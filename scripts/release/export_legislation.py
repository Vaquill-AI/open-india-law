#!/usr/bin/env python3
"""Stage 1 (legislation): the acts_india collection -> per-jurisdiction JSONL.gz.

Unlike case law this does read the vector store, because the chunked provisions
only exist there. At 1.1M points it is a tenth of the US corpus, so a scroll is
affordable - but it still streams: one jurisdiction at a time, written out as it
goes, nothing accumulated.

The taxonomy repair in taxonomy.py is applied here. The raw payload carries two
byte-identical fields (`jurisdiction` and `category`) neither of which is a
jurisdiction, and a fourth act_status value (`superseded`) that three-way status
splits silently report as in force.

Usage
    python -m scripts.release.export_legislation --out /rel --dry-run
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from scripts.release.redaction import excluded, has_aggregator_furniture, redact  # noqa: E402
from scripts.release.schema import (  # noqa: E402
    BOOL_FIELDS,
    INT_FIELDS,
    LEGISLATION_SCHEMA,
    LIST_FIELDS,
)
from scripts.release.taxonomy import UnknownStatusError, repair  # noqa: E402

COLLECTION = "acts_india"
#: Only what the schema needs. Asking for the whole payload drags internals.
PAYLOAD_KEYS = [
    "act_id", "chunk_id", "title", "chapter", "section_number", "section_type",
    "text", "jurisdiction", "category", "state", "act_status", "section_status",
    "doc_type", "provision_type", "legal_subject", "has_proviso",
    "has_non_obstante", "delegation_type", "department", "regulatory_body",
    "acts_referenced", "defined_terms", "amendment_count", "year",
    "language_code", "is_repealed",
]


def coerce(row: dict) -> dict:
    out: dict[str, object] = {}
    for f in LEGISLATION_SCHEMA:
        v = row.get(f)
        if f in INT_FIELDS:
            try:
                out[f] = int(v) if v not in (None, "") else None
            except (TypeError, ValueError):
                out[f] = None
        elif f in BOOL_FIELDS:
            out[f] = bool(v) if v is not None else None
        elif f in LIST_FIELDS:
            out[f] = v if isinstance(v, list) else ([] if v in (None, "") else [str(v)])
        else:
            out[f] = None if v is None else str(v)
    return out


def main() -> int:
    from dotenv import load_dotenv
    from qdrant_client import QdrantClient

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="0 = all points")
    args = ap.parse_args()

    load_dotenv()
    client = QdrantClient(
        url=os.environ["QDRANT_CORPUS_URL"],
        api_key=os.environ["QDRANT_CORPUS_API_KEY"],
        timeout=900,
        check_compatibility=False,
    )
    args.out.mkdir(parents=True, exist_ok=True)

    handles: dict[str, gzip.GzipFile] = {}
    rows: dict[str, int] = defaultdict(int)
    stats: Counter = Counter()
    offset = None
    seen = 0

    def bucket(rec: dict) -> str:
        """central, or the state - the axis a reader actually wants."""
        return rec.get("state") or rec["jurisdiction"] or "unknown"

    while True:
        pts, offset = client.scroll(
            collection_name=COLLECTION, limit=4000, offset=offset,
            with_payload=PAYLOAD_KEYS, with_vectors=False,
        )
        if not pts:
            break
        for p in pts:
            payload = p.payload or {}
            seen += 1
            text = payload.get("text") or ""
            if not text.strip():
                stats["skipped_empty_text"] += 1
                continue
            if has_aggregator_furniture(text) or excluded(text):
                stats["excluded"] += 1
                continue
            try:
                fixed = repair(payload)
            except UnknownStatusError as exc:
                # Fail loudly. A silent default is how `superseded` came to be
                # reported as in force in the first place.
                print(f"REFUSING: {exc}")
                return 1
            payload.update(fixed)
            payload["text"], hits = redact(text)
            for rule, n in hits.items():
                stats[f"redacted_{rule}"] += n
            payload.setdefault("source_url", "")
            payload.setdefault("section_title", payload.get("title") or "")
            payload.setdefault("language_code", "en")

            key = bucket(payload)
            rows[key] += 1
            stats["provisions_kept"] += 1
            if not args.dry_run:
                if key not in handles:
                    handles[key] = gzip.open(
                        args.out / f"in_{key}_legislation.jsonl.gz", "wt", encoding="utf-8")
                handles[key].write(json.dumps(coerce(payload), ensure_ascii=False) + "\n")
        if seen % 100_000 < 4000:
            print(f"  {seen:,} points scanned, {stats['provisions_kept']:,} kept", flush=True)
        if offset is None or (args.limit and seen >= args.limit):
            break

    for fh in handles.values():
        fh.close()
    manifest = [
        {"file": f"in_{k}_legislation.parquet", "jurisdiction": k, "rows": n}
        for k, n in sorted(rows.items(), key=lambda kv: -kv[1])
    ]
    if not args.dry_run:
        (args.out / "manifest_legislation.json").write_text(json.dumps(manifest, indent=2))

    print("\n=== summary ===")
    for k, v in sorted(stats.items()):
        print(f"  {k:<38} {v:>12,}")
    print(f"  {'jurisdictions':<38} {len(rows):>12,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
