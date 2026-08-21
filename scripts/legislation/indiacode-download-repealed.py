#!/usr/bin/env python3
"""
Download 3,906 repealed/spent act PDFs from IndiaCode.

These acts have direct pdfUrl like:
  https://www.indiacode.nic.in/repealedfileopen?rfilename=A1834-2.pdf

Also extracts rich metadata from:
- The pdfUrl filename pattern (act number, year)
- The index entry (title, enactment date, sourceUrl)
- The PDF text itself (after download)

Output:
  data/indiacode/pdfs/repealed/{filename}.pdf
  data/indiacode/index/repealed-enriched.jsonl  (updated index with pdfPath)

Usage:
  python scripts/indiacode-download-repealed.py
  python scripts/indiacode-download-repealed.py --test        # 5 acts only
  python scripts/indiacode-download-repealed.py --workers 10  # concurrency
  python scripts/indiacode-download-repealed.py --resume      # skip existing
"""

import argparse
import json
import logging
import os
import re
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data" / "indiacode"
INDEX_DIR = DATA_DIR / "index-linked"
PDF_DIR = DATA_DIR / "pdfs" / "repealed"
PROGRESS_FILE = DATA_DIR / "repealed-download-progress.json"
ENRICHED_FILE = DATA_DIR / "index" / "repealed-enriched.jsonl"

PDF_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_WORKERS = 8
RETRY_COUNT = 3
RETRY_DELAY = 2
REQUEST_TIMEOUT = 30

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(DATA_DIR / "repealed-download.log"),
    ],
)
log = logging.getLogger("repealed-dl")


# ---------------------------------------------------------------------------
# Metadata extraction from repealed act entries
# ---------------------------------------------------------------------------

def extract_metadata_from_entry(entry: dict) -> dict:
    """Extract rich metadata from the index entry and pdfUrl pattern."""
    meta = {
        "actId": entry.get("actId", ""),
        "title": entry.get("title", ""),
        "year": entry.get("year", ""),
        "actNumber": entry.get("actNumber", ""),
        "category": "repealed",
        "state": "central",
        "enactmentDate": entry.get("enactmentDate", ""),
        "sourceUrl": entry.get("sourceUrl", ""),
        "pdfUrl": entry.get("pdfUrl", ""),
        "department": entry.get("department", ""),
        "ministry": entry.get("ministry", ""),
    }

    # Parse title for extra info: "The XYZ Act, 1834, 2 of 1834 (Rep., A.O. 1950)"
    title = entry.get("title", "")

    # Extract repealing info from title
    rep_match = re.search(
        r"\(Rep\.?,?\s*(?:by\s+)?(?:Act\s+)?(\d+)?\s*(?:of\s+)?(\d{4})?\s*\)",
        title,
        re.IGNORECASE,
    )
    if rep_match:
        meta["repealed_by_act"] = rep_match.group(1) or ""
        meta["repealed_by_year"] = rep_match.group(2) or ""

    # Extract from "A.O. 1950" pattern (Adaptation of Laws Order)
    ao_match = re.search(r"A\.O\.\s*(\d{4})", title)
    if ao_match:
        meta["repealed_by_order"] = f"Adaptation of Laws Order, {ao_match.group(1)}"

    # Extract act number from pdfUrl: A1834-2.pdf → act 2 of 1834
    pdf_url = entry.get("pdfUrl", "")
    pdf_match = re.search(r"rfilename=A(\d{4})-(\d+)\.pdf", pdf_url)
    if pdf_match:
        meta["pdf_year"] = pdf_match.group(1)
        meta["pdf_act_number"] = pdf_match.group(2)
        if not meta["year"]:
            meta["year"] = pdf_match.group(1)
        if not meta["actNumber"]:
            meta["actNumber"] = pdf_match.group(2)

    # Clean title — remove the "(Rep., ...)" suffix for cleaner display
    clean_title = re.sub(r"\s*\(Rep\.?.*?\)\s*$", "", title).strip()
    # Also remove trailing act number "2 of 1834"
    clean_title = re.sub(r",?\s*\d+\s+of\s+\d{4}\s*$", "", clean_title).strip()
    clean_title = clean_title.rstrip(",").strip()
    meta["title_clean"] = clean_title

    meta["act_status"] = "repealed"
    meta["downloaded_at"] = datetime.now(timezone.utc).isoformat()

    return meta


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------

def download_pdf(pdf_url: str, out_path: str) -> bool:
    """Download a PDF with retries."""
    for attempt in range(RETRY_COUNT):
        try:
            req = urllib.request.Request(pdf_url, headers={"User-Agent": USER_AGENT})
            resp = urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT)

            content_type = resp.headers.get("Content-Type", "")
            if "pdf" not in content_type.lower() and "octet" not in content_type.lower():
                log.warning(f"Unexpected content type: {content_type} for {pdf_url}")

            data = resp.read()
            if len(data) < 500:
                log.warning(f"Suspiciously small PDF ({len(data)} bytes): {pdf_url}")
                return False

            with open(out_path, "wb") as f:
                f.write(data)
            return True

        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            if attempt < RETRY_COUNT - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
            else:
                log.error(f"Failed after {RETRY_COUNT} attempts: {pdf_url}: {e}")
                return False

    return False


def _download_worker(args: tuple) -> tuple[str, bool, dict]:
    """Worker: download one repealed act PDF and return metadata."""
    entry, out_path, resume = args
    act_id = entry.get("actId", "")
    pdf_url = entry.get("pdfUrl", "")

    if not pdf_url:
        return act_id, False, {}

    if resume and os.path.exists(out_path) and os.path.getsize(out_path) > 500:
        meta = extract_metadata_from_entry(entry)
        meta["pdfPath"] = os.path.relpath(out_path, str(DATA_DIR))
        meta["pdf_size_bytes"] = os.path.getsize(out_path)
        return act_id, True, meta

    ok = download_pdf(pdf_url, out_path)
    meta = extract_metadata_from_entry(entry)

    if ok:
        meta["pdfPath"] = os.path.relpath(out_path, str(DATA_DIR))
        meta["pdf_size_bytes"] = os.path.getsize(out_path)

    return act_id, ok, meta


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_repealed_entries() -> list[dict]:
    """Load all repealed/spent entries with no data and a pdfUrl."""
    entries = []
    for idx_file in sorted(INDEX_DIR.glob("*.jsonl")):
        for line in open(idx_file):
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if d.get("dataSource") == "none" and d.get("pdfUrl"):
                entries.append(d)
    return entries


def main():
    parser = argparse.ArgumentParser(description="Download repealed act PDFs from IndiaCode")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--test", action="store_true", help="Download only 5 acts")
    parser.add_argument("--resume", action="store_true", default=True, help="Skip existing PDFs")
    parser.add_argument("--no-resume", dest="resume", action="store_false")
    args = parser.parse_args()

    entries = load_repealed_entries()
    log.info(f"Found {len(entries)} repealed/spent acts with pdfUrl to download")

    if args.test:
        entries = entries[:5]
        log.info("TEST MODE: downloading 5 acts only")

    # Build tasks
    tasks = []
    for entry in entries:
        pdf_url = entry.get("pdfUrl", "")
        # Extract filename from URL
        fname_match = re.search(r"rfilename=(.+\.pdf)", pdf_url)
        if fname_match:
            filename = fname_match.group(1)
        else:
            filename = f"{entry.get('actId', 'unknown')}.pdf"

        out_path = str(PDF_DIR / filename)
        tasks.append((entry, out_path, args.resume))

    log.info(f"Downloading {len(tasks)} PDFs with {args.workers} workers")

    success = 0
    failed = 0
    enriched: list[dict] = []

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(_download_worker, t): t[0].get("actId") for t in tasks}
        for i, future in enumerate(as_completed(futures), 1):
            act_id = futures[future]
            try:
                _, ok, meta = future.result()
                if ok:
                    success += 1
                    enriched.append(meta)
                else:
                    failed += 1
            except Exception as e:
                log.error(f"Worker error for {act_id}: {e}")
                failed += 1

            if i % 100 == 0:
                log.info(f"Progress: {i}/{len(tasks)} (ok={success}, fail={failed})")

    log.info(f"Download complete: {success} ok, {failed} failed")

    # Write enriched metadata
    if enriched:
        with open(ENRICHED_FILE, "w") as f:
            for meta in enriched:
                f.write(json.dumps(meta, ensure_ascii=False) + "\n")
        log.info(f"Enriched metadata written: {ENRICHED_FILE} ({len(enriched)} entries)")

    # Write progress
    progress = {
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "total": len(tasks),
        "success": success,
        "failed": failed,
    }
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


if __name__ == "__main__":
    main()
