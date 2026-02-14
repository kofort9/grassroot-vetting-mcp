# Grassroot Vetting MCP Server

An MCP (Model Context Protocol) server for automated **grassroots nonprofit vetting** using the ProPublica Nonprofit Explorer API and IRS Business Master File. Implements automated financial screening from a VC-style nonprofit vetting framework.

## Grassroots Focus

This tool targets **grassroots and community-based nonprofits** ($100K-$10M revenue), not large national charities. The sweet spot: local organizations with real programs, staff, and community impact—but limited fundraising reach.

## Features

### Discovery (IRS Business Master File)
- **discover_nonprofits** - Browse and filter ~1.9M US tax-exempt orgs from the IRS BMF. Filter by state, city, NTEE category, ruling year, or name. Zero API calls, sub-second response.
- **refresh_discovery_index** - Download latest IRS BMF data and rebuild the local SQLite index (~72 seconds)

### Vetting (ProPublica Nonprofit Explorer)
- **search_nonprofit** - Search for nonprofits by name, with optional state/city filters
- **get_nonprofit_profile** - Get detailed profile including 990 financial summary
- **check_tier1** - Run automated financial screening: pre-screen gates → scoring engine → red flag overlay
- **get_red_flags** - Identify warning signs and issues

### Tracking
- **list_vetted** - List previously vetted nonprofits with summary stats. Filter by recommendation or date.
- **refresh_data** - Re-download IRS revocation list and/or OFAC SDN data

## How Screening Works

`check_tier1` runs three layers in sequence:

### Layer 1: Pre-Screen Gates

Four binary checks that ALL must pass before scoring begins. If any gate fails, the org is immediately rejected.

| Gate | What it checks |
|------|---------------|
| `verified_501c3` | Valid 501(c)(3) status, not on IRS revocation list, has determination letter |
| `ofac_sanctions` | Not on OFAC SDN sanctions list |
| `filing_exists` | At least one 990 filing on record (needed to evaluate financials) |
| `portfolio_fit` | NTEE category falls within configured portfolio scope |

### Layer 2: Scoring Engine (100 points)

Only runs if all gates pass.

| Check | Weight | Pass | Review | Fail |
|-------|--------|------|--------|------|
| Years Operating | 25 | ≥3 years | 1-3 years | <1 year |
| Revenue Range | 25 | $100K-$10M | $50K-$100K or $10M-$50M | <$50K or >$50M |
| Expense Ratio* | 25 | 70-100% | 50-70% or 100-120% | <50% or >120% |
| Recent 990 | 25 | Within 2 years | 2-3 years ago | >3 years |

*\*Note: This measures total expenses / total revenue, NOT true overhead. ProPublica data doesn't separate program vs admin expenses. For pass-through orgs (food banks), high ratios are actually good.*

**Scoring**: PASS = full points, REVIEW = 50% points, FAIL = 0 points

### Layer 3: Red Flag Overlay

Applied after scoring. HIGH severity flags can override the recommendation to REJECT.

### Recommendations

| Score | Recommendation | Meaning |
|-------|---------------|---------|
| 75-100 | **PASS** | Ready for Tier 2 deep-dive |
| 50-74 | **REVIEW** | Needs human judgment on flagged items |
| < 50 | **REJECT** | Does not meet criteria |
| *null* | **REJECT** | Failed a pre-screen gate (blocked before scoring) |

## Red Flags

| Flag | Severity | Trigger |
|------|----------|---------|
| No 990 on file | HIGH | No filings in ProPublica |
| Not 501(c)(3) | HIGH | Subsection ≠ "03" |
| No ruling date | HIGH | Missing IRS ruling date |
| Stale 990 | HIGH | Last filing >4 years old |
| Unsustainable burn | HIGH | >120% expense-to-revenue (spending far exceeds income) |
| Low fund deployment | MEDIUM | <50% expense-to-revenue (potential fund hoarding) |
| Very low revenue | MEDIUM | <$25K revenue |
| Revenue decline | MEDIUM | >50% YoY decline |
| Too new | MEDIUM | <1 year operating |

## Installation

```bash
# Clone the repository
git clone https://github.com/kofort9/grassroot-vetting-mcp.git
cd grassroot-vetting-mcp

# Install dependencies
npm install

# Build
npm run build
```

## Usage with Claude Code

Add to your `.mcp.json` configuration:

```json
{
  "mcpServers": {
    "grassroot-vetting": {
      "command": "node",
      "args": ["/path/to/grassroot-vetting-mcp/dist/index.js"]
    }
  }
}
```

Then use the tools in Claude Code.

## Usage Examples

### 1. Discover + vet orgs in a specific area

Find education nonprofits in Oakland, CA and vet the most established one:

```
discover_nonprofits(state: "CA", city: "Oakland", ntee_categories: ["B"], limit: 5)
→ 340 matches, including "Academy of Chinese Culture And" (est. 1982)

check_tier1(ein: "942881684")
→ PASS (88/100) — 43 years operating, $2.3M revenue, 13 filings
→ One flag: expense ratio 100.6% (spending slightly exceeds revenue)
→ Passes financial screening
```

### 2. Gate rejection — org can't be evaluated

Find youth-focused human services orgs in New York:

```
discover_nonprofits(state: "NY", ntee_categories: ["P"], name_contains: "youth", limit: 5)
→ 108 matches, including "Africa Youth Initiative Inc" (est. 2019)

check_tier1(ein: "833882840")
→ REJECT — failed filing_exists gate (no 990s on record)
→ Valid 501(c)(3), not sanctioned, but can't evaluate financials
→ Blocked before scoring even starts
```

### 3. Manual review — borderline org

Find newer health nonprofits in Texas:

```
discover_nonprofits(state: "TX", ntee_categories: ["E"], min_ruling_year: 2015, limit: 5)
→ 1,787 matches, including "2435 Kinwest Medical Clinic" (est. 2015)

check_tier1(ein: "463710579")
→ REVIEW (63/100) — passes all gates, but:
  - $48K revenue (too small to assess reliably)
  - 118.5% expense ratio (burning reserves)
→ Needs human judgment before proceeding
```

### 4. Search by name → profile → vet

Already know the org name:

```
search_nonprofit(query: "Teach For America")
→ Returns EIN, city, state, NTEE code

get_nonprofit_profile(ein: "13-3541913")
→ Full financial summary, years operating, latest 990

check_tier1(ein: "13-3541913")
→ Score + recommendation
```

### 5. Bulk discovery pipeline

Screen a geographic region for all eligible orgs:

```
refresh_discovery_index()
→ Downloads latest IRS BMF data, indexes ~1.9M orgs (~72 seconds)

discover_nonprofits(state: "GA", ntee_categories: ["B", "P"], limit: 100)
→ Returns 100 candidates ready for vetting

# Vet each candidate individually via check_tier1

list_vetted(recommendation: "PASS")
→ See all orgs that passed screening
```

### Discovery Filter Reference

| Filter | Example | What it does |
|--------|---------|-------------|
| `state` | `"CA"` | 2-letter state code |
| `city` | `"Oakland"` | Case-insensitive city match |
| `ntee_categories` | `["B", "E"]` | B=Education, E=Health, P=Human Services, etc. |
| `name_contains` | `"youth"` | Substring match on org name |
| `min_ruling_year` | `2015` | Only orgs established after this year |
| `max_ruling_year` | `2000` | Only orgs established before this year |
| `portfolio_fit_only` | `false` | Disable NTEE scope filter (see all categories) |
| `limit` | `100` | Max results (default 100, max 500) |
| `offset` | `100` | Pagination offset |

## API Reference

### discover_nonprofits

Browse and filter the local IRS BMF index. Zero API calls, sub-second response.

**Input:**
```typescript
{
  state?: string;           // 2-letter state code
  city?: string;            // Case-insensitive city match
  ntee_categories?: string[]; // NTEE prefixes (e.g., ["B"] for education)
  ntee_exclude?: string[];  // NTEE prefixes to exclude
  name_contains?: string;   // Substring match on org name
  min_ruling_year?: number; // Minimum ruling year
  max_ruling_year?: number; // Maximum ruling year
  subsection?: number;      // IRS subsection (default: 3 for 501(c)(3))
  portfolio_fit_only?: boolean; // Apply portfolio NTEE filter (default: true)
  limit?: number;           // Max results (default: 100, max: 500)
  offset?: number;          // Pagination offset
}
```

**Output:**
```typescript
{
  candidates: Array<{
    ein: string;
    name: string;
    city: string;
    state: string;
    ntee_code: string;
    subsection: number;
    ruling_date: string;
  }>;
  total: number;
  filters_applied: string[];
  index_stats: { total_orgs: number; last_updated: string };
}
```

### refresh_discovery_index

Download latest IRS BMF data and rebuild the local SQLite index. Takes ~60-90 seconds.

### search_nonprofit

Search for nonprofits by name.

**Input:**
```typescript
{
  query: string;      // Required: Organization name or keywords
  state?: string;     // Optional: 2-letter state code
  city?: string;      // Optional: City name
}
```

**Output:**
```typescript
{
  results: Array<{
    ein: string;
    name: string;
    city: string;
    state: string;
    ntee_code: string;
  }>;
  total: number;
  attribution: string;
}
```

### get_nonprofit_profile

Get detailed profile for a nonprofit.

**Input:**
```typescript
{
  ein: string;  // EIN with or without dash
}
```

**Output:**
```typescript
{
  ein: string;
  name: string;
  address: { city, state };
  ruling_date: string;
  years_operating: number;
  subsection: string;
  is_501c3: boolean;
  ntee_code: string;
  latest_990: {
    tax_period: string;
    total_revenue: number;
    total_expenses: number;
    total_assets: number;
    overhead_ratio: number;
  } | null;
  filing_count: number;
}
```

### check_tier1

Run automated financial screening checks.

**Input:**
```typescript
{
  ein: string;  // EIN with or without dash
}
```

**Output:**
```typescript
{
  ein: string;
  name: string;
  passed: boolean;
  score: number;              // 0-100
  checks: Array<{
    name: string;
    passed: boolean;
    result: "PASS" | "REVIEW" | "FAIL";
    detail: string;
    weight: number;
  }>;
  recommendation: "PASS" | "REVIEW" | "REJECT";
  red_flags: Array<{
    severity: "HIGH" | "MEDIUM" | "LOW";
    type: string;
    detail: string;
  }>;
}
```

### get_red_flags

Get red flags for a nonprofit.

**Input:**
```typescript
{
  ein: string;  // EIN with or without dash
}
```

**Output:**
```typescript
{
  ein: string;
  name: string;
  flags: Array<{
    severity: "HIGH" | "MEDIUM" | "LOW";
    type: string;
    detail: string;
  }>;
  clean: boolean;
}
```

## Data Sources

### IRS Business Master File (Discovery)
The discovery index is built from the [IRS Exempt Organizations Business Master File](https://www.irs.gov/charities-non-profits/exempt-organizations-business-master-file-extract-eo-bmf), containing ~1.9M US tax-exempt organizations. Downloaded as CSV, indexed locally in SQLite (via sql.js WASM — no native dependencies).

### ProPublica Nonprofit Explorer (Vetting)
Vetting and financial data comes from the [ProPublica Nonprofit Explorer API](https://projects.propublica.org/nonprofits/api), which provides:

- 990 tax form data (filed by nonprofits with >$200K gross receipts or >$500K assets)
- Historical filings going back several years
- Organization classification and ruling dates

### OFAC SDN List (Sanctions Screening)
Pre-screen gate checks organizations against the [OFAC Specially Designated Nationals list](https://sanctionssearch.ofac.treas.gov/).

**Attribution Required**: Data provided by ProPublica Nonprofit Explorer and IRS Exempt Organizations Business Master File.

## Development

```bash
# Run in development mode (watch)
npm run dev

# Run linter
npm run lint

# Run tests
npm test

# Full verification (format, build, lint, test)
npm run verify
```

## License

MIT

## Attribution

Data provided by [ProPublica Nonprofit Explorer](https://projects.propublica.org/nonprofits/).
