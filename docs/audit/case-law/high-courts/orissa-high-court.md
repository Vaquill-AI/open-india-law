# Orissa High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 283,063 |
| Text chunks in Qdrant | 501,386 |
| Metadata rows in Supabase `legal_cases` | 283,055 |
| Earliest decision | 1992-08-10 |
| Latest decision (data cutoff) | 2025-10-24 |
| Years with at least one case | 29 |
| Qdrant collections | v2 |
| Supabase rows with a PDF (`r2_url`) | 283,055 |
| Supabase rows flagged full text | 283,055 |
| Supabase rows with a case name | 283,054 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `Orissa High Court` | v2 | 500,805 | 282,976 |
| `High Court of Orissa` | v2 | 581 | 87 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1992 | 1 | 4 | 4.0 | 1 | 0 |
| 1997 | 2 | 2 | 1.0 | 2 | 0 |
| 1999 | 1 | 9 | 9.0 | 1 | 0 |
| 2000 | 1 | 29 | 29.0 | 1 | 0 |
| 2001 | 4 | 16 | 4.0 | 4 | 0 |
| 2002 | 2 | 25 | 12.5 | 2 | 0 |
| 2003 | 1 | 3 | 3.0 | 1 | 0 |
| 2004 | 6 | 18 | 3.0 | 6 | 0 |
| 2005 | 38 | 142 | 3.7 | 38 | 0 |
| 2006 | 56 | 188 | 3.4 | 56 | 0 |
| 2007 | 21 | 66 | 3.1 | 21 | 0 |
| 2008 | 24 | 117 | 4.9 | 24 | 0 |
| 2009 | 120 | 684 | 5.7 | 120 | 0 |
| 2010 | 523 | 5,154 | 9.9 | 523 | 0 |
| 2011 | 464 | 3,438 | 7.4 | 464 | 0 |
| 2012 | 546 | 3,603 | 6.6 | 546 | 0 |
| 2013 | 1,580 | 7,099 | 4.5 | 1,580 | 0 |
| 2014 | 835 | 3,776 | 4.5 | 835 | 0 |
| 2015 | 6,165 | 12,213 | 2.0 | 6,164 | 1 |
| 2016 | 11,491 | 18,006 | 1.6 | 11,490 | 1 |
| 2017 | 9,047 | 15,693 | 1.7 | 9,046 | 1 |
| 2018 | 5,750 | 12,031 | 2.1 | 5,748 | 2 |
| 2019 | 14,041 | 21,615 | 1.5 | 14,040 | 1 |
| 2020 | 16,043 | 21,118 | 1.3 | 16,041 | 2 |
| 2021 | 33,667 | 45,813 | 1.4 | 33,666 | 1 |
| 2022 | 44,831 | 65,957 | 1.5 | 44,832 | -1 |
| 2023 | 52,249 | 86,311 | 1.7 | 52,249 | 0 |
| 2024 | 50,263 | 117,250 | 2.3 | 50,263 | 0 |
| 2025 | 35,291 | 61,006 | 1.7 | 35,291 | 0 |
| **Total** | **283,063** | **501,386** | | **283,055** | |
