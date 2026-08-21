# Kerala High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 916,190 |
| Text chunks in Qdrant | 3,125,035 |
| Metadata rows in Supabase `legal_cases` | 916,195 |
| Earliest decision | 1950-02-07 |
| Latest decision (data cutoff) | 2024-12-20 |
| Years with at least one case | 40 |
| Qdrant collections | v1, v2 |
| Supabase rows with a PDF (`r2_url`) | 916,195 |
| Supabase rows flagged full text | 916,195 |
| Supabase rows with a case name | 916,195 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court of Kerala` | v2 | 3,125,018 | 916,187 |
| `High Court of Kerala` | v1 | 17 | 3 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1950 | 1 | 1 | 1.0 | 1 | 0 |
| 1951 | 2 | 3 | 1.5 | 2 | 0 |
| 1952 | 3 | 4 | 1.3 | 3 | 0 |
| 1953 | 2 | 4 | 2.0 | 2 | 0 |
| 1954 | 6 | 15 | 2.5 | 6 | 0 |
| 1955 | 10 | 24 | 2.4 | 10 | 0 |
| 1956 | 7 | 10 | 1.4 | 7 | 0 |
| 1958 | 6 | 15 | 2.5 | 6 | 0 |
| 1970 | 1 | 2 | 2.0 | 1 | 0 |
| 1980 | 1 | 1 | 1.0 | 1 | 0 |
| 1982 | 1 | 5 | 5.0 | 1 | 0 |
| 1985 | 7 | 16 | 2.3 | 7 | 0 |
| 1987 | 1 | 3 | 3.0 | 1 | 0 |
| 1997 | 2 | 5 | 2.5 | 2 | 0 |
| 1998 | 1 | 12 | 12.0 | 1 | 0 |
| 1999 | 2 | 22 | 11.0 | 2 | 0 |
| 2000 | 2 | 3 | 1.5 | 2 | 0 |
| 2001 | 3 | 13 | 4.3 | 3 | 0 |
| 2002 | 2 | 3 | 1.5 | 2 | 0 |
| 2003 | 2 | 6 | 3.0 | 2 | 0 |
| 2005 | 41 | 240 | 5.9 | 41 | 0 |
| 2006 | 4,614 | 8,947 | 1.9 | 4,614 | 0 |
| 2007 | 41,974 | 71,769 | 1.7 | 41,974 | 0 |
| 2008 | 48,445 | 82,311 | 1.7 | 48,445 | 0 |
| 2009 | 43,029 | 82,160 | 1.9 | 43,028 | 1 |
| 2010 | 43,472 | 82,201 | 1.9 | 43,471 | 1 |
| 2011 | 45,159 | 90,491 | 2.0 | 45,158 | 1 |
| 2012 | 46,742 | 95,591 | 2.0 | 46,742 | 0 |
| 2013 | 43,870 | 94,432 | 2.2 | 43,870 | 0 |
| 2014 | 46,899 | 100,568 | 2.1 | 46,898 | 1 |
| 2015 | 50,239 | 109,407 | 2.2 | 50,241 | -2 |
| 2016 | 50,760 | 105,754 | 2.1 | 50,760 | 0 |
| 2017 | 48,551 | 100,660 | 2.1 | 48,552 | -1 |
| 2018 | 60,623 | 154,534 | 2.5 | 60,624 | -1 |
| 2019 | 66,414 | 373,404 | 5.6 | 66,414 | 0 |
| 2020 | 43,551 | 221,380 | 5.1 | 43,551 | 0 |
| 2021 | 48,594 | 238,290 | 4.9 | 48,593 | 1 |
| 2022 | 68,458 | 431,780 | 6.3 | 68,460 | -2 |
| 2023 | 74,319 | 365,364 | 4.9 | 74,322 | -3 |
| 2024 | 40,374 | 315,585 | 7.8 | 40,375 | -1 |
| **Total** | **916,190** | **3,125,035** | | **916,195** | |
