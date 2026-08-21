"""
Clean raw PDF-extracted text for IndiaCode legislation.

Handles:
- Page header / footer removal (repeated text across pages)
- Watermark removal
- Unicode normalisation
- Whitespace normalisation
- "Digitally signed" block removal
"""

import re
import unicodedata
from collections import Counter

from config import UNICODE_REPLACEMENTS, PAGE_HEADER_THRESHOLD


# Precompiled
_RE_DIGITAL_SIG = re.compile(
    r"Digitally\s+signed\s+by.*?(?=\n\n|\Z)", re.DOTALL | re.IGNORECASE
)
_RE_WATERMARK = re.compile(
    r"(?:www\.)?indiacode\.nic\.in|indiacode", re.IGNORECASE
)
_RE_PAGE_NUMBER = re.compile(r"^\s*-?\s*\d{1,4}\s*-?\s*$", re.MULTILINE)
_RE_MULTI_SPACE = re.compile(r"[ \t]{2,}")
_RE_MULTI_NEWLINE = re.compile(r"\n{3,}")
_RE_TRAILING_WS = re.compile(r"[ \t]+$", re.MULTILINE)

# Markdown stripping patterns (pymupdf4llm output)
_RE_MD_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_RE_MD_ITALIC = re.compile(r"_([^_]+)_")
_RE_MD_HEADING = re.compile(r"^#{1,6}\s+", re.MULTILINE)
_RE_MD_BLOCKQUOTE = re.compile(r"^>\s*", re.MULTILINE)
_RE_MD_HRULE = re.compile(r"^[-_]{3,}\s*$", re.MULTILINE)
_RE_FOOTNOTE_MARKER = re.compile(r"\[(\d{1,3})\]")
_RE_FOOTNOTE_PREFIX = re.compile(r"^\d{1,3}\[", re.MULTILINE)


def _normalise_unicode(text: str) -> str:
    """NFC normalise and replace common problematic characters."""
    text = unicodedata.normalize("NFC", text)
    for old, new in UNICODE_REPLACEMENTS.items():
        text = text.replace(old, new)
    # Remove remaining control characters (except \n, \t)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    return text


def _detect_page_headers_footers(pages: list[dict]) -> set[str]:
    """
    Detect repeated text that appears on many pages at the same position.
    Returns a set of strings to remove.
    """
    if len(pages) < 3:
        return set()

    # Check first and last 2 lines of each page
    first_lines: list[str] = []
    last_lines: list[str] = []

    for page in pages:
        text = page.get("text", "").strip()
        lines = text.split("\n")
        lines = [l.strip() for l in lines if l.strip()]
        if lines:
            first_lines.extend(lines[:2])
            last_lines.extend(lines[-2:])

    threshold = int(len(pages) * PAGE_HEADER_THRESHOLD)
    repeated: set[str] = set()

    for line, count in Counter(first_lines).items():
        if count >= threshold and len(line) > 3:
            repeated.add(line)

    for line, count in Counter(last_lines).items():
        if count >= threshold and len(line) > 3:
            repeated.add(line)

    return repeated


def clean_pdf_text(
    full_text: str,
    pages: list[dict] | None = None,
) -> str:
    """
    Clean raw PyMuPDF4LLM extracted text.

    Args:
        full_text: The full extracted text from the PDF.
        pages: Optional list of page dicts with 'text' field,
               used for header/footer detection.

    Returns:
        Cleaned text suitable for chunking and R2 upload.
    """
    text = full_text

    # 1. Unicode normalisation
    text = _normalise_unicode(text)

    # 2. Remove "Digitally signed by …" blocks
    text = _RE_DIGITAL_SIG.sub("", text)

    # 3. Remove watermarks
    text = _RE_WATERMARK.sub("", text)

    # 4. Remove detected page headers / footers
    if pages:
        repeated = _detect_page_headers_footers(pages)
        for header in repeated:
            text = text.replace(header, "")

    # 5. Remove standalone page numbers
    text = _RE_PAGE_NUMBER.sub("", text)

    # 7. Normalise whitespace
    text = _RE_MULTI_SPACE.sub(" ", text)
    text = _RE_TRAILING_WS.sub("", text)
    text = _RE_MULTI_NEWLINE.sub("\n\n", text)

    # 7. Strip leading/trailing
    text = text.strip()

    return text


def build_page_char_map(pages: list[dict]) -> list[dict]:
    """
    Build a list of page dicts with cumulative character offsets.

    Each entry: {
        page_number: int (1-indexed),
        char_start: int,
        char_end: int,
        char_count: int,
    }

    Used for mapping char positions to page numbers.
    """
    page_map: list[dict] = []
    cumulative = 0

    for page in pages:
        char_count = len(page.get("text", ""))
        page_map.append({
            "page_number": page.get("page_number", len(page_map) + 1),
            "char_start": cumulative,
            "char_end": cumulative + char_count,
            "char_count": char_count,
        })
        cumulative += char_count + 1  # +1 for page separator

    return page_map


def find_page_for_char(char_pos: int, page_map: list[dict]) -> int:
    """Binary search to find which page a character position falls on."""
    if not page_map:
        return 1

    lo, hi = 0, len(page_map) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        pm = page_map[mid]
        if char_pos < pm["char_start"]:
            hi = mid - 1
        elif char_pos >= pm["char_end"]:
            lo = mid + 1
        else:
            return pm["page_number"]

    # Fallback: return last page
    return page_map[-1]["page_number"]
