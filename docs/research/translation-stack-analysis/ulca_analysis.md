# ULCA/Bhashini Architecture Analysis vs Anuvad.ai

**Date:** 2026-04-02
**Scope:** ULCA (Universal Language Contribution APIs) powering bhashini.gov.in, compared with Vaquill's Anuvad translation platform.

---

## Executive Summary

ULCA is a national-scale, multi-provider translation infrastructure designed for open contribution and benchmarking. Anuvad is a focused legal translation product with a single primary provider (Sarvam AI). The key architectural patterns worth adopting from ULCA are: **multi-provider routing with fallback**, **structured feedback loops**, and **formal benchmark evaluation using standard NLP metrics**. However, ULCA's complexity (12+ Java microservices, Kafka, MongoDB, Druid, Zuul gateway) is overkill for Anuvad's current scale.

---

## 1. Model Registry and Multi-Provider Orchestration

### How ULCA Does It

ULCA operates as a **model marketplace**. It does not host models. Instead, providers (AI4Bharat, C-DAC, IIIT-H, etc.) register their inference endpoints.

**Model registration schema** (`specs/model-schema.yml`):
- Each model declares: `name`, `task` (translation/asr/tts/ocr), `languages` (source/target pairs), `domain` (legal, news, healthcare, etc.), `license`, and critically, an `inferenceEndPoint` with:
  - `callbackUrl` (the actual model API)
  - `inferenceApiKey` (auth for that endpoint)
  - `schema` (discriminated union: TranslationInference, ASRInference, etc.)
  - `isSyncApi` flag + `asyncApiDetails` (polling URL, interval)

**Pipeline orchestration** (`specs/pipeline-inference-schema.yml`, `specs/tasks-pipeline-schemas.yml`):
- Service providers register full **pipeline configurations** via `PipelineInference`
- Each provider declares `supportedPipelines` (sequences of tasks like [ASR, Translation, TTS])
- `taskSpecifications` list per-language-pair model configs with `modelId` and `serviceId`
- Client requests specify `pipelineId` (e.g., "AI4BharatID") and task sequence; the pipeline returns endpoint details for each task

**Key pattern: per-language-pair model routing**
```yaml
ConfigSchema:
  modelId: "63c9586ea0e5e81614ff96a8"
  serviceId: "ai4bharat/speech-to-speech-gpu--t4"
  sourceLanguage: "hi"
  targetLanguage: "en"
```
Different `modelId` + `serviceId` for each language pair. This means ULCA can route Hindi-to-English through AI4Bharat's model but Tamil-to-English through IIIT-H's model.

### How Anuvad Does It

Single provider: Sarvam AI (`app/integrations/sarvam_ai.py`). No model registry, no per-language-pair routing. All 22+ languages go through the same API. Glossary protection/restoration handled by `legal_glossary_service.py`.

Refinement levels (`standard`, `legal_refined`) exist but both use Sarvam. No fallback if Sarvam is down.

### Recommendations

| Priority | Action | Effort |
|----------|--------|--------|
| **HIGH** | Add a `TranslationProvider` abstraction with `translate_text()` interface. Register Sarvam, Google Cloud Translation, and IndicTrans2 (AI4Bharat open-source) as providers. | 2-3 days |
| **HIGH** | Implement per-language-pair provider routing. Some pairs (en-hi, en-ta) have strong Sarvam support; others (en-ks, en-sat) may be better served by Google or a fallback. Store routing config in DB, not code. | 1-2 days |
| **MEDIUM** | Add circuit-breaker-based fallback: if Sarvam fails 3x, route to Google Cloud Translation automatically. Circuit breaker infrastructure already exists in `app/core/circuit_breaker.py`. | 1 day |
| **LOW** | Consider IndicTrans2 self-hosting for cost reduction at scale. AI4Bharat's model is MIT-licensed and handles all 22 scheduled languages. Would eliminate per-API-call costs for high-volume users. | 1 week+ |

**Provider abstraction sketch:**
```python
class TranslationProvider(ABC):
    @abstractmethod
    async def translate(self, text: str, source: str, target: str) -> TranslationResult: ...
    @abstractmethod
    def supported_pairs(self) -> set[tuple[str, str]]: ...

class ProviderRouter:
    def get_provider(self, source: str, target: str, domain: str = "legal") -> TranslationProvider:
        # 1. Check domain-specific overrides (legal -> Sarvam with glossary)
        # 2. Check language-pair routing table
        # 3. Fall back to default provider
        ...
```

---

## 2. Dataset Contribution and Feedback Loop

### How ULCA Does It

ULCA's dataset pipeline is its core differentiator. It crowdsources parallel corpus data at national scale.

**Contribution pipeline** (Kafka-driven, 3 microservices):
1. `ulca-dataset-ingest` -- accepts uploads (JSON format: `params.json` + `data.json`)
2. `dataset/validate` -- Chain-of-Responsibility validation pipeline:
   - `BasicSchemaCheck` -> `TextLanguageCheck` -> `WordLengthCheck` -> `ProfanityCheck` -> `RemoveDuplicateWhitespaces` -> `RemoveSpecialCharacters` -> `HashDedup`
   - Config-driven: each dataset type (parallel, glossary, ASR, etc.) has its own JSON config enabling/disabling validators
   - Language detection via Polyglot with fallback heuristics for under-resourced languages (Dogri, Konkani, Maithili mapped to Hindi/Marathi detectors)
3. `dataset/publish` -- publishes validated data to MongoDB, with deduplication (SHA-256 hash of sentence pairs)

**Feedback schema** (`specs/pipeline-feedback-schema.yml`):
- Rich, multi-level: pipeline-level feedback + per-task feedback
- Feedback types: `rating` (1-5), `comment`, `thumbs` (like/dislike), `rating-list`, `comment-list`, `checkbox-list`
- Captures `pipelineInput` + `pipelineOutput` + `suggestedPipelineOutput` (user's correction)
- Translation-specific questions: "Are you satisfied with this translation?" with 5-star rating
- Granular parameters: accuracy, fluency (from `translationDetailedQns.json`)

**Data tracking** (`specs/endpoint-data-tracking-schema.yml`):
- Opt-in toggle: `dataTracking: boolean` per API key
- When enabled, all inference input/output pairs are logged and visible to model providers

### How Anuvad Does It

No feedback loop currently. Users can edit translations in the document view, but edits are not captured as training signal. No structured feedback collection. Quality scoring (`translation_quality.py`) runs post-hoc but results are not fed back to improve translations.

### Recommendations

| Priority | Action | Effort |
|----------|--------|--------|
| **HIGH** | Add thumbs up/down + optional correction on each translation. Store as `translation_feedback` table: `translation_id`, `user_id`, `rating`, `suggested_text`, `feedback_type`. This is the minimum viable feedback loop. | 1-2 days |
| **HIGH** | When users edit translated documents, capture the diff as implicit feedback. Store `(source_chunk, machine_translation, user_edit, language_pair)` tuples. This is gold-standard parallel corpus data for legal domain. | 1 day |
| **MEDIUM** | Build a legal parallel corpus from accumulated feedback. After 1000+ corrections, this becomes training data for fine-tuning or few-shot prompting. Structure: ULCA-compatible `params.json` + `data.json` format for potential contribution back to Bhashini. | 1 week |
| **MEDIUM** | Add ULCA-style validation pipeline for glossary contributions: language check, dedup, profanity filter. Current glossary pipeline (`step4b_parse_trilingual.py`) is batch-only. | 2-3 days |
| **LOW** | Data tracking toggle (ULCA pattern): let enterprise users opt-in to sharing anonymized translation pairs for model improvement, with legal consent. | 1 day |

**Feedback table schema:**
```sql
CREATE TABLE translation_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    translation_id UUID REFERENCES translations(id),
    user_id UUID NOT NULL,
    rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
    is_liked BOOLEAN,  -- thumbs up/down
    suggested_text TEXT,  -- user's correction
    feedback_type TEXT DEFAULT 'rating',
    source_chunk TEXT,
    machine_output TEXT,
    language_pair TEXT,  -- e.g., "hi_en"
    created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 3. Quality Benchmarking Framework

### How ULCA Does It

ULCA has a comprehensive, Kafka-driven benchmarking system.

**Benchmark metrics** (`backend/model/benchmark-metrics/metrics/`):
- **Translation**: BLEU (sacrebleu), BERTScore, METEOR, chrF, GLEU, RIBES, ROUGE
  - BLEU uses Indic-specific tokenization (`indicnlp.tokenize.indic_tokenize`) and normalization (`indicnlp.normalize.indic_normalize`)
  - BERTScore supports: en, bn, kn, hi, ta, te, pa, mr, ur, ne, ml
  - Moses tokenizer for English, Indic tokenizer for all others
- **ASR**: WER (Word Error Rate), CER (Character Error Rate)
- **OCR**: WER, CER (word and character level)
- **Transliteration**: CER, Top-1 accuracy, Top-5 accuracy

**Benchmark execution pipeline**:
1. Benchmark datasets submitted by subject matter experts (curated test sets)
2. `ulca-benchmark-download` service (Java/Spring Boot) downloads benchmark data, calls model inference endpoints, collects results
3. `benchmark-metrics` service (Python) computes scores using the metric implementations
4. Results stored per-model, creating a **leaderboard**
5. Communication via Kafka: `BenchmarkDownload` -> `BenchmarkMetric` topics

**Key insight: Indic-aware preprocessing.** ULCA doesn't just run sacrebleu out-of-the-box. They normalize and tokenize using IndicNLP Library before computing BLEU, which avoids penalizing valid morphological variations.

### How Anuvad Does It

`translation_quality.py` implements a **heuristic quality scorer** (not corpus-based metrics):
1. Length ratio analysis (per-language-pair expected ranges)
2. Legal term preservation (regex: Section references, case citations, Act/year)
3. Untranslated fragment detection (Devanagari/Bengali/Tamil script in English output)
4. Number/date preservation check
5. Bracket/parenthesis balance
6. Optional back-translation similarity (SequenceMatcher, expensive)

This is **operational quality monitoring**, not benchmark evaluation. It catches gross errors but cannot measure translation quality against ground truth.

### Comparison

| Dimension | ULCA | Anuvad |
|-----------|------|--------|
| Metric type | Corpus-based (BLEU, BERTScore, METEOR) | Heuristic (length ratio, pattern preservation) |
| Ground truth | Curated benchmark datasets | None (no reference translations) |
| Indic preprocessing | Yes (IndicNLP tokenizer/normalizer) | No |
| Domain-specific | General + domain tags | Legal-specific (Section refs, citations) |
| Execution | Async Kafka pipeline | Inline, post-response |
| Leaderboard | Yes (model comparison) | No |
| Cost | High (requires reference data + compute) | Low (regex + string comparison) |

### Recommendations

| Priority | Action | Effort |
|----------|--------|--------|
| **HIGH** | Build a legal translation benchmark dataset. Collect 200-500 sentence pairs across 5 core language pairs (en-hi, en-ta, en-bn, en-mr, en-gu) from verified legal translations. Store as ULCA-format JSON. | 1-2 weeks (data collection) |
| **HIGH** | Add BLEU score computation with IndicNLP preprocessing. Use sacrebleu + indic-nlp-library (both pip-installable). Run against benchmark set on each provider/model change. | 1 day (code) |
| **MEDIUM** | Add BERTScore for supported language pairs. More robust than BLEU for legal text where paraphrasing is acceptable. | 0.5 days |
| **MEDIUM** | Track quality scores over time per language pair. Detect quality regressions when Sarvam updates their models. Alert via existing Sentry/structlog. | 1 day |
| **LOW** | Consider chrF metric (character n-gram F-score). Works well for morphologically rich Indic languages where word-level BLEU underperforms. | 0.5 days |

**Benchmark runner sketch:**
```python
from sacrebleu.metrics import BLEU, CHRF
from indicnlp.tokenize import indic_tokenize
from indicnlp.normalize import indic_normalize

class LegalTranslationBenchmark:
    def evaluate(self, predictions: list[str], references: list[str], lang: str) -> dict:
        # Preprocess with IndicNLP (ULCA pattern)
        if lang != "en":
            factory = indic_normalize.IndicNormalizerFactory()
            normalizer = factory.get_normalizer(lang)
            predictions = [" ".join(indic_tokenize.trivial_tokenize(
                normalizer.normalize(s.strip()), lang)) for s in predictions]
            references = [" ".join(indic_tokenize.trivial_tokenize(
                normalizer.normalize(s.strip()), lang)) for s in references]

        bleu = BLEU(tokenize='none')
        chrf = CHRF()
        return {
            "bleu": bleu.corpus_score(predictions, [references]).score,
            "chrf": chrf.corpus_score(predictions, [references]).score,
        }
```

---

## 4. API Design Patterns: Rate Limiting, Billing, Quotas

### How ULCA Does It

**Authentication**: Zuul API Gateway (`ulca-zuul-api-gw`) with RBAC:
- `roles.json` defines roles, `role-actions.json` maps roles to allowed endpoints, `actions.json` defines endpoints
- API keys generated per app (`emailId` + `appName`), with data tracking toggle
- Key generation/deletion via dedicated endpoints

**Rate limiting**: Zuul gateway-level (pre-filter). No per-user billing. ULCA is government-funded, free to use.

**Quotas**: Not explicitly defined in the codebase. The platform is designed for open contribution, not commercial use.

**Pipeline compute flow**:
1. Client requests pipeline config (languages, task types)
2. Server returns available models + inference endpoint
3. Client calls inference endpoint directly with API key
4. Provider handles rate limiting on their side

### How Anuvad Does It

**Billing**: Sophisticated page-based system (`translation_billing.py`):
- 10 free pages/month, then purchasable packs (100/500/2000 pages)
- Org-level pooling (all members consume from org owner's balance)
- Atomic Postgres RPCs (`consume_translation_pages`, `grant_translation_pages`)
- Separate OCR credit pool (50 free pages/month)
- Per-page pricing: Rs 12-20/page depending on pack size
- Minimum billable page threshold: 200 chars (skip cover pages, blanks)

**Rate limiting**: `rate_limit_endpoint` decorator on API routes (from `app/core/rate_limit.py`)

**Authentication**: Supabase JWT (`app/core/security.py`), multi-tenant with org context

### Comparison

| Dimension | ULCA | Anuvad |
|-----------|------|--------|
| Auth | API key + Zuul RBAC | Supabase JWT + RLS |
| Billing | Free (government) | Page-based, freemium |
| Rate limiting | Gateway-level | Per-endpoint decorator |
| Multi-tenancy | User + org (simple) | User + org + matter (deep) |
| Quotas | None | Per-tier page quotas |
| Atomicity | Not needed (free) | Postgres RPCs (critical) |

### Recommendations

| Priority | Action | Effort |
|----------|--------|--------|
| **MEDIUM** | Add per-language-pair cost tracking. Some providers may charge differently (Google vs Sarvam). Store `provider_cost` alongside `credits_used` in translation records. | 0.5 days |
| **LOW** | Consider ULCA-style API key system for enterprise B2B integrations (separate from Supabase JWT). Useful for letting law firms integrate Anuvad into their DMS without OAuth flows. | 2-3 days |

Anuvad's billing system is significantly more sophisticated than ULCA's (which has none). No changes needed here. The org-level pooling and atomic Postgres RPCs are production-grade patterns that ULCA doesn't address.

---

## 5. Judicial Document Handling

### How ULCA Does It

ULCA has **no judicial-specific pipeline**. The `domain` field supports "legal" as a tag, but there is no specialized processing. The `Source` schema includes `https://main.sci.gov.in` as an example URL, suggesting awareness of legal data sources, but no dedicated extraction or formatting logic.

Dataset types relevant to legal: `parallel-corpus` (sentence pairs), `glossary-corpus` (domain terms). Both are general-purpose. The glossary validation pipeline has most checks **disabled** (only `RemoveDuplicateWhitespaces`, `RemoveSpecialCharacters`, `HashDedup` are active).

### How Anuvad Does It

Deep legal specialization:
- **Glossary service**: `legal_glossary_service.py` with term protection/restoration (placeholder injection before translation, restoration after)
- **Vidhi Shabdavali**: Digitizing 65K Hindi legal terms from government PDFs
- **Encoding converter**: Handles legacy Indian legal encodings (Krutidev, Chanakya, Shusha)
- **Quality scorer**: Legal-specific checks (Section references, case citations, Act/year preservation)
- **Certified translation**: PDF generation with certification marks
- **OCR pipeline**: Mistral OCR for scanned legal PDFs, with PyMuPDF4LLM fallback

### Assessment

Anuvad is **far ahead** of ULCA in legal document handling. ULCA provides generic infrastructure; Anuvad provides domain-specific intelligence. This is the core competitive advantage. No changes needed from ULCA here.

The one ULCA pattern to consider: contributing back anonymized legal parallel corpus to Bhashini as a `glossary-corpus` type dataset, increasing Anuvad's visibility in the national ecosystem.

---

## 6. Multi-Model Routing

### How ULCA Does It

**Explicit per-task, per-language-pair model selection:**
```yaml
taskSpecifications:
  - taskType: translation
    taskConfig:
      - modelId: "model_a"
        serviceId: "ai4bharat/nmt-en-hi"
        sourceLanguage: "en"
        targetLanguage: "hi"
      - modelId: "model_b"
        serviceId: "cdac/nmt-en-ta"
        sourceLanguage: "en"
        targetLanguage: "ta"
```

Each pipeline provider pre-declares which model handles which language pair. The orchestration layer doesn't dynamically select models; the provider's configuration determines routing.

**No quality-based dynamic routing.** ULCA benchmarks models and publishes scores, but doesn't automatically route traffic to the best-performing model. That selection is manual (by the pipeline provider or the client choosing a `pipelineId`).

### How Anuvad Does It

Currently: single model (Sarvam) for all pairs. The `refinement_level` field (`standard` vs `legal_refined`) is the only routing dimension.

### Recommendations

| Priority | Action | Effort |
|----------|--------|--------|
| **HIGH** | Implement a routing table: `(source_lang, target_lang, domain)` -> `provider`. Start with two providers (Sarvam primary, Google fallback). | 1-2 days |
| **MEDIUM** | Add quality-aware routing: track BLEU/quality scores per provider per language pair. When a new benchmark run shows Provider B outperforms Provider A for ta-en, update the routing table. Can be manual initially, automated later. | 2-3 days |
| **LOW** | Consider A/B testing: route 10% of traffic to a challenger provider, compare quality scores, promote if better. Requires the feedback loop from Section 2. | 1 week |

**Routing table schema:**
```sql
CREATE TABLE translation_routing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_language TEXT NOT NULL,
    target_language TEXT NOT NULL,
    domain TEXT DEFAULT 'legal',
    provider TEXT NOT NULL,  -- 'sarvam', 'google', 'indictrans2'
    priority INT DEFAULT 1,  -- lower = preferred
    is_active BOOLEAN DEFAULT true,
    bleu_score FLOAT,  -- last benchmark score
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 7. Architecture Comparison

### ULCA Architecture
```
Client -> Zuul API Gateway -> Microservices (Java/Spring Boot)
                                  |
                          Dataset API    Model API    UMS    Notifier
                                  |          |
                          Kafka Topics (ingest, validate, publish, benchmark)
                                  |
                      Python Workers (validation, metrics)
                                  |
                          MongoDB    Redis    Druid (analytics)
```

- 12+ microservices (Java-heavy)
- Kafka for async processing (dataset ingestion, benchmark execution)
- MongoDB for flexible document storage
- Redis for caching and task tracking
- Druid for analytics/metrics
- Zuul for API gateway/RBAC

### Anuvad Architecture
```
Client -> FastAPI (single service)
              |
    API Routes -> Services -> Integrations (Sarvam, Supabase, R2)
              |
    Celery Workers (async doc translation, cleanup)
              |
    Supabase (Postgres) + Redis + R2 (storage)
```

- Monolith (FastAPI), well-structured with service layer
- Celery for async tasks (document translation, cleanup)
- Supabase/Postgres for data + auth + billing
- Redis for caching
- R2 for document storage

### Assessment

Anuvad's monolithic architecture is appropriate for current scale. ULCA's microservices introduce operational complexity (12+ services to deploy, Kafka cluster to maintain, MongoDB + Redis + Druid) that is justified at national scale but not for a focused product.

**Do not adopt**: ULCA's microservice architecture, Kafka, MongoDB, Zuul gateway.
**Do adopt**: Their schema design patterns (provider registration, pipeline configuration, feedback collection).

---

## 8. Priority Roadmap

### Phase 1: Immediate (This Sprint)
1. **Translation feedback table** + thumbs up/down UI component
2. **Capture document edits as implicit feedback** (diff between machine output and user edit)
3. **TranslationProvider abstraction** with Sarvam + Google Cloud as providers

### Phase 2: Next Sprint
4. **Per-language-pair routing table** with fallback logic
5. **Legal benchmark dataset** (start collecting 200+ verified sentence pairs)
6. **BLEU + chrF scoring** with IndicNLP preprocessing

### Phase 3: Medium-term
7. **Quality-aware routing**: benchmark scores influence provider selection
8. **A/B testing infrastructure** for comparing providers
9. **Legal parallel corpus export** in ULCA-compatible format
10. **IndicTrans2 self-hosting evaluation** for cost reduction

### Not Recommended
- Migrating to microservices (premature at current scale)
- Building a full model marketplace (not Anuvad's value prop)
- Kafka event streaming (Celery + Redis is sufficient)
- MongoDB (Supabase/Postgres is the right choice for structured legal data)

---

## Appendix: ULCA Codebase Map

```
ulca/
  specs/                          # OpenAPI schemas (the real documentation)
    model-schema.yml              # Model registration contract
    pipeline-inference-schema.yml # Provider pipeline registration
    tasks-pipeline-schemas.yml    # Client pipeline request/response
    compute-pipeline-schemas.yml  # Inference request/response
    pipeline-feedback-schema.yml  # Feedback collection
    model-benchmark-schema.yml    # Benchmark definitions
    common-schemas.yml            # Shared: languages, domains, licenses
    endpoint-apikey-schemas.yml   # API key management
    endpoint-data-tracking-schema.yml  # Data logging toggle
  master-data/prod/               # Configuration master data
    languages.json                # 22 supported Indic languages
    modelTasks.json               # translation, asr, tts, ocr, transliteration, txt-lang-detection
    feedbackQns.json              # Feedback question templates
    benchmarkASRMetrics.json      # WER, CER
  backend/
    api/                          # Java microservices
      ulca-dataset-api/           # Dataset CRUD + Kafka publishing
      ulca-zuul-api-gw/           # API gateway with RBAC
      ulca-ums-service/           # User management
      ulca-notifier/              # Notifications
      master-data-management-service/
    dataset/                      # Python dataset pipeline
      validate/                   # Chain-of-Responsibility validators
        validations/              # TextLanguageCheck, ProfanityCheck, HashDedup, etc.
        configs/                  # Per-dataset-type validator configs (JSON)
      publish/                    # MongoDB publishers
      ulca-dataset-ingest/        # Upload ingestion
      ulca-dataset-download/      # Download service
    model/                        # Model + benchmark services
      api/ulca-model-api/         # Java: model CRUD, benchmark orchestration
      ulca-benchmark-download/    # Java: benchmark execution pipeline
      benchmark-metrics/          # Python: BLEU, BERTScore, METEOR, chrF, GLEU, RIBES, ROUGE, WER, CER
    metric/                       # Analytics
      ulca-metric-api/            # Usage metrics
      druid/                      # Druid analytics configs
```
