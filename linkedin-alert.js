/**
 * LINKEDIN IT JOB ALERT ENGINE v4.0 (Interleaved Search + Resilient Detail Scanner)
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * Independent from Naukri — Uses shared filter-rules.js, skill-engine.js & telegram-service.js.
 *
 * Implements:
 *   1. Full "About the job" Deep Scan (Technical Skills, Desired Qualifications, Responsibilities)
 *   2. Interleaved Search Targets: Round-robin across the 6 NCR locations so all 5 query groups
 *      execute immediately in early iterations, preventing omission of entire groups if budget tight.
 *   3. Strict NCR Geofence + India-Wide Remote Policy
 *   4. Actual Salary Parsing >= 6.0 LPA (excludes allowances & stipends)
 *   5. All 34 Headlines as LinkedIn Boolean OR groups with sortBy=DD
 *   6. Strict & Soft Developer Blacklist
 *   7. Strict >= 50% Skill Gate + >= 2 IT Skills (NO BYPASS!)
 *   8. Resilient Detail Fetching: On 429 / fetch failure, marks detail as rate-limited and preserves
 *      job for future scan instead of misclassifying as SKILL_RATIO_LOW.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { evaluateJobSkillRatio } = require('./skill-engine');
const { isDuplicate, rememberJob } = require('./job-dedupe');
const {
  isLocationEligible,
  isTitleBlacklisted,
  isContentBlacklisted,
  parseLinkedInExperience,
  parseLinkedInSalary,
  isLinkedInEasyApply
} = require('./filter-rules');
const { dispatchGroupedAlerts } = require('./telegram-service');

chromium.use(stealth);

const SEEN_JOBS_FILE = path.join(__dirname, 'seen_jobs.json');

function loadSeenJobs() {
  try {
    if (fs.existsSync(SEEN_JOBS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SEEN_JOBS_FILE, 'utf-8'));
      if (Array.isArray(parsed)) return new Set(parsed.map(String));
    }
  } catch (err) {
    console.warn('[WARN] Failed to read seen_jobs.json:', err.message);
  }
  return new Set();
}

/**
 * LINKEDIN BOOLEAN SEARCH GROUPS (Covers all 34 Headlines)
 * Search strictly restricted to the 6 configured NCR locations.
 */
const LINKEDIN_LOCATIONS = [
  'Delhi NCR, India',
  'Noida, Uttar Pradesh, India',
  'Greater Noida, Uttar Pradesh, India',
  'Gurugram, Haryana, India',
  'Faridabad, Haryana, India',
  'Ghaziabad, Uttar Pradesh, India'
];

const LINKEDIN_QUERY_GROUPS = [
  {
    name: 'IT & Desktop Support',
    query: '("IT Support" OR "Desktop Support" OR "Technical Support" OR "Tech Support Engineer" OR "IT Analyst" OR "Helpdesk" OR "L1/L2 Desktop" OR "IT Technician" OR "IT Support Technician" OR "L2 IT Helpdesk")',
    locations: LINKEDIN_LOCATIONS
  },
  {
    name: 'Service Desk, Ops & Support Engineers',
    query: '("Service Desk" OR "Service Ops" OR "System Support" OR "IT and System Support" OR "Support Engineer" OR "L2 Support" OR "Service Desk Engineer" OR "Helpdesk Support" OR "Tech Support Engineer" OR "IT Analyst" OR "Support Analyst")',
    locations: LINKEDIN_LOCATIONS
  },
  {
    name: 'SysAdmin, Specialist & Site Engineers',
    query: '("System Administrator" OR "System Engineer" OR "Senior System Engineer" OR "IT Executive" OR "Senior Executive IT" OR "IT Specialist" OR "Site Engineer" OR "IT Site Engineer")',
    locations: LINKEDIN_LOCATIONS
  },
  {
    name: 'M365, EUC, Intune, Wintel & Infrastructure',
    query: '("M365" OR "Microsoft 365" OR "M365 Lead" OR "EUC" OR "End User Computing" OR "Wintel" OR "IT Infrastructure" OR "Intune")',
    locations: LINKEDIN_LOCATIONS
  },
  {
    name: 'IT Operations Lead & Management',
    query: '("IT Operations Lead" OR "IT Manager" OR "Assistant Manager IT" OR "IT Support Manager" OR "Service Desk Manager")',
    locations: LINKEDIN_LOCATIONS
  }
];

// INTERLEAVED TARGETS: Loop location by location across all 5 groups
// Guarantees all 5 query groups run in early iterations!
const LINKEDIN_TARGETS = [];
for (let locIdx = 0; locIdx < LINKEDIN_LOCATIONS.length; locIdx++) {
  const loc = LINKEDIN_LOCATIONS[locIdx];
  const shortCity = loc.split(',')[0].trim();
  for (const grp of LINKEDIN_QUERY_GROUPS) {
    const url = `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(grp.query)}&location=${encodeURIComponent(loc)}&f_TPR=r86400&f_JT=F%2CC&f_WT=1%2C2%2C3&sortBy=DD`;
    LINKEDIN_TARGETS.push({
      name: `${grp.name} [${shortCity}]`,
      queryGroup: grp.name,
      location: shortCity,
      url
    });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isFreshLinkedInJob(posted = '') {
  if (!posted) return true;
  const lower = posted.toLowerCase().trim();
  if (lower.includes('just now') || lower.includes('minute') || lower.includes('hour') || lower.includes('today')) return true;
  if (lower.includes('1 day ago') || lower.includes('1d') || lower === 'yesterday') return true;
  if (/\b\d+\s*d\b/i.test(lower)) {
    const days = parseInt(lower.match(/(\d+)\s*d/i)[1], 10);
    return days <= 1;
  }
  return false;
}

function parsePostingMinutes(posted = '') {
  if (!posted) return 9999;
  const lower = posted.toLowerCase().trim();
  if (lower.includes('just now')) return 0;
  const minMatch = lower.match(/(\d+)\s*(?:m|min|minute)/i);
  if (minMatch) return parseInt(minMatch[1], 10);
  const hrMatch = lower.match(/(\d+)\s*(?:h|hr|hour)/i);
  if (hrMatch) return parseInt(hrMatch[1], 10) * 60;
  if (lower.includes('1 day') || lower.includes('1d') || lower.includes('yesterday')) return 1440;
  return 9999;
}

/**
 * Executes a single LinkedIn guest search target.
 * Tracks cards before scroll, after scroll, and after "See more".
 * Distinguishes rate limits and selector timeouts from genuine empty results.
 */
async function scrapeLinkedInSearch(page, target) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (resp && resp.status() === 429) {
        const backoffMs = attempt === 1 ? 5000 : 8000;
        console.warn(`[WARN] LinkedIn 429 on ${target.name} (attempt ${attempt}), backing off ${backoffMs / 1000}s...`);
        await sleep(backoffMs);
        if (attempt === 2) {
          return {
            success: false,
            status: 'RATE_LIMITED',
            jobs: [],
            parseFailures: 0,
            counts: { initial: 0, afterScroll: 0, afterSeeMore: 0 }
          };
        }
        continue;
      }

      await page.waitForSelector('.base-card, .job-search-card', { timeout: 4500 }).catch(() => {});

      // Check card count before scrolling
      const initialCards = await page.$$eval('.base-card, .job-search-card', els => els.length).catch(() => 0);

      // Scroll 2 times to trigger lazy-loaded cards
      for (let s = 0; s < 2; s++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await sleep(300);
      }
      const afterScrollCards = await page.$$eval('.base-card, .job-search-card', els => els.length).catch(() => 0);

      // If cards are few, attempt to click "See more" once
      let afterSeeMoreCards = afterScrollCards;
      if (afterScrollCards < 50) {
        try {
          const seeMore = await page.$('button.infinite-scroller__show-more-button, button[aria-label*="See more"]');
          if (seeMore) {
            await seeMore.click().catch(() => {});
            await sleep(400);
            await page.evaluate(() => window.scrollBy(0, 1200));
            await sleep(300);
            afterSeeMoreCards = await page.$$eval('.base-card, .job-search-card', els => els.length).catch(() => 0);
          }
        } catch (e) {}
      }

      // Check if page has genuine empty state
      const emptyCheck = await page.evaluate(() => {
        const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
        const hasNoResultEl = !!document.querySelector('.no-matching-jobs, .empty-search, [class*="no-results"]');
        return hasNoResultEl || bodyText.includes('no matching jobs found') || bodyText.includes('no jobs found');
      });

      if (afterSeeMoreCards === 0) {
        if (emptyCheck) {
          return {
            success: true,
            status: 'GENUINE_EMPTY',
            jobs: [],
            parseFailures: 0,
            counts: { initial: 0, afterScroll: 0, afterSeeMore: 0 }
          };
        } else {
          return {
            success: false,
            status: 'SELECTOR_TIMEOUT',
            jobs: [],
            parseFailures: 0,
            counts: { initial: 0, afterScroll: 0, afterSeeMore: 0 }
          };
        }
      }

      // Extract cards from DOM
      const extractResult = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('.base-card, .job-search-card'));
        let parseFailures = 0;
        const validJobs = [];

        for (const c of cards) {
          const linkEl = c.tagName === 'A' ? c : c.querySelector('a.base-card__full-link, a');
          const href = linkEl ? linkEl.href : '';
          if (!href || !href.includes('/jobs/view/')) {
            parseFailures++;
            continue;
          }

          const urn = c.getAttribute('data-entity-urn') || '';
          const urnMatch = urn.match(/jobPosting:(\d+)/);
          const hrefMatch = href.match(/-(\d{8,14})(?:\?|$)/);
          const rawId = urnMatch ? urnMatch[1] : (hrefMatch ? hrefMatch[1] : '');
          if (!rawId) {
            parseFailures++;
            continue;
          }

          const titleEl = c.querySelector('.base-search-card__title, h3');
          const compEl = c.querySelector('.base-search-card__subtitle, h4');
          const locEl = c.querySelector('.job-search-card__location');
          const timeEl = c.querySelector('time');
          const easyApplyEl = c.querySelector('.job-search-card__easy-apply-label, [class*="easy-apply"]');
          const cardHtml = c.innerHTML || '';
          const cardIsEasyApply = !!easyApplyEl || cardHtml.includes('apply-link-onsite') || /\beasy apply\b/i.test(cardHtml);

          validJobs.push({
            rawId,
            jobId: `linkedin_${rawId}`,
            title: titleEl ? titleEl.innerText.trim() : '',
            company: compEl ? compEl.innerText.trim() : 'Confidential',
            location: locEl ? locEl.innerText.trim() : 'Delhi NCR',
            posted: timeEl ? timeEl.innerText.trim() : 'Past 24h',
            isEasyApply: cardIsEasyApply,
            url: href.split('?')[0]
          });
        }

        return { jobs: validJobs, parseFailures };
      });

      console.log(`🔍 ${target.name} → ${extractResult.jobs.length} cards (initial: ${initialCards}, scroll: ${afterScrollCards}, seeMore: ${afterSeeMoreCards})`);

      return {
        success: true,
        status: 'OK',
        jobs: extractResult.jobs,
        parseFailures: extractResult.parseFailures,
        counts: { initial: initialCards, afterScroll: afterScrollCards, afterSeeMore: afterSeeMoreCards }
      };
    } catch (err) {
      if (attempt === 2) {
        console.error(`[ERROR] LinkedIn search failed (${target.name}):`, err.message);
        return {
          success: false,
          status: 'NAVIGATION_FAILURE',
          error: err.message,
          jobs: [],
          parseFailures: 0,
          counts: { initial: 0, afterScroll: 0, afterSeeMore: 0 }
        };
      }
      await sleep(1500);
    }
  }

  return {
    success: false,
    status: 'UNKNOWN_FAILURE',
    jobs: [],
    parseFailures: 0,
    counts: { initial: 0, afterScroll: 0, afterSeeMore: 0 }
  };
}

/**
 * Fetches full "About the job" detail from LinkedIn guest API.
 * Returns rateLimited flag so caller never mistreats 429 as a skill-filter failure.
 */
async function fetchLinkedInJobDetail(page, rawId) {
  const detailUrl = `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${rawId}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (resp && resp.status() === 429) {
        console.warn(`[WARN] LinkedIn 429 on detail ${rawId}, waiting 4s...`);
        await sleep(4000);
        continue;
      }
      await page.waitForTimeout(500);

      const parsed = await page.evaluate(() => {
        const descEl = document.querySelector('.show-more-less-html__markup, .description__text');
        const description = descEl ? descEl.innerText.trim() : (document.body.innerText || '').trim();

        let seniority = '';
        let employmentType = '';

        const criteriaItems = document.querySelectorAll('.description__job-criteria-item');
        for (const item of criteriaItems) {
          const label = (item.querySelector('.description__job-criteria-subheader')?.innerText || '').toLowerCase();
          const val = (item.querySelector('.description__job-criteria-text')?.innerText || '').trim();
          if (label.includes('seniority')) seniority = val;
          else if (label.includes('employment')) employmentType = val;
        }

        const html = document.body.innerHTML || '';
        const onsiteBtn = document.querySelector('[data-tracking-control-name*="apply-link-onsite"], .apply-button--default, [data-is-easy-apply="true"]');
        const trackingAttr = Array.from(document.querySelectorAll('[data-tracking-control-name]')).map(el => el.getAttribute('data-tracking-control-name')).join(' ');
        const isEasyApply = html.includes('apply-link-onsite') || !!onsiteBtn || trackingAttr.includes('apply-link-onsite') || /\beasy apply\b/i.test(document.body.innerText);

        return { description, seniority, employmentType, isEasyApply };
      });

      return {
        rateLimited: false,
        fetchFailed: false,
        ...parsed
      };
    } catch (err) {
      if (attempt === 2) {
        return {
          rateLimited: false,
          fetchFailed: true,
          error: err.message,
          description: '',
          seniority: '',
          employmentType: '',
          isEasyApply: false
        };
      }
      await sleep(1500);
    }
  }

  return {
    rateLimited: true,
    fetchFailed: true,
    description: '',
    seniority: '',
    employmentType: '',
    isEasyApply: false
  };
}

async function runLinkedIn(options = {}) {
  const { returnEligible = false, dryRun = false } = options;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('🔵 LINKEDIN JOB ALERT ENGINE v4.0 (Interleaved + Resilient Detail Scan)');
  console.log(`⏰ ${new Date().toISOString()} | Interleaved Search Targets: ${LINKEDIN_TARGETS.length}`);
  console.log('══════════════════════════════════════════════════════════════');

  const seenJobs = loadSeenJobs();
  const seenLiCount = Array.from(seenJobs).filter(id => id.startsWith('linkedin_')).length;
  const isFirstLinkedInRun = seenLiCount === 0;
  console.log(`[STATE] Loaded ${seenJobs.size} total seen IDs (${seenLiCount} LinkedIn IDs).`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });

  const page = await context.newPage();
  const collected = [];
  const seenInRun = new Set();

  const coverage = {
    targetsConfigured: LINKEDIN_TARGETS.length,
    targetsStarted: 0,
    targetsCompleted: 0,
    targetsFailed: 0,
    targetsSkipped: 0,
    pagesAttempted: 0,
    pagesCompleted: 0,
    parseFailures: 0,
    rateLimitedTargets: 0,
    detailRateLimited: 0,
    selectorTimeouts: 0,
    navigationFailures: 0,
    stopReason: null,
    targetStatus: 'complete'
  };

  const stats = {
    total: 0, seen: 0, location: 0, freshness: 0, titleBlacklist: 0,
    detailFetched: 0, employmentType: 0, experience: 0, salary: 0,
    contentBlacklist: 0, skillLow: 0, passed: 0
  };

  const candidates = [];
  const eligible = [];
  const blockLog = [];

  try {
    const LINKEDIN_SEARCH_BUDGET_MS = 8 * 60 * 1000; // 8 minutes budget for search phase
    const searchStartTime = Date.now();

    // ────────────────────────────────────────────────────────────
    // Phase 1: Interleaved Search across all 30 Targets
    // ────────────────────────────────────────────────────────────
    for (const target of LINKEDIN_TARGETS) {
      if (Date.now() - searchStartTime > LINKEDIN_SEARCH_BUDGET_MS) {
        coverage.stopReason = 'TIME_BUDGET_EXPIRED (Search Phase)';
        coverage.targetsSkipped = coverage.targetsConfigured - coverage.targetsStarted;
        console.warn(`[TIME-LIMIT] LinkedIn search reached budget. Skipping remaining ${coverage.targetsSkipped} target(s).`);
        break;
      }

      coverage.targetsStarted++;
      coverage.pagesAttempted++;

      const searchRes = await scrapeLinkedInSearch(page, target);
      if (searchRes.success) {
        coverage.targetsCompleted++;
        coverage.pagesCompleted++;
        coverage.parseFailures += searchRes.parseFailures;

        for (const job of searchRes.jobs) {
          if (!job.rawId || seenInRun.has(job.jobId)) continue;
          seenInRun.add(job.jobId);
          collected.push(job);
        }
      } else {
        coverage.targetsFailed++;
        if (searchRes.status === 'RATE_LIMITED') coverage.rateLimitedTargets++;
        else if (searchRes.status === 'SELECTOR_TIMEOUT') coverage.selectorTimeouts++;
        else if (searchRes.status === 'NAVIGATION_FAILURE') coverage.navigationFailures++;
      }

      await sleep(1000); // Respectful pause
    }

    if (coverage.targetsStarted < coverage.targetsConfigured && coverage.targetsSkipped === 0) {
      coverage.targetsSkipped = coverage.targetsConfigured - coverage.targetsStarted;
    }

    stats.total = collected.length;
    console.log(`\n📊 Total Unique LinkedIn Listings Extracted: ${stats.total}`);

    // ────────────────────────────────────────────────────────────
    // Phase 2: Card-Level Pre-Filter
    // ────────────────────────────────────────────────────────────
    for (const job of collected) {
      if (seenJobs.has(job.jobId) || isDuplicate(job, seenJobs)) { stats.seen++; continue; }

      const locCheck = isLocationEligible({ location: job.location, title: job.title });
      if (!locCheck.eligible) {
        stats.location++;
        blockLog.push({ title: job.title, stage: 'LOCATION', detail: locCheck.reason });
        continue;
      }

      if (!isFreshLinkedInJob(job.posted)) {
        stats.freshness++;
        blockLog.push({ title: job.title, stage: 'FRESHNESS', detail: job.posted });
        continue;
      }

      const titleCheck = isTitleBlacklisted(job.title);
      if (titleCheck.blocked) {
        stats.titleBlacklist++;
        blockLog.push({ title: job.title, stage: 'TITLE_BLACKLIST', detail: titleCheck.reason });
        continue;
      }

      candidates.push({ ...job, workMode: locCheck.workMode });
    }

    console.log(`🔎 Fetching full "About the job" details for ${candidates.length} pre-filtered candidate(s)...`);

    const DETAIL_BUDGET_MS = 4 * 60 * 1000; // 4 minutes max for detail fetching
    const detailStartTime = Date.now();

    // ────────────────────────────────────────────────────────────
    // Phase 3: Deep "About the Job" Fetch with Rate-Limit Resilience
    // ────────────────────────────────────────────────────────────
    for (const job of candidates) {
      if (Date.now() - detailStartTime > DETAIL_BUDGET_MS) {
        console.warn(`[TIME-LIMIT] LinkedIn detail fetch reached 4-minute budget. Proceeding to alert.`);
        if (!coverage.stopReason) coverage.stopReason = 'TIME_BUDGET_EXPIRED (Detail Phase)';
        break;
      }

      const detail = await fetchLinkedInJobDetail(page, job.rawId);

      // On 429 or detail fetch failure:
      // Record rate limit counter, DO NOT score as SKILL_RATIO_LOW,
      // and DO NOT mark as seen, leaving it eligible for future scans!
      if (detail.rateLimited || detail.fetchFailed) {
        coverage.detailRateLimited++;
        console.warn(`[RATE-LIMIT] LinkedIn detail fetch incomplete for ${job.rawId} (${job.title}). Preserved for next scan.`);
        continue;
      }

      stats.detailFetched++;
      if (typeof detail.isEasyApply === 'boolean') {
        job.isEasyApply = detail.isEasyApply;
      }

      // User directive: Only Easy Apply jobs allowed (Direct Company stopped)
      if (!job.isEasyApply) {
        blockLog.push({ title: job.title, stage: 'DIRECT_APPLY_STOPPED', detail: 'Direct company jobs stopped' });
        continue;
      }

      const jdText = detail.description || '';
      const combinedText = `${job.title} ${jdText}`;

      // Employment Type: Full-time & Contract only
      if (detail.employmentType && !/(full-time|contract)/i.test(detail.employmentType)) {
        stats.employmentType++;
        blockLog.push({ title: job.title, stage: 'EMPLOYMENT_TYPE', detail: detail.employmentType });
        continue;
      }

      // Experience Check (with labeled patterns)
      const expCheck = parseLinkedInExperience(jdText, job.title, detail.seniority);
      if (!expCheck.eligible) {
        stats.experience++;
        blockLog.push({ title: job.title, stage: 'EXPERIENCE', detail: expCheck.reason });
        continue;
      }

      // Actual Salary Check (excludes allowances & stipends)
      const salCheck = parseLinkedInSalary(jdText);
      if (!salCheck.eligible) {
        stats.salary++;
        blockLog.push({ title: job.title, stage: 'SALARY_LOW', detail: salCheck.reason });
        continue;
      }

      // Strict 50% Job-Skill Ratio Gate + >= 2 IT Skills
      const skill = evaluateJobSkillRatio({ title: job.title, description: jdText });
      if (!skill.passesStrict50) {
        stats.skillLow++;
        blockLog.push({
          title: job.title,
          stage: skill.percentage === 0 ? 'ZERO_SKILLS' : 'SKILL_RATIO_LOW',
          detail: `${skill.matchedCount}/${skill.totalJobSkills} (${skill.percentage}%) < 50% | Unmatched: ${skill.unmatchedSkills.slice(0, 4).join(', ') || 'NONE'}`
        });
        continue;
      }

      // Content Blacklist on Full JD
      const contentCheck = isContentBlacklisted(combinedText, skill.percentage);
      if (contentCheck.blocked) {
        stats.contentBlacklist++;
        blockLog.push({ title: job.title, stage: 'CONTENT_BLACKLIST', detail: `${contentCheck.reason} (${skill.percentage}%)` });
        continue;
      }

      // Passed all filters!
      stats.passed++;
      const badges = [];
      if (salCheck.isHigh) badges.push('🔥 HIGH SALARY (7+ LPA)');
      badges.push(job.workMode === 'REMOTE' ? '🏠 REMOTE' : (job.workMode === 'HYBRID' ? '🔄 HYBRID' : '🏢 ON-SITE'));
      badges.push(job.isEasyApply ? '⚡ EASY APPLY' : '🌐 DIRECT APPLY');
      badges.push(`⭐ ${skill.matchedCount}/${skill.totalJobSkills} SKILLS (${skill.percentage}%)`);

      eligible.push({
        job: {
          ...job,
          source: 'LinkedIn',
          experience: expCheck.label,
          salary: salCheck.raw,
          matchedSkills: skill.matchedSkills,
          skillPct: skill.percentage,
          postedMinutes: parsePostingMinutes(job.posted)
        },
        badges,
        skill
      });

      await sleep(650);
    }
  } finally {
    await browser.close();
  }

  // Compute final coverage targetStatus
  if (coverage.targetsCompleted === coverage.targetsConfigured && coverage.targetsFailed === 0) {
    coverage.targetStatus = 'complete';
  } else if (coverage.targetsCompleted > 0) {
    coverage.targetStatus = 'partial';
  } else {
    coverage.targetStatus = 'failed';
  }

  // Sort eligible jobs newest-first by posting time
  eligible.sort((a, b) => (a.job.postedMinutes || 9999) - (b.job.postedMinutes || 9999));

  console.log('\n' + '═'.repeat(65));
  console.log('📊 LINKEDIN v4.0 FILTER HEAT MAP');
  console.log('═'.repeat(65));
  console.log(`Total Unique Cards Found:        ${stats.total}`);
  console.log(`  ├── Already Seen (Skip):       ${stats.seen}`);
  console.log(`  ├── Outside NCR / Foreign:     ${stats.location}`);
  console.log(`  ├── Not Fresh (>24h):          ${stats.freshness}`);
  console.log(`  ├── Title Blacklisted:         ${stats.titleBlacklist}`);
  console.log(`  ├── Fetched Full "About Job":  ${stats.detailFetched}`);
  console.log(`  ├── Detail Rate-Limited (429): ${coverage.detailRateLimited}`);
  console.log(`  ├── Non Full-time/Contract:    ${stats.employmentType}`);
  console.log(`  ├── Experience <=2y / Entry:   ${stats.experience}`);
  console.log(`  ├── Salary < 6 LPA:            ${stats.salary}`);
  console.log(`  ├── Skill Ratio < 50%:         ${stats.skillLow}`);
  console.log(`  ├── Content Blacklisted:       ${stats.contentBlacklist}`);
  console.log(`  └── ✅ PASSED (Alerts):        ${stats.passed}`);
  console.log('═'.repeat(65));
  console.log(`📈 [LinkedIn Coverage] Status: ${coverage.targetStatus.toUpperCase()} | Targets: ${coverage.targetsCompleted}/${coverage.targetsConfigured} completed (Failed: ${coverage.targetsFailed}, Skipped: ${coverage.targetsSkipped})`);

  if (returnEligible) {
    return {
      jobs: collected,
      scraped: stats.total,
      passed: stats.passed,
      eligible,
      seenJobs,
      isFirstLinkedInRun,
      targetStatus: coverage.targetStatus,
      targetsConfigured: coverage.targetsConfigured,
      targetsStarted: coverage.targetsStarted,
      targetsCompleted: coverage.targetsCompleted,
      targetsFailed: coverage.targetsFailed,
      targetsSkipped: coverage.targetsSkipped,
      pagesAttempted: coverage.pagesAttempted,
      pagesCompleted: coverage.pagesCompleted,
      parseFailures: coverage.parseFailures,
      rateLimitedTargets: coverage.rateLimitedTargets,
      detailRateLimited: coverage.detailRateLimited,
      selectorTimeouts: coverage.selectorTimeouts,
      navigationFailures: coverage.navigationFailures,
      stopReason: coverage.stopReason
    };
  }

  // Standalone execution dispatch
  const dispatchResult = await dispatchGroupedAlerts(eligible, seenJobs, { isFirstRun: isFirstLinkedInRun, dryRun });
  return {
    jobs: collected,
    scraped: stats.total,
    passed: stats.passed,
    sent: dispatchResult.sentJobs,
    targetStatus: coverage.targetStatus,
    targetsConfigured: coverage.targetsConfigured,
    targetsStarted: coverage.targetsStarted,
    targetsCompleted: coverage.targetsCompleted,
    targetsFailed: coverage.targetsFailed,
    targetsSkipped: coverage.targetsSkipped,
    pagesAttempted: coverage.pagesAttempted,
    pagesCompleted: coverage.pagesCompleted,
    parseFailures: coverage.parseFailures,
    rateLimitedTargets: coverage.rateLimitedTargets,
    detailRateLimited: coverage.detailRateLimited,
    selectorTimeouts: coverage.selectorTimeouts,
    navigationFailures: coverage.navigationFailures,
    stopReason: coverage.stopReason
  };
}

if (require.main === module) {
  runLinkedIn().catch(err => {
    console.error('[FATAL LINKEDIN]', err);
    process.exit(1);
  });
}

module.exports = {
  runLinkedIn,
  scrapeLinkedInSearch,
  fetchLinkedInJobDetail,
  LINKEDIN_TARGETS,
  LINKEDIN_QUERY_GROUPS,
  LINKEDIN_LOCATIONS
};
