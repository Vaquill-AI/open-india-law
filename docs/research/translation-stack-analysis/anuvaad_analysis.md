# Anuvaad (SUVAS) vs Anuvad Pipeline: Deep Analysis

**Date**: 2026-04-02
**Repo analyzed**: `data/reference-repos/anuvaad/` (project-anuvaad/anuvaad, MIT license)
**Deployments**: Supreme Court of India (SUVAS), Supreme Court of Bangladesh (Amar Vasha), DIKSHA (NCERT)

---

## Executive Summary

Anuvaad is a microservice-based document translation platform built for the Indian judiciary. It prioritizes **sentence-level granularity**, **human post-editing**, and **self-hosted NMT models** over API-based translation. Our Anuvad pipeline is architecturally simpler (monolithic + Celery) but leverages more modern AI services (Sarvam AI, Mistral OCR, GPT-5). The critical gap is not in translation quality but in **post-editing workflow**, **translation memory**, and **sentence-level alignment** that make Anuvaad court-grade.

---

## 1. Architecture Comparison

### Anuvaad: Microservice Pipeline (Kafka-orchestrated)

```
Upload -> File Converter -> Layout Detector (PRIMA) -> Word Detector (CRAFT)
  -> Block Segmenter (YOLOv5) -> OCR (Tesseract) -> Block Merger
  -> Tokenizer (language-specific) -> Translator (IndicTrans via CTranslate2)
  -> TMX Phrase Replacement -> Content Handler -> DOCX Download
```

**Key components** (each is a separate Flask microservice with Kafka consumers/producers):

| Service | Tech | Purpose |
|---------|------|---------|
| Workflow Manager | Flask + Kafka | Central orchestrator, routes jobs between services |
| Layout Detector | PRIMA (Layout Parser) | Detects text regions, tables, images in page images |
| Word Detector | CRAFT (PyTorch) | Line-level text detection within layout regions |
| Block Segmenter | YOLOv5 | Handles layout misclassifications, merges regions |
| OCR | Tesseract (custom trained) | Text extraction per detected region |
| Tokenizer | NLTK Punkt (per-language) | Paragraph-to-sentence splitting |
| Aligner | LaBSE + FAISS | Sentence alignment for parallel corpus building |
| Translator | Kafka + IndicTrans | Batches sentences to NMT, handles TMX replacement |
| NMT Inference | CTranslate2 + SentencePiece | Self-hosted IndicTrans models |
| TMX Service | Redis + MongoDB | 3-tier translation memory (Global/Org/User) |
| Content Handler | MongoDB | Manages translated document state |

**Communication**: Apache Kafka for async job routing between microservices. MongoDB for state persistence. Redis for TMX caching. Samba for file storage.

### Anuvad: Monolithic + Celery

```
Upload -> R2 -> Celery Task -> PyMuPDF4LLM (or Mistral OCR fallback)
  -> Clean Text -> Chunk by paragraphs -> Glossary Protection
  -> Sarvam AI Translation (per chunk) -> Glossary Restoration
  -> Quality Score -> PDF/DOCX Generation -> R2
```

| Component | Tech | Purpose |
|-----------|------|---------|
| Task Orchestration | Celery + Redis | Background job processing |
| Text Extraction | PyMuPDF4LLM + Mistral OCR | PDF text extraction with OCR fallback |
| Translation | Sarvam AI API | Cloud NMT service |
| Glossary | In-memory + Supabase | Legal term protection/restoration |
| Export | ReportLab + python-docx | PDF/DOCX generation |
| Storage | Cloudflare R2 | Document storage with 7-day TTL |
| Cache | Supabase | Translation cache per chunk |

### Verdict

Anuvaad's microservice architecture is heavier to operate but enables **independent scaling** of compute-intensive services (OCR, NMT). Our monolith is simpler but couples everything. For court-grade deployment, the microservice separation matters less than the **sentence-level data model** that Anuvaad enforces throughout.

---

## 2. Sentence Tokenization vs Paragraph Chunking

### Anuvaad: Language-specific sentence tokenizers

Anuvaad has **separate tokenizer classes per language**:

- `AnuvaadEngTokenizer` (NLTK Punkt + 35+ legal abbreviation patterns)
- `AnuvaadHindiTokenizer` (Devanagari Unicode-aware, handles `।` `॥` sentence enders)
- `AnuvaadTokenizer` (generic for other Indic scripts, Unicode range `\u0900-\u0D7F`)
- Separate tokenizers for Gujarati, Kannada, Bengali, Tamil, Malayalam, Telugu

**Key technique**: Serialize/Deserialize pattern.
1. **Serialize**: Replace problematic patterns (dates `12.03.2024`, abbreviations `Dr.`, `Smt.`, `Pvt. Ltd.`, section numbers `34.`, URLs, decimals, brackets, bullet points) with unique placeholders like `DD_0_DD`, `#0#`, `XX_0_XX`
2. **Tokenize**: Run NLTK Punkt (English) or regex-based sentence splitter (Hindi/Indic) on cleaned text
3. **Deserialize**: Restore original patterns in each sentence

**Legal abbreviation handling** (critical for court documents):
- `W.E.F.`, `O.A.`, `Smt.`, `Sec.`, `Spl.`, `Pvt.`, `Ltd.`, `M/S.`, `i.e.`, `Govt.`, `Admn.`, `P.C.`
- Hindi abbreviations: `प्रो.`, `प्रा.`, `संख्या.`
- Court-specific: `Vs.`, `v.`, `Crl.`, `NO.`, `NOS.`
- Devanagari sentence enders: `।` (purna viram), `॥` (double danda), `|` (pipe)

**Hindi tokenizer specifics**:
- Unicode ranges for complete chars (`\u0904-\u0939`), incomplete chars (matras `\u093A-\u094F`), numbers (`\u0966-\u096F`)
- Colon abbreviation patterns (Hindi text with `:` that should not split)
- Time patterns (HH:MM should not split on `:`)
- Devanagari decimal numbers

### Anuvad: Paragraph-level chunking

Our `_chunk_text()` splits by paragraphs (double newlines), then further splits paragraphs that exceed `_MAX_CHUNK_SIZE` (1800 chars) at sentence boundaries. This is a **coarse approach** that:

- Does NOT have language-specific tokenization
- Does NOT handle legal abbreviations (Dr., Smt., etc.)
- Does NOT understand Devanagari sentence boundaries (`।`, `॥`)
- Chunks are paragraphs (5-50 sentences), not individual sentences
- No serialize/deserialize pattern for protecting dates, section numbers

### Gap Analysis

| Feature | Anuvaad | Anuvad | Impact |
|---------|---------|--------|--------|
| Sentence-level splitting | Yes (per-language) | No (paragraph chunks) | **HIGH**: Can't do sentence-level editing |
| Legal abbreviation handling | 35+ patterns | None | **HIGH**: Breaks on "Smt. Kamla vs. Dr. Ram" |
| Devanagari sentence enders | `।` `॥` `\|` | No | **HIGH**: Hindi text stays as one blob |
| Date protection | `DD.MM.YYYY` patterns | No | **MEDIUM**: Dates can break sentences |
| Section number protection | `34.` patterns | No | **MEDIUM**: "Under section 34. The court" splits wrong |
| Numbered list handling | Yes (Roman, alpha, numbered) | No | **MEDIUM**: Lists break incorrectly |
| Unicode range awareness | Full Indic (`\u0900-\u0D7F`) | None | **HIGH**: No script-aware processing |

**Recommendation**: Build an `IndianLegalTokenizer` class with at minimum:
1. Legal abbreviation dictionary (start with Anuvaad's 35 English + Hindi patterns)
2. Devanagari sentence boundary detection
3. Serialize/deserialize pattern for dates, numbers, brackets
4. This is the single most impactful improvement we can make

---

## 3. Sentence Alignment (Aligner)

### Anuvaad: LaBSE + FAISS

The aligner service (`etl-aligner/`) uses:

1. **LaBSE** (Language-agnostic BERT Sentence Embeddings) to embed source and target sentences
2. **FAISS** (Facebook AI Similarity Search) for k-nearest-neighbor matching
3. **Cosine similarity thresholds** based on sentence length:
   - Short sentences (0-15 words): min 0.65, target 0.7
   - Long sentences (15+ words): min 0.70, target 0.75
4. GPU-accelerated FAISS when available (`faiss.index_cpu_to_all_gpus`)

**Purpose**: When a document has been translated (either by NMT or human), the aligner creates parallel sentence pairs. This is used for:
- Building TMX (Translation Memory) entries
- Corpus creation for model training
- Quality assessment (comparing NMT output with human-edited output)

### Anuvaad: LaBSE Phrase Aligner (in NMT Inference service)

A separate phrase-level aligner (`labse_aligner.py`) handles TMX replacement:
1. Given source phrases (from TMX) and NMT target output
2. Generates sliding window n-grams from target text (n = source phrase word count +/- 1)
3. Embeds both source phrase and all target n-grams with LaBSE
4. Finds best matching target n-gram by cosine similarity
5. If score >= 0.5, replaces NMT output with TMX (user-preferred) translation
6. Updates TMX with the NMT phrase mapping for future use

### Anuvad: Paragraph-level pairing

Our `ParagraphPair` dataclass simply pairs source chunks with translated chunks by index:
```python
paragraph_pairs = [
    ParagraphPair(source=chunks[i], translated=translated_chunks[i], index=i)
    for i in range(min(len(chunks), len(translated_chunks)))
]
```

No semantic alignment. Chunks are paired 1:1 by position. This works because our chunks go through a single translation API, so ordering is preserved. But it means:
- No cross-sentence alignment capability
- No ability to detect when NMT merged or split sentences
- No embedding-based quality comparison

### Gap Analysis

We don't need corpus-building alignment (we're not training models). But we DO need:
1. **Phrase-level alignment for glossary replacement** (Anuvaad uses LaBSE to find WHERE in the NMT output a glossary term's translation landed, then replaces it)
2. **Sentence-level pairs for the editor UI** (our paragraph pairs are too coarse for editing)

---

## 4. OCR Pipeline

### Anuvaad: Multi-stage document processing pipeline

```
PDF -> Pre-processor (orientation correction, watermark removal)
    -> Layout Detector (PRIMA model)
    -> Block Segmenter (YOLOv5, handles misclassifications)
    -> Word Detector (CRAFT, line-level detection)
    -> OCR (custom-trained Tesseract per language)
    -> Block Merger (reassembles into structured document)
```

**Key features**:
- **Pre-processor** (`pre-processor/`): Image extraction, orientation correction, watermark removal. Critical for government scanned documents that are often skewed or have watermarks.
- **Layout detection** (PRIMA): Trained on document layouts to identify text regions, tables, images, headers/footers. Uses Layout Parser framework.
- **Block segmentation** (YOLOv5): Handles layout detection errors by merging/splitting detected regions. Includes `region_operations.py` for spatial operations on bounding boxes.
- **Double OCR logic**: Region-level OCR runs Tesseract with multiple weights and selects best output.
- **Language detection**: Tesseract OSD for auto-detecting script.
- **Auto weight download**: Downloads best Tesseract traineddata from GitHub if not available locally.

**Supported languages** (via Tesseract LANG_MAPPING):
- Custom-trained weights for each Indian language script
- ULCA v2 variant with updated training data

### Anuvad: PyMuPDF4LLM + Mistral OCR fallback

```
PDF -> PyMuPDF4LLM (text layer extraction)
    -> If < 200 chars or garbled: Mistral OCR API
    -> Clean extracted text (strip markdown artifacts)
```

**Key features**:
- **Garbled text detection** (`_is_garbled_text()`): Checks alpha ratio and special char ratio to detect bad OCR text layers in scanned PDFs
- **Image extraction**: Extracts embedded images with position metadata for placement in translated output
- **Mistral OCR**: Cloud-based OCR for scanned documents, handles tables and formatting

### Comparison

| Feature | Anuvaad | Anuvad | Notes |
|---------|---------|--------|-------|
| Text PDF extraction | Tesseract (overkill) | PyMuPDF4LLM | We're better for text PDFs |
| Scanned PDF OCR | Custom Tesseract (self-hosted) | Mistral OCR API | Anuvaad is free; we pay per page |
| Layout detection | PRIMA + YOLOv5 | None | **GAP**: We lose document structure |
| Orientation correction | Yes | No | Scanned docs are often rotated |
| Watermark removal | Yes | No | Government docs have watermarks |
| Table detection | Yes (layout-aware) | Mistral handles tables | Similar capability |
| Court order format | Trained on Indian court docs | General purpose | **GAP**: Their models see court formats |
| Multi-language OCR | Per-language Tesseract weights | Mistral (multilingual) | Mistral is more modern |

### Verdict

Our Mistral OCR approach is actually **more capable for modern documents** (it understands tables, formatting, multi-column layouts natively). But Anuvaad's pipeline has been **specifically trained on Indian court documents** (FIRs, court orders, government notifications) which have unique formatting challenges:
- Typewriter-style FIRs with poor scan quality
- Hindi court orders with mixed English/Hindi in the same line
- Government gazette formatting with columns and seals

**Recommendation**: Our approach is fine for most documents. For court-specific documents (FIRs, old typewritten orders), we should consider:
1. A pre-processing step for orientation correction (trivial with OpenCV)
2. Watermark detection/removal for government scans
3. These are enhancements, not blockers

---

## 5. Translation Engine: CTranslate2 vs Sarvam API

### Anuvaad: Self-hosted IndicTrans via CTranslate2

**Model loading** (`model_loader.py`):
```python
translator = ctranslate2.Translator(path, device="auto")
loaded_models[model_id] = translator
```

Models are loaded at startup and kept in memory. Each language pair has:
- A CTranslate2-converted model (from OpenNMT)
- SentencePiece encoder and decoder

**Translation pipeline** (`translate.py`):
1. **Pre-processing**: Digit conversion (language-specific), uppercase handling
2. **Special case handler**: Short/trivial inputs returned without model inference
3. **Tagger utility**: Tags numbers (`NnUuMm`), dates (`DdAaTtEe`), URLs (`UuRrLl`) with placeholders before translation
4. **SentencePiece encoding**: Subword tokenization
5. **CTranslate2 inference**: Beam search (beam_size=5), 1 hypothesis
6. **SentencePiece decoding**: Subword detokenization
7. **Post-processing**: Regex cleanup, tag restoration, digit postprocessing
8. **Indic tokenizer/detokenizer**: Moses tokenizer for English, custom Indic tokenizer

**Language routing**: Each model ID maps to specific pre/post-processing:
- IDs 56 (en-hi), 6 (hi-en), 7 (en-ta), 10 (en-gu), 18 (en-pn), 42 (en-mr), etc.
- IDs 67-80: IndicTrans v2 models with different encode/decode pipeline

**Number/Date/URL handling** (`tagger_util.py`):
- Replaces numbers with Hindi numeral tags: `NnUuMm०`, `NnUuMm१`, etc. (up to 30)
- Numbers sorted descending to avoid partial replacement
- URLs get `UuRrLl0` tags
- After translation, tags are replaced back with originals
- Extra unreplaced tags are cleaned from output

### Anuvad: Sarvam AI API

Our pipeline uses cloud NMT:
1. Chunk text into max 1800-char segments
2. Protect glossary terms with placeholders
3. Call `client.translate_text()` (Sarvam API)
4. Restore glossary terms
5. Cache results

No number/date/URL tagging. No SentencePiece. No beam search control.

### Performance Comparison

| Metric | Anuvaad (CTranslate2) | Anuvad (Sarvam API) |
|--------|----------------------|---------------------|
| Latency per sentence | ~50-200ms (GPU) | ~200-500ms (API call) |
| Throughput | ~100+ sentences/sec (batched) | ~5-10 chunks/sec (rate limited) |
| Cost | Infrastructure only (GPU servers) | Per-character API pricing |
| Model control | Full (can fine-tune) | None (black box) |
| Number handling | Tag-and-replace (lossless) | None (numbers can be mistranslated) |
| Beam search | Configurable (beam=5) | Not exposed |
| Offline capability | Yes | No |

### Verdict

Sarvam's models are likely **newer and higher quality** than Anuvaad's IndicTrans v1/v2 (2021-2023 era models). But Anuvaad's **number/date/URL tagging** is a critical reliability feature:
- Court documents are full of case numbers, dates, section references
- Even modern NMT models sometimes garble numbers in translation
- The tag-and-replace approach guarantees numbers pass through unchanged

**Recommendation**:
1. **Add number/date/URL tagging** before Sarvam translation (highest priority)
2. This is a 100-line utility that replaces `12.03.2024`, `Rs. 50,000`, case numbers with tags, then restores after translation
3. Consider Sarvam's `hard_translate_dict` if they support it for document API

---

## 6. Translation Memory (TMX)

### Anuvaad: 3-tier hierarchical TMX

This is arguably Anuvaad's **most court-grade feature**. The TMX system (`tmx/tmxservice.py`) provides:

**3 levels of translation memory**:
1. **Global**: Organization-wide glossary (e.g., "the Supreme Court shall" always translates to specific Hindi)
2. **Organization**: Court-specific terminology (SUVAS has its own translations)
3. **User**: Individual translator preferences

**How it works**:
1. Before NMT translation, the **hopping window algorithm** searches for TMX phrases in the source text
2. For each phrase found in TMX, the pre-stored translation is used instead of NMT
3. For phrases that have TMX entries but no NMT alignment yet, **LaBSE alignment** finds the corresponding phrase in NMT output and replaces it
4. Successful replacements are stored back to TMX for future use (learning loop)

**Hopping window search** (`tmx_phrase_search`):
```
sentence = "The accused was convicted under Section 302 of IPC"
hopping_pivot = 0, sliding_pivot = len(sentence)

1. Try: "The accused was convicted under Section 302 of IPC" -> no TMX match
2. Shrink: "The accused was convicted under Section 302 of" -> no match
3. Continue shrinking...
4. Try: "Section 302 of IPC" -> TMX MATCH! Replace with stored translation
5. Hop forward past matched phrase
6. Continue from next position...
```

**TMX hash key structure**:
- `SHA-256(userID + "__" + context + "__" + locale + "__" + src)` (User level)
- `SHA-256(orgID + "__" + context + "__" + locale + "__" + src)` (Org level)
- `SHA-256(context + "__" + locale + "__" + src)` (Global level)

**Sentence flavor generation**: Each source sentence generates 4 variants (original, title case, lowercase, uppercase) for flexible matching.

**Suggestion box**: Translators can suggest glossary entries that go through admin approval before becoming org-level TMX.

### Anuvad: Glossary protection (placeholder-based)

Our `LegalGlossaryService` uses a simpler approach:
1. Before translation: find glossary terms in source, replace with `__LEGAL_TERM_0__` placeholders
2. Translate (placeholders pass through NMT unchanged)
3. After translation: replace placeholders with correct target translations

**Limitations vs Anuvaad TMX**:
- No 3-tier hierarchy (no user/org separation)
- No learning loop (we don't learn from corrections)
- No phrase-level matching (only exact term matches)
- No suggestion/approval workflow
- No hopping window search (we do simple regex matching)
- 66 hardcoded Hindi terms + Supabase-loaded terms

### Gap Analysis

| Feature | Anuvaad TMX | Anuvad Glossary | Impact |
|---------|-------------|-----------------|--------|
| User-level memory | Yes | No | **HIGH**: Translators can't build personal memory |
| Org-level memory | Yes | No | **HIGH**: Court can't have institutional memory |
| Learning from corrections | Yes | No | **HIGH**: System never gets smarter |
| Phrase-level matching | Hopping window | Exact match only | **MEDIUM**: Multi-word terms need fuzzy matching |
| NMT phrase alignment | LaBSE | None | **MEDIUM**: Can't fix NMT output of known phrases |
| Suggestion workflow | Admin approval | None | **LOW**: Nice-to-have for institutional use |
| Reverse locale support | Yes (bi-directional) | No | **LOW**: We do one direction at a time |

**Recommendation**: This is the second most impactful improvement:
1. Add a `user_translation_memory` table in Supabase
2. When a user edits a translation (sentence-level), store src/tgt pair
3. Before NMT translation, check user memory first
4. Build toward org-level memory for institutional clients

---

## 7. Post-Editing UI

### Anuvaad: Sentence-level editor (`SentenceCard.jsx`)

A sophisticated React editor with:
- **Source/Target side-by-side**: Each sentence gets a card with source text (read-only) and target text (editable)
- **Interactive translation**: Users can edit the target, and the system re-translates with their prefix (interactive/constrained NMT)
- **TMX highlighting**: Glossary-applied phrases are highlighted in the translation
- **Dictionary lookup**: Word-level dictionary for translator reference
- **Add to Glossary**: Right-click to add a phrase pair to personal/org glossary
- **Suggest Glossary**: Propose glossary entries for admin approval
- **BLEU score calculation**: Real-time BLEU score comparison with original NMT output
- **Speech recognition**: Mic input for dictating translations (ASR integration)
- **Transliteration**: `react-transliterate` for typing in Indic scripts with Roman keyboard
- **RTL support**: Automatic right-to-left for Urdu/Arabic scripts
- **Save state tracking**: Cards show saved/unsaved/incorrect states with color coding (green=saved, grey=unsaved, red=incorrect)
- **Telemetry**: Tracks editing time, keystrokes for analytics

**Key interaction flow**:
1. Document uploaded -> OCR -> Tokenize into sentences -> NMT translate
2. User sees page-by-page view with sentence cards
3. Each card: source sentence (top), NMT translation (bottom, editable)
4. User edits translation -> system stores as User TM
5. User can flag "translation incorrect" for review
6. Completed pages shown as progress

### Anuvad: TipTap TranslationEditor

Our editor is a **rich text block editor** (TipTap/ProseMirror) showing:
- Full translated document (not sentence-level)
- Glossary term highlighting
- Paragraph-level source/target alignment panel
- No sentence-level editing
- No interactive re-translation
- No TMX/memory integration
- No BLEU scoring
- No speech/transliteration input

### Gap Analysis

| Feature | Anuvaad Editor | Anuvad Editor | Impact |
|---------|---------------|---------------|--------|
| Granularity | Sentence-level | Paragraph/full-doc | **CRITICAL**: Court translators need sentence control |
| Interactive NMT | Yes (prefix-constrained) | No | **HIGH**: Translators can guide the NMT |
| TMX highlight | Yes | Glossary highlights only | **MEDIUM**: Shows which phrases came from memory |
| Dictionary | Yes (per-word) | No | **MEDIUM**: Helpful for rare legal terms |
| Add to glossary | Yes (from editor) | No | **HIGH**: Learning loop requires this |
| Transliteration | Yes (react-transliterate) | No | **HIGH**: Essential for typing in Indic scripts |
| BLEU scoring | Yes (real-time) | Quality score only | **LOW**: More for analytics |
| Speech input | Yes (ASR) | No | **LOW**: Nice-to-have |
| Progress tracking | Per-sentence | Per-document | **MEDIUM**: Court translators need granular progress |

**Recommendation**: The sentence-level editing paradigm is what makes Anuvaad court-grade. To achieve this, we need:
1. Sentence tokenization (prerequisite, see section 2)
2. Sentence-level data model (each sentence stored separately with status)
3. A sentence card view alongside the current TipTap editor
4. "Add to memory" action from the editor

---

## 8. SUVAS-Specific Customizations

Based on the codebase analysis, the SUVAS deployment differs from base Anuvaad in:

1. **Custom Tesseract weights**: Trained specifically on Supreme Court document formats (typed/printed Hindi legal documents)
2. **Court terminology in TMX**: Global TMX pre-loaded with Supreme Court specific translations
3. **org-level TMX isolation**: Each court's translations are isolated
4. **Role-based TMX/UTM access**: `tmx_disable_roles` and `utm_disable_roles` config controls who can use/edit translation memory
5. **Org-level NMT disable** (`orgs_nmt_disable`): Some orgs can be configured to skip NMT entirely and only use TMX matches (for sensitive documents where NMT quality is insufficient)
6. **Non-NMT user flow**: When NMT is disabled for an org, sentences go to a separate Kafka topic (`anu_translator_nonmt_topic`) where only human translations are accepted

**What makes it court-grade**:
- Sentence-level audit trail (every translation can be traced)
- Human-in-the-loop required (NMT is suggestion, not final output)
- Institutional memory (corrections improve future translations)
- Role-based access (judge vs translator vs admin)

---

## 9. Document Processing Pipeline

### Anuvaad: Structured document model

Anuvaad maintains **document structure** throughout the pipeline:

```json
{
  "result": [
    {
      "page_no": 1,
      "text_blocks": [
        {
          "block_id": "1_0",
          "tokenized_sentences": [
            {"s_id": "s1", "src": "The petitioner filed..."},
            {"s_id": "s2", "src": "Under Section 302..."}
          ]
        }
      ]
    }
  ]
}
```

This structure is maintained from OCR output through tokenization, translation, and back to document generation. Each sentence has a unique `s_id` and `n_id` (node_id = record|page|block) that enables:
- Sentence-level status tracking
- Page-by-page progress
- Block-level layout preservation
- Batch processing within pages (configurable `nmt_max_batch_size`)

### Anuvad: Flat text model

We extract text as a single string, chunk by paragraphs, translate chunks, and reassemble:
```
PDF -> single text string -> paragraph chunks -> translate -> join -> PDF/DOCX
```

No page awareness. No block structure. No sentence-level IDs.

### Export comparison

| Feature | Anuvaad | Anuvad |
|---------|---------|--------|
| PDF generation | DOCX download service | ReportLab (certified PDF) |
| Layout preservation | Page-by-page, block-by-block | Paragraph-based two-column |
| Image handling | Via block merger | Image extraction + re-insertion |
| Bilingual output | Sentence-aligned | Paragraph-aligned columns |
| Font support | Not visible in codebase | Multi-script (Noto Sans) |
| Certification | Not visible | Advocate certification stamp |

Our certified PDF generation with advocate details is actually a feature Anuvaad doesn't have. Our bilingual two-column layout and Indic font handling are solid.

---

## 10. Priority Recommendations

### P0: Critical (Makes us court-grade)

1. **Indian Legal Tokenizer** (~2 days)
   - Build `AnuvadLegalTokenizer` with serialize/deserialize pattern from Anuvaad
   - Support 35+ English legal abbreviations + Devanagari sentence enders
   - This unblocks sentence-level everything

2. **Number/Date/URL Tagging** (~1 day)
   - Pre-translation: tag numbers, dates, case references, URLs with placeholders
   - Post-translation: restore tags with originals
   - Prevents Rs. 50,000 becoming "50000 rupees" or dates getting garbled

3. **Sentence-Level Data Model** (~2 days)
   - Store individual sentences (not paragraphs) in `translation_sentences` table
   - Each sentence: `s_id`, `source`, `nmt_output`, `user_edited`, `status`, `page_no`
   - This enables per-sentence editing, progress tracking, and TMX building

### P1: High (Competitive advantage)

4. **User Translation Memory** (~2 days)
   - `user_translation_memory` table: `user_id`, `org_id`, `source`, `target`, `locale`, `context`
   - Before NMT: check memory for exact/fuzzy matches
   - On edit: auto-store correction to user memory
   - Hopping window search from Anuvaad (or simpler phrase matching)

5. **Sentence Card Editor View** (~3 days)
   - Add toggle between "Document view" (current TipTap) and "Sentence view"
   - Sentence view: cards with source/target, edit-in-place, save status
   - "Add to glossary" action from selected text

6. **Transliteration Input** (~0.5 day)
   - Add `react-transliterate` for Indic script input in editor
   - Essential for court translators who use Roman keyboard

### P2: Medium (Quality improvements)

7. **Pre-processing for scanned documents**
   - Orientation correction for skewed scans
   - Watermark detection/dimming

8. **Interactive translation** (prefix-constrained)
   - When user edits first few words, re-translate with their prefix
   - Sarvam may support this via prefix parameter

9. **LaBSE phrase alignment for glossary**
   - Use LaBSE to find where glossary terms end up in NMT output
   - More reliable than placeholder approach for multi-word terms

### P3: Low (Nice-to-have)

10. **Org-level TMX** with admin approval workflow
11. **BLEU score** for translation quality tracking
12. **Speech input** (ASR for Indic languages)
13. **Self-hosted NMT** for offline/on-premise deployments

---

## Appendix A: Key File Paths in Anuvaad

| Component | Path |
|-----------|------|
| English tokenizer | `anuvaad-etl/anuvaad-extractor/sentence/etl-tokeniser/repositories/eng_sentence_tokeniser.py` |
| Hindi tokenizer | `anuvaad-etl/anuvaad-extractor/sentence/etl-tokeniser/repositories/hin_sentence_tokeniser.py` |
| Generic tokenizer | `anuvaad-etl/anuvaad-extractor/sentence/etl-tokeniser/repositories/general_tokeniser.py` |
| Aligner (FAISS) | `anuvaad-etl/anuvaad-extractor/aligner/etl-aligner/utilities/alignmentutils.py` |
| Aligner (LaBSE embedder) | `anuvaad-etl/anuvaad-extractor/aligner/etl-aligner/embedder/labse.py` |
| NMT translate | `anuvaad-nmt-inference/src/services/translate.py` |
| NMT model loader | `anuvaad-nmt-inference/src/services/model_loader.py` |
| Number/date tagger | `anuvaad-nmt-inference/src/utilities/tagger_util.py` |
| LaBSE phrase aligner | `anuvaad-nmt-inference/src/services/labse_aligner.py` |
| TMX service | `anuvaad-etl/anuvaad-translator/translator/tmx/tmxservice.py` |
| Translator service | `anuvaad-etl/anuvaad-translator/translator/service/translatorservice.py` |
| Text translation (sync) | `anuvaad-etl/anuvaad-translator/translator/service/texttranslationservice.py` |
| OCR (Tesseract) | `anuvaad-etl/anuvaad-extractor/document-processor/ocr/tesseract_ulca/src/services/ocr.py` |
| Layout detector (PRIMA) | `anuvaad-etl/anuvaad-extractor/document-processor/layout-detector/prima/` |
| Block segmenter (YOLOv5) | `anuvaad-etl/anuvaad-extractor/document-processor/block-segmenter/` |
| Workflow manager | `anuvaad-etl/anuvaad-workflow-mgr/etl-wf-manager/` |
| Sentence card UI | `anuvaad-fe/anuvaad-webapp/src/ui/containers/web/DocumentEditor/SentenceCard.jsx` |

## Appendix B: Key File Paths in Anuvad

| Component | Path |
|-----------|------|
| Translation service | `app/services/translation_service.py` |
| Translation tasks (Celery) | `app/worker/translation_tasks.py` |
| Translation export (PDF) | `app/services/translation_export.py` |
| Legal glossary | `app/services/legal_glossary_service.py` |
| PDF extraction | `app/rag/ingestors/pymupdf4llm_ingestor.py` |
| Mistral OCR | `app/rag/ingestors/mistral_ocr.py` |
| Sarvam AI client | `app/integrations/sarvam_ai.py` |
| Translation cache | `app/services/translation_cache.py` |
| Quality scorer | `app/services/translation_quality.py` |
| Encoding converter | `app/services/encoding_converter.py` |
