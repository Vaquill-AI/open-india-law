#!/usr/bin/env python3
"""
Parallel Chunking Pipeline for Supreme Court Judgments

Processes all extracted JSON files in parallel and creates chunks for embedding.
Uses multiprocessing for maximum throughput on 48-core VM.

Usage:
    python3 run-chunking-parallel.py --workers 48 --extracted /root/data/rag-output/extracted --output /root/data/rag-output/chunks --metadata /root/data/aws-supreme-court-judgments/extracted/metadata/all_cases.jsonl
"""

import argparse
import json
import logging
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('/root/chunking.log')
    ]
)
logger = logging.getLogger(__name__)

# Global metadata dict (loaded once per worker)
_metadata_dict: Dict[str, Dict] = {}
_chunk_module = None


def init_worker(metadata_file: str):
    """Initialize worker with metadata and chunking module."""
    global _metadata_dict, _chunk_module

    # Load metadata
    logger.info(f"Worker {os.getpid()} loading metadata...")
    with open(metadata_file) as f:
        for line in f:
            case = json.loads(line)
            _metadata_dict[case["case_id"]] = case
    logger.info(f"Worker {os.getpid()} loaded {len(_metadata_dict)} cases")

    # Import chunking module
    sys.path.insert(0, "/root/scripts/rag")
    from importlib import util
    spec = util.spec_from_file_location("chunk_module", "/root/scripts/rag/chunk-judgment-pymupdf4llm.py")
    _chunk_module = util.module_from_spec(spec)
    spec.loader.exec_module(_chunk_module)


def process_file(args: tuple) -> Dict:
    """Process a single extracted JSON file and return chunks."""
    extracted_file, output_dir = args
    global _metadata_dict, _chunk_module

    try:
        # Extract case_id from filename (e.g., 1950_INSC_10_EN.extracted.json -> 1950_INSC_10)
        filename = Path(extracted_file).stem.replace(".extracted", "")
        parts = filename.rsplit("_", 1)
        case_id = parts[0]
        lang_code = parts[1] if len(parts) > 1 else "EN"

        # Get metadata
        metadata = _metadata_dict.get(case_id, {"case_id": case_id})

        # Load extracted JSON
        with open(extracted_file) as f:
            extracted = json.load(f)

        # Chunk it
        chunks = _chunk_module.chunk_with_char_positions(extracted, metadata)

        # Save chunks to output file
        output_file = Path(output_dir) / f"{filename}.chunks.jsonl"
        with open(output_file, "w") as f:
            for chunk in chunks:
                f.write(json.dumps(chunk) + "\n")

        return {
            "status": "success",
            "file": filename,
            "chunks": len(chunks),
            "output": str(output_file)
        }

    except Exception as e:
        return {
            "status": "error",
            "file": str(extracted_file),
            "error": str(e)
        }


def main():
    parser = argparse.ArgumentParser(description="Parallel chunking pipeline")
    parser.add_argument("--workers", type=int, default=48, help="Number of parallel workers")
    parser.add_argument("--extracted", type=str, default="/root/data/rag-output/extracted", help="Directory with extracted JSON files")
    parser.add_argument("--output", type=str, default="/root/data/rag-output/chunks", help="Output directory for chunks")
    parser.add_argument("--metadata", type=str, default="/root/data/aws-supreme-court-judgments/extracted/metadata/all_cases.jsonl", help="Metadata JSONL file")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of files to process (for testing)")
    args = parser.parse_args()

    # Setup paths
    extracted_dir = Path(args.extracted)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Get list of files to process
    extracted_files = sorted(extracted_dir.glob("*.extracted.json"))
    if args.limit:
        extracted_files = extracted_files[:args.limit]

    total_files = len(extracted_files)
    logger.info(f"Found {total_files} extracted files to chunk")
    logger.info(f"Using {args.workers} workers")
    logger.info(f"Output directory: {output_dir}")

    # Skip already processed files
    existing_chunks = set(f.stem.replace(".chunks", "") for f in output_dir.glob("*.chunks.jsonl"))
    files_to_process = [
        f for f in extracted_files
        if f.stem.replace(".extracted", "") not in existing_chunks
    ]

    skipped = total_files - len(files_to_process)
    if skipped > 0:
        logger.info(f"Skipping {skipped} already processed files")

    if not files_to_process:
        logger.info("All files already processed!")
        return

    logger.info(f"Processing {len(files_to_process)} files...")

    # Prepare work items
    work_items = [(str(f), str(output_dir)) for f in files_to_process]

    # Process in parallel
    start_time = time.time()
    completed = 0
    total_chunks = 0
    errors = []

    with ProcessPoolExecutor(
        max_workers=args.workers,
        initializer=init_worker,
        initargs=(args.metadata,)
    ) as executor:
        futures = {executor.submit(process_file, item): item for item in work_items}

        for future in as_completed(futures):
            result = future.result()
            completed += 1

            if result["status"] == "success":
                total_chunks += result["chunks"]
                if completed % 1000 == 0 or completed == len(files_to_process):
                    elapsed = time.time() - start_time
                    rate = completed / elapsed if elapsed > 0 else 0
                    eta = (len(files_to_process) - completed) / rate if rate > 0 else 0
                    logger.info(
                        f"Chunk: {completed:,}/{len(files_to_process):,} ({100*completed/len(files_to_process):.1f}%) | "
                        f"Total chunks: {total_chunks:,} | "
                        f"Rate: {rate:.1f}/s | "
                        f"ETA: {eta/60:.1f}m"
                    )
            else:
                errors.append(result)
                logger.error(f"Error processing {result['file']}: {result['error']}")

    # Summary
    elapsed = time.time() - start_time
    logger.info("=" * 60)
    logger.info(f"CHUNKING COMPLETE")
    logger.info(f"  Files processed: {completed:,}")
    logger.info(f"  Total chunks: {total_chunks:,}")
    logger.info(f"  Errors: {len(errors)}")
    logger.info(f"  Time: {elapsed/60:.1f} minutes")
    logger.info(f"  Rate: {completed/elapsed:.1f} files/sec")
    logger.info(f"  Avg chunks/file: {total_chunks/completed:.1f}" if completed > 0 else "N/A")

    # Save errors
    if errors:
        error_file = output_dir / "chunking_errors.json"
        with open(error_file, "w") as f:
            json.dump(errors, f, indent=2)
        logger.info(f"  Errors saved to: {error_file}")


if __name__ == "__main__":
    main()
