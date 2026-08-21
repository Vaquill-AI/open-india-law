"""
One-time extraction of unique judge names and dispositions from Qdrant corpus.

Scrolls collections, deduplicates, and inserts into Supabase tables:
- corpus_judges (name, court_type, case_count)
- corpus_dispositions (value, case_count)

Features:
- Resume support: saves checkpoint after each batch to /tmp/extract_checkpoint.json
- Sampling: 500K points per collection (judges repeat across chunks)
- Batch size 1000 for speed

Usage:
    python -u scripts/extract_judges_dispositions.py          # Fresh run
    python -u scripts/extract_judges_dispositions.py --resume  # Resume from checkpoint
"""

import asyncio
import json
import os
import sys
from collections import Counter
from pathlib import Path

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from qdrant_client import AsyncQdrantClient
from qdrant_client.models import FieldCondition, Filter, MatchValue

from app.core.config import settings
from app.integrations.supabase import get_supabase_client


COLLECTIONS = ["legal_corpus_v1", "legal_corpus_v2"]
BATCH_SIZE = 1000
PROGRESS_INTERVAL = 50_000  # Log every N points
# v1 = HC only (no SC judges), v2 = HC+SC. Limit v1 to 500K for dispositions.
MAX_POINTS = {
    "legal_corpus_v1": 500_000,   # HC only — just need dispositions
    "legal_corpus_v2": 0,          # 0 = no limit — has SC judges
}
CHECKPOINT_FILE = Path("/tmp/extract_checkpoint.json")
CHECKPOINT_EVERY = 10_000  # Save checkpoint every N points


def save_checkpoint(
    collection: str,
    offset: str | int | None,
    total_points: int,
    judges: Counter,
    dispositions: Counter,
    completed_collections: list[str],
):
    """Save progress to checkpoint file."""
    data = {
        "current_collection": collection,
        "offset": str(offset) if offset is not None else None,
        "total_points": total_points,
        "completed_collections": completed_collections,
        "judges": {f"{name}||{ct}": count for (name, ct), count in judges.items()},
        "dispositions": dict(dispositions),
    }
    CHECKPOINT_FILE.write_text(json.dumps(data))


def load_checkpoint() -> dict | None:
    """Load checkpoint if it exists."""
    if not CHECKPOINT_FILE.exists():
        return None
    try:
        data = json.loads(CHECKPOINT_FILE.read_text())
        # Reconstruct counters
        judges = Counter()
        for key, count in data.get("judges", {}).items():
            name, ct = key.rsplit("||", 1)
            judges[(name, ct)] = count
        data["judges"] = judges
        data["dispositions"] = Counter(data.get("dispositions", {}))
        return data
    except (json.JSONDecodeError, ValueError) as e:
        print(f"  WARNING: Corrupt checkpoint, starting fresh: {e}")
        return None


async def scroll_collection(
    client: AsyncQdrantClient,
    collection: str,
    resume_offset: str | int | None = None,
    resume_total: int = 0,
    existing_judges: Counter | None = None,
    existing_dispositions: Counter | None = None,
    completed_collections: list[str] | None = None,
) -> tuple[Counter, Counter]:
    """Scroll a collection and extract judge names + dispositions."""
    judges: Counter = existing_judges or Counter()
    dispositions: Counter = existing_dispositions or Counter()
    total_points = resume_total
    points_with_judges = 0
    completed = completed_collections or []

    offset = resume_offset
    if resume_offset:
        print(f"  Resuming from offset {resume_offset}, {total_points:,} points already done")

    while True:
        points, next_offset = await client.scroll(
            collection_name=collection,
            scroll_filter=None,
            limit=BATCH_SIZE,
            offset=offset,
            with_payload=["judges", "disposition", "court_type", "case_id"],
            with_vectors=False,
        )

        if not points:
            break

        for point in points:
            total_points += 1
            payload = point.payload or {}
            ct = payload.get("court_type", "unknown")

            # Extract judges — SC only (HC judge data is PDF garbage)
            if ct == "supreme_court":
                judge_list = payload.get("judges")
                if isinstance(judge_list, list) and judge_list:
                    points_with_judges += 1
                    for j in judge_list:
                        if isinstance(j, str) and j.strip():
                            judges[(j.strip(), ct)] += 1
                elif isinstance(judge_list, str) and judge_list.strip():
                    points_with_judges += 1
                    judges[(judge_list.strip(), ct)] += 1

            # Extract dispositions
            disp = payload.get("disposition")
            if isinstance(disp, str) and disp.strip():
                dispositions[disp.strip()] += 1

        if total_points % PROGRESS_INTERVAL < BATCH_SIZE:
            print(
                f"  [{collection}] {total_points:,} points scrolled, "
                f"{len(judges):,} unique judge+court combos, "
                f"{len(dispositions):,} unique dispositions, "
                f"{points_with_judges:,} points with judges"
            )

        # Save checkpoint periodically
        if total_points % CHECKPOINT_EVERY < BATCH_SIZE:
            save_checkpoint(collection, next_offset, total_points, judges, dispositions, completed)

        if next_offset is None:
            break
        max_for_collection = MAX_POINTS.get(collection, 0)
        if max_for_collection > 0 and total_points >= max_for_collection:
            print(f"  [{collection}] Reached {max_for_collection:,} limit, stopping.")
            break
        offset = next_offset

    print(
        f"  [{collection}] DONE: {total_points:,} points, "
        f"{len(judges):,} unique judge+court combos, "
        f"{len(dispositions):,} unique dispositions"
    )
    return judges, dispositions


# HC "judges" field is full of PDF extraction garbage ("Advocate", "therefore", etc.)
# Only SC judge names are clean. For HC, apply aggressive filtering.
JUNK_WORDS = {
    "advocate", "therefore", "however", "namely", "thereafter", "vide",
    "punjab", "judge", "this day", "if any", "as such", "wherein",
    "herein", "aforesaid", "accordingly", "furthermore", "moreover",
    "notwithstanding", "inasmuch", "whosoever", "whatsoever",
}
JUNK_PREFIXES = ("occ:", "age:", "high court", "honourable the")


def is_valid_judge_name(name: str, court_type: str) -> bool:
    """Filter out PDF extraction garbage from judge names."""
    if len(name) < 3 or name.isdigit():
        return False
    lower = name.lower().strip()
    # Always reject obvious junk
    if lower in JUNK_WORDS:
        return False
    if any(lower.startswith(p) for p in JUNK_PREFIXES):
        return False
    # For HC, require "Justice" or at least 2 capitalized words (name-like)
    if court_type == "high_court":
        if "justice" in lower or "j." in lower:
            return True
        # Must look like a name: at least 2 words, each starting with uppercase
        words = name.split()
        if len(words) < 2:
            return False
        capitalized = sum(1 for w in words if w[0].isupper())
        return capitalized >= 2 and len(name) >= 5
    # SC names are clean — accept with minimal filtering
    return True


async def insert_judges(judges: Counter) -> int:
    """Insert unique judges into Supabase corpus_judges table."""
    supabase = get_supabase_client().service_client

    rows = []
    skipped = 0
    for (name, court_type), count in judges.items():
        if not is_valid_judge_name(name, court_type):
            skipped += 1
            continue
        rows.append({
            "name": name,
            "court_type": court_type,
            "case_count": count,
        })

    print(f"  Filtered: {len(rows):,} valid, {skipped:,} junk skipped")

    # Batch insert with upsert
    inserted = 0
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        try:
            supabase.table("corpus_judges").upsert(
                batch,
                on_conflict="name,court_type",
            ).execute()
            inserted += len(batch)
            if inserted % 5000 < batch_size:
                print(f"  Judges inserted: {inserted:,}/{len(rows):,}")
        except Exception as e:
            print(f"  ERROR inserting judges batch {i}: {e}")

    return inserted


def normalize_disposition(raw: str) -> str | None:
    """Normalize raw disposition strings into canonical values.

    Returns None for junk/internal codes that shouldn't appear in the UI.
    Collapses casing variants, trailing qualifiers (NO COSTS, WITH COSTS),
    and court-specific codes into ~20 canonical dispositions.
    """
    s = raw.strip()
    if not s:
        return None

    upper = s.upper()

    # ── Reject court-internal codes (e.g. "38-RULE ABSOLUTE/ALLOWED @ FH") ──
    if upper[:2].isdigit() and "-" in upper[:4]:
        return None
    # Reject codes with @ (admission/final hearing codes)
    if "@ ADM" in upper or "@ FH" in upper:
        return None
    # Reject noise / court-internal labels
    if upper in {
        "JHARKHAND", "BOGUS", "VERIFY", "PREMPTORY", "PEREMPTORY",
        "INTERM  ORDER", "HEARD", "ADDL. GROUND", "EXPEDEDIT",
        "ADJUDICATED", "FOR PURPOSE OF COMPLIANCE",
        "IA/MEMO/VK/OP IN DISPOSAL", "IA DISPOSED",
        "SCHEME SANCTIONED - COMPANY", "COMPANY WOUND UP",
        "SPEAKING TO MINUTES", "AG AND OT", "DECIDED CASE",
        "HEARING ADJOURNED", "PROCEEDINGS CLOSED/DROPPED",
    }:
        return None
    # Reject long strings (usually garbage)
    if len(s) > 60:
        return None

    # ── Normalize into canonical buckets ──

    # DISPOSED OF — many variants
    if any(
        upper.startswith(p)
        for p in ("DISPOSED", "DISPOSSED", "DISPOSAL")
    ):
        return "DISPOSED OF"

    # ALLOWED — but not PARTLY ALLOWED
    if "PARTLY" in upper:
        # Handle PARTLY ALLOWED before ALLOWED
        if "PARTLY ALLOWED" in upper or "CASE PARTLY ALLOWED" in upper:
            return "PARTLY ALLOWED"
        if "PARTLY SUCCESS" in upper:
            return "PARTLY ALLOWED"
    if upper.startswith("ALLOWED") or upper.startswith("CASE ALLOWED"):
        return "ALLOWED"
    if upper.startswith("APPEAL(S) ALLOWED") or upper.startswith("APPEAL IS ALLOWED"):
        return "ALLOWED"
    if upper.startswith("PETITION IS ALLOWED"):
        return "ALLOWED"
    if upper in {"APPLICATION ALLOWED", "APPEAL ALLOWED", "APPEAL ALLOWED/REVERSED"}:
        return "ALLOWED"
    if upper.startswith("ADMITTED") and ("ALLOWED" in upper or "GRANTED" in upper):
        return "ALLOWED"
    if upper.startswith("LEAVE GRANTED & ALLOWED"):
        return "ALLOWED"

    # DISMISSED — but not PARTLY
    if upper.startswith("DISMISSED") or upper.startswith("DISMISED"):
        if "INFRUCTUOUS" in upper or "INFRACTUOUS" in upper or "INFRACTOUS" in upper:
            return "DISMISSED AS INFRUCTUOUS"
        if "DEFAULT" in upper or "NON" in upper:
            return "DISMISSED FOR DEFAULT"
        if "WITHDRAWN" in upper or "WITHDRAWAL" in upper:
            return "WITHDRAWN"
        if "ABATED" in upper:
            return "ABATED"
        if "SETTLED" in upper:
            return "SETTLED"
        if "NOT MAINTAINABLE" in upper:
            return "DISMISSED"
        return "DISMISSED"
    if upper.startswith("DISMISS") or upper.startswith("DISSMISS"):
        if "DEFAULT" in upper or "NON" in upper:
            return "DISMISSED FOR DEFAULT"
        return "DISMISSED"
    if upper.startswith("D.F.D"):
        return "DISMISSED FOR DEFAULT"
    if upper.startswith("APPEAL DISMISSED") or upper.startswith("APPEAL IS DISMISSED"):
        return "DISMISSED"
    if upper == "APPEAL CONFIRMED":
        return "DISMISSED"

    # REJECTED
    if upper.startswith("REJECTED"):
        return "REJECTED"

    # QUASHED
    if upper == "QUASHED":
        return "QUASHED"

    # WITHDRAWN / NOT PRESSED
    if upper.startswith("WITHDRAWN") or upper.startswith("NOT-PRESSED") or upper.startswith("NOT PRESSED"):
        return "WITHDRAWN"
    if "WITHDRAWN" in upper:
        return "WITHDRAWN"

    # BAIL
    if upper == "BAIL" or upper.startswith("BAIL GRANTED") or upper == "PROVISIONAL BAIL":
        return "BAIL GRANTED"
    if "ANTICIPAT" in upper and "BAIL" in upper:
        return "BAIL GRANTED"
    if upper in {"INTERIM BAIL", "BAIL IN PART"}:
        return "BAIL GRANTED"
    if "BAIL REJECTED" in upper or "BAIL CANCELLED" in upper:
        return "BAIL REJECTED"
    if upper.startswith("ANTICIPATORY BAIL REJECTED"):
        return "BAIL REJECTED"

    # CLOSED
    if upper.startswith("CLOSED"):
        return "CLOSED"
    if upper.startswith("CONSIGNED"):
        return "CLOSED"

    # REMANDED / REMITTED
    if "REMAND" in upper or "REMITTED" in upper:
        return "REMANDED"

    # SETTLED / COMPROMISE / LOK ADALAT
    if any(w in upper for w in (
        "SETTLED", "COMPROMISE", "COMPROM", "CONSENT TERM",
        "LOK ADALAT", "MEDIATION", "COMPOUNDED",
    )):
        return "SETTLED"

    # ACQUITTED / CONVICTED
    if upper == "ACQUITTED":
        return "ACQUITTED"
    if upper == "CONVICTED":
        return "CONVICTED"

    # TRANSFERRED (many court-specific variants)
    if upper.startswith("TRANSFER") or upper.startswith("TRANSFERED") or upper.startswith("TRANSFRD"):
        return "TRANSFERRED"
    if upper.startswith("RE-TRANSFERRED"):
        return "TRANSFERRED"
    if upper.startswith("R AND P TRANSFERED"):
        return "TRANSFERRED"

    # ABATED
    if "ABATED" in upper:
        return "ABATED"
    if upper.startswith("ABATED"):
        return "ABATED"

    # INFRUCTUOUS (standalone, not already caught by DISMISSED AS INFRUCTUOUS)
    if "INFRUCTU" in upper or "INFRACTU" in upper or "INFRACTOUS" in upper:
        return "DISMISSED AS INFRUCTUOUS"

    # DECREED
    if upper.startswith("DECREE") or upper.startswith("EX-PARTE DECREE"):
        return "DECREED"

    # GRANTED / LEAVE GRANTED / STAY
    if upper in {"GRANTED", "LEAVE GRANTED", "GRANT ISSUED", "APPLICATION GRANTED"}:
        return "GRANTED"
    if upper.startswith("LEAVE GRANTED"):
        return "GRANTED"
    if upper.startswith("LEAVE TO APPEAL"):
        return "GRANTED"
    if upper.startswith("STAY"):
        return "STAYED"

    # ORDERED / DIRECTIONS
    if upper.startswith("ORDERED"):
        return "ORDERED"
    if upper.startswith("DIRECTION"):
        return "ORDERED"
    if upper == "JUDGEMENT":
        return "ORDERED"

    # REFERRED TO LARGER BENCH
    if "LARGER BENCH" in upper:
        return "REFERRED TO LARGER BENCH"

    # REFERENCE ANSWERED
    if upper.startswith("REFERENCE ANSWERED") or upper.startswith("ANSWERED"):
        return "REFERENCE ANSWERED"

    # RULE MADE ABSOLUTE / RULE DISCHARGED
    if "RULE" in upper and "ABSOLUTE" in upper:
        return "RULE MADE ABSOLUTE"
    if "RULE" in upper and "DISCHARGED" in upper:
        return "RULE DISCHARGED"
    if upper == "ABSOLUTE" or upper.startswith("PETITION MADE ABSOLUTE"):
        return "RULE MADE ABSOLUTE"
    if upper == "INJUNCTION MADE ABSOLUTE":
        return "RULE MADE ABSOLUTE"

    # DISCHARGED (standalone)
    if upper == "DISCHARGED":
        return "DISCHARGED"

    # MODIFIED / SET ASIDE
    if upper.startswith("MODIFIED") or upper == "ORDER MODIFIED" or upper == "MODIFICATION":
        return "MODIFIED"
    if upper.startswith("SET ASIDE") or upper == "REVERSED":
        return "SET ASIDE"

    # LOW-COUNT recognizable dispositions
    if upper in {"DROPPED", "RELAXED", "CONVERTED", "CONFIRMED", "REVOKED", "CLARIFIED"}:
        return upper
    if upper.startswith("CONVERTED"):
        return "CONVERTED"
    if upper == "AMOUNT AWARDED":
        return "ALLOWED"
    if upper.startswith("LEAVE GRANTED & DISPOSED"):
        return "DISPOSED OF"
    if upper == "CONDONED" or upper.startswith("DELAY CONDONED") or upper.startswith("DELAY CONDONATED"):
        return None  # Procedural, not a final disposition
    if upper.startswith("NON PROSECUTION"):
        return "DISMISSED FOR DEFAULT"

    # Catch remaining OTHERS DISPOSED OFF
    if "OTHERS DISPOSED" in upper or "OTHER DISPOSED" in upper:
        return "DISPOSED OF"
    # Catch remaining C.A. DISPOSED
    if "C.A. DISPOSED" in upper or "REFERENCE DISPOSED" in upper:
        return "DISPOSED OF"

    # Filter out remaining noise with very low counts
    return None


# Minimum chunk count to include a disposition in the final table
DISPOSITION_MIN_COUNT = 10


async def insert_dispositions(dispositions: Counter) -> int:
    """Insert normalized dispositions into Supabase corpus_dispositions table."""
    supabase = get_supabase_client().service_client

    # Normalize and aggregate
    normalized: Counter = Counter()
    skipped_junk = 0
    for raw_value, count in dispositions.items():
        canonical = normalize_disposition(raw_value)
        if canonical is None:
            skipped_junk += 1
            continue
        normalized[canonical] += count

    # Filter by minimum count
    rows = [
        {"value": value, "case_count": count}
        for value, count in normalized.items()
        if count >= DISPOSITION_MIN_COUNT
    ]
    rows.sort(key=lambda r: -r["case_count"])

    print(f"  Dispositions: {len(dispositions):,} raw → {len(normalized):,} normalized → {len(rows):,} above threshold")
    print(f"  Skipped junk: {skipped_junk:,}")
    print(f"  Top 25 normalized dispositions:")
    for r in rows[:25]:
        print(f"    {r['value']}: {r['case_count']:,}")

    try:
        supabase.table("corpus_dispositions").upsert(
            rows,
            on_conflict="value",
        ).execute()
        print(f"  Dispositions inserted: {len(rows)}")
    except Exception as e:
        print(f"  ERROR inserting dispositions: {e}")
        return 0

    return len(rows)


async def main():
    resume = "--resume" in sys.argv

    print("=" * 60)
    print("Extracting judge names & dispositions from Qdrant corpus")
    print(f"  Limits: {MAX_POINTS}")
    print(f"  Batch size: {BATCH_SIZE:,}")
    print("=" * 60)

    corpus_url = settings.QDRANT_CORPUS_URL or settings.QDRANT_URL
    corpus_key = settings.QDRANT_CORPUS_API_KEY or settings.QDRANT_API_KEY
    print(f"Connecting to: {corpus_url}")

    client = AsyncQdrantClient(
        url=corpus_url,
        api_key=corpus_key,
        timeout=120,
    )

    # Load checkpoint if resuming
    checkpoint = load_checkpoint() if resume else None
    all_judges: Counter = Counter()
    all_dispositions: Counter = Counter()
    completed_collections: list[str] = []

    if checkpoint:
        all_judges = checkpoint["judges"]
        all_dispositions = checkpoint["dispositions"]
        completed_collections = checkpoint.get("completed_collections", [])
        print(f"  Resumed: {len(all_judges):,} judges, {len(all_dispositions):,} dispositions from checkpoint")
        print(f"  Completed collections: {completed_collections}")

    for collection in COLLECTIONS:
        if collection in completed_collections:
            print(f"\nSkipping {collection} (already completed)")
            continue

        print(f"\nScrolling {collection}...")

        # Check if we're resuming mid-collection
        resume_offset = None
        resume_total = 0
        if checkpoint and checkpoint.get("current_collection") == collection:
            resume_offset = checkpoint.get("offset")
            resume_total = checkpoint.get("total_points", 0)

        try:
            judges, dispositions = await scroll_collection(
                client,
                collection,
                resume_offset=resume_offset,
                resume_total=resume_total,
                existing_judges=all_judges,
                existing_dispositions=all_dispositions,
                completed_collections=completed_collections,
            )
            all_judges = judges
            all_dispositions = dispositions
            completed_collections.append(collection)
            # Save checkpoint after completing collection
            save_checkpoint(collection, None, 0, all_judges, all_dispositions, completed_collections)
        except Exception as e:
            print(f"  ERROR scrolling {collection}: {e}")
            print("  Saving checkpoint for resume...")
            save_checkpoint(collection, None, 0, all_judges, all_dispositions, completed_collections)
            continue

    print(f"\n{'=' * 60}")
    print(f"Total unique judge+court combos: {len(all_judges):,}")
    print(f"Total unique dispositions: {len(all_dispositions):,}")

    # Show top 20 judges
    print("\nTop 20 judges by chunk count:")
    for (name, ct), count in all_judges.most_common(20):
        print(f"  {name} ({ct}): {count:,} chunks")

    # Show all dispositions
    print("\nAll dispositions:")
    for value, count in all_dispositions.most_common():
        print(f"  {value}: {count:,} chunks")

    # Insert into Supabase
    print(f"\n{'=' * 60}")
    print("Inserting into Supabase...")

    judge_count = await insert_judges(all_judges)
    disp_count = await insert_dispositions(all_dispositions)

    print(f"\nDone! {judge_count:,} judges, {disp_count} dispositions inserted.")

    # Clean up checkpoint only if inserts succeeded
    if judge_count > 0 and disp_count > 0:
        if CHECKPOINT_FILE.exists():
            CHECKPOINT_FILE.unlink()
            print("Checkpoint cleaned up.")
    else:
        print("WARNING: Some inserts failed — checkpoint preserved for --resume")

    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
