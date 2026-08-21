# Delhi High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 322,940 |
| Text chunks in Qdrant | 1,093,462 |
| Metadata rows in Supabase `legal_cases` | 322,936 |
| Earliest decision | 1960-10-10 |
| Latest decision (data cutoff) | 2026-01-28 |
| Years with at least one case | 28 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 17,214 |
| Supabase rows with a PDF (`r2_url`) | 322,936 |
| Supabase rows flagged full text | 322,936 |
| Supabase rows with a case name | 322,901 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Delhi` | v1 | 1,047,481 | 322,940 |
| `High Court of Delhi` | v2 | 45,981 | 17,214 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1960 | 1 | 5 | 5.0 | 1 | 0 |
| 1996 | 1 | 17 | 17.0 | 1 | 0 |
| 1997 | 6 | 6 | 1.0 | 6 | 0 |
| 1998 | 9 | 14 | 1.6 | 9 | 0 |
| 2001 | 5 | 28 | 5.6 | 5 | 0 |
| 2002 | 47 | 85 | 1.8 | 47 | 0 |
| 2003 | 89 | 197 | 2.2 | 86 | 3 |
| 2004 | 76 | 285 | 3.8 | 74 | 2 |
| 2005 | 97 | 451 | 4.6 | 94 | 3 |
| 2006 | 219 | 1,327 | 6.1 | 211 | 8 |
| 2007 | 1,265 | 5,431 | 4.3 | 1,207 | 58 |
| 2008 | 2,528 | 12,343 | 4.9 | 2,419 | 109 |
| 2010 | 7,013 | 30,985 | 4.4 | 6,686 | 327 |
| 2011 | 15,797 | 85,457 | 5.4 | 15,036 | 761 |
| 2012 | 11,936 | 57,516 | 4.8 | 11,363 | 573 |
| 2013 | 9,616 | 44,746 | 4.7 | 9,143 | 473 |
| 2014 | 6,938 | 35,323 | 5.1 | 6,592 | 346 |
| 2015 | 17,174 | 69,705 | 4.1 | 16,338 | 836 |
| 2016 | 44,553 | 85,357 | 1.9 | 42,157 | 2,396 |
| 2017 | 39,079 | 83,120 | 2.1 | 37,087 | 1,992 |
| 2018 | 42,411 | 86,876 | 2.0 | 40,185 | 2,226 |
| 2019 | 28,334 | 69,016 | 2.4 | 26,909 | 1,425 |
| 2020 | 13,729 | 33,397 | 2.4 | 13,077 | 652 |
| 2021 | 4,716 | 24,217 | 5.1 | 4,502 | 214 |
| 2022 | 5,110 | 40,098 | 7.8 | 4,863 | 247 |
| 2023 | 8,739 | 61,651 | 7.1 | 8,314 | 425 |
| 2024 | 50,643 | 164,383 | 3.2 | 48,027 | 2,616 |
| 2025 | 30,023 | 101,426 | 3.4 | 28,497 | 1,526 |
| **Total** | **340,154** | **1,093,462** | | **322,936** | |

The year rows sum to 340,154 because 17,214 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **322,940**.
