"""
Detect structural boundaries in Indian legislation text.

Identifies:
- Chapter / Part headings
- Section numbers and titles (Arabic: 1., 2., 3A.)
- Roman numeral sections for old acts (I., II., III.)
- Article numbers (Constitution)
- Schedule headings
- Preamble
- Sub-section boundaries for provision-level splitting

Returns an ordered list of detected boundaries with positions.
"""

import re
from dataclasses import dataclass

from config import (
    RE_CHAPTER,
    RE_PART,
    RE_SECTION,
    RE_ARTICLE,
    RE_SCHEDULE,
    RE_PREAMBLE,
    RE_REPEALED_SECTION,
    RE_ROMAN_SECTION,
    RE_SUB_SECTION,
    RE_CLAUSE,
    SECTION_PRIORITIES,
    MIN_CHUNK_SIZE,
    CHUNK_SIZE,
)


@dataclass
class SectionBoundary:
    """A detected structural boundary in legislation text."""
    section_type: str           # section, definitions, chapter_heading, schedule, etc.
    section_number: str         # "42", "3A", "IV" (chapter), etc.
    section_title: str          # "Hunting prohibited" or chapter title
    char_start: int             # start position in full text
    char_end: int               # end position (set during grouping)
    priority: int = 30
    chapter: str = ""           # current chapter number
    chapter_title: str = ""     # current chapter title
    part: str = ""              # current part number
    part_title: str = ""        # current part title
    is_repealed: bool = False
    sub_section: str = ""       # "(1)", "(a)" for sub-section chunks
    parent_section: str = ""    # parent section number when this is a sub-section


def detect_sections(text: str) -> list[SectionBoundary]:
    """
    Scan legislation text and return an ordered list of section boundaries.
    """
    boundaries: list[SectionBoundary] = []

    # --- Detect preamble ---
    for m in RE_PREAMBLE.finditer(text):
        boundaries.append(SectionBoundary(
            section_type="preamble",
            section_number="",
            section_title="Preamble",
            char_start=m.start(),
            char_end=0,
            priority=SECTION_PRIORITIES["preamble"],
        ))
        break

    # --- Detect chapters ---
    for m in RE_CHAPTER.finditer(text):
        title = _extract_heading_title(text, m.end())
        boundaries.append(SectionBoundary(
            section_type="chapter_heading",
            section_number=m.group(1),
            section_title=title,
            char_start=m.start(),
            char_end=0,
            priority=SECTION_PRIORITIES["chapter_heading"],
        ))

    # --- Detect parts ---
    for m in RE_PART.finditer(text):
        title = _extract_heading_title(text, m.end())
        boundaries.append(SectionBoundary(
            section_type="part_heading",
            section_number=m.group(1),
            section_title=title,
            char_start=m.start(),
            char_end=0,
            priority=SECTION_PRIORITIES["part_heading"],
        ))

    # --- Find the "Arrangement of Sections" TOC block to skip ---
    # TOC entries look like section matches but aren't actual sections.
    # The TOC ends at the preamble or "An Act to..." or the act title repeated.
    toc_end = 0
    toc_match = re.search(
        r"ARRANGEMENT\s+OF\s+SECTIONS", text, re.IGNORECASE
    )
    if toc_match:
        # TOC ends at the preamble, or "An Act to", or actual section 1 with body text
        body_start = re.search(
            r"(?:An\s+Act\s+to|Be\s+it\s+enacted|Preamble|PREAMBLE|ACT\s+NO\.\s+\d+)",
            text[toc_match.end():],
            re.IGNORECASE,
        )
        if body_start:
            toc_end = toc_match.end() + body_start.start()
        else:
            # Fallback: TOC is typically first 20% of text
            toc_end = min(toc_match.end() + 3000, len(text) // 5)

    # --- Detect Arabic numeral sections (modern acts) ---
    for m in RE_SECTION.finditer(text):
        # Skip matches inside the Arrangement of Sections TOC
        if toc_end > 0 and m.start() < toc_end:
            continue

        # Skip footnote lines that look like section numbers.
        # Footnotes: "> 1. Subs. by Act...", "> 2. The words...", "> 3. Ins. by..."
        # Real sections: "**1. Short title.**", "> 6[ **2. Interpretation clause.—**"
        line_start = text.rfind("\n", 0, m.start()) + 1
        line_end = text.find("\n", m.start())
        if line_end == -1:
            line_end = len(text)
        line = text[line_start:line_end].strip()

        # Footnote heuristics — skip if line matches any of these
        _is_footnote = bool(
            # "> N. Subs./Ins./Rep./Omitted/Added/The words/Cl./See/S."
            re.match(
                r"^>\s*\d{1,3}\.\s*(?:Subs|Ins|Rep|Omitted|Added|"
                r"The\s+words|The\s+figures|The\s+brackets|"
                r"Cl\.|S\.\s|See\s|Renumbered|Now\s|Clause|"
                r"Sub-section|Cf\.|This\s+Act|The\s+proviso|"
                r"Section\s+\d)",
                line,
                re.IGNORECASE,
            )
            # "N. Subs. by / Ins. by" without blockquote
            or re.match(
                r"^\d{1,3}\.\s+(?:Subs|Ins|Rep|Omitted|Added|"
                r"The\s+words|The\s+figures|Cl\.|S\.\s|See\s|"
                r"Renumbered|Now\s|Clause|Sub-section|Cf\.)",
                line,
                re.IGNORECASE,
            )
        )
        if _is_footnote:
            continue

        sec_num = m.group(1)
        title = _extract_section_title(text, m.end())
        sec_type = _classify_section(sec_num, title, text[m.start():m.start() + 500])
        boundaries.append(SectionBoundary(
            section_type=sec_type,
            section_number=sec_num,
            section_title=title,
            char_start=m.start(),
            char_end=0,
            priority=SECTION_PRIORITIES.get(sec_type, 80),
        ))

    # --- Detect Roman numeral sections (old acts: I., II., III.) ---
    # Only use if no Arabic sections were found (avoids false positives)
    arabic_found = any(b.section_type in ("section", "definitions", "short_title")
                       for b in boundaries)
    if not arabic_found:
        for m in RE_ROMAN_SECTION.finditer(text):
            roman = m.group(1)
            if not _is_valid_roman(roman):
                continue
            title = _extract_section_title(text, m.end())
            boundaries.append(SectionBoundary(
                section_type="section",
                section_number=roman,
                section_title=title,
                char_start=m.start(),
                char_end=0,
                priority=SECTION_PRIORITIES["section"],
            ))

    # --- Detect articles (Constitution) ---
    for m in RE_ARTICLE.finditer(text):
        title = _extract_section_title(text, m.end())
        boundaries.append(SectionBoundary(
            section_type="article",
            section_number=m.group(1),
            section_title=title,
            char_start=m.start(),
            char_end=0,
            priority=SECTION_PRIORITIES["article"],
        ))

    # --- Detect schedules ---
    for m in RE_SCHEDULE.finditer(text):
        title = _extract_heading_title(text, m.end())
        boundaries.append(SectionBoundary(
            section_type="schedule",
            section_number=_extract_schedule_number(m.group(0)),
            section_title=title if title else m.group(0).strip(),
            char_start=m.start(),
            char_end=0,
            priority=SECTION_PRIORITIES["schedule"],
        ))

    # Sort by position
    boundaries.sort(key=lambda b: b.char_start)
    boundaries = _deduplicate(boundaries)

    # Set char_end
    for i, b in enumerate(boundaries):
        b.char_end = boundaries[i + 1].char_start if i + 1 < len(boundaries) else len(text)

    # Track chapter / part context
    current_chapter = ""
    current_chapter_title = ""
    current_part = ""
    current_part_title = ""

    for b in boundaries:
        if b.section_type == "chapter_heading":
            current_chapter = b.section_number
            current_chapter_title = b.section_title
        elif b.section_type == "part_heading":
            current_part = b.section_number
            current_part_title = b.section_title
        b.chapter = current_chapter
        b.chapter_title = current_chapter_title
        b.part = current_part
        b.part_title = current_part_title

    # Detect repealed sections
    for b in boundaries:
        section_text = text[b.char_start:b.char_end].strip()
        if len(section_text) < 300 and RE_REPEALED_SECTION.search(section_text):
            b.is_repealed = True

    # Fallback: if nothing detected, single "body"
    if not boundaries:
        boundaries = [SectionBoundary(
            section_type="body",
            section_number="",
            section_title="",
            char_start=0,
            char_end=len(text),
            priority=SECTION_PRIORITIES["body"],
        )]

    return boundaries


def merge_small_sections(
    boundaries: list[SectionBoundary],
    text: str,
    min_size: int = MIN_CHUNK_SIZE,
) -> list[SectionBoundary]:
    """
    Merge sections smaller than min_size into adjacent sections.
    Chapter/part headings always merge forward.
    """
    if len(boundaries) <= 1:
        return boundaries

    merged: list[SectionBoundary] = []
    pending: SectionBoundary | None = None

    for b in boundaries:
        section_len = b.char_end - b.char_start

        if b.section_type in ("chapter_heading", "part_heading"):
            pending = b
            continue

        if pending is not None:
            b = SectionBoundary(
                section_type=b.section_type,
                section_number=b.section_number,
                section_title=b.section_title,
                char_start=pending.char_start,
                char_end=b.char_end,
                priority=b.priority,
                chapter=b.chapter,
                chapter_title=b.chapter_title or pending.section_title,
                part=b.part,
                part_title=b.part_title or pending.section_title,
                is_repealed=b.is_repealed,
            )
            pending = None

        if section_len < min_size and merged:
            prev = merged[-1]
            merged[-1] = SectionBoundary(
                section_type=prev.section_type,
                section_number=prev.section_number,
                section_title=prev.section_title,
                char_start=prev.char_start,
                char_end=b.char_end,
                priority=max(prev.priority, b.priority),
                chapter=prev.chapter,
                chapter_title=prev.chapter_title,
                part=prev.part,
                part_title=prev.part_title,
                is_repealed=prev.is_repealed and b.is_repealed,
            )
        else:
            merged.append(b)

    if pending is not None:
        if merged:
            prev = merged[-1]
            merged[-1] = SectionBoundary(
                section_type=prev.section_type,
                section_number=prev.section_number,
                section_title=prev.section_title,
                char_start=prev.char_start,
                char_end=pending.char_end,
                priority=prev.priority,
                chapter=prev.chapter,
                chapter_title=prev.chapter_title,
                part=prev.part,
                part_title=prev.part_title,
                is_repealed=prev.is_repealed,
            )
        else:
            merged.append(pending)

    return merged


# ---------------------------------------------------------------------------
# Sub-section splitting (provision-level)
# ---------------------------------------------------------------------------

def split_section_into_provisions(
    section_text: str,
    section_number: str,
    section_title: str,
    section_type: str,
    max_size: int = CHUNK_SIZE,
) -> list[dict]:
    """
    Split a large section into provision-level sub-chunks.

    For definitions: split at each (a), (b), (c) clause.
    For regular sections: split at each (1), (2), (3) sub-section.
    Fallback: split at paragraph boundaries.

    Returns list of dicts:
      [{text, sub_section, provision_type, char_offset}, ...]
    where char_offset is relative to section_text start.
    """
    if len(section_text) <= max_size:
        return [{"text": section_text, "sub_section": "", "provision_type": section_type, "char_offset": 0}]

    # Strategy 1: For definitions, split at clause markers (a), (b), (c)
    if section_type == "definitions":
        provisions = _split_at_pattern(section_text, RE_CLAUSE, "definition_clause")
        if len(provisions) > 1:
            return provisions

    # Strategy 2: Split at sub-section markers (1), (2), (3)
    provisions = _split_at_pattern(section_text, RE_SUB_SECTION, "sub_section")
    if len(provisions) > 1:
        return provisions

    # Strategy 3: Split at paragraph boundaries
    return _split_at_paragraphs(section_text, max_size)


def _split_at_pattern(
    text: str,
    pattern: re.Pattern,
    provision_type: str,
) -> list[dict]:
    """Split text at regex pattern matches, keeping each match as a sub-chunk."""
    matches = list(pattern.finditer(text))
    if len(matches) < 2:
        return [{"text": text, "sub_section": "", "provision_type": provision_type, "char_offset": 0}]

    provisions: list[dict] = []

    # Text before first match (preamble of the section)
    if matches[0].start() > 0:
        preamble = text[:matches[0].start()].strip()
        if preamble:
            provisions.append({
                "text": preamble,
                "sub_section": "",
                "provision_type": "section",
                "char_offset": 0,
            })

    # Each match → next match
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk_text = text[start:end].strip()
        if not chunk_text:
            continue

        sub_label = f"({m.group(1)})"
        provisions.append({
            "text": chunk_text,
            "sub_section": sub_label,
            "provision_type": provision_type,
            "char_offset": start,
        })

    # If splitting produced chunks that are still too large, recursively split
    result: list[dict] = []
    for p in provisions:
        if len(p["text"]) > CHUNK_SIZE:
            sub = _split_at_paragraphs(p["text"], CHUNK_SIZE)
            for s in sub:
                s["sub_section"] = p["sub_section"]
                s["provision_type"] = p["provision_type"]
                s["char_offset"] = p["char_offset"] + s["char_offset"]
            result.extend(sub)
        else:
            result.append(p)

    return result if result else [{"text": text, "sub_section": "", "provision_type": provision_type, "char_offset": 0}]


def _split_at_paragraphs(text: str, max_size: int) -> list[dict]:
    """Fallback: split at paragraph boundaries."""
    paragraphs = text.split("\n\n")
    chunks: list[dict] = []
    current = ""
    current_offset = 0

    for para in paragraphs:
        if not para.strip():
            continue

        if current and len(current) + len(para) + 2 > max_size:
            chunks.append({
                "text": current.strip(),
                "sub_section": "",
                "provision_type": "section",
                "char_offset": current_offset,
            })
            current_offset = text.find(para, current_offset + len(current))
            if current_offset == -1:
                current_offset = 0
            current = para
        else:
            if not current:
                current_offset = text.find(para)
                if current_offset == -1:
                    current_offset = 0
            current = current + "\n\n" + para if current else para

    if current.strip():
        chunks.append({
            "text": current.strip(),
            "sub_section": "",
            "provision_type": "section",
            "char_offset": current_offset,
        })

    return chunks if chunks else [{"text": text, "sub_section": "", "provision_type": "section", "char_offset": 0}]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_heading_title(text: str, pos: int) -> str:
    """Extract a chapter/part/schedule title after the heading marker."""
    while pos < len(text) and text[pos] in " \t\n\r":
        pos += 1
    end = text.find("\n\n", pos)
    if end == -1:
        end = min(pos + 200, len(text))
    title = text[pos:end].strip().strip("-").strip()
    return title


def _extract_section_title(text: str, pos: int) -> str:
    """Extract section title (between number and em-dash)."""
    search_end = min(pos + 300, len(text))
    chunk = text[pos:search_end]

    for pattern in [".—", ".--", ".-", "\n"]:
        idx = chunk.find(pattern)
        if idx != -1 and idx < 200:
            return chunk[:idx].strip().rstrip(".")

    first_line_end = chunk.find("\n")
    if first_line_end != -1 and first_line_end < 150:
        return chunk[:first_line_end].strip().rstrip(".")

    return chunk[:100].strip().rstrip(".")


def _classify_section(sec_num: str, title: str, content: str) -> str:
    """Classify a section by number, title, content."""
    title_lower = title.lower()

    if sec_num == "1" and ("short title" in title_lower or "extent" in title_lower):
        return "short_title"
    if "definition" in title_lower or "interpretation" in title_lower:
        return "definitions"
    if "amendment" in title_lower and "act" in title_lower:
        return "amendment_provision"
    return "section"


def _extract_schedule_number(match_text: str) -> str:
    ordinals = {
        "FIRST": "1", "SECOND": "2", "THIRD": "3", "FOURTH": "4",
        "FIFTH": "5", "SIXTH": "6", "SEVENTH": "7", "EIGHTH": "8",
        "NINTH": "9", "TENTH": "10", "ELEVENTH": "11", "TWELFTH": "12",
    }
    upper = match_text.upper().strip()
    for word, num in ordinals.items():
        if word in upper:
            return num
    m = re.search(r"(\d+)", upper)
    return m.group(1) if m else "1"


def _deduplicate(boundaries: list[SectionBoundary]) -> list[SectionBoundary]:
    """Remove overlapping boundaries, keeping the more specific one."""
    if len(boundaries) <= 1:
        return boundaries
    result: list[SectionBoundary] = [boundaries[0]]
    for b in boundaries[1:]:
        prev = result[-1]
        if b.char_start == prev.char_start:
            if b.priority > prev.priority:
                result[-1] = b
            elif b.section_type == "section" and prev.section_type in ("chapter_heading", "part_heading"):
                result[-1] = b
        else:
            result.append(b)
    return result


_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def _is_valid_roman(s: str) -> bool:
    """Check if a string is a valid Roman numeral (I-C range for sections)."""
    if not s or len(s) > 6:
        return False
    try:
        val = 0
        for i, ch in enumerate(s):
            if ch not in _ROMAN_VALUES:
                return False
            current = _ROMAN_VALUES[ch]
            next_val = _ROMAN_VALUES[s[i + 1]] if i + 1 < len(s) else 0
            if current < next_val:
                val -= current
            else:
                val += current
        return 1 <= val <= 100
    except (KeyError, IndexError):
        return False
