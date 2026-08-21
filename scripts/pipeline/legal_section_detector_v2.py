"""
Shared Legal Section Detection Module for Indian Court RAG Pipelines

This module provides unified section detection for both Supreme Court and High Court
chunking pipelines. It identifies legal document sections using regex patterns and
content-based heuristics.

Usage:
    from legal_section_detector import detect_section_type, SECTION_PATTERNS

    section = detect_section_type(chunk_text)
    # Returns: "ratio_decidendi", "obiter_dicta", "facts", "conclusion", etc.

Section Types (15 categories):
    - header: Court identification (IN THE SUPREME COURT, HIGH COURT)
    - ratio_decidendi: Core legal reasoning that forms precedent
    - obiter_dicta: Non-binding observations
    - issues: Questions for consideration
    - precedents: Cases cited/referred
    - judgment: Main judgment/order section
    - facts: Factual background
    - arguments: Party submissions/contentions
    - analysis: Court's discussion/reasoning
    - conclusion: Final decision/held
    - relief: Relief sought/prayers
    - statutes: Acts/provisions referenced
    - procedure: Procedural history
    - paragraph: Numbered paragraphs
    - section: Lettered sections
    - body: Default for unclassified content
"""

import re
from typing import List, Tuple, Optional


# =============================================================================
# SECTION PATTERNS - Comprehensive Legal Document Section Detection
# =============================================================================
# These patterns cover Indian legal document structures across:
# - Supreme Court of India judgments
# - High Court judgments (25 HCs)
# - Tribunals and appellate bodies
#
# Pattern format: (regex_pattern, section_type)
# Patterns are checked in order - first match wins
# =============================================================================

SECTION_PATTERNS: List[Tuple[str, str]] = [
    # Court identification headers
    (r"^(?:IN THE SUPREME COURT|SUPREME COURT OF INDIA)", "header"),
    (r"^(?:IN THE HIGH COURT|HIGH COURT OF)", "header"),
    (r"^(?:BEFORE THE HON)", "header"),

    # Core legal holdings (most important for RAG)
    (r"^(?:RATIO\s+DECIDENDI|RATIO\s+OF\s+THE\s+CASE|RATIO)", "ratio_decidendi"),
    (r"^(?:OBITER\s+DICTA|OBITER\s+DICTUM|OBITER)", "obiter_dicta"),

    # Issues and questions for determination
    (r"^(?:ISSUE[S]?(?:\s+FRAMED)?|QUESTION[S]?\s+(?:FOR\s+)?(?:CONSIDERATION|DETERMINATION)|POINT[S]?\s+(?:FOR\s+)?DETERMINATION)", "issues"),
    (r"^(?:FRAMING\s+OF\s+ISSUE|FORMULATION\s+OF\s+ISSUE)", "issues"),

    # Case citations and precedents
    (r"^(?:PRECEDENT[S]?\s+(?:CITED|REFERRED|RELIED)|CASE[S]?\s+(?:CITED|REFERRED|RELIED)|CITATION[S]?\s+(?:RELIED|REFERRED))", "precedents"),
    (r"^(?:CASE\s+LAW|JUDICIAL\s+PRECEDENT)", "precedents"),

    # Main judgment sections
    (r"^(?:JUDGMENT|ORDER|FINAL\s+ORDER|JUDGEMENT)(?:\s*:)?$", "judgment"),
    (r"^(?:PER\s+CURIAM|DELIVERED\s+BY)", "judgment"),

    # Factual background
    (r"^(?:FACTS?|BACKGROUND|FACTUAL\s+(?:BACKGROUND|MATRIX)|BRIEF\s+FACTS)", "facts"),
    (r"^(?:FACTUAL\s+NARRATIVE|STATEMENT\s+OF\s+FACTS)", "facts"),

    # Party arguments and submissions
    (r"^(?:ARGUMENTS?|SUBMISSIONS?|CONTENTIONS?|RIVAL\s+(?:CONTENTIONS?|SUBMISSIONS?))", "arguments"),
    (r"^(?:APPELLANT['S]?\s+(?:ARGUMENTS?|SUBMISSIONS?)|RESPONDENT['S]?\s+(?:ARGUMENTS?|SUBMISSIONS?))", "arguments"),
    (r"^(?:PETITIONER['S]?\s+(?:ARGUMENTS?|SUBMISSIONS?)|DEFENDANT['S]?\s+(?:ARGUMENTS?|SUBMISSIONS?))", "arguments"),
    (r"^(?:LEARNED\s+COUNSEL|SENIOR\s+COUNSEL|ADVOCATE)", "arguments"),

    # Court's analysis and reasoning
    (r"^(?:DISCUSSION|ANALYSIS|FINDINGS?|REASONING|CONSIDERATION[S]?)", "analysis"),
    (r"^(?:OUR\s+(?:ANALYSIS|VIEW|CONSIDERATION)|COURT['S]?\s+(?:ANALYSIS|VIEW))", "analysis"),
    (r"^(?:WE\s+(?:HAVE\s+)?(?:CONSIDERED|EXAMINED|ANALYZED))", "analysis"),

    # Conclusion and decision
    (r"^(?:CONCLUSION[S]?|HELD|ORDERED|DIRECTIVE[S]?|DECISION|RESULT)", "conclusion"),
    (r"^(?:IN\s+(?:THE\s+)?(?:RESULT|CONCLUSION)|ACCORDINGLY)", "conclusion"),
    (r"^(?:FOR\s+(?:THE\s+)?(?:FOREGOING|ABOVE)\s+REASONS?)", "conclusion"),

    # Relief sought
    (r"^(?:RELIEF[S]?\s+(?:SOUGHT|CLAIMED|PRAYED)|PRAYER[S]?)", "relief"),
    (r"^(?:WHEREFORE|THE\s+PETITIONER\s+PRAYS)", "relief"),

    # Statutory references
    (r"^(?:STATUTE[S]?\s+(?:REFERRED|CITED)|ACT[S]?\s+(?:REFERRED|CITED)|PROVISION[S]?\s+(?:REFERRED|CITED))", "statutes"),
    (r"^(?:RELEVANT\s+(?:STATUTORY\s+)?PROVISIONS?|LEGAL\s+PROVISIONS?)", "statutes"),

    # Procedural history
    (r"^(?:PROCEDURAL\s+HISTORY|PROCEEDINGS?|HISTORY\s+OF\s+(?:THE\s+)?CASE)", "procedure"),
    (r"^(?:EARLIER\s+PROCEEDINGS?|PRIOR\s+HISTORY)", "procedure"),

    # Numbered/lettered sections (lower priority - catch-all)
    (r"^(?:\d{1,3}\.?\s+)", "paragraph"),
    (r"^(?:[A-Z]\.?\s+)", "section"),
]


# Compiled patterns for performance (compiled once, reused many times)
_COMPILED_PATTERNS: Optional[List[Tuple[re.Pattern, str]]] = None


def _get_compiled_patterns() -> List[Tuple[re.Pattern, str]]:
    """Lazy compile patterns for better performance."""
    global _COMPILED_PATTERNS
    if _COMPILED_PATTERNS is None:
        _COMPILED_PATTERNS = [
            (re.compile(pattern, re.IGNORECASE | re.MULTILINE), section_type)
            for pattern, section_type in SECTION_PATTERNS
        ]
    return _COMPILED_PATTERNS


def detect_section_type(text: str, check_lines: int = 15, check_chars: int = 1000) -> str:
    """
    Detect section type from chunk text using pattern matching and content heuristics.

    Algorithm:
    1. Check first N lines against SECTION_PATTERNS (regex matching)
    2. If no pattern match, check first M characters for content-based detection
    3. Return "body" as default if no section detected

    Args:
        text: The chunk text to analyze
        check_lines: Number of lines from start to check for patterns (default: 15)
        check_chars: Number of characters to check for content-based detection (default: 1000)

    Returns:
        Section type string (e.g., "ratio_decidendi", "facts", "conclusion", "body")

    Examples:
        >>> detect_section_type("RATIO DECIDENDI\\nThe court held that...")
        'ratio_decidendi'

        >>> detect_section_type("1. The facts of the case are as follows...")
        'paragraph'

        >>> detect_section_type("The appellant has filed this appeal...")
        'body'
    """
    if not text or not text.strip():
        return "body"

    # Get compiled patterns
    compiled_patterns = _get_compiled_patterns()

    # Extract first N lines for pattern matching
    lines = text.strip().split("\n")[:check_lines]

    # Check each line against patterns
    for line in lines:
        line_clean = line.strip().upper()
        if not line_clean:
            continue

        for pattern, section_type in compiled_patterns:
            if pattern.search(line_clean):
                return section_type

    # Content-based detection for sections not caught by patterns
    text_upper = text[:check_chars].upper()

    # Ratio decidendi detection (critical for legal RAG)
    if any(phrase in text_upper for phrase in [
        "RATIO DECIDENDI",
        "RATIO OF THE CASE",
        "THE RATIO",
        "BINDING PRECEDENT",
        "THIS COURT HOLDS",
        "WE HOLD THAT"
    ]):
        return "ratio_decidendi"

    # Obiter dicta detection
    if any(phrase in text_upper for phrase in [
        "OBITER DICTA",
        "OBITER DICTUM",
        "BY WAY OF OBITER",
        "OBSERVATION BY WAY OF"
    ]):
        return "obiter_dicta"

    # Issues detection
    if any(phrase in text_upper for phrase in [
        "QUESTION OF LAW",
        "ISSUE FOR CONSIDERATION",
        "POINT FOR DETERMINATION",
        "THE ISSUE THAT ARISES",
        "THE QUESTION THAT ARISES"
    ]):
        return "issues"

    # Facts detection
    if any(phrase in text_upper for phrase in [
        "THE FACTS OF THE CASE",
        "BRIEFLY STATED THE FACTS",
        "THE FACTUAL MATRIX"
    ]):
        return "facts"

    # Conclusion detection
    if any(phrase in text_upper for phrase in [
        "IN THE RESULT",
        "IN CONCLUSION",
        "THE APPEAL IS ALLOWED",
        "THE APPEAL IS DISMISSED",
        "THE PETITION IS ALLOWED",
        "THE PETITION IS DISMISSED",
        "THE WRIT PETITION"
    ]):
        return "conclusion"

    # Default to body
    return "body"


def get_section_priority(section_type: str) -> int:
    """
    Get priority score for a section type (higher = more important for RAG).

    This can be used for:
    - Boosting important sections in search ranking
    - Prioritizing chunks during retrieval
    - Filtering by section importance

    Args:
        section_type: The section type string

    Returns:
        Priority score (0-100)

    Priority levels:
    - 100: ratio_decidendi (most important - binding precedent)
    - 90: conclusion, judgment (key holdings)
    - 80: analysis, issues (reasoning)
    - 70: obiter_dicta, arguments (supporting)
    - 60: facts, precedents (context)
    - 50: relief, statutes, procedure
    - 40: header
    - 30: paragraph, section, body (generic)
    """
    PRIORITY_MAP = {
        "ratio_decidendi": 100,  # Most important - binding legal principle
        "conclusion": 95,        # Final decision
        "judgment": 90,          # Main judgment
        "analysis": 85,          # Court's reasoning
        "issues": 80,            # Questions decided
        "obiter_dicta": 75,      # Non-binding but insightful
        "arguments": 70,         # Party positions
        "facts": 65,             # Background context
        "precedents": 60,        # Cases cited
        "relief": 55,            # What was sought
        "statutes": 50,          # Legal provisions
        "procedure": 45,         # Procedural history
        "header": 40,            # Court identification
        "paragraph": 35,         # Numbered content
        "section": 35,           # Lettered content
        "body": 30,              # Default/unclassified
    }
    return PRIORITY_MAP.get(section_type, 30)


def is_important_section(section_type: str, threshold: int = 70) -> bool:
    """
    Check if a section type is considered important for RAG retrieval.

    Args:
        section_type: The section type string
        threshold: Minimum priority score to be considered important (default: 70)

    Returns:
        True if section priority >= threshold
    """
    return get_section_priority(section_type) >= threshold


# =============================================================================
# SECTION TYPE CONSTANTS (for reference and type hints)
# =============================================================================

SECTION_TYPES = [
    "header",
    "ratio_decidendi",
    "obiter_dicta",
    "issues",
    "precedents",
    "judgment",
    "facts",
    "arguments",
    "analysis",
    "conclusion",
    "relief",
    "statutes",
    "procedure",
    "paragraph",
    "section",
    "body",
]


# =============================================================================
# TESTING
# =============================================================================

if __name__ == "__main__":
    # Run simple tests
    test_cases = [
        ("RATIO DECIDENDI\nThe court held that...", "ratio_decidendi"),
        ("OBITER DICTA\nBy way of observation...", "obiter_dicta"),
        ("ISSUES\n1. Whether the contract was valid?", "issues"),
        ("JUDGMENT\nDelivered by Hon'ble Justice...", "judgment"),
        ("FACTS\nThe brief facts of the case are...", "facts"),
        ("ARGUMENTS\nLearned counsel for the appellant...", "arguments"),
        ("ANALYSIS\nWe have considered the submissions...", "analysis"),
        ("CONCLUSION\nIn the result, the appeal is allowed.", "conclusion"),
        ("1. The appellant filed this case...", "paragraph"),
        ("Some random legal text without section marker", "body"),
        ("IN THE SUPREME COURT OF INDIA\nCivil Appeal No...", "header"),
        ("PRECEDENTS CITED\n1. State of Maharashtra v. XYZ", "precedents"),
        ("RELIEF SOUGHT\nThe petitioner prays for...", "relief"),
        ("RELEVANT STATUTORY PROVISIONS\nSection 302 IPC...", "statutes"),
        ("PROCEDURAL HISTORY\nThe matter was first heard...", "procedure"),
    ]

    print("Testing section detection...")
    print("=" * 60)

    passed = 0
    failed = 0

    for text, expected in test_cases:
        result = detect_section_type(text)
        status = "PASS" if result == expected else "FAIL"
        if result == expected:
            passed += 1
        else:
            failed += 1
        print(f"[{status}] Expected: {expected:20s} Got: {result:20s}")
        if result != expected:
            print(f"       Text: {text[:50]}...")

    print("=" * 60)
    print(f"Results: {passed} passed, {failed} failed")

    # Test priority function
    print("\nSection priorities:")
    for section in SECTION_TYPES:
        priority = get_section_priority(section)
        important = "IMPORTANT" if is_important_section(section) else ""
        print(f"  {section:20s} -> {priority:3d} {important}")
