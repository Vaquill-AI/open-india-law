# Chhattisgarh High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 508,791 |
| Text chunks in Qdrant | 1,809,603 |
| Metadata rows in Supabase `legal_cases` | 508,771 |
| Earliest decision | 1970-01-18 |
| Latest decision (data cutoff) | 2025-10-13 |
| Years with at least one case | 31 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 27,411 |
| Supabase rows with a PDF (`r2_url`) | 508,771 |
| Supabase rows flagged full text | 508,771 |
| Supabase rows with a case name | 508,769 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court Of Chhattisgarh` | v1 | 1,743,234 | 508,787 |
| `High Court Of Chhattisgarh` | v2 | 66,363 | 27,411 |
| `High Court of Chhattisgarh` | v1 | 6 | 4 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1970 | 1 | 1 | 1.0 | 1 | 0 |
| 1991 | 1 | 1 | 1.0 | 1 | 0 |
| 1994 | 1 | 1 | 1.0 | 1 | 0 |
| 1996 | 2 | 4 | 2.0 | 1 | 1 |
| 1999 | 1 | 1 | 1.0 | 1 | 0 |
| 2000 | 43 | 48 | 1.1 | 42 | 1 |
| 2001 | 679 | 927 | 1.4 | 635 | 44 |
| 2002 | 540 | 693 | 1.3 | 506 | 34 |
| 2003 | 1,667 | 2,851 | 1.7 | 1,594 | 73 |
| 2004 | 2,252 | 3,416 | 1.5 | 2,137 | 115 |
| 2005 | 5,097 | 9,107 | 1.8 | 4,834 | 263 |
| 2006 | 9,005 | 16,098 | 1.8 | 8,560 | 445 |
| 2007 | 12,775 | 28,483 | 2.2 | 12,107 | 668 |
| 2008 | 10,024 | 15,546 | 1.6 | 9,516 | 508 |
| 2009 | 13,158 | 24,070 | 1.8 | 12,436 | 722 |
| 2010 | 16,137 | 36,403 | 2.3 | 15,327 | 810 |
| 2011 | 16,090 | 30,921 | 1.9 | 15,217 | 873 |
| 2012 | 18,830 | 43,399 | 2.3 | 17,904 | 926 |
| 2013 | 18,334 | 34,125 | 1.9 | 17,376 | 958 |
| 2014 | 17,690 | 35,684 | 2.0 | 16,778 | 912 |
| 2015 | 21,062 | 52,416 | 2.5 | 19,959 | 1,103 |
| 2016 | 27,605 | 167,583 | 6.1 | 26,229 | 1,376 |
| 2017 | 31,649 | 128,386 | 4.1 | 30,062 | 1,587 |
| 2018 | 37,722 | 106,520 | 2.8 | 35,877 | 1,845 |
| 2019 | 40,098 | 125,344 | 3.1 | 37,968 | 2,130 |
| 2020 | 24,206 | 58,345 | 2.4 | 22,999 | 1,207 |
| 2021 | 31,461 | 70,039 | 2.2 | 29,804 | 1,657 |
| 2022 | 33,876 | 126,632 | 3.7 | 32,144 | 1,732 |
| 2023 | 44,323 | 204,334 | 4.6 | 42,042 | 2,281 |
| 2024 | 53,279 | 336,647 | 6.3 | 50,612 | 2,667 |
| 2025 | 48,594 | 151,578 | 3.1 | 46,101 | 2,493 |
| **Total** | **536,202** | **1,809,603** | | **508,771** | |

The year rows sum to 536,202 because 27,411 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **508,791**.
