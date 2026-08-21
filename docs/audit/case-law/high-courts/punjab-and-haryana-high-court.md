# Punjab and Haryana High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 483,253 |
| Text chunks in Qdrant | 1,265,189 |
| Metadata rows in Supabase `legal_cases` | 482,424 |
| Earliest decision | 1989-12-20 |
| Latest decision (data cutoff) | 2025-10-10 |
| Years with at least one case | 17 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 1 |
| Supabase rows with a PDF (`r2_url`) | 482,424 |
| Supabase rows flagged full text | 482,424 |
| Supabase rows with a case name | 482,424 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Punjab and Haryana` | v2 | 1,265,076 | 483,223 |
| `High Court of Haryana` | v2 | 59 | 18 |
| `High Court of Chandigarh` | v2 | 45 | 10 |
| `High Court of Chandigarh` | v1 | 9 | 3 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 2008 | 9,281 | 28,481 | 3.1 | 9,281 | 0 |
| 2009 | 21,022 | 55,816 | 2.7 | 21,022 | 0 |
| 2010 | 26,991 | 70,825 | 2.6 | 26,990 | 1 |
| 2011 | 28,602 | 70,948 | 2.5 | 28,593 | 9 |
| 2013 | 24,989 | 55,417 | 2.2 | 24,902 | 87 |
| 2014 | 34,949 | 86,971 | 2.5 | 34,768 | 181 |
| 2015 | 40,264 | 98,613 | 2.4 | 40,170 | 94 |
| 2016 | 39,726 | 91,352 | 2.3 | 39,703 | 23 |
| 2017 | 42,297 | 98,729 | 2.3 | 42,283 | 14 |
| 2018 | 51,243 | 110,950 | 2.2 | 51,184 | 59 |
| 2019 | 46,905 | 104,830 | 2.2 | 46,886 | 19 |
| 2020 | 30,505 | 64,060 | 2.1 | 30,478 | 27 |
| 2021 | 24,332 | 70,080 | 2.9 | 24,293 | 39 |
| 2022 | 50,529 | 124,300 | 2.5 | 50,377 | 152 |
| 2023 | 3,023 | 40,009 | 13.2 | 2,989 | 34 |
| 2024 | 8,594 | 93,802 | 10.9 | 8,505 | 89 |
| 2025 | 2 | 6 | 3.0 | n/a | n/a |
| **Total** | **483,254** | **1,265,189** | | **482,424** | |

The year rows sum to 483,254 because 1 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **483,253**.
