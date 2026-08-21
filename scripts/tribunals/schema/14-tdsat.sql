-- ============================================================================
-- TDSAT — Telecom Disputes Settlement & Appellate Tribunal
-- Telecom and broadcasting disputes
-- R2 upload count: 1,348
-- ============================================================================

CREATE TABLE tribunal_tdsat (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,                           -- e.g. R A/9/2023
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,
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

    -- TDSAT-specific columns
    case_type     TEXT,                           -- R A (Review Application), Petition, Appeal, MA, etc.
    serial        INT,                            -- serial number from source listing
    dispute_type  TEXT,                           -- interconnection, tariff, spectrum, license, broadcasting, cable
    sector        TEXT,                           -- telecom, broadcasting, cable_tv, internet
    operator_name TEXT                            -- telecom/broadcasting operator involved
);

COMMENT ON TABLE tribunal_tdsat IS 'Telecom Disputes Settlement & Appellate Tribunal — telecom and broadcasting disputes';
COMMENT ON COLUMN tribunal_tdsat.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_tdsat.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_tdsat.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_tdsat.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_tdsat.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_tdsat.case_type IS 'Case type: R A (Review Application), Petition, Appeal, MA (Misc Application), etc.';
COMMENT ON COLUMN tribunal_tdsat.serial IS 'Serial number from the TDSAT source listing';
COMMENT ON COLUMN tribunal_tdsat.dispute_type IS 'Dispute type: interconnection, tariff, spectrum, license, broadcasting, cable';
COMMENT ON COLUMN tribunal_tdsat.sector IS 'Sector: telecom, broadcasting, cable_tv, internet';
COMMENT ON COLUMN tribunal_tdsat.operator_name IS 'Telecom or broadcasting operator involved';

-- Indexes
CREATE INDEX idx_tdsat_decision_date ON tribunal_tdsat (decision_date);
CREATE INDEX idx_tdsat_year ON tribunal_tdsat (year);
CREATE INDEX idx_tdsat_judges ON tribunal_tdsat USING GIN (judges);
CREATE INDEX idx_tdsat_outcome ON tribunal_tdsat (outcome);
CREATE INDEX idx_tdsat_subject_matter ON tribunal_tdsat (subject_matter);
CREATE INDEX idx_tdsat_cited_acts ON tribunal_tdsat USING GIN (cited_acts);
CREATE INDEX idx_tdsat_cited_sections ON tribunal_tdsat USING GIN (cited_sections);
CREATE INDEX idx_tdsat_case_type ON tribunal_tdsat (case_type);
CREATE INDEX idx_tdsat_dispute_type ON tribunal_tdsat (dispute_type);
CREATE INDEX idx_tdsat_sector ON tribunal_tdsat (sector);
CREATE INDEX idx_tdsat_operator_name_trgm ON tribunal_tdsat USING GIN (operator_name gin_trgm_ops);
CREATE INDEX idx_tdsat_title_trgm ON tribunal_tdsat USING GIN (title gin_trgm_ops);
CREATE INDEX idx_tdsat_petitioner_trgm ON tribunal_tdsat USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_tdsat_respondent_trgm ON tribunal_tdsat USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_tdsat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_tdsat FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_tdsat FOR ALL USING (auth.role() = 'service_role');
