# Calcutta High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 202,565 |
| Text chunks in Qdrant | 323,606 |
| Metadata rows in Supabase `legal_cases` | 202,564 |
| Earliest decision | 1950-08-14 |
| Latest decision (data cutoff) | 2025-11-27 |
| Years with at least one case | 18 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 242 |
| Supabase rows with a PDF (`r2_url`) | 202,533 |
| Supabase rows flagged full text | 202,564 |
| Supabase rows with a case name | 202,245 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `Calcutta High Court` | v1 | 319,981 | 200,539 |
| `High Court of Calcutta` | v1 | 2,602 | 1,771 |
| `Calcutta High Court` | v2 | 1,002 | 495 |
| `High Court of Calcutta` | v2 | 21 | 2 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1960 | 1 | 1 | 1.0 | 1 | 0 |
| 1964 | 1 | 1 | 1.0 | 1 | 0 |
| 1966 | 1 | 1 | 1.0 | 1 | 0 |
| 1968 | 1 | 1 | 1.0 | 1 | 0 |
| 1979 | 2 | 2 | 1.0 | 2 | 0 |
| 1980 | 1 | 1 | 1.0 | 1 | 0 |
| 1986 | 6 | 6 | 1.0 | 6 | 0 |
| 1992 | 2 | 2 | 1.0 | 2 | 0 |
| 1999 | 27 | 27 | 1.0 | 27 | 0 |
| 2001 | 37 | 37 | 1.0 | 37 | 0 |
| 2016 | 1 | 12 | 12.0 | 1 | 0 |
| 2019 | 284 | 388 | 1.4 | 280 | 4 |
| 2020 | 4,773 | 5,473 | 1.1 | 4,722 | 51 |
| 2021 | 31,118 | 38,213 | 1.2 | 31,064 | 54 |
| 2022 | 49,281 | 83,561 | 1.7 | 49,240 | 41 |
| 2023 | 47,558 | 73,237 | 1.5 | 47,516 | 42 |
| 2024 | 37,812 | 74,915 | 2.0 | 37,785 | 27 |
| 2025 | 31,901 | 47,728 | 1.5 | 31,877 | 24 |
| **Total** | **202,807** | **323,606** | | **202,564** | |

The year rows sum to 202,807 because 242 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **202,565**.
