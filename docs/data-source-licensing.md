# Data Source Licensing — Can We Charge Users?

**Last updated:** 2026-02-14
**Status:** ProPublica fully removed (BON-88), outreach needed for CourtListener

## Bottom Line

Bonsaei's vetting engine pulls data from 7 sources. **All sources are clear for commercial use.** ProPublica has been fully removed (BON-88).

The entire pipeline — screening, profiles, red flags, and name search — runs on IRS BMF + GivingTuesday 990 XML data. Zero external API dependencies at runtime.

**Before we charge anyone, we need to:**
1. ~~Finish migrating off ProPublica (BON-88)~~ **Done — fully removed**
2. Add a GivingTuesday attribution line to the product
3. Get a startup agreement with Free Law Project (court records)

---

## 1. ProPublica Nonprofit Explorer API — FULLY REMOVED

**What it was:** A free API that gave us nonprofit financial data (revenue, expenses, assets) in one convenient call.

**The issue:** Their [terms of use](https://projects.propublica.org/datastore/terms/) restricted commercial use of derived data.

**Resolution (BON-88):** All ProPublica dependencies have been removed. Every tool — `search_nonprofit`, `screen_nonprofit`, `batch_screening`, `get_nonprofit_profile`, `get_red_flags` — now runs on IRS BMF + GivingTuesday 990 XML. The ProPublica client, types, config, and tests have been deleted from the codebase. Zero ProPublica references remain in `src/`.

**Remaining action:** None.

---

## 2-4. Government Data (IRS + Treasury) — ALL CLEAR

These three sources are U.S. government public domain. Anyone can use them commercially, no strings attached. Companies like LexisNexis and Thomson Reuters already resell this data.

| Source | What we use it for | Risk |
|--------|-------------------|------|
| **IRS Revocation List** | Checking if a nonprofit's tax-exempt status was revoked | None |
| **OFAC SDN List** (Treasury) | Checking if an org is on the sanctions list | None — but false matches are serious, so our matching needs to be accurate |
| **IRS Business Master File** | Our index of 1.8M nonprofits (name, EIN, category, location) | None |

---

## 5. GivingTuesday Data Commons (990 XML) — CLEAR, JUST ADD CREDIT

**What it is:** The open data project that hosts all IRS 990 filings in machine-readable format. This is our ProPublica replacement — same underlying IRS data, better license.

**License:** [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/) — the same license OpenStreetMap uses. Apple Maps, Uber, and thousands of companies build commercial products on ODbL data.

**Rules:**
- **Commercial use: Yes** — explicitly allowed
- **Credit them: Yes** — add "Data from GivingTuesday Data Commons" somewhere visible
- **Share-alike:** Only if we redistribute *their database*. Our scores are a product built from the data (like a map built from OSM), not a modified copy of their database. This distinction is well-established in ODbL case law.

**Action:** Add a GivingTuesday attribution line to the product footer or about page. That's it.

---

## 6. CourtListener / Free Law Project — NEED TO REACH OUT

**What it is:** A nonprofit that indexes court records. We use it to flag nonprofits with legal trouble (a red flag in our vetting).

**The deal:** Court records themselves are public. But CourtListener adds their own organization and metadata on top, which has a license that requires a [startup agreement](https://free.law/startups) for commercial use.

**Good news:** They price based on mission alignment and ability to pay — "prices start at free." A nonprofit vetting platform for small donors should get favorable terms.

**Our usage is light:** We just count how many court cases match an org's name. We don't show case details — just "this org has legal flags." Need to confirm this is OK under their terms.

**Action:** Contact Free Law Project, explain what Bonsaei does, ask about startup pricing. Should be a friendly conversation — their mission (open legal data) aligns with ours (nonprofit transparency).

---

## 7. Every.org API — CHECK LATER

Not currently integrated. If we add it later (for nonprofit logos, descriptions, cause tags), we'll need to verify their API terms. Low priority.

---

## 8. Candid/GuideStar API — TOO EXPENSIVE FOR NOW

Proprietary data, $5K-$50K+/year. Not needed for V1. Revisit when revenue justifies the cost.

---

## Summary

| Source | Can we use it commercially? | What do we need to do? |
|--------|---------------------------|----------------------|
| ~~ProPublica~~ | **Fully removed** | Nothing — no longer in the codebase |
| IRS Revocation List | Yes, unrestricted | Nothing |
| OFAC SDN List | Yes, unrestricted | Nothing |
| IRS BMF | Yes, unrestricted | Nothing |
| **GivingTuesday 990 XML** | **Yes — with credit** | Add attribution to the product |
| **CourtListener** | **Yes — with agreement** | Contact Free Law Project for startup pricing |
| Every.org | Probably, needs verification | Check terms if/when we integrate |
| Candid | Only with expensive license | Skip for now |

## To-Do Before Charging Users

1. ~~**Finish ProPublica migration** (BON-88)~~ **Done** — fully removed from codebase.
2. **Add GivingTuesday credit** — a line like "Financial data from GivingTuesday Data Commons" in the product footer.
3. **Contact Free Law Project** — get a startup agreement for court record lookups. Expect friendly terms.

## ProPublica Migration — Complete

BON-88 shipped. The entire codebase now runs on local data with zero ProPublica references:

| Data need | Source | Status |
|---|---|---|
| Org profile (name, EIN, address, NTEE) | IRS BMF | Done |
| Latest 990 financials (revenue, expenses, assets) | GivingTuesday 990 XML | Done |
| Filing history (multi-year) | GivingTuesday 990 XML concordance | Done |
| Overhead ratio | Computed from 990 XML Part IX | Done |
| Officer compensation | 990 XML Part VII | Done |
| Name search | IRS BMF (discoveryIndex) | Done |
| Standalone profile/red flags | IRS BMF + GivingTuesday 990 XML | Done |

**Results:**
1. **No licensing risk** — everything is public domain or openly licensed
2. **Speed** — precompute drops from ~22 hours (API calls) to minutes (local data)
3. **Richer data** — full 990 XML has governance flags, revenue breakdown, and asset diversion fields that ProPublica's summary API didn't expose
4. **Zero external API dependencies** — no rate limits, no downtime risk, no terms-of-use concerns
