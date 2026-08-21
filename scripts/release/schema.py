"""The frozen public schema for Open India Law.

Append only. Never reorder, never remove: consumers pin to column order and a
published snapshot is immutable.

Two record shapes, because the corpora are genuinely different:

  CASE_LAW_SCHEMA   one row per CHUNK, carrying our parsing, chunking and
                    enrichment. Source is highcourt-chunks/batches/*.tar.gz,
                    not Qdrant: the chunk artifacts already hold text plus full
                    metadata plus char/page provenance, so no vector-store
                    scroll is involved and the 3x-scale memory problem that
                    dogged the US release does not arise.

  LEGISLATION_SCHEMA one row per PROVISION. Source is the acts_india collection,
                    with the taxonomy repair in taxonomy.py applied.

Deliberately NOT published:
  r2_key      internal object pointer
  pdf_url     points at an R2 public hostname that has been disabled, so it
              would ship as a dead link presented as provenance. See
              source_url below for what replaces it.
"""

from __future__ import annotations

CASE_LAW_SCHEMA: tuple[str, ...] = (
    # identity
    "case_id", "chunk_id", "chunk_index", "total_chunks",
    # text: `text` is contextualized for retrieval, `text_original` is as parsed
    "text", "text_original",
    # provenance inside the source document
    "char_start", "char_end", "page_start", "page_end",
    # segmentation
    "section_type", "section_priority", "box_aware",
    # court
    "court", "court_code", "court_type", "bench", "bench_strength", "judges",
    # matter
    "title", "description", "petitioner", "respondent", "disposition",
    "case_number", "citation",
    # dates
    "decision_date", "date_of_registration", "year",
    # sourcing
    "source_url", "language_code",
)

LEGISLATION_SCHEMA: tuple[str, ...] = (
    "act_id", "chunk_id", "title", "chapter", "section_number", "section_title",
    "text",
    # repaired taxonomy - see taxonomy.py. `category` is dropped as a
    # byte-identical duplicate of the raw `jurisdiction`.
    "jurisdiction", "state", "instrument_type", "act_status", "in_force",
    # classification
    "doc_type", "provision_type", "section_type", "legal_subject",
    "has_proviso", "has_non_obstante", "delegation_type",
    "department", "regulatory_body",
    "acts_referenced", "defined_terms", "amendment_count", "year",
    "source_url", "language_code",
)

INT_FIELDS = frozenset({
    "chunk_index", "total_chunks", "char_start", "char_end",
    "page_start", "page_end", "section_priority", "bench_strength",
    "year", "amendment_count",
})
BOOL_FIELDS = frozenset({"box_aware", "in_force", "has_proviso", "has_non_obstante"})
LIST_FIELDS = frozenset({"judges", "acts_referenced", "defined_terms"})

#: Fields present in the source artifacts that must never reach a published row.
INTERNAL_FIELDS = frozenset({"r2_key", "pdf_url", "sparse", "category"})
