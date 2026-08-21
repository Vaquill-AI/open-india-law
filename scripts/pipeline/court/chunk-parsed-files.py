#!/usr/bin/env python3
"""
Standalone High Court Chunking Script

Chunks pre-parsed JSON files from parsed/ directory with:
- Parquet metadata merging (official court data)
- Extracted metadata fallback (text-based extraction)
- Multi-year per bench support
- Checkpoint and resume capability
- Progress tracking with ETA

Usage:
    python chunk-parsed-files.py \
      --parsed-dir ~/highcourt-rag/data/highcourt-rag/parsed \
      --parquet-dir ~/highcourt-data/metadata/parquet \
      --output ~/highcourt-rag/data/highcourt-rag/chunks \
      --workers 200
"""

import argparse
import json
import logging
import sys
import time
import re
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Set
from datetime import datetime, timedelta
from concurrent.futures import ProcessPoolExecutor, as_completed
from collections import defaultdict
from dataclasses import dataclass, field, asdict

# Add qdrant directory for shared imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "qdrant"))
from legal_chunker import chunk_legal_document

try:
    import pandas as pd
except ImportError:
    print("Error: pandas required. Install with: pip install pandas pyarrow")
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@dataclass
class ChunkingProgress:
    """Track chunking progress"""
    started_at: str = ""
    last_updated: str = ""
    processed_cnrs: Set[str] = field(default_factory=set)
    failed_cnrs: Set[str] = field(default_factory=set)
    completed_benches: Set[str] = field(default_factory=set)  # Track completed benches
    total_processed: int = 0
    total_successful: int = 0
    total_failed: int = 0
    total_chunks: int = 0

    def save(self, path: Path):
        data = asdict(self)
        data['processed_cnrs'] = list(self.processed_cnrs)
        data['failed_cnrs'] = list(self.failed_cnrs)
        data['completed_benches'] = list(self.completed_benches)
        with open(path, 'w') as f:
            json.dump(data, f, indent=2)

    @classmethod
    def load(cls, path: Path):
        if not path.exists():
            return cls(started_at=datetime.now().isoformat())
        with open(path) as f:
            data = json.load(f)
        data['processed_cnrs'] = set(data.get('processed_cnrs', []))
        data['failed_cnrs'] = set(data.get('failed_cnrs', []))
        data['completed_benches'] = set(data.get('completed_benches', []))
        return cls(**data)


def load_parquet_for_bench_year(parquet_dir: Path, court_code: str, year: int, bench: str) -> Dict[str, Dict]:
    """Load parquet metadata for specific court/year/bench."""
    parquet_path = parquet_dir / f"year={year}" / f"court={court_code}" / f"bench={bench}" / "metadata.parquet"

    if not parquet_path.exists():
        logger.debug(f"No parquet: {parquet_path}")
        return {}

    try:
        df = pd.read_parquet(parquet_path)
        # Return dict keyed by CNR
        return {row['cnr']: row.to_dict() for _, row in df.iterrows()}
    except Exception as e:
        logger.warning(f"Error loading {parquet_path}: {e}")
        return {}


def build_metadata_from_parquet_and_extracted(
    cnr: str,
    parquet_row: Dict,
    extracted: Dict,
    bench: str
) -> Dict:
    """
    Build complete metadata dict merging parquet (official) + extracted (text-based).

    Priority: parquet > extracted for overlapping fields.
    """
    # Parse parties from parquet title if available
    title = parquet_row.get('title', '')
    petitioner_from_title, respondent_from_title = '', ''
    if title:
        vs_match = re.search(r'(.+?)\s+[Vv]s\.?\s+(.+)', title)
        if vs_match:
            petitioner_from_title = vs_match.group(1).strip()
            respondent_from_title = vs_match.group(2).strip()

    # Build complete metadata
    metadata = {
        # IDs
        'cnr': cnr,
        'case_id': cnr,
        'doc_id': cnr,

        # Case info - prefer parquet
        'title': parquet_row.get('title') or f"{extracted.get('case_type', '')} {extracted.get('case_number', '')}".strip(),
        'description': parquet_row.get('description', extracted.get('description', '')),
        'case_type': extracted.get('case_type', ''),
        'case_number': extracted.get('case_number', ''),
        'year': extracted.get('year', 0),

        # Court - prefer parquet
        'court': parquet_row.get('court') or extracted.get('court_name', 'High Court'),
        'court_name': parquet_row.get('court') or extracted.get('court_name', ''),
        'court_code': extracted.get('court_code', ''),
        'bench': extracted.get('bench', bench),
        'state_code': extracted.get('state_code', ''),
        'establishment_code': extracted.get('establishment_code', ''),
        'state_name': extracted.get('state_name', ''),

        # Dates - prefer parquet
        'decision_date': str(parquet_row.get('decision_date', '')) or extracted.get('decision_date', ''),
        'date_of_registration': parquet_row.get('date_of_registration', '') or extracted.get('date_of_registration', ''),

        # Judges - prefer parquet
        'judge': parquet_row.get('judge') or extracted.get('judge', ''),
        'judges': extracted.get('judges') if isinstance(extracted.get('judges'), list) else ([parquet_row.get('judge')] if parquet_row.get('judge') else []),
        'bench_type': extracted.get('bench_type', ''),

        # Parties - prefer extracted over title parsing
        'petitioner': extracted.get('petitioner') or petitioner_from_title,
        'respondent': extracted.get('respondent') or respondent_from_title,
        'petitioner_advocates': extracted.get('petitioner_advocates', []),
        'respondent_advocates': extracted.get('respondent_advocates', []),

        # Legal refs (only in extracted)
        'acts_cited': extracted.get('acts_cited', []),
        'articles_cited': extracted.get('articles_cited', []),
        'jurisdiction': extracted.get('jurisdiction', ''),
        'lower_court': extracted.get('lower_court', ''),
        'fir_number': extracted.get('fir_number', ''),
        'headnote': extracted.get('headnote', ''),

        # Disposition - prefer parquet
        'disposal_status': extracted.get('disposal_status', ''),
        'disposal_nature': parquet_row.get('disposal_nature') or extracted.get('disposal_nature', ''),
        'disposition': parquet_row.get('disposal_nature') or extracted.get('disposal_status', ''),

        # URLs
        'pdf_url': extracted.get('pdf_url', ''),
        'r2_key': extracted.get('r2_key', ''),

        # Quality
        'has_legacy_fonts': extracted.get('has_legacy_fonts', False),
        'ocr_used': extracted.get('ocr_used', False),
    }

    return metadata


def chunk_single_file(args: Tuple) -> Tuple[str, bool, int, Optional[str]]:
    """Worker function to chunk a single parsed file with edge case handling."""
    parsed_file, parquet_row, output_dir = args

    cnr = parsed_file.stem.replace('.parsed', '')

    try:
        # Edge case 1: Check file exists (might be deleted/moved)
        if not Path(parsed_file).exists():
            return (cnr, False, 0, "File not found")

        # Edge case 2: Check file is not empty
        if Path(parsed_file).stat().st_size == 0:
            return (cnr, False, 0, "Empty file")

        # Load parsed JSON with error handling
        try:
            with open(parsed_file) as f:
                extracted = json.load(f)
        except json.JSONDecodeError as e:
            return (cnr, False, 0, f"Invalid JSON: {e}")

        # Edge case 3: Check extracted has required fields
        if not extracted.get('text') and not extracted.get('text_clean'):
            return (cnr, False, 0, "No text content")

        # Get bench from parent directory name
        bench = parsed_file.parent.name

        # Build complete metadata
        metadata = build_metadata_from_parquet_and_extracted(cnr, parquet_row, extracted, bench)

        # Edge case 4: Validate metadata has minimum required fields
        if not metadata.get('cnr'):
            metadata['cnr'] = cnr  # Fallback to filename CNR

        # Chunk using shared chunking logic
        try:
            chunks = chunk_legal_document(
                extracted=extracted,
                metadata=metadata,
                court_type='high_court',
                pdf_url=metadata.get('pdf_url', '')
            )
        except Exception as chunk_error:
            return (cnr, False, 0, f"Chunking failed: {chunk_error}")

        if not chunks:
            return (cnr, False, 0, "No chunks generated")

        # Save chunks with optimization: exclude null/empty fields
        chunks_path = Path(output_dir) / f"{cnr}.chunks.jsonl"
        with open(chunks_path, 'w', encoding='utf-8') as f:
            for chunk in chunks:
                # Filter out null/empty values to save storage
                # Keep: non-null, non-empty strings, non-empty arrays, valid numbers, booleans
                chunk_clean = {}
                for k, v in chunk.items():
                    # Always exclude
                    if k in ('data_source', 'doc_id'):  # doc_id redundant with case_id for HC
                        continue

                    # Exclude null/empty values (but keep numeric 0 for char_start, chunk_index, page_start)
                    if v is None or v == '' or v == []:
                        continue

                    # Exclude invalid year (0 means unknown)
                    if k == 'year' and v == 0:
                        continue

                    # Keep all other values including:
                    # - 0 for char_start, chunk_index, page_start (valid positions)
                    # - False booleans (valid flags)
                    # - Empty bench_strength 0 (means single judge or unknown)
                    chunk_clean[k] = v

                f.write(json.dumps(chunk_clean, ensure_ascii=False) + '\n')

        return (cnr, True, len(chunks), None)

    except Exception as e:
        return (cnr, False, 0, str(e))


def main():
    parser = argparse.ArgumentParser(description='Chunk High Court parsed files')
    parser.add_argument('--parsed-dir', required=True, help='Directory with parsed/*.json files')
    parser.add_argument('--parquet-dir', required=True, help='Base directory with metadata/parquet/')
    parser.add_argument('--output', required=True, help='Output directory for chunks')
    parser.add_argument('--workers', type=int, default=64, help='Number of workers')
    parser.add_argument('--limit', type=int, help='Limit number of files to process (for testing)')
    parser.add_argument('--resume', action='store_true', help='Resume from checkpoint')
    parser.add_argument('--retry-failed', type=str, help='File with CNRs to retry (one per line)')
    args = parser.parse_args()

    parsed_dir = Path(args.parsed_dir)
    parquet_dir = Path(args.parquet_dir)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    checkpoint_path = output_dir / 'chunking_checkpoint.json'
    tasks_cache_path = output_dir / 'chunking_tasks.jsonl'

    # Load or create progress
    if args.resume and checkpoint_path.exists():
        progress = ChunkingProgress.load(checkpoint_path)
        logger.info(f"Resuming: {progress.total_processed:,} already processed")
    else:
        progress = ChunkingProgress(started_at=datetime.now().isoformat())

    logger.info("=" * 80)
    logger.info("HIGH COURT CHUNKING - Standalone")
    logger.info("=" * 80)
    logger.info(f"Parsed dir: {parsed_dir}")
    logger.info(f"Parquet dir: {parquet_dir}")
    logger.info(f"Output: {output_dir}")
    logger.info(f"Workers: {args.workers}")

    # RETRY MODE: Process specific CNRs from file
    if args.retry_failed:
        logger.info("\n⚠️  RETRY MODE: Re-chunking failed files")

        with open(args.retry_failed) as f:
            retry_cnrs = {line.strip() for line in f if line.strip()}

        logger.info(f"Loaded {len(retry_cnrs):,} failed CNRs to retry")

        # Clear these from failed_cnrs so they can be retried
        for cnr in retry_cnrs:
            progress.failed_cnrs.discard(cnr)

        logger.info("Cleared failed CNRs from checkpoint")
        logger.info("=" * 80)

    # BENCH-BY-BENCH PROCESSING (memory efficient, starts chunking immediately)
    logger.info("\nBench-by-bench processing mode")
    bench_dirs = [d for d in parsed_dir.iterdir() if d.is_dir()]
    logger.info(f"Found {len(bench_dirs)} bench directories")
    logger.info("=" * 80)

    total_successful = 0
    total_failed = 0
    start_time = time.time()

    for bench_idx, bench_dir in enumerate(bench_dirs, 1):
        bench_name = bench_dir.name

        # Skip if bench already completed
        if bench_name in progress.completed_benches:
            logger.info(f"[{bench_idx}/{len(bench_dirs)}] Skipping {bench_name} (already completed)")
            continue

        logger.info(f"\n[{bench_idx}/{len(bench_dirs)}] Processing bench: {bench_name}")

        parsed_files = list(bench_dir.rglob('*.parsed.json'))

        if not parsed_files:
            progress.completed_benches.add(bench_name)
            continue

        # Group by year
        files_by_year = defaultdict(list)
        for pf in parsed_files:
            # Quick read to get year/court
            try:
                with open(pf) as f:
                    data = json.load(f)
                y = data.get('year', 0)
                c = data.get('court_code', '')
                if y and c:
                    files_by_year[(y, c)].append(pf)
            except Exception as e:
                logger.debug(f"Skip {pf.name}: {e}")
                continue

        logger.info(f"  Found {len(parsed_files)} files from {len(files_by_year)} year/court combinations")

        # Create tasks for this bench only
        bench_tasks = []
        for (year, court_code), year_files in files_by_year.items():
            parquet_dict = load_parquet_for_bench_year(parquet_dir, court_code, year, bench_name)

            for pf in year_files:
                cnr = pf.stem.replace('.parsed', '')

                # Skip if already successfully chunked (check file existence, not processed_cnrs set)
                chunk_file = Path(output_dir) / f"{cnr}.chunks.jsonl"
                if chunk_file.exists():
                    continue

                # Skip if already failed and not retrying
                if cnr in progress.failed_cnrs:
                    continue

                parquet_row = parquet_dict.get(cnr, {})
                bench_tasks.append((pf, parquet_row, output_dir))

        if not bench_tasks:
            logger.info(f"  All files already processed")
            progress.completed_benches.add(bench_name)
            progress.save(checkpoint_path)
            continue

        logger.info(f"  Chunking {len(bench_tasks)} files...")

        # Process this bench with workers
        bench_successful = 0
        bench_failed = 0
        bench_start = time.time()

        with ProcessPoolExecutor(max_workers=args.workers) as executor:
            futures = {executor.submit(chunk_single_file, task): task for task in bench_tasks}

            for future in as_completed(futures):
                try:
                    cnr, success, chunk_count, error = future.result(timeout=30)  # 30 sec timeout per file
                except Exception as e:
                    # Handle worker crash/timeout
                    task = futures.get(future)
                    if task:
                        pf, _, _ = task
                        cnr = pf.stem.replace('.parsed', '')
                        logger.error(f"  {cnr}: Worker error: {str(e)[:100]}")
                        progress.failed_cnrs.add(cnr)
                        progress.total_failed += 1
                        bench_failed += 1
                        progress.total_processed += 1
                    continue

                if success:
                    progress.processed_cnrs.add(cnr)
                    progress.total_successful += 1
                    progress.total_chunks += chunk_count
                    bench_successful += 1
                else:
                    progress.failed_cnrs.add(cnr)
                    progress.total_failed += 1
                    bench_failed += 1
                    if error and bench_failed <= 5:
                        logger.error(f"  {cnr}: {error}")

                progress.total_processed += 1

                # Progress logging every 1000 files
                if progress.total_processed % 1000 == 0:
                    elapsed = time.time() - start_time
                    rate = progress.total_processed / elapsed if elapsed > 0 else 0
                    pct = (bench_idx / len(bench_dirs)) * 100

                    logger.info(
                        f"  Progress: {progress.total_processed:,} total | "
                        f"Bench: {bench_successful}/{len(bench_tasks)} | "
                        f"Speed: {rate:.1f}/s | "
                        f"Benches: {bench_idx}/{len(bench_dirs)} ({pct:.1f}%)"
                    )

        # Bench complete
        bench_elapsed = time.time() - bench_start
        bench_rate = len(bench_tasks) / bench_elapsed if bench_elapsed > 0 else 0
        progress.completed_benches.add(bench_name)

        logger.info(
            f"  ✅ Bench complete: {bench_successful} OK, {bench_failed} FAIL | "
            f"Time: {bench_elapsed:.1f}s | Rate: {bench_rate:.1f}/s"
        )

        # Checkpoint after each bench
        progress.last_updated = datetime.now().isoformat()
        progress.save(checkpoint_path)

        # Apply global limit
        if args.limit and progress.total_processed >= args.limit:
            logger.info(f"Reached limit of {args.limit} files")
            break

    # Final summary
    elapsed = time.time() - start_time
    logger.info("\n" + "=" * 80)
    logger.info("CHUNKING COMPLETE")
    logger.info("=" * 80)
    logger.info(f"Benches processed: {len(progress.completed_benches)}/{len(bench_dirs)}")
    logger.info(f"Total files: {progress.total_processed:,}")
    logger.info(f"Successful: {progress.total_successful:,}")
    logger.info(f"Failed: {progress.total_failed:,}")
    logger.info(f"Total chunks: {progress.total_chunks:,}")
    logger.info(f"Time: {timedelta(seconds=int(elapsed))}")
    logger.info(f"Rate: {progress.total_processed/elapsed:.1f} files/sec")
    logger.info(f"Output: {output_dir}")
    logger.info("=" * 80)

    # Save final checkpoint
    progress.save(checkpoint_path)


if __name__ == '__main__':
    main()
