#!/usr/bin/env python3
"""Stage 3: dist/ -> the Hugging Face dataset and the Cloudflare R2 mirror.

Two destinations on purpose. The Hub is where people look; the mirror is a copy
on a domain we control, with zero egress and HTTP range requests so a client can
query the Parquet without downloading it.

    python -m scripts.release.publish --dist /rel/dist --version v2026.08 --target hf
    python -m scripts.release.publish --dist /rel/dist --version v2026.08 --target r2
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

HF_REPO = "vaquill/open-india-law"
BASE_URL = "https://oss-data-in.vaquill.ai"
CANONICAL = f"https://huggingface.co/datasets/{HF_REPO}"
SCRAPERS = "https://github.com/Vaquill-AI/open-india-law"

#: The mirror has its OWN bucket. R2_BUCKET_NAME in .env is the application's
#: document bucket; uploading there succeeds silently while the live site stays
#: unchanged. On the US release that cost 233 objects and 8.17 GB written into
#: production storage, with a clean exit code. Never read the bucket from env.
MIRROR_BUCKET = "open-india-law"

#: Bulk PDFs go to the mirror only. The Hub gets Parquet: it becomes unhappy
#: with public datasets much past ~300 GB, and the tribunal PDFs alone are 564 GB.
HF_SUFFIXES = (".parquet", ".json", ".md")


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def publish_hf(dist: Path, version: str, dry: bool) -> None:
    from huggingface_hub import HfApi

    # upload_folder and upload_large_folder hang on Xet; batched create_commit
    # is the path that completes.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    api = HfApi(token=os.environ.get("HF_TOKEN"))
    files = sorted(p for p in dist.iterdir() if p.suffix in HF_SUFFIXES and p.is_file())
    print(f"  {len(files)} files -> {HF_REPO}")
    if dry:
        for f in files:
            print(f"    would upload {f.name}  {f.stat().st_size/1e6:.1f} MB")
        return
    api.create_repo(HF_REPO, repo_type="dataset", exist_ok=True, private=True)
    from huggingface_hub import CommitOperationAdd

    BATCH = 25
    for i in range(0, len(files), BATCH):
        chunk = files[i : i + BATCH]
        api.create_commit(
            repo_id=HF_REPO,
            repo_type="dataset",
            operations=[CommitOperationAdd(f.name, str(f)) for f in chunk],
            commit_message=f"{version}: files {i + 1}-{i + len(chunk)}",
        )
        print(f"    committed {i + len(chunk)}/{len(files)}")


def publish_r2(dist: Path, version: str, dry: bool) -> None:
    import boto3
    from botocore.config import Config

    s3 = boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
        config=Config(retries={"max_attempts": 8, "mode": "standard"}),
    )
    files = sorted(p for p in dist.iterdir() if p.is_file())
    for f in files:
        key = f"{version}/{f.name}"
        if dry:
            print(f"    would put {key}  {f.stat().st_size/1e6:.1f} MB")
        else:
            s3.upload_file(str(f), MIRROR_BUCKET, key)
            print(f"    put {key}")

    # Build the index from WHAT IS IN THE BUCKET, not from this dist directory.
    # Publishing case law from one machine after publishing legislation from
    # another silently un-advertised the legislation, because the index was
    # rebuilt from one run's files and then overwrote the other's.
    entries = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=MIRROR_BUCKET, Prefix=f"{version}/"):
        for o in page.get("Contents", []):
            name = o["Key"].split("/")[-1]
            if name in {"index.json", "index.html"}:
                continue
            entries.append({"file": name, "key": o["Key"], "bytes": o["Size"],
                            "etag": o["ETag"].strip('"'),
                            "url": f"{BASE_URL}/{o['Key']}"})
    entries.sort(key=lambda e: e["file"])
    print(f"    index covers {len(entries)} objects in the bucket")

    index = {
        "dataset": "open-india-law", "version": version,
        "license_data": "CC-BY-4.0", "license_scripts": "Apache-2.0",
        "underlying_text": "Government work under s.17(d), Copyright Act 1957; "
                           "reproduced under the s.52(1)(q) exception. No rights claimed.",
        "canonical": CANONICAL, "scrapers": SCRAPERS,
        "base_url": BASE_URL, "files": entries,
        "total_bytes": sum(e["bytes"] for e in entries),
    }
    if not dry:
        s3.put_object(Bucket=MIRROR_BUCKET, Key="index.json",
                      Body=json.dumps(index, indent=2).encode(),
                      ContentType="application/json")
        # R2 custom domains do not resolve an index document, so the bare root
        # 404s by design. Every link must point at /index.html.
        rows = "\n".join(
            f'<tr><td><a href="{e["url"]}">{e["file"]}</a></td>'
            f'<td align="right">{e["bytes"]/1e6:.1f} MB</td></tr>' for e in entries)
        html = (f"<!doctype html><meta charset=utf-8><title>Open India Law {version}</title>"
                f"<h1>Open India Law {version}</h1>"
                f'<p>Canonical: <a href="{CANONICAL}">{CANONICAL}</a> &middot; '
                f'Scrapers: <a href="{SCRAPERS}">{SCRAPERS}</a></p>'
                f"<table>{rows}</table>")
        s3.put_object(Bucket=MIRROR_BUCKET, Key="index.html",
                      Body=html.encode(), ContentType="text/html")
    print(f"  {len(entries)} objects, {sum(e['bytes'] for e in entries)/1e9:.2f} GB")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dist", required=True, type=Path)
    ap.add_argument("--version", required=True)
    ap.add_argument("--target", choices=["hf", "r2", "both"], default="both")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    from dotenv import load_dotenv

    load_dotenv()
    if args.target in ("hf", "both"):
        print("hugging face:")
        publish_hf(args.dist, args.version, args.dry_run)
    if args.target in ("r2", "both"):
        print("r2 mirror:")
        publish_r2(args.dist, args.version, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
