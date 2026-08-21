# Gauhati High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 285,714 |
| Text chunks in Qdrant | 691,391 |
| Metadata rows in Supabase `legal_cases` | 285,277 |
| Earliest decision | 1982-03-11 |
| Latest decision (data cutoff) | 2029-04-05 |
| Years with at least one case | 26 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 15,542 |
| Supabase rows with a PDF (`r2_url`) | 285,277 |
| Supabase rows flagged full text | 285,277 |
| Supabase rows with a case name | 285,254 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `Gauhati High Court` | v1 | 656,158 | 283,697 |
| `Gauhati High Court` | v2 | 28,669 | 15,438 |
| `High Court of Gauhati` | v1 | 6,280 | 2,014 |
| `High Court of Gauhati` | v2 | 282 | 106 |
| `High Court of Guwahati` | v1 | 2 | 1 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 2000 | 9 | 27 | 3.0 | 9 | 0 |
| 2001 | 19 | 33 | 1.7 | 19 | 0 |
| 2002 | 52 | 151 | 2.9 | 49 | 3 |
| 2003 | 7 | 67 | 9.6 | 6 | 1 |
| 2004 | 5 | 11 | 2.2 | 5 | 0 |
| 2005 | 18 | 89 | 4.9 | 18 | 0 |
| 2006 | 77 | 137 | 1.8 | 72 | 5 |
| 2007 | 1,283 | 3,217 | 2.5 | 1,216 | 67 |
| 2008 | 1,050 | 2,902 | 2.8 | 991 | 59 |
| 2009 | 1,341 | 3,573 | 2.7 | 1,269 | 72 |
| 2010 | 4,397 | 8,355 | 1.9 | 4,166 | 231 |
| 2011 | 11,460 | 15,884 | 1.4 | 10,804 | 656 |
| 2012 | 14,941 | 23,450 | 1.6 | 14,180 | 761 |
| 2013 | 16,552 | 24,881 | 1.5 | 15,681 | 871 |
| 2014 | 15,127 | 24,165 | 1.6 | 14,254 | 873 |
| 2015 | 14,563 | 24,332 | 1.7 | 13,805 | 758 |
| 2016 | 12,262 | 21,383 | 1.7 | 11,465 | 797 |
| 2017 | 13,219 | 24,432 | 1.8 | 12,486 | 733 |
| 2018 | 23,805 | 70,802 | 3.0 | 22,560 | 1,245 |
| 2019 | 25,971 | 47,036 | 1.8 | 24,545 | 1,426 |
| 2020 | 16,579 | 33,294 | 2.0 | 15,750 | 829 |
| 2021 | 20,696 | 42,956 | 2.1 | 19,655 | 1,041 |
| 2022 | 27,460 | 71,414 | 2.6 | 26,008 | 1,452 |
| 2023 | 29,417 | 91,506 | 3.1 | 27,946 | 1,471 |
| 2024 | 27,945 | 84,454 | 3.0 | 26,510 | 1,435 |
| 2025 | 23,001 | 72,840 | 3.2 | 21,808 | 1,193 |
| **Total** | **301,256** | **691,391** | | **285,277** | |

The year rows sum to 301,256 because 15,542 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **285,714**.
