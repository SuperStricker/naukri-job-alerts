# 🚀 IT Job Alert Automation (Naukri + LinkedIn, Delhi NCR)

GitHub Actions aur Playwright ke zariye **Naukri.com** aur **LinkedIn Jobs** ko full-depth scan karta hai. Delhi-NCR (Noida, Greater Noida, Gurugram, Delhi, Ghaziabad, Faridabad) me IT support, desktop/service desk, **IT Analyst**, **Tech Support Engineer**, aur related roles ko filter karke Telegram par **Compact Grouped Alerts** bhejta hai.

Aapka laptop band ho tab bhi GitHub Cloud background me har 1 ghante (8:00 AM se 9:00 PM IST) auto-scan karega!

---

## 🌟 Key Architecture & Supercharged Features

1. **Dual Portal Scraper (Naukri + LinkedIn):**
   - **Naukri.com Engine:** 34 curated roles across 6 NCR cities = **204 target URLs** with 3 concurrent workers.
   - **LinkedIn Jobs Engine:** 5 comprehensive Boolean query groups across 6 NCR cities = **30 search targets** with `sortBy=DD` (most recent). All direct & easy apply jobs included. Automatically detects and badges **⚡ EASY APPLY** (onsite 1-click application on LinkedIn) vs **🌐 DIRECT APPLY** (external employer portal).

2. **Compact Grouped Alerts by Normalized Headline (`telegram-service.js`):**
   - Har individual job ko alag message bhejne ke bajaye, same headline (e.g. `Desktop Support Engineer`, `IT Analyst`, `Tech Support Engineer`) ki saari passing openings ko **ek hi compact group alert** me list karta hai.
   - Har opening ke sath: Company, Location, Work Mode, Disclosed Salary, Source Portal, Matched Skills, aur Direct 1-Click Apply link rehti hai.
   - Message size limit: $\le$ 3800 characters par automatic part splitting (`Part 1/2`, `Part 2/2`).
   - **Reliable State Tracking:** Telegram confirmation (`ok: true`) aane par hi job ko `seen_jobs.json` me record kiya jata hai. Agar koi part fail hota hai toh wo job agle run ke liye eligible rehti hai.

3. **Strict NCR Geofence + India-Wide Remote Policy (`filter-rules.js`):**
   - **6 NCR Cities:** Delhi, New Delhi, Noida, Greater Noida, Gurugram, Faridabad, Ghaziabad.
   - **On-site & Hybrid:** Inka location strict NCR cities se match hona compulsory hai. Standalone "India" on-site reject hota hai.
   - **Remote / WFH:** Poore India me kahin bhi (Bengaluru, Pune, Mumbai, Hyderabad, etc.) Remote job allow hoti hai. Foreign remote (US/UK) reject hoti hai.

4. **Multi-Page Pagination (Naukri):**
   - Sirf page 1 nahi, balki **har target ke page 1, 2, aur 3** tak auto-paginate karta hai.
   - Ek search se 20 ke bajaye **60+ jobs** extract karta hai.
   - Smart early-stop: agar page 1 par < 20 jobs hain ya 0 fresh jobs milti hain toh turant agle target par switch karta hai.

5. **Auto-Scroll & Lazy-Load Engine:**
   - **Naukri:** Har page par 3-stage dynamic scrolling karta hai taaki lazy-loaded cards render ho sakein.
   - **LinkedIn:** 3-stage scroll + "See more jobs" button click handling karta hai taaki 35-50 job cards per search query extract ho sakein.

6. **Universal Strict 50% Skill Gate (`skill-engine.js`):**
   - Job ke tags, summary, technical requirements, aur full "About the job" description se complete skill inventory build karta hai.
   - **Formula:** `Match % = (Job me maujood User CV Skills) / (Job ke total detected Technical Skills) × 100`
   - **Rule:** Minimum **50% match** zaroori hai (chahe headline match ho ya na ho, ZERO BYPASS!).
   - Kam se kam 2 distinct core IT skills match hona compulsory hai.
   - Non-technical junk tags (APAC, EMEA, shifts, soft skills) ko denominator me count nahi karta.

7. **Actual Salary & Allowance Exclusion Policy:**
   - Sirf real CTC / base salary count hoti hai ($\ge$ 6.0 LPA).
   - Monthly salary $\ge$ ₹15,000/month ko annualize karke check kiya jata hai.
   - Cab allowance, shift allowance, mobile/internet reimbursement, aur internship stipends ko salary calculation se bahar rakha jata hai.
   - "Not Disclosed" salary wali jobs drop nahi hoti agar experience mid-senior level (4+ yrs) ho.

8. **Cross-Portal Deduplication & Atomic Git Persistence (`job-dedupe.js`):**
   - Normalized URLs (`joburl:...`), Job IDs, aur title + company identity keys (`jobtitle:...`) ko track karta hai.
   - Workflow me `if: always()` ke through remote branch se union merge karke push kiya jata hai, jisse duplicate alerts aana band ho jata hai.

---

## 📱 Telegram Grouped Alert Preview

Aapke Telegram bot se instant alert is exact format me aayega:

```text
🔔 Job Alert - Role :- Desktop Support Engineer
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1.  🌐 Portal: 🔵 LinkedIn || Easy Apply ||
   📍 Loc: Noida
   ⏳ Exp: 3-6 Yrs
   💰 Sal: 6.50 - 8.50 LPA
   🕒 Posted: 2 hours ago
  
   🔗 Apply: https://www.linkedin.com/jobs/view/...

2.  🌐 Portal: 🟠 Naukri || Direct Company ||
   📍 Loc: Gurugram
   ⏳ Exp: 4-7 Yrs
   💰 Sal: 7.00 - 9.00 LPA
   🕒 Posted: Just Now
  
   🔗 Apply: https://www.naukri.com/job-listings-...
```

Link par click karte hi direct official job page open ho jayega jahan se aap 1 click me apply kar sakte hain.

---

## ⏰ Cloud Schedule (Automated Runs)

GitHub Actions workflow cron:
```yaml
schedule:
  # Every 1 hour from 8:00 AM to 9:00 PM IST (UTC 02:30 to 15:30)
  - cron: '30 2,3,4,5,6,7,8,9,10,11,12,13,14,15 * * *'
```

- **Frequency:** Har 1 ghante me scan run hota hai.
- **Active Hours:** Subah 8:00 AM se Raat 9:00 PM IST tak.
- **Concurrency:** `cancel-in-progress: false` ke sath taaki active run cancel na ho aur duplicate alerts na jayein.
- **Manual Trigger:** GitHub Actions tab par jaakar **Run workflow** button se kisi bhi waqt manually test kiya ja sakta hai.

---

## 🛠️ Repository File Structure

```text
├── .github/workflows/
│   └── job-alert.yml      # Hourly cron automation workflow with atomic state sync
├── job-alert.js           # Multi-portal orchestrator
├── filter-rules.js        # Shared single source of truth (location, salary, blacklist, experience)
├── skill-engine.js        # Universal 50% Job-Skill Ratio Engine
├── telegram-service.js    # Compact grouped alerts & per-part delivery tracking
├── job-dedupe.js          # Cross-portal URL & title+company duplicate prevention
├── naukri-alert.js        # Dedicated Naukri scraper (204 URLs, paginated, 3x scroll)
├── linkedin-alert.js      # Dedicated LinkedIn scraper (30 targets, full JD scan, sortBy=DD)
├── diagnose.js            # Read-only diagnostic runner (mirrors production rules)
├── test-suite.js          # Automated unit & regression test suite (32/32 tests)
├── seen_jobs.json         # State tracking seen job IDs
├── package.json           # Dependencies and test runner script
└── README.md
```

---

## 💻 Local Testing & Verification

1. **Automated Unit Tests Run Karein (Zero Telegram messages):**
   ```bash
   npm test
   ```
   *(32 automated tests covering location, salary allowances, experience, blacklist, strict 50% skill gate regression, and deduplication).*

2. **Step-by-Step Diagnostic Run (Dry-Run Only):**
   ```bash
   node diagnose.js
   ```

3. **Full Live Scan:**
   ```bash
   node job-alert.js
   ```
