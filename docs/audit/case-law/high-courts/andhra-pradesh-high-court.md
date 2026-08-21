# Andhra Pradesh High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 254,482 |
| Text chunks in Qdrant | 1,032,270 |
| Metadata rows in Supabase `legal_cases` | 254,480 |
| Earliest decision | 1995-09-18 |
| Latest decision (data cutoff) | 2025-10-23 |
| Years with at least one case | 11 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 35,029 |
| Supabase rows with a PDF (`r2_url`) | 254,480 |
| Supabase rows flagged full text | 254,480 |
| Supabase rows with a case name | 254,477 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Andhra Pradesh` | v1 | 956,462 | 254,467 |
| `High Court of Andhra Pradesh` | v2 | 75,759 | 35,028 |
| `High Court of Amaravati` | v1 | 42 | 14 |
| `High Court of Amaravati` | v2 | 5 | 1 |
| `High Court of Andhra` | v1 | 2 | 1 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1995 | 2 | 4 | 2.0 | 1 | 1 |
| 1996 | 1 | 2 | 2.0 | 1 | 0 |
| 2001 | 4 | 6 | 1.5 | 4 | 0 |
| 2002 | 2 | 3 | 1.5 | 2 | 0 |
| 2019 | 14,311 | 36,810 | 2.6 | 13,109 | 1,202 |
| 2020 | 28,047 | 68,086 | 2.4 | 24,189 | 3,858 |
| 2021 | 33,857 | 123,291 | 3.6 | 29,274 | 4,583 |
| 2022 | 50,774 | 132,718 | 2.6 | 44,925 | 5,849 |
| 2023 | 55,098 | 184,658 | 3.4 | 48,809 | 6,289 |
| 2024 | 63,402 | 300,120 | 4.7 | 55,650 | 7,752 |
| 2025 | 44,013 | 186,572 | 4.2 | 38,516 | 5,497 |
| **Total** | **289,511** | **1,032,270** | | **254,480** | |

The year rows sum to 289,511 because 35,029 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **254,482**.
