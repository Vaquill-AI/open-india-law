"""
Configuration constants for the IndiaCode legislation RAG pipeline.

Chunk sizes, section type priorities, regex patterns, R2 paths.
"""

import os
import re

# ---------------------------------------------------------------------------
# Chunking — Provision-Level Strategy
# ---------------------------------------------------------------------------
CHUNK_SIZE = 1500          # ~375 tokens – forces sub-section splitting for large sections
CHUNK_OVERLAP = 0          # Sections are complete semantic units; no overlap
SPLIT_OVERLAP = 128        # Small overlap when splitting oversized sub-sections
MIN_CHUNK_SIZE = 80        # Allow small definition clauses "(a) 'goods' means..."

TEXT_SPLIT_SEPARATORS = [
    "\n\n\n",              # Triple newline (sub-section gap)
    "\n\n",                # Paragraph break
    "\n",                  # Line break
    ". ",                  # Sentence end
    " ",                   # Word break
]

# ---------------------------------------------------------------------------
# Sub-section / clause boundary patterns (for splitting large sections)
# ---------------------------------------------------------------------------

# Sub-section markers: (1), (2), (3)...
RE_SUB_SECTION = re.compile(
    r"^\s*\((\d+)\)\s", re.MULTILINE
)

# Clause markers within definitions: (a), (b), (c)... or (i), (ii), (iii)...
RE_CLAUSE = re.compile(
    r"^\s*\(([a-z]{1,3}|[ivxlc]+)\)\s", re.MULTILINE
)

# Roman numeral sections for old acts: "I.", "II.", "III.", "IV."
RE_ROMAN_SECTION = re.compile(
    r"^([IVXLC]+)\.\s", re.MULTILINE
)

# ---------------------------------------------------------------------------
# Section type priorities (higher = more important for search relevance)
# ---------------------------------------------------------------------------
SECTION_PRIORITIES = {
    "definitions":      90,   # Most searched – "what does X mean?"
    "definition_clause": 92,  # Individual defined term – even more precise
    "section":          80,   # Core provisions
    "sub_section":      80,   # Sub-section of a section (same importance)
    "schedule":         70,   # Referenced tables / forms
    "preamble":         65,   # Purpose / scope ("An Act to …")
    "short_title":      60,   # Applicability, extent, commencement
    "amendment_provision": 55, # Sections that amend other acts
    "proviso":          50,   # "Provided that …" clauses
    "explanation":      50,   # "Explanation.—" clauses
    "article":          80,   # Constitution articles (same weight as section)
    "rule":             75,   # Subordinate legislation rules
    "regulation":       75,   # Subordinate legislation regulations
    "chapter_heading":  30,   # Structural, not substantive
    "part_heading":     30,
    "body":             30,   # Fallback
}

# ---------------------------------------------------------------------------
# Section detection regex patterns (compiled for speed)
# ---------------------------------------------------------------------------

# Chapter / Part headings (handles markdown ## prefix)
RE_CHAPTER = re.compile(
    r"^(?:#{1,3}\s+)?(?:\*\*)?(?:CHAPTER|Chapter)\s+([IVXLCDM]+|\d+[A-Z]?)\b",
    re.MULTILINE,
)
RE_PART = re.compile(
    r"^(?:#{1,3}\s+)?(?:\*\*)?(?:PART|Part)\s+([IVXLCDM]+|\d+[A-Z]?)\b",
    re.MULTILINE,
)

# Section numbers: "1.", "3A.", "42.", "302."
# Handles markdown prefixes: "> ", "**", footnote markers like "6[" or "[1]"
# Examples matched:
#   "1. Short title"
#   "**1. Short title, extent and commencement. —**"
#   "> 6[ **2. Interpretation clause.—**"
#   "[1] **3. Definitions.**"
#   "10. Power to invest"  (multi-digit)
#   "302. Punishment for murder"
#
# CRITICAL: The footnote prefix groups must NOT greedily eat leading digits
# of the section number. Use \[ anchor to distinguish "6[" from "60."
RE_SECTION = re.compile(
    r"^(?:>\s*)?(?:\d{1,3}\[\s*)?(?:\[\d{1,3}\]\s*)?(?:\*\*)?(\d+[A-Z]{0,2})\.\s",
    re.MULTILINE,
)

# Article numbers (Constitution): "Article 14.", "Art. 21."
RE_ARTICLE = re.compile(
    r"^(?:Article|Art\.?)\s+(\d+[A-Z]{0,2})\b", re.MULTILINE
)

# Schedule headings
RE_SCHEDULE = re.compile(
    r"^(?:THE\s+)?(?:FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|"
    r"NINTH|TENTH|ELEVENTH|TWELFTH|\d+(?:ST|ND|RD|TH)?)\s+SCHEDULE\b|"
    r"^SCHEDULE\s*$",
    re.MULTILINE | re.IGNORECASE,
)

# Preamble
RE_PREAMBLE = re.compile(
    r"^An\s+Act\s+to\b|^STATEMENT\s+OF\s+OBJECTS\s+AND\s+REASONS",
    re.MULTILINE | re.IGNORECASE,
)

# Rules / Regulations (subordinate legislation)
RE_RULE = re.compile(r"^(\d+[A-Z]?)\.\s", re.MULTILINE)
RE_REGULATION = re.compile(r"^(?:Regulation|Reg\.?)\s+(\d+[A-Z]?)\b", re.MULTILINE)

# ---------------------------------------------------------------------------
# Metadata extraction patterns
# ---------------------------------------------------------------------------

# Amendment notes: [Ins. by Act 44 of 1991, s. 26]
RE_AMENDMENT = re.compile(
    r"\[(?:Ins|Subs|Added|Omitted|Rep)\.\s+by\s+Act\s+(\d+)\s+of\s+(\d{4})"
    r"(?:,\s*(?:s|w\.e\.f)\.\s*[^]]+)?\]",
    re.IGNORECASE,
)

# Cross-referenced acts
RE_ACT_REFERENCE = re.compile(
    r"(?:the\s+)?((?:[A-Z][a-z]+\s+){1,6}(?:Act|Code|Ordinance),?\s+\d{4})",
)

# Defined terms: "board" means … / "authority" means …
RE_DEFINED_TERM = re.compile(
    r'["\u201c]([^"\u201d]{2,60})["\u201d]\s+means\b',
    re.IGNORECASE,
)

# Territorial extent
RE_TERRITORIAL = re.compile(
    r"(?:extends?\s+to\s+)(the\s+whole\s+of\s+India|"
    r"the\s+State\s+of\s+\w+(?:\s+\w+)*|"
    r"the\s+Union\s+[Tt]erritor(?:y|ies)\s+of\s+\w+(?:\s+\w+)*)",
    re.IGNORECASE,
)

# Repealed marker
RE_REPEALED_SECTION = re.compile(
    r"\[(?:Omitted|Repealed|Rep\.)\s*(?:by\s+[^]]+)?\]",
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Text cleaning
# ---------------------------------------------------------------------------

# Page header/footer detection – text appearing on >40% of pages at same position
PAGE_HEADER_THRESHOLD = 0.4

# Characters to normalise
UNICODE_REPLACEMENTS = {
    "\u2018": "'",   # left single quote
    "\u2019": "'",   # right single quote
    "\u201c": '"',   # left double quote
    "\u201d": '"',   # right double quote
    "\u2013": "-",   # en-dash → hyphen (preserve em-dash)
    "\u00a0": " ",   # non-breaking space
    "\ufeff": "",    # BOM
    "\u200b": "",    # zero-width space
    "\u200c": "",    # zero-width non-joiner
    "\u200d": "",    # zero-width joiner
    "\u00ad": "",    # soft hyphen
}

# ---------------------------------------------------------------------------
# R2 storage
# ---------------------------------------------------------------------------
R2_BUCKET_BASE = "indiacode"   # root prefix in the R2 bucket
R2_PUBLIC_URL = os.environ.get("R2_PUBLIC_URL", "")  # Public URL for R2 bucket

# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------
DEFAULT_WORKERS = 8
CHECKPOINT_INTERVAL = 50       # save progress every N acts
EXTRACTION_MIN_CHARS = 100     # skip PDFs with less text than this
