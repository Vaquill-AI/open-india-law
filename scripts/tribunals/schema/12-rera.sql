-- ============================================================================
-- RERA — Real Estate Regulatory Authority (Delhi + Maharashtra + Punjab)
-- Three states merged into one table with a state discriminator column.
-- R2 upload count: 1,530 (all states combined)
-- ============================================================================

CREATE TABLE tribunal_rera (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,
    judges        TEXT[],
    decision_date DATE,
    year          INT,
    pdf_url       TEXT,
    source_pdf_url TEXT,
    doc_type      TEXT DEFAULT 'order',
    is_judgment   BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),

    -- AI-enriched columns (populated during RAG parsing, NULL until then)
    outcome       TEXT,                           -- allowed, dismissed, partly_allowed, remanded, settled, withdrawn
    subject_matter TEXT,                          -- topic classification
    cited_acts    TEXT[],                         -- acts/statutes cited
    cited_sections TEXT[],                        -- specific RERA sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- RERA-specific columns
    state         TEXT NOT NULL,                  -- delhi, maharashtra, punjab
    source        TEXT,                           -- rera (authority) or reat (appellate tribunal)
    project_id    TEXT,                           -- MahaRERA project registration ID, e.g. P52000012196
    project_name  TEXT,                           -- registered project name (MahaRERA)
    heard_by      TEXT,                           -- presiding member/officer name (MahaRERA)
    complaint_type TEXT,                          -- delay, deficiency, refund, non_registration, false_advertisement
    compensation_amount NUMERIC,                 -- compensation/refund ordered (INR)
    builder_name  TEXT                            -- promoter/builder name
);

COMMENT ON TABLE tribunal_rera IS 'Real Estate Regulatory Authority — orders from Delhi, Maharashtra, Punjab RERA/REAT';
COMMENT ON COLUMN tribunal_rera.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_rera.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_rera.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_rera.cited_sections IS 'Array of specific RERA sections cited';
COMMENT ON COLUMN tribunal_rera.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_rera.state IS 'State: delhi, maharashtra, punjab';
COMMENT ON COLUMN tribunal_rera.source IS 'rera = Regulatory Authority (original), reat = Real Estate Appellate Tribunal';
COMMENT ON COLUMN tribunal_rera.project_id IS 'MahaRERA project registration ID (Maharashtra only)';
COMMENT ON COLUMN tribunal_rera.project_name IS 'Registered real estate project name (Maharashtra only)';
COMMENT ON COLUMN tribunal_rera.heard_by IS 'Name of the presiding member or officer';
COMMENT ON COLUMN tribunal_rera.complaint_type IS 'Complaint type: delay, deficiency, refund, non_registration, false_advertisement';
COMMENT ON COLUMN tribunal_rera.compensation_amount IS 'Compensation or refund amount ordered in INR';
COMMENT ON COLUMN tribunal_rera.builder_name IS 'Promoter or builder name';

-- Indexes
CREATE INDEX idx_rera_decision_date ON tribunal_rera (decision_date);
CREATE INDEX idx_rera_year ON tribunal_rera (year);
CREATE INDEX idx_rera_judges ON tribunal_rera USING GIN (judges);
CREATE INDEX idx_rera_outcome ON tribunal_rera (outcome);
CREATE INDEX idx_rera_subject_matter ON tribunal_rera (subject_matter);
CREATE INDEX idx_rera_cited_acts ON tribunal_rera USING GIN (cited_acts);
CREATE INDEX idx_rera_cited_sections ON tribunal_rera USING GIN (cited_sections);
CREATE INDEX idx_rera_state ON tribunal_rera (state);
CREATE INDEX idx_rera_source ON tribunal_rera (source);
CREATE INDEX idx_rera_project_id ON tribunal_rera (project_id);
CREATE INDEX idx_rera_complaint_type ON tribunal_rera (complaint_type);
CREATE INDEX idx_rera_builder_name_trgm ON tribunal_rera USING GIN (builder_name gin_trgm_ops);
CREATE INDEX idx_rera_project_name_trgm ON tribunal_rera USING GIN (project_name gin_trgm_ops);
CREATE INDEX idx_rera_title_trgm ON tribunal_rera USING GIN (title gin_trgm_ops);
CREATE INDEX idx_rera_petitioner_trgm ON tribunal_rera USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_rera_respondent_trgm ON tribunal_rera USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_rera ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_rera FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_rera FOR ALL USING (auth.role() = 'service_role');
