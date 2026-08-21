/**
 * NCLT Bench Registry - Bench IDs, Case Types, Discovery Terms
 *
 * Source: efiling.nclt.gov.in (confirmed via investigation)
 * 15 benches, 42 case types, years 2007-2026
 */

// Bench ID -> city name (from e-filing portal select dropdown)
export const NCLT_BENCHES: Record<string, string> = {
  '1': 'Mumbai',
  '2': 'Kolkata',
  '3': 'Hyderabad',
  '4': 'Chandigarh',
  '5': 'Chennai',
  '6': 'Kochi',
  '7': 'Indore',
  '8': 'Guwahati',
  '9': 'Ahmedabad',
  '10': 'Delhi',
  '11': 'Cuttack',
  '12': 'Bengaluru',
  '13': 'Jaipur',
  '14': 'Allahabad',
  '15': 'Amravati',
};

// Bench city -> slug (for filenames and doc IDs)
export function benchSlug(benchId: string): string {
  const name = NCLT_BENCHES[benchId];
  return name ? name.toLowerCase() : `bench-${benchId}`;
}

// Case type codes discovered from the e-filing portal dropdown.
// Maps numeric code -> human-readable name (from API response case_type_desc_cis).
// Used for deterministic case-number enumeration (100% coverage).
export const CASE_TYPE_CODES: Record<string, string> = {
  '1': 'Transfer Petition(Companies Act)',
  '2': 'Company Petition (Companies Act)',
  '4': 'Interlocatory Application(Companies Act)',
  '6': 'Restoration Application (Companies Act)',
  '7': 'Intervention Petition(Companies Act)',
  '9': 'Contempt Petition(Companies Act)',
  '11': 'Company Appeal(Companies Act)',
  '13': 'Company Application(Companies Act)',
  '14': 'CA(A) Merger and Amalgamation(Companies Act)',
  '15': 'CP(AA) Merger and Amalgamation(Companies Act)',
  '16': 'Company Petition IB (IBC)',
  '22': 'Restoration Application (IBC)',
  '23': 'Intervention Petition (IBC)',
  '25': 'Contempt Petition (IBC)',
  '27': 'Company Appeal (IBC)',
  '29': 'Transfer Petition (IBC)',
  '30': 'Execution Petition',
  '31': 'Interlocutory Application (I.B.C)',
  '32': 'Transfer Application',
  '34': 'Transfer Application (IBC)',
  '36': 'Restored Company Petition (IBC)',
  '37': 'Company Application(Companies Act)',
  '38': 'Interlocutory Application(IBC)(Plan)',
  '39': 'Interlocutory Application(IBC)(Liq.)',
  '40': 'Interlocutory Application(IBC)(Dis.)',
  '41': 'IA (Liq.) Progress Report',
};

// All case type code IDs in order of priority (high-volume types first)
export const ALL_CASE_TYPE_CODES = Object.keys(CASE_TYPE_CODES);

// Stop enumerating case numbers after this many consecutive misses
export const CONSECUTIVE_MISS_LIMIT = 10;

// Legacy: party name search terms (kept for reference, no longer primary strategy)
export const DISCOVERY_TERMS = [
  'Ltd',
  'Limited',
  'Pvt',
  'Private',
  'Corporation',
  'Company',
  'Industries',
  'Enterprises',
  'Solutions',
  'Technologies',
  'Systems',
  'Services',
  'Consultants',
  'Infrastructure',
  'Constructions',
  'Builders',
  'Developers',
  'Housing',
  'Realty',
  'Projects',
  'Finance',
  'Bank',
  'Capital',
  'Investments',
  'Securities',
  'Steel',
  'Power',
  'Energy',
  'Cement',
  'Engineering',
  'Manufacturing',
  'Pharma',
  'Textiles',
  'Chemicals',
  'Motors',
  'Auto',
  'Foods',
  'Beverages',
  'Hotels',
  'Retail',
  'Healthcare',
  'Logistics',
  'Trading',
  'Associates',
  'Group',
  'Holdings',
  'Ventures',
  'Media',
  'Telecom',
  'Authority',
  'Board',
  'Commission',
  'Department',
  'Government',
  'Ministry',
  'Inc',
  'LLC',
  'Corp',
  'Kumar',
  'Singh',
  'Sharma',
  'Gupta',
  'Patel',
  'Agarwal',
  'Jain',
  'Shah',
];

// Years to scrape. NCLT established 2016, but has pre-IBC company law cases from 2007.
// Full coverage: 2007-2026 (20 years).
export const SCRAPE_YEARS = Array.from({ length: 2026 - 2007 + 1 }, (_, i) => 2007 + i);

// All bench IDs in order
export const ALL_BENCH_IDS = Object.keys(NCLT_BENCHES);
