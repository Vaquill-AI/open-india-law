# Himachal Pradesh High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 184,175 |
| Text chunks in Qdrant | 752,558 |
| Metadata rows in Supabase `legal_cases` | 183,933 |
| Earliest decision | 1970-11-25 |
| Latest decision (data cutoff) | 2025-10-09 |
| Years with at least one case | 28 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 5,503 |
| Supabase rows with a PDF (`r2_url`) | 183,933 |
| Supabase rows flagged full text | 183,933 |
| Supabase rows with a case name | 183,933 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Himachal Pradesh` | v2 | 479,389 | 87,912 |
| `High Court of Himachal Pradesh` | v1 | 273,169 | 101,766 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1970 | 1 | 1 | 1.0 | 1 | 0 |
| 1987 | 1 | 1 | 1.0 | 1 | 0 |
| 1997 | 16 | 39 | 2.4 | 14 | 2 |
| 1998 | 1 | 1 | 1.0 | 1 | 0 |
| 1999 | 1 | 2 | 2.0 | 1 | 0 |
| 2001 | 25 | 60 | 2.4 | 25 | 0 |
| 2004 | 35 | 61 | 1.7 | 32 | 3 |
| 2005 | 55 | 110 | 2.0 | 52 | 3 |
| 2006 | 735 | 1,743 | 2.4 | 685 | 50 |
| 2007 | 2,891 | 7,771 | 2.7 | 2,759 | 132 |
| 2008 | 5,120 | 11,621 | 2.3 | 4,838 | 282 |
| 2009 | 5,376 | 11,140 | 2.1 | 5,106 | 270 |
| 2010 | 10,424 | 22,262 | 2.1 | 10,029 | 395 |
| 2011 | 10,246 | 20,114 | 2.0 | 9,865 | 381 |
| 2012 | 13,876 | 64,982 | 4.7 | 13,329 | 547 |
| 2013 | 9,622 | 26,954 | 2.8 | 9,273 | 349 |
| 2014 | 8,873 | 31,831 | 3.6 | 8,611 | 262 |
| 2015 | 9,869 | 37,213 | 3.8 | 9,493 | 376 |
| 2016 | 8,225 | 35,094 | 4.3 | 7,920 | 305 |
| 2017 | 6,505 | 21,794 | 3.4 | 6,273 | 232 |
| 2018 | 7,664 | 28,149 | 3.7 | 7,383 | 281 |
| 2019 | 8,490 | 38,752 | 4.6 | 8,110 | 380 |
| 2020 | 5,783 | 25,861 | 4.5 | 5,649 | 134 |
| 2021 | 9,328 | 35,712 | 3.8 | 9,123 | 205 |
| 2022 | 12,177 | 60,571 | 5.0 | 11,906 | 271 |
| 2023 | 15,199 | 76,069 | 5.0 | 14,899 | 300 |
| 2024 | 19,050 | 107,265 | 5.6 | 18,772 | 278 |
| 2025 | 20,090 | 87,385 | 4.3 | 19,783 | 307 |
| **Total** | **189,678** | **752,558** | | **183,933** | |

The year rows sum to 189,678 because 5,503 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **184,175**.
