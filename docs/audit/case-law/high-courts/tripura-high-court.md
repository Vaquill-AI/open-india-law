# Tripura High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 18,942 |
| Text chunks in Qdrant | 138,535 |
| Metadata rows in Supabase `legal_cases` | 18,815 |
| Earliest decision | 2013-01-04 |
| Latest decision (data cutoff) | 2025-09-26 |
| Years with at least one case | 13 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 3 |
| Supabase rows with a PDF (`r2_url`) | 18,815 |
| Supabase rows flagged full text | 18,815 |
| Supabase rows with a case name | 18,815 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Tripura` | v1 | 138,530 | 18,942 |
| `High Court of Tripura` | v2 | 5 | 3 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 2013 | 613 | 1,810 | 3.0 | 567 | 46 |
| 2014 | 2,250 | 10,190 | 4.5 | 2,178 | 72 |
| 2015 | 1,911 | 9,810 | 5.1 | 1,908 | 3 |
| 2016 | 1,999 | 19,260 | 9.6 | 1,993 | 6 |
| 2017 | 1,172 | 5,669 | 4.8 | 1,170 | 2 |
| 2018 | 1,420 | 13,054 | 9.2 | 1,420 | 0 |
| 2019 | 1,914 | 12,740 | 6.7 | 1,913 | 1 |
| 2020 | 1,172 | 10,416 | 8.9 | 1,172 | 0 |
| 2021 | 1,435 | 23,618 | 16.5 | 1,435 | 0 |
| 2022 | 1,762 | 9,710 | 5.5 | 1,762 | 0 |
| 2023 | 1,468 | 6,894 | 4.7 | 1,468 | 0 |
| 2024 | 1,235 | 10,996 | 8.9 | 1,235 | 0 |
| 2025 | 594 | 4,368 | 7.4 | 594 | 0 |
| **Total** | **18,945** | **138,535** | | **18,815** | |

The year rows sum to 18,945 because 3 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **18,942**.
