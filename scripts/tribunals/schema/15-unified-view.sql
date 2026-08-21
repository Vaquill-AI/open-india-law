-- ============================================================================
-- UNIFIED VIEW — Cross-tribunal search
-- Projects common columns from all 14 tables into a single queryable view.
-- Includes AI-enriched columns (outcome, subject_matter, cited_acts, cited_sections, headnotes).
-- ============================================================================
CREATE OR REPLACE VIEW v_all_tribunal_cases AS

SELECT 'aptel'::TEXT AS tribunal, id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_aptel

UNION ALL

SELECT 'atfp', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_atfp

UNION ALL

SELECT 'cat', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_cat

UNION ALL

SELECT 'cci', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_cci

UNION ALL

SELECT 'cestat', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_cestat

UNION ALL

SELECT 'drt', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_drt

UNION ALL

SELECT 'gst_aar', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_gst_aar

UNION ALL

SELECT 'ibbi', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_ibbi

UNION ALL

SELECT 'itat', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_itat

UNION ALL

SELECT 'nclt', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_nclt

UNION ALL

SELECT 'ngt', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_ngt

UNION ALL

SELECT 'rera', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_rera

UNION ALL

SELECT 'sat', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_sat

UNION ALL

SELECT 'tdsat', id, case_id, case_number, title, petitioner, respondent,
       bench, judges, decision_date, year, pdf_url, source_pdf_url, doc_type, is_judgment,
       outcome, subject_matter, cited_acts, cited_sections, headnotes, created_at
FROM tribunal_tdsat;

COMMENT ON VIEW v_all_tribunal_cases IS 'Unified view across all 14 tribunal tables for cross-tribunal search. Includes common + AI-enriched columns.';
