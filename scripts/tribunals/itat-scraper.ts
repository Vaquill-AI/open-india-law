/**
 * ITAT Scraper - Income Tax Appellate Tribunal (v2 — Optimized)
 * Scrapes tribunal orders from https://itat.gov.in/judicial/tribunalorders
 *
 * ============================================================================
 * WHY THIS IS SLOW (READ THIS FIRST):
 *
 *   ITAT's website has NO bulk API and NO date-range search. Every query is:
 *     1 bench × 1 date × 1 appeal type = 1 HTTP POST (with CAPTCHA + CSRF)
 *
 *   For one year: 30 benches × ~257 working days × ~5 appeal types = ~40,000 requests.
 *   Even at 2 req/sec, that's 5.5 hours minimum. With proxy latency + 403 backoffs:
 *
 *     >>> EXPECT 5–10 HOURS PER YEAR with 10 workers <<<
 *     >>> FULL 25-YEAR BACKFILL (2000–2024) = 5–10 DAYS of runtime <<<
 *
 *   There is no way to speed this up further without the site providing a bulk API.
 *   The scraper is already optimized to the physical limits of the ITAT website.
 * ============================================================================
 *
 * KEY OPTIMIZATIONS (v2):
 *   1. APPEAL TYPE TIERING: Skip abolished taxes (WTA, EDA, GTA etc.) — 4.5x fewer searches
 *   2. CAPTCHA REUSE: Solve ONE captcha per session, reuse for ~260+ searches (~13 min)
 *   3. ADAPTIVE DELAY: Speed up when stable, back off on errors (300ms–15s range)
 *   4. HTTP KEEP-ALIVE: Reuse TCP connections through proxy for lower latency
 *   5. PRIORITY ORDERING: ITA first (99.7% of orders), then CO/MA/SA, then discovery
 *   6. HOLIDAY SKIP: Skip Indian national holidays (no court orders on those dates)
 *   7. OXYLABS STICKY SESSIONS: Per-worker sessid+sesstime keeps same IP for 15 min
 *   8. PDF DIRECT DOWNLOAD: PDFs bypass proxy (faster, cheaper)
 *
 * Appeal Type Tiers:
 *   Tier 1 (always): ITA — 99.7% of all orders
 *   Tier 2 (always): CO, MA, SA — remaining ~0.3%
 *   Tier 3 (big benches only): ITSSA, ITTPA, ITITA, BMA, TDS
 *   SKIP (abolished): WTA, EDA, GTA, INTTA, STTA, ETA, STA, HCD, RA
 *
 * Reduced search space: ~35K searches instead of ~159K (4.5x reduction)
 *
 * Usage:
 *   # Full run with 2captcha (default, most reliable)
 *   CAPTCHA_API_KEY=xxx npx tsx scripts/itat-scraper.ts
 *
 *   # Metadata only (recommended first pass)
 *   CAPTCHA_API_KEY=xxx npx tsx scripts/itat-scraper.ts --metadata-only
 *
 *   # All appeal types (override tiering, search all 18)
 *   CAPTCHA_API_KEY=xxx npx tsx scripts/itat-scraper.ts --all-types
 *
 *   # Single bench / type
 *   BENCH=Delhi APPEAL_TYPE=ITA CAPTCHA_API_KEY=xxx npx tsx scripts/itat-scraper.ts
 *
 *   # Download PDFs only (requires previous metadata run)
 *   npx tsx scripts/itat-scraper.ts --download-only
 *
 * Environment:
 *   CAPTCHA_API_KEY  - API key (2captcha: hex string, CapSolver: CAP-xxx)
 *   CAPTCHA_SERVICE  - "2captcha" (default) or "capsolver"
 *   WORKERS          - Number of concurrent workers (default: 3)
 *   BENCH            - Single bench name (default: all benches)
 *   APPEAL_TYPE      - Single appeal type code (default: tiered)
 *   START_DATE       - Start date dd/mm/yyyy (default: 01/01/2025)
 *   END_DATE         - End date dd/mm/yyyy (default: yesterday)
 *   MAX_CONCURRENT   - Max concurrent PDF downloads per worker (default: 3)
 *   DELAY_MS         - Base delay between searches in ms (default: 800)
 *   PROXY_URL        - HTTP proxy URL (e.g., Oxylabs residential)
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { fileURLToPath } from 'url';
import { Solver } from '2captcha-ts'; // Used only when CAPTCHA_SERVICE=2captcha
import { HttpsProxyAgent } from 'https-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://itat.gov.in';
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/itat');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || '';
const CAPTCHA_SERVICE = (process.env.CAPTCHA_SERVICE || '2captcha').toLowerCase(); // "2captcha" | "capsolver"
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const NUM_WORKERS = parseInt(process.env.WORKERS || '3', 10); // Default 3 (safe for proxy)
const BASE_DELAY_MS = parseInt(process.env.DELAY_MS || '800', 10); // Adaptive base (was 1000)
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const SESSION_REFRESH_INTERVAL_MS = 13 * 60 * 1000; // 13 min (session expires at 15)

// Adaptive delay bounds
const MIN_DELAY_MS = 300;
const MAX_DELAY_MS = 15000;

// Captcha pricing per service
const CAPTCHA_PRICING: Record<string, number> = {
  capsolver: 0.0004, // $0.40/1000 solves (ImageToText)
  '2captcha': 0.003, // $2.99/1000 solves
};
const CAPTCHA_COST_PER_SOLVE = CAPTCHA_PRICING[CAPTCHA_SERVICE] || 0.003;

// CapSolver API endpoint (returns result immediately for ImageToText — no polling)
const CAPSOLVER_API_URL = 'https://api.capsolver.com';

// Proxy configuration (Oxylabs residential proxy) with keep-alive + sticky sessions
const PROXY_URL = process.env.PROXY_URL || '';

// Keep-alive agents for direct connections (no proxy)
const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

// Per-worker sticky session proxy agents (Oxylabs sessid keeps same IP for ~10 min)
const workerProxyAgents: Map<number, HttpsProxyAgent> = new Map();

function createStickyProxyAgent(workerId: number): HttpsProxyAgent {
  if (!PROXY_URL) throw new Error('No PROXY_URL configured');
  const url = new URL(PROXY_URL);
  const sessId = `itat_w${workerId}_${Date.now()}`;
  // Oxylabs sticky session: -sessid-XXX keeps same IP, -sesstime-15 extends to 15 min
  url.username = `${url.username}-sessid-${sessId}-sesstime-15`;
  const agent = new HttpsProxyAgent(url.toString(), { keepAlive: true });
  workerProxyAgents.set(workerId, agent);
  return agent;
}

function refreshStickyProxy(workerId: number): void {
  // Create new agent with fresh sessid (new IP) for next session
  createStickyProxyAgent(workerId);
}

// Helper: get connection agents (proxy or direct keep-alive)
// workerId is optional — when provided, uses per-worker sticky proxy
function getAgents(workerId?: number): {
  httpAgent?: http.Agent;
  httpsAgent?: https.Agent | HttpsProxyAgent;
} {
  if (PROXY_URL) {
    const wid = workerId ?? 0;
    let agent = workerProxyAgents.get(wid);
    if (!agent) agent = createStickyProxyAgent(wid);
    return { httpsAgent: agent, httpAgent: agent as unknown as http.Agent };
  }
  return { httpAgent: keepAliveHttpAgent, httpsAgent: keepAliveHttpsAgent };
}

// Global captcha solve counter (thread-safe via single JS thread)
let totalCaptchaSolves = 0;
let totalErrors = 0;
let total403s = 0;
let activeWorkers = 0;

// ---------------------------------------------------------------------------
// Adaptive Delay Manager (per-worker)
// ---------------------------------------------------------------------------

class AdaptiveDelay {
  private currentDelay: number;
  private successStreak = 0;

  constructor(baseDelay = BASE_DELAY_MS) {
    this.currentDelay = baseDelay;
  }

  onSuccess(): void {
    this.successStreak++;
    // After 5 consecutive successes, reduce delay (min 300ms)
    if (this.successStreak >= 5) {
      this.currentDelay = Math.max(MIN_DELAY_MS, this.currentDelay - 100);
      this.successStreak = 0;
    }
  }

  onError(): void {
    this.successStreak = 0;
    // Double delay on error (max 15s)
    this.currentDelay = Math.min(MAX_DELAY_MS, this.currentDelay * 2);
  }

  on403(): void {
    this.successStreak = 0;
    // Aggressive backoff for rate limits
    this.currentDelay = Math.min(MAX_DELAY_MS, this.currentDelay * 3);
  }

  reset(): void {
    this.currentDelay = BASE_DELAY_MS;
    this.successStreak = 0;
  }

  get delay(): number {
    return this.currentDelay;
  }
}

// ---------------------------------------------------------------------------
// Appeal Type Tiers (data-driven optimization)
// ---------------------------------------------------------------------------

// Tier 1: Always search (99.7% of all orders)
const TIER1_TYPES = ['ITA'];

// Tier 2: Always search (remaining ~0.3%)
const TIER2_TYPES = ['CO', 'MA', 'SA'];

// Tier 3: Only at major benches (rare but possible for 2025+)
const TIER3_TYPES = ['ITSSA', 'ITTPA', 'ITITA', 'BMA', 'TDS'];

// SKIP (for post-abolition years): Abolished taxes or ultra-rare
// For historical scraping, these are searched for years when they were active.
const SKIP_TYPES = ['WTA', 'EDA', 'GTA', 'INTTA', 'STTA', 'ETA', 'STA', 'HCD', 'RA'];

// Abolished appeal types with their last active year (inclusive).
// Types are searched for dates <= Dec 31 of their last active year.
const ABOLISHED_TYPE_LAST_YEAR: Record<string, number> = {
  WTA: 2016, // Wealth Tax Act abolished 2016
  EDA: 1985, // Estate Duty Act abolished 1985
  GTA: 1998, // Gift Tax Act abolished 1998
  INTTA: 2000, // Interest Tax Act abolished 2000
  ETA: 1987, // Expenditure Tax Act abolished 1987
  STA: 2000, // Sur Tax Act abolished 2000
  STTA: 2018, // Security Transaction Tax Appeal — ultra-rare, last seen ~2018
};

/**
 * Returns appeal types that should be searched for a given year.
 * For historical backfill, abolished types are included if the year
 * falls within their active period.
 */
function getAppealTypesForYear(
  year: number,
  bench: string,
  allTypesMode: boolean,
  explicitType?: string,
): string[] {
  if (explicitType) return [explicitType];
  if (allTypesMode) return Object.keys(APPEAL_TYPES);

  const types = [...TIER1_TYPES, ...TIER2_TYPES]; // ITA, CO, MA, SA always

  // Tier 3 at major benches
  if (MAJOR_BENCHES.has(bench)) {
    types.push(...TIER3_TYPES);
  }

  // Add abolished types if the year is within their active period
  for (const [type, lastYear] of Object.entries(ABOLISHED_TYPE_LAST_YEAR)) {
    if (year <= lastYear) {
      // Only at major benches for rare types, all benches for WTA (was widespread)
      if (type === 'WTA' || MAJOR_BENCHES.has(bench)) {
        types.push(type);
      }
    }
  }

  // HCD and RA are ultra-rare at tribunal level — skip unless --all-types
  return types;
}

// Major benches where Tier 3 types might exist
const MAJOR_BENCHES = new Set([
  'Delhi',
  'Mumbai',
  'Bangalore',
  'Chennai',
  'Hyderabad',
  'Kolkata',
  'Ahmedabad',
  'Pune',
]);

// ---------------------------------------------------------------------------
// Indian Holidays — courts don't sit, no orders possible
// Fixed national holidays (same date every year) are checked dynamically.
// Only moveable/religious holidays are listed for specific years.
// ---------------------------------------------------------------------------

// Fixed national holidays: day/month (these are the same every year)
const FIXED_HOLIDAYS: Array<[number, number]> = [
  [26, 1], // Republic Day
  [14, 4], // Ambedkar Jayanti
  [1, 5], // May Day
  [15, 8], // Independence Day
  [2, 10], // Gandhi Jayanti
  [25, 12], // Christmas
];

// Moveable/religious holidays for specific years (dd/mm/yyyy)
const MOVEABLE_HOLIDAYS = new Set([
  // 2025
  '14/02/2025', // Maha Shivaratri
  '14/03/2025', // Holi
  '31/03/2025', // Eid-ul-Fitr (approx)
  '06/04/2025', // Ram Navami
  '10/04/2025', // Mahavir Jayanti
  '18/04/2025', // Good Friday
  '12/05/2025', // Buddha Purnima
  '07/06/2025', // Eid-ul-Adha (approx)
  '06/07/2025', // Muharram (approx)
  '16/08/2025', // Janmashtami
  '05/09/2025', // Milad-un-Nabi (approx)
  '02/10/2025', // Dussehra (approx)
  '20/10/2025', // Diwali (approx)
  '05/11/2025', // Guru Nanak Jayanti
  // 2026 moveable holidays can be added as needed
]);

function isHoliday(date: Date, dateStr: string): boolean {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  for (const [hDay, hMonth] of FIXED_HOLIDAYS) {
    if (day === hDay && month === hMonth) return true;
  }
  return MOVEABLE_HOLIDAYS.has(dateStr);
}

// Bench name → form value mapping (numeric IDs used in select dropdowns)
const BENCH_VALUES: Record<string, string> = {
  Agra: '203',
  Ahmedabad: '205',
  Allahabad: '207',
  Amritsar: '209',
  Bangalore: '211',
  Chandigarh: '215',
  Chennai: '217',
  Cochin: '219',
  Cuttack: '221',
  Dehradun: '260',
  Delhi: '201',
  Guwahati: '223',
  Hyderabad: '225',
  Indore: '227',
  Jabalpur: '229',
  Jaipur: '231',
  Jodhpur: '233',
  Kolkata: '235',
  Lucknow: '237',
  Mumbai: '199',
  Nagpur: '239',
  Panaji: '241',
  Patna: '243',
  Pune: '245',
  Raipur: '247',
  Rajkot: '249',
  Ranchi: '251',
  Surat: '256',
  Varanasi: '258',
  Visakhapatnam: '253',
};

const BENCHES = Object.keys(BENCH_VALUES);

const APPEAL_TYPES: Record<string, string> = {
  ITA: 'Income Tax Appeal',
  CO: 'Cross Objection',
  ITSSA: 'Income Tax (Search & Seizure) Appeal',
  ITTPA: 'Income Tax (Transfer Pricing) Appeal',
  ITITA: 'Income Tax (International Taxation) Appeal',
  WTA: 'Wealth Tax Appeal',
  BMA: 'Black Money Appeal',
  EDA: 'Estate Duty Appeal',
  INTTA: 'Interest Tax Appeal',
  GTA: 'Gift Tax Appeal',
  TDS: 'TDS Appeal',
  STTA: 'Security Transaction Tax Appeal',
  ETA: 'Expenditure Tax Appeal',
  STA: 'Sur Tax Appeal',
  HCD: 'High Court Decision',
  SA: 'Stay Application',
  MA: 'Miscellaneous Application',
  RA: 'Reference Application',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrderMetadata {
  case_number: string;
  appeal_type_code: string;
  appeal_type: string;
  bench: string;
  assessee_name: string;
  respondent: string;
  assessment_year: string;
  order_date: string;
  pronouncement_date: string;
  member_names: string[];
  pdf_url: string;
  pdf_filename: string;
  din_number: string;
  source_url: string;
  tribunal: string;
  country: string;
  scraped_at: string;
}

interface DayResult {
  bench: string;
  date: string;
  orders_found: number;
  orders: OrderMetadata[];
  error?: string;
}

interface Progress {
  completed_searches: string[]; // "Bench|dd/mm/yyyy" keys
  total_orders_found: number;
  total_pdfs_downloaded: number;
  last_bench: string;
  last_date: string;
  last_updated: string;
}

interface SearchResult {
  orders: OrderMetadata[];
  captchaRejected: boolean;
}

interface SessionState {
  cookies: Record<string, string>;
  csrfToken: string;
  createdAt: number;
  captchaText: string; // Reused across multiple searches within same session
  workerId: number; // For per-worker sticky proxy sessions
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    completed_searches: [],
    total_orders_found: 0,
    total_pdfs_downloaded: 0,
    last_bench: '',
    last_date: '',
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(d: Date): string {
  // jQuery UI dateFormat 'dd/mm/yy' = DD/MM/YYYY (4-digit year)
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function formatDateFull(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function parseDate(dateStr: string): Date {
  // Accepts dd/mm/yyyy or dd/mm/yy
  const parts = dateStr.split('/');
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  let year = parseInt(parts[2], 10);
  if (year < 100) year += 2000;
  return new Date(year, month, day);
}

function generateDateRange(start: Date, end: Date): Date[] {
  const dates: Date[] = [];
  const current = new Date(start);
  while (current <= end) {
    // Skip weekends (Saturday=6, Sunday=0)
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // Skip known Indian holidays (fixed + moveable)
      const dateStr = formatDate(current);
      if (!isHoliday(current, dateStr)) {
        dates.push(new Date(current));
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 200);
}

function parseCookies(setCookieHeaders: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of setCookieHeaders) {
    const match = header.match(/^([^=]+)=([^;]+)/);
    if (match) {
      cookies[match[1].trim()] = match[2].trim();
    }
  }
  return cookies;
}

function cookieString(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

async function createSession(workerId: number = 0): Promise<SessionState> {
  log('Creating new session...');

  const resp = await axios.get(`${BASE_URL}/judicial/tribunalorders`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    maxRedirects: 5,
    timeout: 30000,
    ...getAgents(workerId),
  });

  const setCookies = resp.headers['set-cookie'] || [];
  const cookies = parseCookies(setCookies);

  const $ = cheerio.load(resp.data);
  const csrfToken = $('input[name="csrftkn"]').first().attr('value') || '';

  if (!csrfToken) {
    throw new Error('Failed to extract CSRF token from page');
  }

  log(
    `Session created: csrf=${csrfToken.slice(0, 8)}..., cookies=${Object.keys(cookies).join(',')}`,
  );

  return {
    cookies,
    csrfToken,
    createdAt: Date.now(),
    captchaText: '', // Will be solved by solveCaptchaForSession()
    workerId,
  };
}

function isSessionExpired(session: SessionState): boolean {
  return Date.now() - session.createdAt > SESSION_REFRESH_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// CAPTCHA Solver (supports CapSolver and 2captcha)
// ---------------------------------------------------------------------------

/**
 * Fetch captcha image from ITAT server and return base64.
 */
async function fetchCaptchaImage(session: SessionState): Promise<string> {
  const captchaResp = await axios.get(`${BASE_URL}/captcha/show`, {
    headers: {
      Cookie: cookieString(session.cookies),
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    },
    responseType: 'arraybuffer',
    timeout: 15000,
    ...getAgents(session.workerId),
  });

  if (captchaResp.headers['set-cookie']) {
    const newCookies = parseCookies(captchaResp.headers['set-cookie']);
    Object.assign(session.cookies, newCookies);
  }

  return Buffer.from(captchaResp.data).toString('base64');
}

/**
 * Solve captcha using CapSolver (AI-based, $0.40/1000 solves).
 * Returns result immediately — no polling needed for ImageToText.
 */
async function solveWithCapSolver(base64Image: string): Promise<string> {
  log(`Sending CAPTCHA to CapSolver ($${CAPTCHA_COST_PER_SOLVE}/solve)...`);

  const resp = await axios.post(
    `${CAPSOLVER_API_URL}/createTask`,
    {
      clientKey: CAPTCHA_API_KEY,
      task: {
        type: 'ImageToTextTask',
        body: base64Image,
        module: 'common',
        websiteURL: `${BASE_URL}/judicial/tribunalorders`,
      },
    },
    { timeout: 30000 },
  );

  if (resp.data.errorId !== 0) {
    throw new Error(`CapSolver error: ${resp.data.errorCode} - ${resp.data.errorDescription}`);
  }

  const text = resp.data.solution?.text;
  if (!text) {
    throw new Error('CapSolver returned empty solution');
  }

  const solved = text.toUpperCase();

  // CapSolver often returns wrong character count (4-5 chars instead of 6).
  // Skip these to avoid wasting a validation round-trip.
  if (solved.length !== 6) {
    throw new Error(
      `CapSolver returned ${solved.length} chars ("${solved}"), expected 6 — retrying`,
    );
  }

  log(`CAPTCHA solved via CapSolver: ${solved}`);
  return solved;
}

/**
 * Solve captcha using 2captcha (human-based, $2.99/1000 solves).
 */
async function solveWith2Captcha(base64Image: string, solver: Solver): Promise<string> {
  log(`Sending CAPTCHA to 2captcha ($${CAPTCHA_COST_PER_SOLVE}/solve)...`);

  const result = await solver.imageCaptcha({
    body: base64Image,
    numeric: 0,
    min_len: 6,
    max_len: 6,
    caseSensitive: 0,
    lang: 'en',
  });

  const solved = result.data.toUpperCase();
  log(`CAPTCHA solved via 2captcha: ${solved} (id: ${result.id})`);
  return solved;
}

/**
 * Unified captcha solver — routes to configured service.
 */
async function solveCaptcha(session: SessionState, solver: Solver | null): Promise<string> {
  const base64Image = await fetchCaptchaImage(session);

  if (CAPTCHA_SERVICE === 'capsolver') {
    return solveWithCapSolver(base64Image);
  } else {
    if (!solver) throw new Error('2captcha solver not initialized');
    return solveWith2Captcha(base64Image, solver);
  }
}

// ---------------------------------------------------------------------------
// CAPTCHA Validation
// ---------------------------------------------------------------------------

async function validateCaptcha(
  session: SessionState,
  captchaText: string,
  csrfToken: string,
): Promise<boolean> {
  const resp = await axios.post(
    `${BASE_URL}/Ajax/checkCaptcha`,
    `captcha=${encodeURIComponent(captchaText)}`,
    {
      headers: {
        Cookie: cookieString(session.cookies),
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-TOKEN': csrfToken,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Referer: `${BASE_URL}/judicial/tribunalorders`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: 15000,
      ...getAgents(session.workerId),
    },
  );

  // Update cookies if refreshed
  if (resp.headers['set-cookie']) {
    const newCookies = parseCookies(resp.headers['set-cookie']);
    Object.assign(session.cookies, newCookies);
  }

  const result = resp.data;
  return result?.rslt === 'true';
}

// ---------------------------------------------------------------------------
// Session-Level CAPTCHA (solve once, reuse across searches)
// ---------------------------------------------------------------------------

/**
 * Solves and validates a CAPTCHA for the session. The solved text is stored
 * in session.captchaText and reused for all subsequent form submissions
 * until the session expires (~13 min) or the server rejects it.
 *
 * Cost: CapSolver $0.0004/solve, 2captcha $0.003/solve. One solve covers ~260 searches.
 */
async function solveCaptchaForSession(
  session: SessionState,
  solver: Solver | null,
  maxAttempts = 3,
  logPrefix = '',
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const captchaText = await solveCaptcha(session, solver);
      const valid = await validateCaptcha(session, captchaText, session.csrfToken);

      if (valid) {
        session.captchaText = captchaText;
        totalCaptchaSolves++;
        log(
          `${logPrefix}CAPTCHA solved & validated: ${captchaText} (total solves: ${totalCaptchaSolves}, cost: $${(totalCaptchaSolves * CAPTCHA_COST_PER_SOLVE).toFixed(2)})`,
        );
        return;
      }

      log(
        `${logPrefix}CAPTCHA validation failed (attempt ${attempt + 1}/${maxAttempts}), retrying...`,
      );
      await sleep(2000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${logPrefix}CAPTCHA solve error (attempt ${attempt + 1}/${maxAttempts}): ${msg}`);
      await sleep(3000);
    }
  }
  throw new Error(`Failed to solve CAPTCHA after ${maxAttempts} attempts`);
}

// ---------------------------------------------------------------------------
// Search Orders
// ---------------------------------------------------------------------------

async function searchOrdersByDate(
  session: SessionState,
  bench: string,
  date: string, // dd/mm/yyyy format (jQuery UI 'dd/mm/yy' = 4-digit year)
  appealType: string = 'ITA', // Required by server - default to most common
): Promise<SearchResult> {
  // Resolve bench name to numeric ID for the form select
  const benchValue = BENCH_VALUES[bench];
  if (!benchValue) {
    throw new Error(`Unknown bench: ${bench}`);
  }

  // Submit Form 2 (search by order date)
  // Uses session.captchaText which was solved once per session and is reused
  // NOTE: app_type_2 is REQUIRED by the server (cannot be empty)
  const formData = new URLSearchParams({
    hp: '', // honeypot - must be empty
    csrftkn: session.csrfToken,
    c2: session.captchaText, // Reused from session-level solve
    bench_name_2: benchValue, // numeric ID, not text name
    app_type_2: appealType, // REQUIRED - server rejects empty
    order_date: date, // dd/mm/yyyy format
    bt2: 'true',
  });

  const resp = await axios.post(`${BASE_URL}/judicial/tribunalorders`, formData.toString(), {
    headers: {
      Cookie: cookieString(session.cookies),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Referer: `${BASE_URL}/judicial/tribunalorders`,
      Origin: BASE_URL,
    },
    maxRedirects: 5,
    timeout: 30000,
    ...getAgents(session.workerId),
  });

  // Update session cookies
  if (resp.headers['set-cookie']) {
    const newCookies = parseCookies(resp.headers['set-cookie']);
    Object.assign(session.cookies, newCookies);
  }

  // Debug: save raw response in test/debug mode
  if (process.env.DEBUG_HTML) {
    const debugFile = path.join(DATA_DIR, `debug_${bench}_${date.replace(/\//g, '-')}.html`);
    fs.writeFileSync(debugFile, resp.data);
    log(`  DEBUG: saved response HTML to ${debugFile} (${resp.data.length} bytes)`);
  }

  // Refresh CSRF token from response HTML (rotates per page load)
  const $resp = cheerio.load(resp.data);
  const newCsrf = $resp('input[name="csrftkn"]').first().attr('value');
  if (newCsrf) {
    session.csrfToken = newCsrf;
  }

  // Detect captcha rejection: server redirects back to form with no results
  const hasResultsTable = $resp('#results table').length > 0;
  const noRecords =
    resp.data.includes('No Records Found') ||
    resp.data.includes('No records found') ||
    resp.data.includes('No records') ||
    resp.data.includes('No Record');
  const hasSearchForm = $resp('form#f2').length > 0;
  const hasCaptchaField = $resp('input[name="captcha"]').length > 0 || $resp('#captcha').length > 0;

  // If we got neither results nor "no records" message, and the page has
  // the search form with captcha field, the captcha was likely rejected
  if (!hasResultsTable && !noRecords && hasSearchForm && hasCaptchaField) {
    return { orders: [], captchaRejected: true };
  }

  // Parse results from #results div
  const orders = parseOrderResults(resp.data, bench, date);
  return { orders, captchaRejected: false };
}

// ---------------------------------------------------------------------------
// Result Parser
// ---------------------------------------------------------------------------

function parseOrderResults(html: string, bench: string, searchDate: string): OrderMetadata[] {
  const $ = cheerio.load(html);
  const orders: OrderMetadata[] = [];

  // Results appear in #results div after form submission (per window.onload JS)
  const resultsDiv = $('#results');

  // Check for "No records found" or similar message
  const bodyText = resultsDiv.length > 0 ? resultsDiv.text() : $.text();
  if (
    bodyText.includes('No records') ||
    bodyText.includes('No data') ||
    bodyText.includes('no record') ||
    bodyText.includes('No Record')
  ) {
    return [];
  }

  // Try #results div first, then fall back to whole page
  const searchScope = resultsDiv.length > 0 ? resultsDiv : $.root();

  // Find result rows - DataTables renders in <table> with <tbody>
  const resultRows = searchScope.find('table tbody tr');

  if (resultRows.length === 0) {
    // Save HTML for debugging if no results found but no "no record" msg either
    if (resultsDiv.length > 0 && resultsDiv.text().trim().length > 20) {
      log(
        `  DEBUG: #results found but no table rows. Content preview: "${resultsDiv.text().trim().slice(0, 100)}..."`,
      );
    }
    return [];
  }

  // Detect table headers to understand column mapping
  const headers = searchScope
    .find('table thead th, table tr:first-child th')
    .map((_, th) => $(th).text().trim().toLowerCase())
    .get();

  if (headers.length > 0) {
    log(`  Table headers: ${headers.join(' | ')}`);
  }

  resultRows.each((_, row) => {
    const order = parseOrderRow($, row, bench, searchDate, headers);
    if (order) orders.push(order);
  });

  return orders;
}

function parseOrderRow(
  $: cheerio.CheerioAPI,
  row: cheerio.Element,
  bench: string,
  searchDate: string,
  _headers: string[] = [],
): OrderMetadata | null {
  const cells = $(row).find('td');
  if (cells.length < 3) return null;

  // Known table structure (from ITAT tribunal orders):
  // Col 0: Appeal Number + Assessment Year + Case Status (combined with <br>)
  // Col 1: Parties (Assessee VS. Respondent, separated by <BR>VS.<BR>)
  // Col 2: Alpha Bench (single letter)
  // Col 3: Order Link (PDF <a> tag)
  // Col 4: More Details (link to case details page)

  // --- Column 0: Parse case number, assessment year, status ---
  const cell0Html = $(cells[0]).html() || '';
  const cell0Parts = cell0Html
    .replace(/<strong>|<\/strong>/gi, '')
    .split(/<br\s*\/?>/i)
    .map((s) => s.trim())
    .filter(Boolean);

  // e.g. ["ITA 1073/DEL/2014", "[2005-06]", "Status: Disposed"]
  const caseNumber = cell0Parts[0] || '';
  const assessmentYear = (cell0Parts[1] || '').replace(/[\[\]]/g, '').trim();
  const caseStatus = (cell0Parts[2] || '').replace(/^Status:\s*/i, '').trim();

  // --- Column 1: Parse parties (assessee vs respondent) ---
  const cell1Html = $(cells[1]).html() || '';
  const partiesParts = cell1Html.split(/<br\s*\/?>\s*vs\.?\s*<br\s*\/?>/i);
  const assessee = (partiesParts[0] || '').replace(/<[^>]+>/g, '').trim();
  const respondent = (partiesParts[1] || '').replace(/<[^>]+>/g, '').trim();

  // --- Column 2: Alpha bench ---
  const alphaBench = $(cells[2]).text().trim();

  // --- Column 3: PDF link ---
  const pdfLink = $(cells[3])?.find('a').attr('href') || '';
  const fullPdfUrl = pdfLink.startsWith('http')
    ? pdfLink
    : pdfLink
      ? `${BASE_URL}/${pdfLink.replace(/^\//, '')}`
      : '';

  // --- Column 4: Case details link ---
  const detailsLink = $(cells[4])?.find('a').attr('href') || '';

  const order: OrderMetadata = {
    case_number: caseNumber,
    appeal_type_code: extractAppealTypeCode(caseNumber),
    appeal_type: APPEAL_TYPES[extractAppealTypeCode(caseNumber)] || 'Unknown',
    bench,
    assessee_name: assessee,
    respondent,
    assessment_year: assessmentYear,
    order_date: searchDate,
    pronouncement_date: '',
    member_names: [], // Not available in search results; available via details link
    pdf_url: fullPdfUrl,
    pdf_filename: fullPdfUrl ? sanitizeFilename(path.basename(new URL(fullPdfUrl).pathname)) : '',
    din_number: '', // Available via details link
    source_url: detailsLink || `${BASE_URL}/judicial/tribunalorders`,
    tribunal: 'ITAT',
    country: 'IN',
    scraped_at: new Date().toISOString(),
  };

  if (!order.case_number && !order.pdf_url) return null;

  return order;
}

function extractAppealTypeCode(caseNumber: string): string {
  const match = caseNumber.match(
    /^(ITA|CO|ITSSA|ITTPA|ITITA|WTA|BMA|EDA|INTTA|GTA|TDS|STTA|ETA|STA|HCD|SA|MA|RA)/i,
  );
  return match ? match[1].toUpperCase() : '';
}

function extractDate(cells: string[], fallback: string): string {
  for (const cell of cells) {
    if (/^\d{2}\/\d{2}\/\d{2,4}$/.test(cell.trim())) {
      return cell.trim();
    }
  }
  return fallback;
}

function extractMemberNames(cells: string[]): string[] {
  const members: string[] = [];
  for (const cell of cells) {
    if (/\b(judicial|accountant|member|vice president|president)\b/i.test(cell)) {
      members.push(cell.trim());
    }
  }
  return members;
}

function extractDIN(cells: string[]): string {
  for (const cell of cells) {
    if (/ITBA/i.test(cell) || /^[A-Z0-9\-\/()]+$/i.test(cell.trim())) {
      if (cell.length > 10 && cell.length < 50) {
        return cell.trim();
      }
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// PDF Downloader
// ---------------------------------------------------------------------------

async function downloadPdf(pdfUrl: string, outputPath: string): Promise<boolean> {
  if (fs.existsSync(outputPath)) {
    return true; // Already downloaded
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // PDFs use direct connection (no proxy) — faster and cheaper
      const resp = await axios.get(pdfUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: 60000,
        httpAgent: keepAliveHttpAgent,
        httpsAgent: keepAliveHttpsAgent,
      });

      if (resp.status === 200 && resp.data.length > 0) {
        fs.writeFileSync(outputPath, resp.data);
        return true;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES - 1) {
        log(`PDF download retry ${attempt + 1}: ${msg}`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return false;
}

async function downloadPdfsBatch(orders: OrderMetadata[], benchDir: string): Promise<number> {
  let downloaded = 0;
  const queue = orders.filter((o) => o.pdf_url);

  // Process in batches of MAX_CONCURRENT
  for (let i = 0; i < queue.length; i += MAX_CONCURRENT) {
    const batch = queue.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.all(
      batch.map(async (order) => {
        const outputPath = path.join(benchDir, order.pdf_filename);
        const success = await downloadPdf(order.pdf_url, outputPath);
        if (success) {
          downloaded++;
          log(`  PDF: ${order.pdf_filename} (${downloaded}/${queue.length})`);
        }
        return success;
      }),
    );
    await sleep(300); // Small delay between batches
  }

  return downloaded;
}

// ---------------------------------------------------------------------------
// Work Queue & Coordinator (concurrent worker pool)
// ---------------------------------------------------------------------------

interface WorkItem {
  bench: string;
  date: Date;
  dateStr: string;
  appealType: string;
  searchKey: string;
  _retries?: number;
}

class WorkQueue {
  private items: WorkItem[] = [];
  private idx = 0;
  private retryQueue: WorkItem[] = [];
  readonly total: number;

  constructor(items: WorkItem[]) {
    this.items = items;
    this.total = items.length;
  }

  next(): WorkItem | null {
    // Drain retry queue first
    if (this.retryQueue.length > 0) {
      return this.retryQueue.shift()!;
    }
    if (this.idx >= this.items.length) return null;
    return this.items[this.idx++];
  }

  /** Push a failed item back for retry (max 2 retries tracked via _retries) */
  retry(item: WorkItem): void {
    this.retryQueue.push(item);
  }

  processed(): number {
    return this.idx;
  }

  pending(): number {
    return this.items.length - this.idx + this.retryQueue.length;
  }
}

class ScrapeCoordinator {
  private progress: Progress;
  private completedSet: Set<string>;
  private totalOrders = 0;
  private totalPdfs = 0;
  private jsonlFile: string;
  private progressSaveTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  constructor(progress: Progress) {
    this.progress = progress;
    this.completedSet = new Set(progress.completed_searches);
    this.totalOrders = progress.total_orders_found;
    this.totalPdfs = progress.total_pdfs_downloaded;
    this.jsonlFile = path.join(DATA_DIR, 'itat-orders.jsonl');

    // Periodic progress save every 10 seconds
    this.progressSaveTimer = setInterval(() => {
      if (this.dirty) this.flushProgress();
    }, 10_000);
  }

  isCompleted(searchKey: string): boolean {
    return this.completedSet.has(searchKey);
  }

  recordResult(
    searchKey: string,
    orders: OrderMetadata[],
    pdfsDownloaded: number,
    bench: string,
    dateStr: string,
  ): void {
    // Mark completed FIRST (in-memory) to prevent re-processing on restart
    this.completedSet.add(searchKey);
    this.totalOrders += orders.length;
    this.totalPdfs += pdfsDownloaded;
    this.progress.completed_searches.push(searchKey);
    this.progress.total_orders_found = this.totalOrders;
    this.progress.total_pdfs_downloaded = this.totalPdfs;
    this.progress.last_bench = bench;
    this.progress.last_date = dateStr;

    // Flush progress to disk BEFORE writing JSONL — so if crash happens during
    // JSONL write, progress already recorded and we won't get duplicates on restart.
    // Worst case: progress says "done" but JSONL missing those orders — acceptable
    // (lost data is recoverable by re-scraping, duplicates are not easily fixable).
    this.flushProgress();

    // Now append to JSONL
    if (orders.length > 0) {
      try {
        const lines = orders.map((o) => JSON.stringify(o)).join('\n') + '\n';
        fs.appendFileSync(this.jsonlFile, lines);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`Failed to write JSONL: ${msg}`);
        // Progress already saved — on next run, this search will be skipped
        // and orders will be lost. Better than duplicates.
      }
    }
  }

  flushProgress(): void {
    saveProgress(this.progress);
    this.dirty = false;
  }

  shutdown(): void {
    if (this.progressSaveTimer) clearInterval(this.progressSaveTimer);
    this.flushProgress();
  }

  stats(): { orders: number; pdfs: number; completed: number } {
    return {
      orders: this.totalOrders,
      pdfs: this.totalPdfs,
      completed: this.completedSet.size,
    };
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function worker(
  workerId: number,
  queue: WorkQueue,
  coordinator: ScrapeCoordinator,
  solver: Solver | null,
  metadataOnly: boolean,
): Promise<void> {
  let session: SessionState | null = null;
  let consecutiveFails = 0;
  let searchesSinceCaptcha = 0; // Track searches per captcha solve
  const adaptiveDelay = new AdaptiveDelay();

  const wlog = (msg: string) => log(`[W${workerId}] ${msg}`);
  const wlogErr = (msg: string) => logError(`[W${workerId}] ${msg}`);

  // Create session + solve captcha (once per session)
  const refreshSession = async (): Promise<SessionState> => {
    // Rotate sticky proxy IP on each session refresh (new sessid = new IP)
    if (PROXY_URL) refreshStickyProxy(workerId);

    for (let i = 0; i < 5; i++) {
      try {
        const s = await createSession(workerId);
        // Solve captcha ONCE for this session — reused for all searches
        await solveCaptchaForSession(s, solver, 3, `[W${workerId}] `);
        searchesSinceCaptcha = 0;
        wlog(`Session ready (csrf=${s.csrfToken.slice(0, 8)}..., captcha=${s.captchaText})`);
        return s;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        wlogErr(`Session create failed (attempt ${i + 1}): ${msg}`);
        const backoff = msg.includes('403')
          ? Math.min(10000 * Math.pow(2, i), 180000)
          : 5000 * (i + 1);
        await sleep(backoff);
      }
    }
    throw new Error('Failed to create session after 5 attempts');
  };

  // Re-solve captcha within existing session (cheaper than full session refresh)
  const reSolveCaptcha = async (): Promise<void> => {
    wlog('Re-solving captcha (previous one rejected)...');
    await solveCaptchaForSession(session!, solver, 3, `[W${workerId}] `);
    searchesSinceCaptcha = 0;
  };

  // Stagger worker startup — 500ms spacing (was 3s, too slow for 200 workers)
  await sleep(workerId * 500);
  try {
    session = await refreshSession();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    wlogErr(`Initial session failed, worker exiting: ${msg}`);
    return; // Don't crash the whole process
  }
  activeWorkers++;

  while (true) {
    const item = queue.next();
    if (!item) break; // Queue exhausted

    // Skip already completed
    if (coordinator.isCompleted(item.searchKey)) continue;

    // Refresh session if expired (also gets new captcha)
    if (!session || isSessionExpired(session)) {
      wlog('Session expired, refreshing...');
      session = await refreshSession();
    }

    const s = coordinator.stats();
    wlog(
      `[${queue.processed()}/${queue.total}] ${item.bench} | ${item.dateStr} | ${item.appealType} (orders: ${s.orders} | captchas: ${totalCaptchaSolves} | $${(totalCaptchaSolves * CAPTCHA_COST_PER_SOLVE).toFixed(2)})`,
    );

    try {
      const result = await searchOrdersByDate(session, item.bench, item.dateStr, item.appealType);

      // Handle captcha rejection — re-solve and retry this item
      if (result.captchaRejected) {
        wlog(`  Captcha rejected after ${searchesSinceCaptcha} searches, re-solving...`);
        try {
          await reSolveCaptcha();
          // Retry the same search with new captcha
          const retry = await searchOrdersByDate(
            session,
            item.bench,
            item.dateStr,
            item.appealType,
          );
          if (retry.captchaRejected) {
            // Still rejected — full session refresh needed
            wlog('  Still rejected after re-solve, refreshing session...');
            session = await refreshSession();
            const retry2 = await searchOrdersByDate(
              session,
              item.bench,
              item.dateStr,
              item.appealType,
            );
            if (retry2.captchaRejected) {
              throw new Error('Captcha rejected even after session refresh');
            }
            // Use retry2 result
            await processSearchResult(retry2, item, coordinator, metadataOnly, wlog);
          } else {
            await processSearchResult(retry, item, coordinator, metadataOnly, wlog);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          wlogErr(`Captcha recovery failed: ${msg}`);
          // Re-queue for retry
          const retries = (item._retries || 0) + 1;
          if (retries <= 2) {
            queue.retry({ ...item, _retries: retries });
          }
          session = await refreshSession();
        }
      } else {
        searchesSinceCaptcha++;
        await processSearchResult(result, item, coordinator, metadataOnly, wlog);
      }

      consecutiveFails = 0;
      adaptiveDelay.onSuccess();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      wlogErr(`${item.bench} ${item.dateStr} ${item.appealType}: ${msg}`);
      consecutiveFails++;

      // Re-queue failed item for retry (max 2 retries)
      const retries = (item._retries || 0) + 1;
      if (retries <= 2) {
        queue.retry({ ...item, _retries: retries });
        wlog(`  Queued for retry (attempt ${retries}/2)`);
      } else {
        wlogErr(`  Giving up after ${retries} retries`);
      }

      totalErrors++;
      // 403/429 = rate limited / blocked — aggressive backoff
      if (msg.includes('403') || msg.includes('429')) {
        total403s++;
        adaptiveDelay.on403();
        const backoff = Math.min(30000 * Math.pow(2, consecutiveFails - 1), 300000);
        wlog(
          `Rate limited (${msg.includes('429') ? '429' : '403'}). Backing off ${Math.round(backoff / 1000)}s... (delay now: ${adaptiveDelay.delay}ms)`,
        );
        await sleep(backoff);
      } else {
        adaptiveDelay.onError();
      }

      if (consecutiveFails >= 15) {
        wlogErr('Too many consecutive failures, worker shutting down.');
        break;
      }

      // Refresh session on error
      try {
        session = await refreshSession();
        adaptiveDelay.reset();
      } catch {
        wlogErr('Cannot recover session, worker shutting down.');
        break;
      }
    }

    // Adaptive delay between searches
    await sleep(adaptiveDelay.delay);
  }

  activeWorkers--;
  wlog(
    `Finished. (captcha solves: ${totalCaptchaSolves}, searches/captcha: ${searchesSinceCaptcha})`,
  );
}

/**
 * Process a successful search result — save metadata, download PDFs, record progress.
 */
async function processSearchResult(
  result: SearchResult,
  item: WorkItem,
  coordinator: ScrapeCoordinator,
  metadataOnly: boolean,
  wlog: (msg: string) => void,
): Promise<void> {
  let pdfsDownloaded = 0;

  if (result.orders.length > 0) {
    wlog(`  Found ${result.orders.length} orders`);

    // Save per-search metadata file
    const metadataFile = path.join(
      METADATA_DIR,
      `${sanitizeFilename(item.bench)}_${item.appealType}_${item.date.getFullYear()}-${String(item.date.getMonth() + 1).padStart(2, '0')}-${String(item.date.getDate()).padStart(2, '0')}.json`,
    );
    const dayResult: DayResult = {
      bench: item.bench,
      date: item.dateStr,
      orders_found: result.orders.length,
      orders: result.orders,
    };
    fs.writeFileSync(metadataFile, JSON.stringify(dayResult, null, 2));

    // Download PDFs
    if (!metadataOnly) {
      const benchDir = path.join(PDFS_DIR, sanitizeFilename(item.bench));
      fs.mkdirSync(benchDir, { recursive: true });
      pdfsDownloaded = await downloadPdfsBatch(result.orders, benchDir);
    }
  }

  coordinator.recordResult(item.searchKey, result.orders, pdfsDownloaded, item.bench, item.dateStr);
}

// ---------------------------------------------------------------------------
// Main Scraper
// ---------------------------------------------------------------------------

async function scrapeITAT(options: {
  benches: string[];
  startDate: Date;
  endDate: Date;
  metadataOnly: boolean;
  downloadOnly: boolean;
  testMode: boolean;
  resume: boolean;
  args: string[];
}): Promise<void> {
  ensureDirs();
  const args = options.args;

  const progress = loadProgress();
  // Only create 2captcha Solver when using that service; CapSolver uses direct API calls
  const solver: Solver | null = CAPTCHA_SERVICE === '2captcha' ? new Solver(CAPTCHA_API_KEY) : null;

  // Determine appeal types to search based on tiering strategy
  const allTypesMode = args.includes('--all-types');
  const explicitType = process.env.APPEAL_TYPE;

  let tierLabel: string;

  if (options.testMode) {
    tierLabel = 'TEST (ITA only)';
  } else if (explicitType) {
    tierLabel = `EXPLICIT (${explicitType})`;
  } else if (allTypesMode) {
    tierLabel = `ALL (${Object.keys(APPEAL_TYPES).length} types)`;
  } else {
    const startYear = options.startDate.getFullYear();
    const endYear = options.endDate.getFullYear();
    const hasHistorical = startYear < 2020;
    tierLabel = hasHistorical
      ? `YEAR-AWARE TIERED (${startYear}-${endYear}, includes abolished types for active years)`
      : `TIERED (${TIER1_TYPES.join(',')}, ${TIER2_TYPES.join(',')}, +${TIER3_TYPES.join(',')} at major benches)`;
  }

  // Generate all work items with PRIORITY ORDERING:
  // 1. ITA for all benches (highest value — 99.7% of orders)
  // 2. CO/MA/SA for all benches
  // 3. Tier 3 types for major benches only
  // 4. Abolished types for years when they were active (historical backfill)
  const dates = generateDateRange(options.startDate, options.endDate);
  const completedSet = new Set(progress.completed_searches);

  const workItems: WorkItem[] = [];
  let skippedByTier = 0;
  let skippedCompleted = 0;

  if (options.testMode) {
    // Test mode: ITA only, single bench
    for (const bench of options.benches) {
      for (const date of dates) {
        const dateStr = formatDate(date);
        const searchKey = `${bench}|${dateStr}|ITA`;
        if (completedSet.has(searchKey)) {
          skippedCompleted++;
          continue;
        }
        workItems.push({ bench, date, dateStr, appealType: 'ITA', searchKey });
      }
    }
  } else if (explicitType || allTypesMode) {
    // Flat ordering for explicit/all types
    const types = explicitType ? [explicitType] : Object.keys(APPEAL_TYPES);
    for (const appealType of types) {
      for (const bench of options.benches) {
        for (const date of dates) {
          const dateStr = formatDate(date);
          const searchKey = `${bench}|${dateStr}|${appealType}`;
          if (completedSet.has(searchKey)) {
            skippedCompleted++;
            continue;
          }
          workItems.push({ bench, date, dateStr, appealType, searchKey });
        }
      }
    }
  } else {
    // Year-aware tiered approach:
    // Group dates by year so we can determine which types to search per year
    const datesByYear = new Map<number, Array<{ date: Date; dateStr: string }>>();
    for (const date of dates) {
      const year = date.getFullYear();
      if (!datesByYear.has(year)) datesByYear.set(year, []);
      datesByYear.get(year)!.push({ date, dateStr: formatDate(date) });
    }

    // Build work items per year with proper tiering
    const seenTypes = new Set<string>();
    for (const [year, yearDates] of Array.from(datesByYear.entries())) {
      for (const bench of options.benches) {
        const types = getAppealTypesForYear(year, bench, false);
        for (const appealType of types) {
          seenTypes.add(appealType);
          for (const { date, dateStr } of yearDates) {
            const searchKey = `${bench}|${dateStr}|${appealType}`;
            if (completedSet.has(searchKey)) {
              skippedCompleted++;
              continue;
            }
            workItems.push({ bench, date, dateStr, appealType, searchKey });
          }
        }
      }
    }

    // Sort work items: ITA first (highest value), then by date descending (newest first)
    const typePriority: Record<string, number> = { ITA: 0, CO: 1, MA: 1, SA: 1 };
    workItems.sort((a, b) => {
      const pa = typePriority[a.appealType] ?? 2;
      const pb = typePriority[b.appealType] ?? 2;
      if (pa !== pb) return pa - pb;
      return b.date.getTime() - a.date.getTime(); // Newest first
    });

    // Estimate skipped count
    const totalAllTypes = Object.keys(APPEAL_TYPES).length;
    const totalUniqueSearches = options.benches.length * dates.length * totalAllTypes;
    skippedByTier = totalUniqueSearches - workItems.length - skippedCompleted;
    if (skippedByTier < 0) skippedByTier = 0;
  }

  const totalUniverse = options.benches.length * dates.length * Object.keys(APPEAL_TYPES).length;
  const totalPlanned = workItems.length + skippedCompleted;
  const numWorkers = options.testMode ? 1 : Math.min(NUM_WORKERS, workItems.length);

  log(`=== ITAT Scraper v2 (optimized) ===`);
  log(`Benches: ${options.benches.length} | Dates: ${dates.length} | Strategy: ${tierLabel}`);
  log(
    `Universe: ${totalUniverse} | Planned: ${totalPlanned} | Skipped (tier): ${skippedByTier} | Already done: ${skippedCompleted} | Remaining: ${workItems.length}`,
  );
  log(
    `Workers: ${numWorkers} | Date range: ${formatDateFull(options.startDate)} to ${formatDateFull(options.endDate)}`,
  );
  log(`Adaptive delay: ${BASE_DELAY_MS}ms base (range: ${MIN_DELAY_MS}–${MAX_DELAY_MS}ms)`);
  log(
    `Mode: ${options.testMode ? 'TEST' : options.metadataOnly ? 'METADATA-ONLY' : options.downloadOnly ? 'DOWNLOAD-ONLY' : 'FULL'}`,
  );
  log('');

  if (options.downloadOnly) {
    await downloadFromMetadata(options.benches, progress);
    return;
  }

  if (workItems.length === 0) {
    log('All searches already completed. Nothing to do.');
    return;
  }

  // Test mode: limit work items
  const testItems = options.testMode ? workItems.slice(0, 3) : workItems;
  const queue = new WorkQueue(testItems);
  const coordinator = new ScrapeCoordinator(progress);

  // Launch workers — each wrapped to prevent one crash from killing all
  log(`Launching ${numWorkers} workers...`);
  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < numWorkers; i++) {
    workerPromises.push(
      worker(i + 1, queue, coordinator, solver, options.metadataOnly).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[W${i + 1}] Crashed: ${msg}`);
        activeWorkers--;
      }),
    );
  }

  // ETA reporter — logs progress every 30 seconds
  const startTime = Date.now();
  const totalItems = queue.total;
  const etaReporter = setInterval(() => {
    const s = coordinator.stats();
    const done = queue.processed();
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = done / elapsed;
    const remaining = totalItems - done;
    const etaSeconds = rate > 0 ? remaining / rate : 0;
    const etaHours = Math.floor(etaSeconds / 3600);
    const etaMin = Math.floor((etaSeconds % 3600) / 60);
    const pct = ((done * 100) / totalItems).toFixed(1);
    log(
      `[PROGRESS] ${done}/${totalItems} (${pct}%) | ${s.orders} judgments | ` +
        `${rate.toFixed(1)}/s | workers: ${activeWorkers}/${numWorkers} | ` +
        `captchas: ${totalCaptchaSolves} ($${(totalCaptchaSolves * CAPTCHA_COST_PER_SOLVE).toFixed(2)}) | ` +
        `errors: ${totalErrors} (403s: ${total403s}) | ` +
        `ETA: ${etaHours}h ${etaMin}m`,
    );
  }, 30_000);

  await Promise.all(workerPromises);
  clearInterval(etaReporter);

  // Final summary
  coordinator.shutdown();
  const s = coordinator.stats();
  const captchaCost = totalCaptchaSolves * CAPTCHA_COST_PER_SOLVE;
  const avgSearchesPerCaptcha =
    totalCaptchaSolves > 0 ? (s.completed / totalCaptchaSolves).toFixed(1) : 'N/A';
  log('');
  log(`=== Scraping Complete ===`);
  log(`Searches completed: ${s.completed}`);
  log(`Total orders found: ${s.orders}`);
  log(`Total PDFs downloaded: ${s.pdfs}`);
  log(`--- Captcha Cost Report (${CAPTCHA_SERVICE}) ---`);
  log(`Total captcha solves: ${totalCaptchaSolves}`);
  log(`Avg searches per captcha: ${avgSearchesPerCaptcha}`);
  log(`Cost per solve: $${CAPTCHA_COST_PER_SOLVE}`);
  log(`Total captcha cost: $${captchaCost.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Download-only mode
// ---------------------------------------------------------------------------

async function downloadFromMetadata(benches: string[], progress: Progress): Promise<void> {
  log('Download-only mode: reading existing metadata...');

  const jsonlFile = path.join(DATA_DIR, 'itat-orders.jsonl');
  if (!fs.existsSync(jsonlFile)) {
    logError('No metadata file found. Run scraper first.');
    return;
  }

  const lines = fs.readFileSync(jsonlFile, 'utf-8').split('\n').filter(Boolean);
  const orders: OrderMetadata[] = lines.map((l) => JSON.parse(l));

  const filteredOrders =
    benches.length === BENCHES.length ? orders : orders.filter((o) => benches.includes(o.bench));

  const withPdf = filteredOrders.filter((o) => o.pdf_url);
  log(`Found ${withPdf.length} orders with PDF URLs`);

  for (const bench of [...new Set(withPdf.map((o) => o.bench))]) {
    const benchDir = path.join(PDFS_DIR, sanitizeFilename(bench));
    fs.mkdirSync(benchDir, { recursive: true });

    const benchOrders = withPdf.filter((o) => o.bench === bench);
    log(`Downloading ${benchOrders.length} PDFs for ${bench}...`);

    const downloaded = await downloadPdfsBatch(benchOrders, benchDir);
    progress.total_pdfs_downloaded += downloaded;
    saveProgress(progress);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');
  const resume = args.includes('--resume');

  // Validate CAPTCHA API key
  if (!downloadOnly && !CAPTCHA_API_KEY) {
    console.error('Error: CAPTCHA_API_KEY environment variable is required.');
    console.error(`Service: ${CAPTCHA_SERVICE}`);
    console.error(
      CAPTCHA_SERVICE === 'capsolver'
        ? 'Get one at https://capsolver.com/ (starts with CAP- or CAI-)'
        : 'Get one at https://2captcha.com/',
    );
    console.error('');
    console.error('Usage: CAPTCHA_API_KEY=xxx npx tsx scripts/itat-scraper.ts');
    process.exit(1);
  }

  log(`Captcha service: ${CAPTCHA_SERVICE} ($${CAPTCHA_COST_PER_SOLVE}/solve)`);
  log(`Proxy: ${PROXY_URL ? 'ENABLED (Oxylabs)' : 'DISABLED (direct)'}`);
  log(`Keep-alive: ENABLED`);

  // Parse bench filter
  const benchFilter = process.env.BENCH;
  const benches = benchFilter
    ? BENCHES.filter((b) => b.toLowerCase() === benchFilter.toLowerCase())
    : testMode
      ? ['Delhi'] // Test mode: single bench
      : BENCHES;

  if (benchFilter && benches.length === 0) {
    console.error(`Error: Unknown bench "${benchFilter}"`);
    console.error(`Available: ${BENCHES.join(', ')}`);
    process.exit(1);
  }

  // Parse date range
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const defaultStart = new Date(2025, 0, 1); // Jan 1 2025
  const startDate = process.env.START_DATE
    ? parseDate(process.env.START_DATE)
    : testMode
      ? new Date(yesterday.getTime() - 7 * 24 * 60 * 60 * 1000) // Last week for test
      : defaultStart;

  const endDate = process.env.END_DATE ? parseDate(process.env.END_DATE) : yesterday;

  await scrapeITAT({
    benches,
    startDate,
    endDate,
    metadataOnly,
    downloadOnly,
    testMode,
    resume,
    args,
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
