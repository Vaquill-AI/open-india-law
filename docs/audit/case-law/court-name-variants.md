# Court name variants in the raw corpus

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../02-methodology.md) for how each number is produced.

The `court` payload field was never normalized at ingest.
The same court is stored under several spellings, and some of them hold only a handful of cases, which is a sign of a broken parse rather than a real court.
Any query that filters on an exact court string will silently miss the variants.

There are **49 distinct raw labels** resolving to **26 real courts**.

## Every raw label

| Raw label | Chunks | Cases | Collections | Resolves to | Mapping source |
|---|---:|---:|---|---|---|
| `High Court of Kerala` | 3,125,035 | 916,190 | v1, v2 | Kerala High Court | `COURT_NAME_VARIANTS` in code |
| `Bombay High Court` | 2,941,726 | 1,670,486 | v1, v2 | Bombay High Court | already canonical |
| `High Court  for State of Telangana` | 2,843,354 | 1,058,394 | v1, v2 | Telangana High Court | `COURT_NAME_VARIANTS` in code |
| `Madras High Court` | 2,737,956 | 1,571,457 | v1, v2 | Madras High Court | already canonical |
| `Patna High Court` | 2,659,609 | 1,687,961 | v1, v2 | Patna High Court | already canonical |
| `Allahabad High Court` | 1,927,632 | 1,498,915 | v1, v2 | Allahabad High Court | already canonical |
| `High Court Of Chhattisgarh` | 1,809,597 | 536,198 | v1, v2 | Chhattisgarh High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Karnataka` | 1,552,339 | 581,276 | v1, v2 | Karnataka High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Gujarat` | 1,480,863 | 433,606 | v1, v2 | Gujarat High Court | `COURT_NAME_VARIANTS` in code |
| `High Court Of Rajasthan` | 1,356,011 | 324,089 | v2 | Rajasthan High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Punjab and Haryana` | 1,265,076 | 483,223 | v2 | Punjab and Haryana High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Jharkhand` | 1,234,672 | 246,374 | v2 | Jharkhand High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Delhi` | 1,093,462 | 340,154 | v1, v2 | Delhi High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Andhra Pradesh` | 1,032,221 | 289,495 | v1, v2 | Andhra Pradesh High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Madhya Pradesh` | 766,920 | 402,631 | v2 | Madhya Pradesh High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Himachal Pradesh` | 752,558 | 189,678 | v1, v2 | Himachal Pradesh High Court | `COURT_NAME_VARIANTS` in code |
| `Gauhati High Court` | 684,827 | 299,135 | v1, v2 | Gauhati High Court | already canonical |
| `Orissa High Court` | 500,805 | 282,976 | v2 | Orissa High Court | already canonical |
| `Supreme Court of India` | 371,159 | 34,954 | v2 | Supreme Court of India | already canonical |
| `Calcutta High Court` | 320,983 | 201,034 | v1, v2 | Calcutta High Court | already canonical |
| `High Court of Uttarakhand` | 262,048 | 124,096 | v1, v2 | Uttarakhand High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Jammu and Kashmir` | 240,966 | 40,288 | v2 | Jammu & Kashmir High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Tripura` | 138,535 | 18,945 | v1, v2 | Tripura High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Manipur` | 31,643 | 7,903 | v2 | Manipur High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Patna` | 23,135 | 15,389 | v1, v2 | Patna High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Meghalaya` | 22,209 | 6,261 | v2 | Meghalaya High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Bombay` | 17,045 | 12,549 | v1, v2 | Bombay High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Madras` | 8,562 | 4,830 | v1, v2 | Madras High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Gauhati` | 6,562 | 2,120 | v1, v2 | Gauhati High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Sikkim` | 2,678 | 456 | v1, v2 | Sikkim High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Calcutta` | 2,623 | 1,773 | v1, v2 | Calcutta High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Allahabad` | 1,927 | 1,610 | v1, v2 | Allahabad High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Rajasthan` | 1,920 | 478 | v1, v2 | Rajasthan High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Orissa` | 581 | 87 | v2 | Orissa High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Hyderabad` | 492 | 186 | v1, v2 | Telangana High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Haryana` | 59 | 18 | v2 | Punjab and Haryana High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Chandigarh` | 54 | 13 | v1, v2 | Punjab and Haryana High Court | inferred for this report |
| `High Court of Amaravati` | 47 | 15 | v1, v2 | Andhra Pradesh High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Mumbai` | 27 | 9 | v1 | Bombay High Court | inferred for this report |
| `High Court of Chhattisgarh` | 6 | 4 | v1 | Chhattisgarh High Court | `COURT_NAME_VARIANTS` in code |
| `High Court of Telangana` | 5 | 3 | v1 | Telangana High Court | `COURT_NAME_VARIANTS` in code |
| `High Court` | 3 | 3 | v1 | (unresolved court label) | unresolvable |
| `High Court of Aurangabad` | 3 | 1 | v1 | Bombay High Court | inferred for this report |
| `High Court of Andhra` | 2 | 1 | v1 | Andhra Pradesh High Court | inferred for this report |
| `High Court of Guwahati` | 2 | 1 | v1 | Gauhati High Court | inferred for this report |
| `High Court of Jabalpur` | 2 | 1 | v1 | Madhya Pradesh High Court | inferred for this report |
| `High Court of Chennai` | 1 | 1 | v1 | Madras High Court | inferred for this report |
| `High Court of Nagpur` | 1 | 1 | v1 | Bombay High Court | inferred for this report |
| `High Court of Kashmir` | 1 | 1 | v2 | Jammu & Kashmir High Court | inferred for this report |

## Labels the application does not know about

`app/integrations/corpus_qdrant.py` holds a `COURT_NAME_VARIANTS` map used to expand a court filter to its known spellings.
The following labels exist in Qdrant but are **absent from that map**, so a court-filtered query today cannot reach them:

| Raw label | Cases stranded | Should resolve to |
|---|---:|---|
| `High Court of Chandigarh` | 13 | Punjab and Haryana High Court |
| `High Court of Mumbai` | 9 | Bombay High Court |
| `High Court of Andhra` | 1 | Andhra Pradesh High Court |
| `High Court of Aurangabad` | 1 | Bombay High Court |
| `High Court of Chennai` | 1 | Madras High Court |
| `High Court of Guwahati` | 1 | Gauhati High Court |
| `High Court of Jabalpur` | 1 | Madhya Pradesh High Court |
| `High Court of Kashmir` | 1 | Jammu & Kashmir High Court |
| `High Court of Nagpur` | 1 | Bombay High Court |

## The label that cannot be resolved

`High Court` appears as a literal court value on 3 chunks covering 3 cases.
It names no particular court, so it cannot be mapped and those cases are excluded from every court total in this report.
They remain reachable by unfiltered semantic search.

Total cases currently unreachable by an exact court filter: **29**.

This is small in absolute terms but it is a pure correctness bug: adding these keys to `COURT_NAME_VARIANTS` costs nothing and removes a silent-miss class.
