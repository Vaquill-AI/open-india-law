-- ============================================================================
-- NCLT — National Company Law Tribunal
-- Company law and insolvency matters
-- R2 upload count: 21,303
-- ============================================================================

CREATE TABLE tribunal_nclt (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,                           -- e.g. nclt_kochi, nclt_delhi
    judges        TEXT[],
    decision_date DATE,
    year          INT,
    pdf_url       TEXT,
    source_pdf_url TEXT,
    doc_type      TEXT DEFAULT 'order',
    is_judgment   BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),

    -- AI-enriched columns (populated during RAG parsing, NULL until then)
    outcome       TEXT,                           -- admitted, rejected, approved, liquidation, dismissed, withdrawn
    subject_matter TEXT,                          -- topic classification
    cited_acts    TEXT[],                         -- acts/statutes cited
    cited_sections TEXT[],                        -- specific sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- NCLT-specific columns
    bench_id      TEXT,                           -- numeric bench ID from NCLT e-filing system
    filing_no     TEXT,                           -- e-filing number, e.g. 1806122000072016
    case_category TEXT,                           -- ibc (insolvency), company (Companies Act), oppression (S.241-242)
    ibc_section   TEXT,                           -- primary IBC section if insolvency: 7, 9, 10, 33
    company_name  TEXT,                           -- company/corporate debtor name
    resolution_amount NUMERIC,                   -- resolution plan value or liquidation value (INR)
    case_stage    TEXT                            -- admission, cirp, liquidation, resolution, closure
);

COMMENT ON TABLE tribunal_nclt IS 'National Company Law Tribunal — company law and insolvency matters';
COMMENT ON COLUMN tribunal_nclt.outcome IS 'Case outcome: admitted, rejected, approved, liquidation, dismissed, withdrawn';
COMMENT ON COLUMN tribunal_nclt.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_nclt.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_nclt.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_nclt.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_nclt.bench_id IS 'Numeric bench identifier from the NCLT e-filing system';
COMMENT ON COLUMN tribunal_nclt.filing_no IS 'E-filing registration number';
COMMENT ON COLUMN tribunal_nclt.case_category IS 'Case category: ibc (insolvency), company (Companies Act), oppression (S.241-242)';
COMMENT ON COLUMN tribunal_nclt.ibc_section IS 'Primary IBC section: 7 (financial), 9 (operational), 10 (debtor), 33 (liquidation)';
COMMENT ON COLUMN tribunal_nclt.company_name IS 'Company or corporate debtor name';
COMMENT ON COLUMN tribunal_nclt.resolution_amount IS 'Resolution plan value or liquidation value in INR';
COMMENT ON COLUMN tribunal_nclt.case_stage IS 'Case stage: admission, cirp, liquidation, resolution, closure';

-- Indexes
CREATE INDEX idx_nclt_decision_date ON tribunal_nclt (decision_date);
CREATE INDEX idx_nclt_year ON tribunal_nclt (year);
CREATE INDEX idx_nclt_judges ON tribunal_nclt USING GIN (judges);
CREATE INDEX idx_nclt_outcome ON tribunal_nclt (outcome);
CREATE INDEX idx_nclt_subject_matter ON tribunal_nclt (subject_matter);
CREATE INDEX idx_nclt_cited_acts ON tribunal_nclt USING GIN (cited_acts);
CREATE INDEX idx_nclt_cited_sections ON tribunal_nclt USING GIN (cited_sections);
CREATE INDEX idx_nclt_bench_id ON tribunal_nclt (bench_id);
CREATE INDEX idx_nclt_bench ON tribunal_nclt (bench);
CREATE INDEX idx_nclt_filing_no ON tribunal_nclt (filing_no);
CREATE INDEX idx_nclt_case_category ON tribunal_nclt (case_category);
CREATE INDEX idx_nclt_ibc_section ON tribunal_nclt (ibc_section);
CREATE INDEX idx_nclt_case_stage ON tribunal_nclt (case_stage);
CREATE INDEX idx_nclt_company_name_trgm ON tribunal_nclt USING GIN (company_name gin_trgm_ops);
CREATE INDEX idx_nclt_title_trgm ON tribunal_nclt USING GIN (title gin_trgm_ops);
CREATE INDEX idx_nclt_petitioner_trgm ON tribunal_nclt USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_nclt_respondent_trgm ON tribunal_nclt USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_nclt ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_nclt FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_nclt FOR ALL USING (auth.role() = 'service_role');
