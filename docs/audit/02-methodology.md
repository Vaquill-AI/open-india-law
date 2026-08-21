# Methodology

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](02-methodology.md) for how each number is produced.

## Why these numbers are exact

Nothing here is sampled, estimated or extrapolated.

### Counting documents, not chunks

Qdrant stores one point per text chunk, so a point count is not a document count. A judgment is spread over anywhere from 1 to several hundred chunks, all sharing one `case_id`.

Distinct documents are counted with the Qdrant **facet API** on the `case_id` keyword index with `exact: true`, which enumerates every distinct value in a filtered set. The number of returned values is the exact document count.

### The truncation guard

A facet returns at most `limit` values, so a bucket with more distinct values than the limit would silently under-report. Every facet result is checked against an independent exact `count` over the identical filter:

```
sum(chunk counts returned by the facet) == exact point count for the filter
```

Chunks are partitioned by `case_id`, so those two numbers can only agree if the facet enumerated every case. Each per-year row records this check as `consistent`, and any mismatch is logged loudly rather than being averaged away.

### Buckets too large for one facet

A facet over a multi-million-point bucket can exhaust server memory. When one fails, the extractor splits that bucket into month windows on the `decision_date` index and unions the results on `case_id`. Because a judgment has a single decision date the windows do not overlap, and the union is taken on the ID itself so a duplicate would still collapse to one document.

### Court totals

A court total is the size of the **union** of its per-year `case_id` sets, not the sum of the per-year counts. If one `case_id` appeared under two different years the sum would double-count it; the union does not. Where the two differ the delta is reported per court.

### Cross-collection duplicates

`legal_corpus_v1` and `legal_corpus_v2` both hold High Court judgments and several courts appear in both. Adding their case counts would double-count any judgment ingested twice. For every court present in both collections, all `case_id` values were pulled from the smaller side and probed against the larger side in batches with `MatchAny`, giving the exact size of the intersection. Reported court and corpus totals subtract it.

### Date ranges

Earliest and latest decision dates come from an ordered scroll on the `decision_date` datetime index, ascending and descending, one point each. That is the true minimum and maximum, not the extremes of a sample.

## Sources

| Source | What it provides |
|---|---|
| Qdrant `legal_corpus_v1` | High Court judgments, older ingest |
| Qdrant `legal_corpus_v2` | High Court and Supreme Court judgments, newer ingest |
| Qdrant `acts_india` | Central and state legislation, one point per provision |
| Supabase `public.legal_cases` | Case metadata mirror that powers browse and citation lookup |

Qdrant is reached at `QDRANT_CORPUS_URL` with `QDRANT_CORPUS_API_KEY` from `.env`.

## Known limits of this report

- Supabase per-year counts for the unattributed block (rows with no `court_normalized`) are missing. The index that serves per-court-per-year counts is partial, `WHERE court_normalized IS NOT NULL`, so counting that block seq-scans the table and exceeds the statement timeout. Those cells read `n/a` rather than 0. The block totals are still exact and come from a server-side aggregate.
- Court-name normalization merges spelling variants. Mappings taken from the application's own `COURT_NAME_VARIANTS` are separated from ones inferred for this report in [case-law/court-name-variants.md](case-law/court-name-variants.md).
- `decision_date` in the raw payload has inconsistent formats. Dates are normalized to `YYYY-MM-DD` for display only, never for counting.
