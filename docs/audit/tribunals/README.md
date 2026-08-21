# Tribunals, regulators and legislation: where everything lives

Generated 2026-07-28 from live Supabase and R2.
All counts are exact enumerations, not samples.

## Correction to the earlier audit

An earlier version of [../case-law/tribunals.md](../case-law/tribunals.md) stated that we hold no tribunal data at all.
That was wrong.
It was true only of the two searchable case-law collections, which is what that audit examined.

We hold **813,168 tribunal and regulator matters** and **2,112,201 decision documents** totalling **542 GB**.
They are not in the search index, which is why a court-scoped search never returns them, but the material is there.

## Where each body of material lives

| Material | Records | Store | Searchable |
|---|---:|---|---|
| Supreme Court and High Court judgments | 12,848,644 | search index, `legal_corpus_v1` and `legal_corpus_v2` | full text |
| Central and State legislation | 22,265 enactments, 1,098,577 sections | search index, `acts_india` | full text to section level |
| Tribunal and regulator matters | 813,168 | Supabase `tribunal_*` tables, 15 of them | case index only |
| Tribunal decision documents | 2,112,201 PDFs | R2 `tribunal-judgments` | not indexed |
| Regulator circulars and notifications | 19,352 PDFs | R2 `tribunal-judgments/regulatory/` | not indexed |
| Legislation source documents | 22,074 PDF, 22,075 text, 841 HTML | R2 `acts-india` | backing the search index |
| Parliamentary debates, Law Commission reports, gazette, AIR | 12,317 text files, 6.4 GB | R2 `parliament-debates` | not indexed |

## Tribunal holdings

Each forum has a Supabase table (`tribunal_<slug>`) carrying the case index, and a folder of PDFs under `tribunal-judgments/pdfs/<slug>/`.

| Forum | Matters | Documents | Size (GB) | Period |
|---|---:|---:|---:|---|
| Central Administrative Tribunal (case information system) | 181,429 | 1,260,951 | 10.9 | 2021 to 2025 |
| Central Administrative Tribunal | 162,439 | 166,919 | 144.1 | 1985 to 2023 |
| Customs, Excise and Service Tax Appellate Tribunal | 122,612 | 122,612 | 35.4 | 2000 to 2025 |
| Income Tax Appellate Tribunal | 115,074 | 136,850 | 78.9 | 2021 to 2026 |
| Debts Recovery Tribunal and Appellate Tribunal | 108,395 | 256,411 | 195.8 | 2000 to 2026 |
| National Company Law Tribunal | 63,487 | 108,726 | 45.0 | 1996 to 2026 |
| National Green Tribunal | 34,350 | 34,350 | 12.2 | 2011 to 2026 |
| Securities Appellate Tribunal | 9,296 | 9,296 | 2.4 | 2006 to 2026 |
| Appellate Tribunal for Forfeited Property | 3,359 | 3,359 | 1.0 | 2016 to 2026 |
| Competition Commission of India | 2,944 | 2,944 | 1.6 | 2010 to 2026 |
| Appellate Tribunal for Electricity | 2,707 | 2,707 | 0.7 | 2008 to 2026 |
| GST Authority for Advance Ruling | 2,618 | 2,618 | 8.2 | 2017 to 2025 |
| Insolvency and Bankruptcy Board of India | 1,580 | 1,580 | 2.9 | 2017 to 2026 |
| Real Estate Regulatory Authority | 1,530 | 1,530 | 2.2 | 2018 to 2026 |
| Telecom Disputes Settlement and Appellate Tribunal | 1,348 | 1,348 | 0.9 | 2001 to 2026 |
| **Total** | **813,168** | **2,112,201** | **542** | |

Documents exceed matters because a tribunal usually issues several orders in one case.
For CAT CIS the ratio is roughly seven to one.

## What is missing, and what it would take

### No extracted text for tribunals

The entire tribunal corpus is original PDF.
Across 2,131,553 objects in `tribunal-judgments` there are **5 text files**.
The `metadata/normalized/*.jsonl` files are large, up to 2 GB for NCLT, but they carry only case metadata, not judgment text.

Nothing can be searched, quoted or cited from a tribunal decision until text is extracted.
This is the single largest unlocked asset we hold.

### Enrichment columns exist but are empty

Every `tribunal_*` table defines `headnotes`, `outcome` and `subject_matter`.
All three are empty on all 813,168 rows.
`cited_acts` and `cited_sections` are likewise unpopulated.

`judges` is populated only for CAT (162,430), DRT (108,395), TDSAT (1,348) and RERA (552).

### NCLT PDF coverage is partial

NCLT is the only forum where the case index is ahead of the documents: 36,080 of 63,487 matters carry a PDF link, and `source_pdf_url` is empty for all of them.
Every other forum is at or near 100%.

### Date quality

NCLT holds a record dated year 19 and another at 209.
DRT has 2,694 matters with no year, GST AAR 581, NCLT 397, CAT 11.

## Legislation source documents

`acts-india` holds one folder per enactment, keyed by act identifier:

| Pattern | Meaning |
|---|---|
| `IND_central_<n>` | Central Act |
| `IND_state_<n>` | State or Union Territory legislation |
| `IND_REP_<n>_<year>` | repealed Act |
| `IND_SPENT_<n>_<year>` | spent Act |
| `REG_<regulator>_<ref>` | subordinate rules, regulations, circulars and notifications |

Each folder holds `act.pdf`, `act.txt` and `metadata.json`.
The search index carries `pdf_url` and `text_url` pointing at these, served from a public domain over the bucket.

Totals across the bucket: 22,074 PDF, 22,075 extracted text, 22,076 metadata files, 841 HTML, plus 22,986 pre-chunked `jsonl` files.
Against 22,265 enactments in the search index, roughly 191 have no PDF.

## Two corpora nobody is using

Both are fully text-bearing and neither is indexed.

**`parliament-debates`**, 12,317 text files, 6.4 GB: parliamentary debates, the Constitution, Law Commission reports, the gazette, IPC material and AIR volumes.

## Reproducing this

```bash
python3 scripts/audit/extract_tribunals.py       # Supabase, per forum and year
uv run --with boto3 python scripts/audit/inventory_r2.py   # every object in R2
uv run --with openpyxl python scripts/audit/build_tribunals_report.py
```

Raw dumps land in `scripts/audit/raw/` and are copied to [../data/](../data/).
The R2 walk enumerates about 2.3 million objects and takes roughly 35 minutes.
