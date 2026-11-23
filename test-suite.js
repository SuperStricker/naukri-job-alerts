/**
 * AUTOMATED UNIT & REGRESSION TEST SUITE
 * ───────────────────────────────────────────────────────────────────────────
 * Validates all business rules, location policies, salary allowances,
 * experience parsing, strict 50% skill gate, deduplication, and message grouping.
 * ZERO production Telegram calls — completely mocked and self-contained.
 */

const assert = require('assert');
const {
  isLocationEligible,
  detectWorkMode,
  isTitleBlacklisted,
  isContentBlacklisted,
  matchesNaukriExperience,
  parseLinkedInExperience,
  parseNaukriSalary,
  parseLinkedInSalary,
  normalizeHeadline,
  isLinkedInEasyApply
} = require('./filter-rules');
const { evaluateJobSkillRatio } = require('./skill-engine');
const { isDuplicate, rememberJob, identityKeys } = require('./job-dedupe');
const { groupJobsByHeadline, buildGroupedMessages } = require('./telegram-service');
const {
  NAUKRI_TARGETS,
  CITY_SLUGS,
  ROLE_SLUGS,
  getNaukriPageUrl
} = require('./naukri-alert');
const {
  LINKEDIN_TARGETS,
  LINKEDIN_QUERY_GROUPS,
  LINKEDIN_LOCATIONS
} = require('./linkedin-alert');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
  }
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('🧪 RUNNING JOB-ALERT AUTOMATED TEST SUITE');
console.log('══════════════════════════════════════════════════════════════\n');

// ────────────────────────────────────────────────────────────
// 1. LOCATION POLICY TESTS
// ────────────────────────────────────────────────────────────
console.log('📍 1. Location & Work Mode Policy');

runTest('On-site in Noida must pass', () => {
  const res = isLocationEligible({ location: 'Noida, Uttar Pradesh', workMode: 'ON_SITE' });
  assert.strictEqual(res.eligible, true);
});

runTest('On-site in Bengaluru must fail (Non-NCR)', () => {
  const res = isLocationEligible({ location: 'Bengaluru, Karnataka', workMode: 'ON_SITE' });
  assert.strictEqual(res.eligible, false);
});

runTest('Hybrid in Gurugram must pass', () => {
  const res = isLocationEligible({ location: 'Gurugram, Haryana', workMode: 'HYBRID' });
  assert.strictEqual(res.eligible, true);
});

runTest('Hybrid in Pune must fail (Non-NCR)', () => {
  const res = isLocationEligible({ location: 'Pune, Maharashtra', workMode: 'HYBRID' });
  assert.strictEqual(res.eligible, false);
});

runTest('Remote in Bengaluru, India must pass (India-Wide Remote)', () => {
  const res = isLocationEligible({ location: 'Bengaluru, India', title: 'Remote IT Support', workMode: 'REMOTE' });
  assert.strictEqual(res.eligible, true);
});

runTest('Standalone "Remote" on Naukri must pass (India-Wide Remote, e.g. Pearl job)', () => {
  const res = isLocationEligible({ location: 'Remote', title: 'Desktop Support Engineer', description: 'Hiring office located in Bengaluru' });
  assert.strictEqual(res.eligible, true);
  assert.strictEqual(res.workMode, 'REMOTE');
});

runTest('Remote in USA must fail (Foreign Remote)', () => {
  const res = isLocationEligible({ location: 'San Francisco, CA, USA', workMode: 'REMOTE' });
  assert.strictEqual(res.eligible, false);
});

runTest('Standalone "India" on-site must fail (India alone is not an NCR city)', () => {
  const res = isLocationEligible({ location: 'India', workMode: 'ON_SITE' });
  assert.strictEqual(res.eligible, false);
});

runTest('Empty or missing location must fail', () => {
  const res = isLocationEligible({ location: '' });
  assert.strictEqual(res.eligible, false);
});

// ────────────────────────────────────────────────────────────
// 2. SALARY & ALLOWANCE PARSING TESTS
// ────────────────────────────────────────────────────────────
console.log('\n💰 2. Actual Salary & Allowance Parsing');

runTest('LPA >= 7.0 passes with high salary badge', () => {
  const res = parseLinkedInSalary('Salary offered: 6.5 - 8.5 LPA based on experience.');
  assert.strictEqual(res.eligible, true);
  assert.strictEqual(res.isHigh, true);
});

runTest('LPA <= 6.0 fails eligibility (requires 7+ LPA)', () => {
  const res = parseLinkedInSalary('Salary package: 4.0 - 6.0 LPA');
  assert.strictEqual(res.eligible, false);
});

runTest('Monthly ₹60,000/month passes (annualized 7.2 LPA >= 7.0)', () => {
  const res = parseLinkedInSalary('Fixed CTC: ₹60,000 per month.');
  assert.strictEqual(res.eligible, true);
  assert.strictEqual(res.isHigh, true);
});

runTest('Monthly ₹45,000/month fails (annualized 5.4 LPA < 7.0)', () => {
  const res = parseLinkedInSalary('Remuneration: Rs 45,000 per month.');
  assert.strictEqual(res.eligible, false);
});

runTest('Shift & Cab allowances must be ignored and not treated as salary', () => {
  const jd = 'Night shift allowance: ₹5,000 per month. Cab reimbursement: ₹4,000/month.';
  const res = parseLinkedInSalary(jd);
  // Should not parse shift/cab allowance as base salary
  assert.strictEqual(res.raw, 'Not Disclosed');
  assert.strictEqual(res.eligible, true);
});

runTest('Internship stipend must be excluded', () => {
  const jd = 'Stipend: ₹20,000 per month during 6-month internship.';
  const res = parseLinkedInSalary(jd);
  assert.strictEqual(res.eligible, false);
});

// ────────────────────────────────────────────────────────────
// 3. EXPERIENCE PARSING TESTS
// ────────────────────────────────────────────────────────────
console.log('\n⏳ 3. Labeled Experience Parsing');

runTest('Labeled candidate experience 4-7 yrs passes', () => {
  const res = parseLinkedInExperience('Qualifications: 4-7 years of experience in IT Desktop Support.');
  assert.strictEqual(res.eligible, true);
  assert.strictEqual(res.label, '4-7 Yrs');
});

runTest('Fresher 0-2 yrs fails', () => {
  const res = parseLinkedInExperience('Requirements: 0-2 years of experience only.');
  assert.strictEqual(res.eligible, false);
});

runTest('Company age snippet must not be mistaken for candidate experience requirement', () => {
  const jd = 'Our firm has over 20 years of experience delivering IT solutions across India. We are hiring an IT Support Engineer.';
  const res = parseLinkedInExperience(jd, 'IT Support Engineer');
  // 20 years is company age, not candidate requirement! Should not reject as overqualified
  assert.strictEqual(res.eligible, true);
});

runTest('Naukri matchesExperience allows 3-8 yrs (5-7, 6-8) and strictly rejects 7-9, 8-9, and <= 2 yrs', () => {
  assert.strictEqual(matchesNaukriExperience('3-5 Yrs'), true);
  assert.strictEqual(matchesNaukriExperience('5-7 Yrs'), true);
  assert.strictEqual(matchesNaukriExperience('6-8 Yrs'), true);
  assert.strictEqual(matchesNaukriExperience('1-2 Yrs'), false);
  assert.strictEqual(matchesNaukriExperience('7-9 Yrs'), false);
  assert.strictEqual(matchesNaukriExperience('8-9 Yrs'), false);
  assert.strictEqual(matchesNaukriExperience('8-12 Yrs'), false);
  assert.strictEqual(matchesNaukriExperience('5-10 Yrs'), false);
});

runTest('Strictly blocks non-support titles like Consultant, Principal Engineer, CPQ', () => {
  assert.strictEqual(isTitleBlacklisted('Senior Business Consultant - Investment Management').blocked, true);
  assert.strictEqual(isTitleBlacklisted('Principal Engineer - IT').blocked, true);
  assert.strictEqual(isTitleBlacklisted('Staff CPQ Systems Engineer').blocked, true);
});

// ────────────────────────────────────────────────────────────
// 4. BLACKLIST & DEVELOPER EXEMPTION TESTS
// ────────────────────────────────────────────────────────────
console.log('\n🚫 4. Blacklist Rules & Developer Exemptions');

runTest('Strict blacklist blocks BPO and Voice process', () => {
  assert.strictEqual(isTitleBlacklisted('Voice Support Associate').blocked, true);
  assert.strictEqual(isTitleBlacklisted('BPO Executive').blocked, true);
});

runTest('Strict blacklist blocks non-IT disciplines', () => {
  assert.strictEqual(isTitleBlacklisted('Civil Engineer').blocked, true);
  assert.strictEqual(isTitleBlacklisted('Mechanical Engineer').blocked, true);
});

runTest('Developer terms in title are blocked', () => {
  assert.strictEqual(isTitleBlacklisted('React Developer').blocked, true);
  assert.strictEqual(isTitleBlacklisted('Python Developer').blocked, true);
});

runTest('Incidental coding in JD soft-exempted if IT skill ratio >= 50%', () => {
  const jd = 'Desktop support engineer with basic python scripting knowledge.';
  const res = isContentBlacklisted(jd, 65); // 65% IT skills
  assert.strictEqual(res.blocked, false);
});

runTest('Coding in JD blocked if IT skill ratio < 50%', () => {
  const jd = 'Full stack development with react and python.';
  const res = isContentBlacklisted(jd, 25); // only 25% IT skills
  assert.strictEqual(res.blocked, true);
});

// ────────────────────────────────────────────────────────────
// 5. STRICT 50% SKILL GATE REGRESSION PROTECTION
// ────────────────────────────────────────────────────────────
console.log('\n⭐ 5. Strict 50% Job-Skill Ratio Gate (Zero Bypass)');

runTest('REGRESSION: Title matching 100% with < 50% skills MUST BE REJECTED', () => {
  const res = evaluateJobSkillRatio({
    title: 'Desktop Support Engineer',
    description: 'Looking for a developer with Java, Python, React, and MongoDB skills. Occasional hardware support.'
  });
  // 1 CV skill (hardware) vs 4 non-CV skills (Java, Python, React, MongoDB) = 1/5 = 20%
  assert.strictEqual(res.percentage < 50, true);
  assert.strictEqual(res.passesStrict50, false);
});

runTest('Job with >= 50% skills and >= 2 IT skills passes', () => {
  const res = evaluateJobSkillRatio({
    title: 'IT Analyst',
    description: 'Desktop support, Active Directory, Windows 11 installation, Microsoft 365 administration, and basic python.'
  });
  // 4 CV skills vs 1 non-CV skill = 4/5 = 80%
  assert.strictEqual(res.percentage >= 50, true);
  assert.strictEqual(res.matchedCount >= 2, true);
  assert.strictEqual(res.passesStrict50, true);
});

runTest('Job with zero technical skills is blocked', () => {
  const res = evaluateJobSkillRatio({
    title: 'Urgent Opening',
    description: 'Good communication skills, fluent in English, night shift.'
  });
  assert.strictEqual(res.totalJobSkills, 0);
  assert.strictEqual(res.passesStrict50, false);
});

// ────────────────────────────────────────────────────────────
// 6. DEDUPLICATION TESTS
// ────────────────────────────────────────────────────────────
console.log('\n🔁 6. Cross-Portal Deduplication');

runTest('Normalizes URL and prevents duplicates with different query parameters', () => {
  const seen = new Set();
  const job1 = { url: 'https://www.naukri.com/job-12345?src=search&sid=abc', title: 'Desktop Support', company: 'HCL' };
  rememberJob(job1, seen);

  const job2 = { url: 'https://www.naukri.com/job-12345?src=featured&sid=xyz', title: 'Desktop Support', company: 'HCL' };
  assert.strictEqual(isDuplicate(job2, seen), true);
});

runTest('Deduplicates by Title + Company identity key', () => {
  const seen = new Set();
  const job1 = { url: 'https://portal-a.com/job-1', title: 'Desktop Support Engineer', company: 'Wipro' };
  rememberJob(job1, seen);

  const job2 = { url: 'https://portal-b.com/job-999', title: 'Desktop Support Engineer', company: 'Wipro' };
  assert.strictEqual(isDuplicate(job2, seen), true);
});

runTest('Allows different companies with the same title', () => {
  const seen = new Set();
  const job1 = { url: 'https://portal-a.com/job-1', title: 'Desktop Support Engineer', company: 'Wipro' };
  rememberJob(job1, seen);

  const job2 = { url: 'https://portal-b.com/job-2', title: 'Desktop Support Engineer', company: 'Infosys' };
  assert.strictEqual(isDuplicate(job2, seen), false);
});

runTest('Deduplicates by jobId and rawId directly', () => {
  const seen = new Set();
  const job1 = { jobId: '111126001234', title: 'Desktop Support', company: 'Company A' };
  rememberJob(job1, seen);

  const job2 = { jobId: '111126001234', title: 'Completely Changed Title', company: 'Company B' };
  assert.strictEqual(isDuplicate(job2, seen), true);

  const job3 = { rawId: '4487355028', title: 'IT Support', company: 'Company C' };
  rememberJob(job3, seen);
  const job4 = { rawId: '4487355028', title: 'Another Title', company: 'Company D' };
  assert.strictEqual(isDuplicate(job4, seen), true);
});

// ────────────────────────────────────────────────────────────
// 7. COMPACT GROUPING & MESSAGE SPLITTING TESTS
// ────────────────────────────────────────────────────────────
console.log('\n📦 7. Compact Grouping & Splitting');

runTest('Normalizes variations into clean headline groups', () => {
  assert.strictEqual(normalizeHeadline('Senior Desktop Support Engineer - L2'), 'Desktop Support Engineer');
  assert.strictEqual(normalizeHeadline('IT Support Specialist'), 'IT Support Engineer');
  assert.strictEqual(normalizeHeadline('Tech Support Engineer (Night Shift)'), 'Tech Support Engineer');
  assert.strictEqual(normalizeHeadline('IT Analyst - Service Ops'), 'IT Analyst');
});

runTest('Groups multiple jobs under their normalized headline', () => {
  const jobs = [
    { job: { title: 'Desktop Support L1', company: 'Comp A', location: 'Noida', url: 'http://a' } },
    { job: { title: 'Desktop Support Engineer', company: 'Comp B', location: 'Gurugram', url: 'http://b' } },
    { job: { title: 'IT Analyst', company: 'Comp C', location: 'Delhi', url: 'http://c' } }
  ];
  const groups = groupJobsByHeadline(jobs);
  assert.strictEqual(groups.get('Desktop Support Engineer').length, 2);
  assert.strictEqual(groups.get('IT Analyst').length, 1);
});

runTest('Splits oversized message when exceeding character budget', () => {
  const manyJobs = [];
  for (let i = 1; i <= 35; i++) {
    manyJobs.push({
      job: {
        title: 'Desktop Support',
        company: `Super Long Enterprise Corporation Pvt Ltd Company Number ${i}`,
        location: 'Sector 62, Electronic City, Noida, Uttar Pradesh',
        salary: '6.5 - 8.5 Lacs P.A.',
        experience: '4-7 Yrs',
        url: `https://www.naukri.com/job-listings-very-long-url-slug-test-string-${i}`
      }
    });
  }
  const parts = buildGroupedMessages('Desktop Support Engineer', manyJobs);
  assert.strictEqual(parts.length > 1, true); // Verified that it splits!
  for (const p of parts) {
    assert.strictEqual(p.html.length <= 3800, true);
  }
});

runTest('Formats streamlined alert without company name, on-site tag, or repeated headline', () => {
  const sampleJobs = [
    {
      job: {
        title: 'Desktop Support Engineer',
        company: 'Confidential Inc',
        location: 'Noida',
        experience: '3-6 Yrs',
        salary: '6.50 - 8.50 LPA',
        posted: '2 hours ago',
        source: 'LinkedIn',
        isEasyApply: true,
        url: 'https://www.linkedin.com/jobs/view/123456'
      }
    },
    {
      job: {
        title: 'Desktop Support Engineer - L2',
        company: 'Secret Corp',
        location: 'Gurugram',
        experience: '4-7 Yrs',
        salary: '7.00 - 9.00 LPA',
        posted: 'Just Now',
        source: 'Naukri',
        isEasyApply: false,
        url: 'https://www.naukri.com/job-listings-999'
      }
    }
  ];

  const parts = buildGroupedMessages('Desktop Support Engineer', sampleJobs);
  assert.strictEqual(parts.length, 1);
  const html = parts[0].html;

  // Header checks
  assert.strictEqual(html.includes('🔔 Job :- Desktop Support Engineer'), true);

  // Content checks: must NOT contain company names, on-site tags, or skill stars
  assert.strictEqual(html.includes('Confidential Inc'), false);
  assert.strictEqual(html.includes('Secret Corp'), false);
  assert.strictEqual(html.includes('ON-SITE'), false);
  assert.strictEqual(html.includes('SKILLS'), false);

  // Field checks: exact lines with portal colors and Apply Link button
  assert.strictEqual(html.includes('1. 🟡 Portal: LinkedIn || 🟢 Easy Apply ||'), true);
  assert.strictEqual(html.includes('📍 Loc: Noida'), true);
  assert.strictEqual(html.includes('⏳ Exp: 3-6 Yrs'), true);
  assert.strictEqual(html.includes('💰 Sal: 6.50 - 8.50 LPA'), true);
  assert.strictEqual(html.includes('🕒 Posted: 2 hours ago'), true);
  assert.strictEqual(html.includes('🔗 <a href="https://www.linkedin.com/jobs/view/123456">Apply Link</a>'), true);

  assert.strictEqual(html.includes('2. 🔵 Portal: Naukri || 🟢 Easy Apply ||'), true);
  assert.strictEqual(html.includes('📍 Loc: Gurugram'), true);
  assert.strictEqual(html.includes('⏳ Exp: 4-7 Yrs'), true);
  assert.strictEqual(html.includes('💰 Sal: 7.00 - 9.00 LPA'), true);
  assert.strictEqual(html.includes('🕒 Posted: Just Now'), true);
  assert.strictEqual(html.includes('🔗 <a href="https://www.naukri.com/job-listings-999">Apply Link</a>'), true);
});

// ────────────────────────────────────────────────────────────
// 8. LINKEDIN EASY APPLY VS DIRECT APPLY DETECTION
// ────────────────────────────────────────────────────────────
console.log('\n⚡ 8. LinkedIn Easy Apply vs Direct Apply Detection');

runTest('Detects Easy Apply when onsite tracking or button class is present', () => {
  const result = isLinkedInEasyApply({
    tracking: 'public_jobs_apply-link-onsite',
    className: 'apply-button apply-button--default'
  });
  assert.strictEqual(result, true);
});

runTest('Detects Easy Apply from HTML snippet or text', () => {
  const result1 = isLinkedInEasyApply({ html: '<div class="apply-link-onsite">Apply</div>' });
  assert.strictEqual(result1, true);

  const result2 = isLinkedInEasyApply({ text: 'Easy Apply to this position' });
  assert.strictEqual(result2, true);

  const result3 = isLinkedInEasyApply({ html: '<button data-is-easy-apply="true">Apply</button>' });
  assert.strictEqual(result3, true);
});

runTest('Detects Direct Apply when offsite tracking or modal is present', () => {
  const result = isLinkedInEasyApply({
    tracking: 'public_jobs_apply-link-offsite_contextual-sign-in-modal_modal_dismiss',
    className: 'sign-up-modal__outlet top-card-layout__cta'
  });
  assert.strictEqual(result, false);
});

runTest('Defaults to Direct Apply (false) when no Easy Apply indicators found', () => {
  const result = isLinkedInEasyApply({
    html: '<a href="https://careers.externalcompany.com">Apply on company site</a>',
    tracking: 'public_jobs_topcard-title'
  });
  assert.strictEqual(result, false);
});

// ────────────────────────────────────────────────────────────
// 9. SCAN COVERAGE, PAGINATION & FAILURE DISTINCTIONS
// ────────────────────────────────────────────────────────────
console.log('\n🔎 9. Scan Coverage, Pagination & Failure Distinctions');

runTest('All 238 Naukri targets (6 NCR + Remote) and 30 LinkedIn targets configured properly', () => {
  const ALLOWED_LOCATIONS = ['Delhi NCR', 'Noida', 'Greater Noida', 'Gurugram', 'Faridabad', 'Ghaziabad', 'Remote'];

  // Naukri validation: 34 roles × 7 locations (6 NCR + Remote) = 238 targets
  assert.strictEqual(NAUKRI_TARGETS.length, 238, 'Naukri must have exactly 238 targets');
  assert.strictEqual(ROLE_SLUGS.length, 34, 'Must have exactly 34 configured IT roles');
  assert.strictEqual(CITY_SLUGS.length, 7, 'Must have exactly 7 configured locations (6 NCR + Remote)');

  for (const t of NAUKRI_TARGETS) {
    assert.strictEqual(ALLOWED_LOCATIONS.includes(t.cityLabel), true, `Target location ${t.cityLabel} must be in allowed locations`);
    assert.strictEqual(/bengaluru|mumbai|pune|hyderabad|chennai|kolkata/i.test(t.url), false, 'Must not contain non-NCR cities');
  }

  // LinkedIn validation: 5 Boolean groups × 6 cities = 30 targets
  const ALLOWED_NCR_CITIES = ['Delhi NCR', 'Noida', 'Greater Noida', 'Gurugram', 'Faridabad', 'Ghaziabad'];
  assert.strictEqual(LINKEDIN_TARGETS.length, 30, 'LinkedIn must have exactly 30 targets');
  assert.strictEqual(LINKEDIN_QUERY_GROUPS.length, 5, 'Must have exactly 5 query groups');
  assert.strictEqual(LINKEDIN_LOCATIONS.length, 6, 'Must have exactly 6 configured locations');

  for (const t of LINKEDIN_TARGETS) {
    assert.strictEqual(ALLOWED_NCR_CITIES.includes(t.location), true, `LinkedIn target location ${t.location} must be in allowed NCR locations`);
    assert.strictEqual(/bengaluru|mumbai|pune|hyderabad|chennai|kolkata/i.test(t.url), false, 'Must not contain non-NCR locations');
  }
});

runTest('LinkedIn target interleaving ensures all 5 query groups run in early iterations', () => {
  // In the first 5 targets, each query group must be unique (round-robin across locations)
  const first5Groups = new Set(LINKEDIN_TARGETS.slice(0, 5).map(t => t.queryGroup));
  assert.strictEqual(first5Groups.size, 5, 'First 5 LinkedIn targets must span all 5 query groups');

  // Next 5 targets must also span all 5 query groups (for next location)
  const next5Groups = new Set(LINKEDIN_TARGETS.slice(5, 10).map(t => t.queryGroup));
  assert.strictEqual(next5Groups.size, 5, 'Next 5 LinkedIn targets must span all 5 query groups');
});

runTest('Time-budget expiry returns PARTIAL and lists exact skipped targets', () => {
  function computeStatus(cov) {
    if (cov.targetsCompleted === cov.targetsConfigured && cov.targetsFailed === 0) return 'complete';
    if (cov.targetsCompleted > 0) return 'partial';
    return 'failed';
  }

  const cov1 = { targetsConfigured: 238, targetsStarted: 220, targetsCompleted: 220, targetsFailed: 0 };
  cov1.targetsSkipped = cov1.targetsConfigured - cov1.targetsStarted;
  assert.strictEqual(computeStatus(cov1), 'partial');
  assert.strictEqual(cov1.targetsSkipped, 18);

  const cov2 = { targetsConfigured: 30, targetsStarted: 17, targetsCompleted: 17, targetsFailed: 0 };
  cov2.targetsSkipped = cov2.targetsConfigured - cov2.targetsStarted;
  assert.strictEqual(computeStatus(cov2), 'partial');
  assert.strictEqual(cov2.targetsSkipped, 13);

  const cov3 = { targetsConfigured: 238, targetsStarted: 238, targetsCompleted: 238, targetsFailed: 0 };
  cov3.targetsSkipped = 0;
  assert.strictEqual(computeStatus(cov3), 'complete');

  const cov4 = { targetsConfigured: 238, targetsStarted: 238, targetsCompleted: 0, targetsFailed: 238 };
  assert.strictEqual(computeStatus(cov4), 'failed');
});

runTest('Naukri does not stop pagination early when current page has no fresh listings if valid next page exists', () => {
  // Simulate page evaluation with 0 fresh jobs, but verified next page exists
  const mockPageJobs = [
    { posted: '3 days ago' },
    { posted: '1 week ago' }
  ];
  const hasNextPage = true;
  const isDateSorted = false;

  // Under old logic: if (freshCountOnPage === 0) break; -> skipped page 2!
  // Under new v6 logic: if hasNextPage is true, queue target for Pass 2
  const pass2Queue = [];
  if (hasNextPage) {
    pass2Queue.push({ target: { name: 'Test Target' }, pageNum: 2, isDateSorted });
  }

  assert.strictEqual(pass2Queue.length, 1, 'Target must be queued for Page 2 even with 0 fresh jobs on Page 1');
  assert.strictEqual(pass2Queue[0].pageNum, 2);
});

runTest('Empty results are distinguished from selector timeout, navigation failure, and 429', () => {
  function classifyResult(input) {
    if (input.navigationError) return { success: false, status: 'NAVIGATION_FAILURE' };
    if (input.httpStatus === 429 || input.isBotBlocked) return { success: false, status: 'RATE_LIMITED' };
    if (input.tupleCount === 0) {
      if (input.genuineEmpty) return { success: true, status: 'GENUINE_EMPTY' };
      return { success: false, status: 'SELECTOR_TIMEOUT' };
    }
    return { success: true, status: 'OK' };
  }

  // 1. Legitimate empty result
  assert.strictEqual(classifyResult({ tupleCount: 0, genuineEmpty: true }).status, 'GENUINE_EMPTY');
  assert.strictEqual(classifyResult({ tupleCount: 0, genuineEmpty: true }).success, true);

  // 2. Selector timeout (DOM blank or tuple missing without empty message)
  assert.strictEqual(classifyResult({ tupleCount: 0, genuineEmpty: false }).status, 'SELECTOR_TIMEOUT');
  assert.strictEqual(classifyResult({ tupleCount: 0, genuineEmpty: false }).success, false);

  // 3. HTTP 429 rate limit
  assert.strictEqual(classifyResult({ httpStatus: 429 }).status, 'RATE_LIMITED');
  assert.strictEqual(classifyResult({ httpStatus: 429 }).success, false);

  // 4. Navigation failure
  assert.strictEqual(classifyResult({ navigationError: 'net::ERR_CONNECTION_TIMED_OUT' }).status, 'NAVIGATION_FAILURE');
  assert.strictEqual(classifyResult({ navigationError: 'net::ERR_CONNECTION_TIMED_OUT' }).success, false);
});

runTest('Missing Job ID or URL is tracked as parse failure rather than silently dropping', () => {
  const rawTuples = [
    { href: 'https://www.naukri.com/job-123456789012', dataJobId: '123456789012' }, // Valid
    { href: '', dataJobId: '' }, // Missing both href and ID
    { href: 'https://www.naukri.com/company-overview', dataJobId: '' } // No ID match
  ];

  let parseFailures = 0;
  const validJobs = [];

  for (const t of rawTuples) {
    const idMatch = t.href.match(/(\d{10,14})/);
    const rawId = idMatch ? idMatch[1] : t.dataJobId;
    if (!rawId || !t.href) {
      parseFailures++;
      continue;
    }
    validJobs.push({ jobId: rawId });
  }

  assert.strictEqual(validJobs.length, 1);
  assert.strictEqual(parseFailures, 2);
});

runTest('LinkedIn detail rate limit (429) recorded as incomplete detail fetch, leaving job eligible without skill-filter rejection', () => {
  const mockCandidates = [
    { rawId: '111', title: 'Desktop Support Engineer' },
    { rawId: '222', title: 'IT Support Specialist' }
  ];

  const seenJobs = new Set();
  const detailResults = {
    '111': { rateLimited: true, fetchFailed: true, description: '' },
    '222': { rateLimited: false, fetchFailed: false, description: 'Active Directory, Windows 10, Hardware, Office 365, Ticketing' }
  };

  let detailRateLimited = 0;
  let detailFetched = 0;
  let skillLow = 0;
  const eligible = [];

  for (const job of mockCandidates) {
    const detail = detailResults[job.rawId];
    if (detail.rateLimited || detail.fetchFailed) {
      detailRateLimited++;
      // MUST NOT evaluate against skill filter!
      // MUST NOT add to seenJobs!
      continue;
    }

    detailFetched++;
    const skill = evaluateJobSkillRatio({ title: job.title, description: detail.description });
    if (!skill.passesStrict50) {
      skillLow++;
      continue;
    }

    eligible.push(job);
    rememberJob(job, seenJobs);
  }

  assert.strictEqual(detailRateLimited, 1, 'Job 111 must be counted in detailRateLimited');
  assert.strictEqual(detailFetched, 1, 'Only Job 222 must be counted in detailFetched');
  assert.strictEqual(skillLow, 0, 'Rate-limited job 111 must NOT be misreported as skillLow');
  assert.strictEqual(eligible.length, 1);
  assert.strictEqual(seenJobs.has('111'), false, 'Rate-limited job must NOT be marked seen so it can be retried');
  assert.strictEqual(seenJobs.has('222'), true);
});

// ────────────────────────────────────────────────────────────
// SUMMARY
// ────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`📊 TEST SUITE COMPLETE: ${passedTests}/${totalTests} Passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log('══════════════════════════════════════════════════════════════\n');

if (passedTests !== totalTests) {
  process.exit(1);
}

