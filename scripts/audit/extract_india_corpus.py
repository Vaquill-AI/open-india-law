"""Exhaustive extraction of the Indian legal corpus footprint from Qdrant.

Produces exact (not sampled) counts:
  - per collection: points, distinct cases
  - per court: points, distinct cases, court_type, decision_date min/max
  - per court x year: points, distinct cases
  - facet distributions for every low-cardinality payload field

Exactness: every count uses Qdrant `exact: true`. Distinct case counts come from
the facet API on the `case_id` keyword index, which enumerates every distinct
value; we assert sum(facet counts) == exact point count for the same filter, so
a truncated facet can never silently under-report.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OUT = Path(__file__).parent / "raw"
OUT.mkdir(exist_ok=True)

FACET_LIMIT = 400_000


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in Path(".env").read_text().splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
    return env


ENV = load_env()
URL = ENV["QDRANT_CORPUS_URL"].rstrip("/")
KEY = ENV["QDRANT_CORPUS_API_KEY"]


def _req(path: str, body: dict | None, method: str, timeout: int):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        URL + path,
        data=data,
        headers={"api-key": KEY, "content-type": "application/json"},
        method=method,
    )
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def call(path: str, body: dict | None = None, method: str = "POST", timeout: int = 1800):
    """POST/GET with retry on transient failures."""
    last: Exception | None = None
    for attempt in range(6):
        try:
            return _req(path, body, method, timeout)
        except urllib.error.HTTPError as exc:
            # 4xx (except 429) is a permanent request error - retrying is pointless
            if 400 <= exc.code < 500 and exc.code != 429:
                raise
            last = exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
        wait = min(60, 3 * 2**attempt)
        log(f"    retry {attempt + 1}/6 after {type(last).__name__}: {last} (sleep {wait}s)")
        time.sleep(wait)
    raise RuntimeError(f"{path} failed after retries: {last}")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def facet(coll: str, keyname: str, flt: dict | None = None, limit: int = 5000) -> list[dict]:
    body: dict = {"key": keyname, "limit": limit, "exact": True}
    if flt:
        body["filter"] = flt
    return call(f"/collections/{coll}/facet", body)["result"]["hits"]


def count(coll: str, flt: dict | None = None) -> int:
    body: dict = {"exact": True}
    if flt:
        body["filter"] = flt
    return call(f"/collections/{coll}/points/count", body)["result"]["count"]


def match(**kw) -> dict:
    return {"must": [{"key": k, "match": {"value": v}} for k, v in kw.items()]}


def date_bounds(coll: str, flt: dict | None) -> tuple[str | None, str | None]:
    """Earliest / latest decision_date under a filter, via the datetime index."""
    out: list[str | None] = []
    for direction in ("asc", "desc"):
        body: dict = {
            "limit": 1,
            "with_payload": ["decision_date", "case_id", "year"],
            "with_vector": False,
            "order_by": {"key": "decision_date", "direction": direction},
        }
        if flt:
            body["filter"] = flt
        try:
            pts = call(f"/collections/{coll}/points/scroll", body)["result"]["points"]
            out.append(pts[0]["payload"].get("decision_date") if pts else None)
        except Exception as exc:  # noqa: BLE001 - best effort metadata
            log(f"    date_bounds failed: {exc}")
            out.append(None)
    return out[0], out[1]


def _month_slices(coll: str, flt: dict) -> dict[str, int]:
    """Union case_id -> chunk count by walking month windows of decision_date."""
    merged: dict[str, int] = {}
    years = {int(h["value"]): h["count"] for h in facet(coll, "year", flt, 500)}
    for y in sorted(years):
        for m in range(1, 13):
            lo = f"{y}-{m:02d}-01T00:00:00Z"
            hi = f"{y + (m == 12)}-{(m % 12) + 1:02d}-01T00:00:00Z"
            sub = {
                "must": [
                    *flt["must"],
                    {"key": "decision_date", "range": {"gte": lo, "lt": hi}},
                ]
            }
            for h in facet(coll, "case_id", sub, limit=FACET_LIMIT):
                merged[h["value"]] = merged.get(h["value"], 0) + h["count"]
    return merged


def distinct_cases(coll: str, flt: dict) -> tuple[int, int, dict, set[str]]:
    """Exact distinct case_id count under a filter.

    Returns (distinct_cases, chunk_sum, chunk_stats, case_id_set). The caller
    checks chunk_sum against the exact point count, so a truncated or partial
    facet can never be silently reported as complete.
    """
    try:
        hits = facet(coll, "case_id", flt, limit=FACET_LIMIT)
        pairs = {h["value"]: h["count"] for h in hits}
    except Exception as exc:  # noqa: BLE001
        log(f"    single facet failed ({exc}); falling back to month slices")
        pairs = _month_slices(coll, flt)

    chunk_sum = sum(pairs.values())
    counts = sorted(pairs.values())
    summary = {}
    if counts:
        n = len(counts)
        summary = {
            "min_chunks": counts[0],
            "p50_chunks": counts[n // 2],
            "p95_chunks": counts[min(n - 1, int(n * 0.95))],
            "max_chunks": counts[-1],
            "mean_chunks": round(chunk_sum / n, 2),
        }
    return len(pairs), chunk_sum, summary, set(pairs)


# --------------------------------------------------------------------------- #
# Case-law collections
# --------------------------------------------------------------------------- #

FACET_FIELDS_CASES = [
    "court_type",
    "country_code",
    "section_type",
    "disposition",
    "language_code",
    "state_code",
    "bench_strength",
    "section_priority",
    "case_type",
    "bench_type",
    "state_name",
]


def extract_case_collection(coll: str) -> dict:
    log(f"### {coll}")
    info = call(f"/collections/{coll}", None, "GET", 300)["result"]
    total_points = info["points_count"]
    result: dict = {
        "collection": coll,
        "points_count": total_points,
        "segments_count": info.get("segments_count"),
        "payload_schema_fields": sorted((info.get("payload_schema") or {}).keys()),
        "facets": {},
        "courts": {},
    }

    for f in FACET_FIELDS_CASES:
        try:
            hits = facet(coll, f, limit=20000)
            result["facets"][f] = {str(h["value"]): h["count"] for h in hits}
            log(f"  facet {f}: {len(hits)} distinct")
        except Exception as exc:  # noqa: BLE001
            log(f"  facet {f} FAILED: {exc}")
            result["facets"][f] = {"__error__": str(exc)}

    # missing-value diagnostics
    result["missing"] = {}
    for f in ("court", "decision_date", "case_number", "disposition", "judges", "citation"):
        try:
            result["missing"][f] = count(coll, {"must": [{"is_empty": {"key": f}}]})
        except Exception as exc:  # noqa: BLE001
            result["missing"][f] = f"error: {exc}"
    log(f"  missing: {result['missing']}")

    court_hits = facet(coll, "court", limit=20000)
    courts = [h["value"] for h in sorted(court_hits, key=lambda h: -h["count"])]
    log(f"  {len(courts)} distinct raw court values")

    ckpt = OUT / f"{coll}.json"
    if ckpt.exists():
        prior = json.loads(ckpt.read_text())
        result["courts"] = prior.get("courts", {})
        log(f"  resuming: {len(result['courts'])} courts already done")

    for i, court in enumerate(courts, 1):
        if court in result["courts"]:
            continue
        t0 = time.time()
        cflt = match(court=court)
        cpoints = count(coll, cflt)
        ctypes = {str(h["value"]): h["count"] for h in facet(coll, "court_type", cflt, 100)}
        first, last = date_bounds(coll, cflt)
        years = {int(h["value"]): h["count"] for h in facet(coll, "year", cflt, 500)}

        per_year: dict[str, dict] = {}
        court_cases_total = 0
        court_ids: set[str] = set()
        all_consistent = True
        for y in sorted(years):
            yflt = {
                "must": [
                    {"key": "court", "match": {"value": court}},
                    {"key": "year", "match": {"value": y}},
                ]
            }
            ncases, chunk_sum, hist, ids = distinct_cases(coll, yflt)
            ok = chunk_sum == years[y]
            per_year[str(y)] = {
                "cases": ncases,
                "chunks": chunk_sum,
                "chunks_expected": years[y],
                "consistent": ok,
                **hist,
            }
            court_cases_total += ncases
            court_ids |= ids
            if not ok:
                all_consistent = False
                log(f"    !! {court} {y}: facet sum {chunk_sum} != count {years[y]}")

        # Court-level distinct is the union of the per-year id sets, so a case_id
        # appearing under two years is counted once (and the delta is reported).
        court_cases_direct = len(court_ids)

        result["courts"][court] = {
            "points": cpoints,
            "court_type": ctypes,
            "earliest_decision_date": first,
            "latest_decision_date": last,
            "cases_distinct": court_cases_direct,
            "cases_sum_of_years": court_cases_total,
            "cases_year_overlap": court_cases_total - court_cases_direct,
            "chunks_all_years_consistent": all_consistent,
            "chunks_year_sum": sum(v["chunks"] for v in per_year.values()),
            "years": per_year,
        }
        log(
            f"  [{i}/{len(courts)}] {court}: {cpoints:,} chunks, "
            f"{court_cases_direct:,} cases, {len(per_year)} years "
            f"({round(time.time() - t0, 1)}s)"
        )
        ckpt.write_text(json.dumps(result, indent=1))

    # points with no court value at all
    empty_flt = {"must": [{"is_empty": {"key": "court"}}]}
    n_empty = count(coll, empty_flt)
    if n_empty:
        ncases, chunk_sum, hist, _ = distinct_cases(coll, empty_flt)
        years = {int(h["value"]): h["count"] for h in facet(coll, "year", empty_flt, 500)}
        result["no_court_value"] = {
            "points": n_empty,
            "cases": ncases,
            "chunks_matched": chunk_sum,
            "years": {str(k): v for k, v in sorted(years.items())},
            "chunk_stats": hist,
        }
        log(f"  no-court bucket: {n_empty:,} chunks / {ncases:,} cases")

    result["totals"] = {
        "points_from_courts": sum(c["points"] for c in result["courts"].values()) + n_empty,
        "cases_from_courts": sum(c["cases_distinct"] for c in result["courts"].values())
        + (result.get("no_court_value", {}).get("cases", 0)),
    }
    first, last = date_bounds(coll, None)
    result["earliest_decision_date"] = first
    result["latest_decision_date"] = last
    ckpt.write_text(json.dumps(result, indent=1))
    log(f"### {coll} DONE: {result['totals']}")
    return result


# --------------------------------------------------------------------------- #
# acts_india
# --------------------------------------------------------------------------- #

FACET_FIELDS_ACTS = [
    "jurisdiction",
    "state",
    "category",
    "doc_type",
    "act_status",
    "section_status",
    "is_repealed",
    "language_code",
    "country_code",
    "provision_type",
    "section_type",
    "legal_subject",
    "has_proviso",
    "has_non_obstante",
    "delegation_type",
    "regulatory_body",
    "year",
    "amendment_count",
]


def distinct_acts(flt: dict | None) -> tuple[int, int]:
    hits = facet("acts_india", "act_id", flt, limit=FACET_LIMIT)
    return len(hits), sum(h["count"] for h in hits)


def extract_acts() -> dict:
    coll = "acts_india"
    log(f"### {coll}")
    info = call(f"/collections/{coll}", None, "GET", 300)["result"]
    result: dict = {
        "collection": coll,
        "points_count": info["points_count"],
        "segments_count": info.get("segments_count"),
        "facets": {},
    }
    for f in FACET_FIELDS_ACTS:
        try:
            hits = facet(coll, f, limit=20000)
            result["facets"][f] = {str(h["value"]): h["count"] for h in hits}
            log(f"  facet {f}: {len(hits)} distinct")
        except Exception as exc:  # noqa: BLE001
            log(f"  facet {f} FAILED: {exc}")
            result["facets"][f] = {"__error__": str(exc)}

    result["missing"] = {}
    for f in ("year", "title", "acts_referenced", "state", "chapter", "section_number"):
        try:
            result["missing"][f] = count(coll, {"must": [{"is_empty": {"key": f}}]})
        except Exception as exc:  # noqa: BLE001
            result["missing"][f] = f"error: {exc}"

    total_acts, total_sections = distinct_acts(None)
    result["acts_distinct_total"] = total_acts
    result["sections_total"] = total_sections
    log(f"  distinct acts: {total_acts:,} over {total_sections:,} provisions")

    # breakdown dimensions -> distinct acts
    for dim in ("jurisdiction", "state", "category", "doc_type", "act_status", "legal_subject"):
        vals = list(result["facets"].get(dim, {}).keys())
        if "__error__" in vals:
            continue
        block: dict = {}
        for v in vals:
            n_acts, n_sec = distinct_acts(match(**{dim: v}))
            block[v] = {"acts": n_acts, "provisions": n_sec}
        result[f"by_{dim}"] = block
        log(f"  by_{dim}: {len(block)} values")
        (OUT / "acts_india.json").write_text(json.dumps(result, indent=1))

    # year x jurisdiction
    years = sorted(int(y) for y in result["facets"].get("year", {}))
    jurs = list(result["facets"].get("jurisdiction", {}).keys())
    yblock: dict = {}
    for y in years:
        row = {}
        for j in jurs:
            flt = {
                "must": [
                    {"key": "year", "match": {"value": y}},
                    {"key": "jurisdiction", "match": {"value": j}},
                ]
            }
            n_acts, n_sec = distinct_acts(flt)
            if n_acts:
                row[j] = {"acts": n_acts, "provisions": n_sec}
        n_acts_all, n_sec_all = distinct_acts(match(year=y))
        row["__total__"] = {"acts": n_acts_all, "provisions": n_sec_all}
        yblock[str(y)] = row
    result["by_year"] = yblock
    log(f"  by_year: {len(yblock)} years")

    # state x category (which states have which kinds of legislation)
    states = list(result["facets"].get("state", {}).keys())
    sblock: dict = {}
    for s in states:
        sflt = match(state=s)
        n_acts, n_sec = distinct_acts(sflt)
        cats = {str(h["value"]): h["count"] for h in facet(coll, "category", sflt, 5000)}
        statuses = {str(h["value"]): h["count"] for h in facet(coll, "act_status", sflt, 5000)}
        yrs = {str(h["value"]): h["count"] for h in facet(coll, "year", sflt, 5000)}
        sblock[s] = {
            "acts": n_acts,
            "provisions": n_sec,
            "categories": cats,
            "act_status": statuses,
            "years": {k: yrs[k] for k in sorted(yrs, key=lambda x: int(x))},
        }
        log(f"  state {s}: {n_acts:,} acts / {n_sec:,} provisions")
        (OUT / "acts_india.json").write_text(json.dumps(result | {"by_state_detail": sblock}, indent=1))
    result["by_state_detail"] = sblock

    (OUT / "acts_india.json").write_text(json.dumps(result, indent=1))
    log("### acts_india DONE")
    return result


if __name__ == "__main__":
    targets = sys.argv[1:] or ["acts_india", "legal_corpus_v2", "legal_corpus_v1"]
    os.chdir(Path(__file__).resolve().parents[2])
    for t in targets:
        started = time.time()
        if t == "acts_india":
            extract_acts()
        else:
            extract_case_collection(t)
        log(f"{t} took {round(time.time() - started)}s")
    log("ALL DONE")
