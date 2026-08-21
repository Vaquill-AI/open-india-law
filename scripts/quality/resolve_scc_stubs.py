#!/usr/bin/env python3
"""
Bulk SCC Stub Resolution Script.

Maps EXTRACTED SCC stub cases in legal_cases to their CORPUS SC counterparts
by using Qdrant BM25 text search. Creates citation_aliases for each successful match.

PROBLEM:
    legal_cases has 59K+ EXTRACTED stubs with SCC citations like "(2019) 11 SCC 706"
    but NO corpus_case_id. These were created during citation extraction.
    Meanwhile, 35K CORPUS SC cases have SCR citations + corpus_case_id.
    There's no link between them.

SOLUTION:
    For each SCC stub:
    1. Search Qdrant text using the SCC citation string (BM25 keyword match)
    2. BM25 finds judgment chunks that MENTION this SCC citation
    3. Get the case_id from the top result → look up corpus case in DB
    4. Create citation_alias linking SCC citation → corpus case
    5. Now future lookups find the corpus case instantly via alias

USAGE:
    # Dry run - see what would be mapped
    python scripts/resolve_scc_stubs.py --dry-run

    # Resolve with limit
    python scripts/resolve_scc_stubs.py --max-stubs 100

    # Full resolution
    python scripts/resolve_scc_stubs.py

    # Verbose
    python scripts/resolve_scc_stubs.py --verbose

ENVIRONMENT:
    Requires .env with:
    - QDRANT_CORPUS_URL, QDRANT_CORPUS_API_KEY
    - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import asyncio
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))

# =============================================================================
# CONFIGURATION
# =============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

load_dotenv()

QDRANT_CORPUS_URL = os.getenv("QDRANT_CORPUS_URL", "${QDRANT_URL}")
QDRANT_CORPUS_API_KEY = os.getenv("QDRANT_CORPUS_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

COLLECTIONS = ["legal_corpus_v1", "legal_corpus_v2"]

# Year extraction from SCC citations: "(YYYY) X SCC NNN"
SCC_YEAR_RE = re.compile(r"\((\d{4})\)")


# =============================================================================
# CLIENTS
# =============================================================================


class SupabaseClient:
    """Supabase client for reading stubs and writing aliases."""

    def __init__(self, url: str, service_key: str):
        self.url = url.rstrip("/")
        self.client = httpx.AsyncClient(
            timeout=60.0,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
            },
        )

    async def get_scc_stubs(
        self,
        offset: int = 0,
        limit: int = 500,
    ) -> list[dict]:
        """Get EXTRACTED SCC stub cases without corpus_case_id."""
        response = await self.client.get(
            f"{self.url}/rest/v1/legal_cases",
            params={
                "select": "id,primary_citation,normalized_citation,year",
                "source_type": "eq.EXTRACTED",
                "primary_citation": "like.*(*)%20*%20SCC%20*",  # URL-encoded LIKE pattern
                "corpus_case_id": "is.null",
                "order": "id",
                "offset": str(offset),
                "limit": str(limit),
            },
        )

        if response.status_code not in (200, 206):
            logger.error(f"Stub query failed: {response.status_code} - {response.text[:200]}")
            return []

        return response.json()

    async def count_scc_stubs(self) -> int:
        """Count total SCC stubs without corpus_case_id."""
        response = await self.client.get(
            f"{self.url}/rest/v1/legal_cases",
            params={
                "select": "id",
                "source_type": "eq.EXTRACTED",
                "primary_citation": "like.*(*)%20*%20SCC%20*",
                "corpus_case_id": "is.null",
                "limit": "0",
            },
            headers={"Prefer": "count=exact"},
        )
        if response.status_code in (200, 206):
            count_header = response.headers.get("content-range", "")
            if "/" in count_header:
                return int(count_header.split("/")[1])
        return 0

    async def find_corpus_case_by_id(self, corpus_case_id: str) -> dict | None:
        """Find a CORPUS case by its corpus_case_id."""
        response = await self.client.get(
            f"{self.url}/rest/v1/legal_cases",
            params={
                "select": "id,primary_citation,corpus_case_id,case_name,year,court",
                "corpus_case_id": f"eq.{corpus_case_id}",
                "source_type": "eq.CORPUS",
                "limit": "1",
            },
        )
        if response.status_code in (200, 206):
            data = response.json()
            if data:
                return data[0]
        return None

    async def check_alias_exists(self, normalized_alias: str) -> bool:
        """Check if a citation alias already exists."""
        response = await self.client.get(
            f"{self.url}/rest/v1/citation_aliases",
            params={
                "select": "id",
                "normalized_alias": f"eq.{normalized_alias}",
                "limit": "1",
            },
        )
        if response.status_code in (200, 206):
            return bool(response.json())
        return False

    async def insert_alias(self, alias_data: dict) -> bool:
        """Insert a citation alias."""
        response = await self.client.post(
            f"{self.url}/rest/v1/citation_aliases",
            json=alias_data,
            headers={"Prefer": "return=minimal"},
        )
        if response.status_code in (200, 201):
            return True
        if response.status_code == 409:
            return True  # Already exists (unique constraint)
        logger.error(f"Insert alias failed: {response.status_code} - {response.text[:200]}")
        return False

    async def close(self):
        await self.client.aclose()


class QdrantBM25Client:
    """Qdrant client for BM25 text search using server-side sparse vectors."""

    def __init__(self, url: str, api_key: str):
        self.url = url.rstrip("/")
        self.client = httpx.AsyncClient(
            timeout=30.0,
            headers={"api-key": api_key, "Content-Type": "application/json"},
        )

    async def search_text(
        self,
        text: str,
        collections: list[str],
        top_k: int = 5,
        court_type: str | None = None,
    ) -> list[dict]:
        """
        Search for text across collections using Qdrant's query API with text input.

        Uses the sparse vector named "sparse" for BM25 search.
        Qdrant server-side BM25 computes the sparse vector from text.
        """
        # We need the BM25 encoder to convert text to sparse vector
        try:
            from app.rag.embedders.voyage import get_bm25_encoder

            encoder = get_bm25_encoder()
            sparse_vector = encoder.encode_query(text)

            if not sparse_vector:
                return []

            # Build filter
            filter_body: dict[str, Any] = {}
            if court_type:
                filter_body = {"must": [{"key": "court_type", "match": {"value": court_type}}]}

            results = []
            for collection in collections:
                try:
                    body: dict[str, Any] = {
                        "query": {
                            "indices": list(sparse_vector.keys()),
                            "values": list(sparse_vector.values()),
                        },
                        "using": "sparse",
                        "limit": top_k,
                        "with_payload": ["case_id", "title", "citation", "court", "year"],
                    }

                    if filter_body:
                        body["filter"] = filter_body

                    response = await self.client.post(
                        f"{self.url}/collections/{collection}/points/query",
                        json=body,
                    )

                    if response.status_code == 200:
                        data = response.json()
                        for point in data.get("result", {}).get("points", []):
                            payload = point.get("payload", {})
                            results.append(
                                {
                                    "case_id": payload.get("case_id"),
                                    "title": payload.get("title"),
                                    "citation": payload.get("citation"),
                                    "court": payload.get("court"),
                                    "year": payload.get("year"),
                                    "score": point.get("score", 0),
                                    "collection": collection,
                                }
                            )

                except Exception as e:
                    logger.debug(f"Search failed for {collection}: {e}")

            # Sort by score descending
            results.sort(key=lambda x: x.get("score", 0), reverse=True)
            return results[:top_k]

        except ImportError:
            logger.error("Could not import BM25 encoder. Run from project root.")
            return []

    async def close(self):
        await self.client.aclose()


# =============================================================================
# RESOLUTION ENGINE
# =============================================================================


def normalize_citation(text: str) -> str:
    """Normalize citation for DB matching."""
    import unicodedata

    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = text.upper()
    # Remove extra spaces around dots and brackets
    text = re.sub(r"\s*\.\s*", ".", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"\s+\)", ")", text)
    return text


def extract_year_from_scc(citation: str) -> int | None:
    """Extract year from SCC citation like '(2019) 11 SCC 706'."""
    match = SCC_YEAR_RE.search(citation)
    if match:
        return int(match.group(1))
    return None


class StubResolver:
    """Resolves SCC stubs to corpus cases via BM25 search."""

    def __init__(
        self,
        qdrant: QdrantBM25Client,
        supabase: SupabaseClient,
        dry_run: bool = False,
        max_stubs: int | None = None,
        verbose: bool = False,
    ):
        self.qdrant = qdrant
        self.supabase = supabase
        self.dry_run = dry_run
        self.max_stubs = max_stubs
        self.verbose = verbose

    async def run(self):
        """Run the bulk resolution pipeline."""
        start = time.time()

        # Count stubs
        total_stubs = await self.supabase.count_scc_stubs()
        logger.info(f"Total SCC stubs to resolve: {total_stubs:,}")

        if total_stubs == 0:
            logger.warning("No SCC stubs found!")
            return

        # Process in batches
        offset = 0
        batch_size = 200
        resolved = 0
        skipped = 0
        not_found = 0
        errors = 0
        already_aliased = 0

        while True:
            if self.max_stubs and resolved >= self.max_stubs:
                logger.info(f"Reached max_stubs limit: {self.max_stubs}")
                break

            stubs = await self.supabase.get_scc_stubs(offset=offset, limit=batch_size)
            if not stubs:
                break

            for stub in stubs:
                if self.max_stubs and resolved >= self.max_stubs:
                    break

                scc_citation = stub["primary_citation"]
                normalized = normalize_citation(scc_citation)

                # Check if alias already exists
                if await self.supabase.check_alias_exists(normalized):
                    already_aliased += 1
                    if self.verbose:
                        logger.debug(f"  Already aliased: {scc_citation}")
                    continue

                # Extract year for validation
                scc_year = extract_year_from_scc(scc_citation)

                # Search Qdrant for this citation text
                try:
                    results = await self.qdrant.search_text(
                        text=scc_citation,
                        collections=COLLECTIONS,
                        top_k=5,
                    )
                except Exception as e:
                    logger.error(f"Search failed for {scc_citation}: {e}")
                    errors += 1
                    continue

                if not results:
                    not_found += 1
                    if self.verbose:
                        logger.debug(f"  No BM25 results: {scc_citation}")
                    continue

                # Try to match: look for a corpus case with matching year (±1)
                matched = False
                for hit in results:
                    corpus_case_id = hit.get("case_id")
                    if not corpus_case_id:
                        continue

                    hit_year = hit.get("year")

                    # Year validation: SCC year should be within ±2 of corpus year
                    if scc_year and hit_year:
                        if abs(scc_year - hit_year) > 2:
                            continue

                    # Look up the corpus case in DB
                    corpus_case = await self.supabase.find_corpus_case_by_id(corpus_case_id)
                    if not corpus_case:
                        continue

                    # Found a match!
                    if self.dry_run:
                        logger.info(
                            f"[DRY RUN] {scc_citation} → {corpus_case['primary_citation']} "
                            f"({corpus_case_id}) score={hit['score']:.3f}"
                        )
                        resolved += 1
                        matched = True
                        break

                    # Create citation alias
                    alias_data = {
                        "id": str(uuid4()),
                        "legal_case_id": corpus_case["id"],
                        "alias_citation": scc_citation,
                        "normalized_alias": normalized,
                        "citation_type": "SCC",
                        "is_primary": False,
                    }

                    success = await self.supabase.insert_alias(alias_data)
                    if success:
                        resolved += 1
                        matched = True
                        if self.verbose:
                            logger.info(
                                f"  Resolved: {scc_citation} → {corpus_case['primary_citation']} "
                                f"({corpus_case_id})"
                            )
                    else:
                        errors += 1
                    break

                if not matched:
                    not_found += 1

                # Rate limiting: don't hammer Qdrant too hard
                if not self.dry_run and resolved % 10 == 0:
                    await asyncio.sleep(0.1)

            offset += batch_size

            # Progress logging
            total_processed = resolved + skipped + not_found + errors + already_aliased
            if total_processed % 500 == 0 and total_processed > 0:
                logger.info(
                    f"Progress: {total_processed:,} processed | "
                    f"{resolved:,} resolved | {not_found:,} not found | "
                    f"{already_aliased:,} already aliased | {errors:,} errors"
                )

        elapsed = time.time() - start
        logger.info("=" * 60)
        logger.info("RESOLUTION COMPLETE")
        logger.info("=" * 60)
        logger.info(f"Resolved:       {resolved:,}")
        logger.info(f"Not found:      {not_found:,}")
        logger.info(f"Already aliased: {already_aliased:,}")
        logger.info(f"Errors:         {errors:,}")
        logger.info(f"Time:           {elapsed:.0f}s ({elapsed / 60:.1f} min)")


# =============================================================================
# MAIN
# =============================================================================


async def main():
    parser = argparse.ArgumentParser(description="Resolve SCC stubs to corpus cases via BM25")
    parser.add_argument("--dry-run", action="store_true", help="Preview without DB writes")
    parser.add_argument("--max-stubs", type=int, help="Max stubs to resolve")
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    if not QDRANT_CORPUS_API_KEY:
        logger.error("QDRANT_CORPUS_API_KEY not set")
        sys.exit(1)
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required")
        sys.exit(1)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    qdrant = QdrantBM25Client(QDRANT_CORPUS_URL, QDRANT_CORPUS_API_KEY)
    supabase = SupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    resolver = StubResolver(
        qdrant=qdrant,
        supabase=supabase,
        dry_run=args.dry_run,
        max_stubs=args.max_stubs,
        verbose=args.verbose,
    )

    try:
        await resolver.run()
    finally:
        await qdrant.close()
        await supabase.close()


if __name__ == "__main__":
    asyncio.run(main())
