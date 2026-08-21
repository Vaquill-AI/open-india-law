-- ============================================================================
-- CCI — Competition Commission of India
-- Antitrust and merger orders
-- R2 upload count: 2,944
-- ============================================================================

CREATE TABLE tribunal_cci (
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
    outcome       TEXT,                           -- contravention_found, no_contravention, penalty_imposed, approved, rejected
    subject_matter TEXT,                          -- topic classification
    cited_acts    TEXT[],                         -- acts/statutes cited
    cited_sections TEXT[],                        -- specific sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- CCI-specific columns
    category      TEXT,                           -- antitrust, merger, lesser-penalty, etc.
    section       TEXT,                           -- e.g. Section 27, Section 31, Section 26(2)
    case_type     TEXT,                           -- detailed type, e.g. Anti-trust Section 19(1)(a)
    cci_order_id  INT,                            -- internal CCI order ID from their website
    penalty_amount NUMERIC,                      -- total penalty imposed (INR)
    market_definition TEXT,                       -- relevant market as defined by CCI
    sectors       TEXT[],                         -- industry sectors, e.g. {pharma, cement, real_estate}
    leniency_applicant BOOLEAN                   -- whether leniency was granted
);

COMMENT ON TABLE tribunal_cci IS 'Competition Commission of India — antitrust and merger orders';
COMMENT ON COLUMN tribunal_cci.outcome IS 'Order outcome: contravention_found, no_contravention, penalty_imposed, approved, rejected';
COMMENT ON COLUMN tribunal_cci.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_cci.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_cci.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_cci.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_cci.category IS 'Order category: antitrust, merger, lesser-penalty, commitment, etc.';
COMMENT ON COLUMN tribunal_cci.section IS 'Relevant section of the Competition Act, e.g. Section 27';
COMMENT ON COLUMN tribunal_cci.case_type IS 'Detailed case type including section reference';
COMMENT ON COLUMN tribunal_cci.cci_order_id IS 'Internal order ID from cci.gov.in';
COMMENT ON COLUMN tribunal_cci.penalty_amount IS 'Total penalty imposed in INR';
COMMENT ON COLUMN tribunal_cci.market_definition IS 'Relevant market as defined by CCI in the order';
COMMENT ON COLUMN tribunal_cci.sectors IS 'Industry sectors involved: pharma, cement, real_estate, etc.';
COMMENT ON COLUMN tribunal_cci.leniency_applicant IS 'Whether leniency was applied for or granted';

-- Indexes
CREATE INDEX idx_cci_decision_date ON tribunal_cci (decision_date);
CREATE INDEX idx_cci_year ON tribunal_cci (year);
CREATE INDEX idx_cci_judges ON tribunal_cci USING GIN (judges);
CREATE INDEX idx_cci_outcome ON tribunal_cci (outcome);
CREATE INDEX idx_cci_subject_matter ON tribunal_cci (subject_matter);
CREATE INDEX idx_cci_cited_acts ON tribunal_cci USING GIN (cited_acts);
CREATE INDEX idx_cci_cited_sections ON tribunal_cci USING GIN (cited_sections);
CREATE INDEX idx_cci_category ON tribunal_cci (category);
CREATE INDEX idx_cci_section ON tribunal_cci (section);
CREATE INDEX idx_cci_case_type ON tribunal_cci (case_type);
CREATE INDEX idx_cci_sectors ON tribunal_cci USING GIN (sectors);
CREATE INDEX idx_cci_title_trgm ON tribunal_cci USING GIN (title gin_trgm_ops);
CREATE INDEX idx_cci_petitioner_trgm ON tribunal_cci USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_cci_respondent_trgm ON tribunal_cci USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_cci ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_cci FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_cci FOR ALL USING (auth.role() = 'service_role');
