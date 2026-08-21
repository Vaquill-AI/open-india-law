-- ============================================================================
-- STATISTICS TABLE — Record counts per tribunal (materialized for dashboard)
-- ============================================================================
CREATE TABLE tribunal_stats (
    tribunal      TEXT PRIMARY KEY,
    record_count  INT NOT NULL DEFAULT 0,
    last_updated  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO tribunal_stats (tribunal, record_count) VALUES
    ('aptel',    2707),
    ('atfp',     3359),
    ('cat',      4762),
    ('cci',      2944),
    ('cestat',   122612),
    ('drt',      29447),
    ('gst_aar',  2618),
    ('ibbi',     1580),
    ('itat',     35453),
    ('nclt',     21303),
    ('ngt',      34350),
    ('rera',     1530),
    ('sat',      9296),
    ('tdsat',    1348);

COMMENT ON TABLE tribunal_stats IS 'Pre-computed record counts per tribunal. Update after bulk imports.';


-- ============================================================================
-- HELPER FUNCTION — Refresh stats from actual table counts
-- ============================================================================
CREATE OR REPLACE FUNCTION refresh_tribunal_stats()
RETURNS VOID AS $$
BEGIN
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_aptel),    last_updated = NOW() WHERE tribunal = 'aptel';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_atfp),     last_updated = NOW() WHERE tribunal = 'atfp';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_cat),      last_updated = NOW() WHERE tribunal = 'cat';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_cci),      last_updated = NOW() WHERE tribunal = 'cci';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_cestat),   last_updated = NOW() WHERE tribunal = 'cestat';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_drt),      last_updated = NOW() WHERE tribunal = 'drt';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_gst_aar),  last_updated = NOW() WHERE tribunal = 'gst_aar';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_ibbi),     last_updated = NOW() WHERE tribunal = 'ibbi';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_itat),     last_updated = NOW() WHERE tribunal = 'itat';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_nclt),     last_updated = NOW() WHERE tribunal = 'nclt';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_ngt),      last_updated = NOW() WHERE tribunal = 'ngt';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_rera),     last_updated = NOW() WHERE tribunal = 'rera';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_sat),      last_updated = NOW() WHERE tribunal = 'sat';
    UPDATE tribunal_stats SET record_count = (SELECT COUNT(*) FROM tribunal_tdsat),    last_updated = NOW() WHERE tribunal = 'tdsat';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION refresh_tribunal_stats IS 'Recalculates record counts for all tribunal tables. Call after bulk imports.';
