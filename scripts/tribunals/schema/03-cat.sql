-- ============================================================================
-- CAT — Central Administrative Tribunal
-- Service matters of government employees
-- R2 upload count: 4,762
-- ============================================================================

CREATE TABLE tribunal_cat (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,                           -- e.g. cat_mumbai
    judges        TEXT[],
    decision_date DATE,
    year          INT,
    pdf_url       TEXT,
    source_pdf_url TEXT,
    doc_type      TEXT DEFAULT 'judgment',
    is_judgment   BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),

    -- AI-enriched columns (populated during RAG parsing, NULL until then)
    outcome       TEXT,                           -- allowed, dismissed, partly_allowed, remanded, settled, withdrawn
    subject_matter TEXT,                          -- topic classification
    cited_acts    TEXT[],                         -- acts/statutes cited
    cited_sections TEXT[],                        -- specific sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- CAT-specific columns
    bench_slug    TEXT,                           -- bench city slug: mumbai, delhi, kolkata, etc.
    case_type     TEXT,                           -- Original Application (OA), Transfer Application, etc.
    case_year     TEXT,                           -- year from case number (may differ from decision year)
    handle_id     TEXT,                           -- DSpace handle ID from catjudgements.nic.in
    department    TEXT,                           -- government department, e.g. Railways, Defence, Revenue
    service_category TEXT,                        -- promotion, transfer, pension, disciplinary, recruitment, seniority
    pay_commission TEXT                           -- relevant pay commission: 6th CPC, 7th CPC
);

COMMENT ON TABLE tribunal_cat IS 'Central Administrative Tribunal — service matters of government employees';
COMMENT ON COLUMN tribunal_cat.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_cat.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_cat.cited_acts IS 'Array of acts/statutes cited in the judgment';
COMMENT ON COLUMN tribunal_cat.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_cat.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_cat.bench_slug IS 'City slug for the CAT bench: mumbai, delhi, kolkata, chennai, etc.';
COMMENT ON COLUMN tribunal_cat.case_type IS 'Application type: Original Application (OA), Transfer Application, etc.';
COMMENT ON COLUMN tribunal_cat.case_year IS 'Year extracted from case number (filing year, may differ from decision year)';
COMMENT ON COLUMN tribunal_cat.handle_id IS 'DSpace repository handle ID from catjudgements.nic.in';
COMMENT ON COLUMN tribunal_cat.department IS 'Government department: Railways, Defence, Revenue, Posts, etc.';
COMMENT ON COLUMN tribunal_cat.service_category IS 'Service matter type: promotion, transfer, pension, disciplinary, recruitment, seniority';
COMMENT ON COLUMN tribunal_cat.pay_commission IS 'Relevant pay commission reference: 6th CPC, 7th CPC';

-- Indexes
CREATE INDEX idx_cat_decision_date ON tribunal_cat (decision_date);
CREATE INDEX idx_cat_year ON tribunal_cat (year);
CREATE INDEX idx_cat_judges ON tribunal_cat USING GIN (judges);
CREATE INDEX idx_cat_outcome ON tribunal_cat (outcome);
CREATE INDEX idx_cat_subject_matter ON tribunal_cat (subject_matter);
CREATE INDEX idx_cat_cited_acts ON tribunal_cat USING GIN (cited_acts);
CREATE INDEX idx_cat_cited_sections ON tribunal_cat USING GIN (cited_sections);
CREATE INDEX idx_cat_bench_slug ON tribunal_cat (bench_slug);
CREATE INDEX idx_cat_case_type ON tribunal_cat (case_type);
CREATE INDEX idx_cat_case_year ON tribunal_cat (case_year);
CREATE INDEX idx_cat_department ON tribunal_cat (department);
CREATE INDEX idx_cat_service_category ON tribunal_cat (service_category);
CREATE INDEX idx_cat_title_trgm ON tribunal_cat USING GIN (title gin_trgm_ops);
CREATE INDEX idx_cat_petitioner_trgm ON tribunal_cat USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_cat_respondent_trgm ON tribunal_cat USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_cat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_cat FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_cat FOR ALL USING (auth.role() = 'service_role');
