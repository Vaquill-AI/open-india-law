"""
Convert IndiaCode HTML section content to clean plain text.

Handles:
- Stripping HTML tags while preserving structure
- Converting footnote markers <sup>N</sup> → [N]
- Converting <br> / <hr> to newlines
- HTML entity decoding
- Footnote text appending
"""

import html
import re


# Precompiled patterns
_RE_BR = re.compile(r"<br\s*/?>", re.IGNORECASE)
_RE_HR = re.compile(r"<hr[^>]*>", re.IGNORECASE)
_RE_SUP = re.compile(r"<sup[^>]*>\s*(\d+)\s*</sup>", re.IGNORECASE)
_RE_STYLE_SPAN = re.compile(
    r'<span\s+style="margin-left:\d+px;">\s*</span>', re.IGNORECASE
)
_RE_TAGS = re.compile(r"<[^>]+>")
_RE_MULTI_NEWLINE = re.compile(r"\n{3,}")
_RE_TRAILING_WS = re.compile(r"[ \t]+$", re.MULTILINE)
_RE_LEADING_WS = re.compile(r"^[ \t]+", re.MULTILINE)


def clean_html_content(raw_html: str) -> str:
    """Convert an IndiaCode HTML section body to clean plain text."""
    if not raw_html:
        return ""

    text = raw_html

    # 1. Convert <br> → newline
    text = _RE_BR.sub("\n", text)

    # 2. Convert <hr> → paragraph break
    text = _RE_HR.sub("\n\n", text)

    # 3. Convert footnote markers <sup>N</sup> → [N]
    text = _RE_SUP.sub(r"[\1]", text)

    # 4. Remove empty margin spans (IndiaCode indentation artifacts)
    text = _RE_STYLE_SPAN.sub("", text)

    # 5. Strip remaining HTML tags
    text = _RE_TAGS.sub("", text)

    # 6. Decode HTML entities
    text = html.unescape(text)

    # 7. Normalise line endings (\r\n → \n)
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    # 8. Normalise whitespace
    text = _RE_TRAILING_WS.sub("", text)
    text = _RE_MULTI_NEWLINE.sub("\n\n", text)
    text = text.strip()

    return text


def clean_footnote(raw_html: str) -> str:
    """Clean a footnote HTML blob to plain text."""
    if not raw_html:
        return ""
    text = _RE_BR.sub("\n", raw_html)
    text = _RE_HR.sub("\n", text)
    text = _RE_TAGS.sub("", text)
    text = html.unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _RE_TRAILING_WS.sub("", text)
    text = text.strip()
    return text


def sections_to_plain_text(sections: list[dict]) -> str:
    """
    Convert a list of IndiaCode HTML section dicts into a single
    concatenated plain-text document.

    Each section dict has: sectionNo, label, content, footnote (optional).

    Returns the full clean text with section headings.
    """
    parts: list[str] = []

    for sec in sections:
        sec_no = sec.get("sectionNo", "").strip()
        label = sec.get("label", "").strip()
        content = clean_html_content(sec.get("content", ""))
        footnote_raw = sec.get("footnote", "")

        # Build section header
        if sec_no and label:
            header = f"{sec_no}. {label}"
        elif sec_no:
            header = f"{sec_no}."
        elif label:
            header = label
        else:
            header = ""

        # Build section body
        body_parts: list[str] = []
        if header:
            body_parts.append(header)
        if content:
            body_parts.append(content)

        # Append footnotes
        if footnote_raw:
            fn_text = clean_footnote(footnote_raw)
            if fn_text:
                body_parts.append(f"\n[Footnotes]\n{fn_text}")

        if body_parts:
            parts.append("\n".join(body_parts))

    return "\n\n".join(parts)


def section_to_clean_text(section: dict) -> str:
    """
    Convert a single section dict to clean text (for per-section chunking).
    """
    sec_no = section.get("sectionNo", "").strip()
    label = section.get("label", "").strip()
    content = clean_html_content(section.get("content", ""))
    footnote_raw = section.get("footnote", "")

    parts: list[str] = []
    if sec_no and label:
        parts.append(f"{sec_no}. {label}")
    elif sec_no:
        parts.append(f"{sec_no}.")
    elif label:
        parts.append(label)

    if content:
        parts.append(content)

    if footnote_raw:
        fn_text = clean_footnote(footnote_raw)
        if fn_text:
            parts.append(f"\n[Footnotes]\n{fn_text}")

    return "\n".join(parts)
