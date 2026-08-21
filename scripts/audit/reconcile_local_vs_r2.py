#!/usr/bin/env python3
"""Is the local India scrape safe to delete, or does it hold what R2 does not?

A filename comparison CANNOT answer this. Local files are named by slug
(`the-tamil-nadu-revenue-recovery-act-1864_1864.pdf`) while R2 is keyed by act
id (`IND_state_20519/act.pdf`). Comparing names returns zero matches for data
that is in fact fully mirrored, which reads exactly like "nothing is backed up"
and would justify a deletion that loses everything.

The join is `pdfPath` in `data/indiacode/index-linked/*.jsonl`, which records
the local path alongside the actId for the same document.

Read-only. Answers one question per local file: is this document in R2?

    python scripts/audit/reconcile_local_vs_r2.py --news-root ../news
    python scripts/audit/reconcile_local_vs_r2.py --news-root ../news --write-deletable
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


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
        config=Config(retries={"max_attempts": 5, "mode": "standard"},
                      max_pool_connections=64),
    )


def load_index(news_root: Path) -> dict[str, str]:
    """local pdfPath -> actId, from every index-linked shard."""
    mapping: dict[str, str] = {}
    idx = news_root / "data" / "indiacode" / "index-linked"
    for shard in sorted(idx.glob("*.jsonl")):
        for line in shard.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            act_id, pdf_path = rec.get("actId"), rec.get("pdfPath")
            if act_id and pdf_path:
                # the index writes pdfs/tamil-nadu/... while the tree is
                # pdfs/state-tamil-nadu/..., so key on the basename
                mapping[Path(pdf_path).name] = act_id
    return mapping


def r2_act_ids(s3, bucket: str = "acts-india") -> set[str]:
    """Every act id present in R2, from the top-level key prefix."""
    ids: set[str] = set()
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            ids.add(cp["Prefix"].rstrip("/"))
    return ids


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--news-root", required=True, type=Path)
    ap.add_argument("--write-deletable", action="store_true",
                    help="write the verified-mirrored file list for review")
    args = ap.parse_args()

    print("loading the slug -> actId index ...", flush=True)
    by_name = load_index(args.news_root)
    print(f"  {len(by_name):,} documents in the index")

    s3 = client()
    print("listing act ids in R2 ...", flush=True)
    ids = r2_act_ids(s3)
    print(f"  {len(ids):,} act ids in acts-india")

    pdfs = args.news_root / "data" / "indiacode" / "pdfs"
    local = [p for p in pdfs.rglob("*.pdf")]
    print(f"  {len(local):,} local PDFs under {pdfs}")

    stats: Counter = Counter()
    mirrored: list[Path] = []
    unmapped: list[Path] = []
    missing: list[tuple[Path, str]] = []

    for p in local:
        act_id = by_name.get(p.name)
        if not act_id:
            stats["no_index_entry"] += 1
            unmapped.append(p)
            continue
        if act_id in ids:
            stats["mirrored"] += 1
            mirrored.append(p)
        else:
            stats["NOT_in_r2"] += 1
            missing.append((p, act_id))

    # confirm a sample of the "mirrored" verdict at object level, because a
    # prefix existing is not proof the pdf inside it does
    sample = mirrored[:: max(1, len(mirrored) // 40)][:40]

    def has_pdf(p: Path) -> bool:
        try:
            s3.head_object(Bucket="acts-india", Key=f"{by_name[p.name]}/act.pdf")
            return True
        except Exception:  # noqa: BLE001
            return False

    with ThreadPoolExecutor(max_workers=16) as pool:
        confirmed = sum(pool.map(has_pdf, sample))

    print("\n=== verdict ===")
    for k, v in stats.most_common():
        print(f"  {k:<18} {v:>8,}")
    if sample:
        print(f"  object-level spot check: {confirmed}/{len(sample)} of the 'mirrored' set "
              f"really have act.pdf in R2")
    if missing:
        print(f"\n  {len(missing):,} local PDFs map to an actId that is NOT in R2. Examples:")
        for p, a in missing[:6]:
            print(f"    {a:<22} {p.relative_to(args.news_root)}")
    if unmapped:
        print(f"\n  {len(unmapped):,} local PDFs have no index entry, so their status is UNKNOWN.")
        for p in unmapped[:6]:
            print(f"    {p.relative_to(args.news_root)}")

    safe = confirmed == len(sample) and not missing and not unmapped
    print(f"\n  DELETING data/indiacode/pdfs IS {'SAFE' if safe else 'NOT SAFE'}")
    if not safe:
        print("  Upload what is missing before deleting anything.")

    if args.write_deletable and safe:
        out = Path("verified_mirrored.txt")
        out.write_text("\n".join(str(p) for p in mirrored))
        print(f"  wrote {out} ({len(mirrored):,} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
