#!/usr/bin/env python3
"""
PDF Highlighter - Draws highlight annotations on PDF using span bboxes.

Given a PDF and span positions (from pymupdf4llm extraction), this module
can create highlighted PDFs for visual search result display.

Uses PyMuPDF Pro for enhanced PDF handling.

Usage:
    from pdf_highlighter import highlight_spans_in_pdf

    # Highlight specific spans on a page
    output_path = highlight_spans_in_pdf(
        pdf_path="document.pdf",
        highlights=[
            {"page": 1, "bbox": {"x0": 100, "y0": 200, "x1": 300, "y1": 220}},
            {"page": 1, "bbox": {"x0": 100, "y0": 230, "x1": 250, "y1": 250}},
        ],
        output_path="highlighted.pdf",
        color=(1, 1, 0)  # Yellow
    )
"""

# PyMuPDF Pro API Key (3-month unlimited trial)
PYMUPDF_PRO_API_KEY = "K9WIj3z//IAMYAMYwAZGUshC"

# Unlock PyMuPDF Pro before importing pymupdf
try:
    import pymupdf.pro
    pymupdf.pro.unlock(PYMUPDF_PRO_API_KEY)
except ImportError:
    pass  # Pro not installed, use standard pymupdf
except Exception:
    pass  # Pro unlock failed, continue with standard

import pymupdf  # PyMuPDF
from pathlib import Path
from typing import List, Dict, Tuple, Optional


def highlight_spans_in_pdf(
    pdf_path: str,
    highlights: List[Dict],
    output_path: Optional[str] = None,
    color: Tuple[float, float, float] = (1, 1, 0),  # Yellow RGB (0-1 scale)
    opacity: float = 0.4
) -> str:
    """
    Add highlight annotations to a PDF at specified bounding boxes.

    Args:
        pdf_path: Path to source PDF
        highlights: List of dicts with:
            - page: 1-indexed page number
            - bbox: dict with x0, y0, x1, y1 (PDF coordinates)
        output_path: Where to save highlighted PDF (default: adds _highlighted suffix)
        color: RGB tuple (0-1 scale), default yellow
        opacity: Highlight opacity (0-1), default 0.4

    Returns:
        Path to the highlighted PDF
    """
    doc = pymupdf.open(pdf_path)

    for highlight in highlights:
        page_num = highlight.get('page', 1) - 1  # Convert to 0-indexed
        bbox = highlight.get('bbox', {})

        if page_num < 0 or page_num >= len(doc):
            continue

        page = doc[page_num]

        # Create rectangle from bbox
        rect = pymupdf.Rect(
            bbox.get('x0', 0),
            bbox.get('y0', 0),
            bbox.get('x1', 0),
            bbox.get('y1', 0)
        )

        # Add highlight annotation
        annot = page.add_highlight_annot(rect)
        annot.set_colors(stroke=color)
        annot.set_opacity(opacity)
        annot.update()

    # Determine output path
    if output_path is None:
        src = Path(pdf_path)
        output_path = str(src.parent / f"{src.stem}_highlighted{src.suffix}")

    doc.save(output_path)
    doc.close()

    return output_path


def highlight_chunk_in_pdf(
    pdf_path: str,
    chunk_spans: List[Dict],
    page_number: int,
    output_path: Optional[str] = None,
    color: Tuple[float, float, float] = (1, 1, 0)
) -> str:
    """
    Highlight all spans from a chunk on a specific page.

    Args:
        pdf_path: Path to source PDF
        chunk_spans: List of span dicts from pymupdf4llm extraction
            Each span has: text, bbox (x0, y0, x1, y1), box_class
        page_number: 1-indexed page number
        output_path: Where to save (optional)
        color: RGB highlight color

    Returns:
        Path to highlighted PDF
    """
    highlights = [
        {"page": page_number, "bbox": span["bbox"]}
        for span in chunk_spans
        if "bbox" in span
    ]

    return highlight_spans_in_pdf(
        pdf_path=pdf_path,
        highlights=highlights,
        output_path=output_path,
        color=color
    )


def highlight_search_result(
    pdf_path: str,
    search_text: str,
    extracted_pages: List[Dict],
    output_path: Optional[str] = None,
    color: Tuple[float, float, float] = (1, 1, 0)
) -> str:
    """
    Highlight spans that contain the search text.

    Args:
        pdf_path: Path to source PDF
        search_text: Text to find and highlight
        extracted_pages: List of page dicts from pymupdf4llm extraction
            Each page has: page_number, spans[]
        output_path: Where to save (optional)
        color: RGB highlight color

    Returns:
        Path to highlighted PDF
    """
    search_lower = search_text.lower()
    highlights = []

    for page in extracted_pages:
        page_num = page.get('page_number', 1)
        spans = page.get('spans', [])

        for span in spans:
            span_text = span.get('text', '').lower()
            if search_lower in span_text:
                highlights.append({
                    "page": page_num,
                    "bbox": span["bbox"]
                })

    return highlight_spans_in_pdf(
        pdf_path=pdf_path,
        highlights=highlights,
        output_path=output_path,
        color=color
    )


def create_highlighted_page_image(
    pdf_path: str,
    page_number: int,
    highlights: List[Dict],
    dpi: int = 150,
    color: Tuple[float, float, float] = (1, 1, 0)
) -> bytes:
    """
    Create a PNG image of a page with highlights (for web display).

    Args:
        pdf_path: Path to source PDF
        page_number: 1-indexed page number
        highlights: List of bbox dicts to highlight
        dpi: Resolution for rendering
        color: RGB highlight color

    Returns:
        PNG image bytes
    """
    doc = pymupdf.open(pdf_path)
    page = doc[page_number - 1]

    # Add temporary highlights
    annots = []
    for h in highlights:
        bbox = h.get('bbox', {})
        rect = pymupdf.Rect(
            bbox.get('x0', 0),
            bbox.get('y0', 0),
            bbox.get('x1', 0),
            bbox.get('y1', 0)
        )
        annot = page.add_highlight_annot(rect)
        annot.set_colors(stroke=color)
        annot.set_opacity(0.4)
        annot.update()
        annots.append(annot)

    # Render to image
    mat = pymupdf.Matrix(dpi / 72, dpi / 72)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("png")

    # Clean up annotations (optional - if you don't want to modify the doc)
    for annot in annots:
        page.delete_annot(annot)

    doc.close()
    return img_bytes


# Demo usage
if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent / "parsers"))
    from pymupdf4llm_parser import extract_with_pymupdf4llm

    # Test PDF
    test_pdf = "data/aws-supreme-court-judgments/extracted/pdf/english/2006/2006_2_149_168_EN.pdf"

    if not Path(test_pdf).exists():
        print(f"Test PDF not found: {test_pdf}")
        sys.exit(1)

    print(f"Testing PDF highlighter with: {test_pdf}")
    print()

    # Extract with positions
    result = extract_with_pymupdf4llm(test_pdf)

    if "error" in result:
        print(f"Extraction error: {result['error']}")
        sys.exit(1)

    # Get first page spans
    page1 = result['pages'][0]
    spans = page1.get('spans', [])

    # Filter to meaningful spans (title/section-header)
    title_spans = [s for s in spans if s.get('box_class') in ('title', 'section-header')][:10]

    print(f"Found {len(title_spans)} title/header spans to highlight")
    for s in title_spans[:5]:
        print(f"  [{s['box_class']}] '{s['text'][:40]}' @ {s['bbox']}")

    # Create highlighted PDF
    output = highlight_chunk_in_pdf(
        pdf_path=test_pdf,
        chunk_spans=title_spans,
        page_number=1,
        output_path="data/test_highlighted.pdf"
    )

    print(f"\n✓ Created highlighted PDF: {output}")
    print("\nOpen it to see the yellow highlights on title/header spans!")
