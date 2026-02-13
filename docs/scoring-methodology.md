# Scoring Methodology: How Tier 1 Vetting Works

<!-- Linear doc ID: fb990ce6-a80a-41b0-9de5-17db73eb2a67 -->
<!-- To push back to Linear: update_document with this content (strip this comment block) -->

Every nonprofit that enters the Bonsaei directory goes through an automated screening pipeline. This doc explains how it works at a practical level — what we check, how we score, and what the results mean.

For the full technical spec (field names, code paths, API sources), see **Vetting Criteria: Tier 1 — Automated Screening**. *(Note: the technical spec is being updated to match this document — if numbers conflict, this document is authoritative.)*

---

## The 3 Layers

Vetting runs in order. Each layer can override the previous one.

### Layer 1: Pre-Screen Gates

Three binary pass/fail checks. **Any failure = immediate REJECT**, no score calculated.

| Gate | What It Checks | Data Source |
| -- | -- | -- |
| Verified 501(c)(3) | Is this actually a registered 501(c)(3)? Has the IRS revoked their status? Do they have a determination letter? | ProPublica Nonprofit Explorer (classification + ruling date) and IRS Auto-Revocation List (~600K revoked orgs, public domain) |
| OFAC Sanctions | Does the org name match the US Treasury sanctions list? | US Treasury OFAC SDN List (~12K entities + aliases, public domain). Normalized name match filtered to entity-type only. |
| 990 Filing Exists | Has the org filed at least one Form 990? (Without filings, there's nothing to score.) | ProPublica Nonprofit Explorer (filing index) |

Most legitimate nonprofits pass all three gates. Gate failures catch orgs that have lost their tax-exempt status, are sanctioned, or have no public financial records.

### Layer 2: Scoring Engine

Four checks with weighted scoring (100 total). Weights reflect signal strength: spend rate and 990 recency carry more weight because they're stronger indicators of organizational health.

| Check | Weight |
| -- | -- |
| Years Operating | 10 |
| Revenue Range | 25 |
| Spend Rate | 35 |
| 990 Recency | 30 |

Each check produces one of three results:

* **PASS** → full points for that check's weight
* **REVIEW** → half marks (rounded)
* **FAIL** → 0 points

The total across all four checks determines the recommendation.

| Check | What It Measures | PASS | REVIEW | FAIL | Data Source |
| -- | -- | -- | -- | -- | -- |
| **Years Operating** | How long since IRS determination | 3+ years | 1–3 years | <1 year | ProPublica (IRS ruling date) |
| **Revenue Range** | Annual revenue from latest 990 | $50K–$10M (sector-adjusted) | $25K–$50K | <$25K or >$10M | ProPublica (990 `totrevenue`) |
| **Spend Rate** | Total expenses ÷ total revenue | 60–130% | 40–60% or 130–200% | <40% or >200% | ProPublica (990 `totfuncexpns / totrevenue`) |
| **990 Recency** | How recent is the latest filing | ≤3 years old | 3–4 years old | >4 years old | ProPublica (990 `tax_prd`) |

#### Sector-Adjusted Revenue Thresholds

Revenue thresholds are adjusted by NTEE major category to avoid penalizing sectors where smaller organizations are the norm. The base thresholds apply to all sectors not listed below.

| Sector | NTEE | Fail Below | REVIEW Band | Pass Above | Very Low Revenue Flag |
| -- | -- | -- | -- | -- | -- |
| **Base (all others)** | — | $25,000 | $25K–$50K | $50,000 | $25,000 |
| Arts & Culture | A | $25,000 | $25K–$50K | $50,000 | $15,000 |
| Health | E | $25,000 | $25K–$50K | $50,000 (pass max: $50M) | $25,000 |
| Food & Agriculture | K | $10,000 | $10K–$25K | $25,000 | $8,000 |
| Housing & Shelter | L | $15,000 | $15K–$30K | $30,000 | $10,000 |
| Youth Development | O | $10,000 | $10K–$25K | $25,000 | $8,000 |
| Human Services | P | $15,000 | $15K–$30K | $30,000 | $10,000 |
| Community Improvement | S | $10,000 | $10K–$25K | $25,000 | $8,000 |

**Why sector adjustments:**

Food banks, youth mentorship programs, mutual aid groups, and community shelters routinely operate on $10K–$30K annual budgets and are exactly the kind of orgs Bonsaei targets. Without sector adjustments, these orgs would either FAIL outright or have a collapsed REVIEW band (where the fail floor equals the pass floor, creating a binary cliff instead of a graduated assessment). The overrides ensure every sector has a meaningful REVIEW cushion between FAIL and PASS.

The "Very Low Revenue" column sets the threshold for the red flag — it's always below the fail floor to prevent contradictory signals (an org can't score PASS on revenue and simultaneously get flagged for very low revenue).

**Why these thresholds:**

* **Revenue floor ($25K base fail / $50K base full marks):** We chose a low floor because Bonsaei's directory targets grassroots and community orgs. A $30K org can be legitimate and effective — especially mutual aid, mentorship, or volunteer-driven programs. The $25K floor filters out dormant shell orgs while keeping small active ones. Sector-specific floors go as low as $10K for food/agriculture and youth development. We expect to adjust these based on manual review outcomes.
* **Spend rate (60–130%):** The wide range accommodates different operating models. Below 60% signals an org that isn't deploying funds. Above 130% means spending significantly more than annual revenue — normal for pass-through orgs like food banks that distribute donated goods (which count as expenses but not revenue), but a sustainability concern for others. We chose these bounds after reviewing sector norms in ProPublica data; the range will narrow as we gather more review data.
* **Score thresholds (75 = PASS, 50 = REVIEW):** 75 means an org can fail Years Operating (10 pts) or Revenue Range (25 pts) entirely and still pass. Failing Spend Rate (35 pts, score=65) or 990 Recency (30 pts, score=70) drops to REVIEW — intentional, since these are stronger signals. 50 means failing two checks entirely puts you in REJECT territory. We expect to validate these cutoffs against manual review decisions.
* **Weighted scoring (10/25/35/30):** Spend rate and 990 recency carry more weight because they are stronger signals of organizational health. Years operating is the weakest signal — longevity doesn't guarantee quality, and a 30-year-old org with terrible financials shouldn't coast on age. Revenue range stays at 25 as a core eligibility check. After ~300 manual reviews, we plan to run a logistic regression to validate or further refine these weights.

**Score → Recommendation:**

| Score | Result |
| -- | -- |
| 75–100 | **PASS** — approved for listing |
| 50–74 | **REVIEW** — needs manual review |
| 0–49 | **REJECT** |

Impact of failing a single check entirely:

| Failed Check | Score | Result |
| -- | -- | -- |
| Years Operating (10 pts) | 90 | PASS |
| Revenue Range (25 pts) | 75 | PASS |
| Spend Rate (35 pts) | 65 | REVIEW |
| 990 Recency (30 pts) | 70 | REVIEW |

Failing the two strongest signals (Spend Rate, 990 Recency) correctly triggers human review. The gates handle hard disqualifiers; scoring is more forgiving on gradient measures.

### Layer 3: Red Flag Overlay

After scoring, we check for warning signs that can override the recommendation.

Red flags have two severity levels with different effects:

* **HIGH** → automatic REJECT, regardless of score. No human review — the flag is considered disqualifying on its own.
* **MEDIUM** → forces PASS → REVIEW downgrade. An org that scored high enough to PASS gets sent to human review instead. Does not affect orgs already in REVIEW or REJECT.

| Flag | What Triggers It | Severity | Effect | Data Source |
| -- | -- | -- | -- | -- |
| Court records (3+) | 3+ federal court cases in past year | HIGH | Auto-REJECT | CourtListener (federal docket search, free API) |
| Stale 990 | Latest 990 is 5+ years old | HIGH | Auto-REJECT | ProPublica (990 filing date) |
| Very high spend rate | Expense-to-revenue ratio far exceeds sector threshold | HIGH | Auto-REJECT | ProPublica (990 expense/revenue data) |
| High officer compensation | Compensation exceeds size-tiered ceiling (see below) | HIGH | Auto-REJECT | ProPublica (990 officer compensation) |
| OFAC near-match (≥95%) | Org name is ≥95% similar to a sanctioned entity | HIGH | Auto-REJECT | US Treasury OFAC SDN List (Jaro-Winkler fuzzy match) |
| OFAC near-match (<95%) | Org name is 85–94% similar to a sanctioned entity | MEDIUM | PASS → REVIEW | US Treasury OFAC SDN List |
| Court records (1-2) | 1-2 federal court cases in past year | MEDIUM | PASS → REVIEW | CourtListener |
| Low fund deployment | Expense-to-revenue ratio below sector threshold | MEDIUM | PASS → REVIEW | ProPublica (990 expense/revenue data) |
| Moderate officer compensation | Compensation elevated but below HIGH threshold | MEDIUM | PASS → REVIEW | ProPublica (990 officer compensation) |
| Revenue decline | 20%+ year-over-year drop | MEDIUM | PASS → REVIEW | ProPublica (consecutive 990 filings, skipped if >18 months apart) |
| Very low revenue | Revenue below sector-adjusted floor (see table above) | MEDIUM | PASS → REVIEW | ProPublica (990 `totrevenue`) |
| Too new | Less than 2 years old | MEDIUM | PASS → REVIEW | ProPublica (ruling date) |

**Officer compensation tiers:** The threshold scales by organization size — 60% of revenue for orgs under $250K, 50% for $250K–$1M, 40% for $1M+. Above the threshold = HIGH (auto-REJECT). A separate moderate threshold (lower percentage) triggers MEDIUM (PASS → REVIEW).

**Red flag coherence:** Each sector's "very low revenue" flag threshold sits below the revenue FAIL floor. This prevents contradictory signals — an org that passes the revenue check never simultaneously gets flagged for very low revenue. The flag only fires on orgs already scoring poorly on revenue, reinforcing the signal rather than contradicting it.

**Why these flags:**

* **Revenue decline forces REVIEW, not REJECT:** A 20% revenue drop can mean an org is failing — or it can mean a grant cycle ended, a major donor moved, or an economic downturn hit the community they serve. During COVID, frontline service orgs (food banks, shelters, clinics) saw revenue drops precisely because demand surged and donors pulled back. Auto-rejecting on revenue decline would exclude the orgs doing the hardest work at the worst time. The human reviewer can distinguish structural decline from a bad year.
* **Officer comp is size-tiered:** A $200K salary is 80% of a $250K org's revenue but only 20% of a $1M org's. Flat thresholds penalize small orgs unfairly. The tiers step down as revenue increases because larger orgs have more room for competitive salaries without it being a governance red flag.
* **Court records use a simple count:** This is a known simplification — large orgs (hospitals, universities) routinely have employment disputes that inflate their count. For V1 we accept this; the REVIEW path ensures a human sees the context for 1-2 cases. 3+ cases auto-reject — see Open Questions below for whether this should be size-adjusted.
* **"Too new" (<2 years):** New orgs aren't penalized in the score — they just get human review. This is a safety net, not a judgment. Many great orgs are young; we just want a human to confirm before listing them.
* **Stale 990 (5+ years):** An org with no filing in 5+ years likely isn't operating. Currently this auto-rejects — see Open Questions below for whether this should force human review instead.
* **Low fund deployment vs. high spend rate:** These are the two sides of the spend rate check. Low deployment (<60% expense ratio) suggests hoarding; very high spend (>130%) suggests unsustainable burn. Low deployment forces REVIEW; very high spend auto-rejects.
* **OFAC near-match:** A fuzzy name match against the US Treasury sanctions list. At ≥95% similarity it auto-rejects; between 85–94% it forces human review. This catches name variants of sanctioned entities but can produce false positives for organizations with common names in certain languages (see Open Questions).

A PASS can become a REVIEW or REJECT from red flags. A REJECT never gets upgraded.

---

## What This Means for the Directory

The scoring is calibrated to be **inclusive of small, efficient orgs** while still catching real problems:

* **Revenue floor is sector-adjusted** — base $25K–$50K, but food banks and youth programs use $10K–$25K so small community orgs aren't auto-rejected for being small
* **Spend rate range is wide (60–130%)** — pass-through orgs (food banks, mutual aid) that spend more than their annual revenue from reserves aren't penalized
* **Officer comp is size-tiered** — a $200K salary is reasonable for a $1M org but a red flag for a $250K org
* **Every sector has a REVIEW band** — no binary cliff between FAIL and PASS; there's always a graduated assessment zone

Net effect: the pipeline is more likely to surface small, well-run orgs for the directory rather than only large established ones.

---

## Known Limitations

These are accepted trade-offs for V1, not bugs:

1. **All scoring data is self-reported** — Every scoring check and most red flags derive from a single source: the IRS Form 990, which is filed by the nonprofit itself. There is no independent verification of financial figures. The IRS rarely audits small nonprofits, so a bad actor who maintains filing compliance for 3+ years and reports plausible numbers can produce any desired score. This is the fundamental limitation of Tier 1 automation — it filters out obviously problematic orgs, but cannot catch sophisticated fraud. That is what Tier 2 (manual review, external data sources) is for.
2. **Weight calibration (10/25/35/30)** — Check weights are based on signal-strength reasoning, not empirical data. Spend rate (35) and 990 recency (30) are weighted highest because they most directly indicate financial health and data confidence. After ~300 manual reviews, we will run a logistic regression of review outcomes against check scores to validate or refine these weights.
3. **Spend rate ≠ true overhead** — ProPublica reports total functional expenses vs. total revenue. It doesn't separate program expenses from admin/fundraising. A high spend rate could mean great program delivery or bloated overhead — we can't tell from 990 summary data alone. Note: within the 60–130% pass band, all spend rates earn the same score — a 65% ratio and a 125% ratio both get full marks.
4. **NTEE codes are approximate** — IRS NTEE classification codes are ~15-20% miscoded in practice (source: IRS classification via ProPublica, no independent verification). The cause area filter in the directory is useful but not authoritative. Sector-adjusted thresholds inherit this limitation — an org miscoded into the wrong NTEE category gets the wrong sector override.
5. **No officer-level sanctions check** — We check org names against OFAC but not individual officers, because ProPublica doesn't expose officer names in its API.
6. **Data freshness** — All financial data comes from 990 filings, which have a 1-2 year lag from the IRS. The most recent data available for any org is typically 1-2 tax years behind the current year. The 990 Recency check accounts for this by scoring more recent filers higher. The IRS revocation list and OFAC sanctions list are refreshed every 7 days; between refreshes, newly revoked or sanctioned entities could pass.
7. **Revenue scoring disadvantages volunteer-driven orgs** — A mutual aid collective distributing $200K in donated goods but with $8K in cash revenue would fail the revenue check in every sector. In-kind contributions don't show up as revenue on Form 990, creating a blind spot for exactly the grassroots orgs Bonsaei targets.

---

## REVIEW Workflow

When an org lands in REVIEW:

1. Reviewer (Kofi or Nicco) sees the flag details with source citations and links
2. Reviewer decides: **Approve**, **Reject**, or **Request More Info**
3. Decision + reasoning is recorded

Every rejection cites a specific source (IRS list, court docket, ProPublica data) and includes a path forward for the NGO.

**Feedback loop:** Review decisions are logged with schema `{ein, score, flags, decision, reasoning, reviewer, date}`. This data feeds the weight recalibration described above and helps us track whether thresholds are producing the right outcomes.

---

## Test Coverage

The scoring engine has **512 automated tests** covering gates, scoring, red flags, sector-adjusted thresholds, and boundary conditions across all four metro regions.

---

## Open Questions

These are design decisions surfaced during review that need resolution. They are not bugs — they are product choices where reasonable people could disagree.

1. **Should stale 990 auto-reject or force human review?** Currently auto-rejects (HIGH severity). The argument for review: IRS processing delays can cause 2-3 year gaps; a 20-year-old org with a delayed filing gets auto-rejected with no human consideration. The argument for reject: a 5+ year gap is extreme — even with delays, it suggests the org stopped operating.

2. **Should very high spend rate auto-reject or force review?** Currently auto-rejects (HIGH). The argument for review: food banks and pass-through orgs legitimately spend 150-200% of annual revenue from donated goods. The argument for reject: >200% is almost always a data quality issue or a real sustainability problem.

3. **Should court record thresholds scale by org size?** Currently 3+ federal cases = HIGH (auto-reject) regardless of size. A hospital system with 5,000 employees will routinely have 3+ employment disputes. Consider scaling: 3+ for orgs under $1M, 10+ for orgs over $10M.

4. **Appeal and re-evaluation pathway** — No mechanism for a rejected org to request re-vetting after fixing the issue (e.g., filing an updated 990). The code supports re-vetting with `forceRefresh`, but there's no user-facing process or cooling-off period.

5. **OFAC fuzzy-match false positives** — Organizations with names common in Arabic, Farsi, or other languages may trigger near-matches against sanctioned entities. "Al-Amal Foundation" (meaning "hope") is a common charity name that could match a sanctioned entity. Should there be a manual allowlist for known false positives?

6. **"REJECT" label framing** — The term carries strong negative connotation. A nonprofit rejected for being "too new" feels stigmatized differently than one labeled "not yet eligible." Consider alternative labels: "NOT YET ELIGIBLE," "DEFERRED," or "NEEDS MORE DATA."

7. **NTEE code correction policy** — If an org believes its IRS NTEE classification is wrong (15-20% are miscoded), can they request Bonsaei apply the correct sector thresholds? What evidence is required?

8. **Should we publish exact thresholds?** Publishing the full scoring methodology helps transparency but also gives bad actors a roadmap. A simplified public version (categories checked without exact numbers) would reduce gaming risk while maintaining trust. Counter-argument: security through obscurity rarely works, and the transparency builds credibility with donors and partners.

9. **Recalibration trigger** — The doc promises weight recalibration after ~300 manual reviews. Who runs this? What's the timeline? Consider an automated alert when n=300 to prevent the promise from being forgotten.

10. **Missing NTEE code handling** — Orgs with no NTEE code on file currently bypass the portfolio fit gate entirely (auto-pass). Should this instead flag for review?

*Last updated: 2026-02-12 — reweighted scoring checks (10/25/35/30), updated score impact tables and known limitations.*
