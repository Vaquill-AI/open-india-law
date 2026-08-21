#!/usr/bin/env python3
"""
High Court RAG Pipeline - Stream Processing from R2 to Qdrant

Processes High Court PDFs from Cloudflare R2 (aws-high-court-judgments bucket).
REUSES existing parsers and chunking logic from Supreme Court pipeline.

R2 Structure:
    data/pdf/year={YYYY}/court={court_code}/bench={bench_slug}/{CNR}_{version}_{date}.pdf
    metadata/parquet/year={YYYY}/court={court_code}/bench={bench_slug}/metadata.parquet

Public URL:
    ${R2_PUBLIC_BASE_URL}/aws-high-court-judgments/{r2_key}

Usage:
    # Test with 10 PDFs from Patna 2020 (streaming from R2)
    python run-pipeline-highcourt.py --court 10_8 --year 2020 --limit 10

    # Process a full court/year (streaming from R2)
    python run-pipeline-highcourt.py --court 10_8 --year 2020 --workers 8

    # Resume from checkpoint
    python run-pipeline-highcourt.py --resume

    # List available courts
    python run-pipeline-highcourt.py --list-courts

    # ⭐ LOCAL MODE (14x faster) - Process from local disk after R2 transfer:
    # First, sync R2 to local using rclone:
    #   rclone sync r2:aws-high-court-judgments /data/highcourt --progress
    # Then process locally:
    python run-pipeline-highcourt.py --local-path /data/highcourt --workers 50

    # ⭐ PARSE-ONLY MODE - Parse all PDFs first, chunk later:
    # Phase 1: Parse all PDFs (saves extracted JSON)
    python run-pipeline-highcourt.py --local-path /mnt/nvme/highcourt-data --parse-only --workers 90

    # Phase 2 (later): Chunk from parsed files
    python run-pipeline-highcourt.py --chunk-only --workers 90
"""

import json
import sys
import logging
import time
import traceback
import tempfile
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Set
from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from multiprocessing import cpu_count
import threading
import argparse
import re

# Optional memory monitoring
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

# Third-party imports
try:
    import boto3
    from botocore.config import Config as BotoConfig
except ImportError:
    print("Error: boto3 not installed. Run: pip install boto3")
    sys.exit(1)

try:
    import pandas as pd
except ImportError:
    print("Error: pandas not installed. Run: pip install pandas pyarrow")
    sys.exit(1)

# =============================================================================
# SELF-CONTAINED: Import parser from LOCAL highcourt folder
# =============================================================================
# NO parent directory dependencies - this folder is completely independent
# PyMuPDF Pro is unlocked inside pymupdf4llm_parser.py with HIGH COURT key
from pymupdf4llm_parser import extract_with_pymupdf4llm
import subprocess
from metadata_extractor_v3 import extract_all_metadata

# =============================================================================
# TWO-PASS OCR Configuration
# =============================================================================
# Pass 1: force_ocr=False, logs low-text PDFs to ocr_needed_log
# Pass 2: Re-process only files in ocr_needed_log with force_ocr=True
MIN_TEXT_THRESHOLD = 100  # Characters - below this, file needs OCR
OCR_CONFIG = {
    'force_ocr': False,
    'no_ocr': False,
    'ocr_needed_log': None,  # Path to log file for low-text PDFs
    'auto_ocr_pass2': False,  # Auto-chain Pass 2 after Pass 1
}

# Configure logging
log_dir = Path('data/highcourt-rag/logs')
log_dir.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_dir / 'pipeline_highcourt.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# =============================================================================
# R2 configuration. Set these in .env; the parser itself needs no cloud access.
# =============================================================================
R2_ENDPOINT = os.environ.get("R2_ENDPOINT", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = 'aws-high-court-judgments'
R2_PUBLIC_BASE_URL = os.environ.get("R2_PUBLIC_BASE_URL", "")

# =============================================================================
# Chunking Configuration
# =============================================================================
CHUNK_SIZE = 4096      # ~1024 tokens (4 chars/token average)
CHUNK_OVERLAP = 512    # ~128 tokens (12.5% overlap)
MIN_CHUNK_SIZE = 256   # Minimum chunk size to keep

# Box classes to skip (noise)
SKIP_BOX_CLASSES = {'page-header', 'page-footer'}

# Box classes to prefix (boost in embeddings)
# Hybrid format: [SEMANTIC_MARKER] + markdown header
# - [TITLE]/[SECTION] = explicit semantic signal for embedding model
# - # / ## = LLM-native markdown rendering when synthesizing answers
BOOST_BOX_CLASSES = {
    'title': '[TITLE] # ',
    'section-header': '[SECTION] ## ',
}


def build_text_from_boxes(boxes: list) -> str:
    """
    Build text from boxes, skipping noise and adding hybrid prefixes.

    Uses BOOST_BOX_CLASSES to add [TITLE] # / [SECTION] ## prefixes for:
    - Semantic signal to embedding model
    - LLM-native markdown rendering

    Args:
        boxes: List of box dictionaries from pymupdf4llm Pro extraction
               Each box has: box_class, text, page_number, bbox, spans

    Returns:
        Text with hybrid prefixes, without page headers/footers
    """
    text_parts = []

    for box in boxes:
        box_class = box.get('box_class', 'text')
        box_text = box.get('text', '').strip()

        if not box_text:
            continue

        # Skip noise boxes
        if box_class in SKIP_BOX_CLASSES:
            continue

        # Add prefix for important boxes (hybrid: [SEMANTIC] + markdown)
        prefix = BOOST_BOX_CLASSES.get(box_class, '')
        text_parts.append(prefix + box_text)

    return '\n\n'.join(text_parts)


# =============================================================================
# STATE CODE MAPPING: e-Court Identification Codes from NJDG
# =============================================================================
# Format: {state_code}_{establishment_code}
# state_code identifies the state, establishment_code identifies the court within state
# Source: National Judicial Data Grid (NJDG) - https://njdg.ecourts.gov.in/
STATE_CODE_MAPPING = {
    '1': 'Jammu & Kashmir',
    '2': 'Tripura',
    '3': 'Himachal Pradesh',
    '4': 'Uttarakhand',
    '5': 'Andhra Pradesh',
    '7': 'Delhi',
    '8': 'Rajasthan',
    '9': 'Uttar Pradesh',
    '10': 'Bihar',
    '11': 'Sikkim',
    '14': 'Manipur',
    '16': 'Telangana',
    '17': 'Meghalaya',
    '18': 'Assam',  # Gauhati HC covers Assam + NE states
    '19': 'West Bengal',
    '20': 'Jharkhand',
    '21': 'Odisha',
    '22': 'Chhattisgarh',
    '23': 'Madhya Pradesh',
    '24': 'Gujarat',
    '25': 'Rajasthan',
    '26': 'Punjab & Haryana',
    '27': 'Maharashtra',  # Bombay HC
    '28': 'Delhi',
    '29': 'Uttar Pradesh',  # Allahabad HC
    '30': 'Karnataka',
    '31': 'Kerala',
    '32': 'Tamil Nadu',  # Madras HC
    '33': 'Tamil Nadu',
    '36': 'Andhra Pradesh',
}


def parse_court_code(court_code: str) -> Dict[str, str]:
    """
    Parse e-Court Identification Code into state_code and establishment_code.

    Format: {state_code}_{establishment_code}
    Example: "27_1" → state_code="27", establishment_code="1"

    Returns:
        Dict with state_code, establishment_code, and state_name
    """
    if not court_code or '_' not in court_code:
        return {
            'state_code': '',
            'establishment_code': '',
            'state_name': ''
        }

    parts = court_code.split('_', 1)
    state_code = parts[0]
    establishment_code = parts[1] if len(parts) > 1 else ''
    state_name = STATE_CODE_MAPPING.get(state_code, f'State {state_code}')

    return {
        'state_code': state_code,
        'establishment_code': establishment_code,
        'state_name': state_name
    }


# =============================================================================
# BENCH MAPPING: Convert cryptic bench slugs to human-readable names
# =============================================================================
# Complete mapping of all 45 benches discovered in R2 bucket
# Some benches are already readable (e.g., "calcutta_appellate_side")
# Others are database IDs (e.g., "patnahcucisdb94") that need mapping
BENCH_MAPPING = {
    # =========================================================================
    # Court 1_12: Jammu & Kashmir and Ladakh High Court
    # =========================================================================
    'jammuhc': 'Jammu Wing',
    'kashmirhc': 'Srinagar Wing',

    # =========================================================================
    # Court 10_8: Patna High Court (Bihar)
    # =========================================================================
    'patnahcucisdb94': 'Principal Bench - Patna',

    # =========================================================================
    # Court 11_24: Sikkim High Court
    # =========================================================================
    'sikkimhc_pg': 'Principal Bench - Gangtok',

    # =========================================================================
    # Court 14_25: Manipur High Court
    # =========================================================================
    'manipurhc_pg': 'Principal Bench - Imphal',

    # =========================================================================
    # Court 16_20: Telangana High Court
    # =========================================================================
    'thcnc': 'Principal Bench - Hyderabad',

    # =========================================================================
    # Court 17_21: Meghalaya High Court
    # =========================================================================
    'meghalaya': 'Principal Bench - Shillong',

    # =========================================================================
    # Court 18_6: Gauhati High Court (Assam + NE States)
    # =========================================================================
    'arghccis': 'Itanagar Bench (Arunachal Pradesh)',
    'asghccis': 'Principal Bench - Guwahati (Assam)',
    'azghccis': 'Aizawl Bench (Mizoram)',
    'nlghccis': 'Kohima Bench (Nagaland)',

    # =========================================================================
    # Court 19_16: Calcutta High Court (West Bengal)
    # =========================================================================
    'calcutta_appellate_side': 'Appellate Side',
    'calcutta_circuit_bench_at_jalpaiguri': 'Circuit Bench - Jalpaiguri',
    'calcutta_circuit_bench_at_port_blair': 'Circuit Bench - Port Blair (Andaman)',
    'calcutta_original_side': 'Original Side',

    # =========================================================================
    # Court 20_7: Jharkhand High Court
    # =========================================================================
    'jhar_pg': 'Principal Bench - Ranchi',

    # =========================================================================
    # Court 21_11: Orissa High Court (Odisha)
    # =========================================================================
    'cisnc': 'Principal Bench - Cuttack',

    # =========================================================================
    # Court 22_18: Chhattisgarh High Court
    # =========================================================================
    'cghccisdb': 'Principal Bench - Bilaspur',

    # =========================================================================
    # Court 23_23: Madhya Pradesh High Court
    # =========================================================================
    'mphc_db_gwl': 'Gwalior Bench',
    'mphc_db_ind': 'Indore Bench',
    'mphc_db_jbp': 'Principal Bench - Jabalpur',

    # =========================================================================
    # Court 24_17: Gujarat High Court
    # =========================================================================
    'gujarathc': 'Principal Bench - Ahmedabad',

    # =========================================================================
    # Court 25_9: Rajasthan High Court
    # =========================================================================
    'rjjod': 'Principal Bench - Jodhpur',
    'rjjpr': 'Jaipur Bench',

    # =========================================================================
    # Court 26_3: Punjab & Haryana High Court
    # =========================================================================
    'phhc': 'Principal Bench - Chandigarh',

    # =========================================================================
    # Court 27_1: Bombay High Court (Maharashtra + Goa)
    # =========================================================================
    'hcaurdb': 'Aurangabad Bench',
    'hcbgoa': 'Panaji Bench (Goa)',
    'kolhcdb': 'Nagpur Bench',
    'newas': 'Appellate Side - Mumbai',
    'newos': 'Original Side - Mumbai',
    'newos_spl': 'Original Side Special - Mumbai',

    # =========================================================================
    # Court 28_2: Delhi High Court
    # =========================================================================
    'delhihc': 'Principal Bench - New Delhi',

    # =========================================================================
    # Court 29_5: Allahabad High Court (Uttar Pradesh)
    # =========================================================================
    'allhclko': 'Lucknow Bench',
    'allhcpb': 'Principal Bench - Allahabad',

    # =========================================================================
    # Court 2_15: Tripura High Court
    # =========================================================================
    'tripurahc_pg': 'Principal Bench - Agartala',

    # =========================================================================
    # Court 30_4: Karnataka High Court
    # =========================================================================
    'karhcbengaluru': 'Principal Bench - Bengaluru',
    'karhcdharwad': 'Dharwad Bench',
    'karhckalaburagi': 'Kalaburagi Bench',

    # =========================================================================
    # Court 31_10: Kerala High Court
    # =========================================================================
    'keralahc': 'Principal Bench - Kochi',

    # =========================================================================
    # Court 32_14: Madras High Court (Tamil Nadu)
    # =========================================================================
    'mhcchennai': 'Principal Bench - Chennai',
    'mhcmadurai': 'Madurai Bench',

    # =========================================================================
    # Court 3_19: Himachal Pradesh High Court
    # =========================================================================
    'hphc': 'Principal Bench - Shimla',

    # =========================================================================
    # Court 4_22: Uttarakhand High Court
    # =========================================================================
    'ukhc_pg': 'Principal Bench - Nainital',

    # =========================================================================
    # Court 5_13: Andhra Pradesh High Court
    # =========================================================================
    'aphc_pb': 'Principal Bench - Amaravati',

    # =========================================================================
    # Additional benches discovered in dry-run (2024 data)
    # =========================================================================
    # Court 2_5: Appears to be Allahabad HC alternate system
    'cmis': 'Principal Bench - Allahabad (CIS)',

    # Court 5_15: Uttarakhand HC alternate
    'ukhcucis_pg': 'Principal Bench - Nainital',

    # Court 7_26: Delhi HC alternate
    'dhcdb': 'Principal Bench - New Delhi',

    # Court 8_9: Rajasthan HC
    'jaipur': 'Jaipur Bench',
    'rhcjodh240618': 'Principal Bench - Jodhpur',

    # Court 9_13: Allahabad HC alternate benches
    'cisdb_16012018': 'Principal Bench - Allahabad',
    'cishclko': 'Lucknow Bench',

    # Court 27_1: Bombay HC - test data (skip in production)
    'testcase': 'Test Bench (skip)',

    # Court 28_2: Andhra Pradesh HC alternate
    'aphc': 'Principal Bench - Amaravati',

    # Court 29_3: Karnataka HC legacy
    'karnataka_bng_old': 'Principal Bench - Bengaluru (Legacy)',

    # Court 32_4: Kerala HC
    'highcourtofkerala': 'Principal Bench - Kochi',

    # Court 33_10: Madras HC
    'hc_cis_mas': 'Principal Bench - Chennai',
    'mdubench': 'Madurai Bench',

    # Court 36_29: Andhra Pradesh / Telangana
    'taphc': 'Principal Bench - Amaravati',

    # =========================================================================
    # Legacy/Alternative IDs (from ucisdb format - keep for backwards compatibility)
    # =========================================================================
    'delhihcucisdb1': 'Principal Bench - New Delhi',
    'bombayhcucisdb1': 'Principal Bench - Mumbai',
    'bombayhcucisdb2': 'Aurangabad Bench',
    'bombayhcucisdb3': 'Nagpur Bench',
    'bombayhcucisdb4': 'Panaji Bench (Goa)',
    'chennaihcucisdb1': 'Principal Bench - Chennai',
    'chennaihcucisdb2': 'Madurai Bench',
    'karnatakahcucisdb1': 'Principal Bench - Bengaluru',
    'karnatakahcucisdb2': 'Dharwad Bench',
    'karnatakahcucisdb3': 'Kalaburagi Bench',
    'allahabadhcucisdb1': 'Principal Bench - Allahabad',
    'allahabadhcucisdb2': 'Lucknow Bench',
    'gujarathcucisdb1': 'Principal Bench - Ahmedabad',
    'keralahcucisdb1': 'Principal Bench - Kochi',
    'punjabhcucisdb1': 'Principal Bench - Chandigarh',
    'rajasthanhcucisdb1': 'Principal Bench - Jodhpur',
    'rajasthanhcucisdb2': 'Jaipur Bench',
    'andhrahcucisdb1': 'Principal Bench - Amaravati',
    'telanganahcucisdb1': 'Principal Bench - Hyderabad',
    'jaboraborihcucisdb1': 'Principal Bench - Ranchi',
    'caborasgarhcucisdb1': 'Principal Bench - Bilaspur',
    'uttarakhandhcucisdb1': 'Principal Bench - Nainital',
    'himachalhcucisdb1': 'Principal Bench - Shimla',
    'jaborakhcucisdb1': 'Srinagar Wing',
    'jaborakhcucisdb2': 'Jammu Wing',
    'sikkimhcucisdb1': 'Principal Bench - Gangtok',
    'tripurahcucisdb1': 'Principal Bench - Agartala',
    'meghalayahcucisdb1': 'Principal Bench - Shillong',
    'manipurhcucisdb1': 'Principal Bench - Imphal',
    'gauhatihcucisdb1': 'Principal Bench - Guwahati',
    'gauhatihcucisdb2': 'Kohima Bench (Nagaland)',
    'gauhatihcucisdb3': 'Aizawl Bench (Mizoram)',
    'gauhatihcucisdb4': 'Itanagar Bench (Arunachal)',
    'orissahcucisdb1': 'Principal Bench - Cuttack',
}


def get_bench_display_name(bench_slug: str, court_name: str = '') -> str:
    """
    Convert bench slug to human-readable display name.

    Strategy:
    1. If in BENCH_MAPPING, use the mapped name
    2. If already readable (contains underscores like 'appellate_side'), format it
    3. Otherwise return the slug with court context
    """
    # Check mapping first
    if bench_slug in BENCH_MAPPING:
        return BENCH_MAPPING[bench_slug]

    # If it looks like a readable slug (has underscores, no 'ucisdb')
    if '_' in bench_slug and 'ucisdb' not in bench_slug.lower():
        # Convert "calcutta_appellate_side" -> "Appellate Side"
        # Remove court prefix if present
        parts = bench_slug.split('_')
        # Skip first part if it's a court name
        court_prefixes = ['calcutta', 'bombay', 'delhi', 'madras', 'chennai',
                         'karnataka', 'allahabad', 'gujarat', 'kerala', 'punjab']
        if parts[0].lower() in court_prefixes:
            parts = parts[1:]
        return ' '.join(p.capitalize() for p in parts)

    # Fallback: return slug with note that it's an internal ID
    return f"Bench ({bench_slug})"


# =============================================================================
# REUSE: ProcessingStats from run-pipeline-pymupdf4llm.py (identical)
# =============================================================================
@dataclass
class ProcessingStats:
    """Detailed processing statistics"""
    total_files: int = 0
    successful: int = 0
    failed: int = 0
    skipped: int = 0
    retried: int = 0
    total_size_bytes: int = 0
    total_pages: int = 0
    total_chunks: int = 0
    total_words: int = 0
    processing_time_sec: float = 0.0
    errors: Dict[str, List[str]] = field(default_factory=lambda: defaultdict(list))

    def add_error(self, error_type: str, doc_id: str, message: str):
        self.errors[error_type].append(f"{doc_id}: {message}")

    def get_summary(self) -> str:
        lines = [
            f"Total files: {self.total_files}",
            f"Successful: {self.successful} ({self.successful/max(self.total_files,1)*100:.1f}%)",
            f"Failed: {self.failed}",
            f"Skipped: {self.skipped}",
            f"Total pages: {self.total_pages:,}",
            f"Total chunks: {self.total_chunks:,}",
            f"Processing time: {timedelta(seconds=int(self.processing_time_sec))}",
        ]
        if self.errors:
            lines.append("\nErrors by type:")
            for error_type, errors in self.errors.items():
                lines.append(f"  {error_type}: {len(errors)} cases")
        return "\n".join(lines)


@dataclass
class HighCourtProgress:
    """Progress tracking adapted for High Court R2 streaming"""
    started_at: str
    last_updated: str
    current_court: str = ""
    current_year: int = 0

    # Global stats (for ETA across all PDFs)
    global_total_pdfs: int = 0  # Total PDFs in R2 bucket
    global_processed: int = 0   # PDFs processed this session
    global_start_time: float = 0.0  # time.time() when pipeline started

    # Stats
    stats: ProcessingStats = field(default_factory=ProcessingStats)

    # Tracking
    processed_cnrs: Set[str] = field(default_factory=set)
    failed_cnrs: Set[str] = field(default_factory=set)
    completed_court_years: Set[str] = field(default_factory=set)  # "court_code:year"

    def save(self, checkpoint_path: Path):
        data = asdict(self)
        data['processed_cnrs'] = []  # OPTIMIZATION: Don't save - use global_processed
        data['failed_cnrs'] = list(self.failed_cnrs) if len(self.failed_cnrs) < 10000 else []
        data['completed_court_years'] = list(self.completed_court_years)

        temp_path = checkpoint_path.with_suffix('.json.tmp')
        with open(temp_path, 'w') as f:
            json.dump(data, f, separators=(',', ':'))
        temp_path.rename(checkpoint_path)

    @classmethod
    def load(cls, checkpoint_path: Path) -> 'HighCourtProgress':
        if not checkpoint_path.exists():
            return cls(
                started_at=datetime.now().isoformat(),
                last_updated=datetime.now().isoformat()
            )
        with open(checkpoint_path, 'r') as f:
            data = json.load(f)
        data['processed_cnrs'] = set(data.get('processed_cnrs', []))
        data['failed_cnrs'] = set(data.get('failed_cnrs', []))
        data['completed_court_years'] = set(data.get('completed_court_years', []))
        if 'stats' in data:
            data['stats'] = ProcessingStats(**data['stats'])
        return cls(**data)


# =============================================================================
# R2 Client with Connection Pooling (optimized for 50-100+ workers)
# =============================================================================
# Shared boto3 config for connection pooling - critical for high concurrency
# Without this, each worker creates new connections causing socket exhaustion
S3_CONFIG = BotoConfig(
    max_pool_connections=150,  # Allow up to 150 concurrent connections
    connect_timeout=10,
    read_timeout=60,
    retries={
        'max_attempts': 3,
        'mode': 'adaptive'  # Adaptive retry with exponential backoff
    }
)


def create_s3_client():
    """
    Create S3 client for R2 access with connection pooling.

    For high concurrency (50-100+ workers):
    - Uses shared connection pool (max_pool_connections=150)
    - Adaptive retries prevent thundering herd on transient failures
    - 60s read timeout for large PDFs (some are 50MB+)
    """
    return boto3.client(
        's3',
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto',
        config=S3_CONFIG  # ⭐ Use pooled connections
    )


def get_memory_usage_mb() -> float:
    """Get current process memory usage in MB"""
    if HAS_PSUTIL:
        process = psutil.Process(os.getpid())
        return process.memory_info().rss / 1024 / 1024
    return 0.0


def log_memory_usage(logger, prefix: str = ""):
    """Log current memory usage if psutil is available"""
    if HAS_PSUTIL:
        mem_mb = get_memory_usage_mb()
        logger.info(f"{prefix}Memory usage: {mem_mb:.1f} MB")


# =============================================================================
# Parallel Worker Function (standalone for thread safety)
# =============================================================================
def process_pdf_worker(
    pdf_info: Dict,
    metadata: Dict,
    extracted_dir: Path,
    chunks_dir: Path,
    errors_dir: Path
) -> Tuple[str, bool, int, int, Optional[str]]:
    """
    Worker function for parallel PDF processing.

    Creates its own S3 client (boto3 clients are not thread-safe).

    Returns:
        Tuple of (cnr, success, page_count, chunk_count, error_message)
    """
    cnr = pdf_info['cnr']

    # Create thread-local S3 client
    s3 = create_s3_client()

    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
        try:
            # Download PDF
            s3.download_file(R2_BUCKET_NAME, pdf_info['r2_key'], tmp.name)

            # Extract text (REUSES existing parser)
            extracted = extract_with_pymupdf4llm(tmp.name)

            if "error" in extracted:
                raise Exception(extracted['error'])

            # Add metadata to extracted
            extracted['cnr'] = cnr
            extracted['court_code'] = pdf_info['court_code']
            extracted['year'] = pdf_info['year']
            extracted['bench'] = pdf_info['bench']

            # Save extracted JSON
            extracted_path = extracted_dir / f"{cnr}.extracted.json"
            with open(extracted_path, 'w', encoding='utf-8') as f:
                json.dump(extracted, f, ensure_ascii=False, separators=(',', ':'))

            # Chunk (REUSES adapted chunking logic)
            chunks = chunk_highcourt_judgment(extracted, metadata)

            if not chunks:
                raise Exception("No chunks generated")

            # Save chunks
            chunks_path = chunks_dir / f"{cnr}.chunks.jsonl"
            with open(chunks_path, 'w', encoding='utf-8') as f:
                for chunk in chunks:
                    f.write(json.dumps(chunk, ensure_ascii=False) + '\n')

            return cnr, True, extracted.get('page_count', 0), len(chunks), None

        except Exception as e:
            error_msg = str(e)
            # Save error
            error_path = errors_dir / f"{cnr}.error.txt"
            with open(error_path, 'w') as f:
                f.write(f"CNR: {cnr}\n")
                f.write(f"R2 Key: {pdf_info['r2_key']}\n")
                f.write(f"Error: {error_msg}\n")
                f.write(f"\nTraceback:\n{traceback.format_exc()}")
            return cnr, False, 0, 0, error_msg

        finally:
            # Cleanup temp file
            if os.path.exists(tmp.name):
                os.unlink(tmp.name)


def list_courts_and_years_local(local_path: Path) -> Dict[str, List[int]]:
    """
    List all courts and years from LOCAL disk - COURT=* STRUCTURE.
    Scans court=XX/bench=YY/ directories and extracts years from PDF filenames.
    """
    courts_years = defaultdict(set)
    pdf_base = local_path / "data" / "pdf"

    if not pdf_base.exists():
        logger.error(f"Local path not found: {pdf_base}")
        return {}

    # Iterate court=* directories (not year=*)
    for court_dir in pdf_base.iterdir():
        if not court_dir.is_dir():
            continue
        court_match = re.search(r'court=([^/]+)', court_dir.name)
        if not court_match:
            continue
        court_code = court_match.group(1)

        # Get years from PDF filenames
        for bench_dir in court_dir.iterdir():
            if not bench_dir.is_dir():
                continue
            for pdf_file in list(bench_dir.glob("*.pdf"))[:100]:
                date_match = re.search(r'_(\d{4})-\d{2}-\d{2}\.pdf$', pdf_file.name)
                if date_match:
                    courts_years[court_code].add(int(date_match.group(1)))

    return {k: sorted(list(v)) for k, v in courts_years.items()}


def list_benches_local(local_path: Path, court_code: str, year: int) -> List[str]:
    """List benches for a court - COURT=* STRUCTURE."""
    bench_base = local_path / "data" / "pdf" / f"court={court_code}"

    if not bench_base.exists():
        return []

    benches = []
    for bench_dir in bench_base.iterdir():
        if not bench_dir.is_dir():
            continue
        match = re.search(r'bench=([^/]+)', bench_dir.name)
        if match:
            benches.append(match.group(1))
    return benches


def list_pdfs_in_bench_local(local_path: Path, court_code: str, year: int, bench: str) -> List[Dict]:
    """List all PDFs in a bench - COURT=* STRUCTURE."""
    pdf_dir = local_path / "data" / "pdf" / f"court={court_code}" / f"bench={bench}"

    if not pdf_dir.exists():
        return []

    pdfs = []
    for pdf_file in pdf_dir.glob("*.pdf"):
        filename = pdf_file.name
        # Filter by year from filename (COURT=* STRUCTURE)
        date_match = re.search(r'_(\d{4})-\d{2}-\d{2}\.pdf$', filename)
        if not date_match or int(date_match.group(1)) != year:
            continue
        # CNR is the first part: {CNR}_{version}_{date}.pdf
        cnr = filename.split('_')[0]

        # Build r2_key for metadata lookup and pdf_url
        r2_key = f"data/pdf/year={year}/court={court_code}/bench={bench}/{filename}"

        pdfs.append({
            'local_path': str(pdf_file),  # LOCAL path for processing
            'r2_key': r2_key,             # For metadata lookup and URL
            'cnr': cnr,
            'filename': filename,
            'size': pdf_file.stat().st_size,
            'court_code': court_code,
            'year': year,
            'bench': bench,
            'pdf_url': f"{R2_PUBLIC_BASE_URL}/{r2_key}"  # Public URL
        })
    return pdfs


def load_parquet_metadata_local(local_path: Path, court_code: str, year: int, bench: str) -> Dict[str, Dict]:
    """Load metadata parquet from LOCAL disk and return as dict keyed by CNR."""
    parquet_path = local_path / "metadata" / "parquet" / f"year={year}" / f"court={court_code}" / f"bench={bench}" / "metadata.parquet"

    if not parquet_path.exists():
        logger.warning(f"Parquet not found: {parquet_path}")
        return {}

    try:
        df = pd.read_parquet(parquet_path)
        metadata_dict = {}
        for _, row in df.iterrows():
            cnr = row.get('cnr', '')
            if cnr:
                metadata_dict[cnr] = row.to_dict()
        return metadata_dict
    except Exception as e:
        logger.warning(f"Could not load parquet {parquet_path}: {e}")
        return {}


def count_all_pdfs_local(local_path: Path, courts_years: Dict[str, List[int]]) -> Tuple[int, Dict[str, int]]:
    """
    Count total PDFs - COURT=* STRUCTURE.

    Returns:
        Tuple of (total_count, breakdown_by_court)
    """
    total = 0
    by_court = {}

    logger.info("Counting total PDFs in court=* structure...")

    for court_code, years in courts_years.items():
        court_total = 0
        years_set = set(years)
        pdf_dir = local_path / "data" / "pdf" / f"court={court_code}"
        if pdf_dir.exists():
            for bench_dir in pdf_dir.iterdir():
                if bench_dir.is_dir():
                    for pdf_file in bench_dir.glob("*.pdf"):
                        date_match = re.search(r'_(\d{4})-\d{2}-\d{2}\.pdf$', pdf_file.name)
                        if date_match and int(date_match.group(1)) in years_set:
                            court_total += 1
        by_court[court_code] = court_total
        total += court_total

    return total, by_court


def process_pdf_worker_local(
    pdf_info: Dict,
    metadata: Dict,
    extracted_dir: Path,
    chunks_dir: Path,
    errors_dir: Path
) -> Tuple[str, bool, int, int, Optional[str]]:
    """
    Worker function for LOCAL PDF processing (no R2 download needed).

    ~40x faster than R2 streaming mode because:
    - No network latency (NVMe reads at ~3GB/s)
    - No download time (~2-5 seconds saved per PDF)
    - No connection pool contention

    Returns:
        Tuple of (cnr, success, page_count, chunk_count, error_message)
    """
    cnr = pdf_info['cnr']
    local_pdf_path = pdf_info['local_path']

    try:
        # Extract text directly from local file (REUSES existing parser)
        extracted = extract_with_pymupdf4llm(local_pdf_path)

        if "error" in extracted:
            raise Exception(extracted['error'])

        # Add metadata to extracted
        extracted['cnr'] = cnr
        extracted['court_code'] = pdf_info['court_code']
        extracted['year'] = pdf_info['year']
        extracted['bench'] = pdf_info['bench']

        # Save extracted JSON
        extracted_path = extracted_dir / f"{cnr}.extracted.json"
        with open(extracted_path, 'w', encoding='utf-8') as f:
            json.dump(extracted, f, ensure_ascii=False, separators=(',', ':'))

        # Chunk (REUSES adapted chunking logic)
        chunks = chunk_highcourt_judgment(extracted, metadata)

        if not chunks:
            raise Exception("No chunks generated")

        # Save chunks
        chunks_path = chunks_dir / f"{cnr}.chunks.jsonl"
        with open(chunks_path, 'w', encoding='utf-8') as f:
            for chunk in chunks:
                f.write(json.dumps(chunk, ensure_ascii=False) + '\n')

        return cnr, True, extracted.get('page_count', 0), len(chunks), None

    except Exception as e:
        error_msg = str(e)
        # Save error
        error_path = errors_dir / f"{cnr}.error.txt"
        with open(error_path, 'w') as f:
            f.write(f"CNR: {cnr}\n")
            f.write(f"Local Path: {local_pdf_path}\n")
            f.write(f"Error: {error_msg}\n")
            f.write(f"\nTraceback:\n{traceback.format_exc()}")
        return cnr, False, 0, 0, error_msg


# ⚡ OPTIMIZATION: Use orjson if available (5-10x faster than standard json)
try:
    import orjson
    def fast_json_dump(obj, f):
        f.write(orjson.dumps(obj, option=orjson.OPT_INDENT_2).decode('utf-8'))
    def fast_json_dump_compact(obj, f):
        f.write(orjson.dumps(obj).decode('utf-8'))
    USING_ORJSON = True
except ImportError:
    def fast_json_dump(obj, f):
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    def fast_json_dump_compact(obj, f):
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))  # Compact, no spaces
    USING_ORJSON = False

# ⚡ OPTIMIZATION: Cache for created directories (avoid repeated mkdir syscalls)
_created_dirs = set()

def parse_pdf_worker_local(
    pdf_info: Dict,
    parsed_dir: Path,
    errors_dir: Path,
    ocr_needed_log: Optional[str] = None,
    force_ocr: bool = False
) -> Tuple[str, bool, int, Optional[str], bool]:
    """
    Worker function for PARSE-ONLY mode (Phase 1).

    Only extracts PDF content (no chunking). Saves:
    - Full extracted JSON with text, boxes, pages, metadata
    - All data needed for Phase 2 chunking later

    ⚡ OPTIMIZED:
    - No JSON indent (10-15% faster writes)
    - Directory creation caching (avoids syscall per file)
    - orjson if available (5-10x faster serialization)

    TWO-PASS OCR:
    - Pass 1: Check text length, log files < MIN_TEXT_THRESHOLD to ocr_needed_log
    - Pass 2: force_ocr=True reprocesses with OCR enabled

    Returns:
        Tuple of (cnr, success, page_count, error_message, needs_ocr)
    """
    cnr = pdf_info['cnr']
    local_pdf_path = pdf_info['local_path']
    needs_ocr = False

    try:
        # Extract text directly from local file
        extracted = extract_with_pymupdf4llm(local_pdf_path, force_ocr=force_ocr)

        if "error" in extracted:
            raise Exception(extracted['error'])

        # Check if text is too short (needs OCR)
        text = extracted.get('text', '') or ''
        text_len = len(text.strip())

        if text_len < MIN_TEXT_THRESHOLD and not force_ocr:
            needs_ocr = True
            # Log to OCR needed file
            if ocr_needed_log:
                with open(ocr_needed_log, 'a') as f:
                    f.write(f"{local_pdf_path}\n")
            # Still save partial result for reference
            extracted['needs_ocr'] = True
            extracted['text_len'] = text_len

        # Add PDF info metadata (needed for chunking later)
        extracted['cnr'] = cnr
        extracted['court_code'] = pdf_info['court_code']
        extracted['year'] = pdf_info['year']
        extracted['bench'] = pdf_info['bench']
        extracted['pdf_url'] = pdf_info.get('pdf_url', '')
        extracted['r2_key'] = pdf_info.get('r2_key', '')
        extracted['local_path'] = local_pdf_path  # Keep for reference
        extracted['filename'] = pdf_info.get('filename', '')

        # Extract structured metadata from text (ALL legal fields for RAG)
        try:
            text = extracted.get("text", "")
            boxes = extracted.get("boxes", [])
            case_metadata = extract_all_metadata(text, boxes)
            # Judge info
            extracted["judge"] = case_metadata.get("judge")
            extracted["judges"] = case_metadata.get("judges", [])
            extracted["bench_type"] = case_metadata.get("bench_type")
            # Case identifiers
            extracted["case_type"] = case_metadata.get("case_type")
            extracted["case_number"] = case_metadata.get("case_number")
            extracted["jurisdiction"] = case_metadata.get("jurisdiction")
            # Dates
            extracted["decision_date"] = case_metadata.get("decision_date")
            # Parties
            extracted["petitioner"] = case_metadata.get("petitioner")
            extracted["respondent"] = case_metadata.get("respondent")
            # Outcome
            extracted["disposal_status"] = case_metadata.get("disposal_status")
            # Legal citations
            extracted["acts_cited"] = case_metadata.get("acts_cited", [])
            extracted["articles_cited"] = case_metadata.get("articles_cited", [])
            # Advocates
            extracted["petitioner_advocates"] = case_metadata.get("petitioner_advocates", [])
            extracted["respondent_advocates"] = case_metadata.get("respondent_advocates", [])
            # Lower court
            extracted["lower_court"] = case_metadata.get("lower_court")
            # Criminal specific
            extracted["fir_number"] = case_metadata.get("fir_number")
            # Court name
            extracted["court_name"] = case_metadata.get("court_name")
            # Headnote (if present)
            extracted["headnote"] = case_metadata.get("headnote")
        except Exception as meta_err:
            # Non-fatal: continue without extracted metadata
            pass

        # Save extracted JSON (all data needed for Phase 2)
        # ⚡ OPTIMIZATION: Cache directory creation
        bench = pdf_info['bench']
        bench_dir = parsed_dir / bench
        if bench not in _created_dirs:
            bench_dir.mkdir(parents=True, exist_ok=True)
            _created_dirs.add(bench)

        # ⚡ OPTIMIZATION: Compact JSON (no indent) - 10-15% faster
        parsed_path = bench_dir / f"{cnr}.parsed.json"
        with open(parsed_path, 'w', encoding='utf-8') as f:
            fast_json_dump_compact(extracted, f)

        return cnr, True, extracted.get('page_count', 0), None, needs_ocr

    except Exception as e:
        error_msg = str(e)
        # ⚡ OPTIMIZATION: Minimal error logging (skip traceback formatting unless debugging)
        error_path = errors_dir / f"{cnr}.error.txt"
        with open(error_path, 'w') as f:
            f.write(f"{cnr}|{local_pdf_path}|{error_msg}\n")
        return cnr, False, 0, error_msg, False


def list_courts_and_years(s3_client) -> Dict[str, List[int]]:
    """List all courts and years in R2 bucket"""
    courts_years = defaultdict(set)
    paginator = s3_client.get_paginator('list_objects_v2')

    # List years
    for page in paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/pdf/', Delimiter='/'):
        if 'CommonPrefixes' not in page:
            continue
        for prefix in page['CommonPrefixes']:
            year_match = re.search(r'year=(\d+)', prefix['Prefix'])
            if not year_match:
                continue
            year = int(year_match.group(1))

            # List courts for this year
            for court_page in paginator.paginate(
                Bucket=R2_BUCKET_NAME,
                Prefix=prefix['Prefix'],
                Delimiter='/'
            ):
                if 'CommonPrefixes' not in court_page:
                    continue
                for court_prefix in court_page['CommonPrefixes']:
                    court_match = re.search(r'court=([^/]+)', court_prefix['Prefix'])
                    if court_match:
                        courts_years[court_match.group(1)].add(year)

    return {k: sorted(list(v)) for k, v in courts_years.items()}


def count_all_pdfs(s3_client, courts_years: Dict[str, List[int]]) -> Tuple[int, Dict[str, int]]:
    """
    Count total PDFs across all courts/years for global ETA calculation.

    Returns:
        Tuple of (total_count, breakdown_by_court)
    """
    total = 0
    by_court = {}

    logger.info("Counting total PDFs in R2 (for global ETA)...")

    paginator = s3_client.get_paginator('list_objects_v2')

    for court_code, years in courts_years.items():
        court_total = 0
        for year in years:
            # Count PDFs for this court/year
            prefix = f"data/pdf/year={year}/court={court_code}/"
            for page in paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=prefix):
                if 'Contents' in page:
                    pdf_count = sum(1 for obj in page['Contents'] if obj['Key'].endswith('.pdf'))
                    court_total += pdf_count

        by_court[court_code] = court_total
        total += court_total

    return total, by_court


def list_benches(s3_client, court_code: str, year: int) -> List[str]:
    """List benches for a court/year"""
    prefix = f"data/pdf/year={year}/court={court_code}/"
    benches = []

    response = s3_client.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix, Delimiter='/')
    if 'CommonPrefixes' in response:
        for p in response['CommonPrefixes']:
            match = re.search(r'bench=([^/]+)', p['Prefix'])
            if match:
                benches.append(match.group(1))
    return benches


def list_pdfs_in_bench(s3_client, court_code: str, year: int, bench: str) -> List[Dict]:
    """List all PDFs in a bench"""
    prefix = f"data/pdf/year={year}/court={court_code}/bench={bench}/"
    pdfs = []

    paginator = s3_client.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=prefix):
        if 'Contents' not in page:
            continue
        for obj in page['Contents']:
            key = obj['Key']
            if not key.endswith('.pdf'):
                continue

            filename = key.split('/')[-1]
            # CNR is the first part: {CNR}_{version}_{date}.pdf
            cnr = filename.split('_')[0]

            pdfs.append({
                'r2_key': key,
                'cnr': cnr,
                'filename': filename,
                'size': obj['Size'],
                'court_code': court_code,
                'year': year,
                'bench': bench,
                'pdf_url': f"{R2_PUBLIC_BASE_URL}/{key}"  # Public URL doesn't include bucket name
            })
    return pdfs


def load_parquet_metadata(s3_client, court_code: str, year: int, bench: str) -> Dict[str, Dict]:
    """Load metadata parquet and return as dict keyed by CNR"""
    parquet_key = f"metadata/parquet/year={year}/court={court_code}/bench={bench}/metadata.parquet"

    try:
        with tempfile.NamedTemporaryFile(suffix='.parquet', delete=False) as tmp:
            s3_client.download_file(R2_BUCKET_NAME, parquet_key, tmp.name)
            df = pd.read_parquet(tmp.name)
            os.unlink(tmp.name)

        metadata_dict = {}
        for _, row in df.iterrows():
            cnr = row.get('cnr', '')
            if cnr:
                metadata_dict[cnr] = row.to_dict()
        return metadata_dict

    except Exception as e:
        logger.warning(f"Could not load parquet {parquet_key}: {e}")
        return {}


# =============================================================================
# Metadata Mapping (High Court → format expected by chunker)
# =============================================================================
def map_highcourt_metadata(parquet_row: Dict, pdf_info: Dict) -> Dict:
    """
    Map High Court parquet metadata to format expected by chunk_with_char_positions.

    High Court parquet fields:
        cnr, title, description, judge, decision_date, disposal_nature, court, court_code,
        date_of_registration

    Expected by chunker:
        case_id, title, citation, case_number, year, decision_date, court,
        petitioner, respondent, judges, disposition, pdf_paths/pdf_url

    Added fields (for better search):
        description - first ~200 chars of judgment (searchable summary)
        date_of_registration - case filing date
        bench_display_name - human-readable bench name (from BENCH_MAPPING)
    """
    # Parse petitioner/respondent from title ("X Vs Y" or "X vs Y")
    title = parquet_row.get('title', '') or ''
    petitioner, respondent = '', ''
    vs_match = re.search(r'(.+?)\s+[Vv]s\.?\s+(.+)', title)
    if vs_match:
        petitioner = vs_match.group(1).strip()
        respondent = vs_match.group(2).strip()

    # Parse judge into list
    judge_str = parquet_row.get('judge', '') or ''
    judges = [j.strip() for j in re.split(r'[,&]', judge_str) if j.strip()]

    # Parse year from decision_date
    decision_date = str(parquet_row.get('decision_date', ''))
    year = pdf_info.get('year', 0)
    if decision_date:
        year_match = re.search(r'(\d{4})', decision_date)
        if year_match:
            year = int(year_match.group(1))

    # Get bench slug and convert to human-readable name
    bench_slug = pdf_info.get('bench', '')
    court_name = parquet_row.get('court', 'High Court')
    bench_display_name = get_bench_display_name(bench_slug, court_name)

    # Get date_of_registration (case filing date)
    date_of_registration = parquet_row.get('date_of_registration', '') or ''

    # Parse court_code into state_code and establishment_code (e-Court ID format)
    court_code = pdf_info.get('court_code', '')
    court_code_parsed = parse_court_code(court_code)

    return {
        'case_id': parquet_row.get('cnr', pdf_info.get('cnr', '')),
        'title': title,
        'citation': '',  # High Courts don't have standard citation format
        'case_number': parquet_row.get('cnr', ''),
        'year': year,
        'decision_date': decision_date,
        'date_of_registration': date_of_registration,  # Case filing date
        'court': court_name,
        'court_code': court_code,
        # e-Court Identification fields (for faster Qdrant filtering)
        'state_code': court_code_parsed['state_code'],           # e.g., "27" for Maharashtra
        'establishment_code': court_code_parsed['establishment_code'],  # e.g., "1" for Bombay HC
        'state_name': court_code_parsed['state_name'],           # e.g., "Maharashtra"
        'bench': bench_slug,  # Keep original slug for reference
        'bench_display_name': bench_display_name,  # Human-readable bench name
        'petitioner': petitioner,
        'respondent': respondent,
        'petitioners': [petitioner] if petitioner else [],
        'respondents': [respondent] if respondent else [],
        'judges': judges,
        'disposal_nature': parquet_row.get('disposal_nature', ''),
        'disposition': parquet_row.get('disposal_nature', ''),
        'description': parquet_row.get('description', ''),  # Searchable summary
        # PDF URL for chunk metadata (critical for citation preview)
        'pdf_url': pdf_info.get('pdf_url', ''),
        'r2_key': pdf_info.get('r2_key', ''),
        'pdf_paths': {'english': pdf_info.get('pdf_url', '')},
    }


# =============================================================================
# REUSE: Chunking logic from chunk-judgment-pymupdf4llm.py
# =============================================================================
def chunk_highcourt_judgment(extracted: Dict, metadata: Dict) -> List[Dict]:
    """
    Chunk High Court judgment - REUSES logic from chunk-judgment-pymupdf4llm.py

    Adapted for High Court metadata schema.
    """
    try:
        from langchain_text_splitters import RecursiveCharacterTextSplitter
    except ImportError:
        from langchain.text_splitter import RecursiveCharacterTextSplitter

    # Use module-level constants: CHUNK_SIZE=4096, CHUNK_OVERLAP=512, MIN_CHUNK_SIZE=256

    # Get text - PREFER box-aware text with hybrid prefixes
    # Priority:
    # 1. Build from boxes with [TITLE] # / [SECTION] ## prefixes (best for RAG)
    # 2. Fallback to raw markdown `text` field
    # 3. Last resort: text_clean
    boxes = extracted.get("boxes", [])
    if boxes:
        # Build text with hybrid prefixes: [SEMANTIC] + markdown headers
        # This gives both semantic signal and LLM-native rendering
        full_text = build_text_from_boxes(boxes)
    else:
        # Fallback for PDFs without box data
        full_text = extracted.get("text") or extracted.get("text_clean", "")

    pages = extracted.get("pages", [])
    page_count = extracted.get("page_count", 0)

    # PDF URL for highlighting
    pdf_url = metadata.get('pdf_url', '')

    # Create splitter
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=CHUNK_SIZE,
        chunk_overlap=CHUNK_OVERLAP,
        length_function=len,
        separators=["\n\n\n", "\n\n", "\n", ". ", " ", ""],
        keep_separator=True
    )

    text_chunks = splitter.split_text(full_text)

    chunks = []
    search_start = 0  # Running offset for O(n) search instead of O(n²)

    for i, chunk_text in enumerate(text_chunks):
        if len(chunk_text.strip()) < MIN_CHUNK_SIZE:
            continue

        # Find character positions - O(n) total by searching from running offset
        # Instead of O(n²) from searching entire text each time
        char_start = full_text.find(chunk_text, search_start)
        if char_start == -1:
            # Fallback: search from beginning (shouldn't happen with proper splitting)
            char_start = full_text.find(chunk_text)
            if char_start == -1:
                # Last resort: estimate position
                char_start = search_start
        char_end = char_start + len(chunk_text)

        # Move search window forward (account for overlap)
        # Next chunk starts after current chunk's non-overlapping portion
        search_start = char_start + 1

        # Get page range
        page_start, page_end = 1, 1
        running_offset = 0
        for page in pages:
            page_num = page.get('page_number', 1)
            page_text = page.get('text', '')
            page_end_offset = running_offset + len(page_text)

            if char_end > running_offset and char_start < page_end_offset:
                if page_start == 1:
                    page_start = page_num
                page_end = page_num

            running_offset = page_end_offset + 2  # +2 for "\n\n"

        # Detect section type (reuse patterns from chunk-judgment-pymupdf4llm.py)
        section_type = "body"
        first_line = chunk_text.strip().split("\n")[0].upper() if chunk_text.strip() else ""
        if "JUDGMENT" in first_line or "ORDER" in first_line:
            section_type = "judgment"
        elif "FACT" in first_line or "BACKGROUND" in first_line:
            section_type = "facts"
        elif "CONCLUSION" in first_line or "HELD" in first_line:
            section_type = "conclusion"
        elif "ISSUE" in first_line or "QUESTION" in first_line:
            section_type = "issues"

        # Build contextual header
        title = metadata.get('title', 'Untitled')
        if len(title) > 100:
            title = title[:100] + "..."

        court = metadata.get('court', 'High Court')
        year = metadata.get('year', 0)

        case_header = f"Case: {title}"
        if year:
            case_header += f" ({year})"
        case_header += f"\nCourt: {court}"
        section_header = f"Section: {section_type.upper()}"
        contextual_header = f"{case_header}\n{section_header}\n\n"

        text_with_context = contextual_header + chunk_text.strip()

        # Build chunk
        cnr = metadata.get('case_id', '')
        chunk = {
            # Identification
            "chunk_id": f"{cnr}_{i:03d}",
            "case_id": cnr,
            "doc_id": cnr,

            # Text
            # Only store text with contextual header for embedding + BM25
            # Frontend uses char_start/char_end to extract original text from PDF
            # This saves ~2500 chars per chunk (50% reduction)
            "text": text_with_context,
            "title": metadata.get('title', ''),

            # PDF Highlighting
            "pdf_url": pdf_url,
            "char_start": char_start,
            "char_end": char_end,
            "page_start": page_start,
            "page_end": page_end,
            "chunk_index": i,
            "total_chunks": len(text_chunks),

            # Section
            "section_type": section_type,

            # Case Metadata
            "citation": metadata.get('citation', ''),
            "case_number": metadata.get('case_number', ''),
            "year": metadata.get('year', 0),
            "decision_date": metadata.get('decision_date', ''),
            "court": metadata.get('court', 'High Court'),
            "court_code": metadata.get('court_code', ''),
            # e-Court Identification fields (for faster Qdrant filtering)
            "state_code": metadata.get('state_code', ''),           # e.g., "27" for Maharashtra
            "establishment_code": metadata.get('establishment_code', ''),  # e.g., "1" for Bombay HC
            "state_name": metadata.get('state_name', ''),           # e.g., "Maharashtra"
            "bench": metadata.get('bench', ''),
            "bench_display_name": metadata.get('bench_display_name', ''),  # Human-readable

            # Parties
            "petitioner": metadata.get('petitioner', ''),
            "respondent": metadata.get('respondent', ''),

            # Judges
            "judges": metadata.get('judges', []),
            "bench_strength": len(metadata.get('judges', [])),

            # Classification
            "disposition": metadata.get('disposition', ''),

            # Additional searchable metadata
            "description": metadata.get('description', ''),  # ~200 char summary
            "date_of_registration": metadata.get('date_of_registration', ''),  # Filing date

            # Source tracking
            "data_source": "high_court_india",
            "r2_key": metadata.get('r2_key', ''),
        }

        chunks.append(chunk)

    # Update total_chunks
    for chunk in chunks:
        chunk["total_chunks"] = len(chunks)

    return chunks


# =============================================================================
# Pipeline
# =============================================================================
class HighCourtPipeline:
    """High Court RAG Pipeline - streams from R2 OR processes local disk, outputs chunks"""

    def __init__(
        self,
        output_dir: str = "data/highcourt-rag",
        workers: int = 8,
        limit: Optional[int] = None,
        resume: bool = False,
        checkpoint_interval: int = 100,
        court_filter: Optional[str] = None,
        year_filter: Optional[int] = None,
        local_path: Optional[str] = None,  # ⭐ Local mode (14x faster)
        parse_only: bool = False,  # ⭐ Phase 1: Parse only
        chunk_only: bool = False,  # ⭐ Phase 2: Chunk only
        skip_cnrs_file: Optional[str] = None,  # ⭐ CNR index to skip duplicates
        no_ocr: bool = False,  # ⭐ Two-pass OCR mode
        force_ocr: bool = False,  # ⭐ Two-pass OCR mode
        auto_ocr_pass2: bool = False  # ⭐ Auto-chain Pass 2 after Pass 1
    ):
        self.output_dir = Path(output_dir)
        self.workers = workers
        self.limit = limit
        self.checkpoint_interval = checkpoint_interval
        self.court_filter = court_filter
        self.year_filter = year_filter

        # ⭐ PARSE-ONLY MODE (two-phase processing)
        self.parse_only = parse_only
        self.chunk_only = chunk_only

        # ⭐ LOCAL MODE: Process from local disk instead of R2 streaming
        self.local_mode = local_path is not None
        self.local_path = Path(local_path) if local_path else None

        if self.local_mode:
            logger.info("=" * 80)
            logger.info("⚡ LOCAL MODE ENABLED - Processing from local disk")
            logger.info(f"   Source: {self.local_path}")
            if self.parse_only:
                logger.info("   Mode: PARSE-ONLY (Phase 1)")
                logger.info("   Expected ~30 PDF/s with 90 workers")
            elif self.chunk_only:
                logger.info("   Mode: CHUNK-ONLY (Phase 2)")
            else:
                logger.info("   Mode: FULL PIPELINE (parse + chunk)")
                logger.info("   Expected ~25 PDF/s (vs ~2 PDF/s streaming)")
            logger.info("=" * 80)

        # Directories
        self.extracted_dir = self.output_dir / "extracted"
        self.chunks_dir = self.output_dir / "chunks"
        self.parsed_dir = self.output_dir / "parsed"  # ⭐ Parse-only output
        self.errors_dir = self.output_dir / "errors"
        for d in [self.extracted_dir, self.chunks_dir, self.parsed_dir, self.errors_dir]:
            d.mkdir(parents=True, exist_ok=True)

        # Separate checkpoint for parse-only mode
        if self.parse_only:
            self.checkpoint_path = self.output_dir / "checkpoint_court_structure.json"
        elif self.chunk_only:
            self.checkpoint_path = self.output_dir / "checkpoint_chunk_only.json"
        else:
            self.checkpoint_path = self.output_dir / "checkpoint_court_structure_full.json"

        # S3 client (only needed for R2 mode)
        self.s3 = None if self.local_mode else create_s3_client()

        # Progress
        if resume and self.checkpoint_path.exists():
            self.progress = HighCourtProgress.load(self.checkpoint_path)
            logger.info(f"Resuming: {self.progress.global_processed} already processed")
        else:
            self.progress = HighCourtProgress(
                started_at=datetime.now().isoformat(),
                last_updated=datetime.now().isoformat()
            )

        # ⭐ SKIP DUPLICATES: Load CNR index from year=* processing
        self.skip_cnrs_file = skip_cnrs_file
        self.skip_cnrs_count = 0
        if skip_cnrs_file:
            skip_path = Path(skip_cnrs_file).expanduser()
            if skip_path.exists():
                logger.info(f"Loading CNR skip list from: {skip_path}")
                with open(skip_path, 'r') as f:
                    skip_cnrs = set(line.strip() for line in f if line.strip())
                # Pre-populate processed_cnrs with skip list
                self.progress.processed_cnrs.update(skip_cnrs)
                self.skip_cnrs_count = len(skip_cnrs)
                logger.info(f"Loaded {self.skip_cnrs_count:,} CNRs to skip (from year=* structure)")
            else:
                logger.warning(f"Skip CNR file not found: {skip_path}")

        # ⭐ TWO-PASS OCR MODE configuration
        self.no_ocr = no_ocr
        self.force_ocr = force_ocr
        self.auto_ocr_pass2 = auto_ocr_pass2
        self.ocr_needed_log = None

        # Set up OCR needed log file path
        if no_ocr:
            self.ocr_needed_log = str(self.output_dir / "needs_ocr_court.txt")
            # Clear existing file
            open(self.ocr_needed_log, 'w').close()
            logger.info("TWO-PASS MODE: OCR disabled (Pass 1) - will log files needing OCR")
            logger.info(f"   OCR needed log: {self.ocr_needed_log}")
        if force_ocr:
            logger.info("TWO-PASS MODE: Force OCR enabled (Pass 2) - reprocessing scanned files")

    def process_single_pdf(self, pdf_info: Dict, metadata: Dict) -> Tuple[bool, int, int]:
        """
        Process a single PDF: download → extract → chunk → save

        Returns: (success, page_count, chunk_count)
        """
        cnr = pdf_info['cnr']

        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            try:
                # Download PDF
                self.s3.download_file(R2_BUCKET_NAME, pdf_info['r2_key'], tmp.name)

                # Extract text (REUSES existing parser)
                extracted = extract_with_pymupdf4llm(tmp.name)

                if "error" in extracted:
                    raise Exception(extracted['error'])

                # Add metadata to extracted
                extracted['cnr'] = cnr
                extracted['court_code'] = pdf_info['court_code']
                extracted['year'] = pdf_info['year']
                extracted['bench'] = pdf_info['bench']

                # Save extracted JSON
                extracted_path = self.extracted_dir / f"{cnr}.extracted.json"
                with open(extracted_path, 'w', encoding='utf-8') as f:
                    json.dump(extracted, f, ensure_ascii=False, separators=(',', ':'))

                # Chunk (REUSES adapted chunking logic)
                chunks = chunk_highcourt_judgment(extracted, metadata)

                if not chunks:
                    raise Exception("No chunks generated")

                # Save chunks
                chunks_path = self.chunks_dir / f"{cnr}.chunks.jsonl"
                with open(chunks_path, 'w', encoding='utf-8') as f:
                    for chunk in chunks:
                        f.write(json.dumps(chunk, ensure_ascii=False) + '\n')

                return True, extracted.get('page_count', 0), len(chunks)

            except Exception as e:
                # Save error
                error_path = self.errors_dir / f"{cnr}.error.txt"
                with open(error_path, 'w') as f:
                    f.write(f"CNR: {cnr}\n")
                    f.write(f"R2 Key: {pdf_info['r2_key']}\n")
                    f.write(f"Error: {str(e)}\n")
                    f.write(f"\nTraceback:\n{traceback.format_exc()}")
                return False, 0, 0

            finally:
                # Cleanup temp file
                if os.path.exists(tmp.name):
                    os.unlink(tmp.name)

    def process_bench(self, court_code: str, year: int, bench: str) -> Tuple[int, int]:
        """
        Process all PDFs in a bench using parallel ThreadPoolExecutor.

        Optimized for 50-100+ workers:
        - Uses connection-pooled S3 clients (max_pool_connections=150)
        - Semaphore-based rate limiting prevents R2 throttling
        - ETA calculation for progress tracking
        - Adaptive batch submission to control memory

        Returns: (successful, failed)
        """
        logger.info(f"Processing: court={court_code}, year={year}, bench={bench}")
        log_memory_usage(logger, "Start bench: ")

        # List PDFs
        pdfs = list_pdfs_in_bench(self.s3, court_code, year, bench)
        logger.info(f"Found {len(pdfs)} PDFs")

        if self.limit:
            remaining = self.limit - self.progress.global_processed
            if remaining <= 0:
                return 0, 0
            pdfs = pdfs[:remaining]

        # Load metadata
        metadata_dict = load_parquet_metadata(self.s3, court_code, year, bench)
        logger.info(f"Loaded metadata for {len(metadata_dict)} cases")

        # Filter out already processed/failed PDFs
        pdfs_to_process = []
        for pdf_info in pdfs:
            cnr = pdf_info['cnr']
            if cnr in self.progress.processed_cnrs:
                self.progress.stats.skipped += 1
                continue
            if cnr in self.progress.failed_cnrs:
                continue
            pdfs_to_process.append(pdf_info)

        if not pdfs_to_process:
            logger.info("No new PDFs to process")
            return 0, 0

        logger.info(f"Processing {len(pdfs_to_process)} PDFs with {self.workers} parallel workers")
        logger.info(f"Connection pool: max_pool_connections=150, adaptive retries enabled")

        successful, failed = 0, 0
        start_time = time.time()
        completed_count = 0

        # Thread-safe counter for progress
        progress_lock = threading.Lock()

        # Rate limiting semaphore for R2 (prevent 429 errors at high concurrency)
        # Allows workers param concurrent downloads, queues the rest
        rate_limiter = threading.Semaphore(self.workers)

        def rate_limited_worker(pdf_info, metadata, extracted_dir, chunks_dir, errors_dir):
            """Wrapper that respects rate limiting semaphore"""
            with rate_limiter:
                return process_pdf_worker(pdf_info, metadata, extracted_dir, chunks_dir, errors_dir)

        # Use ThreadPoolExecutor for parallel processing (I/O-bound R2 downloads)
        # Note: workers can be 50-100+, but semaphore controls actual concurrency
        with ThreadPoolExecutor(max_workers=min(self.workers, 100)) as executor:
            # Submit all tasks (semaphore will throttle actual execution)
            future_to_cnr = {}
            for pdf_info in pdfs_to_process:
                cnr = pdf_info['cnr']
                parquet_row = metadata_dict.get(cnr, {})
                metadata = map_highcourt_metadata(parquet_row, pdf_info)

                future = executor.submit(
                    rate_limited_worker,
                    pdf_info,
                    metadata,
                    self.extracted_dir,
                    self.chunks_dir,
                    self.errors_dir
                )
                future_to_cnr[future] = cnr

            # Process results as they complete with ETA calculation
            for future in as_completed(future_to_cnr):
                cnr = future_to_cnr[future]
                completed_count += 1

                try:
                    result_cnr, success, pages, chunks, error_msg = future.result()

                    with progress_lock:
                        if success:
                            self.progress.processed_cnrs.add(cnr)
                            self.progress.stats.successful += 1
                            self.progress.stats.total_pages += pages
                            self.progress.stats.total_chunks += chunks
                            self.progress.global_processed += 1
                            successful += 1

                            # Calculate bench ETA
                            elapsed = time.time() - start_time
                            rate = completed_count / elapsed if elapsed > 0 else 0
                            remaining = len(pdfs_to_process) - completed_count
                            eta_sec = remaining / rate if rate > 0 else 0
                            bench_eta = str(timedelta(seconds=int(eta_sec)))

                            # Calculate GLOBAL ETA
                            global_elapsed = time.time() - self.progress.global_start_time
                            global_rate = self.progress.global_processed / global_elapsed if global_elapsed > 0 else rate
                            global_remaining = self.progress.global_total_pdfs - self.progress.global_processed
                            global_eta_sec = global_remaining / global_rate if global_rate > 0 else 0
                            global_eta = str(timedelta(seconds=int(global_eta_sec)))
                            global_pct = self.progress.global_processed / max(self.progress.global_total_pdfs, 1) * 100

                            # Log with both bench and global progress
                            logger.info(
                                f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: {pages}p {chunks}c | "
                                f"{rate:.1f}/s bench-ETA {bench_eta} | "
                                f"🌍 {self.progress.global_processed:,}/{self.progress.global_total_pdfs:,} ({global_pct:.2f}%) global-ETA {global_eta}"
                            )
                        else:
                            self.progress.failed_cnrs.add(cnr)
                            self.progress.stats.failed += 1
                            self.progress.global_processed += 1
                            failed += 1
                            logger.error(f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: FAILED - {error_msg}")

                except Exception as e:
                    # Handle unexpected exceptions from the future
                    with progress_lock:
                        self.progress.failed_cnrs.add(cnr)
                        self.progress.stats.failed += 1
                        failed += 1
                    logger.error(f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: EXCEPTION - {str(e)}")

                # Checkpoint at intervals (thread-safe)
                if completed_count % self.checkpoint_interval == 0:
                    with progress_lock:
                        self.progress.last_updated = datetime.now().isoformat()
                        self.progress.save(self.checkpoint_path)

                    elapsed = time.time() - start_time
                    rate = completed_count / elapsed if elapsed > 0 else 0

                    # Global checkpoint summary
                    global_elapsed = time.time() - self.progress.global_start_time
                    global_rate = self.progress.global_processed / global_elapsed if global_elapsed > 0 else rate
                    global_remaining = self.progress.global_total_pdfs - self.progress.global_processed
                    global_eta_sec = global_remaining / global_rate if global_rate > 0 else 0
                    global_eta = str(timedelta(seconds=int(global_eta_sec)))
                    global_pct = self.progress.global_processed / max(self.progress.global_total_pdfs, 1) * 100

                    logger.info("─" * 80)
                    logger.info(f"📊 CHECKPOINT: {successful} ok, {failed} failed, {rate:.1f} files/sec (bench)")
                    logger.info(
                        f"🌍 GLOBAL: {self.progress.global_processed:,}/{self.progress.global_total_pdfs:,} "
                        f"({global_pct:.2f}%) | Rate: {global_rate:.1f}/s | ETA: {global_eta}"
                    )
                    log_memory_usage(logger, "Memory: ")
                    logger.info("─" * 80)

        # Final memory log
        log_memory_usage(logger, "End bench: ")
        return successful, failed

    def process_bench_local(self, court_code: str, year: int, bench: str) -> Tuple[int, int]:
        """
        Process all PDFs in a bench from LOCAL disk (14x faster than R2 streaming).

        Uses multiprocessing-friendly workers since no S3 client needed.
        Expected: ~25 PDF/s (vs ~2 PDF/s with R2 streaming).

        Returns: (successful, failed)
        """
        logger.info(f"Processing LOCAL: court={court_code}, year={year}, bench={bench}")
        log_memory_usage(logger, "Start bench: ")

        # List PDFs from local disk
        pdfs = list_pdfs_in_bench_local(self.local_path, court_code, year, bench)
        logger.info(f"Found {len(pdfs)} PDFs on disk")

        if self.limit:
            remaining = self.limit - self.progress.global_processed
            if remaining <= 0:
                return 0, 0
            pdfs = pdfs[:remaining]

        # Load metadata from local parquet
        metadata_dict = load_parquet_metadata_local(self.local_path, court_code, year, bench)
        logger.info(f"Loaded metadata for {len(metadata_dict)} cases")

        # Filter out already processed/failed PDFs
        pdfs_to_process = []
        for pdf_info in pdfs:
            cnr = pdf_info['cnr']
            if cnr in self.progress.processed_cnrs:
                self.progress.stats.skipped += 1
                continue
            if cnr in self.progress.failed_cnrs:
                continue
            pdfs_to_process.append(pdf_info)

        if not pdfs_to_process:
            logger.info("No new PDFs to process")
            return 0, 0

        # ⚡ OPTIMIZATION: Use ProcessPoolExecutor for CPU-bound PDF parsing + chunking
        # ThreadPoolExecutor was bottlenecked by Python's GIL
        # Optimal workers = CPU cores (not 500 threads fighting for 1 GIL)
        actual_workers = min(self.workers, cpu_count())
        logger.info(f"Processing {len(pdfs_to_process)} PDFs with {actual_workers} processes (LOCAL, CPU-bound)")
        logger.info(f"  (Requested {self.workers} workers, capped to {cpu_count()} CPU cores)")

        successful, failed = 0, 0
        start_time = time.time()
        completed_count = 0

        # Process-safe counter for progress
        progress_lock = threading.Lock()

        # ⚡ ProcessPoolExecutor for TRUE parallelism (bypasses GIL)
        # PyMuPDF parsing + chunking is CPU-bound
        with ProcessPoolExecutor(max_workers=actual_workers) as executor:
            future_to_cnr = {}
            for pdf_info in pdfs_to_process:
                cnr = pdf_info['cnr']
                parquet_row = metadata_dict.get(cnr, {})
                metadata = map_highcourt_metadata(parquet_row, pdf_info)

                future = executor.submit(
                    process_pdf_worker_local,  # ⭐ Local worker - no S3 download
                    pdf_info,
                    metadata,
                    self.extracted_dir,
                    self.chunks_dir,
                    self.errors_dir
                )
                future_to_cnr[future] = cnr

            # Process results as they complete with ETA calculation
            for future in as_completed(future_to_cnr):
                cnr = future_to_cnr[future]
                completed_count += 1

                try:
                    result_cnr, success, pages, chunks, error_msg = future.result()

                    with progress_lock:
                        if success:
                            self.progress.processed_cnrs.add(cnr)
                            self.progress.stats.successful += 1
                            self.progress.stats.total_pages += pages
                            self.progress.stats.total_chunks += chunks
                            self.progress.global_processed += 1
                            successful += 1

                            # Calculate bench ETA
                            elapsed = time.time() - start_time
                            rate = completed_count / elapsed if elapsed > 0 else 0
                            remaining = len(pdfs_to_process) - completed_count
                            eta_sec = remaining / rate if rate > 0 else 0
                            bench_eta = str(timedelta(seconds=int(eta_sec)))

                            # Calculate GLOBAL ETA
                            global_elapsed = time.time() - self.progress.global_start_time
                            global_rate = self.progress.global_processed / global_elapsed if global_elapsed > 0 else rate
                            global_remaining = self.progress.global_total_pdfs - self.progress.global_processed
                            global_eta_sec = global_remaining / global_rate if global_rate > 0 else 0
                            global_eta = str(timedelta(seconds=int(global_eta_sec)))
                            global_pct = self.progress.global_processed / max(self.progress.global_total_pdfs, 1) * 100

                            # Log with both bench and global progress
                            logger.info(
                                f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: {pages}p {chunks}c | "
                                f"{rate:.1f}/s bench-ETA {bench_eta} | "
                                f"🌍 {self.progress.global_processed:,}/{self.progress.global_total_pdfs:,} ({global_pct:.2f}%) global-ETA {global_eta}"
                            )
                        else:
                            self.progress.failed_cnrs.add(cnr)
                            self.progress.stats.failed += 1
                            self.progress.global_processed += 1
                            failed += 1
                            logger.error(f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: FAILED - {error_msg}")

                except Exception as e:
                    with progress_lock:
                        self.progress.failed_cnrs.add(cnr)
                        self.progress.stats.failed += 1
                        failed += 1
                    logger.error(f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: EXCEPTION - {str(e)}")

                # Checkpoint at intervals (thread-safe)
                if completed_count % self.checkpoint_interval == 0:
                    with progress_lock:
                        self.progress.last_updated = datetime.now().isoformat()
                        self.progress.save(self.checkpoint_path)

                    elapsed = time.time() - start_time
                    rate = completed_count / elapsed if elapsed > 0 else 0

                    # Global checkpoint summary
                    global_elapsed = time.time() - self.progress.global_start_time
                    global_rate = self.progress.global_processed / global_elapsed if global_elapsed > 0 else rate
                    global_remaining = self.progress.global_total_pdfs - self.progress.global_processed
                    global_eta_sec = global_remaining / global_rate if global_rate > 0 else 0
                    global_eta = str(timedelta(seconds=int(global_eta_sec)))
                    global_pct = self.progress.global_processed / max(self.progress.global_total_pdfs, 1) * 100

                    logger.info("─" * 80)
                    logger.info(f"📊 CHECKPOINT: {successful} ok, {failed} failed, {rate:.1f} files/sec (LOCAL)")
                    logger.info(
                        f"🌍 GLOBAL: {self.progress.global_processed:,}/{self.progress.global_total_pdfs:,} "
                        f"({global_pct:.2f}%) | Rate: {global_rate:.1f}/s | ETA: {global_eta}"
                    )
                    log_memory_usage(logger, "Memory: ")
                    logger.info("─" * 80)

        # Final memory log
        log_memory_usage(logger, "End bench: ")
        return successful, failed

    def process_bench_parse_only(self, court_code: str, year: int, bench: str) -> Tuple[int, int]:
        """
        Process all PDFs in a bench - PARSE ONLY (Phase 1).

        Only extracts PDF content, no chunking.
        Saves .parsed.json files for later chunking in Phase 2.

        ~20% faster than full pipeline since no chunking overhead.
        Use with --workers 90 for maximum throughput.

        Returns: (successful, failed)
        """
        logger.info(f"PARSE-ONLY: court={court_code}, year={year}, bench={bench}")
        log_memory_usage(logger, "Start bench: ")

        # List PDFs from local disk
        pdfs = list_pdfs_in_bench_local(self.local_path, court_code, year, bench)
        logger.info(f"Found {len(pdfs)} PDFs on disk")

        if self.limit:
            remaining = self.limit - self.progress.global_processed
            if remaining <= 0:
                return 0, 0
            pdfs = pdfs[:remaining]

        # Filter out already processed/failed PDFs
        pdfs_to_process = []
        for pdf_info in pdfs:
            cnr = pdf_info['cnr']
            if cnr in self.progress.processed_cnrs:
                self.progress.stats.skipped += 1
                continue
            if cnr in self.progress.failed_cnrs:
                continue
            pdfs_to_process.append(pdf_info)

        if not pdfs_to_process:
            logger.info("No new PDFs to process")
            return 0, 0

        # ⚡ OPTIMIZATION: Use ProcessPoolExecutor for CPU-bound PDF parsing
        # ThreadPoolExecutor was bottlenecked by Python's GIL (Global Interpreter Lock)
        # ProcessPoolExecutor bypasses GIL by using separate processes
        # Optimal workers = CPU cores (not 500 threads fighting for 1 GIL)
        actual_workers = min(self.workers, cpu_count())
        logger.info(f"Parsing {len(pdfs_to_process)} PDFs with {actual_workers} processes (PARSE-ONLY, CPU-bound)")
        logger.info(f"  (Requested {self.workers} workers, capped to {cpu_count()} CPU cores)")

        successful, failed = 0, 0
        start_time = time.time()
        completed_count = 0

        # Process-safe counter for progress (threading.Lock works across process results)
        progress_lock = threading.Lock()

        # ⚡ ProcessPoolExecutor for TRUE parallelism (bypasses GIL)
        # Each process has its own Python interpreter and GIL
        # PyMuPDF parsing is CPU-bound, so processes >> threads
        ocr_needed_count = 0  # Track files needing OCR for Pass 2

        with ProcessPoolExecutor(max_workers=actual_workers) as executor:
            future_to_cnr = {}
            for pdf_info in pdfs_to_process:
                cnr = pdf_info['cnr']

                future = executor.submit(
                    parse_pdf_worker_local,  # ⭐ Parse-only worker
                    pdf_info,
                    self.parsed_dir,
                    self.errors_dir,
                    self.ocr_needed_log,  # ⭐ Log files needing OCR
                    self.force_ocr  # ⭐ Force OCR mode
                )
                future_to_cnr[future] = cnr

            # Process results as they complete with ETA calculation
            for future in as_completed(future_to_cnr):
                cnr = future_to_cnr[future]
                completed_count += 1

                try:
                    result_cnr, success, pages, error_msg, needs_ocr = future.result()
                    if needs_ocr:
                        ocr_needed_count += 1

                    with progress_lock:
                        if success:
                            self.progress.processed_cnrs.add(cnr)
                            self.progress.stats.successful += 1
                            self.progress.stats.total_pages += pages
                            self.progress.global_processed += 1
                            successful += 1

                            # Calculate bench ETA
                            elapsed = time.time() - start_time
                            rate = completed_count / elapsed if elapsed > 0 else 0
                            remaining = len(pdfs_to_process) - completed_count
                            eta_sec = remaining / rate if rate > 0 else 0
                            bench_eta = str(timedelta(seconds=int(eta_sec)))

                            # Calculate GLOBAL ETA
                            global_elapsed = time.time() - self.progress.global_start_time
                            global_rate = self.progress.global_processed / global_elapsed if global_elapsed > 0 else rate
                            global_remaining = self.progress.global_total_pdfs - self.progress.global_processed
                            global_eta_sec = global_remaining / global_rate if global_rate > 0 else 0
                            global_eta = str(timedelta(seconds=int(global_eta_sec)))
                            global_pct = self.progress.global_processed / max(self.progress.global_total_pdfs, 1) * 100

                            # ⚡ OPTIMIZATION: Log every 50 files (was 10) - reduces I/O overhead
                            if completed_count % 50 == 0 or completed_count == len(pdfs_to_process):
                                logger.info(
                                    f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: {pages}p | "
                                    f"{rate:.1f}/s ETA {bench_eta} | "
                                    f"🌍 {self.progress.global_processed:,}/{self.progress.global_total_pdfs:,} ({global_pct:.2f}%) global-ETA {global_eta}"
                                )
                        else:
                            self.progress.failed_cnrs.add(cnr)
                            self.progress.stats.failed += 1
                            self.progress.global_processed += 1
                            failed += 1
                            logger.error(f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: FAILED - {error_msg}")

                except Exception as e:
                    with progress_lock:
                        self.progress.failed_cnrs.add(cnr)
                        self.progress.stats.failed += 1
                        failed += 1
                    logger.error(f"[{completed_count}/{len(pdfs_to_process)}] {cnr}: EXCEPTION - {str(e)}")

                # Checkpoint at intervals (thread-safe)
                if completed_count % self.checkpoint_interval == 0:
                    with progress_lock:
                        self.progress.last_updated = datetime.now().isoformat()
                        self.progress.save(self.checkpoint_path)

                    elapsed = time.time() - start_time
                    rate = completed_count / elapsed if elapsed > 0 else 0

                    # Global checkpoint summary
                    global_elapsed = time.time() - self.progress.global_start_time
                    global_rate = self.progress.global_processed / global_elapsed if global_elapsed > 0 else rate
                    global_remaining = self.progress.global_total_pdfs - self.progress.global_processed
                    global_eta_sec = global_remaining / global_rate if global_rate > 0 else 0
                    global_eta = str(timedelta(seconds=int(global_eta_sec)))
                    global_pct = self.progress.global_processed / max(self.progress.global_total_pdfs, 1) * 100

                    logger.info("─" * 80)
                    logger.info(f"📊 CHECKPOINT: {successful} ok, {failed} failed, {rate:.1f} files/sec (PARSE-ONLY)")
                    logger.info(
                        f"🌍 GLOBAL: {self.progress.global_processed:,}/{self.progress.global_total_pdfs:,} "
                        f"({global_pct:.2f}%) | Rate: {global_rate:.1f}/s | ETA: {global_eta}"
                    )
                    log_memory_usage(logger, "Memory: ")
                    logger.info("─" * 80)

        # Final memory log
        log_memory_usage(logger, "End bench: ")
        return successful, failed

    def run(self):
        """Run the pipeline"""
        start_time = datetime.now()
        self.progress.global_start_time = time.time()

        logger.info("=" * 80)
        logger.info("HIGH COURT RAG PIPELINE")
        logger.info("=" * 80)
        logger.info(f"Output: {self.output_dir}")
        logger.info(f"Workers: {self.workers}")
        logger.info(f"Limit: {self.limit or 'None'}")
        log_memory_usage(logger, "Initial: ")

        try:
            # Get courts to process (LOCAL or R2 mode)
            if self.court_filter and self.year_filter:
                courts_years = {self.court_filter: [self.year_filter]}
            elif self.local_mode:
                courts_years = list_courts_and_years_local(self.local_path)
                if self.court_filter:
                    courts_years = {self.court_filter: courts_years.get(self.court_filter, [])}
            else:
                courts_years = list_courts_and_years(self.s3)
                if self.court_filter:
                    courts_years = {self.court_filter: courts_years.get(self.court_filter, [])}

            logger.info(f"Courts: {list(courts_years.keys())}")

            # Count total PDFs for global ETA (skip if --limit set for testing)
            if not self.limit:
                if self.local_mode:
                    total_pdfs, pdfs_by_court = count_all_pdfs_local(self.local_path, courts_years)
                else:
                    total_pdfs, pdfs_by_court = count_all_pdfs(self.s3, courts_years)

                self.progress.global_total_pdfs = total_pdfs
                logger.info("=" * 80)
                logger.info(f"🎯 GLOBAL SCOPE: {total_pdfs:,} total PDFs to process")
                if self.local_mode:
                    logger.info("   Mode: LOCAL (14x faster)")
                else:
                    logger.info("   Mode: R2 STREAMING")
                logger.info("=" * 80)
                logger.info("PDFs by court:")
                for court, count in sorted(pdfs_by_court.items(), key=lambda x: -x[1])[:10]:
                    logger.info(f"  {court}: {count:,} PDFs")
                if len(pdfs_by_court) > 10:
                    logger.info(f"  ... and {len(pdfs_by_court) - 10} more courts")
                logger.info("=" * 80)
            else:
                self.progress.global_total_pdfs = self.limit
                logger.info(f"Test mode: limit={self.limit} PDFs")

            total_ok, total_fail = 0, 0

            for court_code, years in sorted(courts_years.items()):
                if self.year_filter:
                    years = [y for y in years if y == self.year_filter]

                for year in sorted(years):
                    court_year_key = f"{court_code}:{year}"
                    if court_year_key in self.progress.completed_court_years:
                        logger.info(f"Skipping {court_year_key} - already done")
                        continue

                    self.progress.current_court = court_code
                    self.progress.current_year = year

                    # List benches (LOCAL or R2 mode)
                    if self.local_mode:
                        benches = list_benches_local(self.local_path, court_code, year)
                    else:
                        benches = list_benches(self.s3, court_code, year)

                    logger.info(f"\n{court_code}/{year}: {len(benches)} benches")

                    for bench in benches:
                        # Process bench (select appropriate method)
                        if self.parse_only:
                            ok, fail = self.process_bench_parse_only(court_code, year, bench)
                        elif self.local_mode:
                            ok, fail = self.process_bench_local(court_code, year, bench)
                        else:
                            ok, fail = self.process_bench(court_code, year, bench)

                        total_ok += ok
                        total_fail += fail

                        # Check limit
                        if self.limit and self.progress.global_processed >= self.limit:
                            break

                    self.progress.completed_court_years.add(court_year_key)
                    self.progress.save(self.checkpoint_path)
                    log_memory_usage(logger, f"After {court_code}/{year}: ")

                    if self.limit and self.progress.global_processed >= self.limit:
                        break
                if self.limit and self.progress.global_processed >= self.limit:
                    break

            self.progress.stats.processing_time_sec = (datetime.now() - start_time).total_seconds()
            self.progress.save(self.checkpoint_path)

        except KeyboardInterrupt:
            logger.warning("\nInterrupted by user")
            self.progress.save(self.checkpoint_path)
            sys.exit(1)

        # Summary
        elapsed = datetime.now() - start_time
        total_processed = self.progress.global_processed
        global_pct = total_processed / max(self.progress.global_total_pdfs, 1) * 100

        logger.info("\n" + "=" * 80)
        logger.info("🏁 PIPELINE COMPLETE")
        logger.info("=" * 80)
        logger.info(f"Total Time: {elapsed}")
        logger.info(f"🌍 Global Progress: {total_processed:,}/{self.progress.global_total_pdfs:,} ({global_pct:.2f}%)")

        if self.progress.global_processed > 0:
            avg_rate = self.progress.global_processed / elapsed.total_seconds()
            logger.info(f"Average Rate: {avg_rate:.2f} PDFs/second")

        log_memory_usage(logger, "Final: ")
        logger.info("\n" + self.progress.stats.get_summary())
        logger.info(f"\nOutput: {self.chunks_dir}")

        # ⭐ AUTO-CHAIN: Start OCR Pass 2 if enabled and files need OCR
        if self.auto_ocr_pass2 and self.no_ocr and self.ocr_needed_log:
            ocr_log_path = Path(self.ocr_needed_log)
            if ocr_log_path.exists():
                with open(ocr_log_path, 'r') as f:
                    ocr_files = [line.strip() for line in f if line.strip()]

                if ocr_files:
                    logger.info("\n" + "=" * 80)
                    logger.info("🔄 AUTO-CHAIN: Starting OCR Pass 2")
                    logger.info("=" * 80)
                    logger.info(f"Files needing OCR: {len(ocr_files):,}")
                    logger.info(f"OCR file list: {self.ocr_needed_log}")

                    # Build Pass 2 command
                    pass2_cmd = [
                        sys.executable,
                        __file__,
                        "--local-path", str(self.local_path),
                        "--parse-only",
                        "--workers", str(self.workers),
                        "--force-ocr",
                        "--file-list", self.ocr_needed_log,
                        "--output", str(self.output_dir)
                    ]

                    logger.info(f"Command: {' '.join(pass2_cmd)}")
                    logger.info("Starting Pass 2...")

                    # Run Pass 2 as subprocess
                    result = subprocess.run(pass2_cmd, capture_output=False)
                    if result.returncode == 0:
                        logger.info("✅ OCR Pass 2 completed successfully!")
                    else:
                        logger.error(f"❌ OCR Pass 2 failed with code: {result.returncode}")
                else:
                    logger.info("\n✅ No files need OCR - Pass 2 not required")
        else:
            logger.info(f"\nNext step: Run embed-and-ingest-highcourt.py on chunks")


def main():
    parser = argparse.ArgumentParser(
        description="High Court RAG Pipeline - Process PDFs from R2 or local disk",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # R2 Streaming Mode (default)
  python run-pipeline-highcourt.py --court 10_8 --year 2020 --limit 10

  # ⭐ LOCAL Mode (14x faster) - After transferring R2 to Vultr:
  #   rclone sync r2:aws-high-court-judgments /data/highcourt --progress
  python run-pipeline-highcourt.py --local-path /data/highcourt --workers 50
        """
    )

    parser.add_argument("--output", default="data/highcourt-rag",
                       help="Output directory for chunks and extracted text")
    parser.add_argument("--workers", type=int, default=8,
                       help="Number of parallel workers (default: 8, local mode: try 50)")
    parser.add_argument("--limit", type=int,
                       help="Limit PDFs for testing")
    parser.add_argument("--resume", action="store_true",
                       help="Resume from checkpoint")
    parser.add_argument("--checkpoint-interval", type=int, default=100,
                       help="Save checkpoint every N files")
    parser.add_argument("--court", type=str,
                       help="Court code filter (e.g., 10_8)")
    parser.add_argument("--year", type=int,
                       help="Year filter")
    parser.add_argument("--list-courts", action="store_true",
                       help="List available courts and exit")

    # ⭐ LOCAL MODE (14x faster)
    parser.add_argument("--local-path", type=str,
                       help="Path to local R2 copy. Enables LOCAL mode (14x faster). "
                            "First sync R2 using: rclone sync r2:aws-high-court-judgments <path>")

    # ⭐ PARSE-ONLY MODE (two-phase processing)
    parser.add_argument("--parse-only", action="store_true",
                       help="Phase 1: Parse PDFs and save extracted JSON. No chunking. "
                            "Use with --workers 90 for maximum throughput.")
    parser.add_argument("--chunk-only", action="store_true",
                       help="Phase 2: Chunk from previously parsed JSON files. "
                            "Run after --parse-only completes.")

    # ⭐ SKIP DUPLICATES - Load CNR index from year=* processing
    parser.add_argument("--skip-cnrs", type=str,
                       help="Path to file containing CNRs to skip (one per line). "
                            "Used to skip duplicates already processed from year=* structure.")

    # ⭐ TWO-PASS OCR MODE
    parser.add_argument("--no-ocr", action="store_true",
                       help="TWO-PASS MODE Pass 1: Disable OCR (faster), log files needing OCR")
    parser.add_argument("--force-ocr", action="store_true",
                       help="TWO-PASS MODE Pass 2: Force OCR on all files (for reprocessing)")
    parser.add_argument("--auto-ocr-pass2", action="store_true",
                       help="AUTO-CHAIN: Automatically run OCR Pass 2 after Pass 1 completes")
    parser.add_argument("--file-list", type=str,
                       help="Process only files from this list (one path per line)")

    args = parser.parse_args()

    # Validate mutually exclusive modes
    if args.parse_only and args.chunk_only:
        print("Error: --parse-only and --chunk-only are mutually exclusive")
        sys.exit(1)

    if args.list_courts:
        if args.local_path:
            courts = list_courts_and_years_local(Path(args.local_path))
            print(f"\nAvailable courts (LOCAL: {args.local_path}):")
        else:
            s3 = create_s3_client()
            courts = list_courts_and_years(s3)
            print("\nAvailable courts (R2):")
        for court, years in sorted(courts.items()):
            print(f"  {court}: {years}")
        sys.exit(0)

    pipeline = HighCourtPipeline(
        output_dir=args.output,
        workers=args.workers,
        limit=args.limit,
        resume=args.resume,
        checkpoint_interval=args.checkpoint_interval,
        court_filter=args.court,
        year_filter=args.year,
        local_path=args.local_path,
        parse_only=args.parse_only,  # ⭐ Phase 1
        chunk_only=args.chunk_only,  # ⭐ Phase 2
        skip_cnrs_file=args.skip_cnrs,  # ⭐ Skip duplicates
        no_ocr=args.no_ocr,  # ⭐ Two-pass OCR
        force_ocr=args.force_ocr,  # ⭐ Two-pass OCR
        auto_ocr_pass2=args.auto_ocr_pass2  # ⭐ Auto-chain Pass 2
    )

    pipeline.run()


if __name__ == "__main__":
    main()
