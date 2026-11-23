/**
 * UNIFIED JOB ALERT ORCHESTRATOR (NAUKRI + LINKEDIN)
 * ──────────────────────────────────────────────────────────────────────────────
 * Zero-overlap modular architecture:
 *   1. filter-rules.js     → Single source of truth for location, salary, experience & blacklist
 *   2. skill-engine.js     → Single source of truth for strict 50% Job-Skill Ratio Engine
 *   3. job-dedupe.js       → Cross-portal URL & title+company deduplication
 *   4. telegram-service.js → Compact grouped alerts by headline & per-part delivery tracking
 *   5. naukri-alert.js     → Dedicated Naukri.com scraper (204 targets, Two-Pass scanner)
 *   6. linkedin-alert.js   → Dedicated LinkedIn scraper (30 targets, Interleaved + Resilient JD scan)
 */

const { runNaukri } = require('./naukri-alert');
const { runLinkedIn } = require('./linkedin-alert');
const { dispatchGroupedAlerts } = require('./telegram-service');
const fs = require('fs');
const path = require('path');

const SEEN_JOBS_FILE = path.join(__dirname, 'seen_jobs.json');

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

async function main() {
  const start = Date.now();
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   🚀 MULTI-PORTAL JOB ALERT ORCHESTRATOR (NAUKRI + LINKEDIN) ║');
  console.log(`║   ⏰ Started: ${new Date().toISOString()}              ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Verify Telegram secrets in production
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const isCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

  if (isCi && (!botToken || !chatId)) {
    console.error('[FATAL] Production CI workflow missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID secrets!');
    process.exit(1);
  }

  const seenJobs = loadSeenJobs();
  const isFirstRun = seenJobs.size === 0;

  let naukriRes = {
    jobs: [],
    scraped: 0,
    passed: 0,
    eligible: [],
    error: null,
    targetStatus: 'failed',
    targetsConfigured: 204,
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
    stopReason: null
  };

  let linkedinRes = {
    jobs: [],
    scraped: 0,
    passed: 0,
    eligible: [],
    error: null,
    targetStatus: 'failed',
    targetsConfigured: 30,
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
    stopReason: null
  };

  // 1. Run Naukri Scanner (Two-Pass High-Coverage)
  try {
    const res = await runNaukri({ returnEligible: true });
    naukriRes = { ...naukriRes, ...res };
  } catch (err) {
    naukriRes.error = err.message;
    naukriRes.targetStatus = 'failed';
    naukriRes.stopReason = `CRASH: ${err.message}`;
    console.error('[ERROR] Naukri module failed:', err);
  }

  // 2. Run LinkedIn Scanner (Interleaved + Resilient Detail Scan)
  try {
    const res = await runLinkedIn({ returnEligible: true });
    linkedinRes = { ...linkedinRes, ...res };
  } catch (err) {
    linkedinRes.error = err.message;
    linkedinRes.targetStatus = 'failed';
    linkedinRes.stopReason = `CRASH: ${err.message}`;
    console.error('[ERROR] LinkedIn module failed:', err);
  }

  // Combine passing jobs from both portals
  const allEligible = [...(naukriRes.eligible || []), ...(linkedinRes.eligible || [])];
  console.log(`\n📋 Combined Passing Eligible Jobs: ${allEligible.length} (Naukri: ${naukriRes.passed}, LinkedIn: ${linkedinRes.passed})`);

  // Dispatch Compact Grouped Telegram Alerts
  let dispatchSummary = { sentGroups: 0, sentJobs: 0, failedJobs: 0 };
  if (allEligible.length > 0) {
    dispatchSummary = await dispatchGroupedAlerts(allEligible, seenJobs, {
      botToken,
      chatId,
      isFirstRun,
      maxGroupCap: 6,
      dryRun: !botToken || !chatId
    });
  }

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

  // ────────────────────────────────────────────────────────────
  // EXPLICIT COVERAGE & EXECUTION REPORTING
  // ────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║   📊 MULTI-PORTAL SCAN COVERAGE & EXECUTION SUMMARY                                  ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║   🟠 NAUKRI   → Status: ${naukriRes.targetStatus.toUpperCase().padEnd(8)} | Targets: ${String(naukriRes.targetsCompleted).padStart(3)}/${naukriRes.targetsConfigured} completed (Failed: ${naukriRes.targetsFailed}, Skipped: ${naukriRes.targetsSkipped})`);
  console.log(`║                 Pages: ${String(naukriRes.pagesCompleted).padStart(3)}/${naukriRes.pagesAttempted} | Scraped: ${String(naukriRes.scraped).padStart(4)} | Eligible: ${String(naukriRes.passed).padStart(3)} | Parse Fails: ${naukriRes.parseFailures}`);
  if (naukriRes.stopReason) {
    console.log(`║                 Stop Reason: ${naukriRes.stopReason}`);
  }
  console.log('╠══════════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║   🔵 LINKEDIN → Status: ${linkedinRes.targetStatus.toUpperCase().padEnd(8)} | Targets: ${String(linkedinRes.targetsCompleted).padStart(3)}/${linkedinRes.targetsConfigured} completed (Failed: ${linkedinRes.targetsFailed}, Skipped: ${linkedinRes.targetsSkipped})`);
  console.log(`║                 Cards Extracted: ${String(linkedinRes.scraped).padStart(4)} | Eligible: ${String(linkedinRes.passed).padStart(3)} | Detail 429s: ${linkedinRes.detailRateLimited} | Parse Fails: ${linkedinRes.parseFailures}`);
  if (linkedinRes.stopReason) {
    console.log(`║                 Stop Reason: ${linkedinRes.stopReason}`);
  }
  console.log('╠══════════════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║   📤 TELEGRAM → Groups: ${String(dispatchSummary.sentGroups).padEnd(3)}  | Jobs Delivered: ${dispatchSummary.sentJobs}`);
  console.log(`║   ⏱️  DURATION → Total Execution Time: ${elapsedSec}s`);
  console.log('╚══════════════════════════════════════════════════════════════════════════════════════╝');

  // If both portals completely failed, exit with error code
  if (naukriRes.targetStatus === 'failed' && linkedinRes.targetStatus === 'failed') {
    console.error('[FATAL] Both job portal engines completely failed execution.');
    process.exit(1);
  }

  // If a portal experienced critical crash error, notify CI
  if ((naukriRes.error || linkedinRes.error) && isCi) {
    console.warn('[WARN] Partial portal failure detected.');
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[FATAL ORCHESTRATOR]', err);
    process.exit(1);
  });
}

module.exports = { main };
