# Telangana High Court

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../../02-methodology.md) for how each number is produced.

## Headline

| Metric | Value |
|---|---|
| Distinct cases in Qdrant (searchable) | 1,004,138 |
| Text chunks in Qdrant | 2,843,851 |
| Metadata rows in Supabase `legal_cases` | 1,003,990 |
| Earliest decision | 1963-06-28 |
| Latest decision (data cutoff) | 2025-10-17 |
| Years with at least one case | 35 |
| Qdrant collections | v1, v2 |
| Cases present in both v1 and v2 (deduplicated here) | 54,445 |
| Supabase rows with a PDF (`r2_url`) | 1,003,990 |
| Supabase rows flagged full text | 1,003,990 |
| Supabase rows with a case name | 1,003,936 |

## Raw court labels in Qdrant

| Label as stored | Collection | Chunks | Cases |
|---|---|---:|---:|
| `High Court  for State of Telangana` | v1 | 2,727,633 | 1,003,962 |
| `High Court  for State of Telangana` | v2 | 115,721 | 54,432 |
| `High Court of Hyderabad` | v1 | 462 | 173 |
| `High Court of Hyderabad` | v2 | 30 | 13 |
| `High Court of Telangana` | v1 | 5 | 3 |

## Year by year

`Cases` and `Chunks` are exact counts from Qdrant. `Supabase rows` is the metadata mirror for the same court and year, shown so the gap between what is stored and what is searchable is visible.

| Year | Cases | Chunks | Chunks/case | Supabase rows | Delta |
|---:|---:|---:|---:|---:|---:|
| 1963 | 1 | 1 | 1.0 | 1 | 0 |
| 1991 | 1 | 1 | 1.0 | 1 | 0 |
| 1993 | 6 | 6 | 1.0 | 6 | 0 |
| 1994 | 15 | 23 | 1.5 | 13 | 2 |
| 1995 | 17 | 29 | 1.7 | 17 | 0 |
| 1996 | 33 | 58 | 1.8 | 32 | 1 |
| 1997 | 42 | 48 | 1.1 | 42 | 0 |
| 1998 | 48 | 63 | 1.3 | 45 | 3 |
| 1999 | 58 | 99 | 1.7 | 54 | 4 |
| 2000 | 46 | 93 | 2.0 | 44 | 2 |
| 2001 | 116 | 181 | 1.6 | 115 | 1 |
| 2002 | 184 | 404 | 2.2 | 172 | 12 |
| 2003 | 365 | 640 | 1.8 | 348 | 17 |
| 2004 | 20,450 | 121,089 | 5.9 | 19,449 | 1,001 |
| 2005 | 29,334 | 116,848 | 4.0 | 27,888 | 1,446 |
| 2006 | 26,740 | 51,157 | 1.9 | 25,353 | 1,387 |
| 2007 | 34,164 | 56,832 | 1.7 | 32,360 | 1,804 |
| 2008 | 29,821 | 65,135 | 2.2 | 28,235 | 1,586 |
| 2009 | 34,119 | 64,315 | 1.9 | 32,357 | 1,762 |
| 2010 | 56,788 | 99,833 | 1.8 | 53,806 | 2,982 |
| 2011 | 63,601 | 199,346 | 3.1 | 60,412 | 3,189 |
| 2012 | 63,020 | 140,325 | 2.2 | 59,759 | 3,261 |
| 2013 | 56,692 | 92,707 | 1.6 | 53,683 | 3,009 |
| 2014 | 66,775 | 131,937 | 2.0 | 63,340 | 3,435 |
| 2015 | 61,787 | 142,057 | 2.3 | 58,515 | 3,272 |
| 2016 | 69,620 | 131,823 | 1.9 | 66,021 | 3,599 |
| 2017 | 62,331 | 116,504 | 1.9 | 59,035 | 3,296 |
| 2018 | 70,257 | 130,645 | 1.9 | 66,543 | 3,714 |
| 2019 | 35,523 | 59,602 | 1.7 | 33,738 | 1,785 |
| 2020 | 22,956 | 65,915 | 2.9 | 21,835 | 1,121 |
| 2021 | 40,631 | 132,937 | 3.3 | 38,576 | 2,055 |
| 2022 | 74,265 | 266,203 | 3.6 | 70,436 | 3,829 |
| 2023 | 69,720 | 324,763 | 4.7 | 66,198 | 3,522 |
| 2024 | 39,845 | 169,893 | 4.3 | 37,796 | 2,049 |
| 2025 | 29,212 | 162,339 | 5.6 | 27,765 | 1,447 |
| **Total** | **1,058,583** | **2,843,851** | | **1,003,990** | |

The year rows sum to 1,058,583 because 54,445 case IDs appear in both `legal_corpus_v1` and `legal_corpus_v2`. The deduplicated case count for this court is **1,004,138**.
