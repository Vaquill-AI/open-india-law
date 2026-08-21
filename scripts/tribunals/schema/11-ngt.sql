-- ============================================================================
-- NGT — National Green Tribunal
-- Environmental law cases
-- R2 upload count: 34,350
-- ============================================================================

CREATE TABLE tribunal_ngt (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,                           -- e.g. ngt_delhi
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
    cited_sections TEXT[],                        -- specific sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- NGT-specific columns
    zone_id       INT,                            -- 1=Principal Bench, 2=South, 3=Central, 4=East, 5=West
    zone_name     TEXT,                           -- Principal Bench, Southern Zone, Central Zone, etc.
    case_type     TEXT,                           -- Order, Appeal, Application, Original Application, etc.
    order_type    TEXT,                           -- Order, Judgment (from source data)
    environmental_issue TEXT,                     -- air_pollution, water_pollution, waste, mining, forest, wildlife, eia
    state         TEXT,                           -- state where the environmental issue arose
    pollutant_type TEXT,                          -- specific pollutant or environmental concern
    compensation_amount NUMERIC                  -- environmental compensation ordered (INR)
);

COMMENT ON TABLE tribunal_ngt IS 'National Green Tribunal — environmental law cases';
COMMENT ON COLUMN tribunal_ngt.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_ngt.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_ngt.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_ngt.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_ngt.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_ngt.zone_id IS 'NGT zone: 1=Principal(Delhi), 2=South(Chennai), 3=Central(Bhopal), 4=East(Kolkata), 5=West(Pune)';
COMMENT ON COLUMN tribunal_ngt.zone_name IS 'Human-readable zone name';
COMMENT ON COLUMN tribunal_ngt.case_type IS 'Case type: Order, Appeal, Application, Original Application, etc.';
COMMENT ON COLUMN tribunal_ngt.order_type IS 'Whether this is an Order or Judgment';
COMMENT ON COLUMN tribunal_ngt.environmental_issue IS 'Issue type: air_pollution, water_pollution, waste, mining, forest, wildlife, eia';
COMMENT ON COLUMN tribunal_ngt.state IS 'State where the environmental issue arose';
COMMENT ON COLUMN tribunal_ngt.pollutant_type IS 'Specific pollutant or environmental concern';
COMMENT ON COLUMN tribunal_ngt.compensation_amount IS 'Environmental compensation ordered in INR';

-- Indexes
CREATE INDEX idx_ngt_decision_date ON tribunal_ngt (decision_date);
CREATE INDEX idx_ngt_year ON tribunal_ngt (year);
CREATE INDEX idx_ngt_judges ON tribunal_ngt USING GIN (judges);
CREATE INDEX idx_ngt_outcome ON tribunal_ngt (outcome);
CREATE INDEX idx_ngt_subject_matter ON tribunal_ngt (subject_matter);
CREATE INDEX idx_ngt_cited_acts ON tribunal_ngt USING GIN (cited_acts);
CREATE INDEX idx_ngt_cited_sections ON tribunal_ngt USING GIN (cited_sections);
CREATE INDEX idx_ngt_zone_id ON tribunal_ngt (zone_id);
CREATE INDEX idx_ngt_zone_name ON tribunal_ngt (zone_name);
CREATE INDEX idx_ngt_case_type ON tribunal_ngt (case_type);
CREATE INDEX idx_ngt_environmental_issue ON tribunal_ngt (environmental_issue);
CREATE INDEX idx_ngt_state ON tribunal_ngt (state);
CREATE INDEX idx_ngt_title_trgm ON tribunal_ngt USING GIN (title gin_trgm_ops);
CREATE INDEX idx_ngt_petitioner_trgm ON tribunal_ngt USING GIN (petitioner gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_ngt ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_ngt FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_ngt FOR ALL USING (auth.role() = 'service_role');
