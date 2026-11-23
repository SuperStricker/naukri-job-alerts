# 🚀 Master System Architecture, Rules & Live Status

This document records the complete architecture, filtering policies, timing budgets, scan coverage mechanics, failure reporting, and operational status of the **Naukri + LinkedIn IT Job Alert System**.

---

## 📌 Executive Summary

- **Platforms Monitored:** Naukri.com (238 Targets, 34 roles × 7 locations including Remote) + LinkedIn Jobs (30 Targets, 5 Boolean queries × 6 NCR locations).
- **Core Coverage:** Delhi NCR (Delhi, New Delhi, Noida, Greater Noida, Gurugram, Faridabad, Ghaziabad) + India-Wide Remote / WFH.
- **Alert Dispatch:** Telegram Bot (`@Naukari_2027_alert_bot` → Chat ID `1229206599`).
- **Alert Format:** Streamlined user template: `🔔 Job :- <Headline>` with `1. 🟡 Portal: LinkedIn || 🟢 Easy Apply ||` and `🔗 Apply Link`.
- **Execution Schedule:** Every 1 hour from 8:00 AM to 9:00 PM IST (UTC 02:30 to 15:30).
- **Code Repository:** `https://github.com/Shuaib1319/naukri-job-alerts` (Branch: `main`).

---

## 🎨 Exact Telegram Alert Format (`telegram-service.js`)

```text
🔔 Job :- Desktop Support Engineer
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 🟡 Portal: LinkedIn || 🟢 Easy Apply ||
   📍 Loc: Noida
   ⏳ Exp: 3-6 Yrs
   💰 Sal: 6.50 - 8.50 LPA
   🕒 Posted: 2 hours ago
  
   🔗 Apply Link

2. 🔵 Portal: Naukri || 🟢 Easy Apply ||
   📍 Loc: Gurugram
   ⏳ Exp: 4-7 Yrs
   💰 Sal: Not Disclosed
   🕒 Posted: Just Now
  
   🔗 Apply Link
```

---

## 🛡️ Complete Filter & Decision Rules

### 1. Job Roles Allowed
34 IT roles covering IT Support, Desktop Support, Technical Support, IT Analyst, Systems Support, Helpdesk L1/L2, SysAdmin, M365/EUC, IT Executive, IT Operations Lead, IT Management.

### 2. Location & Work Mode Policy (`filter-rules.js`)
- **6 NCR Cities:** Delhi, New Delhi, Noida, Greater Noida, Gurugram/Gurgaon, Faridabad, Ghaziabad.
- **On-site & Hybrid:** Must match one of the 6 NCR cities. Standalone `"India"` on-site is rejected.
- **Remote / WFH:** Allowed India-wide (Bengaluru, Pune, Mumbai, etc.) when associated with an NCR listing. Foreign remote is rejected.

### 3. Application Type Policy: Easy Apply Exclusive
- **Direct Company Apply:** Temporarily **100% stopped**.
- **Allowed:** Only 1-click **Easy Apply** jobs are dispatched.

### 4. Strict Experience Policy
- **Allowed Range:** Up to 8 years (e.g. 3-6, 4-7, 5-7, 6-8 years). Upper ceiling: `exp.max <= 8 && exp.min <= 7`.
- **Strictly Blocked:** $\ge 9$ years (7-9, 8-9, 8-12, 10+ yrs). Freshers $\le 2$ yrs blocked.

### 5. Actual Salary Policy (7+ LPA Rule & Not Disclosed Allowed)
- **Disclosed Salary:** Maximum required salary must reach at least **7.0 LPA** (`sal.max >= 7.0`, e.g. 3-7, 4-8, 6.5-8.5 LPA).
  - Strictly rejects jobs capped at 6.0 LPA (e.g. `3-6 Lacs`, `4-6 Lacs`).
- **"Not Disclosed" Salary:** **ALLOWED** (provided candidate experience matches valid 3-8 yrs range).

### 6. Title & Role Blacklist
Blocks Consultant, Principal Engineer, Staff Engineer, CPQ, Investment Management, Avamar Backup, Mainframe.

### 7. Strict 50% Job-Skill Ratio Gate (`skill-engine.js`)
Minimum 50% match required AND $\ge 2$ distinct IT support skills. Zero bypass.

---

## ⏱️ Execution Duration & Safety Budgets

| Component | Normal Duration | Hard Safety Budget | Action if Budget Reached |
|---|---|---|---|
| **Naukri Scraper** | ~4 to 6 minutes | **10 minutes max** | Completes Pass 1; stops Pass 2 deeper pages gracefully; reports exact `targetsSkipped` and `stopReason` |
| **LinkedIn Search** | ~3 to 5 minutes | **8 minutes max** | Stops search query phase; reports exact `targetsSkipped`; proceeds immediately to candidate evaluation |
| **LinkedIn Details** | ~1 to 2 minutes | **4 minutes max** | Stops fetching further details; un-fetched candidates left unseen for next hourly run |
| **Telegram Dispatch**| ~15 to 30 seconds| **2 minutes max** | Dispatches grouped HTML messages with $\le$ 3800 char splitting |
| **State Push to Git**| ~10 seconds | **2 minutes max** | Union merge of remote and local `seen_jobs.json`, git pull rebase & push |
| **Total Pipeline** | **~10 to 14 minutes**| **26 minutes max** | Well within GitHub Actions **30-minute hard timeout** |

---

## 🧪 Automated Test Suite (`node test-suite.js`)

- **Current Status:** **48/48 Tests Passing (100%)**.
- **Candidate Profile Calibration:** 6 Years Experience (Allows 2-6, 3-8, 4-9, 5-10, 6-12 Yrs; Rejects <=2y Freshers and >=8y Ultra-Senior).
- **Salary Calibration:** Must reach >= 7.0 LPA (Supports LPA & Full INR Comma notation). Remote jobs 100% allowed India-wide.
- **Coverage Suite (Section 9):**
  1. Exact 204 Naukri targets & 30 LinkedIn targets restricted strictly to 6 NCR locations.
  2. LinkedIn round-robin target interleaving across 5 query groups.
  3. Time-budget expiry returning `targetStatus: "partial"` with exact skipped targets.
  4. Safe pagination proceeding to Page 2 when Page 1 has 0 fresh jobs but valid next page.
  5. Distinction between genuine empty, selector timeout, navigation failure, and 429.
  6. Missing job ID tracking as parse failure.
  7. Detail 429 rate limit recorded as incomplete detail fetch without false skill rejection.
