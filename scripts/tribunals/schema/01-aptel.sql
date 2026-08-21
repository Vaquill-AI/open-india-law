-- ============================================================================
-- APTEL — Appellate Tribunal for Electricity
-- Appeals against electricity regulatory orders
-- R2 upload count: 2,707
-- ============================================================================

CREATE TABLE tribunal_aptel (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,           -- dedup key, e.g. APTEL_APPEALNO91OF2008IANOS121230OF2008
    case_number   TEXT,
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,                           -- bench identifier, e.g. aptel_mgj_hlb
    judges        TEXT[],                         -- array of judge names
    decision_date DATE,
    year          INT,
    pdf_url       TEXT,                           -- R2 path, e.g. pdfs/aptel/APTEL_xxx.pdf
    source_pdf_url TEXT,                          -- original URL from aptel.gov.in
    doc_type      TEXT DEFAULT 'judgment',        -- 'judgment' or 'order'
    is_judgment   BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),

    -- AI-enriched columns (populated during RAG parsing, NULL until then)
    outcome       TEXT,                           -- allowed, dismissed, partly_allowed, remanded, settled, withdrawn
    subject_matter TEXT,                          -- topic classification, e.g. tariff dispute, renewable energy
    cited_acts    TEXT[],                         -- acts/statutes cited, e.g. {Electricity Act 2003, CERC Regulations}
    cited_sections TEXT[],                        -- specific sections, e.g. {Section 111, Section 142}
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- APTEL-specific columns
    serial_no     INT,                            -- sequential serial from source scrape
    state         TEXT,                           -- state involved, e.g. Gujarat, Maharashtra, Rajasthan
    sector        TEXT,                           -- generation, transmission, distribution, tariff, renewable
    regulator     TEXT,                           -- originating regulator: CERC, SERC name, JERC
    penalty_amount NUMERIC                       -- penalty/compensation amount if any
);

COMMENT ON TABLE tribunal_aptel IS 'Appellate Tribunal for Electricity — appeals against electricity regulatory orders';
COMMENT ON COLUMN tribunal_aptel.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_aptel.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_aptel.cited_acts IS 'Array of acts/statutes cited in the judgment';
COMMENT ON COLUMN tribunal_aptel.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_aptel.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_aptel.serial_no IS 'Sequential order number from the APTEL website listing';
COMMENT ON COLUMN tribunal_aptel.state IS 'State involved in the electricity dispute';
COMMENT ON COLUMN tribunal_aptel.sector IS 'Electricity sector: generation, transmission, distribution, tariff, renewable';
COMMENT ON COLUMN tribunal_aptel.regulator IS 'Originating regulator: CERC, state ERC, or JERC';
COMMENT ON COLUMN tribunal_aptel.penalty_amount IS 'Penalty or compensation amount imposed, if any';

-- Indexes
CREATE INDEX idx_aptel_decision_date ON tribunal_aptel (decision_date);
CREATE INDEX idx_aptel_year ON tribunal_aptel (year);
CREATE INDEX idx_aptel_judges ON tribunal_aptel USING GIN (judges);
CREATE INDEX idx_aptel_outcome ON tribunal_aptel (outcome);
CREATE INDEX idx_aptel_subject_matter ON tribunal_aptel (subject_matter);
CREATE INDEX idx_aptel_cited_acts ON tribunal_aptel USING GIN (cited_acts);
CREATE INDEX idx_aptel_cited_sections ON tribunal_aptel USING GIN (cited_sections);
CREATE INDEX idx_aptel_state ON tribunal_aptel (state);
CREATE INDEX idx_aptel_sector ON tribunal_aptel (sector);
CREATE INDEX idx_aptel_regulator ON tribunal_aptel (regulator);
CREATE INDEX idx_aptel_title_trgm ON tribunal_aptel USING GIN (title gin_trgm_ops);
CREATE INDEX idx_aptel_petitioner_trgm ON tribunal_aptel USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_aptel_respondent_trgm ON tribunal_aptel USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_aptel ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_aptel FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_aptel FOR ALL USING (auth.role() = 'service_role');
