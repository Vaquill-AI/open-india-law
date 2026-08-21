# Unified Chunking Schema for Indian Legal RAG Pipeline

## Overview

This document describes the unified chunking schema used for both Supreme Court and High Court judgments in the Indian Legal RAG pipeline. Both court types share a common schema, enabling them to be stored in the **same Qdrant collection** for unified search.

## Architecture

```
scripts/rag/
├── legal_section_detector.py   # Shared section detection (15+ patterns)
├── legal_chunker.py            # Shared chunking config and utilities
├── chunk-judgment-pymupdf4llm.py  # Supreme Court chunking (uses shared modules)
└── highcourt/
    └── run-pipeline-court-structure.py  # High Court chunking (uses shared modules)
```

## Configuration Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `CHUNK_SIZE` | 4096 | ~1024 tokens (4 chars/token average) |
| `CHUNK_OVERLAP` | 512 | ~128 tokens (12.5% overlap) |
| `MIN_CHUNK_SIZE` | 300 | Minimum chunk size to keep (unified for SC and HC) |

### Text Separators (in order of priority)

```python
TEXT_SEPARATORS = [
    "\n\n\n",    # Triple newline (major section break)
    "\n\n",      # Double newline (paragraph break)
    "\n",        # Single newline (line break)
    ". ",        # Sentence end
    " ",         # Word break
    ""           # Character level (last resort)
]
```

## Unified Chunk Schema

### Common Fields (All Courts)

| Field | Type | Description |
|-------|------|-------------|
| `chunk_id` | string | Unique chunk identifier: `{doc_id}_{index:03d}` |
| `case_id` | string | Case identifier (e.g., "SC_2024_1234" or "WPHC123456") |
| `doc_id` | string | Document ID (same as case_id, or `{case_id}_{lang}` for multilingual) |
| `text` | string | Chunk text with contextual header (for BM25) |
| `text_original` | string | Clean chunk text without header (for dense embedding) |
| `title` | string | Case title |
| `pdf_url` | string | Primary PDF URL for highlighting |
| `char_start` | int | Start character offset in document |
| `char_end` | int | End character offset in document |
| `page_start` | int | Start page number |
| `page_end` | int | End page number |
| `chunk_index` | int | Index of chunk in document |
| `total_chunks` | int | Total chunks in document |
| `section_type` | string | Detected section type (see Section Types) |
| `section_priority` | int | Priority score 0-100 (for retrieval boosting) |
| `citation` | string | Case citation |
| `case_number` | string | Case number |
| `year` | int | Year of decision |
| `decision_date` | string | Date of decision (ISO format) |
| `court` | string | Court name |
| `petitioner` | string | Petitioner name |
| `respondent` | string | Respondent name |
| `judges` | array | List of judge names |
| `bench_strength` | int | Number of judges |
| `disposition` | string | Case disposition/outcome |
| `court_type` | string | "supreme_court" or "high_court" |
| `data_source` | string | "supreme_court_india" or "high_court_india" |

### Supreme Court Specific Fields

| Field | Type | Description |
|-------|------|-------------|
| `language_code` | string | Language code ("EN", "HI", etc.) |
| `pdf_urls` | dict | Dict of language -> PDF URL for multilingual |
| `petitioner_array` | array | Full list of petitioner names |
| `respondent_array` | array | Full list of respondent names |
| `diary_number` | string | SC diary number |
| `bench_type` | string | Bench type (e.g., "Division Bench") |
| `case_type` | string | Case type (e.g., "Civil Appeal") |
| `acts_referenced` | array | Acts referenced in the judgment |
| `cases_cited` | array | Cases cited in the judgment |
| `cited_by_count` | int | Number of times cited by other cases |

### High Court Specific Fields

| Field | Type | Description |
|-------|------|-------------|
| `state_code` | string | State code (e.g., "27" for Maharashtra) |
| `establishment_code` | string | Establishment code |
| `state_name` | string | State name |
| `court_code` | string | Court code (e.g., "27_1") |
| `bench` | string | Bench identifier |
| `bench_display_name` | string | Human-readable bench name |
| `description` | string | Case description (~200 chars) |
| `date_of_registration` | string | Filing date |
| `r2_key` | string | R2 storage key |

## Section Types (15 Categories)

Section detection uses 15+ regex patterns and content-based heuristics:

| Section Type | Priority | Description |
|--------------|----------|-------------|
| `ratio_decidendi` | 100 | Core legal reasoning (binding precedent) |
| `conclusion` | 95 | Final decision |
| `judgment` | 90 | Main judgment section |
| `analysis` | 85 | Court's reasoning/discussion |
| `issues` | 80 | Questions for determination |
| `obiter_dicta` | 75 | Non-binding observations |
| `arguments` | 70 | Party submissions |
| `facts` | 65 | Factual background |
| `precedents` | 60 | Cases cited |
| `relief` | 55 | Relief sought |
| `statutes` | 50 | Acts/provisions referenced |
| `procedure` | 45 | Procedural history |
| `header` | 40 | Court identification |
| `paragraph` | 35 | Numbered paragraphs |
| `section` | 35 | Lettered sections |
| `body` | 30 | Default for unclassified |

### Section Priority Boosting

Section priority scores (0-100) can be used for:
- **Retrieval boosting**: Multiply relevance scores by `section_priority/100`
- **Filtering**: Use `is_important_section(section_type, threshold=70)` to filter
- **Ranking**: Sort by section priority for presentation

## Text Fields Strategy

### Two-Text Strategy for Hybrid Search

| Field | Content | Use Case |
|-------|---------|----------|
| `text` | With contextual header | BM25 sparse search (party names, citations searchable) |
| `text_original` | Clean text without header | Dense embedding (no header pollution) |

### Contextual Header Format

**Supreme Court:**
```
Case: ABC v. State of Maharashtra [2024 SCC 567] (2024)
Section: RATIO_DECIDENDI

{actual chunk content}
```

**High Court:**
```
Case: Petitioner vs Respondent [2024 BHC 890] (2024)
Court: Bombay High Court
Section: ANALYSIS

{actual chunk content}
```

## O(n) Character Position Search

The chunking uses O(n) character position search instead of O(n²):

```python
search_start = 0  # Running offset

for i, chunk_text in enumerate(text_chunks):
    # O(n) search: start from running offset, not beginning
    char_start = full_text.find(chunk_text, search_start)

    if char_start == -1:
        # Fallback: search from beginning
        char_start = full_text.find(chunk_text)

    # Move window forward for next iteration
    search_start = char_start + 1
```

This is critical for 100+ page judgments where O(n²) would be too slow.

## R2 Storage Configuration

| Court Type | Public Base URL | Data Source |
|------------|-----------------|-------------|
| Supreme Court | `${R2_PUBLIC_BASE_URL}` | `supreme_court_india` |
| High Court | `${R2_PUBLIC_BASE_URL}` | `high_court_india` |

## Usage Examples

### Import Shared Modules

```python
from legal_section_detector import detect_section_type, get_section_priority
from legal_chunker import (
    CHUNK_SIZE, CHUNK_OVERLAP, MIN_CHUNK_SIZE,
    build_text_from_boxes,
    get_page_range_from_char_offsets,
    chunk_legal_document,
)
```

### Chunk a Document

```python
# From extracted PDF data and metadata
chunks = chunk_legal_document(
    extracted={"text": full_text, "pages": pages},
    metadata=case_metadata,
    court_type="supreme_court",  # or "high_court"
    pdf_url="https://example.com/judgment.pdf",
)
```

### Filter Important Sections

```python
from legal_section_detector import is_important_section

# Get chunks with section_priority >= 70
important_chunks = [
    c for c in chunks
    if is_important_section(c["section_type"])
]
```

## Testing

Run the comprehensive test suite:

```bash
cd scripts/rag
pytest tests/test_legal_chunking.py -v
```

Test coverage includes:
- Section detection for all 15+ patterns
- Section priority scoring
- Chunk configuration constants
- Box-aware text building
- Page range calculation
- O(n) character search
- Integration tests for SC and HC chunking
