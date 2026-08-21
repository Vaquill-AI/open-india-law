"""
Indian Legal Citation Patterns.

Comprehensive regex patterns for extracting citations from Indian legal documents.
Covers all major reporters and court systems.

References:
- Indian Law Reports (ILR)
- All India Reporter (AIR)
- Supreme Court Cases (SCC)
- MANUPATRA citation format
- Neutral citation format (2024 INSC 123, 2024:KER:456)
- SCC Online (2024 SCC OnLine Del 123)

Updated: 2025 - Added High Court neutral citations and SCC Online HC formats
"""

import re
from re import Pattern

# =============================================================================
# CITATION REGEX PATTERNS
# =============================================================================

INDIAN_CITATION_PATTERNS: dict[str, Pattern] = {
    # =========================================================================
    # ALL INDIA REPORTER (AIR)
    # Format: AIR YYYY Court Page
    # Examples:
    #   - AIR 2024 SC 123
    #   - AIR 2023 Del 456
    #   - AIR 1950 FC 27 (Federal Court, historical)
    # =========================================================================
    "air": re.compile(r"\bAIR\s+(\d{4})\s+([A-Z][a-z]*(?:&[A-Z])?|SC|FC)\s+(\d+)\b", re.IGNORECASE),
    # =========================================================================
    # SUPREME COURT CASES (SCC)
    # Formats:
    #   - (YYYY) Volume SCC Page: (2024) 5 SCC 123
    #   - YYYY SCC Volume Page: 2024 SCC 5 123
    #   - YYYY (Volume) SCC Page: 2024 (5) SCC 123
    # =========================================================================
    "scc_parenthetical": re.compile(r"\((\d{4})\)\s*(\d{1,2})\s*SCC\s+(\d+)", re.IGNORECASE),
    "scc_standard": re.compile(r"\b(\d{4})\s+SCC\s+(\d{1,2})\s+(\d+)\b", re.IGNORECASE),
    "scc_online": re.compile(r"\b(\d{4})\s+SCC\s+OnLine\s+SC\s+(\d+)\b", re.IGNORECASE),
    # =========================================================================
    # SCC ONLINE HIGH COURT CITATIONS
    # Format: YYYY SCC OnLine CourtCode Number
    # Examples:
    #   - 2024 SCC OnLine Del 1234
    #   - 2023 SCC OnLine Bom 5678
    #   - 2022 SCC OnLine Ker 9012
    # =========================================================================
    "scc_online_hc": re.compile(
        r"\b(\d{4})\s+SCC\s+OnLine\s+([A-Z][a-z]{2,4})\s+(\d+)\b",
        re.IGNORECASE,
    ),
    # =========================================================================
    # SUPREME COURT REPORTS (SCR)
    # Format: SCR (Volume) Year Page or [Year] Volume SCR Page
    # Examples:
    #   - SCR (1) 2024 45
    #   - [2024] 3 SCR 123
    # =========================================================================
    "scr_standard": re.compile(r"\bSCR\s*\((\d{1,2})\)\s*(\d{4})\s+(\d+)\b", re.IGNORECASE),
    "scr_bracket": re.compile(r"\[(\d{4})\]\s*(\d{1,2})\s*SCR\s+(\d+)\b", re.IGNORECASE),
    # =========================================================================
    # MANUPATRA (MANU)
    # Format: MANU/CourtCode/Year/Number
    # Examples:
    #   - MANU/SC/2024/0123
    #   - MANU/DE/2023/4567
    #   - MANU/MH/2024/8901
    # =========================================================================
    "manu": re.compile(r"\bMANU/([A-Z]{2,4})/(\d{4})/(\d+)\b", re.IGNORECASE),
    # =========================================================================
    # NEUTRAL CITATIONS (INSC for Supreme Court)
    # Format: YYYY INSC Number
    # Examples:
    #   - 2024 INSC 123
    #   - 2023 INSC 456
    # =========================================================================
    "neutral_sc": re.compile(r"\b(\d{4})\s+INSC\s+(\d+)\b", re.IGNORECASE),
    # =========================================================================
    # HIGH COURT NEUTRAL CITATIONS (New 2024-2025 format)
    # Format: YYYY:CODE:Number or YYYY/CODE/Number
    # Examples:
    #   - 2024:KER:5678 (Kerala HC)
    #   - 2024:AHC:26454 (Allahabad HC)
    #   - 2024:AHC-LKO:12762 (Allahabad HC Lucknow Bench)
    #   - 2024/DHC/1234 (Delhi HC alternate format)
    #   - 2024:BHC:1234-DB (Division Bench indicator)
    # Court codes: KER, DHC, AHC, BHC, MHC, KA, GJ, TS, RJ, OR, PH, MP, CG, HP, JK, JH, MG, TR
    # =========================================================================
    "neutral_hc_colon": re.compile(
        r"\b(\d{4}):([A-Z]{2,4}(?:-[A-Z]{2,4})?):(\d+)(?:-DB)?\b",
        re.IGNORECASE,
    ),
    "neutral_hc_slash": re.compile(
        r"\b(\d{4})/([A-Z]{2,4})/(\d+)\b",
        re.IGNORECASE,
    ),
    # =========================================================================
    # SCALE (Supreme Court Annotated Legal Encyclopaedia)
    # Format: (YYYY) Volume SCALE Page
    # Examples:
    #   - (2024) 5 SCALE 123
    #   - (2023) 12 SCALE 456
    # =========================================================================
    "scale": re.compile(r"\((\d{4})\)\s*(\d{1,2})\s*SCALE\s+(\d+)", re.IGNORECASE),
    # =========================================================================
    # JUDGMENT TODAY (JT)
    # Format: JT YYYY (Volume) SC Page
    # Examples:
    #   - JT 2024 (5) SC 123
    #   - JT 2023 (12) SC 456
    # =========================================================================
    "jt": re.compile(r"\bJT\s+(\d{4})\s*\((\d{1,2})\)\s*SC\s+(\d+)\b", re.IGNORECASE),
    # =========================================================================
    # STATE HIGH COURT REPORTERS
    # Various state-specific formats
    # =========================================================================
    # Bombay Law Reporter (Bom LR)
    "bom_lr": re.compile(r"\b(\d{4})\s*\((\d{1,2})\)\s*Bom\s*LR\s+(\d+)\b", re.IGNORECASE),
    # Delhi Law Times (DLT)
    "dlt": re.compile(r"\b(\d{4})\s*\((\d{1,2})\)\s*DLT\s+(\d+)\b", re.IGNORECASE),
    # Gujarat Law Reporter (Guj LR)
    "guj_lr": re.compile(r"\b(\d{4})\s+Guj\s*LR\s+(\d+)\b", re.IGNORECASE),
    # Karnataka Law Journal (KLJ)
    "klj": re.compile(r"\b(\d{4})\s*\((\d{1,2})\)\s*KLJ\s+(\d+)\b", re.IGNORECASE),
    # Kerala Law Times (KLT)
    "klt": re.compile(r"\b(\d{4})\s*\((\d{1,2})\)\s*KLT\s+(\d+)\b", re.IGNORECASE),
    # Madras Law Weekly (MLW)
    "mlw": re.compile(r"\b(\d{4})\s*\((\d{1,2})\)\s*MLW\s+(\d+)\b", re.IGNORECASE),
    # Allahabad Law Journal (ALJ)
    "alj": re.compile(r"\b(\d{4})\s+ALJ\s+(\d+)\b", re.IGNORECASE),
    # Punjab Law Reporter (PLR)
    "plr": re.compile(r"\bPLR\s+(\d{4})\s+(\d+)\b", re.IGNORECASE),
    # Calcutta Weekly Notes (CWN)
    "cwn": re.compile(r"\b(\d{4})\s*\((\d{1,2})\)\s*CWN\s+(\d+)\b", re.IGNORECASE),
    # =========================================================================
    # TRIBUNAL CITATIONS
    # =========================================================================
    # Income Tax Appellate Tribunal (ITAT)
    "itat": re.compile(
        r"\b(\d{4})\s+ITAT\s+(\d+)\b|\bITA\s*No\.?\s*(\d+)/(\w+)/(\d{4})\b",
        re.IGNORECASE,
    ),
    # NCLT/NCLAT (Company Law)
    "nclt": re.compile(
        r"\b(?:NCLT|NCLAT)\s*(?:Order\s*)?(?:dated\s*)?(\d{1,2}[./]\d{1,2}[./]\d{2,4})?\s*(?:in\s*)?(?:CP|CA|TA)?\s*(?:No\.?)?\s*(\d+)",
        re.IGNORECASE,
    ),
    # =========================================================================
    # GENERIC INDIAN LAW REPORTS (ILR)
    # Format: ILR YYYY State Volume Page
    # Examples:
    #   - ILR 2024 Kar 5 123
    #   - ILR 2023 Delhi 3 456
    # =========================================================================
    "ilr": re.compile(r"\bILR\s+(\d{4})\s+([A-Za-z]+)\s+(\d{1,2})\s+(\d+)\b", re.IGNORECASE),
    # =========================================================================
    # CRIMINAL LAW JOURNAL (Cri LJ)
    # Format: YYYY Cri LJ Page or (YYYY) Volume Cri LJ Page
    # =========================================================================
    "cri_lj": re.compile(
        r"\b(\d{4})\s+Cri\s*LJ\s+(\d+)\b|\((\d{4})\)\s*(\d{1,2})\s*Cri\s*LJ\s+(\d+)",
        re.IGNORECASE,
    ),
    # =========================================================================
    # COMPANY CASES (Comp Cas)
    # Format: (YYYY) Volume Comp Cas Page
    # =========================================================================
    "comp_cas": re.compile(r"\((\d{4})\)\s*(\d{1,3})\s*Comp\s*Cas\s+(\d+)", re.IGNORECASE),
    # =========================================================================
    # TAX CASES (various)
    # =========================================================================
    "itr": re.compile(  # Income Tax Reports
        r"\((\d{4})\)\s*(\d{1,3})\s*ITR\s+(\d+)", re.IGNORECASE
    ),
    "taxman": re.compile(  # Taxman
        r"\((\d{4})\)\s*(\d{1,3})\s*Taxman\s+(\d+)", re.IGNORECASE
    ),
    "gst": re.compile(r"\b(\d{4})\s+GST\s+(\d+)\b", re.IGNORECASE),  # GST cases
}

# =============================================================================
# COURT CODE MAPPINGS
# =============================================================================

# AIR court codes to full names
AIR_COURT_CODES = {
    "SC": "Supreme Court",
    "FC": "Federal Court",  # Historical (pre-1950)
    "Del": "Delhi High Court",
    "Bom": "Bombay High Court",
    "Mad": "Madras High Court",
    "Cal": "Calcutta High Court",
    "Kar": "Karnataka High Court",
    "Ker": "Kerala High Court",
    "AP": "Andhra Pradesh High Court",
    "Guj": "Gujarat High Court",
    "Raj": "Rajasthan High Court",
    "MP": "Madhya Pradesh High Court",
    "Pat": "Patna High Court",
    "All": "Allahabad High Court",
    "P&H": "Punjab & Haryana High Court",
    "Ori": "Orissa High Court",
    "J&K": "Jammu & Kashmir High Court",
    "HP": "Himachal Pradesh High Court",
    "Gau": "Gauhati High Court",
    "Chh": "Chhattisgarh High Court",
    "Jha": "Jharkhand High Court",
    "Utt": "Uttarakhand High Court",
    "Tel": "Telangana High Court",
    "Tri": "Tripura High Court",
    "Meg": "Meghalaya High Court",
    "Man": "Manipur High Court",
    "Sik": "Sikkim High Court",
    "NOC": "Notes of Cases",  # AIR special
}

# High Court Neutral Citation codes (2024-2025 format)
# Used in formats like 2024:KER:1234 or 2024/DHC/1234
NEUTRAL_HC_CODES = {
    # Major High Courts
    "KER": "Kerala High Court",
    "DHC": "Delhi High Court",
    "AHC": "Allahabad High Court",
    "AHC-LKO": "Allahabad High Court (Lucknow Bench)",
    "BHC": "Bombay High Court",
    "MHC": "Madras High Court",
    "CHC": "Calcutta High Court",
    # State codes (two-letter)
    "KA": "Karnataka High Court",
    "GJ": "Gujarat High Court",
    "TS": "Telangana High Court",
    "AP": "Andhra Pradesh High Court",
    "RJ": "Rajasthan High Court",
    "OR": "Orissa High Court",
    "PH": "Punjab & Haryana High Court",
    "MP": "Madhya Pradesh High Court",
    "CG": "Chhattisgarh High Court",
    "HP": "Himachal Pradesh High Court",
    "JK": "Jammu & Kashmir High Court",
    "JH": "Jharkhand High Court",
    "UK": "Uttarakhand High Court",
    "UR": "Uttarakhand High Court",  # Alternate code
    "MG": "Meghalaya High Court",
    "TR": "Tripura High Court",
    "MN": "Manipur High Court",
    "SK": "Sikkim High Court",
    "GA": "Gauhati High Court",
    "BH": "Patna High Court",  # Bihar
    "TN": "Madras High Court",  # Tamil Nadu
}

# SCC Online High Court codes
SCC_ONLINE_HC_CODES = {
    "Del": "Delhi High Court",
    "Bom": "Bombay High Court",
    "Mad": "Madras High Court",
    "Cal": "Calcutta High Court",
    "Kar": "Karnataka High Court",
    "Ker": "Kerala High Court",
    "All": "Allahabad High Court",
    "Guj": "Gujarat High Court",
    "Raj": "Rajasthan High Court",
    "MP": "Madhya Pradesh High Court",
    "Pat": "Patna High Court",
    "P&H": "Punjab & Haryana High Court",
    "PH": "Punjab & Haryana High Court",
    "Ori": "Orissa High Court",
    "AP": "Andhra Pradesh High Court",
    "Tel": "Telangana High Court",
    "J&K": "Jammu & Kashmir High Court",
    "JK": "Jammu & Kashmir High Court",
    "HP": "Himachal Pradesh High Court",
    "Chh": "Chhattisgarh High Court",
    "Jhar": "Jharkhand High Court",
    "Utt": "Uttarakhand High Court",
    "Gau": "Gauhati High Court",
    "Tri": "Tripura High Court",
    "Meg": "Meghalaya High Court",
    "Man": "Manipur High Court",
    "Sik": "Sikkim High Court",
}

# MANU court codes
MANU_COURT_CODES = {
    "SC": "Supreme Court",
    "SCOR": "Supreme Court",
    "DE": "Delhi High Court",
    "MH": "Bombay High Court",
    "TN": "Madras High Court",
    "WB": "Calcutta High Court",
    "KA": "Karnataka High Court",
    "KE": "Kerala High Court",
    "GJ": "Gujarat High Court",
    "RJ": "Rajasthan High Court",
    "UP": "Allahabad High Court",
    "PH": "Punjab & Haryana High Court",
    "OR": "Orissa High Court",
    "BI": "Patna High Court",
    "AP": "Andhra Pradesh High Court",
    "TS": "Telangana High Court",
    "MP": "Madhya Pradesh High Court",
    "CG": "Chhattisgarh High Court",
    "JH": "Jharkhand High Court",
    "UK": "Uttarakhand High Court",
    "HP": "Himachal Pradesh High Court",
    "JK": "Jammu & Kashmir High Court",
    "GA": "Gauhati High Court",
    "SK": "Sikkim High Court",
    "TR": "Tripura High Court",
    "MG": "Meghalaya High Court",
    "MN": "Manipur High Court",
    # Tribunals
    "IT": "Income Tax Appellate Tribunal",
    "CE": "CESTAT",
    "CL": "NCLT/NCLAT",
    "SA": "Securities Appellate Tribunal",
    "CA": "Central Administrative Tribunal",
}

# =============================================================================
# CASE NAME PATTERNS
# =============================================================================

# Pattern to extract case names (e.g., "State of Maharashtra v. X")
CASE_NAME_PATTERN = re.compile(
    r"(?:In\s+)?(?:Re:\s*)?"  # Optional "In" or "Re:"
    r"([A-Z][a-zA-Z\s&.,]+?)"  # First party
    r"\s+(?:v\.?|vs\.?|versus)\s+"  # versus separator
    r"([A-Z][a-zA-Z\s&.,]+?)"  # Second party
    r"(?=\s*[\[\(,]|\s+\d{4}|\s*$)",  # Lookahead for citation/year/end
    re.IGNORECASE,
)

# Common party name prefixes
PARTY_PREFIXES = [
    "State of",
    "Union of India",
    "Commissioner of",
    "Director of",
    "Chief Commissioner",
    "Collector",
    "Municipal Corporation",
    "M/s",
    "Smt.",
    "Shri",
    "Dr.",
    "Prof.",
]

# =============================================================================
# VALIDATION PATTERNS
# =============================================================================

# Valid year range for Indian citations (1947 onwards, with some pre-independence)
MIN_VALID_YEAR = 1860  # Indian Penal Code era
MAX_VALID_YEAR = 2100  # Future buffer


def is_valid_year(year: int) -> bool:
    """Check if year is valid for Indian legal citations."""
    return MIN_VALID_YEAR <= year <= MAX_VALID_YEAR


def normalize_court_code(code: str) -> str:
    """Normalize court code variations."""
    code = code.strip().upper()
    normalizations = {
        "SUPREME COURT": "SC",
        "DELHI": "DEL",
        "BOMBAY": "BOM",
        "MUMBAI": "BOM",
        "MADRAS": "MAD",
        "CHENNAI": "MAD",
        "CALCUTTA": "CAL",
        "KOLKATA": "CAL",
        "KARNATAKA": "KAR",
        "BENGALURU": "KAR",
        "BANGALORE": "KAR",
    }
    return normalizations.get(code, code)
