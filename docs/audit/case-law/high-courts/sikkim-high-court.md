# Sikkim High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 453 |
| Text chunks in Qdrant | 2,678 |
| Metadata rows in Supabase `legal_cases` | 453 |
| Earliest decision | 2000-03-30 |
| Latest decision (data cutoff) | 2025-09-23 |
| Years with at least one case | 25 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 3 |
| Supabase rows with a PDF (`r2_url`) | 453 |
| Supabase rows flagged full text | 453 |
| Supabase rows with a case name | 453 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Sikkim` | v1 | 2,554 | 436 |
| `High Court of Sikkim` | v2 | 124 | 20 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 2000 | 3 | 10 | 3.3 | 3 | 0 |
| 2002 | 2 | 8 | 4.0 | 2 | 0 |
| 2003 | 2 | 4 | 2.0 | 2 | 0 |
| 2004 | 4 | 20 | 5.0 | 4 | 0 |
| 2005 | 2 | 4 | 2.0 | 2 | 0 |
| 2006 | 3 | 71 | 23.7 | 3 | 0 |
| 2007 | 1 | 2 | 2.0 | 1 | 0 |
| 2008 | 2 | 4 | 2.0 | 2 | 0 |
| 2009 | 2 | 22 | 11.0 | 2 | 0 |
| 2010 | 5 | 66 | 13.2 | 5 | 0 |
| 2011 | 1 | 2 | 2.0 | 1 | 0 |
| 2012 | 2 | 4 | 2.0 | 2 | 0 |
| 2013 | 13 | 450 | 34.6 | 13 | 0 |
| 2014 | 39 | 253 | 6.5 | 38 | 1 |
| 2015 | 6 | 70 | 11.7 | 6 | 0 |
| 2016 | 7 | 67 | 9.6 | 6 | 1 |
| 2017 | 16 | 38 | 2.4 | 16 | 0 |
| 2018 | 23 | 73 | 3.2 | 23 | 0 |
| 2019 | 57 | 270 | 4.7 | 57 | 0 |
| 2020 | 75 | 647 | 8.6 | 74 | 1 |
| 2021 | 94 | 324 | 3.4 | 94 | 0 |
| 2022 | 27 | 71 | 2.6 | 27 | 0 |
| 2023 | 23 | 81 | 3.5 | 23 | 0 |
| 2024 | 27 | 57 | 2.1 | 27 | 0 |
| 2025 | 20 | 60 | 3.0 | 20 | 0 |
| **Total** | **456** | **2,678** | | **453** | |

The year rows sum to 456 because 3 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **453**.
