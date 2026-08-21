# Jharkhand High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 246,374 |
| Text chunks in Qdrant | 1,234,672 |
| Metadata rows in Supabase `legal_cases` | 246,379 |
| Earliest decision | 1993-01-01 |
| Latest decision (data cutoff) | 2025-09-26 |
| Years with at least one case | 20 |
| Qdrant collections | v2 |
| Supabase rows with a PDF (`r2_url`) | 246,379 |
| Supabase rows flagged full text | 246,379 |
| Supabase rows with a case name | 246,379 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Jharkhand` | v2 | 1,234,672 | 246,374 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1993 | 1 | 2 | 2.0 | 1 | 0 |
| 1994 | 1 | 4 | 4.0 | 1 | 0 |
| 1998 | 1 | 6 | 6.0 | 1 | 0 |
| 1999 | 2 | 8 | 4.0 | 2 | 0 |
| 2000 | 5 | 26 | 5.2 | 5 | 0 |
| 2002 | 1 | 6 | 6.0 | 1 | 0 |
| 2012 | 2,019 | 6,791 | 3.4 | 2,019 | 0 |
| 2013 | 5,306 | 17,025 | 3.2 | 5,306 | 0 |
| 2014 | 7,115 | 23,629 | 3.3 | 7,115 | 0 |
| 2015 | 11,086 | 37,043 | 3.3 | 11,086 | 0 |
| 2016 | 10,412 | 33,260 | 3.2 | 10,412 | 0 |
| 2017 | 14,579 | 51,009 | 3.5 | 14,579 | 0 |
| 2018 | 15,211 | 80,589 | 5.3 | 15,211 | 0 |
| 2019 | 25,251 | 104,967 | 4.2 | 25,251 | 0 |
| 2020 | 15,223 | 64,562 | 4.2 | 15,224 | -1 |
| 2021 | 25,078 | 82,099 | 3.3 | 25,078 | 0 |
| 2022 | 29,904 | 192,179 | 6.4 | 29,906 | -2 |
| 2023 | 31,165 | 153,589 | 4.9 | 31,166 | -1 |
| 2024 | 32,481 | 197,573 | 6.1 | 32,482 | -1 |
| 2025 | 21,533 | 190,305 | 8.8 | 21,533 | 0 |
| **Total** | **246,374** | **1,234,672** | | **246,379** | |
