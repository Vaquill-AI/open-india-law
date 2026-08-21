"""Generate docs/india-corpus/csv/, a spreadsheet-ready view of the same data.

Every file is written from the raw extraction dumps, so the CSVs and the
markdown report can never disagree.

Conventions chosen for Google Sheets:
  - tidy (long) format wherever a pivot table or chart is likely, one
    observation per row, so Sheets can pivot without reshaping
  - two wide matrices as well, for charting a year axis directly
  - raw integers with no thousands separators, ISO dates, empty cell for
    genuinely absent rather than 0
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_docs as B  # reuses the same loading, merging and dedup logic

OUT = B.DOCS / "csv"


def write(name: str, header: list[str], rows: list[list]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / name).open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)
    print(f"  {name}: {len(rows)} rows")


INDEX: list[list] = []


def reg(name: str, what: str, sheets_tip: str) -> None:
    INDEX.append([name, what, sheets_tip])


# --------------------------------------------------------------------------- #
# 01 summary metrics
# --------------------------------------------------------------------------- #
def summary_metrics() -> None:
    sc = B.COURTS.get("Supreme Court of India", {})
    sc_sb = B.sb_for("Supreme Court of India") or {}
    v1d = B.DATEIDX.get("legal_corpus_v1", {})
    v2d = B.DATEIDX.get("legal_corpus_v2", {})
    nocourt = sum(nc.get("points", 0) for nc in B.NO_COURT.values())
    rows = [
        ["case_law", "distinct_judgments", B.TOTAL_CASES],
        ["case_law", "judgments_before_cross_collection_dedup",
         B.TOTAL_CASES + B.TOTAL_DUPES],
        ["case_law", "embedded_chunks", B.TOTAL_CHUNKS],
        ["case_law", "courts", len(B.COURTS)],
        ["case_law", "high_courts", len(B.COURTS) - (1 if sc else 0)],
        ["case_law", "chunks_with_no_court_label", nocourt],
        ["case_law", "cases_duplicated_across_collections", B.TOTAL_DUPES],
        ["case_law", "supabase_metadata_rows", sum(c["cases"] for c in B.SB.values())],
        ["case_law", "supabase_rows_with_no_court", B.SB_AGG["unattributed"]["combined_cases"]],
        ["case_law", "practical_cutoff_year", B.corpus_cutoff_year()],
        ["case_law", "chunks_unreachable_by_date_filter",
         v1d.get("present_but_unparseable", 0) + v2d.get("present_but_unparseable", 0)],
        ["supreme_court", "judgments_in_qdrant", sc.get("cases", 0)],
        ["supreme_court", "rows_in_supabase", sc_sb.get("cases", 0)],
        ["supreme_court", "judgments_with_metadata_but_no_vectors", B.sc_metadata_gap()],
        ["supreme_court", "chunks", sc.get("chunks", 0)],
        ["legislation", "distinct_instruments", B.ACTS["acts_distinct_total"]],
        ["legislation", "provisions", B.ACTS["points_count"]],
        ["legislation", "state_buckets", len(B.ACTS["by_state_detail"])],
        ["legislation", "in_force_instruments", B.ACTS["by_act_status"]["in_force"]["acts"]],
        ["legislation", "repealed_instruments", B.ACTS["by_act_status"]["repealed"]["acts"]],
        ["legislation", "spent_instruments", B.ACTS["by_act_status"]["spent"]["acts"]],
        ["legislation", "provisions_with_no_year", B.ACTS["missing"]["year"]],
        ["totals", "embedded_chunks_all_collections", B.TOTAL_CHUNKS + B.ACTS["points_count"]],
        ["totals", "distinct_documents", B.TOTAL_CASES + B.ACTS["acts_distinct_total"]],
    ]
    write("01_summary_metrics.csv", ["area", "metric", "value"], rows)
    reg("01_summary_metrics.csv", "headline numbers, one metric per row",
        "scorecard tiles, or filter by area")


# --------------------------------------------------------------------------- #
# 10 courts
# --------------------------------------------------------------------------- #
def courts() -> None:
    rows = []
    for c, r in B.COURTS.items():
        sb = B.sb_for(c)
        dense = sorted(int(y) for y, d in r["years"].items() if d["cases"] >= 1000)
        first, last = B.span(r)
        rows.append([
            c,
            "Supreme Court" if c == "Supreme Court of India" else "High Court",
            r["cases"], r["chunks"],
            round(r["chunks"] / r["cases"], 2) if r["cases"] else "",
            first, last,
            len(r["years"]),
            dense[0] if dense else "",
            len(dense),
            "+".join(r["collections"]),
            r["duplicate_cases"],
            sb["cases"] if sb else "",
            (r["cases"] - sb["cases"]) if sb else "",
            sb["with_pdf"] if sb else "",
        ])
    write(
        "10_courts.csv",
        ["court", "court_type", "cases", "chunks", "chunks_per_case",
         "first_decision", "last_decision", "years_covered",
         "first_year_with_1000_cases", "years_with_1000_cases",
         "collections", "cases_duplicated_across_collections",
         "supabase_rows", "qdrant_minus_supabase", "supabase_rows_with_pdf"],
        rows,
    )
    reg("10_courts.csv", "one row per court with volume, span and depth",
        "bar chart of cases by court; sort by any column")


def court_year_long() -> None:
    rows = []
    for c, r in B.COURTS.items():
        sby = (B.SB_YEARS.get("courts", {}).get(c) or {}).get("years", {})
        for y in sorted(r["years"], key=int):
            d = r["years"][y]
            sbn = sby.get(y)
            rows.append([
                c,
                "Supreme Court" if c == "Supreme Court of India" else "High Court",
                int(y), d["cases"], d["chunks"],
                round(d["chunks"] / d["cases"], 2) if d["cases"] else "",
                sbn if isinstance(sbn, int) else "",
            ])
    write(
        "11_court_year_long.csv",
        ["court", "court_type", "year", "cases_pre_dedup", "chunks",
         "chunks_per_case", "supabase_rows"],
        rows,
    )
    reg("11_court_year_long.csv",
        "tidy court x year, one row per court and year. cases_pre_dedup counts a "
        "judgment held in both collections twice; see 15_collection_overlap.csv",
        "THE main file. Pivot: rows=year, cols=court, values=SUM(cases_pre_dedup)")


def court_year_matrix(field: str, name: str, label: str) -> None:
    years = sorted({int(y) for r in B.COURTS.values() for y in r["years"]})
    ordered = list(B.COURTS)
    rows = []
    for y in years:
        row = [y]
        for c in ordered:
            v = B.COURTS[c]["years"].get(str(y), {}).get(field, 0)
            row.append(v if v else "")
        row.append(sum(B.COURTS[c]["years"].get(str(y), {}).get(field, 0) for c in ordered))
        rows.append(row)
    write(name, ["year", *ordered, "total"], rows)
    reg(name, f"wide matrix, rows = year, columns = court, values = {label} "
        "(before cross-collection dedup)",
        "select the block and Insert > Chart for a stacked area over time")


# --------------------------------------------------------------------------- #
# 14 to 16 provenance and reconciliation
# --------------------------------------------------------------------------- #
def raw_labels() -> None:
    rows = []
    for tag, blob in (("legal_corpus_v1", B.V1), ("legal_corpus_v2", B.V2)):
        for raw, d in blob.get("courts", {}).items():
            if raw in B.FROM_CODEBASE:
                src = "COURT_NAME_VARIANTS in code"
            elif raw in B.INFERRED:
                src = "inferred for this report"
            elif B.canonical(raw) == B.UNRESOLVED_LABEL:
                src = "unresolvable"
            else:
                src = "already canonical"
            rows.append([
                raw, B.canonical(raw), tag, d["points"], d["cases_distinct"], src,
                "yes" if raw in B.INFERRED else "no",
            ])
    rows.sort(key=lambda r: -r[3])
    write(
        "14_court_raw_labels.csv",
        ["raw_label_in_qdrant", "resolves_to", "collection", "chunks", "cases",
         "mapping_source", "unknown_to_application"],
        rows,
    )
    reg("14_court_raw_labels.csv",
        "every raw court string and what it resolves to",
        "filter unknown_to_application = yes to see the stranded cases")


def overlap() -> None:
    rows = []
    for c, v in (B.OVERLAP or {}).get("shared_courts", {}).items():
        rows.append([
            c, v["v1_cases"], v["v2_cases"], v["case_ids_in_both"],
            v["deduped_cases"], v["naive_sum"] - v["deduped_cases"],
            "yes" if v["case_ids_in_both"] == v["v2_cases"] else "no",
        ])
    rows.sort(key=lambda r: -r[3])
    write(
        "15_collection_overlap.csv",
        ["court", "cases_in_v1", "cases_in_v2", "cases_in_both",
         "unique_after_dedup", "wasted_duplicates", "v2_fully_contained_in_v1"],
        rows,
    )
    reg("15_collection_overlap.csv",
        "exact duplication between the two case-law collections",
        "bar chart of cases_in_both to size the cleanup")


def reconciliation() -> None:
    rows = []
    for c, r in B.COURTS.items():
        sb = B.sb_for(c)
        if not sb:
            continue
        d = r["cases"] - sb["cases"]
        rows.append([
            c, r["cases"], sb["cases"], d,
            round(100 * d / sb["cases"], 4) if sb["cases"] else "",
            "qdrant ahead" if d > 0 else ("supabase ahead" if d < 0 else "exact match"),
        ])
    rows.sort(key=lambda r: r[3])
    write(
        "16_qdrant_vs_supabase.csv",
        ["court", "cases_in_qdrant", "rows_in_supabase", "delta", "delta_pct", "direction"],
        rows,
    )
    reg("16_qdrant_vs_supabase.csv",
        "searchable vectors against the metadata mirror, per court",
        "sort by delta; negative means listed but not searchable")


# --------------------------------------------------------------------------- #
# 20s legislation
# --------------------------------------------------------------------------- #
def legislation_states() -> None:
    rows = []
    for s, v in B.ACTS["by_state_detail"].items():
        yrs = [int(y) for y in v["years"]]
        st = v["act_status"]
        rows.append([
            s, B.nice_state(s),
            "Central" if s == "central" else "State or territory",
            v["acts"], v["provisions"],
            round(v["provisions"] / v["acts"], 1) if v["acts"] else "",
            st.get("in_force", 0), st.get("repealed", 0), st.get("spent", 0),
            min(yrs) if yrs else "", max(yrs) if yrs else "",
        ])
    rows.sort(key=lambda r: -r[3])
    write(
        "20_legislation_states.csv",
        ["state_key", "state", "level", "instruments", "provisions",
         "provisions_per_instrument", "in_force", "repealed", "spent",
         "earliest_year", "latest_year"],
        rows,
    )
    reg("20_legislation_states.csv", "one row per state or territory",
        "bar chart of instruments by state; exclude Central to see states only")


def legislation_state_year() -> None:
    rows = []
    for s, v in B.ACTS["by_state_detail"].items():
        for y in sorted(v["years"], key=int):
            rows.append([
                s, B.nice_state(s),
                "Central" if s == "central" else "State or territory",
                int(y), v["years"][y],
            ])
    write(
        "21_legislation_state_year_long.csv",
        ["state_key", "state", "level", "year", "provisions"],
        rows,
    )
    reg("21_legislation_state_year_long.csv",
        "tidy state x enactment year",
        "Pivot: rows=year, cols=state, values=SUM(provisions)")


def legislation_year() -> None:
    rows = []
    for y in sorted(B.ACTS["by_year"], key=int):
        r = B.ACTS["by_year"][y]
        t = r["__total__"]
        rows.append([
            int(y), t["acts"], t["provisions"],
            *[r.get(k, {}).get("acts", 0) for k in
              ("central", "state", "regulatory", "repealed", "spent")],
        ])
    write(
        "22_legislation_year.csv",
        ["year", "instruments", "provisions", "central", "state", "regulatory",
         "repealed", "spent"],
        rows,
    )
    reg("22_legislation_year.csv", "enactment year profile",
        "line chart of instruments over year")


def legislation_dimensions() -> None:
    rows = []
    for dim, key in (("legal_subject", "by_legal_subject"),
                     ("act_status", "by_act_status"),
                     ("category", "by_category")):
        for k, v in sorted(B.ACTS[key].items(), key=lambda kv: -kv[1]["acts"]):
            rows.append([dim, k, v["acts"], v["provisions"]])
    for k, v in sorted(B.ACTS["facets"]["provision_type"].items(), key=lambda kv: -kv[1]):
        rows.append(["provision_type", k, "", v])
    write(
        "23_legislation_dimensions.csv",
        ["dimension", "value", "instruments", "provisions"],
        rows,
    )
    reg("23_legislation_dimensions.csv",
        "subject, status, category and provision type breakdowns stacked together",
        "filter by dimension, then pie or bar chart")


# --------------------------------------------------------------------------- #
# 30s data quality
# --------------------------------------------------------------------------- #
def data_quality() -> None:
    v1d = B.DATEIDX.get("legal_corpus_v1", {})
    v2d = B.DATEIDX.get("legal_corpus_v2", {})
    sc = B.COURTS.get("Supreme Court of India", {})
    stranded = sum(
        d["cases_distinct"]
        for blob in (B.V1, B.V2)
        for raw, d in blob.get("courts", {}).items()
        if raw in B.INFERRED
    )
    un = B.SB_AGG["unattributed"]
    rows = [
        ["no tribunal content of any kind", "case law", "corpus", 0, "high",
         "case-law/tribunals.md"],
        ["Supreme Court decision_date stored as DD-MM-YYYY, unreadable by the datetime index",
         "case law", "chunks", sc.get("chunks", 0), "high", "case-law/data-quality.md"],
        ["Supreme Court judgments with metadata but no vectors",
         "case law", "judgments", B.sc_metadata_gap(), "high", "case-law/data-quality.md"],
        ["judgments duplicated across legal_corpus_v1 and legal_corpus_v2",
         "case law", "judgments", B.TOTAL_DUPES, "high", "case-law/data-quality.md"],
        ["chunks carrying no court label at all", "case law", "chunks",
         sum(nc.get("points", 0) for nc in B.NO_COURT.values()), "medium",
         "case-law/README.md"],
        ["cases unreachable by court filter because the label is unknown to the app",
         "case law", "judgments", stranded, "medium", "case-law/court-name-variants.md"],
        ["chunks with an empty citation field", "case law", "chunks",
         B.V1["missing"]["citation"] + B.V2["missing"]["citation"], "medium",
         "case-law/data-quality.md"],
        ["chunks with no judges recorded", "case law", "chunks",
         B.V1["missing"]["judges"] + B.V2["missing"]["judges"], "low",
         "case-law/data-quality.md"],
        ["Supabase rows with no court_normalized", "case law", "rows",
         un["combined_cases"], "medium", "case-law/data-quality.md"],
        ["Supabase citation-only stubs with no PDF and no case name", "case law", "rows",
         un["court_type_null"]["cases"] - un["court_type_null"]["with_case_name"], "medium",
         "case-law/data-quality.md"],
        ["provisions with no enactment year", "legislation", "provisions",
         B.ACTS["missing"]["year"], "medium", "legislation/data-quality.md"],
        ["provisions with an empty acts_referenced list", "legislation", "provisions",
         B.ACTS["missing"]["acts_referenced"], "low", "legislation/data-quality.md"],
        ["jurisdiction and category are duplicate fields, and neither is a jurisdiction",
         "legislation", "collection", B.ACTS["points_count"], "medium",
         "legislation/data-quality.md"],
        ["chunks reachable by a date range filter", "case law", "chunks",
         v1d.get("reachable_by_date_range", 0) + v2d.get("reachable_by_date_range", 0),
         "reference", "case-law/data-quality.md"],
    ]
    write(
        "30_data_quality.csv",
        ["issue", "area", "unit", "affected", "severity", "documented_in"],
        rows,
    )
    reg("30_data_quality.csv", "every defect found, with how much it affects",
        "sort by severity then affected")


def missing_fields() -> None:
    total = B.V1["points_count"] + B.V2["points_count"]
    rows = []
    for k in sorted(set(B.V1["missing"]) | set(B.V2["missing"])):
        a, b = B.V1["missing"].get(k), B.V2["missing"].get(k)
        if not isinstance(a, int) or not isinstance(b, int):
            continue
        rows.append([k, a, b, a + b, round(100 * (a + b) / total, 2)])
    rows.sort(key=lambda r: -r[3])
    write(
        "31_missing_fields.csv",
        ["field", "missing_in_v1", "missing_in_v2", "missing_combined", "pct_of_corpus"],
        rows,
    )
    reg("31_missing_fields.csv", "payload completeness per field",
        "bar chart of pct_of_corpus")


def distributions() -> None:
    rows = []
    for dim in ("section_type", "court_type", "disposition"):
        merged: dict[str, int] = {}
        for blob in (B.V1, B.V2):
            f = blob["facets"].get(dim) or {}
            if "__error__" in f:
                continue
            for k, v in f.items():
                merged[k] = merged.get(k, 0) + v
        for k, v in sorted(merged.items(), key=lambda kv: -kv[1]):
            rows.append([dim, k, v])
    write("32_case_law_distributions.csv", ["dimension", "value", "chunks"], rows)
    reg("32_case_law_distributions.csv",
        "section_type, court_type and disposition value counts",
        "filter by dimension; disposition has 400+ raw variants, which is itself a finding")


def supabase_unattributed() -> None:
    un = B.SB_AGG["unattributed"]
    rows = []
    for key, label in (("court_type_null", "court_type also null"),
                       ("court_type_high_court", "court_type = high_court")):
        v = un[key]
        rows.append([
            label, v["cases"], v["with_pdf"], v["with_full_text"],
            v["with_case_name"], v["with_citation"], v["min_year"], v["max_year"],
            v["first_date"], v["last_date"],
        ])
    write(
        "33_supabase_unattributed.csv",
        ["population", "rows", "with_pdf", "with_full_text", "with_case_name",
         "with_citation", "min_year", "max_year", "first_date", "last_date"],
        rows,
    )
    reg("33_supabase_unattributed.csv",
        "the Supabase rows that carry no court, split by sub-population",
        "note min_year and max_year, which prove the year was parsed from citation text")


def main() -> None:
    print(f"writing {OUT}")
    summary_metrics()
    courts()
    court_year_long()
    court_year_matrix("cases", "12_court_year_matrix_cases.csv", "distinct cases")
    court_year_matrix("chunks", "13_court_year_matrix_chunks.csv", "embedded chunks")
    raw_labels()
    overlap()
    reconciliation()
    legislation_states()
    legislation_state_year()
    legislation_year()
    legislation_dimensions()
    data_quality()
    missing_fields()
    distributions()
    supabase_unattributed()

    INDEX.sort()
    write("00_index.csv", ["file", "contents", "how to use it in sheets"], INDEX)


if __name__ == "__main__":
    main()
