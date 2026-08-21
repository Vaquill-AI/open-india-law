#!/usr/bin/env python3
"""
Production RAG Pipeline for pymupdf4llm (Layout Mode - 2x Faster)

Robust pipeline orchestrator with comprehensive error handling:
- Retry logic with exponential backoff
- Detailed error logging and recovery
- Memory-efficient batch processing
- Progress checkpointing every N files
- Validation of outputs at each stage
- Parallel processing with error isolation
- Resume from partial failures

Features:
1. Extract text from PDFs with layout mode (2x faster, better markdown headers)
2. Chunk with metadata (parallel with validation)
3. Batch embed with Voyage AI (with rate limiting)
4. Upload to Qdrant Cloud (with batch validation)

Note: Layout mode provides better markdown structure (#, ## headers) but
word-level positions are not available (not yet implemented by pymupdf4llm).

Usage:
    # Full pipeline (40,543 PDFs)
    python run-pipeline-pymupdf4llm.py --workers 8

    # Test with 10 PDFs
    python run-pipeline-pymupdf4llm.py --limit 10 --workers 4

    # Resume from checkpoint
    python run-pipeline-pymupdf4llm.py --resume

    # With retries
    python run-pipeline-pymupdf4llm.py --workers 8 --max-retries 3
"""

import json
import sys
import logging
import time
import traceback
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Set
import multiprocessing as mp
from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta
from collections import defaultdict
import argparse
import hashlib

# IMPORTANT: Import pymupdf.layout BEFORE pymupdf4llm to enable layout mode (2x faster)
try:
    import pymupdf.layout  # Activates GNN-based layout analysis
except ImportError:
    print("Warning: pymupdf.layout not available. Using legacy mode.")
    print("Install with: pip install pymupdf4llm[layout]")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('pipeline_pymupdf4llm.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Import local modules
sys.path.insert(0, str(Path(__file__).parent))


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

    def add_error(self, error_type: str, case_id: str, message: str):
        """Add error to tracking"""
        self.errors[error_type].append(f"{case_id}: {message}")

    def get_summary(self) -> str:
        """Get human-readable summary"""
        lines = [
            f"Total files: {self.total_files}",
            f"Successful: {self.successful} ({self.successful/self.total_files*100:.1f}%)" if self.total_files > 0 else "Successful: 0",
            f"Failed: {self.failed}",
            f"Skipped: {self.skipped}",
            f"Retried: {self.retried}",
            f"Total size: {self.total_size_bytes / 1024 / 1024:.1f} MB",
            f"Total pages: {self.total_pages:,}",
            f"Total chunks: {self.total_chunks:,}",
            f"Total words: {self.total_words:,}",
            f"Processing time: {timedelta(seconds=int(self.processing_time_sec))}",
        ]

        if self.errors:
            lines.append("\nErrors by type:")
            for error_type, errors in self.errors.items():
                lines.append(f"  {error_type}: {len(errors)} cases")

        return "\n".join(lines)


@dataclass
class PipelineProgress:
    """Comprehensive pipeline progress tracking"""
    started_at: str
    last_updated: str
    last_checkpoint_at: str
    total_cases: int
    processed_cases: int = 0
    current_phase: str = "extract"  # extract, chunk, embed, complete

    # Extraction stats
    extraction_stats: ProcessingStats = field(default_factory=ProcessingStats)
    extracted_files: Set[str] = field(default_factory=set)
    extraction_failures: Set[str] = field(default_factory=set)

    # Chunking stats
    chunking_stats: ProcessingStats = field(default_factory=ProcessingStats)
    chunked_files: Set[str] = field(default_factory=set)
    chunking_failures: Set[str] = field(default_factory=set)

    # Embedding stats
    embedding_stats: ProcessingStats = field(default_factory=ProcessingStats)
    embedded_chunks: int = 0

    def save(self, checkpoint_path: Path):
        """Save progress to JSON"""
        # Convert sets to lists for JSON serialization
        data = asdict(self)
        data['extracted_files'] = list(self.extracted_files)
        data['extraction_failures'] = list(self.extraction_failures)
        data['chunked_files'] = list(self.chunked_files)
        data['chunking_failures'] = list(self.chunking_failures)

        # Write atomically (write to temp file, then rename)
        temp_path = checkpoint_path.with_suffix('.json.tmp')
        with open(temp_path, 'w') as f:
            json.dump(data, f, indent=2)
        temp_path.rename(checkpoint_path)

        logger.info(f"Checkpoint saved: {checkpoint_path}")

    @classmethod
    def load(cls, checkpoint_path: Path) -> 'PipelineProgress':
        """Load progress from JSON"""
        with open(checkpoint_path, 'r') as f:
            data = json.load(f)

        # Convert lists back to sets
        data['extracted_files'] = set(data.get('extracted_files', []))
        data['extraction_failures'] = set(data.get('extraction_failures', []))
        data['chunked_files'] = set(data.get('chunked_files', []))
        data['chunking_failures'] = set(data.get('chunking_failures', []))

        # Reconstruct nested dataclasses
        if 'extraction_stats' in data:
            data['extraction_stats'] = ProcessingStats(**data['extraction_stats'])
        if 'chunking_stats' in data:
            data['chunking_stats'] = ProcessingStats(**data['chunking_stats'])
        if 'embedding_stats' in data:
            data['embedding_stats'] = ProcessingStats(**data['embedding_stats'])

        return cls(**data)


class PyMuPDF4LLMPipeline:
    """Production-ready pipeline orchestrator for pymupdf4llm"""

    def __init__(
        self,
        metadata_jsonl: str,
        pdfs_dir: str,
        output_dir: str,
        workers: int = 8,
        limit: Optional[int] = None,
        resume: bool = False,
        max_retries: int = 3,
        checkpoint_interval: int = 100,
        validate_outputs: bool = True
    ):
        self.metadata_jsonl = Path(metadata_jsonl)
        self.pdfs_dir = Path(pdfs_dir)
        self.output_dir = Path(output_dir)
        self.workers = workers
        self.limit = limit
        self.max_retries = max_retries
        self.checkpoint_interval = checkpoint_interval
        self.validate_outputs = validate_outputs

        # Validate inputs
        if not self.metadata_jsonl.exists():
            raise FileNotFoundError(f"Metadata file not found: {self.metadata_jsonl}")
        if not self.pdfs_dir.exists():
            raise FileNotFoundError(f"PDFs directory not found: {self.pdfs_dir}")

        # Create output directories
        self.extracted_dir = self.output_dir / "extracted"
        self.chunks_dir = self.output_dir / "chunks"
        self.errors_dir = self.output_dir / "errors"
        self.extracted_dir.mkdir(parents=True, exist_ok=True)
        self.chunks_dir.mkdir(parents=True, exist_ok=True)
        self.errors_dir.mkdir(parents=True, exist_ok=True)

        # Checkpoint path
        self.checkpoint_path = self.output_dir / "checkpoint_pymupdf4llm.json"

        # Load cases
        self.cases = self._load_cases()
        logger.info(f"Loaded {len(self.cases)} cases from {self.metadata_jsonl}")

        # Load R2 URL mappings (if available)
        self.r2_url_mapping = self._load_r2_mappings()

        # Initialize or resume progress
        if resume and self.checkpoint_path.exists():
            self.progress = PipelineProgress.load(self.checkpoint_path)
            logger.info(f"Resuming from checkpoint: {self.progress.processed_cases}/{self.progress.total_cases} cases")
            logger.info(f"Extracted: {len(self.progress.extracted_files)}, Chunked: {len(self.progress.chunked_files)}")
        else:
            self.progress = PipelineProgress(
                started_at=datetime.now().isoformat(),
                last_updated=datetime.now().isoformat(),
                last_checkpoint_at=datetime.now().isoformat(),
                total_cases=len(self.cases)
            )

    def _load_cases(self) -> List[Dict]:
        """Load all cases from JSONL with validation"""
        cases = []
        line_num = 0

        with open(self.metadata_jsonl, 'r', encoding='utf-8') as f:
            for line in f:
                line_num += 1
                try:
                    case = json.loads(line.strip())

                    # Validate required fields
                    if not case.get('case_id'):
                        logger.warning(f"Line {line_num}: Missing case_id, skipping")
                        continue

                    # Validate pdf_paths structure
                    pdf_paths = case.get('pdf_paths', {})
                    if not pdf_paths:
                        logger.warning(f"Line {line_num}: case_id={case['case_id']}, missing pdf_paths")
                        continue

                    cases.append(case)

                except json.JSONDecodeError as e:
                    logger.error(f"Line {line_num}: Invalid JSON: {e}")
                    continue

        # Apply limit if specified
        if self.limit:
            cases = cases[:self.limit]
            logger.info(f"Limited to {self.limit} cases for testing")

        return cases

    def _load_r2_mappings(self) -> Dict:
        """Load R2 URL mappings (if available)"""
        r2_mapping_path = self.output_dir / "r2-url-mappings.jsonl"

        if not r2_mapping_path.exists():
            logger.warning("R2 URL mappings not found - PDF highlighting will use local paths")
            return {}

        mappings = {}
        try:
            with open(r2_mapping_path, 'r', encoding='utf-8') as f:
                for line in f:
                    data = json.loads(line.strip())
                    if 'case_id' in data:
                        mappings[data['case_id']] = data
        except Exception as e:
            logger.error(f"Error loading R2 mappings: {e}")
            return {}

        logger.info(f"Loaded {len(mappings)} R2 URL mappings")
        return mappings

    def _get_pdf_path(self, case: Dict, language: str = 'english') -> Optional[Path]:
        """Get PDF path for a case and language with robust error handling"""
        pdf_paths = case.get('pdf_paths', {})

        # Handle dict format (new metadata structure)
        if isinstance(pdf_paths, dict):
            if language == 'english':
                target_path = pdf_paths.get('english', '')
            else:
                # Regional PDFs use glob pattern, resolve it
                regional_pattern = pdf_paths.get('regional', '')
                if regional_pattern and '*' in regional_pattern:
                    # Convert pattern to specific language file
                    # e.g., pdf/regional/1950/1950_1_806_821_*.pdf -> pdf/regional/1950/1950_1_806_821_HIN.pdf
                    target_path = regional_pattern.replace('*', language.upper())
                else:
                    target_path = ''
        # Handle list format (legacy metadata structure)
        elif isinstance(pdf_paths, list):
            if language == 'english':
                english_pdfs = [p for p in pdf_paths if '_EN.pdf' in p]
                target_path = english_pdfs[0] if english_pdfs else ''
            else:
                lang_suffix = f'_{language.upper()}.pdf'
                lang_pdfs = [p for p in pdf_paths if lang_suffix in p]
                target_path = lang_pdfs[0] if lang_pdfs else ''
        else:
            logger.warning(f"Invalid pdf_paths format for {case.get('case_id')}: {type(pdf_paths)}")
            return None

        if not target_path:
            return None

        # Try direct path first
        pdf_path = self.pdfs_dir / target_path
        if pdf_path.exists():
            return pdf_path

        # Try without base directory (path might be absolute)
        alt_path = Path(target_path)
        if alt_path.exists():
            return alt_path

        # Don't warn for regional languages (many cases don't have all languages)
        if language == 'english':
            logger.warning(f"PDF not found for {case.get('case_id')}: {target_path}")
        return None

    def _get_all_pdf_paths(self, case: Dict) -> List[Tuple[str, Path]]:
        """Get all available PDF paths for a case (English + regional languages)

        Returns:
            List of (language_code, pdf_path) tuples
        """
        available_pdfs = []

        # Always try English first
        english_path = self._get_pdf_path(case, 'english')
        if english_path:
            available_pdfs.append(('EN', english_path))

        # Regional language codes (from file naming convention)
        regional_languages = [
            'HIN',  # Hindi
            'PUN',  # Punjabi
            'BEN',  # Bengali
            'GUJ',  # Gujarati
            'TAM',  # Tamil
            'MAL',  # Malayalam
            'MAR',  # Marathi
            'URD',  # Urdu
            'TEL',  # Telugu
            'KAN',  # Kannada
            'ORI',  # Odia
            'ASM',  # Assamese
            'NEP',  # Nepali
            'SAN',  # Sanskrit
            'KOK',  # Konkani
        ]

        for lang_code in regional_languages:
            lang_path = self._get_pdf_path(case, lang_code)
            if lang_path:
                available_pdfs.append((lang_code, lang_path))

        return available_pdfs

    def _validate_extracted_file(self, output_path: Path) -> bool:
        """Validate extracted JSON file"""
        try:
            if not output_path.exists():
                return False

            if output_path.stat().st_size == 0:
                logger.error(f"Empty file: {output_path}")
                return False

            with open(output_path, 'r') as f:
                data = json.load(f)

            # Validate required fields
            required_fields = ['text', 'pages', 'page_count', 'supports_positions', 'parser_name']
            for field in required_fields:
                if field not in data:
                    logger.error(f"Missing field '{field}' in {output_path}")
                    return False

            # Validate content
            if not data['text'] or len(data['text']) < 100:
                logger.error(f"Insufficient text extracted: {output_path}")
                return False

            if not data['pages'] or data['page_count'] == 0:
                logger.error(f"No pages extracted: {output_path}")
                return False

            if not data['supports_positions']:
                logger.error(f"Positions not supported: {output_path}")
                return False

            return True

        except Exception as e:
            logger.error(f"Validation error for {output_path}: {e}")
            return False

    def _validate_chunks_file(self, chunks_path: Path) -> bool:
        """Validate chunks JSONL file"""
        try:
            if not chunks_path.exists():
                return False

            if chunks_path.stat().st_size == 0:
                logger.error(f"Empty chunks file: {chunks_path}")
                return False

            chunk_count = 0
            with open(chunks_path, 'r') as f:
                for line in f:
                    chunk = json.loads(line.strip())

                    # Validate required fields
                    required_fields = ['chunk_id', 'text', 'char_start', 'char_end', 'page_start', 'page_end']
                    for field in required_fields:
                        if field not in chunk:
                            logger.error(f"Missing field '{field}' in chunk: {chunks_path}")
                            return False

                    chunk_count += 1

            if chunk_count == 0:
                logger.error(f"No chunks in file: {chunks_path}")
                return False

            return True

        except Exception as e:
            logger.error(f"Validation error for {chunks_path}: {e}")
            return False

    def phase1_extract(self):
        """Phase 1: Extract PDFs with pymupdf4llm (robust with retries)

        Processes ALL language variants (English + regional) for multilingual embeddings.
        Each language variant gets its own extracted JSON with language code suffix.
        """
        logger.info("=" * 80)
        logger.info("PHASE 1: EXTRACTION (pymupdf4llm with multilingual support)")
        logger.info("=" * 80)

        # Prepare work items (skip already extracted and validated)
        work_items = []
        lang_counts = {}

        for case in self.cases:
            case_id = case['case_id']

            # Get all available PDFs for this case (English + regional)
            all_pdfs = self._get_all_pdf_paths(case)

            if not all_pdfs:
                self.progress.extraction_stats.add_error('no_pdf', case_id, "No PDF files found")
                self.progress.extraction_failures.add(case_id)
                continue

            for lang_code, pdf_path in all_pdfs:
                # Create unique ID for each language variant
                doc_id = f"{case_id}_{lang_code}"

                # Skip if already successfully extracted
                if doc_id in self.progress.extracted_files:
                    self.progress.extraction_stats.skipped += 1
                    continue

                # Skip if failed max retries
                if doc_id in self.progress.extraction_failures:
                    continue

                output_path = self.extracted_dir / f"{doc_id}.extracted.json"

                # Validate existing file
                if output_path.exists() and self.validate_outputs:
                    if self._validate_extracted_file(output_path):
                        self.progress.extracted_files.add(doc_id)
                        self.progress.extraction_stats.skipped += 1
                        continue
                    else:
                        logger.warning(f"Removing invalid extracted file: {output_path}")
                        output_path.unlink()

                # Include language code in work item for metadata
                work_items.append((doc_id, str(pdf_path), str(output_path), lang_code))
                lang_counts[lang_code] = lang_counts.get(lang_code, 0) + 1

        self.progress.extraction_stats.total_files = len(work_items)

        if not work_items:
            logger.info("✓ All PDFs already extracted and validated!")
            return

        logger.info(f"Found {len(work_items)} PDFs to extract")
        logger.info(f"Language distribution: {dict(sorted(lang_counts.items(), key=lambda x: -x[1]))}")
        logger.info(f"Using {self.workers} workers with {self.max_retries} max retries")

        # Process in parallel with progress tracking
        start_time = time.time()
        processed_count = 0

        with mp.Pool(self.workers) as pool:
            for result in pool.imap_unordered(self._extract_worker, work_items):
                case_id, success, stats_update = result
                processed_count += 1

                if success:
                    self.progress.extracted_files.add(case_id)
                    self.progress.extraction_stats.successful += 1

                    # Update stats
                    if stats_update:
                        self.progress.extraction_stats.total_pages += stats_update.get('pages', 0)
                        self.progress.extraction_stats.total_size_bytes += stats_update.get('size_bytes', 0)
                        # Track retries
                        if stats_update.get('retries', 0) > 0:
                            self.progress.extraction_stats.retried += 1
                else:
                    self.progress.extraction_failures.add(case_id)
                    self.progress.extraction_stats.failed += 1

                # Checkpoint periodically
                if processed_count % self.checkpoint_interval == 0:
                    self.progress.last_updated = datetime.now().isoformat()
                    self.progress.last_checkpoint_at = datetime.now().isoformat()
                    self.progress.save(self.checkpoint_path)

                    # Calculate timing and ETA
                    elapsed = time.time() - start_time
                    rate = processed_count / elapsed if elapsed > 0 else 0
                    remaining = len(work_items) - processed_count
                    eta_seconds = remaining / rate if rate > 0 else 0

                    elapsed_str = f"{int(elapsed // 3600)}h {int((elapsed % 3600) // 60)}m {int(elapsed % 60)}s"
                    eta_str = f"{int(eta_seconds // 3600)}h {int((eta_seconds % 3600) // 60)}m {int(eta_seconds % 60)}s"

                    logger.info(
                        f"📊 Extract: {processed_count:,}/{len(work_items):,} ({processed_count/len(work_items)*100:.1f}%) | "
                        f"⏱️ {elapsed_str} elapsed | ETA: {eta_str} | "
                        f"🚀 {rate:.2f} files/sec"
                    )

        self.progress.extraction_stats.processing_time_sec = time.time() - start_time
        self.progress.current_phase = "extract_complete"
        self.progress.save(self.checkpoint_path)

        logger.info("\n" + "=" * 80)
        logger.info("PHASE 1 COMPLETE")
        logger.info("=" * 80)
        logger.info(self.progress.extraction_stats.get_summary())

    @staticmethod
    def _extract_worker(work_item: Tuple[str, str, str, str]) -> Tuple[str, bool, Optional[Dict]]:
        """Worker function for parallel extraction with retry logic

        Args:
            work_item: (doc_id, pdf_path, output_path, lang_code)
                       doc_id format: {case_id}_{lang_code} (e.g., 1950_INSC_25_EN, 1950_INSC_25_HIN)
        """
        doc_id, pdf_path, output_path, lang_code = work_item

        retries = 0
        max_retries = 3

        while retries <= max_retries:
            try:
                # Import parser in worker (avoid pickling issues)
                sys.path.insert(0, str(Path(__file__).parent))
                from parsers.pymupdf4llm_parser import extract_with_pymupdf4llm

                result = extract_with_pymupdf4llm(pdf_path)

                if "error" in result:
                    raise Exception(result['error'])

                # Add language metadata to extracted result
                result['language_code'] = lang_code
                result['doc_id'] = doc_id
                # Extract case_id from doc_id (remove _LANG suffix)
                result['case_id'] = '_'.join(doc_id.split('_')[:-1])

                # Write output atomically
                temp_path = Path(output_path).with_suffix('.json.tmp')
                with open(temp_path, 'w', encoding='utf-8') as f:
                    json.dump(result, f, ensure_ascii=False, indent=2)
                temp_path.rename(output_path)

                # Collect stats (including retry count for tracking)
                stats = {
                    'pages': result['page_count'],
                    'size_bytes': len(result['text']),
                    'language': lang_code,
                    'retries': retries  # Track how many retries were needed
                }

                if retries > 0:
                    logger.info(f"✓ {doc_id} [{lang_code}]: {result['page_count']} pages, {len(result['text']):,} chars (after {retries} retries)")
                else:
                    logger.info(f"✓ {doc_id} [{lang_code}]: {result['page_count']} pages, {len(result['text']):,} chars")
                return (doc_id, True, stats)

            except Exception as e:
                retries += 1
                if retries > max_retries:
                    logger.error(f"✗ {doc_id} [{lang_code}]: Failed after {max_retries} retries: {e}")

                    # Save error details
                    error_file = Path(__file__).parent.parent / "data" / "rag-output" / "errors" / f"{doc_id}.error.txt"
                    error_file.parent.mkdir(parents=True, exist_ok=True)
                    with open(error_file, 'w') as f:
                        f.write(f"Error extracting {doc_id}\n")
                        f.write(f"Language: {lang_code}\n")
                        f.write(f"PDF: {pdf_path}\n")
                        f.write(f"Error: {str(e)}\n")
                        f.write(f"\nTraceback:\n{traceback.format_exc()}")

                    return (doc_id, False, None)

                # Exponential backoff
                wait_time = 2 ** retries
                logger.warning(f"⚠️  {doc_id}: Retry {retries}/{max_retries} after {wait_time}s: {e}")

                # Log warning to file for tracking transient issues
                warnings_file = Path(__file__).parent.parent / "data" / "rag-output" / "warnings.log"
                warnings_file.parent.mkdir(parents=True, exist_ok=True)
                with open(warnings_file, 'a') as f:
                    f.write(f"{datetime.now().isoformat()} | {doc_id} | Retry {retries}/{max_retries} | {str(e)[:200]}\n")

                time.sleep(wait_time)

        return (doc_id, False, None)

    def phase2_chunk(self):
        """Phase 2: Chunk with character-level positions (robust with validation)

        Handles multilingual documents: doc_id format is {case_id}_{lang_code}
        e.g., 1950_INSC_25_EN, 1950_INSC_25_HIN
        """
        logger.info("\n" + "=" * 80)
        logger.info("PHASE 2: CHUNKING (character-level position metadata)")
        logger.info("=" * 80)

        # Find successfully extracted files (doc_id includes language code)
        extracted_files = [
            self.extracted_dir / f"{doc_id}.extracted.json"
            for doc_id in self.progress.extracted_files
        ]

        logger.info(f"Found {len(extracted_files)} successfully extracted files")

        # Prepare work items (skip already chunked and validated)
        work_items = []
        for extracted_file in extracted_files:
            doc_id = extracted_file.stem.replace(".extracted", "")

            # Skip if already chunked
            if doc_id in self.progress.chunked_files:
                self.progress.chunking_stats.skipped += 1
                continue

            # Skip if failed chunking before
            if doc_id in self.progress.chunking_failures:
                continue

            chunks_file = self.chunks_dir / f"{doc_id}.chunks.jsonl"

            # Validate existing chunks
            if chunks_file.exists() and self.validate_outputs:
                if self._validate_chunks_file(chunks_file):
                    self.progress.chunked_files.add(doc_id)
                    self.progress.chunking_stats.skipped += 1
                    continue
                else:
                    logger.warning(f"Removing invalid chunks file: {chunks_file}")
                    chunks_file.unlink()

            work_items.append((str(extracted_file), doc_id, str(chunks_file)))

        self.progress.chunking_stats.total_files = len(work_items)

        if not work_items:
            logger.info("✓ All files already chunked and validated!")
            return

        logger.info(f"Chunking {len(work_items)} files")
        logger.info(f"Using {self.workers} workers")

        # Process in parallel
        start_time = time.time()
        processed_count = 0

        with mp.Pool(self.workers) as pool:
            work_with_metadata = [
                (item, str(self.metadata_jsonl), self.r2_url_mapping)
                for item in work_items
            ]

            for result in pool.imap_unordered(self._chunk_worker, work_with_metadata):
                doc_id, success, stats_update = result
                processed_count += 1

                if success:
                    self.progress.chunked_files.add(doc_id)
                    self.progress.chunking_stats.successful += 1

                    if stats_update:
                        self.progress.chunking_stats.total_chunks += stats_update.get('chunk_count', 0)
                        self.progress.chunking_stats.total_words += stats_update.get('word_count', 0)
                else:
                    self.progress.chunking_failures.add(doc_id)
                    self.progress.chunking_stats.failed += 1

                # Checkpoint periodically
                if processed_count % self.checkpoint_interval == 0:
                    self.progress.last_updated = datetime.now().isoformat()
                    self.progress.last_checkpoint_at = datetime.now().isoformat()
                    self.progress.save(self.checkpoint_path)

                    # Calculate timing and ETA
                    elapsed = time.time() - start_time
                    rate = processed_count / elapsed if elapsed > 0 else 0
                    remaining = len(work_items) - processed_count
                    eta_seconds = remaining / rate if rate > 0 else 0

                    elapsed_str = f"{int(elapsed // 3600)}h {int((elapsed % 3600) // 60)}m {int(elapsed % 60)}s"
                    eta_str = f"{int(eta_seconds // 3600)}h {int((eta_seconds % 3600) // 60)}m {int(eta_seconds % 60)}s"

                    logger.info(
                        f"📊 Chunk: {processed_count:,}/{len(work_items):,} ({processed_count/len(work_items)*100:.1f}%) | "
                        f"⏱️ {elapsed_str} elapsed | ETA: {eta_str} | "
                        f"🚀 {rate:.2f} files/sec"
                    )

        self.progress.chunking_stats.processing_time_sec = time.time() - start_time
        self.progress.current_phase = "chunk_complete"
        self.progress.save(self.checkpoint_path)

        logger.info("\n" + "=" * 80)
        logger.info("PHASE 2 COMPLETE")
        logger.info("=" * 80)
        logger.info(self.progress.chunking_stats.get_summary())

    @staticmethod
    def _chunk_worker(work_tuple: Tuple) -> Tuple[str, bool, Optional[Dict]]:
        """Worker function for parallel chunking with validation

        Handles multilingual documents: doc_id format is {case_id}_{lang_code}
        e.g., 1950_INSC_25_EN, 1950_INSC_25_HIN
        """
        work_item, metadata_jsonl, r2_mapping = work_tuple
        extracted_file, doc_id, chunks_file = work_item

        retries = 0
        max_retries = 2  # Fewer retries for chunking (deterministic operation)

        while retries <= max_retries:
            try:
                # Load chunking module in worker
                sys.path.insert(0, str(Path(__file__).parent))
                chunk_script = Path(__file__).parent / "chunk-judgment-pymupdf4llm.py"

                import importlib.util
                spec = importlib.util.spec_from_file_location("chunk_module", chunk_script)
                chunk_module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(chunk_module)

                # Load extracted data (includes language_code, case_id from extraction phase)
                with open(extracted_file, 'r', encoding='utf-8') as f:
                    extracted = json.load(f)

                # Get language code and case_id from extracted data
                lang_code = extracted.get('language_code', 'EN')
                case_id = extracted.get('case_id', '_'.join(doc_id.split('_')[:-1]))

                # Load metadata using original case_id (without language suffix)
                metadata = chunk_module.merge_metadata(metadata_jsonl, case_id)
                if not metadata:
                    raise Exception(f"Metadata not found for {case_id}")

                metadata['case_id'] = case_id
                metadata['doc_id'] = doc_id
                metadata['language_code'] = lang_code

                # Chunk
                chunks = chunk_module.chunk_with_char_positions(
                    extracted,
                    metadata,
                    r2_url_mapping=r2_mapping
                )

                if not chunks:
                    raise Exception(f"No chunks generated for {doc_id}")

                # Write output atomically
                temp_path = Path(chunks_file).with_suffix('.jsonl.tmp')
                with open(temp_path, 'w', encoding='utf-8') as f:
                    for chunk in chunks:
                        f.write(json.dumps(chunk, ensure_ascii=False) + "\n")
                temp_path.rename(chunks_file)

                # Collect stats
                stats = {
                    'chunk_count': len(chunks),
                    'word_count': sum(len(c['text'].split()) for c in chunks)
                }

                avg_words = stats['word_count'] // len(chunks)
                logger.info(f"✓ {doc_id}: {len(chunks)} chunks, avg {avg_words} words/chunk")
                return (doc_id, True, stats)

            except Exception as e:
                retries += 1
                if retries > max_retries:
                    logger.error(f"✗ {doc_id}: Failed chunking after {max_retries} retries: {e}")

                    # Save error
                    error_file = Path(__file__).parent.parent / "data" / "rag-output" / "errors" / f"{doc_id}_chunking.error.txt"
                    error_file.parent.mkdir(parents=True, exist_ok=True)
                    with open(error_file, 'w') as f:
                        f.write(f"Error chunking {doc_id}\n")
                        f.write(f"Extracted file: {extracted_file}\n")
                        f.write(f"Error: {str(e)}\n")
                        f.write(f"\nTraceback:\n{traceback.format_exc()}")

                    return (doc_id, False, None)

                time.sleep(1)  # Brief pause before retry

        return (doc_id, False, None)

    def phase3_embed_and_upload(self):
        """Phase 3: Embed and upload to Qdrant"""
        logger.info("\n" + "=" * 80)
        logger.info("PHASE 3: EMBED & UPLOAD (Voyage AI → Qdrant)")
        logger.info("=" * 80)
        logger.warning("⚠️  This phase requires:")
        logger.warning("   1. VOYAGE_API_KEY environment variable")
        logger.warning("   2. Qdrant Cloud credentials (QDRANT_URL, QDRANT_API_KEY)")
        logger.warning("   3. embed-and-ingest.py script")
        logger.warning("\nTo run this phase:")
        logger.warning("   python scripts/rag/embed-and-ingest.py \\")
        logger.warning("     --chunks-dir data/rag-output/chunks \\")
        logger.warning("     --collection supreme_court_chunks \\")
        logger.warning("     --batch-size 64")

    def run(self):
        """Run complete pipeline with comprehensive error handling"""
        start_time = datetime.now()

        try:
            logger.info("\n" + "=" * 80)
            logger.info("RAG PIPELINE: pymupdf4llm (Word-Level Positions)")
            logger.info("=" * 80)
            logger.info(f"Total cases: {len(self.cases)}")
            logger.info(f"Workers: {self.workers}")
            logger.info(f"Max retries: {self.max_retries}")
            logger.info(f"Checkpoint interval: {self.checkpoint_interval}")
            logger.info(f"Output dir: {self.output_dir}")
            logger.info(f"Checkpoint: {self.checkpoint_path}")
            logger.info(f"Validate outputs: {self.validate_outputs}")

            # Run phases
            self.phase1_extract()
            self.phase2_chunk()
            self.phase3_embed_and_upload()

            # Mark complete
            self.progress.current_phase = "complete"
            self.progress.last_updated = datetime.now().isoformat()
            self.progress.save(self.checkpoint_path)

        except KeyboardInterrupt:
            logger.warning("\n⚠️  Pipeline interrupted by user")
            self.progress.last_updated = datetime.now().isoformat()
            self.progress.save(self.checkpoint_path)
            logger.info(f"Progress saved to: {self.checkpoint_path}")
            logger.info("Resume with: --resume flag")
            sys.exit(1)

        except Exception as e:
            logger.error(f"Pipeline error: {e}")
            logger.error(traceback.format_exc())
            self.progress.last_updated = datetime.now().isoformat()
            self.progress.save(self.checkpoint_path)
            raise

        # Final summary
        elapsed = datetime.now() - start_time
        logger.info("\n" + "=" * 80)
        logger.info("PIPELINE COMPLETE")
        logger.info("=" * 80)
        logger.info(f"Total time: {elapsed}")
        logger.info(f"\nExtraction:")
        logger.info(self.progress.extraction_stats.get_summary())
        logger.info(f"\nChunking:")
        logger.info(self.progress.chunking_stats.get_summary())
        logger.info(f"\nOutput:")
        logger.info(f"  Extracted: {self.extracted_dir}")
        logger.info(f"  Chunks: {self.chunks_dir}")
        logger.info(f"  Errors: {self.errors_dir}")
        logger.info(f"  Checkpoint: {self.checkpoint_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Production RAG Pipeline with pymupdf4llm",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--metadata", default="data/aws-supreme-court-judgments/extracted/metadata/all_cases.jsonl",
                        help="Path to all_cases.jsonl")
    parser.add_argument("--pdfs", default="data/aws-supreme-court-judgments/extracted",
                        help="Base directory containing PDFs (paths in metadata are relative to this)")
    parser.add_argument("--output", default="data/rag-output",
                        help="Output directory for extracted/chunked data")
    parser.add_argument("--workers", type=int, default=8,
                        help="Number of parallel workers (default: 8)")
    parser.add_argument("--limit", type=int,
                        help="Limit number of PDFs to process (for testing)")
    parser.add_argument("--resume", action="store_true",
                        help="Resume from checkpoint")
    parser.add_argument("--max-retries", type=int, default=3,
                        help="Maximum retries per file (default: 3)")
    parser.add_argument("--checkpoint-interval", type=int, default=100,
                        help="Save checkpoint every N files (default: 100)")
    parser.add_argument("--no-validate", action="store_true",
                        help="Disable output validation")

    args = parser.parse_args()

    pipeline = PyMuPDF4LLMPipeline(
        metadata_jsonl=args.metadata,
        pdfs_dir=args.pdfs,
        output_dir=args.output,
        workers=args.workers,
        limit=args.limit,
        resume=args.resume,
        max_retries=args.max_retries,
        checkpoint_interval=args.checkpoint_interval,
        validate_outputs=not args.no_validate
    )

    pipeline.run()


if __name__ == "__main__":
    main()
