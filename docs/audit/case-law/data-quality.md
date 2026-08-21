# Case law data quality

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../02-methodology.md) for how each number is produced.

## Every Supreme Court judgment is invisible to a date filter

This is the most consequential defect found in this audit.

`decision_date` is stored in two different formats:

| Court | Stored format | Example |
|---|---|---|
| High Courts | `YYYY-MM-DD HH:MM:SS` | `2023-08-23 00:00:00` |
| Supreme Court | `DD-MM-YYYY` | `16-09-2020` |

Qdrant's datetime index cannot parse `DD-MM-YYYY`, so it indexes none of those points. The field is present, so an `is_empty` check reports nothing wrong, but a range query matches zero of them.

| Collection | Points | Reachable by a date range | Present but unparseable | Genuinely absent |
|---|---:|---:|---:|---:|
| `legal_corpus_v1` | 19,595,718 | 19,534,503 | 40 | 61,175 |
| `legal_corpus_v2` | 11,823,753 | 11,427,723 | 371,192 | 24,838 |

Of the 371,232 unparseable points, 371,159 are the entire Supreme Court block. Verified directly:

```
filter: court = "Supreme Court of India"
                             -> 371,159 points
filter: court = "Supreme Court of India"
        AND decision_date in [1900-01-01, 2100-01-01)
                             -> 0 points
```

Any query that scopes by date, sorts by recency, or filters to a period drops all Supreme Court authority without an error. The fix is a backfill that rewrites those values to ISO 8601, not a query-side change.

## The two collections overlap heavily

**436,622 case IDs exist in both `legal_corpus_v1` and `legal_corpus_v2`.** Both collections are searched together at query time, so these judgments are embedded twice, stored twice, and can be retrieved twice for one query.

For most affected courts the v2 copy is a strict subset of v1, meaning v2 adds no coverage at all for that court and only adds cost.

| Court | Cases in v1 | Cases in v2 | In both | Unique after dedup |
|---|---:|---:|---:|---:|
| Patna High Court | 1,615,035 | 88,315 | 88,309 | 1,615,041 |
| Bombay High Court | 1,595,945 | 87,101 | 87,098 | 1,595,948 |
| Madras High Court (v2 fully contained in v1) | 1,494,952 | 81,336 | 81,336 | 1,494,952 |
| Telangana High Court (v2 fully contained in v1) | 1,004,138 | 54,445 | 54,445 | 1,004,138 |
| Andhra Pradesh High Court (v2 fully contained in v1) | 254,482 | 35,029 | 35,029 | 254,482 |
| Chhattisgarh High Court (v2 fully contained in v1) | 508,791 | 27,411 | 27,411 | 508,791 |
| Gujarat High Court | 411,637 | 21,969 | 21,968 | 411,638 |
| Delhi High Court (v2 fully contained in v1) | 322,940 | 17,214 | 17,214 | 322,940 |
| Gauhati High Court | 285,712 | 15,544 | 15,542 | 285,714 |
| Himachal Pradesh High Court | 101,766 | 87,912 | 5,503 | 184,175 |
| Allahabad High Court | 1,498,161 | 2,364 | 2,275 | 1,498,250 |
| Uttarakhand High Court | 123,643 | 453 | 243 | 123,853 |
| Calcutta High Court | 202,310 | 497 | 242 | 202,565 |
| Sikkim High Court | 436 | 20 | 3 | 453 |
| Tripura High Court (v2 fully contained in v1) | 18,942 | 3 | 3 | 18,942 |
| Punjab and Haryana High Court | 3 | 483,251 | 1 | 483,253 |
| Karnataka High Court | 1 | 581,275 | 0 | 581,276 |
| Kerala High Court | 3 | 916,187 | 0 | 916,190 |
| Madhya Pradesh High Court | 1 | 402,631 | 0 | 402,632 |
| Rajasthan High Court | 2 | 324,565 | 0 | 324,567 |

## Qdrant against the Supabase mirror

`legal_cases` is the metadata mirror that powers browse and citation lookup, and Qdrant is what retrieval can actually reach. The two are built by different pipelines, so comparing them shows where a judgment is listed but not searchable, or embedded but not listed.

They agree closely, which is the main reason to trust both. The exceptions are worth acting on.

| Court | Cases in Qdrant | Rows in Supabase | Delta | Delta % |
|---|---:|---:|---:|---:|
| Supreme Court of India | 34,954 | 37,879 | -2,925 | -7.722% |
| Gujarat High Court | 411,638 | 410,187 | +1,451 | +0.354% |
| Punjab and Haryana High Court | 483,253 | 482,424 | +829 | +0.172% |
| Gauhati High Court | 285,714 | 285,277 | +437 | +0.153% |
| Karnataka High Court | 581,276 | 580,888 | +388 | +0.067% |
| Rajasthan High Court | 324,567 | 324,241 | +326 | +0.101% |
| Himachal Pradesh High Court | 184,175 | 183,933 | +242 | +0.132% |
| Telangana High Court | 1,004,138 | 1,003,990 | +148 | +0.015% |
| Tripura High Court | 18,942 | 18,815 | +127 | +0.675% |
| Meghalaya High Court | 6,261 | 6,200 | +61 | +0.984% |
| Madhya Pradesh High Court | 402,632 | 402,595 | +37 | +0.009% |
| Bombay High Court | 1,595,948 | 1,595,927 | +21 | +0.001% |
| Chhattisgarh High Court | 508,791 | 508,771 | +20 | +0.004% |
| Orissa High Court | 283,063 | 283,055 | +8 | +0.003% |
| Jammu & Kashmir High Court | 40,289 | 40,282 | +7 | +0.017% |
| Kerala High Court | 916,190 | 916,195 | -5 | -0.001% |
| Jharkhand High Court | 246,374 | 246,379 | -5 | -0.002% |
| Allahabad High Court | 1,498,250 | 1,498,245 | +5 | +0.000% |
| Patna High Court | 1,615,041 | 1,615,037 | +4 | +0.000% |
| Delhi High Court | 322,940 | 322,936 | +4 | +0.001% |
| Uttarakhand High Court | 123,853 | 123,851 | +2 | +0.002% |
| Madras High Court | 1,494,952 | 1,494,950 | +2 | +0.000% |
| Andhra Pradesh High Court | 254,482 | 254,480 | +2 | +0.001% |
| Calcutta High Court | 202,565 | 202,564 | +1 | +0.000% |
| Sikkim High Court | 453 | 453 | +0 | +0.000% |
| Manipur High Court | 7,903 | 7,903 | +0 | +0.000% |
| **Total** | **12,848,644** | **12,847,457** | **+1,187** | **+0.009%** |

Across 26 courts and 12,847,457 judgments the two systems differ by 1,187 records, 0.009%.

The Supreme Court is the one real outlier, and it is the wrong direction.
**2,925 Supreme Court judgments have a metadata row but no vectors in Qdrant**, 7.7% of the court.
They appear in browse and resolve by citation, but retrieval cannot cite or quote them, because there is nothing embedded to retrieve.
For the only court that binds nationally this is the highest-value backlog in the corpus.

Where Qdrant is instead slightly ahead of Supabase, that is the normal direction: chunks were written and the metadata backfill has not caught up.

## Missing payload values

| Field | v1 | v2 | Combined | Share of corpus |
|---|---:|---:|---:|---:|
| `case_number` | 1,684,422 | 761,337 | 2,445,759 | 7.8% |
| `citation` | 19,595,718 | 11,452,594 | 31,048,312 | 98.8% |
| `court` | 125,741 | 75,786 | 201,527 | 0.6% |
| `decision_date` | 61,175 | 24,838 | 86,013 | 0.3% |
| `disposition` | 317,637 | 31,543 | 349,180 | 1.1% |
| `judges` | 12,113,348 | 6,846,014 | 18,959,362 | 60.3% |

`citation` is empty on every one of the 19,595,718 points in `legal_corpus_v1` and on all High Court points in `legal_corpus_v2`.
Only Supreme Court points carry a formal citation, so citation lookup against the corpus works for the Supreme Court alone.

`judges` is empty on 18,959,362 points, which is why judge is not offered as a browse facet.

## Indexed but never populated

Both collections carry payload indexes on fields no document ever sets.

| Field | v1 | v2 |
|---|---|---|
| `bench_type` | empty | empty |
| `case_type` | empty | empty |
| `language_code` | empty | populated |
| `state_name` | populated | empty |

## Impossible decision dates in the Supabase mirror

`legal_cases.decision_date` contains dates that cannot be real judgments.
These flow straight into browse ordering, which sorts by `decision_date DESC`, so a case dated 2088 pins itself to the top of the list.

| Court | Latest decision_date on record |
|---|---|
| Patna High Court | 2030-05-06 |
| Gauhati High Court | 2029-04-05 |
| (no court, `court_type = high_court`) | 2088-11-28 |

## The unattributed block in the Supabase mirror

**310,016 rows** in `legal_cases` have no `court_normalized` value. They split into two very different populations.

| Population | Rows | With PDF | With case name | Year range |
|---|---:|---:|---:|---|
| `court_type` also null | 247,479 | 14 | 14 | 13 to 9916 |
| `court_type = high_court` | 62,537 | 62,530 | 55,018 | 1997 to 2025 |

The first group is citation-only stubs: all 247,479 rows have a citation, but only 14 have a PDF and only 14 have a case name.
Their `year` column ranges from 13 to 9916, which means the year was parsed out of citation strings and frequently picked up a volume or page number instead.

Only 74,368 of the 310,016 unattributed rows link to a corpus document at all.
