-- ============================================================================
-- ITAT — Income Tax Appellate Tribunal
-- Direct tax appeals
-- R2 upload count: 35,453
-- ============================================================================

CREATE TABLE tribunal_itat (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,                           -- e.g. ITA 1073/DEL/2014
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,                           -- e.g. itat_delhi, itat_mumbai
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
    subject_matter TEXT,                          -- topic classification, e.g. capital gains, TDS, transfer pricing
    cited_acts    TEXT[],                         -- acts/statutes cited
    cited_sections TEXT[],                        -- specific IT Act sections, e.g. {Section 68, Section 271(1)(c)}
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- ITAT-specific columns
    appeal_type_code TEXT,                        -- ITA (Income Tax Appeal), CO (Cross Objection), MA (Misc Application), SA (Stay Application)
    assessment_year  TEXT,                        -- e.g. 2005-06, 2023-24
    case_type        TEXT,                        -- always 'Income Tax Appeal' for ITAT
    income_amount    NUMERIC,                    -- disputed income/addition amount (INR)
    it_section       TEXT,                        -- primary IT Act section in dispute, e.g. 68, 271(1)(c), 263
    assessee_type    TEXT,                        -- individual, huf, firm, company, trust, aop
    tax_issue        TEXT                         -- capital_gains, tds, transfer_pricing, penalty, reassessment, exemption
);

COMMENT ON TABLE tribunal_itat IS 'Income Tax Appellate Tribunal — direct tax appeals';
COMMENT ON COLUMN tribunal_itat.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_itat.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_itat.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_itat.cited_sections IS 'Array of specific IT Act sections cited';
COMMENT ON COLUMN tribunal_itat.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_itat.appeal_type_code IS 'Appeal type: ITA=Income Tax Appeal, CO=Cross Objection, MA=Misc Application, SA=Stay Application';
COMMENT ON COLUMN tribunal_itat.assessment_year IS 'Assessment year in YYYY-YY format, e.g. 2023-24';
COMMENT ON COLUMN tribunal_itat.income_amount IS 'Disputed income or addition amount in INR';
COMMENT ON COLUMN tribunal_itat.it_section IS 'Primary IT Act section in dispute: 68, 271(1)(c), 263, etc.';
COMMENT ON COLUMN tribunal_itat.assessee_type IS 'Assessee type: individual, huf, firm, company, trust, aop';
COMMENT ON COLUMN tribunal_itat.tax_issue IS 'Primary tax issue: capital_gains, tds, transfer_pricing, penalty, reassessment, exemption';

-- Indexes
CREATE INDEX idx_itat_decision_date ON tribunal_itat (decision_date);
CREATE INDEX idx_itat_year ON tribunal_itat (year);
CREATE INDEX idx_itat_judges ON tribunal_itat USING GIN (judges);
CREATE INDEX idx_itat_outcome ON tribunal_itat (outcome);
CREATE INDEX idx_itat_subject_matter ON tribunal_itat (subject_matter);
CREATE INDEX idx_itat_cited_acts ON tribunal_itat USING GIN (cited_acts);
CREATE INDEX idx_itat_cited_sections ON tribunal_itat USING GIN (cited_sections);
CREATE INDEX idx_itat_appeal_type_code ON tribunal_itat (appeal_type_code);
CREATE INDEX idx_itat_assessment_year ON tribunal_itat (assessment_year);
CREATE INDEX idx_itat_bench ON tribunal_itat (bench);
CREATE INDEX idx_itat_it_section ON tribunal_itat (it_section);
CREATE INDEX idx_itat_assessee_type ON tribunal_itat (assessee_type);
CREATE INDEX idx_itat_tax_issue ON tribunal_itat (tax_issue);
CREATE INDEX idx_itat_title_trgm ON tribunal_itat USING GIN (title gin_trgm_ops);
CREATE INDEX idx_itat_petitioner_trgm ON tribunal_itat USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_itat_respondent_trgm ON tribunal_itat USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_itat ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_itat FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_itat FOR ALL USING (auth.role() = 'service_role');
