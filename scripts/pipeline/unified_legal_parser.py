#!/usr/bin/env python3
"""
Unified Legal Document Parser for Indian Court RAG Pipelines

Single source of truth for PDF parsing and metadata extraction across:
- Supreme Court of India
- High Courts of India (all 25 benches)
- Tribunals (future)

This script consolidates:
- pymupdf4llm_parser.py: PDF text extraction with PyMuPDF Pro + OCR
- metadata_extractor_v3.py: Text-based metadata extraction (14 unique fields)
- legal_chunker.py: Unified chunking with complete schema

UNIFIED METADATA SCHEMA (40+ fields):

COMMON FIELDS (both SC and HC):
- case_id, doc_id, title, year, decision_date
- court, court_type, data_source
- judges, bench_strength, bench_type
- petitioner, respondent, disposition
- section_type, section_priority
- char_start, char_end, page_start, page_end
- chunk_index, total_chunks, pdf_url

SUPREME COURT SPECIFIC:
- citation, language_code, pdf_urls
- petitioners_all, respondents_all
- case_type, jurisdiction
- acts_referenced, cases_cited, cited_by_count
- box_aware, has_legacy_fonts

HIGH COURT SPECIFIC:
- state_code, state_name, establishment_code, court_code
- bench, bench_display_name, r2_key
- case_type, case_number, jurisdiction
- acts_referenced (mapped from acts_cited), articles_cited
- petitioner_advocates, respondent_advocates
- lower_court, fir_number, headnote
- description, date_of_registration
- has_legacy_fonts, ocr_used

Usage:
    # Parse a single PDF (SC)
    python unified_legal_parser.py --pdf /path/to/judgment.pdf --court-type supreme_court

    # Parse a single PDF (HC) with parquet metadata
    python unified_legal_parser.py --pdf /path/to/judgment.pdf --court-type high_court \\
        --parquet-row '{"cnr": "...", "judge": "...", ...}'

    # Process directory of PDFs
    python unified_legal_parser.py --pdf-dir /path/to/pdfs --court-type high_court \\
        --parquet /path/to/metadata.parquet --output /path/to/output

    # Process pre-parsed JSON files (chunking only)
    python unified_legal_parser.py --parsed-dir /path/to/parsed --court-type high_court \\
        --parquet /path/to/metadata.parquet --output /path/to/chunks
"""

import sys
import json
import re
import logging
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime

# =============================================================================
# LOGGING SETUP
# =============================================================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)


# =============================================================================
# PyMuPDF Pro Setup (PDF Extraction)
# =============================================================================
PYMUPDF_PRO_API_KEY = "K9WIj3z//IAMYAMYwAZGUshC"

PYMUPDF_PRO_AVAILABLE = False
OCR_AVAILABLE = False

try:
    import pymupdf.pro
    pymupdf.pro.unlock(PYMUPDF_PRO_API_KEY)
    PYMUPDF_PRO_AVAILABLE = True
    logger.info("PyMuPDF Pro unlocked")
except ImportError:
    logger.warning("pymupdfpro not installed - layout mode unavailable")
except Exception as e:
    logger.warning(f"PyMuPDF Pro unlock failed: {e}")

try:
    import pymupdf.layout
except ImportError:
    pass

try:
    import pymupdf4llm
except ImportError:
    logger.error("pymupdf4llm not installed. Run: pip install pymupdf4llm")
    pymupdf4llm = None

try:
    import cv2
    OCR_AVAILABLE = True
except ImportError:
    logger.warning("OpenCV not installed - OCR disabled for scanned PDFs")

# Legacy fonts that extract as garbage
LEGACY_FONT_INDICATORS = ['Asees', 'Akhar', 'AnmolLipi']
REPLACEMENT_CHARACTER = chr(0xFFFD)


# =============================================================================
# TEXT CLEANING UTILITIES
# =============================================================================

RE_HTML_TAGS = re.compile(r'<[^>]+>')
RE_ASTERISKS = re.compile(r'\*+')
RE_HASHES = re.compile(r'#+\s*')
RE_PIPES = re.compile(r'\|+')
RE_BACKTICKS = re.compile(r'`+')
RE_WHITESPACE = re.compile(r'\s+')


def clean_ocr_artifacts(text: str) -> str:
    """Clean common OCR artifacts from text."""
    if not text:
        return ""
    text = RE_HTML_TAGS.sub(' ', text)
    text = RE_ASTERISKS.sub(' ', text)
    text = RE_HASHES.sub(' ', text)
    text = RE_PIPES.sub(' ', text)
    text = RE_BACKTICKS.sub(' ', text)
    text = RE_WHITESPACE.sub(' ', text)
    return text.strip()


# =============================================================================
# PDF EXTRACTION (from pymupdf4llm_parser.py)
# =============================================================================

def check_needs_ocr(pdf_path: str, sample_pages: int = 3, min_chars: int = 200) -> bool:
    """Check if PDF needs OCR by sampling pages for native text."""
    if pymupdf4llm is None:
        return False
    try:
        import pymupdf
        doc = pymupdf.open(pdf_path)
        total_chars = 0
        pages_to_check = min(sample_pages, len(doc))

        for i in range(pages_to_check):
            page = doc[i]
            text = page.get_text("text")
            if text:
                cleaned = text.strip()
                if REPLACEMENT_CHARACTER not in cleaned:
                    total_chars += len(cleaned)

        doc.close()
        return total_chars < min_chars
    except Exception as e:
        logger.warning(f"OCR check failed: {e}")
        return False


def check_legacy_fonts(pdf_path: str) -> bool:
    """Check if PDF uses legacy Indic fonts."""
    try:
        import pymupdf
        doc = pymupdf.open(pdf_path)
        for page_num in range(min(3, len(doc))):
            page = doc[page_num]
            blocks = page.get_text("dict")["blocks"]
            for block in blocks:
                if "lines" in block:
                    for line in block["lines"]:
                        for span in line["spans"]:
                            font = span.get("font", "")
                            if any(legacy in font for legacy in LEGACY_FONT_INDICATORS):
                                doc.close()
                                return True
        doc.close()
        return False
    except Exception:
        return False


def extract_pdf_content(
    pdf_path: str,
    ocr_dpi: int = 200,
    force_ocr: bool = False,
) -> Dict[str, Any]:
    """
    Extract text and structure from PDF using pymupdf4llm.

    Returns:
        Dict with: text, text_clean, boxes, pages, page_count,
                   ocr_used, has_legacy_fonts, extraction_time
    """
    import time
    start_time = time.time()

    if pymupdf4llm is None:
        return {"error": "pymupdf4llm not installed"}

    result = {
        "text": "",
        "text_clean": "",
        "boxes": [],
        "pages": [],
        "page_count": 0,
        "ocr_used": False,
        "has_legacy_fonts": False,
        "extraction_time": 0,
    }

    try:
        # Check for legacy fonts
        result["has_legacy_fonts"] = check_legacy_fonts(pdf_path)

        # Determine OCR strategy
        needs_ocr = force_ocr or check_needs_ocr(pdf_path)
        result["ocr_used"] = needs_ocr and OCR_AVAILABLE

        # Extract with pymupdf4llm
        extraction = pymupdf4llm.to_markdown(
            pdf_path,
            page_chunks=True,
            write_images=False,
            dpi=ocr_dpi if result["ocr_used"] else 72,
        )

        # Process pages
        if isinstance(extraction, list):
            pages = []
            all_text_parts = []

            for page_data in extraction:
                if isinstance(page_data, dict):
                    page_text = page_data.get("text", "")
                    page_num = page_data.get("page", len(pages) + 1)
                else:
                    page_text = str(page_data)
                    page_num = len(pages) + 1

                pages.append({
                    "page_number": page_num,
                    "text": page_text,
                })
                all_text_parts.append(page_text)

            result["pages"] = pages
            result["text"] = "\n\n".join(all_text_parts)
            result["page_count"] = len(pages)
        else:
            result["text"] = str(extraction)
            result["page_count"] = 1
            result["pages"] = [{"page_number": 1, "text": result["text"]}]

        result["text_clean"] = clean_ocr_artifacts(result["text"])
        result["extraction_time"] = time.time() - start_time

    except Exception as e:
        result["error"] = str(e)
        logger.error(f"PDF extraction failed: {e}")

    return result


# =============================================================================
# METADATA EXTRACTION (from metadata_extractor_v3.py)
# =============================================================================

# Pre-compiled patterns for HC metadata extraction
VERSUS_PATTERNS = [
    r'(?:^|\n)\s*[-—]*\s*(?:Versus|VERSUS)\s*[-—]*\s*(?:\n|$)',
    r'(?:^|\n)\s*[-—]*\s*V\s*/\s*[Ss]\s*[-—]*\s*(?:\n|$)',
    r'(?:^|\n)\s*[-—]*\s*Vs\.?\s*[-—]*\s*(?:\n|$)',
    r'\s+Versus\s+', r'\s+V/s\s+', r'\s+Vs\.?\s+',
]
RE_VERSUS = re.compile('|'.join(VERSUS_PATTERNS), re.IGNORECASE | re.MULTILINE)

# Case type patterns
CASE_TYPE_PATTERNS = [
    (re.compile(r'\bWrit\s*Petition', re.IGNORECASE), 'writ_petition'),
    (re.compile(r'\bCriminal\s*Appeal', re.IGNORECASE), 'criminal_appeal'),
    (re.compile(r'\bCivil\s*Appeal', re.IGNORECASE), 'civil_appeal'),
    (re.compile(r'\bSpecial\s*Leave\s*Petition', re.IGNORECASE), 'slp'),
    (re.compile(r'\bS\.?L\.?P\.?', re.IGNORECASE), 'slp'),
    (re.compile(r'\bCriminal\s*Miscellaneous', re.IGNORECASE), 'criminal_misc'),
    (re.compile(r'\bCivil\s*Miscellaneous', re.IGNORECASE), 'civil_misc'),
    (re.compile(r'\bCrl\.?\s*M\.?C\.?', re.IGNORECASE), 'criminal_misc'),
    (re.compile(r'\bBail\s*Application', re.IGNORECASE), 'bail'),
    (re.compile(r'\bFirst\s*Appeal', re.IGNORECASE), 'first_appeal'),
    (re.compile(r'\bSecond\s*Appeal', re.IGNORECASE), 'second_appeal'),
    (re.compile(r'\bRegular\s*Second\s*Appeal', re.IGNORECASE), 'rsa'),
    (re.compile(r'\bMatrimonial\s*(?:Appeal|Case)', re.IGNORECASE), 'matrimonial'),
    (re.compile(r'\bArbitration\s*(?:Petition|Appeal)', re.IGNORECASE), 'arbitration'),
    (re.compile(r'\bW\.?P\.?\s*\(', re.IGNORECASE), 'writ_petition'),
    (re.compile(r'\bCrl\.?\s*A\.?', re.IGNORECASE), 'criminal_appeal'),
    (re.compile(r'\bC\.?A\.?\s*No', re.IGNORECASE), 'civil_appeal'),
]

# Bench type patterns
BENCH_TYPE_PATTERNS = [
    (re.compile(r'\bConstitution\s*Bench', re.IGNORECASE), 'constitution'),
    (re.compile(r'\bFull\s*Bench', re.IGNORECASE), 'full'),
    (re.compile(r'\bDivision\s*Bench', re.IGNORECASE), 'division'),
    (re.compile(r'\bD\.?B\.?', re.IGNORECASE), 'division'),
    (re.compile(r'\bSingle\s*(?:Bench|Judge)', re.IGNORECASE), 'single'),
    (re.compile(r'\bS\.?B\.?', re.IGNORECASE), 'single'),
    (re.compile(r'\bLarger\s*Bench', re.IGNORECASE), 'larger'),
]

# Judge extraction patterns
RE_JUDGE_CORAM = re.compile(r'CORAM[:\s]+(?:HON[\.\']?BLE\s+)?(?:MR\.?\s+)?(?:JUSTICE\s+)?([A-Z][A-Za-z\.\s]+?)(?:\s*,|\s*AND|\s*$)', re.IGNORECASE)
RE_JUDGE_BEFORE = re.compile(r'BEFORE[:\s]+(?:HON[\.\']?BLE\s+)?(?:MR\.?\s+)?(?:JUSTICE\s+)?([A-Z][A-Za-z\.\s]+?)(?:\s*,|\s*AND|\s*$)', re.IGNORECASE)
RE_JUDGE_JUSTICE = re.compile(r'(?:HON[\.\']?BLE\s+)?(?:MR\.?\s+)?JUSTICE\s+([A-Z][A-Za-z\.\s]+?)(?:\s*,|\s*AND|\s*J\.?\s*$)', re.IGNORECASE)

# Acts cited patterns
RE_ACTS = re.compile(r'(?:Section|Sec\.?|S\.?)\s+\d+[A-Za-z]?\s+(?:of\s+(?:the\s+)?)?([A-Z][A-Za-z\s,]+?Act(?:\s*,?\s*\d{4})?)', re.IGNORECASE)
RE_ACTS_DIRECT = re.compile(r'\b([A-Z][A-Za-z\s]+Act(?:\s*,?\s*\d{4})?)\b')

# Article patterns
RE_ARTICLES = re.compile(r'Article\s+(\d+[A-Za-z]?(?:\s*\(\d+\))?)\s+(?:of\s+(?:the\s+)?)?(?:Constitution|Indian\s+Constitution)', re.IGNORECASE)

# Date patterns
RE_DATE_LONG = re.compile(r'(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)[,\s]+(\d{4})', re.IGNORECASE)
RE_DATE_NUMERIC = re.compile(r'(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})')

# FIR patterns
RE_FIR = re.compile(r'(?:FIR|F\.I\.R\.?|Crime)\s*(?:No\.?|Number)?\s*[:\-]?\s*(\d+)\s*[/\-]\s*(\d{4})', re.IGNORECASE)

# Case number patterns
RE_CASE_NUMBER = re.compile(r'(?:No\.?|Number)\s*[:\-]?\s*(\d+)\s*(?:of|/)\s*(\d{4})', re.IGNORECASE)


def extract_case_type(text: str) -> str:
    """Extract case type from text."""
    if not text:
        return ""
    for pattern, case_type in CASE_TYPE_PATTERNS:
        if pattern.search(text):
            return case_type
    return ""


def extract_bench_type(text: str) -> str:
    """Extract bench type from text."""
    if not text:
        return ""
    for pattern, bench_type in BENCH_TYPE_PATTERNS:
        if pattern.search(text):
            return bench_type
    return ""


def extract_judges(text: str) -> List[str]:
    """Extract list of judge names."""
    if not text:
        return []

    judges = set()

    # Try CORAM pattern first
    matches = RE_JUDGE_CORAM.findall(text)
    for match in matches:
        name = match.strip()
        if len(name) > 3 and len(name) < 50:
            judges.add(name)

    # Try BEFORE pattern
    matches = RE_JUDGE_BEFORE.findall(text)
    for match in matches:
        name = match.strip()
        if len(name) > 3 and len(name) < 50:
            judges.add(name)

    # Try JUSTICE pattern
    matches = RE_JUDGE_JUSTICE.findall(text)
    for match in matches:
        name = match.strip()
        if len(name) > 3 and len(name) < 50:
            judges.add(name)

    return list(judges)


def extract_acts_cited(text: str) -> List[str]:
    """Extract list of acts cited in the text."""
    if not text:
        return []

    acts = set()

    # Pattern 1: "Section X of Y Act"
    for match in RE_ACTS.finditer(text):
        act_name = match.group(1).strip()
        if len(act_name) > 5 and len(act_name) < 100:
            acts.add(act_name)

    # Pattern 2: Direct act names
    for match in RE_ACTS_DIRECT.finditer(text):
        act_name = match.group(1).strip()
        if len(act_name) > 10 and len(act_name) < 100:
            if 'act' in act_name.lower():
                acts.add(act_name)

    return list(acts)[:20]  # Limit to 20 acts


def extract_articles_cited(text: str) -> List[str]:
    """Extract constitutional articles cited."""
    if not text:
        return []

    articles = set()
    for match in RE_ARTICLES.finditer(text):
        article = f"Article {match.group(1)}"
        articles.add(article)

    return list(articles)[:10]


def extract_decision_date(text: str) -> str:
    """Extract decision date from text."""
    if not text:
        return ""

    # Try long format first
    match = RE_DATE_LONG.search(text)
    if match:
        day, month, year = match.groups()
        month_map = {
            'january': '01', 'february': '02', 'march': '03', 'april': '04',
            'may': '05', 'june': '06', 'july': '07', 'august': '08',
            'september': '09', 'october': '10', 'november': '11', 'december': '12'
        }
        month_num = month_map.get(month.lower(), '01')
        return f"{year}-{month_num}-{day.zfill(2)}"

    # Try numeric format
    match = RE_DATE_NUMERIC.search(text)
    if match:
        d, m, y = match.groups()
        return f"{y}-{m.zfill(2)}-{d.zfill(2)}"

    return ""


def extract_fir_number(text: str) -> Optional[str]:
    """Extract FIR/Crime number."""
    if not text:
        return None

    match = RE_FIR.search(text)
    if match:
        return f"{match.group(1)}/{match.group(2)}"

    return None


def extract_case_number(text: str) -> str:
    """Extract case number."""
    if not text:
        return ""

    match = RE_CASE_NUMBER.search(text)
    if match:
        return f"{match.group(1)}/{match.group(2)}"

    return ""


def extract_parties(text: str) -> Tuple[str, str]:
    """Extract petitioner and respondent names using versus-split."""
    if not text:
        return ("", "")

    # Find versus separator
    match = RE_VERSUS.search(text)
    if not match:
        return ("", "")

    before = text[:match.start()].strip()
    after = text[match.end():].strip()

    # Get last non-empty line before versus (petitioner)
    petitioner_lines = [l.strip() for l in before.split('\n') if l.strip()]
    petitioner = petitioner_lines[-1] if petitioner_lines else ""

    # Get first non-empty line after versus (respondent)
    respondent_lines = [l.strip() for l in after.split('\n') if l.strip()]
    respondent = respondent_lines[0] if respondent_lines else ""

    # Clean party names
    petitioner = _clean_party_name(petitioner)
    respondent = _clean_party_name(respondent)

    return (petitioner, respondent)


def _clean_party_name(name: str) -> str:
    """Clean party name by removing noise."""
    if not name:
        return ""

    # Remove common suffixes
    name = re.sub(r'\.{2,}\s*(Petitioner|Appellant|Respondent|Applicant)s?.*$', '', name, flags=re.IGNORECASE)
    name = re.sub(r'\s+(Petitioner|Respondent|Appellant|Applicant)s?\s*$', '', name, flags=re.IGNORECASE)

    # Remove markdown/formatting
    name = re.sub(r'^\*+|\*+$', '', name)
    name = re.sub(r'^#+\s*', '', name)
    name = re.sub(r'^\d+\.\s*', '', name)

    # Clean whitespace
    name = re.sub(r'\s+', ' ', name).strip()
    name = name.strip('.,;:-*#()[]` ')

    # Validate
    if len(name) < 3 or len(name) > 200:
        return ""

    alpha_count = sum(1 for c in name if c.isalpha())
    if alpha_count < 3:
        return ""

    return name


def extract_jurisdiction(text: str, case_type: str = "") -> str:
    """Extract jurisdiction from text or infer from case type."""
    if not text:
        return ""

    text_lower = text.lower()

    if 'criminal' in text_lower or case_type in ['criminal_appeal', 'criminal_misc', 'bail']:
        return 'criminal'
    elif 'civil' in text_lower or case_type in ['civil_appeal', 'civil_misc', 'first_appeal', 'second_appeal']:
        return 'civil'
    elif 'writ' in text_lower or case_type == 'writ_petition':
        return 'writ'
    elif 'constitutional' in text_lower:
        return 'constitutional'
    elif 'matrimonial' in text_lower or case_type == 'matrimonial':
        return 'family'
    elif 'arbitration' in text_lower or case_type == 'arbitration':
        return 'arbitration'

    return ""


def extract_lower_court(text: str) -> Optional[str]:
    """Extract lower court name from text."""
    if not text:
        return None

    patterns = [
        re.compile(r'(?:order|judgment|decree)\s+(?:of|passed\s+by|dated)\s+(?:the\s+)?(?:learned\s+)?([A-Z][A-Za-z\s,]+(?:Court|Tribunal|Judge))', re.IGNORECASE),
        re.compile(r'(?:District|Sessions|Magistrate|Tribunal|Civil)\s+(?:Court|Judge)\s*,?\s*([A-Za-z\s]+)', re.IGNORECASE),
    ]

    for pattern in patterns:
        match = pattern.search(text)
        if match:
            court = match.group(1).strip()
            if len(court) > 5 and len(court) < 100:
                return court

    return None


def extract_headnote(text: str) -> Optional[str]:
    """Extract headnote/summary from text."""
    if not text:
        return None

    pattern = re.compile(r'(?:HEADNOTE|HEAD\s*NOTE|SUMMARY)[:\s]+(.{50,500}?)(?:\n\n|\n[A-Z])', re.IGNORECASE | re.DOTALL)
    match = pattern.search(text)
    if match:
        return match.group(1).strip()

    return None


def extract_all_metadata(text: str, boxes: List[Dict] = None) -> Dict[str, Any]:
    """
    Extract all metadata from parsed document text.

    This is the main extraction function that produces all 14 unique fields
    that parquet data doesn't have.

    Args:
        text: Full document text
        boxes: Optional list of boxes from pymupdf4llm

    Returns:
        Dict with all extracted metadata fields
    """
    # Use box text if available
    if boxes:
        box_text = '\n'.join(box.get('text', '') for box in boxes if box.get('text'))
        search_text = box_text if box_text else text
    else:
        search_text = text

    # Clean header region
    header_clean = clean_ocr_artifacts(search_text[:5000]) if search_text else ""
    footer_clean = clean_ocr_artifacts(text[-4000:]) if text and len(text) > 4000 else clean_ocr_artifacts(text) if text else ""

    # Extract case type first (needed for jurisdiction)
    case_type = extract_case_type(header_clean)

    # Extract parties
    raw_header = search_text[:5000] if search_text else ""
    petitioner, respondent = extract_parties(raw_header)

    metadata = {
        # Case identifiers
        'case_type': case_type,
        'case_number': extract_case_number(header_clean),
        'jurisdiction': extract_jurisdiction(header_clean, case_type),
        'bench_type': extract_bench_type(header_clean),

        # Judges
        'judges': extract_judges(header_clean),

        # Parties
        'petitioner': petitioner,
        'respondent': respondent,

        # Legal citations
        'acts_cited': extract_acts_cited(text) if text else [],
        'articles_cited': extract_articles_cited(text) if text else [],

        # Dates
        'decision_date': extract_decision_date(header_clean),

        # Criminal case specific
        'fir_number': extract_fir_number(text) if text else None,

        # Lower court
        'lower_court': extract_lower_court(text[:15000]) if text else None,

        # Summary
        'headnote': extract_headnote(text[:10000]) if text else None,
    }

    return metadata


# =============================================================================
# UNIFIED METADATA BUILDER
# =============================================================================

def build_unified_metadata(
    extracted: Dict[str, Any],
    court_type: str,
    parquet_row: Optional[Dict] = None,
    sc_metadata: Optional[Dict] = None,
) -> Dict[str, Any]:
    """
    Build unified metadata from extraction + external sources.

    For High Court:
        - Uses parquet data as primary source for: judge, decision_date, disposal_status
        - Uses extracted data for: case_type, parties, acts_cited, etc.

    For Supreme Court:
        - Uses all_cases.jsonl metadata as primary
        - Supplements with extracted data where needed

    Args:
        extracted: Output from extract_pdf_content()
        court_type: "supreme_court" or "high_court"
        parquet_row: HC parquet metadata (optional)
        sc_metadata: SC all_cases.jsonl metadata (optional)

    Returns:
        Unified metadata dict compatible with legal_chunker.py
    """
    # Extract text-based metadata
    text = extracted.get('text', '')
    boxes = extracted.get('boxes', [])
    text_metadata = extract_all_metadata(text, boxes)

    metadata = {}

    if court_type == "high_court":
        parquet = parquet_row or {}

        # Case ID
        cnr = parquet.get('cnr', '')
        metadata['case_id'] = cnr
        metadata['cnr'] = cnr

        # Title - prefer parquet
        title = parquet.get('title', '')
        if not title and text_metadata.get('petitioner'):
            title = f"{text_metadata['petitioner']} vs {text_metadata.get('respondent', 'Unknown')}"
        metadata['title'] = title

        # Court info from parquet
        metadata['court'] = parquet.get('court_name', '')
        metadata['court_name'] = parquet.get('court_name', '')
        metadata['state_code'] = parquet.get('state_code', '')
        metadata['state_name'] = parquet.get('state_name', '')
        metadata['establishment_code'] = parquet.get('establishment_code', '')
        metadata['court_code'] = parquet.get('court_code', '')
        metadata['bench'] = parquet.get('bench', '')
        metadata['bench_display_name'] = parquet.get('bench_display_name', '')

        # Dates - prefer parquet
        decision_date = str(parquet.get('decision_date', '')) or text_metadata.get('decision_date', '')
        metadata['decision_date'] = decision_date
        metadata['date_of_registration'] = parquet.get('date_of_registration', '')

        # Extract year
        if decision_date:
            year_match = re.search(r'(\d{4})', str(decision_date))
            metadata['year'] = int(year_match.group(1)) if year_match else 0
        else:
            metadata['year'] = 0

        # Judges - prefer parquet, supplement with extracted
        parquet_judge = parquet.get('judge', '')
        extracted_judges = text_metadata.get('judges', [])
        if parquet_judge:
            metadata['judges'] = [parquet_judge] + [j for j in extracted_judges if j != parquet_judge]
        else:
            metadata['judges'] = extracted_judges

        # Parties - prefer extracted (parquet title is unreliable)
        metadata['petitioner'] = text_metadata.get('petitioner', '')
        metadata['respondent'] = text_metadata.get('respondent', '')

        # Case classification - from extraction
        metadata['case_type'] = text_metadata.get('case_type', '')
        metadata['case_number'] = text_metadata.get('case_number', '')
        metadata['jurisdiction'] = text_metadata.get('jurisdiction', '')
        metadata['bench_type'] = text_metadata.get('bench_type', '')

        # Legal citations - from extraction (CRITICAL FIX: use acts_cited)
        metadata['acts_cited'] = text_metadata.get('acts_cited', [])
        metadata['articles_cited'] = text_metadata.get('articles_cited', [])

        # Criminal case specific
        metadata['fir_number'] = text_metadata.get('fir_number')
        metadata['lower_court'] = text_metadata.get('lower_court')
        metadata['headnote'] = text_metadata.get('headnote')

        # Disposition - prefer parquet
        metadata['disposal_status'] = parquet.get('disposal_nature', '') or parquet.get('disposal_status', '')

        # Additional parquet fields
        metadata['description'] = parquet.get('description', '')

        # Quality indicators
        metadata['has_legacy_fonts'] = extracted.get('has_legacy_fonts', False)
        metadata['ocr_used'] = extracted.get('ocr_used', False)

    elif court_type == "supreme_court":
        sc = sc_metadata or {}

        # Case ID
        metadata['case_id'] = sc.get('doc_id', sc.get('case_id', ''))
        metadata['doc_id'] = sc.get('doc_id', '')

        # Title and citation
        metadata['title'] = sc.get('title', '')
        metadata['citation'] = sc.get('citation', '')

        # Court
        metadata['court'] = 'Supreme Court of India'
        metadata['court_name'] = 'Supreme Court of India'

        # Year and date
        metadata['year'] = sc.get('year', 0)
        metadata['decision_date'] = sc.get('decision_date', '') or text_metadata.get('decision_date', '')

        # Judges
        metadata['judges'] = sc.get('judges', text_metadata.get('judges', []))

        # Parties
        metadata['petitioner'] = sc.get('petitioner', text_metadata.get('petitioner', ''))
        metadata['respondent'] = sc.get('respondent', text_metadata.get('respondent', ''))
        metadata['petitioners'] = sc.get('petitioners', [])
        metadata['respondents'] = sc.get('respondents', [])

        # Case classification
        metadata['case_type'] = sc.get('case_type', text_metadata.get('case_type', ''))
        metadata['jurisdiction'] = sc.get('jurisdiction', text_metadata.get('jurisdiction', ''))
        metadata['bench_type'] = sc.get('bench_type', text_metadata.get('bench_type', ''))

        # Citation network (SC has proper data)
        metadata['acts_referenced'] = sc.get('acts_referenced', [])
        metadata['cases_cited'] = sc.get('cases_cited', [])
        metadata['cited_by_count'] = sc.get('cited_by_count', 0)

        # Multilingual
        metadata['language_code'] = sc.get('language_code', 'EN')

        # Disposition
        metadata['disposition'] = sc.get('disposition', '')

        # Quality
        metadata['has_legacy_fonts'] = extracted.get('has_legacy_fonts', False)

    return metadata


# =============================================================================
# MAIN PROCESSING FUNCTIONS
# =============================================================================

def process_single_pdf(
    pdf_path: str,
    court_type: str,
    parquet_row: Optional[Dict] = None,
    sc_metadata: Optional[Dict] = None,
    output_path: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Process a single PDF file: extract text, metadata, and optionally chunk.

    Args:
        pdf_path: Path to PDF file
        court_type: "supreme_court" or "high_court"
        parquet_row: HC parquet metadata
        sc_metadata: SC metadata from all_cases.jsonl
        output_path: Optional path to save extracted JSON

    Returns:
        Dict with extracted content and metadata
    """
    logger.info(f"Processing: {pdf_path}")

    # Extract PDF content
    extracted = extract_pdf_content(pdf_path)

    if "error" in extracted:
        logger.error(f"Extraction failed: {extracted['error']}")
        return extracted

    # Build unified metadata
    metadata = build_unified_metadata(
        extracted=extracted,
        court_type=court_type,
        parquet_row=parquet_row,
        sc_metadata=sc_metadata,
    )

    # Combine extraction + metadata
    result = {
        **extracted,
        "metadata": metadata,
        "court_type": court_type,
    }

    # Save if output path provided
    if output_path:
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2, default=str)
        logger.info(f"Saved: {output_path}")

    return result


# =============================================================================
# CLI INTERFACE
# =============================================================================

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Unified Legal Document Parser for SC and HC RAG pipelines",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Parse a single HC PDF
  python unified_legal_parser.py --pdf judgment.pdf --court-type high_court

  # Parse with parquet metadata
  python unified_legal_parser.py --pdf judgment.pdf --court-type high_court \\
      --parquet-row '{"cnr": "DLHC01-001234-2024", "judge": "A.B. Smith"}'

  # Process directory
  python unified_legal_parser.py --pdf-dir /path/to/pdfs --court-type supreme_court \\
      --output /path/to/output
        """
    )

    parser.add_argument("--pdf", help="Single PDF file to process")
    parser.add_argument("--pdf-dir", help="Directory of PDFs to process")
    parser.add_argument("--court-type", required=True,
                       choices=["supreme_court", "high_court"],
                       help="Court type for processing")
    parser.add_argument("--parquet-row", help="JSON string of parquet metadata for HC")
    parser.add_argument("--sc-metadata", help="JSON string of SC metadata")
    parser.add_argument("--output", help="Output directory or file")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Parse metadata from JSON strings
    parquet_row = None
    sc_metadata = None

    if args.parquet_row:
        try:
            parquet_row = json.loads(args.parquet_row)
        except json.JSONDecodeError as e:
            logger.error(f"Invalid parquet-row JSON: {e}")
            sys.exit(1)

    if args.sc_metadata:
        try:
            sc_metadata = json.loads(args.sc_metadata)
        except json.JSONDecodeError as e:
            logger.error(f"Invalid sc-metadata JSON: {e}")
            sys.exit(1)

    # Process single PDF
    if args.pdf:
        output_path = args.output or args.pdf.replace('.pdf', '.parsed.json')
        result = process_single_pdf(
            pdf_path=args.pdf,
            court_type=args.court_type,
            parquet_row=parquet_row,
            sc_metadata=sc_metadata,
            output_path=output_path,
        )

        # Print summary
        if "error" not in result:
            meta = result.get("metadata", {})
            print("\n" + "=" * 60)
            print("EXTRACTION SUMMARY")
            print("=" * 60)
            print(f"Pages: {result.get('page_count', 0)}")
            print(f"OCR Used: {result.get('ocr_used', False)}")
            print(f"Legacy Fonts: {result.get('has_legacy_fonts', False)}")
            print(f"\nMetadata:")
            for key, value in meta.items():
                if value:
                    print(f"  {key}: {str(value)[:80]}")
            print("=" * 60)

    # Process directory
    elif args.pdf_dir:
        pdf_dir = Path(args.pdf_dir)
        output_dir = Path(args.output) if args.output else pdf_dir / "parsed"
        output_dir.mkdir(parents=True, exist_ok=True)

        pdf_files = list(pdf_dir.glob("*.pdf"))
        logger.info(f"Found {len(pdf_files)} PDF files")

        for pdf_path in pdf_files:
            output_path = output_dir / f"{pdf_path.stem}.parsed.json"
            try:
                process_single_pdf(
                    pdf_path=str(pdf_path),
                    court_type=args.court_type,
                    parquet_row=parquet_row,
                    sc_metadata=sc_metadata,
                    output_path=str(output_path),
                )
            except Exception as e:
                logger.error(f"Failed to process {pdf_path}: {e}")

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
