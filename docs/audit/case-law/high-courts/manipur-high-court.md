# Manipur High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 7,903 |
| Text chunks in Qdrant | 31,643 |
| Metadata rows in Supabase `legal_cases` | 7,903 |
| Earliest decision | 2017-05-19 |
| Latest decision (data cutoff) | 2025-10-05 |
| Years with at least one case | 9 |
| Qdrant collections | v2 |
| Supabase rows with a PDF (`r2_url`) | 7,903 |
| Supabase rows flagged full text | 7,903 |
| Supabase rows with a case name | 7,903 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Manipur` | v2 | 31,643 | 7,903 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 2017 | 169 | 329 | 1.9 | 169 | 0 |
| 2018 | 707 | 1,655 | 2.3 | 707 | 0 |
| 2019 | 1,143 | 5,274 | 4.6 | 1,143 | 0 |
| 2020 | 487 | 3,507 | 7.2 | 487 | 0 |
| 2021 | 798 | 3,694 | 4.6 | 798 | 0 |
| 2022 | 1,579 | 6,690 | 4.2 | 1,579 | 0 |
| 2023 | 1,041 | 4,777 | 4.6 | 1,041 | 0 |
| 2024 | 989 | 2,808 | 2.8 | 989 | 0 |
| 2025 | 990 | 2,909 | 2.9 | 990 | 0 |
| **Total** | **7,903** | **31,643** | | **7,903** | |
