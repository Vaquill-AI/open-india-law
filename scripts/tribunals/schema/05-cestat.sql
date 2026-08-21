-- ============================================================================
-- CESTAT — Customs, Excise & Service Tax Appellate Tribunal
-- Indirect tax appeals
-- R2 upload count: 122,612
-- ============================================================================

CREATE TABLE tribunal_cestat (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,                           -- e.g. C/51455/2022 (C=Customs, E=Excise, ST=Service Tax)
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,                           -- e.g. cestat_delhi, cestat_mumbai
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

    -- CESTAT-specific columns
    order_type    TEXT,                           -- F (Final), M (Misc), S (Stay), R (Rectification)
    bench_type    TEXT,                           -- derived: customs, excise, service_tax (from case_number prefix C/E/ST)
    pdf_id        TEXT,                           -- internal PDF ID from cestat.gov.in
    duty_amount   NUMERIC,                       -- customs/excise duty amount in dispute (INR)
    commodity     TEXT,                           -- commodity/goods involved
    tariff_heading TEXT,                          -- customs tariff heading (HS code), e.g. 8471, 3004
    penalty_amount NUMERIC                       -- penalty imposed (INR)
);

COMMENT ON TABLE tribunal_cestat IS 'Customs, Excise & Service Tax Appellate Tribunal — indirect tax appeals';
COMMENT ON COLUMN tribunal_cestat.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_cestat.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_cestat.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_cestat.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_cestat.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_cestat.order_type IS 'Order type code: F=Final, M=Misc, S=Stay, R=Rectification';
COMMENT ON COLUMN tribunal_cestat.bench_type IS 'Subject matter derived from case number prefix: customs (C/), excise (E/), service_tax (ST/)';
COMMENT ON COLUMN tribunal_cestat.pdf_id IS 'Internal PDF identifier from cestat.gov.in';
COMMENT ON COLUMN tribunal_cestat.duty_amount IS 'Customs/excise duty amount in dispute (INR)';
COMMENT ON COLUMN tribunal_cestat.commodity IS 'Commodity or goods involved in the dispute';
COMMENT ON COLUMN tribunal_cestat.tariff_heading IS 'Customs tariff heading (HS code)';
COMMENT ON COLUMN tribunal_cestat.penalty_amount IS 'Penalty amount imposed (INR)';

-- Indexes
CREATE INDEX idx_cestat_decision_date ON tribunal_cestat (decision_date);
CREATE INDEX idx_cestat_year ON tribunal_cestat (year);
CREATE INDEX idx_cestat_judges ON tribunal_cestat USING GIN (judges);
CREATE INDEX idx_cestat_outcome ON tribunal_cestat (outcome);
CREATE INDEX idx_cestat_subject_matter ON tribunal_cestat (subject_matter);
CREATE INDEX idx_cestat_cited_acts ON tribunal_cestat USING GIN (cited_acts);
CREATE INDEX idx_cestat_cited_sections ON tribunal_cestat USING GIN (cited_sections);
CREATE INDEX idx_cestat_order_type ON tribunal_cestat (order_type);
CREATE INDEX idx_cestat_bench_type ON tribunal_cestat (bench_type);
CREATE INDEX idx_cestat_bench ON tribunal_cestat (bench);
CREATE INDEX idx_cestat_commodity ON tribunal_cestat (commodity);
CREATE INDEX idx_cestat_tariff_heading ON tribunal_cestat (tariff_heading);
CREATE INDEX idx_cestat_title_trgm ON tribunal_cestat USING GIN (title gin_trgm_ops);
CREATE INDEX idx_cestat_petitioner_trgm ON tribunal_cestat USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_cestat_respondent_trgm ON tribunal_cestat USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_cestat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_cestat FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_cestat FOR ALL USING (auth.role() = 'service_role');
