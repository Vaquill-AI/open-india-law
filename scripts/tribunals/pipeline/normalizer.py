"""
Tribunal Metadata Normalizer.

Transforms raw JSONL records from each tribunal's scraper into a common
schema matching the legal_corpus_v1/v2 Qdrant payload structure.

Input:  Raw JSONL record (different fields per tribunal)
Output: Normalized dict with:
  - Common fields (matching corpus: petitioner, respondent, case_number, etc.)
  - tribunal_extra dict (tribunal-specific fields preserved)
  - raw_metadata dict (ALL unmapped fields preserved)
  - Standardized dates (ISO format), bench slugs, case IDs

Usage:
  python normalizer.py --tribunal itat --output-dir data/normalized/
  python normalizer.py --all --output-dir data/normalized/
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from registry import TribunalConfig, get_all_tribunals, get_tribunal

DATA_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "tribunals"


# ─────────────────────────────────────────────────────────────────────
# Date parsing — handles all formats found across tribunals
# ─────────────────────────────────────────────────────────────────────

_DATE_FORMATS = [
    "%d/%m/%Y",        # 06/01/2025 (ITAT, DRT, SAT, CCI)
    "%d-%m-%Y",        # 16-12-2026 (ATFP)
    "%d.%m.%Y",        # 19.12.2008 (APTEL)
    "%Y-%m-%d",        # 2026-12-16 (ISO — ATFP date_iso, IBBI date_iso)
    "%d-%b-%Y",        # 29-Nov-2024 (RERA Delhi)
    "%d %b, %Y",       # 10 Feb, 2026 (IBBI date)
    "%d-%m-%Y %H:%M:%S",  # 08-06-2024 18:57:35 (MahaRERA upload_date)
    "%d-%m-%y",        # 22-02-16 short year
    "%d/%m/%y",        # 06/01/25 short year
    "%d/%m/%Y %H:%M",  # 06/01/2025 14:30
]


def parse_date(raw: str | None) -> str | None:
    """Parse date string to ISO format (YYYY-MM-DD). Returns None if unparseable."""
    if not raw or not isinstance(raw, str) or not raw.strip():
        return None

    raw = raw.strip()

    # Already ISO
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        return raw[:10]

    # Excel serial date numbers (days since 1899-12-30) — found in CAT data
    # Valid range: ~30000 (1982) to ~50000 (2036)
    if re.match(r"^\d{5}$", raw):
        try:
            serial = int(raw)
            if 30000 <= serial <= 50000:
                from datetime import timedelta
                # Excel epoch: 1899-12-30 (accounting for Excel's leap year bug)
                excel_epoch = datetime(1899, 12, 30)
                dt = excel_epoch + timedelta(days=serial)
                return dt.strftime("%Y-%m-%d")
        except (ValueError, OverflowError):
            pass

    # Extract date from embedded strings like "GUJ/GAAR/R/2025/58/dated 29.11.2025"
    # or "Order No GST-ARA-81/2021-22/B-629, Mumbai Dted.28.11.2025."
    dated_match = re.search(r"[Dd](?:ate)?[dt]\.?\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})", raw)
    if dated_match:
        return parse_date(dated_match.group(1))

    for fmt in _DATE_FORMATS:
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue

    return None


def extract_year(date_iso: str | None) -> int | None:
    """Extract year from ISO date string."""
    if not date_iso:
        return None
    try:
        return int(date_iso[:4])
    except (ValueError, IndexError):
        return None


# ─────────────────────────────────────────────────────────────────────
# Assessment year normalization — ITAT-specific
# ─────────────────────────────────────────────────────────────────────

def normalize_assessment_year(raw: str | None) -> str | None:
    """
    Normalize assessment year to short format: '2018-19'.

    Handles:
      '2018-2019' → '2018-19'
      '2018-19'   → '2018-19' (already correct)
      'NA', '00', '' → None
    """
    if not raw or not isinstance(raw, str):
        return None

    raw = raw.strip()
    if raw in ("NA", "00", "0", ""):
        return None

    # Full year format: 2018-2019 → 2018-19
    m = re.match(r"^(\d{4})-(\d{4})$", raw)
    if m:
        return f"{m.group(1)}-{m.group(2)[2:]}"

    # Already short format: 2018-19
    if re.match(r"^\d{4}-\d{2}$", raw):
        return raw

    return None


# ─────────────────────────────────────────────────────────────────────
# Party name / city splitting — ITAT names have city appended
# ─────────────────────────────────────────────────────────────────────

# Known ITAT city suffixes (appear after last comma in assessee/respondent names)
_ITAT_CITIES = {
    "new delhi", "delhi", "mumbai", "chennai", "kolkata", "bangalore",
    "bengaluru", "hyderabad", "ahmedabad", "pune", "jaipur", "lucknow",
    "chandigarh", "indore", "cochin", "kochi", "surat", "rajkot",
    "nagpur", "patna", "guwahati", "cuttack", "raipur", "jodhpur",
    "dehradun", "ranchi", "agra", "jabalpur", "allahabad", "varanasi",
    "amritsar", "visakhapatnam", "panaji", "goa", "noida", "gurgaon",
    "gurugram", "faridabad", "thane", "bhiwani", "karnal", "meerut",
    "kanpur", "bhopal", "jamshedpur", "ludhiana", "coimbatore",
    "ernakulam", "trivandrum", "thiruvananthapuram", "madurai",
    "vadodara", "gandhinagar", "bhubaneswar", "shimla",
}


def split_party_city(name: str) -> tuple[str, str]:
    """
    Split 'ATUL MARDIA,NEW DELHI' into ('Atul Mardia', 'New Delhi').
    Returns (cleaned_name, city). City is '' if not detected.
    """
    if not name or "," not in name:
        return name, ""

    # Split on last comma — city is typically the last segment
    last_comma = name.rfind(",")
    candidate_city = name[last_comma + 1:].strip()

    if candidate_city.lower() in _ITAT_CITIES:
        party_name = name[:last_comma].strip()
        return party_name, candidate_city.title()

    return name, ""


# ─────────────────────────────────────────────────────────────────────
# Text cleanup — HTML artifacts, encoding issues
# ─────────────────────────────────────────────────────────────────────

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_HTML_ATTR_RE = re.compile(r"^(?:color|font|size|style)=['\"]?[^'\"]*['\"]?>(.*)", re.IGNORECASE)


def clean_text(raw: str | None) -> str:
    """Remove HTML tags/attributes and clean whitespace."""
    if not raw or not isinstance(raw, str):
        return ""
    # Handle TDSAT-style "color='black'>Actual Name" artifacts
    cleaned = _HTML_ATTR_RE.sub(r"\1", raw)
    # Strip remaining HTML tags
    cleaned = _HTML_TAG_RE.sub("", cleaned)
    # Remove TDSAT-style "Additional Party(Pet.):" / "Additional Party(Res.):" suffixes
    cleaned = re.sub(r"\s*Additional Party\([^)]*\):?\s*$", "", cleaned)
    # Normalize whitespace
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


# ─────────────────────────────────────────────────────────────────────
# Party name parsing — handles "X Versus Y" titles
# ─────────────────────────────────────────────────────────────────────

_VS_PATTERN = re.compile(
    r"\s+(?:vs\.?|versus|v/s|v\.)\s+",
    re.IGNORECASE,
)


def parse_parties_from_title(title: str) -> tuple[str, str]:
    """Split 'Petitioner Versus Respondent' style titles into parties."""
    parts = _VS_PATTERN.split(title, maxsplit=1)
    if len(parts) == 2:
        return clean_text(parts[0]), clean_text(parts[1])
    return clean_text(title), ""


# ─────────────────────────────────────────────────────────────────────
# Bench slug generation
# ─────────────────────────────────────────────────────────────────────

def make_bench_slug(prefix: str, bench_raw: str | None) -> str:
    """Create a URL-safe bench slug: 'itat_del', 'cat_mumbai', etc."""
    if not bench_raw:
        return prefix

    slug = bench_raw.lower().strip()
    # Remove common suffixes
    for remove in ["bench", "tribunal", "principal", "hon'ble", "court -"]:
        slug = slug.replace(remove, "")
    slug = slug.strip()
    # Collapse whitespace/punctuation to underscore
    slug = re.sub(r"[^a-z0-9]+", "_", slug).strip("_")
    # Truncate long slugs
    if len(slug) > 30:
        slug = slug[:30].rstrip("_")
    return f"{prefix}_{slug}" if slug else prefix


# ─────────────────────────────────────────────────────────────────────
# Case ID generation — deterministic, dedup-safe
# ─────────────────────────────────────────────────────────────────────

def make_case_id(
    tribunal_slug: str,
    case_number: str | None,
    fallback_fields: dict,
    *,
    include_context: bool = False,
) -> str:
    """
    Generate a deterministic case_id.
    Uses tribunal slug + case_number when available.
    Falls back to hashing key fields for uniqueness.

    When include_context=True, includes bench+year in the hash to disambiguate
    tribunals where the same case number appears across benches/years (e.g. CAT).
    """
    if case_number:
        normalized = re.sub(r"[^A-Za-z0-9]", "", case_number.upper())
        if include_context:
            # Include bench and year to disambiguate across benches
            ctx = json.dumps(fallback_fields, sort_keys=True, default=str)
            ctx_hash = hashlib.md5(ctx.encode(), usedforsecurity=False).hexdigest()[:8]
            return f"{tribunal_slug.upper()}_{normalized}_{ctx_hash}"
        return f"{tribunal_slug.upper()}_{normalized}"

    # Fallback: hash key fields
    hashable = json.dumps(fallback_fields, sort_keys=True, default=str)
    short_hash = hashlib.md5(hashable.encode(), usedforsecurity=False).hexdigest()[:12]
    return f"{tribunal_slug.upper()}_{short_hash}"


# ─────────────────────────────────────────────────────────────────────
# Title generation
# ─────────────────────────────────────────────────────────────────────

def make_title(
    case_number: str | None,
    petitioner: str | None,
    respondent: str | None,
    year: int | None,
) -> str:
    """Generate a display title from case details."""
    parts = []
    if petitioner:
        pet = petitioner[:80] + "..." if len(petitioner) > 80 else petitioner
        parts.append(pet)
    if respondent:
        resp = respondent[:80] + "..." if len(respondent) > 80 else respondent
        parts.append("Vs")
        parts.append(resp)
    if case_number:
        parts.append(f"[{case_number}]")
    if year:
        parts.append(f"({year})")
    return " ".join(parts) if parts else (case_number or "Unknown")


# ─────────────────────────────────────────────────────────────────────
# Judges parsing — handles string, list, and comma-separated
# ─────────────────────────────────────────────────────────────────────

def parse_judges(raw: Any) -> list[str]:
    """Normalize judges field to a list of strings."""
    if not raw:
        return []
    if isinstance(raw, list):
        return [clean_text(j) for j in raw if j and str(j).strip()]
    if isinstance(raw, str):
        cleaned = clean_text(raw)
        if not cleaned:
            return []
        # Split on common delimiters
        for delim in [",", " and ", "&", ";", "\n"]:
            if delim in cleaned:
                return [j.strip() for j in cleaned.split(delim) if j.strip()]
        return [cleaned]
    return []


# ─────────────────────────────────────────────────────────────────────
# PDF URL handling — list or string
# ─────────────────────────────────────────────────────────────────────

def get_pdf_url(raw: Any) -> str | None:
    """Extract single PDF URL from string or list."""
    if not raw:
        return None
    if isinstance(raw, list):
        return raw[0] if raw else None
    return str(raw)


# ─────────────────────────────────────────────────────────────────────
# NCLT record flattener — nested search_result
# ─────────────────────────────────────────────────────────────────────

def flatten_nclt_record(record: dict[str, Any]) -> dict[str, Any]:
    """
    NCLT records have a nested 'search_result' dict with 40+ fields.
    Flatten it into the top-level record, prefixing with 'sr_' to avoid conflicts.
    """
    search_result = record.get("search_result")
    if not isinstance(search_result, dict):
        return record

    flat = {}
    for key, val in record.items():
        if key != "search_result":
            flat[key] = val

    # Promote key search_result fields to top level for field_map access
    sr_promotions = {
        "case_no": "case_no",
        "case_title1": "case_title1",
        "case_title2": "case_title2",
        "case_type_desc_cis": "case_type_desc",
        "date_of_filing": "date_of_filing",
        "disposal_date": "disposal_date",
        "action_type": "action_type",
        "status": "case_status",
        "bench_location_name": "bench_location",
    }
    for sr_key, flat_key in sr_promotions.items():
        if sr_key in search_result and flat_key not in flat:
            flat[flat_key] = search_result[sr_key]

    # Store ALL search_result fields in raw_metadata (normalizer will pick them up)
    for key, val in search_result.items():
        sr_key = f"sr_{key}"
        if sr_key not in flat:
            flat[sr_key] = val

    return flat


# ─────────────────────────────────────────────────────────────────────
# Core normalizer
# ─────────────────────────────────────────────────────────────────────

def normalize_record(
    record: dict[str, Any],
    config: TribunalConfig,
    source_path: str = "",
) -> dict[str, Any]:
    """
    Normalize a raw JSONL record to the common corpus schema.

    Returns a dict with:
      - All common fields (matching legal_corpus_v1/v2 payload)
      - tribunal: slug identifier
      - tribunal-specific extras (flat)
      - raw_metadata: ALL unmapped raw fields preserved
      - source_pdf_url: original PDF URL (preserved when hosting on R2)
    """
    # NCLT has nested search_result — flatten first
    if config.slug == "nclt":
        record = flatten_nclt_record(record)

    fmap = config.field_map

    # ── Map common fields ──
    petitioner = record.get(
        _find_source_field(fmap, "petitioner"), ""
    ) or ""
    respondent = record.get(
        _find_source_field(fmap, "respondent"), ""
    ) or ""
    raw_case_number = record.get(
        _find_source_field(fmap, "case_number"), None
    )
    case_number = str(raw_case_number) if raw_case_number is not None else None
    raw_date = record.get(
        _find_source_field(fmap, "decision_date"), None
    )
    raw_bench = record.get(
        _find_source_field(fmap, "bench"), None
    )
    raw_judges = record.get(
        _find_source_field(fmap, "judges"), None
    )
    raw_case_type = record.get(
        _find_source_field(fmap, "case_type"), None
    )
    raw_title = record.get(
        _find_source_field(fmap, "title"), None
    )
    raw_pdf_url = record.get(
        _find_source_field(fmap, "pdf_url"), None
    )
    raw_source_url = record.get(
        _find_source_field(fmap, "source_url"),
        record.get("source_url", None),
    )

    # ── Clean text fields (HTML artifacts from TDSAT, etc.) ──
    petitioner = clean_text(petitioner)
    respondent = clean_text(respondent)

    # ── ITAT: split city from party names (e.g. "ATUL MARDIA,NEW DELHI") ──
    petitioner_city = ""
    respondent_city = ""
    if config.slug == "itat":
        petitioner, petitioner_city = split_party_city(petitioner)
        respondent, respondent_city = split_party_city(respondent)

    # ── APTEL / CCI: parse petitioner/respondent from title ──
    if not petitioner and raw_title and config.slug in ("aptel",):
        petitioner, respondent = parse_parties_from_title(str(raw_title))

    # ── NCLT: use case_title1/case_title2 for petitioner/respondent ──
    if config.slug == "nclt":
        if not petitioner:
            petitioner = clean_text(record.get("case_title1", ""))
        if not respondent:
            respondent = clean_text(record.get("case_title2", ""))
        if not case_number:
            case_number = record.get("case_no")
        if not raw_date:
            raw_date = record.get("disposal_date") or record.get("date_of_filing")

    # ── GST AAR: extract date from order_no_date field ──
    # e.g. "GUJ/GAAR/R/2025/58/dated 29.11.2025"
    if not raw_date and config.slug == "gst_aar":
        order_no_date = record.get("order_no_date", "")
        if order_no_date:
            raw_date = str(order_no_date)  # parse_date handles "dated DD.MM.YYYY"

    # ── Derived fields ──
    decision_date = parse_date(raw_date)
    year = extract_year(decision_date)

    # Fallback: use case_year when date parsing fails (CAT has bad dates)
    if not year:
        raw_year = record.get("case_year") or record.get("year")
        if raw_year:
            try:
                yr = int(str(raw_year)[:4])
                if 1900 <= yr <= 2100:
                    year = yr
            except (ValueError, TypeError):
                pass

    bench = make_bench_slug(config.bench_prefix, raw_bench)
    judges = parse_judges(raw_judges)
    pdf_url = get_pdf_url(raw_pdf_url)

    # MahaRERA: PDFs are locally saved (base64 from API), no public URL
    # Use pdf_filename to construct local path reference for R2 upload later
    if not pdf_url and record.get("has_pdf") and record.get("pdf_filename"):
        pdf_url = f"local://rera-maharera/pdfs/{record['pdf_filename']}"

    # ── Local PDF overrides ──
    # PDFs were downloaded during scraping. Map to local:// paths for R2 upload.
    # Preserves original remote URL in source_pdf_url for reference.
    original_remote_url = None

    if config.slug == "sat" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        appeal_type = (record.get("appeal_type") or "").lower()
        pdf_url = f"local://sat/pdfs/{appeal_type}/{record['pdf_filename']}"

    elif config.slug == "aptel":
        fnames = record.get("pdf_filenames", [])
        if fnames:
            original_remote_url = pdf_url
            year = record.get("year", "unknown")
            pdf_url = f"local://aptel/pdfs/{year}/{fnames[0]}"

    elif config.slug == "cci":
        fnames = record.get("pdf_filenames", [])
        if fnames:
            original_remote_url = pdf_url
            category = record.get("category", "unknown")
            pdf_url = f"local://cci/pdfs/{category}/{fnames[0]}"

    elif config.slug == "cestat" and record.get("pdf_id"):
        original_remote_url = pdf_url
        bench_val = (record.get("bench") or "unknown").lower()
        pdf_url = f"local://cestat/orders/{bench_val}/{record['pdf_id']}.pdf"

    elif config.slug == "rera_punjab" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        pdf_url = f"local://rera-punjab/pdfs/{record['pdf_filename']}"

    elif config.slug == "itat" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        pdf_url = f"local://itat/pdfs/{record['pdf_filename']}"

    elif config.slug == "cat" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        bench_slug = record.get("bench_slug", "unknown")
        pdf_url = f"local://cat/pdfs/{bench_slug}/{record['pdf_filename']}"

    elif config.slug == "ngt" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        ngt_bench = (record.get("bench") or "unknown").lower()
        pdf_url = f"local://ngt/pdfs/{ngt_bench}/{record['pdf_filename']}"

    elif config.slug == "atfp" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        pdf_url = f"local://atfp/pdfs/{record['pdf_filename']}"

    elif config.slug == "gst_aar" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        ruling_type = (record.get("ruling_type") or "aar").lower()
        pdf_url = f"local://gst-aar/pdfs/{ruling_type}/{record['pdf_filename']}"

    elif config.slug == "ibbi" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        # IBBI PDFs organized by source: pdfs/{nclt,nclat,ibbi,ipa-rvo,high-courts}/
        ibbi_subdir = "ibbi"
        if source_path:
            src_name = Path(source_path).stem  # e.g., "nclt-orders"
            ibbi_subdir = src_name.replace("-orders", "").replace(".jsonl", "")
        pdf_url = f"local://ibbi/pdfs/{ibbi_subdir}/{record['pdf_filename']}"

    elif config.slug == "tdsat" and record.get("filename"):
        original_remote_url = pdf_url
        pdf_url = f"local://tdsat/judgments/{record['filename']}"

    elif config.slug == "rera_delhi" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        pdf_url = f"local://rera-delhi/pdfs/{record['pdf_filename']}"

    elif config.slug == "drt" and record.get("pdf_filename"):
        original_remote_url = pdf_url
        pdf_url = f"local://drt/pdfs/{record['pdf_filename']}"

    elif config.slug == "nclt":
        sr = record.get("search_result", {})
        case_no = sr.get("case_no", "") if sr else record.get("case_no", "")
        if case_no:
            original_remote_url = pdf_url
            # Extract bench folder from source JSONL filename (e.g., ahmedabad-cases.jsonl → ahmedabad)
            nclt_bench = "unknown"
            if source_path:
                src_name = Path(source_path).stem  # e.g., "ahmedabad-cases"
                nclt_bench = src_name.replace("-cases", "")
            safe_case = case_no.replace("/", "_")
            pdf_url = f"local://nclt/pdfs/{nclt_bench}/{safe_case}.pdf"

    # CAT has non-unique case numbers across benches/years — include context
    # CAT CIS has daily orders: same case has multiple orders on different dates
    needs_context = config.slug in ("cat", "cat_cis")
    fallback = {"petitioner": petitioner, "date": decision_date, "bench": bench}
    if needs_context:
        fallback["case_type"] = str(raw_case_type) if raw_case_type else None
        fallback["year"] = year
    case_id = make_case_id(
        config.slug,
        case_number,
        fallback,
        include_context=needs_context,
    )

    if raw_title:
        title = clean_text(str(raw_title))
    else:
        title = make_title(case_number, petitioner, respondent, year)

    # ── Resolve country_code from raw data ──
    country_code = (
        record.get("country_code")
        or _country_to_code(record.get("country"))
        or "IN"
    )

    # ── Build tribunal_extra with unique fields ──
    tribunal_extra = {}
    for field_name in config.extra_fields:
        val = record.get(field_name)
        if val is not None:
            tribunal_extra[field_name] = val

    # ── ITAT: normalize assessment_year and add city ──
    if config.slug == "itat":
        raw_ay = tribunal_extra.get("assessment_year")
        if raw_ay:
            tribunal_extra["assessment_year"] = normalize_assessment_year(raw_ay)
        if petitioner_city:
            tribunal_extra["petitioner_city"] = petitioner_city
        if respondent_city:
            tribunal_extra["respondent_city"] = respondent_city

    # ── Collect ALL consumed field names (mapped + extra) ──
    consumed_fields = set(config.extra_fields)
    for raw_name in config.field_map:
        consumed_fields.add(raw_name)
    # Also consumed by direct access
    consumed_fields.update({
        "scraped_at", "source_url", "country", "country_code",
        "tribunal", "search_result",
        # NCLT promoted fields
        "case_title1", "case_title2", "case_no",
        "disposal_date", "date_of_filing",
    })

    # ── Preserve ALL unmapped raw fields ──
    # "more unused metadata is better than less"
    raw_unmapped = {}
    for key, val in record.items():
        if key not in consumed_fields and val is not None:
            raw_unmapped[key] = val

    # ── Common schema output (matching corpus payload) ──
    normalized = {
        # Identification
        "case_id": case_id,
        "case_number": case_number,
        # Court
        "court": config.name,
        "court_type": config.court_type,
        "bench": bench,
        "bench_strength": 0,
        # Geography
        "country_code": country_code,
        "state_code": None,
        "state_name": None,
        "language_code": "en",
        # Case details
        "decision_date": f"{decision_date} 00:00:00" if decision_date else None,
        "year": year,
        "disposition": None,
        "case_type": str(raw_case_type) if raw_case_type else None,
        # Parties
        "petitioner": petitioner,
        "respondent": respondent,
        "judges": judges,
        # Display
        "title": title,
        "description": title,
        # Legal references (populated during backfill from PDF text)
        "acts_referenced": [],
        "cases_cited": [],
        "cited_by_count": 0,
        # PDF — source_pdf_url preserves the original URL from tribunal site
        # pdf_url will be updated to R2 URL after upload
        "pdf_url": pdf_url,
        "source_pdf_url": original_remote_url or pdf_url,
        "source_url": raw_source_url,
        # Tribunal identifier
        "tribunal": config.slug,
        # Tribunal-specific extras (stored as flat payload fields in Qdrant)
        **tribunal_extra,
        # All remaining raw fields not consumed by field_map or extra_fields
        "raw_metadata": raw_unmapped,
        # Source tracking
        "scraped_at": record.get("scraped_at"),
        "normalized_at": datetime.now(timezone.utc).isoformat(),
        "source_file": source_path,
    }

    return normalized


def _find_source_field(field_map: dict[str, str], target: str) -> str:
    """
    Find the raw field name that maps to a target common field.
    field_map is {raw_name: common_name}, so we reverse-lookup.
    """
    for raw_name, common_name in field_map.items():
        if common_name == target:
            return raw_name
    return target  # fallback: same name


def _country_to_code(country: str | None) -> str | None:
    """Convert country name to ISO code."""
    if not country:
        return None
    lower = country.strip().lower()
    if lower in ("in", "india"):
        return "IN"
    return country.strip().upper()[:2] if len(country.strip()) == 2 else None


# ─────────────────────────────────────────────────────────────────────
# Judgment filter
# ─────────────────────────────────────────────────────────────────────

def is_judgment(
    record: dict[str, Any],
    config: TribunalConfig,
    source_path: str = "",
) -> bool:
    """
    Determine if a record is a judgment (should be RAG'd) vs order (listing only).
    Uses the judgment_filter rule from the tribunal config.
    """
    jf = config.judgment_filter
    if not jf:
        return False

    rule = jf.get("rule")
    field_name = jf.get("field", "")
    value = jf.get("value", "")

    if rule == "always_true":
        return True
    elif rule == "not_empty":
        return bool(record.get(field_name, ""))
    elif rule == "equals":
        return str(record.get(field_name, "")).lower() == str(value).lower()
    elif rule == "contains":
        if field_name == "_path":
            # Support comma-separated values for multi-pattern path matching
            for v in str(value).split(","):
                if v.strip() in source_path:
                    return True
            return False
        return value.lower() in str(record.get(field_name, "")).lower()
    return False


# ─────────────────────────────────────────────────────────────────────
# Batch processing
# ─────────────────────────────────────────────────────────────────────

def normalize_file(
    tribunal_slug: str,
    input_path: str,
    output_path: str | None = None,
    judgments_only: bool = False,
    sample_limit: int = 0,
    dedup: bool = True,
) -> dict[str, int]:
    """
    Normalize an entire JSONL file.

    Returns stats: {total, normalized, judgments, orders, errors, duplicates, no_pdf}
    """
    config = get_tribunal(tribunal_slug)
    stats = {
        "total": 0, "normalized": 0, "judgments": 0, "orders": 0,
        "errors": 0, "duplicates": 0, "no_pdf": 0,
    }
    seen_case_ids: set[str] = set()

    output_file = None
    if output_path:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        output_file = open(output_path, "w")

    try:
        with open(input_path) as f:
            for line_num, line in enumerate(f, 1):
                if sample_limit and stats["normalized"] >= sample_limit:
                    break

                stats["total"] += 1
                line = line.strip()
                if not line:
                    continue

                try:
                    record = json.loads(line)
                except json.JSONDecodeError as e:
                    stats["errors"] += 1
                    if stats["errors"] <= 5:
                        print(f"  JSON error line {line_num}: {e}", file=sys.stderr)
                    continue

                # Skip records without PDF URL (no value for RAG pipeline)
                raw_pdf_field = _find_source_field(config.field_map, "pdf_url")
                raw_pdf = record.get(raw_pdf_field)
                if isinstance(raw_pdf, list):
                    has_pdf = bool(raw_pdf)
                else:
                    has_pdf = bool(raw_pdf)
                # Allow local:// refs (MahaRERA etc.) through via has_pdf or pdf_filename
                if not has_pdf and not record.get("has_pdf") and not record.get("pdf_filename"):
                    stats["no_pdf"] += 1
                    continue

                judgment = is_judgment(record, config, input_path)
                if judgment:
                    stats["judgments"] += 1
                else:
                    stats["orders"] += 1

                if judgments_only and not judgment:
                    continue

                try:
                    normalized = normalize_record(record, config, input_path)
                    normalized["is_judgment"] = judgment

                    # Dedup by case_id
                    if dedup:
                        cid = normalized.get("case_id", "")
                        if cid in seen_case_ids:
                            stats["duplicates"] += 1
                            continue
                        seen_case_ids.add(cid)

                    stats["normalized"] += 1

                    if output_file:
                        output_file.write(json.dumps(normalized, default=str) + "\n")
                except Exception as e:
                    stats["errors"] += 1
                    if stats["errors"] <= 5:
                        print(
                            f"  Normalize error line {line_num}: {e}",
                            file=sys.stderr,
                        )
    finally:
        if output_file:
            output_file.close()

    return stats


def normalize_tribunal(
    tribunal_slug: str,
    output_dir: str,
    judgments_only: bool = False,
    sample_limit: int = 0,
) -> dict[str, int]:
    """Normalize all JSONL files for a tribunal."""
    config = get_tribunal(tribunal_slug)
    total_stats = {
        "total": 0, "normalized": 0, "judgments": 0, "orders": 0,
        "errors": 0, "duplicates": 0, "no_pdf": 0,
    }

    if not config.jsonl_paths:
        print(f"  {tribunal_slug}: no JSONL files configured, skipping")
        return total_stats

    output_path = os.path.join(output_dir, f"{tribunal_slug}.jsonl")

    # Process all JSONL files, appending to single output
    first_file = True
    for rel_path in config.jsonl_paths:
        input_path = str(DATA_DIR / rel_path)
        if not os.path.exists(input_path):
            print(f"  {tribunal_slug}: file not found: {rel_path}", file=sys.stderr)
            continue

        # First file creates, subsequent append
        if not first_file:
            temp_path = output_path + ".tmp"
            stats = normalize_file(
                tribunal_slug, input_path, temp_path, judgments_only, sample_limit
            )
            # Append temp to output
            with open(temp_path) as src, open(output_path, "a") as dst:
                for line in src:
                    dst.write(line)
            os.remove(temp_path)
        else:
            stats = normalize_file(
                tribunal_slug, input_path, output_path, judgments_only, sample_limit
            )
            first_file = False

        for k in total_stats:
            total_stats[k] += stats[k]

    return total_stats


# ─────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Normalize tribunal metadata to common schema")
    parser.add_argument(
        "--tribunal",
        type=str,
        help="Tribunal slug (e.g., itat, cat, drt). Use --all for all tribunals.",
    )
    parser.add_argument("--all", action="store_true", help="Normalize all tribunals")
    parser.add_argument(
        "--output-dir",
        type=str,
        default=str(DATA_DIR / "normalized"),
        help="Output directory for normalized JSONL files",
    )
    parser.add_argument(
        "--judgments-only",
        action="store_true",
        help="Only output records identified as judgments (skip orders)",
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=0,
        help="Only process first N records per file (for testing)",
    )

    args = parser.parse_args()

    if not args.tribunal and not args.all:
        parser.error("Specify --tribunal SLUG or --all")

    os.makedirs(args.output_dir, exist_ok=True)

    if args.all:
        slugs = list(get_all_tribunals().keys())
    else:
        slugs = [args.tribunal]

    print(f"Normalizing {len(slugs)} tribunal(s) → {args.output_dir}/")
    if args.judgments_only:
        print("  Mode: judgments only (orders skipped)")
    if args.sample:
        print(f"  Mode: sample (first {args.sample} records per file)")
    print()

    grand_total = {
        "total": 0, "normalized": 0, "judgments": 0, "orders": 0,
        "errors": 0, "duplicates": 0, "no_pdf": 0,
    }

    for slug in slugs:
        try:
            config = get_tribunal(slug)
        except KeyError:
            print(f"  Unknown tribunal: {slug}", file=sys.stderr)
            continue

        print(f"  {slug} ({config.name})...")
        stats = normalize_tribunal(slug, args.output_dir, args.judgments_only, args.sample)

        for k in grand_total:
            grand_total[k] += stats[k]

        print(
            f"    total={stats['total']} normalized={stats['normalized']} "
            f"judgments={stats['judgments']} orders={stats['orders']} "
            f"dupes={stats['duplicates']} no_pdf={stats['no_pdf']} "
            f"errors={stats['errors']}"
        )

    print(f"\n=== GRAND TOTAL ===")
    print(
        f"  total={grand_total['total']} normalized={grand_total['normalized']} "
        f"judgments={grand_total['judgments']} orders={grand_total['orders']} "
        f"dupes={grand_total['duplicates']} no_pdf={grand_total['no_pdf']} "
        f"errors={grand_total['errors']}"
    )


if __name__ == "__main__":
    main()
