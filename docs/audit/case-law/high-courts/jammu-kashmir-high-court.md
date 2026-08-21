# Jammu & Kashmir High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 40,289 |
| Text chunks in Qdrant | 240,967 |
| Metadata rows in Supabase `legal_cases` | 40,282 |
| Earliest decision | 2003-02-21 |
| Latest decision (data cutoff) | 2025-10-18 |
| Years with at least one case | 21 |
| Qdrant collections | v2 |
| Supabase rows with a PDF (`r2_url`) | 40,282 |
| Supabase rows flagged full text | 40,282 |
| Supabase rows with a case name | 40,282 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Jammu and Kashmir` | v2 | 240,966 | 40,288 |
| `High Court of Kashmir` | v2 | 1 | 1 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 2003 | 3 | 22 | 7.3 | 3 | 0 |
| 2006 | 3 | 28 | 9.3 | 3 | 0 |
| 2007 | 28 | 450 | 16.1 | 28 | 0 |
| 2008 | 87 | 524 | 6.0 | 87 | 0 |
| 2009 | 105 | 800 | 7.6 | 105 | 0 |
| 2010 | 132 | 1,041 | 7.9 | 131 | 1 |
| 2011 | 111 | 825 | 7.4 | 110 | 1 |
| 2012 | 194 | 1,165 | 6.0 | 194 | 0 |
| 2013 | 49 | 393 | 8.0 | 46 | 3 |
| 2014 | 141 | 2,030 | 14.4 | 137 | 4 |
| 2015 | 182 | 1,685 | 9.3 | 182 | 0 |
| 2016 | 257 | 2,231 | 8.7 | 257 | 0 |
| 2017 | 2,231 | 14,009 | 6.3 | 2,232 | -1 |
| 2018 | 2,081 | 17,188 | 8.3 | 2,081 | 0 |
| 2019 | 3,706 | 22,249 | 6.0 | 3,706 | 0 |
| 2020 | 3,941 | 17,537 | 4.4 | 3,941 | 0 |
| 2021 | 5,556 | 26,133 | 4.7 | 5,557 | -1 |
| 2022 | 5,567 | 31,784 | 5.7 | 5,567 | 0 |
| 2023 | 6,480 | 41,885 | 6.5 | 6,481 | -1 |
| 2024 | 5,433 | 34,142 | 6.3 | 5,433 | 0 |
| 2025 | 4,002 | 24,846 | 6.2 | 4,001 | 1 |
| **Total** | **40,289** | **240,967** | | **40,282** | |
