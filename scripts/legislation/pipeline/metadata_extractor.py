"""
Extract structured metadata from legislation text.

Extracts:
- Amendment notes (acts that modified this section)
- Cross-referenced acts
- Defined terms (from definitions sections)
- Territorial extent
- Commencement info
- Penalty / punishment provisions (imprisonment, fine amounts)
- Enacting formula and date of assent
- Ministry / department from header
- Repeal clauses (what this act repeals)
- Effective dates (w.e.f. dates per section)
"""

import re

from config import (
    RE_AMENDMENT,
    RE_ACT_REFERENCE,
    RE_DEFINED_TERM,
    RE_TERRITORIAL,
)


# ---------------------------------------------------------------------------
# Penalty / Punishment extraction
# ---------------------------------------------------------------------------

RE_IMPRISONMENT = re.compile(
    r"(?:imprison(?:ment|ed)\s+(?:of\s+)?(?:either\s+description\s+)?for\s+(?:a\s+term\s+)?)"
    r"(?:which\s+may\s+extend\s+to\s+|not\s+(?:be\s+)?less\s+than\s+)"
    r"(\d+\s+(?:year|month|day|week)s?)",
    re.IGNORECASE,
)

RE_FINE = re.compile(
    r"(?:fine\s+(?:which\s+may\s+extend\s+to|not\s+(?:be\s+)?less\s+than|of)\s+)"
    r"(?:rupees?\s+)?([\d,]+(?:\s+(?:lakh|crore|thousand)s?)?)",
    re.IGNORECASE,
)

RE_PENALTY_SECTION = re.compile(
    r"(?:shall\s+be\s+(?:punish(?:ed|able)|liable\s+to))\s+with\s+([^.]{10,200})\.",
    re.IGNORECASE,
)


def extract_penalties(text: str) -> dict | None:
    """
    Extract penalty/punishment info from a section.

    Returns dict like:
      {
        "has_penalty": True,
        "imprisonment": ["3 years", "7 years"],
        "fine": ["1,00,000", "5 lakh"],
        "penalty_text": "imprisonment for 3 years, or fine up to 1 lakh, or both"
      }
    """
    imprisonment = []
    for m in RE_IMPRISONMENT.finditer(text):
        term = m.group(1).strip()
        if term and term not in imprisonment:
            imprisonment.append(term)

    fines = []
    for m in RE_FINE.finditer(text):
        amount = m.group(1).strip()
        if amount and amount not in fines:
            fines.append(amount)

    penalty_texts = []
    for m in RE_PENALTY_SECTION.finditer(text):
        penalty_texts.append(m.group(1).strip())

    if not imprisonment and not fines and not penalty_texts:
        return None

    return {
        "has_penalty": True,
        "imprisonment": imprisonment,
        "fine": fines,
        "penalty_text": penalty_texts[0] if penalty_texts else "",
    }


# ---------------------------------------------------------------------------
# Enacting formula / date of assent
# ---------------------------------------------------------------------------

def extract_enacting_info(header_text: str) -> dict:
    """Extract enacting formula, date of assent, and parliament details."""
    result: dict = {}

    # Date of assent / passing: "[30th November, 1855]" or "[Passed on the 30th...]"
    date_patterns = [
        r"\[\s*(?:Passed\s+on\s+(?:the\s+)?)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})\s*\]",
        r"(?:received\s+the\s+assent\s+of\s+the\s+President\s+on\s+(?:the\s+)?)"
        r"(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
        r"(?:Date\s+of\s+Assent[:\s]+)(\d{1,2}[./\-]\d{1,2}[./\-]\d{4})",
    ]
    for pat in date_patterns:
        m = re.search(pat, header_text, re.IGNORECASE)
        if m:
            result["date_of_assent"] = m.group(1).strip()
            break

    # Ministry / Department
    ministry_patterns = [
        r"(?:Ministry\s+of\s+)([\w\s,&]+?)(?:\.|,|\n|$)",
        r"(?:Department\s+of\s+)([\w\s,&]+?)(?:\.|,|\n|$)",
        r"(?:MINISTRY\s+OF\s+)([\w\s,&]+?)(?:\.|,|\n|$)",
    ]
    for pat in ministry_patterns:
        m = re.search(pat, header_text)
        if m:
            val = m.group(1).strip().rstrip(",").strip()
            if len(val) > 3 and len(val) < 80:
                result["ministry_extracted"] = val
                break

    # Enacting formula: "Be it enacted by Parliament..."
    enact_match = re.search(
        r"(Be\s+it\s+enacted\s+by\s+[^.]+\.)",
        header_text,
        re.IGNORECASE,
    )
    if enact_match:
        result["enacting_formula"] = enact_match.group(1).strip()

    # Long title: "An Act to provide for..."
    long_title_match = re.search(
        r"(An\s+Act\s+to\s+[^.]+\.)",
        header_text,
        re.IGNORECASE,
    )
    if long_title_match:
        result["long_title"] = long_title_match.group(1).strip()

    return result


# ---------------------------------------------------------------------------
# Repeal clauses
# ---------------------------------------------------------------------------

def extract_repeal_info(text: str) -> list[str]:
    """
    Extract what other acts/regulations this act repeals.

    Returns list like: ["Bengal R. 6, 1806", "B.R. 11, 1829"]
    """
    repeals: list[str] = []
    seen: set[str] = set()

    patterns = [
        r"(?:hereby\s+)?repeal(?:s|ed)\s+(?:the\s+)?((?:[A-Z][\w\s,.']+?)(?:Act|Regulation|Code|Ordinance),?\s+\d{4})",
        r"Repeal\s+(?:of\s+)?([\w\s,.]+?(?:Act|Regulation),?\s+\d{4})",
        r"(?:Repeal\s+)([\w\s,.]+?\d{4})",
    ]
    for pat in patterns:
        for m in re.finditer(pat, text, re.IGNORECASE):
            val = m.group(1).strip().rstrip(",").strip()
            if val and val not in seen and len(val) > 5:
                repeals.append(val)
                seen.add(val)

    return repeals


# ---------------------------------------------------------------------------
# Effective dates
# ---------------------------------------------------------------------------

def extract_effective_dates(text: str) -> list[str]:
    """Extract w.e.f. (with effect from) dates from section text."""
    dates: list[str] = []
    seen: set[str] = set()

    patterns = [
        r"w\.e\.f\.\s+(\d{1,2}[./\-]\d{1,2}[./\-]\d{4})",
        r"w\.e\.f\.\s+(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
        r"with\s+effect\s+from\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    ]
    for pat in patterns:
        for m in re.finditer(pat, text, re.IGNORECASE):
            val = m.group(1).strip()
            if val not in seen:
                dates.append(val)
                seen.add(val)

    return dates


# ---------------------------------------------------------------------------
# Provision type classification (TIER 1)
# ---------------------------------------------------------------------------

def classify_provision_type(text: str) -> str:
    """
    Classify the legal nature of a provision based on modal verbs.

    Returns: "mandatory"|"discretionary"|"prohibitory"|"overriding"|"declaratory"|"general"
    """
    lower = text.lower()
    # Order matters — check most specific first
    if re.search(r"\bnotwithstanding\s+anything\s+contained\s+in\b", lower):
        return "overriding"
    if re.search(r"\bshall\s+not\b", lower):
        return "prohibitory"
    if re.search(r"\bno\s+person\s+shall\b", lower):
        return "prohibitory"
    if re.search(r"\bit\s+shall\s+be\s+unlawful\b", lower):
        return "prohibitory"
    # "shall" without "not" = mandatory
    if re.search(r"\bshall\b", lower) and not re.search(r"\bshall\s+not\b", lower):
        return "mandatory"
    if re.search(r"\bmay\b", lower):
        return "discretionary"
    if re.search(r"\bis\s+deemed\s+to\b|\bshall\s+be\s+deemed\b", lower):
        return "declaratory"
    return "general"


# ---------------------------------------------------------------------------
# Legal markers detection (TIER 1)
# ---------------------------------------------------------------------------

def detect_legal_markers(text: str) -> dict:
    """
    Detect proviso, explanation, illustration, non obstante, saving clause.

    Returns dict of boolean flags.
    """
    return {
        "has_proviso": bool(re.search(
            r"(?:^|\n)\s*Provided\s+that\b", text, re.IGNORECASE
        )),
        "has_explanation": bool(re.search(
            r"(?:^|\n)\s*Explanation\s*[.:\-—]", text, re.IGNORECASE
        )),
        "has_illustration": bool(re.search(
            r"(?:^|\n)\s*Illustration\s*[.:\-—]", text, re.IGNORECASE
        )),
        "has_non_obstante": bool(re.search(
            r"\b[Nn]otwithstanding\s+anything\s+(?:contained\s+in|inconsistent)",
            text,
        )),
        "has_saving_clause": bool(re.search(
            r"\b[Nn]othing\s+in\s+this\s+(?:Act|section|Chapter)\s+shall\b",
            text,
        )),
    }


# ---------------------------------------------------------------------------
# Section status (TIER 1)
# ---------------------------------------------------------------------------

def detect_section_status(text: str) -> str:
    """
    Detect section-level status from markers in text.

    Returns: "in_force"|"omitted"|"repealed"|"not_yet_in_force"|"substituted"
    """
    stripped = text.strip()
    # Check first 200 chars for status markers
    head = stripped[:200].lower()

    if "[omitted" in head or "* * *" in stripped[:50]:
        return "omitted"
    if "[repealed" in head:
        return "repealed"
    if "[not yet in force" in head or "[not yet enforced" in head:
        return "not_yet_in_force"
    if "[substituted" in head:
        return "substituted"
    return "in_force"


# ---------------------------------------------------------------------------
# Internal cross-references (TIER 1)
# ---------------------------------------------------------------------------

RE_INTERNAL_SECTION_REF = re.compile(
    r"(?:section|Section|Sec\.|sec\.)\s+"
    r"(\d+[A-Z]?(?:\s*\([a-z0-9]+\))?)",
)

RE_SCHEDULE_REF = re.compile(
    r"(?:(?:First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s+Schedule"
    r"|Schedule\s+[IVXLCDM]+)",
    re.IGNORECASE,
)


def extract_internal_references(text: str, own_section: str | None = None) -> list[str]:
    """
    Extract references to other sections within the same act.

    Returns list like: ["41", "2(d)", "Schedule I"]
    Excludes self-reference.
    """
    refs: list[str] = []
    seen: set[str] = set()

    for m in RE_INTERNAL_SECTION_REF.finditer(text):
        ref = m.group(1).strip()
        # Skip self-reference
        if own_section and ref == own_section:
            continue
        if ref not in seen:
            refs.append(ref)
            seen.add(ref)

    # Schedule references
    for m in RE_SCHEDULE_REF.finditer(text):
        ref = m.group(0).strip()
        if ref not in seen:
            refs.append(ref)
            seen.add(ref)

    return refs


# ---------------------------------------------------------------------------
# Delegation of power (TIER 1)
# ---------------------------------------------------------------------------

def detect_delegation_type(text: str, section_number: str | None = None) -> str | None:
    """
    Detect if this section delegates rule/regulation-making power.

    Skips Section 1 (Short title) which often mentions "notification"
    in commencement clauses — not actual delegation.

    Returns: "rules"|"regulations"|"notification"|"order"|None
    """
    # Section 1 is almost always "Short title, extent and commencement"
    # "by notification in the Official Gazette" is about commencement, not delegation
    if section_number and section_number.strip() == "1":
        return None

    lower = text.lower()
    if re.search(r"\bmay\s*(?:,\s*by\s+notification[^,]*,\s*)?make\s+rules\b", lower):
        return "rules"
    if re.search(r"\bmay\s*(?:,\s*by\s+notification[^,]*,\s*)?make\s+regulations\b", lower):
        return "regulations"
    # "may, by notification" ONLY counts if it's about delegating power, not commencement
    if re.search(r"\bmay,?\s+by\s+(?:official\s+)?notification[^.]*(?:appoint|direct|specify|exempt|declare|add|remove)\b", lower):
        return "notification"
    if re.search(r"\bmay,?\s+by\s+order[^.]*(?:appoint|direct|specify|exempt|declare)\b", lower):
        return "order"
    return None


# ---------------------------------------------------------------------------
# Legal subject classification (TIER 2)
# ---------------------------------------------------------------------------

SUBJECT_KEYWORDS: dict[str, list[str]] = {
    "criminal_law": [
        "penal", "criminal", "offence", "crime", "punishment", "imprisonment",
        "cognizable", "bail", "prosecution", "police",
    ],
    "tax_law": [
        "tax", "duty", "excise", "customs", "income-tax", "gst", "goods and services",
        "stamp", "cess", "levy", "tariff", "revenue",
    ],
    "property_law": [
        "property", "transfer", "easement", "mortgage", "tenancy", "rent",
        "land", "registration", "conveyance",
    ],
    "labour_law": [
        "labour", "labor", "industrial", "workmen", "employment", "wage",
        "factory", "trade union", "provident fund", "gratuity",
    ],
    "corporate_law": [
        "company", "companies", "corporate", "securities", "share", "debenture",
        "insolvency", "bankruptcy", "partnership", "llp",
    ],
    "family_law": [
        "marriage", "divorce", "adoption", "maintenance", "guardians",
        "succession", "hindu", "muslim", "christian", "parsi",
    ],
    "constitutional_law": [
        "constitution", "fundamental", "directive", "citizenship",
        "election", "parliament", "legislature",
    ],
    "environmental_law": [
        "environment", "pollution", "forest", "wildlife", "water",
        "air", "conservation", "ecology", "biodiversity",
    ],
    "banking_finance": [
        "banking", "bank", "reserve bank", "insurance", "financial",
        "negotiable instrument", "money", "credit", "loan",
    ],
    "civil_procedure": [
        "civil procedure", "limitation", "arbitration", "evidence",
        "court fees", "suit", "decree", "appeal",
    ],
    "administrative_law": [
        "tribunal", "commission", "authority", "board", "regulatory",
        "ombudsman", "administrative",
    ],
    "intellectual_property": [
        "patent", "copyright", "trademark", "design", "geographical indication",
    ],
    "information_technology": [
        "information technology", "cyber", "electronic", "digital", "data protection",
    ],
}


def classify_legal_subject(title: str, department: str = "", ministry: str = "") -> list[str]:
    """
    Classify an act into legal subject areas based on title and ministry.

    Returns list of matching subjects (can be multi-label).
    """
    combined = f"{title} {department} {ministry}".lower()
    subjects: list[str] = []

    for subject, keywords in SUBJECT_KEYWORDS.items():
        for kw in keywords:
            if kw in combined:
                subjects.append(subject)
                break

    return subjects if subjects else ["general"]


# ---------------------------------------------------------------------------
# Structured footnotes (TIER 2)
# ---------------------------------------------------------------------------

RE_FOOTNOTE_BLOCK = re.compile(
    r"\[Footnotes?\]\s*(.*?)$",
    re.DOTALL | re.IGNORECASE,
)

RE_FOOTNOTE_ENTRY = re.compile(
    r"(\d+)\.\s+(.*?)(?=\n\d+\.\s|\Z)",
    re.DOTALL,
)


def extract_structured_footnotes(text: str) -> list[dict]:
    """
    Parse footnote blocks into structured entries.

    Returns list like:
      [{"id": 1, "text": "Subs. by Act 44 of 1991, s. 26, for 'three years'",
        "type": "substitution", "by_act": "Act 44 of 1991"}]
    """
    block_match = RE_FOOTNOTE_BLOCK.search(text)
    if not block_match:
        return []

    block = block_match.group(1).strip()
    footnotes: list[dict] = []

    for m in RE_FOOTNOTE_ENTRY.finditer(block):
        fn_id = int(m.group(1))
        fn_text = m.group(2).strip()
        fn_text = re.sub(r"\s+", " ", fn_text)

        # Classify footnote type
        fn_lower = fn_text.lower()
        if "subs." in fn_lower or "substituted" in fn_lower:
            fn_type = "substitution"
        elif "ins." in fn_lower or "inserted" in fn_lower or "added" in fn_lower:
            fn_type = "insertion"
        elif "omitted" in fn_lower or "rep." in fn_lower or "repealed" in fn_lower:
            fn_type = "omission"
        elif "renumbered" in fn_lower:
            fn_type = "renumbering"
        else:
            fn_type = "note"

        # Extract amending act
        act_match = re.search(r"Act\s+\d+\s+of\s+\d{4}", fn_text)
        by_act = act_match.group(0) if act_match else None

        # Extract original text (what was replaced)
        orig_match = re.search(r"for\s+['\"](.+?)['\"]", fn_text)
        original_text = orig_match.group(1) if orig_match else None

        footnotes.append({
            "id": fn_id,
            "text": fn_text,
            "type": fn_type,
            "by_act": by_act,
            "original_text": original_text,
        })

    return footnotes


# ---------------------------------------------------------------------------
# Case citations in text (TIER 2)
# ---------------------------------------------------------------------------

RE_CASE_CITATION = re.compile(
    r"(?:"
    r"\(\d{4}\)\s+\d+\s+SCC\s+\d+"           # (2013) 8 SCC 519
    r"|AIR\s+\d{4}\s+SC\s+\d+"                # AIR 2005 SC 3820
    r"|\d{4}\s+SCC\s+\(Cri\)\s+\d+"           # 2013 SCC (Cri) 1
    r"|\(\d{4}\)\s+\d+\s+SCC\s+\([A-Za-z]+\)\s+\d+"  # (2013) 8 SCC (Cri) 1
    r"|ILR\s+\d{4}\s+\w+\s+\d+"               # ILR 2005 Kar 123
    r")",
)


def extract_case_citations(text: str) -> list[str]:
    """Extract case law citations from text (typically from footnotes)."""
    citations: list[str] = []
    seen: set[str] = set()

    for m in RE_CASE_CITATION.finditer(text):
        cite = m.group(0).strip()
        if cite not in seen:
            citations.append(cite)
            seen.add(cite)

    return citations


# ---------------------------------------------------------------------------
# Limitation period extraction (TIER 3)
# ---------------------------------------------------------------------------

RE_LIMITATION = re.compile(
    r"within\s+(?:a\s+period\s+of\s+)?(\d+\s+(?:day|month|year|week)s?)",
    re.IGNORECASE,
)


def extract_limitation_periods(text: str) -> list[str]:
    """Extract limitation/time periods from section text."""
    periods: list[str] = []
    seen: set[str] = set()

    for m in RE_LIMITATION.finditer(text):
        period = m.group(1).strip()
        if period not in seen:
            periods.append(period)
            seen.add(period)

    return periods


# ---------------------------------------------------------------------------
# Core extractors (unchanged)
# ---------------------------------------------------------------------------

def extract_amendments(text: str) -> list[str]:
    """
    Extract amendment notes from section text.

    Matches both formats:
    - Bracketed: [Ins. by Act 44 of 1991, s. 26]
    - Footnote: 1. Ins. by Act 44 of 1991, s. 26 (w.e.f. 15-5-1991).
    """
    notes: list[str] = []
    seen: set[str] = set()

    # Format 1: Bracketed [Ins. by Act...]
    for m in re.finditer(
        r"\[(?:Ins|Subs|Added|Omitted|Rep)\.\s+by\s+Act\s+\d+\s+of\s+\d{4}"
        r"(?:,\s*(?:s|w\.e\.f)\.\s*[^]]+)?\]",
        text,
        re.IGNORECASE,
    ):
        note = m.group(0).strip("[]").strip()
        if note not in seen:
            notes.append(note)
            seen.add(note)

    # Format 2: Footnote-style "1. Ins. by Act..." or standalone
    for m in re.finditer(
        r"(?:^|\n)\s*\d*\.?\s*((?:Ins|Subs|Added|Omitted|Rep)\.\s+by\s+Act\s+\d+\s+of\s+\d{4}"
        r"(?:,\s*s\.\s*\d+[^.]*)?)",
        text,
        re.IGNORECASE,
    ):
        note = m.group(1).strip()
        if note and note not in seen:
            notes.append(note)
            seen.add(note)

    return notes


def extract_acts_referenced(text: str) -> list[str]:
    """Extract cross-referenced act names."""
    acts: list[str] = []
    seen: set[str] = set()

    for m in RE_ACT_REFERENCE.finditer(text):
        act_name = m.group(1).strip()
        if act_name.lower() in ("this act", "the act", "an act"):
            continue
        normalised = act_name.strip(",").strip()
        if normalised and normalised not in seen:
            acts.append(normalised)
            seen.add(normalised)

    return acts


def extract_defined_terms(text: str) -> list[str]:
    """Extract defined terms: "board" means ..."""
    terms: list[str] = []
    seen: set[str] = set()

    for m in RE_DEFINED_TERM.finditer(text):
        term = m.group(1).strip().lower()
        if len(term) > 50:
            continue
        if term not in seen:
            terms.append(term)
            seen.add(term)

    return sorted(terms)


def extract_territorial_extent(text: str) -> str | None:
    """Extract territorial extent from Section 1."""
    m = RE_TERRITORIAL.search(text)
    if m:
        return m.group(1).strip()
    return None


def extract_commencement_info(text: str) -> str | None:
    """Extract commencement date/info from Section 1."""
    patterns = [
        r"shall\s+come\s+into\s+force\s+on\s+([^.;]+)",
        r"shall\s+be\s+deemed\s+to\s+have\s+come\s+into\s+force\s+on\s+([^.;]+)",
        r"come\s+into\s+force\s+(?:on\s+)?(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+\w+,?\s+\d{4})",
    ]
    for pattern in patterns:
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            return m.group(1).strip().rstrip(",").strip()
    return None


# ---------------------------------------------------------------------------
# Act-level metadata (from full text header)
# ---------------------------------------------------------------------------

def extract_act_metadata_from_text(full_text: str) -> dict:
    """Extract act-level metadata from the full text."""
    header = full_text[:3000]
    result: dict = {}

    # Territorial extent
    extent = extract_territorial_extent(full_text[:5000])
    if extent:
        result["territorial_extent"] = extent

    # Commencement info
    commencement = extract_commencement_info(full_text[:5000])
    if commencement:
        result["commencement_info"] = commencement

    # Act number: "[Act No. 45 of 1860]"
    act_no_match = re.search(
        r"(?:Act\s+No\.?\s*|ACT\s+NO\.?\s*)(\d+|[IVXLCDM]+)\s+(?:of|OF)\s+(\d{4})",
        header,
    )
    if act_no_match:
        result["act_number_extracted"] = act_no_match.group(1)
        result["year_extracted"] = int(act_no_match.group(2))

    # Gazette notification
    gazette_match = re.search(
        r"(?:Gazette\s+of\s+India|Official\s+Gazette)[^.]*\.",
        header,
        re.IGNORECASE,
    )
    if gazette_match:
        result["gazette_notification"] = gazette_match.group(0).strip()

    # Enacting info (date of assent, ministry, long title, enacting formula)
    enacting = extract_enacting_info(header)
    result.update(enacting)

    # Repeal clauses (what this act repeals)
    repeals = extract_repeal_info(full_text[:10000])
    if repeals:
        result["repeals"] = repeals

    # All referenced acts
    result["acts_referenced"] = extract_acts_referenced(full_text)

    # All amendment notes
    result["amendment_notes"] = extract_amendments(full_text)

    # Legal subject classification (TIER 2)
    # title/department/ministry filled by caller from index entry
    # We extract from header text as fallback
    result["_header_for_subject"] = header  # caller uses this

    return result


# ---------------------------------------------------------------------------
# Section-level metadata
# ---------------------------------------------------------------------------

def extract_section_metadata(
    section_text: str,
    section_type: str,
    section_number: str | None = None,
) -> dict:
    """Extract metadata specific to a single section."""
    result: dict = {}

    result["amendment_notes"] = extract_amendments(section_text)
    result["acts_referenced"] = extract_acts_referenced(section_text)

    if section_type == "definitions":
        result["defined_terms"] = extract_defined_terms(section_text)

    # Penalties
    penalty = extract_penalties(section_text)
    if penalty:
        result["penalty"] = penalty

    # Effective dates
    eff_dates = extract_effective_dates(section_text)
    if eff_dates:
        result["effective_dates"] = eff_dates

    # --- TIER 1: New extractions ---

    # Provision type (mandatory/discretionary/prohibitory/overriding)
    result["provision_type"] = classify_provision_type(section_text)

    # Legal markers (proviso, explanation, illustration, non obstante, saving)
    result.update(detect_legal_markers(section_text))

    # Section status (in_force/omitted/repealed/not_yet_in_force/substituted)
    result["section_status"] = detect_section_status(section_text)

    # Internal cross-references
    result["sections_referenced_internal"] = extract_internal_references(
        section_text, own_section=section_number,
    )

    # Delegation of power
    delegation = detect_delegation_type(section_text, section_number)
    if delegation:
        result["delegation_type"] = delegation

    # Amendment count (derived)
    result["amendment_count"] = len(result["amendment_notes"])

    # --- TIER 2 ---

    # Structured footnotes
    footnotes = extract_structured_footnotes(section_text)
    if footnotes:
        result["footnotes_structured"] = footnotes

    # Case citations
    citations = extract_case_citations(section_text)
    if citations:
        result["case_citations"] = citations

    # --- TIER 3 ---

    # Limitation periods
    limitations = extract_limitation_periods(section_text)
    if limitations:
        result["limitation_periods"] = limitations

    return result
