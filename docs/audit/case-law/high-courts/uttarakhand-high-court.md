# Uttarakhand High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 123,853 |
| Text chunks in Qdrant | 262,048 |
| Metadata rows in Supabase `legal_cases` | 123,851 |
| Earliest decision | 1950-01-01 |
| Latest decision (data cutoff) | 2025-10-17 |
| Years with at least one case | 30 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 243 |
| Supabase rows with a PDF (`r2_url`) | 123,851 |
| Supabase rows flagged full text | 123,851 |
| Supabase rows with a case name | 123,848 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Uttarakhand` | v1 | 261,025 | 123,643 |
| `High Court of Uttarakhand` | v2 | 1,023 | 453 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1950 | 9 | 14 | 1.6 | 9 | 0 |
| 1997 | 1 | 1 | 1.0 | 1 | 0 |
| 1998 | 1 | 1 | 1.0 | 1 | 0 |
| 1999 | 2 | 3 | 1.5 | 2 | 0 |
| 2000 | 30 | 40 | 1.3 | 30 | 0 |
| 2001 | 555 | 1,041 | 1.9 | 555 | 0 |
| 2002 | 702 | 1,326 | 1.9 | 702 | 0 |
| 2003 | 1,751 | 3,641 | 2.1 | 1,751 | 0 |
| 2004 | 1,911 | 3,443 | 1.8 | 1,910 | 1 |
| 2005 | 1,386 | 2,625 | 1.9 | 1,379 | 7 |
| 2006 | 3,628 | 7,020 | 1.9 | 3,622 | 6 |
| 2007 | 1,820 | 3,124 | 1.7 | 1,818 | 2 |
| 2008 | 4,518 | 11,146 | 2.5 | 4,513 | 5 |
| 2009 | 2,602 | 7,570 | 2.9 | 2,601 | 1 |
| 2010 | 5,361 | 14,333 | 2.7 | 5,349 | 12 |
| 2011 | 3,285 | 8,378 | 2.6 | 3,273 | 12 |
| 2012 | 4,996 | 11,522 | 2.3 | 4,982 | 14 |
| 2013 | 6,790 | 14,128 | 2.1 | 6,782 | 8 |
| 2014 | 5,810 | 10,098 | 1.7 | 5,805 | 5 |
| 2015 | 6,219 | 10,717 | 1.7 | 6,213 | 6 |
| 2016 | 5,741 | 9,706 | 1.7 | 5,736 | 5 |
| 2017 | 7,343 | 12,054 | 1.6 | 7,341 | 2 |
| 2018 | 7,142 | 12,743 | 1.8 | 7,131 | 11 |
| 2019 | 9,086 | 24,105 | 2.7 | 9,057 | 29 |
| 2020 | 5,598 | 14,050 | 2.5 | 5,577 | 21 |
| 2021 | 8,180 | 17,695 | 2.2 | 8,155 | 25 |
| 2022 | 8,615 | 18,066 | 2.1 | 8,593 | 22 |
| 2023 | 8,867 | 19,235 | 2.2 | 8,842 | 25 |
| 2024 | 7,608 | 15,721 | 2.1 | 7,589 | 19 |
| 2025 | 4,539 | 8,502 | 1.9 | 4,532 | 7 |
| **Total** | **124,096** | **262,048** | | **123,851** | |

The year rows sum to 124,096 because 243 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **123,853**.
