/**
 * CAT (Central Administrative Tribunal) Scraper - v2 PER-BENCH BROWSE
 *
 * Primary source: catjudgements.nic.in (DSpace repository)
 * ~186,300+ final judgments across 39 benches (20 regular + 19 circuit)
 *
 * Two-phase scraper:
 *   Phase 1: Browse each bench's DSpace collection individually to collect
 *            metadata + PDF URLs. Multiple benches (BENCH_CONCURRENCY, default 4)
 *            are processed in parallel, each with its own page queue. All benches
 *            share a single global item queue for bounded server load.
 *   Phase 2: Download judgment PDFs in parallel with adaptive concurrency.
 *
 * v2 CHANGE: Switched from global browse to per-collection browse.
 * The global /browse?type=judgementdate endpoint has a DSpace-internal index
 * limit (~52K items). Per-collection browsing at
 * /handle/123456789/{handle}/browse?type=judgementdate bypasses this limit
 * and exposes ALL items in each collection independently. This increased
 * discoverable items from ~52K to 186K+.
 *
 * The DSpace site has NO CAPTCHA, NO authentication, NO rate limiting.
 * All endpoints return server-rendered HTML via simple GET requests.
 *
 * Usage:
 *   npx tsx scripts/cat-scraper.ts                     # Full run (all benches)
 *   npx tsx scripts/cat-scraper.ts --metadata-only     # Metadata collection only
 *   npx tsx scripts/cat-scraper.ts --download-only     # PDFs only (requires metadata)
 *   npx tsx scripts/cat-scraper.ts --test              # Test mode (100 items, 5 PDFs)
 *   npx tsx scripts/cat-scraper.ts --bench principal   # Single bench only
 *   npx tsx scripts/cat-scraper.ts --no-proxy          # Direct connection (no proxy)
 *
 * Resume: Re-running is safe. Completed benches are tracked in scrape-progress.json
 * and skipped automatically. Already-collected handle IDs are deduped via JSONL.
 *
 * Environment variables:
 *   BENCH_CONCURRENCY=4       Max benches processed in parallel (default: 4)
 *   PAGE_CONCURRENCY=15       Max concurrent browse page fetches per bench (default: 15)
 *   ITEM_CONCURRENCY=150      Max concurrent item metadata fetches globally (default: 150)
 *   PDF_CONCURRENCY=30        Max concurrent PDF downloads (default: 30)
 *   PAGE_SIZE=100             Items per browse page (default: 100)
 *   DELAY_MS=0                Delay between browse requests (default: 0)
 *   MAX_ITEMS=0               Limit items for testing (0=unlimited)
 *   MAX_PDFS=0                Limit PDFs for testing (0=unlimited)
 *   DATA_DIR=data/tribunals/cat  Output directory
 *
 * Proxy:
 *   Uses DataImpulse residential proxy by default (rotates IPs per request).
 *   Disable with --no-proxy flag.
 *   DATAIMPULSE_USERNAME=...  Proxy username
 *   DATAIMPULSE_PASSWORD=...  Proxy password
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import PQueue from 'p-queue';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://catjudgements.nic.in';

interface BenchConfig {
  name: string;
  slug: string;
  handle: string; // DSpace collection handle suffix
}

const BENCHES: BenchConfig[] = [
  // Regular Benches (19)
  { name: 'Principal Bench', slug: 'principal', handle: '43826' },
  { name: 'Ahmedabad Bench', slug: 'ahmedabad', handle: '43825' },
  { name: 'Allahabad Bench', slug: 'allahabad', handle: '43811' },
  { name: 'Bangalore Bench', slug: 'bangalore', handle: '60517' },
  { name: 'Chandigarh Bench', slug: 'chandigarh', handle: '43820' },
  { name: 'Chennai Bench', slug: 'chennai', handle: '66801' },
  { name: 'Cuttack Bench', slug: 'cuttack', handle: '66802' },
  { name: 'Ernakulam Bench', slug: 'ernakulam', handle: '43823' },
  { name: 'Guwahati Bench', slug: 'guwahati', handle: '66803' },
  { name: 'Hyderabad Bench', slug: 'hyderabad', handle: '66805' },
  { name: 'Jabalpur Bench', slug: 'jabalpur', handle: '66809' },
  { name: 'Jaipur Bench', slug: 'jaipur', handle: '66810' },
  { name: 'Jammu Bench', slug: 'jammu', handle: '151753' },
  { name: 'Jodhpur Bench', slug: 'jodhpur', handle: '66812' },
  { name: 'Kolkata Bench', slug: 'kolkata', handle: '43817' },
  { name: 'Lucknow Bench', slug: 'lucknow', handle: '66814' },
  { name: 'Mumbai Bench', slug: 'mumbai', handle: '43813' },
  { name: 'Patna Bench', slug: 'patna', handle: '66815' },
  { name: 'Srinagar Bench', slug: 'srinagar', handle: '66822' },
  // Circuit Benches (19)
  { name: 'Agartala Circuit Bench', slug: 'agartala', handle: '66800' },
  { name: 'Aizawl Circuit Bench', slug: 'aizawl', handle: '66823' },
  { name: 'Aurangabad Circuit Bench', slug: 'aurangabad', handle: '43814' },
  { name: 'Bilaspur Circuit Bench', slug: 'bilaspur', handle: '60518' },
  { name: 'Gangtok Circuit Bench', slug: 'gangtok', handle: '43819' },
  { name: 'Goa Circuit Bench', slug: 'goa', handle: '43815' },
  { name: 'Gwalior Circuit Bench', slug: 'gwalior', handle: '66804' },
  { name: 'Imphal Circuit Bench', slug: 'imphal', handle: '66806' },
  { name: 'Indore Circuit Bench', slug: 'indore', handle: '66807' },
  { name: 'Itanagar Circuit Bench', slug: 'itanagar', handle: '66808' },
  { name: 'Jammu Circuit Bench', slug: 'jammu-circuit', handle: '43821' },
  { name: 'Kohima Circuit Bench', slug: 'kohima', handle: '66813' },
  { name: 'Lakshadweep Circuit Bench', slug: 'lakshadweep', handle: '43824' },
  { name: 'Nagpur Circuit Bench', slug: 'nagpur', handle: '43816' },
  { name: 'Nainital Circuit Bench', slug: 'nainital', handle: '43812' },
  { name: 'Port Blair Circuit Bench', slug: 'port-blair', handle: '66816' },
  { name: 'Puducherry Circuit Bench', slug: 'puducherry', handle: '66817' },
  { name: 'Ranchi Circuit Bench', slug: 'ranchi', handle: '66818' },
  { name: 'Shillong Circuit Bench', slug: 'shillong', handle: '66819' },
  { name: 'Shimla Circuit Bench', slug: 'shimla', handle: '66821' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface CatJudgment {
  handle_id: string;
  judgment_date: string;
  case_type: string;
  case_number: string;
  case_year: string;
  judge_name: string;
  petitioner: string;
  respondent: string;
  bench_name: string;
  bench_slug: string;
  pdf_url: string;
  pdf_filename: string;
  source_url: string;
  tribunal: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  metadata: {
    last_offset: number;
    total_collected: number;
    completed_benches: string[];
  };
  pdfs: {
    downloaded: number;
    failed: number;
    skipped: number;
  };
  last_updated: string;
}

interface DownloadResult {
  success: boolean;
  permanent: boolean; // true = don't retry (404, invalid PDF)
  error?: string;
  bytes?: number;
}

interface FailedDownload {
  handle_id: string;
  pdf_url: string;
  error: string;
  attempts: number;
  permanent: boolean;
  last_attempt: string;
}

// ─── Environment ─────────────────────────────────────────────────────────────

const PAGE_CONCURRENCY = parseInt(process.env.PAGE_CONCURRENCY || '15', 10);
const ITEM_CONCURRENCY = parseInt(process.env.ITEM_CONCURRENCY || '150', 10);
const BENCH_CONCURRENCY = parseInt(process.env.BENCH_CONCURRENCY || '4', 10);
const PDF_CONCURRENCY = parseInt(process.env.PDF_CONCURRENCY || '30', 10);
const PAGE_SIZE = parseInt(process.env.PAGE_SIZE || '100', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '0', 10);
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS || '0', 10);
const MAX_PDFS = parseInt(process.env.MAX_PDFS || '0', 10);
// ESTIMATED_TOTAL removed in v2 — per-bench browsing gets actual counts from DSpace
const DATA_DIR = process.env.DATA_DIR || 'data/tribunals/cat';

// CLI args
const args = process.argv.slice(2);
const METADATA_ONLY = args.includes('--metadata-only');
const DOWNLOAD_ONLY = args.includes('--download-only');
const TEST_MODE = args.includes('--test');
const NO_PROXY = args.includes('--no-proxy');
const BENCH_FILTER = (() => {
  const idx = args.indexOf('--bench');
  return idx >= 0 && args[idx + 1] ? args[idx + 1].toLowerCase() : null;
})();
// --start-offset removed in v2 — resume is now handled per-bench via completed_benches in progress file

const EFFECTIVE_MAX_ITEMS = TEST_MODE ? 100 : MAX_ITEMS;
const EFFECTIVE_MAX_PDFS = TEST_MODE ? 5 : MAX_PDFS;

// ─── Proxy Configuration ────────────────────────────────────────────────────

const PROXY_USER = process.env.DATAIMPULSE_USERNAME || '';
const PROXY_PASS = process.env.DATAIMPULSE_PASSWORD || '';
const PROXY_HOST = 'gw.dataimpulse.com';
const PROXY_PORT = 823;
const PROXY_URL = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;

let proxyAgent: HttpsProxyAgent<string> | undefined;
if (!NO_PROXY) {
  proxyAgent = new HttpsProxyAgent(PROXY_URL);
}

// ─── Directories ─────────────────────────────────────────────────────────────

const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const COMBINED_JSONL = path.join(DATA_DIR, 'cat-all-metadata.jsonl');

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Progress tracking ───────────────────────────────────────────────────────

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    metadata: { last_offset: 0, total_collected: 0, completed_benches: [] },
    pdfs: { downloaded: 0, failed: 0, skipped: 0 },
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

function createClient(useProxy: boolean): AxiosInstance {
  const config: Record<string, any> = {
    timeout: 20000, // 20s — most good requests finish in 5-10s, 45s wasted slots
    maxRedirects: 5,
    validateStatus: (status: number) => status < 500,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  };

  if (useProxy && proxyAgent) {
    config.httpAgent = proxyAgent;
    config.httpsAgent = proxyAgent;
    config.proxy = false;
  }

  return axios.create(config);
}

// Two clients: proxy (fast, IP-rotated) and direct (slower, single IP, for overflow)
const proxyClient = createClient(true);
const directClient = createClient(false);

// 100% proxy for max throughput — direct requests cause stalls when server throttles single IPs
const requestCounter = 0;
function getClient(): AxiosInstance {
  if (NO_PROXY) return directClient;
  return proxyClient;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

const stats = {
  pagesProcessed: 0,
  pagesEmpty: 0,
  itemsNew: 0,
  itemsSkipped: 0,
  itemsFailed: 0,
  proxyOk: 0,
  proxyFail: 0,
};

// ─── DSpace browse page parser ───────────────────────────────────────────────

// Return type: { handles, error, totalItems } to distinguish empty pages from errors
interface BrowseResult {
  handles: string[];
  error: boolean;
  totalItems?: number; // Extracted from "Showing results X to Y of Z" on the page
}

/**
 * Fetch a single browse page from DSpace.
 *
 * CRITICAL FIX (v2): Now accepts an optional `collectionHandle` param to browse
 * within a specific bench's collection rather than the global browse index.
 *
 * Why this matters:
 * The global browse endpoint (/browse?type=judgementdate) has a DSpace-internal
 * index limit that caps results at ~52K items, even though the repository contains
 * 186K+ judgments. Per-collection browsing (/handle/123456789/{handle}/browse)
 * bypasses this limit because each collection maintains its own independent browse
 * index. For example, Principal Bench alone has 81,719 items that are fully
 * accessible via its collection browse but were mostly invisible in the global view.
 */
async function fetchBrowsePage(
  offset: number,
  collectionHandle?: string,
  retries: number = 5,
): Promise<BrowseResult> {
  // Per-collection browse URL when a handle is provided, otherwise fall back to global
  const url = collectionHandle
    ? `${BASE_URL}/handle/123456789/${collectionHandle}/browse?type=judgementdate&sort_by=2&order=DESC&rpp=${PAGE_SIZE}&etal=-1&offset=${offset}`
    : `${BASE_URL}/browse?type=judgementdate&sort_by=2&order=DESC&rpp=${PAGE_SIZE}&etal=-1&offset=${offset}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const c = getClient();
      const response = await c.get(url);
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      stats.proxyOk++;

      const $ = cheerio.load(response.data);

      // Extract total item count from "Showing results 1 to 100 of 81719"
      let totalItems: number | undefined;
      const bodyText = $('body').text();
      const totalMatch = bodyText.match(/Showing results \d+ to \d+ of (\d+)/);
      if (totalMatch) {
        totalItems = parseInt(totalMatch[1], 10);
      }

      // Extract handle IDs from links like /handle/123456789/185037
      // Exclude the collection handle itself (it appears in breadcrumb/nav links)
      const handles: string[] = [];
      $('a[href*="/handle/123456789/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const match = href.match(/\/handle\/123456789\/(\d+)/);
        if (match && !handles.includes(match[1])) {
          // Skip the collection handle — it's a nav link, not a judgment item
          if (collectionHandle && match[1] === collectionHandle) return;
          handles.push(match[1]);
        }
      });

      return { handles, error: false, totalItems };
    } catch (err: any) {
      stats.proxyFail++;
      if (attempt === retries) {
        log(`  ERROR browse offset=${offset}: ${err.message}`);
        return { handles: [], error: true }; // Mark as error, NOT empty
      }
      await sleep(200 * attempt); // fast retries
    }
  }
  return { handles: [], error: true };
}

/**
 * Fetch the total number of items in a bench's DSpace collection.
 * Uses a minimal request (rpp=1) to extract "Showing results 1 to 1 of N".
 */
async function fetchBenchItemCount(collectionHandle: string, retries: number = 3): Promise<number> {
  const url = `${BASE_URL}/handle/123456789/${collectionHandle}/browse?type=judgementdate&sort_by=2&order=DESC&rpp=1&etal=-1&offset=0`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const c = getClient();
      const response = await c.get(url);
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

      const $ = cheerio.load(response.data);
      const bodyText = $('body').text();
      const match = bodyText.match(/Showing results \d+ to \d+ of (\d+)/);
      if (match) return parseInt(match[1], 10);
      return 0;
    } catch {
      if (attempt === retries) return 0;
      await sleep(300 * attempt);
    }
  }
  return 0;
}

// ─── Item page parser ────────────────────────────────────────────────────────

async function fetchItemMetadata(
  handleId: string,
  retries: number = 5,
): Promise<CatJudgment | null> {
  const url = `${BASE_URL}/handle/123456789/${handleId}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const c = getClient();
      const response = await c.get(url);
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      stats.proxyOk++;

      const $ = cheerio.load(response.data);

      // Extract metadata from <meta> tags and table cells
      const metaFields: Record<string, string> = {};

      // Meta tags
      const dcDate = $('meta[name="DC.date"]').attr('content') || '';
      const dcIdentifier = $('meta[name="DC.identifier"]').attr('content') || '';
      const pdfUrl = $('meta[name="citation_pdf_url"]').attr('content') || '';

      // Table-based metadata
      $('td.metadataFieldLabel').each((_, el) => {
        const label = $(el)
          .text()
          .replace(/[:\s]+$/g, '')
          .trim();
        const value = $(el).next('td.metadataFieldValue').text().trim();
        if (label && value) {
          metaFields[label] = value;
        }
      });

      // Extract PDF link from bitstream table
      let actualPdfUrl = pdfUrl;
      let pdfFilename = '';
      $('a[href*="/bitstream/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href.endsWith('.pdf')) {
          actualPdfUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
          pdfFilename = href.split('/').pop() || '';
        }
      });

      if (!actualPdfUrl) {
        return null; // no PDF = skip
      }

      // Normalize PDF URL to https
      actualPdfUrl = actualPdfUrl.replace('http://', 'https://');

      // Parse judgment date
      const rawDate = metaFields['Judgment Date'] || dcDate || '';
      const judgmentDate = normalizeDate(rawDate);

      const benchName = metaFields['Bench Name'] || dcIdentifier || '';
      const benchSlug = benchNameToSlug(benchName);

      return {
        handle_id: handleId,
        judgment_date: judgmentDate,
        case_type: metaFields['Case Type'] || '',
        case_number: metaFields['Case Number'] || '',
        case_year: metaFields['Case Year'] || '',
        judge_name: metaFields['Judge Name'] || '',
        petitioner: metaFields['Petitioner Name'] || '',
        respondent: metaFields['Respondent Name'] || '',
        bench_name: benchName,
        bench_slug: benchSlug,
        pdf_url: actualPdfUrl,
        pdf_filename: pdfFilename,
        source_url: url,
        tribunal: 'CAT',
        country: 'IN',
        scraped_at: new Date().toISOString(),
      };
    } catch (err: any) {
      stats.proxyFail++;
      if (attempt === retries) {
        return null;
      }
      // Linear backoff: 300ms, 600ms, 900ms, 1.2s, 1.5s — enough to avoid bursts
      await sleep(300 * attempt);
    }
  }
  return null;
}

// ─── Phase 1: Metadata collection (HIGH SPEED, PER-BENCH) ──────────────────

/**
 * REWRITTEN in v2 to use per-collection browsing instead of global browse.
 *
 * Previous approach (v1):
 *   Crawled /browse?type=judgementdate globally across all benches.
 *   Problem: DSpace's global browse index has an internal limit (~52K items).
 *   Result: Only 51,834 out of 186K+ judgments were discovered.
 *
 * New approach (v2):
 *   Iterates through each of the 39 benches individually, using per-collection
 *   browse URLs like /handle/123456789/{handle}/browse?type=judgementdate.
 *   Each collection's browse index is independent and complete, so we get ALL
 *   items. The scraper first probes each bench for its total item count, then
 *   generates all page offsets and processes them in parallel.
 *
 *   Benches are processed sequentially (one at a time) to make progress tracking
 *   simple and resumable. Within each bench, page and item fetches run in parallel
 *   at high concurrency for speed.
 */
async function collectMetadataByBrowse(progress: Progress): Promise<CatJudgment[]> {
  log('═══ PHASE 1: METADATA COLLECTION (PER-BENCH BROWSE) ═══');

  // Load already-collected handle IDs from JSONL for dedup
  const existingHandles = new Set<string>();
  if (fs.existsSync(COMBINED_JSONL)) {
    const lines = fs.readFileSync(COMBINED_JSONL, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.handle_id) existingHandles.add(item.handle_id);
      } catch {
        // skip malformed
      }
    }
    log(`  Loaded ${existingHandles.size} existing handles from JSONL`);
  }

  // Determine which benches to process
  const benchesToProcess = BENCH_FILTER
    ? BENCHES.filter((b) => b.slug === BENCH_FILTER || b.name.toLowerCase().includes(BENCH_FILTER!))
    : BENCHES;

  if (benchesToProcess.length === 0) {
    log(`  ERROR: No benches match filter '${BENCH_FILTER}'`);
    return [];
  }

  log(`  Benches to process: ${benchesToProcess.length}`);
  log(`  Bench concurrency: ${BENCH_CONCURRENCY} (parallel benches)`);
  log(`  Page concurrency: ${PAGE_CONCURRENCY} (per bench)`);
  log(`  Item concurrency: ${ITEM_CONCURRENCY} (global shared pool)`);
  if (EFFECTIVE_MAX_ITEMS > 0) {
    log(`  Max items: ${EFFECTIVE_MAX_ITEMS}`);
  }

  // Probe all benches for their item counts (parallel, fast — uses rpp=1)
  log('\n  Probing bench item counts...');
  const benchCounts: Array<{ bench: BenchConfig; total: number }> = [];
  let grandTotal = 0;
  await Promise.all(
    benchesToProcess.map(async (bench) => {
      const total = await fetchBenchItemCount(bench.handle);
      benchCounts.push({ bench, total });
      grandTotal += total;
    }),
  );
  // Sort by item count descending so largest benches are processed first
  benchCounts.sort((a, b) => b.total - a.total);

  log(
    `\n  Bench item counts (${benchCounts.length} benches, ${grandTotal.toLocaleString()} total):`,
  );
  for (const { bench, total } of benchCounts) {
    const done = progress.metadata.completed_benches.includes(bench.slug);
    log(`    ${bench.name} (${bench.slug}): ${total.toLocaleString()}${done ? ' [DONE]' : ''}`);
  }

  // Open JSONL for appending
  const jsonlFd = fs.openSync(COMBINED_JSONL, 'a');
  const allRecords: CatJudgment[] = [];
  const startTime = Date.now();

  // GLOBAL shared item queue — all benches share this pool so total concurrency
  // to the DSpace server stays bounded regardless of how many benches run in parallel.
  const globalItemQueue = new PQueue({ concurrency: ITEM_CONCURRENCY });

  // Adaptive concurrency on the global item queue: monitors failure rate every 60s.
  // Uses a tight band to avoid the oscillation that killed throughput in earlier runs.
  // Only reduces on sustained high failure rate (>50/min), ramps up slowly (+5).
  let lastFailCount = 0;
  const MIN_CONCURRENCY = Math.max(20, Math.floor(ITEM_CONCURRENCY * 0.5));
  const adaptiveInterval = setInterval(() => {
    const newFails = stats.itemsFailed - lastFailCount;
    if (newFails > 50) {
      // Severe throttling — reduce by 25% but stay above floor
      const newConc = Math.max(MIN_CONCURRENCY, Math.floor(globalItemQueue.concurrency * 0.75));
      if (newConc < globalItemQueue.concurrency) {
        log(
          `  ⚠ ${newFails} failures in 60s — concurrency ${globalItemQueue.concurrency} → ${newConc}`,
        );
        globalItemQueue.concurrency = newConc;
      }
    } else if (newFails <= 5 && globalItemQueue.concurrency < ITEM_CONCURRENCY) {
      // Almost no failures — ramp up slowly
      const newConc = Math.min(ITEM_CONCURRENCY, globalItemQueue.concurrency + 5);
      log(`  ✓ Stable — concurrency ${globalItemQueue.concurrency} → ${newConc}`);
      globalItemQueue.concurrency = newConc;
    }
    lastFailCount = stats.itemsFailed;
  }, 60_000);

  // Filter out benches that are already done or have 0 items
  const activeBenches: Array<{ bench: BenchConfig; total: number }> = [];
  for (const { bench, total } of benchCounts) {
    if (progress.metadata.completed_benches.includes(bench.slug)) {
      log(`\n  Skipping ${bench.name} (${bench.slug}) — already completed`);
      continue;
    }
    if (total === 0) {
      log(`\n  Skipping ${bench.name} (${bench.slug}) — 0 items`);
      progress.metadata.completed_benches.push(bench.slug);
      saveProgress(progress);
      continue;
    }
    activeBenches.push({ bench, total });
  }

  log(`\n  Active benches: ${activeBenches.length} | Parallel: ${BENCH_CONCURRENCY}`);

  // Per-bench stats tracking for the progress logger
  const benchStats = new Map<
    string,
    { new: number; skipped: number; pageErrors: number; start: number }
  >();

  // Global progress logger — shows all active benches + overall stats
  const globalLogInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = stats.itemsNew / Math.max(elapsed, 1);
    const globalQueued = globalItemQueue.size + globalItemQueue.pending;

    // Show overall stats
    log(
      `  [GLOBAL] New: ${stats.itemsNew} (${(rate * 60).toFixed(0)}/min) | ` +
        `Skip: ${stats.itemsSkipped} | Fail: ${stats.itemsFailed} | ` +
        `Conc: ${globalItemQueue.concurrency} | ` +
        `Queued: ${globalQueued} items | ` +
        `Total: ${existingHandles.size}`,
    );

    progress.metadata.total_collected = existingHandles.size;
    saveProgress(progress);
  }, 10_000);

  // Process benches in parallel using a bench-level queue.
  // Each bench gets its own page queue but shares the global item queue.
  const benchQueue = new PQueue({ concurrency: BENCH_CONCURRENCY });

  for (const { bench, total } of activeBenches) {
    benchQueue.add(async () => {
      if (EFFECTIVE_MAX_ITEMS > 0 && stats.itemsNew >= EFFECTIVE_MAX_ITEMS) return;

      log(`\n  ─── START ${bench.name} (${bench.slug}): ${total.toLocaleString()} items ───`);

      const offsets: number[] = [];
      for (let o = 0; o < total; o += PAGE_SIZE) {
        offsets.push(o);
      }

      // Each bench gets its own page queue — pages are independent per-collection
      const pageQueue = new PQueue({ concurrency: PAGE_CONCURRENCY });

      const bs = { new: 0, skipped: 0, pageErrors: 0, start: Date.now() };
      benchStats.set(bench.slug, bs);

      // Process all pages for this bench
      for (const offset of offsets) {
        if (EFFECTIVE_MAX_ITEMS > 0 && stats.itemsNew >= EFFECTIVE_MAX_ITEMS) break;

        pageQueue.add(async () => {
          const result = await fetchBrowsePage(offset, bench.handle);
          stats.pagesProcessed++;

          if (result.error) {
            bs.pageErrors++;
            return;
          }

          if (result.handles.length === 0) {
            stats.pagesEmpty++;
            return;
          }

          const newHandles = result.handles.filter((h) => !existingHandles.has(h));
          const skipped = result.handles.length - newHandles.length;
          bs.skipped += skipped;
          stats.itemsSkipped += skipped;

          if (newHandles.length === 0) return;

          // Queue item metadata fetches into the GLOBAL shared item queue
          for (const handleId of newHandles) {
            existingHandles.add(handleId);

            globalItemQueue.add(async () => {
              if (EFFECTIVE_MAX_ITEMS > 0 && stats.itemsNew >= EFFECTIVE_MAX_ITEMS) return;

              const judgment = await fetchItemMetadata(handleId);
              if (judgment) {
                allRecords.push(judgment);
                stats.itemsNew++;
                bs.new++;
                fs.writeSync(jsonlFd, JSON.stringify(judgment) + '\n');
              } else {
                stats.itemsFailed++;
                existingHandles.delete(handleId);
              }
            });
          }

          if (DELAY_MS > 0) {
            await sleep(DELAY_MS);
          }
        });
      }

      // Wait for this bench's pages to finish discovering handles
      await pageQueue.onIdle();
      log(
        `    [${bench.slug}] All ${offsets.length} pages done (${bs.pageErrors} err). Items queued into global pool.`,
      );

      // DON'T wait for global item queue here — other benches are feeding it too.
      // Instead, snapshot how many items this bench has queued and track completion.
      // We mark bench complete after ALL global items drain (at the end).
    });
  }

  // Wait for all benches to finish page discovery
  await benchQueue.onIdle();
  log(
    `\n  All bench page discovery complete. Draining ${globalItemQueue.size + globalItemQueue.pending} global item fetches...`,
  );

  // Now wait for all item fetches to complete across all benches
  await globalItemQueue.onIdle();

  clearInterval(globalLogInterval);
  clearInterval(adaptiveInterval);

  // Mark all active benches as completed (their items are all processed now)
  for (const { bench } of activeBenches) {
    if (!progress.metadata.completed_benches.includes(bench.slug)) {
      progress.metadata.completed_benches.push(bench.slug);
    }
    const bs = benchStats.get(bench.slug);
    if (bs) {
      const elapsed = ((Date.now() - bs.start) / 1000 / 60).toFixed(1);
      log(`    [${bench.slug}] Done: ${bs.new} new + ${bs.skipped} skipped in ${elapsed} min`);
    }
  }

  fs.closeSync(jsonlFd);

  progress.metadata.total_collected = existingHandles.size;
  saveProgress(progress);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(
    `\n  Metadata complete: ${stats.itemsNew} new + ${stats.itemsSkipped} skipped ` +
      `= ${existingHandles.size} total | ${stats.pagesProcessed} pages in ${elapsed} min`,
  );

  return allRecords;
}

// ─── Phase 2: PDF download (fault-tolerant, high-throughput) ─────────────────

// Shared HTTPS agent with connection pooling for all PDF downloads
const pdfAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 600, // headroom above max workers (500)
  maxFreeSockets: 100,
  timeout: 90000,
  scheduling: 'fifo',
});

// Dedicated axios client for PDF downloads — reuses connections
const pdfClient = axios.create({
  httpsAgent: pdfAgent,
  timeout: 60000,
  responseType: 'arraybuffer',
  maxRedirects: 5,
  maxContentLength: 100 * 1024 * 1024, // 100MB safety cap
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/pdf,*/*',
    'Accept-Encoding': 'gzip, deflate',
    Connection: 'keep-alive',
  },
  validateStatus: (status: number) => status >= 200 && status < 400,
});

/**
 * Classify whether an error is permanent (don't retry) or transient (retry).
 */
function classifyError(err: any): { permanent: boolean; label: string } {
  const status = err?.response?.status;
  const code = err?.code || '';

  // Permanent: resource doesn't exist or is forbidden content
  if (status === 404 || status === 410) {
    return { permanent: true, label: `HTTP ${status}` };
  }

  // Transient: server errors, rate limits, network issues
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return { permanent: false, label: `HTTP ${status}` };
  }
  if (status === 403) {
    return { permanent: false, label: 'HTTP 403 (possible IP block)' };
  }

  // Network-level transient errors
  if (
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ERR_SOCKET_TIMEOUT',
    ].includes(code)
  ) {
    return { permanent: false, label: code };
  }
  if (err?.message?.includes('socket hang up') || err?.message?.includes('timeout')) {
    return { permanent: false, label: 'socket/timeout' };
  }

  // Axios cancel / abort
  if (axios.isCancel(err)) {
    return { permanent: false, label: 'cancelled' };
  }

  // Unknown — treat as transient (give it a chance)
  return { permanent: false, label: `unknown: ${code || err?.message?.slice(0, 60)}` };
}

async function downloadPDF(judgment: CatJudgment, maxRetries: number = 5): Promise<DownloadResult> {
  const benchDir = path.join(PDFS_DIR, judgment.bench_slug || 'unknown');
  fs.mkdirSync(benchDir, { recursive: true });

  const filename = judgment.pdf_filename || `${judgment.handle_id}.pdf`;
  const outFile = path.join(benchDir, filename);
  const tmpFile = outFile + '.tmp';

  // Skip if already exists and non-empty
  if (fs.existsSync(outFile)) {
    try {
      const stat = fs.statSync(outFile);
      if (stat.size > 500) {
        return { success: true, permanent: false, bytes: stat.size };
      }
    } catch {
      // stat failed, re-download
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await pdfClient.get(judgment.pdf_url);

      const data = Buffer.from(response.data);

      // Too small — likely an error page, not a real PDF
      if (data.length < 500) {
        return { success: false, permanent: true, error: `too small (${data.length}B)` };
      }

      // Verify PDF magic bytes
      if (data.subarray(0, 5).toString() !== '%PDF-') {
        return { success: false, permanent: true, error: `not a PDF (${data.length}B)` };
      }

      // Atomic write: tmp → rename
      fs.writeFileSync(tmpFile, data);
      fs.renameSync(tmpFile, outFile);
      return { success: true, permanent: false, bytes: data.length };
    } catch (err: any) {
      const { permanent, label } = classifyError(err);

      // Clean up partial tmp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }

      // Permanent failure — don't retry
      if (permanent) {
        return { success: false, permanent: true, error: label };
      }

      // Last attempt exhausted
      if (attempt === maxRetries) {
        return { success: false, permanent: false, error: `${label} (${maxRetries} attempts)` };
      }

      // Fast exponential backoff: 200, 400, 800, 1600, 3200ms
      await sleep(200 * Math.pow(2, attempt - 1));
    }
  }
  return { success: false, permanent: false, error: 'exhausted retries' };
}

async function downloadAllPDFs(records: CatJudgment[], progress: Progress): Promise<void> {
  log('\n═══ PHASE 2: PDF DOWNLOAD (fault-tolerant engine) ═══');

  // Clean stale .tmp files from previous interrupted runs
  const cleanTmpFiles = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    let cleaned = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        cleanTmpFiles(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.tmp')) {
        try {
          fs.unlinkSync(path.join(dir, entry.name));
          cleaned++;
        } catch {
          /* ignore */
        }
      }
    }
    if (cleaned > 0) log(`  Cleaned ${cleaned} stale .tmp files in ${dir}`);
  };
  cleanTmpFiles(PDFS_DIR);

  // Deduplicate by handle_id
  const seen = new Set<string>();
  const unique = records.filter((r) => {
    if (seen.has(r.handle_id) || !r.pdf_url) return false;
    seen.add(r.handle_id);
    return true;
  });

  // Filter out already downloaded
  const toDownload = unique.filter((r) => {
    const benchDir = path.join(PDFS_DIR, r.bench_slug || 'unknown');
    const filename = r.pdf_filename || `${r.handle_id}.pdf`;
    const outFile = path.join(benchDir, filename);
    if (fs.existsSync(outFile)) {
      try {
        if (fs.statSync(outFile).size > 500) {
          progress.pdfs.skipped++;
          return false;
        }
      } catch {
        /* re-download */
      }
    }
    return true;
  });

  const limit =
    EFFECTIVE_MAX_PDFS > 0 ? Math.min(EFFECTIVE_MAX_PDFS, toDownload.length) : toDownload.length;
  const batch = toDownload.slice(0, limit);

  log(
    `  Total unique: ${unique.length}, Already downloaded: ${progress.pdfs.skipped}, To download: ${batch.length}`,
  );

  if (batch.length === 0) {
    log('  Nothing to download!');
    return;
  }

  // ─── Dynamic worker pool config ──────────────────────────────────────────
  const MAX_PDF_WORKERS = 500;
  const INITIAL_WORKERS = Math.min(100, batch.length); // start aggressive
  const FLOOR_WORKERS = 30;
  const SCALE_INTERVAL_MS = 10000;
  const ERROR_RATE_SCALE_UP = 0.05; // < 5% errors → scale up
  const ERROR_RATE_HOLD = 0.2; // 5-20% → hold steady
  // > 20% → scale down

  let currentConcurrency = INITIAL_WORKERS;
  const queue = new PQueue({ concurrency: currentConcurrency });

  // ─── Counters ────────────────────────────────────────────────────────────
  let completed = 0;
  let failed = 0;
  let permanentFails = 0;
  let totalBytes = 0;
  let recentFails = 0;
  let recentOks = 0;
  let peakWorkers = currentConcurrency;
  let lastCompletedCount = 0;
  let stallSeconds = 0;
  const startTime = Date.now();

  // EMA for rate calculation (smoothed over ~30s)
  let emaRate = 0;
  const EMA_ALPHA = 0.3;

  // ─── Dead letter queue ───────────────────────────────────────────────────
  const failedItems: Array<{ record: CatJudgment; error: string; permanent: boolean }> = [];
  const FAILED_LOG = path.join(DATA_DIR, 'failed-downloads.jsonl');

  const logFailedItem = (record: CatJudgment, error: string, permanent: boolean) => {
    const entry: FailedDownload = {
      handle_id: record.handle_id,
      pdf_url: record.pdf_url,
      error,
      attempts: 5,
      permanent,
      last_attempt: new Date().toISOString(),
    };
    try {
      fs.appendFileSync(FAILED_LOG, JSON.stringify(entry) + '\n');
    } catch {
      /* ignore */
    }
  };

  // ─── Worker scaling (ramp-up with backpressure) ──────────────────────────
  const scalingInterval = setInterval(() => {
    const total = recentFails + recentOks;
    const oldConcurrency = currentConcurrency;

    if (total === 0) {
      // No activity — could be warming up or stalled, don't change
      return;
    }

    const failRate = recentFails / total;

    if (failRate < ERROR_RATE_SCALE_UP && currentConcurrency < MAX_PDF_WORKERS) {
      // Low error rate → scale UP 20% (minimum +10 workers)
      const boost = Math.min(
        Math.max(Math.ceil(currentConcurrency * 0.2), 10),
        MAX_PDF_WORKERS - currentConcurrency,
      );
      currentConcurrency += boost;
      queue.concurrency = currentConcurrency;
    } else if (failRate > ERROR_RATE_HOLD) {
      // High error rate → scale DOWN 30% (server pushing back)
      currentConcurrency = Math.max(FLOOR_WORKERS, Math.floor(currentConcurrency * 0.7));
      queue.concurrency = currentConcurrency;
    }
    // Between 5-20% → hold steady (finding equilibrium)

    if (currentConcurrency > peakWorkers) peakWorkers = currentConcurrency;

    if (currentConcurrency !== oldConcurrency) {
      log(
        `  ⚡ Workers: ${oldConcurrency} → ${currentConcurrency} ` +
          `(${recentOks} ok, ${recentFails} fail, ${(failRate * 100).toFixed(1)}% err in window)`,
      );
    }

    recentFails = 0;
    recentOks = 0;
  }, SCALE_INTERVAL_MS);

  // ─── Progress logger (EMA rate + MB/s + stall detection) ────────────────
  const progressInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;

    // Instantaneous rate over last 5s
    const recentCompleted = completed - lastCompletedCount;
    const instantRate = recentCompleted / 5;

    // EMA smoothing
    emaRate = emaRate === 0 ? instantRate : EMA_ALPHA * instantRate + (1 - EMA_ALPHA) * emaRate;

    // Stall detection
    if (recentCompleted === 0) {
      stallSeconds += 5;
      if (stallSeconds >= 30) {
        log(
          `  ⚠️  STALL: No completions for ${stallSeconds}s (${queue.pending} pending, ${queue.size} queued)`,
        );
      }
    } else {
      stallSeconds = 0;
    }
    lastCompletedCount = completed;

    const remaining = batch.length - completed - failed;
    const etaMin = emaRate > 0 ? Math.round(remaining / emaRate / 60) : 999;
    const mbPerSec = (totalBytes / Math.max(elapsed, 1) / 1024 / 1024).toFixed(1);

    log(
      `  Progress: ${completed + failed}/${batch.length} (${completed} ok, ${failed} fail [${permanentFails} perm]) | ` +
        `${emaRate.toFixed(1)}/s ${mbPerSec}MB/s | Workers: ${currentConcurrency} | ETA: ${etaMin}m`,
    );
    saveProgress(progress);
  }, 5000);

  // ─── Queue all downloads ─────────────────────────────────────────────────
  const tasks = batch.map((record) =>
    queue.add(async () => {
      const result = await downloadPDF(record);
      if (result.success) {
        completed++;
        recentOks++;
        progress.pdfs.downloaded++;
        if (result.bytes) totalBytes += result.bytes;
      } else {
        failed++;
        recentFails++;
        progress.pdfs.failed++;
        if (result.permanent) permanentFails++;
        failedItems.push({ record, error: result.error || 'unknown', permanent: result.permanent });
        logFailedItem(record, result.error || 'unknown', result.permanent);
      }
    }),
  );

  await Promise.all(tasks);
  await queue.onIdle();
  clearInterval(scalingInterval);
  clearInterval(progressInterval);

  const mainTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(
    `\n  Main pass complete: ${completed} ok, ${failed} failed (${permanentFails} permanent) in ${mainTime} min`,
  );

  // ─── Retry sweep: re-attempt transient failures ──────────────────────────
  const transientFailures = failedItems.filter((f) => !f.permanent);
  if (transientFailures.length > 0) {
    log(`\n  ═══ RETRY SWEEP: ${transientFailures.length} transient failures ═══`);
    const retryQueue = new PQueue({ concurrency: Math.min(currentConcurrency, 200) });
    let retryOk = 0;
    let retryFail = 0;

    const retryTasks = transientFailures.map((item) =>
      retryQueue.add(async () => {
        // Give longer timeout for retry sweep
        const origTimeout = pdfClient.defaults.timeout;
        pdfClient.defaults.timeout = 120000;
        const result = await downloadPDF(item.record, 10); // 10 retries for sweep
        pdfClient.defaults.timeout = origTimeout;

        if (result.success) {
          retryOk++;
          completed++;
          failed--; // correct the main counter
          progress.pdfs.downloaded++;
          progress.pdfs.failed--;
          if (result.bytes) totalBytes += result.bytes;
        } else {
          retryFail++;
        }
      }),
    );

    await Promise.all(retryTasks);
    await retryQueue.onIdle();
    log(`  Retry sweep: ${retryOk} recovered, ${retryFail} still failed`);
  }

  // ─── Final summary ───────────────────────────────────────────────────────
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const totalMB = (totalBytes / 1024 / 1024).toFixed(0);
  log(
    `\n  ✅ PDF download complete: ${completed} downloaded (${totalMB} MB), ${failed} failed in ${totalTime} min`,
  );
  log(`  Peak workers: ${peakWorkers}, Final workers: ${currentConcurrency}`);
  if (failed > 0) {
    log(`  Failed items logged to: ${FAILED_LOG}`);
  }
  saveProgress(progress);

  // Cleanup agent
  pdfAgent.destroy();
}

// ─── Load existing metadata from disk ────────────────────────────────────────

function loadExistingMetadata(): CatJudgment[] {
  const records: CatJudgment[] = [];

  // Load from combined JSONL
  if (fs.existsSync(COMBINED_JSONL)) {
    const content = fs.readFileSync(COMBINED_JSONL, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return records;
  }

  // Fallback: load from individual JSON files
  if (fs.existsSync(METADATA_DIR)) {
    const files = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(METADATA_DIR, file), 'utf-8'));
        records.push(data);
      } catch {
        // skip
      }
    }
  }

  return records;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function normalizeDate(raw: string): string {
  // Handle formats: "21-Oct-2021", "2021-10-21", "21/10/2021"
  if (!raw) return '';

  // ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }

  // DD-Mon-YYYY
  const dmy = raw.match(/(\d{1,2})-(\w+)-(\d{4})/);
  if (dmy) {
    const months: Record<string, string> = {
      Jan: '01',
      Feb: '02',
      Mar: '03',
      Apr: '04',
      May: '05',
      Jun: '06',
      Jul: '07',
      Aug: '08',
      Sep: '09',
      Oct: '10',
      Nov: '11',
      Dec: '12',
    };
    const m = months[dmy[2]] || '01';
    return `${dmy[3]}-${m}-${dmy[1].padStart(2, '0')}`;
  }

  return raw;
}

function benchNameToSlug(name: string): string {
  if (!name) return 'unknown';
  const lower = name.toLowerCase().trim();

  // Try exact match first
  for (const bench of BENCHES) {
    if (lower.includes(bench.slug) || lower === bench.name.toLowerCase()) {
      return bench.slug;
    }
  }

  // Fuzzy match
  if (lower.includes('principal')) return 'principal';
  if (lower.includes('delhi') && !lower.includes('circuit')) return 'principal';
  if (lower.includes('bangaluru') || lower.includes('bangalore')) return 'bangalore';

  // Fallback: slugify
  return (
    lower
      .replace(/\s*(bench|circuit)\s*/gi, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'unknown'
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDirs();
  const progress = loadProgress();

  log('╔══════════════════════════════════════════════════════════╗');
  log('║   CAT JUDGMENT SCRAPER (DSpace) v2 - PER-BENCH BROWSE  ║');
  log('╚══════════════════════════════════════════════════════════╝');
  log(`  Source:              ${BASE_URL}`);
  log(`  Strategy:            Per-collection browse (v2 — bypasses global index limit)`);
  log(
    `  Proxy:               ${NO_PROXY ? 'DISABLED (direct)' : `${PROXY_HOST}:${PROXY_PORT} (DataImpulse)`}`,
  );
  log(`  Config:`);
  log(`    Page Concurrency:   ${PAGE_CONCURRENCY}`);
  log(`    Item Concurrency:   ${ITEM_CONCURRENCY}`);
  log(`    PDF Concurrency:    ${PDF_CONCURRENCY}`);
  log(`    Page Size:          ${PAGE_SIZE}`);
  log(`    Delay:              ${DELAY_MS}ms`);
  log(`    Bench Filter:       ${BENCH_FILTER || 'ALL (39)'}`);
  log(`    Test Mode:          ${TEST_MODE}`);
  log(`    Metadata Only:      ${METADATA_ONLY}`);
  log(`    Download Only:      ${DOWNLOAD_ONLY}`);
  log(`    Max Items:          ${EFFECTIVE_MAX_ITEMS || 'unlimited'}`);
  log(`    Max PDFs:           ${EFFECTIVE_MAX_PDFS || 'unlimited'}`);
  log(`    Data Dir:           ${DATA_DIR}`);
  log(`    Completed benches:  ${progress.metadata.completed_benches.length}`);
  log('');

  let records: CatJudgment[];

  if (DOWNLOAD_ONLY) {
    log('  Skipping metadata, loading from disk...');
    records = loadExistingMetadata();
    log(`  Loaded ${records.length} records from existing metadata`);
  } else {
    records = await collectMetadataByBrowse(progress);
  }

  // For download-only mode, apply bench filter to loaded records
  // (In metadata mode, filtering is handled inside collectMetadataByBrowse)
  if (DOWNLOAD_ONLY && BENCH_FILTER) {
    const before = records.length;
    records = records.filter(
      (r) => r.bench_slug === BENCH_FILTER || r.bench_name.toLowerCase().includes(BENCH_FILTER!),
    );
    log(`  Bench filter '${BENCH_FILTER}': ${before} → ${records.length} records`);
  }

  if (!METADATA_ONLY && records.length > 0) {
    await downloadAllPDFs(records, progress);
  }

  // Final summary
  log('\n╔══════════════════════════════════════════════════╗');
  log('║              SCRAPING COMPLETE                   ║');
  log('╚══════════════════════════════════════════════════╝');
  log(`  Total metadata records: ${records.length}`);
  log(`  PDFs downloaded:        ${progress.pdfs.downloaded}`);
  log(`  PDFs failed:            ${progress.pdfs.failed}`);
  log(`  PDFs skipped (existed): ${progress.pdfs.skipped}`);

  // Count files on disk
  if (fs.existsSync(PDFS_DIR)) {
    let totalPdfs = 0;
    const benchDirs = fs.readdirSync(PDFS_DIR);
    for (const dir of benchDirs) {
      const fullDir = path.join(PDFS_DIR, dir);
      if (fs.statSync(fullDir).isDirectory()) {
        const count = fs.readdirSync(fullDir).filter((f) => f.endsWith('.pdf')).length;
        totalPdfs += count;
        if (count > 0) log(`    ${dir}: ${count} PDFs`);
      }
    }
    log(`  Total PDFs on disk:     ${totalPdfs}`);
  }

  // Bench distribution
  const benchCounts: Record<string, number> = {};
  for (const r of records) {
    benchCounts[r.bench_name || r.bench_slug] =
      (benchCounts[r.bench_name || r.bench_slug] || 0) + 1;
  }
  if (Object.keys(benchCounts).length > 0) {
    log('\n  Bench distribution:');
    const sorted = Object.entries(benchCounts).sort((a, b) => b[1] - a[1]);
    for (const [bench, count] of sorted) {
      log(`    ${bench}: ${count}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
