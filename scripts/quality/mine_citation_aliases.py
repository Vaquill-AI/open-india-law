#!/usr/bin/env python3
"""
Citation Alias Mining Script.

Mines Supreme Court judgment text in Qdrant corpus to extract SCC/AIR/SCALE/JT
parallel citations and populate the `citation_aliases` table.

PROBLEM:
    Qdrant stores SCR (Supreme Court Reports) and INSC (neutral) citations.
    Lawyers search using SCC (Supreme Court Cases) format — the most common format.
    The `citation_aliases` table is EMPTY — no SCC↔SCR↔INSC mappings exist.

APPROACH:
    1. "Header Mining" — For each SC case in v2 (371K chunks with citation field):
       a. Read chunk_index=0 (header/opening section with metadata)
       b. Extract ALL citations using CitationExtractor (147+ regex patterns)
       c. Filter: keep only citations with SAME YEAR as the case AND SC court type
       d. These are parallel citations (SCC, AIR, SCALE, JT, MANU) for the same case
       e. Insert into citation_aliases with proper citation_type

    2. "Cross-Reference" — For cases that have NO SCC alias after header mining:
       a. Read ALL chunks (full judgment text)
       b. Look for self-referencing patterns: "reported in (YYYY) X SCC NNN"
       c. Extract SCC citation and add as alias

USAGE:
    # Dry run — see what would be extracted (no DB writes)
    python scripts/mine_citation_aliases.py --dry-run --max-cases 100

    # Mine header sections only (fast, ~30 min for 33K cases)
    python scripts/mine_citation_aliases.py --mode header

    # Mine with cross-reference pass for missing SCC aliases
    python scripts/mine_citation_aliases.py --mode full

    # Resume from checkpoint
    python scripts/mine_citation_aliases.py --resume

    # Verbose logging
    python scripts/mine_citation_aliases.py --verbose

ENVIRONMENT:
    Requires .env with:
    - QDRANT_CORPUS_URL
    - QDRANT_CORPUS_API_KEY
    - SUPABASE_URL
    - SUPABASE_SERVICE_ROLE_KEY
"""

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.rag.citations.extractor import CitationExtractor
from app.rag.citations.models import CitationType, CourtLevel

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

COLLECTION = "legal_corpus_v2"
CHECKPOINT_FILE = Path(__file__).parent / ".alias_mining_checkpoint.json"

# Citation type mapping from CitationType enum to DB citation_type
CITATION_TYPE_MAP = {
    CitationType.SCC: "SCC",
    CitationType.SCR: "SCR",
    CitationType.AIR: "AIR",
    CitationType.MANU: "MANU",
    CitationType.SCALE: "SCALE",
    CitationType.JT: "JT",
    CitationType.NEUTRAL: "NEUTRAL",
    CitationType.STATE: "STATE",
    CitationType.TRIBUNAL: "TRIBUNAL",
    CitationType.UNKNOWN: "OTHER",
}

# Self-reference patterns for cross-reference mining
SELF_REFERENCE_PATTERNS = [
    # "reported in (2019) 11 SCC 706"
    re.compile(
        r"reported\s+(?:in|as)\s+\((\d{4})\)\s+(\d+)\s+SCC\s+(\d+)",
        re.IGNORECASE,
    ),
    # "reported in AIR 2019 SC 345"
    re.compile(
        r"reported\s+(?:in|as)\s+AIR\s+(\d{4})\s+SC\s+(\d+)",
        re.IGNORECASE,
    ),
    # "(reported as (2019) 11 SCC 706)"
    re.compile(
        r"\(\s*reported\s+(?:in|as)\s+\((\d{4})\)\s+(\d+)\s+SCC\s+(\d+)\s*\)",
        re.IGNORECASE,
    ),
    # "cited as (2019) 11 SCC 706"
    re.compile(
        r"cited\s+as\s+\((\d{4})\)\s+(\d+)\s+SCC\s+(\d+)",
        re.IGNORECASE,
    ),
]


# =============================================================================
# DATA CLASSES
# =============================================================================


@dataclass
class MiningStats:
    """Track mining progress."""

    cases_processed: int = 0
    cases_with_aliases: int = 0
    aliases_found: int = 0
    aliases_inserted: int = 0
    scc_found: int = 0
    air_found: int = 0
    manu_found: int = 0
    scale_found: int = 0
    other_found: int = 0
    cross_ref_found: int = 0
    errors: int = 0
    start_time: float = 0.0
    last_cursor: str | None = None
    phase: str = "header"

    def summary(self) -> str:
        elapsed = time.time() - self.start_time if self.start_time else 0
        rate = self.cases_processed / elapsed if elapsed > 0 else 0
        return (
            f"Processed: {self.cases_processed:,} cases | "
            f"With aliases: {self.cases_with_aliases:,} | "
            f"Aliases found: {self.aliases_found:,} | "
            f"Inserted: {self.aliases_inserted:,} | "
            f"SCC: {self.scc_found:,} | AIR: {self.air_found:,} | "
            f"MANU: {self.manu_found:,} | SCALE: {self.scale_found:,} | "
            f"CrossRef: {self.cross_ref_found:,} | "
            f"Errors: {self.errors:,} | "
            f"Rate: {rate:.1f} cases/sec | "
            f"Elapsed: {elapsed:.0f}s"
        )

    def to_dict(self) -> dict:
        return {
            "cases_processed": self.cases_processed,
            "cases_with_aliases": self.cases_with_aliases,
            "aliases_found": self.aliases_found,
            "aliases_inserted": self.aliases_inserted,
            "scc_found": self.scc_found,
            "air_found": self.air_found,
            "manu_found": self.manu_found,
            "scale_found": self.scale_found,
            "other_found": self.other_found,
            "cross_ref_found": self.cross_ref_found,
            "errors": self.errors,
            "last_cursor": self.last_cursor,
            "phase": self.phase,
        }


@dataclass
class DiscoveredAlias:
    """A citation alias discovered from corpus text."""

    case_id: str  # INSC format from Qdrant (e.g., "2018_INSC_1060")
    legal_case_id: str | None  # UUID from legal_cases table
    alias_citation: str  # The citation text
    citation_type: str  # SCC, AIR, MANU, etc.
    source: str  # "header" or "cross_ref"


# =============================================================================
# QDRANT CLIENT (reused from seed script)
# =============================================================================


class QdrantCorpusClient:
    """Direct Qdrant client for corpus access."""

    def __init__(self, url: str, api_key: str):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.client = httpx.AsyncClient(
            timeout=60.0,
            headers={"api-key": api_key, "Content-Type": "application/json"},
        )

    async def scroll(
        self,
        collection: str,
        limit: int = 100,
        offset: str | None = None,
        filter_: dict | None = None,
        with_payload: bool | list[str] = True,
    ) -> tuple[list[dict], str | None]:
        """Scroll through collection with cursor-based pagination."""
        body: dict[str, Any] = {
            "limit": limit,
            "with_payload": with_payload,
            "with_vector": False,
        }
        if offset:
            body["offset"] = offset
        if filter_:
            body["filter"] = filter_

        response = await self.client.post(
            f"{self.url}/collections/{collection}/points/scroll",
            json=body,
        )
        response.raise_for_status()
        data = response.json()

        points = data.get("result", {}).get("points", [])
        next_offset = data.get("result", {}).get("next_page_offset")

        return points, next_offset

    async def close(self):
        await self.client.aclose()


# =============================================================================
# SUPABASE CLIENT
# =============================================================================


class SupabaseDirectClient:
    """Direct Supabase client for bulk operations."""

    def __init__(self, url: str, service_key: str):
        self.url = url.rstrip("/")
        self.client = httpx.AsyncClient(
            timeout=60.0,
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
        )

    async def get_case_id_by_corpus_id(self, corpus_case_id: str) -> str | None:
        """Look up legal_case UUID by corpus_case_id."""
        response = await self.client.get(
            f"{self.url}/rest/v1/legal_cases",
            params={
                "select": "id",
                "corpus_case_id": f"eq.{corpus_case_id}",
                "limit": "1",
            },
        )
        if response.status_code == 200:
            rows = response.json()
            if rows:
                return rows[0]["id"]
        return None

    async def batch_get_case_ids(self, corpus_case_ids: list[str]) -> dict[str, str]:
        """Batch look up legal_case UUIDs by corpus_case_ids."""
        result: dict[str, str] = {}
        # PostgREST supports in. filter for batching
        for i in range(0, len(corpus_case_ids), 100):
            batch = corpus_case_ids[i : i + 100]
            param = ",".join(f'"{cid}"' for cid in batch)
            response = await self.client.get(
                f"{self.url}/rest/v1/legal_cases",
                params={
                    "select": "id,corpus_case_id",
                    "corpus_case_id": f"in.({param})",
                },
            )
            if response.status_code == 200:
                for row in response.json():
                    if row.get("corpus_case_id"):
                        result[row["corpus_case_id"]] = row["id"]
        return result

    async def upsert_aliases(self, aliases: list[dict]) -> int:
        """Bulk upsert citation aliases."""
        if not aliases:
            return 0

        response = await self.client.post(
            f"{self.url}/rest/v1/citation_aliases",
            json=aliases,
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )

        if response.status_code not in (200, 201, 204):
            logger.error(f"Alias upsert failed: {response.status_code} - {response.text[:200]}")
            return 0

        return len(aliases)

    async def get_cases_without_scc_alias(self, limit: int = 1000) -> list[dict]:
        """Get SC cases that have no SCC alias."""
        # Query legal_cases where court_code='SC' and no SCC alias exists
        response = await self.client.get(
            f"{self.url}/rest/v1/legal_cases",
            params={
                "select": "id,corpus_case_id,primary_citation,year",
                "court_code": "eq.SC",
                "limit": str(limit),
                # Subquery: no SCC alias exists
                # PostgREST doesn't support NOT EXISTS directly,
                # so we'll filter in Python after fetching
            },
        )
        if response.status_code == 200:
            return response.json()
        return []

    async def close(self):
        await self.client.aclose()


# =============================================================================
# CITATION NORMALIZER (lightweight, no service dependency)
# =============================================================================


def normalize_citation(citation: str) -> str:
    """Normalize citation for consistent matching (mirrors CitationGraphService)."""
    normalized = citation.upper().strip()
    # Collapse dotted abbreviations: S.C.R. → SCR
    normalized = re.sub(
        r"(?<![A-Z])([A-Z])(?:\.([A-Z]))+\.?",
        lambda m: m.group(0).replace(".", ""),
        normalized,
    )
    # Remove brackets and parentheses
    normalized = re.sub(r"[\[\]()]", "", normalized)
    # Replace hyphens/underscores/slashes with spaces
    normalized = re.sub(r"[-_/]+", " ", normalized)
    # Remove newlines
    normalized = re.sub(r"[\n\r]+", " ", normalized)
    # Collapse multiple spaces
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized


def detect_citation_type(citation: str) -> str:
    """Detect citation type from citation text."""
    upper = citation.upper()
    if "SCC" in upper or "S.C.C." in upper:
        return "SCC"
    if "SCR" in upper or "S.C.R." in upper:
        return "SCR"
    if "AIR" in upper or "A.I.R." in upper:
        return "AIR"
    if "INSC" in upper:
        return "NEUTRAL"
    if "MANU" in upper:
        return "MANU"
    if "SCALE" in upper:
        return "SCALE"
    if "JT" in upper:
        return "JT"
    return "OTHER"


def uuid7_str() -> str:
    """Generate a UUIDv7 string."""

    timestamp_ms = int(time.time() * 1000)
    random_bits = int.from_bytes(os.urandom(10), "big")

    time_high = (timestamp_ms >> 16) & 0xFFFFFFFF
    time_low = timestamp_ms & 0xFFFF
    rand_a = (random_bits >> 62) & 0x0FFF
    rand_b = random_bits & 0x3FFFFFFFFFFFFFFF

    uuid_int = (
        (time_high << 96)
        | (time_low << 80)
        | (0x7 << 76)
        | (rand_a << 64)
        | (0x2 << 62)
        | rand_b
    )

    from uuid import UUID

    return str(UUID(int=uuid_int))


# =============================================================================
# ALIAS MINER
# =============================================================================


class CitationAliasMiner:
    """Mines Qdrant corpus to extract parallel citation aliases."""

    def __init__(
        self,
        qdrant: QdrantCorpusClient,
        supabase: SupabaseDirectClient,
        dry_run: bool = False,
        max_cases: int | None = None,
        verbose: bool = False,
    ):
        self.qdrant = qdrant
        self.supabase = supabase
        self.extractor = CitationExtractor()
        self.dry_run = dry_run
        self.max_cases = max_cases
        self.verbose = verbose
        self.stats = MiningStats()

    # ---- Checkpoint management ----

    def save_checkpoint(self):
        """Save progress checkpoint."""
        data = self.stats.to_dict()
        CHECKPOINT_FILE.write_text(json.dumps(data, indent=2))

    def load_checkpoint(self) -> bool:
        """Load checkpoint if exists."""
        if not CHECKPOINT_FILE.exists():
            return False
        try:
            data = json.loads(CHECKPOINT_FILE.read_text())
            self.stats.cases_processed = data.get("cases_processed", 0)
            self.stats.cases_with_aliases = data.get("cases_with_aliases", 0)
            self.stats.aliases_found = data.get("aliases_found", 0)
            self.stats.aliases_inserted = data.get("aliases_inserted", 0)
            self.stats.scc_found = data.get("scc_found", 0)
            self.stats.air_found = data.get("air_found", 0)
            self.stats.manu_found = data.get("manu_found", 0)
            self.stats.scale_found = data.get("scale_found", 0)
            self.stats.other_found = data.get("other_found", 0)
            self.stats.cross_ref_found = data.get("cross_ref_found", 0)
            self.stats.errors = data.get("errors", 0)
            self.stats.last_cursor = data.get("last_cursor")
            self.stats.phase = data.get("phase", "header")
            logger.info(f"Resumed from checkpoint: {self.stats.cases_processed:,} cases processed")
            return True
        except Exception as e:
            logger.warning(f"Failed to load checkpoint: {e}")
            return False

    # ---- Header Mining (Pass 1) ----

    async def mine_headers(self):
        """
        Mine header sections of SC judgments for parallel citations.

        For each unique SC case in v2:
        1. Get chunk_index=0 (header/metadata section)
        2. Extract all citations from text
        3. Filter: same year + SC court → parallel citations
        4. Insert as aliases
        """
        self.stats.phase = "header"
        self.stats.start_time = time.time()
        logger.info("=" * 60)
        logger.info("PHASE 1: Header Mining")
        logger.info("=" * 60)

        # Filter: SC cases in v2 with chunk_index=0 (header)
        qdrant_filter = {
            "must": [
                {"key": "court_type", "match": {"value": "supreme_court"}},
                {"key": "chunk_index", "match": {"value": 0}},
            ]
        }

        # Payload fields we need
        payload_fields = [
            "case_id",
            "citation",
            "title",
            "year",
            "court_type",
            "text",
            "description",
        ]

        cursor = self.stats.last_cursor
        batch_aliases: list[DiscoveredAlias] = []
        seen_case_ids: set[str] = set()

        while True:
            if self.max_cases and self.stats.cases_processed >= self.max_cases:
                logger.info(f"Reached max_cases limit: {self.max_cases}")
                break

            try:
                points, next_cursor = await self.qdrant.scroll(
                    collection=COLLECTION,
                    limit=100,
                    offset=cursor,
                    filter_=qdrant_filter,
                    with_payload=payload_fields,
                )
            except Exception as e:
                logger.error(f"Qdrant scroll failed: {e}")
                self.stats.errors += 1
                await asyncio.sleep(2)
                continue

            if not points:
                logger.info("No more points to process")
                break

            for point in points:
                payload = point.get("payload", {})
                case_id = payload.get("case_id")

                if not case_id or case_id in seen_case_ids:
                    continue

                seen_case_ids.add(case_id)
                self.stats.cases_processed += 1

                # Get the text content (try text first, then description)
                text = payload.get("text") or payload.get("description") or ""
                if not text:
                    continue

                # Get case year and primary citation
                case_year = payload.get("year")
                primary_citation = payload.get("citation", "")

                # Extract all citations from header text
                try:
                    citations = self.extractor.extract(text, deduplicate=True)
                except Exception as e:
                    if self.verbose:
                        logger.debug(f"Extraction failed for {case_id}: {e}")
                    self.stats.errors += 1
                    continue

                # Filter for parallel citations:
                # - Same year as the case (±1 year for SCR/SCC year discrepancies)
                # - SC court level
                # - NOT the same as primary citation
                aliases_for_case = []
                primary_normalized = normalize_citation(primary_citation) if primary_citation else ""

                for cit in citations:
                    # Must be SC level
                    if cit.court_level != CourtLevel.SUPREME_COURT:
                        continue

                    # Must be same year (±1 for SCR/SCC year offset)
                    if case_year and cit.year:
                        if abs(cit.year - case_year) > 1:
                            continue

                    # Must not be the same as primary citation
                    cit_normalized = normalize_citation(cit.full_citation)
                    if cit_normalized == primary_normalized:
                        continue

                    # Must be a different reporter type
                    cit_type = CITATION_TYPE_MAP.get(cit.reporter, "OTHER")
                    primary_type = detect_citation_type(primary_citation) if primary_citation else ""
                    if cit_type == primary_type:
                        continue

                    aliases_for_case.append(
                        DiscoveredAlias(
                            case_id=case_id,
                            legal_case_id=None,  # Will be resolved in batch
                            alias_citation=cit.full_citation,
                            citation_type=cit_type,
                            source="header",
                        )
                    )

                    # Track stats
                    self.stats.aliases_found += 1
                    if cit_type == "SCC":
                        self.stats.scc_found += 1
                    elif cit_type == "AIR":
                        self.stats.air_found += 1
                    elif cit_type == "MANU":
                        self.stats.manu_found += 1
                    elif cit_type == "SCALE":
                        self.stats.scale_found += 1
                    else:
                        self.stats.other_found += 1

                if aliases_for_case:
                    self.stats.cases_with_aliases += 1
                    batch_aliases.extend(aliases_for_case)

                    if self.verbose:
                        logger.info(
                            f"  {case_id}: Found {len(aliases_for_case)} aliases "
                            f"({', '.join(a.citation_type + ':' + a.alias_citation[:30] for a in aliases_for_case)})"
                        )

            # Flush batch when large enough
            if len(batch_aliases) >= 200:
                await self._flush_aliases(batch_aliases)
                batch_aliases = []

            # Update cursor and checkpoint
            cursor = next_cursor
            self.stats.last_cursor = cursor

            if self.stats.cases_processed % 1000 == 0:
                logger.info(self.stats.summary())
                self.save_checkpoint()

            if not next_cursor:
                break

        # Final flush
        if batch_aliases:
            await self._flush_aliases(batch_aliases)

        self.save_checkpoint()
        logger.info("=" * 60)
        logger.info(f"Header mining complete: {self.stats.summary()}")
        logger.info("=" * 60)

    # ---- Cross-Reference Mining (Pass 2) ----

    async def mine_cross_references(self):
        """
        Mine full judgment text for self-referencing SCC citations.

        For cases without a SCC alias after header mining:
        1. Search full judgment text for "reported in/as (YYYY) X SCC NNN"
        2. Extract the SCC citation
        3. Insert as alias
        """
        self.stats.phase = "cross_ref"
        logger.info("=" * 60)
        logger.info("PHASE 2: Cross-Reference Mining")
        logger.info("=" * 60)

        # Get SC cases without SCC alias — scroll through v2 SC cases
        # For each, check if any chunk contains a self-reference pattern
        qdrant_filter = {
            "must": [
                {"key": "court_type", "match": {"value": "supreme_court"}},
            ]
        }

        payload_fields = ["case_id", "citation", "year", "text", "chunk_index"]

        cursor = None
        seen_case_ids: set[str] = set()
        # Track cases we already found SCC for in phase 1
        cases_with_scc: set[str] = set()
        batch_aliases: list[DiscoveredAlias] = []
        cross_ref_processed = 0

        while True:
            if self.max_cases and cross_ref_processed >= self.max_cases:
                break

            try:
                points, next_cursor = await self.qdrant.scroll(
                    collection=COLLECTION,
                    limit=100,
                    offset=cursor,
                    filter_=qdrant_filter,
                    with_payload=payload_fields,
                )
            except Exception as e:
                logger.error(f"Qdrant scroll failed: {e}")
                self.stats.errors += 1
                await asyncio.sleep(2)
                continue

            if not points:
                break

            for point in points:
                payload = point.get("payload", {})
                case_id = payload.get("case_id")
                text = payload.get("text", "")

                if not case_id or not text:
                    continue

                if case_id in cases_with_scc:
                    continue

                case_year = payload.get("year")

                # Search for self-reference patterns
                for pattern in SELF_REFERENCE_PATTERNS:
                    matches = pattern.findall(text)
                    for match in matches:
                        if len(match) == 3:
                            # SCC format: (year, volume, page)
                            year, volume, page = match
                            scc_citation = f"({year}) {volume} SCC {page}"
                        elif len(match) == 2:
                            # AIR format: (year, page)
                            year, page = match
                            scc_citation = f"AIR {year} SC {page}"
                        else:
                            continue

                        # Validate year proximity
                        if case_year:
                            try:
                                if abs(int(year) - case_year) > 1:
                                    continue
                            except ValueError:
                                continue

                        cit_type = detect_citation_type(scc_citation)

                        batch_aliases.append(
                            DiscoveredAlias(
                                case_id=case_id,
                                legal_case_id=None,
                                alias_citation=scc_citation,
                                citation_type=cit_type,
                                source="cross_ref",
                            )
                        )
                        self.stats.cross_ref_found += 1
                        self.stats.aliases_found += 1
                        cases_with_scc.add(case_id)

                        if self.verbose:
                            logger.info(f"  CrossRef: {case_id} → {scc_citation}")

                        break  # One SCC per case is enough
                    if case_id in cases_with_scc:
                        break

                if case_id not in seen_case_ids:
                    seen_case_ids.add(case_id)
                    cross_ref_processed += 1

            # Flush batch
            if len(batch_aliases) >= 200:
                await self._flush_aliases(batch_aliases)
                batch_aliases = []

            cursor = next_cursor
            if cross_ref_processed % 5000 == 0 and cross_ref_processed > 0:
                logger.info(
                    f"Cross-ref: {cross_ref_processed:,} cases scanned, "
                    f"{self.stats.cross_ref_found:,} SCC refs found"
                )

            if not next_cursor:
                break

        # Final flush
        if batch_aliases:
            await self._flush_aliases(batch_aliases)

        logger.info(f"Cross-reference mining complete: {self.stats.cross_ref_found:,} refs found")

    # ---- Alias Flushing ----

    async def _flush_aliases(self, aliases: list[DiscoveredAlias]):
        """Resolve case IDs and insert aliases into Supabase."""
        if not aliases or self.dry_run:
            if self.dry_run:
                logger.info(f"[DRY RUN] Would insert {len(aliases)} aliases")
                for a in aliases[:5]:
                    logger.info(f"  {a.case_id} → {a.citation_type}: {a.alias_citation}")
                if len(aliases) > 5:
                    logger.info(f"  ... and {len(aliases) - 5} more")
            return

        # Batch resolve corpus_case_id → legal_case_id
        unique_corpus_ids = list({a.case_id for a in aliases})
        id_map = await self.supabase.batch_get_case_ids(unique_corpus_ids)

        # Build insert records
        records = []
        now = datetime.now(UTC).isoformat()

        for alias in aliases:
            legal_case_id = id_map.get(alias.case_id)
            if not legal_case_id:
                if self.verbose:
                    logger.debug(f"No legal_case for corpus {alias.case_id}, skipping alias")
                continue

            normalized = normalize_citation(alias.alias_citation)

            records.append(
                {
                    "id": uuid7_str(),
                    "legal_case_id": legal_case_id,
                    "alias_citation": alias.alias_citation,
                    "normalized_alias": normalized,
                    "citation_type": alias.citation_type,
                    "created_at": now,
                }
            )

        if records:
            inserted = await self.supabase.upsert_aliases(records)
            self.stats.aliases_inserted += inserted
            if inserted < len(records):
                logger.warning(
                    f"Partial insert: {inserted}/{len(records)} aliases "
                    f"(duplicates or errors for {len(records) - inserted})"
                )

    # ---- Main Entry Point ----

    async def run(self, mode: str = "full", resume: bool = False):
        """Run the mining pipeline."""
        if resume:
            self.load_checkpoint()

        logger.info(f"Starting citation alias mining (mode={mode}, dry_run={self.dry_run})")
        logger.info(f"Collection: {COLLECTION}")
        if self.max_cases:
            logger.info(f"Max cases per phase: {self.max_cases}")

        self.stats.start_time = time.time()

        # Phase 1: Header mining (always run)
        await self.mine_headers()

        # Phase 2: Cross-reference mining (only in full mode)
        if mode == "full":
            await self.mine_cross_references()

        # Final summary
        elapsed = time.time() - self.stats.start_time
        logger.info("=" * 60)
        logger.info("MINING COMPLETE")
        logger.info("=" * 60)
        logger.info(f"Total time: {elapsed:.0f}s ({elapsed / 60:.1f} min)")
        logger.info(f"Cases processed: {self.stats.cases_processed:,}")
        logger.info(f"Cases with aliases: {self.stats.cases_with_aliases:,}")
        logger.info(f"Total aliases found: {self.stats.aliases_found:,}")
        logger.info(f"  SCC: {self.stats.scc_found:,}")
        logger.info(f"  AIR: {self.stats.air_found:,}")
        logger.info(f"  MANU: {self.stats.manu_found:,}")
        logger.info(f"  SCALE: {self.stats.scale_found:,}")
        logger.info(f"  Other: {self.stats.other_found:,}")
        logger.info(f"  Cross-ref: {self.stats.cross_ref_found:,}")
        logger.info(f"Aliases inserted: {self.stats.aliases_inserted:,}")
        logger.info(f"Errors: {self.stats.errors:,}")

        # Cleanup checkpoint on successful completion
        if not self.dry_run and CHECKPOINT_FILE.exists():
            CHECKPOINT_FILE.unlink()
            logger.info("Checkpoint file cleaned up")


# =============================================================================
# MAIN
# =============================================================================


async def main():
    parser = argparse.ArgumentParser(description="Mine citation aliases from Qdrant corpus")
    parser.add_argument(
        "--mode",
        choices=["header", "full"],
        default="full",
        help="Mining mode: 'header' for header-only, 'full' for header + cross-reference",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview without DB writes")
    parser.add_argument("--resume", action="store_true", help="Resume from checkpoint")
    parser.add_argument("--max-cases", type=int, help="Max cases to process per phase")
    parser.add_argument("--verbose", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    # Validate env
    if not QDRANT_CORPUS_API_KEY:
        logger.error("QDRANT_CORPUS_API_KEY not set")
        sys.exit(1)
    if not args.dry_run and (not SUPABASE_URL or not SUPABASE_SERVICE_KEY):
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for non-dry-run")
        sys.exit(1)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Create clients
    qdrant = QdrantCorpusClient(QDRANT_CORPUS_URL, QDRANT_CORPUS_API_KEY)
    supabase = SupabaseDirectClient(SUPABASE_URL or "", SUPABASE_SERVICE_KEY or "")

    miner = CitationAliasMiner(
        qdrant=qdrant,
        supabase=supabase,
        dry_run=args.dry_run,
        max_cases=args.max_cases,
        verbose=args.verbose,
    )

    try:
        await miner.run(mode=args.mode, resume=args.resume)
    finally:
        await qdrant.close()
        await supabase.close()


if __name__ == "__main__":
    asyncio.run(main())
