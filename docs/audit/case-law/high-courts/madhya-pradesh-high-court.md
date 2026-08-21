# Madhya Pradesh High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 402,632 |
| Text chunks in Qdrant | 766,922 |
| Metadata rows in Supabase `legal_cases` | 402,595 |
| Earliest decision | 1994-05-16 |
| Latest decision (data cutoff) | 2024-12-14 |
| Years with at least one case | 17 |
| Qdrant collections | v1, v2 |
| Supabase rows with a PDF (`r2_url`) | 402,595 |
| Supabase rows flagged full text | 402,595 |
| Supabase rows with a case name | 402,595 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Madhya Pradesh` | v2 | 766,920 | 402,631 |
| `High Court of Jabalpur` | v1 | 2 | 1 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 2000 | 13 | 21 | 1.6 | 13 | 0 |
| 2009 | 2 | 4 | 2.0 | 2 | 0 |
| 2010 | 45 | 192 | 4.3 | 45 | 0 |
| 2011 | 1,024 | 3,081 | 3.0 | 1,024 | 0 |
| 2012 | 7,825 | 18,869 | 2.4 | 7,824 | 1 |
| 2013 | 8,552 | 19,167 | 2.2 | 8,552 | 0 |
| 2014 | 13,537 | 24,384 | 1.8 | 13,537 | 0 |
| 2015 | 23,839 | 38,194 | 1.6 | 23,839 | 0 |
| 2016 | 26,179 | 51,312 | 2.0 | 26,159 | 20 |
| 2017 | 23,935 | 44,912 | 1.9 | 23,926 | 9 |
| 2018 | 33,472 | 67,254 | 2.0 | 33,471 | 1 |
| 2019 | 37,064 | 69,126 | 1.9 | 37,064 | 0 |
| 2020 | 26,738 | 55,905 | 2.1 | 26,738 | 0 |
| 2021 | 37,058 | 64,480 | 1.7 | 37,058 | 0 |
| 2022 | 68,167 | 135,544 | 2.0 | 68,162 | 5 |
| 2023 | 86,604 | 156,716 | 1.8 | 86,603 | 1 |
| 2024 | 8,578 | 17,761 | 2.1 | 8,578 | 0 |
| **Total** | **402,632** | **766,922** | | **402,595** | |
