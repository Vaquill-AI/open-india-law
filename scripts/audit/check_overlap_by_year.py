"""Exact per-court, per-year duplication between the two case-law collections.

check_overlap.py gives the duplicate count per court, which is enough to state a
correct corpus total. It is not enough to state a correct judgment count for a
single year, and a coverage report quoted to a client needs that.

For every court held in both collections, this walks year by year: pull the
case IDs for that court and year from whichever collection holds fewer chunks,
then probe the other collection in batches. The result is the exact number of
judgments present in both for that year, so:

    judgments(court, year) = v1(court, year) + v2(court, year) - overlap(court, year)

Self-check: the per-year overlaps are summed per court and compared against the
court-level figure from check_overlap.py. A mismatch means a judgment is filed
under different years in the two collections, and is reported rather than hidden.

Writes raw/overlap_by_year.json.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_docs_canon import canonical
from extract_india_corpus import OUT, facet, log

BATCH = 400
V1, V2 = "legal_corpus_v1", "legal_corpus_v2"


def ids_for(coll: str, labels: list[str], year: int) -> set[str]:
    out: set[str] = set()
    for lab in labels:
        flt = {
            "must": [
                {"key": "court", "match": {"value": lab}},
                {"key": "year", "match": {"value": year}},
            ]
        }
        out |= {h["value"] for h in facet(coll, "case_id", flt, limit=400_000)}
    return out


def present_in(coll: str, ids: list[str]) -> int:
    found = 0
    for i in range(0, len(ids), BATCH):
        hits = facet(
            coll,
            "case_id",
            {"must": [{"key": "case_id", "match": {"any": ids[i : i + BATCH]}}]},
            limit=400_000,
        )
        found += len(hits)
    return found


def main() -> None:
    v1 = json.loads((OUT / f"{V1}.json").read_text())
    v2 = json.loads((OUT / f"{V2}.json").read_text())
    court_level = json.loads((OUT / "overlap.json").read_text())["shared_courts"]

    def labels(blob) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for raw in blob["courts"]:
            out.setdefault(canonical(raw), []).append(raw)
        return out

    l1, l2 = labels(v1), labels(v2)
    result: dict = {"courts": {}, "batch_size": BATCH}

    for canon, cl in court_level.items():
        if cl["case_ids_in_both"] == 0:
            result["courts"][canon] = {"years": {}, "total_overlap": 0,
                                       "matches_court_level": True}
            log(f"  {canon}: no overlap, skipped")
            continue

        t0 = time.time()
        small, big = (V1, V2) if cl["v1_chunks"] <= cl["v2_chunks"] else (V2, V1)
        small_labels = l1[canon] if small == V1 else l2[canon]
        blob = v1 if small == V1 else v2
        years = sorted(
            {int(y) for lab in small_labels for y in blob["courts"][lab]["years"]}
        )

        per_year: dict[str, int] = {}
        for y in years:
            ids = ids_for(small, small_labels, y)
            if not ids:
                continue
            n = present_in(big, sorted(ids))
            if n:
                per_year[str(y)] = n

        total = sum(per_year.values())
        ok = total == cl["case_ids_in_both"]
        result["courts"][canon] = {
            "years": per_year,
            "total_overlap": total,
            "court_level_overlap": cl["case_ids_in_both"],
            "matches_court_level": ok,
            "probed_from": small,
        }
        log(
            f"  {canon}: {total:,} duplicates across {len(per_year)} years "
            f"(court-level said {cl['case_ids_in_both']:,}, "
            f"{'match' if ok else 'MISMATCH'}) ({round(time.time() - t0, 1)}s)"
        )
        (OUT / "overlap_by_year.json").write_text(json.dumps(result, indent=1))

    bad = [c for c, v in result["courts"].items() if not v["matches_court_level"]]
    result["all_courts_reconcile"] = not bad
    result["courts_not_reconciling"] = bad
    result["total_overlap"] = sum(v["total_overlap"] for v in result["courts"].values())
    (OUT / "overlap_by_year.json").write_text(json.dumps(result, indent=1))
    log(f"TOTAL {result['total_overlap']:,}; reconciles: {not bad} {bad if bad else ''}")


if __name__ == "__main__":
    main()
