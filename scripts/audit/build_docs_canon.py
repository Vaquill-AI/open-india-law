"""Canonical court-name mapping shared by the extraction and doc-build steps."""

from __future__ import annotations

# Verbatim from COURT_NAME_VARIANTS in app/integrations/corpus_qdrant.py,
# the same map the retrieval layer uses to reconcile dirty court labels.
FROM_CODEBASE: dict[str, str] = {
    "High Court of Allahabad": "Allahabad High Court",
    "High Court of Andhra Pradesh": "Andhra Pradesh High Court",
    "High Court of Amaravati": "Andhra Pradesh High Court",
    "High Court of Bombay": "Bombay High Court",
    "High Court of Calcutta": "Calcutta High Court",
    "High Court Of Chhattisgarh": "Chhattisgarh High Court",
    "High Court of Chhattisgarh": "Chhattisgarh High Court",
    "High Court of Delhi": "Delhi High Court",
    "High Court of Gauhati": "Gauhati High Court",
    "High Court of Gujarat": "Gujarat High Court",
    "High Court of Himachal Pradesh": "Himachal Pradesh High Court",
    "High Court of Jammu and Kashmir": "Jammu & Kashmir High Court",
    "High Court of Jharkhand": "Jharkhand High Court",
    "High Court of Karnataka": "Karnataka High Court",
    "High Court of Kerala": "Kerala High Court",
    "High Court of Madhya Pradesh": "Madhya Pradesh High Court",
    "High Court of Madras": "Madras High Court",
    "High Court of Manipur": "Manipur High Court",
    "High Court of Meghalaya": "Meghalaya High Court",
    "High Court of Orissa": "Orissa High Court",
    "High Court of Patna": "Patna High Court",
    "High Court of Punjab and Haryana": "Punjab and Haryana High Court",
    "High Court of Haryana": "Punjab and Haryana High Court",
    "High Court Of Rajasthan": "Rajasthan High Court",
    "High Court of Rajasthan": "Rajasthan High Court",
    "High Court of Sikkim": "Sikkim High Court",
    "High Court  for State of Telangana": "Telangana High Court",
    "High Court of Telangana": "Telangana High Court",
    "High Court of Hyderabad": "Telangana High Court",
    "High Court of Tripura": "Tripura High Court",
    "High Court of Uttarakhand": "Uttarakhand High Court",
}

# Seat and city spellings present in Qdrant that the codebase map does not
# cover. Resolved for this report only, and listed separately in
# case-law/court-name-variants.md so the inference stays visible.
INFERRED: dict[str, str] = {
    "High Court of Mumbai": "Bombay High Court",
    "High Court of Nagpur": "Bombay High Court",
    "High Court of Aurangabad": "Bombay High Court",
    "High Court of Jabalpur": "Madhya Pradesh High Court",
    "High Court of Chennai": "Madras High Court",
    "High Court of Andhra": "Andhra Pradesh High Court",
    "High Court of Guwahati": "Gauhati High Court",
    "High Court of Kashmir": "Jammu & Kashmir High Court",
    "High Court of Chandigarh": "Punjab and Haryana High Court",
}

UNRESOLVED_LABEL = "(unresolved court label)"
UNRESOLVED = {"High Court"}

CANON: dict[str, str] = {**FROM_CODEBASE, **INFERRED}


def canonical(raw: str) -> str:
    """Map a raw Qdrant `court` payload value to a canonical court name."""
    if raw in CANON:
        return CANON[raw]
    if raw in UNRESOLVED:
        return UNRESOLVED_LABEL
    return raw
