/**
 * GRANULAR JOB-SKILL INVENTORY & 50% RATIO MATCHING ENGINE
 * ───────────────────────────────────────────────────────────────────────────
 * Shared pure utility (zero platform-specific logic).
 * Builds an inventory list of ALL skills, tools, & responsibilities detected
 * in a job listing (from explicit tags + summary + responsibilities + full JD),
 * then computes:
 *
 *   Match % = (Matched CV Skills in Job) / (Total Distinct Skills in Job) × 100
 *
 * Strict Policy (Applied universally regardless of whether Title matches):
 *   • Required threshold: >= 50% of the job's total detected skills MUST match user's CV!
 *   • If 10 skills are found in the job and only 3 match → 30% → BLOCKED.
 *   • If 10 skills are found in the job and 5+ match → 50%+ → ALLOWED.
 */

const CV_SKILL_TERMS = [
  // Core IT & Helpdesk Support (check multi-word support roles BEFORE generic device words!)
  { label: 'Desktop Support', pattern: /\b(desktop\s+support|desktop\s+engineering|desktop\s+admin(istration)?)\b/i },
  { label: 'IT Support', pattern: /\b(it\s+support|technical\s+support|tech\s+support|tech\s+support\s+engineer|tse|user\s+support|onsite\s+support|field\s+support|remote\s+support|vip\s+support|client\s+support|application\s+support|software\s+support)\b/i },
  { label: 'IT Analyst', pattern: /\b(it\s+analyst|technical\s+analyst|desktop\s+analyst|support\s+analyst|systems?\s+analyst|service\s+desk\s+analyst)\b/i },
  { label: 'Service Desk / Helpdesk', pattern: /\b(service\s+desk(\s+management)?|it\s+service\s+desk|helpdesk|help\s+desk|it\s+helpdesk|l1(\s+support)?|l2(\s+support)?|l3(\s+support)?|tier\s*1|tier\s*2)\b/i },
  { label: 'System Support / Admin', pattern: /\b(system\s+support|system\s+administration|systems?\s+admin|it\s+administration|windows\s+admin)\b/i },
  { label: 'Troubleshooting', pattern: /\b(troubleshooting|diagnosis|root\s+cause|rca|fms|facility\s+management)\b/i },

  // Hardware, End-User Devices & Peripherals
  { label: 'Hardware Support', pattern: /\b(hardware|hardware\s+troubleshooting|computer\s+hardware|server\s+hardware)\b/i },
  { label: 'Desktop / Laptop', pattern: /\b(desktops?(?!\s+(support|engineering|admin))|laptops?|workstations?|pc\s+support|pc\s+assembling|desktop\s+repair|imaging)\b/i },
  { label: 'Printers / Scanners', pattern: /\b(printers?|printing|scanners?|peripherals?|biometrics?|cctv|barcode|ups)\b/i },
  { label: 'Asset Management', pattern: /\b(asset\s+management|it\s+asset|it\s+inventory|itam|cmdb|it\s+procurement)\b/i },
  { label: 'EUC / Workplace', pattern: /\b(euc|end\s+user(\s+computing|\s+support)?|workplace\s+support|deskside|desk\s*side)\b/i },
  { label: 'Mac / MDM / Jamf', pattern: /\b(mac|macos|mac\s*os|macbook|jamf|mdm|apple|ios|ipad|iphone)\b/i },
  { label: 'Audio Visual / VC', pattern: /\b(audio\s*visual|conferencing|video\s+conferencing|teams\s+room|zoom\s+room)\b/i },

  // OS, Active Directory & Microsoft 365
  { label: 'Windows OS', pattern: /\b(windows(\s*(10|11|7|8|xp|os|client))?|microsoft\s+windows|operating\s+systems?|os\s+installation|os\s+support|windows\s+deployment)\b/i },
  { label: 'Windows Server / Wintel', pattern: /\b(windows\s+server|wintel|wsus)\b/i },
  { label: 'Active Directory', pattern: /\b(active\s+directory|\bad\b|user\s+provisioning|access\s+control|access\s+management|it\s+onboarding)\b/i },
  { label: 'Group Policy (GPO)', pattern: /\b(group\s+policy|gpo)\b/i },
  { label: 'Microsoft 365 / O365', pattern: /\b(microsoft\s*365|m365|office\s*365|o365|ms\s*office(\s+outlook)?|google\s+workspace)\b/i },
  { label: 'Exchange / Outlook', pattern: /\b(exchange\s+online|ms\s+exchange|outlook|email\s+administration)\b/i },
  { label: 'Teams / SharePoint / OneDrive', pattern: /\b(microsoft\s+teams|sharepoint|onedrive)\b/i },
  { label: 'Intune / SCCM / Patching', pattern: /\b(intune|sccm|mecm|patch\s+management|patching|endpoint\s+manager|software\s+deployment)\b/i },
  { label: 'Azure AD / Entra ID', pattern: /\b(azure\s+ad|entra\s+id|entra|sso|mfa)\b/i },
  { label: 'BitLocker / Antivirus / EDR', pattern: /\b(bitlocker|antivirus|endpoint\s+(security|protection)|defender|crowdstrike)\b/i },
  { label: 'Linux Basics', pattern: /\b(linux)\b/i },

  // ITSM & Operations
  { label: 'ITIL / ITSM', pattern: /\b(itil|itsm|it\s+service\s+management)\b/i },
  { label: 'ServiceNow / Remedy / Jira', pattern: /\b(servicenow|remedy|jira|freshservice|zendesk|manageengine)\b/i },
  { label: 'Ticketing / Incident Mgmt', pattern: /\b(ticketing(\s+tools?)?|incident\s+management|problem\s+management|change\s+management|service\s+request)\b/i },
  { label: 'SLA & Service Delivery', pattern: /\b(sla|service\s+delivery|it\s+operations|service\s+ops|service\s+operations|kpi)\b/i },
  { label: 'Backup & Virtualization', pattern: /\b(backup|disaster\s+recovery|vmware|vcenter|hyper-v|virtualization|citrix|vdi|rds)\b/i },
  { label: 'Vendor Management', pattern: /\b(vendor\s+management|escalation\s+management|shift\s+management|it\s+documentation|it\s+sop|technical\s+documentation)\b/i },
  { label: 'IT Infrastructure', pattern: /\b(it\s+infrastructure|infrastructure\s+support)\b/i },

  // Basic Networking & Remote Tools
  { label: 'LAN / WAN / Wi-Fi', pattern: /\b(lan(\s+troubleshooting)?|wan|wi-fi|wifi|wlan|basic\s+networking|hardware\s+networking|network\s+support|network\s+connectivity|wireless(\s+technologies)?|structured\s+cabling|patch\s+panel|server\s+rack)\b/i },
  { label: 'VPN / DHCP / DNS', pattern: /\b(vpn|dhcp|dns|tcp\/ip|ip\s+addressing|ssl)\b/i },
  { label: 'Remote Tools (RDP/AnyDesk)', pattern: /\b(rdp|remote\s+desktop|anydesk|teamviewer|remote\s+troubleshooting)\b/i }
];

// Technical, Software, Dev, Cloud, ERP & Non-Support Skills OUTSIDE user's CV profile
const NON_CV_TECH_TERMS = [
  { label: 'Java', pattern: /\b(java|spring\s+boot|hibernate|j2ee)\b/i },
  { label: 'Python', pattern: /\b(python|django|flask|pandas|numpy)\b/i },
  { label: 'JavaScript / TypeScript', pattern: /\b(javascript|typescript)\b/i },
  { label: 'React / Angular / Vue', pattern: /\b(react(\.js)?|angular(\.js)?|vue(\.js)?|next\.js)\b/i },
  { label: 'Node.js / Express', pattern: /\b(node(\.js)?|express\.js)\b/i },
  { label: 'C++ / C# / .NET', pattern: /\b(c\+\+|c#|dotnet|\.net|asp\.net)\b/i },
  { label: 'PHP / Golang / Ruby', pattern: /\b(php|laravel|golang|ruby\s+on\s+rails|rust)\b/i },
  { label: 'Mobile (Flutter/Kotlin/Swift)', pattern: /\b(flutter|react\s+native|kotlin|swift|ios\s+development|android\s+sdk)\b/i },
  { label: 'SQL / RDBMS / Oracle', pattern: /\b(sql|mysql|postgresql|pl\/sql|oracle\s+(db|database|apps)|dbms|t-sql)\b/i },
  { label: 'NoSQL / MongoDB / Redis', pattern: /\b(mongodb|nosql|cassandra|redis|dynamodb|elasticsearch)\b/i },
  { label: 'REST API / GraphQL / Postman', pattern: /\b(rest\s+api|graphql|postman|microservices|soap\s+api)\b/i },
  { label: 'AWS Cloud', pattern: /\b(aws|amazon\s+web\s+services|ec2|s3|lambda|ecs|eks)\b/i },
  { label: 'Google Cloud (GCP)', pattern: /\b(gcp|google\s+cloud\s+platform|bigquery)\b/i },
  { label: 'Docker / Kubernetes', pattern: /\b(docker|kubernetes|k8s|helm|openshift)\b/i },
  { label: 'Terraform / Ansible', pattern: /\b(terraform|ansible|puppet|chef|infrastructure\s+as\s+code)\b/i },
  { label: 'CI/CD (Jenkins/GitLab)', pattern: /\b(jenkins|ci\/cd|github\s+actions|gitlab\s+ci|azure\s+devops|argo\s*cd)\b/i },
  { label: 'Data Engg (Spark/Kafka/Snowflake)', pattern: /\b(spark|kafka|hadoop|snowflake|databricks|airflow|dbt|etl)\b/i },
  { label: 'BI & Analytics (PowerBI/Tableau)', pattern: /\b(power\s*bi|tableau|looker|qlik|sas|excel\s+vba)\b/i },
  { label: 'QA / Automation Testing', pattern: /\b(selenium|cypress|playwright\s+testing|appium|testng|sdet|manual\s+testing|api\s+testing)\b/i },
  { label: 'AI / ML / LLM', pattern: /\b(machine\s+learning|deep\s+learning|nlp|llm|generative\s+ai|tensorflow|pytorch)\b/i },
  { label: 'Salesforce / Dynamics / SAP', pattern: /\b(salesforce|apex|visualforce|dynamics\s*365|sap\s+(fico|abap|basis|hana|mm|sd))\b/i },
  { label: 'Advanced Security (SIEM/SOC/IAM)', pattern: /\b(siem|splunk|qradar|cyberark|saviynt|sailpoint|soar|penetration\s+testing|vapt|ztna)\b/i },
  { label: 'Advanced Network (BGP/OSPF/CCNA)', pattern: /\b(bgp|ospf|mpls|sd-wan|palo\s+alto|fortinet|checkpoint|cisco\s+nexus|ccna|ccnp)\b/i },
  { label: 'PLM / CAD / Teamcenter', pattern: /\b(teamcenter|windchill|autocad|solidworks|catia|siemens\s+plm)\b/i },
  { label: 'BPO / Cold Calling / Sales', pattern: /\b(cold\s+calling|lead\s+generation|inbound\s+voice|outbound\s+sales|telesales|b2b\s+sales)\b/i },
  { label: 'HCM / Workday / Enterprise ERP', pattern: /\b(workday|successfactors|peoplesoft|hcm\s+functional|oracle\s+hcm|netsuite)\b/i },
  { label: 'Front Desk / Hospitality', pattern: /\b(front\s*desk|receptionist|guest\s+relations|hospitality\s+operations)\b/i },
  { label: 'Finance / Accounting / Tax', pattern: /\b(general\s+ledger|accounts\s+payable|gst|taxation|chartered\s+accountant|statutory\s+audit)\b/i }
];

// Ignore soft skills, shifts, regional metadata, or generic chopped Naukri tags from counting as missing technical skills
const NON_TECHNICAL_JUNK_TAG = /\b(management|manager|lead|leadership|coordinator|supervision|administration|project|operations|communication|interpersonal|verbal|written|customer\s+service|client\s+handling|shift|rotational|night|day|apac|emea|us|uk|24\/7|24\*7|hiring|urgent|immediate|custom|installation|maintenance|graduate|diploma|btech|bca|bsc|fresher|experience|support|engineer|executive|specialist|analyst|associate|officer|professional|skills|requirements|good\s+to\s+have|plus|fluent|english|hindi|troubleshoot|handling|knowledge|ability|desk|sd|end|usage|technical|it\s+services?|office|computer|remote|onsite|on-site|system\s+engineering)\b/i;

/**
 * Evaluates a job's COMPLETE skill/responsibility inventory against User CV Skills.
 * @param {Object} params
 * @param {string} params.title - Job title
 * @param {string[]} [params.tags] - Explicit tag chips (Naukri)
 * @param {string} [params.description] - Summary, highlights, responsibilities or full "About the job"
 */
function evaluateJobSkillRatio({ title = '', tags = [], description = '' }) {
  const cleanTags = Array.from(new Set(
    (tags || []).map(t => t.trim()).filter(t => t.length >= 2)
  ));

  const matchedSkills = [];
  const unmatchedSkills = [];
  const seenLabels = new Set();

  // 1. Evaluate explicit tag chips first (if provided, e.g., Naukri)
  for (const tag of cleanTags) {
    const cvMatch = CV_SKILL_TERMS.find(term => term.pattern.test(tag));
    const nonCvMatch = NON_CV_TECH_TERMS.find(term => term.pattern.test(tag));

    if (cvMatch && !nonCvMatch) {
      if (!seenLabels.has(cvMatch.label)) {
        seenLabels.add(cvMatch.label);
        matchedSkills.push(tag);
      }
    } else if (nonCvMatch) {
      if (!seenLabels.has(nonCvMatch.label)) {
        seenLabels.add(nonCvMatch.label);
        unmatchedSkills.push(tag);
      }
    } else if (!NON_TECHNICAL_JUNK_TAG.test(tag)) {
      // Unrecognized specific tag (e.g. "SaaS", "Shopify", "HIPAA", "SAP")
      unmatchedSkills.push(tag);
    }
  }

  // 2. Scan description / full "About the job" / responsibilities for BOTH CV skills & Non-CV skills
  const fullText = `${title} ${description}`;
  for (const term of CV_SKILL_TERMS) {
    if (term.pattern.test(fullText) && !seenLabels.has(term.label)) {
      seenLabels.add(term.label);
      matchedSkills.push(term.label);
    }
  }
  for (const term of NON_CV_TECH_TERMS) {
    if (term.pattern.test(fullText) && !seenLabels.has(term.label)) {
      seenLabels.add(term.label);
      unmatchedSkills.push(term.label);
    }
  }

  const totalJobSkills = matchedSkills.length + unmatchedSkills.length;
  const percentage = totalJobSkills > 0 ? Math.round((matchedSkills.length / totalJobSkills) * 100) : 0;

  return {
    totalJobSkills,
    matchedCount: matchedSkills.length,
    unmatchedCount: unmatchedSkills.length,
    percentage,
    matchedSkills,
    unmatchedSkills,
    // Passes strict 50% rule: >= 50% of the job's detected skills match CV AND >= 2 CV IT skills exist
    passesStrict50: totalJobSkills > 0 && percentage >= 50 && matchedSkills.length >= 2,
    // Backward compatibility alias
    passesStrict60: totalJobSkills > 0 && percentage >= 50 && matchedSkills.length >= 2
  };
}

module.exports = {
  CV_SKILL_TERMS,
  NON_CV_TECH_TERMS,
  evaluateJobSkillRatio
};
