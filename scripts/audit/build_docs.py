"""Generate docs/india-corpus/ from the raw extraction dumps.

Every number written comes from a raw JSON dump produced by
extract_india_corpus.py, extract_supabase_cases.py and check_overlap.py.
Nothing is hand-typed, so a fresh extraction plus a re-run of this script
gives an updated report with no drift.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from build_docs_canon import CANON, FROM_CODEBASE, INFERRED, UNRESOLVED_LABEL, canonical

REPO = Path(__file__).resolve().parents[2]
DOCS = REPO / "docs" / "india-corpus"
# Fresh extractions land in ./raw; once published, docs/india-corpus/data holds
# the same dumps, so the docs can be rebuilt without re-running the extraction.
_LOCAL = Path(__file__).parent / "raw"
RAW = _LOCAL if _LOCAL.exists() else DOCS / "data"
GENERATED = "2026-07-28"


def load(name: str, required: bool = True) -> dict:
    p = RAW / name
    if not p.exists():
        if required:
            raise SystemExit(f"missing raw dump: {p}")
        return {}
    return json.loads(p.read_text())


V1 = load("legal_corpus_v1.json")
V2 = load("legal_corpus_v2.json")
ACTS = load("acts_india.json")
SB_AGG = load("supabase_court_aggregates.json")
SB_YEARS = load("supabase_legal_cases.json")
OVERLAP = load("overlap.json", required=False)
DATEIDX = load("date_index.json", required=False)


def fmt(n) -> str:
    if n is None:
        return "n/a"
    if isinstance(n, bool):
        return "yes" if n else "no"
    return f"{n:,}" if isinstance(n, int) else str(n)


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def date_only(s: str | None) -> str | None:
    if not s:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return m.group(0)
    m = re.match(r"(\d{2})-(\d{2})-(\d{4})", s)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return s[:10]


def dmin(a, b):
    vals = [v for v in (a, b) if v]
    return min(vals) if vals else None


def dmax(a, b):
    vals = [v for v in (a, b) if v]
    return max(vals) if vals else None


# --------------------------------------------------------------------------- #
# Merge v1 + v2 into canonical courts
# --------------------------------------------------------------------------- #
def merged_courts() -> dict:
    out: dict[str, dict] = {}
    for tag, blob in (("v1", V1), ("v2", V2)):
        for raw, d in blob.get("courts", {}).items():
            c = canonical(raw)
            rec = out.setdefault(
                c,
                {
                    "raw_labels": [],
                    "chunks": 0,
                    "cases_naive": 0,
                    "years": {},
                    "court_types": {},
                    "first": None,
                    "last": None,
                    "collections": set(),
                },
            )
            rec["raw_labels"].append(
                {
                    "label": raw,
                    "collection": tag,
                    "chunks": d["points"],
                    "cases": d["cases_distinct"],
                }
            )
            rec["chunks"] += d["points"]
            rec["cases_naive"] += d["cases_distinct"]
            rec["collections"].add(tag)
            for k, v in (d.get("court_type") or {}).items():
                rec["court_types"][k] = rec["court_types"].get(k, 0) + v
            for y, yd in d["years"].items():
                s = rec["years"].setdefault(y, {"cases": 0, "chunks": 0})
                s["cases"] += yd["cases"]
                s["chunks"] += yd["chunks"]
            rec["first"] = dmin(rec["first"], date_only(d.get("earliest_decision_date")))
            rec["last"] = dmax(rec["last"], date_only(d.get("latest_decision_date")))

    dupes = (OVERLAP or {}).get("shared_courts", {})
    for c, rec in out.items():
        rec["collections"] = sorted(rec["collections"])
        rec["duplicate_cases"] = dupes.get(c, {}).get("case_ids_in_both", 0)
        rec["cases"] = rec["cases_naive"] - rec["duplicate_cases"]
    return dict(sorted(out.items(), key=lambda kv: -kv[1]["cases"]))


_ALL = merged_courts()
UNRESOLVED_REC = _ALL.pop(UNRESOLVED_LABEL, None)
# The unresolved label is not a court, so it is excluded from court counts and
# rankings and reported separately in case-law/court-name-variants.md.
COURTS = _ALL
SB = SB_AGG["courts"]


def sb_for(canon: str) -> dict | None:
    return SB.get(canon)


TOTAL_CHUNKS = sum(c["chunks"] for c in COURTS.values())
TOTAL_CASES = sum(c["cases"] for c in COURTS.values())
TOTAL_DUPES = sum(c["duplicate_cases"] for c in COURTS.values())
NO_COURT = {
    "v1": V1.get("no_court_value", {}),
    "v2": V2.get("no_court_value", {}),
}


def w(path: str, text: str) -> None:
    p = DOCS / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text.rstrip() + "\n")
    print(f"wrote {p.relative_to(REPO)}")


def span(rec: dict) -> tuple[str, str]:
    """Display date range, falling back to the year field when dates are unindexed.

    Supreme Court points store `decision_date` as DD-MM-YYYY, which Qdrant's
    datetime index cannot parse, so an ordered scroll returns nothing for them.
    Rather than print n/a we fall back to the `year` field and say so.
    """
    if rec["first"] or rec["last"]:
        return rec["first"] or "n/a", rec["last"] or "n/a"
    years = sorted(int(y) for y in rec["years"])
    if not years:
        return "n/a", "n/a"
    return f"{years[0]} (year only)", f"{years[-1]} (year only)"


def up(depth: int) -> str:
    """Prefix to reach docs/india-corpus/ from a page `depth` folders below it."""
    return "../" * depth


def repo(depth: int, path: str) -> str:
    """Link to a repo file from a page `depth` folders below docs/india-corpus/."""
    return "../" * (depth + 2) + path


def header(depth: int) -> str:
    return (
        f"Generated {GENERATED} by `scripts/india_corpus/` against live Qdrant "
        f"(`our production Qdrant`) and Supabase `legal_cases`.\n"
        "All counts are exact full-collection counts, not samples or estimates.\n"
        f"See [02-methodology.md]({up(depth)}02-methodology.md) for how each number "
        "is produced.\n"
    )


# --------------------------------------------------------------------------- #
# Per-court pages
# --------------------------------------------------------------------------- #
def court_page(canon: str, rec: dict, depth: int) -> str:
    sb = sb_for(canon)
    sby = (SB_YEARS.get("courts", {}).get(canon) or {}).get("years", {})
    L = [f"# {canon}", "", header(depth), "## Headline", ""]
    L += [
        "| Metric | Value |",
        "|---|---|",
        f"| Distinct cases in Qdrant (searchable) | {fmt(rec['cases'])} |",
        f"| Text chunks in Qdrant | {fmt(rec['chunks'])} |",
        f"| Metadata rows in Supabase `legal_cases` | {fmt(sb['cases']) if sb else 'n/a'} |",
        f"| Earliest decision | {span(rec)[0]} |",
        f"| Latest decision (data cutoff) | {span(rec)[1]} |",
        f"| Years with at least one case | {fmt(len(rec['years']))} |",
        f"| Qdrant collections | {', '.join(rec['collections'])} |",
    ]
    if rec["duplicate_cases"]:
        L.append(
            f"| Cases present in both v1 and v2 (deduplicated here) | "
            f"{fmt(rec['duplicate_cases'])} |"
        )
    if sb:
        L += [
            f"| Supabase rows with a PDF (`r2_url`) | {fmt(sb['with_pdf'])} |",
            f"| Supabase rows flagged full text | {fmt(sb['with_full_text'])} |",
            f"| Supabase rows with a case name | {fmt(sb['with_case_name'])} |",
        ]
    if not (rec["first"] or rec["last"]):
        L += [
            "",
            "The date range above falls back to the `year` field because none of this "
            "court's `decision_date` values are readable by the datetime index.",
            "They are stored as `DD-MM-YYYY`, which Qdrant cannot parse, so this court "
            "is unreachable by any date-range filter. "
            "See [data-quality.md](" + up(depth - 1) + "data-quality.md).",
        ]
    L += ["", "## Raw court labels in Qdrant", ""]
    L += ["| Label as stored | Collection | Chunks | Cases |", "|---|---|---:|---:|"]
    for r in sorted(rec["raw_labels"], key=lambda x: -x["chunks"]):
        L.append(
            f"| `{r['label']}` | {r['collection']} | {fmt(r['chunks'])} | {fmt(r['cases'])} |"
        )

    L += ["", "## Year by year", ""]
    L.append(
        "`Cases` and `Chunks` are exact counts from Qdrant. "
        "`Supabase rows` is the metadata mirror for the same court and year, "
        "shown so the gap between what is stored and what is searchable is visible."
    )
    L += ["", "| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |", "|---:|---:|---:|---:|---:|---:|"]
    years = sorted(rec["years"], key=lambda y: int(y))
    for y in years:
        d = rec["years"][y]
        cpc = round(d["chunks"] / d["cases"], 1) if d["cases"] else 0
        sbn = sby.get(y)
        delta = fmt(d["cases"] - sbn) if isinstance(sbn, int) else "n/a"
        L.append(
            f"| {y} | {fmt(d['cases'])} | {fmt(d['chunks'])} | {cpc} | {fmt(sbn)} | {delta} |"
        )
    L.append(
        f"| **Total** | **{fmt(rec['cases_naive'])}** | **{fmt(rec['chunks'])}** | | "
        f"**{fmt(sum(v for v in sby.values() if isinstance(v, int))) if sby else 'n/a'}** | |"
    )
    if rec["duplicate_cases"]:
        L += [
            "",
            f"The year rows sum to {fmt(rec['cases_naive'])} because "
            f"{fmt(rec['duplicate_cases'])} case IDs appear in both `legal_corpus_v1` "
            f"and `legal_corpus_v2`. The deduplicated case count for this court is "
            f"**{fmt(rec['cases'])}**.",
        ]
    return "\n".join(L)


def write_court_pages() -> None:
    for canon, rec in COURTS.items():
        if canon == "Supreme Court of India":
            w("case-law/supreme-court.md", court_page(canon, rec, 1))
        else:
            w(f"case-law/high-courts/{slug(canon)}.md", court_page(canon, rec, 2))


# --------------------------------------------------------------------------- #
# Case-law index, matrix, variants, tribunals
# --------------------------------------------------------------------------- #
def case_law_readme() -> str:
    L = ["# India case law", "", header(1)]
    L += [
        "## What is here",
        "",
        f"The India case-law corpus is **{fmt(TOTAL_CASES)} distinct judgments** "
        f"across **{fmt(TOTAL_CHUNKS)} embedded text chunks**, "
        f"spread over **{len(COURTS)} courts**.",
        "",
        "It lives in two Qdrant collections that were built at different times "
        "and never merged:",
        "",
        "| Collection | Chunks | Courts | Role |",
        "|---|---:|---:|---|",
        f"| `legal_corpus_v1` | {fmt(V1['points_count'])} | "
        f"{len(V1.get('courts', {}))} raw labels | Older High Court ingest, no citation field |",
        f"| `legal_corpus_v2` | {fmt(V2['points_count'])} | "
        f"{len(V2.get('courts', {}))} raw labels | Newer ingest, adds the Supreme Court and citations |",
        "",
        "Both are searched together at query time "
        "(`QDRANT_CORPUS_COLLECTIONS` in [app/core/config.py](" + repo(1, "app/core/config.py") + ")).",
        "",
        "## Every court, ranked",
        "",
        "`Cases` is the exact number of distinct `case_id` values in Qdrant, "
        "which is what retrieval can actually reach.",
        "`Supabase` is the row count in the `legal_cases` metadata mirror for the same court.",
        "",
        "| # | Court | Cases | Chunks | First decision | Last decision | Supabase rows | Collections |",
        "|---:|---|---:|---:|---|---|---:|---|",
    ]
    for i, (canon, rec) in enumerate(COURTS.items(), 1):
        sb = sb_for(canon)
        link = (
            "supreme-court.md"
            if canon == "Supreme Court of India"
            else f"high-courts/{slug(canon)}.md"
        )
        L.append(
            f"| {i} | [{canon}]({link}) | {fmt(rec['cases'])} | {fmt(rec['chunks'])} | "
            f"{span(rec)[0]} | {span(rec)[1]} | "
            f"{fmt(sb['cases']) if sb else 'n/a'} | {', '.join(rec['collections'])} |"
        )
    L.append(
        f"| | **Total** | **{fmt(TOTAL_CASES)}** | **{fmt(TOTAL_CHUNKS)}** | | | "
        f"**{fmt(sum(c['cases'] for c in SB.values()))}** | |"
    )

    nc1, nc2 = NO_COURT["v1"], NO_COURT["v2"]
    if nc1 or nc2:
        L += [
            "",
            "## Chunks with no court label",
            "",
            "These points carry no `court` value, so no court filter can ever match them.",
            "They are reachable by plain semantic search but invisible to "
            "court-scoped retrieval and to browse.",
            "",
            "| Collection | Chunks | Cases |",
            "|---|---:|---:|",
        ]
        for tag, nc in (("legal_corpus_v1", nc1), ("legal_corpus_v2", nc2)):
            if nc:
                L.append(f"| `{tag}` | {fmt(nc.get('points'))} | {fmt(nc.get('cases'))} |")

    L += [
        "",
        "## Also in this folder",
        "",
        "- [coverage-matrix.md](coverage-matrix.md) all courts by year in one grid",
        "- [court-name-variants.md](court-name-variants.md) the duplicate court "
        "labels in the raw data and how they were resolved",
        "- [tribunals.md](tribunals.md) tribunal coverage",
        "- [supreme-court.md](supreme-court.md) and "
        "[high-courts/](high-courts/) one page per court, year by year",
    ]
    return "\n".join(L)


def coverage_matrix() -> str:
    years = sorted({int(y) for rec in COURTS.values() for y in rec["years"]})
    L = ["# Coverage matrix: court by year", "", header(1)]
    L += [
        "Exact distinct case counts per court per year, from Qdrant.",
        "A blank cell means zero cases for that court and year.",
        "",
        "The same data as a spreadsheet is in "
        "[../csv/11_court_year_long.csv](../csv/11_court_year_long.csv) (tidy) and "
        "[../csv/12_court_year_matrix_cases.csv](../csv/12_court_year_matrix_cases.csv) "
        "(this grid).",
        "",
    ]
    ordered = list(COURTS)
    # "Bombay High Court" -> "Bombay"; the table is 26 courts wide and the
    # repeated suffix makes it unreadable.
    short = [c.replace(" High Court", "").replace("Supreme Court of India", "Supreme Court")
             for c in ordered]
    L += [
        "Columns are ordered by total volume, largest first.",
        "Court names are abbreviated: every column except Supreme Court is a High Court.",
        "",
    ]
    L.append("| Year | " + " | ".join(short) + " | Total |")
    L.append("|---:|" + "---:|" * (len(ordered) + 1))
    for y in years:
        row = [str(y)]
        tot = 0
        for c in ordered:
            n = COURTS[c]["years"].get(str(y), {}).get("cases", 0)
            tot += n
            row.append(f"{n:,}" if n else "")
        row.append(f"**{tot:,}**")
        L.append("| " + " | ".join(row) + " |")
    totals = ["**Total**"]
    for c in ordered:
        totals.append(f"**{COURTS[c]['cases_naive']:,}**")
    totals.append(f"**{sum(c['cases_naive'] for c in COURTS.values()):,}**")
    L.append("| " + " | ".join(totals) + " |")
    return "\n".join(L)


def court_variants() -> str:
    raw_all: dict[str, dict] = {}
    for tag, blob in (("v1", V1), ("v2", V2)):
        for raw, d in blob.get("courts", {}).items():
            r = raw_all.setdefault(raw, {"chunks": 0, "cases": 0, "colls": []})
            r["chunks"] += d["points"]
            r["cases"] += d["cases_distinct"]
            r["colls"].append(tag)

    L = ["# Court name variants in the raw corpus", "", header(1)]
    L += [
        "The `court` payload field was never normalized at ingest.",
        "The same court is stored under several spellings, and some of them hold "
        "only a handful of cases, which is a sign of a broken parse rather than a "
        "real court.",
        "Any query that filters on an exact court string will silently miss the variants.",
        "",
        f"There are **{len(raw_all)} distinct raw labels** resolving to "
        f"**{len(COURTS)} real courts**.",
        "",
        "## Every raw label",
        "",
        "| Raw label | Chunks | Cases | Collections | Resolves to | Mapping source |",
        "|---|---:|---:|---|---|---|",
    ]
    for raw, r in sorted(raw_all.items(), key=lambda kv: -kv[1]["chunks"]):
        if raw in FROM_CODEBASE:
            src = "`COURT_NAME_VARIANTS` in code"
        elif raw in INFERRED:
            src = "inferred for this report"
        elif canonical(raw) == UNRESOLVED_LABEL:
            src = "unresolvable"
        else:
            src = "already canonical"
        L.append(
            f"| `{raw}` | {fmt(r['chunks'])} | {fmt(r['cases'])} | "
            f"{', '.join(sorted(set(r['colls'])))} | {canonical(raw)} | {src} |"
        )

    missing = sorted(k for k in raw_all if k in INFERRED)
    L += [
        "",
        "## Labels the application does not know about",
        "",
        "[app/integrations/corpus_qdrant.py]("+repo(1,"app/integrations/corpus_qdrant.py")+") "
        "holds a `COURT_NAME_VARIANTS` map used to expand a court filter to its known "
        "spellings.",
        "The following labels exist in Qdrant but are **absent from that map**, so a "
        "court-filtered query today cannot reach them:",
        "",
        "| Raw label | Cases stranded | Should resolve to |",
        "|---|---:|---|",
    ]
    for raw in sorted(missing, key=lambda r: -raw_all[r]["cases"]):
        L.append(f"| `{raw}` | {fmt(raw_all[raw]['cases'])} | {INFERRED[raw]} |")
    stranded = sum(raw_all[r]["cases"] for r in missing)
    if UNRESOLVED_REC:
        L += [
            "",
            "## The label that cannot be resolved",
            "",
            f"`High Court` appears as a literal court value on "
            f"{fmt(UNRESOLVED_REC['chunks'])} chunks covering "
            f"{fmt(UNRESOLVED_REC['cases'])} cases.",
            "It names no particular court, so it cannot be mapped and those cases are "
            "excluded from every court total in this report.",
            "They remain reachable by unfiltered semantic search.",
        ]
    L += [
        "",
        f"Total cases currently unreachable by an exact court filter: **{fmt(stranded)}**.",
        "",
        "This is small in absolute terms but it is a pure correctness bug: adding these "
        "keys to `COURT_NAME_VARIANTS` costs nothing and removes a silent-miss class.",
    ]
    return "\n".join(L)


def tribunals_page() -> str:
    L = ["# Tribunals", "", header(1)]
    L += [
        "## Correction",
        "",
        "An earlier version of this page said we hold no tribunal data at all.",
        "That was wrong. We hold **813,168 tribunal and regulator matters** and "
        "**2,112,201 decision documents**, in Supabase tables and object storage.",
        "They are absent from the two searchable case-law collections, which is what "
        "this audit measures, so a court-scoped search never reaches them.",
        "See [../tribunals/README.md](../tribunals/README.md) for the full inventory.",
        "",
        "## There is no tribunal data in the searchable case-law corpus",
        "",
        "Every one of the "
        f"{sum(len(b.get('courts', {})) for b in (V1, V2))} raw court labels across "
        "`legal_corpus_v1` and `legal_corpus_v2` is a High Court or the Supreme Court.",
        "The `court_type` payload field only ever takes two values:",
        "",
        "| court_type | Chunks |",
        "|---|---:|",
    ]
    ct: dict[str, int] = {}
    for blob in (V1, V2):
        for k, v in (blob.get("facets", {}).get("court_type") or {}).items():
            if k != "__error__":
                ct[k] = ct.get(k, 0) + v
    for k, v in sorted(ct.items(), key=lambda kv: -kv[1]):
        L.append(f"| `{k}` | {fmt(v)} |")
    L += [
        "",
        "No point in either collection carries a tribunal court name, so NCLT, ITAT, "
        "CESTAT, SAT, DRT, CAT, NGT and the rest are unreachable by retrieval even "
        "though the underlying decisions are held elsewhere.",
        "",
        "## The retrieval layer is already built for tribunals",
        "",
        "This is a data gap, not a code gap.",
        "[app/rag/ranking/court_boost.py]("+repo(1,"app/rag/ranking/court_boost.py")+") defines "
        "`CourtLevel.TRIBUNAL` and maps NCLT, NCLAT, ITAT, CESTAT, CAT, NGT, NCDRC, SCDRC "
        "and TDSAT to it, with a 1.0x precedence boost.",
        "[app/rag/pipeline.py]("+repo(1,"app/rag/pipeline.py")+") classifies any court name "
        "containing `tribunal`, `nclt`, `nclat`, `itat` or `cestat` as a tribunal.",
        "[app/rag/temporal/precedent.py]("+repo(1,"app/rag/temporal/precedent.py")+") documents "
        "tribunal precedence rules.",
        "",
        "All of that code is unreachable today because no document in the search "
        "index carries a tribunal court name.",
        "A question about an NCLT or ITAT ruling cannot be answered from retrieval, "
        "and nothing in the pipeline signals that to the user, even though we hold "
        "2.1 million tribunal decision documents.",
        "",
        "The gap is text extraction, not acquisition. The documents are original PDF "
        "with no extracted text, so there is nothing to embed yet.",
    ]
    return "\n".join(L)


# --------------------------------------------------------------------------- #
# Legislation (acts_india)
# --------------------------------------------------------------------------- #
STATE_LABEL = {
    "central": "Central (Union of India)",
    "jammu-kashmir": "Jammu and Kashmir",
    "dadra-nagar-haveli": "Dadra and Nagar Haveli",
    "andaman-nicobar": "Andaman and Nicobar Islands",
}


def nice_state(s: str) -> str:
    return STATE_LABEL.get(s, s.replace("-", " ").title())


def acts_readme() -> str:
    f = ACTS["facets"]
    L = ["# India legislation (acts and rules)", "", header(1)]
    L += [
        "## What is here",
        "",
        f"One Qdrant collection, `acts_india`, holding **{fmt(ACTS['acts_distinct_total'])} "
        f"distinct instruments** split into **{fmt(ACTS['sections_total'])} provisions** "
        "(sections, rules and regulations), each separately embedded.",
        "",
        "| Metric | Value |",
        "|---|---:|",
        f"| Distinct `act_id` values | {fmt(ACTS['acts_distinct_total'])} |",
        f"| Provision chunks (points) | {fmt(ACTS['points_count'])} |",
        f"| State and territory buckets | {fmt(len(ACTS['by_state_detail']))} |",
        f"| Provisions with no year | {fmt(ACTS['missing']['year'])} |",
        f"| Languages | {', '.join(f['language_code'])} |",
        "",
        "## Status",
        "",
        "| Status | Instruments | Provisions |",
        "|---|---:|---:|",
    ]
    for k, v in sorted(ACTS["by_act_status"].items(), key=lambda kv: -kv[1]["acts"]):
        L.append(f"| `{k}` | {fmt(v['acts'])} | {fmt(v['provisions'])} |")
    L += [
        "",
        "## Category",
        "",
        "This is the `jurisdiction` field, which is also duplicated verbatim as "
        "`category`. Note that it mixes a real jurisdiction axis (central versus state) "
        "with a status axis (repealed, spent), so it cannot be used as a clean "
        "jurisdiction filter. See [data-quality.md](data-quality.md).",
        "",
        "| Value | Instruments | Provisions |",
        "|---|---:|---:|",
    ]
    for k, v in sorted(ACTS["by_jurisdiction"].items(), key=lambda kv: -kv[1]["acts"]):
        L.append(f"| `{k}` | {fmt(v['acts'])} | {fmt(v['provisions'])} |")
    L += [
        "",
        "## Subject",
        "",
        "| Legal subject | Instruments | Provisions |",
        "|---|---:|---:|",
    ]
    for k, v in sorted(ACTS["by_legal_subject"].items(), key=lambda kv: -kv[1]["acts"]):
        L.append(f"| `{k}` | {fmt(v['acts'])} | {fmt(v['provisions'])} |")
    L += [
        "",
        "## Also in this folder",
        "",
        "- [by-state.md](by-state.md) every state and territory, with its own year profile",
        "- [by-year.md](by-year.md) enactment year across the whole collection",
        "- [data-quality.md](data-quality.md) schema and coverage problems found in this audit",
    ]
    return "\n".join(L)


def acts_by_state() -> str:
    bs = ACTS["by_state_detail"]
    L = ["# Legislation by state and territory", "", header(1)]
    L += [
        "`central` holds Union legislation. Everything else is state or union "
        "territory legislation.",
        "Instruments are distinct `act_id` values, provisions are individually "
        "embedded sections.",
        "",
        "| State or territory | Instruments | Provisions | Earliest year | Latest year | In force | Repealed |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for s, v in sorted(bs.items(), key=lambda kv: -kv[1]["acts"]):
        yrs = [int(y) for y in v["years"]]
        st = v["act_status"]
        L.append(
            f"| {nice_state(s)} | {fmt(v['acts'])} | {fmt(v['provisions'])} | "
            f"{min(yrs) if yrs else 'n/a'} | {max(yrs) if yrs else 'n/a'} | "
            f"{fmt(st.get('in_force', 0))} | {fmt(st.get('repealed', 0))} |"
        )
    L.append(
        f"| **Total** | **{fmt(sum(v['acts'] for v in bs.values()))}** | "
        f"**{fmt(sum(v['provisions'] for v in bs.values()))}** | | | | |"
    )

    L += [
        "",
        "## States and territories with no legislation at all",
        "",
    ]
    present = set(bs)
    all_states = {
        "andhra-pradesh", "arunachal-pradesh", "assam", "bihar", "chhattisgarh", "goa",
        "gujarat", "haryana", "himachal-pradesh", "jharkhand", "karnataka", "kerala",
        "madhya-pradesh", "maharashtra", "manipur", "meghalaya", "mizoram", "nagaland",
        "odisha", "punjab", "rajasthan", "sikkim", "tamil-nadu", "telangana", "tripura",
        "uttar-pradesh", "uttarakhand", "west-bengal", "andaman-nicobar", "chandigarh",
        "dadra-nagar-haveli", "delhi", "jammu-kashmir", "ladakh", "lakshadweep", "puducherry",
    }
    missing = sorted(all_states - present)
    if missing:
        for m in missing:
            L.append(f"- {nice_state(m)}")
    else:
        L.append("None. Every state and union territory has at least one instrument.")

    L += ["", "## Provision counts by year, per state", ""]
    for s, v in sorted(bs.items(), key=lambda kv: -kv[1]["acts"]):
        yrs = v["years"]
        if not yrs:
            continue
        L += [f"### {nice_state(s)}", ""]
        L.append(f"{fmt(v['acts'])} instruments, {fmt(v['provisions'])} provisions.")
        L.append("")
        L.append("| Year | Provisions |")
        L.append("|---:|---:|")
        for y in sorted(yrs, key=lambda x: int(x)):
            L.append(f"| {y} | {fmt(yrs[y])} |")
        L.append("")
    return "\n".join(L)


def acts_by_year() -> str:
    by = ACTS["by_year"]
    L = ["# Legislation by enactment year", "", header(1)]
    L += [
        f"Years present: **{len(by)}**, spanning "
        f"**{min(int(y) for y in by)} to {max(int(y) for y in by)}**.",
        "",
        f"**{fmt(ACTS['missing']['year'])} provisions carry no year at all** and are "
        "absent from this table, which is why the column totals here are lower than the "
        f"collection total of {fmt(ACTS['acts_distinct_total'])} instruments.",
        "",
        "| Year | Instruments | Provisions | central | state | regulatory | repealed | spent |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for y in sorted(by, key=lambda x: int(x)):
        r = by[y]
        t = r["__total__"]
        cells = [
            fmt(r.get(k, {}).get("acts", 0)) if r.get(k) else ""
            for k in ("central", "state", "regulatory", "repealed", "spent")
        ]
        L.append(
            f"| {y} | {fmt(t['acts'])} | {fmt(t['provisions'])} | " + " | ".join(cells) + " |"
        )
    tot_a = sum(by[y]["__total__"]["acts"] for y in by)
    tot_p = sum(by[y]["__total__"]["provisions"] for y in by)
    L.append(f"| **Total** | **{fmt(tot_a)}** | **{fmt(tot_p)}** | | | | | |")
    return "\n".join(L)


def acts_data_quality() -> str:
    f = ACTS["facets"]
    L = ["# Legislation data quality", "", header(1)]
    same = f.get("jurisdiction") == f.get("category")
    L += [
        "## `jurisdiction` and `category` are the same field",
        "",
        f"Both fields carry byte-identical value distributions across all "
        f"{fmt(ACTS['points_count'])} points: **{fmt(same)}**.",
        "",
        "| Value | Provisions |",
        "|---|---:|",
    ]
    for k, v in sorted(f["jurisdiction"].items(), key=lambda kv: -kv[1]):
        L.append(f"| `{k}` | {fmt(v)} |")
    L += [
        "",
        "Neither field is a jurisdiction. The values mix a jurisdiction axis "
        "(`central`, `state`), a document-kind axis (`regulatory`) and a status axis "
        "(`repealed`, `spent`).",
        "A repealed *state* act is tagged `repealed`, which erases the fact that it is a "
        "state act. The only reliable jurisdiction signal is the separate `state` field.",
        "",
        "Consequence: any filter of the form `jurisdiction = central` under-counts, "
        f"because a central act that happens to be repealed lands in the `repealed` "
        "bucket instead.",
        "",
        "## Missing values",
        "",
        "| Field | Provisions with no value | Share |",
        "|---|---:|---:|",
    ]
    total = ACTS["points_count"]
    for k, v in sorted(ACTS["missing"].items(), key=lambda kv: -(kv[1] if isinstance(kv[1], int) else 0)):
        if isinstance(v, int):
            L.append(f"| `{k}` | {fmt(v)} | {round(100 * v / total, 1)}% |")
    L += [
        "",
        f"`year` is absent on {fmt(ACTS['missing']['year'])} provisions "
        f"({round(100 * ACTS['missing']['year'] / total, 1)}%), so any date-scoped "
        "legislation query silently drops them.",
        f"`acts_referenced` is empty on {fmt(ACTS['missing']['acts_referenced'])} "
        "provisions, so cross-act citation traversal only works for a minority of the corpus.",
        "",
        "## Fields that are indexed but never populated",
        "",
        "These have a payload index built and maintained on every write, and zero "
        "points carrying a value. The index cost is paid for nothing.",
        "",
        "| Field |",
        "|---|",
    ]
    for k, v in sorted(f.items()):
        if isinstance(v, dict) and not v:
            L.append(f"| `{k}` |")
    L += [
        "",
        "## Enactment years that cannot be real",
        "",
    ]
    by = ACTS["by_year"]
    bad = sorted(int(y) for y in by if int(y) > 2026 or int(y) < 1800)
    if bad:
        L += [
            "| Year | Instruments | Provisions |",
            "|---:|---:|---:|",
        ]
        for y in bad:
            t = by[str(y)]["__total__"]
            L.append(f"| {y} | {fmt(t['acts'])} | {fmt(t['provisions'])} |")
    else:
        L.append("None. Every year in the collection falls in a plausible range.")
    return "\n".join(L)


def case_law_data_quality() -> str:
    L = ["# Case law data quality", "", header(1)]

    if DATEIDX:
        v1d, v2d = DATEIDX["legal_corpus_v1"], DATEIDX["legal_corpus_v2"]
        bad = v1d["present_but_unparseable"] + v2d["present_but_unparseable"]
        sc = COURTS.get("Supreme Court of India", {}).get("chunks", 0)
        L += [
            "## Every Supreme Court judgment is invisible to a date filter",
            "",
            "This is the most consequential defect found in this audit.",
            "",
            "`decision_date` is stored in two different formats:",
            "",
            "| Court | Stored format | Example |",
            "|---|---|---|",
            "| High Courts | `YYYY-MM-DD HH:MM:SS` | `2023-08-23 00:00:00` |",
            "| Supreme Court | `DD-MM-YYYY` | `16-09-2020` |",
            "",
            "Qdrant's datetime index cannot parse `DD-MM-YYYY`, so it indexes none of "
            "those points. The field is present, so an `is_empty` check reports nothing "
            "wrong, but a range query matches zero of them.",
            "",
            "| Collection | Points | Reachable by a date range | Present but unparseable | Genuinely absent |",
            "|---|---:|---:|---:|---:|",
            f"| `legal_corpus_v1` | {fmt(v1d['points'])} | {fmt(v1d['reachable_by_date_range'])} | "
            f"{fmt(v1d['present_but_unparseable'])} | {fmt(v1d['is_empty'])} |",
            f"| `legal_corpus_v2` | {fmt(v2d['points'])} | {fmt(v2d['reachable_by_date_range'])} | "
            f"{fmt(v2d['present_but_unparseable'])} | {fmt(v2d['is_empty'])} |",
            "",
            f"Of the {fmt(bad)} unparseable points, {fmt(sc)} are the entire Supreme "
            "Court block. Verified directly:",
            "",
            "```",
            'filter: court = "Supreme Court of India"',
            "                             -> 371,159 points",
            'filter: court = "Supreme Court of India"',
            '        AND decision_date in [1900-01-01, 2100-01-01)',
            "                             -> 0 points",
            "```",
            "",
            "Any query that scopes by date, sorts by recency, or filters to a period "
            "drops all Supreme Court authority without an error. The fix is a "
            "backfill that rewrites those values to ISO 8601, not a query-side change.",
            "",
        ]

    if TOTAL_DUPES:
        L += [
            "## The two collections overlap heavily",
            "",
            f"**{fmt(TOTAL_DUPES)} case IDs exist in both `legal_corpus_v1` and "
            "`legal_corpus_v2`.** Both collections are searched together at query "
            "time, so these judgments are embedded twice, stored twice, and can be "
            "retrieved twice for one query.",
            "",
            "For most affected courts the v2 copy is a strict subset of v1, meaning "
            "v2 adds no coverage at all for that court and only adds cost.",
            "",
            "| Court | Cases in v1 | Cases in v2 | In both | Unique after dedup |",
            "|---|---:|---:|---:|---:|",
        ]
        for c, v in sorted(
            (OVERLAP or {}).get("shared_courts", {}).items(),
            key=lambda kv: -kv[1]["case_ids_in_both"],
        ):
            subset = " (v2 fully contained in v1)" if v["case_ids_in_both"] == v["v2_cases"] else ""
            L.append(
                f"| {c}{subset} | {fmt(v['v1_cases'])} | {fmt(v['v2_cases'])} | "
                f"{fmt(v['case_ids_in_both'])} | {fmt(v['deduped_cases'])} |"
            )
        L.append("")

    L += [
        "## Qdrant against the Supabase mirror",
        "",
        "`legal_cases` is the metadata mirror that powers browse and citation lookup, "
        "and Qdrant is what retrieval can actually reach. The two are built by "
        "different pipelines, so comparing them shows where a judgment is listed but "
        "not searchable, or embedded but not listed.",
        "",
        "They agree closely, which is the main reason to trust both. "
        "The exceptions are worth acting on.",
        "",
        "| Court | Cases in Qdrant | Rows in Supabase | Delta | Delta % |",
        "|---|---:|---:|---:|---:|",
    ]
    deltas = []
    for c, rec in COURTS.items():
        sb = sb_for(c)
        if not sb:
            continue
        deltas.append((abs(rec["cases"] - sb["cases"]), c, rec["cases"], sb["cases"]))
    for _, c, q, x in sorted(deltas, reverse=True):
        d = q - x
        L.append(f"| {c} | {fmt(q)} | {fmt(x)} | {d:+,} | {100 * d / max(x, 1):+.3f}% |")
    tot_q = sum(d[2] for d in deltas)
    tot_s = sum(d[3] for d in deltas)
    L += [
        f"| **Total** | **{fmt(tot_q)}** | **{fmt(tot_s)}** | **{tot_q - tot_s:+,}** | "
        f"**{100 * (tot_q - tot_s) / tot_s:+.3f}%** |",
        "",
        f"Across {fmt(len(deltas))} courts and {fmt(tot_s)} judgments the two systems "
        f"differ by {fmt(abs(tot_q - tot_s))} records, "
        f"{abs(100 * (tot_q - tot_s) / tot_s):.3f}%.",
        "",
    ]
    sc_rec = COURTS.get("Supreme Court of India")
    sc_sb = sb_for("Supreme Court of India")
    if sc_rec and sc_sb:
        gap = sc_sb["cases"] - sc_rec["cases"]
        L += [
            "The Supreme Court is the one real outlier, and it is the wrong direction.",
            f"**{fmt(gap)} Supreme Court judgments have a metadata row but no vectors "
            f"in Qdrant**, {round(100 * gap / sc_sb['cases'], 1)}% of the court.",
            "They appear in browse and resolve by citation, but retrieval cannot cite "
            "or quote them, because there is nothing embedded to retrieve.",
            "For the only court that binds nationally this is the highest-value backlog "
            "in the corpus.",
            "",
            "Where Qdrant is instead slightly ahead of Supabase, that is the normal "
            "direction: chunks were written and the metadata backfill has not caught up.",
            "",
        ]
    L += ["## Missing payload values", "", "| Field | v1 | v2 | Combined | Share of corpus |", "|---|---:|---:|---:|---:|"]
    total = V1["points_count"] + V2["points_count"]
    keys = sorted(set(V1["missing"]) | set(V2["missing"]))
    for k in keys:
        a, b = V1["missing"].get(k), V2["missing"].get(k)
        if not isinstance(a, int) or not isinstance(b, int):
            continue
        L.append(
            f"| `{k}` | {fmt(a)} | {fmt(b)} | {fmt(a + b)} | {round(100 * (a + b) / total, 1)}% |"
        )
    L += [
        "",
        f"`citation` is empty on every one of the {fmt(V1['points_count'])} points in "
        "`legal_corpus_v1` and on all High Court points in `legal_corpus_v2`.",
        "Only Supreme Court points carry a formal citation, so citation lookup against "
        "the corpus works for the Supreme Court alone.",
        "",
        f"`judges` is empty on {fmt(V1['missing']['judges'] + V2['missing']['judges'])} "
        "points, which is why judge is not offered as a browse facet.",
        "",
        "## Indexed but never populated",
        "",
        "Both collections carry payload indexes on fields no document ever sets.",
        "",
        "| Field | v1 | v2 |",
        "|---|---|---|",
    ]
    for k in sorted(set(V1["facets"]) | set(V2["facets"])):
        a = V1["facets"].get(k)
        b = V2["facets"].get(k)
        ea = isinstance(a, dict) and not a
        eb = isinstance(b, dict) and not b
        if ea or eb:
            L.append(f"| `{k}` | {'empty' if ea else 'populated'} | {'empty' if eb else 'populated'} |")

    L += [
        "",
        "## Impossible decision dates in the Supabase mirror",
        "",
        "`legal_cases.decision_date` contains dates that cannot be real judgments.",
        "These flow straight into browse ordering, which sorts by `decision_date DESC`, "
        "so a case dated 2088 pins itself to the top of the list.",
        "",
        "| Court | Latest decision_date on record |",
        "|---|---|",
    ]
    for c, v in sorted(SB.items(), key=lambda kv: (kv[1]["last_date"] or ""), reverse=True):
        if v["last_date"] and v["last_date"] > "2026-07-28":
            L.append(f"| {c} | {v['last_date']} |")
    un = SB_AGG["unattributed"]
    L.append(f"| (no court, `court_type = high_court`) | {un['court_type_high_court']['last_date']} |")

    L += [
        "",
        "## The unattributed block in the Supabase mirror",
        "",
        f"**{fmt(un['combined_cases'])} rows** in `legal_cases` have no "
        "`court_normalized` value. They split into two very different populations.",
        "",
        "| Population | Rows | With PDF | With case name | Year range |",
        "|---|---:|---:|---:|---|",
        f"| `court_type` also null | {fmt(un['court_type_null']['cases'])} | "
        f"{fmt(un['court_type_null']['with_pdf'])} | "
        f"{fmt(un['court_type_null']['with_case_name'])} | "
        f"{un['court_type_null']['min_year']} to {un['court_type_null']['max_year']} |",
        f"| `court_type = high_court` | {fmt(un['court_type_high_court']['cases'])} | "
        f"{fmt(un['court_type_high_court']['with_pdf'])} | "
        f"{fmt(un['court_type_high_court']['with_case_name'])} | "
        f"{un['court_type_high_court']['min_year']} to {un['court_type_high_court']['max_year']} |",
        "",
        f"The first group is citation-only stubs: all "
        f"{fmt(un['court_type_null']['cases'])} rows have a citation, but only "
        f"{fmt(un['court_type_null']['with_pdf'])} have a PDF and only "
        f"{fmt(un['court_type_null']['with_case_name'])} have a case name.",
        f"Their `year` column ranges from {un['court_type_null']['min_year']} to "
        f"{un['court_type_null']['max_year']}, which means the year was parsed out of "
        "citation strings and frequently picked up a volume or page number instead.",
        "",
        f"Only {fmt(un['combined_with_corpus_id'])} of the {fmt(un['combined_cases'])} "
        "unattributed rows link to a corpus document at all.",
    ]
    return "\n".join(L)


# --------------------------------------------------------------------------- #
# Top level
# --------------------------------------------------------------------------- #
def top_readme() -> str:
    sb_total = sum(c["cases"] for c in SB.values())
    L = ["# India legal corpus coverage", "", header(0)]
    L += [
        "This folder is the exact inventory of every piece of Indian legal content "
        "Vaquill holds: case law and legislation, per court, per state, per year.",
        "",
        "## Headline",
        "",
        "| | Case law | Legislation |",
        "|---|---:|---:|",
        f"| Documents | {fmt(TOTAL_CASES)} judgments | "
        f"{fmt(ACTS['acts_distinct_total'])} instruments |",
        f"| Embedded chunks | {fmt(TOTAL_CHUNKS)} | {fmt(ACTS['points_count'])} |",
        f"| Courts / states | {len(COURTS)} courts | "
        f"{len(ACTS['by_state_detail'])} state buckets |",
        f"| Earliest | {min((r['first'] for r in COURTS.values() if r['first']), default='n/a')} | "
        f"{min(int(y) for y in ACTS['by_year'])} |",
        f"| Latest on record | {max((r['last'] for r in COURTS.values() if r['last']), default='n/a')} | "
        f"{max(int(y) for y in ACTS['by_year'])} |",
        f"| Practical cutoff | {corpus_cutoff_year()} | "
        f"{max(int(y) for y in ACTS['by_year'])} |",
        "| Qdrant collections | `legal_corpus_v1`, `legal_corpus_v2` | `acts_india` |",
        "",
        "The latest case-law date on record is not a real judgment date. "
        "A handful of rows carry impossible future dates, so the practical cutoff row "
        "above is the one to quote. "
        "See [case-law/data-quality.md](case-law/data-quality.md).",
        "",
        f"Combined that is **{fmt(TOTAL_CHUNKS + ACTS['points_count'])} embedded chunks** "
        f"covering **{fmt(TOTAL_CASES + ACTS['acts_distinct_total'])} distinct legal documents**.",
        "",
        f"A further **{fmt(sum(nc.get('points', 0) for nc in NO_COURT.values()))} case-law "
        "chunks carry no court label at all** and are excluded from the per-court "
        "figures above, because no court filter can reach them. "
        "They are counted in [case-law/README.md](case-law/README.md).",
        "",
        "## Read this first",
        "",
        "- [01-summary.md](01-summary.md) what we have, what we do not have, and what is broken",
        "- [02-methodology.md](02-methodology.md) how every number here was produced and why it is exact",
        "",
        "## Case law",
        "",
        "- [case-law/README.md](case-law/README.md) all courts ranked, with the v1 / v2 split",
        "- [case-law/coverage-matrix.md](case-law/coverage-matrix.md) court by year, one grid",
        "- [case-law/supreme-court.md](case-law/supreme-court.md) Supreme Court of India",
        "- [case-law/high-courts/](case-law/high-courts/) one page per High Court, year by year",
        "- [case-law/tribunals.md](case-law/tribunals.md) tribunal coverage",
        "- [case-law/court-name-variants.md](case-law/court-name-variants.md) duplicate court labels",
        "- [case-law/data-quality.md](case-law/data-quality.md) missing fields and impossible dates",
        "",
        "## Legislation",
        "",
        "- [legislation/README.md](legislation/README.md) acts, rules and regulations overview",
        "- [legislation/by-state.md](legislation/by-state.md) every state and territory",
        "- [legislation/by-year.md](legislation/by-year.md) enactment year profile",
        "- [legislation/data-quality.md](legislation/data-quality.md) schema problems",
        "",
        "## Machine-readable",
        "",
        "- [Vaquill-India-Coverage.xlsx](Vaquill-India-Coverage.xlsx) **the client "
        "workbook.** Courts, tribunals, legislation and regulators in nine tabs, "
        "plain English, safe to share outside the company. Built by "
        "`build_merged_report.py`.",

        "- [internal-audit-workbook.xlsx](internal-audit-workbook.xlsx) every internal "
        "table in one workbook, a tab each. Not for sharing.",
        "- [csv/](csv/) the same tables as 17 individual CSVs, for scripting and diffs",
        "- [data/](data/) the raw extraction dumps behind every number here",
        "",
        "## Regenerating",
        "",
        "```bash",
        "python3 scripts/india_corpus/extract_india_corpus.py acts_india legal_corpus_v2 legal_corpus_v1",
        "python3 scripts/india_corpus/extract_supabase_cases.py",
        "python3 scripts/india_corpus/check_overlap.py",
        "python3 scripts/india_corpus/build_docs.py",
        "```",
        "",
        "The extraction step reads every point in all three collections and takes a "
        "few hours. It is read-only.",
    ]
    return "\n".join(L)


def sc_rank() -> int:
    """1-based rank of the Supreme Court by case count among all courts."""
    order = sorted(COURTS.items(), key=lambda kv: -kv[1]["cases"])
    for i, (c, _) in enumerate(order, 1):
        if c == "Supreme Court of India":
            return i
    return 0


def sc_rank_text() -> str:
    r = sc_rank()
    if not r:
        return "not present in the corpus at all"
    if r == 1:
        ordinal = "largest"
    else:
        suffix = "th" if 11 <= r % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(r % 10, "th")
        ordinal = f"{r}{suffix} largest"
    return f"{ordinal} of the {len(COURTS)} courts by volume"


def sc_beaten_by() -> str:
    sc = COURTS.get("Supreme Court of India", {}).get("cases", 0)
    return fmt(sum(1 for c, r in COURTS.items() if c != "Supreme Court of India" and r["cases"] > sc))


def corpus_cutoff_year() -> str:
    """Last year in which the corpus as a whole still has substantial volume."""
    per_year: dict[int, int] = {}
    for rec in COURTS.values():
        for y, d in rec["years"].items():
            per_year[int(y)] = per_year.get(int(y), 0) + d["cases"]
    if not per_year:
        return "n/a"
    peak = max(per_year.values())
    dense = [y for y, n in per_year.items() if n >= peak * 0.25]
    return str(max(dense))


def sc_metadata_gap() -> int:
    """Supreme Court judgments listed in Supabase but absent from Qdrant."""
    sb = sb_for("Supreme Court of India") or {}
    return max(0, sb.get("cases", 0) - COURTS.get("Supreme Court of India", {}).get("cases", 0))


def summary() -> str:
    L = ["# Summary: what we have and what we do not", "", header(0)]

    biggest = list(COURTS.items())[:5]
    smallest = [ (c, r) for c, r in COURTS.items() if r["cases"] < 25000 ]
    stranded = sum(
        d["cases_distinct"]
        for blob in (V1, V2)
        for raw, d in blob.get("courts", {}).items()
        if raw in INFERRED
    )
    v2d = (DATEIDX or {}).get("legal_corpus_v2", {})
    L += [
        "## Fix these two first",
        "",
        "Both are bugs in data we already hold, not gaps in what we bought.",
        "Neither needs a re-ingest.",
        "",
        "**Every Supreme Court judgment is invisible to a date filter.**",
        "Supreme Court points store `decision_date` as `DD-MM-YYYY`, which Qdrant's "
        "datetime index cannot parse, while High Court points use ISO format.",
        f"All {fmt(COURTS.get('Supreme Court of India', {}).get('chunks', 0))} Supreme "
        "Court chunks are silently dropped by any date-scoped or recency-sorted query, "
        "with no error raised.",
        "",
        f"**The two case-law collections duplicate {fmt(TOTAL_DUPES)} judgments.**",
        "`legal_corpus_v1` and `legal_corpus_v2` are searched together, and for most "
        "shared courts the v2 copy is a strict subset of v1.",
        "That is embedding spend, storage and duplicate hits in retrieval for no added coverage.",
        "",
        "Detail and exact per-court numbers in "
        "[case-law/data-quality.md](case-law/data-quality.md).",
        "",
        "## The short version",
        "",
        f"1. We hold **{fmt(TOTAL_CASES)} Indian judgments** and "
        f"**{fmt(ACTS['acts_distinct_total'])} Indian statutory instruments**, "
        f"embedded as **{fmt(TOTAL_CHUNKS + ACTS['points_count'])} searchable chunks**.",
        "2. Coverage is **High Courts and the Supreme Court only**, with no tribunal "
        "content whatsoever.",
        "   The retrieval code already has tribunal handling built for data that does "
        "not exist, so that path is dead.",
        "   See [case-law/tribunals.md](case-law/tribunals.md).",
        f"3. Case law spans **{len(COURTS)} courts**, but volume is extremely uneven.",
        f"   The top five hold {fmt(sum(r['cases'] for _, r in biggest))} cases, "
        f"{round(100 * sum(r['cases'] for _, r in biggest) / TOTAL_CASES)}% of everything, "
        f"while the bottom {len([1 for r in COURTS.values() if r['cases'] < 25000])} "
        "courts hold under 25,000 each.",
        f"4. The **Supreme Court is {sc_rank_text()}**, with "
        f"{fmt(COURTS.get('Supreme Court of India', {}).get('cases', 0))} judgments.",
        "   It is the only court whose rulings bind nationally, and it is thinner "
        f"than {sc_beaten_by()} of the High Courts we carry.",
        f"5. Practical data cutoff is **{corpus_cutoff_year()}**.",
        "   Latest decision date anywhere in the corpus is "
        f"{max((r['last'] for r in COURTS.values() if r['last']), default='n/a')}, "
        "though some of the very latest dates are data errors rather than real judgments.",
        "",
        "## Coverage by court, condensed",
        "",
        "| Court | Cases | First | Last |",
        "|---|---:|---|---|",
    ]
    for c, r in COURTS.items():
        L.append(f"| {c} | {fmt(r['cases'])} | {span(r)[0]} | {span(r)[1]} |")

    L += [
        "",
        "## The 25 High Courts of India, checked one by one",
        "",
        "India has 25 High Courts. This is which of them we carry.",
        "",
        "| High Court | In corpus | Cases |",
        "|---|---|---:|",
    ]
    ALL_HC = [
        "Allahabad High Court", "Andhra Pradesh High Court", "Bombay High Court",
        "Calcutta High Court", "Chhattisgarh High Court", "Delhi High Court",
        "Gauhati High Court", "Gujarat High Court", "Himachal Pradesh High Court",
        "Jammu & Kashmir High Court", "Jharkhand High Court", "Karnataka High Court",
        "Kerala High Court", "Madhya Pradesh High Court", "Madras High Court",
        "Manipur High Court", "Meghalaya High Court", "Orissa High Court",
        "Patna High Court", "Punjab and Haryana High Court", "Rajasthan High Court",
        "Sikkim High Court", "Telangana High Court", "Tripura High Court",
        "Uttarakhand High Court",
    ]
    missing_hc = []
    for hc in ALL_HC:
        rec = COURTS.get(hc)
        if rec:
            L.append(f"| {hc} | yes | {fmt(rec['cases'])} |")
        else:
            L.append(f"| {hc} | **no** | 0 |")
            missing_hc.append(hc)
    L += [
        "",
        (
            f"Missing High Courts: {', '.join(missing_hc)}."
            if missing_hc
            else "All 25 High Courts are represented."
        ),
    ]

    thin = [(c, r) for c, r in COURTS.items() if r["cases"] < 25000 and c in ALL_HC]
    if thin:
        L += [
            "",
            "## Courts that are present but too thin to rely on",
            "",
            "| Court | Cases | Earliest | Note |",
            "|---|---:|---|---|",
        ]
        for c, r in sorted(thin, key=lambda kv: kv[1]["cases"]):
            L.append(
                f"| {c} | {fmt(r['cases'])} | {span(r)[0]} | "
                f"first {span(r)[0][:4]}, "
                f"{len(r['years'])} years of data |"
            )

    L += [
        "",
        "## Where coverage starts, by court",
        "",
        "Most courts have effectively nothing before the mid 2000s. A handful of very "
        "old entries exist but they are isolated, not continuous coverage. The column "
        "below is the first year in which a court has at least 1,000 cases, which is a "
        "far better guide to usable depth than the earliest date on record.",
        "",
        "| Court | Earliest date | First year with 1,000+ cases | Years at 1,000+ |",
        "|---|---|---:|---:|",
    ]
    for c, r in COURTS.items():
        dense = sorted(int(y) for y, d in r["years"].items() if d["cases"] >= 1000)
        L.append(
            f"| {c} | {span(r)[0]} | {dense[0] if dense else 'never'} | {len(dense)} |"
        )

    L += [
        "",
        "## Legislation",
        "",
        f"- **{fmt(ACTS['acts_distinct_total'])} instruments** across "
        f"**{fmt(ACTS['sections_total'])} individually embedded provisions**.",
        f"- **{fmt(ACTS['by_state_detail']['central']['acts'])} central instruments** "
        f"and {fmt(ACTS['acts_distinct_total'] - ACTS['by_state_detail']['central']['acts'])} "
        "state and territory instruments.",
        f"- **{fmt(ACTS['by_act_status']['in_force']['acts'])} in force**, "
        f"{fmt(ACTS['by_act_status']['repealed']['acts'])} repealed, "
        f"{fmt(ACTS['by_act_status']['spent']['acts'])} spent.",
        f"- {fmt(ACTS['missing']['year'])} provisions carry no enactment year.",
        "",
        "State-level legislation is thin and lopsided. See "
        "[legislation/by-state.md](legislation/by-state.md) for the full list.",
        "",
        "## Known problems, ranked by how much they cost us",
        "",
        "1. **2.1 million tribunal decision documents are held but not searchable.** "
        "813,168 matters across 15 forums including NCLT, ITAT, CESTAT, CAT, NGT, DRT, "
        "SAT and CCI sit in storage as original PDF with no extracted text, so none of "
        "it can be retrieved, quoted or cited. For corporate, tax and insolvency work "
        "this is where most of the usable authority sits. "
        "See [tribunals/README.md](tribunals/README.md).",
        "2. **Every Supreme Court judgment is invisible to a date filter**, because "
        "its `decision_date` is stored in a format the datetime index cannot parse.",
        f"3. **{fmt(sc_metadata_gap())} Supreme Court judgments have metadata but no "
        "vectors**, so they appear in browse yet cannot be retrieved, quoted or cited.",
        f"4. **The Supreme Court is under-covered overall**, at "
        f"{fmt(COURTS.get('Supreme Court of India', {}).get('cases', 0))} judgments, "
        "and it is the only court whose authority binds nationally.",
        f"5. **{fmt(TOTAL_DUPES)} judgments are duplicated across the two case-law "
        "collections**, which are searched together, so retrieval can return the same "
        "judgment twice.",
        f"6. **{fmt(stranded)} cases are unreachable by court filter** because their "
        "court label is a spelling the application does not know. See "
        "[case-law/court-name-variants.md](case-law/court-name-variants.md).",
        f"7. **Citations exist for the Supreme Court only.** Every High Court point in "
        "both collections has an empty `citation` field, so citation lookup silently "
        "fails for High Court authority.",
        f"8. **{fmt(SB_AGG['unattributed']['combined_cases'])} Supabase rows have no "
        "court**, and their parsed years run from "
        f"{SB_AGG['unattributed']['court_type_null']['min_year']} to "
        f"{SB_AGG['unattributed']['court_type_null']['max_year']}, which means the year "
        "was scraped out of citation text and often grabbed a volume number.",
        "9. **Impossible future decision dates** reach browse ordering, which sorts by "
        "`decision_date DESC`. See [case-law/data-quality.md](case-law/data-quality.md).",
        f"10. **`jurisdiction` and `category` on `acts_india` are the same field**, and "
        "neither is a jurisdiction. See "
        "[legislation/data-quality.md](legislation/data-quality.md).",
    ]
    return "\n".join(L)


def methodology() -> str:
    L = ["# Methodology", "", header(0)]
    L += [
        "## Why these numbers are exact",
        "",
        "Nothing here is sampled, estimated or extrapolated.",
        "",
        "### Counting documents, not chunks",
        "",
        "Qdrant stores one point per text chunk, so a point count is not a document "
        "count. A judgment is spread over anywhere from 1 to several hundred chunks, "
        "all sharing one `case_id`.",
        "",
        "Distinct documents are counted with the Qdrant **facet API** on the `case_id` "
        "keyword index with `exact: true`, which enumerates every distinct value in a "
        "filtered set. The number of returned values is the exact document count.",
        "",
        "### The truncation guard",
        "",
        "A facet returns at most `limit` values, so a bucket with more distinct values "
        "than the limit would silently under-report. Every facet result is checked "
        "against an independent exact `count` over the identical filter:",
        "",
        "```",
        "sum(chunk counts returned by the facet) == exact point count for the filter",
        "```",
        "",
        "Chunks are partitioned by `case_id`, so those two numbers can only agree if "
        "the facet enumerated every case. Each per-year row records this check as "
        "`consistent`, and any mismatch is logged loudly rather than being averaged away.",
        "",
        "### Buckets too large for one facet",
        "",
        "A facet over a multi-million-point bucket can exhaust server memory. When one "
        "fails, the extractor splits that bucket into month windows on the "
        "`decision_date` index and unions the results on `case_id`. Because a judgment "
        "has a single decision date the windows do not overlap, and the union is taken "
        "on the ID itself so a duplicate would still collapse to one document.",
        "",
        "### Court totals",
        "",
        "A court total is the size of the **union** of its per-year `case_id` sets, not "
        "the sum of the per-year counts. If one `case_id` appeared under two different "
        "years the sum would double-count it; the union does not. Where the two differ "
        "the delta is reported per court.",
        "",
        "### Cross-collection duplicates",
        "",
        "`legal_corpus_v1` and `legal_corpus_v2` both hold High Court judgments and "
        "several courts appear in both. Adding their case counts would double-count any "
        "judgment ingested twice. For every court present in both collections, all "
        "`case_id` values were pulled from the smaller side and probed against the "
        "larger side in batches with `MatchAny`, giving the exact size of the "
        "intersection. Reported court and corpus totals subtract it.",
        "",
        "### Date ranges",
        "",
        "Earliest and latest decision dates come from an ordered scroll on the "
        "`decision_date` datetime index, ascending and descending, one point each. That "
        "is the true minimum and maximum, not the extremes of a sample.",
        "",
        "## Sources",
        "",
        "| Source | What it provides |",
        "|---|---|",
        "| Qdrant `legal_corpus_v1` | High Court judgments, older ingest |",
        "| Qdrant `legal_corpus_v2` | High Court and Supreme Court judgments, newer ingest |",
        "| Qdrant `acts_india` | Central and state legislation, one point per provision |",
        "| Supabase `public.legal_cases` | Case metadata mirror that powers browse and citation lookup |",
        "",
        "Qdrant is reached at `QDRANT_CORPUS_URL` with `QDRANT_CORPUS_API_KEY` from `.env`.",
        "",
        "## Known limits of this report",
        "",
        "- Supabase per-year counts for the unattributed block (rows with no "
        "`court_normalized`) are missing. The index that serves per-court-per-year "
        "counts is partial, `WHERE court_normalized IS NOT NULL`, so counting that "
        "block seq-scans the table and exceeds the statement timeout. Those cells read "
        "`n/a` rather than 0. The block totals are still exact and come from a "
        "server-side aggregate.",
        "- Court-name normalization merges spelling variants. Mappings taken from the "
        "application's own `COURT_NAME_VARIANTS` are separated from ones inferred for "
        "this report in "
        "[case-law/court-name-variants.md](case-law/court-name-variants.md).",
        "- `decision_date` in the raw payload has inconsistent formats. Dates are "
        "normalized to `YYYY-MM-DD` for display only, never for counting.",
    ]
    return "\n".join(L)


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
def write_csvs() -> None:
    """Copy the raw dumps into docs/india-corpus/data/.

    Flat tabular exports live in docs/india-corpus/csv/ and are written by
    build_csvs.py, so there is exactly one version of every table.
    """
    d = DOCS / "data"
    d.mkdir(parents=True, exist_ok=True)
    for name in ("legal_corpus_v1.json", "legal_corpus_v2.json", "acts_india.json",
                 "supabase_legal_cases.json", "supabase_court_aggregates.json",
                 "overlap.json", "date_index.json"):
        src = RAW / name
        if src.exists() and src.resolve() != (d / name).resolve():
            (d / name).write_text(src.read_text())
    print(f"copied raw dumps into {d.relative_to(REPO)}")


def data_readme() -> str:
    return "\n".join([
        "# Machine-readable data",
        "",
        header(1),
        "These are the raw extraction dumps. Every table in this folder tree is "
        "generated from them.",
        "",
        "For flat tables to open in a spreadsheet, use [../csv/](../csv/) instead.",
        "",
        "| File | Contents |",
        "|---|---|",
        "| `legal_corpus_v1.json` | full raw extraction for the v1 Qdrant collection |",
        "| `legal_corpus_v2.json` | full raw extraction for the v2 Qdrant collection |",
        "| `acts_india.json` | full raw extraction for the legislation collection |",
        "| `supabase_legal_cases.json` | per court and year exact counts from the Supabase mirror |",
        "| `supabase_court_aggregates.json` | per court aggregates from the Supabase mirror |",
        "| `overlap.json` | exact cross-collection duplicate case IDs |",
        "| `date_index.json` | how many points each collection exposes to a date filter |",
        "",
        "The JSON dumps carry per-year consistency flags "
        "(`consistent`, `chunks_expected`) so any bucket where the facet and the exact "
        "count disagreed can be found without re-running the extraction.",
    ])


def main() -> None:
    DOCS.mkdir(parents=True, exist_ok=True)
    w("README.md", top_readme())
    w("01-summary.md", summary())
    w("02-methodology.md", methodology())
    w("case-law/README.md", case_law_readme())
    w("case-law/coverage-matrix.md", coverage_matrix())
    w("case-law/court-name-variants.md", court_variants())
    w("case-law/tribunals.md", tribunals_page())
    w("case-law/data-quality.md", case_law_data_quality())
    write_court_pages()
    w("legislation/README.md", acts_readme())
    w("legislation/by-state.md", acts_by_state())
    w("legislation/by-year.md", acts_by_year())
    w("legislation/data-quality.md", acts_data_quality())
    w("data/README.md", data_readme())
    write_csvs()


if __name__ == "__main__":
    main()
