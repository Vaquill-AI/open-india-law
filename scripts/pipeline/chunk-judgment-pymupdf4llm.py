#!/usr/bin/env python3
"""
Box-Aware Judgment Chunking for pymupdf4llm Pro (Supreme Court)

Chunks Supreme Court judgments with box-class awareness and character-level position metadata.
Optimized for pymupdf4llm Pro parser with GNN-based layout analysis.

UPDATED: Now uses shared modules for unified schema across SC and HC:
- legal_section_detector: 15+ section patterns with priority scoring
- legal_chunker: Unified configuration and O(n) character search

Features:
- Skips page-header/page-footer boxes (noise reduction)
- Prefixes title/section-header boxes for embedding boost
- Uses box boundaries as natural chunk boundaries
- Character-level positions for PDF highlighting
- O(n) character position search (not O(n²))
- Unified schema compatible with High Court chunks

Usage:
    python chunk-judgment-pymupdf4llm.py <extracted_json> --metadata all_cases.jsonl [--output chunks.jsonl]
"""

import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

try:
    from langchain_text_splitters import RecursiveCharacterTextSplitter
except ImportError:
    from langchain.text_splitter import RecursiveCharacterTextSplitter

# Import shared modules from qdrant folder
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "qdrant"))
from legal_section_detector import detect_section_type, get_section_priority
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
)

# R2 Public URL for Supreme Court
R2_PUBLIC_BASE_URL = R2_CONFIG["supreme_court"]["public_base_url"]
DATA_SOURCE = R2_CONFIG["supreme_court"]["data_source"]


def convert_relative_to_r2_url(relative_path: str) -> str:
    """Convert relative PDF path to full R2 URL.

    Examples:
        pdf/english/1950/1950_1_806_821_EN.pdf
        → ${R2_PUBLIC_BASE_URL}/supreme-court/english/1950/1950_1_806_821_EN.pdf

        pdf/regional/1950/1950_1_806_821_HIN.pdf
        → ${R2_PUBLIC_BASE_URL}/supreme-court/regional/1950/1950_1_806_821_HIN.pdf
    """
    if not relative_path:
        return ""
    if relative_path.startswith("http"):
        return relative_path  # Already a full URL

    # Convert pdf/ prefix to supreme-court/ for R2 structure
    r2_path = relative_path.replace("pdf/", "supreme-court/", 1)
    return f"{R2_PUBLIC_BASE_URL}/{r2_path}"


def chunk_with_char_positions(
    extracted: Dict,
    metadata: Dict,
    chunk_size: int = CHUNK_SIZE,
    chunk_overlap: int = CHUNK_OVERLAP,
    r2_url_mapping: Optional[Dict] = None,
    use_box_aware: bool = True
) -> List[Dict]:
    """
    Chunk judgment text with character-level position metadata.

    Uses character offsets (char_start, char_end) and page ranges (page_start, page_end)
    for frontend PDF highlighting. This is 99.8% smaller than word-level bounding boxes
    and allows PDF.js to calculate highlighting on-demand.

    When box-aware mode is enabled (default), uses PyMuPDF Pro box classification:
    - Skips page-header/page-footer boxes (noise reduction)
    - Prefixes title/section-header boxes (embedding boost)
    - Uses box boundaries as natural chunk boundaries

    OPTIMIZATIONS:
    - O(n) character position search using running offset (not O(n²))
    - Unified MIN_CHUNK_SIZE = 300 (standardized with High Court)
    - Section priority scoring for retrieval boosting

    Args:
        extracted: Output from pymupdf4llm_parser.py
        metadata: Case metadata from all_cases.jsonl
        chunk_size: Target chunk size in characters
        chunk_overlap: Overlap between chunks
        r2_url_mapping: Optional dict mapping case_id to {language: r2_url}
                        Format: {"case_id": "...", "english": "url", "hindi": "url", ...}
        use_box_aware: Use box-aware chunking if boxes available (default: True)

    Returns:
        List of chunk dictionaries ready for embedding
    """
    # Check for box-aware data from PyMuPDF Pro
    boxes = extracted.get("boxes", [])
    has_boxes = use_box_aware and len(boxes) > 0

    # Build text based on available data
    if has_boxes:
        # Use box-aware text building (skip noise, add prefixes)
        full_text = build_text_from_boxes(boxes)
        # Also use text_clean for page mapping if available
        text_for_pages = extracted.get("text_clean") or extracted.get("text", "")
    else:
        # Fallback: PREFER markdown-rich `text` for better RAG retrieval
        # The `text` field from pymupdf4llm contains:
        #   - ## headers (section importance)
        #   - **bold** (emphasis on key terms)
        #   - |tables| (structured data)
        # Modern embedding models (Voyage) understand markdown structure
        full_text = extracted.get("text") or extracted.get("text_clean") or extracted.get("full_text", "")
        text_for_pages = full_text

    if not full_text or not full_text.strip():
        return []

    pages = extracted.get("pages") or extracted.get("char_positions", [])
    page_count = extracted.get("page_count", 0)

    # Extract English PDF URL (primary) + all regional language URLs
    case_id = metadata.get("case_id", "")
    pdf_url = ""  # English PDF URL for highlighting
    pdf_urls = {}  # All language URLs for frontend switching

    if r2_url_mapping and case_id in r2_url_mapping:
        # R2 mapping format: {"case_id": "...", "english": "url", "hindi": "url", ...}
        mapping = r2_url_mapping[case_id]

        # Extract English URL (primary)
        pdf_url = mapping.get('english', '')

        # Extract ALL language URLs (including English)
        for key, value in mapping.items():
            if key not in ('case_id', 'uploaded_at') and isinstance(value, str):
                pdf_urls[key] = value
    else:
        # Convert relative paths from metadata to full R2 URLs
        pdf_paths = metadata.get("pdf_paths", {})
        if isinstance(pdf_paths, dict):
            english_path = pdf_paths.get('english', '')
            pdf_url = convert_relative_to_r2_url(english_path)

            # Also convert regional paths if available
            regional_pattern = pdf_paths.get('regional', '')
            if regional_pattern and '*' in regional_pattern:
                # Pattern like: pdf/regional/1950/1950_1_806_821_*.pdf
                # Extract available languages from metadata
                languages = metadata.get('languages', [])
                pdf_urls = {}
                if english_path:
                    pdf_urls['english'] = pdf_url
                for lang in languages:
                    if lang != 'ENG':
                        # Convert language code to file suffix (HIN, PUN, TAM, etc.)
                        lang_path = regional_pattern.replace('*', lang)
                        pdf_urls[lang.lower()] = convert_relative_to_r2_url(lang_path)
            else:
                pdf_urls = {'english': pdf_url} if pdf_url else {}
        elif isinstance(pdf_paths, str):
            pdf_url = convert_relative_to_r2_url(pdf_paths)
            pdf_urls = {'english': pdf_url} if pdf_url else {}

    # Create text splitter
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        length_function=len,
        separators=TEXT_SEPARATORS,
        keep_separator=True
    )

    # Split into chunks
    text_chunks = splitter.split_text(full_text)

    if not text_chunks:
        return []

    chunks = []

    # =========================================================================
    # O(n) CHARACTER POSITION SEARCH (Optimized - backported from High Court)
    # =========================================================================
    # Instead of searching from beginning each time (O(n²)), we maintain a
    # running offset and search forward from there. This is critical for
    # performance on long documents (100+ page judgments).
    # =========================================================================
    search_start = 0

    for i, chunk_text in enumerate(text_chunks):
        # Skip tiny fragments (unified MIN_CHUNK_SIZE = 300)
        if len(chunk_text.strip()) < MIN_CHUNK_SIZE:
            continue

        # Find character positions - O(n) total using running offset
        char_start = full_text.find(chunk_text, search_start)

        if char_start == -1:
            # Fallback: search from beginning (shouldn't happen with proper splitting)
            char_start = full_text.find(chunk_text)
            if char_start == -1:
                # Last resort: estimate position
                char_start = search_start

        char_end = char_start + len(chunk_text)

        # Move search window forward for next iteration
        search_start = char_start + 1

        # Get page range from character offsets
        page_start, page_end = get_page_range_from_char_offsets(pages, char_start, char_end)

        # Detect section type using shared detector (15+ patterns)
        section_type = detect_section_type(chunk_text)

        # Build contextual header
        title = metadata.get('title', 'Untitled')
        citation = metadata.get('citation', '')
        year = metadata.get('year', 0)

        # Truncate long titles
        MAX_TITLE_LENGTH = 100
        if len(title) > MAX_TITLE_LENGTH:
            title = title[:MAX_TITLE_LENGTH] + "..."

        case_parts = [f"Case: {title}"]
        if citation:
            case_parts.append(f"[{citation}]")
        if year and year > 0:
            case_parts.append(f"({year})")
        case_header = " ".join(case_parts)

        section_header = f"Section: {section_type.upper()}"
        contextual_header = f"{case_header}\n{section_header}\n\n"

        text_with_context = contextual_header + chunk_text.strip()

        # Build chunk payload with UNIFIED SCHEMA
        # Use doc_id for chunk_id to ensure uniqueness across languages
        doc_id = metadata.get("doc_id", metadata["case_id"])
        language_code = metadata.get("language_code", "EN")

        chunk = {
            # === IDENTIFICATION (Unified) ===
            "chunk_id": f"{doc_id}_{i:03d}",
            "case_id": metadata["case_id"],
            "doc_id": doc_id,

            # === TEXT ===
            # Only store text with contextual header for embedding + BM25
            # Frontend uses char_start/char_end to extract original text from PDF
            # This saves ~2500 chars per chunk (50% reduction)
            "text": text_with_context,
            "title": metadata.get("title", ""),

            # === PDF HIGHLIGHTING (CHARACTER-LEVEL) ===
            "pdf_url": pdf_url,  # English PDF URL for highlighting
            "char_start": char_start,
            "char_end": char_end,
            "page_start": page_start,
            "page_end": page_end,
            "chunk_index": i,
            "total_chunks": len(text_chunks),  # Will be updated after filtering

            # === SECTION INFO (Enhanced with priority) ===
            "section_type": section_type,
            "section_priority": get_section_priority(section_type),  # NEW: 0-100 priority score

            # === CASE METADATA (Unified) ===
            "citation": metadata.get("citation", ""),
            "case_number": metadata.get("case_number", ""),
            "year": metadata.get("year", 0),
            "decision_date": metadata.get("decision_date", ""),
            # Support both court_name (High Court backfill) and court (Supreme Court)
            "court": metadata.get("court_name") or metadata.get("court", ""),

            # === PARTIES (Unified) ===
            "petitioner": metadata.get("petitioner", ""),
            "respondent": metadata.get("respondent", ""),

            # === JUDGES (Unified) ===
            "judges": metadata.get("judges", []),
            "bench_strength": len(metadata.get("judges", [])),

            # === DISPOSITION (Unified) ===
            # Support both disposal_status (High Court backfill) and disposal_nature (Supreme Court)
            "disposition": metadata.get("disposal_status") or metadata.get("disposal_nature", ""),

            # === SOURCE TRACKING (NEW - for unified collection) ===
            "court_type": "supreme_court",  # Distinguishes from high_court
            "data_source": DATA_SOURCE,  # "supreme_court_india"

            # === SUPREME COURT SPECIFIC FIELDS ===
            "language_code": language_code,  # EN, HIN, TAM, BEN, etc.
            "pdf_urls": pdf_urls,  # All language URLs: {"english": "url", "hindi": "url", ...}

            # Party arrays (SC has full lists)
            "petitioners_all": metadata.get("petitioners", []),
            "respondents_all": metadata.get("respondents", []),

            # Legal classification
            "case_type": metadata.get("case_type", ""),
            "jurisdiction": metadata.get("jurisdiction", ""),
            "bench_type": metadata.get("bench_type", ""),

            # Citation network
            "acts_referenced": metadata.get("acts_referenced", []),
            "cases_cited": metadata.get("cases_cited", []),
            "cited_by_count": metadata.get("cited_by_count", 0),

            # Extraction metadata
            "box_aware": has_boxes,  # True if PyMuPDF Pro box-aware chunking was used
            # Legacy font flag - True means text extraction may be garbage (0.5% of regional PDFs)
            "has_legacy_fonts": extracted.get("has_legacy_fonts", False),
        }

        chunks.append(chunk)

    # Update total_chunks count (after filtering small chunks)
    total = len(chunks)
    for chunk in chunks:
        chunk["total_chunks"] = total

    return chunks


def merge_metadata(all_cases_jsonl: str, case_id: str) -> Optional[Dict]:
    """Load metadata for a specific case from all_cases.jsonl."""
    with open(all_cases_jsonl, "r") as f:
        for line in f:
            case = json.loads(line)
            if case.get("case_id") == case_id:
                return case
    return None


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Chunk Supreme Court judgment with pymupdf4llm (unified schema)"
    )
    parser.add_argument("extracted_json", help="Extracted PDF JSON from pymupdf4llm_parser.py")
    parser.add_argument("--metadata", help="all_cases.jsonl path", required=True)
    parser.add_argument("--case-id", help="Case ID (if not in extracted JSON)")
    parser.add_argument("--output", "-o", help="Output JSONL path")
    parser.add_argument("--chunk-size", type=int, default=CHUNK_SIZE, help=f"Chunk size (default: {CHUNK_SIZE})")
    parser.add_argument("--overlap", type=int, default=CHUNK_OVERLAP, help=f"Overlap size (default: {CHUNK_OVERLAP})")

    args = parser.parse_args()

    # Load extracted JSON
    with open(args.extracted_json, "r") as f:
        extracted = json.load(f)

    # Determine case_id
    if args.case_id:
        case_id = args.case_id
    else:
        filename = Path(args.extracted_json).stem
        case_id = filename.replace(".extracted", "")

    # Load metadata
    print(f"Loading metadata for case: {case_id}")
    metadata = merge_metadata(args.metadata, case_id)
    if not metadata:
        print(f"Error: Case {case_id} not found in {args.metadata}")
        sys.exit(1)

    metadata["case_id"] = case_id

    # Check for box-aware data
    boxes = extracted.get("boxes", [])
    box_class_counts = extracted.get("box_class_counts", {})

    if boxes:
        print(f"Box-aware mode: {len(boxes)} boxes detected")
        if box_class_counts:
            print(f"  Box classes: {box_class_counts}")
        skipped = sum(box_class_counts.get(cls, 0) for cls in SKIP_BOX_CLASSES)
        boosted = sum(box_class_counts.get(cls, 0) for cls in BOOST_BOX_CLASSES.keys())
        print(f"  Skipping: {skipped} boxes (page-header/footer)")
        print(f"  Boosting: {boosted} boxes (title/section-header)")
    else:
        print("Legacy mode: No box data available")

    # Chunk
    print(f"Chunking with size={args.chunk_size}, overlap={args.overlap}")
    print(f"  MIN_CHUNK_SIZE: {MIN_CHUNK_SIZE} (unified with High Court)")
    print(f"  Section detector: 15+ patterns with priority scoring")
    print(f"  Char search: O(n) optimized")

    chunks = chunk_with_char_positions(extracted, metadata, args.chunk_size, args.overlap)

    if not chunks:
        print("Warning: No chunks generated (empty text?)")
        sys.exit(1)

    # Determine output path
    if args.output:
        output_path = Path(args.output)
    else:
        output_path = Path(args.extracted_json).with_suffix(".chunks.jsonl")

    # Save as JSONL
    with open(output_path, "w") as f:
        for chunk in chunks:
            f.write(json.dumps(chunk, ensure_ascii=False) + "\n")

    # Summary
    section_types = {}
    for chunk in chunks:
        st = chunk["section_type"]
        section_types[st] = section_types.get(st, 0) + 1

    print(f"\n✓ Created {len(chunks)} chunks")
    print(f"✓ Saved to: {output_path}")
    print(f"  Avg chunk size: {sum(len(c['text']) for c in chunks) // len(chunks)} chars")
    print(f"  Pages covered: {chunks[0]['page_start']}-{chunks[-1]['page_end']}")
    print(f"  Box-aware: {chunks[0].get('box_aware', False)}")
    print(f"  Court type: {chunks[0].get('court_type', 'unknown')}")
    print(f"  Data source: {chunks[0].get('data_source', 'unknown')}")
    print(f"  Section types: {section_types}")


if __name__ == "__main__":
    main()
