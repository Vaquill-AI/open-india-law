-- ============================================================================
-- IBBI — Insolvency and Bankruptcy Board of India
-- IBC orders from NCLT/NCLAT/IBBI
-- R2 upload count: 1,580
-- ============================================================================

CREATE TABLE tribunal_ibbi (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,                           -- e.g. ibbi_jaipur
    judges        TEXT[],
    decision_date DATE,
    year          INT,
    pdf_url       TEXT,
    source_pdf_url TEXT,
    doc_type      TEXT DEFAULT 'order',
    is_judgment   BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),

    -- AI-enriched columns (populated during RAG parsing, NULL until then)
    outcome       TEXT,                           -- admitted, rejected, liquidation, resolution_approved, withdrawn
    subject_matter TEXT,                          -- topic classification
    cited_acts    TEXT[],                         -- acts/statutes cited
    cited_sections TEXT[],                        -- specific IBC sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- IBBI-specific columns
    category_slug TEXT,                           -- nclt, nclat, ibbi, sc, hc
    category_name TEXT,                           -- display name: NCLT, NCLAT, IBBI, Supreme Court, High Court
    case_type     TEXT,                           -- same as category_name (from source)
    order_remarks TEXT,                           -- e.g. Admission - Final Order, Liquidation Order
    petition_number TEXT,                         -- petition number (may differ from case_number)
    debtor_name   TEXT,                           -- corporate debtor / personal guarantor name
    resolution_amount NUMERIC,                   -- resolution plan amount or liquidation value (INR)
    ibc_section   TEXT,                           -- primary IBC section: 7, 9, 10, 33, 66
    insolvency_type TEXT                          -- cirp, liquidation, voluntary_liquidation, personal_insolvency
);

COMMENT ON TABLE tribunal_ibbi IS 'Insolvency and Bankruptcy Board of India — IBC orders from NCLT/NCLAT/IBBI';
COMMENT ON COLUMN tribunal_ibbi.outcome IS 'Case outcome: admitted, rejected, liquidation, resolution_approved, withdrawn';
COMMENT ON COLUMN tribunal_ibbi.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_ibbi.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_ibbi.cited_sections IS 'Array of specific IBC sections cited';
COMMENT ON COLUMN tribunal_ibbi.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_ibbi.category_slug IS 'Source forum slug: nclt, nclat, ibbi, sc, hc';
COMMENT ON COLUMN tribunal_ibbi.category_name IS 'Source forum display name';
COMMENT ON COLUMN tribunal_ibbi.order_remarks IS 'Order disposition: Admission, Liquidation, Resolution Plan Approval, etc.';
COMMENT ON COLUMN tribunal_ibbi.petition_number IS 'Petition/application number (may differ from case_number)';
COMMENT ON COLUMN tribunal_ibbi.debtor_name IS 'Corporate debtor or personal guarantor name';
COMMENT ON COLUMN tribunal_ibbi.resolution_amount IS 'Resolution plan amount or liquidation value in INR';
COMMENT ON COLUMN tribunal_ibbi.ibc_section IS 'Primary IBC section: 7 (financial creditor), 9 (operational), 10 (debtor), 33, 66';
COMMENT ON COLUMN tribunal_ibbi.insolvency_type IS 'Process type: cirp, liquidation, voluntary_liquidation, personal_insolvency';

-- Indexes
CREATE INDEX idx_ibbi_decision_date ON tribunal_ibbi (decision_date);
CREATE INDEX idx_ibbi_year ON tribunal_ibbi (year);
CREATE INDEX idx_ibbi_judges ON tribunal_ibbi USING GIN (judges);
CREATE INDEX idx_ibbi_outcome ON tribunal_ibbi (outcome);
CREATE INDEX idx_ibbi_subject_matter ON tribunal_ibbi (subject_matter);
CREATE INDEX idx_ibbi_cited_acts ON tribunal_ibbi USING GIN (cited_acts);
CREATE INDEX idx_ibbi_cited_sections ON tribunal_ibbi USING GIN (cited_sections);
CREATE INDEX idx_ibbi_category_slug ON tribunal_ibbi (category_slug);
CREATE INDEX idx_ibbi_order_remarks ON tribunal_ibbi (order_remarks);
CREATE INDEX idx_ibbi_ibc_section ON tribunal_ibbi (ibc_section);
CREATE INDEX idx_ibbi_insolvency_type ON tribunal_ibbi (insolvency_type);
CREATE INDEX idx_ibbi_debtor_name_trgm ON tribunal_ibbi USING GIN (debtor_name gin_trgm_ops);
CREATE INDEX idx_ibbi_title_trgm ON tribunal_ibbi USING GIN (title gin_trgm_ops);
CREATE INDEX idx_ibbi_petitioner_trgm ON tribunal_ibbi USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_ibbi_respondent_trgm ON tribunal_ibbi USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_ibbi ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_ibbi FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_ibbi FOR ALL USING (auth.role() = 'service_role');
