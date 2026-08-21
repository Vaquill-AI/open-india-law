-- ============================================================================
-- GST AAR/AAAR — GST Authority for Advance Ruling / Appellate Authority
-- GST advance rulings from state-level authorities
-- R2 upload count: 2,618
-- ============================================================================

CREATE TABLE tribunal_gst_aar (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,
    title         TEXT,
    petitioner    TEXT,                           -- applicant name
    respondent    TEXT,
    bench         TEXT,                           -- e.g. gst_aar_gujarat
    judges        TEXT[],
    decision_date DATE,
    year          INT,
    pdf_url       TEXT,
    source_pdf_url TEXT,
    doc_type      TEXT DEFAULT 'ruling',
    is_judgment   BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),

    -- AI-enriched columns (populated during RAG parsing, NULL until then)
    outcome       TEXT,                           -- ruling_given, application_rejected, withdrawn, referred
    subject_matter TEXT,                          -- topic classification
    cited_acts    TEXT[],                         -- acts/statutes cited
    cited_sections TEXT[],                        -- specific sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- GST AAR-specific columns
    state_ut      TEXT,                           -- state/UT name: Gujarat, Maharashtra, Tamil Nadu, etc.
    ruling_type   TEXT,                           -- aar (Authority) or aaar (Appellate Authority)
    category      TEXT,                           -- section reference, e.g. 97(2), or topic category
    brief_of_order TEXT,                          -- short summary/question addressed in the ruling
    hsn_sac_code  TEXT,                           -- HSN/SAC code discussed, e.g. 9954, 8471
    gst_rate      TEXT,                           -- applicable GST rate determined, e.g. 18%, 12%, exempt
    question_of_law TEXT,                         -- specific legal question posed for advance ruling
    supply_type   TEXT                            -- goods, services, or works_contract
);

COMMENT ON TABLE tribunal_gst_aar IS 'GST Authority for Advance Ruling (AAR) and Appellate AAR (AAAR)';
COMMENT ON COLUMN tribunal_gst_aar.outcome IS 'Ruling outcome: ruling_given, application_rejected, withdrawn, referred';
COMMENT ON COLUMN tribunal_gst_aar.subject_matter IS 'Topic classification of the ruling';
COMMENT ON COLUMN tribunal_gst_aar.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_gst_aar.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_gst_aar.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_gst_aar.state_ut IS 'State or Union Territory that issued the ruling';
COMMENT ON COLUMN tribunal_gst_aar.ruling_type IS 'aar = Authority for Advance Ruling, aaar = Appellate Authority';
COMMENT ON COLUMN tribunal_gst_aar.category IS 'Section of GST Act or topic category for the ruling';
COMMENT ON COLUMN tribunal_gst_aar.brief_of_order IS 'Brief description or question addressed in the ruling';
COMMENT ON COLUMN tribunal_gst_aar.hsn_sac_code IS 'HSN (goods) or SAC (services) code discussed';
COMMENT ON COLUMN tribunal_gst_aar.gst_rate IS 'Applicable GST rate determined: 5%, 12%, 18%, 28%, exempt';
COMMENT ON COLUMN tribunal_gst_aar.question_of_law IS 'Specific legal question posed for advance ruling';
COMMENT ON COLUMN tribunal_gst_aar.supply_type IS 'Type of supply: goods, services, or works_contract';

-- Indexes
CREATE INDEX idx_gst_aar_decision_date ON tribunal_gst_aar (decision_date);
CREATE INDEX idx_gst_aar_year ON tribunal_gst_aar (year);
CREATE INDEX idx_gst_aar_judges ON tribunal_gst_aar USING GIN (judges);
CREATE INDEX idx_gst_aar_outcome ON tribunal_gst_aar (outcome);
CREATE INDEX idx_gst_aar_subject_matter ON tribunal_gst_aar (subject_matter);
CREATE INDEX idx_gst_aar_cited_acts ON tribunal_gst_aar USING GIN (cited_acts);
CREATE INDEX idx_gst_aar_cited_sections ON tribunal_gst_aar USING GIN (cited_sections);
CREATE INDEX idx_gst_aar_state_ut ON tribunal_gst_aar (state_ut);
CREATE INDEX idx_gst_aar_ruling_type ON tribunal_gst_aar (ruling_type);
CREATE INDEX idx_gst_aar_category ON tribunal_gst_aar (category);
CREATE INDEX idx_gst_aar_hsn_sac_code ON tribunal_gst_aar (hsn_sac_code);
CREATE INDEX idx_gst_aar_gst_rate ON tribunal_gst_aar (gst_rate);
CREATE INDEX idx_gst_aar_supply_type ON tribunal_gst_aar (supply_type);
CREATE INDEX idx_gst_aar_title_trgm ON tribunal_gst_aar USING GIN (title gin_trgm_ops);
CREATE INDEX idx_gst_aar_petitioner_trgm ON tribunal_gst_aar USING GIN (petitioner gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_gst_aar ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_gst_aar FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_gst_aar FOR ALL USING (auth.role() = 'service_role');
