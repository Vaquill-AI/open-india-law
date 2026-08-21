#!/usr/bin/env python3
"""
E2E Tests for Legal RAG Chunking Pipeline

Tests the complete chunking pipeline for:
1. Supreme Court judgments (100 random English PDFs)
2. High Court judgments (from local extracted files)

DOES NOT test:
- Qdrant embedding/ingestion
- API endpoints

Run with:
    cd scripts/rag
    pytest tests/test_e2e_chunking.py -v --tb=short

    # Run specific test class
    pytest tests/test_e2e_chunking.py::TestSupremeCourtChunking -v

    # Run with coverage
    pytest tests/test_e2e_chunking.py -v --cov=. --cov-report=term-missing
"""

import json
import os
import random
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import pytest

# Add qdrant and highcourt directories to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "qdrant"))
sys.path.insert(0, str(Path(__file__).parent.parent / "highcourt"))

# Import modules to test
from legal_section_detector import (
    detect_section_type,
    get_section_priority,
    is_important_section,
    SECTION_TYPES,
)
from legal_chunker import (
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    MIN_CHUNK_SIZE,
    TEXT_SEPARATORS,
    build_text_from_boxes,
    get_page_range_from_char_offsets,
    R2_CONFIG,
)

# =============================================================================
# TEST CONFIGURATION
# =============================================================================

# Paths (relative to project root)
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
DATA_DIR = PROJECT_ROOT / "data"
SC_METADATA_PATH = DATA_DIR / "aws-supreme-court-judgments/extracted/metadata/all_cases.jsonl"
SC_PDF_DIR = DATA_DIR / "aws-supreme-court-judgments/extracted/pdf/english"
HC_EXTRACTED_DIR = DATA_DIR / "highcourt-rag/extracted"

# Test parameters
NUM_SC_PDFS_TO_TEST = 100  # Number of random SC PDFs to test
NUM_HC_FILES_TO_TEST = 10  # Number of HC extracted files to test
MAX_PDF_SIZE_MB = 50  # Skip PDFs larger than this (memory safety)


@dataclass
class ChunkValidationResult:
    """Result of chunk validation."""
    valid: bool
    errors: List[str]
    warnings: List[str]
    stats: Dict


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def load_sc_metadata(limit: Optional[int] = None) -> List[Dict]:
    """Load Supreme Court case metadata."""
    if not SC_METADATA_PATH.exists():
        pytest.skip(f"SC metadata not found at {SC_METADATA_PATH}")

    cases = []
    with open(SC_METADATA_PATH, "r") as f:
        for i, line in enumerate(f):
            if limit and i >= limit:
                break
            cases.append(json.loads(line))
    return cases


def get_random_english_pdfs(n: int = 100) -> List[Tuple[str, Path]]:
    """Get N random English SC PDFs with their case IDs."""
    if not SC_PDF_DIR.exists():
        pytest.skip(f"SC PDF directory not found at {SC_PDF_DIR}")

    # Find all English PDFs
    all_pdfs = list(SC_PDF_DIR.rglob("*_EN.pdf"))
    if len(all_pdfs) == 0:
        pytest.skip("No English PDFs found")

    # Random sample
    sample_size = min(n, len(all_pdfs))
    selected = random.sample(all_pdfs, sample_size)

    # Extract case IDs from paths
    # Pattern: pdf/english/{year}/{path}_EN.pdf -> case_id from metadata
    result = []
    for pdf_path in selected:
        # Check file size
        size_mb = pdf_path.stat().st_size / (1024 * 1024)
        if size_mb > MAX_PDF_SIZE_MB:
            continue

        # Extract path component for matching
        # e.g., 2013_1_1053_1069_EN.pdf -> path is 2013_1_1053_1069
        stem = pdf_path.stem.replace("_EN", "")
        result.append((stem, pdf_path))

    return result[:n]


def get_hc_extracted_files(n: int = 10) -> List[Path]:
    """Get N High Court extracted JSON files."""
    if not HC_EXTRACTED_DIR.exists():
        pytest.skip(f"HC extracted directory not found at {HC_EXTRACTED_DIR}")

    files = list(HC_EXTRACTED_DIR.glob("*.extracted.json"))
    if len(files) == 0:
        pytest.skip("No HC extracted files found")

    return files[:n]


def validate_chunk_schema(chunk: Dict, court_type: str = "supreme_court") -> ChunkValidationResult:
    """Validate a single chunk against the unified schema."""
    errors = []
    warnings = []

    # === REQUIRED FIELDS (All Courts) ===
    required_fields = [
        "chunk_id", "case_id", "doc_id", "text", "title",
        "pdf_url", "char_start", "char_end", "page_start", "page_end",
        "chunk_index", "total_chunks", "section_type", "section_priority",
        "citation", "case_number", "year", "decision_date", "court",
        "petitioner", "respondent", "judges", "bench_strength", "disposition",
        "court_type", "data_source"
    ]

    for field in required_fields:
        if field not in chunk:
            errors.append(f"Missing required field: {field}")

    # === FIELD TYPE VALIDATION ===
    if "chunk_id" in chunk and not isinstance(chunk["chunk_id"], str):
        errors.append(f"chunk_id must be string, got {type(chunk['chunk_id'])}")

    if "text" in chunk:
        if not isinstance(chunk["text"], str):
            errors.append(f"text must be string, got {type(chunk['text'])}")
        elif len(chunk["text"]) < 50:
            warnings.append(f"text is very short: {len(chunk['text'])} chars")

    if "char_start" in chunk and "char_end" in chunk:
        if chunk["char_start"] > chunk["char_end"]:
            errors.append(f"char_start ({chunk['char_start']}) > char_end ({chunk['char_end']})")
        if chunk["char_start"] < 0:
            errors.append(f"char_start is negative: {chunk['char_start']}")

    if "page_start" in chunk and "page_end" in chunk:
        if chunk["page_start"] > chunk["page_end"]:
            errors.append(f"page_start ({chunk['page_start']}) > page_end ({chunk['page_end']})")
        if chunk["page_start"] < 1:
            warnings.append(f"page_start is less than 1: {chunk['page_start']}")

    if "section_type" in chunk:
        if chunk["section_type"] not in SECTION_TYPES:
            warnings.append(f"Unknown section_type: {chunk['section_type']}")

    if "section_priority" in chunk:
        if not isinstance(chunk["section_priority"], int):
            errors.append(f"section_priority must be int, got {type(chunk['section_priority'])}")
        elif chunk["section_priority"] < 0 or chunk["section_priority"] > 100:
            errors.append(f"section_priority out of range [0, 100]: {chunk['section_priority']}")

    if "judges" in chunk and not isinstance(chunk["judges"], list):
        errors.append(f"judges must be list, got {type(chunk['judges'])}")

    if "year" in chunk and chunk["year"]:
        if not isinstance(chunk["year"], int):
            errors.append(f"year must be int, got {type(chunk['year'])}")
        elif chunk["year"] < 1900 or chunk["year"] > 2030:
            warnings.append(f"year out of expected range: {chunk['year']}")

    # === COURT-SPECIFIC VALIDATION ===
    if court_type == "supreme_court":
        sc_fields = ["language_code", "pdf_urls"]
        for field in sc_fields:
            if field not in chunk:
                warnings.append(f"Missing SC-specific field: {field}")

    elif court_type == "high_court":
        hc_fields = ["state_code", "court_code", "bench"]
        for field in hc_fields:
            if field not in chunk:
                warnings.append(f"Missing HC-specific field: {field}")

    # === TEXT_ORIGINAL VALIDATION ===
    if "text_original" in chunk:
        if not isinstance(chunk["text_original"], str):
            errors.append(f"text_original must be string, got {type(chunk['text_original'])}")
        # text_original should not contain contextual header
        if chunk["text_original"].startswith("Case:"):
            warnings.append("text_original appears to contain contextual header")
    else:
        warnings.append("text_original field missing (needed for dense embeddings)")

    # Compute stats
    stats = {
        "text_length": len(chunk.get("text", "")),
        "section_type": chunk.get("section_type", "unknown"),
        "section_priority": chunk.get("section_priority", 0),
        "page_span": chunk.get("page_end", 0) - chunk.get("page_start", 0) + 1 if chunk.get("page_start") else 0,
    }

    return ChunkValidationResult(
        valid=len(errors) == 0,
        errors=errors,
        warnings=warnings,
        stats=stats
    )


def validate_chunks(chunks: List[Dict], court_type: str = "supreme_court") -> Tuple[bool, Dict]:
    """Validate a list of chunks and return aggregate results."""
    all_errors = []
    all_warnings = []
    stats = {
        "total_chunks": len(chunks),
        "valid_chunks": 0,
        "invalid_chunks": 0,
        "total_text_length": 0,
        "avg_chunk_size": 0,
        "section_distribution": {},
        "important_sections": 0,
    }

    for i, chunk in enumerate(chunks):
        result = validate_chunk_schema(chunk, court_type)
        if result.valid:
            stats["valid_chunks"] += 1
        else:
            stats["invalid_chunks"] += 1
            for err in result.errors:
                all_errors.append(f"Chunk {i}: {err}")

        all_warnings.extend(result.warnings)
        stats["total_text_length"] += result.stats.get("text_length", 0)

        # Track section distribution
        section = result.stats.get("section_type", "unknown")
        stats["section_distribution"][section] = stats["section_distribution"].get(section, 0) + 1

        # Count important sections
        if is_important_section(section):
            stats["important_sections"] += 1

    if stats["total_chunks"] > 0:
        stats["avg_chunk_size"] = stats["total_text_length"] // stats["total_chunks"]

    return len(all_errors) == 0, {
        "valid": len(all_errors) == 0,
        "errors": all_errors,
        "warnings": all_warnings,
        "stats": stats
    }


# =============================================================================
# TEST FIXTURES
# =============================================================================

@pytest.fixture(scope="module")
def sc_metadata():
    """Load SC metadata once for all tests."""
    return load_sc_metadata()


@pytest.fixture(scope="module")
def random_sc_pdfs():
    """Get random SC PDFs for testing."""
    return get_random_english_pdfs(NUM_SC_PDFS_TO_TEST)


@pytest.fixture(scope="module")
def hc_extracted_files():
    """Get HC extracted files for testing."""
    return get_hc_extracted_files(NUM_HC_FILES_TO_TEST)


# =============================================================================
# SUPREME COURT E2E TESTS
# =============================================================================

class TestSupremeCourtChunking:
    """E2E tests for Supreme Court chunking pipeline."""

    def test_metadata_loading(self, sc_metadata):
        """Test that SC metadata loads correctly."""
        assert len(sc_metadata) > 0, "No SC metadata loaded"
        print(f"\n✓ Loaded {len(sc_metadata)} SC cases")

        # Validate metadata structure
        first_case = sc_metadata[0]
        required_meta = ["case_id", "title", "citation", "judges", "year"]
        for field in required_meta:
            assert field in first_case, f"Missing metadata field: {field}"

    def test_pdfs_available(self, random_sc_pdfs):
        """Test that we have PDFs to test."""
        assert len(random_sc_pdfs) > 0, "No SC PDFs found"
        print(f"\n✓ Found {len(random_sc_pdfs)} SC PDFs for testing")

    def test_chunking_with_real_pdfs(self, random_sc_pdfs, sc_metadata):
        """Test chunking pipeline with real SC PDFs."""
        # Skip if no PDFs or pymupdf4llm not available
        if len(random_sc_pdfs) == 0:
            pytest.skip("No SC PDFs available")

        try:
            from highcourt.pymupdf4llm_parser import extract_with_pymupdf4llm
        except ImportError:
            pytest.skip("pymupdf4llm not available")

        # Import chunking function using importlib (filename has hyphens)
        import importlib.util
        chunker_path = Path(__file__).parent.parent / "chunk-judgment-pymupdf4llm.py"
        spec = importlib.util.spec_from_file_location("chunk_judgment", chunker_path)
        chunk_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(chunk_module)
        chunk_with_char_positions = chunk_module.chunk_with_char_positions

        # Build metadata lookup
        metadata_lookup = {
            case.get("path", ""): case for case in sc_metadata
        }

        successful = 0
        failed = 0
        all_stats = []
        validation_errors = []

        # Test subset of PDFs (for speed)
        test_pdfs = random_sc_pdfs[:10]  # Test first 10

        for path_key, pdf_path in test_pdfs:
            try:
                # Find matching metadata
                metadata = metadata_lookup.get(path_key)
                if not metadata:
                    # Try alternative matching
                    for case in sc_metadata:
                        if path_key in case.get("path", ""):
                            metadata = case
                            break

                if not metadata:
                    print(f"  ⚠ No metadata for {path_key}")
                    continue

                # Extract PDF
                extracted = extract_with_pymupdf4llm(str(pdf_path))

                # Chunk
                chunks = chunk_with_char_positions(extracted, metadata)

                if not chunks:
                    print(f"  ⚠ No chunks generated for {path_key}")
                    continue

                # Validate chunks
                valid, results = validate_chunks(chunks, court_type="supreme_court")

                if not valid:
                    validation_errors.extend(results["errors"][:5])  # First 5 errors

                all_stats.append(results["stats"])
                successful += 1

            except Exception as e:
                failed += 1
                print(f"  ✗ Error processing {pdf_path.name}: {e}")

        # Report results
        print(f"\n=== SC Chunking Results ===")
        print(f"  Successful: {successful}/{len(test_pdfs)}")
        print(f"  Failed: {failed}/{len(test_pdfs)}")

        if all_stats:
            avg_chunks = sum(s["total_chunks"] for s in all_stats) / len(all_stats)
            avg_size = sum(s["avg_chunk_size"] for s in all_stats) / len(all_stats)
            print(f"  Avg chunks per doc: {avg_chunks:.1f}")
            print(f"  Avg chunk size: {avg_size:.0f} chars")

        if validation_errors:
            print(f"\n  Validation errors (first 5):")
            for err in validation_errors[:5]:
                print(f"    - {err}")

        # Assertions
        assert successful > 0, "No PDFs successfully processed"
        assert failed < len(test_pdfs), "All PDFs failed"

    def test_section_detection_on_real_chunks(self, random_sc_pdfs, sc_metadata):
        """Test that section detection works on real SC chunks."""
        if len(random_sc_pdfs) == 0:
            pytest.skip("No SC PDFs available")

        try:
            from highcourt.pymupdf4llm_parser import extract_with_pymupdf4llm
        except ImportError:
            pytest.skip("pymupdf4llm not available")

        # Import chunking function using importlib (filename has hyphens)
        import importlib.util
        chunker_path = Path(__file__).parent.parent / "chunk-judgment-pymupdf4llm.py"
        spec = importlib.util.spec_from_file_location("chunk_judgment", chunker_path)
        chunk_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(chunk_module)
        chunk_with_char_positions = chunk_module.chunk_with_char_positions

        # Build metadata lookup
        metadata_lookup = {case.get("path", ""): case for case in sc_metadata}

        section_counts = {}
        total_chunks = 0

        # Test one PDF
        path_key, pdf_path = random_sc_pdfs[0]
        metadata = metadata_lookup.get(path_key)

        if not metadata:
            for case in sc_metadata:
                if path_key in case.get("path", ""):
                    metadata = case
                    break

        if not metadata:
            pytest.skip(f"No metadata for {path_key}")

        extracted = extract_with_pymupdf4llm(str(pdf_path))
        chunks = chunk_with_char_positions(extracted, metadata)

        for chunk in chunks:
            section = chunk.get("section_type", "unknown")
            section_counts[section] = section_counts.get(section, 0) + 1
            total_chunks += 1

        print(f"\n=== Section Detection Results ===")
        print(f"  Total chunks: {total_chunks}")
        print(f"  Section distribution:")
        for section, count in sorted(section_counts.items(), key=lambda x: -x[1]):
            priority = get_section_priority(section)
            print(f"    {section}: {count} (priority: {priority})")

        # At least one non-body section should be detected
        non_body_sections = {k: v for k, v in section_counts.items() if k != "body"}
        assert len(non_body_sections) > 0, "No non-body sections detected"


# =============================================================================
# HIGH COURT E2E TESTS
# =============================================================================

class TestHighCourtChunking:
    """E2E tests for High Court chunking pipeline."""

    def test_extracted_files_available(self, hc_extracted_files):
        """Test that HC extracted files are available."""
        assert len(hc_extracted_files) > 0, "No HC extracted files found"
        print(f"\n✓ Found {len(hc_extracted_files)} HC extracted files")

    def test_extracted_format_valid(self, hc_extracted_files):
        """Test that HC extracted files have valid format."""
        required_keys = ["text", "pages", "metadata", "cnr", "court_code"]

        for file_path in hc_extracted_files[:3]:
            with open(file_path, "r") as f:
                data = json.load(f)

            for key in required_keys:
                assert key in data, f"Missing key {key} in {file_path.name}"

            # Validate text
            assert len(data.get("text", "")) > 100, f"Text too short in {file_path.name}"

            print(f"  ✓ {file_path.name}: {len(data.get('text', ''))} chars, {len(data.get('pages', []))} pages")

    def test_hc_chunking_with_extracted(self, hc_extracted_files):
        """Test HC chunking with pre-extracted files."""
        if len(hc_extracted_files) == 0:
            pytest.skip("No HC extracted files available")

        try:
            from langchain_text_splitters import RecursiveCharacterTextSplitter
        except ImportError:
            from langchain.text_splitter import RecursiveCharacterTextSplitter

        successful = 0
        failed = 0
        all_stats = []

        for file_path in hc_extracted_files[:5]:
            try:
                with open(file_path, "r") as f:
                    extracted = json.load(f)

                # Get text
                text = extracted.get("text_clean") or extracted.get("text", "")
                if not text or len(text) < MIN_CHUNK_SIZE:
                    print(f"  ⚠ Text too short in {file_path.name}")
                    continue

                # Create splitter
                splitter = RecursiveCharacterTextSplitter(
                    chunk_size=CHUNK_SIZE,
                    chunk_overlap=CHUNK_OVERLAP,
                    separators=TEXT_SEPARATORS,
                )

                # Split
                text_chunks = splitter.split_text(text)

                # Basic validation
                assert len(text_chunks) > 0, f"No chunks generated for {file_path.name}"

                # Detect sections for each chunk
                sections = {}
                for chunk_text in text_chunks:
                    section = detect_section_type(chunk_text)
                    sections[section] = sections.get(section, 0) + 1

                all_stats.append({
                    "file": file_path.name,
                    "text_length": len(text),
                    "chunk_count": len(text_chunks),
                    "sections": sections
                })

                successful += 1

            except Exception as e:
                failed += 1
                print(f"  ✗ Error processing {file_path.name}: {e}")

        print(f"\n=== HC Chunking Results ===")
        print(f"  Successful: {successful}/{len(hc_extracted_files[:5])}")
        print(f"  Failed: {failed}")

        for stat in all_stats:
            print(f"\n  {stat['file']}:")
            print(f"    Text: {stat['text_length']} chars")
            print(f"    Chunks: {stat['chunk_count']}")
            print(f"    Sections: {stat['sections']}")

        assert successful > 0, "No HC files successfully processed"


# =============================================================================
# UNIFIED SCHEMA TESTS
# =============================================================================

class TestUnifiedSchema:
    """Test that SC and HC chunks follow the same unified schema."""

    def test_schema_compatibility(self):
        """Test that the unified schema constants are consistent."""
        # From UNIFIED_CHUNKING_SCHEMA.md
        assert CHUNK_SIZE == 4096, f"CHUNK_SIZE should be 4096, got {CHUNK_SIZE}"
        assert CHUNK_OVERLAP == 512, f"CHUNK_OVERLAP should be 512, got {CHUNK_OVERLAP}"
        assert MIN_CHUNK_SIZE == 300, f"MIN_CHUNK_SIZE should be 300, got {MIN_CHUNK_SIZE}"

        # Check separators
        expected_separators = ["\n\n\n", "\n\n", "\n", ". ", " ", ""]
        assert TEXT_SEPARATORS == expected_separators, f"TEXT_SEPARATORS mismatch"

        print("\n✓ Unified schema constants verified")

    def test_section_types_complete(self):
        """Test that all 16 section types are defined."""
        expected_sections = {
            "header", "ratio_decidendi", "obiter_dicta", "issues",
            "precedents", "judgment", "facts", "arguments", "analysis",
            "conclusion", "relief", "statutes", "procedure", "paragraph",
            "section", "body"
        }

        actual_sections = set(SECTION_TYPES)
        missing = expected_sections - actual_sections
        extra = actual_sections - expected_sections

        assert len(missing) == 0, f"Missing section types: {missing}"
        if extra:
            print(f"  ℹ Extra section types: {extra}")

        print(f"\n✓ All {len(expected_sections)} section types defined")

    def test_r2_config_complete(self):
        """Test that R2 configuration is complete for both courts."""
        assert "supreme_court" in R2_CONFIG, "Missing supreme_court R2 config"
        assert "high_court" in R2_CONFIG, "Missing high_court R2 config"

        for court in ["supreme_court", "high_court"]:
            assert "public_base_url" in R2_CONFIG[court], f"Missing public_base_url for {court}"
            assert "data_source" in R2_CONFIG[court], f"Missing data_source for {court}"

        print("\n✓ R2 configuration complete for SC and HC")


# =============================================================================
# PERFORMANCE TESTS
# =============================================================================

class TestChunkingPerformance:
    """Performance tests for chunking pipeline."""

    def test_text_splitter_performance(self):
        """Test that text splitting is performant."""
        import time

        try:
            from langchain_text_splitters import RecursiveCharacterTextSplitter
        except ImportError:
            from langchain.text_splitter import RecursiveCharacterTextSplitter

        # Create large text (simulating 100-page judgment)
        test_text = "This is a test paragraph. " * 10000  # ~280KB

        splitter = RecursiveCharacterTextSplitter(
            chunk_size=CHUNK_SIZE,
            chunk_overlap=CHUNK_OVERLAP,
            separators=TEXT_SEPARATORS,
        )

        start = time.time()
        chunks = splitter.split_text(test_text)
        elapsed = time.time() - start

        print(f"\n=== Performance Results ===")
        print(f"  Text size: {len(test_text):,} chars")
        print(f"  Chunks: {len(chunks)}")
        print(f"  Time: {elapsed:.3f}s")
        print(f"  Throughput: {len(test_text)/elapsed:,.0f} chars/sec")

        # Should be fast (< 1 second for 280KB)
        assert elapsed < 1.0, f"Chunking too slow: {elapsed:.3f}s"

    def test_section_detection_performance(self):
        """Test that section detection is performant."""
        import time

        # Sample legal text sections
        test_texts = [
            "RATIO DECIDENDI\nThe court held that...",
            "FACTS\nThe brief facts of the case are...",
            "CONCLUSION\nIn the result, the appeal is allowed.",
            "1. The appellant filed this case...",
            "Some random legal text without section marker",
        ] * 1000  # 5000 detections

        start = time.time()
        for text in test_texts:
            detect_section_type(text)
        elapsed = time.time() - start

        print(f"\n=== Section Detection Performance ===")
        print(f"  Detections: {len(test_texts)}")
        print(f"  Time: {elapsed:.3f}s")
        print(f"  Throughput: {len(test_texts)/elapsed:,.0f} detections/sec")

        # Should be very fast (< 1 second for 5000 detections)
        assert elapsed < 1.0, f"Section detection too slow: {elapsed:.3f}s"


# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":
    # Run with verbose output
    pytest.main([__file__, "-v", "--tb=short"])
