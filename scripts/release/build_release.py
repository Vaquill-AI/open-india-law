#!/usr/bin/env python3
"""Stage 2: JSONL.gz -> Parquet, checksums, totals, tarball.

Writes Parquet in BATCHES rather than materializing a whole file's rows. The US
pipeline learned this the expensive way: holding all rows of one file needed
tens of GB for a 2.6 GB gzip input.

Re-runs the content gates against the Parquet that actually ships. A gate that
only ran on the intermediate is a gate that can be bypassed by editing the
intermediate.

Usage
    python -m scripts.release.build_release --in /rel --out /rel/dist --version v2026.08
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import sys
import tarfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from scripts.release.schema import (  # noqa: E402
    BOOL_FIELDS,
    CASE_LAW_SCHEMA,
    INT_FIELDS,
    INTERNAL_FIELDS,
    LEGISLATION_SCHEMA,
    LIST_FIELDS,
)

BATCH_ROWS = 20_000
# Indian courts cite Manupatra, SCC OnLine and AIR in their own judgments, so a
# brand-name gate refuses legitimate text. The gate is on page FURNITURE, which
# means the document came from that site rather than from the court.
from scripts.release.redaction import has_aggregator_furniture  # noqa: E402


def arrow_schema(columns: tuple[str, ...]):
    import pyarrow as pa

    fields = []
    for c in columns:
        if c in INT_FIELDS:
            fields.append(pa.field(c, pa.int64()))
        elif c in BOOL_FIELDS:
            fields.append(pa.field(c, pa.bool_()))
        elif c in LIST_FIELDS:
            fields.append(pa.field(c, pa.list_(pa.string())))
        else:
            fields.append(pa.field(c, pa.string()))
    return pa.schema(fields)


def gate(rows: list[dict], source: str) -> list[str]:
    """Refusals, not warnings. An empty list means the batch may ship."""
    problems = []
    for r in rows:
        text = (r.get("text") or "") + (r.get("text_original") or "")
        if has_aggregator_furniture(text):
            problems.append(
                f"{source}: third-party page furniture in "
                f"{r.get('chunk_id') or r.get('act_id')} - document was not sourced from the court")
        if not text.strip():
            problems.append(f"{source}: empty text in {r.get('chunk_id') or r.get('act_id')}")
        for f in INTERNAL_FIELDS:
            if f in r:
                problems.append(f"{source}: internal field {f!r} present")
    return problems[:20]


def build(in_dir: Path, out_dir: Path, columns: tuple[str, ...], manifest_name: str) -> list[dict]:
    import pyarrow as pa
    import pyarrow.parquet as pq

    manifest_path = in_dir / manifest_name
    if not manifest_path.exists():
        return []
    manifest = json.loads(manifest_path.read_text())
    schema = arrow_schema(columns)
    written: list[dict] = []

    for entry in manifest:
        src = in_dir / entry["file"].replace(".parquet", ".jsonl.gz")
        if not src.exists():
            print(f"  skip (missing) {src.name}")
            continue
        dst = out_dir / entry["file"]
        writer = pq.ParquetWriter(dst, schema, compression="zstd")
        rows, total, refusals = [], 0, []
        with gzip.open(src, "rt", encoding="utf-8") as fh:
            for line in fh:
                rows.append(json.loads(line))
                if len(rows) >= BATCH_ROWS:
                    refusals += gate(rows, src.name)
                    writer.write_table(pa.Table.from_pylist(rows, schema=schema))
                    total += len(rows)
                    rows = []
        if rows:
            refusals += gate(rows, src.name)
            writer.write_table(pa.Table.from_pylist(rows, schema=schema))
            total += len(rows)
        writer.close()
        if refusals:
            dst.unlink(missing_ok=True)
            raise SystemExit("REFUSING to build:\n  " + "\n  ".join(refusals))
        written.append({"file": entry["file"], "rows": total, "bytes": dst.stat().st_size})
        print(f"  {entry['file']:<48} {total:>10,} rows  {dst.stat().st_size/1e6:>8.1f} MB")
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="in_dir", required=True, type=Path)
    ap.add_argument("--out", dest="out_dir", required=True, type=Path)
    ap.add_argument("--version", required=True)
    ap.add_argument("--skip-tar", action="store_true")
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    print("case law:")
    written = build(args.in_dir, args.out_dir, CASE_LAW_SCHEMA, "manifest_case_law.json")
    print("legislation:")
    written += build(args.in_dir, args.out_dir, LEGISLATION_SCHEMA, "manifest_legislation.json")
    if not written:
        raise SystemExit("nothing built - no manifests found")

    sums = {}
    for w in written:
        h = hashlib.sha256()
        with (args.out_dir / w["file"]).open("rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
        sums[w["file"]] = {"sha256": h.hexdigest(), "rows": w["rows"], "bytes": w["bytes"]}
    (args.out_dir / "SHA256SUMS.json").write_text(json.dumps(sums, indent=2))
    totals = {"version": args.version, "files": len(written),
              "rows": sum(w["rows"] for w in written),
              "bytes": sum(w["bytes"] for w in written)}
    (args.out_dir / "totals.json").write_text(json.dumps(totals, indent=2))

    if not args.skip_tar:
        tar_path = args.out_dir / f"open-india-law-{args.version}-parquet.tar"
        expected = 0
        with tarfile.open(tar_path, "w") as tar:
            for w in written:
                p = args.out_dir / w["file"]
                # realpath: a symlink member is stored as a 0-byte entry, which
                # once shipped a 57 MB tar in place of 1.19 GB.
                real = Path(os.path.realpath(p))
                expected += real.stat().st_size
                tar.add(real, arcname=w["file"])
        got = tar_path.stat().st_size
        if got < expected * 0.9:
            tar_path.unlink()
            raise SystemExit(f"REFUSING: tar {got:,} B < 90% of inputs {expected:,} B")
        print(f"  tar {tar_path.name}  {got/1e6:.1f} MB")

    print(f"\n{totals['files']} files, {totals['rows']:,} rows, {totals['bytes']/1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
