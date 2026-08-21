# Rajasthan High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 324,567 |
| Text chunks in Qdrant | 1,357,931 |
| Metadata rows in Supabase `legal_cases` | 324,241 |
| Earliest decision | 1989-03-31 |
| Latest decision (data cutoff) | 2025-10-17 |
| Years with at least one case | 30 |
| Qdrant collections | v1, v2 |
| Supabase rows with a PDF (`r2_url`) | 324,241 |
| Supabase rows flagged full text | 324,241 |
| Supabase rows with a case name | 324,238 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court Of Rajasthan` | v2 | 1,356,011 | 324,089 |
| `High Court of Rajasthan` | v2 | 1,917 | 476 |
| `High Court of Rajasthan` | v1 | 3 | 2 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1989 | 1 | 1 | 1.0 | 1 | 0 |
| 1990 | 1 | 1 | 1.0 | 1 | 0 |
| 1996 | 2 | 7 | 3.5 | 2 | 0 |
| 1999 | 2 | 26 | 13.0 | 2 | 0 |
| 2000 | 2 | 11 | 5.5 | 2 | 0 |
| 2001 | 3 | 5 | 1.7 | 3 | 0 |
| 2002 | 2 | 4 | 2.0 | 2 | 0 |
| 2003 | 3 | 5 | 1.7 | 3 | 0 |
| 2004 | 215 | 779 | 3.6 | 215 | 0 |
| 2005 | 1,091 | 3,907 | 3.6 | 1,088 | 3 |
| 2006 | 3,628 | 14,463 | 4.0 | 3,605 | 23 |
| 2007 | 5,971 | 25,481 | 4.3 | 5,952 | 19 |
| 2008 | 6,285 | 25,985 | 4.1 | 6,251 | 34 |
| 2009 | 6,555 | 34,158 | 5.2 | 6,536 | 19 |
| 2010 | 5,138 | 32,949 | 6.4 | 5,122 | 16 |
| 2011 | 4,298 | 15,930 | 3.7 | 4,268 | 30 |
| 2012 | 6,239 | 47,304 | 7.6 | 6,231 | 8 |
| 2013 | 6,050 | 34,921 | 5.8 | 6,024 | 26 |
| 2014 | 12,025 | 49,204 | 4.1 | 12,001 | 24 |
| 2015 | 13,289 | 44,348 | 3.3 | 13,201 | 88 |
| 2016 | 16,517 | 73,003 | 4.4 | 16,496 | 21 |
| 2017 | 26,553 | 108,395 | 4.1 | 26,543 | 10 |
| 2018 | 26,891 | 118,432 | 4.4 | 26,887 | 4 |
| 2019 | 23,191 | 85,788 | 3.7 | 23,190 | 1 |
| 2020 | 22,870 | 82,474 | 3.6 | 22,869 | 1 |
| 2021 | 30,867 | 116,027 | 3.8 | 30,867 | 0 |
| 2022 | 33,371 | 139,105 | 4.2 | 33,370 | 1 |
| 2023 | 38,256 | 138,825 | 3.6 | 38,258 | -2 |
| 2024 | 29,186 | 145,988 | 5.0 | 29,186 | 0 |
| 2025 | 6,065 | 20,405 | 3.4 | 6,065 | 0 |
| **Total** | **324,567** | **1,357,931** | | **324,241** | |
