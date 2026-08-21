-- ============================================================================
-- SAT — Securities Appellate Tribunal
-- Appeals against SEBI, IRDAI, PFRDA, IBBI orders
-- R2 upload count: 9,296
-- ============================================================================

CREATE TABLE tribunal_sat (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,                           -- e.g. SEBI - 0110/2006
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
    cited_sections TEXT[],                        -- specific sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- SAT-specific columns
    appeal_type   TEXT,                           -- SEBI, IRDAI, PFRDA, IBBI
    case_type     TEXT,                           -- same as appeal_type (from source)
    al_number     TEXT,                           -- appeal number without prefix, e.g. 0110/2006
    sat_order_id  INT,                            -- internal SAT order ID from satweb.sat.gov.in
    penalty_amount NUMERIC,                      -- penalty amount challenged/upheld (INR)
    regulation_cited TEXT,                        -- specific regulation, e.g. SEBI (LODR) Regulations 2015
    violation_type TEXT                           -- insider_trading, market_manipulation, disclosure, takeover, fraud
);

COMMENT ON TABLE tribunal_sat IS 'Securities Appellate Tribunal — appeals against SEBI, IRDAI, PFRDA, IBBI orders';
COMMENT ON COLUMN tribunal_sat.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_sat.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_sat.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_sat.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_sat.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_sat.appeal_type IS 'Regulator appealed against: SEBI, IRDAI, PFRDA, IBBI';
COMMENT ON COLUMN tribunal_sat.al_number IS 'Appeal number without the regulator prefix';
COMMENT ON COLUMN tribunal_sat.sat_order_id IS 'Internal order ID from satweb.sat.gov.in';
COMMENT ON COLUMN tribunal_sat.penalty_amount IS 'Penalty amount challenged or upheld in INR';
COMMENT ON COLUMN tribunal_sat.regulation_cited IS 'Specific regulation cited, e.g. SEBI (LODR) Regulations 2015';
COMMENT ON COLUMN tribunal_sat.violation_type IS 'Violation type: insider_trading, market_manipulation, disclosure, takeover, fraud';

-- Indexes
CREATE INDEX idx_sat_decision_date ON tribunal_sat (decision_date);
CREATE INDEX idx_sat_year ON tribunal_sat (year);
CREATE INDEX idx_sat_judges ON tribunal_sat USING GIN (judges);
CREATE INDEX idx_sat_outcome ON tribunal_sat (outcome);
CREATE INDEX idx_sat_subject_matter ON tribunal_sat (subject_matter);
CREATE INDEX idx_sat_cited_acts ON tribunal_sat USING GIN (cited_acts);
CREATE INDEX idx_sat_cited_sections ON tribunal_sat USING GIN (cited_sections);
CREATE INDEX idx_sat_appeal_type ON tribunal_sat (appeal_type);
CREATE INDEX idx_sat_case_type ON tribunal_sat (case_type);
CREATE INDEX idx_sat_violation_type ON tribunal_sat (violation_type);
CREATE INDEX idx_sat_title_trgm ON tribunal_sat USING GIN (title gin_trgm_ops);
CREATE INDEX idx_sat_petitioner_trgm ON tribunal_sat USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_sat_respondent_trgm ON tribunal_sat USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_sat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_sat FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_sat FOR ALL USING (auth.role() = 'service_role');
