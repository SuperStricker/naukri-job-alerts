/**
 * NAUKRI.COM IT JOB ALERT ENGINE v6.0 (Two-Pass High-Coverage Scanner + Verified Pagination)
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Platform:   Naukri.com (Modular, using shared filter-rules.js & skill-engine.js)
 * Coverage:   Delhi NCR, Noida, Greater Noida, Gurugram, Faridabad, Ghaziabad (204 Targets)
 * Strategy:   Two-Pass High-Coverage:
 *               Pass 1: Scrape Page 1 across ALL 204 targets to guarantee 100% role/city coverage.
 *               Pass 2: Scrape Page 2+ for targets with verified next pages within remaining time budget.
 * Reliability: Distinguishes genuine empty results from selector timeouts, bot blocks, and nav errors.
 * Deduping:   Integrated with job-dedupe.js & telegram-service.js
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
  matchesNaukriExperience,
  parseNaukriExperience,
  parseNaukriSalary
} = require('./filter-rules');
const { dispatchGroupedAlerts } = require('./telegram-service');

chromium.use(stealth);

const SEEN_JOBS_FILE = path.join(__dirname, 'seen_jobs.json');
const MAX_PAGES_PER_TARGET = 3;

function loadSeenJobs() {
  try {
    if (fs.existsSync(SEEN_JOBS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SEEN_JOBS_FILE, 'utf-8'));
      if (Array.isArray(parsed)) return new Set(parsed.map(String));
    }
  } catch (err) {
    console.warn('[WARN] Could not read seen_jobs.json:', err.message);
  }
  return new Set();
}

const CITY_SLUGS = [
  { label: 'Delhi NCR', slug: 'delhi-ncr' },
  { label: 'Noida', slug: 'noida' },
  { label: 'Greater Noida', slug: 'greater-noida' },
  { label: 'Gurugram', slug: 'gurugram' },
  { label: 'Faridabad', slug: 'faridabad' },
  { label: 'Ghaziabad', slug: 'ghaziabad' },
  { label: 'Remote', slug: 'remote', isRemote: true }
];

const ROLE_SLUGS = [
  { name: 'IT Support', slug: 'it-support', expFilter: true },
  { name: 'Desktop Support Engineer', slug: 'desktop-support-engineer', expFilter: true },
  { name: 'L1/L2 Desktop Support', slug: 'l1-l2-desktop-support', expFilter: false },
  { name: 'Technical Support Engineer', slug: 'technical-support-engineer', expFilter: false },
  { name: 'Tech Support Engineer', slug: 'tech-support-engineer', expFilter: false },
  { name: 'Support Engineer', slug: 'support-engineer', expFilter: true },
  { name: 'L2 Support Engineer', slug: 'l2-support-engineer', expFilter: false },
  { name: 'Service Desk Engineer', slug: 'service-desk-engineer', expFilter: false },
  { name: 'Helpdesk Support Engineer', slug: 'helpdesk-support-engineer', expFilter: false },
  { name: 'L2 IT Helpdesk', slug: 'l2-it-helpdesk', expFilter: false },
  { name: 'Service Ops Engineer', slug: 'service-ops-engineer', expFilter: false },
  { name: 'System Engineer Service Ops', slug: 'system-engineer-service-ops', expFilter: false },
  { name: 'System Support', slug: 'system-support', expFilter: true },
  { name: 'IT and System Support', slug: 'it-and-system-support', expFilter: false },
  { name: 'Senior System Engineer', slug: 'senior-system-engineer', expFilter: false },
  { name: 'System Administrator', slug: 'system-administrator', expFilter: true },
  { name: 'IT Executive', slug: 'it-executive', expFilter: true },
  { name: 'Senior Executive IT', slug: 'senior-executive-it', expFilter: false },
  { name: 'IT Technician', slug: 'it-technician', expFilter: false },
  { name: 'IT Support Technician', slug: 'it-support-technician', expFilter: false },
  { name: 'IT Specialist', slug: 'it-specialist', expFilter: false },
  { name: 'IT Site Engineer', slug: 'it-site-engineer', expFilter: false },
  { name: 'IT Analyst', slug: 'it-analyst', expFilter: true },
  { name: 'Support Analyst', slug: 'support-analyst', expFilter: true },
  { name: 'M365 / M365 Lead', slug: 'm365', expFilter: false },
  { name: 'Microsoft 365 Engineer', slug: 'microsoft-365-engineer', expFilter: false },
  { name: 'End User Computing (EUC)', slug: 'end-user-computing', expFilter: false },
  { name: 'Wintel Administrator', slug: 'wintel-administrator', expFilter: false },
  { name: 'IT Infrastructure', slug: 'it-infrastructure', expFilter: true },
  { name: 'IT Operations Lead', slug: 'it-operations-lead', expFilter: false },
  { name: 'IT Manager', slug: 'it-manager', expFilter: true },
  { name: 'Assistant Manager IT', slug: 'assistant-manager-it', expFilter: false },
  { name: 'IT Support Manager', slug: 'it-support-manager', expFilter: false },
  { name: 'Service Desk Manager', slug: 'service-desk-manager', expFilter: false }
];

const NAUKRI_TARGETS = [];
for (const role of ROLE_SLUGS) {
  for (const city of CITY_SLUGS) {
    let url;
    if (city.isRemote) {
      url = `https://www.naukri.com/remote-${role.slug}-jobs`;
    } else {
      url = `https://www.naukri.com/${role.slug}-jobs-in-${city.slug}`;
    }
    NAUKRI_TARGETS.push({
      name: `${role.name} [${city.label}]`,
      roleName: role.name,
      cityLabel: city.label,
      url
    });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isFreshJob(posted = '') {
  if (!posted) return true;
  const lower = posted.toLowerCase().trim();
  // Strictly <= 24 hours (Fresh only)
  if (lower.includes('just now') || lower.includes('few hours') || lower.includes('today') || lower.includes('24h')) return true;
  if (lower.includes('1 day ago') || lower.includes('1d ago') || lower === 'yesterday' || lower.includes('1 day')) return true;
  if (/\b\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s*ago\b/i.test(lower)) return true;
  if (/\b1\s*d(ays?)?\s*ago\b/i.test(lower)) return true;
  // Strictly reject 2+ days old postings (e.g. 2 days ago, 3 days, 4 days, 5 days, 1 week, etc.)
  return false;
}

function getNaukriPageUrl(baseUrl, pageNum) {
  if (pageNum <= 1) return baseUrl;
  try {
    const urlObj = new URL(baseUrl);
    urlObj.pathname = urlObj.pathname.replace(/(-\d+)?$/, `-${pageNum}`);
    return urlObj.toString();
  } catch {
    const [pathPart, queryPart] = baseUrl.split('?');
    const newPath = pathPart.replace(/(-\d+)?$/, `-${pageNum}`);
    return queryPart ? `${newPath}?${queryPart}` : newPath;
  }
}

/**
 * Scrapes a single page of a Naukri target.
 * Distinguishes genuine empty results from selector timeout, navigation failure, and bot challenge.
 */
async function scrapeNaukriPage(page, target, pageNum = 1) {
  const pageUrl = getNaukriPageUrl(target.url, pageNum);

  try {
    const resp = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    if (resp && resp.status() === 429) {
      return {
        success: false,
        status: 'RATE_LIMITED',
        error: 'HTTP 429 Rate Limited',
        jobs: [],
        hasNextPage: false,
        parseFailures: 0,
        tupleCount: 0,
        isDateSorted: false
      };
    }
  } catch (err) {
    return {
      success: false,
      status: 'NAVIGATION_FAILURE',
      error: err.message,
      jobs: [],
      hasNextPage: false,
      parseFailures: 0,
      tupleCount: 0,
      isDateSorted: false
    };
  }

  // Check for bot challenge or access denied in page content
  try {
    const pageContent = await page.content().catch(() => '');
    if (/captcha|challenge-running|cf-browser-verification|access denied|blocked/i.test(pageContent)) {
      return {
        success: false,
        status: 'RATE_LIMITED',
        error: 'Bot challenge / block page detected',
        jobs: [],
        hasNextPage: false,
        parseFailures: 0,
        tupleCount: 0,
        isDateSorted: false
      };
    }
  } catch (e) {}

  // Wait for either job tuples OR genuine empty-result indicator
  await Promise.race([
    page.waitForSelector('.cust-job-tuple', { timeout: 4500 }).catch(() => null),
    page.waitForSelector('.no-result, .zero-result, .no-jobs, [class*="no-result"], [class*="empty-research"]', { timeout: 4500 }).catch(() => null)
  ]);

  // Attempt date sort on page 1 and verify whether it took effect
  let isDateSorted = false;
  if (pageNum === 1) {
    try {
      const sortBtn = await page.$('#filter-sort');
      if (sortBtn) {
        await sortBtn.click();
        await page.waitForTimeout(300);
        const dateBtn = await page.$('#filter-sort-menu li:has-text("Date"), #filter-sort-menu a:has-text("Date")');
        if (dateBtn) {
          await dateBtn.click();
          await page.waitForTimeout(1000);
          const currentSortText = await page.$eval('#filter-sort', el => el.innerText).catch(() => '');
          isDateSorted = /date/i.test(currentSortText);
        }
      }
    } catch (e) {}
  }

  // 3-stage scroll to load lazy cards
  for (let s = 0; s < 3; s++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await sleep(250);
  }
  await sleep(200);

  // Extract DOM data, check pagination, and parse cards
  const evalResult = await page.evaluate(() => {
    const tuples = Array.from(document.querySelectorAll('.cust-job-tuple'));
    const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
    const hasEmptyEl = !!document.querySelector('.no-result, .zero-result, .no-jobs, [class*="no-result"], [class*="empty-research"]');
    const genuineEmpty = tuples.length === 0 && (
      hasEmptyEl ||
      bodyText.includes('no results found') ||
      bodyText.includes('0 jobs found') ||
      bodyText.includes('we could not find any jobs') ||
      bodyText.includes('no matching jobs')
    );

    // Verified next-page control check
    const nextBtn = document.querySelector('a.fright, a.next-page, a[aria-label*="Next"], a[aria-label*="next page"]');
    const allLinks = Array.from(document.querySelectorAll('a'));
    const nextTextLink = allLinks.find(a => {
      const t = a.innerText.trim().toLowerCase();
      return t === 'next' || t === 'next >' || t === 'next »';
    });
    const hasNextPage = !!(nextBtn || nextTextLink);

    let parseFailures = 0;
    const parsedJobs = [];

    for (const t of tuples) {
      const titleEl = t.querySelector('a.title');
      const compEl = t.querySelector('a.comp-name');
      const expEl = t.querySelector('.expwdth, [class*="exp"]');
      const salEl = t.querySelector('.sal-wrap, [class*="sal"], [class*="rupee"]');
      const locEl = t.querySelector('.locWdth, [class*="loc"]');
      const postEl = t.querySelector('.job-post-day, span[class*="date"]');
      const descEl = t.querySelector('.job-desc, [class*="job-desc"], [class*="desc"], [class*="highlight"]');
      const tagsEls = Array.from(t.querySelectorAll('.tags-gt li, [class*="tag"] li, .tag-li'));
      const href = titleEl ? titleEl.href : '';
      const idMatch = href ? href.match(/(\d{10,14})/) : null;
      const dataJobId = t.getAttribute('data-job-id') || '';
      const rawId = idMatch ? idMatch[1] : dataJobId;

      if (!rawId || !href) {
        parseFailures++;
        continue;
      }

      const extApply = t.querySelector('.apply-type, [class*="external"], [class*="company-site"]') ||
                       /company\s+site/i.test(t.innerText || '');
      const isEasyApply = !extApply;

      parsedJobs.push({
        source: 'Naukri',
        jobId: rawId,
        title: titleEl ? titleEl.innerText.trim() : '',
        company: compEl ? compEl.innerText.trim() : 'Confidential',
        experience: expEl ? expEl.innerText.trim() : 'Not Specified',
        salary: salEl ? salEl.innerText.trim() : 'Not Disclosed',
        location: locEl ? locEl.innerText.trim() : 'Delhi NCR',
        posted: postEl ? postEl.innerText.trim() : 'Recently',
        isEasyApply,
        description: descEl ? descEl.innerText.trim() : '',
        tags: tagsEls.map(tag => tag.innerText.trim()).filter(Boolean),
        url: href
      });
    }

    return {
      tupleCount: tuples.length,
      genuineEmpty,
      hasNextPage,
      parseFailures,
      parsedJobs
    };
  });

  if (evalResult.tupleCount === 0) {
    if (evalResult.genuineEmpty) {
      return {
        success: true,
        status: 'GENUINE_EMPTY',
        error: null,
        jobs: [],
        hasNextPage: false,
        parseFailures: 0,
        tupleCount: 0,
        isDateSorted
      };
    } else {
      return {
        success: false,
        status: 'SELECTOR_TIMEOUT',
        error: 'Selector timeout without genuine empty indicator',
        jobs: [],
        hasNextPage: false,
        parseFailures: 0,
        tupleCount: 0,
        isDateSorted
      };
    }
  }

  return {
    success: true,
    status: 'OK',
    error: null,
    jobs: evalResult.parsedJobs,
    hasNextPage: evalResult.hasNextPage,
    parseFailures: evalResult.parseFailures,
    tupleCount: evalResult.tupleCount,
    isDateSorted
  };
}

async function runNaukri(options = {}) {
  const { returnEligible = false, dryRun = false } = options;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('🟠 NAUKRI JOB ALERT ENGINE v6.0 (Two-Pass High-Coverage Scanner)');
  console.log(`⏰ ${new Date().toISOString()} | Configured Targets: ${NAUKRI_TARGETS.length} URLs`);
  console.log('══════════════════════════════════════════════════════════════');

  const seenJobs = loadSeenJobs();
  const isFirstRun = seenJobs.size === 0;
  console.log(`[STATE] Loaded ${seenJobs.size} previously seen jobs.`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US'
  });

  const allJobs = [];
  const seenInRun = new Set();
  const CONCURRENCY = 3;
  const NAUKRI_TIME_BUDGET_MS = 10 * 60 * 1000; // 10 minutes max total budget
  const startTime = Date.now();

  const coverage = {
    targetsConfigured: NAUKRI_TARGETS.length,
    targetsStarted: 0,
    targetsCompleted: 0,
    targetsFailed: 0,
    targetsSkipped: 0,
    pagesAttempted: 0,
    pagesCompleted: 0,
    parseFailures: 0,
    rateLimitedTargets: 0,
    selectorTimeouts: 0,
    navigationFailures: 0,
    stopReason: null,
    targetStatus: 'complete'
  };

  // ────────────────────────────────────────────────────────────
  // PASS 1: Guarantee Page 1 across ALL 204 Targets
  // ────────────────────────────────────────────────────────────
  console.log(`\n🚀 [Pass 1/2] Scanning Page 1 across all ${NAUKRI_TARGETS.length} configured targets...`);
  const pass1Queue = [...NAUKRI_TARGETS];
  const pass2Candidates = []; // Targets with verified hasNextPage
  let pass1Idx = 0;

  async function pass1Worker(workerId) {
    const page = await context.newPage();
    await sleep(workerId * 250);
    try {
      while (pass1Idx < pass1Queue.length) {
        if (Date.now() - startTime > NAUKRI_TIME_BUDGET_MS) {
          if (!coverage.stopReason) {
            coverage.stopReason = 'TIME_BUDGET_EXPIRED (Pass 1)';
            console.warn(`[TIME-LIMIT] Naukri reached 10-minute time budget in Pass 1.`);
          }
          break;
        }

        const target = pass1Queue[pass1Idx++];
        coverage.targetsStarted++;
        coverage.pagesAttempted++;

        const res = await scrapeNaukriPage(page, target, 1);
        if (res.success) {
          coverage.pagesCompleted++;
          coverage.targetsCompleted++;
          coverage.parseFailures += res.parseFailures;

          let targetJobsAdded = 0;
          for (const job of res.jobs) {
            if (!job.url || !job.jobId || seenInRun.has(job.jobId)) continue;
            seenInRun.add(job.jobId);
            allJobs.push(job);
            targetJobsAdded++;
          }

          console.log(`🔍 [P1] ${target.name} → ${res.jobs.length} cards (${targetJobsAdded} new)${res.hasNextPage ? ' [Next Page Found]' : ''}`);

          if (res.hasNextPage) {
            pass2Candidates.push({
              target,
              pageNum: 2,
              isDateSorted: res.isDateSorted
            });
          }
        } else {
          coverage.targetsFailed++;
          if (res.status === 'NAVIGATION_FAILURE') coverage.navigationFailures++;
          else if (res.status === 'SELECTOR_TIMEOUT') coverage.selectorTimeouts++;
          else if (res.status === 'RATE_LIMITED') coverage.rateLimitedTargets++;

          console.warn(`[WARN] Pass 1 Failed on ${target.name}: ${res.status} (${res.error || 'Unknown'})`);
        }
      }
    } finally {
      await page.close();
    }
  }

  await Promise.all([pass1Worker(0), pass1Worker(1), pass1Worker(2)]);

  // Track skipped targets if Pass 1 was cut short
  if (coverage.targetsStarted < coverage.targetsConfigured) {
    coverage.targetsSkipped = coverage.targetsConfigured - coverage.targetsStarted;
  }

  // ────────────────────────────────────────────────────────────
  // PASS 2: Deeper Pages for Targets with Verified Next Pages
  // ────────────────────────────────────────────────────────────
  const timeRemainingMs = NAUKRI_TIME_BUDGET_MS - (Date.now() - startTime);
  if (timeRemainingMs > 45000 && pass2Candidates.length > 0 && !coverage.stopReason) {
    console.log(`\n📄 [Pass 2/2] ${pass2Candidates.length} target(s) have verified next pages. Budget remaining: ${(timeRemainingMs / 1000).toFixed(0)}s.`);
    const pass2Queue = [...pass2Candidates];
    let pass2Idx = 0;

    async function pass2Worker(workerId) {
      const page = await context.newPage();
      await sleep(workerId * 200);
      try {
        while (pass2Idx < pass2Queue.length) {
          if (Date.now() - startTime > NAUKRI_TIME_BUDGET_MS) {
            if (!coverage.stopReason) {
              coverage.stopReason = 'TIME_BUDGET_EXPIRED (Pass 2)';
              console.warn(`[TIME-LIMIT] Naukri reached 10-minute time budget during Pass 2.`);
            }
            break;
          }

          const item = pass2Queue[pass2Idx++];
          coverage.pagesAttempted++;

          const res = await scrapeNaukriPage(page, item.target, item.pageNum);
          if (res.success) {
            coverage.pagesCompleted++;
            coverage.parseFailures += res.parseFailures;

            let pageJobsAdded = 0;
            for (const job of res.jobs) {
              if (!job.url || !job.jobId || seenInRun.has(job.jobId)) continue;
              seenInRun.add(job.jobId);
              allJobs.push(job);
              pageJobsAdded++;
            }

            console.log(`  ↳ [P${item.pageNum}] ${item.target.name} → ${res.jobs.length} cards (${pageJobsAdded} new)`);

            // Queue Page 3 if valid next page exists and under limit
            if (res.hasNextPage && item.pageNum < MAX_PAGES_PER_TARGET) {
              pass2Queue.push({
                target: item.target,
                pageNum: item.pageNum + 1,
                isDateSorted: item.isDateSorted
              });
            }
          } else {
            console.warn(`  ↳ [WARN] P${item.pageNum} failed for ${item.target.name}: ${res.status}`);
          }
        }
      } finally {
        await page.close();
      }
    }

    await Promise.all([pass2Worker(0), pass2Worker(1), pass2Worker(2)]);
  } else if (pass2Candidates.length > 0 && !coverage.stopReason) {
    console.log(`[INFO] Insufficient time remaining for Pass 2 (${(timeRemainingMs / 1000).toFixed(0)}s). Proceeding with Pass 1 results.`);
  }

  await browser.close();

  // Compute final coverage targetStatus
  if (coverage.targetsCompleted === coverage.targetsConfigured && coverage.targetsFailed === 0) {
    coverage.targetStatus = 'complete';
  } else if (coverage.targetsCompleted > 0) {
    coverage.targetStatus = 'partial';
  } else {
    coverage.targetStatus = 'failed';
  }

  console.log(`\n📊 [Naukri] Total Unique Job IDs Scraped: ${allJobs.length}`);
  console.log(`📈 [Naukri Coverage] Status: ${coverage.targetStatus.toUpperCase()} | Targets: ${coverage.targetsCompleted}/${coverage.targetsConfigured} completed (Failed: ${coverage.targetsFailed}, Skipped: ${coverage.targetsSkipped}) | Pages: ${coverage.pagesCompleted}/${coverage.pagesAttempted}`);

  const stats = {
    total: allJobs.length, seen: 0, location: 0, experience: 0,
    freshness: 0, titleBlacklist: 0, contentBlacklist: 0,
    skillLow: 0, salary: 0, passed: 0
  };

  const eligible = [];
  const blockLog = [];

  for (const job of allJobs) {
    if (seenJobs.has(job.jobId) || isDuplicate(job, seenJobs)) { stats.seen++; continue; }

    const locCheck = isLocationEligible({ location: job.location, title: job.title, description: job.description });
    if (!locCheck.eligible) {
      stats.location++;
      blockLog.push({ title: job.title, stage: 'LOCATION', detail: locCheck.reason });
      continue;
    }

    if (!matchesNaukriExperience(job.experience)) {
      stats.experience++;
      blockLog.push({ title: job.title, stage: 'EXPERIENCE', detail: job.experience });
      continue;
    }

    if (!isFreshJob(job.posted)) {
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

    // Strict 50% Job-Skill Ratio Gate
    const skill = evaluateJobSkillRatio({
      title: job.title,
      tags: job.tags,
      description: job.description
    });

    if (!skill.passesStrict50) {
      stats.skillLow++;
      blockLog.push({
        title: job.title,
        stage: skill.percentage === 0 ? 'ZERO_SKILLS' : 'SKILL_RATIO_LOW',
        detail: `${skill.matchedCount}/${skill.totalJobSkills} (${skill.percentage}%) < 50% | Unmatched: ${skill.unmatchedSkills.slice(0, 4).join(', ')}`
      });
      continue;
    }

    const combinedText = `${job.title} ${job.description || ''} ${(job.tags || []).join(' ')}`;
    const contentCheck = isContentBlacklisted(combinedText, skill.percentage);
    if (contentCheck.blocked) {
      stats.contentBlacklist++;
      blockLog.push({ title: job.title, stage: 'CONTENT_BLACKLIST', detail: `${contentCheck.reason} (${skill.percentage}%)` });
      continue;
    }

    // User directive: Only Easy Apply jobs allowed (Direct Company stopped)
    if (!job.isEasyApply) {
      blockLog.push({ title: job.title, stage: 'DIRECT_COMPANY_STOPPED', detail: 'Direct company jobs stopped' });
      continue;
    }

    const sal = parseNaukriSalary(job.salary);
    const exp = parseNaukriExperience(job.experience);
    // User directive: Disclosed salary max must reach at least 7.0 LPA (not max 6, e.g. 3-7, 4-8 LPA).
    // "Not Disclosed" is allowed.
    if (sal.isDisclosed && sal.max < 7.0) {
      stats.salary++;
      blockLog.push({ title: job.title, stage: 'SALARY_LOW', detail: `${sal.raw} (max ${sal.max} < 7.0 LPA)` });
      continue;
    }

    stats.passed++;
    const badges = [];
    if (sal.isHigh) badges.push('🔥 HIGH SALARY (7+ LPA)');
    badges.push(locCheck.workMode === 'REMOTE' ? '🏠 REMOTE' : (locCheck.workMode === 'HYBRID' ? '🔄 HYBRID' : '🏢 ON-SITE'));
    badges.push(`⭐ ${skill.matchedCount}/${skill.totalJobSkills} SKILLS (${skill.percentage}%)`);

    eligible.push({
      job: {
        ...job,
        workMode: locCheck.workMode,
        matchedSkills: skill.matchedSkills,
        skillPct: skill.percentage
      },
      badges,
      skill
    });
  }

  console.log('\n' + '═'.repeat(65));
  console.log('📊 NAUKRI v6.0 FILTER HEAT MAP');
  console.log('═'.repeat(65));
  console.log(`Total Unique Jobs Scraped:       ${stats.total}`);
  console.log(`  ├── Already Seen (Skip):       ${stats.seen}`);
  console.log(`  ├── Outside NCR / Foreign:     ${stats.location}`);
  console.log(`  ├── Experience Out of Range:    ${stats.experience}`);
  console.log(`  ├── Not Fresh (>24h):           ${stats.freshness}`);
  console.log(`  ├── Title Blacklisted:          ${stats.titleBlacklist}`);
  console.log(`  ├── Content Blacklisted:        ${stats.contentBlacklist}`);
  console.log(`  ├── Skill Ratio < 50%:          ${stats.skillLow}`);
  console.log(`  ├── Salary <6 LPA / <=3y Junior:${stats.salary}`);
  console.log(`  └── ✅ PASSED (Alerts):         ${stats.passed}`);
  console.log('═'.repeat(65));

  if (returnEligible) {
    return {
      jobs: allJobs,
      scraped: stats.total,
      passed: stats.passed,
      eligible,
      seenJobs,
      isFirstRun,
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
      selectorTimeouts: coverage.selectorTimeouts,
      navigationFailures: coverage.navigationFailures,
      stopReason: coverage.stopReason
    };
  }

  // Standalone execution dispatch
  const dispatchResult = await dispatchGroupedAlerts(eligible, seenJobs, { isFirstRun, dryRun });
  return {
    jobs: allJobs,
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
    selectorTimeouts: coverage.selectorTimeouts,
    navigationFailures: coverage.navigationFailures,
    stopReason: coverage.stopReason
  };
}

if (require.main === module) {
  runNaukri().catch(err => {
    console.error('[FATAL NAUKRI]', err);
    process.exit(1);
  });
}

module.exports = {
  runNaukri,
  scrapeNaukriPage,
  getNaukriPageUrl,
  isFreshJob,
  NAUKRI_TARGETS,
  CITY_SLUGS,
  ROLE_SLUGS
};
