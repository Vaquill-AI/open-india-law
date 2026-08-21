"""
Production-grade citation extraction for High Court cases (15M scale).

Self-contained pipeline: Discovers cases from Qdrant → extracts citations → writes to Supabase.
No pre-seeding required (unlike the SC script that uses corpus_seeding_log).

ARCHITECTURE (3-phase pipeline):
  Phase 1: Load existing legal_cases into memory (~2 min)
  Phase 2: Discover unique HC case_ids from Qdrant via metadata-only scroll (~15-30 min)
  Phase 3: For each batch of cases:
           a) Create CORPUS legal_cases in Supabase
           b) Fetch text chunks from Qdrant (cursor-based, Semaphore-limited)
           c) Extract citations via ProcessPoolExecutor (zero shared state)
           d) Deduplicate + batch write EXTRACTED cases + relationships
           e) Checkpoint every N batches

KEY OPTIMIZATIONS (vs naive approach):
  1. Cursor-based scroll pagination (fixes silent data truncation bug)
  2. ProcessPoolExecutor with initializer (true parallelism, not GIL-bound)
  3. Zero-shared-state workers (only regex extraction, main process does lookups)
  4. asyncio.Semaphore(10) for high Qdrant concurrency (16 vCPU server)
  5. In-memory deduplication before DB writes (50-70% fewer writes)
  6. Adaptive batch sizing based on memory pressure (psutil)
  7. Structured error logging (JSONL for post-run analysis)
  8. Graceful shutdown with checkpoint persistence (SIGINT/SIGTERM)

USAGE:
  python scripts/high_court_citation_extraction.py                    # Full run
  python scripts/high_court_citation_extraction.py --limit 100        # Test run
  python scripts/high_court_citation_extraction.py --dry-run          # Discovery only
  python scripts/high_court_citation_extraction.py --collection v1    # Single collection
  python scripts/high_court_citation_extraction.py --reset            # Clear checkpoint
"""

import argparse
import asyncio
import json
import random
import re
import signal
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, ".")


# =============================================================================
# CONFIGURATION
# =============================================================================

COLLECTIONS = {
    "v1": "legal_corpus_v1",
    "v2": "legal_corpus_v2",
}

# Tuning parameters — optimized for M4 Max (36GB, 16 cores) + Qdrant (32GB, 16 vCPU)
DISCOVERY_SCROLL_BATCH = 10_000  # Points per scroll in Phase 2 (metadata-only)
CASE_BATCH_SIZE = 5_000  # Cases per extraction batch in Phase 3
QDRANT_FETCH_BATCH = 500  # Case IDs per Qdrant text-fetch sub-batch (5000/500 = 10 concurrent fetches)
QDRANT_SCROLL_LIMIT = 10_000  # Max points per scroll page
QDRANT_CONCURRENCY = 10  # Max concurrent Qdrant requests (16 vCPU server)
DB_WRITE_BATCH = 5_000  # Rows per Supabase insert
DB_LOOKUP_BATCH = 300  # Norms per Supabase IN() query (keep small — long strings hit URL limits)
CHECKPOINT_EVERY_N_BATCHES = 5  # Checkpoint interval (batches)
PROCESS_WORKERS = 10  # ProcessPoolExecutor workers (M4 Max: 16 cores)
MAX_CHUNKS_PER_CASE = 20  # Max chunks to combine for extraction
MAX_TEXT_LENGTH = 50_000  # Max chars of combined text per case
RETRY_MAX = 5  # Max retries per Qdrant/DB operation
EXTRACTION_TIMEOUT = 30  # Seconds per worker task
PREFETCH_BATCHES = 2  # Number of text-fetch batches to prefetch ahead

CHECKPOINT_FILE = Path("scripts/.checkpoint_hc_extraction.json")  # Legacy (overridden per-collection)
ERROR_LOG_FILE = Path("scripts/.errors_hc_extraction.jsonl")  # Legacy (overridden per-collection)
DISCOVERY_CACHE_DIR = Path("scripts/.discovery_cache")


def get_checkpoint_file(collection_key: str | None) -> Path:
    """Get collection-specific checkpoint file path."""
    if collection_key:
        return Path(f"scripts/.checkpoint_hc_{collection_key}.json")
    return CHECKPOINT_FILE  # Fallback for --collection not specified


def get_error_log_file(collection_key: str | None) -> Path:
    """Get collection-specific error log file path."""
    if collection_key:
        return Path(f"scripts/.errors_hc_{collection_key}.jsonl")
    return ERROR_LOG_FILE

# =============================================================================
# GLOBAL STATE
# =============================================================================

_shutdown_requested = False


def _signal_handler(signum, frame):
    global _shutdown_requested
    if _shutdown_requested:
        print("\nForce quit. Progress may be lost.", flush=True)
        sys.exit(1)
    print("\nShutdown requested. Finishing current batch...", flush=True)
    _shutdown_requested = True


signal.signal(signal.SIGINT, _signal_handler)
signal.signal(signal.SIGTERM, _signal_handler)


# =============================================================================
# WORKER FUNCTIONS (Module-level for pickle compatibility)
# =============================================================================

_worker_extractor = None


def _init_worker():
    """Initialize CitationExtractor once per worker process."""
    global _worker_extractor
    from app.rag.citations.extractor import CitationExtractor

    _worker_extractor = CitationExtractor()


def _normalize_citation(citation: str) -> str:
    """
    Normalize citation for matching.
    MUST match the normalization in seed_citation_graph.py exactly!
    """
    normalized = citation.upper()
    # Collapse dotted abbreviations: S.C.R. → SCR, I.N.S.C. → INSC
    normalized = re.sub(
        r"(?<![A-Z])([A-Z])(?:\.([A-Z]))+\.?",
        lambda m: m.group(0).replace(".", ""),
        normalized,
    )
    normalized = re.sub(r"[-_]+", " ", normalized)
    normalized = re.sub(r"\(\s+", "(", normalized)
    normalized = re.sub(r"\s+\)", ")", normalized)
    normalized = re.sub(r"\[\s+", "[", normalized)
    normalized = re.sub(r"\s+\]", "]", normalized)
    normalized = " ".join(normalized.split())
    return normalized


def _extract_worker(args: tuple[str, str, str]) -> tuple[str, str, list[tuple[str, str]]]:
    """
    Pure CPU work: extract citations from text.

    Args:
        args: (case_id, citing_citation, combined_text)

    Returns:
        (case_id, citing_citation, [(raw_text, normalized_citation), ...])
    """
    case_id, citing_citation, text = args

    try:
        extracted = _worker_extractor.extract(text)
    except Exception:
        return (case_id, citing_citation, [])

    citing_norm = _normalize_citation(citing_citation) if citing_citation else ""
    seen = set()
    results = []

    for citation in extracted:
        raw = citation.full_citation
        norm = _normalize_citation(raw)
        if norm == citing_norm or norm in seen or not norm:
            continue
        seen.add(norm)
        results.append((raw, norm))

    return (case_id, citing_citation, results)


# =============================================================================
# UTILITIES
# =============================================================================


def _get_memory_mb() -> float:
    """Get current process RSS in MB."""
    try:
        import psutil

        return psutil.Process().memory_info().rss / (1024 * 1024)
    except ImportError:
        # Fallback for systems without psutil
        try:
            import resource

            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024  # macOS: bytes→KB→MB
        except Exception:
            return 0.0


def _adaptive_batch_size(base: int) -> int:
    """Reduce batch size under memory pressure (tuned for 36GB M4 Max)."""
    mem = _get_memory_mb()
    if mem > 28_000:  # >28GB — critical
        return max(100, base // 4)
    if mem > 20_000:  # >20GB — moderate pressure
        return max(250, base // 2)
    return base


def _chunked(iterable, size):
    """Yield successive chunks from an iterable."""
    items = list(iterable)
    for i in range(0, len(items), size):
        yield items[i : i + size]


# Active error log path (set per-collection at startup)
_active_error_log: Path = ERROR_LOG_FILE


def _log_error(category: str, case_id: str, error: str, details: dict | None = None):
    """Append structured error to JSONL log."""
    entry = {
        "ts": datetime.now(UTC).isoformat(),
        "cat": category,
        "case_id": case_id,
        "err": str(error)[:500],
    }
    if details:
        entry["details"] = details
    try:
        with open(_active_error_log, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


async def _retry_qdrant(coro_factory, label: str = "qdrant"):
    """Retry an async Qdrant operation with exponential backoff + jitter."""
    for attempt in range(RETRY_MAX):
        try:
            return await coro_factory()
        except Exception as e:
            if attempt == RETRY_MAX - 1:
                raise
            wait = min(60, (2**attempt) + random.uniform(0, 1))
            print(f"  [{label}] Retry {attempt + 1}/{RETRY_MAX} after {wait:.1f}s: {e}", flush=True)
            await asyncio.sleep(wait)


def _retry_db(func, label: str = "db"):
    """Retry a synchronous DB operation with exponential backoff.
    Duplicate key / unique constraint errors are NOT retried (they'll never succeed)."""
    for attempt in range(RETRY_MAX):
        try:
            return func()
        except Exception as e:
            err = str(e).lower()
            # Duplicate key errors will never succeed on retry — fail fast
            if "duplicate key" in err or "unique constraint" in err or "23505" in err:
                raise
            if attempt == RETRY_MAX - 1:
                raise
            wait = min(30, (2**attempt) + random.uniform(0, 0.5))
            print(f"  [{label}] Retry {attempt + 1}/{RETRY_MAX} after {wait:.1f}s: {e}", flush=True)
            time.sleep(wait)


# =============================================================================
# CHECKPOINT MANAGER
# =============================================================================


class CheckpointManager:
    """Persistent checkpoint for resumable multi-hour extractions."""

    def __init__(self, path: Path):
        self.path = path
        self.state = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            try:
                with open(self.path) as f:
                    data = json.load(f)
                if data.get("version") == 2:
                    return data
                print("  Old checkpoint version, starting fresh.")
            except Exception as e:
                print(f"  Checkpoint load error: {e}")
        return self._default()

    @staticmethod
    def _default() -> dict:
        return {
            "version": 2,
            "started_at": datetime.now(UTC).isoformat(),
            "phase": "init",
            "current_collection": None,
            "collections_completed": [],
            "extraction_batch_index": 0,
            "cases_processed": 0,
            "legal_cases_created": 0,
            "relationships_created": 0,
            "errors": 0,
            "last_updated": None,
        }

    def save(self):
        self.state["last_updated"] = datetime.now(UTC).isoformat()
        try:
            tmp = self.path.with_suffix(".tmp")
            with open(tmp, "w") as f:
                json.dump(self.state, f, indent=2)
            tmp.rename(self.path)  # Atomic rename
        except Exception as e:
            print(f"  Checkpoint save error: {e}", flush=True)

    def update(self, **kwargs):
        self.state.update(kwargs)
        self.save()

    def is_collection_done(self, collection: str) -> bool:
        return collection in self.state.get("collections_completed", [])

    def get_batch_start(self, collection: str) -> int:
        if self.state.get("current_collection") == collection:
            return self.state.get("extraction_batch_index", 0)
        return 0

    def mark_collection_done(self, collection: str):
        completed = self.state.get("collections_completed", [])
        if collection not in completed:
            completed.append(collection)
        self.update(
            collections_completed=completed,
            current_collection=None,
            extraction_batch_index=0,
        )

    def reset(self):
        self.state = self._default()
        self.save()
        print("Checkpoint reset.")


# =============================================================================
# PHASE 1: LOAD EXISTING LEGAL CASES
# =============================================================================


def load_existing_cases(supabase, max_seconds: int = 120) -> dict[str, str]:
    """
    Load legal_cases.normalized_citation → id into memory.

    Uses cursor-based pagination on `id` (indexed PK) to avoid
    statement timeouts on large tables.

    Time-capped: loads as many as possible within max_seconds (default 2 min).
    DB upsert with ignore_duplicates handles dedup for anything missed.

    Returns:
        dict mapping normalized_citation to legal_case.id
    """
    import time

    citation_to_id: dict[str, str] = {}
    last_id = "00000000-0000-0000-0000-000000000000"
    # PostgREST caps at 1000 rows regardless of .limit() value
    batch_size = 1000
    total = 0
    start = time.time()

    while True:
        # Time cap check
        elapsed = time.time() - start
        if elapsed > max_seconds:
            print(
                f"    Time cap reached ({max_seconds}s). "
                f"Loaded {total:,} of ~5M+ legal_cases. "
                f"DB upsert handles the rest.",
                flush=True,
            )
            break

        result = _retry_db(
            lambda last_id=last_id: (
                supabase.service_client.table("legal_cases")
                .select("id, normalized_citation")
                .gt("id", last_id)
                .order("id")
                .limit(batch_size)
                .execute()
            ),
            "load_cases",
        )

        if not result.data:
            break

        for row in result.data:
            norm = row.get("normalized_citation")
            if norm:
                citation_to_id[norm] = row["id"]

        last_id = result.data[-1]["id"]
        total += len(result.data)
        if total % 50_000 == 0:
            print(f"    Loaded {total:,} legal_cases...", flush=True)
        if len(result.data) < batch_size:
            break

    return citation_to_id


def load_existing_relationships(supabase) -> set[tuple[str, str]]:
    """
    Load ALL corpus-level citation_relationships into memory for O(1) dedup.

    Only loads relationships where source_document_id IS NULL (corpus-level),
    matching the same filter used by the old per-batch pre-filter query.

    Returns:
        set of (citing_case_id, cited_case_id) tuples (~2M pairs ≈ 150MB)
    """
    existing_pairs: set[tuple[str, str]] = set()
    last_id = "00000000-0000-0000-0000-000000000000"
    # PostgREST caps at 1000 rows regardless of .limit() value
    batch_size = 1000
    total = 0

    while True:
        result = _retry_db(
            lambda last_id=last_id: (
                supabase.service_client.table("citation_relationships")
                .select("id, citing_case_id, cited_case_id")
                .is_("source_document_id", "null")
                .gt("id", last_id)
                .order("id")
                .limit(batch_size)
                .execute()
            ),
            "load_rels",
        )

        if not result.data:
            break

        for row in result.data:
            existing_pairs.add((row["citing_case_id"], row["cited_case_id"]))

        last_id = result.data[-1]["id"]
        total += len(result.data)
        if total % 100_000 == 0:
            print(f"    Loaded {total:,} relationships...", flush=True)
        if len(result.data) < batch_size:
            break

    return existing_pairs


# =============================================================================
# PHASE 2: DISCOVER UNIQUE CASES FROM QDRANT
# =============================================================================


async def discover_cases(
    client,
    collection: str,
    limit: int | None = None,
) -> dict[str, dict]:
    """
    Scroll entire Qdrant collection (metadata-only) to discover unique case_ids.

    Uses cursor-based pagination to handle collections of any size.
    Only fetches case_id + metadata fields (no text, no vectors).

    Returns:
        dict: case_id → {citation, title, court, court_type, year}
    """
    cases: dict[str, dict] = {}
    offset = None  # cursor-based: None = start from beginning
    total_points = 0
    start = time.time()

    print(f"  Scrolling {collection} (metadata-only)...", flush=True)

    while True:
        if _shutdown_requested:
            break

        points, next_offset = await _retry_qdrant(
            lambda offset=offset: client.scroll(
                collection_name=collection,
                limit=DISCOVERY_SCROLL_BATCH,
                offset=offset,
                with_payload=["case_id", "citation", "title", "court", "court_type", "year"],
                with_vectors=False,
            ),
            label=f"discover:{collection}",
        )

        for point in points:
            payload = point.payload or {}
            case_id = payload.get("case_id")
            if case_id and case_id not in cases:
                cases[case_id] = {
                    "citation": payload.get("citation", ""),
                    "title": payload.get("title", ""),
                    "court": payload.get("court", ""),
                    "court_type": payload.get("court_type", ""),
                    "year": payload.get("year"),
                }

                if limit and len(cases) >= limit:
                    break

        total_points += len(points)

        # Progress
        elapsed = time.time() - start
        rate = total_points / elapsed if elapsed > 0 else 0
        if total_points % (DISCOVERY_SCROLL_BATCH * 10) == 0 and total_points > 0:
            mem = _get_memory_mb()
            print(
                f"    Scrolled {total_points:,} points | "
                f"Unique cases: {len(cases):,} | "
                f"Rate: {rate:,.0f} pts/s | "
                f"Mem: {mem:.0f}MB",
                flush=True,
            )

        # Exit conditions
        if limit and len(cases) >= limit:
            print(f"    Limit reached ({limit:,} cases).", flush=True)
            break
        if next_offset is None:
            break
        offset = next_offset

    elapsed = time.time() - start
    print(
        f"    Done: {len(cases):,} unique cases from {total_points:,} points in {elapsed:.0f}s",
        flush=True,
    )
    return cases


def save_discovery_cache(collection: str, case_registry: dict[str, dict]) -> None:
    """Save Phase 2 discovery results to disk for fast resume."""
    DISCOVERY_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = DISCOVERY_CACHE_DIR / f"{collection}.json"
    with open(cache_file, "w") as f:
        json.dump(case_registry, f)
    print(f"  Discovery cache saved: {cache_file} ({len(case_registry):,} cases)", flush=True)


def load_discovery_cache(collection: str) -> dict[str, dict] | None:
    """Load Phase 2 discovery results from disk cache. Returns None if no cache."""
    cache_file = DISCOVERY_CACHE_DIR / f"{collection}.json"
    if not cache_file.exists():
        return None
    try:
        with open(cache_file) as f:
            data = json.load(f)
        print(f"  Discovery cache loaded: {len(data):,} cases from {cache_file}", flush=True)
        return data
    except (json.JSONDecodeError, OSError) as e:
        print(f"  Discovery cache corrupted ({e}), will re-scroll.", flush=True)
        return None


# =============================================================================
# PHASE 3: FETCH TEXT CHUNKS (cursor-based, semaphore-limited)
# =============================================================================


async def _fetch_sub_batch(
    client,
    collection: str,
    case_ids: list[str],
    semaphore: asyncio.Semaphore,
) -> dict[str, list[str]]:
    """
    Fetch text chunks for a single sub-batch of case_ids.
    Semaphore controls Qdrant concurrency across all concurrent sub-batches.
    """
    from qdrant_client.models import FieldCondition, Filter, MatchAny

    texts: dict[str, list[str]] = defaultdict(list)

    async with semaphore:
        offset = None
        while True:
            try:
                points, next_offset = await _retry_qdrant(
                    lambda offset=offset: client.scroll(
                        collection_name=collection,
                        scroll_filter=Filter(
                            must=[FieldCondition(key="case_id", match=MatchAny(any=case_ids))]
                        ),
                        limit=QDRANT_SCROLL_LIMIT,
                        offset=offset,
                        with_payload=["case_id", "text"],
                        with_vectors=False,
                    ),
                    label="fetch_text",
                )
            except Exception as e:
                _log_error("qdrant_fetch", ",".join(case_ids[:3]), str(e))
                break

            for point in points:
                p = point.payload or {}
                cid = p.get("case_id")
                text = p.get("text", "")
                if cid and text:
                    texts[cid].append(text)

            if next_offset is None:
                break
            offset = next_offset

    return texts


async def fetch_case_texts(
    client,
    collection: str,
    case_ids: list[str],
    semaphore: asyncio.Semaphore,
) -> dict[str, str]:
    """
    Fetch ALL text chunks for given case_ids using CONCURRENT sub-batch fetches.
    All sub-batches fire in parallel, controlled by semaphore.

    Returns:
        dict: case_id → combined_text
    """
    # Split into sub-batches and fetch ALL concurrently
    sub_batches = list(_chunked(case_ids, QDRANT_FETCH_BATCH))
    fetch_tasks = [
        _fetch_sub_batch(client, collection, sub, semaphore) for sub in sub_batches
    ]
    results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

    # Merge all sub-batch results
    all_texts: dict[str, list[str]] = defaultdict(list)
    for result in results:
        if isinstance(result, Exception):
            _log_error("qdrant_fetch", "batch", str(result))
            continue
        for cid, chunks in result.items():
            all_texts[cid].extend(chunks)

    # Combine chunks per case (respect limits)
    combined: dict[str, str] = {}
    for cid, chunks in all_texts.items():
        text = ""
        for chunk in chunks[:MAX_CHUNKS_PER_CASE]:
            text += chunk + "\n\n"
            if len(text) > MAX_TEXT_LENGTH:
                break
        if text.strip():
            combined[cid] = text

    return combined


# =============================================================================
# PHASE 3: DB WRITE FUNCTIONS
# =============================================================================


def create_corpus_cases(
    supabase,
    case_batch: dict[str, dict],
    citation_to_id: dict[str, str],
) -> dict[str, str]:
    """
    Create CORPUS legal_cases for the HC cases themselves.

    Returns:
        dict: qdrant_case_id → legal_case.id
    """
    case_id_map: dict[str, str] = {}
    records_to_insert = []

    for qdrant_id, metadata in case_batch.items():
        citation = metadata.get("citation", "")
        norm = _normalize_citation(citation) if citation else ""
        fallback_key = f"HC-{qdrant_id.upper()}"
        effective_key = norm or fallback_key

        # Check if already exists (by normalized citation OR fallback key)
        if norm and norm in citation_to_id:
            case_id_map[qdrant_id] = citation_to_id[norm]
            continue
        if fallback_key in citation_to_id:
            case_id_map[qdrant_id] = citation_to_id[fallback_key]
            continue

        # Create new CORPUS entry
        legal_id = str(uuid4())
        record = {
            "id": legal_id,
            "primary_citation": citation or f"HC-{qdrant_id}",
            "normalized_citation": effective_key,
            "court": metadata.get("court", ""),
            "year": metadata.get("year"),
            "source_type": "CORPUS",
            "corpus_case_id": qdrant_id,
            "has_full_text": True,
            "validity_status": "UNKNOWN",
        }
        records_to_insert.append(record)

        citation_to_id[effective_key] = legal_id
        case_id_map[qdrant_id] = legal_id

    # Batch upsert
    if records_to_insert:
        for chunk in _chunked(records_to_insert, DB_WRITE_BATCH):
            try:
                _retry_db(
                    lambda chunk=chunk: (
                        supabase.service_client.table("legal_cases")
                        .upsert(chunk, on_conflict="normalized_citation", ignore_duplicates=True)
                        .execute()
                    ),
                    "create_corpus",
                )
            except Exception as e:
                _log_error("db_corpus_create", "batch", str(e))

        # Sync actual IDs from DB — ignore_duplicates may have skipped rows
        # so our generated UUIDs might not exist in DB
        norm_to_qdrant: dict[str, str] = {}
        for qdrant_id, metadata in case_batch.items():
            citation = metadata.get("citation", "")
            norm = _normalize_citation(citation) if citation else ""
            effective = norm or f"HC-{qdrant_id.upper()}"
            norm_to_qdrant[effective] = qdrant_id

        inserted_norms = [r["normalized_citation"] for r in records_to_insert]
        for chunk in _chunked(inserted_norms, DB_LOOKUP_BATCH):
            try:
                result = _retry_db(
                    lambda chunk=chunk: (
                        supabase.service_client.table("legal_cases")
                        .select("id, normalized_citation")
                        .in_("normalized_citation", chunk)
                        .execute()
                    ),
                    "sync_corpus_ids",
                )
                for row in result.data:
                    actual_id = row["id"]
                    norm = row["normalized_citation"]
                    citation_to_id[norm] = actual_id
                    qid = norm_to_qdrant.get(norm)
                    if qid:
                        case_id_map[qid] = actual_id
            except Exception as e:
                _log_error("db_sync_corpus_ids", "batch", str(e))

    return case_id_map


def write_extracted_cases_and_relationships(
    supabase,
    new_citations: dict[str, str],
    relationships: set[tuple[str, str]],
    citation_to_id: dict[str, str],
    existing_pairs: set[tuple[str, str]] | None = None,
) -> tuple[int, int, int]:
    """
    Write EXTRACTED legal_cases and citation_relationships.

    Args:
        new_citations: normalized → raw_text (citations not yet in DB)
        relationships: set of (citing_case_id, cited_norm) tuples
        citation_to_id: global lookup (updated in place)

    Returns:
        (cases_created, relationships_created, relationships_skipped)
    """
    cases_created = 0
    rels_created = 0

    # Step 1: Create EXTRACTED legal_cases
    case_records = []
    for norm, raw_text in new_citations.items():
        if norm not in citation_to_id:
            case_id = str(uuid4())
            case_records.append(
                {
                    "id": case_id,
                    "primary_citation": raw_text,
                    "normalized_citation": norm,
                    "source_type": "EXTRACTED",
                    "validity_status": "UNKNOWN",
                }
            )
            citation_to_id[norm] = case_id

    if case_records:
        for chunk in _chunked(case_records, DB_WRITE_BATCH):
            try:
                _retry_db(
                    lambda chunk=chunk: (
                        supabase.service_client.table("legal_cases")
                        .upsert(chunk, on_conflict="normalized_citation", ignore_duplicates=True)
                        .execute()
                    ),
                    "create_extracted",
                )
                cases_created += len(chunk)
            except Exception as e:
                _log_error("db_extracted_create", "batch", str(e))

    # Step 2: Sync IDs from DB (some may already exist with different UUIDs)
    all_cited_norms = list({norm for _, norm in relationships})
    fresh_ids: dict[str, str] = {}

    for chunk in _chunked(all_cited_norms, DB_LOOKUP_BATCH):
        try:
            result = _retry_db(
                lambda chunk=chunk: (
                    supabase.service_client.table("legal_cases")
                    .select("id, normalized_citation")
                    .in_("normalized_citation", chunk)
                    .execute()
                ),
                "sync_ids",
            )
            for row in result.data:
                fresh_ids[row["normalized_citation"]] = row["id"]
                citation_to_id[row["normalized_citation"]] = row["id"]
        except Exception as e:
            _log_error("db_sync_ids", "batch", str(e))

    # Step 3: Build and insert relationships via direct PostgREST inserts
    # (RPC batch_insert_citation_relationships had JSONB scalar serialization bug)
    rel_records = []
    seen_pairs: set[tuple[str, str]] = set(existing_pairs) if existing_pairs else set()
    skip_no_cited = 0
    skip_self = 0
    skip_seen = 0
    rels_dup = 0
    for citing_id, cited_norm in relationships:
        cited_id = fresh_ids.get(cited_norm)
        if not cited_id:
            skip_no_cited += 1
            continue
        if cited_id == citing_id:
            skip_self += 1
            continue
        pair = (citing_id, cited_id)
        if pair in seen_pairs:
            skip_seen += 1
            continue
        seen_pairs.add(pair)
        rel_records.append(
            {
                "citing_case_id": citing_id,
                "cited_case_id": cited_id,
                "treatment": "REFERRED",
                "extraction_method": "CORPUS_PAYLOAD",
                "confidence_score": 0.85,
            }
        )

    if rel_records:
        for chunk in _chunked(rel_records, 500):
            try:
                _retry_db(
                    lambda chunk=chunk: (
                        supabase.service_client.table("citation_relationships")
                        .insert(chunk)
                        .execute()
                    ),
                    "create_rels",
                )
                rels_created += len(chunk)
            except Exception as e:
                err = str(e).lower()
                if "duplicate key" in err or "unique constraint" in err or "23505" in err:
                    # Batch has conflicts — fall back to individual inserts
                    for rec in chunk:
                        try:
                            _retry_db(
                                lambda rec=rec: (
                                    supabase.service_client.table("citation_relationships")
                                    .insert(rec)
                                    .execute()
                                ),
                                "create_rel_single",
                            )
                            rels_created += 1
                        except Exception:
                            rels_dup += 1
                else:
                    _log_error("db_insert_rels", "batch", str(e))

    skipped = skip_no_cited + skip_self + skip_seen + rels_dup
    return cases_created, rels_created, skipped


# =============================================================================
# PHASE 3: MAIN EXTRACTION LOOP
# =============================================================================


async def process_collection(
    collection: str,
    case_registry: dict[str, dict],
    citation_to_id: dict[str, str],
    existing_pairs: set[tuple[str, str]],
    supabase,
    qdrant_client,
    checkpoint: CheckpointManager,
    executor: ProcessPoolExecutor,
):
    """
    Process all cases in a collection through the extraction pipeline.

    PIPELINED architecture for maximum throughput:
    - While batch N is extracting + writing, batch N+1 text is being pre-fetched
    - All Qdrant sub-batch fetches run concurrently (not sequentially)
    - ProcessPoolExecutor uses 10 workers for CPU-bound regex

    For each batch of CASE_BATCH_SIZE cases:
    1. Create CORPUS legal_cases
    2. Fetch text from Qdrant (concurrent sub-batches, pipelined)
    3. Extract citations via ProcessPoolExecutor
    4. Deduplicate and batch-write results
    """
    semaphore = asyncio.Semaphore(QDRANT_CONCURRENCY)
    loop = asyncio.get_event_loop()

    # Build ordered list of case_ids for deterministic batching
    all_case_ids = sorted(case_registry.keys())
    total_cases = len(all_case_ids)

    # Resume from checkpoint
    start_batch_idx = checkpoint.get_batch_start(collection)
    start_case_offset = start_batch_idx * CASE_BATCH_SIZE

    batch_size = _adaptive_batch_size(CASE_BATCH_SIZE)
    total_batches = (total_cases + batch_size - 1) // batch_size

    print(f"\n  Processing {total_cases:,} cases in ~{total_batches:,} batches of {batch_size}")
    print(
        f"  Concurrency: {QDRANT_CONCURRENCY} Qdrant / {PROCESS_WORKERS} CPU workers / "
        f"pipeline prefetch={PREFETCH_BATCHES}"
    )
    if start_batch_idx > 0:
        print(f"  Resuming from batch {start_batch_idx} (offset {start_case_offset:,})")
    print()

    # Cumulative stats
    total_processed = checkpoint.state.get("cases_processed", 0)
    total_cases_created = checkpoint.state.get("legal_cases_created", 0)
    total_rels_created = checkpoint.state.get("relationships_created", 0)
    total_errors = checkpoint.state.get("errors", 0)
    collection_start = time.time()

    batch_idx = start_batch_idx
    case_offset = start_case_offset

    # --- Pipeline: kick off first prefetch ---
    prefetch_task: asyncio.Task | None = None
    prefetch_case_ids: list[str] | None = None

    def _get_batch_ids(offset: int) -> list[str]:
        bs = _adaptive_batch_size(CASE_BATCH_SIZE)
        return all_case_ids[offset : offset + bs]

    def _start_prefetch(offset: int) -> tuple[asyncio.Task, list[str]] | tuple[None, None]:
        if offset >= total_cases or _shutdown_requested:
            return None, None
        ids = _get_batch_ids(offset)
        if not ids:
            return None, None
        task = asyncio.create_task(
            fetch_case_texts(qdrant_client, collection, ids, semaphore)
        )
        return task, ids

    # Pre-fetch first batch
    prefetch_task, prefetch_case_ids = _start_prefetch(case_offset)

    while case_offset < total_cases and not _shutdown_requested:
        batch_start = time.time()
        batch_size = _adaptive_batch_size(CASE_BATCH_SIZE)

        # Get batch of case_ids
        batch_case_ids = all_case_ids[case_offset : case_offset + batch_size]
        batch_cases = {cid: case_registry[cid] for cid in batch_case_ids}

        # ------- Step 1: Create CORPUS cases -------
        t_s1 = time.time()
        case_id_map = create_corpus_cases(supabase, batch_cases, citation_to_id)
        t_s1_done = time.time()

        # ------- Step 2: Get text (from prefetch or fetch now) -------
        t_s2 = time.time()
        if prefetch_task and prefetch_case_ids == batch_case_ids:
            # Use pre-fetched result
            try:
                combined_texts = await prefetch_task
            except Exception as e:
                _log_error("qdrant_prefetch", batch_case_ids[0] if batch_case_ids else "", str(e))
                combined_texts = {}
                total_errors += 1
        else:
            # Fetch now (first iteration or mismatch)
            try:
                combined_texts = await fetch_case_texts(
                    qdrant_client, collection, batch_case_ids, semaphore
                )
            except Exception as e:
                _log_error("qdrant_text", batch_case_ids[0] if batch_case_ids else "", str(e))
                combined_texts = {}
                total_errors += 1
        t_s2_done = time.time()

        # ------- Pipeline: start pre-fetching NEXT batch -------
        next_offset = case_offset + batch_size
        prefetch_task, prefetch_case_ids = _start_prefetch(next_offset)

        # ------- Step 3: Extract citations via ProcessPoolExecutor -------
        t_s3 = time.time()
        extraction_args = []
        for cid in batch_case_ids:
            text = combined_texts.get(cid)
            citation = batch_cases[cid].get("citation", "")
            if text:
                extraction_args.append((cid, citation, text))

        # Submit all to process pool and gather
        extraction_results = []
        if extraction_args:
            tasks = [
                loop.run_in_executor(executor, _extract_worker, args) for args in extraction_args
            ]
            done = await asyncio.gather(*tasks, return_exceptions=True)
            for result in done:
                if isinstance(result, Exception):
                    total_errors += 1
                    _log_error("extraction", "unknown", str(result))
                else:
                    extraction_results.append(result)
        t_s3_done = time.time()

        # ------- Step 4: Deduplicate results -------
        batch_new_citations: dict[str, str] = {}  # norm → raw_text
        batch_relationships: set[tuple[str, str]] = set()  # (citing_legal_id, cited_norm)

        for case_id, citing_citation, extracted_pairs in extraction_results:
            citing_legal_id = case_id_map.get(case_id)
            if not citing_legal_id:
                continue

            for raw_text, cited_norm in extracted_pairs:
                if cited_norm not in citation_to_id and cited_norm not in batch_new_citations:
                    batch_new_citations[cited_norm] = raw_text
                batch_relationships.add((citing_legal_id, cited_norm))

        # ------- Step 5: Write to DB -------
        t_s5 = time.time()
        cases_created, rels_created, rels_skipped = write_extracted_cases_and_relationships(
            supabase,
            batch_new_citations,
            batch_relationships,
            citation_to_id,
            existing_pairs,
        )
        t_s5_done = time.time()

        # ------- Stats -------
        batch_processed = len(batch_case_ids)
        total_processed += batch_processed
        total_cases_created += cases_created
        total_rels_created += rels_created

        batch_time = time.time() - batch_start
        elapsed = time.time() - collection_start
        effective_processed = total_processed - (start_batch_idx * CASE_BATCH_SIZE)
        rate = effective_processed / elapsed if elapsed > 0 else 0
        remaining = total_cases - (case_offset + batch_processed)
        eta_hours = remaining / rate / 3600 if rate > 0 else 0

        mem = _get_memory_mb()
        skip_info = f" Skip: {rels_skipped}" if rels_skipped else ""
        print(
            f"  Batch {batch_idx:,}/{total_batches:,} | "
            f"{case_offset + batch_processed:,}/{total_cases:,} "
            f"({100 * (case_offset + batch_processed) / total_cases:.1f}%) | "
            f"{batch_time:.1f}s "
            f"[s1:{t_s1_done - t_s1:.1f} s2:{t_s2_done - t_s2:.1f} "
            f"s3:{t_s3_done - t_s3:.1f} s5:{t_s5_done - t_s5:.1f}] | "
            f"Cits: +{cases_created} Rels: +{rels_created}{skip_info} | "
            f"Rate: {rate:.0f}/s | "
            f"ETA: {eta_hours:.1f}h | "
            f"Mem: {mem:.0f}MB",
            flush=True,
        )

        # ------- Checkpoint -------
        batch_idx += 1
        case_offset += batch_size

        if batch_idx % CHECKPOINT_EVERY_N_BATCHES == 0 or _shutdown_requested:
            checkpoint.update(
                phase="extract",
                current_collection=collection,
                extraction_batch_index=batch_idx,
                cases_processed=total_processed,
                legal_cases_created=total_cases_created,
                relationships_created=total_rels_created,
                errors=total_errors,
            )

    # Cancel any outstanding prefetch
    if prefetch_task and not prefetch_task.done():
        prefetch_task.cancel()

    # Final checkpoint for this collection
    if not _shutdown_requested:
        checkpoint.update(
            cases_processed=total_processed,
            legal_cases_created=total_cases_created,
            relationships_created=total_rels_created,
            errors=total_errors,
        )
        checkpoint.mark_collection_done(collection)


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================


async def run_hc_extraction(args):
    """Main extraction pipeline."""
    from app.integrations.corpus_qdrant import get_corpus_client
    from app.integrations.supabase import get_supabase_client

    global _active_error_log

    supabase = get_supabase_client()
    # Set HTTP timeout on service_client to prevent indefinite hangs
    # (the default service_client has no timeout configured)
    import httpx

    supabase.service_client.postgrest.session = httpx.Client(timeout=httpx.Timeout(60.0))
    corpus_client = get_corpus_client()
    qdrant_client = corpus_client.client

    # Collection-specific checkpoint and error log files
    collection_key = args.collection  # "v1", "v2", or None
    ckpt_file = get_checkpoint_file(collection_key)
    err_file = get_error_log_file(collection_key)
    _active_error_log = err_file

    # Auto-migrate: if collection-specific file doesn't exist but legacy does,
    # copy legacy checkpoint if it matches this collection
    if collection_key and not ckpt_file.exists() and CHECKPOINT_FILE.exists():
        try:
            legacy = json.loads(CHECKPOINT_FILE.read_text())
            legacy_coll = legacy.get("current_collection", "")
            if COLLECTIONS.get(collection_key, "") == legacy_coll:
                ckpt_file.write_text(json.dumps(legacy, indent=2))
                print(f"  Migrated legacy checkpoint to {ckpt_file}")
        except Exception:
            pass

    checkpoint = CheckpointManager(ckpt_file)

    if args.reset:
        checkpoint.reset()
        ckpt_file.unlink(missing_ok=True)
        err_file.unlink(missing_ok=True)
        print("Checkpoint and error log cleared.")
        return

    # Determine collections to process
    if args.collection:
        collections_to_run = [COLLECTIONS[args.collection]]
    else:
        collections_to_run = list(COLLECTIONS.values())

    # Header
    print()
    print("=" * 80)
    print("HIGH COURT CITATION EXTRACTION")
    print("=" * 80)
    print(f"  Started:      {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Collections:  {', '.join(collections_to_run)}")
    print(f"  Limit:        {args.limit or 'none (full run)'}")
    print(f"  Dry run:      {args.dry_run}")
    print(f"  Workers:      {PROCESS_WORKERS}")
    print(f"  Checkpoint:   {ckpt_file}")
    print("=" * 80)
    print()

    # ===================== PHASE 1: Load existing cases + relationships =====================
    if args.skip_phase1:
        print("PHASE 1: SKIPPED (--skip-phase1 flag)")
        citation_to_id: dict[str, str] = {}
        existing_pairs: set[tuple[str, str]] = set()
        print()
    else:
        print("PHASE 1: Loading existing legal_cases into memory...")
        t1 = time.time()
        citation_to_id = load_existing_cases(supabase)
        print(f"  Loaded {len(citation_to_id):,} citations in {time.time() - t1:.1f}s")

        print("  Loading existing relationships for dedup...")
        t1r = time.time()
        existing_pairs = load_existing_relationships(supabase)
        print(f"  Loaded {len(existing_pairs):,} relationships in {time.time() - t1r:.1f}s")
        print(f"  Memory: {_get_memory_mb():.0f}MB")
        print()

    # Initialize ProcessPoolExecutor
    executor = ProcessPoolExecutor(
        max_workers=PROCESS_WORKERS,
        initializer=_init_worker,
    )

    try:
        for collection in collections_to_run:
            if _shutdown_requested:
                break

            if checkpoint.is_collection_done(collection):
                print(f"Skipping {collection} (already completed in checkpoint)")
                continue

            print(f"{'=' * 80}")
            print(f"COLLECTION: {collection}")
            print(f"{'=' * 80}")

            # ============ PHASE 2: Discover cases ============
            # Try loading from disk cache first (avoids re-scrolling 9M+ points)
            case_registry = None
            if not args.limit:  # Only use cache for full runs (not --limit)
                case_registry = load_discovery_cache(collection)

            if case_registry is None:
                print(f"\nPHASE 2: Discovering unique cases from {collection}...")
                t2 = time.time()
                case_registry = await discover_cases(
                    qdrant_client,
                    collection,
                    limit=args.limit,
                )
                print(
                    f"  Discovered {len(case_registry):,} unique cases "
                    f"in {time.time() - t2:.0f}s"
                )
                print(f"  Memory: {_get_memory_mb():.0f}MB")
                # Save to cache for future resumes
                if not args.limit:
                    save_discovery_cache(collection, case_registry)
            print()

            if not case_registry:
                print(f"  No cases found in {collection}. Skipping.")
                checkpoint.mark_collection_done(collection)
                continue

            if args.dry_run:
                print(
                    f"  DRY RUN: Would process {len(case_registry):,} cases. Skipping extraction."
                )
                # Show sample
                for i, (cid, meta) in enumerate(list(case_registry.items())[:5]):
                    print(
                        f"    [{i + 1}] {cid}: {meta.get('citation', 'N/A')} ({meta.get('court', 'N/A')})"
                    )
                continue

            # ============ PHASE 3: Extract + Write ============
            print("PHASE 3: Extracting citations and building graph...")
            checkpoint.update(phase="extract", current_collection=collection)

            await process_collection(
                collection=collection,
                case_registry=case_registry,
                citation_to_id=citation_to_id,
                existing_pairs=existing_pairs,
                supabase=supabase,
                qdrant_client=qdrant_client,
                checkpoint=checkpoint,
                executor=executor,
            )

            if _shutdown_requested:
                print(f"\nShutdown during {collection}. Checkpoint saved. Resume to continue.")
                break

    finally:
        executor.shutdown(wait=False)

    # ===================== FINAL SUMMARY =====================
    print()
    print("=" * 80)
    if _shutdown_requested:
        print("EXTRACTION PAUSED (checkpoint saved)")
    else:
        print("EXTRACTION COMPLETE")
    print("=" * 80)
    s = checkpoint.state
    print(f"  Cases processed:       {s.get('cases_processed', 0):,}")
    print(f"  Legal cases created:   {s.get('legal_cases_created', 0):,}")
    print(f"  Relationships created: {s.get('relationships_created', 0):,}")
    print(f"  Errors:                {s.get('errors', 0):,}")
    print(f"  Memory peak:           {_get_memory_mb():.0f}MB")
    print("=" * 80)

    # Clean up on success
    if not _shutdown_requested:
        ckpt_file.unlink(missing_ok=True)
        print("Checkpoint file removed (run complete).")
    else:
        cmd = "python scripts/high_court_citation_extraction.py"
        if collection_key:
            cmd += f" --collection {collection_key}"
        print(f"Resume with: {cmd}")

    print()


# =============================================================================
# CLI
# =============================================================================


def main():
    parser = argparse.ArgumentParser(
        description="Extract citations from High Court cases in Qdrant corpus.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python scripts/high_court_citation_extraction.py                    # Full run (both collections)
  python scripts/high_court_citation_extraction.py --limit 100        # Test with 100 cases
  python scripts/high_court_citation_extraction.py --dry-run          # Discovery only (no writes)
  python scripts/high_court_citation_extraction.py --collection v1    # Only legal_corpus_v1
  python scripts/high_court_citation_extraction.py --reset            # Clear checkpoint + errors
        """,
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Max cases to discover per collection (for testing)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run Phase 1-2 (discovery) only, no extraction or DB writes",
    )
    parser.add_argument(
        "--collection",
        choices=["v1", "v2"],
        help="Process a single collection instead of both",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Reset checkpoint and error log, then exit",
    )
    parser.add_argument(
        "--skip-phase1",
        action="store_true",
        help="Skip Phase 1 loading (fast test mode — empty citation_to_id and existing_pairs)",
    )
    args = parser.parse_args()
    asyncio.run(run_hc_extraction(args))


if __name__ == "__main__":
    main()
