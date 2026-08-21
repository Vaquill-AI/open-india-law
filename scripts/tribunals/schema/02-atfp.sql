-- ============================================================================
-- ATFP — Appellate Tribunal for Forfeited Property
-- PMLA, SAFEMA, NDPS, FERA/FEMA appeals
-- R2 upload count: 3,359
-- ============================================================================

CREATE TABLE tribunal_atfp (
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
    doc_type      TEXT,                           -- 'order' (most ATFP records are orders)
    is_judgment   BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),

    -- AI-enriched columns (populated during RAG parsing, NULL until then)
    outcome       TEXT,                           -- allowed, dismissed, partly_allowed, remanded, settled, withdrawn
    subject_matter TEXT,                          -- topic classification
    cited_acts    TEXT[],                         -- acts/statutes cited
    cited_sections TEXT[],                        -- specific sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- ATFP-specific columns
    act_id        TEXT,                           -- slug: pmla, safema, ndps, ferafera
    act_name      TEXT,                           -- display name: PMLA, SAFEMA, NDPS, FERA/FEMA
    case_type     TEXT,                           -- derived from act, e.g. PMLA
    full_parties  TEXT,                           -- full parties string before splitting into petitioner/respondent
    forfeiture_amount NUMERIC,                   -- amount involved in forfeiture/attachment
    property_type TEXT,                           -- immovable, movable, bank_account, etc.
    ed_case_no    TEXT                            -- linked Enforcement Directorate case number
);

COMMENT ON TABLE tribunal_atfp IS 'Appellate Tribunal for Forfeited Property — PMLA, SAFEMA, NDPS, FERA/FEMA appeals';
COMMENT ON COLUMN tribunal_atfp.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_atfp.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_atfp.cited_acts IS 'Array of acts/statutes cited in the judgment';
COMMENT ON COLUMN tribunal_atfp.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_atfp.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_atfp.act_id IS 'Slug of the governing act: pmla, safema, ndps, ferafera';
COMMENT ON COLUMN tribunal_atfp.act_name IS 'Human-readable act name: PMLA, SAFEMA, NDPS, FERA/FEMA';
COMMENT ON COLUMN tribunal_atfp.case_type IS 'Case type derived from the act, used for filtering';
COMMENT ON COLUMN tribunal_atfp.forfeiture_amount IS 'Amount involved in forfeiture or provisional attachment';
COMMENT ON COLUMN tribunal_atfp.property_type IS 'Type of property: immovable, movable, bank_account, etc.';
COMMENT ON COLUMN tribunal_atfp.ed_case_no IS 'Linked Enforcement Directorate case number';

-- Indexes
CREATE INDEX idx_atfp_decision_date ON tribunal_atfp (decision_date);
CREATE INDEX idx_atfp_year ON tribunal_atfp (year);
CREATE INDEX idx_atfp_judges ON tribunal_atfp USING GIN (judges);
CREATE INDEX idx_atfp_outcome ON tribunal_atfp (outcome);
CREATE INDEX idx_atfp_subject_matter ON tribunal_atfp (subject_matter);
CREATE INDEX idx_atfp_cited_acts ON tribunal_atfp USING GIN (cited_acts);
CREATE INDEX idx_atfp_cited_sections ON tribunal_atfp USING GIN (cited_sections);
CREATE INDEX idx_atfp_act_id ON tribunal_atfp (act_id);
CREATE INDEX idx_atfp_act_name ON tribunal_atfp (act_name);
CREATE INDEX idx_atfp_case_type ON tribunal_atfp (case_type);
CREATE INDEX idx_atfp_property_type ON tribunal_atfp (property_type);
CREATE INDEX idx_atfp_title_trgm ON tribunal_atfp USING GIN (title gin_trgm_ops);
CREATE INDEX idx_atfp_petitioner_trgm ON tribunal_atfp USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_atfp_respondent_trgm ON tribunal_atfp USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_atfp ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_atfp FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_atfp FOR ALL USING (auth.role() = 'service_role');
