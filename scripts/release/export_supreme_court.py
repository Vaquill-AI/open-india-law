#!/usr/bin/env python3
"""Stage 1 (Supreme Court): the SC chunk archive -> JSONL.gz.

The Supreme Court corpus lives in a single tarball rather than the sharded
per-court archives the High Courts use, and its chunks carry a slightly
different shape. Two differences need handling rather than passing through:

1. `decision_date` is DD-MM-YYYY here and YYYY-MM-DD in the High Court chunks.
   Publishing both formats in one column would make the field unusable, and it
   is the known reason a date-range filter returns nothing for the Supreme
   Court in the live index.

2. There are 137,491 members for 34,954 judgments, because each judgment may
   also exist in regional-language translations (_HIN, _PUN, _GUJ, ...). Those
   are worth publishing, but every variant restarts chunk_id at _000, so the
   ids collide unless the language is folded in.

The Supreme Court chunks are RICHER than the High Court ones: they carry
citation, cases_cited and cited_by_count, which the High Court set does not.

Usage
    python -m scripts.release.export_supreme_court --out /data/out
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import re
import sys
import tarfile
from collections import Counter
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from scripts.release.export_case_law import _client, coerce  # noqa: E402
from scripts.release.redaction import excluded, has_aggregator_furniture, redact  # noqa: E402

BUCKET = "backup-aws-data"
KEY = "supreme-court-parsed-and-chunks/chunks.tar.gz"

#: 1979_INSC_59_PUN.chunks.jsonl -> base id 1979_INSC_59, language PUN
MEMBER = re.compile(r"(\d{4}_INSC_\d+)(?:_([A-Z]{2,4}))?\.chunks\.jsonl$")
DDMMYYYY = re.compile(r"^(\d{2})-(\d{2})-(\d{4})")


def iso_date(value: str) -> str:
    """DD-MM-YYYY -> YYYY-MM-DD, so the column matches the High Court set."""
    if not value:
        return ""
    if m := DDMMYYYY.match(value.strip()):
        d, mo, y = m.groups()
        return f"{y}-{mo}-{d}"
    return value.strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--languages", default="all",
                    help="'all', or 'en' for the base English judgments only")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    s3 = _client()
    print(f"downloading {KEY} ...", flush=True)
    body = s3.get_object(Bucket=BUCKET, Key=KEY)["Body"].read()
    print(f"  {len(body)/1e6:.0f} MB", flush=True)

    stats: Counter = Counter()
    seen_cases: set[str] = set()
    rows = 0
    out_path = args.out / "in_supreme-court_judgments.jsonl.gz"

    with gzip.open(out_path, "wt", encoding="utf-8") as fh, \
            tarfile.open(fileobj=io.BytesIO(body)) as tar:
        for member in tar:
            if not member.isfile():
                continue
            m = MEMBER.search(member.name)
            if not m:
                stats["unrecognised_member"] += 1
                continue
            base_id, lang = m.group(1), (m.group(2) or "EN")
            if args.languages == "en" and lang != "EN":
                stats["skipped_translation"] += 1
                continue
            raw = tar.extractfile(member)
            if raw is None:
                continue
            chunks = [json.loads(ln) for ln in raw.read().decode("utf-8").splitlines() if ln.strip()]
            if not chunks:
                continue

            blob = "\n".join(c.get("text") or "" for c in chunks)
            if has_aggregator_furniture(blob):
                stats["documents_purged_third_party_source"] += 1
                continue
            if excluded(blob):
                stats["documents_excluded_non_publication"] += 1
                continue

            for c in chunks:
                if c.get("text"):
                    c["text"], hits = redact(c["text"])
                    for rule, n in hits.items():
                        stats[f"redacted_{rule}"] += n
                c["decision_date"] = iso_date(str(c.get("decision_date") or ""))
                c["language_code"] = lang.lower()
                # every language variant restarts chunk_id at _000, so fold the
                # language in to keep ids unique across the published set
                if lang != "EN":
                    c["chunk_id"] = f"{c.get('chunk_id') or base_id}_{lang.lower()}"
                c["court"] = c.get("court") or "Supreme Court of India"
                c["court_type"] = "supreme_court"
                c["court_code"] = "SCI"
                c["source_url"] = ""
                c.setdefault("text_original", c.get("text") or "")
                c.setdefault("bench", "")
                c.setdefault("description", "")
                c.setdefault("date_of_registration", "")
                fh.write(json.dumps(coerce(c), ensure_ascii=False) + "\n")
                rows += 1
            seen_cases.add(base_id)
            stats["documents_kept"] += 1
            stats[f"lang_{lang.lower()}"] += 1

    manifest = [{"file": "in_supreme-court_judgments.parquet",
                 "court": "Supreme Court of India", "rows": rows}]
    (args.out / "manifest_supreme_court.json").write_text(json.dumps(manifest, indent=2))

    print("\n=== summary ===")
    print(f"  distinct judgments   {len(seen_cases):,}")
    print(f"  chunks written       {rows:,}")
    for k, v in sorted(stats.items()):
        print(f"  {k:<38} {v:>10,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
