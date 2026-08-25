---
license: cc-by-4.0
language:
  - en
pretty_name: Open India Law
size_categories:
  - 10M<n<100M
task_categories:
  - text-retrieval
  - question-answering
  - text-classification
tags:
  - legal
  - india
  - case-law
  - legislation
  - rag
configs:
  - config_name: judgments
    data_files: "in_*_judgments.parquet"
  - config_name: legislation
    data_files: "in_*_legislation.parquet"
  - config_name: regulations
    data_files: "in_*_regulations.parquet"
---

# Open India Law

**Open, structured Indian primary law - plus the scrapers that build it.**
Every judgment of the Supreme Court of India and all 25 High Courts, the decisions of 15
tribunals and regulators, and Central, State and Union Territory legislation down to the
individual section. Normalized to one schema, exclusively from official government sources.

| | Volume | Period |
|---|---:|---|
| Court judgments | 12,848,644 | 1950 to 2025 |
| Tribunal and regulator matters | 813,168 | 1985 to 2026 |
| Enactments | 22,265 | 1806 to 2026 |
| Sections of legislation | 1,098,577 | individually searchable |

District and trial court decisions are **not** included.

## Just want to read the documents?



Parquet is for pipelines. If you want to open an actual judgment or Act:

- **[Browse 22,264 Acts and regulations](https://oss-data-in.vaquill.ai/browse.html)** - pick a
  jurisdiction or a regulator, filter by title, click to open the PDF. Nothing to download.
- **[tribunals.vaquill.ai](http://tribunals.vaquill.ai/)** - tribunal and regulator decisions
  as PDFs, by forum, bench, party and date.
- **[news.vaquill.com](https://news.vaquill.com/)** - Indian courts, regulators and
  legal developments, readable rather than machine-readable.
- **[The raw file listing](https://oss-data-in.vaquill.ai/index.html)** - every published
  file, if you want the Parquet directly.
- Every provision in the legislation and regulator files carries a `source_url` pointing at
  its own PDF, so you can go from a chunk straight to the document it came from.
- Judgment source PDFs are on the AWS Open Data Registry
  ([High Court](https://registry.opendata.aws/indian-high-court-judgments/),
  [Supreme Court](https://registry.opendata.aws/indian-supreme-court-judgments/)); we do not
  re-host them.

## Courts



| Court | Judgments | Earliest | Latest |
|---|---:|---|---|
| Supreme Court of India | 34,954 | 1950 | 2025 |
| Patna High Court | 1,615,041 | 1967 | 2025 |
| Bombay High Court | 1,595,948 | 1953 | 2025 |
| Allahabad High Court | 1,498,250 | 1992 | 2025 |
| Madras High Court | 1,494,952 | 1997 | 2025 |
| Telangana High Court | 1,004,138 | 1963 | 2025 |
| Kerala High Court | 916,190 | 1950 | 2024 |
| Karnataka High Court | 581,276 | 1998 | 2025 |
| Chhattisgarh High Court | 508,791 | 1970 | 2025 |
| Punjab and Haryana High Court | 483,253 | 2008 | 2025 |
| Gujarat High Court | 411,638 | 1982 | 2025 |
| Madhya Pradesh High Court | 402,632 | 2000 | 2024 |
| Rajasthan High Court | 324,567 | 1989 | 2025 |
| Delhi High Court | 322,940 | 1960 | 2025 |
| Gauhati High Court | 285,714 | 2000 | 2025 |
| Orissa High Court | 283,063 | 1992 | 2025 |
| Andhra Pradesh High Court | 254,482 | 1995 | 2025 |
| Jharkhand High Court | 246,374 | 1993 | 2025 |
| Calcutta High Court | 202,565 | 1960 | 2025 |
| Himachal Pradesh High Court | 184,175 | 1970 | 2025 |
| Uttarakhand High Court | 123,853 | 1950 | 2025 |
| Jammu and Kashmir High Court | 40,289 | 2003 | 2025 |
| Tripura High Court | 18,942 | 2013 | 2025 |
| Manipur High Court | 7,903 | 2017 | 2025 |
| Meghalaya High Court | 6,261 | 2010 | 2025 |
| Sikkim High Court | 453 | 2000 | 2025 |

## Tribunals and regulators



**Matters** are distinct cases. **Reasoned decisions** is the estimated subset that is a
substantive decision rather than a procedural order sheet, from a sample of 150 documents per
forum - about 348,516 of 2,112,201 documents. Size this tier on that number, not the document
count. Each forum links to the scraper that built it.

| Forum | Matters | Reasoned decisions (est.) | Period |
|---|---:|---:|---|
| [Central Administrative Tribunal (case information system) (CAT CIS)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/cat-cis-scraper.ts) | 181,429 | not measurable | 2021 to 2025 |
| [Central Administrative Tribunal (CAT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/cat-scraper.ts) | 162,439 | 65,599 | 1985 to 2023 |
| [Customs, Excise and Service Tax Appellate Tribunal (CESTAT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/cestat-scraper.ts) | 122,612 | 53,949 | 2000 to 2025 |
| [Income Tax Appellate Tribunal (ITAT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/itat-scraper.ts) | 115,074 | 113,216 | 2021 to 2026 |
| [Debts Recovery Tribunal and Appellate Tribunal (DRT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/drt-scraper.ts) | 108,395 | 75,130 | 2000 to 2026 |
| [National Company Law Tribunal (NCLT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/nclt-efiling-scraper.ts) | 63,487 | 15,222 | 1996 to 2026 |
| [National Green Tribunal (NGT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/ngt-scraper.ts) | 34,350 | 12,366 | 2011 to 2026 |
| [Securities Appellate Tribunal (SAT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/sat-scraper.ts) | 9,296 | 3,653 | 2006 to 2026 |
| [Appellate Tribunal for Forfeited Property (ATFP)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/atfp-scraper.ts) | 3,359 | 2,956 | 2016 to 2026 |
| [Competition Commission of India (CCI)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/cci-scraper.ts) | 2,944 | 1,295 | 2010 to 2026 |
| [Appellate Tribunal for Electricity (APTEL)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/aptel-scraper.ts) | 2,707 | 2,328 | 2008 to 2026 |
| [GST Authority for Advance Ruling (GST AAR)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/gst-aar-scraper.ts) | 2,618 | 961 | 2017 to 2025 |
| [Insolvency and Bankruptcy Board of India (IBBI)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/ibbi-orders-scraper.ts) | 1,580 | 853 | 2017 to 2026 |
| [Real Estate Regulatory Authority (RERA)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/rera-maharera-scraper.ts) | 1,530 | not measurable | 2018 to 2026 |
| [Telecom Disputes Settlement and Appellate Tribunal (TDSAT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/tdsat-judgment-scraper.ts) | 1,348 | 988 | 2001 to 2026 |

Tribunal material is indexed by case, not yet by full text. It is 2.1M PDFs with no text
layer, of which roughly 348,516 are reasoned decisions, and extracting them is a large OCR and
parsing job rather than a quick pass. Supporting scripts live in
[scripts/tribunals/](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/), with per-forum schema in
[scripts/tribunals/schema/](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/tribunals/schema/).

If you are building on this corpus and need that tribunal text, or the same extraction run
over your own sources, we do that work under contract. We have put roughly 16 million Indian
legal PDFs through this pipeline. Email **contact@vaquill.ai**.

## Regulators



Each regulator ships as its own file, `in_<body>_regulations.parquet`, so you can take the
Securities and Exchange Board of India without pulling the Reserve Bank of India.

| Issuing body | Instruments | Provisions |
|---|---:|---:|
| [Ministry of Corporate Affairs (MCA)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/mca-scraper.ts) | 2,666 | 46,480 |
| [Reserve Bank of India (RBI)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/rbi-comprehensive-scraper.ts) | 2,640 | 104,143 |
| [Ministry of Environment, Forest and Climate Change (MOEFCC)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/moefcc-scraper.ts) | 1,399 | 116,227 |
| [Directorate General of Foreign Trade (DGFT)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/dgft-scraper.ts) | 1,233 | 4,252 |
| [Securities and Exchange Board of India (SEBI)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/sebi-scraper.ts) | 1,144 | 88,310 |
| [Telecom Regulatory Authority of India (TRAI)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/trai-scraper.ts) | 834 | 22,720 |
| [Central Pollution Control Board (CPCB)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/cpcb-scraper.ts) | 558 | 13,752 |
| [Ministry of Law and Justice (LAW)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/law-commission-scraper.ts) | 558 | 77,209 |
| State GST and tax authorities (TRIB) | 354 | 41,708 |
| [Insurance Regulatory and Development Authority of India (IRDAI)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/irdai-scraper.ts) | 314 | 16,238 |
| [Department of Financial Services (DFS)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/dfs-scraper.ts) | 283 | 18,509 |
| [Central Board of Indirect Taxes and Customs (CBIC)](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/regulators/cbic-scraper.ts) | 169 | 4,806 |

## Legislation



Sourced from India Code. Every section is held and indexed separately.

Scrapers: [Acts crawler](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/legislation/indiacode-scraper.ts) ·
[HTML section extractor](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/legislation/indiacode-html-extractor.ts) ·
[repealed Acts](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/legislation/indiacode-download-repealed.py) ·
[gap re-scrape](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/legislation/indiacode-rescrape-missing.py) ·
[amendment metadata](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/legislation/indiacode-link-metadata.py) ·
[normalization pipeline](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/legislation/pipeline/run-pipeline.py)

| Jurisdiction | Enactments | Sections | Earliest | Latest |
|---|---:|---:|---|---|
| Central | 13,720 | 628,863 | 1834 | 2026 |
| Assam | 987 | 12,429 | 1806 | 2020 |
| West Bengal | 715 | 32,238 | 1947 | 2024 |
| Rajasthan | 383 | 26,759 | 1860 | 2025 |
| Maharashtra | 379 | 30,271 | 1866 | 2025 |
| Chhattisgarh | 359 | 25,368 | 1860 | 2023 |
| Uttar Pradesh | 338 | 14,308 | 1885 | 2025 |
| Kerala | 322 | 19,164 | 1951 | 2025 |
| Tamil Nadu | 308 | 15,524 | 1864 | 2023 |
| Punjab | 303 | 18,037 | 1887 | 2025 |
| Bihar | 298 | 10,910 | 1894 | 2024 |
| Odisha | 282 | 11,370 | 1908 | 2025 |
| Karnataka | 279 | 29,485 | 1899 | 2025 |
| Telangana | 259 | 16,785 | 1837 | 2024 |
| Chandigarh | 256 | 21,805 | 1860 | 2018 |
| Uttarakhand | 244 | 10,531 | 1901 | 2022 |
| Gujarat | 226 | 12,868 | 1867 | 2025 |
| Madhya Pradesh | 216 | 17,477 | 1860 | 2023 |
| Haryana | 211 | 11,787 | 1897 | 2025 |
| Nagaland | 202 | 4,861 | 1954 | 2024 |
| Himachal Pradesh | 194 | 10,765 | 1952 | 2023 |
| Andhra Pradesh | 190 | 12,264 | 1954 | 2023 |
| Manipur | 187 | 4,560 | 1924 | 2023 |
| Dadra and Nagar Haveli | 169 | 15,619 | 1860 | 2018 |
| Goa | 154 | 14,539 | 1867 | 2024 |
| Jharkhand | 137 | 10,831 | 1887 | 2021 |
| Jammu and Kashmir | 137 | 9,223 | 1945 | 2020 |
| Tripura | 121 | 8,070 | 1926 | 2023 |
| Arunachal Pradesh | 115 | 6,996 | 1891 | 2025 |
| Sikkim | 111 | 4,266 | 1975 | 2022 |
| Meghalaya | 105 | 5,550 | 1970 | 2024 |
| Delhi | 96 | 8,006 | 1870 | 2019 |
| Mizoram | 83 | 2,015 | 1988 | 2023 |
| Puducherry | 78 | 7,117 | 1897 | 2019 |
| Ladakh | 55 | 3,119 | 1945 | 2018 |
| Andaman and Nicobar Islands | 45 | 4,626 | 1894 | 2016 |
| Lakshadweep | 1 | 171 | 1995 | 1995 |

## Parliament



Lok Sabha debates, Law Commission reports and gazette records:
[download-lok-sabha-debates.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/parliament/download-lok-sabha-debates.py).

## Document pipeline



Indian courts and tribunals publish PDFs, very often scanned with no text layer. Turning
those into clean, section-aware, citable text is the hard part, and it is what this project
actually contributes.

| Stage | Script |
|---|---|
| PDF to markdown (text layer) | [pymupdf4llm_parser.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/pymupdf4llm_parser.py) |
| Unified parser across document kinds | [unified_legal_parser.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/unified_legal_parser.py) |
| Section boundary detection | [legal_section_detector.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/legal_section_detector.py), [v2](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/legal_section_detector_v2.py) |
| Section-aware chunking | [legal_chunker.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/legal_chunker.py) |
| Metadata extraction | [metadata_extractor_v3.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/metadata_extractor_v3.py) |
| Parallel chunking driver | [run-chunking-parallel.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/run-chunking-parallel.py), [full pipeline](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/run-pipeline-pymupdf4llm.py) |
| OCR fallback (no text layer) | [ocr-mistral.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/legislation/pipeline/ocr-mistral.py) |
| Chunk schema | [UNIFIED_CHUNKING_SCHEMA.md](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/UNIFIED_CHUNKING_SCHEMA.md) |
| Read AWS Open Data HC parquet | [aws-hc-parquet-reader.py](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/aws-hc-parquet-reader.py) |

A court-structure-aware variant is in [scripts/pipeline/court/](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/court/);
chunking tests in [scripts/pipeline/tests/](https://github.com/Vaquill-AI/open-india-law/blob/main/scripts/pipeline/tests/).

## What you get (output format)



Scrapers write **JSONL** - one normalized record per line - to `$OUT_DIR` (default `./data`), plus source PDFs where the forum publishes them.
No database, no cloud storage, no credentials required.

Legislation records:

| Field | Meaning |
|---|---|
| `act_id` | Stable identifier, e.g. `IND_central_1860_45` |
| `title` | Short title of the Act |
| `chapter` / `section_number` | Position in the Act's hierarchy |
| `section_title` / `text` | Heading and text of the provision |
| `act_status` / `section_status` | `in_force`, `repealed`, `spent` |
| `state` | Jurisdiction (`central` or the State) |
| `year` / `amendment_count` | Enactment year, number of recorded amendments |
| `source_url` | Back-link to the authoritative government page |

Tribunal records:

| Field | Meaning |
|---|---|
| `case_id` | Stable dedup key |
| `case_number` / `title` | Registry number and cause title |
| `bench` / `judges` | Bench and coram |
| `decision_date` / `year` | Date of the order |
| `doc_type` / `is_judgment` | Order, judgment, notice |
| `source_pdf_url` | Back-link to the tribunal's own PDF |

## Download



```python
from datasets import load_dataset

judgments = load_dataset("vaquill/open-india-law", "judgments", split="train")
acts      = load_dataset("vaquill/open-india-law", "legislation", split="train")
regs      = load_dataset("vaquill/open-india-law", "regulations", split="train")

kerala    = load_dataset("vaquill/open-india-law", data_files="in_kerala_judgments.parquet")
sebi      = load_dataset("vaquill/open-india-law", data_files="in_sebi_regulations.parquet")
```

**[huggingface.co/datasets/vaquill/open-india-law](https://huggingface.co/datasets/vaquill/open-india-law)**
· mirror at [oss-data-in.vaquill.ai](https://oss-data-in.vaquill.ai/index.html)

Snapshot `v2026.08`: 26 judgment files (32,572,660 chunks, 53.6 GB), 37 legislation files
and 12 regulator files (1,098,269 provisions between them). Judgment rows are one per **chunk** - group by `case_id` and order by
`chunk_index` to reassemble a judgment.

You do not need to run any scraper below to use the data. They are here so the corpus is
reproducible and auditable.

## Vector embeddings



Every chunk is published with its embedding, as Qdrant per-shard snapshots.

| Collection | Points | Shards | Size | Content |
| --- | --- | --- | --- | --- |
| `legal_corpus_v1` | 19,595,718 | 4 | 272.8 GB | High Court and Supreme Court judgment chunks |
| `legal_corpus_v2` | 11,823,753 | 4 | 179.6 GB | Tribunal and regulator decision chunks |
| `acts_india` | 1,098,577 | 2 | 11.2 GB | Legislation and regulatory provisions |

**32,518,048 vectors, 463.6 GB**, taken from Qdrant 1.16.3.
Embeddings are Voyage AI **voyage-4 series**, 1024 dimensions, cosine distance.
Each collection also carries a named sparse vector used for BM25 hybrid search.

> **Embed your queries with the voyage-4 series.**
> Vectors from a different model live in a different space, so similarity scores against them are not meaningful.

### Import into Qdrant

Snapshots are per-shard, so create the collection first with a matching `shard_number`, then recover each shard.
Qdrant fetches each snapshot itself and verifies the published SHA256 before accepting it.

```bash
# 1. create the collection
curl -X PUT http://localhost:6333/collections/legal_corpus_v1 \
  -H 'Content-Type: application/json' -d '{
    "shard_number": 4,
    "vectors": {"dense": {"size": 1024, "distance": "Cosine", "on_disk": true,
      "quantization_config": {"scalar": {"type": "int8", "quantile": 0.99}}}},
    "sparse_vectors": {"sparse": {}}
  }'

# 2. recover each shard straight from the mirror
BASE=https://oss-data-in.vaquill.ai/qdrant/legal_corpus_v1
for N in 0 1 2 3; do
  SNAP=$(curl -s "$BASE/shard-$N/index.json" | jq -r .snapshot)
  SUM=$(curl -s "$BASE/shard-$N/$SNAP.checksum")
  curl -X PUT "http://localhost:6333/collections/legal_corpus_v1/shards/$N/snapshots/recover" \
    -H 'Content-Type: application/json' \
    -d "{\"location\": \"$BASE/shard-$N/$SNAP\", \"checksum\": \"$SUM\", \"priority\": \"snapshot\"}"
done
```

Use `shard_number: 2` for `acts_india`.
Manifest of every shard, size and checksum: [qdrant/index.json](https://oss-data-in.vaquill.ai/qdrant/index.json).
Full guide including verification and disk requirements: [QDRANT_RESTORE.md](https://github.com/Vaquill-AI/open-india-law/blob/main/data/QDRANT_RESTORE.md).

## Quick start



```bash
pip install -r requirements.txt
npm install                       # the TypeScript scrapers

cp .env.example .env              # optional - only proxies and OCR need keys

# Legislation: India Code (Central + State Acts)
OUT_DIR=./data npx tsx scripts/legislation/indiacode-scraper.ts

# A tribunal (the Income Tax Appellate Tribunal):
OUT_DIR=./data npx tsx scripts/tribunals/itat-scraper.ts

# Turn scraped PDFs/HTML into normalized section records
OUT_DIR=./data python scripts/legislation/pipeline/run-pipeline.py --help
```

Every script is self-documenting - run it with `--help`, or read its module docstring for the exact source and options.

## Sourcing and provenance



Government-only. Every record traces to a court, tribunal or government publisher, and keeps
the source URL it was ingested from. No commercial law reporter and no third-party aggregator
material enters this corpus.

Not every official Indian body publishes on a `.gov.in` domain, so the source list is not
filterable by suffix alone. These are the official portals of the bodies named: the Reserve
Bank of India on `rbi.org.in`, the Pension Fund Regulatory and Development Authority on
`pfrda.org.in`, the Delhi Real Estate Regulatory Authority on `erera.co.in`, and the Bar
Council of India's All India Bar Examination on `allindiabarexamination.com`.

Scrapers identify as `VaquillLegalBot/1.0` and respect each site's `robots.txt`.

**The source judgment PDFs are not republished here.** They are already public under CC BY 4.0
on the AWS Open Data Registry - [High Court](https://registry.opendata.aws/indian-high-court-judgments/)
(~17.8M judgments, ~1.25 TiB) and [Supreme Court](https://registry.opendata.aws/indian-supreme-court-judgments/),
published by Dattam Labs. Re-hosting 1.36 TB of already-public files would add nothing, so
this project publishes the layer they lack: extracted text, chunking, provenance and metadata.

The embeddings ARE published, as Qdrant snapshots. See [Vector embeddings](#vector-embeddings).
Still out of scope: the citation graph, which is coupled to our own infrastructure.

## What has been removed, and why



**Identifying detail that a statute bars from publication.** Indian courts anonymize
sexual-offence victims in the large majority of cases, so this dataset does **not** exclude by
statute category: doing so would remove roughly 180,000 judgments that are lawful to publish
precisely because the court controlled the disclosure. What is redacted is the narrow band
where identity actually leaks:

- names of relatives of victims and of protected children, where the court named them
- telephone numbers and email addresses
- Permanent Account Number, Indian Financial System Code and Aadhaar numbers, each only where
  the surrounding text identifies the number as such

That last condition matters. Those patterns are shape-only and Indian case numbers share the
shapes: `WPCT0123456` is an Indian Financial System Code by shape and `ABCDE1234F` is a
Permanent Account Number by shape. Masking on shape alone corrupts the judgment text, so a
context word is required nearby.

**Documents a court directed not be published**, including in-camera matters. Those sit
outside the statutory exception this corpus relies on.

Counts of what each rule removed are published with each snapshot.

## Reporting a problem



If this corpus contains material that should not be public, write to **contact@vaquill.ai**
with the subject line `Open India Law - redaction request`. Directions of Indian courts and
tribunals are honoured. Because a published snapshot is a fixed artifact with published
checksums, corrections are made by publishing a superseding snapshot rather than editing one
in place.

## Important caveats



**1. Several sources serve Indian traffic only.** India Code in particular returns "The specified URL is inaccessible at this time" to non-Indian IPs while serving its homepage normally.
Run those scrapers from an Indian host, or configure a proxy in `.env`.
If a run returns almost nothing and you are outside India, that is the usual cause.

**2. Some scripts will stop working over time.** These target **live government websites**, which get redesigned, move URLs, change HTML, or add anti-bot measures.
A scraper that worked at publish time can break later.
That usually needs a small parser update, not a rewrite.
Please [open an issue or PR](#contributing) - fixes to individual parsers are exactly where community help compounds.

**3. A browser is needed for some forums.** Most sources are plain HTTP.
A handful render via JavaScript and use Playwright - you will need its browsers installed (`npx playwright install`).

**4. The tribunal corpus is PDF-only.** These forums publish scanned or generated PDFs with no machine-readable text.
Text extraction is a separate step and its quality varies by forum.

**5. Snapshots are point-in-time, not current law.** Indian legislation changes continuously and tribunal orders are appealed.
Output is an archive as of the run date - **always verify against the official source** before relying on it.
This is **not legal advice**.

## Licensing and commercial use



- **Scripts** - Apache-2.0 ([`LICENSE`](https://github.com/Vaquill-AI/open-india-law/blob/main/LICENSE)). Free, including commercial use.
- **Data / compilation** - CC BY 4.0 ([`data/LICENSE.md`](https://github.com/Vaquill-AI/open-india-law/blob/main/data/LICENSE.md)). Free with attribution.
- **The underlying legal text** - a Government work under s.17(d) of the Copyright Act 1957, reproducible under s.52(1)(q). We hold no rights in it and grant none; your right to use it comes from the statute.

**The dataset is free for everyone.** You never need to email us or ask permission to use it, including for commercial products, as long as you attribute it.

Attribution is a **condition our sources impose**, not a preference of ours - the eCourts policy and those of the National Company Law Tribunal and the National Company Law Appellate Tribunal all require the source to be prominently acknowledged.
That is why this corpus is CC BY rather than CC0.

## Want it built for you?



The dataset is free and always will be. Separately, we build legal data pipelines under
contract: bulk extraction from scanned or non-machine-readable sources, OCR at scale,
normalization into a schema you can query, and ongoing refresh.

That is what produced this corpus. If a law firm, publisher or legal-research product needs
data at this scale and cannot get there from the raw sources, email **contact@vaquill.ai**.

## Help keep this current

This release is a snapshot, `v2026.08`. Left alone it goes stale.

The corpus is built by **54 scrapers pointed at government portals**, 30 for tribunals, 17 for
regulators, 5 for legislation and 2 for Parliament.
Those portals change without warning, and when one does, its scraper breaks quietly.
A scraper that returns nothing looks a lot like a source that published nothing.

We publish every scraper so anyone can rebuild the corpus from scratch.
Rebuilding it on a schedule is a different problem, and it needs more hands than we have.

**The most useful thing you can do is adopt one source.**
Pick a forum or a regulator you already care about, watch its scraper, and send a PR when it
breaks. One person watching one court is worth more than an occasional sweep across all of them,
because you will notice the change in a week rather than at the next release.

Also genuinely useful, and quick:

- **Verified copyright and terms pages for the 24 sources still marked `terms_status: unknown`
  in [coverage.yml](https://github.com/Vaquill-AI/open-india-law/blob/main/coverage.yml).** Most are unreachable from outside India, so this needs
  someone on an Indian IP. Each one unblocks a corpus.
- **Coverage gaps.** If you know a court or regulator publishes something we have not captured,
  open an issue with the URL.
- **Bad records.** A wrong section number, a truncated judgment, a mislabelled status. Open an
  issue with the `act_id` or `case_id` and we can trace it.

If enough sources get adopted we will move to a regular refresh rather than one-off snapshots.
That is the goal, and it is the part we cannot do alone.

## Contributing

New-source parsers, coverage fixes, and especially **repairs to scrapers that broke when a
government site changed** are welcome.
Open a PR against the relevant script in the tables above.

## Maintained by



[Vaquill AI](https://www.vaquill.ai). Full measured coverage, including year-by-year tables
and the held-vs-embedded reconciliation, is in [COVERAGE.md](https://github.com/Vaquill-AI/open-india-law/blob/main/COVERAGE.md).

Questions, ideas, or want to help? DM me on [LinkedIn](https://www.linkedin.com/in/zriyansh/).

---

*The law is public. Making it usable should be too.*
