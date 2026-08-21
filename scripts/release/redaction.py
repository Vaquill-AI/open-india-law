"""Redaction and exclusion applied on the way into a published snapshot.

Measured against the live corpus on 2026-08-13/14. The rates matter, because
they determine whether a rule is a redaction or an exclusion:

  phone numbers               ~0.3% of all chunks (~95,000)   redact
  named relatives of victims  0.14-0.32% of the relevant subsets (~1-2k) redact
  named protected children    0.02-0.17% of JJ Act judgments (~20-30)    redact
  Aadhaar numbers             none found. Every 12-digit hit was a case id,
                              FIR number or proceeding number, and the Verhoeff
                              pass rate matched chance. Kept as cheap insurance.
  in-camera directions        ~19,000 chunks matching "in camera"         EXCLUDE

Scope note. Indian courts anonymize sexual-offence victims in the large
majority of cases: in the POCSO subset, anonymization markers outnumber
victim-naming 18:1. So this does NOT exclude by statute category. Dropping
every POCSO or rape judgment would remove roughly 180,000 judgments that are
lawful to publish precisely because the court, not us, controlled the
disclosure. The narrow band where identity actually leaks is what gets treated.

The exception is a court direction against publication: those sit outside
s.52(1)(q)(iv) by its own terms, so the exemption this corpus relies on does
not cover them at all. Those documents are dropped, not redacted.
"""

from __future__ import annotations

import re

MASK = "[REDACTED]"

# Indian mobile numbers. Bounded so a 10-digit case or FIR number adjacent to
# other digits does not match.
PHONE = re.compile(r"(?<!\d)(?:\+?91[\-\s]?)?[6-9]\d{9}(?!\d)")
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b")
PAN = re.compile(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b")
IFSC = re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")
AADHAAR_SHAPE = re.compile(r"(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)")

# The real BNS s.72 surface: not the victim, the relative the court named.
# "mother of the prosecutrix namely Smt. Meena Singh"
# NOTE: deliberately NOT re.IGNORECASE. The name capture relies on real
# capitalisation; with IGNORECASE, [A-Z] matches lowercase and the group runs
# on past the name into the rest of the sentence.
VICTIM_NAMED = re.compile(
    r"((?i:victim|prosecutrix)[,\s\w]{0,40}?\b(?i:namely|named|by name)\s*,?\s*)"
    r"((?:Smt\.?|Shri\.?|Mr\.?|Ms\.?|Dr\.?)?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})"
)
# JJ Act s.74: the protected child named outright.
CHILD_NAMED = re.compile(
    r"((?i:juvenile|CCL|child in conflict with (?:the )?law)[,\s]*"
    r"\b(?i:namely|named|by name)\s*,?\s*)"
    r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})"
)

#: A direction against publication. Outside s.52(1)(q)(iv), so excluded whole.
NON_PUBLICATION = re.compile(
    # negation can sit on EITHER side: "not in camera" as well as
    # "in camera ... not". A forward-only lookahead missed the first form.
    r"(?<!not )(?<!never )(?<!was not )(?<!were not )\bin\s?-?\s?camera\b(?![^.]{0,40}\bnot\b)"
    r"|shall not be (?:published|reported|disclosed)"
    r"|not (?:be )?(?:published|reported) in any (?:manner|form|media)"
    r"|identity of the (?:victim|child|prosecutrix) shall not",
    re.IGNORECASE,
)

_VERHOEFF_D = (
    (0,1,2,3,4,5,6,7,8,9),(1,2,3,4,0,6,7,8,9,5),(2,3,4,0,1,7,8,9,5,6),
    (3,4,0,1,2,8,9,5,6,7),(4,0,1,2,3,9,5,6,7,8),(5,9,8,7,6,0,4,3,2,1),
    (6,5,9,8,7,1,0,4,3,2),(7,6,5,9,8,2,1,0,4,3),(8,7,6,5,9,3,2,1,0,4),
    (9,8,7,6,5,4,3,2,1,0),
)
_VERHOEFF_P = (
    (0,1,2,3,4,5,6,7,8,9),(1,5,7,6,2,8,3,0,9,4),(5,8,0,3,7,9,6,1,4,2),
    (8,9,1,6,0,4,3,5,2,7),(9,4,5,3,1,2,6,8,7,0),(4,2,8,6,5,7,3,9,0,1),
    (2,7,9,3,8,0,6,4,1,5),(7,0,4,6,9,1,3,2,5,8),
)


def is_aadhaar(candidate: str) -> bool:
    """A real Aadhaar number carries a Verhoeff check digit.

    Roughly 1 in 10 random 12-digit strings passes, so this narrows but does
    not prove. Used only to avoid masking every case number in the corpus.
    """
    digits = [int(x) for x in re.sub(r"\D", "", candidate)][::-1]
    if len(digits) != 12:
        return False
    check = 0
    for i, digit in enumerate(digits):
        check = _VERHOEFF_D[check][_VERHOEFF_P[i % 8][digit]]
    return check == 0


#: Context words that must appear near a shape-only match before it is masked.
PAN_CONTEXT = re.compile(r"\b(?:PAN|permanent account number)\b", re.IGNORECASE)
IFSC_CONTEXT = re.compile(r"\b(?:IFSC|NEFT|RTGS|branch code|account (?:no|number))\b", re.IGNORECASE)
AADHAAR_CONTEXT = re.compile(r"\b(?:aadhaa?r|UIDAI|unique identification)\b", re.IGNORECASE)

#: How far either side of a match to look for the context word.
CONTEXT_WINDOW = 80


def _masked_in_context(
    text: str,
    pattern: re.Pattern[str],
    context: re.Pattern[str],
    label: str,
    counts: dict[str, int],
    extra=None,
) -> str:
    """Mask matches of `pattern` only where `context` appears nearby.

    Shape-only identifier patterns collide with Indian case numbers, so the
    surrounding text has to say what the number is before it is treated as one.
    """
    hits = 0

    def repl(m: re.Match[str]) -> str:
        nonlocal hits
        if extra is not None and not extra(m.group(0)):
            return m.group(0)
        lo = max(0, m.start() - CONTEXT_WINDOW)
        hi = min(len(text), m.end() + CONTEXT_WINDOW)
        if not context.search(text[lo:hi]):
            return m.group(0)
        hits += 1
        return MASK

    out = pattern.sub(repl, text)
    if hits:
        counts[label] = counts.get(label, 0) + hits
    return out


#: A third-party site's print-view furniture captured as body text, which means
#: the document was sourced from that site rather than from the court.
#:
#: This is NOT the same as the judgment citing a reporter. Indian courts cite
#: Manupatra, SCC OnLine and AIR constantly - "reported in Manupatra -
#: MANU/TN/1707/2010" is the judge's own words and belongs in the text.
#: Measured over 19,991 documents: 1.14% carry a reporter citation and must be
#: kept, 0.01% carry furniture and must be dropped. A brand-name gate cannot
#: tell those apart and would refuse the whole corpus.
AGGREGATOR_FURNITURE = re.compile(
    r"Indian\s+Kanoon\s*-\s*https?://indiankanoon\.org/doc/\d+"
    r"|https?://(?:www\.)?indiankanoon\.org/doc/\d+/\d+\s*$"
    r"|\bCite\s+this\s+(?:article|document)\b"
    r"|\bTry\s+out\s+our\s+Premium\s+Member\b",
    re.IGNORECASE | re.MULTILINE,
)


def has_aggregator_furniture(text: str) -> bool:
    """Whether a third-party site's page chrome leaked into the body."""
    return bool(AGGREGATOR_FURNITURE.search(text or ""))


def excluded(text: str) -> bool:
    """Whether the document must be dropped rather than redacted."""
    return bool(NON_PUBLICATION.search(text or "")) or has_aggregator_furniture(text or "")


def redact(text: str) -> tuple[str, dict[str, int]]:
    """Mask identifying detail. Returns the text and a per-rule hit count.

    The counts are returned rather than logged so the caller can report exactly
    what a snapshot removed, on the dataset card.
    """
    if not text:
        return text, {}
    counts: dict[str, int] = {}

    def sub(pattern: re.Pattern[str], repl, label: str, value: str) -> str:
        value, n = pattern.subn(repl, value)
        if n:
            counts[label] = counts.get(label, 0) + n
        return value

    # Keep the role word, drop the name: "prosecutrix namely [REDACTED]"
    text = sub(VICTIM_NAMED, lambda m: m.group(1) + MASK, "victim_relative_named", text)
    text = sub(CHILD_NAMED, lambda m: m.group(1) + MASK, "protected_child_named", text)
    text = sub(PHONE, MASK, "phone", text)
    text = sub(EMAIL, MASK, "email", text)
    # PAN and IFSC are shape-only patterns and Indian case numbers share those
    # shapes: WPCT0123456 is an IFSC by shape, ABCDE1234F is a PAN by shape.
    # Masking those corrupts the statutory text, which is a worse outcome than
    # the residual risk, so both require a nearby context word.
    text = _masked_in_context(text, PAN, PAN_CONTEXT, "pan", counts)
    text = _masked_in_context(text, IFSC, IFSC_CONTEXT, "ifsc", counts)
    # Verhoeff alone passes roughly 1 in 10 random 12-digit strings, and the
    # corpus is full of 12-digit case and FIR numbers. Measured across the live
    # corpus, every 12-digit hit was an identifier of that kind and none was a
    # real Aadhaar number, so a context word is required as well.
    text = _masked_in_context(
        text, AADHAAR_SHAPE, AADHAAR_CONTEXT, "aadhaar", counts,
        extra=is_aadhaar,
    )
    return text, counts
