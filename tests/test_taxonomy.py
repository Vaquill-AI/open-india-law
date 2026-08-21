"""Pin the acts_india taxonomy repair applied at release time.

The counts below were measured against live Qdrant on 2026-08-14 and are quoted
so a future reader can tell an intentional corpus change from a regression in
this module.
"""

from __future__ import annotations

import pytest

from scripts.release.taxonomy import (
    IN_FORCE_STATUSES,
    KNOWN_STATUSES,
    NOT_IN_FORCE_STATUSES,
    UnknownStatusError,
    derive_instrument_type,
    derive_jurisdiction,
    derive_state,
    is_in_force,
    repair,
)


class TestJurisdictionIsNoLongerErased:
    """Defect 2: all 554,354 jurisdiction=regulatory provisions are state=central.

    The raw field labels them "regulatory", losing the fact that they are
    central-jurisdiction material.
    """

    def test_regulatory_instrument_is_recognised_as_central(self) -> None:
        payload = {"jurisdiction": "regulatory", "category": "regulatory", "state": "central"}
        assert derive_jurisdiction(payload) == "central"

    def test_regulatory_kind_survives_on_its_own_axis(self) -> None:
        payload = {"jurisdiction": "regulatory", "category": "regulatory", "state": "central"}
        assert derive_instrument_type(payload) == "regulatory"

    def test_central_legislation_is_central_and_legislation(self) -> None:
        payload = {"jurisdiction": "central", "category": "central", "state": "central"}
        assert derive_jurisdiction(payload) == "central"
        assert derive_instrument_type(payload) == "legislation"

    def test_state_legislation_keeps_its_state(self) -> None:
        payload = {"jurisdiction": "state", "category": "state", "state": "maharashtra"}
        assert derive_jurisdiction(payload) == "state"
        assert derive_state(payload) == "maharashtra"
        assert derive_instrument_type(payload) == "legislation"

    def test_central_is_not_published_as_a_state(self) -> None:
        """`state="central"` would read as a state named Central."""
        assert derive_state({"state": "central"}) == ""


class TestSupersededIsNotInForce:
    """Defect 3: `superseded` (57,458 provisions) is a real fourth status.

    Vaquill-India-Coverage.xlsx reports Central in_force as 613,970, which is
    556,512 genuinely in force plus these 57,458. Anything that buckets status
    into three values misstates 9.4% of Central.
    """

    def test_superseded_is_not_in_force(self) -> None:
        assert is_in_force({"act_status": "superseded"}) is False

    @pytest.mark.parametrize("status", ["repealed", "spent", "superseded"])
    def test_non_operative_statuses_are_not_in_force(self, status: str) -> None:
        assert is_in_force({"act_status": status}) is False

    def test_in_force_is_in_force(self) -> None:
        assert is_in_force({"act_status": "in_force"}) is True

    def test_superseded_is_classified_not_merely_tolerated(self) -> None:
        assert "superseded" in NOT_IN_FORCE_STATUSES
        assert "superseded" not in IN_FORCE_STATUSES

    def test_the_four_measured_statuses_are_all_known(self) -> None:
        """Live facet on acts_india, 2026-08-14, summing to 1,098,577."""
        measured = {"in_force": 1_026_226, "superseded": 57_458, "repealed": 14_609, "spent": 284}
        assert sum(measured.values()) == 1_098_577
        assert set(measured) == KNOWN_STATUSES

    def test_unknown_status_raises_rather_than_defaulting(self) -> None:
        """A silent default is how superseded came to be counted as in force."""
        with pytest.raises(UnknownStatusError, match="unknown act_status"):
            is_in_force({"act_status": "omitted"})

    def test_missing_status_also_raises(self) -> None:
        with pytest.raises(UnknownStatusError):
            is_in_force({})


class TestCategoryIsDropped:
    """Defect 1: `category` is a byte-identical copy of `jurisdiction`."""

    def test_repair_does_not_emit_category(self) -> None:
        payload = {
            "jurisdiction": "state",
            "category": "state",
            "state": "kerala",
            "act_status": "in_force",
        }
        assert "category" not in repair(payload)

    def test_repair_falls_back_to_category_when_jurisdiction_absent(self) -> None:
        """They are identical, so either can carry the instrument-kind signal."""
        payload = {"category": "regulatory", "state": "central", "act_status": "in_force"}
        assert repair(payload)["instrument_type"] == "regulatory"


class TestRepairShape:
    def test_repair_emits_the_published_taxonomy_fields(self) -> None:
        payload = {
            "jurisdiction": "regulatory",
            "category": "regulatory",
            "state": "central",
            "act_status": "superseded",
        }
        assert repair(payload) == {
            "jurisdiction": "central",
            "state": "",
            "instrument_type": "regulatory",
            "act_status": "superseded",
            "in_force": False,
        }

    def test_measured_totals_decompose_onto_two_clean_axes(self) -> None:
        """Live facet counts, 2026-08-14.

        Raw `jurisdiction`: regulatory 554,354 | state 469,714 | central 74,509.
        Raw `state=central`: 628,863 == 74,509 + 554,354, which is the proof
        that regulatory material is central-jurisdiction.
        """
        raw_central, raw_state, raw_regulatory = 74_509, 469_714, 554_354
        assert raw_central + raw_state + raw_regulatory == 1_098_577

        jurisdiction_central = raw_central + raw_regulatory
        assert jurisdiction_central == 628_863  # matches facet on state=central
        assert jurisdiction_central + raw_state == 1_098_577

        instrument_legislation = raw_central + raw_state
        assert instrument_legislation + raw_regulatory == 1_098_577
