#!/usr/bin/env python3
"""
Re-scrape 3,968 state/central acts that have handles but returned 0 sections.

For each act:
  1. Fetch the handle page → extract AC_ID, section list, PDF URL
  2. Download the PDF (bitstream or upload.indiacode.nic.in)
  3. Fetch each section via /SectionPageContent API → {content, footnote}
  4. Save HTML JSON + PDF with rich metadata

Output:
  data/indiacode/html/{state}/{handle_slug}.json   (HTML sections)
  data/indiacode/pdfs/{state}/{slug}.pdf            (PDF download)
  data/indiacode/rescrape-progress.json             (checkpoint)

Usage:
  python scripts/indiacode-rescrape-missing.py
  python scripts/indiacode-rescrape-missing.py --test         # 5 acts
  python scripts/indiacode-rescrape-missing.py --workers 5    # concurrency
  python scripts/indiacode-rescrape-missing.py --state assam  # one state
  python scripts/indiacode-rescrape-missing.py --pdf-only     # skip HTML
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
HTML_DIR = DATA_DIR / "html"
PDF_DIR = DATA_DIR / "pdfs"
PROGRESS_FILE = DATA_DIR / "rescrape-progress.json"

DEFAULT_WORKERS = 5  # conservative — IndiaCode has no rate limit but be polite
RETRY_COUNT = 3
RETRY_DELAY = 3
REQUEST_TIMEOUT = 25

BASE_URL = "https://www.indiacode.nic.in"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(DATA_DIR / "rescrape.log"),
    ],
)
log = logging.getLogger("rescrape")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def http_get(url: str, timeout: int = REQUEST_TIMEOUT) -> str:
    """GET a URL and return response body as string."""
    for attempt in range(RETRY_COUNT):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            resp = urllib.request.urlopen(req, timeout=timeout)
            return resp.read().decode("utf-8", errors="ignore")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            if attempt < RETRY_COUNT - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
            else:
                raise


def http_download(url: str, out_path: str, timeout: int = 30) -> bool:
    """Download binary file with retries."""
    for attempt in range(RETRY_COUNT):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            resp = urllib.request.urlopen(req, timeout=timeout)
            data = resp.read()
            if len(data) < 500:
                return False
            with open(out_path, "wb") as f:
                f.write(data)
            return True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
            if attempt < RETRY_COUNT - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
    return False


# ---------------------------------------------------------------------------
# IndiaCode page parsing
# ---------------------------------------------------------------------------

def parse_act_page(html: str) -> dict:
    """
    Parse an IndiaCode act handle page.
    Extracts: AC_ID, section list, PDF URL, schedule list, metadata.
    """
    result = {
        "acId": "",
        "sections": [],
        "schedules": [],
        "pdfUrl": "",
        "chapters": [],
    }

    # Extract AC_ ID from preamble
    ac_match = re.search(
        r'id="(AC_[A-Z0-9_]+)"\s+class="preambletitle"', html
    )
    if ac_match:
        result["acId"] = ac_match.group(1)

    # Extract sections: id="AC_ID#sectionId#AC_ID" class="title" ... sectionno=N
    section_pattern = re.compile(
        r'id="(AC_[A-Z0-9_]+)#(\d+)#(?:AC_[A-Z0-9_]+)"\s+class="title"\s+'
        r'[^>]*href=[^>]*sectionno=(\d+)[^>]*>\s*<span[^>]*class="label\s+label-default">'
        r'\s*Section\s+(\S+?)\s*</span>\s*(?:&nbsp;)?\s*([^<]*?)\s*</a>',
        re.IGNORECASE | re.DOTALL,
    )
    for m in section_pattern.finditer(html):
        if not result["acId"]:
            result["acId"] = m.group(1)
        result["sections"].append({
            "sectionId": m.group(2),
            "sectionNo": m.group(4).strip().rstrip("."),
            "label": m.group(5).strip().rstrip("."),
        })

    # Fallback: broader section pattern
    if not result["sections"]:
        fallback = re.compile(
            r'id="(AC_[A-Z0-9_]+)#(\d+)#[^"]*"\s+class="title"[^>]*>'
            r'[\s\S]*?Section\s+(\S+?)\.\s*</span>\s*(?:&nbsp;)?\s*([^<]*?)\s*</a>',
            re.IGNORECASE,
        )
        for m in fallback.finditer(html):
            if not result["acId"]:
                result["acId"] = m.group(1)
            result["sections"].append({
                "sectionId": m.group(2),
                "sectionNo": m.group(3).strip().rstrip("."),
                "label": m.group(4).strip().rstrip("."),
            })

    # Extract AC_ID from ANY id attribute if still missing
    if not result["acId"]:
        any_ac = re.search(r'id="(AC_[A-Z0-9_]+)', html)
        if any_ac:
            result["acId"] = any_ac.group(1)

    # Extract PDF URL (5 patterns from the TS scraper)
    pdf_patterns = [
        (r'href="(/bitstream/123456789/\d+/\d+/[^"]+\.pdf)"', True),
        (r'href="(https?://upload\.indiacode\.nic\.in/showfile[^"]+)"', False),
        (r'href="(/ViewFileUploaded[^"]+)"', True),
        (r'href="(/repealedfileopen[^"]+)"', True),
        (r'href="([^"]*\.pdf[^"]*)"', True),
    ]
    for pattern, needs_base in pdf_patterns:
        m = re.search(pattern, html, re.IGNORECASE)
        if m:
            url = m.group(1)
            if needs_base and not url.startswith("http"):
                url = f"{BASE_URL}{url}"
            result["pdfUrl"] = url
            break

    # Extract schedules
    sched_pattern = re.compile(
        r'href="(https?://upload\.indiacode\.nic\.in/schedulefile[^"]+)"[^>]*>'
        r'\s*([^<]+)',
        re.IGNORECASE,
    )
    for m in sched_pattern.finditer(html):
        result["schedules"].append({
            "pdfUrl": m.group(1),
            "label": m.group(2).strip(),
        })

    # Extract chapters
    chap_pattern = re.compile(
        r'id="(AC_[A-Z0-9_]+)#(\d+)#(\d+)#(?:AC_[A-Z0-9_]+)"\s+class="headingtwo"',
        re.IGNORECASE,
    )
    for m in chap_pattern.finditer(html):
        result["chapters"].append({
            "chapterId": m.group(2),
            "orgId": m.group(3),
        })

    return result


def fetch_section_content(ac_id: str, section_id: str) -> dict:
    """Fetch section content from the SectionPageContent API."""
    url = f"{BASE_URL}/SectionPageContent?actid={ac_id}&sectionID={section_id}"
    try:
        body = http_get(url, timeout=15)
        # Response is JSON: { content: "...", footnote: "..." }
        data = json.loads(body)
        return {
            "content": data.get("content", ""),
            "footnote": data.get("footnote", ""),
        }
    except (json.JSONDecodeError, Exception) as e:
        log.debug(f"Section fetch failed: {ac_id}/{section_id}: {e}")
        return {"content": "", "footnote": ""}


# ---------------------------------------------------------------------------
# Process one act
# ---------------------------------------------------------------------------

def process_act(entry: dict, pdf_only: bool = False) -> dict:
    """
    Process a single act: fetch page, extract sections, download PDF.

    Returns metadata dict with results.
    """
    act_id = entry["actId"]
    handle = entry.get("handle", "")
    title = entry.get("title", "")
    state = entry.get("state", "central")
    source_url = entry.get("sourceUrl", "")

    result = {
        "actId": act_id,
        "title": title,
        "handle": handle,
        "state": state,
        "pdf_downloaded": False,
        "sections_extracted": 0,
        "pdf_path": None,
        "html_path": None,
        "error": None,
    }

    try:
        # 1. Fetch the handle page
        page_html = http_get(source_url)
        parsed = parse_act_page(page_html)

        ac_id = parsed["acId"]
        pdf_url = parsed["pdfUrl"]
        sections_meta = parsed["sections"]

        # 2. Download PDF
        if pdf_url:
            state_dir = f"state-{state}" if state != "central" else "central"
            pdf_out_dir = PDF_DIR / state_dir
            pdf_out_dir.mkdir(parents=True, exist_ok=True)

            # Generate filename from title
            slug = re.sub(r"[^a-z0-9\s]", "", title.lower())
            slug = re.sub(r"\s+", "-", slug).strip("-")[:80]
            year = entry.get("year", "")
            pdf_filename = f"{slug}_{year}.pdf" if year else f"{slug}.pdf"
            pdf_path = str(pdf_out_dir / pdf_filename)

            if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) < 500:
                ok = http_download(pdf_url, pdf_path)
                result["pdf_downloaded"] = ok
            else:
                result["pdf_downloaded"] = True

            if result["pdf_downloaded"]:
                result["pdf_path"] = os.path.relpath(pdf_path, str(DATA_DIR))

        # 3. Extract HTML sections (unless pdf-only mode)
        if not pdf_only and ac_id and sections_meta:
            section_contents = []
            for sec in sections_meta:
                content = fetch_section_content(ac_id, sec["sectionId"])
                section_contents.append({
                    "sectionId": sec["sectionId"],
                    "sectionNo": sec["sectionNo"],
                    "label": sec["label"],
                    "type": "section",
                    "content": content.get("content", ""),
                    "footnote": content.get("footnote", ""),
                })
                time.sleep(0.05)  # polite delay between section calls

            # Save HTML JSON
            if section_contents:
                state_html_dir = HTML_DIR / state
                state_html_dir.mkdir(parents=True, exist_ok=True)
                handle_slug = handle.replace("/", "_")
                html_path = state_html_dir / f"{handle_slug}.json"

                html_data = {
                    "actId": act_id,
                    "acId": ac_id,
                    "title": title,
                    "handle": handle,
                    "extractedAt": datetime.now(timezone.utc).isoformat(),
                    "sectionCount": len(section_contents),
                    "sections": section_contents,
                    "schedules": parsed.get("schedules", []),
                }

                with open(html_path, "w") as f:
                    json.dump(html_data, f, ensure_ascii=False, indent=None)

                result["html_path"] = os.path.relpath(str(html_path), str(DATA_DIR))
                result["sections_extracted"] = len(section_contents)

    except Exception as e:
        result["error"] = str(e)
        log.error(f"Failed {act_id}: {e}")

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_missing_entries() -> list[dict]:
    """Load all state/central entries with dataSource='none' and a handle."""
    entries = []
    for idx_file in sorted(INDEX_DIR.glob("*.jsonl")):
        for line in open(idx_file):
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if (
                d.get("dataSource") == "none"
                and d.get("handle")
                and not d.get("pdfUrl")  # exclude repealed (handled by other script)
            ):
                entries.append(d)
    return entries


def load_progress() -> set:
    """Load completed act IDs from progress file."""
    if PROGRESS_FILE.exists():
        data = json.load(open(PROGRESS_FILE))
        return set(data.get("completed", []))
    return set()


def save_progress(completed: set, stats: dict):
    """Save progress checkpoint."""
    data = {
        "completed": list(completed),
        "stats": stats,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    with open(PROGRESS_FILE, "w") as f:
        json.dump(data, f, ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser(description="Re-scrape missing IndiaCode acts")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--test", action="store_true", help="Process 5 acts only")
    parser.add_argument("--state", type=str, default=None, help="Filter by state")
    parser.add_argument("--pdf-only", action="store_true", help="Skip HTML extraction")
    args = parser.parse_args()

    entries = load_missing_entries()
    log.info(f"Found {len(entries)} missing state/central acts to re-scrape")

    if args.state:
        entries = [e for e in entries if e.get("state") == args.state]
        log.info(f"Filtered to state={args.state}: {len(entries)} acts")

    if args.test:
        entries = entries[:5]
        log.info("TEST MODE: 5 acts only")

    completed = load_progress()
    entries = [e for e in entries if e["actId"] not in completed]
    log.info(f"After resume filter: {len(entries)} acts remaining")

    stats = {"pdf_ok": 0, "html_ok": 0, "failed": 0, "skipped": 0}
    lock = __import__("threading").Lock()

    def _worker(entry_item):
        idx, entry = entry_item
        result = process_act(entry, pdf_only=args.pdf_only)
        with lock:
            if result["error"]:
                stats["failed"] += 1
            else:
                if result["pdf_downloaded"]:
                    stats["pdf_ok"] += 1
                if result["sections_extracted"] > 0:
                    stats["html_ok"] += 1
            completed.add(entry["actId"])
        return idx, result

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(_worker, (i, e)): i
            for i, e in enumerate(entries, 1)
        }
        for done_count, future in enumerate(as_completed(futures), 1):
            try:
                future.result()
            except Exception as e:
                log.error(f"Worker error: {e}")

            if done_count % 50 == 0:
                save_progress(completed, stats)
                log.info(
                    f"Progress: {done_count}/{len(entries)} | "
                    f"PDF={stats['pdf_ok']} HTML={stats['html_ok']} "
                    f"fail={stats['failed']}"
                )

    save_progress(completed, stats)
    log.info(
        f"Complete: {len(entries)} acts | "
        f"PDF={stats['pdf_ok']} HTML={stats['html_ok']} "
        f"fail={stats['failed']}"
    )


if __name__ == "__main__":
    main()
