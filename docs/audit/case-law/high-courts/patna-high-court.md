# Patna High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 1,615,041 |
| Text chunks in Qdrant | 2,682,744 |
| Metadata rows in Supabase `legal_cases` | 1,615,037 |
| Earliest decision | 1924-12-15 |
| Latest decision (data cutoff) | 2030-05-06 |
| Years with at least one case | 28 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 88,309 |
| Supabase rows with a PDF (`r2_url`) | 1,615,037 |
| Supabase rows flagged full text | 1,615,037 |
| Supabase rows with a case name | 1,614,973 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `Patna High Court` | v1 | 2,541,141 | 1,600,414 |
| `Patna High Court` | v2 | 118,468 | 87,547 |
| `High Court of Patna` | v1 | 21,917 | 14,621 |
| `High Court of Patna` | v2 | 1,218 | 768 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1967 | 1 | 4 | 4.0 | 1 | 0 |
| 1972 | 1 | 1 | 1.0 | 1 | 0 |
| 1978 | 3 | 15 | 5.0 | 3 | 0 |
| 1980 | 3 | 3 | 1.0 | 3 | 0 |
| 1984 | 2 | 2 | 1.0 | 2 | 0 |
| 1989 | 8 | 80 | 10.0 | 8 | 0 |
| 1994 | 16 | 44 | 2.8 | 16 | 0 |
| 1997 | 25 | 30 | 1.2 | 23 | 2 |
| 2001 | 33 | 60 | 1.8 | 29 | 4 |
| 2002 | 52 | 81 | 1.6 | 46 | 6 |
| 2008 | 45,394 | 53,637 | 1.2 | 43,125 | 2,269 |
| 2009 | 74,831 | 96,230 | 1.3 | 70,848 | 3,983 |
| 2010 | 84,983 | 196,994 | 2.3 | 80,583 | 4,400 |
| 2011 | 95,265 | 123,356 | 1.3 | 90,289 | 4,976 |
| 2012 | 94,111 | 121,810 | 1.3 | 89,210 | 4,901 |
| 2013 | 84,438 | 140,801 | 1.7 | 79,969 | 4,469 |
| 2014 | 83,461 | 137,430 | 1.6 | 79,053 | 4,408 |
| 2015 | 102,780 | 155,386 | 1.5 | 97,523 | 5,257 |
| 2016 | 90,693 | 147,839 | 1.6 | 86,004 | 4,689 |
| 2017 | 99,788 | 144,695 | 1.5 | 94,664 | 5,124 |
| 2018 | 121,240 | 166,110 | 1.4 | 115,048 | 6,192 |
| 2019 | 121,507 | 164,214 | 1.4 | 115,146 | 6,361 |
| 2020 | 53,714 | 95,805 | 1.8 | 50,918 | 2,796 |
| 2021 | 60,877 | 104,330 | 1.7 | 57,695 | 3,182 |
| 2022 | 122,307 | 175,783 | 1.4 | 115,970 | 6,337 |
| 2023 | 142,639 | 216,574 | 1.5 | 135,369 | 7,270 |
| 2024 | 129,071 | 300,755 | 2.3 | 122,294 | 6,777 |
| 2025 | 96,107 | 140,675 | 1.5 | 91,197 | 4,910 |
| **Total** | **1,703,350** | **2,682,744** | | **1,615,037** | |

The year rows sum to 1,703,350 because 88,309 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **1,615,041**.
