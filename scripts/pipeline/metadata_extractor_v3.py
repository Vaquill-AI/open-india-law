#!/usr/bin/env python3
"""
Metadata Extractor for High Court Judgments - V5 (Versus-split + Improved Advocates)

V5 IMPROVEMENTS:
- Party extraction: 0.6% -> 62% using Versus-split approach
- Advocate extraction: ~5% -> 58%/41% using for-pattern approach
- Removed case_citations (unreliable - data doesn't exist in most HC orders)

Based on V3+V4 optimizations

Based on V3 optimizations + V4 robustness improvements:
1. ALL regexes pre-compiled at module level (saves ~40% CPU)
2. Text cleaning done ONCE and passed to all extractors
3. orjson support for faster JSON operations (5-10x faster)
4. Reduced redundant string operations
5. [V4] Enhanced garbage detection for judge/advocate extraction
6. [V4] Stricter validation for acts_cited
7. [V4] Better lower_court filtering
8. [V4] extract_unique_metadata() returns ONLY fields parquet doesn't have

UNIQUE FIELDS (14 total - parquet doesn't have these):
- case_type, case_number, jurisdiction, bench_type
- acts_cited, articles_cited, case_citations
- petitioner, respondent
- petitioner_advocates, respondent_advocates
- fir_number, lower_court, headnote

PARQUET FIELDS (NOT extracted - parquet already has):
- judge, judges, decision_date, disposal_status, court_name
"""

import re
from datetime import datetime
from typing import Dict, List, Optional, Tuple, Set
import logging

logger = logging.getLogger(__name__)


# =============================================================================
# V5: VERSUS-SPLIT PARTY EXTRACTION (62% success vs 0.6% baseline)
# =============================================================================

VERSUS_PATTERNS_V5 = [
    r'(?:^|\n)\s*[-—]*\s*(?:Versus|VERSUS)\s*[-—]*\s*(?:\n|$)',
    r'(?:^|\n)\s*[-—]*\s*V\s*/\s*[Ss]\s*[-—]*\s*(?:\n|$)',
    r'(?:^|\n)\s*[-—]*\s*Vs\.?\s*[-—]*\s*(?:\n|$)',
    r'(?:^|\n)\s*[-—]*\s*vs\.?\s*[-—]*\s*(?:\n|$)',
    r'(?:^|\n)\s*[-—]*\s*V\.\s*S\.?\s*[-—]*\s*(?:\n|$)',
    r'\.{2,}\s*Versus\s*\.{2,}',
    r'\.{2,}\s*V/s\s*\.{2,}',
    r'\.{2,}\s*Vs\.?\s*\.{2,}',
    r'\s+Versus\s+',
    r'\s+V/s\s+',
    r'\s+Vs\.?\s+',
    r'\s+v\.\s+',
    r'\t+Versus\t+',
    r'\t+V/s\t+',
]

COMBINED_VERSUS_V5 = re.compile('|'.join(VERSUS_PATTERNS_V5), re.IGNORECASE | re.MULTILINE)

NOT_PARTY_PATTERNS_V5 = [
    # Markdown formatting from pymupdf4llm
    r'^```',
    r'^#{1,6}\s',
    r'^\|',
    r'^\*\*',
    # Role markers (not names)
    r'^&\s*Ors?\.?',
    r'^&\s*Others',
    r'^&\s*Anr\.?',
    r'^&\s*Another',
    r'Petitioners?\s*$',
    r'Respondents?\s*$',
    r'Appellants?\s*$',
    r'Applicants?\s*$',
    r'Complainants?\s*$',
    r'Accused\s*$',
    r'\.{3,}\s*Petitioner',
    r'\.{3,}\s*Respondent',
    r'\.{3,}\s*Appellant',
    # Original patterns
    r'^IN THE HIGH COURT', r'^HIGH COURT', r'^BEFORE[:\s]', r'^HON[\.\']',
    r'^CORAM', r'^PRESENT', r'^DATE\s*:', r'^\d+$', r'^Page\s', r'^-{3,}$',
    r'^\*{3,}$', r'^#{2,}', r'^\[.*\]$', r'^CRIMINAL', r'^CIVIL', r'^WRIT',
    r'^APPEAL', r'^PETITION', r'^CASE\s*NO', r'^JUDGMENT', r'^ORDER\s',
    r'^RESERVED', r'^PRONOUNCED', r'^AT BOMBAY', r'^AT DELHI', r'^AT MADRAS',
    r'^BENCH', r'JURISDICTION', r'^No\.\s', r'^Crl\.', r'^W\.P\.', r'^C\.A\.',
    r'^\(.*\)$', r'^FARAD', r'^Office', r'^Court.*order', r'^Registrar',
    r'^Mr\.\s+\w+\s+for', r'^Mrs\.\s+\w+\s+for', r'^Shri\s+\w+\s+for',
    r'^Smt\.\s+\w+\s+for', r'for\s+(the\s+)?(petitioner|respondent|appellant)',
    r'^Advocate', r'^SMT\.',
    r'^SEPTEMBER|^OCTOBER|^NOVEMBER|^DECEMBER|^JANUARY|^FEBRUARY|^MARCH|^APRIL|^MAY|^JUNE|^JULY|^AUGUST',
    r'^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}', r'^P\.C\.', r'^Through',
    r'^AND$', r'^WITH$', r'^IN$',
]

NOT_PARTY_COMPILED_V5 = [re.compile(p, re.IGNORECASE) for p in NOT_PARTY_PATTERNS_V5]

# V5 Advocate patterns (58%/41% success vs ~5%)
PETITIONER_ADV_PATTERNS_V5 = [
    # V6: "For Petitioner: Mr. X.Y. Singh"
    re.compile(r"For\s+(?:the\s+)?(?:Petitioner|Appellant)\s*[:\-]\s*(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?|Adv\.?)?\s*([A-Z][A-Za-z\.\s]+?)(?:\s*,|\s*$|\s+(?:Advocate|Counsel))", re.IGNORECASE),
    # V6: "Mr. X.Y.Z. Singh for the petitioner"
    re.compile(r"(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?|Adv\.?|Dr\.?)\s+([A-Z][A-Za-z\.\s]+?)(?:,?\s*(?:learned\s+)?(?:Senior\s+)?(?:Counsel|Advocate|A\.?S\.?G\.?)?)\s+(?:appearing\s+)?for\s+(?:the\s+)?(?:petitioner|appellant|applicant)", re.IGNORECASE),
    # V6: "Mr. X.Y. Singh, learned counsel for petitioner"
    re.compile(r"(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?)\s+([A-Z][A-Za-z\.\s]+?),?\s+(?:learned\s+)?(?:counsel|advocate)\s+for\s+(?:the\s+)?(?:petitioner|appellant)", re.IGNORECASE),
    # V6: "Petitioner's Counsel: Mr. X"
    re.compile(r"(?:Petitioner|Appellant)'?s?\s+(?:Counsel|Advocate)\s*[:\-]\s*(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?)?\s*([A-Z][A-Za-z\.\s]+?)(?:\s*,|\s*$)", re.IGNORECASE),
    # Original patterns
    re.compile(r"(?:Mr\.|Mrs\.|Ms\.|Shri|Smt\.?)\s+([A-Z][a-zA-Z\.\s]{3,40}?)\s+(?:i/b\s+[^\n]+?\s+)?for\s+(?:the\s+)?(?:petitioner|appellant|applicant)", re.IGNORECASE),
    re.compile(r"([A-Z][a-zA-Z\.\s]{5,40}?),?\s+(?:Advocate|Adv\.?|APP|AGP)\s+for\s+(?:the\s+)?(?:petitioner|appellant|applicant)", re.IGNORECASE),
]

RESPONDENT_ADV_PATTERNS_V5 = [
    # V6: "For Respondent: Mr. X"
    re.compile(r"For\s+(?:the\s+)?(?:Respondent|State|Opposite\s+Party)\s*[:\-]\s*(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?|Adv\.?)?\s*([A-Z][A-Za-z\.\s]+?)(?:\s*,|\s*$|\s+(?:Advocate|Counsel))", re.IGNORECASE),
    # V6: "Mr. X for the respondent/state"
    re.compile(r"(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?|Adv\.?|Dr\.?)\s+([A-Z][A-Za-z\.\s]+?)(?:,?\s*(?:learned\s+)?(?:Senior\s+)?(?:Counsel|Advocate|A\.?S\.?G\.?)?)\s+(?:appearing\s+)?for\s+(?:the\s+)?(?:respondent|opposite\s+party|state|defendant)", re.IGNORECASE),
    # V6: "Mr. X, learned counsel for respondent"
    re.compile(r"(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?)\s+([A-Z][A-Za-z\.\s]+?),?\s+(?:learned\s+)?(?:counsel|advocate)\s+for\s+(?:the\s+)?(?:respondent|state)", re.IGNORECASE),
    # V6: "A.P.P." or "Additional Public Prosecutor"
    re.compile(r"(?:A\.?P\.?P\.?|Additional\s+Public\s+Prosecutor|Public\s+Prosecutor)\s*[:\-]?\s*(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?)?\s*([A-Z][A-Za-z\.\s]+?)(?:\s*,|\s*$)", re.IGNORECASE),
    # V6: "Respondent's Counsel: Mr. X"
    re.compile(r"(?:Respondent|State)'?s?\s+(?:Counsel|Advocate)\s*[:\-]\s*(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?)?\s*([A-Z][A-Za-z\.\s]+?)(?:\s*,|\s*$)", re.IGNORECASE),
    # Original patterns
    re.compile(r"(?:Mr\.|Mrs\.|Ms\.|Shri|Smt\.?)\s+([A-Z][a-zA-Z\.\s]{3,40}?)\s+(?:i/b\s+[^\n]+?\s+)?for\s+(?:the\s+)?(?:respondent|state|accused)", re.IGNORECASE),
    re.compile(r"([A-Z][a-zA-Z\.\s]{5,40}?),?\s+(?:Advocate|Adv\.?|APP|AGP)\s+for\s+(?:the\s+)?(?:respondent|state|accused)", re.IGNORECASE),
]


def _is_valid_party_v5(text: str) -> bool:
    """Check if text is valid party name - V5 version."""
    if not text:
        return False
    text = text.strip()
    if len(text) < 3 or len(text) > 250:
        return False
    for pattern in NOT_PARTY_COMPILED_V5:
        if pattern.search(text):
            return False
    alpha_count = sum(1 for c in text if c.isalpha())
    if alpha_count < max(3, len(text) * 0.25):
        return False
    if text.count('*') > 3 or text.count('#') > 2:
        return False
    return True


def _clean_party_name_v5(name: str):
    """Clean party name - V5 version with markdown handling."""
    if not name:
        return None
    # Remove markdown formatting
    name = re.sub(r'^```+', '', name)
    name = re.sub(r'```+$', '', name)
    name = re.sub(r'^#+\s*', '', name)
    name = re.sub(r'\*\*([^*]+)\*\*', r'\1', name)  # **bold** -> bold
    # Remove role suffixes
    name = re.sub(r'\.{2,}\s*(Petitioner|Appellant|Applicant|Complainant)s?.*$', '', name, flags=re.IGNORECASE)
    name = re.sub(r'\.{2,}\s*(Respondent|Accused|Opposite\s*Party|Defendant)s?.*$', '', name, flags=re.IGNORECASE)
    name = re.sub(r'\s*\.{2,}\s*$', '', name)  # Trailing dots
    name = re.sub(r'\s*:\s*(Petitioner|Respondent|Appellant|Applicant)s?\s*$', '', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+(Petitioner|Respondent|Appellant|Applicant|Complainant)s?\s*$', '', name, flags=re.IGNORECASE)
    # Remove leading numbers/brackets
    name = re.sub(r'^\s*[\d\.\)\(\s]+', '', name)
    # Remove formatting chars
    name = re.sub(r'\*+', '', name)
    name = re.sub(r'#+', '', name)
    name = re.sub(r'\|+', '', name)
    name = re.sub(r'`+', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    name = name.strip('.,;:-*#()[]` ')
    # Skip if it's just a role marker
    if name.lower() in ['petitioner', 'respondent', 'appellant', 'applicant', 'accused', 'complainant']:
        return None
    if re.match(r'^&\s*(ors?|others?|anr|another)$', name, re.IGNORECASE):
        return None
    return name if len(name) > 2 else None



def clean_party_name_v6(text: str) -> str:
    """V6: Remove garbage prefixes/suffixes from party names."""
    if not text:
        return ""
    # Remove leading separators (=, -, _, *, #) with optional whitespace
    text = re.sub(r'^[=\-_*#\s]+', '', text)
    # Remove leading <br> tags (with optional whitespace)
    text = re.sub(r'^(\s*<br\s*/?>)+', '', text, flags=re.IGNORECASE)
    # Remove leading numbered lists: "1. ", "(1) ", "1) ", etc.
    text = re.sub(r'^\s*\(?\d+\)?[\.)\s]+', '', text)
    # Remove trailing role indicators if they're standalone
    text = re.sub(r'\s*\.{2,}\s*(?:Petitioner|Appellant|Respondent|Applicant|Complainant)s?\s*$', '', text, flags=re.IGNORECASE)
    # Clean up excessive whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) < 3:
        return ""
    alpha_count = sum(1 for c in text if c.isalpha())
    if alpha_count < 3:
        return ""
    return text


def _clean_advocate_name_v6(name: str) -> str:
    """V6: Clean extracted advocate name."""
    if not name:
        return ""
    name = name.strip()
    # Remove trailing qualifiers
    name = re.sub(r',?\s*(?:learned\s+)?(?:Senior\s+)?(?:Counsel|Advocate|A\.?S\.?G\.?)?\s*$', '', name, flags=re.IGNORECASE)
    # Remove leading titles if still present
    name = re.sub(r'^(?:Mr\.?|Mrs\.?|Ms\.?|Shri\.?|Smt\.?|Adv\.?|Advocate|Dr\.?)\s*', '', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+', ' ', name).strip()
    name = name.rstrip('.,;:')
    garbage_words = ['for', 'the', 'petitioner', 'respondent', 'appearing', 'learned', 'counsel']
    name_lower = name.lower()
    for g in garbage_words:
        if name_lower == g or name_lower.startswith(g + ' '):
            return ""
    return name if len(name) >= 3 else ""


def _extract_party_from_block_v5(text: str, is_petitioner: bool = True):
    """Extract party name from text block using V5 validation."""
    if not text:
        return None
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    if is_petitioner:
        lines = list(reversed(lines))
    for line in lines:
        cleaned = _clean_party_name_v5(line)
        if cleaned and _is_valid_party_v5(cleaned):
            cleaned = clean_party_name_v6(cleaned)
            if not cleaned:
                continue
            return cleaned[:200]
    return None


def _extract_advocate_v5(text: str, for_petitioner: bool = True):
    """Extract advocate name using for-pattern."""
    if not text:
        return None
    patterns = PETITIONER_ADV_PATTERNS_V5 if for_petitioner else RESPONDENT_ADV_PATTERNS_V5
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            name = match.group(1).strip()
            if name and len(name) > 3 and len(name) < 50:
                if name.lower() not in ["none", "advocate", "adv", "the", "mr", "mrs", "ms"]:
                    if re.search(r"[A-Za-z]{3,}", name):
                        name = re.sub(r"\s+(for|advocate|adv|app|agp).*$", "", name, flags=re.IGNORECASE)
                        name = _clean_advocate_name_v6(name)
                        return name if name else None
    return None

# End V5 additions


# =============================================================================
# PRE-COMPILED REGEXES (OPTIMIZATION #1)
# =============================================================================

# Text cleaning regexes
RE_HTML_TAGS = re.compile(r'<[^>]+>')
RE_ASTERISKS = re.compile(r'\*+')
RE_HASHES = re.compile(r'#+\s*')
RE_PIPES = re.compile(r'\|+')
RE_BACKTICKS = re.compile(r'`+')
RE_WHITESPACE = re.compile(r'\s+')

# Name validation
RE_HAS_LETTER = re.compile(r'[A-Za-z]')
RE_ALL_LETTERS = re.compile(r'[A-Za-z]')
RE_LONG_NUMBERS = re.compile(r'\d{4,}')
RE_NO_LETTERS = re.compile(r'^[^A-Za-z]+$')

# Garbage patterns for name validation (pre-compiled)
GARBAGE_PATTERNS_COMPILED = [
    re.compile(r'^\s*the\s*$', re.IGNORECASE),
    re.compile(r'^\s*of\s*$', re.IGNORECASE),
    re.compile(r'^\s*and\s*$', re.IGNORECASE),
    re.compile(r'^\s*in\s*$', re.IGNORECASE),
    re.compile(r'^\s*at\s*$', re.IGNORECASE),
    re.compile(r'\d{4,}'),
    re.compile(r'^[^A-Za-z]+$'),
    re.compile(r'^this\s+court', re.IGNORECASE),
    re.compile(r'^of\s+this', re.IGNORECASE),
]

# [V4] Enhanced garbage detection - words that indicate judgment body text leaked
# NOTE: Excludes title words (justice, hon, coram) as they're valid for judge names
JUDGMENT_GARBAGE_WORDS = {
    'learned', 'counsel', 'submitted', 'contended', 'argued', 'pleaded',
    'consideration', 'circumstances', 'therefore', 'accordingly', 'hence',
    'heard', 'perused', 'considered', 'examined', 'reviewed', 'analyzed',
    'petition', 'appeal', 'application',
    'petitioner', 'respondent', 'appellant', 'accused', 'complainant',
    'prosecution', 'defence', 'defense', 'evidence', 'witness', 'testimony',
    'aggrieved', 'dissatisfied', 'impugned', 'challenged', 'prayed',
    'submissions', 'contentions', 'averments', 'allegations', 'grounds',
    'question', 'issue', 'matter', 'case', 'facts',
    'before', 'present', 'appearing', 'appeared',
    'against', 'under', 'pursuant', 'accordance', 'respect',
    'common', 'questions', 'law', 'similar', 'analogous',
    'that', 'this', 'which', 'where', 'when', 'while', 'being',
    'advocate', 'for', 'the', 'and', 'state', 'of',
    'acquittal', 'conviction', 'sentenced', 'ordered', 'passed', 'dismissed',
}

# Party validation patterns (pre-compiled)
INVALID_PARTY_PATTERNS_COMPILED = [
    re.compile(r'^(?:Chandigarh|Kadapa|Delhi|Mumbai|Chennai|Kolkata|Bengaluru)\.?\s*$', re.IGNORECASE),
    re.compile(r'^(?:State|Government|Union)\s+of\s*$', re.IGNORECASE),
    re.compile(r'^(?:The|In|At|Of|And)\s*$', re.IGNORECASE),
    re.compile(r',\s*J\.?\]?\s*$', re.IGNORECASE),
    re.compile(r'^JUSTICE\s', re.IGNORECASE),
    re.compile(r"^HON'?BLE\s", re.IGNORECASE),
    re.compile(r'^IN\s+THE\s+HIGH\s+COURT', re.IGNORECASE),
    re.compile(r'^\d+-\s*IN\s+THE', re.IGNORECASE),
]

# Judge patterns (pre-compiled)
JUDGE_PATTERNS_COMPILED = [
    (re.compile(r'CORAM\s*:\s*(.+?)(?=\s*DATE\s*:|DATED\s*:|ORDER|JUDGMENT|\n\s*\n)', re.IGNORECASE | re.DOTALL), "CORAM"),
    (re.compile(r'BENCH\s*:\s*(.+?)(?=\s*DATE\s*:|DATED\s*:|ORDER|JUDGMENT|\n\s*\n)', re.IGNORECASE | re.DOTALL), "BENCH"),
    (re.compile(r'Before\s*:?\s*(.+?)(?=\s*DATE\s*:|DATED\s*:|ORDER|JUDGMENT|\n\s*\n)', re.IGNORECASE | re.DOTALL), "BEFORE"),
    (re.compile(r"HON'?BLE\s+(?:MR\.?\s+)?(?:JUSTICE|JUDGE)\s+([A-Z][A-Z\s\.,]+?)(?:\s+AND\s+HON'?BLE\s+(?:MR\.?\s+)?(?:JUSTICE|JUDGE)\s+([A-Z][A-Z\s\.,]+?))?(?=\s*\n|DATED|DATE|$)", re.IGNORECASE), "HONBLE"),
    (re.compile(r"HON'?BLE\s+(?:MR\.?\s+)?(?:JUSTICE|JUDGE)\s+([A-Z][A-Z\s\.,]+?)(?=\s+AND\s+|\s*,\s*HON|\n|$)", re.IGNORECASE), "HONBLE2"),
    (re.compile(r'(?:^|\n)\s*(?:JUSTICE|JUDGE)\s+([A-Z][A-Z\s\.,]+?)(?=\s+AND\s+|\n|$)', re.MULTILINE), "JUSTICE"),
]

RE_JUDGE_FALLBACK = re.compile(r'\(([A-Z][A-Z\s\.,]+,\s*J\.?)\)\s*$', re.MULTILINE)

# Judge cleanup patterns (pre-compiled)
JUDGE_CLEANUP_COMPILED = [
    (re.compile(r'\s+'), ' '),
    (re.compile(r"^\s*HON'?BLE\s+", re.IGNORECASE), ''),
    (re.compile(r'^\s*(?:MR|MS|MRS|SMT|SHRI)\.?\s+', re.IGNORECASE), ''),
    (re.compile(r'^\s*JUSTICE\s+', re.IGNORECASE), ''),
    (re.compile(r'^\s*JUDGE\s+', re.IGNORECASE), ''),
    (re.compile(r',?\s*J\.?\s*$', re.IGNORECASE), ''),
    (re.compile(r',?\s*JJ\.?\s*$', re.IGNORECASE), ''),
    (re.compile(r'\s*\(.*?\)\s*', re.IGNORECASE), ''),
]

RE_JUDGE_SPLIT = re.compile(r'\s+AND\s+|\s*&\s*|,\s*(?=[A-Z])', re.IGNORECASE)
RE_CORAM_PREFIX = re.compile(r'^CORAM\s*:\s*', re.IGNORECASE)
RE_BENCH_PREFIX = re.compile(r'^BENCH\s*:\s*', re.IGNORECASE)
RE_BEFORE_PREFIX = re.compile(r'^Before\s*:\s*', re.IGNORECASE)

# Noise patterns for judge validation (pre-compiled)
JUDGE_NOISE_COMPILED = [
    re.compile(r'division\s*bench', re.IGNORECASE),
    re.compile(r'single\s*bench', re.IGNORECASE),
    re.compile(r'full\s*bench', re.IGNORECASE),
    re.compile(r'^the\s', re.IGNORECASE),
    re.compile(r'^by\s+an', re.IGNORECASE),
    re.compile(r'^this\s+court', re.IGNORECASE),
    re.compile(r'^learned', re.IGNORECASE),
    re.compile(r'^\d'),
    re.compile(r'^para', re.IGNORECASE),
    re.compile(r'^page', re.IGNORECASE),
    re.compile(r'^order', re.IGNORECASE),
    re.compile(r'^in\s+connection', re.IGNORECASE),
    re.compile(r'police\s+station', re.IGNORECASE),
    re.compile(r'p\.?s\.?\s+case', re.IGNORECASE),
    re.compile(r'case\s+no', re.IGNORECASE),
    re.compile(r'fir\s+no', re.IGNORECASE),
    re.compile(r'crime\s+no', re.IGNORECASE),
    re.compile(r'^at\s+', re.IGNORECASE),
    re.compile(r'^on\s+', re.IGNORECASE),
    re.compile(r'industrial', re.IGNORECASE),
    re.compile(r'industerial', re.IGNORECASE),
    re.compile(r'registered', re.IGNORECASE),
]

# Date patterns (pre-compiled)
DATE_PATTERNS_COMPILED = [
    (re.compile(r'DATE\s*:\s*(\d{1,2})(?:ST|ND|RD|TH)?\s+(\w+)\s+(\d{4})', re.IGNORECASE), 'DMY_WORD'),
    (re.compile(r'DATED\s*:\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})', re.IGNORECASE), 'DMY_NUM'),
    (re.compile(r'DATED?\s*:?-?\s*(\w+)\s+(\d{1,2}),?\s+(\d{4})', re.IGNORECASE), 'MDY_WORD'),
    (re.compile(r'(?:Judgment|Order)\s+Date\s*:\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})', re.IGNORECASE), 'DMY_NUM'),
    (re.compile(r'Date\s+of\s+(?:Judgment|Order)\s*:\s*(\w+)\s+(\d{1,2}),?\s+(\d{4})', re.IGNORECASE), 'MDY_WORD'),
    (re.compile(r'(?:on|dated?)\s+(\d{1,2})(?:ST|ND|RD|TH)?\s+(\w+),?\s+(\d{4})', re.IGNORECASE), 'DMY_WORD'),
    (re.compile(r'(?:^|\s)(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s|$)'), 'DMY_NUM'),
]

MONTH_MAP = {
    'january': 1, 'jan': 1, 'february': 2, 'feb': 2,
    'march': 3, 'mar': 3, 'april': 4, 'apr': 4,
    'may': 5, 'june': 6, 'jun': 6,
    'july': 7, 'jul': 7, 'august': 8, 'aug': 8,
    'september': 9, 'sep': 9, 'sept': 9,
    'october': 10, 'oct': 10, 'november': 11, 'nov': 11,
    'december': 12, 'dec': 12,
}

# Case type patterns (pre-compiled)
CASE_TYPE_PATTERNS_COMPILED = [
    (re.compile(r'WRIT\s+PETITION\s*\(?\s*(?:CIVIL|CRIMINAL|C|Crl)?\s*\)?', re.IGNORECASE), 'WRIT PETITION'),
    (re.compile(r'CRIMINAL\s+APPEAL', re.IGNORECASE), 'CRIMINAL APPEAL'),
    (re.compile(r'CIVIL\s+APPEAL', re.IGNORECASE), 'CIVIL APPEAL'),
    (re.compile(r'SPECIAL\s+LEAVE\s+PETITION', re.IGNORECASE), 'SPECIAL LEAVE PETITION'),
    (re.compile(r'BAIL\s+APPLICATION', re.IGNORECASE), 'BAIL APPLICATION'),
    (re.compile(r'ANTICIPATORY\s+BAIL', re.IGNORECASE), 'ANTICIPATORY BAIL'),
    (re.compile(r'CONTEMPT\s+(?:PETITION|CASE)', re.IGNORECASE), 'CONTEMPT'),
    (re.compile(r'REVIEW\s+(?:PETITION|APPLICATION)', re.IGNORECASE), 'REVIEW PETITION'),
    (re.compile(r'FIRST\s+APPEAL', re.IGNORECASE), 'FIRST APPEAL'),
    (re.compile(r'SECOND\s+APPEAL', re.IGNORECASE), 'SECOND APPEAL'),
    (re.compile(r'MISC\.?\s*(?:CIVIL|CRIMINAL)?\s*APPLICATION', re.IGNORECASE), 'MISCELLANEOUS APPLICATION'),
    (re.compile(r'APPEAL\s+FROM\s+ORDER', re.IGNORECASE), 'APPEAL FROM ORDER'),
    (re.compile(r'ORIGINAL\s+(?:SIDE\s+)?(?:SUIT|PETITION)', re.IGNORECASE), 'ORIGINAL PETITION'),
    (re.compile(r'LETTERS?\s+PATENT\s+APPEAL', re.IGNORECASE), 'LETTERS PATENT APPEAL'),
    (re.compile(r'(?:CRL|CRIMINAL)\s*\.?\s*(?:MC|MISC)', re.IGNORECASE), 'CRIMINAL MISCELLANEOUS'),
    (re.compile(r'(?:CIVIL|CIV)\s*\.?\s*(?:MC|MISC)', re.IGNORECASE), 'CIVIL MISCELLANEOUS'),
    (re.compile(r'PUBLIC\s+INTEREST\s+LITIGATION', re.IGNORECASE), 'PIL'),
    (re.compile(r'\bPIL\b', re.IGNORECASE), 'PIL'),
    (re.compile(r'\bW\.?\s*P\.?\s*\(?\s*(?:C|Crl|CIVIL|CRIMINAL)\s*\)?\.?\s*(?:No\.?)?', re.IGNORECASE), 'WRIT PETITION'),
    (re.compile(r'\bCr\.?\s*A\.?\s*(?:No\.?)?', re.IGNORECASE), 'CRIMINAL APPEAL'),
    (re.compile(r'\bC\.?\s*A\.?\s*(?:No\.?)?', re.IGNORECASE), 'CIVIL APPEAL'),
    (re.compile(r'\bSLP\s*\(?\s*(?:C|Crl)?\s*\)?', re.IGNORECASE), 'SPECIAL LEAVE PETITION'),
    (re.compile(r'\bCRL\.?\s*M\.?\s*C\.?', re.IGNORECASE), 'CRIMINAL MISCELLANEOUS'),
    (re.compile(r'\bC\.?\s*M\.?\s*A\.?', re.IGNORECASE), 'CIVIL MISCELLANEOUS APPLICATION'),
]

# Case number patterns (pre-compiled)
CASE_NUMBER_PATTERNS_COMPILED = [
    re.compile(r'(?:Case\s*No\.?|W\.?P\.?\s*(?:\(C\))?|Cr\.?\s*A\.?|C\.?\s*A\.?|SLP|CRL\.?\s*M\.?\s*C\.?)\s*(?:No\.?\s*)?(\d+(?:/\d+)?(?:\s*of\s*\d{4})?)', re.IGNORECASE),
    re.compile(r'(?:Writ\s+Petition|Criminal\s+Appeal|Civil\s+Appeal)\s*(?:\([^)]+\))?\s*(?:No\.?\s*)?(\d+(?:/\d+)?)\s*(?:of\s*)?(\d{4})', re.IGNORECASE),
    re.compile(r'(?:No\.?|Number)\s*:?\s*(\d+(?:/\d+)?)\s*(?:of|/)\s*(\d{4})', re.IGNORECASE),
]

# Party patterns (pre-compiled)
PARTY_PATTERNS_COMPILED = [
    re.compile(r'(.+?)\s*\.{2,}\s*(?:Petitioner|Appellant|Complainant)s?\s+(?:Versus|Vs\.?|V\.)\s+(.+?)\s*\.{2,}\s*(?:Respondent|Accused|Opposite\s+Party)', re.IGNORECASE | re.MULTILINE),
    re.compile(r'^(.+?)\s+(?:Versus|Vs\.?|V\.)\s+(.+?)$', re.IGNORECASE | re.MULTILINE),
    re.compile(r'(.+?)\s+-vs-\s+(.+)', re.IGNORECASE),
]

RESPONDENT_PATTERNS_COMPILED = [
    re.compile(r'(?:Versus|Vs\.?|V\.)\s*\n?\s*([A-Z][A-Za-z\s\.]+?)\s*\.{2,}\s*(?:Respondent|Accused|Opposite\s+Party)', re.IGNORECASE | re.MULTILINE),
]

# Party name cleanup
RE_PARTY_SUFFIX = re.compile(r'\s*[:\-]+\s*(?:Petitioner|Appellant|Applicant|Respondent|Accused|Opposite\s+Party)s?\s*$', re.IGNORECASE)

# Jurisdiction patterns (pre-compiled)
JURISDICTION_PATTERNS_COMPILED = [
    (re.compile(r'(CRIMINAL)\s+(?:APPELLATE\s+)?JURISDICTION', re.IGNORECASE), 'CRIMINAL'),
    (re.compile(r'(CIVIL)\s+(?:APPELLATE\s+)?JURISDICTION', re.IGNORECASE), 'CIVIL'),
    (re.compile(r'(WRIT)\s+JURISDICTION', re.IGNORECASE), 'WRIT'),
    (re.compile(r'(ORIGINAL)\s+(?:CIVIL\s+)?JURISDICTION', re.IGNORECASE), 'ORIGINAL'),
    (re.compile(r'(APPELLATE)\s+JURISDICTION', re.IGNORECASE), 'APPELLATE'),
    (re.compile(r'(REVISIONAL)\s+JURISDICTION', re.IGNORECASE), 'REVISIONAL'),
    (re.compile(r'CRIMINAL\s+APPEAL', re.IGNORECASE), 'CRIMINAL'),
    (re.compile(r'CIVIL\s+APPEAL', re.IGNORECASE), 'CIVIL'),
    (re.compile(r'WRIT\s+PETITION', re.IGNORECASE), 'WRIT'),
    (re.compile(r'BAIL\s+APPLICATION', re.IGNORECASE), 'CRIMINAL'),
    (re.compile(r'ANTICIPATORY\s+BAIL', re.IGNORECASE), 'CRIMINAL'),
]

# Disposal patterns (pre-compiled)
DISPOSAL_PATTERNS_COMPILED = [
    (re.compile(r'\b(allowed)\b', re.IGNORECASE), 'ALLOWED'),
    (re.compile(r'\b(dismissed)\b', re.IGNORECASE), 'DISMISSED'),
    (re.compile(r'\bpartly\s+(allowed)\b', re.IGNORECASE), 'PARTLY ALLOWED'),
    (re.compile(r'\b(rejected)\b', re.IGNORECASE), 'REJECTED'),
    (re.compile(r'\bdisposed\s+(?:of|off)\b', re.IGNORECASE), 'DISPOSED'),
    (re.compile(r'\b(withdrawn)\b', re.IGNORECASE), 'WITHDRAWN'),
    (re.compile(r'\b(quashed)\b', re.IGNORECASE), 'QUASHED'),
    (re.compile(r'\b(remanded)\b', re.IGNORECASE), 'REMANDED'),
    (re.compile(r'\b(stayed)\b', re.IGNORECASE), 'STAYED'),
    (re.compile(r'\bsine\s+die\b', re.IGNORECASE), 'ADJOURNED SINE DIE'),
    (re.compile(r'\b(acquitted)\b', re.IGNORECASE), 'ACQUITTED'),
    (re.compile(r'\b(convicted)\b', re.IGNORECASE), 'CONVICTED'),
]

# Bench type patterns (pre-compiled)
BENCH_TYPE_PATTERNS_COMPILED = [
    (re.compile(r'Division\s+Bench', re.IGNORECASE), 'DIVISION BENCH'),
    (re.compile(r'\bDB\b'), 'DIVISION BENCH'),
    (re.compile(r'Full\s+Bench', re.IGNORECASE), 'FULL BENCH'),
    (re.compile(r'\bFB\b'), 'FULL BENCH'),
    (re.compile(r'Single\s+(?:Judge\s+)?Bench', re.IGNORECASE), 'SINGLE BENCH'),
    (re.compile(r'\bSB\b'), 'SINGLE BENCH'),
    (re.compile(r'Constitution\s+Bench', re.IGNORECASE), 'CONSTITUTION BENCH'),
    (re.compile(r'Larger\s+Bench', re.IGNORECASE), 'LARGER BENCH'),
]

# Court name patterns (pre-compiled)
COURT_NAME_PATTERNS_COMPILED = [
    re.compile(r'HIGH\s+COURT\s+(?:OF\s+)?(?:JUDICATURE\s+)?(?:AT\s+|FOR\s+)([A-Z][A-Za-z]+)', re.IGNORECASE),
    re.compile(r'([A-Z][A-Za-z]+)\s+HIGH\s+COURT', re.IGNORECASE),
]

# Acts pattern (pre-compiled)
RE_ACT_PATTERN = re.compile(
    r'(?:Section|Sec\.?|S\.?)\s*(\d+(?:\s*\([a-zA-Z0-9]+\))?(?:\s*(?:r/w|read\s+with)\s*\d+(?:\s*\([a-zA-Z0-9]+\))?)*)\s+(?:of\s+)?(?:the\s+)?([A-Z][A-Za-z\s,\.]+?(?:Act|Code|Rules|Regulations|Order)(?:\s*,?\s*\d{4})?)',
    re.IGNORECASE
)

# Article pattern (pre-compiled)
RE_ARTICLE_PATTERN = re.compile(
    r'Article\s+(\d+(?:\s*\([a-zA-Z0-9]+\))?(?:\s*(?:r/w|read\s+with)\s*\d+(?:\s*\([a-zA-Z0-9]+\))?)*)\s+(?:of\s+)?(?:the\s+)?Constitution',
    re.IGNORECASE
)

# Advocate patterns (pre-compiled)
ADVOCATE_PATTERNS_COMPILED = [
    re.compile(r'(?:Mr\.?|Ms\.?|Shri|Smt\.?)\s+([A-Za-z\s\.]+?),?\s+(?:Advocate|Adv\.?|Counsel|Senior\s+Counsel)\s+(?:for\s+)?(?:the\s+)?(?:Petitioner|Appellant|Applicant)s?', re.IGNORECASE),
    re.compile(r'(?:Advocate|Counsel)\s+(?:for\s+)?(?:the\s+)?(?:Petitioner|Appellant|Applicant)s?\s*[:\-]?\s*(?:Mr\.?|Ms\.?|Shri|Smt\.?)?\s*([A-Za-z\s\.]+?)(?=\.|,\s*(?:Advocate|for)|$)', re.IGNORECASE),
    re.compile(r'([A-Za-z\s\.]+?)\s+(?:appearing|appeared)\s+(?:for\s+)?(?:the\s+)?(?:Petitioner|Appellant|Applicant)s?', re.IGNORECASE),
]

RESPONDENT_ADVOCATE_PATTERNS_COMPILED = [
    re.compile(r'(?:Mr\.?|Ms\.?|Shri|Smt\.?)\s+([A-Za-z\s\.]+?),?\s+(?:Advocate|Adv\.?|Counsel|Senior\s+Counsel|AGP|APP|Public\s+Prosecutor)\s+(?:for\s+)?(?:the\s+)?(?:Respondent|State|Accused|Opposite\s+Party)', re.IGNORECASE),
    re.compile(r'(?:Advocate|Counsel|AGP|APP)\s+(?:for\s+)?(?:the\s+)?(?:Respondent|State|Accused)s?\s*[:\-]?\s*(?:Mr\.?|Ms\.?|Shri|Smt\.?)?\s*([A-Za-z\s\.]+?)(?=\.|,|$)', re.IGNORECASE),
    re.compile(r'([A-Za-z\s\.]+?)\s+(?:appearing|appeared)\s+(?:for\s+)?(?:the\s+)?(?:Respondent|State|Accused)', re.IGNORECASE),
]

# Advocate cleanup patterns
RE_ADVOCATE_PREFIX = re.compile(r'^\s*(?:Mr\.?|Ms\.?|Shri|Smt\.?)\s+', re.IGNORECASE)

# Party cleanup patterns (pre-compiled) - FIX: was inline re.sub
RE_PARTY_NUM_PREFIX = re.compile(r'^\d+\.\s*')
RE_PARTY_DOTS_SUFFIX = re.compile(r'\s*\.{2,}\s*$')

# Advocate digit check (pre-compiled) - FIX: was inline re.search
RE_HAS_DIGIT = re.compile(r'\d')
ADVOCATE_NOISE_COMPILED = [
    re.compile(r'^learned\s+counsel', re.IGNORECASE),
    re.compile(r'^also\s+heard', re.IGNORECASE),
    re.compile(r'^the\s+petitioner', re.IGNORECASE),
    re.compile(r'^the\s+respondent', re.IGNORECASE),
    re.compile(r'^counsel\s+for', re.IGNORECASE),
    re.compile(r'^state$', re.IGNORECASE),
    re.compile(r'^and\s+learned', re.IGNORECASE),
    re.compile(r'^and\s+mr', re.IGNORECASE),
    re.compile(r'^heard\s+', re.IGNORECASE),
]

# Lower court patterns (pre-compiled)
LOWER_COURT_PATTERNS_COMPILED = [
    re.compile(r'(?:order|judgment|decree|award)\s+(?:passed\s+)?(?:by|of)\s+(?:the\s+)?(?:Learned\s+)?(?:Hon\'?ble\s+)?([A-Za-z\s]+(?:Court|Tribunal|Judge|Magistrate|Authority|Commission|Board))', re.IGNORECASE),
    re.compile(r'(?:impugned|challenged|appealed)\s+(?:order|judgment|decree)\s+(?:of\s+)?(?:the\s+)?(?:Learned\s+)?([A-Za-z\s]+(?:Court|Tribunal|Judge|Magistrate))', re.IGNORECASE),
    re.compile(r'(?:appeal|revision)\s+(?:against|from)\s+(?:the\s+)?(?:order\s+of\s+)?(?:the\s+)?(?:Learned\s+)?([A-Za-z\s]+(?:Court|Tribunal|Judge|Magistrate))', re.IGNORECASE),
]

# FIR patterns (pre-compiled)
FIR_PATTERNS_COMPILED = [
    re.compile(r'(?:FIR|First\s+Information\s+Report)\s*(?:No\.?)?\s*:?\s*(\d+(?:/\d+)?)\s*(?:of\s*)?(\d{4})?', re.IGNORECASE),
    re.compile(r'(?:Crime|CR|C\.?R\.?)\s*(?:No\.?)?\s*:?\s*(\d+(?:/\d+)?)\s*(?:of\s*)?(\d{4})?', re.IGNORECASE),
    re.compile(r'(?:Police\s+Station)\s+[A-Za-z\s]+\s+(?:Crime|FIR)\s*(?:No\.?)?\s*(\d+(?:/\d+)?)', re.IGNORECASE),
    # [V4] P.S. Case pattern (common in Bihar/Patna judgments)
    re.compile(r'P\.?S\.?\s*(?:Case)?\s*No\.?\s*[-:]?\s*(\d+)\s*(?:of|Year)?\s*[-:]?\s*(\d{4})?', re.IGNORECASE),
]

# Headnote pattern (pre-compiled)
RE_HEADNOTE = re.compile(r'(?:HEADNOTE|HEAD\s*NOTE|SUMMARY)\s*[:\-]?\s*(.{100,500}?)(?=\n\n|\n[A-Z]{3,}|\n\d+\.)', re.IGNORECASE | re.DOTALL)


# =============================================================================
# VALID COURTS LIST (used in validation)
# =============================================================================

VALID_COURTS = [
    'bombay', 'delhi', 'madras', 'calcutta', 'allahabad', 'andhra',
    'telangana', 'karnataka', 'kerala', 'punjab', 'haryana', 'gujarat',
    'rajasthan', 'madhya', 'chhattisgarh', 'jharkhand', 'bihar', 'orissa',
    'odisha', 'assam', 'gauhati', 'guwahati', 'patna', 'lucknow',
    'hyderabad', 'bangalore', 'chennai', 'mumbai', 'kolkata', 'amaravati',
    'jabalpur', 'nagpur', 'aurangabad', 'panaji', 'goa', 'sikkim',
    'manipur', 'meghalaya', 'tripura', 'uttarakhand', 'himachal',
    'jammu', 'kashmir', 'srinagar', 'chandigarh', 'cuttack',
]


# =============================================================================
# TEXT CLEANING (OPTIMIZATION #2 - Single clean pass)
# =============================================================================

def clean_ocr_artifacts(text: str) -> str:
    """Remove HTML/markdown artifacts from OCR text."""
    if not text:
        return ""
    cleaned = RE_HTML_TAGS.sub(' ', text)
    cleaned = RE_ASTERISKS.sub(' ', cleaned)
    cleaned = RE_HASHES.sub(' ', cleaned)
    cleaned = RE_PIPES.sub(' ', cleaned)
    cleaned = RE_BACKTICKS.sub(' ', cleaned)
    cleaned = RE_WHITESPACE.sub(' ', cleaned)
    return cleaned.strip()


# =============================================================================
# VALIDATION UTILITIES (use pre-compiled patterns)
# =============================================================================

def is_garbage_text(text: str) -> bool:
    """
    [V4] Check if extracted text is garbage (judgment body leaked into field).

    Returns True if:
    - Text starts/ends with common connector words
    - Contains too many judgment-related words (>40%)
    - Has too many lowercase words (typical of judgment body)
    """
    if not text:
        return True

    text_lower = text.lower().strip()

    # Check for common garbage patterns - starts/ends with connectors
    if text_lower.startswith(('and ', 'the ', 'of ', 'in ', 'at ', 'to ', 'for ', 'by ', 'is ', 'was ', 'has ', 'learned ')):
        return True
    if text_lower.endswith((' and', ' the', ' of', ' in', ' at', ' to', ' for', ' by', ' is', ' was')):
        return True

    # Check for sentence fragments with judgment words
    words_lower = text_lower.split()
    words_orig = text.strip().split()  # Keep original case for checking
    if len(words_lower) >= 3:
        garbage_word_count = sum(1 for w in words_lower if w.strip('.,;:') in JUDGMENT_GARBAGE_WORDS)
        garbage_ratio = garbage_word_count / len(words_lower)
        # If >40% of words are garbage words, it's likely judgment text
        if garbage_ratio > 0.4:
            return True

    # Check for long strings of lowercase words (typical of judgment body)
    # Use ORIGINAL text case - proper names have capitalized words
    if len(words_orig) > 3:
        lowercase_words = sum(1 for w in words_orig if w.islower() and len(w) > 2)
        if lowercase_words / len(words_orig) > 0.7:
            return True

    return False


def is_valid_name(name: str, min_len: int = 3, max_len: int = 100) -> bool:
    """Validate that a name looks like a real name, not garbage."""
    if not name or len(name) < min_len or len(name) > max_len:
        return False
    if not RE_HAS_LETTER.search(name):
        return False
    letter_count = len(RE_ALL_LETTERS.findall(name))
    if letter_count < len(name) * 0.3:
        return False
    for pat in GARBAGE_PATTERNS_COMPILED:
        if pat.search(name):
            return False
    # [V4] Additional garbage check
    if is_garbage_text(name):
        return False
    return True


def is_valid_court_name(name: str) -> bool:
    """Validate court name is a real Indian court/location."""
    if not name or len(name) < 3 or len(name) > 40:
        return False
    name_clean = name.split()[0] if ' ' in name else name
    for court in VALID_COURTS:
        if name_clean.lower().startswith(court):
            return True
    name_lower = name.lower()
    for court in VALID_COURTS:
        if court in name_lower:
            return True
    return False


def clean_court_name(name: str) -> str:
    """Clean court name, extracting just the location."""
    name_lower = name.lower()
    for court in VALID_COURTS:
        if name_lower.startswith(court):
            return court.capitalize()
        if court in name_lower:
            return court.capitalize()
    return name


def is_valid_party_name(name: str) -> bool:
    """Validate party name is not garbage."""
    if not is_valid_name(name, min_len=4, max_len=150):
        return False
    for pat in INVALID_PARTY_PATTERNS_COMPILED:
        if pat.search(name):
            return False
    return True


# =============================================================================
# JUDGE EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_judge(header_clean: str) -> Optional[str]:
    """Extract primary judge name from pre-cleaned header text."""
    judges = extract_judges(header_clean)
    return judges[0] if judges else None


def extract_judges(header_clean: str) -> List[str]:
    """Extract all judge names from pre-cleaned header text."""
    if not header_clean:
        return []

    for regex, _ in JUDGE_PATTERNS_COMPILED:
        match = regex.search(header_clean)
        if match:
            raw_judges = match.group(1).strip()
            judges = _parse_judge_names(raw_judges)
            if judges:
                return judges

    match = RE_JUDGE_FALLBACK.search(header_clean)
    if match:
        judges = _parse_judge_names(match.group(1))
        if judges:
            return judges

    return []


def _parse_judge_names(raw: str) -> List[str]:
    """Parse raw judge string into list of validated names."""
    if not raw:
        return []

    parts = RE_JUDGE_SPLIT.split(raw)
    judges = []

    for part in parts:
        name = _clean_judge_name(part)
        if name and is_valid_name(name, min_len=4, max_len=50):
            is_noise = False
            for noise_pat in JUDGE_NOISE_COMPILED:
                if noise_pat.search(name):
                    is_noise = True
                    break
            if is_noise:
                continue
            if len(name.split()) > 5:
                continue
            if RE_HAS_LETTER.search(name):
                judges.append(name)

    return judges


def _clean_judge_name(name: str) -> str:
    """Clean a single judge name."""
    if not name:
        return ""

    cleaned = name.strip()
    cleaned = RE_CORAM_PREFIX.sub('', cleaned)
    cleaned = RE_BENCH_PREFIX.sub('', cleaned)
    cleaned = RE_BEFORE_PREFIX.sub('', cleaned)

    for regex, replacement in JUDGE_CLEANUP_COMPILED:
        cleaned = regex.sub(replacement, cleaned)

    return cleaned.strip(' \t\n:-.,')


# =============================================================================
# DATE EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_decision_date(header_clean: str) -> Optional[str]:
    """Extract decision date from pre-cleaned header text."""
    if not header_clean:
        return None

    for regex, fmt in DATE_PATTERNS_COMPILED:
        match = regex.search(header_clean)
        if match:
            try:
                if fmt == 'DMY_WORD':
                    day = int(match.group(1))
                    month = MONTH_MAP.get(match.group(2).lower())
                    year = int(match.group(3))
                elif fmt == 'DMY_NUM':
                    day = int(match.group(1))
                    month = int(match.group(2))
                    year = int(match.group(3))
                    if year < 100:
                        year += 2000 if year < 50 else 1900
                elif fmt == 'MDY_WORD':
                    month = MONTH_MAP.get(match.group(1).lower())
                    day = int(match.group(2))
                    year = int(match.group(3))
                else:
                    continue

                if month and 1 <= day <= 31 and 1900 <= year <= 2100:
                    return f"{year:04d}-{month:02d}-{day:02d}"
            except (ValueError, TypeError):
                continue

    return None


# =============================================================================
# CASE TYPE EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_case_type(header_clean: str) -> Optional[str]:
    """Extract case type from pre-cleaned header text."""
    if not header_clean:
        return None

    for regex, case_type in CASE_TYPE_PATTERNS_COMPILED:
        if regex.search(header_clean):
            return case_type

    return None


# =============================================================================
# CASE NUMBER EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_case_number(header_clean: str) -> Optional[str]:
    """Extract case number from pre-cleaned header text."""
    if not header_clean:
        return None

    for regex in CASE_NUMBER_PATTERNS_COMPILED:
        match = regex.search(header_clean)
        if match:
            groups = [g for g in match.groups() if g]
            if groups:
                return ' of '.join(groups) if len(groups) > 1 else groups[0]

    return None


# =============================================================================
# PARTIES EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_parties(header_clean: str, full_text: str = None) -> Dict[str, Optional[str]]:
    """
    Extract petitioner and respondent using Versus-split approach.
    V5: 62% success rate vs 0.6% baseline.
    """
    result = {'petitioner': None, 'respondent': None}

    # Use full_text if provided, otherwise use header
    search_text = full_text[:5000] if full_text else header_clean

    if not search_text:
        return result

    # Find Versus marker
    match = COMBINED_VERSUS_V5.search(search_text)
    if not match:
        # Fallback to old method if no Versus found
        return _extract_parties_legacy(header_clean)

    before_versus = search_text[:match.start()]
    after_versus = search_text[match.end():]

    # Extract petitioner (last valid line before Versus)
    result['petitioner'] = _extract_party_from_block_v5(before_versus[-1500:], is_petitioner=True)

    # Extract respondent (first valid line after Versus)
    result['respondent'] = _extract_party_from_block_v5(after_versus[:1500], is_petitioner=False)

    return result


def _extract_parties_legacy(header_clean: str) -> Dict[str, Optional[str]]:
    """Legacy party extraction as fallback when no Versus marker found."""
    result = {'petitioner': None, 'respondent': None}

    if not header_clean:
        return result

    for regex in PARTY_PATTERNS_COMPILED:
        match = regex.search(header_clean)
        if match:
            petitioner = _clean_party_name(match.group(1))
            if petitioner and is_valid_party_name(petitioner):
                result['petitioner'] = petitioner

            if len(match.groups()) > 1:
                respondent = _clean_party_name(match.group(2))
                if respondent and is_valid_party_name(respondent):
                    result['respondent'] = respondent

            if result['petitioner']:
                break

    if not result['respondent']:
        for regex in RESPONDENT_PATTERNS_COMPILED:
            match = regex.search(header_clean)
            if match:
                respondent = _clean_party_name(match.group(1))
                if respondent and is_valid_party_name(respondent):
                    result['respondent'] = respondent
                    break

    return result


def _clean_party_name(name: str) -> str:
    """Clean party name."""
    if not name:
        return ""

    cleaned = name.strip()
    cleaned = RE_ASTERISKS.sub('', cleaned)
    cleaned = RE_HASHES.sub('', cleaned)
    cleaned = RE_BACKTICKS.sub('', cleaned)
    cleaned = RE_PARTY_NUM_PREFIX.sub('', cleaned)  # FIX: pre-compiled
    cleaned = RE_PARTY_DOTS_SUFFIX.sub('', cleaned)  # FIX: pre-compiled
    cleaned = RE_WHITESPACE.sub(' ', cleaned)
    cleaned = RE_PARTY_SUFFIX.sub('', cleaned)
    cleaned = cleaned.strip('., :-()')

    if len(cleaned) > 200:
        cleaned = cleaned[:200] + '...'

    return cleaned


# =============================================================================
# JURISDICTION EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_jurisdiction(header_clean: str, case_type: Optional[str] = None) -> Optional[str]:
    """Extract jurisdiction type from pre-cleaned header text."""
    if not header_clean:
        return None

    for regex, jurisdiction in JURISDICTION_PATTERNS_COMPILED:
        if regex.search(header_clean):
            return jurisdiction

    # Infer from case type if provided
    if case_type:
        if 'CRIMINAL' in case_type or 'BAIL' in case_type:
            return 'CRIMINAL'
        if 'CIVIL' in case_type:
            return 'CIVIL'
        if 'WRIT' in case_type or 'PIL' in case_type:
            return 'WRIT'

    return None


# =============================================================================
# DISPOSAL STATUS EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_disposal_status(footer_clean: str) -> Optional[str]:
    """Extract disposal/outcome status from pre-cleaned footer text."""
    if not footer_clean:
        return None

    for regex, status in DISPOSAL_PATTERNS_COMPILED:
        if regex.search(footer_clean):
            return status

    return None


# =============================================================================
# BENCH TYPE EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_bench_type(header_clean: str) -> Optional[str]:
    """Extract bench type from pre-cleaned header text."""
    if not header_clean:
        return None

    for regex, bench_type in BENCH_TYPE_PATTERNS_COMPILED:
        if regex.search(header_clean):
            return bench_type

    return None


# =============================================================================
# ACTS AND SECTIONS CITED (use pre-compiled patterns)
# =============================================================================

def extract_acts_cited(text: str) -> List[Dict[str, str]]:
    """Extract all acts and sections cited in the text."""
    if not text:
        return []

    acts_cited = []
    seen = set()

    matches = RE_ACT_PATTERN.findall(text)

    for section, act in matches:
        section = section.strip()
        act = RE_WHITESPACE.sub(' ', act.strip())
        act = act.rstrip('., ')

        key = f"{section}|{act.lower()}"
        if key not in seen and len(act) > 3:
            seen.add(key)
            acts_cited.append({
                'section': section,
                'act': act
            })

    return acts_cited[:20]


def extract_acts_cited_list(text: str) -> List[str]:
    """Extract acts cited as simple list of strings."""
    acts = extract_acts_cited(text)
    return [f"Section {a['section']} of {a['act']}" for a in acts]


# =============================================================================
# CONSTITUTIONAL ARTICLES CITED (use pre-compiled patterns)
# =============================================================================

def extract_articles_cited(text: str) -> List[str]:
    """Extract Constitutional articles cited."""
    if not text:
        return []

    articles = []
    seen = set()

    matches = RE_ARTICLE_PATTERN.findall(text)

    for article in matches:
        article = article.strip()
        if article not in seen:
            seen.add(article)
            articles.append(f"Article {article}")

    return articles[:10]


# =============================================================================
# ADVOCATES EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_advocates(header_clean: str) -> Dict[str, List[str]]:
    """
    Extract advocates using improved for-pattern approach.
    V5: 58%/41% success vs ~5% baseline.
    """
    result = {
        'petitioner_advocates': [],
        'respondent_advocates': []
    }

    if not header_clean:
        return result

    # Extract petitioner advocate
    pet_adv = _extract_advocate_v5(header_clean, for_petitioner=True)
    if pet_adv:
        result['petitioner_advocates'] = [pet_adv]

    # Extract respondent advocate
    resp_adv = _extract_advocate_v5(header_clean, for_petitioner=False)
    if resp_adv:
        result['respondent_advocates'] = [resp_adv]

    return result



def extract_lower_court(full_text_clean: str) -> Optional[str]:
    """Extract lower court/tribunal from pre-cleaned full text."""
    if not full_text_clean:
        return None

    # [V4] Invalid lower court patterns (not actual courts)
    invalid_lower = {'this court', 'high court', 'the court', 'court below', 'lower court'}

    for regex in LOWER_COURT_PATTERNS_COMPILED:
        match = regex.search(full_text_clean)
        if match:
            court = match.group(1).strip()
            court = RE_WHITESPACE.sub(' ', court)

            # [V4] Skip invalid generic references
            if court.lower() in invalid_lower:
                continue

            # [V4] Skip if contains judgment body indicators (stricter for lower_court)
            court_lower = court.lower()
            if any(w in court_lower for w in ['learned', 'acquittal', 'conviction', 'recorded by', 'passed by', 'made by']):
                continue

            # [V4] Must contain specific court type keyword
            court_keywords = ['district', 'sessions', 'magistrate', 'tribunal', 'civil',
                            'family', 'labour', 'consumer', 'munsiff', 'munsif', 'additional']
            has_keyword = any(kw in court.lower() for kw in court_keywords)

            # [V4] Skip if contains judgment body words (garbage detection)
            if is_garbage_text(court):
                continue

            # Validate - must have court keyword or be long enough
            if (has_keyword or len(court) > 20) and 5 < len(court) < 100 and is_valid_name(court):
                return court

    return None


# =============================================================================
# FIR / CRIME NUMBER EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_fir_number(text: str) -> Optional[str]:
    """Extract FIR/Crime number for criminal cases."""
    if not text:
        return None

    for regex in FIR_PATTERNS_COMPILED:
        match = regex.search(text)
        if match:
            groups = [g for g in match.groups() if g]
            if groups:
                return '/'.join(groups) if len(groups) > 1 else groups[0]

    return None


# =============================================================================
# COURT NAME EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_court_name(header_clean: str) -> Optional[str]:
    """Extract full court name from pre-cleaned header text."""
    if not header_clean:
        return None

    for regex in COURT_NAME_PATTERNS_COMPILED:
        match = regex.search(header_clean)
        if match:
            court = match.group(1).strip()
            court = RE_WHITESPACE.sub(' ', court)
            if is_valid_court_name(court):
                clean_name = clean_court_name(court)
                return f"High Court of {clean_name}"

    return None


# =============================================================================
# HEADNOTE EXTRACTION (use pre-compiled patterns)
# =============================================================================

def extract_headnote(full_text_clean: str) -> Optional[str]:
    """Extract headnote/summary from pre-cleaned full text."""
    if not full_text_clean:
        return None

    match = RE_HEADNOTE.search(full_text_clean)
    if match:
        headnote = match.group(1).strip()
        headnote = RE_WHITESPACE.sub(' ', headnote)
        return headnote

    return None


# =============================================================================
# MAIN EXTRACTION FUNCTION (OPTIMIZATION #2 - single text cleaning)
# =============================================================================

def extract_all_metadata(text: str, boxes: List[Dict] = None) -> Dict:
    """
    Extract all metadata from parsed document.

    OPTIMIZED: Cleans text ONCE and passes pre-cleaned regions to extractors.

    Args:
        text: Full text content
        boxes: Optional list of text boxes (for structured extraction)

    Returns:
        Dict with all extracted metadata fields for Legal RAG
    """
    # Use boxes text if available (often cleaner)
    if boxes:
        box_text = '\n'.join(box.get('text', '') for box in boxes if box.get('text'))
        search_text = box_text if box_text else text
    else:
        search_text = text

    # =========================================================================
    # OPTIMIZATION: Clean text ONCE, reuse for all extractions
    # =========================================================================

    # Clean header region (first 5000 chars covers all header extractions)
    header_clean = clean_ocr_artifacts(search_text[:5000]) if search_text else ""

    # Clean footer region (last 4000 chars for disposal status)
    footer_clean = clean_ocr_artifacts(text[-4000:]) if text and len(text) > 4000 else clean_ocr_artifacts(text) if text else ""

    # Clean extended regions for specific extractions (NOT full text - that's slow!)
    # Lower court info typically in first 15K chars
    lower_court_text = clean_ocr_artifacts(text[:15000]) if text else ""
    # Headnote typically in first 10K chars
    headnote_text = clean_ocr_artifacts(text[:10000]) if text else ""

    # Extract case type first (needed for jurisdiction inference)
    case_type = extract_case_type(header_clean)

    # Core metadata - all use pre-cleaned text
    metadata = {
        # Judge info
        'judge': extract_judge(header_clean),
        'judges': extract_judges(header_clean),
        'bench_type': extract_bench_type(header_clean),

        # Case identifiers
        'case_type': case_type,
        'case_number': extract_case_number(header_clean),
        'jurisdiction': extract_jurisdiction(header_clean, case_type),

        # Dates
        'decision_date': extract_decision_date(header_clean),

        # Parties (will be filled below)
        'petitioner': None,
        'respondent': None,

        # Outcome
        'disposal_status': extract_disposal_status(footer_clean),

        # Legal citations (need full text)
        'acts_cited': extract_acts_cited_list(text) if text else [],
        'articles_cited': extract_articles_cited(text) if text else [],

        # Advocates (will be filled below)
        'petitioner_advocates': [],
        'respondent_advocates': [],

        # Lower court
        'lower_court': extract_lower_court(lower_court_text),

        # Criminal case specific
        'fir_number': extract_fir_number(text) if text else None,

        # Court
        'court_name': extract_court_name(header_clean),

        # Summary (if available)
        'headnote': extract_headnote(headnote_text),
    }

    # Add parties
    # V5 FIX: Pass raw text for party extraction (needs newlines for line detection)
    raw_search_text = search_text[:5000] if search_text else ""
    parties = extract_parties(header_clean, full_text=raw_search_text)
    metadata['petitioner'] = parties['petitioner']
    metadata['respondent'] = parties['respondent']

    # Add advocates (use extended header - first 5000 chars is enough)
    advocates = extract_advocates(header_clean)
    metadata['petitioner_advocates'] = advocates['petitioner_advocates']
    metadata['respondent_advocates'] = advocates['respondent_advocates']

    # Fallback to full text if boxes didn't work
    if boxes and text:
        text_header_clean = clean_ocr_artifacts(text[:5000])
        if not metadata['judge']:
            metadata['judge'] = extract_judge(text_header_clean)
            metadata['judges'] = extract_judges(text_header_clean)
        if not metadata['decision_date']:
            metadata['decision_date'] = extract_decision_date(text_header_clean)
        if not metadata['case_type']:
            metadata['case_type'] = extract_case_type(text_header_clean)
        if not metadata['petitioner']:
            raw_text_header = text[:5000] if text else ""
            parties = extract_parties(text_header_clean, full_text=raw_text_header)
            metadata['petitioner'] = parties['petitioner']
            metadata['respondent'] = parties['respondent']
        if not metadata['petitioner_advocates']:
            advocates = extract_advocates(text_header_clean)
            metadata['petitioner_advocates'] = advocates['petitioner_advocates']
            metadata['respondent_advocates'] = advocates['respondent_advocates']

    return metadata


# =============================================================================
# FAST EXTRACTION FOR BACKFILL (only core fields, no expensive operations)
# =============================================================================

def extract_core_metadata(text: str, boxes: List[Dict] = None) -> Dict:
    """
    Fast extraction of core metadata for backfill operations.

    Skips expensive operations like:
    - acts_cited, articles_cited (full text scan)
    - lower_court, headnote (extra text cleaning)
    - fir_number (text scan)
    - advocates split (complex parsing)

    Returns only the 10 fields needed for backfill.
    """
    # Use boxes text if available (often cleaner)
    if boxes:
        box_text = '\n'.join(box.get('text', '') for box in boxes if box.get('text'))
        search_text = box_text if box_text else text
    else:
        search_text = text

    # Clean only header and footer (minimal cleaning)
    header_clean = clean_ocr_artifacts(search_text[:5000]) if search_text else ""
    footer_clean = clean_ocr_artifacts(text[-4000:]) if text and len(text) > 4000 else clean_ocr_artifacts(text) if text else ""

    # Extract case type first (needed for jurisdiction)
    case_type = extract_case_type(header_clean)

    # Extract parties once
    # V5 FIX: Pass raw text for party extraction (needs newlines for line detection)
    raw_search_text = search_text[:5000] if search_text else ""
    parties = extract_parties(header_clean, full_text=raw_search_text)

    return {
        'judge': extract_judge(header_clean),
        'judges': extract_judges(header_clean),
        'decision_date': extract_decision_date(header_clean),
        'case_type': case_type,
        'petitioner': parties['petitioner'],
        'respondent': parties['respondent'],
        'court_name': extract_court_name(header_clean),
        'disposal_status': extract_disposal_status(footer_clean),
        'jurisdiction': extract_jurisdiction(header_clean, case_type),
        'bench_type': extract_bench_type(header_clean),
    }


# =============================================================================
# [V4] UNIQUE FIELDS ONLY (parquet already has judge, decision_date, disposal_status, court_name)
# =============================================================================

def extract_unique_metadata(text: str, boxes: List[Dict] = None) -> Dict:
    """
    [V4] Extract ONLY unique metadata fields that parquet doesn't provide.

    RETURNS 14 fields (parquet doesn't have these):
    - case_type, case_number, jurisdiction, bench_type
    - acts_cited, articles_cited
    - petitioner, respondent
    - petitioner_advocates, respondent_advocates
    - fir_number, lower_court, headnote

    DOES NOT RETURN (parquet already has):
    - judge, judges, decision_date, disposal_status, court_name
    """
    # Use boxes text if available (often cleaner)
    if boxes:
        box_text = '\n'.join(box.get('text', '') for box in boxes if box.get('text'))
        search_text = box_text if box_text else text
    else:
        search_text = text

    # =========================================================================
    # FIX: Clean text ONCE up to 15K, slice from that (avoids duplicate cleaning)
    # Previously cleaned 5K, 10K, 15K separately = 3x overhead on overlapping regions
    # =========================================================================
    text_clean_15k = clean_ocr_artifacts(text[:15000]) if text else ""
    header_clean = clean_ocr_artifacts(search_text[:5000]) if search_text else ""
    lower_court_text = text_clean_15k  # Reuse cleaned 15K
    headnote_text = text_clean_15k[:10000]  # Slice from cleaned 15K

    # Extract case type first (needed for jurisdiction inference)
    case_type = extract_case_type(header_clean)

    # Extract parties
    # V5 FIX: Pass raw text for party extraction (needs newlines for line detection)
    raw_search_text = search_text[:5000] if search_text else ""
    parties = extract_parties(header_clean, full_text=raw_search_text)

    # Extract advocates
    advocates = extract_advocates(header_clean)

    metadata = {
        # Case identifiers
        'case_type': case_type,
        'case_number': extract_case_number(header_clean),
        'jurisdiction': extract_jurisdiction(header_clean, case_type),
        'bench_type': extract_bench_type(header_clean),

        # Legal citations (full text needed)
        'acts_cited': extract_acts_cited_list(text) if text else [],
        'articles_cited': extract_articles_cited(text) if text else [],

        # Parties
        'petitioner': parties['petitioner'],
        'respondent': parties['respondent'],

        # Advocates
        'petitioner_advocates': advocates['petitioner_advocates'],
        'respondent_advocates': advocates['respondent_advocates'],

        # Criminal case specific
        'fir_number': extract_fir_number(text) if text else None,

        # Lower court
        'lower_court': extract_lower_court(lower_court_text),

        # Summary
        'headnote': extract_headnote(headnote_text),
    }

    # Fallback to full text if boxes didn't work
    # FIX: Reuse text_clean_15k[:5000] instead of re-cleaning
    if boxes and text:
        text_header_clean = text_clean_15k[:5000]  # FIX: slice from already cleaned
        if not metadata['case_type']:
            metadata['case_type'] = extract_case_type(text_header_clean)
        if not metadata['petitioner']:
            raw_text_header = text[:5000] if text else ""
            parties = extract_parties(text_header_clean, full_text=raw_text_header)
            metadata['petitioner'] = parties['petitioner']
            metadata['respondent'] = parties['respondent']
        if not metadata['petitioner_advocates']:
            advocates = extract_advocates(text_header_clean)
            metadata['petitioner_advocates'] = advocates['petitioner_advocates']
            metadata['respondent_advocates'] = advocates['respondent_advocates']

    return metadata


# =============================================================================
# TESTING
# =============================================================================

if __name__ == '__main__':
    test_text = """
    IN THE HIGH COURT OF JUDICATURE AT BOMBAY
    CRIMINAL APPELLATE JURISDICTION
    CRIMINAL APPEAL NO. 789 OF 2022

    Ramesh Kumar ... Appellant
    Versus
    State of Maharashtra ... Respondent

    CORAM: A.B. SHARMA AND C.D. PATEL, JJ.
    (Division Bench)
    DATE: 15TH MARCH 2023

    Mr. P.K. Singh, Advocate for the Appellant.
    Mr. R.S. Gupta, APP for the Respondent/State.

    This appeal arises from FIR No. 123/2021 registered at
    Andheri Police Station.

    The appellant challenges the order dated 10.01.2022 passed by
    the learned Sessions Judge, Mumbai.

    Section 302 of the Indian Penal Code is invoked.
    Article 21 of the Constitution is also relied upon.

    The appeal is partly allowed.
    """

    print("=" * 70)
    print("METADATA EXTRACTION TEST - V3 OPTIMIZED")
    print("=" * 70)

    import time

    # Warm-up run
    _ = extract_all_metadata(test_text)

    # Timed run
    start = time.perf_counter()
    for _ in range(1000):
        metadata = extract_all_metadata(test_text)
    elapsed = time.perf_counter() - start

    print(f"\nPerformance: {1000/elapsed:.0f} extractions/sec")
    print(f"Time per extraction: {elapsed*1000:.2f}ms")
    print()

    for key, value in metadata.items():
        if value:
            print(f"{key:25s}: {value}")
