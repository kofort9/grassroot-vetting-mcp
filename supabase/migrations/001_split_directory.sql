-- BON-92: Split directory table into organizations + vetting_results
-- Run as a single atomic transaction. If any step fails, nothing changes.

BEGIN;

-- Pre-flight: verify ALL required source columns exist
DO $$
BEGIN
  IF (
    SELECT count(DISTINCT column_name) FROM information_schema.columns
    WHERE table_name = 'directory'
    AND column_name IN ('ein','name','city','state','ntee_code','ruling_date',
                        'recommendation','score','gate_blocked','red_flag_count',
                        'high_flag_count','summary_headline','summary_justification',
                        'key_factors','review_reasons','result_json','vetted_at')
  ) < 17 THEN
    RAISE EXCEPTION 'directory table schema mismatch — expected 17 columns, manual review required';
  END IF;
END $$;

-- Enable trigram extension for name search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Create organizations table (raw BMF fields + subsection for 501(c) filtering)
CREATE TABLE organizations (
  ein         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT '',
  ntee_code   TEXT NOT NULL DEFAULT '',
  subsection  INTEGER NOT NULL DEFAULT 0,
  ruling_date TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orgs_state ON organizations(state);
CREATE INDEX idx_orgs_ntee ON organizations(ntee_code);
CREATE INDEX idx_orgs_subsection ON organizations(subsection);
CREATE INDEX idx_orgs_name ON organizations USING gin(name gin_trgm_ops);

-- 2. Create vetting_results table (all scoring/vetting fields from old directory)
CREATE TABLE vetting_results (
  ein                   TEXT PRIMARY KEY REFERENCES organizations(ein),
  recommendation        TEXT NOT NULL CHECK(recommendation IN ('PASS','REVIEW','REJECT')),
  score                 INTEGER,
  gate_blocked          BOOLEAN DEFAULT false,
  red_flag_count        INTEGER DEFAULT 0,
  high_flag_count       INTEGER DEFAULT 0,
  summary_headline      TEXT,
  summary_justification TEXT,
  key_factors           TEXT[],
  review_reasons        TEXT[],
  result_json           JSONB NOT NULL,
  vetted_at             TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_vr_recommendation ON vetting_results(recommendation);
CREATE INDEX idx_vr_score ON vetting_results(score DESC NULLS LAST);

-- 3. Migrate data from old directory table
INSERT INTO organizations (ein, name, city, state, ntee_code, ruling_date)
SELECT ein, name, city, state, COALESCE(ntee_code, ''), COALESCE(ruling_date, '')
FROM directory
ON CONFLICT (ein) DO NOTHING;

-- Only migrate rows that have vetting data (recommendation + result_json are NOT NULL).
INSERT INTO vetting_results (
  ein, recommendation, score, gate_blocked, red_flag_count, high_flag_count,
  summary_headline, summary_justification, key_factors, review_reasons,
  result_json, vetted_at
)
SELECT
  ein, recommendation, score,
  COALESCE(gate_blocked, false),
  COALESCE(red_flag_count, 0),
  COALESCE(high_flag_count, 0),
  summary_headline, summary_justification,
  COALESCE(key_factors, ARRAY[]::TEXT[]),
  COALESCE(review_reasons, ARRAY[]::TEXT[]),
  result_json, vetted_at
FROM directory
WHERE recommendation IS NOT NULL
  AND result_json IS NOT NULL
  AND vetted_at IS NOT NULL
ON CONFLICT (ein) DO NOTHING;

-- 4. Sanity check before replacing
DO $$
DECLARE
  org_count INTEGER;
  vr_count INTEGER;
  old_count INTEGER;
  old_vetted_count INTEGER;
BEGIN
  SELECT count(*) INTO org_count FROM organizations;
  SELECT count(*) INTO vr_count FROM vetting_results;
  SELECT count(*) INTO old_count FROM directory;
  SELECT count(*) INTO old_vetted_count FROM directory
    WHERE recommendation IS NOT NULL AND result_json IS NOT NULL AND vetted_at IS NOT NULL;

  -- All directory rows should be in organizations
  IF org_count < old_count THEN
    RAISE EXCEPTION 'Migration count mismatch: directory=%, organizations=% (expected >=)', old_count, org_count;
  END IF;

  -- vetting_results should match the vetted subset of directory
  IF vr_count < old_vetted_count THEN
    RAISE EXCEPTION 'Migration count mismatch: vetted directory=%, vetting_results=% (expected >=)', old_vetted_count, vr_count;
  END IF;

  RAISE NOTICE 'Migration OK: % orgs, % vetting_results (from % directory rows, % vetted)', org_count, vr_count, old_count, old_vetted_count;
END $$;

-- 5. Swap: rename old table, create backwards-compatible view
ALTER TABLE directory RENAME TO directory_old;

-- INNER JOIN: directory view only shows vetted orgs.
-- After BMF refresh, organizations will have ~1.8M rows but only ~60K are vetted.
-- IMPORTANT: Keep metro city lists in sync with scripts/precompute.ts METRO_CITIES mapping.
-- security_definer (default): VIEW runs as owner, not caller. This lets anon
-- users read vetted data through the VIEW while vetting_results has no anon
-- SELECT policy — the VIEW itself is the controlled access layer.
CREATE VIEW directory WITH (security_barrier = true) AS
SELECT
  o.ein, o.name, o.city, o.state, o.ntee_code, o.ruling_date,
  -- metro: derived from city+state
  CASE
    WHEN o.state = 'CA' AND lower(o.city) IN ('san francisco','oakland','san jose','berkeley','palo alto','mountain view','fremont','richmond','hayward','santa clara','sunnyvale','redwood city','daly city','walnut creek','concord') THEN 'bay_area'
    WHEN o.state = 'CA' AND lower(o.city) IN ('los angeles','long beach','pasadena','glendale','santa monica','inglewood','compton','torrance','burbank','el monte') THEN 'la'
    WHEN o.state = 'IL' AND lower(o.city) IN ('chicago','evanston','oak park','cicero','naperville','aurora','joliet','arlington heights','schaumburg') THEN 'chicago'
    ELSE ''
  END AS metro,
  -- cause_area: derived from NTEE first letter (full NTEE category list)
  COALESCE(
    CASE left(o.ntee_code, 1)
      WHEN 'A' THEN 'Arts & Culture' WHEN 'B' THEN 'Education'
      WHEN 'C' THEN 'Environment' WHEN 'D' THEN 'Animal Welfare'
      WHEN 'E' THEN 'Health' WHEN 'F' THEN 'Mental Health'
      WHEN 'G' THEN 'Disease & Disorders' WHEN 'H' THEN 'Medical Research'
      WHEN 'I' THEN 'Crime & Legal' WHEN 'J' THEN 'Employment'
      WHEN 'K' THEN 'Food & Agriculture' WHEN 'L' THEN 'Housing & Shelter'
      WHEN 'M' THEN 'Public Safety' WHEN 'N' THEN 'Recreation & Sports'
      WHEN 'O' THEN 'Youth Development' WHEN 'P' THEN 'Human Services'
      WHEN 'Q' THEN 'International Affairs' WHEN 'R' THEN 'Civil Rights'
      WHEN 'S' THEN 'Community Development' WHEN 'T' THEN 'Philanthropy & Voluntarism'
      WHEN 'U' THEN 'Science & Technology' WHEN 'V' THEN 'Social Science Research'
      WHEN 'W' THEN 'Public Policy' WHEN 'X' THEN 'Religion'
      WHEN 'Y' THEN 'Mutual Benefit' WHEN 'Z' THEN 'Unknown'
    END, ''
  ) AS cause_area,
  v.recommendation, v.score, v.gate_blocked, v.red_flag_count, v.high_flag_count,
  v.summary_headline, v.summary_justification, v.key_factors, v.review_reasons,
  v.result_json, v.vetted_at
FROM organizations o
JOIN vetting_results v ON o.ein = v.ein;

-- 6. RLS policies
-- organizations: anon can read, service_role can write
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_orgs" ON organizations FOR SELECT USING (true);
CREATE POLICY "service_write_orgs" ON organizations FOR ALL USING (auth.role() = 'service_role');

-- vetting_results: NO direct anon access. Anon users read through the directory VIEW
-- (security definer), which runs as the view owner. Direct queries to vetting_results
-- by anon are blocked by RLS. Service role can write for pipeline uploads.
ALTER TABLE vetting_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_write_vr" ON vetting_results FOR ALL USING (auth.role() = 'service_role');

COMMIT;

-- After verifying frontend works (keep directory_old for 7+ days):
-- DROP TABLE directory_old;
