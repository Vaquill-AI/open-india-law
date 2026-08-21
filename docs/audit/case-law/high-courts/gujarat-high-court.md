# Gujarat High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 411,638 |
| Text chunks in Qdrant | 1,480,863 |
| Metadata rows in Supabase `legal_cases` | 410,187 |
| Earliest decision | 1982-06-25 |
| Latest decision (data cutoff) | 2025-10-06 |
| Years with at least one case | 36 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 21,968 |
| Supabase rows with a PDF (`r2_url`) | 410,187 |
| Supabase rows flagged full text | 410,187 |
| Supabase rows with a case name | 410,187 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Gujarat` | v1 | 1,415,395 | 411,637 |
| `High Court of Gujarat` | v2 | 65,468 | 21,969 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1982 | 1 | 1 | 1.0 | 1 | 0 |
| 1986 | 1 | 2 | 2.0 | 1 | 0 |
| 1987 | 1 | 1 | 1.0 | 1 | 0 |
| 1988 | 1 | 3 | 3.0 | 1 | 0 |
| 1992 | 2 | 4 | 2.0 | 2 | 0 |
| 1993 | 128 | 2,150 | 16.8 | 2 | 126 |
| 1994 | 16 | 63 | 3.9 | 13 | 3 |
| 1995 | 296 | 845 | 2.9 | 195 | 101 |
| 1996 | 4,165 | 10,823 | 2.6 | 3,724 | 441 |
| 1997 | 6,661 | 42,981 | 6.5 | 6,255 | 406 |
| 1998 | 6,155 | 18,585 | 3.0 | 5,624 | 531 |
| 1999 | 5,155 | 21,815 | 4.2 | 4,783 | 372 |
| 2000 | 9,668 | 38,575 | 4.0 | 9,158 | 510 |
| 2001 | 7,139 | 24,222 | 3.4 | 6,577 | 562 |
| 2002 | 5,411 | 19,909 | 3.7 | 5,077 | 334 |
| 2003 | 4,974 | 40,509 | 8.1 | 4,677 | 297 |
| 2004 | 6,438 | 26,121 | 4.1 | 5,993 | 445 |
| 2005 | 9,220 | 43,155 | 4.7 | 8,763 | 457 |
| 2006 | 8,326 | 52,427 | 6.3 | 7,943 | 383 |
| 2007 | 7,703 | 40,151 | 5.2 | 7,303 | 400 |
| 2008 | 10,996 | 77,659 | 7.1 | 10,472 | 524 |
| 2009 | 2 | 4 | 2.0 | 2 | 0 |
| 2010 | 2 | 4 | 2.0 | 2 | 0 |
| 2011 | 17 | 36 | 2.1 | 17 | 0 |
| 2012 | 12,551 | 64,554 | 5.1 | 11,930 | 621 |
| 2013 | 9,781 | 58,268 | 6.0 | 9,266 | 515 |
| 2014 | 13,103 | 78,744 | 6.0 | 12,473 | 630 |
| 2015 | 9,438 | 76,979 | 8.2 | 8,996 | 442 |
| 2018 | 47,850 | 130,871 | 2.7 | 45,370 | 2,480 |
| 2019 | 65,227 | 179,773 | 2.8 | 61,793 | 3,434 |
| 2020 | 43,067 | 97,583 | 2.3 | 40,854 | 2,213 |
| 2021 | 56,136 | 115,711 | 2.1 | 53,236 | 2,900 |
| 2022 | 71,953 | 192,543 | 2.7 | 68,282 | 3,671 |
| 2023 | 4,748 | 11,088 | 2.3 | 4,509 | 239 |
| 2024 | 1,817 | 3,646 | 2.0 | 1,737 | 80 |
| 2025 | 5,457 | 11,058 | 2.0 | 5,155 | 302 |
| **Total** | **433,606** | **1,480,863** | | **410,187** | |

The year rows sum to 433,606 because 21,968 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **411,638**.
