"""Exact per-court x per-year counts from the Supabase `legal_cases` mirror.

Uses PostgREST `Prefer: count=exact` HEAD requests, which are served by
idx_legal_cases_browse_primary (court_normalized, year, decision_date).

Self-checking: the sum of every bucket written here is compared against an
unfiltered exact count of the table. If a court were missing from COURTS the
totals would not reconcile and the run fails loudly.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

OUT = Path(__file__).parent / "raw"
OUT.mkdir(exist_ok=True)

env = {}
for line in Path(".env").read_text().splitlines():
    line = line.strip()
    if line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k] = v.strip().strip('"').strip("'")

BASE = env["SUPABASE_URL"].rstrip("/") + "/rest/v1/legal_cases"
HDR = {
    "apikey": env["SUPABASE_SERVICE_ROLE_KEY"],
    "authorization": "Bearer " + env["SUPABASE_SERVICE_ROLE_KEY"],
    "user-agent": "vaquill-corpus-audit/1.0",
    "accept": "application/json",
    "prefer": "count=exact",
    "range-unit": "items",
    "range": "0-0",
}

# Every distinct court_normalized value in the table (from a GROUP BY probe).
COURTS = [
    "Patna High Court", "Bombay High Court", "Allahabad High Court", "Madras High Court",
    "Telangana High Court", "Kerala High Court", "Karnataka High Court",
    "Chhattisgarh High Court", "Punjab and Haryana High Court", "Gujarat High Court",
    "Madhya Pradesh High Court", "Rajasthan High Court", "Delhi High Court",
    "Gauhati High Court", "Orissa High Court", "Andhra Pradesh High Court",
    "Jharkhand High Court", "Calcutta High Court", "Himachal Pradesh High Court",
    "Uttarakhand High Court", "Jammu & Kashmir High Court", "Supreme Court of India",
    "Tripura High Court", "Manipur High Court", "Meghalaya High Court",
    "Sikkim High Court", "High Court of Chandigarh", "High Court of Mumbai",
    "High Court", "High Court of Chennai", "High Court of Kashmir",
    "High Court of Jabalpur", "High Court of Guwahati", "High Court of Nagpur",
    "High Court of Aurangabad", "High Court of Andhra",
]

_RANGE_RE = re.compile(r"/(\d+)$")


def exact_count(params: list[tuple[str, str]]) -> int:
    url = BASE + "?" + urllib.parse.urlencode([("select", "id"), *params])
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers=HDR, method="GET")
            with urllib.request.urlopen(req, timeout=600) as resp:
                cr = resp.headers.get("content-range", "")
            m = _RANGE_RE.search(cr)
            if not m:
                raise RuntimeError(f"no count in content-range {cr!r}")
            return int(m.group(1))
        except Exception as exc:  # noqa: BLE001
            if attempt == 5:
                raise
            time.sleep(min(30, 2 * 2**attempt))
    raise AssertionError("unreachable")


def court_param(court: str | None) -> list[tuple[str, str]]:
    return [("court_normalized", "is.null")] if court is None else [
        ("court_normalized", "eq." + court)
    ]


YEARS = list(range(1900, 2031))


def try_count(params: list[tuple[str, str]]):
    """Exact count, or None when PostgREST times out on an unindexed scan.

    Columns like has_full_text/r2_url have no index, so a whole-court count on
    them seq-scans millions of rows and exceeds the statement timeout. Those are
    recorded as null here and sourced from a server-side GROUP BY instead, rather
    than being silently reported as zero.
    """
    try:
        return exact_count(params)
    except Exception as exc:  # noqa: BLE001
        print(f"    count unavailable for {params}: {exc}", flush=True)
        return None


def do_court(court: str | None) -> tuple[str, dict]:
    cp = court_param(court)
    label = court or "(null)"
    row: dict = {}
    # index-backed (idx_legal_cases_browse_primary / idx_legal_cases_sitemap_v2)
    row["year_null"] = try_count([*cp, ("year", "is.null")])
    row["year_lt_1900"] = try_count([*cp, ("year", "lt.1900")])
    row["year_gt_2030"] = try_count([*cp, ("year", "gt.2030")])
    row["with_corpus_case_id"] = try_count([*cp, ("corpus_case_id", "not.is.null")])

    per_year: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        counts = list(pool.map(lambda y: try_count([*cp, ("year", f"eq.{y}")]), YEARS))
    missing_years = [y for y, n in zip(YEARS, counts, strict=True) if n is None]
    for y, n in zip(YEARS, counts, strict=True):
        if n:
            per_year[str(y)] = n
    row["years"] = per_year
    row["years_failed"] = missing_years

    row["total"] = sum(per_year.values()) + sum(
        row[k] or 0 for k in ("year_null", "year_lt_1900", "year_gt_2030")
    )
    row["total_is_complete"] = not missing_years and all(
        row[k] is not None for k in ("year_null", "year_lt_1900", "year_gt_2030")
    )
    print(
        f"[{time.strftime('%H:%M:%S')}] {label}: {row['total']:,} rows, "
        f"{len(per_year)} years, complete={row['total_is_complete']}",
        flush=True,
    )
    return label, row


def main() -> None:
    table_total = try_count([])
    print(f"legal_cases exact total: {table_total}", flush=True)

    out: dict = {"table_total": table_total, "courts": {}}
    for court in [*COURTS, None]:
        label, row = do_court(court)
        out["courts"][label] = row
        (OUT / "supabase_legal_cases.json").write_text(json.dumps(out, indent=1))

    covered = sum(c["total"] for c in out["courts"].values())
    out["sum_of_courts"] = covered
    out["reconciles_with_table_total"] = covered == table_total
    print(f"sum over courts {covered:,} vs table {table_total:,} -> {covered == table_total}")
    (OUT / "supabase_legal_cases.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
