#!/usr/bin/env python3
"""
Mistral OCR for scanned IndiaCode PDFs (REST API, no SDK).

ONLY processes PDFs that need OCR (< 200 chars native text in first 3 pages).
Skips PDFs that pymupdf4llm can handle natively.

Usage:
    python ocr-mistral.py --dry-run              # Count scanned PDFs
    python ocr-mistral.py --standard              # OCR one-by-one ($2/1K pages)
    python ocr-mistral.py --standard --limit 5    # Test with 5
    python ocr-mistral.py --single /path/to.pdf --act-id IND_central_1234
"""

import argparse
import base64
import json
import logging
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR.parent.parent.parent / "data" / "indiacode"
INDEX_DIR = DATA_DIR / "index-linked"
EXTRACTED_DIR = DATA_DIR / "rag-output" / "extracted"
OCR_PROGRESS_FILE = DATA_DIR / "ocr-mistral-progress.json"

EXTRACTED_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MISTRAL_API_KEY = os.environ.get("MISTRAL_API_KEY", "")
PYMUPDF_PRO_KEY = "lN2Ny16nOf72t73tb3tV7y2j"
OCR_MODEL = "mistral-ocr-latest"
OCR_ENDPOINT = "https://api.mistral.ai/v1/ocr"
FILES_ENDPOINT = "https://api.mistral.ai/v1/files"
MIN_CHARS_THRESHOLD = 200
SAMPLE_PAGES = 3

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(str(DATA_DIR / "ocr-mistral.log")),
    ],
)
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# REST helpers
# ---------------------------------------------------------------------------

def _api_key():
    return os.environ.get("MISTRAL_API_KEY", MISTRAL_API_KEY)


def _post_json(url: str, body: dict, timeout: int = 120) -> dict:
    """POST JSON to Mistral API."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {_api_key()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=timeout)
    return json.loads(resp.read().decode("utf-8"))


def _upload_file(file_path: str, purpose: str = "ocr") -> str:
    """Upload a file to Mistral and return file_id."""
    import mimetypes

    boundary = "----MistralOCRBoundary"
    filename = os.path.basename(file_path)
    mime_type = mimetypes.guess_type(file_path)[0] or "application/pdf"

    with open(file_path, "rb") as f:
        file_data = f.read()

    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="purpose"\r\n\r\n'
        f"{purpose}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {mime_type}\r\n\r\n"
    ).encode("utf-8") + file_data + f"\r\n--{boundary}--\r\n".encode("utf-8")

    req = urllib.request.Request(
        FILES_ENDPOINT,
        data=body,
        headers={
            "Authorization": f"Bearer {_api_key()}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=120)
    result = json.loads(resp.read().decode("utf-8"))
    return result["id"]


# ---------------------------------------------------------------------------
# PDF scanning
# ---------------------------------------------------------------------------

def needs_ocr(pdf_path: str) -> bool:
    """Check if a PDF needs OCR (scanned image, no native text)."""
    import pymupdf

    try:
        doc = pymupdf.open(pdf_path)
        n = len(doc)
        if n == 0:
            doc.close()
            return True
        total = 0
        for i in range(min(SAMPLE_PAGES, n)):
            total += len(doc[i].get_text("text").strip())
        doc.close()
        return total < MIN_CHARS_THRESHOLD
    except Exception:
        return True


def scan_all_pdfs() -> list[dict]:
    """Scan index, return entries needing OCR (skips already-extracted)."""
    import pymupdf

    try:
        import pymupdf.pro
        pymupdf.pro.unlock(PYMUPDF_PRO_KEY)
    except Exception:
        pass

    entries = []
    for idx_file in sorted(INDEX_DIR.glob("*.jsonl")):
        for line in open(idx_file):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            pdf_path = entry.get("pdfPath")
            if not pdf_path:
                continue

            full_pdf = str(DATA_DIR / pdf_path)
            if not os.path.exists(full_pdf):
                continue

            act_id = entry["actId"]
            if (EXTRACTED_DIR / f"{act_id}.extracted.json").exists():
                continue

            entries.append({
                "actId": act_id,
                "pdfPath": pdf_path,
                "full_pdf_path": full_pdf,
                "title": entry.get("title", ""),
            })

    ocr_entries = []
    for i, entry in enumerate(entries):
        if needs_ocr(entry["full_pdf_path"]):
            doc = pymupdf.open(entry["full_pdf_path"])
            entry["page_count"] = len(doc)
            doc.close()
            ocr_entries.append(entry)

        if (i + 1) % 500 == 0:
            log.info(f"  Scanned {i + 1}/{len(entries)} PDFs, {len(ocr_entries)} need OCR")

    return ocr_entries


# ---------------------------------------------------------------------------
# OCR via REST API
# ---------------------------------------------------------------------------

def ocr_single_pdf(pdf_path: str, act_id: str) -> dict | None:
    """
    OCR a single PDF using Mistral REST API.

    Strategy: Send as base64 data URL (avoids file upload for small PDFs).
    For large PDFs (>20MB), upload first then reference file_id.
    """
    file_size = os.path.getsize(pdf_path)

    if file_size > 20 * 1024 * 1024:
        # Large file — upload first
        log.info(f"  Large PDF ({file_size // 1024 // 1024}MB), uploading first...")
        file_id = _upload_file(pdf_path)
        document = {"type": "file_id", "file_id": file_id}
    else:
        # Small file — base64 inline
        with open(pdf_path, "rb") as f:
            pdf_b64 = base64.b64encode(f.read()).decode("utf-8")
        document = {
            "type": "document_url",
            "document_url": f"data:application/pdf;base64,{pdf_b64}",
        }

    body = {
        "model": OCR_MODEL,
        "document": document,
        "include_image_base64": False,
    }

    try:
        result = _post_json(OCR_ENDPOINT, body, timeout=300)
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="ignore")
        log.error(f"  HTTP {e.code}: {error_body[:200]}")
        return None
    except Exception as e:
        log.error(f"  Request failed: {e}")
        return None

    ocr_pages = result.get("pages", [])
    if not ocr_pages:
        return None

    # Convert to pipeline format
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

    full_text = "\n\n".join(full_text_parts)

    if len(full_text.strip()) < 50:
        return None

    return {
        "act_id": act_id,
        "source_pdf": pdf_path,
        "text": full_text,
        "pages": pages,
        "page_count": len(pages),
        "parser_name": "mistral-ocr",
        "ocr_used": True,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# Standard processing (one-by-one)
# ---------------------------------------------------------------------------

def run_standard_ocr(entries: list[dict], limit: int | None = None):
    """Process PDFs one-by-one using Mistral OCR REST API."""
    if limit:
        entries = entries[:limit]

    total_pages = sum(e.get("page_count", 0) for e in entries)
    est_cost = total_pages / 1000 * 2
    log.info(f"Standard OCR: {len(entries)} PDFs, ~{total_pages} pages, est. ${est_cost:.2f}")

    progress = _load_progress()
    completed = set(progress.get("completed", []))

    success = 0
    failed = 0

    for i, entry in enumerate(entries):
        act_id = entry["actId"]
        if act_id in completed:
            continue

        out_path = EXTRACTED_DIR / f"{act_id}.extracted.json"
        if out_path.exists():
            completed.add(act_id)
            continue

        try:
            result = ocr_single_pdf(entry["full_pdf_path"], act_id)
            if result:
                with open(out_path, "w") as f:
                    json.dump(result, f, ensure_ascii=False)
                success += 1
                completed.add(act_id)
                log.info(f"  [{i + 1}/{len(entries)}] {act_id}: {result['page_count']} pages, {len(result['text'])} chars")
            else:
                log.warning(f"  [{i + 1}/{len(entries)}] {act_id}: empty OCR result")
                failed += 1
        except Exception as e:
            log.error(f"  [{i + 1}/{len(entries)}] {act_id}: {e}")
            failed += 1

        if (i + 1) % 10 == 0:
            _save_progress({"completed": list(completed), "success": success, "failed": failed})

        # No delay — testing rate limits
        time.sleep(0.1)

    _save_progress({"completed": list(completed), "success": success, "failed": failed})
    log.info(f"OCR complete: {success} ok, {failed} failed")


# ---------------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------------

def _load_progress() -> dict:
    if OCR_PROGRESS_FILE.exists():
        return json.loads(OCR_PROGRESS_FILE.read_text())
    return {}


def _save_progress(data: dict):
    OCR_PROGRESS_FILE.write_text(json.dumps(data, indent=2))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Mistral OCR for scanned IndiaCode PDFs")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Scan and report only")
    mode.add_argument("--standard", action="store_true", help="OCR one-by-one via REST")
    mode.add_argument("--single", type=str, help="OCR a single PDF file")

    parser.add_argument("--act-id", type=str, help="Act ID for --single mode")
    parser.add_argument("--limit", type=int, help="Limit to first N PDFs")

    args = parser.parse_args()

    if args.single:
        log.info(f"OCR single PDF: {args.single}")
        act_id = args.act_id or "test_ocr"
        result = ocr_single_pdf(args.single, act_id)
        if result:
            out_path = EXTRACTED_DIR / f"{act_id}.extracted.json"
            with open(out_path, "w") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            log.info(f"Saved: {out_path}")
            log.info(f"Pages: {result['page_count']}, Chars: {len(result['text'])}")
            log.info(f"First 500 chars:\n{result['text'][:500]}")
        else:
            log.error("OCR returned no text")
        return

    log.info("Scanning PDFs to find scanned documents...")
    ocr_entries = scan_all_pdfs()

    total_pages = sum(e.get("page_count", 0) for e in ocr_entries)
    log.info(f"Found {len(ocr_entries)} PDFs needing OCR ({total_pages} pages)")
    log.info(f"Estimated cost: ${total_pages / 1000 * 2:.2f} (standard)")

    if args.dry_run:
        by_cat = {}
        for e in ocr_entries:
            cat = e["pdfPath"].split("/")[1] if "/" in e["pdfPath"] else "unknown"
            if cat not in by_cat:
                by_cat[cat] = {"count": 0, "pages": 0}
            by_cat[cat]["count"] += 1
            by_cat[cat]["pages"] += e.get("page_count", 0)
        for cat, s in sorted(by_cat.items(), key=lambda x: -x[1]["count"]):
            log.info(f"  {cat:30s}: {s['count']:>5d} PDFs, {s['pages']:>6d} pages")
        return

    if args.standard:
        run_standard_ocr(ocr_entries, limit=args.limit)


if __name__ == "__main__":
    main()
