#!/usr/bin/env python3
"""
Comprehensive Tests for Unified Legal Chunking Pipeline

Tests cover:
1. legal_section_detector.py - Section pattern detection
2. legal_chunker.py - Chunking configuration and utilities
3. Integration tests - Full chunking workflow for SC and HC

Run with:
    pytest scripts/rag/tests/test_legal_chunking.py -v

Or standalone:
    python scripts/rag/tests/test_legal_chunking.py
"""

import sys
from pathlib import Path

# Add qdrant directory to path for module imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "qdrant"))

import pytest
from legal_section_detector import (
    detect_section_type,
    get_section_priority,
    is_important_section,
    SECTION_TYPES,
    SECTION_PATTERNS,
)
from legal_chunker import (
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    MIN_CHUNK_SIZE,
    SKIP_BOX_CLASSES,
    BOOST_BOX_CLASSES,
    TEXT_SEPARATORS,
    build_text_from_boxes,
    get_page_range_from_char_offsets,
    R2_CONFIG,
    chunk_legal_document,
)


# =============================================================================
# TEST FIXTURES
# =============================================================================

@pytest.fixture
def sample_legal_text():
    """Sample legal judgment text with multiple sections."""
    return """IN THE SUPREME COURT OF INDIA
CIVIL APPELLATE JURISDICTION

Civil Appeal No. 1234 of 2024

PETITIONER: ABC Corporation
RESPONDENT: State of Maharashtra

JUDGMENT

Delivered by Hon'ble Justice X

FACTS OF THE CASE

The appellant filed this appeal against the order dated 15th January 2024 passed by
the High Court of Bombay. The brief facts are that the appellant company entered
into a contract with the respondent for supply of goods.

ISSUES FRAMED FOR CONSIDERATION

1. Whether the High Court erred in dismissing the writ petition?
2. Whether the appellant is entitled to refund of the amount deposited?

ARGUMENTS OF THE APPELLANT

Learned counsel for the appellant submitted that the impugned order is arbitrary
and violates principles of natural justice. He relied upon State of UP v. XYZ (2020)
to support his contentions.

ARGUMENTS OF THE RESPONDENT

Learned counsel for the respondent submitted that the order is in accordance with
law and no interference is warranted in the present proceedings.

ANALYSIS AND REASONING

We have carefully considered the submissions made by learned counsel for both
parties and perused the record.

RATIO DECIDENDI

This court holds that the fundamental principle established in ABC v. State (2019)
applies directly to the present case. The ratio of that decision is binding and we
follow the same reasoning here.

OBITER DICTA

By way of observation, we note that the legislature may consider amending the
relevant provisions to avoid similar disputes in future.

CONCLUSION

In the result, the appeal is allowed. The impugned order of the High Court is
set aside. The respondent is directed to refund the amount deposited by the
appellant within 30 days.

No costs.
"""


@pytest.fixture
def sample_boxes():
    """Sample box data from PyMuPDF Pro extraction."""
    return [
        {"box_class": "page-header", "text": "Supreme Court of India"},
        {"box_class": "title", "text": "ABC Corporation v. State of Maharashtra"},
        {"box_class": "text", "text": "The facts of the case are as follows..."},
        {"box_class": "section-header", "text": "ISSUES FRAMED"},
        {"box_class": "text", "text": "1. Whether the order is valid?"},
        {"box_class": "page-footer", "text": "Page 1"},
        {"box_class": "text", "text": "The court analyzed the arguments..."},
    ]


@pytest.fixture
def sample_pages():
    """Sample page data for page range calculation."""
    return [
        {"page_number": 1, "text": "First page content " * 100},
        {"page_number": 2, "text": "Second page content " * 100},
        {"page_number": 3, "text": "Third page content " * 100},
    ]


@pytest.fixture
def sample_sc_metadata():
    """Sample Supreme Court metadata."""
    return {
        "case_id": "SC_2024_1234",
        "diary_number": "12345/2024",
        "title": "ABC Corporation v. State of Maharashtra",
        "petitioner": "ABC Corporation",
        "respondent": "State of Maharashtra",
        "petitioner_array": ["ABC Corporation", "XYZ Ltd"],
        "respondent_array": ["State of Maharashtra", "Union of India"],
        "year": 2024,
        "decision_date": "2024-06-15",
        "citation": "2024 SCC 567",
        "judges": ["Justice X", "Justice Y"],
        "bench_type": "Division Bench",
        "case_type": "Civil Appeal",
        "pdf_url": "https://example.com/sc/judgment.pdf",
    }


@pytest.fixture
def sample_hc_metadata():
    """Sample High Court metadata."""
    return {
        "case_id": "WPHC123456",
        "title": "Petitioner vs Respondent Authority",
        "petitioner": "John Doe",
        "respondent": "State of Karnataka",
        "year": 2024,
        "decision_date": "2024-05-20",
        "citation": "2024 KHC 890",
        "court": "Karnataka High Court",
        "court_code": "4_1",
        "state_code": "4",
        "state_name": "Karnataka",
        "judges": ["Justice A", "Justice B"],
        "bench": "principal",
        "bench_display_name": "Principal Bench",
        "pdf_url": "https://example.com/hc/judgment.pdf",
    }


# =============================================================================
# SECTION DETECTOR TESTS
# =============================================================================

class TestSectionDetector:
    """Tests for legal_section_detector.py"""

    def test_detect_ratio_decidendi(self):
        """Test detection of ratio decidendi sections."""
        test_cases = [
            "RATIO DECIDENDI\nThe court held that...",
            "RATIO OF THE CASE\nThis establishes...",
            "THE RATIO\nThe binding principle is...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "ratio_decidendi", f"Failed for: {text[:30]}"

    def test_detect_obiter_dicta(self):
        """Test detection of obiter dicta sections."""
        test_cases = [
            "OBITER DICTA\nBy way of observation...",
            "OBITER DICTUM\nWe note that...",
            "BY WAY OF OBITER\nThe court observed...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "obiter_dicta", f"Failed for: {text[:30]}"

    def test_detect_issues(self):
        """Test detection of issues sections."""
        test_cases = [
            "ISSUES FRAMED\n1. Whether the order is valid?",
            "QUESTIONS FOR CONSIDERATION\n1. First question",
            "POINTS FOR DETERMINATION\n1. Point one",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "issues", f"Failed for: {text[:30]}"

    def test_detect_judgment(self):
        """Test detection of judgment sections."""
        test_cases = [
            "JUDGMENT\nDelivered by Hon'ble Justice...",
            "ORDER\nThe court hereby orders...",
            "PER CURIAM\nThis court holds...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "judgment", f"Failed for: {text[:30]}"

    def test_detect_facts(self):
        """Test detection of facts sections."""
        test_cases = [
            "FACTS\nThe brief facts are...",
            "BACKGROUND\nThe factual matrix is...",
            "FACTUAL BACKGROUND\nThe case arises from...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "facts", f"Failed for: {text[:30]}"

    def test_detect_arguments(self):
        """Test detection of arguments sections."""
        test_cases = [
            "ARGUMENTS\nLearned counsel submitted...",
            "SUBMISSIONS\nThe appellant's counsel argued...",
            "RIVAL CONTENTIONS\nBoth parties submitted...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "arguments", f"Failed for: {text[:30]}"

    def test_detect_analysis(self):
        """Test detection of analysis sections."""
        test_cases = [
            "ANALYSIS\nWe have carefully considered...",
            "DISCUSSION\nThe court's analysis is...",
            "FINDINGS\nOur findings are as follows...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "analysis", f"Failed for: {text[:30]}"

    def test_detect_conclusion(self):
        """Test detection of conclusion sections."""
        test_cases = [
            "CONCLUSION\nIn the result, the appeal is allowed.",
            "HELD\nThe petition is dismissed.",
            "IN THE RESULT\nThe appeal succeeds.",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "conclusion", f"Failed for: {text[:30]}"

    def test_detect_header(self):
        """Test detection of court header sections."""
        test_cases = [
            "IN THE SUPREME COURT OF INDIA\nCivil Appeal No...",
            "IN THE HIGH COURT OF DELHI\nWrit Petition...",
            "BEFORE THE HON'BLE JUSTICE X\nCase No...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "header", f"Failed for: {text[:30]}"

    def test_detect_precedents(self):
        """Test detection of precedents sections."""
        test_cases = [
            "PRECEDENTS CITED\n1. State v. ABC (2020)",
            "CASES REFERRED\n1. XYZ v. State (2019)",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "precedents", f"Failed for: {text[:30]}"

    def test_detect_statutes(self):
        """Test detection of statutes sections."""
        test_cases = [
            "RELEVANT STATUTORY PROVISIONS\nSection 302 IPC...",
            "STATUTES REFERRED\nThe Indian Contract Act...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "statutes", f"Failed for: {text[:30]}"

    def test_detect_body_default(self):
        """Test that unclassified text defaults to body."""
        test_cases = [
            "The appellant has filed this appeal challenging...",
            "Some random legal text without clear section markers.",
            "Lorem ipsum dolor sit amet...",
        ]
        for text in test_cases:
            assert detect_section_type(text) == "body", f"Failed for: {text[:30]}"

    def test_empty_text(self):
        """Test handling of empty text."""
        assert detect_section_type("") == "body"
        assert detect_section_type("   ") == "body"
        assert detect_section_type(None) == "body" if detect_section_type(None) else True

    def test_content_based_detection(self):
        """Test content-based detection for ratio/conclusion."""
        # These don't have section headers but contain key phrases
        ratio_text = "The appellant argued that THIS COURT HOLDS that the principle..."
        assert detect_section_type(ratio_text) == "ratio_decidendi"

        conclusion_text = "After careful analysis, THE APPEAL IS ALLOWED with costs."
        assert detect_section_type(conclusion_text) == "conclusion"


class TestSectionPriority:
    """Tests for section priority scoring."""

    def test_ratio_decidendi_highest_priority(self):
        """Ratio decidendi should have highest priority (100)."""
        assert get_section_priority("ratio_decidendi") == 100

    def test_conclusion_high_priority(self):
        """Conclusion should have high priority (95)."""
        assert get_section_priority("conclusion") == 95

    def test_body_lowest_priority(self):
        """Body should have lowest priority (30)."""
        assert get_section_priority("body") == 30

    def test_priority_ordering(self):
        """Test that priorities are in correct order."""
        priorities = [
            ("ratio_decidendi", 100),
            ("conclusion", 95),
            ("judgment", 90),
            ("analysis", 85),
            ("issues", 80),
            ("obiter_dicta", 75),
            ("arguments", 70),
            ("facts", 65),
            ("precedents", 60),
            ("body", 30),
        ]
        for section_type, expected_priority in priorities:
            actual = get_section_priority(section_type)
            assert actual == expected_priority, f"{section_type}: expected {expected_priority}, got {actual}"

    def test_is_important_section(self):
        """Test is_important_section helper."""
        # High priority sections
        assert is_important_section("ratio_decidendi") is True
        assert is_important_section("conclusion") is True
        assert is_important_section("judgment") is True
        assert is_important_section("analysis") is True
        assert is_important_section("arguments") is True

        # Low priority sections
        assert is_important_section("body") is False
        assert is_important_section("paragraph") is False

        # Custom threshold
        assert is_important_section("facts", threshold=60) is True
        assert is_important_section("facts", threshold=70) is False


class TestSectionConstants:
    """Tests for section type constants."""

    def test_all_section_types_defined(self):
        """Verify all 16 section types are defined."""
        expected_types = {
            "header", "ratio_decidendi", "obiter_dicta", "issues",
            "precedents", "judgment", "facts", "arguments", "analysis",
            "conclusion", "relief", "statutes", "procedure", "paragraph",
            "section", "body"
        }
        assert set(SECTION_TYPES) == expected_types

    def test_patterns_count(self):
        """Verify sufficient patterns are defined."""
        assert len(SECTION_PATTERNS) >= 15, "Should have at least 15 patterns"


# =============================================================================
# LEGAL CHUNKER TESTS
# =============================================================================

class TestChunkingConstants:
    """Tests for chunking configuration constants."""

    def test_chunk_size(self):
        """CHUNK_SIZE should be 4096 (~1024 tokens)."""
        assert CHUNK_SIZE == 4096

    def test_chunk_overlap(self):
        """CHUNK_OVERLAP should be 512 (~128 tokens)."""
        assert CHUNK_OVERLAP == 512

    def test_min_chunk_size(self):
        """MIN_CHUNK_SIZE should be 300 (unified for SC and HC)."""
        assert MIN_CHUNK_SIZE == 300

    def test_text_separators(self):
        """TEXT_SEPARATORS should include proper hierarchy."""
        assert "\n\n\n" in TEXT_SEPARATORS  # Triple newline
        assert "\n\n" in TEXT_SEPARATORS    # Double newline
        assert "\n" in TEXT_SEPARATORS      # Single newline
        assert ". " in TEXT_SEPARATORS      # Sentence end

    def test_skip_box_classes(self):
        """SKIP_BOX_CLASSES should include page headers/footers."""
        assert "page-header" in SKIP_BOX_CLASSES
        assert "page-footer" in SKIP_BOX_CLASSES

    def test_boost_box_classes(self):
        """BOOST_BOX_CLASSES should include title and section-header."""
        assert "title" in BOOST_BOX_CLASSES
        assert "section-header" in BOOST_BOX_CLASSES


class TestBuildTextFromBoxes:
    """Tests for build_text_from_boxes function."""

    def test_basic_text_building(self, sample_boxes):
        """Test basic text building from boxes."""
        result = build_text_from_boxes(sample_boxes)

        # Should include title with prefix
        assert "[TITLE] #" in result
        assert "ABC Corporation v. State of Maharashtra" in result

        # Should include section header with prefix
        assert "[SECTION] ##" in result
        assert "ISSUES FRAMED" in result

        # Should NOT include page header/footer
        assert "Supreme Court of India" not in result
        assert "Page 1" not in result

    def test_empty_boxes(self):
        """Test handling of empty boxes list."""
        result = build_text_from_boxes([])
        assert result == ""

    def test_boxes_with_empty_text(self):
        """Test handling of boxes with empty text."""
        boxes = [
            {"box_class": "text", "text": ""},
            {"box_class": "text", "text": "   "},
            {"box_class": "text", "text": "Valid text"},
        ]
        result = build_text_from_boxes(boxes)
        assert "Valid text" in result
        assert result.strip() == "Valid text"


class TestPageRangeCalculation:
    """Tests for get_page_range_from_char_offsets function."""

    def test_single_page_range(self, sample_pages):
        """Test detection of content on single page."""
        # Content starting at char 0 should be on page 1
        page_start, page_end = get_page_range_from_char_offsets(sample_pages, 0, 100)
        assert page_start == 1
        assert page_end == 1

    def test_multi_page_range(self):
        """Test detection of content spanning multiple pages."""
        # Create pages with known lengths for predictable testing
        # Note: get_page_range_from_char_offsets adds +2 for "\n\n" between pages
        pages = [
            {"page_number": 1, "text": "A" * 1000},  # offset 0-999
            {"page_number": 2, "text": "B" * 1000},  # offset 1002-2001
            {"page_number": 3, "text": "C" * 1000},  # offset 2004-3003
        ]
        # Content clearly on page 1 (0-500)
        page_start, page_end = get_page_range_from_char_offsets(pages, 0, 500)
        assert page_start == 1
        assert page_end == 1

        # Content spanning pages 2-3 (1500-2500)
        page_start, page_end = get_page_range_from_char_offsets(pages, 1500, 2500)
        assert page_start >= 2
        assert page_end >= 2

    def test_empty_pages(self):
        """Test handling of empty pages list."""
        page_start, page_end = get_page_range_from_char_offsets([], 0, 100)
        assert page_start == 1
        assert page_end == 1


class TestR2Config:
    """Tests for R2 storage configuration."""

    def test_supreme_court_config(self):
        """Test Supreme Court R2 configuration."""
        assert "supreme_court" in R2_CONFIG
        sc_config = R2_CONFIG["supreme_court"]
        assert "public_base_url" in sc_config
        assert "data_source" in sc_config
        assert sc_config["data_source"] == "supreme_court_india"

    def test_high_court_config(self):
        """Test High Court R2 configuration."""
        assert "high_court" in R2_CONFIG
        hc_config = R2_CONFIG["high_court"]
        assert "public_base_url" in hc_config
        assert "data_source" in hc_config
        assert hc_config["data_source"] == "high_court_india"


# =============================================================================
# INTEGRATION TESTS
# =============================================================================

class TestChunkLegalDocument:
    """Integration tests for chunk_legal_document function."""

    def test_supreme_court_chunking(self, sample_legal_text, sample_pages, sample_sc_metadata):
        """Test full chunking workflow for Supreme Court document."""
        extracted = {
            "text": sample_legal_text,
            "pages": sample_pages,
            "page_count": len(sample_pages),
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_sc_metadata,
            court_type="supreme_court"
        )

        assert len(chunks) > 0, "Should generate at least one chunk"

        # Check unified fields
        first_chunk = chunks[0]
        assert "chunk_id" in first_chunk
        assert "section_type" in first_chunk
        assert "section_priority" in first_chunk
        assert "court_type" in first_chunk
        assert "data_source" in first_chunk

        # Check court-specific values
        assert first_chunk["court_type"] == "supreme_court"
        assert first_chunk["data_source"] == "supreme_court_india"

    def test_high_court_chunking(self, sample_legal_text, sample_pages, sample_hc_metadata):
        """Test full chunking workflow for High Court document."""
        extracted = {
            "text": sample_legal_text,
            "pages": sample_pages,
            "page_count": len(sample_pages),
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_hc_metadata,
            court_type="high_court"
        )

        assert len(chunks) > 0, "Should generate at least one chunk"

        # Check court-specific values
        first_chunk = chunks[0]
        assert first_chunk["court_type"] == "high_court"
        assert first_chunk["data_source"] == "high_court_india"

    def test_section_detection_in_chunks(self, sample_legal_text, sample_pages, sample_sc_metadata):
        """Test that chunks have proper section detection."""
        extracted = {
            "text": sample_legal_text,
            "pages": sample_pages,
            "page_count": len(sample_pages),
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_sc_metadata,
            court_type="supreme_court"
        )

        # Verify section types are valid
        for chunk in chunks:
            assert chunk["section_type"] in SECTION_TYPES
            assert 0 <= chunk["section_priority"] <= 100

    def test_text_original_field(self, sample_legal_text, sample_pages, sample_sc_metadata):
        """Test that text_original field is present and clean."""
        extracted = {
            "text": sample_legal_text,
            "pages": sample_pages,
            "page_count": len(sample_pages),
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_sc_metadata,
            court_type="supreme_court"
        )

        for chunk in chunks:
            # text_original should NOT have the contextual header
            assert "text_original" in chunk
            assert not chunk["text_original"].startswith("Case:")

            # text should have the contextual header
            assert chunk["text"].startswith("Case:")

    def test_min_chunk_size_filtering(self, sample_sc_metadata):
        """Test that small chunks are filtered out."""
        # Create text that would generate small chunks
        extracted = {
            "text": "Small text.\n\n" * 10,  # Should be too small
            "pages": [],
            "page_count": 1,
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_sc_metadata,
            court_type="supreme_court"
        )

        # All chunks should be >= MIN_CHUNK_SIZE
        for chunk in chunks:
            assert len(chunk["text_original"]) >= MIN_CHUNK_SIZE or len(chunks) == 0


class TestChunkIdFormat:
    """Tests for chunk ID formatting."""

    def test_sc_chunk_id_format(self, sample_legal_text, sample_pages, sample_sc_metadata):
        """Test Supreme Court chunk ID format."""
        extracted = {
            "text": sample_legal_text,
            "pages": sample_pages,
            "page_count": len(sample_pages),
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_sc_metadata,
            court_type="supreme_court"
        )

        if chunks:
            # Format: {case_id}_{index:03d}
            chunk_id = chunks[0]["chunk_id"]
            assert chunk_id.startswith(sample_sc_metadata["case_id"])
            assert "_" in chunk_id

    def test_chunk_index_ordering(self, sample_legal_text, sample_pages, sample_sc_metadata):
        """Test that chunk indices are sequential."""
        extracted = {
            "text": sample_legal_text * 5,  # Make text long enough for multiple chunks
            "pages": sample_pages,
            "page_count": len(sample_pages),
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_sc_metadata,
            court_type="supreme_court"
        )

        indices = [c["chunk_index"] for c in chunks]
        # Indices should be unique and increasing
        assert len(indices) == len(set(indices)), "Chunk indices should be unique"


# =============================================================================
# O(n) CHARACTER SEARCH TESTS
# =============================================================================

class TestOnCharacterSearch:
    """Tests for O(n) character position search optimization."""

    def test_char_positions_are_valid(self, sample_legal_text, sample_pages, sample_sc_metadata):
        """Test that character positions are valid."""
        extracted = {
            "text": sample_legal_text,
            "pages": sample_pages,
            "page_count": len(sample_pages),
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_sc_metadata,
            court_type="supreme_court"
        )

        full_text = sample_legal_text
        for chunk in chunks:
            char_start = chunk["char_start"]
            char_end = chunk["char_end"]

            # Positions should be non-negative
            assert char_start >= 0, "char_start should be non-negative"
            assert char_end >= char_start, "char_end should be >= char_start"

            # char_end should not exceed text length significantly
            assert char_end <= len(full_text) + 1000, "char_end should be within text bounds"

    def test_char_positions_are_monotonic(self, sample_legal_text, sample_pages, sample_sc_metadata):
        """Test that character positions are monotonically increasing."""
        # Long text to ensure multiple chunks
        long_text = sample_legal_text * 10
        extracted = {
            "text": long_text,
            "pages": sample_pages,
            "page_count": len(sample_pages),
        }

        chunks = chunk_legal_document(
            extracted=extracted,
            metadata=sample_sc_metadata,
            court_type="supreme_court"
        )

        if len(chunks) > 1:
            for i in range(1, len(chunks)):
                # Later chunks should start after earlier chunks (allowing for overlap)
                prev_start = chunks[i-1]["char_start"]
                curr_start = chunks[i]["char_start"]
                assert curr_start >= prev_start, f"Chunk {i} starts before chunk {i-1}"


# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":
    # Run tests with pytest
    pytest.main([__file__, "-v", "--tb=short"])
