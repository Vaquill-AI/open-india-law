# Allahabad High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 1,498,250 |
| Text chunks in Qdrant | 1,929,559 |
| Metadata rows in Supabase `legal_cases` | 1,498,245 |
| Earliest decision | 1973-07-10 |
| Latest decision (data cutoff) | 2025-12-17 |
| Years with at least one case | 15 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 2,275 |
| Supabase rows with a PDF (`r2_url`) | 1,498,245 |
| Supabase rows flagged full text | 1,498,245 |
| Supabase rows with a case name | 1,497,864 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `Allahabad High Court` | v1 | 1,924,170 | 1,496,558 |
| `Allahabad High Court` | v2 | 3,462 | 2,357 |
| `High Court of Allahabad` | v1 | 1,918 | 1,603 |
| `High Court of Allahabad` | v2 | 9 | 7 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1992 | 2 | 2 | 1.0 | 2 | 0 |
| 1993 | 1 | 1 | 1.0 | 1 | 0 |
| 2006 | 1 | 1 | 1.0 | 1 | 0 |
| 2007 | 1 | 2 | 2.0 | 1 | 0 |
| 2008 | 1 | 1 | 1.0 | 1 | 0 |
| 2010 | 21 | 30 | 1.4 | 21 | 0 |
| 2012 | 1 | 1 | 1.0 | 1 | 0 |
| 2018 | 187,947 | 228,194 | 1.2 | 187,627 | 320 |
| 2019 | 228,086 | 276,318 | 1.2 | 227,728 | 358 |
| 2020 | 122,715 | 153,698 | 1.3 | 122,436 | 279 |
| 2021 | 171,555 | 217,484 | 1.3 | 171,290 | 265 |
| 2022 | 272,085 | 353,404 | 1.3 | 271,667 | 418 |
| 2023 | 273,167 | 369,052 | 1.4 | 272,768 | 399 |
| 2024 | 84,396 | 119,090 | 1.4 | 84,324 | 72 |
| 2025 | 160,546 | 212,281 | 1.3 | 160,377 | 169 |
| **Total** | **1,500,525** | **1,929,559** | | **1,498,245** | |

The year rows sum to 1,500,525 because 2,275 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **1,498,250**.
