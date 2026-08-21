"""Pin the redaction pass. Every case below is real text from the corpus.

Each class documents a bug found while writing this. They are regression pins,
not hypotheticals.
"""

from __future__ import annotations

from scripts.release.redaction import excluded, is_aadhaar, redact


class TestNameCaptureStopsAtTheName:
    """re.IGNORECASE made [A-Z] match lowercase, so the capture ran past the
    name and swallowed the rest of the sentence."""

    def test_masks_the_child_but_not_the_following_words(self) -> None:
        out, counts = redact("child in conflict with law namely Ajay Murmu was produced")
        assert out == "child in conflict with law namely [REDACTED] was produced"
        assert counts == {"protected_child_named": 1}

    def test_masks_the_relative_but_keeps_the_role_word(self) -> None:
        out, _ = redact("lodged by mother of the prosecutrix namely Smt. Meena Singh on 3.4.2019")
        assert "prosecutrix namely [REDACTED]" in out
        assert "Meena" not in out
        assert "on 3.4.2019" in out


class TestNegatedInCameraIsNotExcluded:
    """The guard was a forward-only lookahead, so a negation BEFORE the phrase
    ("the trial was not in camera") still excluded the document."""

    def test_a_real_direction_is_excluded(self) -> None:
        assert excluded("the matter was heard in camera as directed") is True

    def test_a_negated_mention_is_not_excluded(self) -> None:
        assert excluded("the trial was not in camera") is False
        assert excluded("it was never in camera") is False

    def test_ordinary_text_is_not_excluded(self) -> None:
        assert excluded("ordinary civil appeal against the decree") is False


class TestAadhaarCountingIsHonest:
    """subn() counts matches the callback left unchanged, so every 12-digit case
    id inflated the reported Aadhaar count. The corpus contains no real Aadhaar
    numbers; a wrong count would have implied otherwise on the dataset card."""

    def test_case_ids_and_fir_numbers_are_not_counted(self) -> None:
        out, counts = redact("the appellant in APHC010572462018 filed under FIR No.RC023201850012")
        assert counts == {}
        assert "APHC010572462018" in out

    def test_verhoeff_rejects_a_non_aadhaar(self) -> None:
        assert is_aadhaar("123456789012") is False


class TestPhoneNumbers:
    def test_masks_a_contact_number_in_a_cause_title(self) -> None:
        out, counts = redact("SECRETARY SMT. ROSELY THOMAS, CONTACT-9447091300.")
        assert "9447091300" not in out
        assert counts == {"phone": 1}

    def test_leaves_a_pin_code_alone(self) -> None:
        out, counts = redact("District Korba, Chhattisgarh Pin 495449")
        assert "495449" in out
        assert counts == {}


class TestNoStatuteCategoryExclusion:
    """Courts anonymize victims in the large majority of cases: anonymization
    markers outnumber victim-naming 18:1 in the POCSO subset. Excluding by
    statute category would drop ~180,000 judgments that are lawful to publish."""

    def test_a_properly_anonymized_pocso_judgment_survives(self) -> None:
        text = "conviction under the POCSO Act; the prosecutrix deposed that the accused"
        assert excluded(text) is False
        out, counts = redact(text)
        assert out == text
        assert counts == {}


class TestCitationVsFurniture:
    """Indian courts cite Manupatra, SCC OnLine and AIR in their own judgments.

    Measured over 19,991 documents: 1.14% carry a reporter citation and must be
    kept, 0.01% carry a third-party site's print-view furniture and must be
    dropped because the document was not sourced from the court. A brand-name
    gate cannot tell those apart and would refuse the corpus.
    """

    def test_a_judgment_citing_manupatra_is_kept(self) -> None:
        text = "reported in Manupatra - MANU/TN/1707/2010 - W.P.No.15272 of 2009"
        assert excluded(text) is False

    def test_a_neutral_scc_online_citation_is_kept(self) -> None:
        assert excluded("1968 SCC OnLine Ker 101: AIR 1969 Ker 316, approved") is False

    def test_print_view_furniture_is_dropped(self) -> None:
        text = ("Shayara Bano vs Union Of India on 22 August, 2017\n"
                "Indian Kanoon - http://indiankanoon.org/doc/115701246/239")
        assert excluded(text) is True

    def test_cite_this_article_chrome_is_dropped(self) -> None:
        assert excluded("Cite this article: Smith v Jones") is True
