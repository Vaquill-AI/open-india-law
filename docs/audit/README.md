# India legal corpus coverage

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](02-methodology.md) for how each number is produced.

This folder is the exact inventory of every piece of Indian legal content Vaquill holds: case law and legislation, per court, per state, per year.

## Headline

| | Case law | Legislation |
|---|---:|---:|
| Documents | 12,848,644 judgments | 22,265 instruments |
| Embedded chunks | 31,217,941 | 1,098,577 |
| Courts / states | 26 courts | 37 state buckets |
| Earliest | 1908-07-28 | 1806 |
| Latest on record | 2030-05-06 | 2026 |
| Practical cutoff | 2025 | 2026 |
| Qdrant collections | `legal_corpus_v1`, `legal_corpus_v2` | `acts_india` |

The latest case-law date on record is not a real judgment date. A handful of rows carry impossible future dates, so the practical cutoff row above is the one to quote. See [case-law/data-quality.md](case-law/data-quality.md).

Combined that is **32,316,518 embedded chunks** covering **12,870,909 distinct legal documents**.

A further **201,527 case-law chunks carry no court label at all** and are excluded from the per-court figures above, because no court filter can reach them. They are counted in [case-law/README.md](case-law/README.md).

## Read this first

- [01-summary.md](01-summary.md) what we have, what we do not have, and what is broken
- [02-methodology.md](02-methodology.md) how every number here was produced and why it is exact

## Case law

- [case-law/README.md](case-law/README.md) all courts ranked, with the v1 / v2 split
- [case-law/coverage-matrix.md](case-law/coverage-matrix.md) court by year, one grid
- [case-law/supreme-court.md](case-law/supreme-court.md) Supreme Court of India
- [case-law/high-courts/](case-law/high-courts/) one page per High Court, year by year
- [case-law/tribunals.md](case-law/tribunals.md) tribunal coverage
- [case-law/court-name-variants.md](case-law/court-name-variants.md) duplicate court labels
- [case-law/data-quality.md](case-law/data-quality.md) missing fields and impossible dates

## Legislation

- [legislation/README.md](legislation/README.md) acts, rules and regulations overview
- [legislation/by-state.md](legislation/by-state.md) every state and territory
- [legislation/by-year.md](legislation/by-year.md) enactment year profile
- [legislation/data-quality.md](legislation/data-quality.md) schema problems

## Machine-readable

- [Vaquill-India-Coverage.xlsx](Vaquill-India-Coverage.xlsx) **the client workbook.** Courts, tribunals, legislation and regulators in nine tabs, plain English, safe to share outside the company. Built by `build_merged_report.py`.
- [csv/](csv/) the same tables as 17 individual CSVs, for scripting and diffs
- [data/](data/) the raw extraction dumps behind every number here

## Regenerating

```bash
python3 scripts/audit/extract_india_corpus.py acts_india legal_corpus_v2 legal_corpus_v1
python3 scripts/audit/extract_supabase_cases.py
python3 scripts/audit/check_overlap.py
python3 scripts/audit/build_docs.py
```

The extraction step reads every point in all three collections and takes a few hours. It is read-only.
