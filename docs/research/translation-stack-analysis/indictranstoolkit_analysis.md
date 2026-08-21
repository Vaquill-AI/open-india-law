# IndicTransToolkit vs Vaquill Translation Pipeline: Comparative Analysis

**Date**: 2026-04-02
**IndicTransToolkit version**: 1.1.1 (Cython-optimized IndicProcessor)
**Vaquill pipeline**: Sarvam AI + LegalGlossaryService + TranslationQualityScorer

---

## Executive Summary

IndicTransToolkit is the official preprocessing/postprocessing toolkit for AI4Bharat's IndicTrans2 NMT models. It operates at a different layer than Vaquill: it wraps a self-hosted HuggingFace model with text normalization, while Vaquill calls Sarvam AI's hosted API. Despite this architectural difference, IndicTransToolkit contains several techniques Vaquill should adopt.

### Top Actionable Findings

1. **HIGH: Indic numeral normalization is missing.** IndicTransToolkit converts all 10 Indic digit scripts (Devanagari, Bengali, Gujarati, Tamil, etc.) to ASCII digits before translation. Vaquill does not normalize Indic numerals at all. This causes "Section ३०२" to be mistranslated or dropped.

2. **HIGH: Entity placeholder system is more robust.** IndicTransToolkit wraps URLs, emails, numerals (dates, percentages, ranges), and hashtags/mentions with `<ID1>`, `<ID2>` placeholders before translation and restores them after. It handles 20+ known NMT failure modes where the model corrupts the placeholder into Indic script (e.g., "आईडी" instead of "ID"). Vaquill only protects legal glossary terms and section references, not general entities.

3. **MEDIUM: Unicode normalization via indic-nlp-library.** IndicTransToolkit applies script-specific Unicode normalization (nukta handling, vowel sign normalization, etc.) through `IndicNormalizerFactory`. Vaquill's only normalization is Krutidev-to-Unicode legacy encoding conversion.

4. **MEDIUM: Transliteration to common script.** IndicTransToolkit transliterates all Indic scripts to Devanagari before feeding to the model, then transliterates back in postprocessing. This is model-specific (IndicTrans2 uses Devanagari as pivot), but the concept of script normalization pre-translation is valuable.

5. **LOW: Formal evaluation metrics (BLEU, chrF2++).** IndicTransToolkit ships `IndicEvaluator` with sacrebleu BLEU and chrF2++ scoring with Indic tokenization. Vaquill uses heuristic quality scoring (length ratio, back-translation similarity, legal term preservation).

---

## 1. IndicProcessor Preprocessing/Postprocessing

### What IndicTransToolkit Does

The `IndicProcessor` (implemented in Cython for performance) applies a 5-stage preprocessing pipeline:

#### Stage 1: Punctuation Normalization (`_punc_norm`)
```python
# 13 regex replacements applied in sequence:
- Carriage return removal
- Whitespace around parentheses collapsed
- Colon/semicolon spacing normalized
- Smart quotes normalized to ASCII: ` ' ' -> '  and  " " -> "
- Em dash/en dash normalized to hyphen
- Ellipsis normalized
- Percentage spacing removed ("50 %" -> "50%")
- Multi-space collapsed to single space
- Closing bracket spacing fixed: ") ." -> ")."
- Digit-space-percent: "50 %" -> "50%"
- Non-breaking space between digits: "1 234" -> "1.234"
```

**Vaquill gap**: No punctuation normalization at all before sending to Sarvam. Smart quotes, em dashes, and inconsistent spacing in legal documents go through untransformed.

#### Stage 2: Numeral Normalization (`_normalize`)
Converts digits from 10 different Indic scripts to ASCII:
```python
# Covers: Devanagari, Bengali, Gujarati, Kannada, Arabic, Meetei Mayek,
# Odia, Gurmukhi, Ol Chiki, Extended Arabic numerals
# Example: "धारा ३०२" -> "धारा 302"
_digits_translation_table = {
    0x0966: "0",  # Devanagari ०
    0x09E6: "0",  # Bengali ০
    0x0AE6: "0",  # Gujarati ૦
    # ... 100 total mappings across 10 scripts
}
text = text.translate(self._digits_translation_table)
```

**Vaquill gap**: Critical. Legal documents frequently contain section numbers in Devanagari digits ("धारा ३०२ भारतीय दण्ड संहिता"). Without normalization, these may not be recognized by Vaquill's `_LEGAL_PATTERNS` regex in `translation_quality.py`, which only matches ASCII digits: `r"(?:Section|S\.|Sec\.)\s*\d+[A-Za-z]*"`.

#### Stage 3: Entity Placeholder Wrapping (`_wrap_with_placeholders`)
Wraps URLs, emails, numerals, and hashtags/mentions:
```python
patterns = [EMAIL_PATTERN, URL_PATTERN, NUMERAL_PATTERN, OTHER_PATTERN]
# NUMERAL_PATTERN catches: "12.5%", "100-200", "15/10/2023", "2023:45"
# URL_PATTERN catches: "https://example.com/path"
# EMAIL_PATTERN catches: "user@domain.com"
# OTHER_PATTERN catches: "#hashtag", "@mention"

# Each match replaced with <ID1>, <ID2>, etc.
# CRITICAL: Also pre-generates 20+ failure-mode variants per placeholder
# because NMT models sometimes transliterate "ID" into Indic scripts:
placeholder_entity_map["<ID1>"] = match
placeholder_entity_map["<id1>"] = match        # lowercase
placeholder_entity_map["[ID1]"] = match        # bracket variant
placeholder_entity_map["आईडी1"] = match        # Hindi transliteration
placeholder_entity_map["آئی ڈی 1"] = match     # Urdu transliteration
placeholder_entity_map["ꯑꯥꯏꯗꯤ1"] = match     # Manipuri transliteration
# ... 20+ Indic script variants of "ID" for each placeholder
```

**Vaquill gap**: Vaquill's `LegalGlossaryService.protect_terms()` only protects:
- Glossary legal terms (66 Hindi + 40 other languages)
- Section references: `धारा 302`, `Section 482 BNSS`
- Case citations: `AIR 2020 SC 1234`, `(2019) 5 SCC 678`

It does NOT protect: URLs, email addresses, dates (15/10/2023), percentage ranges (12.5%-15%), phone numbers, monetary amounts with Indic digits. These entities can be corrupted during translation.

#### Stage 4: Script-specific Tokenization
```python
if iso_lang == "en":
    # Moses tokenizer for English
    tokens = self._en_tok.tokenize(self._en_normalizer.normalize(text))
else:
    # indic-nlp-library tokenizer + Unicode normalization
    normed = normalizer.normalize(sentence)  # IndicNormalizerFactory
    tokens = indic_tokenize.trivial_tokenize(normed, iso_lang)
```

**Vaquill gap**: No tokenization step. Sarvam's API likely handles this internally, but the Unicode normalization step (nukta handling, vowel sign normalization) is valuable for consistency.

#### Stage 5: Transliteration to Devanagari
```python
if transliterate:  # True for Beng, Gujr, Knda, Mlym, Orya, Guru, Taml, Telu scripts
    xlated = self._xliterator.transliterate(joined, iso_lang, "hi")
    xlated = xlated.replace(" ् ", "्")  # Fix halant spacing
```

**Vaquill gap**: Not directly applicable since Sarvam handles multi-script internally, but the halant spacing fix is relevant for post-processing Devanagari output.

### Postprocessing Pipeline

#### Placeholder Restoration
```python
for k, v in placeholder_entity_map.items():
    sent = sent.replace(k, v)
```

#### Script-specific Fixes
```python
# Perso-Arabic: fix spacing before punctuation
if script_code in ["Arab", "Aran"]:
    sent = sent.replace(" ؟", "؟").replace(" ۔", "۔").replace(" ،", "،")

# Odia: fix ya/ya-phalaa confusion
if lang_code == "ory":
    sent = sent.replace("ଯ଼", "ୟ")
```

**Vaquill gap**: No script-specific post-processing at all. Urdu/Kashmiri translations may have incorrect punctuation spacing.

#### Reverse Transliteration + Detokenization
```python
if lang == "eng_Latn":
    return self._en_detok.detokenize(sent.split(" "))
else:
    xlated = self._xliterator.transliterate(sent, "hi", iso_lang)
    return indic_detokenize.trivial_detokenize(xlated, iso_lang)
```

---

## 2. Batch Inference Patterns

### IndicTransToolkit Approach
IndicTransToolkit is designed for local GPU inference with HuggingFace models:

```python
# Preprocess entire batch at once (Cython-optimized loop)
batch = ip.preprocess_batch(sentences, src_lang="eng_Latn", tgt_lang="hin_Deva")

# Tokenize entire batch at once (HF tokenizer with padding)
batch = tokenizer(batch, padding="longest", truncation=True, max_length=256, return_tensors="pt")

# Single GPU forward pass for entire batch
with torch.inference_mode():
    outputs = model.generate(**batch, num_beams=5, max_length=256)

# Postprocess entire batch at once
outputs = ip.postprocess_batch(outputs, lang="hin_Deva")
```

Key design:
- **True batching**: All sentences processed in a single model forward pass
- **Dynamic padding**: `padding="longest"` minimizes padding overhead
- **Left-pad**: `self.tokenizer.padding_side = "left"` in `IndicDataCollator` (required for generation)
- **Placeholder queue**: `Queue()` maintains ordering between pre/post-processing across batch elements
- **Multi-sequence support**: `num_return_sequences` parameter for beam search outputs

### Vaquill Approach
```python
# Chunk text into segments (max 1800 chars each)
chunks = self._chunk_text(converted_text)

# Translate chunks with asyncio.Semaphore(5) concurrency
semaphore = asyncio.Semaphore(_MAX_CONCURRENT_CHUNKS)  # 5 concurrent

async def _translate_chunk(chunk):
    async with semaphore:
        # Cache check -> Glossary protect -> API call -> Glossary restore -> Cache store
        result = await client.translate_text(text=text_to_translate, ...)
```

Key design:
- **API-based**: Each chunk is a separate HTTP request to Sarvam AI
- **Bounded concurrency**: 5 concurrent requests (rate limit aware)
- **Per-chunk caching**: SHA-based translation cache in Supabase
- **No true batching**: Sarvam's `/translate` endpoint is single-text, not batch

### Analysis
The approaches are fundamentally different because IndicTransToolkit runs local models while Vaquill uses a hosted API. However:

1. **Sarvam does not offer a batch endpoint**, so Vaquill's asyncio.gather + semaphore approach is already optimal for the API model.
2. **The 5-concurrent limit** is set by Sarvam's rate limits (60-1000 req/min depending on tier). This is correct.
3. **If Vaquill ever self-hosts IndicTrans2**, the batching pattern from IndicTransToolkit would be directly applicable.
4. **The placeholder Queue pattern** is clever but fragile (ordering-dependent). Vaquill's approach of attaching placeholders directly to the ProtectedText dataclass is safer.

---

## 3. Special Token/Entity Handling

### IndicTransToolkit: Entity Preservation

The `_wrap_with_placeholders` method is the core innovation. It handles:

| Entity Type | Pattern | Example |
|-------------|---------|---------|
| URLs | Complex regex | `https://courts.nic.in/case/123` |
| Emails | Standard email regex | `lawyer@example.com` |
| Numerals | Ranges, percentages, dates, times | `12.5%-15%`, `15/10/2023`, `2023:45` |
| Hashtags/Mentions | `#` or `@` prefixed | `#Section302`, `@SupremeCourt` |

The numeral pattern is particularly comprehensive:
```python
NUMERAL_PATTERN = re.compile(
    r"(~?\d+\.?\d*\s?%?\s?-?\s?~?\d+\.?\d*\s?%|"  # ranges: "12.5%-15%"
    r"~?\d+%|"                                        # percentages: "~50%"
    r"\d+[-\/.,:']\d+[-\/.,:'+]\d+(?:\.\d+)?|"       # dates/times: "15/10/2023"
    r"\d+[-\/.:'+]\d+(?:\.\d+)?)"                     # simple: "12:30"
)
```

Crucially, it then generates **failure-mode variants** for each placeholder. The model sometimes corrupts `<ID1>` into script-specific transliterations. The `_INDIC_FAILURE_CASES` list contains 20+ known corruptions:
```python
_INDIC_FAILURE_CASES = [
    "آی ڈی ",      # Urdu
    "ꯑꯥꯏꯗꯤ",      # Manipuri (Meetei)
    "आईडी",         # Hindi (most common)
    "आई . डी . ",   # Hindi with spaces
    "آئی ڈی ",      # Urdu variant
    "ᱟᱭᱰᱤ",        # Santali (Ol Chiki)
    "आयडी",         # Marathi
    "ऐडि",          # Another variant
    # ... more variants
]
```

### Vaquill: Legal Term Protection

Vaquill's `LegalGlossaryService.protect_terms()` focuses specifically on legal terminology:

```python
# Sorted longest-first to prevent partial matches
# Uses Unicode-aware word boundary detection
for entry in entries_sorted:
    # Check word boundaries using script-range detection
    if self._is_word_boundary(protected, pos, end_pos):
        ph = f"__LEGAL_TERM_{idx}__"
        protected = protected[:pos] + ph + protected[end_pos:]
        placeholders[ph] = self._clean_target_term(entry.target_term)
```

**Strengths of Vaquill's approach**:
- Unicode-aware word boundary detection (checks script ranges, not just `\b`)
- Longest-match-first prevents "न्याय" from matching inside "न्यायालय"
- Category-aware (party designation, criminal law, court procedure, etc.)
- DB-backed with hot reload capability

**Gaps compared to IndicTransToolkit**:
1. No URL/email/hashtag protection
2. No numeric range/percentage/date protection
3. No failure-mode variant handling (if Sarvam corrupts `__LEGAL_TERM_1__`, there is no recovery)
4. Section numbers (धारा ३०२) with Indic digits may not match the protection regex

### Recommendations for Entity Handling

**HIGH priority**: Add Indic digit normalization before the glossary protection step:
```python
# Add to translation_service.py before chunking
converted_text = self._normalize_indic_digits(converted_text)
```

**HIGH priority**: Add entity placeholders for URLs, emails, dates, and numeric ranges:
```python
# Before glossary protection, wrap non-legal entities
protected = self._wrap_entities(text)  # URLs, emails, dates
# Then apply glossary protection on top
```

**MEDIUM priority**: Add failure-mode handling. If Sarvam corrupts `__LEGAL_TERM_1__` to `__कानूनी शब्द_1__` or similar, the restoration step silently fails. Consider:
- Checking if all placeholders were restored
- Logging unrestored placeholders as quality flags
- Pre-generating known corruption variants (like IndicTransToolkit does)

---

## 4. Transliteration (IndicXlit)

### IndicTransToolkit's Transliteration

Uses `UnicodeIndicTransliterator` from `indic-nlp-library` for bidirectional script conversion:

```python
# Preprocessing: Convert source script -> Devanagari (pivot script for IndicTrans2)
xlated = self._xliterator.transliterate(joined, iso_lang, "hi")
xlated = xlated.replace(" ् ", "्")  # Fix halant spacing artifact

# Postprocessing: Convert Devanagari -> target script
xlated = self._xliterator.transliterate(sent, "hi", iso_lang)
```

Scripts that skip transliteration (already compatible): `Arab`, `Aran`, `Olck`, `Mtei`, `Latn`.

This is model-specific: IndicTrans2 uses Devanagari as a pivot script internally.

### Should Vaquill Add Transliteration?

**Not as a preprocessing step** (Sarvam handles multi-script internally), but **as a user-facing feature**:

1. **Transliteration output mode**: Users may want Hindi text rendered in Latin script (for reading aloud in court) or vice versa. This is distinct from translation.

2. **Romanization for search**: Legal terms in Indic scripts need to be searchable in Latin characters. A transliteration layer would help.

3. **Cross-script glossary matching**: If a user types "dharaa 302" (Romanized Hindi), Vaquill could transliterate to "धारा 302" and match the glossary.

**Recommendation (LOW priority)**: Consider adding transliteration as a separate user-facing feature using `indic-nlp-library`'s `UnicodeIndicTransliterator`. Not needed for the core translation pipeline since Sarvam handles it.

---

## 5. Mixed-Language Text Handling

### IndicTransToolkit's Approach

IndicTransToolkit handles mixed English-Indic text through:

1. **Language tags**: Prepends source and target language codes to each sentence:
   ```python
   return f"{src_lang} {tgt_lang} {processed_sent}"
   # Example: "eng_Latn hin_Deva This is a test sentence."
   ```

2. **Script-based routing**: English text goes through Moses tokenizer, Indic text goes through indic-nlp-library tokenizer. The entity placeholder system preserves English entities embedded in Indic text.

3. **No explicit code-switching handling**: IndicTransToolkit does not detect or specially handle code-switched text (e.g., "उसने court में appeal file किया"). This is left to the NMT model.

### Vaquill's Approach

Vaquill handles mixed text through:

1. **Glossary term protection**: Legal terms in both English and Indic scripts are protected with placeholders.
2. **Section reference protection**: Regex catches both "Section 302" and "धारा 302".
3. **Sarvam's `enable_preprocessing`**: Available but currently set to `False` by default.

### Gap Analysis

Neither toolkit handles code-switched legal text well. In Indian legal documents, code-switching is extremely common:

```
"उक्त accused ने Section 302 IPC के अंतर्गत cognizable offence committed किया है"
```

In this sentence, English legal terms are embedded in Hindi. The challenges:
- "accused" should remain "accused" when translating to English (not be treated as Hindi)
- "cognizable offence" should be recognized as a legal term pair

**Recommendation (MEDIUM priority)**: Add a code-switch detection step that identifies English words embedded in Hindi text and either:
- Adds them to the protection list (if they are legal terms)
- Tags them for the translation engine (Sarvam's `enable_preprocessing` may help)

---

## 6. Quality Metrics Comparison

### IndicTransToolkit: IndicEvaluator

Uses formal MT evaluation metrics from the `sacrebleu` library:

```python
class IndicEvaluator:
    def __init__(self):
        self._chrf2_metric = CHRF(word_order=2)       # chrF2++
        self._bleu_metric_13a = BLEU(tokenize="13a")   # BLEU with 13a tokenization
        self._bleu_metric_none = BLEU(tokenize="none")  # BLEU without tokenization

    def evaluate(self, tgt_lang, preds, refs):
        if tgt_lang == "eng_Latn":
            return self._compute_scores(preds, refs, use_13a=True)
        else:
            # Normalize + tokenize before scoring (Indic-aware)
            preds_processed = self._preprocess_batch(preds, tgt_lang)
            refs_processed = self._preprocess_batch(refs, tgt_lang)
            return self._compute_scores(preds_processed, refs_processed)
```

Key features:
- **Indic-aware preprocessing**: Normalizes and tokenizes using `indic-nlp-library` before computing BLEU
- **chrF2++ (character n-gram F-score)**: More robust than BLEU for morphologically rich Indic languages
- **Streaming evaluation**: `evaluate_streaming()` for large file evaluation with batched processing
- **Language-specific normalization**: Uses `IndicNormalizerFactory` with per-language ISO codes

### Vaquill: TranslationQualityScorer

Heuristic quality scoring without reference translations:

```python
class TranslationQualityScorer:
    async def score(self, source_text, translated_text, source_lang, target_lang):
        # 1. Length ratio check (language-pair-specific ranges)
        # 2. Legal term preservation (section refs, citations, act/year)
        # 3. Untranslated fragment detection (script pattern matching)
        # 4. Number/date preservation
        # 5. Bracket/parenthesis balance
        # 6. Optional back-translation similarity (SequenceMatcher)
```

Key features:
- **No reference translation needed**: Works at inference time, not evaluation time
- **Legal-domain-specific**: Checks for section numbers, case citations, act references
- **Language-pair-aware**: Different length ratio ranges for North Indian vs South Indian languages
- **Back-translation**: Optional round-trip quality check using SequenceMatcher

### Comparison

| Aspect | IndicTransToolkit | Vaquill |
|--------|------------------|---------|
| **Purpose** | Offline evaluation against references | Online quality estimation |
| **Reference needed** | Yes (gold translations) | No |
| **Metrics** | BLEU, chrF2++ | Heuristic composite score |
| **Indic-aware** | Yes (normalization + tokenization) | Partial (script detection only) |
| **Legal domain** | No | Yes (section refs, citations) |
| **Streaming** | Yes (batched file evaluation) | No (single translation) |
| **Cost** | Free (local computation) | Optional API call (back-translation) |

### Recommendations

**MEDIUM priority**: Add chrF2++ or BLEU scoring for back-translation comparison instead of `SequenceMatcher`:
```python
# Current: SequenceMatcher (string edit distance, not translation-quality-aware)
similarity = SequenceMatcher(None, norm_source, norm_back).ratio()

# Better: Use sacrebleu chrF2++ (no tokenization needed, works on character level)
from sacrebleu.metrics import CHRF
chrf = CHRF(word_order=2)
score = chrf.corpus_score([norm_back], [[norm_source]])
```

This would give more meaningful quality signals, especially for morphologically rich languages where word order differs but meaning is preserved.

**LOW priority**: Add Indic-aware normalization before quality comparison. Currently Vaquill compares raw strings, but Unicode normalization differences (nukta, vowel signs) can cause false quality flags.

---

## Prioritized Recommendations Summary

### HIGH Priority

| # | Recommendation | Effort | Impact |
|---|---------------|--------|--------|
| 1 | **Add Indic digit normalization** (10 scripts to ASCII). Add a `_normalize_indic_digits()` step in `translation_service.py` before chunking. Reuse IndicTransToolkit's digit translation table. | Small (50 lines) | High. Section numbers in Devanagari digits are currently invisible to quality checks and may be corrupted in translation. |
| 2 | **Add entity placeholder protection** for URLs, emails, dates, and numeric ranges. Extend `LegalGlossaryService` or add a separate `EntityProtector` class. | Medium (150 lines) | High. Phone numbers, dates, and URLs in legal documents are currently unprotected and can be corrupted by Sarvam. |
| 3 | **Add placeholder corruption detection**. After `restore_terms()`, check if any `__LEGAL_TERM_X__` placeholders remain unrestored. Log as quality flag. | Small (20 lines) | High. Silent failures in glossary restoration currently go undetected. |

### MEDIUM Priority

| # | Recommendation | Effort | Impact |
|---|---------------|--------|--------|
| 4 | **Add punctuation normalization** (smart quotes, em dashes, spacing). Port IndicTransToolkit's `_punc_norm()` to a Python function in the translation pipeline. | Small (40 lines) | Medium. Improves translation consistency for documents with varied formatting. |
| 5 | **Add Unicode normalization** using `indic-nlp-library`. Run `IndicNormalizerFactory().get_normalizer(lang).normalize()` on input text before translation. | Small (30 lines) | Medium. Prevents Unicode encoding variants from causing inconsistent translations. |
| 6 | **Replace SequenceMatcher with chrF2++** in back-translation quality scoring. | Small (15 lines) | Medium. More accurate quality signal for Indic languages. |
| 7 | **Add Perso-Arabic post-processing** (Urdu, Kashmiri, Sindhi). Fix punctuation spacing for Arabic-script outputs. | Small (10 lines) | Medium. Currently Urdu translations may have spacing issues around question marks and commas. |

### LOW Priority

| # | Recommendation | Effort | Impact |
|---|---------------|--------|--------|
| 8 | **Add transliteration as a user feature** (Indic-to-Latin and Latin-to-Indic). | Medium (100 lines) | Low for translation quality, high for user experience. |
| 9 | **Add code-switch detection** for mixed Hindi-English legal text. | High (200+ lines) | Low. Sarvam handles most cases acceptably. |
| 10 | **Consider self-hosting IndicTrans2** for offline/batch translation. Would enable true batching and eliminate API rate limits. | Very High | Strategic. Only if Sarvam costs become prohibitive. |

---

## Appendix: Key File Paths

### IndicTransToolkit
- Processor (Cython): `data/reference-repos/IndicTransToolkit/IndicTransToolkit/processor.pyx`
- Evaluator: `data/reference-repos/IndicTransToolkit/IndicTransToolkit/evaluator.py`
- Data Collator: `data/reference-repos/IndicTransToolkit/IndicTransToolkit/collator.py`

### Vaquill Translation Pipeline
- Translation Service: `app/services/translation_service.py`
- Sarvam AI Client: `app/integrations/sarvam_ai.py`
- Legal Glossary: `app/services/legal_glossary_service.py`
- Quality Scorer: `app/services/translation_quality.py`
- Encoding Converter: `app/services/encoding_converter.py`
