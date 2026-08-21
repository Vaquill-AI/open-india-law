#!/usr/bin/env python3
"""Consolidate the India source artifacts into the public mirror bucket.

The data currently lives across six buckets that grew organically. The public
mirror needs one coherent layout, so this COPIES each source prefix into
`open-india-law` under a stable path.

COPY, never move. Live services read from the source buckets - tribunals.vaquill.ai
among them - so nothing is deleted from a source. The mirror is additive.

Uses server-side CopyObject, so bytes never transit this machine. It is still
one API call per object and there are ~34M of them, so this is a long job: run
it with concurrency, and it is resumable because an object already present at
the destination with a matching size is skipped.

    python -m scripts.release.consolidate_mirror --plan
    python -m scripts.release.consolidate_mirror --group legislation --workers 32
    python -m scripts.release.consolidate_mirror --group all --workers 64
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

MIRROR = "open-india-law"

#: (group, source bucket, source prefix, destination prefix, approx objects, approx GB)
#:
#: backup-aws-data is a MIXED bucket holding general backups alongside the
#: India corpus, so only the corpus prefixes are listed. Never copy it whole.
PLAN: tuple[tuple[str, str, str, str, int, float], ...] = (
    ("legislation", "acts-india", "", "legislation/", 90_052, 38.4),
    ("parliament", "parliament-debates", "", "parliament/", 12_317, 6.4),
    ("tribunals", "tribunal-judgments", "pdfs/", "tribunals/decisions/", 2_112_201, 524.0),
    ("regulators", "tribunal-judgments", "regulatory/", "regulators/", 19_352, 17.6),
    ("tribunals-index", "tribunal-judgments", "metadata/", "tribunals/index/", 16, 4.8),
    ("derived-text", "backup-aws-data", "corpus-text/", "judgments/text/", 14_775_029, 97.1),
    ("derived-chunks", "backup-aws-data", "highcourt-chunks/", "judgments/chunks/", 1_578, 29.5),
    ("derived-parsed", "backup-aws-data", "highcourt-parsed/", "judgments/parsed/", 1_609, 63.5),
    ("derived-sc", "backup-aws-data", "supreme-court-parsed-and-chunks/", "judgments/sc-parsed/", 6, 8.2),
    ("source-hc", "aws-high-court-judgments", "data/pdf/", "judgments/source-pdf/hc/", 16_703_478, 1355.6),
    ("source-sc", "aws-supreme-court-judgments", "", "judgments/source-pdf/sc/", 989, 115.8),
)

_lock = threading.Lock()
_done = {"copied": 0, "skipped": 0, "failed": 0}


def _client():
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
        config=Config(retries={"max_attempts": 8, "mode": "standard"},
                      max_pool_connections=128),
    )


def copy_one(s3, src_bucket: str, key: str, dst_key: str, size: int) -> str:
    """Server-side copy, skipping anything already there at the same size."""
    try:
        head = s3.head_object(Bucket=MIRROR, Key=dst_key)
        if head["ContentLength"] == size:
            return "skipped"
    except Exception:  # noqa: BLE001 - a miss is the normal path
        pass
    try:
        s3.copy_object(
            Bucket=MIRROR, Key=dst_key,
            CopySource={"Bucket": src_bucket, "Key": key},
        )
        return "copied"
    except Exception as exc:  # noqa: BLE001
        print(f"    FAILED {src_bucket}/{key}: {type(exc).__name__}", file=sys.stderr)
        return "failed"


def run_group(s3, group: str, src_bucket: str, src_prefix: str, dst_prefix: str,
              workers: int, limit: int) -> None:
    print(f"\n=== {group}: {src_bucket}/{src_prefix or '(root)'} -> {MIRROR}/{dst_prefix}")
    token, n = None, 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = set()
        while True:
            kw = {"Bucket": src_bucket, "MaxKeys": 1000}
            if src_prefix:
                kw["Prefix"] = src_prefix
            if token:
                kw["ContinuationToken"] = token
            page = s3.list_objects_v2(**kw)
            for obj in page.get("Contents", []):
                rel = obj["Key"][len(src_prefix):] if src_prefix else obj["Key"]
                futures.add(pool.submit(copy_one, s3, src_bucket, obj["Key"],
                                        dst_prefix + rel, obj["Size"]))
                n += 1
                if len(futures) >= workers * 8:
                    for f in as_completed(list(futures)):
                        with _lock:
                            _done[f.result()] += 1
                        futures.discard(f)
                        break
                if limit and n >= limit:
                    break
            if limit and n >= limit:
                break
            if not page.get("IsTruncated"):
                break
            token = page["NextContinuationToken"]
            if n % 50_000 < 1000:
                print(f"    queued {n:,}  copied={_done['copied']:,} "
                      f"skipped={_done['skipped']:,} failed={_done['failed']:,}", flush=True)
        for f in as_completed(futures):
            with _lock:
                _done[f.result()] += 1
    print(f"    {group}: queued {n:,}  copied={_done['copied']:,} "
          f"skipped={_done['skipped']:,} failed={_done['failed']:,}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--group", default="plan",
                    help="a group name, 'lean' (the recommended set), or 'all'")
    ap.add_argument("--plan", action="store_true", help="print the plan and exit")
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--limit", type=int, default=0, help="stop after N objects (smoke test)")
    args = ap.parse_args()

    if args.plan or args.group == "plan":
        print(f"{'group':<18}{'source':<30}{'destination':<30}{'objects':>12}{'GB':>9}")
        print("-" * 99)
        to, tg = 0, 0.0
        for g, sb, sp, dp, o, gb in PLAN:
            print(f"{g:<18}{sb + '/' + sp:<30}{MIRROR + '/' + dp:<30}{o:>12,}{gb:>9.1f}")
            to, tg = to + o, tg + gb
        print("-" * 99)
        print(f"{'TOTAL':<78}{to:>12,}{tg:>9.1f}")
        print(f"\nAt 200 objects/sec that is roughly {to / 200 / 3600:.0f} hours of API calls.")
        print("Server-side copy: bytes do not transit this machine.")
        print("COPY only. Nothing is deleted from any source bucket.")
        return 0

    s3 = _client()
    # 'lean' drops the AWS Open Data mirror (already public under CC BY 4.0)
    # and the 14.8M loose text files (that text is in the Parquet). Together
    # they are 31.5M of 33.7M objects for no added content.
    REDUNDANT = {"source-hc", "derived-text"}
    if args.group == "lean":
        groups = [p for p in PLAN if p[0] not in REDUNDANT]
    else:
        groups = [p for p in PLAN if args.group in ("all", p[0])]
    if not groups:
        print(f"unknown group {args.group!r}")
        return 1
    for g, sb, sp, dp, _, _ in groups:
        run_group(s3, g, sb, sp, dp, args.workers, args.limit)
    print(f"\ntotal copied={_done['copied']:,} skipped={_done['skipped']:,} failed={_done['failed']:,}")
    return 1 if _done["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
