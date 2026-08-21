# Karnataka High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 581,276 |
| Text chunks in Qdrant | 1,552,339 |
| Metadata rows in Supabase `legal_cases` | 580,888 |
| Earliest decision | 1998-01-15 |
| Latest decision (data cutoff) | 2025-09-26 |
| Years with at least one case | 25 |
| Qdrant collections | v1, v2 |
| Supabase rows with a PDF (`r2_url`) | 580,888 |
| Supabase rows flagged full text | 580,888 |
| Supabase rows with a case name | 580,888 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Karnataka` | v2 | 1,552,336 | 581,275 |
| `High Court of Karnataka` | v1 | 3 | 1 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1998 | 113 | 308 | 2.7 | 113 | 0 |
| 1999 | 2 | 9 | 4.5 | 2 | 0 |
| 2000 | 1 | 4 | 4.0 | 1 | 0 |
| 2001 | 1 | 2 | 2.0 | 1 | 0 |
| 2004 | 3 | 5 | 1.7 | 3 | 0 |
| 2006 | 1 | 2 | 2.0 | 1 | 0 |
| 2007 | 6 | 7 | 1.2 | 6 | 0 |
| 2008 | 20 | 28 | 1.4 | 20 | 0 |
| 2009 | 90 | 110 | 1.2 | 90 | 0 |
| 2010 | 128 | 158 | 1.2 | 128 | 0 |
| 2011 | 270 | 499 | 1.8 | 269 | 1 |
| 2012 | 22,975 | 50,123 | 2.2 | 22,956 | 19 |
| 2013 | 7,140 | 16,802 | 2.4 | 7,131 | 9 |
| 2014 | 40,013 | 80,357 | 2.0 | 39,962 | 51 |
| 2015 | 37,783 | 76,523 | 2.0 | 37,777 | 6 |
| 2016 | 33,935 | 68,083 | 2.0 | 33,916 | 19 |
| 2017 | 33,096 | 69,935 | 2.1 | 33,089 | 7 |
| 2018 | 31,917 | 73,433 | 2.3 | 31,903 | 14 |
| 2019 | 42,268 | 97,838 | 2.3 | 42,259 | 9 |
| 2020 | 34,035 | 100,269 | 2.9 | 34,033 | 2 |
| 2021 | 59,310 | 184,971 | 3.1 | 59,314 | -4 |
| 2022 | 59,820 | 169,696 | 2.8 | 59,773 | 47 |
| 2023 | 67,670 | 226,123 | 3.3 | 67,578 | 92 |
| 2024 | 78,994 | 229,421 | 2.9 | 78,886 | 108 |
| 2025 | 31,685 | 107,633 | 3.4 | 31,677 | 8 |
| **Total** | **581,276** | **1,552,339** | | **580,888** | |
