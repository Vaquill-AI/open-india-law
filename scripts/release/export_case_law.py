#!/usr/bin/env python3
"""Stage 1 (case law): R2 chunk archives -> per-court JSONL.gz.

Reads highcourt-chunks/batches/*.tar.gz directly. Those archives already carry
our parsing, chunking and enrichment - text, section segmentation, char/page
provenance and court metadata - so this never touches the vector store.

That is deliberate. The US pipeline pulls full text through a Qdrant scroll and
needed four successive memory fixes to get 10.5M points through a 44 GB limit.
This corpus is 3x that size, and streaming tar members sidesteps the problem
entirely: one archive is opened at a time, each case is written out as soon as
it is transformed, and nothing accumulates.

Usage
    python -m scripts.release.export_case_law --out /rel --dry-run
    python -m scripts.release.export_case_law --out /rel --limit-archives 2
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import sys
import tarfile
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from scripts.release.redaction import excluded, has_aggregator_furniture, redact  # noqa: E402
from scripts.release.schema import (  # noqa: E402
    BOOL_FIELDS,
    CASE_LAW_SCHEMA,
    INT_FIELDS,
    INTERNAL_FIELDS,
    LIST_FIELDS,
)

BUCKET = "backup-aws-data"
PREFIX = "highcourt-chunks/batches/"

#: Court code -> canonical court name. Madras files under two registry codes
#: (principal seat and the Madurai bench), which is why a naive prefix scan
#: appears to be missing it entirely.
COURT_CODES = {
    "BRHC": "Patna High Court", "UPHC": "Allahabad High Court",
    "HCBM": "Bombay High Court", "RJHC": "Rajasthan High Court",
    "KLHC": "Kerala High Court", "HBHC": "Telangana High Court",
    "HCMA": "Madras High Court", "HCMD": "Madras High Court",
    "PHHC": "Punjab and Haryana High Court", "KAHC": "Karnataka High Court",
    "MPHC": "Madhya Pradesh High Court", "CGHC": "Chhattisgarh High Court",
    "JHHC": "Jharkhand High Court", "GJHC": "Gujarat High Court",
    "WBCH": "Calcutta High Court", "DLHC": "Delhi High Court",
    "GAHC": "Gauhati High Court", "APHC": "Andhra Pradesh High Court",
    "HPHC": "Himachal Pradesh High Court", "UKHC": "Uttarakhand High Court",
    "JKHC": "Jammu and Kashmir High Court", "TRHC": "Tripura High Court",
    "MNHC": "Manipur High Court", "MLHC": "Meghalaya High Court",
    "SKHC": "Sikkim High Court", "ODHC": "Orissa High Court",
}
SLUG = {v: v.lower().replace(" high court", "").replace(" ", "-") for v in COURT_CODES.values()}


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
        config=Config(retries={"max_attempts": 8, "mode": "standard"}),
    )


def coerce(row: dict) -> dict:
    """Project a raw chunk onto the frozen schema."""
    out: dict[str, object] = {}
    for field in CASE_LAW_SCHEMA:
        value = row.get(field)
        if field in INT_FIELDS:
            try:
                out[field] = int(value) if value is not None and value != "" else None
            except (TypeError, ValueError):
                out[field] = None
        elif field in BOOL_FIELDS:
            out[field] = bool(value) if value is not None else None
        elif field in LIST_FIELDS:
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except json.JSONDecodeError:
                    value = [value] if value else []
            out[field] = value if isinstance(value, list) else ([] if value is None else [value])
        else:
            out[field] = None if value is None else str(value)
    return out


#: case_ids whose text carries a third-party site's page furniture, meaning the
#: document was sourced from that site rather than from the court. Written out
#: so they can be purged from the corpus, not merely filtered from the release.
PURGE: list[str] = []


def transform(chunks: list[dict], stats: Counter) -> list[dict]:
    """Redact, drop non-publishable documents, project onto the schema.

    A direction against publication applies to the WHOLE document, so the test
    runs over every chunk before any is emitted. Redacting chunk-by-chunk would
    let a judgment whose direction sits in chunk 7 ship chunks 1-6.
    """
    blob = "\n".join((c.get("text_original") or c.get("text") or "") for c in chunks)

    if has_aggregator_furniture(blob):
        # Not sourced from the court. Record it for purging from the corpus.
        PURGE.append(chunks[0].get("case_id", ""))
        stats["documents_purged_third_party_source"] += 1
        return []

    if excluded(blob):
        stats["documents_excluded_non_publication"] += 1
        return []

    out = []
    for chunk in chunks:
        for field in ("text", "text_original"):
            if chunk.get(field):
                chunk[field], hits = redact(chunk[field])
                for rule, n in hits.items():
                    stats[f"redacted_{rule}"] += n
        # source_url replaces the internal pdf_url, which points at a bucket
        # whose public access was disabled and would ship as a dead link.
        chunk["source_url"] = ""
        chunk.setdefault("language_code", "en")
        chunk.setdefault("case_number", "")
        chunk.setdefault("citation", "")
        out.append(coerce(chunk))
    stats["documents_kept"] += 1
    stats["chunks_kept"] += len(out)
    return out


def process_archive(job: tuple[int, str, str]) -> tuple[int, dict, dict, list[str]]:
    """Handle one archive in its own process.

    Each worker writes its OWN shard per court rather than sharing a handle,
    so there is no cross-process contention and no lock. build_release globs
    the shards back together.
    """
    index, key, out_dir = job
    out = Path(out_dir)
    s3 = _client()
    body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()

    handles: dict[str, gzip.GzipFile] = {}
    rows: dict[str, int] = defaultdict(int)
    stats: Counter = Counter()
    purge: list[str] = []

    with tarfile.open(fileobj=io.BytesIO(body)) as tar:
        for member in tar:
            if not member.isfile():
                continue
            raw = tar.extractfile(member)
            if raw is None:
                continue
            chunks = [json.loads(ln) for ln in raw.read().decode("utf-8").splitlines() if ln.strip()]
            if not chunks:
                continue
            court = COURT_CODES.get(chunks[0].get("case_id", "")[:4])
            if not court:
                stats["unknown_court_code"] += 1
                continue
            before = len(PURGE)
            emitted = transform(chunks, stats)
            purge += PURGE[before:]
            for row in emitted:
                rows[court] += 1
                if court not in handles:
                    shard = out / f"in_{SLUG.get(court, 'unknown')}_judgments.part{index:05d}.jsonl.gz"
                    handles[court] = gzip.open(shard, "wt", encoding="utf-8")
                handles[court].write(json.dumps(row, ensure_ascii=False) + "\n")
    for fh in handles.values():
        fh.close()
    del body
    return index, dict(rows), dict(stats), purge


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--limit-archives", type=int, default=0, help="0 = all")
    ap.add_argument("--start-archive", type=int, default=0,
                    help="resume from this index; output is appended, not truncated")
    ap.add_argument("--dry-run", action="store_true", help="gate only, write nothing")
    ap.add_argument("--workers", type=int, default=max(2, (os.cpu_count() or 4) * 2),
                    help="parallel PROCESSES. The work is CPU-bound (10k JSON parses "
                         "plus regex redaction per archive), so threads do not help "
                         "past the GIL and going far beyond ~2x cores only thrashes.")
    args = ap.parse_args()

    s3 = _client()
    archives: list[str] = []
    token = None
    while True:
        kw = {"Bucket": BUCKET, "Prefix": PREFIX, "MaxKeys": 1000}
        if token:
            kw["ContinuationToken"] = token
        page = s3.list_objects_v2(**kw)
        archives += [o["Key"] for o in page.get("Contents", []) if o["Key"].endswith(".tar.gz")]
        if not page.get("IsTruncated"):
            break
        token = page["NextContinuationToken"]
    archives.sort()
    total_archives = len(archives)
    if args.start_archive:
        archives = archives[args.start_archive :]
    if args.limit_archives:
        archives = archives[: args.limit_archives]
    print(f"{len(archives)} chunk archives", flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    handles: dict[str, gzip.GzipFile] = {}
    rows_by_court: dict[str, int] = defaultdict(int)
    stats: Counter = Counter()

    def handle(court: str):
        if court not in handles and not args.dry_run:
            path = args.out / f"in_{SLUG.get(court, 'unknown')}_judgments.jsonl.gz"
            # append when resuming so a restart does not truncate a part-built file
            mode = "at" if args.start_archive else "wt"
            handles[court] = gzip.open(path, mode, encoding="utf-8")
        return handles.get(court)

    jobs = [(args.start_archive + i, k, str(args.out)) for i, k in enumerate(archives)]
    done = 0
    started = time.time()
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        for fut in as_completed(pool.submit(process_archive, j) for j in jobs):
            try:
                _, rows, st, purge = fut.result()
            except Exception as exc:  # noqa: BLE001
                print(f"  ARCHIVE FAILED: {type(exc).__name__}: {exc}", flush=True)
                stats["archives_failed"] += 1
                continue
            for c, n in rows.items():
                rows_by_court[c] += n
            for k, v in st.items():
                stats[k] += v
            PURGE.extend(purge)
            done += 1
            if done % 25 == 0 or done == len(jobs):
                rate = done / max(time.time() - started, 1)
                eta = (len(jobs) - done) / max(rate, 1e-9) / 60
                print(f"  [{done}/{len(jobs)}] {rate:.2f} archives/s  "
                      f"docs={stats['documents_kept']:,} chunks={stats['chunks_kept']:,}  "
                      f"eta {eta:.0f} min", flush=True)

    manifest = [
        {"file": f"in_{SLUG.get(c, 'unknown')}_judgments.parquet", "court": c, "rows": n}
        for c, n in sorted(rows_by_court.items(), key=lambda kv: -kv[1])
    ]
    if not args.dry_run:
        (args.out / "manifest_case_law.json").write_text(json.dumps(manifest, indent=2))
        # The purge list is written even on a dry run in spirit: it is the input
        # to removing this material from the corpus, and it must not be lost.
        (args.out / "purge_third_party_sourced.txt").write_text("\n".join(PURGE) + "\n")
    print(f"\n  purge list: {len(PURGE):,} case_ids -> purge_third_party_sourced.txt")

    print("\n=== summary ===")
    for k, v in sorted(stats.items()):
        print(f"  {k:<40} {v:>12,}")
    print(f"  {'courts':<40} {len(rows_by_court):>12,}")
    if INTERNAL_FIELDS & set(CASE_LAW_SCHEMA):
        print("REFUSING: an internal field is in the published schema")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
