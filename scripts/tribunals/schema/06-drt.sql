-- ============================================================================
-- DRT/DRAT — Debt Recovery Tribunal / Debt Recovery Appellate Tribunal
-- Debt recovery and SARFAESI matters
-- R2 upload count: 29,447
-- ============================================================================

CREATE TABLE tribunal_drt (
    -- Common columns
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       TEXT NOT NULL UNIQUE,
    case_number   TEXT,
    title         TEXT,
    petitioner    TEXT,
    respondent    TEXT,
    bench         TEXT,                           -- e.g. drt_debt_recovery_appellate_delhi
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
    cited_acts    TEXT[],                         -- acts/statutes cited, e.g. {RDDBFI Act 1993, SARFAESI Act 2002}
    cited_sections TEXT[],                        -- specific sections cited
    headnotes     TEXT,                           -- AI-extracted summary/headnote

    -- DRT-specific columns
    tribunal_type TEXT,                           -- DRT or DRAT (appellate)
    tribunal_id   TEXT,                           -- numeric tribunal ID from cis.drt.gov.in
    order_type    TEXT,                           -- final, interim, etc.
    diary_number  TEXT,                           -- diary/registration number, e.g. 18/2025
    item_no       TEXT,                           -- item number in the cause list
    claim_amount  NUMERIC,                       -- claimed debt amount (INR)
    bank_name     TEXT,                           -- creditor bank/financial institution
    case_category TEXT,                           -- OA (Original Application), SA (Securitisation), RP (Recovery Proceeding)
    is_sarfaesi   BOOLEAN                        -- whether SARFAESI Act is involved
);

COMMENT ON TABLE tribunal_drt IS 'Debt Recovery Tribunal (DRT) and Debt Recovery Appellate Tribunal (DRAT)';
COMMENT ON COLUMN tribunal_drt.outcome IS 'Case outcome: allowed, dismissed, partly_allowed, remanded, settled, withdrawn';
COMMENT ON COLUMN tribunal_drt.subject_matter IS 'Topic classification of the case';
COMMENT ON COLUMN tribunal_drt.cited_acts IS 'Array of acts/statutes cited';
COMMENT ON COLUMN tribunal_drt.cited_sections IS 'Array of specific sections cited';
COMMENT ON COLUMN tribunal_drt.headnotes IS 'AI-extracted summary or headnote';
COMMENT ON COLUMN tribunal_drt.tribunal_type IS 'DRT (original) or DRAT (appellate)';
COMMENT ON COLUMN tribunal_drt.tribunal_id IS 'Numeric tribunal identifier from cis.drt.gov.in';
COMMENT ON COLUMN tribunal_drt.order_type IS 'Order disposition: final, interim, etc.';
COMMENT ON COLUMN tribunal_drt.diary_number IS 'Diary/registration number assigned at filing';
COMMENT ON COLUMN tribunal_drt.item_no IS 'Item number in the tribunal cause list';
COMMENT ON COLUMN tribunal_drt.claim_amount IS 'Claimed debt amount in INR';
COMMENT ON COLUMN tribunal_drt.bank_name IS 'Creditor bank or financial institution name';
COMMENT ON COLUMN tribunal_drt.case_category IS 'OA=Original Application, SA=Securitisation Application, RP=Recovery Proceeding';
COMMENT ON COLUMN tribunal_drt.is_sarfaesi IS 'Whether SARFAESI Act 2002 is involved';

-- Indexes
CREATE INDEX idx_drt_decision_date ON tribunal_drt (decision_date);
CREATE INDEX idx_drt_year ON tribunal_drt (year);
CREATE INDEX idx_drt_judges ON tribunal_drt USING GIN (judges);
CREATE INDEX idx_drt_outcome ON tribunal_drt (outcome);
CREATE INDEX idx_drt_subject_matter ON tribunal_drt (subject_matter);
CREATE INDEX idx_drt_cited_acts ON tribunal_drt USING GIN (cited_acts);
CREATE INDEX idx_drt_cited_sections ON tribunal_drt USING GIN (cited_sections);
CREATE INDEX idx_drt_tribunal_type ON tribunal_drt (tribunal_type);
CREATE INDEX idx_drt_order_type ON tribunal_drt (order_type);
CREATE INDEX idx_drt_tribunal_id ON tribunal_drt (tribunal_id);
CREATE INDEX idx_drt_bank_name ON tribunal_drt (bank_name);
CREATE INDEX idx_drt_case_category ON tribunal_drt (case_category);
CREATE INDEX idx_drt_title_trgm ON tribunal_drt USING GIN (title gin_trgm_ops);
CREATE INDEX idx_drt_petitioner_trgm ON tribunal_drt USING GIN (petitioner gin_trgm_ops);
CREATE INDEX idx_drt_respondent_trgm ON tribunal_drt USING GIN (respondent gin_trgm_ops);

-- Row Level Security
ALTER TABLE tribunal_drt ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read access" ON tribunal_drt FOR SELECT USING (true);
CREATE POLICY "Service role full access" ON tribunal_drt FOR ALL USING (auth.role() = 'service_role');
