/**
 * NGT Scraper - National Green Tribunal
 * Scrapes orders/judgments from https://www.greentribunal.gov.in
 *
 * CAPTCHA OPTIMIZATION (following ITAT pattern):
 *   1. REUSE: Solve ONE captcha per session, reuse for ALL paginated results + case details
 *   2. SERVICE: 2captcha ($0.003/solve, ~100% accuracy) or CapSolver ($0.0004/solve)
 *   3. SESSION PERSISTENCE: One captcha unlocks entire session (~15min window)
 *      - Paginate through all search results (no new captcha per page)
 *      - Visit case detail pages (no new captcha)
 *      - Download PDFs via gen_pdf_test.php (no auth at all)
 *
 * Strategy: Search by zone (1-5) × monthly date ranges (2010-2026)
 *   Phase 1: Collect case metadata from search results
 *   Phase 2: Visit each case detail page to extract order PDF paths
 *   Phase 3: Download PDFs via gen_pdf_test.php (zero auth, high concurrency)
 *
 * Volume Estimate (final orders/judgments only):
 *   ~75,000 total cases since 2010 → ~50,000-60,000 with final orders
 *   Each case: 1 final order + N interim orders. We collect ALL, tag type in metadata.
 *   Captcha cost: ~900 solves (5 zones × 15 years × 12 months) = ~$2.70 with 2captcha
 *
 * Usage:
 *   # Full run
 *   CAPTCHA_API_KEY=xxx npx tsx scripts/ngt-scraper.ts
 *
 *   # Single zone
 *   ZONE=1 CAPTCHA_API_KEY=xxx npx tsx scripts/ngt-scraper.ts
 *
 *   # Date range
 *   START_YEAR=2024 END_YEAR=2025 CAPTCHA_API_KEY=xxx npx tsx scripts/ngt-scraper.ts
 *
 *   # Test mode (1 zone, 1 month, no PDF download)
 *   CAPTCHA_API_KEY=xxx npx tsx scripts/ngt-scraper.ts --test
 *
 *   # Metadata only (no case details or PDF downloads)
 *   CAPTCHA_API_KEY=xxx npx tsx scripts/ngt-scraper.ts --metadata-only
 *
 *   # Case details only (requires metadata)
 *   CAPTCHA_API_KEY=xxx npx tsx scripts/ngt-scraper.ts --details-only
 *
 *   # Download PDFs only (requires case details)
 *   npx tsx scripts/ngt-scraper.ts --download-only
 *
 * Environment:
 *   CAPTCHA_API_KEY  - 2captcha or CapSolver key
 *   CAPTCHA_SERVICE  - "2captcha" (default) or "capsolver"
 *   WORKERS          - Concurrent workers (default: 5)
 *   ZONE             - Single zone 1-5 (default: all)
 *   START_YEAR       - Start year (default: 2025)
 *   END_YEAR         - End year (default: 2010)
 *   PDF_CONCURRENCY  - Max concurrent PDF downloads (default: 20)
 *   DELAY_MS         - Delay between searches in ms (default: 500)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Solver } from '2captcha-ts';
import PQueue from 'p-queue';
import { HttpsProxyAgent } from 'https-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ──────────────────────────────────────────────────────────────────

// Gov.in sites have incomplete SSL chains — disable TLS verification globally
// (already done per-agent with rejectUnauthorized: false, but proxy tunnels need this too)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE_URL = 'https://www.greentribunal.gov.in';
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/ngt');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const DETAILS_DIR = path.join(DATA_DIR, 'case-details');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const COMBINED_JSONL = path.join(DATA_DIR, 'ngt-all-orders.jsonl');
const LOG_FILE = path.join(DATA_DIR, 'scraper.log');

const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || '';
const CAPTCHA_SERVICE = (process.env.CAPTCHA_SERVICE || '2captcha').toLowerCase();

// Proxy config — Oxylabs residential with sticky sessions per worker
const PROXY_ENABLED = process.env.USE_PROXY === 'true' || !!process.env.OXYLABS_USER;
const OXYLABS_USER = process.env.OXYLABS_USER || '';
const OXYLABS_PASS = process.env.OXYLABS_PASS || '';

// With proxy: more workers + less delay (different IPs avoid rate limits)
const DEFAULT_WORKERS = PROXY_ENABLED ? 10 : 5;
const DEFAULT_DELAY = PROXY_ENABLED ? 200 : 500;
const NUM_WORKERS = parseInt(process.env.WORKERS || String(DEFAULT_WORKERS), 10);
const PDF_CONCURRENCY = parseInt(process.env.PDF_CONCURRENCY || '30', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || String(DEFAULT_DELAY), 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const SESSION_REFRESH_INTERVAL_MS = 13 * 60 * 1000; // 13 min (be safe before 15min expiry)

const CAPTCHA_PRICING: Record<string, number> = {
  capsolver: 0.0004,
  '2captcha': 0.003,
};
const CAPTCHA_COST_PER_SOLVE = CAPTCHA_PRICING[CAPTCHA_SERVICE] || 0.003;
const CAPSOLVER_API_URL = 'https://api.capsolver.com';

let totalCaptchaSolves = 0;

// ─── Zones ───────────────────────────────────────────────────────────────────

interface ZoneConfig {
  id: number;
  name: string;
  slug: string;
  location: string;
}

const ZONES: ZoneConfig[] = [
  { id: 1, name: 'Principal Bench', slug: 'delhi', location: 'New Delhi' },
  { id: 2, name: 'Eastern Zonal Bench', slug: 'kolkata', location: 'Kolkata' },
  { id: 3, name: 'Central Zonal Bench', slug: 'bhopal', location: 'Bhopal' },
  { id: 4, name: 'Western Zonal Bench', slug: 'pune', location: 'Pune' },
  { id: 5, name: 'Southern Zonal Bench', slug: 'chennai', location: 'Chennai' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface CaseRecord {
  diary_number: string;
  case_number: string;
  parties: string;
  petitioner: string;
  respondent: string;
  order_date: string;
  upload_date: string;
  status: string;
  zone_id: number;
  zone_name: string;
  bench: string;
  case_detail_url: string;
  case_id: string;
  scraped_at: string;
}

interface OrderRecord {
  case_id: string;
  case_number: string;
  zone_id: number;
  zone_name: string;
  bench: string;
  order_date: string;
  order_type: string; // "Order" or "Judgement"
  pdf_base64_path: string;
  pdf_download_url: string;
  pdf_filename: string;
  petitioner: string;
  respondent: string;
  tribunal: string;
  country: string;
  scraped_at: string;
}

interface SessionState {
  cookies: string;
  captchaText: string;
  createdAt: number;
  searchCount: number;
}

interface Progress {
  metadata: {
    completed: string[]; // "zone_1_2025_01" keys
    total_cases: number;
  };
  details: {
    completed: string[]; // case_id keys
    total_orders: number;
  };
  pdfs: {
    downloaded: number;
    failed: number;
    skipped: number;
  };
  last_updated: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write directly to log file (unbuffered) + stderr for real-time monitoring via `tail -f` */
let _logFd: number | null = null;
function getLogFd(): number {
  if (_logFd === null) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _logFd = fs.openSync(LOG_FILE, 'a');
  }
  return _logFd;
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}\n`;
  fs.writeSync(getLogFd(), line);
  process.stderr.write(line);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ERROR: ${msg}\n`;
  fs.writeSync(getLogFd(), line);
  process.stderr.write(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, DETAILS_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const zone of ZONES) {
    fs.mkdirSync(path.join(PDFS_DIR, zone.slug), { recursive: true });
  }
}

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    metadata: { completed: [], total_cases: 0 },
    details: { completed: [], total_orders: 0 },
    pdfs: { downloaded: 0, failed: 0, skipped: 0 },
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 200);
}

// Shared HTTPS agent (rejectUnauthorized: false for gov.in SSL) — used when no proxy
let _httpsAgent: import('https').Agent | null = null;
async function getHttpsAgent(): Promise<import('https').Agent> {
  if (!_httpsAgent) {
    const https = await import('https');
    _httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  }
  return _httpsAgent;
}

// Per-worker proxy agents with sticky Oxylabs sessions
// Each worker gets a unique sessid → same IP for entire Drupal session
const _workerAgents = new Map<number, HttpsProxyAgent<string>>();

function createOxylabsAgent(workerId: number): HttpsProxyAgent<string> {
  // Sticky session: same sessid = same IP for this worker
  const sessId = `ngt_w${workerId}_${Date.now()}`;
  const proxyUrl = `http://customer-${OXYLABS_USER}-cc-IN-sessid-${sessId}:${OXYLABS_PASS}@pr.oxylabs.io:7777`;
  // rejectUnauthorized must be false for gov.in SSL (self-signed/incomplete chain)
  // tls options are passed through to the tunneled HTTPS connection
  return new HttpsProxyAgent(proxyUrl, {
    rejectUnauthorized: false,
    requestTls: { rejectUnauthorized: false },
  } as any);
}

function getWorkerAgent(workerId: number): HttpsProxyAgent<string> {
  if (!_workerAgents.has(workerId)) {
    _workerAgents.set(workerId, createOxylabsAgent(workerId));
  }
  return _workerAgents.get(workerId)!;
}

/** Rotate proxy IP for a worker (new sticky session) */
function rotateWorkerProxy(workerId: number): void {
  _workerAgents.set(workerId, createOxylabsAgent(workerId));
}

/** Get the right agent for a worker — proxy if enabled, otherwise shared HTTPS */
async function getAgentForWorker(
  workerId: number,
): Promise<import('https').Agent | HttpsProxyAgent<string>> {
  if (PROXY_ENABLED && OXYLABS_USER) {
    return getWorkerAgent(workerId);
  }
  return getHttpsAgent();
}

// ─── Session Management ─────────────────────────────────────────────────────

/**
 * Create a new session by fetching captcha.php — this is what creates the
 * Drupal session (SSESS cookie). The search page itself does NOT set cookies.
 */
async function createSession(workerId: number = 0, maxRetries: number = 5): Promise<SessionState> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log('Creating new session via captcha.php...');

      // Rotate proxy IP on each new session so Drupal session is bound to fresh IP
      if (PROXY_ENABLED && OXYLABS_USER) {
        rotateWorkerProxy(workerId);
      }
      const agent = await getAgentForWorker(workerId);

      // Step 1: Fetch captcha.php — this creates the Drupal session and sets SSESS cookie
      const captchaResp = await axios.get(
        `${BASE_URL}/sites/all/modules/custom/case_status/captcha.php`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          responseType: 'arraybuffer',
          timeout: 15000,
          httpsAgent: agent,
        },
      );

      // Extract SSESS cookie from captcha.php response
      const setCookies = captchaResp.headers['set-cookie'] || [];
      const cookieArr = Array.isArray(setCookies) ? setCookies : [setCookies];
      const cookieParts = cookieArr
        .filter((c: string) => c && c.length > 0)
        .map((c: string) => c.split(';')[0].trim());
      const cookieStr = cookieParts.join('; ');

      if (!cookieStr.includes('SSESS')) {
        throw new Error(`No SSESS cookie from captcha.php. Got: ${cookieStr.slice(0, 100)}`);
      }

      // Store the captcha image from this same request (avoid fetching twice)
      const captchaBase64 = Buffer.from(captchaResp.data).toString('base64');

      log(`Session created: ${cookieStr.slice(0, 70)}...`);

      return {
        cookies: cookieStr,
        captchaText: '',
        createdAt: Date.now(),
        searchCount: 0,
        _pendingCaptchaBase64: captchaBase64, // will be consumed by solveCaptchaForSession
      } as SessionState & { _pendingCaptchaBase64: string };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as any)?.response?.status || (err as any)?.status;
      logError(
        `createSession attempt ${attempt}/${maxRetries}: ${status || ''} ${msg.slice(0, 120)}`,
      );
      if (attempt < maxRetries) {
        const backoff = attempt * 5000; // 5s, 10s, 15s, 20s, 25s
        log(`  Retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
      } else {
        throw new Error(`createSession failed after ${maxRetries} attempts: ${msg.slice(0, 200)}`);
      }
    }
  }
  throw new Error('createSession: unreachable');
}

function isSessionExpired(session: SessionState): boolean {
  return Date.now() - session.createdAt > SESSION_REFRESH_INTERVAL_MS;
}

// ─── CAPTCHA Solver ─────────────────────────────────────────────────────────

async function fetchCaptchaImage(session: SessionState, workerId: number = 0): Promise<string> {
  // If session was just created, use the captcha image from createSession()
  const pending = (session as any)._pendingCaptchaBase64;
  if (pending) {
    delete (session as any)._pendingCaptchaBase64;
    return pending;
  }

  const agent = await getAgentForWorker(workerId);
  const captchaResp = await axios.get(
    `${BASE_URL}/sites/all/modules/custom/case_status/captcha.php`,
    {
      headers: {
        Cookie: session.cookies,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      httpsAgent: agent,
    },
  );

  // Update cookies if new ones are set (session refresh)
  const setCookies = captchaResp.headers['set-cookie'] || [];
  const cookieArr = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const c of cookieArr) {
    if (c && c.includes('SSESS')) {
      session.cookies = c.split(';')[0].trim();
    }
  }

  return Buffer.from(captchaResp.data).toString('base64');
}

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
        websiteURL: `${BASE_URL}/judgementOrder/zonalbenchwise`,
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

  log(`CAPTCHA solved via CapSolver: ${text}`);
  return text;
}

async function solveWith2Captcha(base64Image: string, solver: Solver): Promise<string> {
  log(`Sending CAPTCHA to 2captcha ($${CAPTCHA_COST_PER_SOLVE}/solve)...`);

  const result = await solver.imageCaptcha({
    body: base64Image,
    numeric: 0,
    caseSensitive: 0,
    lang: 'en',
  });

  log(`CAPTCHA solved via 2captcha: ${result.data} (id: ${result.id})`);
  return result.data;
}

async function solveCaptcha(
  session: SessionState,
  solver: Solver | null,
  workerId: number = 0,
): Promise<string> {
  const base64Image = await fetchCaptchaImage(session, workerId);

  if (CAPTCHA_SERVICE === 'capsolver') {
    return solveWithCapSolver(base64Image);
  } else {
    if (!solver) throw new Error('2captcha solver not initialized');
    return solveWith2Captcha(base64Image, solver);
  }
}

/**
 * Solve and validate captcha for session. The solved text is stored in
 * session.captchaText and reused for ALL subsequent search queries
 * within the session window (~13min).
 *
 * NGT validation: We don't have a separate validation endpoint like ITAT.
 * Instead, we validate by making a test search and checking if results come back
 * or if we get "Captcha is incorrect or missing".
 */
async function solveCaptchaForSession(
  session: SessionState,
  solver: Solver | null,
  maxAttempts = 5,
  logPrefix = '',
  workerId: number = 0,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const captchaText = await solveCaptcha(session, solver, workerId);

      // Validate by making a small test search (Principal Bench, recent month)
      const now = new Date();
      const testFrom = `01/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
      const testTo = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

      const testUrl =
        `${BASE_URL}/judgementOrder/zonalBenchData` +
        `?zone_type=1&from_date=${testFrom}&to_date=${testTo}` +
        `&order_by=1&captcha_input=${encodeURIComponent(captchaText)}`;

      const testResp = await axios.get(testUrl, {
        headers: {
          Cookie: session.cookies,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Referer: `${BASE_URL}/judgementOrder/zonalbenchwise`,
        },
        timeout: 30000,
        httpsAgent: await getAgentForWorker(workerId),
      });

      const body =
        typeof testResp.data === 'string' ? testResp.data : JSON.stringify(testResp.data);

      if (
        body.includes('Captcha is incorrect') ||
        body.includes('captcha is incorrect') ||
        body.length < 200
      ) {
        log(
          `${logPrefix}CAPTCHA validation failed (attempt ${attempt + 1}/${maxAttempts}), retrying...`,
        );
        await sleep(2000);
        continue;
      }

      // Success
      session.captchaText = captchaText;
      session.searchCount = 1; // Already used one search for validation
      totalCaptchaSolves++;
      log(
        `${logPrefix}CAPTCHA solved & validated: "${captchaText}" (total solves: ${totalCaptchaSolves}, cost: $${(totalCaptchaSolves * CAPTCHA_COST_PER_SOLVE).toFixed(3)})`,
      );
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${logPrefix}CAPTCHA solve error (attempt ${attempt + 1}/${maxAttempts}): ${msg}`);
      await sleep(3000);
    }
  }
  throw new Error(`Failed to solve CAPTCHA after ${maxAttempts} attempts`);
}

// ─── Search Orders ──────────────────────────────────────────────────────────

interface SearchPage {
  cases: CaseRecord[];
  totalPages: number;
  currentPage: number;
  totalResults: number;
}

async function searchOrders(
  session: SessionState,
  zoneId: number,
  fromDate: string,
  toDate: string,
  page: number = 0,
  workerId: number = 0,
): Promise<SearchPage> {
  const url =
    `${BASE_URL}/judgementOrder/zonalBenchData` +
    `?zone_type=${zoneId}&from_date=${fromDate}&to_date=${toDate}` +
    `&order_by=1&captcha_input=${encodeURIComponent(session.captchaText)}` +
    (page > 0 ? `&page=${page}` : '');

  const resp = await axios.get(url, {
    headers: {
      Cookie: session.cookies,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Referer: `${BASE_URL}/judgementOrder/zonalbenchwise`,
    },
    timeout: 60000,
    httpsAgent: await getAgentForWorker(workerId),
  });

  session.searchCount++;

  const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);

  // Check for captcha rejection
  if (body.includes('Captcha is incorrect') || body.includes('captcha is incorrect')) {
    throw new Error('CAPTCHA_REJECTED');
  }

  return parseSearchResults(body, zoneId);
}

function parseSearchResults(html: string, zoneId: number): SearchPage {
  const $ = cheerio.load(html);
  const cases: CaseRecord[] = [];
  const zone = ZONES.find((z) => z.id === zoneId)!;

  // Parse the results table
  const rows = $('table tbody tr');

  rows.each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;

    // NGT search results columns:
    // 0: S.No
    // 1: Diary No.
    // 2: Case No. (link to case details)
    // 3: Parties (Petitioner vs Respondent)
    // 4: Order Date
    // 5: Upload Date
    // 6: Status

    const serialNo = $(cells[0]).text().trim();
    const diaryNo = $(cells[1]).text().trim();

    // Extract case link and number
    const caseLink = $(cells[2]).find('a');
    const caseNumber = caseLink.text().trim() || $(cells[2]).text().trim();
    const caseHref = caseLink.attr('href') || '';

    // Extract case ID from URL: /caseDetails/{ZONE}/{CASE_ID}
    const caseIdMatch = caseHref.match(/\/caseDetails\/([^\/]+)\/([^\/\?]+)/);
    const caseId = caseIdMatch ? caseIdMatch[2] : '';
    const caseZone = caseIdMatch ? caseIdMatch[1] : '';

    // Parse parties
    const partiesHtml = $(cells[3]).html() || '';
    const partiesText = $(cells[3]).text().trim();
    const partiesSplit = partiesHtml.split(/<br\s*\/?>\s*(?:vs\.?|VS\.?|Vs\.?)\s*<br\s*\/?>/i);
    const petitioner = partiesSplit[0] ? cheerio.load(partiesSplit[0]).text().trim() : partiesText;
    const respondent = partiesSplit[1] ? cheerio.load(partiesSplit[1]).text().trim() : '';

    const orderDate = $(cells[4]).text().trim();
    const uploadDate = cells.length > 5 ? $(cells[5]).text().trim() : '';
    const status = cells.length > 6 ? $(cells[6]).text().trim() : '';

    if (!caseNumber && !diaryNo) return;

    cases.push({
      diary_number: diaryNo,
      case_number: caseNumber,
      parties: partiesText,
      petitioner,
      respondent,
      order_date: orderDate,
      upload_date: uploadDate,
      status,
      zone_id: zoneId,
      zone_name: zone.name,
      bench: zone.slug,
      case_detail_url: caseHref
        ? caseHref.startsWith('http')
          ? caseHref
          : `${BASE_URL}${caseHref}`
        : '',
      case_id: caseId,
      scraped_at: new Date().toISOString(),
    });
  });

  // Parse pagination
  const pagerLinks = $('.pager li a, .pagination li a, ul.pager a');
  let totalPages = 1;
  let currentPage = 0;

  // Find the "last" page link or highest page number
  pagerLinks.each((_, link) => {
    const href = $(link).attr('href') || '';
    const pageMatch = href.match(/[?&]page=(\d+)/);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1], 10);
      if (pageNum + 1 > totalPages) {
        totalPages = pageNum + 1;
      }
    }
  });

  // Check for "last" link specifically
  const lastLink = $('.pager-last a, .pager li.last a').attr('href') || '';
  const lastPageMatch = lastLink.match(/[?&]page=(\d+)/);
  if (lastPageMatch) {
    totalPages = parseInt(lastPageMatch[1], 10) + 1;
  }

  // Current page from active pager item
  const activeItem = $('.pager-current, .pager li.active').text().trim();
  if (activeItem) {
    const activeNum = parseInt(activeItem, 10);
    if (!isNaN(activeNum)) {
      currentPage = activeNum - 1;
    }
  }

  return {
    cases,
    totalPages,
    currentPage,
    totalResults: cases.length, // Per page; total count not always available from HTML
  };
}

// ─── Case Detail Extraction ─────────────────────────────────────────────────

async function fetchCaseDetails(
  session: SessionState,
  caseRecord: CaseRecord,
  workerId: number = 0,
): Promise<OrderRecord[]> {
  // Build URL — case_detail_url may already have ?page=order
  let url: string;
  if (caseRecord.case_detail_url) {
    url = caseRecord.case_detail_url.includes('?page=order')
      ? caseRecord.case_detail_url
      : `${caseRecord.case_detail_url}?page=order`;
  } else {
    url = `${BASE_URL}/caseDetails/${caseRecord.zone_id}/${caseRecord.case_id}?page=order`;
  }

  const resp = await axios.get(url, {
    headers: {
      Cookie: session.cookies,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      Referer: `${BASE_URL}/judgementOrder/zonalbenchwise`,
    },
    timeout: 25000,
    httpsAgent: await getAgentForWorker(workerId),
  });

  const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);

  if (body.includes('Captcha is incorrect') || body.length < 200) {
    throw new Error('CAPTCHA_REJECTED');
  }

  return parseCaseDetailOrders(body, caseRecord);
}

function parseCaseDetailOrders(html: string, caseRecord: CaseRecord): OrderRecord[] {
  const orders: OrderRecord[] = [];
  const zone = ZONES.find((z) => z.id === caseRecord.zone_id)!;

  // Extract base64 PDF paths from myFunctionTest('...') calls
  const pdfPattern = /myFunctionTest\s*\(\s*'([^']+)'\s*\)/g;
  let match: RegExpExecArray | null;

  // Also parse the orders table for dates and types
  const $ = cheerio.load(html);
  const orderRows = $('table tbody tr');

  // Build a list of order info from the table
  interface OrderInfo {
    orderDate: string;
    orderType: string;
    base64Path: string;
  }
  const orderInfos: OrderInfo[] = [];

  orderRows.each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    // Typical columns: S.No, Order Date, Order/Judgement, Download
    const orderDate = $(cells[1]).text().trim();
    const orderType = $(cells[2]).text().trim(); // "Order" or "Judgement"

    // Extract base64 path from the download link/button
    const cellHtml = $(cells[cells.length - 1]).html() || '';
    const pathMatch = cellHtml.match(/myFunctionTest\s*\(\s*'([^']+)'\s*\)/);
    const base64Path = pathMatch ? pathMatch[1] : '';

    if (base64Path) {
      orderInfos.push({ orderDate, orderType, base64Path });
    }
  });

  // If table parsing didn't find paths, try regex on full HTML
  if (orderInfos.length === 0) {
    while ((match = pdfPattern.exec(html)) !== null) {
      orderInfos.push({
        orderDate: caseRecord.order_date,
        orderType: 'Order',
        base64Path: match[1],
      });
    }
  }

  for (const info of orderInfos) {
    const pdfUrl = `${BASE_URL}/gen_pdf_test.php?filepath=${encodeURIComponent(info.base64Path)}`;

    // Decode base64 to get a readable filename hint
    let decodedPath = '';
    try {
      decodedPath = Buffer.from(info.base64Path, 'base64').toString('utf-8');
    } catch {
      // Ignore decode errors
    }

    // Generate filename: zone_caseId_orderDate_index.pdf
    const dateSlug = info.orderDate.replace(/\//g, '-');
    const orderIndex = orderInfos.indexOf(info);
    const pdfFilename = `ngt_${zone.slug}_${caseRecord.case_id}_${dateSlug}_${orderIndex}.pdf`;

    orders.push({
      case_id: caseRecord.case_id,
      case_number: caseRecord.case_number,
      zone_id: caseRecord.zone_id,
      zone_name: zone.name,
      bench: zone.slug,
      order_date: info.orderDate,
      order_type: info.orderType || 'Order',
      pdf_base64_path: info.base64Path,
      pdf_download_url: pdfUrl,
      pdf_filename: pdfFilename,
      petitioner: caseRecord.petitioner,
      respondent: caseRecord.respondent,
      tribunal: 'NGT',
      country: 'IN',
      scraped_at: new Date().toISOString(),
    });
  }

  return orders;
}

// ─── Work Queue ─────────────────────────────────────────────────────────────

interface MetadataWorkItem {
  zoneId: number;
  zoneName: string;
  zoneSlug: string;
  year: number;
  month: number;
  key: string; // "zone_1_2025_01"
}

class WorkQueue<T> {
  private items: T[];
  private idx = 0;
  private retryItems: T[] = [];
  readonly total: number;

  constructor(items: T[]) {
    this.items = items;
    this.total = items.length;
  }

  next(): T | null {
    if (this.retryItems.length > 0) {
      return this.retryItems.shift()!;
    }
    if (this.idx >= this.items.length) return null;
    return this.items[this.idx++];
  }

  retry(item: T): void {
    this.retryItems.push(item);
  }

  processed(): number {
    return this.idx;
  }

  pending(): number {
    return this.items.length - this.idx + this.retryItems.length;
  }
}

// ─── Phase 1: Metadata Collection (Workers) ─────────────────────────────────

async function metadataWorker(
  workerId: number,
  queue: WorkQueue<MetadataWorkItem>,
  progress: Progress,
  solver: Solver | null,
  progressMutex: { dirty: boolean },
): Promise<CaseRecord[]> {
  const allCases: CaseRecord[] = [];
  let session: SessionState | null = null;
  let consecutiveFails = 0;

  const wlog = (msg: string) => log(`[W${workerId}] ${msg}`);
  const wlogErr = (msg: string) => logError(`[W${workerId}] ${msg}`);

  const refreshSession = async (): Promise<SessionState> => {
    for (let i = 0; i < 5; i++) {
      try {
        const s = await createSession(workerId);
        await solveCaptchaForSession(s, solver, 5, `[W${workerId}] `, workerId);
        wlog(`Session ready (captcha="${s.captchaText}", searches=${s.searchCount})`);
        return s;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        wlogErr(`Session create failed (attempt ${i + 1}): ${msg}`);
        await sleep(5000 * (i + 1));
      }
    }
    throw new Error('Failed to create session after 5 attempts');
  };

  // Stagger worker startup
  await sleep(workerId * 2000);
  session = await refreshSession();

  while (true) {
    const item = queue.next();
    if (!item) break;

    // Skip completed
    if (progress.metadata.completed.includes(item.key)) continue;

    // Refresh session if expired
    if (!session || isSessionExpired(session)) {
      wlog('Session expired, refreshing...');
      session = await refreshSession();
    }

    const fromDate = `01/${String(item.month).padStart(2, '0')}/${item.year}`;
    const lastDay = new Date(item.year, item.month, 0).getDate();
    const toDate = `${lastDay}/${String(item.month).padStart(2, '0')}/${item.year}`;

    wlog(
      `[${queue.processed()}/${queue.total}] Zone ${item.zoneId} (${item.zoneSlug}) | ${item.year}-${String(item.month).padStart(2, '0')} | captchas: ${totalCaptchaSolves}`,
    );

    try {
      // Fetch first page
      const firstPage = await searchOrders(session, item.zoneId, fromDate, toDate, 0, workerId);

      const monthCases: CaseRecord[] = [...firstPage.cases];

      // Paginate through remaining pages
      if (firstPage.totalPages > 1) {
        wlog(`  ${firstPage.cases.length} cases on page 1/${firstPage.totalPages}`);

        let consecutiveErrors = 0;
        for (let page = 1; page < firstPage.totalPages; page++) {
          await sleep(DELAY_MS);

          try {
            const nextPage = await searchOrders(
              session,
              item.zoneId,
              fromDate,
              toDate,
              page,
              workerId,
            );
            monthCases.push(...nextPage.cases);
            consecutiveErrors = 0;

            // Log every 10 pages or last page
            if ((page + 1) % 10 === 0 || page === firstPage.totalPages - 1) {
              wlog(
                `  page ${page + 1}/${firstPage.totalPages} (${monthCases.length} cases so far)`,
              );
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'CAPTCHA_REJECTED') {
              wlog('  Captcha rejected during pagination, re-solving...');
              await solveCaptchaForSession(session, solver, 3, `[W${workerId}] `, workerId);
              // Retry this page
              page--;
              continue;
            }
            consecutiveErrors++;
            wlogErr(`  Page ${page + 1}/${firstPage.totalPages} failed: ${msg}`);
            // If too many consecutive errors, likely session dead — break
            if (consecutiveErrors >= 5) {
              wlogErr(
                `  5 consecutive page errors, stopping pagination (got ${monthCases.length} cases)`,
              );
              break;
            }
            // Retry with backoff on network errors
            if (
              msg.includes('socket hang up') ||
              msg.includes('ECONNRESET') ||
              msg.includes('timeout')
            ) {
              await sleep(2000);
              page--; // Retry
              continue;
            }
          }
        }
      }

      wlog(
        `  Total: ${monthCases.length} cases for ${item.zoneSlug} ${item.year}-${String(item.month).padStart(2, '0')}`,
      );

      allCases.push(...monthCases);

      // Save per-month metadata
      const metaFile = path.join(METADATA_DIR, `ngt-${item.key}.jsonl`);
      const lines = monthCases.map((c) => JSON.stringify(c)).join('\n');
      if (lines) {
        fs.writeFileSync(metaFile, lines + '\n');
      }

      // Update progress
      progress.metadata.completed.push(item.key);
      progress.metadata.total_cases += monthCases.length;
      progressMutex.dirty = true;

      consecutiveFails = 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      if (msg === 'CAPTCHA_REJECTED') {
        wlog('Captcha rejected, re-solving...');
        try {
          await solveCaptchaForSession(session, solver, 3, `[W${workerId}] `, workerId);
          // Re-queue this item
          queue.retry(item);
        } catch {
          wlogErr('Captcha re-solve failed, refreshing session...');
          session = await refreshSession();
          queue.retry(item);
        }
        continue;
      }

      wlogErr(`${item.key}: ${msg}`);
      consecutiveFails++;

      if (consecutiveFails >= 10) {
        wlogErr('Too many consecutive failures, worker shutting down.');
        break;
      }

      // Refresh session on error
      try {
        session = await refreshSession();
      } catch {
        wlogErr('Cannot recover session, worker shutting down.');
        break;
      }
    }

    await sleep(DELAY_MS);
  }

  wlog(`Finished. ${allCases.length} cases found. (captcha solves: ${totalCaptchaSolves})`);
  return allCases;
}

// ─── Phase 2: Case Details (extract order PDF paths) ────────────────────────

async function collectCaseDetails(
  cases: CaseRecord[],
  progress: Progress,
  solver: Solver | null,
): Promise<OrderRecord[]> {
  log('\n═══ PHASE 2: CASE DETAIL EXTRACTION ═══');

  const allOrders: OrderRecord[] = [];
  const completedSet = new Set(progress.details.completed);

  // Deduplicate cases by case_id and filter already-completed
  const seenIds = new Set<string>();
  const pending: CaseRecord[] = [];
  for (const c of cases) {
    if (c.case_id && !completedSet.has(c.case_id) && !seenIds.has(c.case_id)) {
      seenIds.add(c.case_id);
      pending.push(c);
    }
  }
  const uniqueTotal = new Set(cases.filter((c) => c.case_id).map((c) => c.case_id)).size;
  log(
    `  Total records: ${cases.length}, Unique cases: ${uniqueTotal}, Already done: ${completedSet.size}, Pending: ${pending.length}`,
  );

  if (pending.length === 0) {
    log('  Nothing to do.');
    return allOrders;
  }

  // ETA tracking
  const phase2StartTime = Date.now();
  const phase2StartDone = completedSet.size;

  // Use workers for case detail extraction too
  const numWorkers = Math.min(NUM_WORKERS, pending.length);
  const chunkSize = Math.ceil(pending.length / numWorkers);
  const chunks: CaseRecord[][] = [];

  for (let i = 0; i < pending.length; i += chunkSize) {
    chunks.push(pending.slice(i, i + chunkSize));
  }

  const workerResults = await Promise.all(
    chunks.map(async (chunk, idx) => {
      const wlog = (msg: string) => log(`[DW${idx}] ${msg}`);
      const orders: OrderRecord[] = [];

      // Stagger worker starts
      if (idx > 0) {
        await sleep(idx * 2000);
      }

      // Initial session setup — retry up to 5 times (never crash on startup)
      let session: SessionState | null = null;
      for (let startAttempt = 1; startAttempt <= 5; startAttempt++) {
        try {
          session = await createSession(idx);
          await solveCaptchaForSession(session, solver, 5, `[DW${idx}] `, idx);
          break;
        } catch (startErr) {
          wlog(
            `Initial session attempt ${startAttempt}/5 failed: ${(startErr as Error).message?.slice(0, 80)}`,
          );
          if (startAttempt < 5) await sleep(10000 * startAttempt);
        }
      }
      if (!session || !session.captchaText) {
        wlog('Cannot establish initial session after 5 attempts. Worker exiting.');
        return orders;
      }

      let consecutiveErrors = 0;
      let proxyRotations = 0; // Track how many times we've rotated proxy for this worker

      for (let i = 0; i < chunk.length; i++) {
        const caseRec = chunk[i];

        if (completedSet.has(caseRec.case_id)) continue;

        // Refresh session if expired — retry up to 3 times (never crash the worker)
        if (isSessionExpired(session)) {
          wlog('Session expired, refreshing...');
          let refreshed = false;
          for (let attempt = 1; attempt <= 3 && !refreshed; attempt++) {
            try {
              session = await createSession(idx);
              await solveCaptchaForSession(session, solver, 5, `[DW${idx}] `, idx);
              consecutiveErrors = 0;
              refreshed = true;
            } catch (refreshErr) {
              wlog(
                `  Session refresh attempt ${attempt}/3 failed: ${(refreshErr as Error).message?.slice(0, 80)}`,
              );
              if (attempt < 3) await sleep(10000 * attempt);
            }
          }
          if (!refreshed) {
            wlog('  All session refresh attempts failed — backing off 60s then retrying...');
            await sleep(60000);
            try {
              session = await createSession(idx);
              await solveCaptchaForSession(session, solver, 5, `[DW${idx}] `, idx);
            } catch {
              wlog('  FATAL: Cannot create session. Worker stopping gracefully.');
              break; // Exit this worker's loop without crashing Promise.all
            }
          }
        }

        try {
          const caseOrders = await fetchCaseDetails(session, caseRec, idx);
          orders.push(...caseOrders);
          consecutiveErrors = 0; // Reset on success

          // Persist orders immediately (append to JSONL)
          if (caseOrders.length > 0) {
            const lines = caseOrders.map((o) => JSON.stringify(o)).join('\n') + '\n';
            fs.appendFileSync(COMBINED_JSONL, lines);
          }

          progress.details.completed.push(caseRec.case_id);
          completedSet.add(caseRec.case_id);
          progress.details.total_orders += caseOrders.length;

          // Save and log progress regularly
          if (progress.details.completed.length % 25 === 0 || i === chunk.length - 1) {
            const globalDone = progress.details.completed.length;
            const globalPct = ((globalDone / cases.length) * 100).toFixed(1);
            const elapsedMin = (Date.now() - phase2StartTime) / 60000;
            const doneSinceStart = globalDone - phase2StartDone;
            const rate = elapsedMin > 0.5 ? Math.round(doneSinceStart / elapsedMin) : 0;
            const remaining = pending.length - doneSinceStart;
            const etaH = rate > 0 ? (remaining / rate / 60).toFixed(1) : '?';
            wlog(
              `  ${globalDone} done (${globalPct}%) | ${progress.details.total_orders} orders | ${rate}/min | ETA ${etaH}h`,
            );
            saveProgress(progress);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          consecutiveErrors++;

          if (msg === 'CAPTCHA_REJECTED') {
            wlog('Captcha rejected, re-solving...');
            try {
              await solveCaptchaForSession(session, solver, 3, `[DW${idx}] `, idx);
              consecutiveErrors = 0;
              i--; // Retry this case
              continue;
            } catch {
              try {
                session = await createSession(idx);
                await solveCaptchaForSession(session, solver, 5, `[DW${idx}] `, idx);
                consecutiveErrors = 0;
                i--; // Retry
                continue;
              } catch {
                wlog('  Captcha re-solve failed twice, backing off 30s...');
                await sleep(30000);
                // Don't retry this case — move on, it stays in pending
              }
            }
          }

          // Retry on ANY server/network error
          const status = (err as any)?.response?.status || (err as any)?.status;
          const isRetryable =
            (status >= 500 && status <= 599) ||
            msg.includes('socket hang up') ||
            msg.includes('ECONNRESET') ||
            msg.includes('timeout') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('ECONNREFUSED') ||
            msg.includes('ENOTFOUND') ||
            msg.includes('EAI_AGAIN') ||
            msg.includes('EPIPE') ||
            msg.includes('EHOSTUNREACH');

          if (isRetryable) {
            // After 5 consecutive errors with proxy: rotate proxy IP + new session
            // This is the KEY fix: proxy IPs get blocked by Cloudflare, need fresh IP
            if (consecutiveErrors === 5 && PROXY_ENABLED && OXYLABS_USER) {
              proxyRotations++;
              wlog(`  5 errors in a row — rotating proxy IP (#${proxyRotations}) + new session...`);
              try {
                session = await createSession(idx); // This rotates proxy internally
                await solveCaptchaForSession(session, solver, 5, `[DW${idx}] `, idx);
                consecutiveErrors = 0;
                i--; // Retry this case with new IP
                continue;
              } catch (rotErr) {
                wlog(`  Proxy rotation failed, backing off 15s...`);
                await sleep(15000);
              }
            }

            const backoff = Math.min(consecutiveErrors * 3000, 20000);
            if (consecutiveErrors % 2 === 1 || consecutiveErrors >= 5) {
              wlog(`  Err #${consecutiveErrors}: ${status || 'net'} | wait ${backoff / 1000}s`);
            }
            await sleep(backoff);

            // After 10 failures: rotate proxy again (more aggressively) then defer
            if (consecutiveErrors >= 10) {
              if (PROXY_ENABLED && OXYLABS_USER) {
                proxyRotations++;
                wlog(
                  `  10 errors — rotating proxy IP (#${proxyRotations}) + new session, then moving on...`,
                );
                try {
                  session = await createSession(idx);
                  await solveCaptchaForSession(session, solver, 5, `[DW${idx}] `, idx);
                } catch {
                  wlog(`  Proxy rotation failed again, will retry next case with current session`);
                }
              }
              wlog(`  Deferring case ${caseRec.case_id} (10 failures)`);
              consecutiveErrors = 0;
              // DON'T mark as completed — stays in pending for next restart
            } else {
              i--; // Retry this case
            }
            continue;
          }

          logError(`Case ${caseRec.case_id}: ${msg.slice(0, 200)}`);
        }

        await sleep(DELAY_MS); // Delay between case detail fetches
      }

      return orders;
    }),
  );

  for (const result of workerResults) {
    allOrders.push(...result);
  }

  // Orders already written incrementally via appendFileSync during extraction
  log(`\n  Phase 2 complete: ${allOrders.length} orders extracted (written to ${COMBINED_JSONL})`);

  saveProgress(progress);
  return allOrders;
}

// ─── Phase 3: PDF Download ──────────────────────────────────────────────────

async function downloadPDFs(
  orders: OrderRecord[],
  progress: Progress,
  maxPdfs?: number,
): Promise<void> {
  log('\n═══ PHASE 3: PDF DOWNLOAD ═══');

  // Deduplicate by pdf_base64_path
  const seen = new Set<string>();
  const unique = orders.filter((o) => {
    if (seen.has(o.pdf_base64_path) || !o.pdf_base64_path) return false;
    seen.add(o.pdf_base64_path);
    return true;
  });

  // Filter out already downloaded
  const toDownload = unique.filter((o) => {
    const outFile = path.join(PDFS_DIR, o.bench, o.pdf_filename);
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100) {
      progress.pdfs.skipped++;
      return false;
    }
    return true;
  });

  const limit = maxPdfs && maxPdfs > 0 ? Math.min(maxPdfs, toDownload.length) : toDownload.length;
  const batch = toDownload.slice(0, limit);

  log(
    `  Total unique: ${unique.length}, Already downloaded: ${progress.pdfs.skipped}, To download: ${batch.length}`,
  );

  if (batch.length === 0) {
    log('  Nothing to download!');
    return;
  }

  const queue = new PQueue({ concurrency: PDF_CONCURRENCY });
  let completed = 0;
  let failed = 0;
  const startTime = Date.now();
  let lastProgressLog = Date.now();

  const tasks = batch.map((order) =>
    queue.add(async () => {
      const outFile = path.join(PDFS_DIR, order.bench, order.pdf_filename);

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          // gen_pdf_test.php needs NO auth, NO session, NO captcha
          const resp = await axios.get(order.pdf_download_url, {
            timeout: 60000,
            responseType: 'arraybuffer',
            validateStatus: (status) => status === 200,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            httpsAgent: await getHttpsAgent(),
          });

          const data = Buffer.from(resp.data);
          if (data.length < 100) {
            failed++;
            progress.pdfs.failed++;
            return;
          }

          // Atomic write
          const tmpFile = `${outFile}.tmp`;
          fs.writeFileSync(tmpFile, data);
          fs.renameSync(tmpFile, outFile);

          completed++;
          progress.pdfs.downloaded++;
          break;
        } catch (err: unknown) {
          if (attempt === MAX_RETRIES) {
            failed++;
            progress.pdfs.failed++;
          } else {
            await sleep(1000 * attempt);
          }
        }
      }

      // Log progress every 5 seconds
      const now = Date.now();
      if (now - lastProgressLog > 5000) {
        lastProgressLog = now;
        const elapsed = (now - startTime) / 1000;
        const rate = completed / elapsed;
        const remaining = (batch.length - completed - failed) / Math.max(rate, 0.1);
        const etaMin = Math.round(remaining / 60);
        log(
          `  Progress: ${completed + failed}/${batch.length} (${completed} ok, ${failed} fail) | ${rate.toFixed(1)}/s | ETA: ${etaMin}m`,
        );
        saveProgress(progress);
      }
    }),
  );

  await Promise.all(tasks);
  await queue.onIdle();

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(`\n  PDF download complete: ${completed} downloaded, ${failed} failed in ${totalTime} min`);
  saveProgress(progress);
}

// ─── Load Existing Data ─────────────────────────────────────────────────────

function loadExistingMetadata(): CaseRecord[] {
  const records: CaseRecord[] = [];
  if (!fs.existsSync(METADATA_DIR)) return records;

  const files = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.jsonl'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(METADATA_DIR, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
  }
  return records;
}

function loadExistingOrders(): OrderRecord[] {
  if (!fs.existsSync(COMBINED_JSONL)) return [];

  const records: OrderRecord[] = [];
  const content = fs.readFileSync(COMBINED_JSONL, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return records;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const detailsOnly = args.includes('--details-only');
  const downloadOnly = args.includes('--download-only');

  // Validate CAPTCHA API key (not needed for download-only)
  if (!downloadOnly && !CAPTCHA_API_KEY) {
    console.error('Error: CAPTCHA_API_KEY environment variable required.');
    console.error(`Service: ${CAPTCHA_SERVICE}`);
    console.error(
      CAPTCHA_SERVICE === 'capsolver'
        ? 'Get one at https://capsolver.com/'
        : 'Get one at https://2captcha.com/',
    );
    console.error('');
    console.error('Usage: CAPTCHA_API_KEY=xxx npx tsx scripts/ngt-scraper.ts');
    process.exit(1);
  }

  ensureDirs();
  const progress = loadProgress();
  const solver: Solver | null =
    CAPTCHA_SERVICE === '2captcha' && CAPTCHA_API_KEY ? new Solver(CAPTCHA_API_KEY) : null;

  // Parse zone filter
  const zoneFilter = process.env.ZONE ? parseInt(process.env.ZONE, 10) : null;
  const zones = zoneFilter ? ZONES.filter((z) => z.id === zoneFilter) : ZONES;

  // Parse year range
  const START_YEAR = parseInt(process.env.START_YEAR || '2025', 10);
  const END_YEAR = parseInt(process.env.END_YEAR || '2010', 10);
  const MAX_PDFS = parseInt(process.env.MAX_PDFS || '0', 10);

  log('╔══════════════════════════════════════════════╗');
  log('║        NGT ORDER/JUDGMENT SCRAPER            ║');
  log('╚══════════════════════════════════════════════╝');
  log(`  Captcha service: ${CAPTCHA_SERVICE} ($${CAPTCHA_COST_PER_SOLVE}/solve)`);
  log(`  Workers:         ${NUM_WORKERS}`);
  log(
    `  Proxy:           ${PROXY_ENABLED ? `Oxylabs (${OXYLABS_USER}) sticky sessions, IN` : 'DIRECT (no proxy)'}`,
  );
  log(`  Delay:           ${DELAY_MS}ms`);
  log(`  PDF concurrency: ${PDF_CONCURRENCY}`);
  log(`  Years:           ${START_YEAR} -> ${END_YEAR}`);
  log(`  Zones:           ${zones.map((z) => `${z.id}:${z.slug}`).join(', ')}`);
  log(
    `  Mode:            ${testMode ? 'TEST' : metadataOnly ? 'METADATA-ONLY' : detailsOnly ? 'DETAILS-ONLY' : downloadOnly ? 'DOWNLOAD-ONLY' : 'FULL'}`,
  );
  log(`  Max PDFs:        ${MAX_PDFS || 'unlimited'}`);
  log('');

  // ─── Phase 1: Metadata ─────────────────────────────────────────────

  let allCases: CaseRecord[];

  if (detailsOnly || downloadOnly) {
    log('Loading existing metadata from disk...');
    allCases = loadExistingMetadata();
    log(`Loaded ${allCases.length} cases from existing metadata`);
  } else {
    // Generate work items: zone × year × month
    const workItems: MetadataWorkItem[] = [];
    const now = new Date();

    for (const zone of zones) {
      for (let year = START_YEAR; year >= END_YEAR; year--) {
        const maxMonth = year === now.getFullYear() ? now.getMonth() + 1 : 12;
        for (let month = 1; month <= maxMonth; month++) {
          const key = `zone_${zone.id}_${year}_${String(month).padStart(2, '0')}`;
          if (!progress.metadata.completed.includes(key)) {
            workItems.push({
              zoneId: zone.id,
              zoneName: zone.name,
              zoneSlug: zone.slug,
              year,
              month,
              key,
            });
          }
        }
      }
    }

    // Test mode: limit to 1 zone, 1 month
    const itemsToProcess = testMode ? workItems.slice(0, 1) : workItems;

    const totalMonths = zones.length * (START_YEAR - END_YEAR + 1) * 12;
    log(`\n═══ PHASE 1: METADATA COLLECTION ═══`);
    log(
      `  Total: ${totalMonths} zone-months, Already done: ${progress.metadata.completed.length}, Remaining: ${itemsToProcess.length}`,
    );

    if (itemsToProcess.length === 0) {
      log('  All metadata already collected.');
      allCases = loadExistingMetadata();
    } else {
      const queue = new WorkQueue(itemsToProcess);
      const progressMutex = { dirty: false };

      // Periodic progress save
      const saveInterval = setInterval(() => {
        if (progressMutex.dirty) {
          saveProgress(progress);
          progressMutex.dirty = false;
        }
      }, 10_000);

      const numWorkers = testMode ? 1 : Math.min(NUM_WORKERS, itemsToProcess.length);
      log(`  Launching ${numWorkers} workers...\n`);

      const workerResults = await Promise.all(
        Array.from({ length: numWorkers }, (_, i) =>
          metadataWorker(i + 1, queue, progress, solver, progressMutex),
        ),
      );

      clearInterval(saveInterval);
      saveProgress(progress);

      allCases = workerResults.flat();

      // Also load any previously collected metadata
      const existing = loadExistingMetadata();
      const caseIds = new Set(allCases.map((c) => c.case_id));
      for (const c of existing) {
        if (!caseIds.has(c.case_id)) {
          allCases.push(c);
        }
      }

      log(
        `\n  Metadata complete: ${allCases.length} total cases (captcha solves: ${totalCaptchaSolves}, cost: $${(totalCaptchaSolves * CAPTCHA_COST_PER_SOLVE).toFixed(3)})`,
      );
    }
  }

  if (metadataOnly) {
    printSummary(allCases, [], progress);
    return;
  }

  // ─── Phase 2: Case Details ─────────────────────────────────────────

  let allOrders: OrderRecord[];

  if (downloadOnly) {
    log('Loading existing orders from disk...');
    allOrders = loadExistingOrders();
    log(`Loaded ${allOrders.length} orders from existing data`);
  } else {
    allOrders = await collectCaseDetails(allCases, progress, solver);
  }

  if (detailsOnly) {
    printSummary(allCases, allOrders, progress);
    return;
  }

  // ─── Phase 3: PDF Download ─────────────────────────────────────────

  if (allOrders.length > 0) {
    const maxPdfs = testMode ? 5 : MAX_PDFS > 0 ? MAX_PDFS : undefined;
    await downloadPDFs(allOrders, progress, maxPdfs);
  }

  printSummary(allCases, allOrders, progress);
}

function printSummary(cases: CaseRecord[], orders: OrderRecord[], progress: Progress): void {
  log('\n╔══════════════════════════════════════════════╗');
  log('║              SCRAPING COMPLETE               ║');
  log('╚══════════════════════════════════════════════╝');
  log(`  Total cases found:      ${cases.length}`);
  log(`  Total orders extracted:  ${orders.length}`);

  // Breakdown by type
  const orderTypes = orders.reduce(
    (acc, o) => {
      const t = o.order_type || 'Unknown';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  for (const [type, count] of Object.entries(orderTypes)) {
    log(`    ${type}: ${count}`);
  }

  // Breakdown by zone
  for (const zone of ZONES) {
    const zoneCases = cases.filter((c) => c.zone_id === zone.id).length;
    const zoneOrders = orders.filter((o) => o.zone_id === zone.id).length;
    if (zoneCases > 0 || zoneOrders > 0) {
      log(`  ${zone.name}: ${zoneCases} cases, ${zoneOrders} orders`);
    }
  }

  log(`  PDFs downloaded:        ${progress.pdfs.downloaded}`);
  log(`  PDFs failed:            ${progress.pdfs.failed}`);
  log(`  PDFs skipped (existed): ${progress.pdfs.skipped}`);

  // Count files on disk
  let totalPdfs = 0;
  for (const zone of ZONES) {
    const dir = path.join(PDFS_DIR, zone.slug);
    if (fs.existsSync(dir)) {
      const count = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf')).length;
      totalPdfs += count;
      if (count > 0) log(`    ${zone.name}: ${count} PDFs`);
    }
  }
  log(`  Total PDFs on disk:     ${totalPdfs}`);

  // Captcha cost report
  log(`\n  --- Captcha Cost Report (${CAPTCHA_SERVICE}) ---`);
  log(`  Total solves:           ${totalCaptchaSolves}`);
  log(`  Cost per solve:         $${CAPTCHA_COST_PER_SOLVE}`);
  log(`  Total cost:             $${(totalCaptchaSolves * CAPTCHA_COST_PER_SOLVE).toFixed(3)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
