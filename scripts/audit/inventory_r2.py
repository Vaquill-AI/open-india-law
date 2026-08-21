"""Exhaustive object inventory of the India-related R2 buckets.

Answers, per corpus, what formats we actually hold: PDF, extracted text, HTML,
JSON metadata, and how much of each.

Every object is enumerated through paginated list calls. Nothing is sampled, so
counts and byte totals are exact as at the time of the run.

Run:
    uv run --with boto3 python scripts/india_corpus/inventory_r2.py
"""

from __future__ import annotations

import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import boto3

REPO = Path(__file__).resolve().parents[2]
RAW = Path(__file__).parent / "raw"
RAW.mkdir(exist_ok=True)

# Buckets holding Indian legal content. Others in the account are US corpora,
# translations, build assets and backups, and are listed but not walked.
TARGETS = [
    "tribunal-judgments",
    "acts-india",
    "parliament-debates",
]

EXT = re.compile(r"\.([A-Za-z0-9]{1,6})$")


def log(m: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


def client():
    env = {}
    for line in (REPO / ".env").read_text().splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def group_of(key: str) -> str:
    """Collapse a key to the folder that identifies its corpus slice.

    pdfs/aptel/X.pdf            -> pdfs/aptel
    IND_REP_1000_1873/act.pdf   -> (acts, one folder per act, so use the top level)
    judgments/allahabad/2022/X  -> judgments/allahabad
    """
    parts = key.split("/")
    if len(parts) <= 1:
        return "(root)"
    if parts[0].startswith("IND_"):
        return "(per-act folders)"
    return "/".join(parts[:2]) if len(parts) > 2 else parts[0]


def walk(s3, bucket: str) -> dict:
    log(f"### {bucket}")
    per_group: dict[str, dict] = defaultdict(
        lambda: {"objects": 0, "bytes": 0, "by_ext": defaultdict(lambda: {"n": 0, "bytes": 0})}
    )
    by_ext_total: dict[str, dict] = defaultdict(lambda: {"n": 0, "bytes": 0})
    total = tbytes = 0
    newest = oldest = None

    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        for o in page.get("Contents", []):
            key, size, lm = o["Key"], o["Size"], o["LastModified"]
            m = EXT.search(key)
            ext = m.group(1).lower() if m else "(no extension)"
            g = group_of(key)
            per_group[g]["objects"] += 1
            per_group[g]["bytes"] += size
            per_group[g]["by_ext"][ext]["n"] += 1
            per_group[g]["by_ext"][ext]["bytes"] += size
            by_ext_total[ext]["n"] += 1
            by_ext_total[ext]["bytes"] += size
            total += 1
            tbytes += size
            newest = lm if newest is None or lm > newest else newest
            oldest = lm if oldest is None or lm < oldest else oldest
        if total and total % 200_000 < 1000:
            log(f"  ... {total:,} objects so far")

    out = {
        "bucket": bucket,
        "objects": total,
        "bytes": tbytes,
        "oldest_object": oldest.isoformat() if oldest else None,
        "newest_object": newest.isoformat() if newest else None,
        "by_extension": {
            k: dict(v) for k, v in sorted(by_ext_total.items(), key=lambda kv: -kv[1]["n"])
        },
        "by_group": {
            g: {
                "objects": v["objects"],
                "bytes": v["bytes"],
                "by_extension": {k: dict(e) for k, e in sorted(
                    v["by_ext"].items(), key=lambda kv: -kv[1]["n"])},
            }
            for g, v in sorted(per_group.items(), key=lambda kv: -kv[1]["objects"])
        },
    }
    log(f"  {bucket}: {total:,} objects, {tbytes / 1e9:.1f} GB, {len(per_group)} groups")
    return out


def main() -> None:
    s3 = client()
    all_buckets = [b["Name"] for b in s3.list_buckets()["Buckets"]]
    result = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "all_buckets_in_account": all_buckets,
        "walked": TARGETS,
        "buckets": {},
    }
    targets = sys.argv[1:] or TARGETS
    for b in targets:
        result["buckets"][b] = walk(s3, b)
        (RAW / "r2_inventory.json").write_text(json.dumps(result, indent=1, default=str))
    log("DONE")


if __name__ == "__main__":
    main()
