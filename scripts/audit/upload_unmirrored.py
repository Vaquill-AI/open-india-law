#!/usr/bin/env python3
"""Upload local India scrape files that are NOT already in R2.

Written because the reconciliation found 13,163 of 22,626 local India Code PDFs
either mapping to an act id absent from R2 or carrying no index entry at all,
which makes deleting the local tree unsafe. This closes that gap so the local
copy becomes genuinely redundant.

Files land under a prefix that PRESERVES the local relative path, rather than
being re-keyed by act id. That is deliberate: the whole reason the gap existed
is that 13,078 of them have no act id to key on, and inventing one would lose
the only identifier they have.

Skips anything already present at the same size, so it is resumable and safe to
re-run. Never deletes anything.

    python scripts/audit/upload_unmirrored.py --src ../news/data/indiacode/pdfs \
        --prefix legislation-source/indiacode/pdfs --dry-run
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BUCKET = "open-india-law"
_lock = threading.Lock()
_n = {"uploaded": 0, "skipped": 0, "failed": 0, "bytes": 0}


def client():
    import boto3
    from botocore.config import Config
    from dotenv import load_dotenv

    load_dotenv()
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(
            retries={"max_attempts": 10, "mode": "adaptive"},
            max_pool_connections=64,
            # a laptop changing network mid-transfer shows up as a read timeout
            # or an SSL error, not a clean disconnect, so these need to be
            # generous rather than fast-failing
            connect_timeout=30,
            read_timeout=120,
        ),
    )


def existing(s3, prefix: str) -> dict[str, int]:
    """key -> size for everything already under the prefix.

    One LIST per 1000 keys instead of one HEAD per file. On 22,633 files that
    is ~25 calls rather than 22,633, which is the difference between minutes
    and seconds before any byte is uploaded.
    """
    out: dict[str, int] = {}
    for page in s3.get_paginator("list_objects_v2").paginate(
            Bucket=BUCKET, Prefix=prefix.rstrip("/") + "/"):
        for o in page.get("Contents", []):
            out[o["Key"]] = o["Size"]
    return out


def one(s3, path: Path, key: str, size: int, dry: bool) -> str:
    """Upload with explicit retry.

    boto3's own retry does not cover a connection that dies mid-body, which is
    what a network change looks like, so each file gets its own attempts with
    backoff. A file that still fails is left for the next resume pass rather
    than being lost.
    """
    if dry:
        return "uploaded"
    delay = 2.0
    for attempt in range(5):
        try:
            s3.upload_file(str(path), BUCKET, key)
            return "uploaded"
        except Exception as exc:  # noqa: BLE001
            if attempt == 4:
                print(f"    FAILED {path.name}: {type(exc).__name__}", file=sys.stderr)
                return "failed"
            time.sleep(delay)
            delay *= 2
    return "failed"



def do_pass(args, s3) -> tuple[int, int]:
    """One list-diff-upload pass. Returns (uploaded, failed)."""
    _n.update(uploaded=0, skipped=0, failed=0, bytes=0)
    root = args.src.resolve()

    if args.from_list:
        rels = [l.strip() for l in args.from_list.read_text().splitlines() if l.strip()]
        files = [args.src / r for r in rels]
    else:
        files = list(args.src.rglob("*"))
    files = [p for p in files if p.is_file() and not p.name.startswith(".")]

    have = existing(s3, args.prefix)
    todo = []
    for f in files:
        key = f"{args.prefix.rstrip('/')}/{f.resolve().relative_to(root)}"
        if have.get(key) == f.stat().st_size:
            _n["skipped"] += 1
        else:
            todo.append((f, key))

    print(f"  {len(have):,} in destination | {_n['skipped']:,} already ok | "
          f"{len(todo):,} to upload ({sum(f.stat().st_size for f, _ in todo)/1e9:.2f} GB)",
          flush=True)
    if not todo:
        return 0, 0

    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(one, s3, f, k, f.stat().st_size, args.dry_run): f
                for f, k in todo}
        for fut in as_completed(futs):
            r = fut.result()
            with _lock:
                _n[r] += 1
                if r == "uploaded":
                    _n["bytes"] += futs[fut].stat().st_size
            done += 1
            if done % 250 == 0:
                print(f"    {done:,}/{len(todo):,}  up={_n['uploaded']:,} "
                      f"fail={_n['failed']:,}  {_n['bytes']/1e9:.2f} GB", flush=True)
    return _n["uploaded"], _n["failed"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", required=True, type=Path)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--from-list", type=Path,
                    help="upload only these paths, relative to --src")
    ap.add_argument("--max-passes", type=int, default=8,
                    help="re-list and retry until nothing is left. A pass that "
                         "uploads nothing new twice in a row stops the loop.")
    args = ap.parse_args()

    s3 = client()
    stale = 0
    for attempt in range(1, args.max_passes + 1):
        print(f"\n=== pass {attempt}/{args.max_passes} ===", flush=True)
        try:
            uploaded, failed = do_pass(args, s3)
        except Exception as exc:  # noqa: BLE001 - a dead network must not end the run
            print(f"  pass aborted: {type(exc).__name__}: {exc}", flush=True)
            time.sleep(30)
            s3 = client()
            continue
        print(f"  pass {attempt}: uploaded {uploaded:,}, failed {failed:,}", flush=True)
        if failed == 0 and uploaded == 0:
            print("\n  nothing left to upload - everything is mirrored")
            return 0
        if uploaded == 0:
            stale += 1
            if stale >= 2:
                print(f"\n  two passes with no progress and {failed:,} still failing")
                return 1
        else:
            stale = 0
        time.sleep(5)
    print("\n  max passes reached")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
