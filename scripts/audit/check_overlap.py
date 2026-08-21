"""Exact cross-collection duplication check for the India case-law corpus.

legal_corpus_v1 and legal_corpus_v2 both hold High Court judgments and several
courts appear in both. Adding their case counts is only valid if the case_id
sets are disjoint. This measures the intersection exactly:

  1. pull every case_id for the court from whichever collection has fewer chunks
  2. probe the other collection in batches with MatchAny(case_id)
  3. report the exact number of case_ids present in both

Writes raw/overlap.json.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from extract_india_corpus import OUT, count, facet, log  # noqa: E402

BATCH = 400


def court_case_ids(coll: str, court: str, years: dict) -> set[str]:
    ids: set[str] = set()
    for y in years:
        flt = {
            "must": [
                {"key": "court", "match": {"value": court}},
                {"key": "year", "match": {"value": int(y)}},
            ]
        }
        ids |= {h["value"] for h in facet(coll, "case_id", flt, limit=400_000)}
    return ids


def present_in(coll: str, ids: list[str]) -> int:
    """How many of `ids` have at least one point in `coll` (exact)."""
    found = 0
    for i in range(0, len(ids), BATCH):
        chunk = ids[i : i + BATCH]
        hits = facet(
            coll,
            "case_id",
            {"must": [{"key": "case_id", "match": {"any": chunk}}]},
            limit=400_000,
        )
        found += len(hits)
    return found


def main() -> None:
    v1 = json.loads((OUT / "legal_corpus_v1.json").read_text())
    v2 = json.loads((OUT / "legal_corpus_v2.json").read_text())

    # canonical grouping is done in build_docs; here we work per raw label pair
    from build_docs_canon import canonical  # noqa: PLC0415

    def by_canon(blob):
        out: dict[str, list[tuple[str, dict]]] = {}
        for raw, d in blob["courts"].items():
            out.setdefault(canonical(raw), []).append((raw, d))
        return out

    c1, c2 = by_canon(v1), by_canon(v2)
    shared = sorted(set(c1) & set(c2))
    log(f"{len(shared)} canonical courts appear in BOTH collections: {shared}")

    result: dict = {"shared_courts": {}, "batch_size": BATCH}
    for canon in shared:
        t0 = time.time()
        n1 = sum(d["points"] for _, d in c1[canon])
        n2 = sum(d["points"] for _, d in c2[canon])
        small, big = ("legal_corpus_v1", "legal_corpus_v2") if n1 <= n2 else (
            "legal_corpus_v2",
            "legal_corpus_v1",
        )
        src = c1[canon] if small == "legal_corpus_v1" else c2[canon]

        ids: set[str] = set()
        for raw, d in src:
            ids |= court_case_ids(small, raw, d["years"])
        overlap = present_in(big, sorted(ids))

        cases1 = sum(d["cases_distinct"] for _, d in c1[canon])
        cases2 = sum(d["cases_distinct"] for _, d in c2[canon])
        result["shared_courts"][canon] = {
            "v1_chunks": n1,
            "v2_chunks": n2,
            "v1_cases": cases1,
            "v2_cases": cases2,
            "probed_from": small,
            "probed_ids": len(ids),
            "case_ids_in_both": overlap,
            "naive_sum": cases1 + cases2,
            "deduped_cases": cases1 + cases2 - overlap,
        }
        log(
            f"  {canon}: v1={cases1:,} v2={cases2:,} overlap={overlap:,} "
            f"-> deduped {cases1 + cases2 - overlap:,} ({round(time.time() - t0, 1)}s)"
        )
        (OUT / "overlap.json").write_text(json.dumps(result, indent=1))

    total_overlap = sum(v["case_ids_in_both"] for v in result["shared_courts"].values())
    result["total_case_ids_in_both_collections"] = total_overlap
    (OUT / "overlap.json").write_text(json.dumps(result, indent=1))
    log(f"TOTAL cross-collection duplicate case_ids: {total_overlap:,}")


if __name__ == "__main__":
    main()
