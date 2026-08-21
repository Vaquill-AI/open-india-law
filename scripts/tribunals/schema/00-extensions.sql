-- ============================================================================
-- Extensions required by the Tribunal Case Search Platform
-- Platform: tribunals.vaquill.ai
-- Database: Supabase (PostgreSQL 15+)
--
-- IMPORTANT: Only records with successfully uploaded PDFs to R2 are stored.
-- R2 upload counts at time of schema creation:
--   aptel: 2,707      atfp: 3,359       cat: 4,762       cci: 2,944
--   cestat: 122,612    drt: 29,447       gst_aar: 2,618   ibbi: 1,580
--   itat: 35,453       nclt: 21,303      ngt: 34,350      rera (all): 1,530
--   sat: 9,296         tdsat: 1,348
--   TOTAL: 273,309 cases with PDFs
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for trigram text search
