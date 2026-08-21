/**
 * NCLT E-Filing Portal Scraper v3 (Case Number Enumeration)
 *
 * Strategy:
 *   Enumerate ALL cases by iterating case_no = 1, 2, 3... for each
 *   (bench, year, case_type) combination. This gives 100% coverage
 *   unlike the old party-name keyword approach which only found ~50%.
 *
 *   N parallel workers, each assigned a set of benches (round-robin).
 *   Each worker uses Playwright ONLY to initialize a session (get cookies).
 *   All actual API calls use raw HTTP with those cookies (much faster).
 *   Sessions are refreshed every REQUESTS_PER_SESSION calls or on error.
 *
 * Output: data/tribunals/nclt/metadata/{bench}-cases.jsonl  (one JSON per line per case)
 *         data/tribunals/nclt/scrape-progress.json           (resume state)
 *
 * Usage:
 *   npx tsx scripts/nclt-efiling-scraper.ts --test           # 1 bench, 1 type, max 10 cases
 *   npx tsx scripts/nclt-efiling-scraper.ts                  # Full run, 20 workers
 *   npx tsx scripts/nclt-efiling-scraper.ts --upload         # Full run with Cloudflare upload
 *   WORKERS=40 npx tsx scripts/nclt-efiling-scraper.ts       # 40 parallel workers
 *
 * Environment:
 *   WORKERS             - Number of parallel workers (default: 40)
 *   CLOUDFLARE_API_URL  - Worker URL (required for --upload mode)
 *   START_BENCH         - Resume from bench ID (default: 1)
 *   START_YEAR          - Resume from year (default: first year)
 *   MAX_CASES           - Limit total cases (0 = unlimited)
 *   BATCH_SIZE          - Upload batch size (default: 25)
 *   MISS_LIMIT          - Stop after N consecutive case_no misses (default: 10)
 */

import { chromium, type Browser } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  ALL_BENCH_IDS,
  ALL_CASE_TYPE_CODES,
  benchSlug,
  CASE_TYPE_CODES,
  CONSECUTIVE_MISS_LIMIT,
  NCLT_BENCHES,
  SCRAPE_YEARS,
} from './nclt-bench-registry';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EFILING_BASE = 'https://efiling.nclt.gov.in';
const EFILING_URL = `${EFILING_BASE}/casehistorybeforeloginmenutrue.drt`;
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/nclt');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

const CLOUDFLARE_API_URL = process.env.CLOUDFLARE_API_URL || '';
const MAX_CASES = process.env.MAX_CASES ? parseInt(process.env.MAX_CASES, 10) : Infinity;
const START_BENCH = process.env.START_BENCH || '1';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '25', 10);
const NUM_WORKERS = parseInt(process.env.WORKERS || '80', 10);
const MISS_LIMIT = parseInt(process.env.MISS_LIMIT || String(CONSECUTIVE_MISS_LIMIT), 10);

// Session management: refresh session after this many API requests (higher = fewer Playwright page loads)
const REQUESTS_PER_SESSION = parseInt(process.env.REQUESTS_PER_SESSION || '200', 10);

// Timeouts (ms)
const DISCOVERY_TIMEOUT = 120_000; // 120s for discovery (some benches are slow)
const DETAIL_TIMEOUT = 45_000; // 45s for detail fetch
const SESSION_INIT_TIMEOUT = 30_000; // 30s for Playwright page load (was 20s, caused 84% of errors)

// Delays (ms) - only applied on HITS; misses get no delay (they're lightweight empty responses)
const BETWEEN_REQUESTS_MIN = parseInt(process.env.BETWEEN_REQUESTS_MIN || '150', 10);
const BETWEEN_REQUESTS_MAX = parseInt(process.env.BETWEEN_REQUESTS_MAX || '400', 10);
const MISS_DELAY = parseInt(process.env.MISS_DELAY || '30', 10); // tiny delay on misses
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY = 1500;

// Oxylabs proxy config
const PROXY_URL = process.env.PROXY_URL || '';
const PROXY_ENABLED = !!PROXY_URL;

// Circuit breaker (per-worker) - shorter cooldown
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN = 90 * 1000; // 90s (down from 5 min)

const IS_TEST = process.argv.includes('--test');
const UPLOAD_MODE = process.argv.includes('--upload');

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PartySearchResult {
  filing_no: string;
  case_type: string;
  case_type_desc_cis: string;
  case_no: string;
  bench_location_name: string;
  date_of_filing: string;
  regis_date: string;
  status: string;
  case_title1: string;
  case_title2: string;
  disposal_date: string;
  action_type: string;
  main_case_fno: string;
  [key: string]: unknown;
}

interface CaseDetail {
  filing_no: string;
  bench_id: string;
  bench_name: string;
  discovery_term: string;
  scraped_at: string;
  content_hash: string;
  search_result: PartySearchResult;
  detail_response: Record<string, unknown>;
}

interface NcltProgress {
  lastBench: string;
  lastTerm: string;
  discoveredFilings: Record<string, boolean>;
  completedBenchYearTerms: string[];
  errors: Array<{ filing_no?: string; bench?: string; error: string; at: string }>;
  stats: {
    totalDiscovered: number;
    totalDetailsFetched: number;
    totalErrors: number;
    startedAt: string;
    lastUpdatedAt: string;
  };
}

interface WorkItem {
  benchId: string;
  year: number;
  caseTypeCode: string;
  key: string; // "benchId-year-ct{code}"
}

// ---------------------------------------------------------------------------
// Shared State (single-threaded Node.js - safe for async concurrency)
// ---------------------------------------------------------------------------

class SharedProgress {
  private progress: NcltProgress;
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private fileLocks = new Map<string, Promise<void>>();

  constructor() {
    this.progress = this.load();
    this.flushTimer = setInterval(() => this.flush(), 10000);
  }

  private load(): NcltProgress {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
    return {
      lastBench: '1',
      lastTerm: '',
      discoveredFilings: {},
      completedBenchYearTerms: [],
      errors: [],
      stats: {
        totalDiscovered: 0,
        totalDetailsFetched: 0,
        totalErrors: 0,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      },
    };
  }

  flush(): void {
    if (!this.dirty) return;
    this.progress.stats.lastUpdatedAt = new Date().toISOString();
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(this.progress, null, 2));
    this.dirty = false;
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flush();
  }

  isCompleted(key: string): boolean {
    return this.progress.completedBenchYearTerms.includes(key);
  }

  isFilingKnown(filingNo: string): boolean {
    return filingNo in this.progress.discoveredFilings;
  }

  isFilingFetched(filingNo: string): boolean {
    return this.progress.discoveredFilings[filingNo] === true;
  }

  markDiscovered(filingNo: string): void {
    if (!this.progress.discoveredFilings[filingNo]) {
      this.progress.discoveredFilings[filingNo] = false;
      this.progress.stats.totalDiscovered++;
      this.dirty = true;
    }
  }

  markFetched(filingNo: string): void {
    this.progress.discoveredFilings[filingNo] = true;
    this.progress.stats.totalDetailsFetched++;
    this.dirty = true;
  }

  markCompleted(key: string): void {
    if (!this.progress.completedBenchYearTerms.includes(key)) {
      this.progress.completedBenchYearTerms.push(key);
      this.dirty = true;
    }
  }

  addError(err: { filing_no?: string; bench?: string; error: string; at: string }): void {
    this.progress.errors.push(err);
    this.progress.stats.totalErrors++;
    this.dirty = true;
  }

  get totalFetched(): number {
    return this.progress.stats.totalDetailsFetched;
  }

  get totalDiscovered(): number {
    return this.progress.stats.totalDiscovered;
  }

  get totalErrors(): number {
    return this.progress.stats.totalErrors;
  }

  get completedCount(): number {
    return this.progress.completedBenchYearTerms.length;
  }

  async appendJsonl(filePath: string, obj: Record<string, unknown>): Promise<void> {
    const existing = this.fileLocks.get(filePath) || Promise.resolve();
    const next = existing.then(() => {
      fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
    });
    this.fileLocks.set(filePath, next);
    await next;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomDelay(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
}

function md5(data: string): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

function log(msg: string, workerId?: number): void {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = workerId !== undefined ? `[${ts}][W${workerId}]` : `[${ts}]`;
  console.log(`${prefix} ${msg}`);
}

function logError(msg: string, workerId?: number): void {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = workerId !== undefined ? `[${ts}][W${workerId}]` : `[${ts}]`;
  console.error(`${prefix} ERROR: ${msg}`);
}

// ---------------------------------------------------------------------------
// Proxy Agent Factory (Oxylabs sticky sessions per worker)
// ---------------------------------------------------------------------------

const workerProxyAgents = new Map<number, HttpsProxyAgent>();

function createProxyAgent(workerId: number): HttpsProxyAgent | undefined {
  if (!PROXY_ENABLED) return undefined;
  const url = new URL(PROXY_URL);
  // Oxylabs sticky session: append -sessid-XXX to username for same IP per worker
  const sessId = `nclt_w${workerId}_${Date.now()}`;
  url.username = `${url.username}-sessid-${sessId}-sesstime-10`;
  const agent = new HttpsProxyAgent(url.toString());
  workerProxyAgents.set(workerId, agent);
  return agent;
}

function getProxyAgent(workerId: number): HttpsProxyAgent | undefined {
  if (!PROXY_ENABLED) return undefined;
  return workerProxyAgents.get(workerId) || createProxyAgent(workerId);
}

function refreshProxy(workerId: number): void {
  if (!PROXY_ENABLED) return;
  createProxyAgent(workerId); // new sessid = new IP
}

// ---------------------------------------------------------------------------
// Proxy-aware HTTP helper
// ---------------------------------------------------------------------------

function proxyFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
    workerId?: number;
  },
): Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}> {
  const agent = options.workerId !== undefined ? getProxyAgent(options.workerId) : undefined;

  if (!agent) {
    // No proxy — use native fetch
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeout || 30000);
    return fetch(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      signal: ctrl.signal,
    }).then((resp) => {
      clearTimeout(timer);
      return resp;
    });
  }

  // Proxied request via https.request
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const timeout = options.timeout || 30000;

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers,
        agent,
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve({
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            text: () => Promise.resolve(body),
            json: () => Promise.resolve(JSON.parse(body)),
          });
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Session Manager - Uses Playwright ONLY for cookie harvesting
// ---------------------------------------------------------------------------

class SessionManager {
  private cookies: string = '';
  private requestCount = 0;
  private browser: Browser;
  private workerId: number;

  constructor(browser: Browser, workerId: number) {
    this.browser = browser;
    this.workerId = workerId;
  }

  async init(): Promise<void> {
    await this.refreshSession();
  }

  getWorkerId(): number {
    return this.workerId;
  }

  async refreshSession(): Promise<void> {
    // Rotate proxy IP on session refresh
    if (PROXY_ENABLED) refreshProxy(this.workerId);

    const context = await this.browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();

    try {
      await page.goto(EFILING_URL, {
        waitUntil: 'domcontentloaded',
        timeout: SESSION_INIT_TIMEOUT,
      });
      // Wait for JS initialization
      await page.waitForTimeout(1500);

      const browserCookies = await context.cookies();
      this.cookies = browserCookies.map((c) => `${c.name}=${c.value}`).join('; ');
      this.requestCount = 0;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  async ensureFreshSession(): Promise<void> {
    if (this.requestCount >= REQUESTS_PER_SESSION || !this.cookies) {
      await this.refreshSession();
    }
  }

  getCookies(): string {
    this.requestCount++;
    return this.cookies;
  }

  invalidate(): void {
    // Force refresh on next request
    this.requestCount = REQUESTS_PER_SESSION;
  }
}

// ---------------------------------------------------------------------------
// Raw HTTP API Calls
// ---------------------------------------------------------------------------

async function caseNoSearchHttp(
  session: SessionManager,
  benchId: string,
  caseTypeCode: string,
  caseNo: number,
  year: number | string,
  retries = MAX_RETRIES,
): Promise<PartySearchResult[]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await session.ensureFreshSession();
      const cookies = session.getCookies();

      const body = {
        wayofselection: 'casenumber',
        i_bench_id_case_no: benchId,
        i_case_type_caseno: caseTypeCode,
        case_no: String(caseNo),
        i_case_year_caseno: String(year),
        i_bench_id_party: '0',
        party_type_party: '0',
        party_name_party: '',
        i_case_year_party: '0',
        i_party_search: 'W',
        status_party: '0',
        i_bench_id: '0',
        filing_no: '',
      };

      const resp = await proxyFetch(`${EFILING_BASE}/caseHistoryoptional.drt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookies,
          'User-Agent': USER_AGENT,
          Referer: EFILING_URL,
          Accept: 'application/json, text/plain, */*',
          Origin: EFILING_BASE,
        },
        body: JSON.stringify(body),
        timeout: DISCOVERY_TIMEOUT,
        workerId: session.getWorkerId(),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as Record<string, unknown>;
      return (data.mainpanellist || []) as PartySearchResult[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      session.invalidate();

      if (attempt < retries) {
        const d = RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        await randomDelay(d, d * 1.3);
      } else {
        throw new Error(`Failed after ${retries} attempts: ${msg}`);
      }
    }
  }
  return [];
}

async function fetchDetailHttp(
  session: SessionManager,
  filingNo: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    await session.ensureFreshSession();
    const cookies = session.getCookies();

    const resp = await proxyFetch(
      `${EFILING_BASE}/caseHistoryalldetails.drt?filing_no=${filingNo}&flagIA=false`,
      {
        headers: {
          Cookie: cookies,
          'User-Agent': USER_AGENT,
          Referer: EFILING_URL,
          Accept: 'application/json, text/plain, */*',
        },
        timeout: DETAIL_TIMEOUT,
        workerId: session.getWorkerId(),
      },
    );

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    return { ok: true, data: JSON.parse(text) as Record<string, unknown> };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    session.invalidate();
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Circuit Breaker (per-worker)
// ---------------------------------------------------------------------------

class CircuitBreaker {
  private consecutiveFailures = 0;
  private lastFailure = 0;

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailure = Date.now();
  }

  isTripped(): boolean {
    return this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD;
  }

  async waitIfTripped(wid: number): Promise<void> {
    if (!this.isTripped()) return;
    const elapsed = Date.now() - this.lastFailure;
    const remaining = CIRCUIT_BREAKER_COOLDOWN - elapsed;
    if (remaining > 0) {
      log(
        `Circuit breaker tripped (${this.consecutiveFailures} failures). Pausing ${Math.round(remaining / 1000)}s...`,
        wid,
      );
      await new Promise((r) => setTimeout(r, remaining));
    }
    this.consecutiveFailures = 0;
  }
}

// ---------------------------------------------------------------------------
// Cloudflare Upload
// ---------------------------------------------------------------------------

interface CaseForUpload {
  doc_id: string;
  title: string;
  court_slug: string;
  decision_date?: string;
  decision_year: number;
  case_number?: string;
  case_type?: string;
  petitioner?: string;
  respondent?: string;
  has_full_text: boolean;
  source_url: string;
  full_text?: string;
  content_hash?: string;
}

function caseDetailToUpload(caseData: CaseDetail): CaseForUpload {
  const sr = caseData.search_result;
  const petitioner = (sr.case_title1 || '').trim();
  const respondent = (sr.case_title2 || '').trim();
  const caseNo = sr.case_no || '';
  const title =
    petitioner && respondent
      ? `${caseNo} - ${petitioner} vs ${respondent}`
      : caseNo || `NCLT Filing ${caseData.filing_no}`;

  const dof = sr.date_of_filing || '';
  const parts = dof.split('-');
  const isoDate = parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : '';
  const year = parts.length === 3 ? parseInt(parts[2], 10) : new Date().getFullYear();

  return {
    doc_id: `nclt-${caseData.filing_no}`,
    title,
    court_slug: `nclt-${benchSlug(caseData.bench_id)}`,
    decision_date: isoDate || undefined,
    decision_year: year,
    case_number: caseNo || undefined,
    case_type: sr.case_type_desc_cis || undefined,
    petitioner: petitioner || undefined,
    respondent: respondent || undefined,
    has_full_text: true,
    source_url: 'https://efiling.nclt.gov.in/casehistorybeforeloginmenutrue.drt',
    full_text: JSON.stringify(caseData.detail_response),
    content_hash: caseData.content_hash,
  };
}

async function uploadBatch(cases: CaseForUpload[]): Promise<boolean> {
  if (!CLOUDFLARE_API_URL || cases.length === 0) return true;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${CLOUDFLARE_API_URL}/internal/cases/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`API ${response.status}: ${text.slice(0, 200)}`);
      }
      return true;
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt)));
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Worker - processes a queue of WorkItems
// ---------------------------------------------------------------------------

async function runWorker(
  workerId: number,
  items: WorkItem[],
  shared: SharedProgress,
  shouldUpload: boolean,
  maxCases: number,
  shutdownFlag: { value: boolean },
): Promise<{ discovered: number; fetched: number; errors: number }> {
  const stats = { discovered: 0, fetched: 0, errors: 0 };
  const breaker = new CircuitBreaker();
  const uploadBuffer: CaseForUpload[] = [];

  // Stagger worker start (fast stagger — 300ms apart)
  await randomDelay(workerId * 300, workerId * 300 + 500);

  // Each worker gets its own browser (shared across session refreshes)
  const browser = await chromium.launch({ headless: true });
  const session = new SessionManager(browser, workerId);

  try {
    await session.init();
    log(`Session initialized`, workerId);

    for (const item of items) {
      if (shutdownFlag.value || stats.fetched >= maxCases) break;
      if (shared.isCompleted(item.key)) continue;

      await breaker.waitIfTripped(workerId);

      const benchName = NCLT_BENCHES[item.benchId];
      const caseTypeName = CASE_TYPE_CODES[item.caseTypeCode] || `type-${item.caseTypeCode}`;
      const slug = benchSlug(item.benchId);
      const jsonlFile = path.join(METADATA_DIR, `${slug}-cases.jsonl`);

      log(`${caseTypeName} @ ${benchName} ${item.year} — enumerating case numbers`, workerId);

      let consecutiveMisses = 0;
      let caseNo = 1;
      let itemDiscovered = 0;

      // Enumerate case_no = 1, 2, 3... until MISS_LIMIT consecutive misses
      while (consecutiveMisses < MISS_LIMIT) {
        if (shutdownFlag.value || stats.fetched >= maxCases) break;

        await breaker.waitIfTripped(workerId);

        // Phase 1: Search by case number
        let searchResults: PartySearchResult[] = [];

        try {
          searchResults = await caseNoSearchHttp(
            session,
            item.benchId,
            item.caseTypeCode,
            caseNo,
            item.year,
          );
          breaker.recordSuccess();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(
            `Search failed case_no=${caseNo} ${caseTypeName} @ ${benchName} ${item.year}: ${msg.slice(0, 100)}`,
            workerId,
          );
          breaker.recordFailure();
          stats.errors++;
          consecutiveMisses++;
          caseNo++;
          await new Promise((r) => setTimeout(r, MISS_DELAY));
          continue;
        }

        if (searchResults.length === 0) {
          consecutiveMisses++;
          caseNo++;
          await new Promise((r) => setTimeout(r, MISS_DELAY));
          continue;
        }

        // Reset miss counter on hit
        consecutiveMisses = 0;

        // Phase 2: Process each result and fetch details
        for (const sr of searchResults) {
          if (!sr.filing_no || shutdownFlag.value || stats.fetched >= maxCases) continue;

          if (!shared.isFilingKnown(sr.filing_no)) {
            shared.markDiscovered(sr.filing_no);
            stats.discovered++;
            itemDiscovered++;
          }

          if (shared.isFilingFetched(sr.filing_no)) continue;

          await breaker.waitIfTripped(workerId);

          const result = await fetchDetailHttp(session, sr.filing_no);

          if (result.ok) {
            breaker.recordSuccess();
            const detailJson = JSON.stringify(result.data);

            const caseData: CaseDetail = {
              filing_no: sr.filing_no,
              bench_id: item.benchId,
              bench_name: benchName,
              discovery_term: `ct${item.caseTypeCode}:${caseNo}`,
              scraped_at: new Date().toISOString(),
              content_hash: md5(detailJson),
              search_result: sr,
              detail_response: result.data,
            };

            await shared.appendJsonl(jsonlFile, caseData as unknown as Record<string, unknown>);
            shared.markFetched(sr.filing_no);
            stats.fetched++;

            if (shouldUpload) {
              uploadBuffer.push(caseDetailToUpload(caseData));
              if (uploadBuffer.length >= BATCH_SIZE) {
                const ok = await uploadBatch(uploadBuffer.splice(0));
                if (ok) log(`  Uploaded ${BATCH_SIZE} cases`, workerId);
              }
            }

            if (stats.fetched % 50 === 0) {
              log(`  Worker progress: ${stats.fetched} fetched, ${stats.errors} errors`, workerId);
            }
          } else {
            breaker.recordFailure();
            shared.addError({
              filing_no: sr.filing_no,
              bench: item.benchId,
              error: result.error.slice(0, 200),
              at: new Date().toISOString(),
            });
            stats.errors++;
          }

          await randomDelay(BETWEEN_REQUESTS_MIN, BETWEEN_REQUESTS_MAX);
        }

        caseNo++;
        await randomDelay(BETWEEN_REQUESTS_MIN, BETWEEN_REQUESTS_MAX);
      }

      if (itemDiscovered > 0) {
        log(`  Done: ${itemDiscovered} new cases found (case_no 1-${caseNo - 1})`, workerId);
      }

      shared.markCompleted(item.key);
    }
  } finally {
    await browser.close();

    // Flush remaining uploads
    if (shouldUpload && uploadBuffer.length > 0) {
      await uploadBatch(uploadBuffer.splice(0));
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Work Queue Builder
// ---------------------------------------------------------------------------

function buildWorkQueue(
  benchIds: string[],
  years: number[],
  caseTypeCodes: string[],
  shared: SharedProgress,
): WorkItem[] {
  const items: WorkItem[] = [];

  const startYear = parseInt(process.env.START_YEAR || String(years[0]), 10);

  for (const benchId of benchIds) {
    if (parseInt(benchId) < parseInt(START_BENCH)) continue;

    for (const year of years) {
      if (benchId === START_BENCH && year < startYear) continue;

      for (const caseTypeCode of caseTypeCodes) {
        const key = `${benchId}-${year}-ct${caseTypeCode}`;
        if (!shared.isCompleted(key)) {
          items.push({ benchId, year, caseTypeCode, key });
        }
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Distribute work items to workers by bench (round-robin)
// ---------------------------------------------------------------------------

function distributeWork(items: WorkItem[], numWorkers: number): WorkItem[][] {
  const workerQueues: WorkItem[][] = Array.from({ length: numWorkers }, () => []);

  // Round-robin distribute individual items across all workers
  // This lets us scale past 15 workers (one per bench) by splitting bench work
  for (let i = 0; i < items.length; i++) {
    workerQueues[i % numWorkers].push(items[i]);
  }

  return workerQueues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(METADATA_DIR, { recursive: true });

  const shared = new SharedProgress();
  const shutdownFlag = { value: false };

  const shutdown = () => {
    if (shutdownFlag.value) return;
    shutdownFlag.value = true;
    log('\nShutdown requested. Workers will finish current items and save progress...');
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  const benchIds = IS_TEST ? [ALL_BENCH_IDS[0]] : ALL_BENCH_IDS;
  const years = IS_TEST ? [2024] : SCRAPE_YEARS;
  const caseTypeCodes = IS_TEST ? ['16'] : ALL_CASE_TYPE_CODES; // type 16 = CP(IB) for test
  const maxCases = IS_TEST ? 10 : MAX_CASES;
  const shouldUpload = UPLOAD_MODE && !!CLOUDFLARE_API_URL;
  const numWorkers = IS_TEST ? 1 : NUM_WORKERS;

  const allItems = buildWorkQueue(benchIds, years, caseTypeCodes, shared);

  log('=== NCLT E-Filing Portal Scraper v3 (Case Number Enumeration) ===');
  log(`Workers: ${numWorkers}`);
  log(
    `Benches: ${benchIds.length}, Years: ${years.length} (${years[0]}-${years[years.length - 1]}), Case Types: ${caseTypeCodes.length}`,
  );
  log(`Remaining work items: ${allItems.length} (already completed: ${shared.completedCount})`);
  log(
    `Mode: ${IS_TEST ? 'TEST' : 'FULL'}, Max cases: ${maxCases === Infinity ? 'unlimited' : maxCases}`,
  );
  log(`Miss limit: ${MISS_LIMIT} consecutive misses per bench/year/type before moving on`);
  log(
    `Upload: ${shouldUpload ? CLOUDFLARE_API_URL : 'disabled (use --upload + CLOUDFLARE_API_URL)'}`,
  );
  log(
    `Timing: ${BETWEEN_REQUESTS_MIN}-${BETWEEN_REQUESTS_MAX}ms between requests, session refresh every ${REQUESTS_PER_SESSION} requests`,
  );
  log(
    `Timeouts: discovery ${DISCOVERY_TIMEOUT / 1000}s, detail ${DETAIL_TIMEOUT / 1000}s, retries: ${MAX_RETRIES}`,
  );
  log(`Proxy: ${PROXY_ENABLED ? 'ENABLED (Oxylabs)' : 'DISABLED (direct)'}`);
  log(
    `Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} failures → ${CIRCUIT_BREAKER_COOLDOWN / 1000}s pause`,
  );
  log(`Existing progress: ${shared.totalDiscovered} discovered, ${shared.totalFetched} fetched`);

  if (shouldUpload) {
    try {
      const healthResp = await fetch(`${CLOUDFLARE_API_URL}/health`);
      if (!healthResp.ok) throw new Error(`HTTP ${healthResp.status}`);
      log('Cloudflare API: healthy');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Cloudflare API unreachable: ${msg}`);
      process.exit(1);
    }
  }
  log('');

  if (allItems.length === 0) {
    log('No work items remaining. All bench/year/term combos already completed.');
    shared.stop();
    return;
  }

  const workerQueues = distributeWork(allItems, numWorkers);

  for (let i = 0; i < numWorkers; i++) {
    if (workerQueues[i].length === 0) continue;
    const benches = [...new Set(workerQueues[i].map((w) => NCLT_BENCHES[w.benchId]))];
    const types = [...new Set(workerQueues[i].map((w) => w.caseTypeCode))].length;
    log(`Worker ${i}: ${workerQueues[i].length} items, ${types} types (${benches.join(', ')})`);
  }
  log('');

  const workerPromises = workerQueues
    .map((queue, idx) => {
      if (queue.length === 0) return null;
      return runWorker(idx, queue, shared, shouldUpload, maxCases, shutdownFlag);
    })
    .filter(Boolean);

  const progressInterval = setInterval(() => {
    log(
      `--- Progress: ${shared.totalFetched} fetched, ${shared.totalDiscovered} discovered, ${shared.totalErrors} errors, ${shared.completedCount} combos done ---`,
    );
  }, 30000);

  const results = await Promise.all(workerPromises);

  clearInterval(progressInterval);
  shared.stop();

  const totals = results.reduce(
    (acc, r) => {
      if (!r) return acc;
      return {
        discovered: acc.discovered + r.discovered,
        fetched: acc.fetched + r.fetched,
        errors: acc.errors + r.errors,
      };
    },
    { discovered: 0, fetched: 0, errors: 0 },
  );

  log('');
  log('=== SCRAPING COMPLETE ===');
  log(
    `This run: discovered ${totals.discovered}, fetched ${totals.fetched}, errors ${totals.errors}`,
  );
  log(
    `All time: discovered ${shared.totalDiscovered}, fetched ${shared.totalFetched}, errors ${shared.totalErrors}`,
  );
  log(`Completed combos: ${shared.completedCount}`);
  log(`Progress saved to: ${PROGRESS_FILE}`);

  log('');
  log('Per-bench summary:');
  for (const bid of ALL_BENCH_IDS) {
    const file = path.join(METADATA_DIR, `${benchSlug(bid)}-cases.jsonl`);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).length;
      log(`  ${NCLT_BENCHES[bid]}: ${lines} cases`);
    }
  }
}

main().catch((err) => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
