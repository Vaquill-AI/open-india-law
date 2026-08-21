# Madras High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 1,494,952 |
| Text chunks in Qdrant | 2,746,519 |
| Metadata rows in Supabase `legal_cases` | 1,494,950 |
| Earliest decision | 1976-03-26 |
| Latest decision (data cutoff) | 2025-11-03 |
| Years with at least one case | 27 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 81,336 |
| Supabase rows with a PDF (`r2_url`) | 1,494,950 |
| Supabase rows flagged full text | 1,494,950 |
| Supabase rows with a case name | 1,494,892 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `Madras High Court` | v1 | 2,600,953 | 1,490,354 |
| `Madras High Court` | v2 | 137,003 | 81,103 |
| `High Court of Madras` | v1 | 8,183 | 4,597 |
| `High Court of Madras` | v2 | 379 | 233 |
| `High Court of Chennai` | v1 | 1 | 1 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1997 | 1 | 1 | 1.0 | 1 | 0 |
| 1999 | 1 | 6 | 6.0 | 1 | 0 |
| 2000 | 7 | 35 | 5.0 | 7 | 0 |
| 2001 | 43 | 211 | 4.9 | 42 | 1 |
| 2002 | 1,054 | 4,386 | 4.2 | 1,000 | 54 |
| 2003 | 1,146 | 6,440 | 5.6 | 1,089 | 57 |
| 2004 | 1,017 | 4,520 | 4.4 | 980 | 37 |
| 2005 | 577 | 3,279 | 5.7 | 541 | 36 |
| 2006 | 2,564 | 10,064 | 3.9 | 2,435 | 129 |
| 2007 | 3,290 | 14,694 | 4.5 | 3,139 | 151 |
| 2008 | 3,645 | 17,262 | 4.7 | 3,465 | 180 |
| 2009 | 4,138 | 20,773 | 5.0 | 3,929 | 209 |
| 2010 | 5,483 | 24,438 | 4.5 | 5,186 | 297 |
| 2011 | 21,637 | 46,796 | 2.2 | 20,485 | 1,152 |
| 2013 | 32,416 | 56,019 | 1.7 | 30,775 | 1,641 |
| 2014 | 40,065 | 69,574 | 1.7 | 37,988 | 2,077 |
| 2015 | 69,761 | 110,142 | 1.6 | 66,167 | 3,594 |
| 2016 | 92,371 | 146,094 | 1.6 | 87,551 | 4,820 |
| 2017 | 96,360 | 169,253 | 1.8 | 91,567 | 4,793 |
| 2018 | 115,878 | 200,193 | 1.7 | 109,796 | 6,082 |
| 2019 | 129,294 | 238,523 | 1.8 | 122,675 | 6,619 |
| 2020 | 97,010 | 171,590 | 1.8 | 92,010 | 5,000 |
| 2021 | 142,009 | 244,946 | 1.7 | 134,649 | 7,360 |
| 2022 | 180,416 | 305,421 | 1.7 | 171,129 | 9,287 |
| 2023 | 187,002 | 305,757 | 1.6 | 177,301 | 9,701 |
| 2024 | 182,269 | 306,989 | 1.7 | 172,714 | 9,555 |
| 2025 | 166,834 | 269,113 | 1.6 | 158,328 | 8,506 |
| **Total** | **1,576,288** | **2,746,519** | | **1,494,950** | |

The year rows sum to 1,576,288 because 81,336 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **1,494,952**.
