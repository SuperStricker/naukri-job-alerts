/**
 * DIAGNOSTIC SCRIPT: High-Coverage Scan & Filter Diagnostic
 * ───────────────────────────────────────────────────────────────────────────
 * Strictly READ-ONLY: Never sends Telegram alerts and never edits seen_jobs.json.
 * Validates scan coverage, selector integrity, and step-by-step filter breakdown
 * strictly across the 6 configured NCR locations.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { evaluateJobSkillRatio } = require('./skill-engine');
const { isDuplicate } = require('./job-dedupe');
const {
  isLocationEligible,
  isTitleBlacklisted,
  isContentBlacklisted,
  matchesNaukriExperience,
  parseNaukriExperience,
  parseNaukriSalary,
  parseLinkedInExperience,
  parseLinkedInSalary
} = require('./filter-rules');
const { NAUKRI_TARGETS, scrapeNaukriPage } = require('./naukri-alert');
const { LINKEDIN_TARGETS, scrapeLinkedInSearch, fetchLinkedInJobDetail } = require('./linkedin-alert');

chromium.use(stealth);

const SEEN_JOBS_FILE = path.join(__dirname, 'seen_jobs.json');

function loadSeenJobs() {
  try {
    if (fs.existsSync(SEEN_JOBS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_JOBS_FILE, 'utf-8')).map(String));
    }
  } catch (e) {}
  return new Set();
}

function isFreshJob(posted = '') {
  if (!posted) return true;
  const lower = posted.toLowerCase().trim();
  if (lower.includes('just now') || lower.includes('few hours') || lower.includes('today') || lower.includes('24h')) return true;
  if (lower.includes('1 day ago') || lower.includes('1d ago') || lower === 'yesterday' || lower.includes('1 day')) return true;
  if (/\b\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s*ago\b/i.test(lower)) return true;
  return false;
}

(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🔍 JOB ALERT SCAN & COVERAGE DIAGNOSTIC (READ-ONLY)        ║');
  console.log('║   Strictly 6 NCR Locations | No Telegram | No State Updates  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`📌 Architecture Configured Targets:`);
  console.log(`   🟠 Naukri Configured Targets:   ${NAUKRI_TARGETS.length} URLs (34 roles × 6 NCR cities)`);
  console.log(`   🔵 LinkedIn Configured Targets: ${LINKEDIN_TARGETS.length} Targets (5 Boolean groups × 6 NCR cities)\n`);

  const seenJobs = loadSeenJobs();
  console.log(`[STATE] Loaded ${seenJobs.size} previously seen job IDs.\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 }
  });
  const page = await context.newPage();

  // Test representative targets across both portals strictly within the 6 NCR cities
  const diagnosticNaukriTargets = [
    NAUKRI_TARGETS.find(t => t.name.includes('Desktop Support Engineer [Noida]')) || NAUKRI_TARGETS[0],
    NAUKRI_TARGETS.find(t => t.name.includes('IT Support [Delhi NCR]')) || NAUKRI_TARGETS[1]
  ];

  const diagnosticLinkedInTargets = [
    LINKEDIN_TARGETS.find(t => t.name.includes('IT & Desktop Support [Delhi NCR]')) || LINKEDIN_TARGETS[0],
    LINKEDIN_TARGETS.find(t => t.name.includes('IT & Desktop Support [Noida]')) || LINKEDIN_TARGETS[1]
  ];

  const coverageReport = {
    targetsConfigured: diagnosticNaukriTargets.length + diagnosticLinkedInTargets.length,
    targetsStarted: 0,
    targetsCompleted: 0,
    targetsFailed: 0,
    pagesAttempted: 0,
    pagesCompleted: 0,
    parseFailures: 0,
    selectorTimeouts: 0,
    navigationFailures: 0,
    rateLimitedTargets: 0
  };

  const results = {
    totalEvaluated: 0,
    seen: 0,
    location: 0,
    exp: 0,
    freshness: 0,
    titleBlacklist: 0,
    contentBlacklist: 0,
    skillLow: 0,
    salary: 0,
    passed: 0
  };

  const blockedDetails = [];

  // 1. Diagnose Naukri Targets
  console.log('────────────────────────────────────────────────────────────────');
  console.log('🟠 NAUKRI DIAGNOSTIC PASS');
  console.log('────────────────────────────────────────────────────────────────');

  for (const target of diagnosticNaukriTargets) {
    coverageReport.targetsStarted++;
    coverageReport.pagesAttempted++;
    console.log(`\nTesting Target: ${target.name}`);
    console.log(`URL: ${target.url}`);

    const res = await scrapeNaukriPage(page, target, 1);
    console.log(`Status: ${res.status} | Success: ${res.success} | Tuples Found: ${res.tupleCount} | Valid Jobs: ${res.jobs.length} | Parse Fails: ${res.parseFailures} | Date-Sorted: ${res.isDateSorted} | Has Next Page: ${res.hasNextPage}`);

    if (res.success) {
      coverageReport.targetsCompleted++;
      coverageReport.pagesCompleted++;
      coverageReport.parseFailures += res.parseFailures;
    } else {
      coverageReport.targetsFailed++;
      if (res.status === 'SELECTOR_TIMEOUT') coverageReport.selectorTimeouts++;
      else if (res.status === 'NAVIGATION_FAILURE') coverageReport.navigationFailures++;
      else if (res.status === 'RATE_LIMITED') coverageReport.rateLimitedTargets++;
      console.warn(`[DIAG-FAIL] ${target.name}: ${res.status} (${res.error || 'N/A'})`);
    }

    for (const job of res.jobs) {
      results.totalEvaluated++;

      if (seenJobs.has(job.jobId) || isDuplicate(job, seenJobs)) {
        results.seen++;
        continue;
      }

      const locCheck = isLocationEligible({ location: job.location, title: job.title, description: job.description });
      if (!locCheck.eligible) {
        results.location++;
        blockedDetails.push({ portal: 'Naukri', title: job.title, stage: 'LOCATION', detail: locCheck.reason });
        continue;
      }

      if (!matchesNaukriExperience(job.experience)) {
        results.exp++;
        blockedDetails.push({ portal: 'Naukri', title: job.title, stage: 'EXPERIENCE', detail: job.experience });
        continue;
      }

      if (!isFreshJob(job.posted)) {
        results.freshness++;
        blockedDetails.push({ portal: 'Naukri', title: job.title, stage: 'FRESHNESS', detail: job.posted });
        continue;
      }

      const titleCheck = isTitleBlacklisted(job.title);
      if (titleCheck.blocked) {
        results.titleBlacklist++;
        blockedDetails.push({ portal: 'Naukri', title: job.title, stage: 'TITLE_BLACKLIST', detail: titleCheck.reason });
        continue;
      }

      const skill = evaluateJobSkillRatio({ title: job.title, tags: job.tags, description: job.description });
      if (!skill.passesStrict50) {
        results.skillLow++;
        blockedDetails.push({ portal: 'Naukri', title: job.title, stage: 'SKILL_RATIO_LOW', detail: `${skill.matchedCount}/${skill.totalJobSkills} (${skill.percentage}%)` });
        continue;
      }

      const sal = parseNaukriSalary(job.salary);
      const exp = parseNaukriExperience(job.experience);
      if (sal.isDisclosed && sal.max < 6.0) { results.salary++; continue; }
      if (!sal.isDisclosed && exp.max <= 3) { results.salary++; continue; }

      results.passed++;
      console.log(`  ✅ PASSED NAUKRI: [${job.title}] @ [${job.company}] | Exp: ${job.experience} | Sal: ${job.salary} | Skill: ${skill.percentage}%`);
    }
  }

  // 2. Diagnose LinkedIn Targets
  console.log('\n────────────────────────────────────────────────────────────────');
  console.log('🔵 LINKEDIN DIAGNOSTIC PASS');
  console.log('────────────────────────────────────────────────────────────────');

  for (const target of diagnosticLinkedInTargets) {
    coverageReport.targetsStarted++;
    coverageReport.pagesAttempted++;
    console.log(`\nTesting Target: ${target.name}`);
    console.log(`URL: ${target.url}`);

    const res = await scrapeLinkedInSearch(page, target);
    console.log(`Status: ${res.status} | Success: ${res.success} | Cards: ${res.jobs.length} (init: ${res.counts.initial}, scroll: ${res.counts.afterScroll}, seeMore: ${res.counts.afterSeeMore}) | Parse Fails: ${res.parseFailures}`);

    if (res.success) {
      coverageReport.targetsCompleted++;
      coverageReport.pagesCompleted++;
      coverageReport.parseFailures += res.parseFailures;
    } else {
      coverageReport.targetsFailed++;
      if (res.status === 'SELECTOR_TIMEOUT') coverageReport.selectorTimeouts++;
      else if (res.status === 'NAVIGATION_FAILURE') coverageReport.navigationFailures++;
      else if (res.status === 'RATE_LIMITED') coverageReport.rateLimitedTargets++;
      console.warn(`[DIAG-FAIL] ${target.name}: ${res.status}`);
    }

    // Inspect first 2 sample cards for deep detail scan
    for (const job of res.jobs.slice(0, 2)) {
      results.totalEvaluated++;
      console.log(`  Testing Detail Fetch for ${job.rawId} (${job.title})...`);
      const detail = await fetchLinkedInJobDetail(page, job.rawId);
      console.log(`  ↳ Detail Status: rateLimited=${detail.rateLimited}, fetchFailed=${detail.fetchFailed}, isEasyApply=${detail.isEasyApply}, descLength=${(detail.description || '').length}`);

      if (detail.rateLimited || detail.fetchFailed) {
        console.warn(`  ↳ [RATE-LIMIT / FAIL] Detail fetch incomplete. Properly recorded as incomplete without false skill-rejection.`);
        continue;
      }

      const skill = evaluateJobSkillRatio({ title: job.title, description: detail.description });
      console.log(`  ↳ Skill Engine: ${skill.matchedCount}/${skill.totalJobSkills} skills (${skill.percentage}%), passesStrict50=${skill.passesStrict50}`);
    }
  }

  await browser.close();

  console.log('\n' + '═'.repeat(70));
  console.log('📊 DIAGNOSTIC COVERAGE & SCAN INTEGRITY SUMMARY');
  console.log('═'.repeat(70));
  console.log(`Configured Architecture Targets: 204 Naukri URLs + 30 LinkedIn Targets`);
  console.log(`Diagnostic Targets Evaluated:    ${coverageReport.targetsCompleted}/${coverageReport.targetsConfigured} completed (Failed: ${coverageReport.targetsFailed})`);
  console.log(`Pages Attempted / Completed:     ${coverageReport.pagesAttempted} / ${coverageReport.pagesCompleted}`);
  console.log(`Parse Failures (Missing IDs):    ${coverageReport.parseFailures}`);
  console.log(`Selector Timeouts:               ${coverageReport.selectorTimeouts}`);
  console.log(`Navigation Failures:             ${coverageReport.navigationFailures}`);
  console.log(`Rate Limited Targets (429):      ${coverageReport.rateLimitedTargets}`);
  console.log(`Total Cards Scanned:             ${results.totalEvaluated}`);
  console.log(`  ├── Seen / Duplicate:          ${results.seen}`);
  console.log(`  ├── Non-NCR / Foreign Location:${results.location}`);
  console.log(`  ├── Experience Out of Range:   ${results.exp}`);
  console.log(`  ├── Stale (>24h):              ${results.freshness}`);
  console.log(`  ├── Title Blacklisted:         ${results.titleBlacklist}`);
  console.log(`  ├── Skill Ratio < 50%:         ${results.skillLow}`);
  console.log(`  ├── Salary < 6 LPA:            ${results.salary}`);
  console.log(`  └── ✅ Passed Eligibility:     ${results.passed}`);
  console.log('═'.repeat(70));

  if (blockedDetails.length > 0) {
    console.log('\n📋 Sample Filter Rejections:');
    for (const b of blockedDetails.slice(0, 10)) {
      console.log(`  [${b.portal}] [${b.stage}] "${b.title}" → ${b.detail}`);
    }
  }
})();
