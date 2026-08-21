/**
 * NCLT Fetch-Only Script
 *
 * Reads unfetched filing numbers from scrape-progress.json and fetches their
 * details in parallel across N workers. Saves results to per-bench JSONL files
 * and updates the progress file.
 *
 * Usage:
 *   WORKERS=80 npx tsx scripts/nclt-fetch-unfetched.ts
 */

import { chromium, type Browser } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { NCLT_BENCHES, benchSlug, ALL_BENCH_IDS } from './nclt-bench-registry';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EFILING_BASE = 'https://efiling.nclt.gov.in';
const EFILING_URL = `${EFILING_BASE}/casehistorybeforeloginmenutrue.drt`;
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/nclt');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

const NUM_WORKERS = parseInt(process.env.WORKERS || '80', 10);
const REQUESTS_PER_SESSION = 200;
const DETAIL_TIMEOUT = 45_000;
const SESSION_INIT_TIMEOUT = 30_000;
const BETWEEN_REQUESTS_MIN = 20;
const BETWEEN_REQUESTS_MAX = 60;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Progress (read/write the same file as the main scraper)
// ---------------------------------------------------------------------------

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

let progress: NcltProgress;
let dirty = false;

function loadProgress(): NcltProgress {
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
}

function flushProgress(): void {
  if (!dirty) return;
  progress.stats.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  dirty = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string, wid?: number): void {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = wid !== undefined ? `[${ts}][W${wid}]` : `[${ts}]`;
  console.log(`${prefix} ${msg}`);
}

function md5(data: string): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

function randomDelay(min: number, max: number): Promise<void> {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

// Guess bench from filing number prefix (first 2 digits map to bench IDs)
// Filing numbers encode the bench. We'll extract it from the detail response instead.
// For JSONL output, we need the bench — we'll get it from the API response.

// File locks for concurrent JSONL writes
const fileLocks = new Map<string, Promise<void>>();

function appendJsonl(filePath: string, obj: Record<string, unknown>): Promise<void> {
  const existing = fileLocks.get(filePath) || Promise.resolve();
  const next = existing.then(() => {
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
  });
  fileLocks.set(filePath, next);
  return next;
}

// ---------------------------------------------------------------------------
// Session Manager (same as main scraper)
// ---------------------------------------------------------------------------

class SessionManager {
  private cookies = '';
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

  async refreshSession(): Promise<void> {
    const context = await this.browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    try {
      await page.goto(EFILING_URL, {
        waitUntil: 'domcontentloaded',
        timeout: SESSION_INIT_TIMEOUT,
      });
      await page.waitForTimeout(1500);
      const browserCookies = await context.cookies();
      this.cookies = browserCookies.map((c) => `${c.name}=${c.value}`).join('; ');
      this.requestCount = 0;
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  async ensureFresh(): Promise<void> {
    if (this.requestCount >= REQUESTS_PER_SESSION || !this.cookies) {
      await this.refreshSession();
    }
  }

  getCookies(): string {
    this.requestCount++;
    return this.cookies;
  }

  invalidate(): void {
    this.requestCount = REQUESTS_PER_SESSION;
  }
}

// ---------------------------------------------------------------------------
// Fetch detail for a filing
// ---------------------------------------------------------------------------

async function fetchDetail(
  session: SessionManager,
  filingNo: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await session.ensureFresh();
      const cookies = session.getCookies();

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DETAIL_TIMEOUT);

      const resp = await fetch(
        `${EFILING_BASE}/caseHistoryalldetails.drt?filing_no=${filingNo}&flagIA=false`,
        {
          headers: {
            Cookie: cookies,
            'User-Agent': USER_AGENT,
            Referer: EFILING_URL,
            Accept: 'application/json, text/plain, */*',
          },
          signal: ctrl.signal,
        },
      );
      clearTimeout(timer);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      return { ok: true, data: JSON.parse(text) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      session.invalidate();
      if (attempt < 3) {
        await randomDelay(1000 * attempt, 1500 * attempt);
      } else {
        return { ok: false, error: msg };
      }
    }
  }
  return { ok: false, error: 'exhausted retries' };
}

// ---------------------------------------------------------------------------
// Determine bench from filing number or detail response
// ---------------------------------------------------------------------------

function guessBenchFromFiling(filingNo: string, detailData: Record<string, unknown>): string {
  // Try to get bench from the detail response
  const benchId = detailData.bench_id || detailData.i_bench_id;
  if (benchId && NCLT_BENCHES[String(benchId)]) return String(benchId);

  // Try bench_location_name from case_details
  const caseDetails = detailData.case_details as Record<string, unknown> | undefined;
  if (caseDetails) {
    const benchLoc = String(caseDetails.bench_location_name || '').toLowerCase();
    for (const [id, name] of Object.entries(NCLT_BENCHES)) {
      if (benchLoc.includes(name.toLowerCase())) return id;
    }
  }

  // Fallback: save to "unknown" file
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function runFetchWorker(
  workerId: number,
  filings: string[],
  shutdownFlag: { value: boolean },
): Promise<{ fetched: number; errors: number }> {
  const stats = { fetched: 0, errors: 0 };

  // Stagger start — 1s apart to avoid overwhelming the site with 80 simultaneous Playwright sessions
  await randomDelay(workerId * 1000, workerId * 1000 + 500);

  const browser = await chromium.launch({ headless: true });
  const session = new SessionManager(browser, workerId);

  try {
    // Retry session init up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await session.init();
        break;
      } catch (err) {
        if (attempt === 3) throw err;
        log(`Session init attempt ${attempt} failed, retrying in ${attempt * 5}s...`, workerId);
        await randomDelay(attempt * 5000, attempt * 5000 + 2000);
      }
    }
    log(`Ready, ${filings.length} filings to fetch`, workerId);

    for (const filingNo of filings) {
      if (shutdownFlag.value) break;

      // Skip if already fetched (race condition protection)
      if (progress.discoveredFilings[filingNo] === true) continue;

      const result = await fetchDetail(session, filingNo);

      if (result.ok) {
        const detailJson = JSON.stringify(result.data);
        const benchId = guessBenchFromFiling(filingNo, result.data);
        const slug = benchId === 'unknown' ? 'unknown' : benchSlug(benchId);
        const jsonlFile = path.join(METADATA_DIR, `${slug}-cases.jsonl`);

        const caseData = {
          filing_no: filingNo,
          bench_id: benchId,
          bench_name: NCLT_BENCHES[benchId] || 'Unknown',
          discovery_term: 'backfill',
          scraped_at: new Date().toISOString(),
          content_hash: md5(detailJson),
          search_result: {},
          detail_response: result.data,
        };

        await appendJsonl(jsonlFile, caseData);
        progress.discoveredFilings[filingNo] = true;
        progress.stats.totalDetailsFetched++;
        dirty = true;
        stats.fetched++;

        if (stats.fetched % 50 === 0) {
          log(
            `Progress: ${stats.fetched}/${filings.length} fetched, ${stats.errors} errors`,
            workerId,
          );
        }
      } else {
        progress.errors.push({
          filing_no: filingNo,
          error: result.error.slice(0, 200),
          at: new Date().toISOString(),
        });
        progress.stats.totalErrors++;
        dirty = true;
        stats.errors++;
      }

      await randomDelay(BETWEEN_REQUESTS_MIN, BETWEEN_REQUESTS_MAX);
    }
  } finally {
    await browser.close();
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  progress = loadProgress();

  const unfetched = Object.entries(progress.discoveredFilings)
    .filter(([, v]) => v === false)
    .map(([k]) => k);

  log(`=== NCLT Fetch-Only Mode ===`);
  log(`Unfetched filings: ${unfetched.length}`);
  log(`Workers: ${NUM_WORKERS}`);
  log(`Items per worker: ~${Math.ceil(unfetched.length / NUM_WORKERS)}`);

  if (unfetched.length === 0) {
    log('Nothing to fetch!');
    return;
  }

  const shutdownFlag = { value: false };
  process.on('SIGINT', () => {
    shutdownFlag.value = true;
    log('Shutting down...');
  });
  process.on('SIGTERM', () => {
    shutdownFlag.value = true;
  });

  // Distribute evenly
  const workerQueues: string[][] = Array.from({ length: NUM_WORKERS }, () => []);
  for (let i = 0; i < unfetched.length; i++) {
    workerQueues[i % NUM_WORKERS].push(unfetched[i]);
  }

  // Flush progress every 5s
  const flushTimer = setInterval(flushProgress, 5000);

  // Progress logging every 10s
  const progressTimer = setInterval(() => {
    const totalDone = Object.values(progress.discoveredFilings).filter((v) => v === true).length;
    const remaining = Object.values(progress.discoveredFilings).filter((v) => v === false).length;
    log(
      `--- ${totalDone} fetched, ${remaining} remaining, ${progress.stats.totalErrors} errors ---`,
    );
  }, 10000);

  const activeWorkers = workerQueues.filter((q) => q.length > 0);
  log(`Launching ${activeWorkers.length} workers...\n`);

  const results = await Promise.all(
    workerQueues.map((queue, idx) => {
      if (queue.length === 0) return Promise.resolve({ fetched: 0, errors: 0 });
      return runFetchWorker(idx, queue, shutdownFlag).catch((err) => {
        log(`Worker ${idx} crashed: ${err.message}`, idx);
        return { fetched: 0, errors: queue.length };
      });
    }),
  );

  clearInterval(flushTimer);
  clearInterval(progressTimer);
  flushProgress();

  const totals = results.reduce(
    (acc, r) => ({ fetched: acc.fetched + r.fetched, errors: acc.errors + r.errors }),
    { fetched: 0, errors: 0 },
  );

  log('');
  log('=== FETCH COMPLETE ===');
  log(`Fetched: ${totals.fetched}, Errors: ${totals.errors}`);
  log(
    `Total in progress: ${progress.stats.totalDetailsFetched} fetched, ${progress.stats.totalDiscovered} discovered`,
  );

  const remaining = Object.values(progress.discoveredFilings).filter((v) => v === false).length;
  if (remaining > 0) {
    log(`Still unfetched: ${remaining} (from errors)`);
  }
}

main().catch((err) => {
  flushProgress();
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
