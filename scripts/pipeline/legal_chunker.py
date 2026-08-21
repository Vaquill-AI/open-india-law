"""
Unified Legal Document Chunking Module for Indian Court RAG Pipelines

This module provides shared chunking logic for both Supreme Court and High Court
pipelines with:
- RecursiveCharacterTextSplitter for intelligent chunking
- O(n) character position search (not O(n²))
- Unified configuration constants
- Box-aware text building with semantic prefixes
- Shared metadata schema

Usage:
    from legal_chunker import (
        chunk_legal_document,
        build_text_from_boxes,
        CHUNK_SIZE, CHUNK_OVERLAP, MIN_CHUNK_SIZE
    )

    chunks = chunk_legal_document(extracted, metadata, court_type="supreme_court")
"""

import re
from typing import Dict, List, Optional, Tuple
from legal_section_detector import detect_section_type, get_section_priority


# =============================================================================
# UNIFIED CHUNKING CONFIGURATION
# =============================================================================
# These values are optimized for legal document retrieval based on research:
# - CHUNK_SIZE: ~1024 tokens balances context vs recall
# - CHUNK_OVERLAP: 20% preserves cross-chunk context
# - MIN_CHUNK_SIZE: 300 chars filters noise while keeping short but important content
# =============================================================================

CHUNK_SIZE = 4096       # ~1024 tokens (4 chars/token average for English)
CHUNK_OVERLAP = 819     # ~205 tokens (20% overlap)
MIN_CHUNK_SIZE = 300    # Minimum chunk size to keep (unified for SC and HC)

# Box classes to skip (page headers/footers = noise)
SKIP_BOX_CLASSES = {'page-header', 'page-footer'}

# Box classes to prefix with semantic markers (boost in embeddings)
# Hybrid format: [SEMANTIC_MARKER] + markdown header
# - [TITLE]/[SECTION] = explicit semantic signal for embedding model
# - # / ## = LLM-native markdown rendering when synthesizing answers
BOOST_BOX_CLASSES = {
    'title': '[TITLE] # ',
    'section-header': '[SECTION] ## ',
}

# Text splitter separators (recursive, from most to least preferred)
TEXT_SEPARATORS = ["\n\n\n", "\n\n", "\n", ". ", " ", ""]


# =============================================================================
# R2 STORAGE CONFIGURATION
# =============================================================================
# Different R2 buckets for SC vs HC (they have different public URLs)
# =============================================================================

R2_CONFIG = {
    "supreme_court": {
        "public_base_url": "${R2_PUBLIC_BASE_URL}",
        "path_prefix": "supreme-court",
        "data_source": "supreme_court_india"
    },
    "high_court": {
        "public_base_url": "${R2_PUBLIC_BASE_URL}",
        "path_prefix": "data/pdf",
        "data_source": "high_court_india"
    }
}


def get_r2_config(court_type: str) -> Dict:
    """Get R2 configuration for court type."""
    if court_type not in R2_CONFIG:
        raise ValueError(f"Unknown court type: {court_type}. Use 'supreme_court' or 'high_court'")
    return R2_CONFIG[court_type]


# =============================================================================
# BOX-AWARE TEXT BUILDING
# =============================================================================

def build_text_from_boxes(boxes: List[Dict]) -> str:
    """
    Build clean text from PyMuPDF Pro boxes with semantic prefixes.

    This function:
    1. Skips noise boxes (page-header, page-footer)
    2. Adds semantic prefixes to title/section-header boxes
    3. Joins remaining boxes with double newlines

    Args:
        boxes: List of box dicts from pymupdf4llm Pro extraction
               Each box has: box_class, text, page_number, bbox, spans

    Returns:
        Clean text with [TITLE] # / [SECTION] ## prefixes
    """
    text_parts = []

    for box in boxes:
        box_class = box.get('box_class', 'text')
        box_text = box.get('text', '').strip()

        if not box_text:
            continue

        # Skip noise boxes (page headers/footers)
        if box_class in SKIP_BOX_CLASSES:
            continue

        # Add semantic prefix for important boxes
        prefix = BOOST_BOX_CLASSES.get(box_class, '')
        text_parts.append(prefix + box_text)

    return '\n\n'.join(text_parts)


# =============================================================================
# PAGE RANGE CALCULATION
# =============================================================================

def get_page_range_from_char_offsets(
    pages: List[Dict],
    char_start: int,
    char_end: int
) -> Tuple[int, int]:
    """
    Calculate page range from character offsets.

    Args:
        pages: List of page dicts with 'text' and optionally 'page_number'
        char_start: Start character offset in full text
        char_end: End character offset in full text

    Returns:
        (page_start, page_end) tuple (1-indexed)
    """
    if not pages:
        return (1, 1)

    page_start, page_end = 1, 1
    running_offset = 0

    for i, page in enumerate(pages):
        page_num = page.get('page_number', i + 1)
        page_text = page.get('text', '')
        page_end_offset = running_offset + len(page_text)

        # Check if chunk overlaps with this page
        if char_end > running_offset and char_start < page_end_offset:
            if page_start == 1 and running_offset > 0:
                page_start = page_num
            page_end = page_num

        running_offset = page_end_offset + 2  # +2 for "\n\n" between pages

    return (page_start, page_end)


# =============================================================================
# CONTEXTUAL HEADER BUILDING
# =============================================================================

def build_contextual_header(
    metadata: Dict,
    section_type: str,
    court_type: str = "supreme_court",
    max_title_length: int = 100
) -> str:
    """
    Build contextual header for a chunk.

    Format varies slightly by court type:
    - Supreme Court: "Case: {title} [{citation}] ({year})\nSection: {SECTION_TYPE}\n\n"
    - High Court: "Case: {title} ({year})\nCourt: {court}\nSection: {SECTION_TYPE}\n\n"

    Args:
        metadata: Case metadata dict
        section_type: Detected section type
        court_type: "supreme_court" or "high_court"
        max_title_length: Maximum title length before truncation

    Returns:
        Contextual header string
    """
    title = metadata.get('title', 'Untitled')
    if len(title) > max_title_length:
        title = title[:max_title_length] + "..."

    citation = metadata.get('citation', '')
    year = metadata.get('year', 0)
    court = metadata.get('court', metadata.get('court_name', ''))

    # Build case header
    case_parts = [f"Case: {title}"]
    if citation:
        case_parts.append(f"[{citation}]")
    if year and year > 0:
        case_parts.append(f"({year})")
    case_header = " ".join(case_parts)

    # Add court for High Court (since there are 25 different HCs)
    if court_type == "high_court" and court:
        case_header += f"\nCourt: {court}"

    section_header = f"Section: {section_type.upper()}"
    return f"{case_header}\n{section_header}\n\n"


# =============================================================================
# UNIFIED METADATA SCHEMA
# =============================================================================

def build_unified_chunk_payload(
    chunk_text: str,
    chunk_index: int,
    total_chunks: int,
    char_start: int,
    char_end: int,
    page_start: int,
    page_end: int,
    section_type: str,
    metadata: Dict,
    court_type: str,
    pdf_url: str = "",
    pdf_urls: Optional[Dict] = None,
    text_original: Optional[str] = None,
) -> Dict:
    """
    Build unified chunk payload compatible with both SC and HC in same Qdrant collection.

    The schema supports:
    - Common fields for both courts (case_id, year, court, etc.)
    - SC-specific fields (language_code, pdf_urls, citation network)
    - HC-specific fields (state_code, establishment_code, bench)
    - Section priority for retrieval boosting

    Args:
        chunk_text: The chunk text (with contextual header)
        chunk_index: Index of this chunk in document
        total_chunks: Total chunks in document
        char_start: Start character offset for PDF highlighting
        char_end: End character offset for PDF highlighting
        page_start: Start page number
        page_end: End page number
        section_type: Detected section type
        metadata: Full case metadata dict
        court_type: "supreme_court" or "high_court"
        pdf_url: Primary PDF URL for highlighting
        pdf_urls: Dict of language -> URL (for multilingual SC)
        text_original: Clean chunk text without contextual header (for dense embedding)

    Returns:
        Unified chunk payload dict
    """
    # Base identification
    case_id = metadata.get('case_id', '')
    doc_id = metadata.get('doc_id', case_id)
    language_code = metadata.get('language_code', 'EN')

    # For SC multilingual, doc_id format is {case_id}_{lang}
    if court_type == "supreme_court" and language_code != "EN":
        doc_id = f"{case_id}_{language_code}"

    chunk = {
        # === IDENTIFICATION (Common) ===
        "chunk_id": f"{doc_id}_{chunk_index:03d}",
        "case_id": case_id,
        "doc_id": doc_id,

        # === TEXT ===
        # text: With contextual header for BM25 (party names, citation searchable)
        # text_original: Clean text for dense embedding (no header pollution)
        "text": chunk_text,
        "text_original": text_original if text_original else chunk_text,
        "title": metadata.get('title', ''),

        # === PDF HIGHLIGHTING ===
        "pdf_url": pdf_url,
        "char_start": char_start,
        "char_end": char_end,
        "page_start": page_start,
        "page_end": page_end,
        "chunk_index": chunk_index,
        "total_chunks": total_chunks,

        # === SECTION INFO ===
        "section_type": section_type,
        "section_priority": get_section_priority(section_type),

        # === CASE METADATA (Common) ===
        "citation": metadata.get('citation', ''),
        "case_number": metadata.get('case_number', ''),
        "year": metadata.get('year', 0),
        "decision_date": metadata.get('decision_date', ''),
        "court": metadata.get('court', metadata.get('court_name', '')),

        # === PARTIES (Common) ===
        "petitioner": metadata.get('petitioner', ''),
        "respondent": metadata.get('respondent', ''),

        # === JUDGES (Common) ===
        "judges": metadata.get('judges', []),
        "bench_strength": len(metadata.get('judges', [])),

        # === DISPOSITION (Common) ===
        "disposition": (
            metadata.get('disposal_status') or
            metadata.get('disposal_nature') or
            metadata.get('disposition', '')
        ),

        # === SOURCE TRACKING ===
        "court_type": court_type,  # "supreme_court" or "high_court"
        "data_source": R2_CONFIG.get(court_type, {}).get('data_source', ''),
    }

    # === SUPREME COURT SPECIFIC FIELDS ===
    if court_type == "supreme_court":
        chunk.update({
            # Multilingual support
            "language_code": language_code,
            "pdf_urls": pdf_urls or {},  # {"english": "url", "hindi": "url", ...}

            # Party arrays (SC has full lists)
            "petitioners_all": metadata.get('petitioners', []),
            "respondents_all": metadata.get('respondents', []),

            # Legal classification
            "case_type": metadata.get('case_type', ''),
            "jurisdiction": metadata.get('jurisdiction', ''),
            "bench_type": metadata.get('bench_type', ''),

            # Citation network
            "acts_referenced": metadata.get('acts_referenced', []),
            "cases_cited": metadata.get('cases_cited', []),
            "cited_by_count": metadata.get('cited_by_count', 0),

            # Extraction metadata
            "box_aware": metadata.get('box_aware', False),
            "has_legacy_fonts": metadata.get('has_legacy_fonts', False),
        })

    # === HIGH COURT SPECIFIC FIELDS ===
    elif court_type == "high_court":
        chunk.update({
            # e-Court identification (for Qdrant filtering)
            "state_code": metadata.get('state_code', ''),
            "establishment_code": metadata.get('establishment_code', ''),
            "state_name": metadata.get('state_name', ''),
            "bench": metadata.get('bench', ''),
            "bench_display_name": metadata.get('bench_display_name', ''),
            "court_code": metadata.get('court_code', ''),

            # Legal classification (same as SC - HC extractor provides these)
            "case_type": metadata.get('case_type', ''),
            "jurisdiction": metadata.get('jurisdiction', ''),
            "bench_type": metadata.get('bench_type', ''),

            # Citation network (HC uses 'acts_cited' → map to unified 'acts_referenced')
            # This fixes the critical naming mismatch between HC extractor and Qdrant
            "acts_referenced": metadata.get('acts_cited', metadata.get('acts_referenced', [])),
            "articles_cited": metadata.get('articles_cited', []),  # HC-specific

            # Advocates (HC extractor provides these)
            "petitioner_advocates": metadata.get('petitioner_advocates', []),
            "respondent_advocates": metadata.get('respondent_advocates', []),

            # Lower court / appeal chain
            "lower_court": metadata.get('lower_court', ''),
            "fir_number": metadata.get('fir_number', ''),

            # Summary
            "headnote": metadata.get('headnote', ''),

            # Additional HC fields
            "description": metadata.get('description', ''),
            "date_of_registration": metadata.get('date_of_registration', ''),
            "r2_key": metadata.get('r2_key', ''),

            # Quality indicators
            "has_legacy_fonts": metadata.get('has_legacy_fonts', False),
            "ocr_used": metadata.get('ocr_used', False),
        })

    return chunk


# =============================================================================
# MAIN CHUNKING FUNCTION (with O(n) optimization)
# =============================================================================

def chunk_legal_document(
    extracted: Dict,
    metadata: Dict,
    court_type: str = "supreme_court",
    chunk_size: int = CHUNK_SIZE,
    chunk_overlap: int = CHUNK_OVERLAP,
    min_chunk_size: int = MIN_CHUNK_SIZE,
    pdf_url: str = "",
    pdf_urls: Optional[Dict] = None,
    use_box_aware: bool = True,
) -> List[Dict]:
    """
    Chunk a legal document with unified schema and O(n) character search.

    This function:
    1. Builds text from boxes (if available) or falls back to raw text
    2. Splits text using RecursiveCharacterTextSplitter
    3. Calculates character positions using O(n) running offset (not O(n²))
    4. Detects section types using shared legal_section_detector
    5. Builds unified chunk payloads compatible with both SC and HC

    Args:
        extracted: Output from pymupdf4llm_parser.py (has 'text', 'boxes', 'pages')
        metadata: Case metadata from all_cases.jsonl or parquet
        court_type: "supreme_court" or "high_court"
        chunk_size: Target chunk size in characters (default: 4096)
        chunk_overlap: Overlap between chunks (default: 512)
        min_chunk_size: Minimum chunk size to keep (default: 300)
        pdf_url: Primary PDF URL for highlighting
        pdf_urls: Dict of language -> URL (for multilingual SC)
        use_box_aware: Use box-aware text building if boxes available

    Returns:
        List of chunk dictionaries with unified schema
    """
    # Import langchain splitter (lazy to avoid import errors)
    try:
        from langchain_text_splitters import RecursiveCharacterTextSplitter
    except ImportError:
        from langchain.text_splitter import RecursiveCharacterTextSplitter

    # Get text - prefer box-aware text with semantic prefixes
    boxes = extracted.get("boxes", [])
    has_boxes = use_box_aware and len(boxes) > 0

    if has_boxes:
        full_text = build_text_from_boxes(boxes)
    else:
        # Fallback: prefer markdown-rich 'text' field
        full_text = (
            extracted.get("text") or
            extracted.get("text_clean") or
            extracted.get("full_text", "")
        )

    if not full_text or not full_text.strip():
        return []

    pages = extracted.get("pages", [])

    # Create splitter
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        length_function=len,
        separators=TEXT_SEPARATORS,
        keep_separator=True
    )

    # Split text
    text_chunks = splitter.split_text(full_text)

    if not text_chunks:
        return []

    chunks = []

    # =========================================================================
    # O(n) CHARACTER POSITION SEARCH
    # =========================================================================
    # Instead of searching from beginning each time (O(n²)), we maintain a
    # running offset and search forward from there. This is critical for
    # performance on long documents (100+ page judgments).
    # =========================================================================
    search_start = 0

    for i, chunk_text in enumerate(text_chunks):
        # Skip tiny fragments
        if len(chunk_text.strip()) < min_chunk_size:
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
        # We move by 1 (not by chunk length) to handle overlaps correctly
        search_start = char_start + 1

        # Get page range
        page_start, page_end = get_page_range_from_char_offsets(pages, char_start, char_end)

        # Detect section type using shared detector
        section_type = detect_section_type(chunk_text)

        # Build contextual header
        header = build_contextual_header(metadata, section_type, court_type)
        text_with_context = header + chunk_text.strip()

        # Store original text for dense embedding (without header pollution)
        text_original = chunk_text.strip()

        # Build unified chunk payload
        chunk = build_unified_chunk_payload(
            chunk_text=text_with_context,
            chunk_index=i,
            total_chunks=len(text_chunks),  # Will be updated after filtering
            char_start=char_start,
            char_end=char_end,
            page_start=page_start,
            page_end=page_end,
            section_type=section_type,
            metadata=metadata,
            court_type=court_type,
            pdf_url=pdf_url,
            pdf_urls=pdf_urls,
            text_original=text_original,  # Clean text for dense embedding
        )

        # Store box_aware flag
        chunk["box_aware"] = has_boxes

        chunks.append(chunk)

    # Update total_chunks to actual count (after filtering small chunks)
    for chunk in chunks:
        chunk["total_chunks"] = len(chunks)

    return chunks


# =============================================================================
# TESTING
# =============================================================================

if __name__ == "__main__":
    print("Testing legal_chunker module...")
    print("=" * 60)

    # Test with mock data
    mock_extracted = {
        "text": """
IN THE SUPREME COURT OF INDIA
Civil Appeal No. 1234 of 2024

JUDGMENT

This appeal raises important questions of constitutional law.

FACTS

The appellant filed a writ petition challenging the validity of Section 66A.
The High Court dismissed the petition. Hence this appeal.

ARGUMENTS

Learned counsel for the appellant submitted that Section 66A is vague.
The respondent contended that the provision serves legitimate state interest.

ANALYSIS

We have carefully considered the rival submissions. The provision must be
tested against the touchstone of Article 19(1)(a). Having examined the
legislative history and comparative jurisprudence, we find merit in the
appellant's contentions.

RATIO DECIDENDI

A law which restricts speech must be narrowly tailored to achieve a
compelling state interest. Vague and overbroad restrictions violate
Article 19(1)(a).

CONCLUSION

For the foregoing reasons, the appeal is allowed. Section 66A is declared
unconstitutional and struck down.
        """,
        "boxes": [],
        "pages": [{"page_number": 1, "text": "Full text here..."}]
    }

    mock_metadata = {
        "case_id": "2024_INSC_123",
        "title": "Shreya Singhal vs Union of India",
        "citation": "[2024] 1 SCC 123",
        "year": 2024,
        "court": "Supreme Court of India",
        "judges": ["Justice A", "Justice B"],
        "petitioner": "Shreya Singhal",
        "respondent": "Union of India",
    }

    # Test chunking
    chunks = chunk_legal_document(
        mock_extracted,
        mock_metadata,
        court_type="supreme_court",
        chunk_size=500,  # Smaller for testing
        chunk_overlap=50,
        min_chunk_size=50,
    )

    print(f"Generated {len(chunks)} chunks")
    print()

    for i, chunk in enumerate(chunks):
        print(f"Chunk {i + 1}:")
        print(f"  Section: {chunk['section_type']} (priority: {chunk['section_priority']})")
        print(f"  Chars: {chunk['char_start']}-{chunk['char_end']}")
        print(f"  Pages: {chunk['page_start']}-{chunk['page_end']}")
        print(f"  Text preview: {chunk['text'][:100]}...")
        print()

    print("=" * 60)
    print("Test completed!")
