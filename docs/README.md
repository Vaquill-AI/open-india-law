# Documentation

Rescued from the Vaquill application repository during its cleanup, August 2026.
Most of this cannot be regenerated: the audit numbers were produced by exact
full-collection counts against a Qdrant instance that is being decommissioned,
and the research notes were written while the work was live.

## What is here

| Path | What it is |
|---|---|
| [`audit/`](audit/) | The July 2026 corpus audit. Exact counts, not samples, for every court, forum, jurisdiction and year, plus the per-collection defect registers. |
| [`audit/02-methodology.md`](audit/02-methodology.md) | How every number was produced: the Qdrant facet method, the truncation guard, and the month-window split for buckets too large to facet in one pass. Read this before trusting or reproducing any figure. |
| [`audit/case-law/court-name-variants.md`](audit/case-law/court-name-variants.md) | **49 raw `court` labels resolving to 26 real courts.** The field was never normalized at ingest, so any query filtering on an exact court string silently misses variants. Load-bearing for any release. |
| [`audit/csv/`](audit/csv/) | The audit as 17 machine-readable tables. |
| [`audit/data/`](audit/data/) | Raw facet dumps from the extraction run, one JSON per collection. |
| [`research/translation-stack-analysis/`](research/translation-stack-analysis/) | Evaluation of the Indic translation stack (IndicTrans2, IndicTransToolkit, Anuvaad, ULCA), written April 2026. Kept for the reasoning; the stack is not in use. |
| [`pipeline/`](pipeline/) | Operating notes for the High Court extraction pipeline and the corpus backfill patterns. |

## Provenance and accuracy

Everything under `audit/` is dated **2026-07-28** and describes the corpus as it
stood then. Three things have since been measured that contradict or extend it,
and where they disagree the newer figure wins:

- [`../COVERAGE.md`](../COVERAGE.md) carries the July 2026 position plus the
  per-court **held vs embedded** reconciliation from 2026-08-14.
- The Courts tables here and in the workbook count what is **embedded**. They are
  not what is **held**; the two differ by 1,786,868 judgments, and Orissa High
  Court has 283,063 embedded judgments with no extracted text at all.
- `act_status` has a fourth value, `superseded` (57,458 provisions), which
  three-way status splits in these documents fold into "in force". See
  [`../scripts/release/taxonomy.py`](../scripts/release/taxonomy.py).

Internal hostnames, IPs and storage identifiers have been replaced with
placeholders or environment-variable references. Client-identifiable material
has been removed.
