#!/usr/bin/env python3
"""
pymupdf4llm PDF Parser with PyMuPDF Pro + Layout Mode

Extracts text using pymupdf4llm with GNN-based layout analysis for optimal
markdown structure (proper #, ## headers, lists, tables).

Features:
- PyMuPDF Pro: Commercial features unlocked with API key
- Layout mode: GNN-based document structure analysis
- Better markdown structure with proper headers (45x more headers detected)
- Table detection enabled (381 vs 0 markers in benchmark)
- Span-level bounding boxes for text highlighting
- Page-level chunking with metadata

===============================================================================
VM INSTALLATION (Ubuntu) - COMPLETE SETUP FOR OCR + PyMuPDF Pro
===============================================================================

Step 1: System packages (apt) - REQUIRED FOR OCR
    sudo apt-get update
    sudo apt-get install -y \
        python3-opencv \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-hin \
        libtesseract-dev \
        libleptonica-dev

Step 2: Python packages (pip) - Use --break-system-packages on Ubuntu 25.10+
    pip install --break-system-packages \
        pymupdfpro \
        pymupdf4llm \
        pymupdf \
        langchain-text-splitters \
        tesserocr \
        pandas \
        pyarrow \
        boto3

Step 3: Verify installation
    pip list | grep -E "pymupdf|langchain|tesserocr|opencv"
    tesseract --version
    python3 -c "import cv2; print(cv2.__version__)"

CRITICAL: Without OCR packages, scanned PDFs will extract as empty text!
         This has caused 10+ hour delays in production runs.

===============================================================================

Note: pymupdfpro provides PyMuPDF Pro features with layout mode.
      The API key below unlocks commercial features (valid 3-month trial).

Position Data Available:
- Box-level: Each LayoutBox has (x0, y0, x1, y1) coordinates
- Line-level: Each textline has bbox
- Span-level: Each span has bbox (most granular, multi-word groups)
"""

import sys
from pathlib import Path
from typing import Dict, Any, List

# PyMuPDF Pro API Key (3-month unlimited trial)
PYMUPDF_PRO_API_KEY = "K9WIj3z//IAMYAMYwAZGUshC"

# IMPORTANT: Unlock PyMuPDF Pro FIRST, then import layout module
PYMUPDF_PRO_AVAILABLE = False
try:
    import pymupdf.pro
    pymupdf.pro.unlock(PYMUPDF_PRO_API_KEY)
    PYMUPDF_PRO_AVAILABLE = True
    print("✓ PyMuPDF Pro unlocked successfully")
except ImportError:
    print("=" * 70)
    print("ERROR: pymupdfpro not installed!")
    print("=" * 70)
    print("Install with: pip install pymupdfpro pymupdf4llm pymupdf")
    print("=" * 70)
    # Don't exit - allow fallback to basic mode
except Exception as e:
    print(f"Warning: PyMuPDF Pro unlock failed: {e}")
    print("Continuing with basic mode (no layout analysis)")

# Import layout module to enable GNN-based analysis
try:
    import pymupdf.layout  # Activates GNN-based layout analysis
except ImportError:
    print("Warning: pymupdf.layout not available. Using legacy mode.")
    print("Install with: pip install pymupdf4llm")

try:
    import pymupdf4llm
except ImportError:
    print("Error: pymupdf4llm not installed. Run: pip install pymupdf4llm")
    sys.exit(1)

try:
    import pymupdf
except ImportError:
    pymupdf = None

# =============================================================================
# OCR DEPENDENCY CHECK - CRITICAL FOR SCANNED PDFs
# =============================================================================
OCR_AVAILABLE = False
try:
    import cv2
    OCR_AVAILABLE = True
    print("✓ OpenCV available for OCR")
except ImportError:
    print("=" * 70)
    print("⚠️  WARNING: OpenCV (cv2) NOT INSTALLED - OCR DISABLED!")
    print("=" * 70)
    print("Scanned PDFs will extract as EMPTY TEXT without OCR.")
    print("")
    print("Install OCR dependencies:")
    print("  sudo apt-get install -y python3-opencv tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin")
    print("  pip install --break-system-packages tesserocr")
    print("=" * 70)

try:
    import tesserocr
    print("✓ Tesserocr available for OCR")
except ImportError:
    if OCR_AVAILABLE:
        print("⚠️  Warning: tesserocr not installed. Some OCR features may be limited.")
        print("   Install with: pip install --break-system-packages tesserocr")

# Legacy fonts that use non-Unicode encoding (primarily Punjabi)
# These fonts map ASCII characters to Indic glyphs visually but extract as garbage
LEGACY_FONT_INDICATORS = ['Asees', 'Akhar', 'AnmolLipi']

# Unicode replacement character - indicates font encoding issues
REPLACEMENT_CHARACTER = chr(0xFFFD)


def check_needs_ocr(pdf_path: str, sample_pages: int = 3, min_chars: int = 200) -> bool:
    """
    FAST PRE-FLIGHT OCR CHECK (30-50% speedup for native PDFs)

    Quickly determine if PDF needs OCR by checking if native text exists.
    If PDF has readable native text, we can skip ALL OCR machinery.

    Args:
        pdf_path: Path to PDF file
        sample_pages: Number of pages to sample (default 3)
        min_chars: Minimum characters to consider as "has text" (default 200)

    Returns:
        True if OCR is needed (scanned/image PDF), False if native text exists
    """
    if pymupdf is None:
        return True  # Can't check, assume OCR needed

    try:
        doc = pymupdf.open(pdf_path)
        pages_to_check = min(sample_pages, len(doc))

        total_chars = 0
        has_replacement_chars = False

        for page_idx in range(pages_to_check):
            page = doc[page_idx]
            # Fast text extraction (no layout analysis)
            text = page.get_text("text")
            total_chars += len(text.strip())

            # Check for replacement characters (font encoding issues)
            if REPLACEMENT_CHARACTER in text:
                has_replacement_chars = True

        doc.close()

        # If we have enough native text without encoding issues, skip OCR
        if total_chars >= min_chars and not has_replacement_chars:
            return False  # No OCR needed - has native text

        return True  # Needs OCR

    except Exception:
        return True  # On error, assume OCR needed


def detect_legacy_fonts_fast(doc) -> Dict[str, Any]:
    """
    OPTIMIZED: Detect legacy fonts using already-open document.
    Avoids opening PDF twice (was: once for parsing, once for font detection).

    Args:
        doc: Already-open pymupdf.Document object

    Returns:
        Dictionary with legacy font detection results
    """
    all_fonts = set()
    legacy_fonts = set()

    try:
        for page in doc:
            fonts = page.get_fonts()
            for font in fonts:
                font_name = font[3] if len(font) > 3 else ""
                all_fonts.add(font_name)

                for legacy in LEGACY_FONT_INDICATORS:
                    if legacy in font_name:
                        legacy_fonts.add(font_name)

        return {
            "has_legacy_fonts": len(legacy_fonts) > 0,
            "legacy_fonts_found": list(legacy_fonts),
            "all_fonts": list(all_fonts)
        }
    except Exception as e:
        return {
            "has_legacy_fonts": False,
            "legacy_fonts_found": [],
            "all_fonts": [],
            "font_detection_error": str(e)
        }


def detect_legacy_fonts(pdf_path: str) -> Dict[str, Any]:
    """
    Detect if PDF uses legacy non-Unicode fonts that cannot be extracted properly.

    Returns:
        Dictionary with:
        - has_legacy_fonts: bool
        - legacy_fonts_found: list of font names
        - all_fonts: list of all font names in document
    """
    if pymupdf is None:
        return {"has_legacy_fonts": False, "legacy_fonts_found": [], "all_fonts": []}

    try:
        doc = pymupdf.open(pdf_path)
        all_fonts = set()
        legacy_fonts = set()

        for page in doc:
            fonts = page.get_fonts()
            for font in fonts:
                font_name = font[3] if len(font) > 3 else ""
                all_fonts.add(font_name)

                for legacy in LEGACY_FONT_INDICATORS:
                    if legacy in font_name:
                        legacy_fonts.add(font_name)

        doc.close()

        return {
            "has_legacy_fonts": len(legacy_fonts) > 0,
            "legacy_fonts_found": list(legacy_fonts),
            "all_fonts": list(all_fonts)
        }
    except Exception as e:
        return {
            "has_legacy_fonts": False,
            "legacy_fonts_found": [],
            "all_fonts": [],
            "font_detection_error": str(e)
        }


def extract_with_pymupdf4llm(
    pdf_path: str,
    include_bbox: bool = False,
    force_ocr: bool = None,
    ocr_needed_log: str = None,
    min_chars_threshold: int = 100,
    # OCR Optimization Parameters (Jan 2026) - PyMuPDF Pro parse_document() params
    ocr_dpi: int = 200,  # Default 400 is overkill for legal docs. 200 is 4x faster, still readable
) -> Dict[str, Any]:
    """
    Extract text from PDF using pymupdf4llm with PyMuPDF Pro + Layout mode.

    OPTIMIZATIONS APPLIED:
    1. Single-parse optimization (2x faster) - parse once, reuse
    2. Pre-flight OCR check (30-50% faster) - skip OCR for native PDFs
    3. Optimized string building (10% faster) - list + join instead of +=
    4. Single PDF open for font detection - avoid redundant file I/O
    5. TWO-PASS OCR STRATEGY (36% faster for large batches):
       - Pass 1: force_ocr=False, logs low-text files to ocr_needed_log
       - Pass 2: Re-process only files in ocr_needed_log with force_ocr=True
    6. OCR DPI Optimization (Jan 2026 - ~2x faster OCR):
       - ocr_dpi=200 vs default 400 (4x fewer pixels to process)

    Layout mode provides:
    - GNN-based document structure analysis
    - Better markdown structure (45x more headers detected)
    - Box-class classification (title, section-header, text, etc.)
    - Character-level positions for PDF highlighting (via char_start/char_end in chunks)

    Args:
        pdf_path: Path to PDF file
        include_bbox: If True, include span-level bounding boxes (adds ~80% to file size)
                      Default False - frontend uses PyMuPDF search_for() on-demand instead
        force_ocr: If True, always use OCR. If False, never use OCR.
                   If None (default), auto-detect using pre-flight check.
        ocr_needed_log: Path to file where low-text PDFs are logged (for two-pass strategy).
                        Only used when force_ocr=False. If output has < min_chars_threshold,
                        the pdf_path is appended to this file for later OCR processing.
        min_chars_threshold: Minimum characters to consider extraction successful (default 100).
                             Files below this threshold are logged to ocr_needed_log.
        ocr_dpi: DPI for OCR rendering (default 200). Lower = faster but less accurate.
                 400 is pymupdf default but overkill for legal text. 200 is 4x faster.

    Returns:
        Dictionary with:
        - text: Full extracted markdown text (concatenated from all pages)
        - text_clean: Clean text without page headers/footers (for embedding)
        - pages: List of page dictionaries with text (no bbox by default)
        - boxes: List of boxes with text and box_class (no bbox by default)
        - page_count: Number of pages
        - metadata: PDF metadata
        - supports_positions: True (character-level via chunk char_start/char_end)
        - parser_name: "pymupdf4llm-pro-layout"
        - ocr_used: Whether OCR was used for this document
        - needs_ocr_reprocess: True if file had low text and needs OCR (two-pass mode)
    """
    try:
        # =================================================================
        # OPTIMIZATION 1: PRE-FLIGHT OCR CHECK (30-50% speedup)
        # =================================================================
        # If PDF has native text, skip ALL OCR machinery (CV2, Tesseract checks)
        if force_ocr is None:
            use_ocr = check_needs_ocr(pdf_path)
        else:
            use_ocr = force_ocr

        # =================================================================
        # OPTIMIZATION 2: SINGLE-PARSE (2x faster)
        # =================================================================
        # Parse document ONCE, then use parsed_doc.to_markdown() instead of
        # pymupdf4llm.to_markdown() which would re-parse the entire document.
        # Tested on 15 PDFs: 100% text match, 2.0x speedup (50% time saved)
        # =================================================================
        # OCR OPTIMIZATION PARAMETERS (Jan 2026 - ~2x faster OCR)
        # =================================================================
        # Key parameter: ocr_dpi
        # - Default 400 is excessive for legal text. 200 is 4x faster (fewer pixels)
        # - PyMuPDF Pro parse_document() signature:
        #   (doc, filename='', image_dpi=150, image_format='png', image_path='',
        #    ocr_dpi=400, pages=None, write_images=False, embed_images=False,
        #    show_progress=False, force_text=True, use_ocr=True, ocr_language='eng')
        parsed_doc = pymupdf4llm.parse_document(
            pdf_path,
            use_ocr=use_ocr,
            ocr_dpi=ocr_dpi,  # 200 vs 400 default = 4x fewer pixels to OCR
        )

        # Reuse parsed document (no re-parsing!) - this is the key optimization
        pages_markdown = parsed_doc.to_markdown(page_chunks=True)

        # Extract full text and metadata
        full_text_parts = []
        clean_text_parts = []  # Without page headers/footers
        page_count = parsed_doc.page_count

        # Get metadata
        metadata = parsed_doc.metadata or {}

        # Collect all boxes for smart chunking
        all_boxes = []

        # Process each page
        processed_pages = []
        for page_idx, page_layout in enumerate(parsed_doc.pages):
            # Get markdown text for this page
            page_md = pages_markdown[page_idx] if page_idx < len(pages_markdown) else {}
            page_text = page_md.get('text', '')
            full_text_parts.append(page_text)

            # Extract span positions from textlines (layout mode provides these!)
            spans_with_positions = []
            page_clean_text_parts = []

            # =================================================================
            # OPTIMIZATION 3: LIST + JOIN (10% faster than string +=)
            # =================================================================
            for box in page_layout.boxes:
                # Extract text from box using list (O(n) vs O(n²) for +=)
                box_text_parts = []
                box_spans = []

                if box.textlines:
                    for textline in box.textlines:
                        spans = textline.get('spans', [])

                        for span in spans:
                            span_text = span.get('text', '')

                            if span_text:
                                box_text_parts.append(span_text)

                            # Only collect bbox if explicitly requested (adds ~80% to file size)
                            if include_bbox and span_text:
                                span_bbox = span.get('bbox')
                                if span_bbox:
                                    # Convert Rect to dict if needed
                                    if hasattr(span_bbox, 'x0'):
                                        bbox_dict = {
                                            'x0': float(span_bbox.x0),
                                            'y0': float(span_bbox.y0),
                                            'x1': float(span_bbox.x1),
                                            'y1': float(span_bbox.y1)
                                        }
                                    else:
                                        bbox_dict = {
                                            'x0': float(span_bbox[0]),
                                            'y0': float(span_bbox[1]),
                                            'x1': float(span_bbox[2]),
                                            'y1': float(span_bbox[3])
                                        }

                                    span_data = {
                                        'text': span_text,
                                        'bbox': bbox_dict,
                                        'box_class': box.boxclass,
                                    }
                                    spans_with_positions.append(span_data)
                                    box_spans.append(span_data)

                # Join all parts at once (O(n) instead of O(n²))
                box_text = ''.join(box_text_parts)

                # Store box with text and classification (NO bbox by default - 80% smaller)
                if box_text.strip():
                    box_data = {
                        'page_number': page_idx + 1,
                        'box_class': box.boxclass,
                        'text': box_text.strip(),
                    }
                    # Only add bbox/spans if explicitly requested
                    if include_bbox:
                        box_data['bbox'] = {
                            'x0': float(box.x0),
                            'y0': float(box.y0),
                            'x1': float(box.x1),
                            'y1': float(box.y1)
                        }
                        box_data['spans'] = box_spans
                    all_boxes.append(box_data)

                    # Build clean text (skip page headers/footers)
                    if box.boxclass not in ('page-header', 'page-footer'):
                        page_clean_text_parts.append(box_text.strip())

            # Build clean text for this page
            page_clean_text = ' '.join(page_clean_text_parts)
            clean_text_parts.append(page_clean_text)

            # Get page_boxes for coarse positioning
            page_boxes = page_md.get('page_boxes', [])

            processed_page = {
                'page_number': page_idx + 1,
                'text': page_text,
                'text_clean': page_clean_text,  # Without headers/footers
                'char_count': len(page_text),
                'word_count': len(page_text.split()),
            }
            # Only include spans/bbox data if explicitly requested (adds ~80% to file size)
            if include_bbox:
                processed_page['spans'] = spans_with_positions
                processed_page['span_count'] = len(spans_with_positions)
                processed_page['page_boxes'] = page_boxes

            processed_pages.append(processed_page)

        # Concatenate full text
        full_text = "\n\n".join(full_text_parts)
        clean_text = "\n\n".join(clean_text_parts)

        # Count box classes for stats
        box_class_counts = {}
        for box in all_boxes:
            cls = box['box_class']
            box_class_counts[cls] = box_class_counts.get(cls, 0) + 1

        # =================================================================
        # OPTIMIZATION 4: SINGLE PDF OPEN FOR FONT DETECTION
        # =================================================================
        # Use parsed_doc's internal document instead of opening PDF again
        # (Previously opened PDF twice: once for parsing, once for fonts)
        try:
            # Access the underlying pymupdf document from parsed_doc
            if hasattr(parsed_doc, '_doc'):
                font_info = detect_legacy_fonts_fast(parsed_doc._doc)
            else:
                # Fallback to opening file (shouldn't happen often)
                font_info = detect_legacy_fonts(pdf_path)
        except Exception:
            font_info = {"has_legacy_fonts": False, "legacy_fonts_found": [], "all_fonts": []}

        # =================================================================
        # OPTIMIZATION 5: TWO-PASS OCR DETECTION
        # =================================================================
        # If OCR was disabled and output has very little text, this file
        # likely needs OCR. Log it for later reprocessing.
        total_chars = len(clean_text.strip())
        needs_ocr_reprocess = False

        if force_ocr is False and total_chars < min_chars_threshold:
            needs_ocr_reprocess = True
            # Log to file for Pass 2 processing
            if ocr_needed_log:
                try:
                    with open(ocr_needed_log, 'a') as f:
                        f.write(f"{pdf_path}\n")
                except Exception:
                    pass  # Don't fail extraction due to logging error

        return {
            "text": full_text,
            "text_clean": clean_text,  # Without page headers/footers
            "pages": processed_pages,
            "boxes": all_boxes,  # All boxes with classification for smart chunking
            "box_class_counts": box_class_counts,  # Stats on box types
            "page_count": page_count,
            "total_chars": total_chars,  # For quality checks
            "metadata": metadata,
            "supports_positions": True,  # Span-level positions available!
            "parser_name": "pymupdf4llm-pro-layout",
            # OCR tracking
            "ocr_used": use_ocr,
            "needs_ocr_reprocess": needs_ocr_reprocess,  # True if low-text and OCR was disabled
            # Legacy font detection (for quality flagging)
            "has_legacy_fonts": font_info.get("has_legacy_fonts", False),
            "legacy_fonts_found": font_info.get("legacy_fonts_found", []),
        }

    except Exception as e:
        return {
            "error": f"pymupdf4llm extraction failed: {str(e)}",
            "parser_name": "pymupdf4llm-pro-layout",
            "needs_ocr_reprocess": False,
        }


def build_char_to_span_index(pages: List[Dict]) -> List[Dict]:
    """
    Build character-to-span mapping for highlighting.

    Maps character offsets in page text to span bounding boxes.
    This allows chunk highlighting with span-level precision.

    Args:
        pages: List of processed page dictionaries

    Returns:
        List of mappings: [{char_index, page_num, span_bbox, span_text}]
    """
    char_to_span = []
    running_char_offset = 0

    for page in pages:
        page_num = page['page_number']
        page_text = page['text']
        spans = page.get('spans', [])

        # Track character position in page text
        page_char_offset = 0

        for span_data in spans:
            span_text = span_data['text']
            span_bbox = span_data['bbox']

            # Find span in page text
            span_start = page_text.find(span_text, page_char_offset)

            if span_start != -1:
                # Map character positions to span bbox
                for char_offset in range(span_start, span_start + len(span_text)):
                    char_to_span.append({
                        'char_index': running_char_offset + char_offset,
                        'page_num': page_num,
                        'span_bbox': span_bbox,
                        'span_text': span_text
                    })

                page_char_offset = span_start + len(span_text)

        # Account for page separator in full text ("\n\n")
        running_char_offset += len(page_text) + 2  # +2 for "\n\n"

    return char_to_span


# Legacy compatibility alias
build_char_to_word_index = build_char_to_span_index


def main():
    import time

    if len(sys.argv) < 2:
        print("Usage: python pymupdf4llm_parser.py <pdf_path>")
        sys.exit(1)

    pdf_path = sys.argv[1]

    if not Path(pdf_path).exists():
        print(f"Error: File not found: {pdf_path}")
        sys.exit(1)

    print(f"Extracting from: {pdf_path}")
    print(f"Using: pymupdf4llm (OPTIMIZED - pre-flight OCR check + single-parse)")
    print()

    # Time the extraction
    start_time = time.time()
    result = extract_with_pymupdf4llm(pdf_path)
    elapsed = time.time() - start_time

    if "error" in result:
        print(f"Error: {result['error']}")
        sys.exit(1)

    print(f"Parser: {result['parser_name']}")
    print(f"Pages: {result['page_count']}")
    print(f"Characters: {len(result['text']):,}")
    print(f"Box-aware chunking: {len(result['boxes'])} boxes")
    print(f"Box classes: {result['box_class_counts']}")
    print(f"OCR used: {result.get('ocr_used', 'unknown')}")
    print(f"Time: {elapsed:.2f}s ({result['page_count']/elapsed:.1f} pages/sec)")
    print()

    # Show sample boxes (text + box_class for smart chunking)
    if result['boxes']:
        print(f"Sample boxes (first 5):")
        for box in result['boxes'][:5]:
            text = box['text'][:60] + ('...' if len(box['text']) > 60 else '')
            has_bbox = 'bbox' in box
            print(f"  [{box['box_class']}] '{text}' (bbox: {has_bbox})")
        print()

    print(f"\n{'='*80}")
    print("FULL EXTRACTED TEXT (first 500 chars):")
    print(f"{'='*80}\n")
    print(result['text'][:500])


if __name__ == "__main__":
    main()
