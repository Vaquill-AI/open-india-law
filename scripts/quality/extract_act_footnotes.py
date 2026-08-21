#!/usr/bin/env python3
"""
Extract inline amendment footnotes from act text files in R2 and insert
structured rows into the Supabase legislation_footnotes table.

Acts live in R2 bucket `acts-india` at `{act_id}/act.txt`.

Usage:
    python scripts/extract_act_footnotes.py --dry-run
    python scripts/extract_act_footnotes.py --act-id hindu-marriage-act-1955
    python scripts/extract_act_footnotes.py --force

Environment (loaded from .env):
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import logging
import os
import re
import sys
import time

import boto3
import requests
from botocore.config import Config
from botocore.exceptions import ClientError
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

load_dotenv()

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_ACTS_BUCKET = "acts-india"

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
INSERT_BATCH_SIZE = 100

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s | %(levelname)-8s | %(message)s", datefmt="%H:%M:%S"
)
log = logging.getLogger("extract_act_footnotes")

# ---------------------------------------------------------------------------
# R2 helpers
# ---------------------------------------------------------------------------


def get_r2_client():
    if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY]):
        log.error("Missing R2 credentials. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.")
        sys.exit(1)
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(retries={"max_attempts": 3, "mode": "adaptive"}),
    )


def fetch_act_text(s3, act_id: str) -> str | None:
    """Download {act_id}/act.txt from R2. Returns decoded text or None on failure."""
    key = f"{act_id}/act.txt"
    try:
        resp = s3.get_object(Bucket=R2_ACTS_BUCKET, Key=key)
        return resp["Body"].read().decode("utf-8", errors="replace")
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        if code in ("NoSuchKey", "404"):
            log.warning("act.txt not found: act_id=%s", act_id)
        else:
            log.error("R2 fetch error: act_id=%s error=%s", act_id, exc)
        return None
    except Exception as exc:
        log.error("Unexpected R2 error: act_id=%s error=%s", act_id, exc)
        return None


# ---------------------------------------------------------------------------
# Supabase REST helpers
# ---------------------------------------------------------------------------


def _headers() -> dict[str, str]:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


def fetch_central_acts(act_id_filter: str | None = None) -> list[dict]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.")
        sys.exit(1)
    params: dict = {"select": "id,act_id,title", "category": "eq.central", "is_active": "eq.true"}
    if act_id_filter:
        params["act_id"] = f"eq.{act_id_filter}"
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/legislation", headers=_headers(), params=params, timeout=30)
    if resp.status_code != 200:
        log.error("Failed to fetch legislation: %s %s", resp.status_code, resp.text[:200])
        sys.exit(1)
    acts = resp.json()
    log.info("Fetched %d acts from Supabase", len(acts))
    return acts


def act_has_footnotes(act_id: str) -> bool:
    url = f"{SUPABASE_URL}/rest/v1/legislation_footnotes"
    resp = requests.get(url, headers=_headers(), params={"act_id": f"eq.{act_id}", "select": "id", "limit": "1"}, timeout=15)
    return resp.status_code == 200 and len(resp.json()) > 0


def delete_footnotes_for_act(act_id: str) -> None:
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/legislation_footnotes",
        headers=_headers(),
        params={"act_id": f"eq.{act_id}"},
        timeout=30,
    )
    if resp.status_code not in (200, 204):
        log.warning("Delete returned %s for act_id=%s", resp.status_code, act_id)


def batch_insert(rows: list[dict], dry_run: bool) -> int:
    """Insert rows in chunks of INSERT_BATCH_SIZE. Returns inserted count."""
    if dry_run:
        log.info("  [DRY RUN] Would insert %d footnote rows", len(rows))
        return 0
    inserted = 0
    url = f"{SUPABASE_URL}/rest/v1/legislation_footnotes"
    for i in range(0, len(rows), INSERT_BATCH_SIZE):
        chunk = rows[i : i + INSERT_BATCH_SIZE]
        resp = requests.post(url, headers=_headers(), json=chunk, timeout=30)
        if resp.status_code in (200, 201):
            inserted += len(chunk)
        else:
            log.error("Insert failed (chunk %d): %s %s", i // INSERT_BATCH_SIZE, resp.status_code, resp.text[:200])
    return inserted


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

# Section header: **5. Title.** or **Section 302.**
_SEC_RE = re.compile(
    r"^\*{1,2}(?:Section\s+)?(\d+[A-Z]?(?:\.\d+)?)\.\s*([^*\n]{0,120})",
    re.MULTILINE,
)

# Amendment line: matches the full line then subfields are extracted separately.
# Using [^\n]{0,300} avoids catastrophic backtracking with nested parens.
_AMEND_RE = re.compile(
    r"""
    (?P<prefix>Subs\.|Omitted|Ins\.|Rep\.|Added|Re-?numbered(?:\s+as\s[^,\n]+)?)
    \s+by\s+
    (?P<by_act>Act\s+\d+\s+of\s+\d{4})
    [^\n]{0,300}
    """,
    re.VERBOSE | re.IGNORECASE,
)

# Subfield extractors applied on the full matched line.
_FOR_RE = re.compile(r',\s*for\s+"([^"]+)"', re.IGNORECASE)
_WEFF_RE = re.compile(r"w\.e\.f\.\s*([\d]+-[\d]+-\d{4})", re.IGNORECASE)
# Gazette/vide notification note.
_GAZETTE_RE = re.compile(r"(?:vide|Vide)\s+notification\s+No\.\s*[\w\s./]+", re.IGNORECASE)
# Numbered footnote lines at bottom of act (1 Subs... or 1. Subs...).
_NUM_FN_RE = re.compile(r"^(?P<n>\d+)[\.\s]\s*(?P<body>.+)", re.MULTILINE)
# Inline footnote marker (1[, 2[).
_MARKER_RE = re.compile(r"(\d+)\[")


def _classify(prefix: str) -> str:
    p = prefix.lower()
    if p.startswith("subs"):
        return "substitution"
    if p.startswith("omit"):
        return "omission"
    if p.startswith("ins"):
        return "insertion"
    if p.startswith("rep"):
        return "repeal"
    if p.startswith("add"):
        return "addition"
    if "number" in p:
        return "renumbering"
    return "note"


def _section_at(pos: int, headers: list[tuple[int, str, str]]) -> tuple[str | None, str | None]:
    """Return (section_number, section_title) for the header immediately before pos."""
    result: tuple[str | None, str | None] = (None, None)
    for hpos, hnum, htitle in headers:
        if hpos <= pos:
            result = (hnum, htitle)
        else:
            break
    return result


def _row_from_match(act_id: str, m: re.Match, sec_num: str | None, sec_title: str | None, fn_id: int | None) -> dict:
    line = m.group(0)
    orig_m = _FOR_RE.search(line)
    weff_m = _WEFF_RE.search(line)
    return {
        "act_id": act_id,
        "section_number": sec_num,
        "section_title": sec_title,
        "footnote_id": fn_id,
        "footnote_text": line.strip()[:2000],
        "footnote_type": _classify(m.group("prefix")),
        "by_act": m.group("by_act"),
        "original_text": orig_m.group(1) if orig_m else None,
        "effective_date": weff_m.group(1) if weff_m else None,
    }


def parse_footnotes(act_id: str, text: str) -> list[dict]:
    """Parse all footnotes from act text. Returns deduplicated list of row dicts."""
    rows: list[dict] = []

    headers: list[tuple[int, str, str]] = [
        (m.start(), m.group(1), m.group(2).strip(" .-")) for m in _SEC_RE.finditer(text)
    ]

    # Pass 1: collect numbered footnotes by id.
    numbered: dict[int, str] = {
        int(m.group("n")): m.group("body").strip()
        for m in _NUM_FN_RE.finditer(text)
        if len(m.group("body").strip()) > 10
    }

    # Attach numbered footnotes to their inline markers for section context.
    for m in _MARKER_RE.finditer(text):
        fn_num = int(m.group(1))
        body = numbered.get(fn_num)
        if not body:
            continue
        sec_num, sec_title = _section_at(m.start(), headers)
        am = _AMEND_RE.search(body)
        if am:
            row = _row_from_match(act_id, am, sec_num, sec_title, fn_num)
            rows.append(row)
        elif _GAZETTE_RE.search(body):
            rows.append({
                "act_id": act_id, "section_number": sec_num, "section_title": sec_title,
                "footnote_id": fn_num, "footnote_text": body[:2000],
                "footnote_type": "note", "by_act": None, "original_text": None, "effective_date": None,
            })

    # Pass 2: inline amendment sentences in body text.
    for m in _AMEND_RE.finditer(text):
        sec_num, sec_title = _section_at(m.start(), headers)
        rows.append(_row_from_match(act_id, m, sec_num, sec_title, None))

    # Pass 3: gazette notes not yet captured.
    for m in _GAZETTE_RE.finditer(text):
        sec_num, sec_title = _section_at(m.start(), headers)
        rows.append({
            "act_id": act_id, "section_number": sec_num, "section_title": sec_title,
            "footnote_id": None, "footnote_text": m.group(0).strip()[:2000],
            "footnote_type": "note", "by_act": None, "original_text": None, "effective_date": None,
        })

    # Deduplicate by (footnote_text, section_number).
    seen: set[tuple] = set()
    unique: list[dict] = []
    for row in rows:
        key = (row["footnote_text"], row["section_number"])
        if key not in seen:
            seen.add(key)
            unique.append(row)
    return unique


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def process_act(s3, act: dict, force: bool, dry_run: bool) -> dict:
    act_id: str = act["act_id"]
    stats: dict = {"act_id": act_id, "footnotes": 0, "inserted": 0, "skipped": False, "error": None}

    if not force and not dry_run and act_has_footnotes(act_id):
        log.info("  Skipping %s (already processed, use --force to overwrite)", act_id)
        stats["skipped"] = True
        return stats

    text = fetch_act_text(s3, act_id)
    if text is None:
        stats["error"] = "R2 fetch failed"
        return stats
    if len(text.strip()) < 100:
        log.warning("  act.txt too short for %s (%d chars), skipping", act_id, len(text))
        stats["error"] = "text too short"
        return stats

    rows = parse_footnotes(act_id, text)
    stats["footnotes"] = len(rows)
    log.info("  Found %d footnotes in %s", len(rows), act_id)

    if rows:
        if force and not dry_run:
            delete_footnotes_for_act(act_id)
        stats["inserted"] = batch_insert(rows, dry_run)

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract act footnotes from R2 into Supabase.")
    parser.add_argument("--act-id", default=None, help="Process only this act_id.")
    parser.add_argument("--dry-run", action="store_true", help="Parse without writing to Supabase.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing footnotes.")
    args = parser.parse_args()

    log.info("extract_act_footnotes | act_id=%s dry_run=%s force=%s", args.act_id or "ALL", args.dry_run, args.force)

    acts = fetch_central_acts(args.act_id)
    if not acts:
        log.warning("No acts found. Exiting.")
        return

    s3 = get_r2_client()
    t0 = time.time()
    total_fn = skipped = errors = total_ins = 0

    for i, act in enumerate(acts, start=1):
        log.info("[%d/%d] %s", i, len(acts), act.get("act_id"))
        st = process_act(s3, act, force=args.force, dry_run=args.dry_run)
        if st["skipped"]:
            skipped += 1
        elif st["error"]:
            errors += 1
        else:
            total_fn += st["footnotes"]
            total_ins += st["inserted"]

    prefix = "[DRY RUN] " if args.dry_run else ""
    log.info(
        "%sDone in %.1fs | acts=%d skipped=%d errors=%d footnotes=%d inserted=%d",
        prefix, time.time() - t0, len(acts), skipped, errors, total_fn, total_ins,
    )


if __name__ == "__main__":
    main()
