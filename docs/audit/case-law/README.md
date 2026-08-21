# India case law

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../02-methodology.md) for how each number is produced.

## What is here

The India case-law corpus is **12,848,644 distinct judgments** across **31,217,941 embedded text chunks**, spread over **26 courts**.

It lives in two Qdrant collections that were built at different times and never merged:

| Collection | Chunks | Courts | Role |
|---|---:|---:|---|
| `legal_corpus_v1` | 19,595,718 | 37 raw labels | Older High Court ingest, no citation field |
| `legal_corpus_v2` | 11,823,753 | 39 raw labels | Newer ingest, adds the Supreme Court and citations |

Both are searched together at query time (`QDRANT_CORPUS_COLLECTIONS` in `app/core/config.py`).

## Every court, ranked

`Cases` is the exact number of distinct `case_id` values in Qdrant, which is what retrieval can actually reach.
`Supabase` is the row count in the `legal_cases` metadata mirror for the same court.

| # | Court | Cases | Chunks | First decision | Last decision | Supabase rows | Collections |
|---:|---|---:|---:|---|---|---:|---|
| 1 | [Patna High Court](high-courts/patna-high-court.md) | 1,615,041 | 2,682,744 | 1924-12-15 | 2030-05-06 | 1,615,037 | v1, v2 |
| 2 | [Bombay High Court](high-courts/bombay-high-court.md) | 1,595,948 | 2,958,802 | 1908-07-28 | 2025-11-14 | 1,595,927 | v1, v2 |
| 3 | [Allahabad High Court](high-courts/allahabad-high-court.md) | 1,498,250 | 1,929,559 | 1973-07-10 | 2025-12-17 | 1,498,245 | v1, v2 |
| 4 | [Madras High Court](high-courts/madras-high-court.md) | 1,494,952 | 2,746,519 | 1976-03-26 | 2025-11-03 | 1,494,950 | v1, v2 |
| 5 | [Telangana High Court](high-courts/telangana-high-court.md) | 1,004,138 | 2,843,851 | 1963-06-28 | 2025-10-17 | 1,003,990 | v1, v2 |
| 6 | [Kerala High Court](high-courts/kerala-high-court.md) | 916,190 | 3,125,035 | 1950-02-07 | 2024-12-20 | 916,195 | v1, v2 |
| 7 | [Karnataka High Court](high-courts/karnataka-high-court.md) | 581,276 | 1,552,339 | 1998-01-15 | 2025-09-26 | 580,888 | v1, v2 |
| 8 | [Chhattisgarh High Court](high-courts/chhattisgarh-high-court.md) | 508,791 | 1,809,603 | 1970-01-18 | 2025-10-13 | 508,771 | v1, v2 |
| 9 | [Punjab and Haryana High Court](high-courts/punjab-and-haryana-high-court.md) | 483,253 | 1,265,189 | 1989-12-20 | 2025-10-10 | 482,424 | v1, v2 |
| 10 | [Gujarat High Court](high-courts/gujarat-high-court.md) | 411,638 | 1,480,863 | 1982-06-25 | 2025-10-06 | 410,187 | v1, v2 |
| 11 | [Madhya Pradesh High Court](high-courts/madhya-pradesh-high-court.md) | 402,632 | 766,922 | 1994-05-16 | 2024-12-14 | 402,595 | v1, v2 |
| 12 | [Rajasthan High Court](high-courts/rajasthan-high-court.md) | 324,567 | 1,357,931 | 1989-03-31 | 2025-10-17 | 324,241 | v1, v2 |
| 13 | [Delhi High Court](high-courts/delhi-high-court.md) | 322,940 | 1,093,462 | 1960-10-10 | 2026-01-28 | 322,936 | v1, v2 |
| 14 | [Gauhati High Court](high-courts/gauhati-high-court.md) | 285,714 | 691,391 | 1982-03-11 | 2029-04-05 | 285,277 | v1, v2 |
| 15 | [Orissa High Court](high-courts/orissa-high-court.md) | 283,063 | 501,386 | 1992-08-10 | 2025-10-24 | 283,055 | v2 |
| 16 | [Andhra Pradesh High Court](high-courts/andhra-pradesh-high-court.md) | 254,482 | 1,032,270 | 1995-09-18 | 2025-10-23 | 254,480 | v1, v2 |
| 17 | [Jharkhand High Court](high-courts/jharkhand-high-court.md) | 246,374 | 1,234,672 | 1993-01-01 | 2025-09-26 | 246,379 | v2 |
| 18 | [Calcutta High Court](high-courts/calcutta-high-court.md) | 202,565 | 323,606 | 1950-08-14 | 2025-11-27 | 202,564 | v1, v2 |
| 19 | [Himachal Pradesh High Court](high-courts/himachal-pradesh-high-court.md) | 184,175 | 752,558 | 1970-11-25 | 2025-10-09 | 183,933 | v1, v2 |
| 20 | [Uttarakhand High Court](high-courts/uttarakhand-high-court.md) | 123,853 | 262,048 | 1950-01-01 | 2025-10-17 | 123,851 | v1, v2 |
| 21 | [Jammu & Kashmir High Court](high-courts/jammu-kashmir-high-court.md) | 40,289 | 240,967 | 2003-02-21 | 2025-10-18 | 40,282 | v2 |
| 22 | [Supreme Court of India](supreme-court.md) | 34,954 | 371,159 | 1950 (year only) | 2025 (year only) | 37,879 | v2 |
| 23 | [Tripura High Court](high-courts/tripura-high-court.md) | 18,942 | 138,535 | 2013-01-04 | 2025-09-26 | 18,815 | v1, v2 |
| 24 | [Manipur High Court](high-courts/manipur-high-court.md) | 7,903 | 31,643 | 2017-05-19 | 2025-10-05 | 7,903 | v2 |
| 25 | [Meghalaya High Court](high-courts/meghalaya-high-court.md) | 6,261 | 22,209 | 2010-07-06 | 2025-09-15 | 6,200 | v2 |
| 26 | [Sikkim High Court](high-courts/sikkim-high-court.md) | 453 | 2,678 | 2000-03-30 | 2025-09-23 | 453 | v1, v2 |
| | **Total** | **12,848,644** | **31,217,941** | | | **12,847,488** | |

## Chunks with no court label

These points carry no `court` value, so no court filter can ever match them.
They are reachable by plain semantic search but invisible to court-scoped retrieval and to browse.

| Collection | Chunks | Cases |
|---|---:|---:|
| `legal_corpus_v1` | 125,741 | 46,110 |
| `legal_corpus_v2` | 75,786 | 19,007 |

## Also in this folder

- [coverage-matrix.md](coverage-matrix.md) all courts by year in one grid
- [court-name-variants.md](court-name-variants.md) the duplicate court labels in the raw data and how they were resolved
- [tribunals.md](tribunals.md) tribunal coverage
- [supreme-court.md](supreme-court.md) and [high-courts/](high-courts/) one page per court, year by year
