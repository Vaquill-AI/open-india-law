---
name: High Court RAG Reference
description: Reference for High Court RAG pipeline data locations, scripts, optimizations, and Azure VM paths for 1M+ extracted legal documents
---

# High Court RAG Pipeline Reference

Use this skill when the user asks about High Court data locations, extraction results, chunking pipeline, or RAG infrastructure.

## Azure VM Access

**IP**: <extraction-host>
**SSH**: `ssh -i ~/Desktop/Projects/vaquill-all/news/test-1-azure_key.pem <extraction-host-user>@<extraction-host>`

## Data Locations

### Original Parsed Files
- **Path**: `<extraction-host>:/highcourt-rag/data/highcourt-rag/parsed/`
- **Count**: 16,284,259 JSON files
- **Format**: `{CNR}.parsed.json`

### OCR Re-extracted Files
- **Path**: `<extraction-host>:/highcourt-rag/ocr-reextracted/extracted/`
- **Count**: 1,058,014 JSON files (84.4% of corrupted PDFs)
- **Format**: `{CNR}.json`

### Failed/Corrupted PDFs
- **Path**: `<extraction-host>:/highcourt-rag/ocr-reextracted/failed-pdfs-complete.txt`
- **Count**: 203,120 PDFs (16.2% - bandwriter errors)

### Source PDFs
- **Path**: `<extraction-host>:/highcourt-rag/pdfs-for-ocr/`
- **Total**: 1,254,249 PDFs (corrupted subset needing OCR re-extraction)
- **Structure**: `year=YYYY/court=X_Y/bench=NAME/FILE.pdf`

## Core Scripts

### Parser (Local)
- **Path**: `scripts/rag/highcourt/pymupdf4llm_parser.py`
- **Features**: PyMuPDF Pro + Layout mode, OCR with `ocr_dpi=200` optimization

### Chunking (Local & Azure)
- **Local**: `scripts/rag/legal_chunker.py`
- **Azure**: `<extraction-host>:/highcourt-rag/legal_chunker.py`

### Metadata Extraction
- **Path**: `scripts/rag/highcourt/metadata_extractor_v3.py`
- **Extracts**: 20+ legal fields (judge, parties, citations, etc.)

### Pipeline Scripts (Azure)
- **File-list mode**: `<extraction-host>:/highcourt-rag/run-pipeline-file-list.py`
- **Court structure**: `<extraction-host>:/highcourt-rag/run-pipeline-court-structure.py`

## Optimizations Applied (Jan 2026)

### OCR Optimization
- **Parameter**: `ocr_dpi=200` (down from 400)
- **Impact**: 65% faster (302/min → 517/min)

### Threading
- **Variable**: `OMP_THREAD_LIMIT=1`
- **Impact**: 3x faster (prevents Tesseract thread explosion)

### Workers
- **Count**: 64 (matches CPU cores)
- **Type**: ProcessPoolExecutor (bypasses GIL)

## Key Commands

### Check extraction count
```bash
# Original parsed
find ~/highcourt-rag/data/highcourt-rag/parsed -name '*.json' | wc -l

# OCR re-extracted
find ~/highcourt-rag/ocr-reextracted/extracted -name '*.json' | wc -l
```

### Monitor pipeline
```bash
tail -f ~/highcourt-rag/ocr.log | grep 'Progress:'
```

### Check workers
```bash
ps aux | grep python | grep pipeline | wc -l
```

## Performance Results (OCR Re-extraction)

- **Total Corrupted PDFs**: 1,254,249
- **Successful**: 1,058,014 (84.4%)
- **Failed**: 203,120 (16.2%)
- **Speed**: 517-540 files/min
- **Duration**: 1.2 days (optimized) vs 2.8 days (unoptimized)

## Next Steps

1. Compare metadata between original parsed and OCR re-extracted files
2. Merge/deduplicate datasets
3. Chunk combined dataset with legal chunker
4. Extract metadata (20+ legal fields)
5. Generate vector embeddings
6. Ingest into Supabase vector database

## File Naming: CNR Format

**Format**: `{COURT}{SEQUENCE}{YEAR}_{VERSION}_{DATE}.pdf`
**Example**: `PHHC010558422003_1_2015-11-03.pdf`
- PHHC: Punjab & Haryana High Court
- 01055842: Sequence number
- 2003: Filing year
- 1: Version
- 2015-11-03: Decision date
