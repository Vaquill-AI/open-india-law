# IndicTrans2 vs Anuvad Translation Pipeline Analysis

**Date**: 2026-04-02
**Scope**: Comparative analysis of AI4Bharat's IndicTrans2 (open-source NMT) with Vaquill's Anuvad pipeline (Sarvam AI-powered)

---

## 1. Script Unification Technique

### How IndicTrans2 Does It

IndicTrans2's core innovation is **script unification**: converting all Indic scripts to Devanagari before translation, then converting back to the target script after.

**Pipeline** (from `inference/engine.py:preprocess_sent`, lines 333-379):
```
Input (any Indic script)
  -> Punctuation normalization (Moses/sacremoses)
  -> Indic numeral normalization (native digits -> Roman: ১২৩ -> 123)
  -> Entity placeholder extraction (URLs, emails, dates, numerals -> <ID1>, <ID2>...)
  -> Indic NLP normalization (script-specific Unicode normalization)
  -> Trivial tokenization (indic_tokenize.trivial_tokenize)
  -> Transliteration to Devanagari (UnicodeIndicTransliterator, src_lang -> "hi")
  -> Fix virama spacing (.replace(" ् ", "्"))
  -> SentencePiece encoding
  -> Language tag prepending ("{src_lang} {tgt_lang} {sentence}")
  -> Translation (Fairseq/CT2)
  -> SentencePiece decoding
  -> Placeholder restoration
  -> Transliteration back to target script (Devanagari -> target)
  -> Detokenization
```

**Which scripts get unified** (from `engine.py:356`):
- **Transliterated to Devanagari**: Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Odia, Gurmukhi, and all Devanagari-native languages
- **NOT transliterated** (kept in original script): Perso-Arabic (Kashmiri, Sindhi, Urdu), Ol Chiki (Santali), Meitei (Manipuri), Latin (English)

**Why it works**: Languages that share Devanagari (Hindi, Marathi, Sanskrit, Bodo, Dogri, Konkani, Maithili, Nepali) naturally share vocabulary. By transliterating Tamil/Telugu/Bengali/etc. INTO Devanagari, the model gets lexical overlap where none existed, enabling transfer learning across all Indic languages with a single shared SentencePiece vocabulary.

### Can We Add This as Pre-processing Before Sarvam?

**Short answer: No, and we should not.**

Sarvam's Mayura model already handles multi-script input internally. Adding a transliteration layer would:
1. **Double-process** the text (we transliterate to Devanagari, Sarvam's tokenizer handles it again)
2. **Break Sarvam's language detection** if we send Bengali text in Devanagari script with `source_language: "bn"`
3. **Corrupt Perso-Arabic** and Ol Chiki text that should NOT be transliterated

**What we SHOULD adopt** (see Techniques section):
- Indic numeral normalization (native digits -> Roman) as a pre-processing step
- Entity placeholder extraction for URLs, emails, legal citation numbers
- Unicode normalization for each script

### Numeral Normalization: High-Value, Low-Risk

IndicTrans2's `indic_num_map.py` maps numerals from all 11 Indic scripts to Roman digits. This is critical for legal text where section numbers (e.g., "ধারা ৩০২" = "Section 302") must be preserved exactly. Our pipeline currently has no numeral normalization.

---

## 2. Tokenization and Sentence Splitting

### IndicTrans2's Approach (`engine.py:split_sentences`, lines 22-44)

```python
# English: dual-splitter strategy
sents_moses = MosesSentenceSplitter("en")([paragraph])
sents_nltk = sent_tokenize(paragraph)
# Takes the SHORTER list (fewer, longer sentences) to avoid over-splitting
sents = sents_nltk if len(sents_nltk) < len(sents_moses) else sents_moses

# Indic: IndicNLP sentence splitter with NO danda pattern
# DELIM_PAT_NO_DANDA avoids splitting on purna viram (।) inside legal citations
sentence_split(paragraph, lang=iso_lang, delim_pat=DELIM_PAT_NO_DANDA)
```

Key: IndicTrans2 splits at **sentence boundaries**, not character limits. Each sentence is translated independently, maintaining semantic coherence.

Their max sequence length is **256 SPM tokens** (not characters). Sentences exceeding this are truncated at word boundaries (`truncate_long_sentences`, line 84-115). The RoPE variants extend this to **2048 tokens**.

### Our Approach (`translation_service.py:_chunk_text`, lines 351-436)

```python
_MAX_CHUNK_SIZE = 1800  # characters (buffer below Sarvam's 2000 char limit)

# 1. Split by paragraphs (double newline)
# 2. If paragraph > 1800 chars, split by sentences (।.?!)
# 3. If sentence > 1800 chars, split at word boundaries
```

### Comparison

| Aspect | IndicTrans2 | Anuvad |
|--------|-------------|--------|
| Split unit | Sentences (linguistic) | Paragraphs/character chunks |
| Split tool | Moses + NLTK (English), IndicNLP (Indic) | Simple regex `(?<=[।.?!])\s+` |
| Max unit | 256 SPM tokens (~150-200 words) | 1800 characters (~300-450 words) |
| Danda handling | `DELIM_PAT_NO_DANDA` (avoids mid-citation splits) | Splits on `।` always |
| Legal awareness | None, but avoids false splits | None |

### Are We Losing Quality by Chunking at 1800 Chars?

**Mixed.** Our chunks are actually LARGER than IndicTrans2's (which translates sentence-by-sentence). Larger chunks give Sarvam more context, which can be better for legal text where sentences reference each other. But:

1. **Our sentence splitting is naive**. The regex `(?<=[।.?!])\s+` will split on abbreviations ("U.S. Supreme Court"), legal citations ("S. 302 I.P.C."), and numbered lists. IndicTrans2's Moses splitter handles these edge cases.

2. **We lack IndicNLP sentence splitting for Indic languages**. The `DELIM_PAT_NO_DANDA` pattern is specifically designed to avoid splitting legal Indic text at purna viram (।) when it appears inside citations like "धारा ३०२ भा.दं.सं।"

3. **Paragraph join is lossy**. We rejoin with `\n` (line 244) but IndicTrans2 joins with space. For legal documents, paragraph boundaries matter. Our approach is actually better here.

---

## 3. Legal/Formal Text vs Conversational Text

### IndicTrans2's Domain Handling

IndicTrans2 has **no domain-specific fine-tuning** for legal text. Their evaluation benchmarks confirm this:

- **IN22-Gen** (1024 sentences): Wikipedia + Web content. Covers news, entertainment, culture, legal topics, India-centric content. This is the closest to "formal" text.
- **IN22-Conv** (1503 sentences): Day-to-day conversational text.

The model is a general-purpose NMT system. It does not distinguish between legal, medical, or casual registers. There is no "formal mode" or domain adaptation.

### Our Domain Handling

We have significant advantages here:

1. **Sarvam's `mode` parameter**: We use `settings.SARVAM_TRANSLATE_MODE` which can be set to `"formal"` for legal text (from `sarvam_ai.py:213`).

2. **Legal glossary protection** (`legal_glossary_service.py`): Vidhi Shabdavali terms are protected with placeholder substitution before translation and restored after. This ensures terms like "अग्रिम जमानत" (anticipatory bail) are translated correctly.

3. **Encoding detection** (`encoding_converter.py`): We handle legacy encodings (Krutidev, Chanakya, Shusha) common in Indian legal documents. IndicTrans2 assumes Unicode input only.

4. **Quality scoring** (`translation_quality.py`): Post-translation quality checks for legal term preservation, untranslated fragments, and length ratio anomalies.

---

## 4. Evaluation Benchmarks (IN22-Gen, IN22-Conv)

### What They Are

- **IN22-Gen**: 1024 sentences, n-way parallel across 22 languages. Multi-domain (news, Wikipedia, web, legal, cultural). Available at `ai4bharat/IN22-Gen` on HuggingFace.
- **IN22-Conv**: 1503 sentences, conversational domain. Available at `ai4bharat/IN22-Conv` on HuggingFace.

Metrics used: chrF++ (primary), BLEU, COMET.

### Can We Run Our Translations Against These?

**Yes, and we should.** Here is the approach:

1. **Download**: `huggingface-cli download ai4bharat/IN22-Gen` and `ai4bharat/IN22-Conv`
2. **For each language pair we support** (e.g., hi->en, bn->en, ta->en):
   - Extract source sentences from the benchmark
   - Run through our Sarvam pipeline
   - Compare against reference translations using `sacrebleu`
3. **Metrics**: `sacrebleu ref.txt < pred.txt -m bleu chrf` for English targets, IndicNLP tokenization for Indic targets (see `compute_metrics.sh`)

**Practical considerations**:
- IN22-Gen has ~1024 * 22 = ~22K translation pairs. At 5 req/sec Sarvam rate, this takes ~4400 seconds (~1.2 hours)
- Cost: ~22K * avg 50 chars = ~1.1M chars = ~1100 credits
- This gives us a **direct, apples-to-apples comparison** against IndicTrans2, Google Translate, Azure, and NLLB

**Recommended evaluation script** (to build):
```python
# scripts/eval/benchmark_sarvam.py
# 1. Load IN22-Gen from HuggingFace datasets
# 2. For each supported language pair:
#    - Send source sentences through TranslationService
#    - Collect translated outputs
#    - Compute chrF++ and BLEU using sacrebleu
# 3. Output comparison table vs IndicTrans2 published scores
```

---

## 5. RoPE-based Long Context Variants

### What IndicTrans2 Offers

As of Jan 2025, IndicTrans2 released RoPE-based variants supporting **up to 2048 SPM tokens** (vs base model's 256 tokens). Available at `prajdabre/indictrans2-rope` on HuggingFace.

- 2048 tokens ~ 1200-1600 words ~ 6000-8000 characters for English
- For Devanagari/Indic scripts, character:token ratio is higher, so ~4000-6000 characters

### Relevance to Our Pipeline

We chunk at 1800 characters because of **Sarvam's API limit of 2000 characters per request**, not because of any model limitation. This is a hard API constraint, not a quality decision.

**Options to increase context**:
1. **Ask Sarvam about higher limits**: Their Pro/Business tiers may support longer inputs
2. **Use Sarvam's PDF translation API**: It handles document-level context internally with `hard_translate_dict` glossary support
3. **Evaluate self-hosted IndicTrans2-RoPE**: For batch processing where latency is acceptable, the RoPE model could handle entire paragraphs without chunking. Trade-off: we lose Sarvam's legal mode and need GPU infrastructure.

---

## STRENGTHS WE HAVE

1. **Legal domain specialization**: Glossary protection (Vidhi Shabdavali), formal translation mode, quality scoring. IndicTrans2 has zero legal domain awareness.

2. **Legacy encoding support**: Krutidev, Chanakya, Shusha detection and conversion. Most Indian legal documents from courts still use these encodings. IndicTrans2 assumes Unicode.

3. **Production infrastructure**: Circuit breakers, caching (7-day TTL), rate limiting, async document pipeline, credit billing. IndicTrans2 is a research artifact with no production-readiness.

4. **22 language coverage via Sarvam API**: Same language coverage as IndicTrans2 without self-hosting GPU infrastructure.

5. **Document-level translation**: PDF/DOCX pipeline with OCR (Mistral), layout preservation, and async processing. IndicTrans2 only handles plain text.

6. **Paragraph alignment**: We maintain source-target paragraph pairs for side-by-side legal review. IndicTrans2's sentence-level approach loses paragraph structure.

7. **Translation cache**: Chunk-level caching with glossary mode awareness. Repeated legal boilerplate (standard clauses, definitions) translates instantly on cache hit.

## WEAKNESSES TO FIX

1. **No Indic numeral normalization**: IndicTrans2 normalizes native digits (১২৩ -> 123) before translation. We don't. Legal section numbers in Bengali/Tamil/Gujarati script could be garbled. **Priority: HIGH, effort: LOW.**

2. **Naive sentence splitting for Indic languages**: Our regex `(?<=[।.?!])\s+` doesn't handle legal abbreviations, case citations, or section references. IndicTrans2 uses IndicNLP's `sentence_split` with `DELIM_PAT_NO_DANDA`. **Priority: HIGH, effort: MEDIUM.**

3. **No entity placeholder extraction**: IndicTrans2 wraps URLs, emails, dates, and complex numerals in `<ID1>` placeholders before translation. We only protect glossary terms. Legal citations like "2024 SCC (Cri) 145" or "AIR 1952 SC 196" could be corrupted during translation. **Priority: HIGH, effort: MEDIUM.**

4. **No Unicode normalization per script**: IndicTrans2 uses `indic_normalize.IndicNormalizerFactory` to normalize each script's Unicode variants (e.g., multiple forms of Devanagari vowels). We pass raw text. **Priority: MEDIUM, effort: LOW.**

5. **No punctuation normalization**: IndicTrans2 uses Moses punctuation normalizer for English and script-aware normalization for Indic. We pass raw text, which may contain inconsistent quotes, dashes, and whitespace from OCR output. **Priority: MEDIUM, effort: LOW.**

6. **No benchmark evaluation**: We have no BLEU/chrF++ scores to compare against. IndicTrans2 publishes detailed scores on IN22-Gen and IN22-Conv. We cannot objectively measure our translation quality. **Priority: HIGH, effort: MEDIUM.**

7. **Danda (।) splitting in legal text**: Our splitter treats purna viram as a sentence terminator always. In legal Hindi, it often appears inside citations and abbreviations. **Priority: MEDIUM, effort: LOW** (switch to IndicNLP splitter or add exceptions).

## TECHNIQUES TO ADOPT

### Immediate (can ship this week)

#### 1. Indic Numeral Normalization
Adopt IndicTrans2's `INDIC_NUM_MAP` dictionary. Add as a pre-processing step in `TranslationService.translate_text()` before chunking.

```python
# app/services/indic_numeral_normalizer.py
INDIC_NUM_MAP = {"\u09e6": "0", "\u09e7": "1", ...}  # from IndicTrans2

def normalize_indic_numerals(text: str) -> str:
    return "".join(INDIC_NUM_MAP.get(c, c) for c in text)
```

**Impact**: Preserves legal section numbers across scripts. Zero risk, pure improvement.

#### 2. Entity Placeholder Extraction for Legal Citations
Extend our glossary protection to also handle URLs, emails, case citations, and section numbers.

```python
LEGAL_CITATION_PATTERN = r'\(\d{4}\)\s+\d+\s+SCC\s+\d+'  # (2024) 1 SCC 123
SECTION_PATTERN = r'(?:Section|S\.|धारा)\s+\d+[A-Za-z]?'
AIR_PATTERN = r'AIR\s+\d{4}\s+\w+\s+\d+'
```

**Impact**: Prevents corruption of case citations and section references during translation.

#### 3. Punctuation Normalization
Add Moses-style punctuation normalization for English text and basic Unicode normalization for Indic text before sending to Sarvam.

```python
from sacremoses import MosesPunctNormalizer
normalizer = MosesPunctNormalizer()
text = normalizer.normalize(text)  # before chunking
```

**Impact**: Cleaner input produces more consistent translations, especially from OCR output.

### Short-term (1-2 weeks)

#### 4. IndicNLP Sentence Splitting for Indic Languages
Replace our regex-based Indic sentence splitting with IndicNLP's `sentence_split`:

```python
from indicnlp.tokenize.sentence_tokenize import sentence_split, DELIM_PAT_NO_DANDA

def _split_indic_sentences(text: str, lang: str) -> list[str]:
    return sentence_split(text, lang=lang, delim_pat=DELIM_PAT_NO_DANDA)
```

**Dependency**: `pip install indic-nlp-library`. Lightweight, pure Python.
**Impact**: Proper sentence boundary detection for Hindi, Bengali, Tamil, etc. Critical for legal text.

#### 5. Benchmark Evaluation Pipeline
Build `scripts/eval/benchmark_sarvam.py` to run IN22-Gen/IN22-Conv through our pipeline and generate chrF++/BLEU scores. This gives us:
- Baseline quality metrics
- Regression detection on pipeline changes
- Marketing data ("Anuvad achieves X chrF++ on IN22-Gen")

### Evaluated and Rejected

#### Self-hosted IndicTrans2 as Translation Backend
- **Pro**: No API limits, full control, open-source (MIT license)
- **Con**: Requires GPU infrastructure ($500+/month for A100), no legal domain fine-tuning, no formal mode, we'd need to build ALL the production infrastructure (caching, rate limiting, monitoring) that Sarvam provides
- **Verdict**: Not worth it. Sarvam's Mayura model likely incorporates IndicTrans2's training data already, plus proprietary improvements.

#### Script Unification as Pre-processing
- **Pro**: Could help with cross-lingual transfer
- **Con**: Sarvam handles this internally. Adding it would double-process text and potentially confuse language detection.
- **Verdict**: Rejected. Sarvam's API is a black box; adding transliteration before it is unpredictable.

#### IndicTrans2 for Indic-to-Indic Translation
- **Pro**: Direct Indic-Indic model without English pivot
- **Con**: Sarvam already supports direct Indic-Indic translation. Self-hosting adds complexity.
- **Verdict**: Keep monitoring. If Sarvam's Indic-Indic quality is poor on benchmarks, revisit.

---

## Architecture Comparison Summary

```
IndicTrans2 Pipeline:
  Text -> Moses/IndicNLP sentence split -> Normalize numerals ->
  Extract entities (<ID1>) -> Unicode normalize -> Tokenize ->
  Transliterate to Devanagari -> SentencePiece -> Language tags ->
  Fairseq/CT2 model -> SPM decode -> Restore entities ->
  Transliterate to target script -> Detokenize -> Output

Anuvad Pipeline (current):
  Text -> Encoding detection (Krutidev/Chanakya/Shusha) ->
  Language detection (Sarvam) -> Paragraph/character chunking ->
  [per chunk: Cache check -> Glossary protection -> Sarvam API ->
  Glossary restoration -> Cache store] -> Reassemble ->
  Quality scoring -> Output

Anuvad Pipeline (proposed improvements):
  Text -> Encoding detection -> Indic numeral normalization [NEW] ->
  Punctuation normalization [NEW] -> Unicode normalization [NEW] ->
  Language detection -> Entity placeholder extraction [NEW] ->
  IndicNLP sentence splitting [IMPROVED] -> Paragraph/character chunking ->
  [per chunk: Cache check -> Glossary + entity protection ->
  Sarvam API -> Glossary + entity restoration -> Cache store] ->
  Reassemble -> Quality scoring -> Output
```

---

## Action Items (Prioritized)

| # | Task | Priority | Effort | Impact |
|---|------|----------|--------|--------|
| 1 | Add Indic numeral normalization | HIGH | 2 hours | Fixes legal section numbers across scripts |
| 2 | Add entity placeholder extraction (citations, URLs, emails) | HIGH | 1 day | Prevents legal citation corruption |
| 3 | Replace regex sentence splitter with IndicNLP for Indic langs | HIGH | 1 day | Proper boundary detection for legal text |
| 4 | Build IN22-Gen/IN22-Conv benchmark pipeline | HIGH | 2 days | Objective quality measurement |
| 5 | Add punctuation normalization (Moses) | MEDIUM | 2 hours | Cleaner OCR text input |
| 6 | Add per-script Unicode normalization | MEDIUM | 4 hours | Handles Unicode variant characters |
| 7 | Evaluate Sarvam on IN22 benchmarks, publish comparison | MEDIUM | 1 day | Marketing + quality baseline |
