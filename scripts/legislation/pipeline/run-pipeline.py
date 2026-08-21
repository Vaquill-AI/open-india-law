#!/usr/bin/env python3
"""
IndiaCode Legislation RAG Pipeline

Extracts text from PDFs, cleans it, chunks by section boundaries,
and produces JSONL chunks with char/page positions for PDF highlighting.

Usage:
    python run-pipeline.py --phase all
    python run-pipeline.py --phase extract --workers 12
    python run-pipeline.py --phase chunk
    python run-pipeline.py --phase chunk --act-id IND_central_1726

Phases:
    extract  - PDF → extracted JSON (parallel)
    chunk    - extracted JSON + HTML → chunks JSONL
    all      - both phases sequentially
"""

import argparse
import json
import logging
import os
import sys
import time
import traceback
import multiprocessing as mp
from datetime import datetime, timezone
from pathlib import Path

# Add script dir to path for local imports
sys.path.insert(0, str(Path(__file__).parent))

from config import (
    CHUNK_SIZE,
    SPLIT_OVERLAP,
    MIN_CHUNK_SIZE,
    TEXT_SPLIT_SEPARATORS,
    SECTION_PRIORITIES,
    R2_BUCKET_BASE,
    R2_PUBLIC_URL,
    DEFAULT_WORKERS,
    CHECKPOINT_INTERVAL,
    EXTRACTION_MIN_CHARS,
)  # noqa: E402 — SECTION_PRIORITIES used in chunk dicts
from html_cleaner import sections_to_plain_text, section_to_clean_text
from text_cleaner import clean_pdf_text, build_page_char_map, find_page_for_char
from legislation_section_detector import (
    detect_sections,
    merge_small_sections,
    split_section_into_provisions,
)
from metadata_extractor import (
    extract_act_metadata_from_text,
    extract_section_metadata,
    extract_defined_terms,
    classify_legal_subject,
)


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[3]  # news/
DATA_DIR = PROJECT_ROOT / "data" / "indiacode"
INDEX_DIR = DATA_DIR / "index-linked"
PDF_DIR = DATA_DIR / "pdfs"
HTML_DIR = DATA_DIR / "html"
SUB_DIR = DATA_DIR / "subordinate"
OUTPUT_DIR = DATA_DIR / "rag-output"
EXTRACTED_DIR = OUTPUT_DIR / "extracted"
CLEANED_DIR = OUTPUT_DIR / "cleaned"
HTML_CLEANED_DIR = OUTPUT_DIR / "html-cleaned"
CHUNKS_DIR = OUTPUT_DIR / "chunks"
PROGRESS_FILE = OUTPUT_DIR / "_progress.json"

for d in [OUTPUT_DIR, EXTRACTED_DIR, CLEANED_DIR, HTML_CLEANED_DIR, CHUNKS_DIR]:
    d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(OUTPUT_DIR / "pipeline.log"),
    ],
)
log = logging.getLogger("indiacode-rag")


# =========================================================================
# PHASE 1: EXTRACT
# =========================================================================

PYMUPDF_PRO_KEY = "lN2Ny16nOf72t73tb3tV7y2j"
_pro_unlocked = False


def _ensure_pro():
    """Unlock PyMuPDF Pro + activate layout mode (once per process).

    Called lazily inside extract_single_pdf, NOT as pool initializer.
    Pool initializer with spawn context causes deadlock when multiple
    workers try to unlock Pro license simultaneously on macOS.
    """
    global _pro_unlocked
    if _pro_unlocked:
        return
    try:
        import pymupdf.pro
        pymupdf.pro.unlock(PYMUPDF_PRO_KEY)
    except Exception:
        pass
    try:
        import pymupdf.layout  # noqa: F401 — activates GNN-based layout
    except Exception:
        pass
    _pro_unlocked = True


def _check_needs_ocr(pdf_path: str, sample_pages: int = 3, min_chars: int = 200) -> bool:
    """Fast pre-flight check: does this PDF need OCR?"""
    import pymupdf
    try:
        _ensure_pro()
        doc = pymupdf.open(pdf_path)
        n = len(doc)
        if n == 0:
            doc.close()
            return True
        total = 0
        check_pages = sample_pages if sample_pages <= n else n
        for i in range(check_pages):
            total += len(doc[i].get_text("text").strip())
        doc.close()
        return total < min_chars
    except Exception:
        return False  # Assume native text on error — let pymupdf4llm try first


def _make_ocr_stub(pdf_path: str, reason: str) -> dict:
    """
    Create a stub .extracted.json that marks this PDF for Mistral OCR.

    Instead of failing silently, we save a marker so:
    1. The pipeline counts it as "ok" (not a failure)
    2. ocr-mistral.py can find and process these stubs
    3. Chunking phase skips stubs (no text)
    """
    return {
        "text": "",
        "pages": [],
        "page_count": 0,
        "parser_name": "needs-mistral-ocr",
        "ocr_used": False,
        "needs_ocr_review": True,
        "quality_score": 0.0,
        "ocr_reason": reason,
        "source_pdf": pdf_path,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
    }


def extract_single_pdf(pdf_path: str) -> dict | None:
    """
    Extract text from a single PDF using PyMuPDF Pro + Layout mode.

    Strategy:
    1. Pre-flight check — if scanned (< 200 chars), skip (use ocr-mistral.py)
    2. pymupdf4llm.to_markdown(page_chunks=True) with Pro + GNN layout
    3. Fallback to plain get_text() if layout crashes (pymupdf4llm bug)

    Returns dict with: text, pages[], page_count, parser metadata.
    Returns None if scanned or extraction fails.
    """
    try:
        import pymupdf4llm
        import pymupdf

        _ensure_pro()

        # ---- Pre-flight OCR check ----
        needs_ocr = _check_needs_ocr(pdf_path)

        doc = pymupdf.open(pdf_path)
        page_count = len(doc)
        doc.close()

        parser_name = "pymupdf4llm-layout"

        if needs_ocr:
            log.info(f"  Scanned PDF, marking for Mistral OCR: {pdf_path}")
            return _make_ocr_stub(pdf_path, "scanned")
        else:
            # ---- SINGLE-PARSE OPTIMIZATION (2x faster, from HC pipeline) ----
            # parse_document() parses ONCE, then to_markdown() reuses the parse.
            # pymupdf4llm.to_markdown() re-parses every time — 2x slower.
            try:
                parsed_doc = pymupdf4llm.parse_document(
                    pdf_path,
                    force_text=False,  # No auto-OCR — Mistral handles scanned PDFs
                    use_ocr=False,
                )
                page_chunks = parsed_doc.to_markdown(page_chunks=True)
            except Exception as lib_err:
                # Any pymupdf4llm error — try plain text fallback
                log.info(
                    f"  pymupdf4llm error ({lib_err}), "
                    f"trying plain text: {pdf_path}"
                )
                try:
                    doc2 = pymupdf.open(pdf_path)
                    page_chunks = [
                        {"text": doc2[i].get_text("text"), "metadata": {"page": i + 1}}
                        for i in range(len(doc2))
                    ]
                    doc2.close()
                    parser_name = "pymupdf-plain-fallback"
                except Exception as plain_err:
                    # Even plain text failed — mark for Mistral OCR
                    log.info(
                        f"  Plain text also failed ({plain_err}), "
                        f"marking for Mistral OCR: {pdf_path}"
                    )
                    return _make_ocr_stub(pdf_path, f"{lib_err}; plain: {plain_err}")

            full_text_parts: list[str] = []
            pages: list[dict] = []

            for chunk in page_chunks:
                if isinstance(chunk, dict):
                    page_text = chunk.get("text", "")
                    meta = chunk.get("metadata", {})
                    page_num = meta.get("page", len(pages) + 1)
                else:
                    page_text = str(chunk)
                    page_num = len(pages) + 1

                full_text_parts.append(page_text)
                pages.append({
                    "page_number": page_num,
                    "text": page_text,
                    "char_count": len(page_text),
                    "ocred": False,
                })

            full_text = "\n\n".join(full_text_parts)
            if not parser_name.endswith("fallback"):
                parser_name = "pymupdf4llm-pro-layout"

        # ---- Validate extraction quality ----
        stripped = full_text.strip()

        # Gate 1: Minimum length
        if len(stripped) < EXTRACTION_MIN_CHARS:
            log.info(f"  Too short ({len(stripped)} chars), marking for Mistral OCR: {pdf_path}")
            return _make_ocr_stub(pdf_path, f"too_short ({len(stripped)} chars)")

        # Gate 2: Text quality — detect garbage/mojibake
        # Count chars that are recognisable (letters in any script + digits + common punctuation)
        sample = stripped[:2000]
        usable = sum(
            1 for c in sample
            if c.isalpha()        # Any script: Latin, Devanagari, etc.
            or c.isdigit()
            or c in " \n\t.,;:()[]{}!?-–—'/\"@#$%&*+=<>"
        )
        usable_ratio = usable / len(sample) if sample else 0

        if usable_ratio < 0.5:
            log.info(
                f"  Low quality text (usable={usable_ratio:.0%}), "
                f"flagging for OCR: {pdf_path}"
            )
            return {
                "text": full_text,
                "pages": pages,
                "page_count": page_count,
                "parser_name": parser_name,
                "ocr_used": False,
                "needs_ocr_review": True,
                "quality_score": round(usable_ratio, 3),
                "extracted_at": datetime.now(timezone.utc).isoformat(),
            }

        return {
            "text": full_text,
            "pages": pages,
            "page_count": page_count,
            "parser_name": parser_name,
            "ocr_used": needs_ocr,
            "needs_ocr_review": False,
            "quality_score": round(usable_ratio, 3),
            "extracted_at": datetime.now(timezone.utc).isoformat(),
        }

    except Exception as e:
        log.info(f"  Unexpected error, marking for Mistral OCR: {pdf_path} ({e})")
        return _make_ocr_stub(pdf_path, str(e))


def _extract_worker(args: tuple) -> tuple[str, bool, str]:
    """Worker function for parallel extraction.

    Returns (act_id, success, status) where status is one of:
    'ok', 'ocr_stub', 'failed'
    """
    act_id, pdf_path, out_path = args

    result = extract_single_pdf(pdf_path)
    if result is None:
        return act_id, False, "failed"

    result["act_id"] = act_id
    result["source_pdf"] = pdf_path

    with open(out_path, "w") as f:
        json.dump(result, f, ensure_ascii=False)

    status = "ocr_stub" if result.get("parser_name") == "needs-mistral-ocr" else "ok"
    return act_id, True, status


def run_extraction(entries: list[dict], workers: int = DEFAULT_WORKERS):
    """Phase 1: Extract text from all PDFs in parallel.

    Architecture:
    - Uses mp.Pool with 'fork' context (NOT ProcessPoolExecutor)
    - fork context: children inherit pymupdf Pro + layout from parent
    - No worker re-initialization needed (the root cause of all hangs)
    - imap_unordered with timeout catches stuck workers
    - Pool destroyed every BATCH_SIZE PDFs to free leaked C memory
    - Checkpoint via files on disk — resume by re-running

    See: https://forum.mupdf.com/t/pymupdf4llm-to-markdown-memory-leak/328
    """
    log.info(f"Phase 1: EXTRACT — {len(entries)} acts, {workers} workers")

    # Build task list — skip already-done files HERE, not in workers
    all_tasks = []
    skipped = 0
    for entry in entries:
        act_id = entry["actId"]
        pdf_path = entry.get("pdfPath")
        if not pdf_path:
            continue
        full_pdf = str(DATA_DIR / pdf_path)
        if not os.path.exists(full_pdf):
            continue
        out_path = str(EXTRACTED_DIR / f"{act_id}.extracted.json")
        if os.path.exists(out_path):
            skipped += 1
            continue  # skip here, not in worker
        all_tasks.append((act_id, full_pdf, out_path))

    tasks = all_tasks
    log.info(f"  Skipped {skipped} already-extracted, {len(tasks)} PDFs to process")

    log.info(f"  {len(tasks)} PDFs to extract")

    # ---- Initialize pymupdf Pro in main process BEFORE forking ----
    # Children inherit this via fork — no re-initialization, no deadlocks
    log.info("  Initializing PyMuPDF Pro + Layout in main process...")
    _ensure_pro()
    log.info("  PyMuPDF Pro ready")

    # ---- Config ----
    BATCH_SIZE = 200       # pool destroyed every 200 PDFs (frees leaked C memory)
    PDF_TIMEOUT = 180      # 3 min max per PDF (kills hung workers)
    RAM_LIMIT_GB = 20      # pause if Python > 20GB RSS

    ctx = mp.get_context("fork")  # explicit fork — don't rely on global setting

    success = 0
    failed = 0
    skipped = 0
    ocr_stubs = 0
    extraction_start = time.time()
    checkpoint_path = OUTPUT_DIR / "_extraction_checkpoint.json"

    def _save_checkpoint():
        checkpoint = {
            "success": success,
            "failed": failed,
            "skipped": skipped,
            "ocr_stubs": ocr_stubs,
            "total": len(tasks),
            "elapsed_sec": int(time.time() - extraction_start),
            "last_updated": datetime.now(timezone.utc).isoformat(),
        }
        with open(checkpoint_path, "w") as f:
            json.dump(checkpoint, f, indent=2)

    def _check_memory_ok() -> bool:
        try:
            import subprocess as _sp
            r = _sp.run(["ps", "aux"], capture_output=True, text=True, timeout=5)
            total_kb = sum(
                int(line.split()[5])
                for line in r.stdout.splitlines()
                if "python" in line.lower() and len(line.split()) > 5
            )
            total_gb = total_kb / 1024 / 1024
            if total_gb > RAM_LIMIT_GB:
                log.warning(f"  Memory: {total_gb:.1f}GB > {RAM_LIMIT_GB}GB limit")
                return False
            return True
        except Exception:
            return True

    total_batches = (len(tasks) + BATCH_SIZE - 1) // BATCH_SIZE

    for batch_start in range(0, len(tasks), BATCH_SIZE):
        batch = tasks[batch_start : batch_start + BATCH_SIZE]
        batch_num = batch_start // BATCH_SIZE + 1
        batch_start_time = time.time()

        log.info(f"  Batch {batch_num}/{total_batches}: {len(batch)} PDFs")

        pool = ctx.Pool(workers)

        try:
            result_iter = pool.imap_unordered(_extract_worker, batch, chunksize=1)
            batch_done = 0

            while True:
                try:
                    act_id, ok, status = result_iter.next(timeout=PDF_TIMEOUT)
                    batch_done += 1

                    if status == "ok":
                        success += 1
                    elif status == "ocr_stub":
                        success += 1
                        ocr_stubs += 1
                    else:
                        failed += 1

                    global_i = batch_start + batch_done
                    if batch_done % 10 == 0:
                        elapsed = time.time() - extraction_start
                        real_done = success - skipped
                        rate = real_done / elapsed if elapsed > 0 and real_done > 0 else 0
                        remaining_real = len(tasks) - global_i
                        eta_min = remaining_real / max(rate, 0.01) / 60
                        log.info(
                            f"  Progress: {global_i}/{len(tasks)} "
                            f"(ok={success} skip={skipped} ocr={ocr_stubs} fail={failed}) "
                            f"| {rate:.1f} PDF/s | ETA {eta_min:.0f}m"
                        )

                    # Checkpoint every 50
                    if batch_done % 50 == 0:
                        _save_checkpoint()

                except StopIteration:
                    break  # batch complete

                except mp.TimeoutError:
                    # A worker is stuck — log and kill the batch
                    log.warning(
                        f"  TIMEOUT: worker stuck for {PDF_TIMEOUT}s in batch {batch_num} "
                        f"— killing pool, {len(batch) - batch_done} tasks lost (will retry next run)"
                    )
                    failed += len(batch) - batch_done
                    break

        except Exception as e:
            log.error(f"  Pool error in batch {batch_num}: {e}")
            failed += len(batch) - batch_done

        finally:
            pool.terminate()  # kill ALL workers (including stuck ones)
            pool.join()        # wait for cleanup
            import gc
            gc.collect()
            _save_checkpoint()

        batch_elapsed = time.time() - batch_start_time
        log.info(
            f"  Batch {batch_num} done in {batch_elapsed:.0f}s "
            f"(ok={success} skip={skipped} fail={failed})"
        )

        # Memory check between batches
        if not _check_memory_ok():
            log.warning("  Memory limit — pausing 10s for GC")
            time.sleep(10)
            gc.collect()

    _save_checkpoint()
    total_elapsed = time.time() - extraction_start
    log.info(
        f"  Extraction complete in {total_elapsed:.0f}s: "
        f"{success} ok, {skipped} skipped, {ocr_stubs} ocr stubs, {failed} failed"
    )
    return success, failed


# =========================================================================
# PHASE 2: CHUNK
# =========================================================================

def _split_oversized(text: str, max_size: int, overlap: int) -> list[str]:
    """Split text that exceeds max_size using hierarchical separators."""
    if len(text) <= max_size:
        return [text]

    chunks: list[str] = []
    remaining = text

    for sep in TEXT_SPLIT_SEPARATORS:
        if len(remaining) <= max_size:
            break

        parts = remaining.split(sep) if sep else list(remaining)
        current = ""
        new_remaining_parts: list[str] = []

        for part in parts:
            candidate = current + sep + part if current else part
            if len(candidate) <= max_size:
                current = candidate
            else:
                if current:
                    chunks.append(current)
                current = part

        if current:
            if len(current) <= max_size:
                chunks.append(current)
            else:
                remaining = current
                continue
            break
        remaining = ""

    if remaining and remaining not in chunks:
        # Hard split as last resort
        while remaining:
            chunks.append(remaining[:max_size])
            remaining = remaining[max_size - overlap:]

    return chunks if chunks else [text]


def _build_contextual_header(
    title: str,
    year: int | str,
    category: str,
    act_number: str,
    act_status: str,
    chapter: str,
    chapter_title: str,
    section_number: str,
    section_title: str,
    sub_section: str = "",
) -> str:
    """Build the contextual header prepended to each chunk for embedding.

    Format:
      Act: The IPC, 1860 (Act 45 of 1860) | India | Central | In Force
      Chapter XVI: Offences Against the Human Body | Section 302: Punishment for murder
    """
    # Line 1: Act identity
    act_ref = f"Act {act_number} of {year}" if act_number and year else ""
    line1_parts = [f"Act: {title}"]
    if act_ref:
        line1_parts[0] += f" ({act_ref})"
    elif year:
        line1_parts[0] += f" ({year})"
    line1_parts.append("India")
    if category:
        line1_parts.append(category.title())
    if act_status:
        line1_parts.append(act_status.replace("_", " ").title())
    line1 = " | ".join(line1_parts)

    # Line 2: Location within the act
    line2_parts = []
    if chapter and chapter_title:
        line2_parts.append(f"Chapter {chapter}: {chapter_title}")
    elif chapter:
        line2_parts.append(f"Chapter {chapter}")

    sec_label = f"Section {section_number}" if section_number else ""
    if sub_section:
        sec_label += sub_section
    if sec_label and section_title:
        sec_label += f": {section_title}"
    if sec_label:
        line2_parts.append(sec_label)

    line2 = " | ".join(line2_parts)

    return f"{line1}\n{line2}" if line2 else line1


def chunk_act_from_pdf(
    act_id: str,
    entry: dict,
    extracted: dict,
    act_metadata: dict,
) -> list[dict]:
    """
    Chunk an act from PDF-extracted text using section detection.
    """
    full_text = extracted.get("text", "")
    pages = extracted.get("pages", [])
    clean_text = clean_pdf_text(full_text, pages)

    # Save clean text for R2
    clean_path = CLEANED_DIR / f"{act_id}.txt"
    clean_path.write_text(clean_text, encoding="utf-8")

    # Build page map from clean text pages
    # Re-extract pages from clean text (page boundaries may shift after cleaning)
    page_map = build_page_char_map(pages)

    # Detect sections
    boundaries = detect_sections(clean_text)
    boundaries = merge_small_sections(boundaries, clean_text)

    chunks = []
    act_status = _infer_act_status(entry)

    # Legal subject classification (once per act)
    legal_subjects = classify_legal_subject(
        entry.get("title", ""),
        entry.get("department", ""),
        entry.get("ministry", ""),
    )

    # Collect all defined terms from definitions sections
    all_defined_terms: list[str] = []

    # Track seen chunk_ids to prevent collisions
    _seen_chunk_ids: dict[str, int] = {}

    for idx, boundary in enumerate(boundaries):
        section_text = clean_text[boundary.char_start:boundary.char_end].strip()
        if not section_text:
            continue

        # Extract section-level metadata
        sec_meta = extract_section_metadata(
            section_text, boundary.section_type, boundary.section_number,
        )
        if boundary.section_type == "definitions":
            all_defined_terms.extend(sec_meta.get("defined_terms", []))

        # Provision-level splitting
        provisions = split_section_into_provisions(
            section_text,
            boundary.section_number,
            boundary.section_title,
            boundary.section_type,
        )

        for prov_idx, prov in enumerate(provisions):
            sub_text = prov["text"]
            sub_section = prov["sub_section"]
            prov_type = prov["provision_type"]

            # Char positions relative to clean_text
            char_start = clean_text.find(sub_text, boundary.char_start)
            if char_start == -1:
                char_start = boundary.char_start + prov["char_offset"]
            char_end = char_start + len(sub_text)

            # Page positions
            page_start = find_page_for_char(char_start, page_map) if page_map else None
            page_end = find_page_for_char(char_end - 1, page_map) if page_map else None

            # Chunk ID — must be unique per act
            sec_suffix = f"s{boundary.section_number.zfill(3)}" if boundary.section_number else f"b{idx:03d}"
            if sub_section:
                sec_suffix += f"_{sub_section.strip('()')}"
            elif len(provisions) > 1:
                sec_suffix += f"_p{prov_idx}"
            chunk_id = f"{act_id}_{sec_suffix}"

            # BULLETPROOF: ensure uniqueness — if collision, append index
            if chunk_id in _seen_chunk_ids:
                _seen_chunk_ids[chunk_id] += 1
                chunk_id = f"{chunk_id}_d{_seen_chunk_ids[chunk_id]}"
            else:
                _seen_chunk_ids[chunk_id] = 0

            # Contextual header
            header = _build_contextual_header(
                title=entry.get("title", ""),
                year=entry.get("year", ""),
                category=entry.get("category", ""),
                act_number=entry.get("actNumber", ""),
                act_status=act_status,
                chapter=boundary.chapter,
                chapter_title=boundary.chapter_title,
                section_number=boundary.section_number,
                section_title=boundary.section_title,
                sub_section=sub_section,
            )

            chunk = {
                "chunk_id": chunk_id,
                "act_id": act_id,
                "doc_type": "legislation",
                "country_code": "IN",
                "language_code": "en",
                "text": f"{header}\n\n{sub_text}",
                "text_original": sub_text,
                "char_start": char_start,
                "char_end": char_end,
                "page_start": page_start,
                "page_end": page_end,
                "chunk_index": len(chunks),
                "total_chunks": 0,  # updated after loop
                "section_number": boundary.section_number,
                "sub_section": sub_section,
                "section_title": boundary.section_title,
                "section_type": prov_type,
                "section_priority": SECTION_PRIORITIES.get(prov_type, boundary.priority),
                "chapter": boundary.chapter,
                "chapter_title": boundary.chapter_title,
                "part": boundary.part,
                "part_title": boundary.part_title,
                "is_repealed": boundary.is_repealed,
                "title": entry.get("title", ""),
                "act_number": entry.get("actNumber", ""),
                "year": _safe_int(entry.get("year", "")),
                "enactment_date": entry.get("enactmentDate", ""),
                "category": entry.get("category", ""),
                "state": entry.get("state", ""),
                "jurisdiction": entry.get("category", ""),
                "department": entry.get("department", ""),
                "ministry": entry.get("ministry", ""),
                "act_status": _infer_act_status(entry),
                "acts_referenced": sec_meta.get("acts_referenced", []),
                "amendment_notes": sec_meta.get("amendment_notes", []),
                "amendment_count": sec_meta.get("amendment_count", 0),
                "defined_terms": sec_meta.get("defined_terms", []),
                "penalty": sec_meta.get("penalty"),
                "effective_dates": sec_meta.get("effective_dates", []),
                # Tier 1: provision classification
                "provision_type": sec_meta.get("provision_type", "general"),
                "has_proviso": sec_meta.get("has_proviso", False),
                "has_explanation": sec_meta.get("has_explanation", False),
                "has_illustration": sec_meta.get("has_illustration", False),
                "has_non_obstante": sec_meta.get("has_non_obstante", False),
                "has_saving_clause": sec_meta.get("has_saving_clause", False),
                "section_status": sec_meta.get("section_status", "in_force"),
                "sections_referenced_internal": sec_meta.get("sections_referenced_internal", []),
                "delegation_type": sec_meta.get("delegation_type"),
                # Tier 2
                "legal_subject": legal_subjects,
                "footnotes_structured": sec_meta.get("footnotes_structured", []),
                "case_citations": sec_meta.get("case_citations", []),
                # Tier 3
                "limitation_periods": sec_meta.get("limitation_periods", []),
                # Existing act-level
                "territorial_extent": act_metadata.get("territorial_extent"),
                "commencement_info": act_metadata.get("commencement_info"),
                "long_title": act_metadata.get("long_title"),
                "date_of_assent": act_metadata.get("date_of_assent"),
                "ministry_extracted": act_metadata.get("ministry_extracted"),
                "repeals": act_metadata.get("repeals", []),
                "ocr_used": extracted.get("ocr_used", False),
                "pdf_url": f"{R2_PUBLIC_URL}/{act_id}/act.pdf" if R2_PUBLIC_URL else None,
                "html_url": f"{R2_PUBLIC_URL}/{act_id}/act.html" if R2_PUBLIC_URL and (HTML_CLEANED_DIR / f"{act_id}.html").exists() else None,
                "text_url": f"{R2_PUBLIC_URL}/{act_id}/act.txt" if R2_PUBLIC_URL else None,
                "html_section_id": None,
                "handle": entry.get("handle", ""),
                "source_url": entry.get("sourceUrl", ""),
                "data_source": "indiacode",
                "extraction_source": "pdf",
                "extracted_at": datetime.now(timezone.utc).isoformat(),
                "is_subordinate": False,
                "parent_act_id": None,
                "subordinate_count": len(entry.get("subordinatePdfs", [])),
            }
            chunks.append(chunk)

    # Update total_chunks
    for c in chunks:
        c["total_chunks"] = len(chunks)

    # Propagate all defined terms to every chunk in this act
    if all_defined_terms:
        for c in chunks:
            if not c["defined_terms"]:
                c["defined_terms"] = []

    return chunks


def chunk_act_from_html(
    act_id: str,
    entry: dict,
    html_data: dict,
    act_metadata: dict,
    extracted: dict | None = None,
) -> list[dict]:
    """
    Chunk an act from HTML sections.

    If extracted PDF data is also available, maps char positions to PDF pages.
    """
    sections = html_data.get("sections", [])
    if not sections:
        return []

    # Build per-section clean texts and track positions
    section_texts: list[tuple[dict, str]] = []
    for sec in sections:
        sec_text = section_to_clean_text(sec)
        if sec_text.strip():
            section_texts.append((sec, sec_text))

    # Build full_clean by joining with \n\n (same separator as sections_to_plain_text)
    full_clean = "\n\n".join(text for _, text in section_texts)
    clean_path = CLEANED_DIR / f"{act_id}.txt"
    clean_path.write_text(full_clean, encoding="utf-8")

    # Build clean HTML for R2
    html_clean_path = HTML_CLEANED_DIR / f"{act_id}.html"
    _build_clean_html(sections, html_data.get("title", ""), html_clean_path)

    # If we have PDF extraction, build page map for position mapping
    page_map = None
    pdf_clean_text = None
    if extracted:
        pdf_pages = extracted.get("pages", [])
        page_map = build_page_char_map(pdf_pages)
        pdf_clean_text = clean_pdf_text(extracted.get("text", ""), pdf_pages)

    # Pre-compute char positions for each section (exact, no find needed)
    section_positions: list[tuple[int, int]] = []
    pos = 0
    for i, (_, text) in enumerate(section_texts):
        section_positions.append((pos, pos + len(text)))
        pos += len(text) + 2  # +2 for \n\n separator

    chunks = []
    all_defined_terms: list[str] = []
    _seen_chunk_ids_html: dict[str, int] = {}

    # Legal subject classification (once per act)
    legal_subjects = classify_legal_subject(
        entry.get("title", ""),
        entry.get("department", ""),
        entry.get("ministry", ""),
    )

    for sec_idx, (sec, sec_text) in enumerate(section_texts):
        char_start, char_end = section_positions[sec_idx]

        sec_no = sec.get("sectionNo", "").strip()
        label = sec.get("label", "").strip()
        sec_id = sec.get("sectionId", "")

        # Classify section
        sec_type = _classify_html_section(sec_no, label, sec_text)
        priority = SECTION_PRIORITIES.get(sec_type, 80)

        # Get page numbers from PDF if available
        page_start = None
        page_end = None
        if pdf_clean_text and page_map:
            # Fuzzy-find section text in PDF text
            pdf_pos = _fuzzy_find_in_pdf(sec_text[:100], pdf_clean_text)
            if pdf_pos >= 0:
                page_start = find_page_for_char(pdf_pos, page_map)
                pdf_end = _fuzzy_find_in_pdf(sec_text[-80:], pdf_clean_text, pdf_pos)
                if pdf_end >= 0:
                    page_end = find_page_for_char(pdf_end, page_map)
                else:
                    page_end = page_start

        # Section-level metadata
        sec_meta = extract_section_metadata(sec_text, sec_type, sec_no)
        if sec_type == "definitions":
            all_defined_terms.extend(sec_meta.get("defined_terms", []))

        # Detect chapter context (from label or section flow)
        chapter, chapter_title = _detect_chapter_from_context(
            sec_no, label, chunks
        )

        # Provision-level splitting
        provisions = split_section_into_provisions(
            sec_text, sec_no, label, sec_type,
        )

        act_status = _infer_act_status(entry)

        for prov_idx, prov in enumerate(provisions):
            sub_text = prov["text"]
            sub_section = prov["sub_section"]
            prov_type = prov["provision_type"]

            # Char positions
            if len(provisions) == 1:
                sub_start = char_start
                sub_end = char_end
            else:
                sub_start = char_start + prov["char_offset"]
                # Verify by searching in full_clean
                verify_pos = full_clean.find(sub_text, char_start)
                if verify_pos >= 0:
                    sub_start = verify_pos
                sub_end = sub_start + len(sub_text)

            sec_suffix = f"s{sec_no.zfill(3)}" if sec_no else f"b{len(chunks):03d}"
            if sub_section:
                sec_suffix += f"_{sub_section.strip('()')}"
            elif len(provisions) > 1:
                sec_suffix += f"_p{prov_idx}"
            chunk_id = f"{act_id}_{sec_suffix}"

            # BULLETPROOF: ensure uniqueness — if collision, append index
            if chunk_id in _seen_chunk_ids_html:
                _seen_chunk_ids_html[chunk_id] += 1
                chunk_id = f"{chunk_id}_d{_seen_chunk_ids_html[chunk_id]}"
            else:
                _seen_chunk_ids_html[chunk_id] = 0

            header = _build_contextual_header(
                title=entry.get("title", ""),
                year=entry.get("year", ""),
                category=entry.get("category", ""),
                act_number=entry.get("actNumber", ""),
                act_status=act_status,
                chapter=chapter,
                chapter_title=chapter_title,
                section_number=sec_no,
                section_title=label,
                sub_section=sub_section,
            )

            chunk = {
                "chunk_id": chunk_id,
                "act_id": act_id,
                "doc_type": "legislation",
                "country_code": "IN",
                "language_code": "en",
                "text": f"{header}\n\n{sub_text}",
                "text_original": sub_text,
                "char_start": sub_start,
                "char_end": sub_end,
                "page_start": page_start,
                "page_end": page_end,
                "chunk_index": len(chunks),
                "total_chunks": 0,
                "section_number": sec_no,
                "sub_section": sub_section,
                "section_title": label,
                "section_type": prov_type,
                "section_priority": SECTION_PRIORITIES.get(prov_type, priority),
                "chapter": chapter,
                "chapter_title": chapter_title,
                "part": "",
                "part_title": "",
                "is_repealed": "[omitted]" in sec_text.lower() or "[repealed]" in sec_text.lower(),
                "title": entry.get("title", ""),
                "act_number": entry.get("actNumber", ""),
                "year": _safe_int(entry.get("year", "")),
                "enactment_date": entry.get("enactmentDate", ""),
                "category": entry.get("category", ""),
                "state": entry.get("state", ""),
                "jurisdiction": entry.get("category", ""),
                "department": entry.get("department", ""),
                "ministry": entry.get("ministry", ""),
                "act_status": _infer_act_status(entry),
                "acts_referenced": sec_meta.get("acts_referenced", []),
                "amendment_notes": sec_meta.get("amendment_notes", []),
                "amendment_count": sec_meta.get("amendment_count", 0),
                "defined_terms": sec_meta.get("defined_terms", []),
                "penalty": sec_meta.get("penalty"),
                "effective_dates": sec_meta.get("effective_dates", []),
                # Tier 1
                "provision_type": sec_meta.get("provision_type", "general"),
                "has_proviso": sec_meta.get("has_proviso", False),
                "has_explanation": sec_meta.get("has_explanation", False),
                "has_illustration": sec_meta.get("has_illustration", False),
                "has_non_obstante": sec_meta.get("has_non_obstante", False),
                "has_saving_clause": sec_meta.get("has_saving_clause", False),
                "section_status": sec_meta.get("section_status", "in_force"),
                "sections_referenced_internal": sec_meta.get("sections_referenced_internal", []),
                "delegation_type": sec_meta.get("delegation_type"),
                # Tier 2
                "legal_subject": legal_subjects,
                "footnotes_structured": sec_meta.get("footnotes_structured", []),
                "case_citations": sec_meta.get("case_citations", []),
                # Tier 3
                "limitation_periods": sec_meta.get("limitation_periods", []),
                # Existing act-level
                "territorial_extent": act_metadata.get("territorial_extent"),
                "commencement_info": act_metadata.get("commencement_info"),
                "long_title": act_metadata.get("long_title"),
                "date_of_assent": act_metadata.get("date_of_assent"),
                "ministry_extracted": act_metadata.get("ministry_extracted"),
                "repeals": act_metadata.get("repeals", []),
                "ocr_used": extracted.get("ocr_used", False) if extracted else False,
                "pdf_url": f"{R2_PUBLIC_URL}/{act_id}/act.pdf" if R2_PUBLIC_URL else None,
                "html_url": f"{R2_PUBLIC_URL}/{act_id}/act.html" if R2_PUBLIC_URL and (HTML_CLEANED_DIR / f"{act_id}.html").exists() else None,
                "text_url": f"{R2_PUBLIC_URL}/{act_id}/act.txt" if R2_PUBLIC_URL else None,
                "html_section_id": sec_id,
                "handle": entry.get("handle", ""),
                "source_url": entry.get("sourceUrl", ""),
                "data_source": "indiacode",
                "extraction_source": "both" if extracted else "html",
                "extracted_at": datetime.now(timezone.utc).isoformat(),
                "is_subordinate": False,
                "parent_act_id": None,
                "subordinate_count": len(entry.get("subordinatePdfs", [])),
            }
            chunks.append(chunk)

    for c in chunks:
        c["total_chunks"] = len(chunks)

    return chunks


def chunk_single_act(entry: dict) -> tuple[str, int]:
    """
    Process a single act: load sources, chunk, write JSONL.

    Returns (act_id, chunk_count).
    """
    act_id = entry["actId"]
    out_path = CHUNKS_DIR / f"{act_id}.chunks.jsonl"

    if out_path.exists():
        # Count existing chunks
        with open(out_path) as f:
            count = sum(1 for _ in f)
        return act_id, count

    # Load extracted PDF data (if available)
    extracted = None
    ext_path = EXTRACTED_DIR / f"{act_id}.extracted.json"
    if ext_path.exists():
        with open(ext_path) as f:
            extracted = json.load(f)

    # Load HTML data (if available)
    html_data = None
    html_path = entry.get("htmlPath")
    if html_path:
        full_html = DATA_DIR / html_path
        if full_html.exists():
            with open(full_html) as f:
                html_data = json.load(f)

    # Extract act-level metadata
    act_metadata = {}
    source_text = ""
    if extracted:
        source_text = extracted.get("text", "")
    elif html_data and html_data.get("sections"):
        source_text = sections_to_plain_text(html_data["sections"])

    if source_text:
        act_metadata = extract_act_metadata_from_text(source_text)

    # Choose chunking strategy
    # PDF-first: always use PDF if extracted (gives page positions for highlighting).
    # HTML-only: use HTML when no PDF available.
    has_html_sections = (
        html_data is not None
        and html_data.get("sectionCount", 0) > 0
        and len(html_data.get("sections", [])) > 0
    )

    chunks = []
    if extracted:
        chunks = chunk_act_from_pdf(act_id, entry, extracted, act_metadata)
    elif has_html_sections:
        chunks = chunk_act_from_html(act_id, entry, html_data, act_metadata, extracted)
    else:
        log.warning(f"  No data source for {act_id}: {entry.get('title', '')}")
        return act_id, 0

    # Write chunks
    if chunks:
        with open(out_path, "w") as f:
            for chunk in chunks:
                f.write(json.dumps(chunk, ensure_ascii=False) + "\n")

    return act_id, len(chunks)


def run_chunking(entries: list[dict]):
    """Phase 2: Chunk all acts."""
    log.info(f"Phase 2: CHUNK — {len(entries)} acts")

    total_chunks = 0
    processed = 0
    skipped = 0

    for i, entry in enumerate(entries, 1):
        act_id = entry["actId"]
        data_source = entry.get("dataSource", "none")

        if data_source == "none":
            skipped += 1
            continue

        try:
            _, count = chunk_single_act(entry)
            total_chunks += count
            processed += 1
        except Exception as e:
            log.error(f"  Chunking failed for {act_id}: {e}")
            log.debug(traceback.format_exc())

        if i % CHECKPOINT_INTERVAL == 0:
            log.info(
                f"  Progress: {i}/{len(entries)} "
                f"(processed={processed}, chunks={total_chunks}, skipped={skipped})"
            )

    log.info(
        f"  Chunking complete: {processed} acts, {total_chunks} chunks, "
        f"{skipped} skipped (no data)"
    )


# =========================================================================
# HELPERS
# =========================================================================

def _safe_int(val) -> int | None:
    """Safely convert to int."""
    try:
        return int(val)
    except (ValueError, TypeError):
        return None


def _infer_act_status(entry: dict) -> str:
    """Infer act status from index category."""
    cat = entry.get("category", "").lower()
    if cat == "repealed":
        return "repealed"
    elif cat == "spent":
        return "spent"
    else:
        return "in_force"


def _classify_html_section(sec_no: str, label: str, content: str) -> str:
    """Classify an HTML section by its number and label."""
    label_lower = label.lower()

    if sec_no == "1" and ("short title" in label_lower or "extent" in label_lower):
        return "short_title"
    if "definition" in label_lower or "interpretation" in label_lower:
        return "definitions"
    if "schedule" in label_lower:
        return "schedule"
    if "preamble" in label_lower:
        return "preamble"

    return "section"


def _detect_chapter_from_context(
    sec_no: str,
    label: str,
    previous_chunks: list[dict],
) -> tuple[str, str]:
    """Try to detect chapter from previous chunks or label patterns."""
    # Carry forward from previous chunk
    if previous_chunks:
        last = previous_chunks[-1]
        return last.get("chapter", ""), last.get("chapter_title", "")
    return "", ""


def _fuzzy_find_in_pdf(
    needle: str,
    haystack: str,
    start: int = 0,
) -> int:
    """
    Find needle text in PDF haystack, tolerating minor whitespace differences.
    """
    # Try exact match first
    pos = haystack.find(needle, start)
    if pos >= 0:
        return pos

    # Try with normalised whitespace
    import re
    needle_norm = re.sub(r"\s+", " ", needle).strip()
    # Search in chunks to avoid creating huge normalised string
    window = min(len(haystack) - start, 50000)
    search_text = haystack[start:start + window]
    search_norm = re.sub(r"\s+", " ", search_text)
    pos = search_norm.find(needle_norm)
    if pos >= 0:
        return start + pos

    return -1


def _build_clean_html(
    sections: list[dict],
    title: str,
    out_path: Path,
):
    """Build a clean standalone HTML file from sections for R2 hosting."""
    parts = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        f"<title>{title}</title>",
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        "<style>",
        "body { font-family: Georgia, serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }",
        "h2 { border-bottom: 1px solid #ccc; padding-bottom: 4px; }",
        ".section { margin-bottom: 24px; }",
        ".section-header { font-weight: bold; margin-bottom: 8px; }",
        ".footnote { font-size: 0.85em; color: #555; border-top: 1px solid #ddd; margin-top: 12px; padding-top: 8px; }",
        "sup { color: #0066cc; }",
        "</style>",
        "</head>",
        "<body>",
        f"<h1>{title}</h1>",
    ]

    for sec in sections:
        sec_no = sec.get("sectionNo", "").strip()
        label = sec.get("label", "").strip()
        content = sec.get("content", "")
        footnote = sec.get("footnote", "")

        header = f"{sec_no}. {label}" if sec_no and label else (sec_no or label or "")

        parts.append(f'<div class="section" id="section-{sec.get("sectionId", "")}">')
        if header:
            parts.append(f'<div class="section-header">{header}</div>')
        if content:
            parts.append(f"<div>{content}</div>")
        if footnote:
            parts.append(f'<div class="footnote">{footnote}</div>')
        parts.append("</div>")

    parts.extend(["</body>", "</html>"])

    out_path.write_text("\n".join(parts), encoding="utf-8")


# =========================================================================
# MAIN
# =========================================================================

def run_mistral_ocr_on_stubs():
    """
    Phase 1.5: Find all OCR stubs and process them with Mistral Batch OCR.

    Uses Mistral's Batch API ($1/1K pages — 50% cheaper than standard).
    Workflow:
    1. Collect all OCR stubs
    2. Build JSONL batch file with base64-encoded PDFs
    3. Upload batch file to Mistral
    4. Create batch job
    5. Poll until complete
    6. Download results and overwrite stubs
    """
    import base64
    import urllib.request
    import urllib.error

    MISTRAL_API_KEY = os.environ.get("MISTRAL_API_KEY", "")
    API_BASE = "https://api.mistral.ai/v1"
    OCR_MODEL = "mistral-ocr-latest"

    api_key = os.environ.get("MISTRAL_API_KEY", MISTRAL_API_KEY)

    def _api_call(endpoint: str, data: dict | None = None, method: str = "POST") -> dict:
        """Make authenticated API call to Mistral."""
        url = f"{API_BASE}/{endpoint}"
        body = json.dumps(data).encode("utf-8") if data else None
        req = urllib.request.Request(
            url, data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        resp = urllib.request.urlopen(req, timeout=300)
        return json.loads(resp.read().decode("utf-8"))

    def _upload_file(file_path: str) -> str:
        """Upload a file to Mistral and return file ID."""
        import mimetypes
        boundary = "----BatchUploadBoundary"
        file_name = os.path.basename(file_path)

        with open(file_path, "rb") as f:
            file_data = f.read()

        header = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="purpose"\r\n\r\n'
            f"batch\r\n"
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{file_name}"\r\n'
            f"Content-Type: application/jsonl\r\n\r\n"
        )
        body = header.encode() + file_data + f"\r\n--{boundary}--\r\n".encode()

        req = urllib.request.Request(
            f"{API_BASE}/files",
            data=body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=600)
        result = json.loads(resp.read().decode("utf-8"))
        return result["id"]

    # ---- Step 1: Collect stubs ----
    stubs = []
    for f in EXTRACTED_DIR.glob("*.extracted.json"):
        try:
            d = json.load(open(f))
            if d.get("parser_name") == "needs-mistral-ocr":
                pdf_path = d.get("source_pdf", "")
                if pdf_path and os.path.exists(pdf_path):
                    stubs.append({
                        "stub_path": str(f),
                        "act_id": d.get("act_id", f.stem),
                        "pdf_path": pdf_path,
                        "reason": d.get("ocr_reason", ""),
                    })
        except (json.JSONDecodeError, IOError):
            pass

    if not stubs:
        log.info("Phase 1.5: No OCR stubs found — skipping Mistral OCR")
        return

    # Estimate pages and cost
    total_pages = 0
    for stub in stubs:
        try:
            import pymupdf
            doc = pymupdf.open(stub["pdf_path"])
            stub["page_count"] = len(doc)
            total_pages += len(doc)
            doc.close()
        except Exception:
            stub["page_count"] = 5
            total_pages += 5

    batch_cost = total_pages / 1000 * 1  # $1/1K pages (batch pricing)
    log.info(
        f"Phase 1.5: MISTRAL BATCH OCR — {len(stubs)} stubs, "
        f"~{total_pages} pages, est. ${batch_cost:.2f} (batch pricing)"
    )

    # ---- Step 2: Build JSONL batch files (max 450MB each) ----
    MAX_BATCH_FILE_MB = 450
    batch_dir = OUTPUT_DIR / "_ocr_batches"
    batch_dir.mkdir(exist_ok=True)

    log.info(f"  Building batch files (max {MAX_BATCH_FILE_MB}MB each)...")

    batch_files = []
    current_batch_num = 0
    current_batch_path = None
    current_batch_file = None
    current_batch_size = 0
    current_batch_count = 0

    def _start_new_batch():
        nonlocal current_batch_num, current_batch_path, current_batch_file
        nonlocal current_batch_size, current_batch_count
        if current_batch_file:
            current_batch_file.close()
            batch_files.append({
                "path": current_batch_path,
                "size_mb": current_batch_size / 1024 / 1024,
                "count": current_batch_count,
            })
        current_batch_num += 1
        current_batch_path = str(batch_dir / f"batch_{current_batch_num:03d}.jsonl")
        current_batch_file = open(current_batch_path, "w")
        current_batch_size = 0
        current_batch_count = 0

    _start_new_batch()

    for i, stub in enumerate(stubs):
        try:
            pdf_size = os.path.getsize(stub["pdf_path"])
            # base64 expands ~33%, plus JSON overhead
            estimated_entry_size = int(pdf_size * 1.4)

            # Start new batch if this entry would exceed limit
            if current_batch_size + estimated_entry_size > MAX_BATCH_FILE_MB * 1024 * 1024:
                _start_new_batch()

            with open(stub["pdf_path"], "rb") as f:
                pdf_b64 = base64.b64encode(f.read()).decode("utf-8")

            batch_entry = {
                "custom_id": stub["act_id"],
                "body": {
                    "model": OCR_MODEL,
                    "document": {
                        "type": "document_url",
                        "document_url": f"data:application/pdf;base64,{pdf_b64}",
                    },
                    "include_image_base64": False,
                },
            }
            line = json.dumps(batch_entry, ensure_ascii=False) + "\n"
            current_batch_file.write(line)
            current_batch_size += len(line.encode("utf-8"))
            current_batch_count += 1

        except Exception as e:
            log.warning(f"  Skipping {stub['act_id']} for batch: {e}")

        if (i + 1) % 100 == 0:
            log.info(f"  Batch prep: {i + 1}/{len(stubs)} entries")

    # Close last batch
    if current_batch_file:
        current_batch_file.close()
        if current_batch_count > 0:
            batch_files.append({
                "path": current_batch_path,
                "size_mb": current_batch_size / 1024 / 1024,
                "count": current_batch_count,
            })

    log.info(f"  Created {len(batch_files)} batch files:")
    for bf in batch_files:
        log.info(f"    {os.path.basename(bf['path'])}: {bf['count']} PDFs, {bf['size_mb']:.0f}MB")

    # ---- Step 3-5: Upload, submit, poll each batch ----
    stub_map = {s["act_id"]: s for s in stubs}
    total_success = 0
    total_failed = 0

    for bi, bf in enumerate(batch_files, 1):
        log.info(f"  === Batch job {bi}/{len(batch_files)}: {bf['count']} PDFs, {bf['size_mb']:.0f}MB ===")

        # Upload
        try:
            file_id = _upload_file(bf["path"])
            log.info(f"  Uploaded: file_id={file_id}")
        except Exception as e:
            log.error(f"  Upload failed: {e} — running standard OCR for this batch")
            # Collect stubs in this batch and run standard
            batch_stubs = []
            for line in open(bf["path"]):
                entry = json.loads(line)
                act_id = entry.get("custom_id", "")
                if act_id in stub_map:
                    batch_stubs.append(stub_map[act_id])
            _run_standard_ocr(batch_stubs, api_key, OCR_MODEL)
            continue

        # Create job
        try:
            job = _api_call("batch/jobs", {
                "input_files": [file_id],
                "model": OCR_MODEL,
                "endpoint": "/v1/ocr",
                "metadata": {"job_type": f"indiacode_ocr_batch_{bi}"},
            })
            job_id = job["id"]
            log.info(f"  Job created: {job_id}")
        except Exception as e:
            log.error(f"  Job creation failed: {e}")
            continue

        # Poll
        poll_interval = 30
        max_wait = 7200
        elapsed = 0
        state = "QUEUED"

        while elapsed < max_wait:
            time.sleep(poll_interval)
            elapsed += poll_interval
            try:
                status = _api_call(f"batch/jobs/{job_id}", method="GET")
                state = status.get("status", "UNKNOWN")
                succeeded = status.get("succeeded_requests", 0)
                total_req = status.get("total_requests", bf["count"])
                failed_req = status.get("failed_requests", 0)
                log.info(
                    f"  Batch {bi} status: {state} — "
                    f"{succeeded}/{total_req} done, {failed_req} failed "
                    f"({elapsed}s elapsed)"
                )
                if state in ("COMPLETED", "FAILED", "EXPIRED", "CANCELLED"):
                    break
            except Exception as e:
                log.warning(f"  Poll error: {e}")

        if state != "COMPLETED":
            log.error(f"  Batch {bi} did not complete: {state}")
            total_failed += bf["count"]
            continue

        # Download results
        output_file_id = status.get("output_file")
        if not output_file_id:
            log.error(f"  Batch {bi}: no output file")
            continue

        try:
            req = urllib.request.Request(
                f"{API_BASE}/files/{output_file_id}/content",
                headers={"Authorization": f"Bearer {api_key}"},
                method="GET",
            )
            resp = urllib.request.urlopen(req, timeout=600)
            results_data = resp.read().decode("utf-8")
        except Exception as e:
            log.error(f"  Batch {bi} download failed: {e}")
            continue

        # Process results
        for line in results_data.strip().split("\n"):
            if not line.strip():
                continue
            try:
                result = json.loads(line)
                act_id = result.get("custom_id", "")
                stub = stub_map.get(act_id)
                if not stub:
                    continue

                response = result.get("response", {})
                ocr_body = response.get("body", {})
                ocr_pages = ocr_body.get("pages", [])

                if not ocr_pages:
                    total_failed += 1
                    continue

                pages = []
                full_text_parts = []
                for page in ocr_pages:
                    page_text = page.get("markdown", "")
                    full_text_parts.append(page_text)
                    pages.append({
                        "page_number": page.get("index", len(pages)) + 1,
                        "text": page_text,
                        "char_count": len(page_text),
                        "ocred": True,
                    })

                extracted = {
                    "act_id": act_id,
                    "source_pdf": stub["pdf_path"],
                    "text": "\n\n".join(full_text_parts),
                    "pages": pages,
                    "page_count": len(pages),
                    "parser_name": "mistral-ocr-batch",
                    "ocr_used": True,
                    "needs_ocr_review": False,
                    "quality_score": 1.0,
                    "ocr_reason": stub["reason"],
                    "extracted_at": datetime.now(timezone.utc).isoformat(),
                }

                with open(stub["stub_path"], "w") as f:
                    json.dump(extracted, f, ensure_ascii=False)

                total_success += 1
            except Exception as e:
                log.warning(f"  Error processing result: {e}")
                total_failed += 1

        log.info(f"  Batch {bi} done: {total_success} ok total")

    log.info(
        f"Phase 1.5: Mistral Batch OCR complete — "
        f"{total_success} ok, {total_failed} failed"
    )

    # Cleanup batch files
    import shutil
    try:
        shutil.rmtree(str(batch_dir))
    except Exception:
        pass


def _run_standard_ocr(stubs: list[dict], api_key: str, model: str):
    """Fallback: standard one-by-one OCR if batch fails."""
    import base64
    import urllib.request
    import urllib.error

    OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr"
    success = 0
    failed = 0

    for stub in stubs:
        try:
            with open(stub["pdf_path"], "rb") as f:
                pdf_b64 = base64.b64encode(f.read()).decode("utf-8")

            body = json.dumps({
                "model": model,
                "document": {
                    "type": "document_url",
                    "document_url": f"data:application/pdf;base64,{pdf_b64}",
                },
                "include_image_base64": False,
            }).encode("utf-8")

            req = urllib.request.Request(
                OCR_ENDPOINT, data=body,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )
            resp = urllib.request.urlopen(req, timeout=300)
            result = json.loads(resp.read().decode("utf-8"))

            ocr_pages = result.get("pages", [])
            if not ocr_pages:
                failed += 1
                continue

            pages = []
            full_text_parts = []
            for page in ocr_pages:
                page_text = page.get("markdown", "")
                full_text_parts.append(page_text)
                pages.append({
                    "page_number": page.get("index", len(pages)) + 1,
                    "text": page_text,
                    "char_count": len(page_text),
                    "ocred": True,
                })

            extracted = {
                "act_id": stub["act_id"],
                "source_pdf": stub["pdf_path"],
                "text": "\n\n".join(full_text_parts),
                "pages": pages,
                "page_count": len(pages),
                "parser_name": "mistral-ocr",
                "ocr_used": True,
                "needs_ocr_review": False,
                "quality_score": 1.0,
                "ocr_reason": stub["reason"],
                "extracted_at": datetime.now(timezone.utc).isoformat(),
            }

            with open(stub["stub_path"], "w") as f:
                json.dump(extracted, f, ensure_ascii=False)

            success += 1
            time.sleep(0.3)

        except Exception as e:
            log.warning(f"  Standard OCR error for {stub['act_id']}: {e}")
            failed += 1

    log.info(f"  Standard OCR fallback: {success} ok, {failed} failed")


def load_all_entries() -> list[dict]:
    """Load all act entries from the linked index."""
    entries = []
    for idx_file in sorted(INDEX_DIR.glob("*.jsonl")):
        with open(idx_file) as f:
            for line in f:
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
    return entries


def main():
    parser = argparse.ArgumentParser(description="IndiaCode Legislation RAG Pipeline")
    parser.add_argument(
        "--phase",
        choices=["extract", "ocr", "chunk", "all"],
        default="all",
        help="Pipeline phase to run",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=DEFAULT_WORKERS,
        help=f"Number of parallel workers (default: {DEFAULT_WORKERS})",
    )
    parser.add_argument(
        "--act-id",
        type=str,
        default=None,
        help="Process a single act by ID (e.g., IND_central_1726)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit to first N acts (for testing)",
    )
    args = parser.parse_args()

    log.info("=" * 60)
    log.info("IndiaCode Legislation RAG Pipeline")
    log.info(f"Phase: {args.phase}")
    log.info(f"Workers: {args.workers}")
    log.info(f"Output: {OUTPUT_DIR}")
    log.info("=" * 60)

    entries = load_all_entries()
    log.info(f"Loaded {len(entries)} act entries from index")

    # Filter to single act if specified
    if args.act_id:
        entries = [e for e in entries if e["actId"] == args.act_id]
        if not entries:
            log.error(f"Act {args.act_id} not found in index")
            return
        log.info(f"Filtered to single act: {args.act_id}")

    # Limit for testing
    if args.limit:
        entries = entries[: args.limit]
        log.info(f"Limited to {len(entries)} acts")

    start = time.time()

    if args.phase in ("extract", "all"):
        run_extraction(entries, workers=args.workers)

    # Phase 1.5: Mistral OCR for stubs (scanned/corrupt/short PDFs)
    if args.phase in ("extract", "ocr", "all"):
        run_mistral_ocr_on_stubs()

    if args.phase in ("chunk", "all"):
        run_chunking(entries)

    elapsed = time.time() - start
    log.info(f"Pipeline complete in {elapsed:.0f}s")

    # Write summary report
    _write_report(entries)


def _write_report(entries: list[dict]):
    """Generate a summary report."""
    chunk_files = list(CHUNKS_DIR.glob("*.chunks.jsonl"))
    total_chunks = 0
    section_type_counts: dict[str, int] = {}

    for cf in chunk_files:
        with open(cf) as f:
            for line in f:
                total_chunks += 1
                try:
                    chunk = json.loads(line)
                    st = chunk.get("section_type", "unknown")
                    section_type_counts[st] = section_type_counts.get(st, 0) + 1
                except json.JSONDecodeError:
                    pass

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_acts_in_index": len(entries),
        "acts_with_chunks": len(chunk_files),
        "total_chunks": total_chunks,
        "section_type_distribution": dict(
            sorted(section_type_counts.items(), key=lambda x: -x[1])
        ),
        "output_dir": str(OUTPUT_DIR),
    }

    report_path = OUTPUT_DIR / "_report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    log.info(f"Report written to {report_path}")
    log.info(f"  Total chunks: {total_chunks}")
    log.info(f"  Section types: {section_type_counts}")


if __name__ == "__main__":
    main()
