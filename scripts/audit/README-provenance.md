# Audit tooling

These scripts produced every number in [`../../docs/audit/`](../../docs/audit/).
They are read-only against Qdrant, Supabase and R2, and they are kept so the
figures can be re-derived rather than taken on trust.

Run order and per-script notes are in [`README.md`](README.md).

They target infrastructure that is being decommissioned, so treat them as a
record of method rather than as scripts that will run unchanged. The method is
the durable part: exact facet counts on a keyword index with a truncation guard,
and month-window splitting when a bucket is too large to facet in one pass.
