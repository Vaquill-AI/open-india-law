"""
Scan and delete encoding-corrupted documents from Qdrant corpus collections.

Safety-first design — multiple layers prevent accidental data loss:

1. SCAN:   Scroll all chunks, compute corruption_score() per chunk
2. AGGREGATE: Group by case_id, compute per-document corruption ratio
3. CLASSIFY: Three tiers — DEFINITE / PARTIAL / BORDERLINE
4. EXPORT:  Write full report to JSON BEFORE any deletion
5. DELETE:  Only "DEFINITE" tier, with confirmation + safety cap

Usage:
    # Phase 1: Scan and generate report (ALWAYS do this first)
    python scripts/cleanup_corrupted_corpus.py

    # Scan specific collection with limited scope
    python scripts/cleanup_corrupted_corpus.py --collection legal_corpus_v1 --max-scan 50000

    # Phase 2: Delete only high-confidence corrupted documents
    python scripts/cleanup_corrupted_corpus.py --delete --max-delete 500

    # Delete individual corrupted chunks (keep good chunks in same document)
    python scripts/cleanup_corrupted_corpus.py --delete-chunks

    # Adjust thresholds (stricter = fewer false positives)
    python scripts/cleanup_corrupted_corpus.py --score-threshold 0.6 --ratio-threshold 0.8
"""

import argparse
import asyncio
import json
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from qdrant_client import AsyncQdrantClient
from qdrant_client.models import (
    FieldCondition,
    Filter,
    MatchValue,
    PointIdsList,
)

from app.core.config import settings
from app.rag.ingestors.text_cleaner import corruption_score


# ============================================
# Data Structures
# ============================================


@dataclass
class CorruptedChunk:
    """A single chunk flagged as corrupted."""

    point_id: str
    score: float
    text_sample: str  # First 200 chars for review


@dataclass
class CaseReport:
    """Per-document corruption analysis."""

    case_id: str
    collection: str
    title: str | None
    total_chunks: int
    corrupted_chunks: int
    corrupted_ratio: float
    avg_score: float
    max_score: float
    classification: str  # "DEFINITE" | "PARTIAL" | "BORDERLINE"
    corrupted_point_ids: list[str] = field(default_factory=list)
    sample_texts: list[str] = field(default_factory=list)


# ============================================
# Scanning
# ============================================


async def scan_collection(
    client: AsyncQdrantClient,
    collection: str,
    score_threshold: float,
    batch_size: int = 200,
    max_scan: int | None = None,
) -> tuple[dict[str, int], dict[str, list[CorruptedChunk]], dict[str, str | None]]:
    """
    Scan a collection, tracking ALL chunks per case_id and flagging corrupted ones.

    Returns:
        - case_chunk_counts: {case_id: total_chunk_count}
        - corrupted_chunks: {case_id: [CorruptedChunk, ...]}
        - case_titles: {case_id: title}
    """
    case_chunk_counts: dict[str, int] = defaultdict(int)
    corrupted_chunks: dict[str, list[CorruptedChunk]] = defaultdict(list)
    case_titles: dict[str, str | None] = {}

    offset = None
    scanned = 0
    flagged = 0

    print(f"\n  Scanning {collection}...")

    while True:
        result = await client.scroll(
            collection_name=collection,
            limit=batch_size,
            offset=offset,
            with_payload=["text", "case_id", "title"],
            with_vectors=False,
        )

        points, next_offset = result

        if not points:
            break

        for point in points:
            payload = point.payload or {}
            text = payload.get("text", "")
            case_id = payload.get("case_id", "unknown")

            # Track every chunk
            case_chunk_counts[case_id] += 1

            # Store title (first seen wins)
            if case_id not in case_titles:
                case_titles[case_id] = payload.get("title")

            # Score and flag
            score = corruption_score(text)
            if score >= score_threshold:
                corrupted_chunks[case_id].append(
                    CorruptedChunk(
                        point_id=str(point.id),
                        score=score,
                        text_sample=text[:200],
                    )
                )
                flagged += 1

        scanned += len(points)

        if scanned % 10000 == 0:
            print(
                f"    {scanned:>10,} chunks scanned | "
                f"{flagged:,} flagged | "
                f"{len(corrupted_chunks):,} case_ids affected"
            )

        if next_offset is None:
            break
        offset = next_offset

        if max_scan and scanned >= max_scan:
            print(f"    Reached scan limit ({max_scan:,})")
            break

    print(
        f"    Done: {scanned:,} chunks scanned, "
        f"{flagged:,} flagged across {len(corrupted_chunks):,} case_ids"
    )
    return dict(case_chunk_counts), dict(corrupted_chunks), case_titles


# ============================================
# Classification
# ============================================


def classify_cases(
    collection: str,
    case_chunk_counts: dict[str, int],
    corrupted_chunks: dict[str, list[CorruptedChunk]],
    case_titles: dict[str, str | None],
    ratio_threshold: float,
    score_threshold: float,
) -> list[CaseReport]:
    """
    Classify each affected case_id into DEFINITE / PARTIAL / BORDERLINE.

    DEFINITE:   corrupted_ratio >= ratio_threshold AND avg_score >= score_threshold
                → Safe to delete (overwhelmingly corrupted)

    PARTIAL:    corrupted_ratio >= 0.3 AND avg_score >= 0.4
                → Consider deleting only corrupted chunks (--delete-chunks)

    BORDERLINE: Everything else above the scan threshold
                → Needs manual review, never auto-deleted
    """
    reports: list[CaseReport] = []

    for case_id, chunks in corrupted_chunks.items():
        total = case_chunk_counts.get(case_id, len(chunks))
        corrupted_count = len(chunks)
        ratio = corrupted_count / total if total > 0 else 0.0
        scores = [c.score for c in chunks]
        avg = sum(scores) / len(scores) if scores else 0.0
        max_s = max(scores) if scores else 0.0

        # Classification logic
        if ratio >= ratio_threshold and avg >= score_threshold:
            classification = "DEFINITE"
        elif ratio >= 0.3 and avg >= 0.4:
            classification = "PARTIAL"
        else:
            classification = "BORDERLINE"

        reports.append(
            CaseReport(
                case_id=case_id,
                collection=collection,
                title=case_titles.get(case_id),
                total_chunks=total,
                corrupted_chunks=corrupted_count,
                corrupted_ratio=round(ratio, 3),
                avg_score=round(avg, 3),
                max_score=round(max_s, 3),
                classification=classification,
                corrupted_point_ids=[c.point_id for c in chunks],
                sample_texts=[c.text_sample for c in chunks[:3]],  # Max 3 samples
            )
        )

    # Sort: DEFINITE first, then by corruption ratio descending
    order = {"DEFINITE": 0, "PARTIAL": 1, "BORDERLINE": 2}
    reports.sort(key=lambda r: (order.get(r.classification, 9), -r.corrupted_ratio))

    return reports


# ============================================
# Reporting
# ============================================


def print_report(reports: list[CaseReport]) -> None:
    """Print a human-readable summary."""
    definite = [r for r in reports if r.classification == "DEFINITE"]
    partial = [r for r in reports if r.classification == "PARTIAL"]
    borderline = [r for r in reports if r.classification == "BORDERLINE"]

    print(f"\n  Classification Results:")
    print(f"    DEFINITE   (safe to delete):     {len(definite):>5} case_ids")
    print(f"    PARTIAL    (delete chunks only):  {len(partial):>5} case_ids")
    print(f"    BORDERLINE (manual review):       {len(borderline):>5} case_ids")

    if definite:
        print(f"\n  Top DEFINITE cases (first 10):")
        for r in definite[:10]:
            title_short = (r.title or "no title")[:60]
            print(
                f"    {r.case_id[:20]:>20} | "
                f"{r.corrupted_chunks}/{r.total_chunks} chunks "
                f"({r.corrupted_ratio:.0%}) | "
                f"avg={r.avg_score:.2f} | "
                f"{title_short}"
            )
            # Show first sample
            if r.sample_texts:
                sample = r.sample_texts[0][:100].replace("\n", " ")
                print(f"{'':>24}   └─ \"{sample}...\"")

    if partial:
        print(f"\n  Top PARTIAL cases (first 5):")
        for r in partial[:5]:
            title_short = (r.title or "no title")[:60]
            print(
                f"    {r.case_id[:20]:>20} | "
                f"{r.corrupted_chunks}/{r.total_chunks} chunks "
                f"({r.corrupted_ratio:.0%}) | "
                f"avg={r.avg_score:.2f} | "
                f"{title_short}"
            )


def export_report(reports: list[CaseReport], output_path: Path) -> None:
    """Export full report to JSON for review before deletion."""
    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_cases": len(reports),
        "by_classification": {
            "DEFINITE": len([r for r in reports if r.classification == "DEFINITE"]),
            "PARTIAL": len([r for r in reports if r.classification == "PARTIAL"]),
            "BORDERLINE": len([r for r in reports if r.classification == "BORDERLINE"]),
        },
        "cases": [asdict(r) for r in reports],
    }
    output_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    print(f"\n  Full report exported to: {output_path}")


# ============================================
# Deletion
# ============================================


async def delete_documents(
    client: AsyncQdrantClient,
    reports: list[CaseReport],
    max_delete: int,
) -> int:
    """
    Delete all chunks for DEFINITE-classified case_ids.

    Deletes by case_id filter (all chunks for the document).
    """
    targets = [r for r in reports if r.classification == "DEFINITE"][:max_delete]

    if not targets:
        print("  No DEFINITE cases to delete.")
        return 0

    total_chunks = sum(r.total_chunks for r in targets)
    print(f"\n  Will delete {len(targets)} case_ids ({total_chunks:,} total chunks)")
    print(f"  Safety cap: {max_delete} (use --max-delete to increase)")

    confirm = input("  Type 'DELETE' to confirm: ")
    if confirm.strip() != "DELETE":
        print("  Aborted.")
        return 0

    deleted = 0
    for i, report in enumerate(targets, 1):
        await client.delete(
            collection_name=report.collection,
            points_selector=Filter(
                must=[
                    FieldCondition(
                        key="case_id",
                        match=MatchValue(value=report.case_id),
                    ),
                ]
            ),
        )
        deleted += 1

        if i % 50 == 0:
            print(f"    Deleted {i}/{len(targets)} case_ids...")

    print(f"    Deleted {deleted} case_ids (all chunks removed)")
    return deleted


async def delete_chunks_only(
    client: AsyncQdrantClient,
    reports: list[CaseReport],
    max_delete: int,
) -> int:
    """
    Delete only the corrupted chunks (not the entire document).

    Safer for PARTIAL cases where some chunks are good.
    """
    # Gather from both DEFINITE and PARTIAL
    targets = [r for r in reports if r.classification in ("DEFINITE", "PARTIAL")]

    if not targets:
        print("  No cases with corrupted chunks to delete.")
        return 0

    # Collect all corrupted point_ids grouped by collection
    by_collection: dict[str, list[str]] = defaultdict(list)
    for report in targets:
        by_collection[report.collection].extend(report.corrupted_point_ids)

    total_points = sum(len(ids) for ids in by_collection.values())
    if total_points > max_delete:
        print(
            f"  {total_points:,} corrupted chunks found, "
            f"but safety cap is {max_delete}. "
            f"Use --max-delete to increase."
        )
        total_points = max_delete

    print(f"\n  Will delete {total_points:,} individual corrupted chunks")
    print(f"  (Good chunks in the same documents are preserved)")

    confirm = input("  Type 'DELETE' to confirm: ")
    if confirm.strip() != "DELETE":
        print("  Aborted.")
        return 0

    deleted = 0
    for collection, point_ids in by_collection.items():
        # Batch delete in groups of 100
        ids_to_delete = point_ids[:max_delete - deleted]
        for i in range(0, len(ids_to_delete), 100):
            batch = ids_to_delete[i : i + 100]
            await client.delete(
                collection_name=collection,
                points_selector=PointIdsList(points=batch),
            )
            deleted += len(batch)

            if deleted % 500 == 0:
                print(f"    Deleted {deleted:,} chunks...")

        if deleted >= max_delete:
            break

    print(f"    Deleted {deleted:,} individual corrupted chunks")
    return deleted


# ============================================
# Qdrant Connection
# ============================================


def connect_corpus() -> AsyncQdrantClient:
    """Create AsyncQdrantClient for corpus cluster."""
    if not settings.QDRANT_CORPUS_URL or not settings.QDRANT_CORPUS_API_KEY:
        print("ERROR: QDRANT_CORPUS_URL and QDRANT_CORPUS_API_KEY must be set")
        sys.exit(1)

    corpus_url = settings.QDRANT_CORPUS_URL
    use_https = corpus_url.startswith("https://")

    if corpus_url.startswith("https://"):
        host = corpus_url.replace("https://", "").rstrip("/")
        port = 443
    elif corpus_url.startswith("http://"):
        host = corpus_url.replace("http://", "").rstrip("/")
        port = 6333
        use_https = False
    else:
        host = corpus_url.rstrip("/")
        port = 443
        use_https = True

    if ":" in host:
        host_parts = host.rsplit(":", 1)
        host = host_parts[0]
        try:
            port = int(host_parts[1])
        except ValueError:
            pass

    return AsyncQdrantClient(
        host=host,
        port=port,
        api_key=settings.QDRANT_CORPUS_API_KEY,
        https=use_https,
        timeout=120,
    )


# ============================================
# Main
# ============================================


async def main():
    parser = argparse.ArgumentParser(
        description="Scan and clean encoding-corrupted corpus documents",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Scan only (safe — no changes)
  python scripts/cleanup_corrupted_corpus.py

  # Delete entire documents that are overwhelmingly corrupted
  python scripts/cleanup_corrupted_corpus.py --delete --max-delete 500

  # Delete only corrupted chunks (preserves good chunks)
  python scripts/cleanup_corrupted_corpus.py --delete-chunks --max-delete 2000

  # Stricter thresholds (fewer false positives, miss some real corruption)
  python scripts/cleanup_corrupted_corpus.py --score-threshold 0.7 --ratio-threshold 0.9
        """,
    )

    # Mode
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--delete",
        action="store_true",
        help="Delete entire DEFINITE-classified documents (all chunks for case_id)",
    )
    mode.add_argument(
        "--delete-chunks",
        action="store_true",
        help="Delete only corrupted chunks (preserve good chunks in same document)",
    )

    # Scope
    parser.add_argument(
        "--collection",
        type=str,
        default=None,
        help="Scan specific collection (default: all configured)",
    )
    parser.add_argument("--batch-size", type=int, default=200, help="Scroll batch size")
    parser.add_argument(
        "--max-scan",
        type=int,
        default=None,
        help="Max chunks to scan per collection (default: all)",
    )

    # Safety
    parser.add_argument(
        "--max-delete",
        type=int,
        default=500,
        help="Maximum case_ids (--delete) or chunks (--delete-chunks) to delete. Default: 500",
    )

    # Thresholds — these control the DEFINITE classification
    parser.add_argument(
        "--score-threshold",
        type=float,
        default=0.5,
        help="Min avg corruption_score for DEFINITE classification. Default: 0.5",
    )
    parser.add_argument(
        "--ratio-threshold",
        type=float,
        default=0.5,
        help="Min corrupted_chunks/total_chunks ratio for DEFINITE. Default: 0.5 (50%%)",
    )

    # Output
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="JSON report output path (default: scripts/corruption_report_<timestamp>.json)",
    )

    args = parser.parse_args()

    client = connect_corpus()

    collections = (
        [args.collection]
        if args.collection
        else list(settings.QDRANT_CORPUS_COLLECTIONS)
    )

    # The scan_threshold is intentionally lower than the classification threshold.
    # We want to CATCH everything during scan, then classify with stricter thresholds.
    scan_threshold = min(args.score_threshold * 0.6, 0.2)

    print("=" * 65)
    print("  CORPUS CORRUPTION SCANNER")
    print("=" * 65)
    print(f"  Mode:             {'DELETE DOCUMENTS' if args.delete else 'DELETE CHUNKS' if args.delete_chunks else 'SCAN ONLY (dry run)'}")
    print(f"  Collections:      {', '.join(collections)}")
    print(f"  Scan threshold:   {scan_threshold:.2f} (catches candidates)")
    print(f"  Score threshold:  {args.score_threshold:.2f} (DEFINITE avg_score)")
    print(f"  Ratio threshold:  {args.ratio_threshold:.0%} (DEFINITE corrupted ratio)")
    print(f"  Safety cap:       {args.max_delete}")

    # ── Phase 1: Scan ──
    all_reports: list[CaseReport] = []

    for collection in collections:
        counts, corrupted, titles = await scan_collection(
            client,
            collection,
            score_threshold=scan_threshold,
            batch_size=args.batch_size,
            max_scan=args.max_scan,
        )

        reports = classify_cases(
            collection=collection,
            case_chunk_counts=counts,
            corrupted_chunks=corrupted,
            case_titles=titles,
            ratio_threshold=args.ratio_threshold,
            score_threshold=args.score_threshold,
        )
        all_reports.extend(reports)

    # ── Phase 2: Report ──
    print(f"\n{'=' * 65}")
    print(f"  RESULTS")
    print(f"{'=' * 65}")

    if not all_reports:
        print("  No corrupted documents found!")
        await client.close()
        return

    print_report(all_reports)

    # ── Phase 3: Export ──
    if args.output:
        output_path = Path(args.output)
    else:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_path = Path(f"scripts/corruption_report_{ts}.json")

    export_report(all_reports, output_path)

    # ── Phase 4: Delete (if requested) ──
    if args.delete:
        deleted = await delete_documents(client, all_reports, args.max_delete)
        if deleted:
            print(f"\n  DONE: Deleted {deleted} case_ids")
    elif args.delete_chunks:
        deleted = await delete_chunks_only(client, all_reports, args.max_delete)
        if deleted:
            print(f"\n  DONE: Deleted {deleted} corrupted chunks")
    else:
        definite = len([r for r in all_reports if r.classification == "DEFINITE"])
        if definite:
            print(f"\n  Next steps:")
            print(f"    1. Review the JSON report: {output_path}")
            print(f"    2. Delete documents:  python scripts/cleanup_corrupted_corpus.py --delete")
            print(f"    3. Or delete chunks:  python scripts/cleanup_corrupted_corpus.py --delete-chunks")

    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
