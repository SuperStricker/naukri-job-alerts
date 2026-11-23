/**
 * FILTER RULES & DECISION ENGINE (Shared Single Source of Truth)
 * ───────────────────────────────────────────────────────────────────────────
 * Consolidates all pure business rules across Naukri, LinkedIn, and diagnose.js:
 *   1. Strict NCR Geofence + India-Wide Remote Policy
 *   2. Strict & Soft Developer Blacklists
 *   3. Labeled Experience Parsing (ignores company age/tenure text)
 *   4. Actual Salary Parsing (excludes cab/shift allowances, stipends & reimbursements)
 *   5. Normalized Headline Matcher for Compact Grouped Telegram Alerts
 */

// ════════════════════════════════════════════════════════
// 1. LOCATION & WORK MODE POLICY
// ════════════════════════════════════════════════════════

const NCR_CITIES = [
  'delhi', 'new delhi', 'noida', 'greater noida', 'gretar noida',
  'gurgaon', 'gurugram', 'gudgwao', 'ghaziabad', 'faridabad', 'ncr'
];

const INDIA_REGIONS = [
  'india', 'bangalore', 'bengaluru', 'pune', 'hyderabad', 'mumbai',
  'chennai', 'kolkata', 'ahmedabad', 'jaipur', 'chandigarh', 'kochi',
  'indore', 'karnataka', 'maharashtra', 'telangana', 'tamil nadu'
];

const FOREIGN_REGIONS = [
  'united states', 'usa', 'us', 'united kingdom', 'uk', 'canada',
  'australia', 'singapore', 'germany', 'dubai', 'uae', 'philippines'
];

function detectWorkMode(text = '', location = '') {
  const combined = `${text} ${location}`.toLowerCase();
  if (/\b(work\s*from\s*home|wfh|remote)\b/i.test(combined)) return 'REMOTE';
  if (/\bhybrid\b/i.test(combined)) return 'HYBRID';
  return 'ON_SITE';
}

function isLocationEligible({ location = '', title = '', description = '', workMode = null }) {
  if (!location || typeof location !== 'string' || !location.trim()) {
    return { eligible: false, reason: 'Location missing or unparseable', workMode: 'UNKNOWN' };
  }

  const locLower = location.toLowerCase().trim();
  const fullText = `${title} ${description} ${location}`.toLowerCase();
  const mode = workMode || detectWorkMode(fullText, location);

  // Check if matches NCR cities
  const isNcr = NCR_CITIES.some(city => locLower.includes(city));

  if (mode === 'REMOTE') {
    // Foreign remote positions are rejected (e.g. USA, UK, Canada, Australia)
    const isForeign = FOREIGN_REGIONS.some(region => {
      const rx = new RegExp(`\\b${region}\\b`, 'i');
      return rx.test(locLower);
    });
    if (isForeign && !isNcr) {
      return { eligible: false, reason: `Foreign Remote (${location})`, workMode: mode };
    }

    // Remote is allowed India-wide (including standalone "Remote", "Work from Home", or Indian cities/NCR)
    return { eligible: true, workMode: mode, locationLabel: location };
  }

  // Hybrid & On-Site MUST be in NCR
  if (isNcr) {
    return { eligible: true, workMode: mode, locationLabel: location };
  }

  return { eligible: false, reason: `${mode} not in NCR (${location})`, workMode: mode };
}

// ════════════════════════════════════════════════════════
// 2. BLACKLIST RULES (Strict vs Soft Developer)
// ════════════════════════════════════════════════════════

const STRICT_BLACKLIST = [
  // High-end Network Architecture / Protocols
  /\bnetwork\s+architect\b/i, /\bnetwork\s+lead\b/i,
  /\bbgp\b/i, /\bstp\b/i, /\bvss\b/i, /\bhss\b/i,
  /\bhsrp\b/i, /\bvrrp\b/i, /\bglbp\b/i, /\bpbr\b/i,
  /\bvoip\b/i, /\bccie\b/i,
  /\brouting\s*(&|and)?\s*switching\b/i,

  // BPO / Voice / Call Center / Telesales
  /\bbpo\b/i, /\bvoice\s+support\b/i, /\bvoice\s+process\b/i,
  /\bsemi[\s-]?voice\b/i, /\bcall\s+center\b/i,
  /\btelecaller\b/i, /\btelesales\b/i,
  /\binbound\s+(calls?|voice|process|bpo)\b/i,
  /\boutbound\s+(calls?|voice|process|bpo)\b/i,
  /\bcustomer\s+care\s+(executive|associate|representative)\b/i,

  // Executive Posts
  /\bdirector\b/i, /\bvice\s+president\b/i, /\b(^|\s)vp(\s|$)/i,
  /\bavp\b/i, /\bchief\b/i, /\bcio\b/i, /\bcto\b/i, /\bcxo\b/i,
  /\bgeneral\s+manager\b/i,

  // Unrelated Disciplines
  /\bcivil\b/i, /\bmechanical\b/i, /\belectrical\s+engineer\b/i,
  /\bconstruction\b/i, /\bhvac\b/i, /\bplumbing\b/i,
  /\bprofessor\b/i, /\bfaculty\b/i, /\bdoctor\b/i,
  /\bsurgeon\b/i, /\bnurse\b/i, /\baccountant\b/i,
  /\bsales\s+executive\b/i, /\bmarketing\s+executive\b/i
];

const DEVELOPER_BLACKLIST = [
  // Network certs/firewalls (Soft blacklist: allowed ONLY IF >= 50% IT support skills match)
  /\bccna\b/i, /\bccnp\b/i, /\bfortinet\b/i, /\bfirewall\s+engineer\b/i,
  /\bswitch(es|ing)?\s+configuration\b/i, /\brouter(s)?\s+configuration\b/i,

  // Coding & Software Engineering
  /\bdeveloper\b/i, /\breact(\.js)?\b/i, /\bnode(\.js)?\b/i,
  /\bjava\b/i, /\bpython\b/i, /\bfull[\s-]?stack\b/i,
  /\bfront[\s-]?end\b/i, /\bback[\s-]?end\b/i, /\bc\+\+\b/i,
  /\bsoftware\s+engineer\b/i, /\bsoftware\s+developer\b/i,
  /\bgolang\b/i, /\bflutter\b/i, /\bphp\b/i,
  /\bangular(\.js)?\b/i, /\bruby\b/i, /\bdjango\b/i,
  /\bspring\s+boot\b/i, /\bdotnet\b/i, /\b\.net\b/i, /\bc#\b/i,
  /\bkotlin\b/i, /\bswift\b/i, /\bsql\b/i, /\bpostman\b/i,

  // Data & QA
  /\bdata\s+analyst\b/i, /\bdata\s+science\b/i, /\bbusiness\s+analyst\b/i,
  /\bqa\s+engineer\b/i, /\bautomation\s+tester\b/i, /\bmanual\s+tester\b/i,
  /\bsdet\b/i, /\bapi\s+testing\b/i, /\bselenium\b/i, /\bcypress\b/i,
  /\bai\b/i, /\bml\b/i, /\bmachine\s+learning\b/i, /\bdeep\s+learning\b/i,
  /\bnlp\b/i, /\bllm\b/i
];

const NON_IT_TITLE_BLACKLIST = [
  /\baccount\s+manager\b/i, /\bcustomer\s+success\b/i,
  /\bprogram\s+manager\b/i, /\blivelihood\b/i,
  /\bcredentialing\b/i, /\binside\s+sales\b/i, /\bsales\b/i,
  /\brelationship\s+manager\b/i, /\bsap\s+(fico|mm|sd|abap|pp|basis)\b/i,
  /\boracle\s+dba\b/i, /\bcollections?\b/i,
  /\bsecurity\s+(system\s+)?engineer\b/i, /\bcloud\s+security\b/i,
  /\bcyber\s*security\b/i, /\bsalesforce\b/i,
  /\bdynamics\s*365\b/i, /\bsnowflake\b/i, /\bdevops\b/i,
  /\bservicenow\s+architect\b/i, /\bnetwork\s+cloud\b/i,
  /\bteamcenter\b/i, /\bexaminer\b/i,
  /\belectric\s*(&|and)?\s*electronic\b/i,
  /\bfront\s*desk\b/i, /\breceptionist\b/i,
  /\bnetwork\s+engineer\b/i, /\bnetwork\s+admin(istrator)?\b/i,
  /\bnetwork\s+support\b/i, /\bnetwork\s+operations\b/i,
  /\bnetwork\s+specialist\b/i, /\bnoc\s+engineer\b/i,
  /\b(business|management|functional|strategy|financial)\s+consultant\b/i,
  /\bprincipal\s+engineer\b/i,
  /\bstaff\s+(cpq|systems|software|salesforce|engineer)\b/i,
  /\bcpq\b/i,
  /\binvestment(\s+management)?\b/i,
  /\bavamar\s+backup\b/i,
  /\bmainframe\b/i
];

const ALL_TITLE_BLACKLIST = [
  ...STRICT_BLACKLIST,
  ...DEVELOPER_BLACKLIST,
  ...NON_IT_TITLE_BLACKLIST
];

function isTitleBlacklisted(title = '') {
  for (const p of ALL_TITLE_BLACKLIST) {
    if (p.test(title)) return { blocked: true, reason: `Title: ${p}` };
  }
  return { blocked: false };
}

function isContentBlacklisted(text = '', skillPct = 0) {
  for (const p of STRICT_BLACKLIST) {
    if (p.test(text)) return { blocked: true, reason: `Strict: ${p}` };
  }
  // Soft developer blacklist: exempted if core IT support skill ratio >= 50%
  if (skillPct >= 50) return { blocked: false };
  for (const p of DEVELOPER_BLACKLIST) {
    if (p.test(text)) return { blocked: true, reason: `Dev(skill<50%): ${p}` };
  }
  return { blocked: false };
}

// ════════════════════════════════════════════════════════
// 3. EXPERIENCE PARSING & VALIDATION
// ════════════════════════════════════════════════════════

function parseNaukriExperience(expText = '') {
  if (!expText || /not specified/i.test(expText)) return { min: 4, max: 99 };
  const m = expText.match(/(\d+)\s*(?:-\s*(\d+))?\s*(?:yr|year)/i);
  if (m) {
    const min = parseInt(m[1], 10);
    const max = m[2] ? parseInt(m[2], 10) : min;
    return { min, max };
  }
  return { min: 4, max: 99 };
}

function matchesNaukriExperience(expText = '') {
  const exp = parseNaukriExperience(expText);
  // Rejects pure freshers <= 2 yrs (e.g. 0-1, 0-2, 1-2 yrs)
  if (exp.max <= 2) return false;
  // User has 6 years experience: allows 2-6, 3-8, 4-8, 4-9, 5-8, 5-10, 6-10, 6-12 yrs.
  // Rejects ultra-senior / director roles where minimum required is > 7 yrs (e.g. 8-12, 10-15 yrs)
  if (exp.min > 7) return false;
  // Upper ceiling: allows up to 12 yrs
  if (exp.max > 12) return false;
  return true;
}

function parseLinkedInExperience(jdText = '', title = '', seniority = '') {
  const combined = `${title} ${jdText}`;

  // 1. Check title / keywords for clear fresher / intern signals
  if (/\b(fresher|intern|internship|trainee)\b/i.test(title)) {
    return { eligible: false, reason: 'Title indicates Fresher/Intern', label: 'Fresher / Intern' };
  }
  if ((seniority || '').toLowerCase().includes('internship')) {
    return { eligible: false, reason: 'Seniority: Internship', label: 'Internship' };
  }

  // 2. Look for explicit LABELED candidate experience patterns (avoiding company age text)
  const labeledPatterns = [
    /(?:minimum|at\s+least|require[ds]?)\s+(\d+)\s*(?:\+)?\s*(?:years?|yrs?)\s+of\s+(?:relevant\s+)?experience/i,
    /(?:experience|exp|background|qualifications?)\s*[:\-–]?\s*(\d+)\s*(?:-|to|–)\s*(\d+)\s*(?:years?|yrs?)/i,
    /(\d+)\s*(?:-|to|–)\s*(\d+)\s*(?:years?|yrs?)\s+of\s+(?:experience|it\s+support)/i,
    /(\d+)\s*\+\s*(?:years?|yrs?)\s+of\s+experience/i
  ];

  // Helper to test if a matched snippet is actually describing company age
  const isCompanyAgeSnippet = snippet => {
    return /(?:in\s+business|serving\s+clients|established|founded|experience\s+delivering|track\s+record|history)\b/i.test(snippet);
  };

  let minYears = null;
  let maxYears = null;
  let label = 'Not Specified';

  for (const rx of labeledPatterns) {
    const match = jdText.match(rx);
    if (match) {
      const startIdx = Math.max(0, match.index - 40);
      const surrounding = jdText.substring(startIdx, match.index + match[0].length + 40);
      if (isCompanyAgeSnippet(surrounding)) continue;

      minYears = parseFloat(match[1]);
      maxYears = match[2] ? parseFloat(match[2]) : minYears;
      label = `${minYears}${maxYears && maxYears !== minYears ? '-' + maxYears : '+'} Yrs`;
      break;
    }
  }

  // If labeled experience found, evaluate against thresholds
  if (minYears !== null) {
    if (maxYears <= 2) {
      return { eligible: false, reason: `Experience ${label} <= 2 Yrs (Fresher)`, label };
    }
    // User has 6 years experience: allows up to 12 yrs (e.g. 2-6, 3-8, 4-9, 5-10, 6-12 yrs)
    if (minYears > 7 || maxYears > 12) {
      return { eligible: false, reason: `Experience ${label} out of range for 6 yrs candidate`, label };
    }
    return { eligible: true, label };
  }

  // Fallback: Check for generic 0-2 yrs fresher text
  if (/\b(0\s*(to|-)\s*[12]\s*years?|freshers?\s+only)\b/i.test(combined)) {
    return { eligible: false, reason: 'JD indicates 0-2 yrs Fresher', label: '0-2 Yrs' };
  }

  // Genuine unspecified experience allowed for mid-senior IT profiles
  return { eligible: true, label: 'Mid-Senior / Unspecified' };
}

// ════════════════════════════════════════════════════════
// 4. ACTUAL SALARY PARSING (EXCLUDES ALLOWANCES & STIPENDS)
// ════════════════════════════════════════════════════════

const ALLOWANCE_EXCLUSION_PATTERN = /\b(cab|travel|shift|night\s+shift|housing|hra|meal|food|mobile|internet|reimbursement|per\s*diem|incentive|bonus|variable)\s*(?:allowance|reimbursement|component)?\b/i;

function parseNaukriSalary(salaryText = '') {
  if (!salaryText || /not disclosed/i.test(salaryText)) {
    return { isDisclosed: false, isHigh: false, min: null, max: null, raw: 'Not Disclosed' };
  }
  // 1. Check Lacs/LPA format: e.g. 4-8.5 Lacs P.A., 6-10 LPA
  const mLacs = salaryText.match(/(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*(?:lacs|lakhs|lpa)/i);
  if (mLacs) {
    const min = parseFloat(mLacs[1]);
    const max = mLacs[2] ? parseFloat(mLacs[2]) : min;
    return { isDisclosed: true, isHigh: max >= 7.0, min, max, raw: salaryText.trim() };
  }
  // 2. Check full number INR format: e.g. 7,00,000 - 10,00,000 PA, 3,50,000 - 5,00,000 PA
  const mFull = salaryText.match(/(\d{1,3}(?:,\d{2,3})+)\s*(?:-\s*(\d{1,3}(?:,\d{2,3})+))?/i);
  if (mFull) {
    const minNum = parseInt(mFull[1].replace(/,/g, ''), 10);
    const maxNum = mFull[2] ? parseInt(mFull[2].replace(/,/g, ''), 10) : minNum;
    const min = minNum / 100000;
    const max = maxNum / 100000;
    return { isDisclosed: true, isHigh: max >= 7.0, min, max, raw: salaryText.trim() };
  }
  return { isDisclosed: false, isHigh: false, min: null, max: null, raw: salaryText.trim() };
}

function parseLinkedInSalary(jdText = '') {
  if (!jdText) return { eligible: true, isHigh: false, raw: 'Not Disclosed' };

  // Explicitly reject internship stipends under confirmed user policy
  if (/\b(?:monthly\s+)?stipend\s*[:\-–]?\s*(?:rs\.?|inr|₹)?\s*\d+/i.test(jdText) || /\bstipend\s+of\b/i.test(jdText)) {
    return { eligible: false, isHigh: false, raw: 'Stipend', reason: 'Stipend excluded under salary policy' };
  }

  // 1. Annual LPA pattern: "3-7 LPA", "4-8 LPA", "6.5-8.5 LPA" (must reach >= 7.0 LPA, max <= 6 rejected)
  const lpaMatch = jdText.match(/(\d+(?:\.\d+)?)\s*(?:(?:-|to|–)\s*(\d+(?:\.\d+)?))?\s*(?:lpa|lacs|lakhs)\b/i);
  if (lpaMatch) {
    const min = parseFloat(lpaMatch[1]);
    const max = lpaMatch[2] ? parseFloat(lpaMatch[2]) : min;
    if (max < 7.0) return { eligible: false, isHigh: false, raw: lpaMatch[0], reason: `Salary ${max} LPA < 7.0 LPA (requires 7+ LPA)` };
    return { eligible: true, isHigh: max >= 7.0, raw: lpaMatch[0] };
  }

  // 2. Monthly INR pattern: requires salary context, minimum ₹15,000/month, and excludes allowances & stipends
  const monthlyRegex = /(?:salary|ctc|pay|package|in-hand|remuneration)\s*[:\-–]?\s*(?:rs\.?|inr|₹)?\s*(\d{2,3})[,.]?(\d{3})?\s*(?:\/|\s*per\s*)(?:month|pm|mo)\b/gi;
  let match;
  while ((match = monthlyRegex.exec(jdText)) !== null) {
    const snippetStart = Math.max(0, match.index - 30);
    const snippet = jdText.substring(snippetStart, match.index + match[0].length + 30);

    // Exclude if labeled as allowance or reimbursement
    if (ALLOWANCE_EXCLUSION_PATTERN.test(snippet)) continue;
    // Exclude if labeled as internship stipend
    if (/\bstipend\b/i.test(snippet)) {
      return { eligible: false, isHigh: false, raw: match[0], reason: 'Stipend excluded under salary policy' };
    }

    const rawNum = match[2] ? parseInt(match[1] + match[2], 10) : parseInt(match[1], 10) * 1000;
    // Must be at least ₹15,000/month to be considered real full-time salary
    if (rawNum >= 15000) {
      const annualLpa = (rawNum * 12) / 100000;
      if (annualLpa < 7.0) {
        return { eligible: false, isHigh: false, raw: `${match[0]} (~${annualLpa.toFixed(1)} LPA)`, reason: `Monthly salary ~${annualLpa.toFixed(1)} LPA < 7.0` };
      }
      return { eligible: true, isHigh: true, raw: `${match[0]} (~${annualLpa.toFixed(1)} LPA)` };
    }
  }

  return { eligible: true, isHigh: false, raw: 'Not Disclosed' };
}

// ════════════════════════════════════════════════════════
// 5. NORMALIZED HEADLINE MATCHER FOR COMPACT GROUPING
// ════════════════════════════════════════════════════════

const HEADLINE_GROUPS = [
  { normalized: 'Desktop Support Engineer', pattern: /\b(desktop\s+support|desktop\s+engineer|l1[\s\/-]?l2\s+desktop|deskside)\b/i },
  { normalized: 'Tech Support Engineer', pattern: /\b(tech\s+support\s+engineer|tse)\b/i },
  { normalized: 'IT Support Engineer', pattern: /\b(it\s+support|technical\s+support|tech\s+support|user\s+support)\b/i },
  { normalized: 'IT Analyst', pattern: /\b(it\s+analyst|technical\s+analyst|desktop\s+analyst|support\s+analyst|systems?\s+analyst)\b/i },
  { normalized: 'Service Desk / Helpdesk Engineer', pattern: /\b(service\s+desk|helpdesk|help\s+desk|service\s+ops)\b/i },
  { normalized: 'System Administrator / Engineer', pattern: /\b(system\s+administrator|sysadmin|system\s+engineer|systems?\s+admin)\b/i },
  { normalized: 'IT Executive / Senior Executive', pattern: /\b(it\s+executive|senior\s+executive\s*[-–|\/]?\s*it|executive\s+it)\b/i },
  { normalized: 'IT Specialist / Site Engineer', pattern: /\b(it\s+specialist|site\s+engineer|it\s+site\s+engineer|field\s+support)\b/i },
  { normalized: 'Microsoft 365 / EUC Engineer', pattern: /\b(m365|microsoft\s*365|office\s*365|o365|end\s+user\s+computing|euc|wintel)\b/i },
  { normalized: 'IT Infrastructure / Operations Lead', pattern: /\b(it\s+infrastructure|infrastructure\s+support|it\s+operations|it\s+lead|it\s+manager)\b/i }
];

function normalizeHeadline(title = '') {
  for (const grp of HEADLINE_GROUPS) {
    if (grp.pattern.test(title)) return grp.normalized;
  }
  // Fallback: clean title of extra punctuation
  return title.replace(/[-–|(\[].*$/, '').trim() || title.trim();
}

/**
 * Detects whether a LinkedIn job is "Easy Apply" (Onsite on LinkedIn)
 * vs "Direct Apply" (Offsite external employer career page).
 */
function isLinkedInEasyApply({ html = '', tracking = '', className = '', text = '' } = {}) {
  const combined = `${html} ${tracking} ${className} ${text}`.toLowerCase();
  return (
    combined.includes('apply-link-onsite') ||
    combined.includes('easy-apply') ||
    combined.includes('easyapply') ||
    combined.includes('data-is-easy-apply="true"') ||
    /\beasy apply\b/i.test(combined)
  );
}

module.exports = {
  NCR_CITIES,
  detectWorkMode,
  isLocationEligible,
  STRICT_BLACKLIST,
  DEVELOPER_BLACKLIST,
  ALL_TITLE_BLACKLIST,
  isTitleBlacklisted,
  isContentBlacklisted,
  parseNaukriExperience,
  matchesNaukriExperience,
  parseLinkedInExperience,
  parseNaukriSalary,
  parseLinkedInSalary,
  normalizeHeadline,
  isLinkedInEasyApply
};
