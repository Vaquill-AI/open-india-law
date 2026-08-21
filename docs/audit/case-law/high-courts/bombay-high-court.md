# Bombay High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 1,595,948 |
| Text chunks in Qdrant | 2,958,802 |
| Metadata rows in Supabase `legal_cases` | 1,595,927 |
| Earliest decision | 1908-07-28 |
| Latest decision (data cutoff) | 2025-11-14 |
| Years with at least one case | 40 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 87,098 |
| Supabase rows with a PDF (`r2_url`) | 1,595,905 |
| Supabase rows flagged full text | 1,595,927 |
| Supabase rows with a case name | 1,595,208 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `Bombay High Court` | v1 | 2,804,382 | 1,584,031 |
| `Bombay High Court` | v2 | 137,344 | 86,455 |
| `High Court of Bombay` | v1 | 16,221 | 11,903 |
| `High Court of Bombay` | v2 | 824 | 646 |
| `High Court of Mumbai` | v1 | 27 | 9 |
| `High Court of Aurangabad` | v1 | 3 | 1 |
| `High Court of Nagpur` | v1 | 1 | 1 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1953 | 2 | 2 | 1.0 | 2 | 0 |
| 1955 | 5 | 5 | 1.0 | 5 | 0 |
| 1958 | 1 | 1 | 1.0 | 1 | 0 |
| 1962 | 5 | 5 | 1.0 | 5 | 0 |
| 1969 | 4 | 4 | 1.0 | 4 | 0 |
| 1971 | 6 | 6 | 1.0 | 5 | 1 |
| 1974 | 1 | 2 | 2.0 | 1 | 0 |
| 1976 | 7 | 7 | 1.0 | 6 | 1 |
| 1989 | 20 | 22 | 1.1 | 20 | 0 |
| 1992 | 20 | 28 | 1.4 | 18 | 2 |
| 1994 | 75 | 96 | 1.3 | 71 | 4 |
| 1996 | 133 | 159 | 1.2 | 122 | 11 |
| 1997 | 165 | 174 | 1.1 | 152 | 13 |
| 1999 | 7 | 14 | 2.0 | 6 | 1 |
| 2000 | 1 | 4 | 4.0 | 1 | 0 |
| 2001 | 15 | 48 | 3.2 | 13 | 2 |
| 2002 | 406 | 1,521 | 3.7 | 389 | 17 |
| 2003 | 1,815 | 3,800 | 2.1 | 1,712 | 103 |
| 2004 | 15,732 | 24,748 | 1.6 | 14,918 | 814 |
| 2005 | 48,986 | 64,422 | 1.3 | 46,408 | 2,578 |
| 2006 | 47,137 | 64,937 | 1.4 | 44,636 | 2,501 |
| 2007 | 52,890 | 68,816 | 1.3 | 50,131 | 2,759 |
| 2008 | 59,577 | 78,721 | 1.3 | 56,564 | 3,013 |
| 2009 | 80,713 | 110,597 | 1.4 | 76,593 | 4,120 |
| 2010 | 89,866 | 123,251 | 1.4 | 85,162 | 4,704 |
| 2011 | 91,560 | 125,663 | 1.4 | 86,836 | 4,724 |
| 2012 | 85,466 | 131,493 | 1.5 | 80,986 | 4,480 |
| 2013 | 89,626 | 135,099 | 1.5 | 84,871 | 4,755 |
| 2014 | 90,842 | 147,404 | 1.6 | 86,184 | 4,658 |
| 2015 | 96,231 | 179,603 | 1.9 | 91,242 | 4,989 |
| 2016 | 98,013 | 186,716 | 1.9 | 92,914 | 5,099 |
| 2017 | 99,121 | 216,886 | 2.2 | 93,927 | 5,194 |
| 2018 | 96,860 | 215,077 | 2.2 | 91,879 | 4,981 |
| 2019 | 102,592 | 187,654 | 1.8 | 97,337 | 5,255 |
| 2020 | 34,882 | 64,854 | 1.9 | 33,088 | 1,794 |
| 2021 | 67,857 | 138,852 | 2.0 | 64,420 | 3,437 |
| 2022 | 98,484 | 255,884 | 2.6 | 93,446 | 5,038 |
| 2023 | 108,630 | 193,255 | 1.8 | 103,094 | 5,536 |
| 2024 | 77,818 | 148,927 | 1.9 | 73,777 | 4,041 |
| 2025 | 47,475 | 90,045 | 1.9 | 44,981 | 2,494 |
| **Total** | **1,683,046** | **2,958,802** | | **1,595,927** | |

The year rows sum to 1,683,046 because 87,098 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **1,595,948**.
