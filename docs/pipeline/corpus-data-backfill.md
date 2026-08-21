---
name: Corpus Data Backfill
description: Reference for backfilling Supabase legal_cases from Qdrant corpus metadata. Covers case_name backfill pattern, Qdrant scroll optimization, and Supabase batch UPDATE via RPC.
---

# Corpus Data Backfill Reference

Use this skill when backfilling metadata from Qdrant corpus collections into Supabase `legal_cases` table, or when doing similar large-scale data migration between Qdrant and Supabase.

## Architecture

### Data Sources
- **Qdrant** (`our production Qdrant`): 31.4M vectors across 2 collections
  - `legal_corpus_v1`: ~19.6M vectors (~9.8M unique cases, HC only)
  - `legal_corpus_v2`: ~11.8M vectors (~5.9M unique cases, SC + HC)
- **Supabase** (`legal_cases` table): 13.16M rows
  - Join key: `legal_cases.corpus_case_id` = Qdrant payload `case_id`
  - Index: `idx_legal_cases_corpus_id` (btree on corpus_case_id)

### Qdrant Payload Fields Available for Backfill
```
case_id, title, petitioner, respondent, court, court_type, year,
decision_date, case_number, bench, bench_strength, judges,
description, disposition, pdf_url, section_type, chunk_index
```

## case_name Backfill (2026-02-25)

### Problem
Only 35K of 13.1M legal_cases rows had `case_name` populated (all Supreme Court S.C.R. corpus). The 13M+ High Court rows had null `case_name`.

### Solution
Qdrant's `title` field contains the case name directly (e.g., "WP/22967/2016 of Mettu Ravinder, Vs The Union of India,"). No parsing needed — use title as-is.

### Script
`scripts/backfill_case_names.py`

```bash
# Dry run
python scripts/backfill_case_names.py --dry-run

# Full backfill
python scripts/backfill_case_names.py

# Resume from checkpoint after interruption
python scripts/backfill_case_names.py --resume

# Single collection
python scripts/backfill_case_names.py --collection v1

# Custom concurrency (default: 15)
python scripts/backfill_case_names.py --concurrency 20
```

### SQL Function
Migration: `backfill_case_names_rpc` — creates `backfill_case_names(p_updates jsonb)` function.

Key features:
- `SET statement_timeout = '120s'` — overrides Supabase default 8s timeout
- `WHERE case_name IS NULL` — idempotent, safe to re-run
- Accepts JSON array of `{case_id, title}` pairs
- Returns count of rows updated

### Performance Optimizations Discovered

1. **chunk_index=0 filter**: Scrolls ~15.7M points instead of 31.4M (one point per case). Qdrant payload field `chunk_index` identifies the first chunk.

2. **GIN index must be dropped**: The `idx_legal_cases_case_name_gin` (full-text search) causes massive slowdown during bulk UPDATEs. Drop before backfill, recreate after:
   ```sql
   -- Before backfill
   DROP INDEX IF EXISTS idx_legal_cases_case_name_gin;

   -- After backfill
   CREATE INDEX idx_legal_cases_case_name_gin
     ON public.legal_cases
     USING gin (to_tsvector('english'::regconfig, COALESCE(case_name, ''::text)));
   ```

3. **Statement timeout override**: Supabase default is ~8s. RPC function sets `SET statement_timeout = '120s'` to handle 500-row batch UPDATEs.

4. **Concurrent RPC calls**: 15 parallel calls with asyncio.Semaphore. Each call updates 500 rows. Total burst: 7,500 rows per cycle.

5. **Lock timeout retry**: Concurrent UPDATEs can hit `55P03` (lock_timeout). Script retries up to 3 times with exponential backoff.

6. **Qdrant scroll with selective payload**: Only request needed fields to minimize bandwidth:
   ```python
   "with_payload": {"include": ["case_id", "title"]}
   ```

### Throughput
- Qdrant scroll: ~1,400 cases/sec (10K per batch)
- Supabase update: ~1,000-1,400 rows/sec effective
- Full backfill ETA: ~2-3 hours for 15.7M cases

### Checkpoint & Resume
- Checkpoint file: `scripts/.case_name_backfill_checkpoint.json`
- Saves every 10 scroll batches (100K cases)
- Stores Qdrant scroll offset + stats
- Use `--resume` flag to continue from checkpoint

### Cleanup After Backfill
```sql
-- Drop the temporary RPC function
DROP FUNCTION IF EXISTS backfill_case_names;

-- Recreate the GIN index
CREATE INDEX idx_legal_cases_case_name_gin
  ON public.legal_cases
  USING gin (to_tsvector('english'::regconfig, COALESCE(case_name, ''::text)));
```

## General Pattern for Qdrant-to-Supabase Backfills

1. **Investigate both sides**: Check Qdrant payloads (`points/scroll` with small limit) and Supabase schema/stats
2. **Create SQL function** with `SET statement_timeout = '120s'` for batch UPDATEs
3. **Use chunk_index=0 filter** to deduplicate (one point per case)
4. **Drop expensive indexes** (GIN, trigram) before bulk writes
5. **Concurrent RPC calls** (10-15) with retry on timeout/lock errors
6. **Checkpoint for resume** — essential for multi-hour jobs
7. **Recreate indexes** after backfill completes
