# Tribunals

Generated 2026-07-28 by `scripts/audit/` against live Qdrant (`our production Qdrant`) and Supabase `legal_cases`.
All counts are exact full-collection counts, not samples or estimates.
See [02-methodology.md](../02-methodology.md) for how each number is produced.

## Correction

An earlier version of this page said we hold no tribunal data at all.
That was wrong. We hold **813,168 tribunal and regulator matters** and **2,112,201 decision documents**, in Supabase tables and object storage.
They are absent from the two searchable case-law collections, which is what this audit measures, so a court-scoped search never reaches them.
See [../tribunals/README.md](../tribunals/README.md) for the full inventory.

## There is no tribunal data in the searchable case-law corpus

Every one of the 76 raw court labels across `legal_corpus_v1` and `legal_corpus_v2` is a High Court or the Supreme Court.
The `court_type` payload field only ever takes two values:

| court_type | Chunks |
|---|---:|
| `high_court` | 31,048,312 |
| `supreme_court` | 371,159 |

No point in either collection carries a tribunal court name, so NCLT, ITAT, CESTAT, SAT, DRT, CAT, NGT and the rest are unreachable by retrieval even though the underlying decisions are held elsewhere.

## The retrieval layer is already built for tribunals

This is a data gap, not a code gap.
`app/rag/ranking/court_boost.py` defines `CourtLevel.TRIBUNAL` and maps NCLT, NCLAT, ITAT, CESTAT, CAT, NGT, NCDRC, SCDRC and TDSAT to it, with a 1.0x precedence boost.
`app/rag/pipeline.py` classifies any court name containing `tribunal`, `nclt`, `nclat`, `itat` or `cestat` as a tribunal.
`app/rag/temporal/precedent.py` documents tribunal precedence rules.

All of that code is unreachable today because no document in the search index carries a tribunal court name.
A question about an NCLT or ITAT ruling cannot be answered from retrieval, and nothing in the pipeline signals that to the user, even though we hold 2.1 million tribunal decision documents.

The gap is text extraction, not acquisition. The documents are original PDF with no extracted text, so there is nothing to embed yet.
