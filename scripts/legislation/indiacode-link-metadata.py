#!/usr/bin/env python3
"""
Link IndiaCode HTML extracts and PDFs into the index JSONL metadata.

Adds to each index entry:
  - pdfPath: relative path to the main PDF (if found)
  - htmlPath: relative path to the HTML JSON extract (if found)
  - htmlHasSections: bool - whether the HTML extract has parsed section text
  - htmlSectionCount: int - number of sections in HTML extract
  - subordinatePdfs: list of relative paths to subordinate legislation PDFs
  - dataSource: "html" | "pdf" | "both" | "none" - what's available for RAG

Writes enriched index to data/indiacode/index-linked/
Also writes a summary report.
"""

import json
import os
import re
import glob
from pathlib import Path

BASE = Path(".")
PDF_DIR = BASE / "pdfs"
HTML_DIR = BASE / "html"
SUB_DIR = BASE / "subordinate"
INDEX_DIR = BASE / "index"
OUTPUT_DIR = BASE / "index-linked"

OUTPUT_DIR.mkdir(exist_ok=True)


def normalize_title(title: str) -> str:
    """Normalize title for fuzzy matching."""
    t = title.lower().strip()
    t = re.sub(r"[^a-z0-9\s]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def title_to_pdf_slug(title: str) -> str:
    """Convert title to expected PDF filename slug."""
    t = title.lower().strip()
    t = re.sub(r"[^a-z0-9\s]", "", t)
    t = re.sub(r"\s+", "-", t).strip("-")
    return t


def build_pdf_index() -> dict:
    """Map normalized PDF names -> relative paths."""
    pdf_map = {}
    for root, _, files in os.walk(PDF_DIR):
        for f in files:
            if not f.endswith(".pdf"):
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, BASE)
            # Key: filename without .pdf, without trailing _year
            name = f.replace(".pdf", "")
            name_no_year = re.sub(r"_\d{4}$", "", name)
            slug = name_no_year.replace("-", " ").strip()
            pdf_map[slug] = rel
            # Also index with the full name (including year suffix)
            full_slug = name.replace("-", " ").strip()
            pdf_map[full_slug] = rel
    return pdf_map


def build_html_index() -> dict:
    """Map handle -> (relative path, sectionCount, sections data)."""
    html_map = {}
    for f in glob.glob(str(HTML_DIR / "**" / "*.json"), recursive=True):
        try:
            d = json.load(open(f))
        except (json.JSONDecodeError, IOError):
            continue
        handle = d.get("handle", "")
        rel = os.path.relpath(f, BASE)
        sc = d.get("sectionCount", 0)
        title = d.get("title", "")
        html_map[handle] = {
            "path": rel,
            "sectionCount": sc,
            "hasSections": sc > 0,
            "title": title,
        }
    return html_map


def build_subordinate_index() -> dict:
    """Map parent act slug -> list of subordinate PDF relative paths."""
    sub_map = {}
    if not SUB_DIR.exists():
        return sub_map
    for state_dir in SUB_DIR.iterdir():
        if not state_dir.is_dir():
            continue
        for act_dir in state_dir.iterdir():
            if not act_dir.is_dir():
                continue
            pdfs = sorted(
                os.path.relpath(str(act_dir / f), str(BASE))
                for f in os.listdir(act_dir)
                if f.endswith(".pdf")
            )
            if pdfs:
                slug = act_dir.name.replace("-", " ").strip()
                key = f"{state_dir.name}/{slug}"
                sub_map[key] = pdfs
    return sub_map


def match_pdf(title: str, year: str, state: str, pdf_map: dict) -> str | None:
    """Try multiple strategies to match a title to a PDF."""
    slug = title_to_pdf_slug(title)

    # Strategy 1: exact slug match
    norm = slug.replace("-", " ")
    if norm in pdf_map:
        return pdf_map[norm]

    # Strategy 2: slug_year
    with_year = f"{norm} {year}" if year else None
    if with_year and with_year.replace(" ", "-") in pdf_map:
        return pdf_map[with_year.replace(" ", "-")]

    # Strategy 3: slug with year appended as filename convention
    slug_year = f"{slug} {year}"
    if slug_year in pdf_map:
        return pdf_map[slug_year]

    return None


def match_subordinate(title: str, state: str, sub_map: dict) -> list:
    """Find subordinate PDFs for an act."""
    # title_to_pdf_slug returns hyphens, sub_map keys use spaces
    slug_hyphen = title_to_pdf_slug(title)
    slug_space = slug_hyphen.replace("-", " ")
    state_slug = state.replace("state-", "") if state.startswith("state-") else state

    # Strategy 1: exact match
    key = f"{state_slug}/{slug_space}"
    if key in sub_map:
        return sub_map[key]

    # Strategy 2: strip year
    slug_no_year = re.sub(r"\s*\d{4}$", "", slug_space).strip()
    key2 = f"{state_slug}/{slug_no_year}"
    if key2 in sub_map:
        return sub_map[key2]

    # Strategy 3: handle truncated dir names + cross-state
    for k, v in sub_map.items():
        k_slug = k.split("/", 1)[1] if "/" in k else k
        if k_slug == slug_space or k_slug == slug_no_year:
            return v
        # Truncated dirs (50 char limit on some filesystems)
        if len(k_slug) >= 45 and (
            slug_space.startswith(k_slug) or slug_no_year.startswith(k_slug)
        ):
            return v

    return []


def main():
    print("Building indexes...")
    pdf_map = build_pdf_index()
    print(f"  PDF index: {len(pdf_map)} entries")

    html_map = build_html_index()
    print(f"  HTML index: {len(html_map)} entries")

    sub_map = build_subordinate_index()
    print(f"  Subordinate index: {len(sub_map)} parent acts")

    stats = {
        "total": 0,
        "pdf_found": 0,
        "html_found": 0,
        "html_with_sections": 0,
        "both": 0,
        "none": 0,
        "subordinate_linked": 0,
        "by_jurisdiction": {},
    }

    index_files = sorted(INDEX_DIR.glob("*.jsonl"))
    print(f"\nProcessing {len(index_files)} index files...")

    for idx_file in index_files:
        jur = idx_file.stem
        out_file = OUTPUT_DIR / idx_file.name
        entries = []

        for line in open(idx_file):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            handle = entry.get("handle", "")
            title = entry.get("title", "")
            year = entry.get("year", "")
            state = entry.get("state", jur.replace("state-", ""))

            # Match HTML
            html_info = html_map.get(handle)
            if html_info:
                entry["htmlPath"] = html_info["path"]
                entry["htmlHasSections"] = html_info["hasSections"]
                entry["htmlSectionCount"] = html_info["sectionCount"]
                entry["htmlExtracted"] = True
                stats["html_found"] += 1
                if html_info["hasSections"]:
                    stats["html_with_sections"] += 1
            else:
                entry["htmlPath"] = None
                entry["htmlHasSections"] = False
                entry["htmlSectionCount"] = 0

            # Match PDF
            pdf_path = match_pdf(title, year, state, pdf_map)
            if pdf_path:
                entry["pdfPath"] = pdf_path
                entry["pdfDownloaded"] = True
                stats["pdf_found"] += 1
            else:
                entry["pdfPath"] = None

            # Match subordinate
            sub_pdfs = match_subordinate(title, state, sub_map)
            if sub_pdfs:
                entry["subordinatePdfs"] = sub_pdfs
                entry["subordinateCount"] = len(sub_pdfs)
                stats["subordinate_linked"] += 1
            else:
                entry["subordinatePdfs"] = []

            # Determine data source
            has_pdf = pdf_path is not None
            has_html = html_info is not None and html_info["hasSections"]
            if has_pdf and has_html:
                entry["dataSource"] = "both"
                stats["both"] += 1
            elif has_html:
                entry["dataSource"] = "html"
            elif has_pdf:
                entry["dataSource"] = "pdf"
            else:
                entry["dataSource"] = "none"
                stats["none"] += 1

            stats["total"] += 1

            # Per-jurisdiction stats
            if jur not in stats["by_jurisdiction"]:
                stats["by_jurisdiction"][jur] = {
                    "total": 0,
                    "pdf": 0,
                    "html_sections": 0,
                    "both": 0,
                    "none": 0,
                }
            js = stats["by_jurisdiction"][jur]
            js["total"] += 1
            if has_pdf:
                js["pdf"] += 1
            if has_html:
                js["html_sections"] += 1
            if has_pdf and has_html:
                js["both"] += 1
            if not has_pdf and not has_html:
                js["none"] += 1

            entries.append(entry)

        # Write enriched index
        with open(out_file, "w") as f:
            for e in entries:
                f.write(json.dumps(e, ensure_ascii=False) + "\n")

        print(f"  {jur}: {len(entries)} entries written")

    # Write summary
    summary_path = OUTPUT_DIR / "_summary.json"
    summary = {
        "total_acts": stats["total"],
        "pdf_linked": stats["pdf_found"],
        "html_linked": stats["html_found"],
        "html_with_sections": stats["html_with_sections"],
        "both_pdf_and_html": stats["both"],
        "no_data_source": stats["none"],
        "subordinate_linked": stats["subordinate_linked"],
        "by_jurisdiction": stats["by_jurisdiction"],
    }
    json.dump(summary, open(summary_path, "w"), indent=2, ensure_ascii=False)

    print(f"\n=== SUMMARY ===")
    print(f"Total acts processed:     {stats['total']}")
    print(f"PDF linked:               {stats['pdf_found']}")
    print(f"HTML linked:              {stats['html_found']}")
    print(f"HTML with sections:       {stats['html_with_sections']}")
    print(f"Both PDF + rich HTML:     {stats['both']}")
    print(f"No data source:           {stats['none']}")
    print(f"Subordinate acts linked:  {stats['subordinate_linked']}")
    print(f"\nOutput: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
