"""Exact inventory of the Indian tribunal holdings.

Tribunal decisions live in fifteen `tribunal_*` tables in Supabase and as PDFs in
the `tribunal-judgments` R2 bucket. They are NOT in the search corpus, so they do
not appear in the case-law coverage report.

Every count here is an exact PostgREST `count=exact` over the table, per
tribunal and per year. The tables are small enough that this never needs an
aggregate query or a statement-timeout workaround.

Writes raw/tribunals.json.
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

REPO = Path(__file__).resolve().parents[2]
RAW = Path(__file__).parent / "raw"
RAW.mkdir(exist_ok=True)

env = {}
for line in (REPO / ".env").read_text().splitlines():
    line = line.strip()
    if line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k] = v.strip().strip('"').strip("'")

BASE = env["SUPABASE_URL"].rstrip("/") + "/rest/v1/"
HDR = {
    "apikey": env["SUPABASE_SERVICE_ROLE_KEY"],
    "authorization": "Bearer " + env["SUPABASE_SERVICE_ROLE_KEY"],
    "user-agent": "vaquill-corpus-audit/1.0",
    "accept": "application/json",
    "prefer": "count=exact",
    "range": "0-0",
}

TRIBUNALS = {
    "aptel": "Appellate Tribunal for Electricity",
    "atfp": "Appellate Tribunal for Forfeited Property",
    "cat": "Central Administrative Tribunal",
    "cat_cis": "Central Administrative Tribunal (case information system)",
    "cci": "Competition Commission of India",
    "cestat": "Customs, Excise and Service Tax Appellate Tribunal",
    "drt": "Debts Recovery Tribunal and Appellate Tribunal",
    "gst_aar": "GST Authority for Advance Ruling",
    "ibbi": "Insolvency and Bankruptcy Board of India",
    "itat": "Income Tax Appellate Tribunal",
    "nclt": "National Company Law Tribunal",
    "ngt": "National Green Tribunal",
    "rera": "Real Estate Regulatory Authority",
    "sat": "Securities Appellate Tribunal",
    "tdsat": "Telecom Disputes Settlement and Appellate Tribunal",
}

# Columns that carry usable content, checked for how much is actually populated.
CONTENT_COLS = ["pdf_url", "source_pdf_url", "headnotes", "outcome",
                "subject_matter", "case_number", "decision_date"]

_RANGE = re.compile(r"/(\d+)$")
YEARS = list(range(1980, 2031))


def count(table: str, params: list[tuple[str, str]]):
    url = BASE + table + "?" + urllib.parse.urlencode([("select", "id"), *params])
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers=HDR, method="GET")
            with urllib.request.urlopen(req, timeout=600) as resp:
                cr = resp.headers.get("content-range", "")
            m = _RANGE.search(cr)
            if m:
                return int(m.group(1))
            raise RuntimeError(f"no count in {cr!r}")
        except Exception as exc:  # noqa: BLE001
            if attempt == 4:
                print(f"    count failed {table} {params}: {exc}", flush=True)
                return None
            time.sleep(2 * 2**attempt)
    return None


def has_col(table: str, col: str) -> bool:
    url = BASE + table + "?" + urllib.parse.urlencode([("select", col), ("limit", "1")])
    try:
        urllib.request.urlopen(urllib.request.Request(url, headers=HDR), timeout=60)
        return True
    except urllib.error.HTTPError:
        return False


def main() -> None:
    out: dict = {"generated": time.strftime("%Y-%m-%d %H:%M:%S"), "tribunals": {}}
    for slug, name in TRIBUNALS.items():
        table = f"tribunal_{slug}"
        t0 = time.time()
        rec: dict = {"name": name, "table": table}
        rec["records"] = count(table, [])

        for col in CONTENT_COLS:
            if not has_col(table, col):
                rec[f"with_{col}"] = None
                continue
            rec[f"with_{col}"] = count(table, [(col, "not.is.null")])

        rec["judgments_flagged"] = count(table, [("is_judgment", "is.true")])
        rec["year_missing"] = count(table, [("year", "is.null")])
        rec["year_before_1980"] = count(table, [("year", "lt.1980")])
        rec["year_after_2030"] = count(table, [("year", "gt.2030")])

        with ThreadPoolExecutor(max_workers=6) as pool:
            counts = list(pool.map(lambda y: count(table, [("year", f"eq.{y}")]), YEARS))
        years = {str(y): n for y, n in zip(YEARS, counts, strict=True) if n}
        rec["years"] = years

        bucket_sum = sum(years.values()) + sum(
            rec[k] or 0 for k in ("year_missing", "year_before_1980", "year_after_2030")
        )
        rec["year_buckets_reconcile"] = bucket_sum == rec["records"]
        out["tribunals"][slug] = rec
        print(
            f"[{time.strftime('%H:%M:%S')}] {slug}: {rec['records']:,} records, "
            f"{len(years)} years, reconcile={rec['year_buckets_reconcile']} "
            f"({round(time.time() - t0, 1)}s)",
            flush=True,
        )
        (RAW / "tribunals.json").write_text(json.dumps(out, indent=1))

    out["total_records"] = sum(t["records"] or 0 for t in out["tribunals"].values())
    out["all_reconcile"] = all(
        t["year_buckets_reconcile"] for t in out["tribunals"].values()
    )
    (RAW / "tribunals.json").write_text(json.dumps(out, indent=1))
    print(f"TOTAL {out['total_records']:,}; all reconcile: {out['all_reconcile']}")


if __name__ == "__main__":
    main()
