# Meghalaya High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 6,261 |
| Text chunks in Qdrant | 22,209 |
| Metadata rows in Supabase `legal_cases` | 6,200 |
| Earliest decision | 2010-07-06 |
| Latest decision (data cutoff) | 2025-09-15 |
| Years with at least one case | 16 |
| Qdrant collections | v2 |
| Supabase rows with a PDF (`r2_url`) | 6,200 |
| Supabase rows flagged full text | 6,200 |
| Supabase rows with a case name | 6,200 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Meghalaya` | v2 | 22,209 | 6,261 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 2010 | 4 | 52 | 13.0 | 4 | 0 |
| 2011 | 26 | 369 | 14.2 | 19 | 7 |
| 2012 | 30 | 180 | 6.0 | 27 | 3 |
| 2013 | 202 | 1,102 | 5.5 | 158 | 44 |
| 2014 | 265 | 1,371 | 5.2 | 258 | 7 |
| 2015 | 172 | 1,306 | 7.6 | 172 | 0 |
| 2016 | 229 | 778 | 3.4 | 229 | 0 |
| 2017 | 438 | 1,678 | 3.8 | 438 | 0 |
| 2018 | 380 | 925 | 2.4 | 380 | 0 |
| 2019 | 543 | 1,317 | 2.4 | 543 | 0 |
| 2020 | 325 | 1,830 | 5.6 | 325 | 0 |
| 2021 | 425 | 1,199 | 2.8 | 425 | 0 |
| 2022 | 771 | 2,474 | 3.2 | 771 | 0 |
| 2023 | 854 | 2,609 | 3.1 | 854 | 0 |
| 2024 | 858 | 2,691 | 3.1 | 858 | 0 |
| 2025 | 739 | 2,328 | 3.2 | 739 | 0 |
| **Total** | **6,261** | **22,209** | | **6,200** | |
