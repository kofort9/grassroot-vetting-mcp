/**
 * Name normalization for OFAC matching.
 *
 * OFAC matching is a binary legal concern — we use exact match
 * after normalization rather than fuzzy matching.
 *
 * Normalization steps:
 * 1. Unicode NFD normalization + diacritic stripping
 * 2. Lowercase
 * 3. Strip punctuation (periods, commas, quotes, etc.)
 * 4. Remove "the" prefix
 * 5. Strip trailing organizational suffixes only
 * 6. Collapse whitespace
 */

// Only true organizational suffixes that never carry semantic meaning
// as part of a proper name. Words like "national", "institute", "fund",
// "trust", "society", "group", "international" are intentionally excluded
// because they appear as meaningful name components (e.g., "National Wildlife Fund").
const ORG_SUFFIXES = [
  "incorporated",
  "inc",
  "corporation",
  "corp",
  "association",
  "assoc",
  "assn",
  "organization",
  "org",
  "limited",
  "ltd",
  "llc",
  "llp",
  "lp",
  "co",
  "company",
  "nfp",
  "pbc",
];

// Match suffixes only at the END of the string, preceded by a space.
// Applied iteratively to strip stacked suffixes like "inc ltd".
const TRAILING_SUFFIX_PATTERN = new RegExp(
  `\\s+(${ORG_SUFFIXES.join("|")})$`,
  "i",
);

export function normalizeName(name: string): string {
  // Unicode NFD normalization: decompose accented chars, then strip combining marks
  // e.g., "José" → "Jose", "Müller" → "Muller"
  let normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  normalized = normalized.toLowerCase();

  // Strip punctuation (keep alphanumeric and spaces)
  normalized = normalized.replace(/[^a-z0-9\s]/g, "");

  // Remove "the" prefix
  normalized = normalized.replace(/^the\s+/, "");

  // Strip trailing org suffixes iteratively (handles "corp inc" stacking)
  // Cap iterations to prevent pathological inputs from causing excessive looping
  let prev: string;
  let iterations = 0;
  do {
    prev = normalized;
    normalized = normalized.replace(TRAILING_SUFFIX_PATTERN, "");
    iterations++;
  } while (normalized !== prev && iterations < 10);

  // Collapse whitespace and trim
  normalized = normalized.replace(/\s+/g, " ").trim();

  return normalized;
}
