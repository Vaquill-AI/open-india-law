#!/usr/bin/env python3
"""
Direct Retry for Failed Chunks - No Bench Scanning

Retries specific CNRs from a list without rescanning all benches.

Usage:
    python retry-failed-chunks.py \
      --failed-cnrs ~/highcourt-rag/failed-cnrs-retry.txt \
      --parsed-dir ~/highcourt-rag/data/highcourt-rag/parsed \
      --parquet-base ~/highcourt-data/metadata/parquet \
      --output ~/highcourt-rag/data/highcourt-rag/chunks \
      --workers 32
"""

import argparse
import json
import sys
import time
import re
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timedelta
import logging

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "qdrant"))
from legal_chunker import chunk_legal_document

try:
    import pandas as pd
except ImportError:
    pd = None

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(message)s')
logger = logging.getLogger(__name__)


def build_metadata_from_parquet_and_extracted(cnr: str, parquet_row: dict, extracted: dict, bench: str) -> dict:
    """Build complete metadata - COPIED from chunk-parsed-files.py"""
    title = parquet_row.get('title', '')
    petitioner_from_title, respondent_from_title = '', ''
    if title:
        vs_match = re.search(r'(.+?)\s+[Vv]s\.?\s+(.+)', title)
        if vs_match:
            petitioner_from_title = vs_match.group(1).strip()
            respondent_from_title = vs_match.group(2).strip()

    return {
        'cnr': cnr, 'case_id': cnr, 'doc_id': cnr,
        'title': parquet_row.get('title') or f"{extracted.get('case_type', '')} {extracted.get('case_number', '')}".strip(),
        'description': parquet_row.get('description', extracted.get('description', '')),
        'case_type': extracted.get('case_type', ''),
        'case_number': extracted.get('case_number', ''),
        'year': extracted.get('year', 0),
        'court': parquet_row.get('court') or extracted.get('court_name', 'High Court'),
        'court_name': parquet_row.get('court') or extracted.get('court_name', ''),
        'court_code': extracted.get('court_code', ''),
        'bench': extracted.get('bench', bench),
        'state_code': extracted.get('state_code', ''),
        'establishment_code': extracted.get('establishment_code', ''),
        'state_name': extracted.get('state_name', ''),
        'decision_date': str(parquet_row.get('decision_date', '')) or extracted.get('decision_date', ''),
        'date_of_registration': parquet_row.get('date_of_registration', '') or extracted.get('date_of_registration', ''),
        'judge': parquet_row.get('judge') or extracted.get('judge', ''),
        'judges': extracted.get('judges') if isinstance(extracted.get('judges'), list) else ([parquet_row.get('judge')] if parquet_row.get('judge') else []),
        'bench_type': extracted.get('bench_type', ''),
        'petitioner': extracted.get('petitioner') or petitioner_from_title,
        'respondent': extracted.get('respondent') or respondent_from_title,
        'petitioner_advocates': extracted.get('petitioner_advocates', []),
        'respondent_advocates': extracted.get('respondent_advocates', []),
        'acts_cited': extracted.get('acts_cited', []),
        'articles_cited': extracted.get('articles_cited', []),
        'jurisdiction': extracted.get('jurisdiction', ''),
        'lower_court': extracted.get('lower_court', ''),
        'fir_number': extracted.get('fir_number', ''),
        'headnote': extracted.get('headnote', ''),
        'disposal_status': extracted.get('disposal_status', ''),
        'disposal_nature': parquet_row.get('disposal_nature') or extracted.get('disposal_nature', ''),
        'disposition': parquet_row.get('disposal_nature') or extracted.get('disposal_status', ''),
        'pdf_url': extracted.get('pdf_url', ''),
        'r2_key': extracted.get('r2_key', ''),
        'has_legacy_fonts': extracted.get('has_legacy_fonts', False),
        'ocr_used': extracted.get('ocr_used', False),
    }


def chunk_file_direct(cnr, parsed_dir, parquet_base, output_dir):
    """Chunk a single file by CNR directly."""
    try:
        # Find parsed file
        parsed_file = None
        for bench_dir in parsed_dir.iterdir():
            if bench_dir.is_dir():
                candidate = bench_dir / f"{cnr}.parsed.json"
                if candidate.exists():
                    parsed_file = candidate
                    break

        if not parsed_file:
            return (cnr, False, 0, "Parsed file not found")

        # Load parsed
        with open(parsed_file) as f:
            extracted = json.load(f)

        if not extracted.get('text') and not extracted.get('text_clean'):
            return (cnr, False, 0, "No text")

        # Load parquet if available
        year = extracted.get('year', 0)
        court_code = extracted.get('court_code', '')
        bench = parsed_file.parent.name

        parquet_row = {}
        if pd and year and court_code:
            parquet_path = parquet_base / f"year={year}" / f"court={court_code}" / f"bench={bench}" / "metadata.parquet"
            if parquet_path.exists():
                try:
                    df = pd.read_parquet(parquet_path)
                    matches = df[df['cnr'] == cnr]
                    if len(matches) > 0:
                        parquet_row = matches.iloc[0].to_dict()
                        # Convert timestamps
                        for k, v in parquet_row.items():
                            if hasattr(v, 'isoformat'):
                                parquet_row[k] = v.isoformat()
                except:
                    pass

        # Build COMPLETE metadata using same function as main chunking
        metadata = build_metadata_from_parquet_and_extracted(cnr, parquet_row, extracted, bench)

        # Chunk with full metadata
        chunks = chunk_legal_document(extracted, metadata, 'high_court', metadata.get('pdf_url', ''))

        if not chunks:
            return (cnr, False, 0, "No chunks generated")

        # Save
        chunks_path = Path(output_dir) / f"{cnr}.chunks.jsonl"
        with open(chunks_path, 'w', encoding='utf-8') as f:
            for chunk in chunks:
                chunk_clean = {k: v for k, v in chunk.items()
                              if v not in (None, '', []) and k not in ('data_source', 'doc_id')}
                f.write(json.dumps(chunk_clean, ensure_ascii=False) + '\n')

        return (cnr, True, len(chunks), None)

    except Exception as e:
        return (cnr, False, 0, str(e))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--failed-cnrs', required=True)
    parser.add_argument('--parsed-dir', required=True)
    parser.add_argument('--parquet-base', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--workers', type=int, default=32)
    args = parser.parse_args()

    # Load failed CNRs
    with open(args.failed_cnrs) as f:
        failed_cnrs = [line.strip() for line in f if line.strip()]

    logger.info("=" * 80)
    logger.info("RETRY FAILED CHUNKS - Direct Processing")
    logger.info("=" * 80)
    logger.info(f"Failed CNRs to retry: {len(failed_cnrs):,}")
    logger.info(f"Workers: {args.workers}")
    logger.info("=" * 80)

    # Filter out ones that already have chunks
    to_retry = []
    for cnr in failed_cnrs:
        chunk_file = Path(args.output) / f"{cnr}.chunks.jsonl"
        if not chunk_file.exists():
            to_retry.append(cnr)

    logger.info(f"Files needing retry (no chunk file): {len(to_retry):,}")
    logger.info("Starting retry...")

    # Process with workers
    successful = 0
    failed = 0
    start_time = time.time()

    with ProcessPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(chunk_file_direct, cnr, Path(args.parsed_dir),
                                   Path(args.parquet_base), args.output): cnr
                  for cnr in to_retry}

        for future in as_completed(futures):
            try:
                cnr, success, chunk_count, error = future.result(timeout=60)

                if success:
                    successful += 1
                else:
                    failed += 1
                    if failed <= 10:
                        logger.error(f"{cnr}: {error}")

                if (successful + failed) % 1000 == 0:
                    elapsed = time.time() - start_time
                    rate = (successful + failed) / elapsed
                    remaining = len(to_retry) - (successful + failed)
                    eta = timedelta(seconds=int(remaining / rate)) if rate > 0 else '?'

                    logger.info(
                        f"Progress: {successful + failed:,}/{len(to_retry):,} | "
                        f"OK: {successful:,} | FAIL: {failed:,} | "
                        f"Speed: {rate:.1f}/s | ETA: {eta}"
                    )

            except Exception as e:
                failed += 1

    # Summary
    elapsed = time.time() - start_time
    logger.info("\n" + "=" * 80)
    logger.info("RETRY COMPLETE")
    logger.info("=" * 80)
    logger.info(f"Total retried: {len(to_retry):,}")
    logger.info(f"Recovered: {successful:,}")
    logger.info(f"Still failed: {failed:,}")
    logger.info(f"Time: {timedelta(seconds=int(elapsed))}")
    logger.info(f"Rate: {(successful + failed)/elapsed:.1f} files/sec")
    logger.info("=" * 80)


if __name__ == '__main__':
    main()
