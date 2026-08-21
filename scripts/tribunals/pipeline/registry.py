"""
Tribunal Registry — single source of truth for all tribunal metadata,
JSONL paths, field mappings, and judgment detection rules.

Each tribunal entry defines:
- slug: URL-safe identifier (used in Qdrant payload, PG, R2 paths)
- name: Display name
- jsonl_paths: list of JSONL files (relative to data/tribunals/)
- court_type: always "tribunal" for Qdrant corpus compatibility
- has_judgments: whether this tribunal has parseable judgments (not just orders)
- judgment_filter: callable or field-based rule to separate judgments from orders
- field_map: maps raw JSONL field names → corpus common field names
- extra_fields: tribunal-specific fields to preserve (indexed in Qdrant)
- governing_acts: acts this tribunal operates under (for legal_acts_rules collection)
"""

from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass(frozen=True)
class TribunalConfig:
    slug: str
    name: str
    jsonl_paths: list[str]
    court_type: str = "tribunal"
    has_judgments: bool = False
    judgment_filter: dict[str, Any] | None = None
    field_map: dict[str, str] = field(default_factory=dict)
    extra_fields: list[str] = field(default_factory=list)
    extra_indexes: list[dict[str, str]] = field(default_factory=list)
    governing_acts: list[str] = field(default_factory=list)
    bench_prefix: str = ""


# ─────────────────────────────────────────────────────────────────────
# Common field names (matching legal_corpus_v1/v2 payload schema):
#
#   case_id, case_number, court, court_type, bench, bench_strength,
#   country_code, state_code, state_name, language_code,
#   decision_date, year, disposition, case_type,
#   petitioner, respondent, judges, title, description,
#   acts_referenced, cases_cited, cited_by_count,
#   section_type, section_priority,
#   text, pdf_url,
#   chunk_id, chunk_index, total_chunks,
#   char_start, char_end, page_start, page_end
#
# Plus tribunal-specific:
#   tribunal (slug), tribunal_extra (dict of unique fields)
# ─────────────────────────────────────────────────────────────────────


TRIBUNALS: dict[str, TribunalConfig] = {
    "itat": TribunalConfig(
        slug="itat",
        name="Income Tax Appellate Tribunal",
        jsonl_paths=["itat/itat-orders.jsonl"],
        has_judgments=True,
        # All ITAT records are final orders/judgments from itat.gov.in with PDFs
        # (din_number is empty across all records — not a reliable filter)
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "assessee_name": "petitioner",
            "respondent": "respondent",
            "case_number": "case_number",
            "order_date": "decision_date",
            "bench": "bench",
            "member_names": "judges",
            "appeal_type": "case_type",
            "pdf_url": "pdf_url",
            "source_url": "source_url",
        },
        extra_fields=[
            "appeal_type_code",
            "assessment_year",
            "din_number",
            "pronouncement_date",
            "petitioner_city",
            "respondent_city",
        ],
        extra_indexes=[
            {"field": "assessment_year", "type": "keyword"},
            {"field": "appeal_type_code", "type": "keyword"},
            {"field": "petitioner_city", "type": "keyword"},
        ],
        governing_acts=["Income Tax Act, 1961"],
        bench_prefix="itat",
    ),
    "cat": TribunalConfig(
        slug="cat",
        name="Central Administrative Tribunal",
        jsonl_paths=["cat/cat-all-metadata.jsonl"],
        has_judgments=True,
        # All CAT records are judgments
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "petitioner": "petitioner",
            "respondent": "respondent",
            "case_number": "case_number",
            "judgment_date": "decision_date",
            "bench_name": "bench",
            "judge_name": "judges",
            "case_type": "case_type",
            "pdf_url": "pdf_url",
            "source_url": "source_url",
        },
        extra_fields=["handle_id", "case_year", "bench_slug"],
        extra_indexes=[
            {"field": "case_year", "type": "keyword"},
            {"field": "bench_slug", "type": "keyword"},
        ],
        governing_acts=["Administrative Tribunals Act, 1985"],
        bench_prefix="cat",
    ),
    # CAT CIS — daily orders from the new Case Information System (2021-2025)
    # Past judgments (1985-2021): catjudgements.nic.in DSpace → "cat" slug above
    # Present orders (2021-2025): cis.cgat.gov.in → "cat_cis" slug below
    # ~1.26M records, 181K unique cases, avg 7 orders per case
    "cat_cis": TribunalConfig(
        slug="cat_cis",
        name="Central Administrative Tribunal (CIS Orders)",
        jsonl_paths=["cat-cis/cat-cis-all-metadata.jsonl"],
        has_judgments=False,  # These are daily orders, not final judgments
        judgment_filter=None,
        field_map={
            "petitioner": "petitioner",
            "respondent": "respondent",
            "case_number": "case_number",
            "order_date_iso": "decision_date",
            "bench_name": "bench",
            "case_type": "case_type",
            "pdf_url": "pdf_url",
        },
        extra_fields=["bench_code", "pdf_encoded_path", "source_system"],
        extra_indexes=[
            {"field": "bench_code", "type": "keyword"},
        ],
        governing_acts=["Administrative Tribunals Act, 1985"],
        bench_prefix="cat_cis",
    ),
    "drt": TribunalConfig(
        slug="drt",
        name="Debt Recovery Tribunal / Appellate Tribunal",
        jsonl_paths=[
            "drt/drt-final-orders.jsonl",  # 125K final judgments only
            "drt/rc-trc/drt-rc-trc.jsonl",
        ],
        has_judgments=True,
        # Daily orders (3.3M interim/procedural) deleted — no legal value for RAG.
        # Only final orders retained (125K). Original source: drt-all-orders.jsonl.
        judgment_filter={"field": "pdf_url", "rule": "not_empty"},
        field_map={
            "applicant_name": "petitioner",
            "respondent_name": "respondent",
            "case_number": "case_number",
            "order_date": "decision_date",
            "tribunal_name": "bench",
            "pronounced_by": "judges",
            "pdf_url": "pdf_url",
        },
        extra_fields=[
            "tribunal_type",
            "tribunal_id",
            "diary_number",
            "order_type",
            "item_no",
            "source",
        ],
        extra_indexes=[
            {"field": "tribunal_type", "type": "keyword"},
            {"field": "order_type", "type": "keyword"},
        ],
        governing_acts=[
            "Recovery of Debts and Bankruptcy Act, 1993",
            "SARFAESI Act, 2002",
        ],
        bench_prefix="drt",
    ),
    "sat": TribunalConfig(
        slug="sat",
        name="Securities Appellate Tribunal",
        jsonl_paths=["sat/sat-all-metadata.jsonl"],
        has_judgments=True,
        # All SAT orders contain reasoning — treat as judgments
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "appellant": "petitioner",
            "respondent": "respondent",
            "appeal_number": "case_number",
            "order_date": "decision_date",
            "court": "bench",
            "appeal_type": "case_type",
            "view_order_url": "pdf_url",
            "source_url": "source_url",
        },
        extra_fields=[
            "appeal_type",
            "appeal_type_code",
            "al_number",
            "order_year",
            "order_month",
            "pdf_size_bytes",
            "id",
        ],
        extra_indexes=[
            {"field": "appeal_type", "type": "keyword"},
        ],
        governing_acts=[
            "SEBI Act, 1992",
            "IRDAI Act, 1999",
            "PFRDA Act, 2013",
        ],
        bench_prefix="sat",
    ),
    "aptel": TribunalConfig(
        slug="aptel",
        name="Appellate Tribunal for Electricity",
        # NOTE: supplementary contains acts/rules/statutes, not case judgments
        # — will go into legal_acts_rules collection separately
        jsonl_paths=[
            "aptel/aptel-all-metadata.jsonl",
        ],
        has_judgments=True,
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "cause_title": "title",
            "appeal_petition": "case_number",
            "date_of_decision": "decision_date",
            "bench": "bench",
            "pdf_urls": "pdf_url",
            "source_url": "source_url",
        },
        extra_fields=["serial_no", "year"],
        extra_indexes=[],
        governing_acts=["Electricity Act, 2003"],
        bench_prefix="aptel",
    ),
    "cci": TribunalConfig(
        slug="cci",
        name="Competition Commission of India",
        jsonl_paths=[
            "cci/cci-all-metadata.jsonl",
            "cci/cci-supplementary-metadata.jsonl",
        ],
        has_judgments=True,
        # CCI orders contain detailed reasoning
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "description": "title",
            "case_no": "case_number",
            "order_date": "decision_date",
            "category": "case_type",
            "pdf_urls": "pdf_url",
            "detail_url": "source_url",
        },
        extra_fields=[
            "category", "section", "type", "main_order_date",
            "id",
        ],
        extra_indexes=[
            {"field": "category", "type": "keyword"},
            {"field": "section", "type": "keyword"},
        ],
        governing_acts=["Competition Act, 2002"],
        bench_prefix="cci",
    ),
    "atfp": TribunalConfig(
        slug="atfp",
        name="Appellate Tribunal for Forfeited Property",
        jsonl_paths=[
            "atfp/atfp-all-documents.jsonl",
            "atfp/atfp-judgments-only.jsonl",
        ],
        has_judgments=True,
        # Use the judgments-only file, or filter by doc_type
        judgment_filter={"field": "doc_type", "rule": "equals", "value": "judgment"},
        field_map={
            "appellant_name": "petitioner",
            "respondent_name": "respondent",
            "case_number": "case_number",
            "date_iso": "decision_date",
            "act_name": "case_type",
            "pdf_url": "pdf_url",
            "source_url": "source_url",
        },
        extra_fields=["act_id", "act_name", "doc_type", "full_parties"],
        extra_indexes=[
            {"field": "act_id", "type": "keyword"},
            {"field": "doc_type", "type": "keyword"},
        ],
        governing_acts=[
            "PMLA, 2002",
            "NDPS Act, 1985",
            "COFEPOSA, 1974",
            "Benami Transactions Act, 1988",
        ],
        bench_prefix="atfp",
    ),
    "gst_aar": TribunalConfig(
        slug="gst_aar",
        name="GST Authority for Advance Ruling",
        jsonl_paths=["gst-aar/gst-aar-all-metadata.jsonl"],
        has_judgments=True,
        # Rulings with detailed reasoning
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "applicant_name": "petitioner",
            "order_no_date": "case_number",
            "state_ut": "bench",
            "pdf_url": "pdf_url",
        },
        extra_fields=[
            "state_ut",
            "brief_of_order",
            "category",
            "order_type",
        ],
        extra_indexes=[
            {"field": "state_ut", "type": "keyword"},
            {"field": "order_type", "type": "keyword"},
            {"field": "category", "type": "keyword"},
        ],
        governing_acts=["CGST Act, 2017", "SGST Acts"],
        bench_prefix="gst_aar",
    ),
    "ibbi": TribunalConfig(
        slug="ibbi",
        name="Insolvency and Bankruptcy Board of India",
        # NOTE: ibbi-all-metadata.jsonl is a superset of individual files below
        # — excluded to avoid double-counting (verified via content_hash overlap)
        jsonl_paths=[
            "ibbi/metadata/nclt-orders.jsonl",
            "ibbi/metadata/nclat-orders.jsonl",
            "ibbi/metadata/ibbi-orders.jsonl",
            "ibbi/metadata/supreme-court-orders.jsonl",
            "ibbi/metadata/high-courts-orders.jsonl",
            "ibbi/metadata/ipa-rvo-orders.jsonl",
        ],
        has_judgments=True,
        # Final orders are judgments
        judgment_filter={
            "field": "order_remarks",
            "rule": "contains",
            "value": "Final Order",
        },
        field_map={
            "case_name": "title",
            "petition_number": "case_number",
            "date_iso": "decision_date",
            "bench": "bench",
            "category_name": "case_type",
            "pdf_url": "pdf_url",
            "source_url": "source_url",
        },
        extra_fields=[
            "category_slug",
            "category_name",
            "order_remarks",
            "petition_number",
            "file_size",
            "content_hash",
        ],
        extra_indexes=[
            {"field": "category_slug", "type": "keyword"},
            {"field": "order_remarks", "type": "keyword"},
        ],
        governing_acts=["Insolvency and Bankruptcy Code, 2016"],
        bench_prefix="ibbi",
    ),
    "ngt": TribunalConfig(
        slug="ngt",
        name="National Green Tribunal",
        jsonl_paths=["ngt/ngt-all-orders.jsonl"],
        has_judgments=True,
        # All NGT records are orders/judgments from greentribunal.gov.in with PDFs
        # (order_type only contains 'Order' or leaked dates — no 'Judgment' label exists)
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "petitioner": "petitioner",
            "respondent": "respondent",
            "case_number": "case_number",
            "order_date": "decision_date",
            "bench": "bench",
            "order_type": "case_type",
            "pdf_download_url": "pdf_url",
            "source_url": "source_url",
        },
        extra_fields=["zone_id", "zone_name", "case_id", "order_type"],
        extra_indexes=[
            {"field": "zone_name", "type": "keyword"},
            {"field": "order_type", "type": "keyword"},
        ],
        governing_acts=["National Green Tribunal Act, 2010"],
        bench_prefix="ngt",
    ),
    "cestat": TribunalConfig(
        slug="cestat",
        name="Customs, Excise & Service Tax Appellate Tribunal",
        jsonl_paths=[
            # Final orders only — daily orders (interim/procedural) excluded for now.
            # Daily files: *_daily.jsonl (386K records, order_type="D") — low-value for RAG.
            # To re-include later, add back *_daily.jsonl files.
            "cestat/metadata/delhi_final.jsonl",
            "cestat/metadata/mumbai_final.jsonl",
            "cestat/metadata/bangalore_final.jsonl",
            "cestat/metadata/chennai_final.jsonl",
            "cestat/metadata/kolkata_final.jsonl",
            "cestat/metadata/ahmedabad_final.jsonl",
            "cestat/metadata/chandigarh_final.jsonl",
            "cestat/metadata/allahabad_final.jsonl",
            "cestat/metadata/hyderabad_final.jsonl",
            # Larger bench orders (supplementary — always judgments)
            "cestat/supplementary/metadata/larger_bench_orders.jsonl",
        ],
        has_judgments=True,
        # Final orders + larger bench contain reasoning — judgments
        judgment_filter={"field": "_path", "rule": "contains", "value": "_final.jsonl,larger_bench"},
        field_map={
            "appellant": "petitioner",
            "respondent": "respondent",
            "case_number": "case_number",
            "order_date": "decision_date",
            "bench": "bench",
            "parties": "title",
            "pdf_url": "pdf_url",
        },
        extra_fields=["order_type", "bench_type", "pdf_id", "serial"],
        extra_indexes=[
            {"field": "order_type", "type": "keyword"},
            {"field": "bench_type", "type": "keyword"},
        ],
        governing_acts=[
            "Customs Act, 1962",
            "Central Excise Act, 1944",
            "Finance Act, 1994 (Service Tax)",
        ],
        bench_prefix="cestat",
    ),
    "nclt": TribunalConfig(
        slug="nclt",
        name="National Company Law Tribunal",
        jsonl_paths=[
            "nclt/metadata/kochi-cases.jsonl",
            "nclt/metadata/hyderabad-cases.jsonl",
            "nclt/metadata/chennai-cases.jsonl",
            "nclt/metadata/bengaluru-cases.jsonl",
            "nclt/metadata/cuttack-cases.jsonl",
            "nclt/metadata/ahmedabad-cases.jsonl",
            "nclt/metadata/allahabad-cases.jsonl",
            "nclt/metadata/amravati-cases.jsonl",
            "nclt/metadata/kolkata-cases.jsonl",
            "nclt/metadata/guwahati-cases.jsonl",
            "nclt/metadata/indore-cases.jsonl",
            "nclt/metadata/chandigarh-cases.jsonl",
            "nclt/metadata/jaipur-cases.jsonl",
            "nclt/metadata/mumbai-cases.jsonl",
            "nclt/metadata/delhi-cases.jsonl",
        ],
        has_judgments=True,
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "filing_no": "case_number",
            "bench_name": "bench",
        },
        extra_fields=["bench_id", "filing_no", "discovery_term", "content_hash"],
        extra_indexes=[
            {"field": "bench_id", "type": "keyword"},
        ],
        governing_acts=["Companies Act, 2013", "Insolvency and Bankruptcy Code, 2016"],
        bench_prefix="nclt",
    ),
    "tdsat": TribunalConfig(
        slug="tdsat",
        name="Telecom Disputes Settlement & Appellate Tribunal",
        jsonl_paths=[
            "tdsat/metadata/all_judgments.jsonl",
            # Case dossiers — no PDFs, but rich metadata (proceedings, advocates, status)
            "tdsat/case-dossiers/all_case_dossiers.jsonl",
        ],
        has_judgments=True,
        # Only judgment files have PDFs for RAG
        judgment_filter={"field": "_path", "rule": "contains", "value": "all_judgments"},
        field_map={
            "petitioner": "petitioner",
            "respondent": "respondent",
            "case_no": "case_number",
            "judgment_date": "decision_date",
            "case_type": "case_type",
            "member": "judges",
            "full_pdf_url": "pdf_url",
        },
        extra_fields=[
            "serial", "year", "case_year", "diary_no", "diary_year",
            "filing_date", "status", "subject",
            "petitioner_advocate", "respondent_advocate",
        ],
        extra_indexes=[
            {"field": "case_type", "type": "keyword"},
            {"field": "status", "type": "keyword"},
        ],
        governing_acts=["TRAI Act, 1997"],
        bench_prefix="tdsat",
    ),
    "rera_delhi": TribunalConfig(
        slug="rera_delhi",
        name="RERA Appellate Tribunal - Delhi",
        jsonl_paths=["rera-delhi/delhi-reat-all-metadata.jsonl"],
        has_judgments=True,
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "complainant": "petitioner",
            "respondent": "respondent",
            "complaint_no": "case_number",
            "order_date": "decision_date",
            "court": "bench",
            "pdf_url": "pdf_url",
        },
        extra_fields=["source"],
        extra_indexes=[],
        governing_acts=["RERA Act, 2016"],
        bench_prefix="rera",
    ),
    "rera_punjab": TribunalConfig(
        slug="rera_punjab",
        name="RERA Appellate Tribunal - Punjab",
        jsonl_paths=["rera-punjab/punjab-reat-all-metadata.jsonl"],
        has_judgments=True,
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "complainant": "petitioner",
            "respondent": "respondent",
            "complaint_no": "case_number",
            "order_date": "decision_date",
            "court": "bench",
            "pdf_url": "pdf_url",
        },
        extra_fields=["source"],
        extra_indexes=[],
        governing_acts=["RERA Act, 2016"],
        bench_prefix="rera",
    ),
    "rera_maharera": TribunalConfig(
        slug="rera_maharera",
        name="MahaRERA Appellate Tribunal",
        jsonl_paths=["rera-maharera/maharera-all-metadata.jsonl"],
        has_judgments=True,
        judgment_filter={"field": "_all", "rule": "always_true"},
        field_map={
            "complainant": "petitioner",
            "respondent": "respondent",
            "complaint_no": "case_number",
            "upload_date": "decision_date",
            "court": "bench",
            "heard_by": "judges",
        },
        extra_fields=["project_id", "project_name", "heard_by", "has_pdf", "source"],
        extra_indexes=[
            {"field": "project_id", "type": "keyword"},
        ],
        governing_acts=["RERA Act, 2016"],
        bench_prefix="rera",
    ),
}


def get_tribunal(slug: str) -> TribunalConfig:
    """Get tribunal config by slug. Raises KeyError if not found."""
    return TRIBUNALS[slug]


def get_all_tribunals() -> dict[str, TribunalConfig]:
    """Get all tribunal configs."""
    return TRIBUNALS


def get_tribunals_with_judgments() -> dict[str, TribunalConfig]:
    """Get only tribunals that have parseable judgments."""
    return {k: v for k, v in TRIBUNALS.items() if v.has_judgments}


def get_tribunals_orders_only() -> dict[str, TribunalConfig]:
    """Get tribunals that only have orders (no RAG, listing only)."""
    return {k: v for k, v in TRIBUNALS.items() if not v.has_judgments}


def get_all_extra_indexes() -> list[dict[str, str]]:
    """Collect all unique extra indexes across all tribunals."""
    seen = set()
    indexes = []
    for t in TRIBUNALS.values():
        for idx in t.extra_indexes:
            key = (idx["field"], idx["type"])
            if key not in seen:
                seen.add(key)
                indexes.append(idx)
    return indexes


if __name__ == "__main__":
    print("=== Tribunals with Judgments (will be RAG'd) ===")
    for slug, t in get_tribunals_with_judgments().items():
        paths = ", ".join(t.jsonl_paths) if t.jsonl_paths else "(no data)"
        print(f"  {slug}: {t.name} — {paths}")

    print("\n=== Orders Only (PG listing, no RAG) ===")
    for slug, t in get_tribunals_orders_only().items():
        paths = ", ".join(t.jsonl_paths) if t.jsonl_paths else "(no data)"
        print(f"  {slug}: {t.name} — {paths}")

    print(f"\n=== Extra Indexes Needed ({len(get_all_extra_indexes())}) ===")
    for idx in get_all_extra_indexes():
        print(f"  {idx['field']}: {idx['type']}")
