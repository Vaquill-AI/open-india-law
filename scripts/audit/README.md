# India corpus coverage extraction

Read-only tooling that produces [docs/audit/](../../docs/audit/), the exact inventory of the Indian case-law and legislation corpus.

Nothing here writes to Qdrant or Supabase.
Every count is an exact full-collection count, never a sample.
See [docs/audit/02-methodology.md](../../docs/audit/02-methodology.md) for why the numbers are exact and where the guardrails are.

## Running it

```bash
# 1. Qdrant: per collection, per court, per year. This is the slow one.
python3 scripts/audit/extract_india_corpus.py acts_india legal_corpus_v2 legal_corpus_v1

# 2. Supabase legal_cases mirror: per court, per year.
python3 scripts/audit/extract_supabase_cases.py

# 3. Exact cross-collection duplicate case IDs between v1 and v2.
python3 scripts/audit/check_overlap.py

# 4. Render docs/audit/ from the dumps in step 1 to 3.
python3 scripts/audit/build_docs.py

# 5. Flat CSVs for spreadsheets.
python3 scripts/audit/build_csvs.py

# 6. Bundle those CSVs into one .xlsx with a tab each.
#    uv keeps openpyxl out of the project environment.
uv run --with openpyxl python scripts/audit/build_workbook.py
```

Run from the repository root.
Credentials are read from `.env` (`QDRANT_CORPUS_URL`, `QDRANT_CORPUS_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

Step 1 walks every point in all three collections and takes a few hours against the production Qdrant instance.
It checkpoints after each court into `scripts/audit/raw/`, so an interrupted run resumes from where it stopped rather than starting over.

## Files

| File | Role |
|---|---|
| `extract_india_corpus.py` | Qdrant extraction, per collection, court and year |
| `extract_supabase_cases.py` | Supabase `legal_cases` extraction via PostgREST exact counts |
| `check_overlap.py` | exact v1 / v2 duplicate case IDs |
| `build_docs_canon.py` | court-name normalization shared by the steps above |
| `build_docs.py` | renders every markdown page under `docs/audit/` |
| `build_csvs.py` | renders the flat CSVs under `docs/audit/csv/` |
| `build_workbook.py` | bundles those CSVs into `docs/audit/india-corpus-coverage.xlsx` |
| `raw/` | intermediate JSON dumps, also copied into `docs/audit/data/` |

`build_docs.py` reads `raw/` when it exists and falls back to `docs/audit/data/`, so the report and the spreadsheets can be regenerated from the committed dumps without re-running the extraction.

## Load

Step 1 issues a large number of `facet` and `count` calls against production Qdrant.
It runs one collection at a time on purpose.
Running the collections in parallel was tried and pushed the server into HTTP 500s on the largest buckets, so do not reintroduce it.
