# Machine-readable data

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../02-methodology.md) for how each number is produced.

These are the raw extraction dumps. Every table in this folder tree is generated from them.

For flat tables to open in a spreadsheet, use [../csv/](../csv/) instead.

| File | Contents |
|---|---|
| `legal_corpus_v1.json` | full raw extraction for the v1 Qdrant collection |
| `legal_corpus_v2.json` | full raw extraction for the v2 Qdrant collection |
| `acts_india.json` | full raw extraction for the legislation collection |
| `supabase_legal_cases.json` | per court and year exact counts from the Supabase mirror |
| `supabase_court_aggregates.json` | per court aggregates from the Supabase mirror |
| `overlap.json` | exact cross-collection duplicate case IDs |
| `date_index.json` | how many points each collection exposes to a date filter |

The JSON dumps carry per-year consistency flags (`consistent`, `chunks_expected`) so any bucket where the facet and the exact count disagreed can be found without re-running the extraction.
