// Stable cross-portal identity keys. Keep legacy portal IDs in seen_jobs.json.
function normalizeUrl(url = '') {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url).trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

function normalizeText(value = '') {
  return String(value).normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function identityKeys(job) {
  const keys = [];
  if (job.jobId) keys.push(String(job.jobId));
  if (job.rawId && String(job.rawId) !== String(job.jobId)) keys.push(String(job.rawId));
  const url = normalizeUrl(job.url);
  const title = normalizeText(job.title);
  const company = normalizeText(job.company);
  if (url) keys.push(`joburl:${url}`);
  // Company disambiguates common titles such as "Support Engineer".
  if (title && company) keys.push(`jobtitle:${title}|${company}`);
  return keys;
}

function isDuplicate(job, seenJobs) {
  return identityKeys(job).some(key => seenJobs.has(key));
}

function rememberJob(job, seenJobs) {
  for (const key of identityKeys(job)) seenJobs.add(key);
  if (job.jobId) seenJobs.add(String(job.jobId));
}

module.exports = { identityKeys, isDuplicate, rememberJob };
