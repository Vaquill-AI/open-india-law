"""Repair the acts_india taxonomy on the way into a public release.

Three defects measured against live Qdrant on 2026-08-14. All are fixed here,
at export time, rather than by mutating the collection: the fix is then
reversible, reviewable in a diff, and does not risk a filtered write against a
19.6M-point single-shard instance.

1. `jurisdiction` and `category` are byte-identical.
       regulatory 554,354 | state 469,714 | central 74,509  (both fields)
   One of them is dead weight. Neither is published under its own name.

2. `jurisdiction` erases the jurisdiction of regulatory instruments.
   Every one of the 554,354 `jurisdiction=regulatory` provisions carries
   `state=central`, so they ARE central-jurisdiction material; the field just
   overwrites that with an instrument-kind label. Two axes are crushed into
   one, and the jurisdiction axis loses.

   Decomposed here into:
       jurisdiction     central (628,863) | state (469,714)
       instrument_type  legislation (544,223) | regulatory (554,354)

3. `act_status` has a fourth value, `superseded` (57,458), that downstream
   reporting does not know about. It sits entirely in central regulatory
   material - superseded RBI master directions and the like. Anything that
   buckets status into in_force/repealed/spent silently counts these as in
   force. `Vaquill-India-Coverage.xlsx` does exactly that: its Central row
   reports in_force 613,970, which is 556,512 genuinely in force plus these
   57,458. Publishing that as "in force" would misstate 9.4% of Central.
"""

from __future__ import annotations

from typing import Any

# The raw values `jurisdiction` / `category` take in acts_india.
_RAW_CENTRAL = "central"
_RAW_STATE = "state"
_RAW_REGULATORY = "regulatory"

#: `act_status` values that mean "this is the operative text today".
IN_FORCE_STATUSES = frozenset({"in_force"})

#: Values that mean the provision is no longer operative. `superseded` belongs
#: here, not with in_force. Kept explicit so a new status fails loudly below.
NOT_IN_FORCE_STATUSES = frozenset({"superseded", "repealed", "spent"})

KNOWN_STATUSES = IN_FORCE_STATUSES | NOT_IN_FORCE_STATUSES


class UnknownStatusError(ValueError):
    """An act_status value the taxonomy has never seen.

    Raised rather than defaulted: a silent default is how `superseded` came to
    be reported as in force in the first place.
    """


def derive_jurisdiction(payload: dict[str, Any]) -> str:
    """The real jurisdiction axis: central or state.

    `state` is the only trustworthy signal in the raw payload, and it holds the
    literal string "central" for central material.
    """
    state = (payload.get("state") or "").strip().lower()
    if not state:
        return ""
    return _RAW_CENTRAL if state == _RAW_CENTRAL else _RAW_STATE


def derive_instrument_type(payload: dict[str, Any]) -> str:
    """The kind axis that `jurisdiction` was smuggling: legislation or regulatory."""
    raw = (payload.get("jurisdiction") or payload.get("category") or "").strip().lower()
    return _RAW_REGULATORY if raw == _RAW_REGULATORY else "legislation"


def derive_state(payload: dict[str, Any]) -> str:
    """State name, empty for central material.

    Publishing `state="central"` invites a reader to treat "central" as a state.
    """
    state = (payload.get("state") or "").strip().lower()
    return "" if state in {"", _RAW_CENTRAL} else state


def is_in_force(payload: dict[str, Any]) -> bool:
    """Whether the provision is operative today.

    Raises on an unrecognised status rather than guessing.
    """
    status = (payload.get("act_status") or "").strip().lower()
    if status not in KNOWN_STATUSES:
        raise UnknownStatusError(
            f"unknown act_status {status!r}; classify it in IN_FORCE_STATUSES or "
            f"NOT_IN_FORCE_STATUSES before publishing. Known: {sorted(KNOWN_STATUSES)}"
        )
    return status in IN_FORCE_STATUSES


def repair(payload: dict[str, Any]) -> dict[str, Any]:
    """Return the taxonomy fields a published record should carry.

    `category` is deliberately absent: it is a byte-identical copy of
    `jurisdiction` and carries no information of its own.
    """
    return {
        "jurisdiction": derive_jurisdiction(payload),
        "state": derive_state(payload),
        "instrument_type": derive_instrument_type(payload),
        "act_status": (payload.get("act_status") or "").strip().lower(),
        "in_force": is_in_force(payload),
    }
