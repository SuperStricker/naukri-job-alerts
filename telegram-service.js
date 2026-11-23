/**
 * COMPACT GROUPED TELEGRAM ALERT SERVICE
 * ───────────────────────────────────────────────────────────────────────────
 * Groups eligible IT job openings by normalized headline.
 * Implements Telegram message splitting (<= 3800 chars) and per-part delivery tracking.
 * ONLY records jobs in seen_jobs.json when their message part is confirmed delivered.
 */

const fs = require('fs');
const path = require('path');
const { normalizeHeadline } = require('./filter-rules');
const { isDuplicate, rememberJob } = require('./job-dedupe');

const SEEN_JOBS_FILE = path.join(__dirname, 'seen_jobs.json');
const MAX_TELEGRAM_CHARS = 3800; // Telegram limit is 4096, keeping safe margin

function escapeHtml(text = '') {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Groups an array of eligible jobs by normalized headline.
 * @param {Array} eligibleJobs - Array of { job, badges, skill } objects that already passed ALL filters
 * @returns {Map<string, Array>} Map of headline -> items
 */
function groupJobsByHeadline(eligibleJobs = []) {
  const groups = new Map();
  for (const item of eligibleJobs) {
    const headline = normalizeHeadline(item.job.title);
    if (!groups.has(headline)) {
      groups.set(headline, []);
    }
    groups.get(headline).push(item);
  }
  return groups;
}

/**
 * Builds HTML message chunks for a single headline group.
 * @param {string} headline - Normalized headline name
 * @param {Array} items - Items under this headline
 * @returns {Array<{ html: string, jobs: Array }>} Message parts with their associated jobs
 */
function buildGroupedMessages(headline, items = []) {
  if (!items || items.length === 0) return [];

  const chunks = [];
  let currentJobs = [];
  let currentBody = '';

  const formatEntry = (item, idx) => {
    const j = item.job;
    const isLinkedIn = j.source === 'LinkedIn';
    const portalTag = isLinkedIn ? '🟡 Portal: LinkedIn' : '🔵 Portal: Naukri';
    const typeLabel = '🟢 Easy Apply';
    const salText = (j.salary && j.salary.trim()) ? j.salary.trim() : 'Not Disclosed';
    const expText = (j.experience && j.experience.trim()) ? j.experience.trim() : 'Not Specified';
    const postText = (j.posted && j.posted.trim()) ? j.posted.trim() : 'Recently';

    return `\n${idx}. ${portalTag} || ${typeLabel} ||
   📍 Loc: ${escapeHtml(j.location)}
   ⏳ Exp: ${escapeHtml(expText)}
   💰 Sal: ${escapeHtml(salText)}
   🕒 Posted: ${escapeHtml(postText)}
   
   🔗 <a href="${j.url}">Apply Link</a>\n`;
  };

  const jobEntries = items.map((item, i) => ({
    job: item.job,
    text: formatEntry(item, i + 1)
  }));

  for (const entry of jobEntries) {
    const testBody = currentBody + entry.text;
    // Header takes ~120 chars
    if (testBody.length > MAX_TELEGRAM_CHARS - 180 && currentJobs.length > 0) {
      chunks.push({ jobs: currentJobs, body: currentBody });
      currentJobs = [entry.job];
      currentBody = entry.text;
    } else {
      currentJobs.push(entry.job);
      currentBody = testBody;
    }
  }

  if (currentJobs.length > 0) {
    chunks.push({ jobs: currentJobs, body: currentBody });
  }

  // Add headers with part numbering if split
  return chunks.map((chunk, idx) => {
    const partTag = chunks.length > 1 ? ` (Part ${idx + 1}/${chunks.length})` : '';
    const header = `🔔 Job :- ${escapeHtml(headline)}${partTag}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
    return {
      html: header + chunk.body,
      jobs: chunk.jobs
    };
  });
}

/**
 * Sends a message to Telegram.
 */
async function sendTelegramRaw(botToken, chatId, messageHtml) {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const res = await response.json();
    if (!res.ok) {
      console.error('[ERROR] Telegram API error:', res.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[ERROR] Telegram request failed:', err.message);
    return false;
  }
}

/**
 * Dispatches grouped alerts for all eligible jobs.
 * @param {Array} eligibleJobs - List of eligible jobs
 * @param {Set} seenJobs - Set of seen job IDs / keys
 * @param {Object} options - { botToken, chatId, isFirstRun, maxGroupCap, dryRun }
 * @returns {Promise<{ sentGroups: number, sentJobs: number, failedJobs: number }>}
 */
async function dispatchGroupedAlerts(eligibleJobs, seenJobs, options = {}) {
  const {
    botToken = process.env.TELEGRAM_BOT_TOKEN,
    chatId = process.env.TELEGRAM_CHAT_ID,
    isFirstRun = false,
    maxGroupCap = 6,
    dryRun = false
  } = options;

  if (eligibleJobs.length === 0) {
    return { sentGroups: 0, sentJobs: 0, failedJobs: 0 };
  }

  // Deduplicate against seenJobs and within the current dispatch batch
  const dedupedEligible = [];
  const batchSeen = new Set(seenJobs);
  for (const item of eligibleJobs) {
    if (batchSeen.has(item.job.jobId) || isDuplicate(item.job, batchSeen)) {
      continue;
    }
    rememberJob(item.job, batchSeen);
    dedupedEligible.push(item);
  }

  if (dedupedEligible.length === 0) {
    console.log('[DEDUPE] All eligible jobs have already been alerted or are duplicates in seenJobs.');
    return { sentGroups: 0, sentJobs: 0, failedJobs: 0 };
  }

  const groups = groupJobsByHeadline(dedupedEligible);
  console.log(`\n📦 Grouped ${dedupedEligible.length} eligible jobs into ${groups.size} headline group(s).`);

  let headlineList = Array.from(groups.keys());
  if (isFirstRun && headlineList.length > maxGroupCap) {
    console.log(`[FIRST-RUN] Limiting initial alerts to top ${maxGroupCap} groups.`);
    headlineList = headlineList.slice(0, maxGroupCap);
  }

  let totalSentJobs = 0;
  let totalFailedJobs = 0;
  let totalSentGroups = 0;

  for (const headline of headlineList) {
    const items = groups.get(headline);
    const messageParts = buildGroupedMessages(headline, items);

    let groupSuccess = true;
    for (const part of messageParts) {
      if (dryRun || !botToken || !chatId) {
        console.log(`\n[DRY-RUN ALERT: ${headline}] (${part.jobs.length} jobs)`);
        console.log(part.html.replace(/<[^>]+>/g, ''));
        // In dry run, DO NOT modify seenJobs
        continue;
      }

      console.log(`\n📤 Sending Telegram Group Alert: [${headline}] (${part.jobs.length} jobs)...`);
      const ok = await sendTelegramRaw(botToken, chatId, part.html);

      if (ok) {
        // ONLY mark jobs as seen when confirmed delivered!
        for (const job of part.jobs) {
          rememberJob(job, seenJobs);
        }
        totalSentJobs += part.jobs.length;

        // Persist seen_jobs.json immediately after each confirmed send
        try {
          const arr = Array.from(seenJobs).slice(-2000);
          fs.writeFileSync(SEEN_JOBS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
        } catch (e) {
          console.warn('[WARN] Failed intermediate state save:', e.message);
        }
      } else {
        console.error(`[ERROR] Failed to deliver group part for [${headline}]. Jobs left unseen for retry.`);
        groupSuccess = false;
        totalFailedJobs += part.jobs.length;
      }

      // Respect Telegram rate limits
      await new Promise(r => setTimeout(r, 1500));
    }

    if (groupSuccess) totalSentGroups++;
  }

  return {
    sentGroups: totalSentGroups,
    sentJobs: totalSentJobs,
    failedJobs: totalFailedJobs
  };
}

module.exports = {
  groupJobsByHeadline,
  buildGroupedMessages,
  dispatchGroupedAlerts,
  sendTelegramRaw
};

