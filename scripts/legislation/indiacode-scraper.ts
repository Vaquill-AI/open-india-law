/**
 * IndiaCode Scraper - https://www.indiacode.nic.in
 * Scrapes all Indian acts, laws, and subordinate legislation for RAG pipeline.
 *
 * Content inventory (~16,000+ acts):
 *   - Central Acts (active):   ~847     browse?type=shorttitle on handle/123456789/1362
 *   - Repealed Acts:           ~4,627   /repealed-act/repealed-act.jsp
 *   - Spent Acts:              ~14      /spent-act/spent-act.jsp
 *   - State/UT Acts:           ~10,460  36 state handles under /handle/123456789/2180
 *   - Constitution of India:   6+ handles
 *   - Subordinate Legislation: 100K+ PDFs per act (rules, regulations, notifications)
 *
 * Tech: DSpace 5.5, JSP backend, no WAF, no CAPTCHA, no rate limiting.
 * Custom AJAX API: /SectionPageContent returns JSON { content, footnote }.
 * PDFs: machine-readable (native text), dual hosting (bitstream + upload.indiacode.nic.in).
 *
 * Phases:
 *   Phase 1: Index all acts (browse pages, repealed, spent, state)
 *   Phase 2: Download PDFs + extract HTML sections per act
 *   Phase 3: Scrape subordinate legislation PDFs per act
 *
 * Proxy rotation: Oxylabs, DataImpulse (residential + datacenter), Webshare
 *
 * Usage:
 *   npx tsx scripts/indiacode-scraper.ts                             # Full run
 *   npx tsx scripts/indiacode-scraper.ts --phase index               # Index only
 *   npx tsx scripts/indiacode-scraper.ts --phase download            # Download PDFs only
 *   npx tsx scripts/indiacode-scraper.ts --phase subordinate         # Subordinate legislation
 *   npx tsx scripts/indiacode-scraper.ts --category central          # Central acts only
 *   npx tsx scripts/indiacode-scraper.ts --category repealed         # Repealed acts only
 *   npx tsx scripts/indiacode-scraper.ts --category state            # State acts only
 *   npx tsx scripts/indiacode-scraper.ts --state delhi               # Specific state
 *   npx tsx scripts/indiacode-scraper.ts --test                      # Test (5 acts)
 *   npx tsx scripts/indiacode-scraper.ts --no-proxy                  # Disable proxy
 *   MAX_CONCURRENT=15 npx tsx scripts/indiacode-scraper.ts           # Concurrency
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://www.indiacode.nic.in';
const UPLOAD_BASE = 'https://upload.indiacode.nic.in';
const DATA_DIR = path.resolve(__dirname, '../data/indiacode');
const INDEX_DIR = path.join(DATA_DIR, 'index');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const HTML_DIR = path.join(DATA_DIR, 'html');
const SUBORDINATE_DIR = path.join(DATA_DIR, 'subordinate');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

// With 4 proxy providers, we can safely run 12-15 concurrent requests
// (3-4 connections per proxy to avoid per-IP throttling)
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '12', 10);
const MAX_INDEX_CONCURRENT = parseInt(process.env.MAX_INDEX_CONCURRENT || '3', 10); // parallel state indexing
const DELAY_BETWEEN_REQUESTS_MS = 100; // minimal with proxies
const DELAY_DIRECT_MS = 800; // without proxies, be polite
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const RPP = 100; // results per page for browse
const PROGRESS_SAVE_INTERVAL_MS = 10_000; // save progress every 10s
const PROGRESS_LOG_INTERVAL = 25; // log every N completions

type ActCategory = 'central' | 'repealed' | 'spent' | 'state' | 'constitution';

// ---------------------------------------------------------------------------
// State/UT Registry (handle -> name mapping)
// ---------------------------------------------------------------------------

/**
 * Correct handle mapping extracted from /handle/123456789/2180 (States Community page).
 * Verified Feb 2026.
 */
const STATE_HANDLES: Record<string, string> = {
  // Central (not a state, but used for reference)
  '1362': 'central',
  '2180': 'states-community',
  // States
  '2486': 'andhra-pradesh',
  '2487': 'arunachal-pradesh',
  '2513': 'assam',
  '2488': 'bihar',
  '2490': 'chhattisgarh',
  '2514': 'goa',
  '2455': 'gujarat',
  '2193': 'haryana',
  '2494': 'himachal-pradesh',
  '2515': 'jharkhand',
  '2485': 'karnataka',
  '2516': 'kerala',
  '2497': 'madhya-pradesh',
  '2517': 'maharashtra',
  '2498': 'manipur',
  '2499': 'meghalaya',
  '2500': 'mizoram',
  '2501': 'nagaland',
  '2502': 'odisha',
  '2504': 'punjab',
  '2505': 'rajasthan',
  '2506': 'sikkim',
  '2507': 'tamil-nadu',
  '2508': 'telangana',
  '2509': 'tripura',
  '2510': 'uttar-pradesh',
  '2511': 'uttarakhand',
  '2512': 'west-bengal',
  // Union Territories
  '2454': 'andaman-nicobar',
  '2489': 'chandigarh',
  '2492': 'dadra-nagar-haveli',
  '2493': 'delhi',
  '14011': 'ladakh',
  '2495': 'jammu-kashmir',
  '2496': 'lakshadweep',
  '2503': 'puducherry',
};

// Reverse lookup: state slug -> handle
const STATE_SLUG_TO_HANDLE: Record<string, string> = {};
for (const [handle, slug] of Object.entries(STATE_HANDLES)) {
  STATE_SLUG_TO_HANDLE[slug] = handle;
}

const CONSTITUTION_HANDLES = ['16124', '19150', '19632', '10531', '15240', '19151'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActEntry {
  actId: string;
  title: string;
  year: string;
  actNumber: string;
  category: ActCategory;
  state: string;
  handle: string;
  sourceUrl: string;
  pdfUrl: string;
  department: string;
  ministry: string;
  enactmentDate: string;
  pdfDownloaded: boolean;
  htmlExtracted: boolean;
  sectionCount: number;
  subordinateCount: number;
  repealedFileRef: string;
}

interface Progress {
  phase: string;
  indexCompleted: ActCategory[];
  statesIndexed: string[];
  pdfDownloaded: string[]; // actId list - serialized as array, loaded as Set
  htmlExtracted: string[];
  subordinateScraped: string[];
  totalActs: number;
  totalPdfs: number;
  totalHtml: number;
  errors: { actId: string; phase: string; error: string; timestamp: string }[];
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Semaphore (worker pool concurrency limiter)
// ---------------------------------------------------------------------------

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }
}

// ---------------------------------------------------------------------------
// ETA Tracker
// ---------------------------------------------------------------------------

class ETATracker {
  private startTime: number;
  private completed = 0;
  private total: number;
  private bytesDownloaded = 0;
  private windowStart: number;
  private windowCompleted = 0;
  private readonly WINDOW_MS = 30_000; // 30-second rolling window for speed calc

  constructor(total: number) {
    this.total = total;
    this.startTime = Date.now();
    this.windowStart = Date.now();
  }

  tick(bytes = 0): void {
    this.completed++;
    this.bytesDownloaded += bytes;
    this.windowCompleted++;

    // Reset window periodically for accurate recent speed
    const now = Date.now();
    if (now - this.windowStart > this.WINDOW_MS) {
      this.windowStart = now;
      this.windowCompleted = 0;
    }
  }

  setTotal(total: number): void {
    this.total = total;
  }

  get pct(): string {
    if (this.total === 0) return '0.0%';
    return ((this.completed / this.total) * 100).toFixed(1) + '%';
  }

  get eta(): string {
    if (this.completed === 0) return 'calculating...';
    const elapsed = Date.now() - this.startTime;
    const avgMs = elapsed / this.completed;
    const remaining = this.total - this.completed;
    const etaMs = avgMs * remaining;
    return formatDuration(etaMs);
  }

  get speed(): string {
    const elapsed = Date.now() - this.startTime;
    if (elapsed < 1000) return '...';
    const perMin = (this.completed / elapsed) * 60_000;
    return `${perMin.toFixed(1)}/min`;
  }

  get mbDownloaded(): string {
    return (this.bytesDownloaded / (1024 * 1024)).toFixed(1);
  }

  get mbPerSec(): string {
    const elapsed = (Date.now() - this.startTime) / 1000;
    if (elapsed < 1) return '...';
    const mbps = this.bytesDownloaded / (1024 * 1024) / elapsed;
    return mbps.toFixed(2);
  }

  get count(): number {
    return this.completed;
  }

  formatProgress(extra = ''): string {
    const parts = [
      `[${this.pct}]`,
      `${this.completed}/${this.total}`,
      `speed=${this.speed}`,
      `ETA=${this.eta}`,
    ];
    if (this.bytesDownloaded > 0) {
      parts.push(`${this.mbDownloaded}MB (${this.mbPerSec} MB/s)`);
    }
    if (extra) parts.push(extra);
    return parts.join(' | ');
  }
}

function formatDuration(ms: number): string {
  if (ms < 0 || !isFinite(ms)) return 'unknown';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

// ---------------------------------------------------------------------------
// Proxy System
// ---------------------------------------------------------------------------

interface ProxyConfig {
  name: string;
  url: string;
  type: 'residential' | 'datacenter';
  weight: number;
}

function buildProxyConfigs(noProxy: boolean): ProxyConfig[] {
  if (noProxy) return [];

  const configs: ProxyConfig[] = [];

  // 1. Oxylabs — DISABLED (quota exhausted)
  // configs.push({
  //   name: "oxylabs",
  //   url: `http://${PROXY_USER}:${PROXY_PASS}@pr.oxylabs.io:7777`,
  //   type: "residential",
  //   weight: 3,
  // });

  // 2. DataImpulse Residential
  const diResUser = process.env.DATAIMPULSE_USERNAME || '';
  const diResPass = process.env.DATAIMPULSE_PASSWORD || '';
  configs.push({
    name: 'dataimpulse-residential',
    url: `http://${diResUser}:${diResPass}@gw.dataimpulse.com:823`,
    type: 'residential',
    weight: 3,
  });

  // 3. DataImpulse Datacenter
  configs.push({
    name: 'dataimpulse-datacenter',
    url: `http://${PROXY_USER}:${PROXY_PASS}@gw.dataimpulse.com:823`,
    type: 'datacenter',
    weight: 2,
  });

  // 4. Webshare Residential
  configs.push({
    name: 'webshare',
    url: `http://${PROXY_USER}:${PROXY_PASS}@p.webshare.io:80`,
    type: 'residential',
    weight: 2,
  });

  return configs;
}

class ProxyRotator {
  private configs: ProxyConfig[];
  private currentIndex = 0;
  private failCounts: Map<string, number> = new Map();
  private successCounts: Map<string, number> = new Map();
  private disabled: boolean;
  // Cache agents to avoid re-creating per request
  private agentCache: Map<string, https.Agent | http.Agent> = new Map();

  constructor(configs: ProxyConfig[]) {
    this.configs = configs;
    this.disabled = configs.length === 0;
    // Pre-warm agent cache
    for (const config of configs) {
      try {
        const parsed = new URL(config.url);
        const isHttps = parsed.protocol === 'https:';
        const agent = isHttps ? new HttpsProxyAgent(config.url) : new HttpsProxyAgent(config.url); // HttpsProxyAgent works for HTTPS targets through HTTP proxies
        this.agentCache.set(config.name, agent);
      } catch {
        // skip
      }
    }
  }

  getNext(): ProxyConfig | null {
    if (this.disabled || this.configs.length === 0) return null;

    const maxAttempts = this.configs.length * 2;
    for (let i = 0; i < maxAttempts; i++) {
      const config = this.configs[this.currentIndex % this.configs.length];
      this.currentIndex++;

      const fails = this.failCounts.get(config.name) || 0;
      if (fails > 5) {
        if (i === this.configs.length - 1) {
          this.failCounts.clear();
        }
        continue;
      }

      return config;
    }

    this.failCounts.clear();
    return this.configs[0] || null;
  }

  reportSuccess(name: string): void {
    this.failCounts.set(name, 0);
    this.successCounts.set(name, (this.successCounts.get(name) || 0) + 1);
  }

  reportFailure(name: string): void {
    const current = this.failCounts.get(name) || 0;
    this.failCounts.set(name, current + 1);
  }

  getAgent(): { agent: https.Agent | http.Agent | undefined; proxyName: string } {
    const proxy = this.getNext();
    if (!proxy) return { agent: undefined, proxyName: 'direct' };
    const cached = this.agentCache.get(proxy.name);
    if (cached) return { agent: cached, proxyName: proxy.name };
    try {
      const agent = new HttpsProxyAgent(proxy.url);
      this.agentCache.set(proxy.name, agent);
      return { agent, proxyName: proxy.name };
    } catch {
      return { agent: undefined, proxyName: 'direct' };
    }
  }

  get isDisabled(): boolean {
    return this.disabled;
  }

  getStats(): string {
    if (this.disabled) return 'proxies=off';
    const parts: string[] = [];
    for (const config of this.configs) {
      const ok = this.successCounts.get(config.name) || 0;
      const fail = this.failCounts.get(config.name) || 0;
      parts.push(`${config.name}(${ok}ok/${fail}err)`);
    }
    return parts.join(', ');
  }

  get requestDelay(): number {
    return this.disabled ? DELAY_DIRECT_MS : DELAY_BETWEEN_REQUESTS_MS;
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;
let progressRef: Progress | null = null;
let progressDirty = false;

function setupShutdownHandler(): void {
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      console.log(`\n[${signal}] Force exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n[${signal}] Graceful shutdown... saving progress.`);
    if (progressRef && progressDirty) {
      saveProgressSync(progressRef);
      console.log('  Progress saved.');
    }
    console.log('  Exiting.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(text: string, maxLen = 80): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS
}

// ---------------------------------------------------------------------------
// Progress - Uses Sets internally, serializes as arrays
// ---------------------------------------------------------------------------

// Runtime sets for O(1) lookups
let pdfDownloadedSet: Set<string>;
let htmlExtractedSet: Set<string>;
let subordinateScrapedSet: Set<string>;
let statesIndexedSet: Set<string>;

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')) as Progress;
    // Hydrate sets from arrays
    pdfDownloadedSet = new Set(raw.pdfDownloaded);
    htmlExtractedSet = new Set(raw.htmlExtracted);
    subordinateScrapedSet = new Set(raw.subordinateScraped);
    statesIndexedSet = new Set(raw.statesIndexed);
    return raw;
  }
  pdfDownloadedSet = new Set();
  htmlExtractedSet = new Set();
  subordinateScrapedSet = new Set();
  statesIndexedSet = new Set();
  return {
    phase: '',
    indexCompleted: [],
    statesIndexed: [],
    pdfDownloaded: [],
    htmlExtracted: [],
    subordinateScraped: [],
    totalActs: 0,
    totalPdfs: 0,
    totalHtml: 0,
    errors: [],
    lastUpdated: new Date().toISOString(),
  };
}

function syncSetsToProgress(progress: Progress): void {
  progress.pdfDownloaded = [...pdfDownloadedSet];
  progress.htmlExtracted = [...htmlExtractedSet];
  progress.subordinateScraped = [...subordinateScrapedSet];
  progress.statesIndexed = [...statesIndexedSet];
}

function saveProgressSync(progress: Progress): void {
  syncSetsToProgress(progress);
  progress.lastUpdated = new Date().toISOString();
  // Write compact JSON (no pretty-print) - can be 100x smaller with 16K entries
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress));
  progressDirty = false;
}

// Debounced progress saver - saves at most every PROGRESS_SAVE_INTERVAL_MS
let lastProgressSave = 0;
function saveProgressDebounced(progress: Progress): void {
  progressDirty = true;
  const now = Date.now();
  if (now - lastProgressSave >= PROGRESS_SAVE_INTERVAL_MS) {
    saveProgressSync(progress);
    lastProgressSave = now;
  }
}

function markPdfDownloaded(actId: string): void {
  pdfDownloadedSet.add(actId);
  progressDirty = true;
}

function markHtmlExtracted(actId: string): void {
  htmlExtractedSet.add(actId);
  progressDirty = true;
}

function markSubordinateScraped(actId: string): void {
  subordinateScrapedSet.add(actId);
  progressDirty = true;
}

function markStateIndexed(slug: string): void {
  statesIndexedSet.add(slug);
  progressDirty = true;
}

function isPdfDownloaded(actId: string): boolean {
  return pdfDownloadedSet.has(actId);
}

function isHtmlExtracted(actId: string): boolean {
  return htmlExtractedSet.has(actId);
}

function isSubordinateScraped(actId: string): boolean {
  return subordinateScrapedSet.has(actId);
}

function isStateIndexed(slug: string): boolean {
  return statesIndexedSet.has(slug);
}

// ---------------------------------------------------------------------------
// Index file helpers
// ---------------------------------------------------------------------------

function loadIndex(category: ActCategory, state?: string): ActEntry[] {
  const filename = state ? `${category}-${state}.jsonl` : `${category}.jsonl`;
  const filepath = path.join(INDEX_DIR, filename);
  if (!fs.existsSync(filepath)) return [];
  return fs
    .readFileSync(filepath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendToIndex(entry: ActEntry, category: ActCategory, state?: string): void {
  const filename = state ? `${category}-${state}.jsonl` : `${category}.jsonl`;
  const filepath = path.join(INDEX_DIR, filename);
  fs.appendFileSync(filepath, JSON.stringify(entry) + '\n');
}

function loadAllIndexed(): ActEntry[] {
  const entries: ActEntry[] = [];
  if (!fs.existsSync(INDEX_DIR)) return entries;
  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    const filepath = path.join(INDEX_DIR, f);
    const lines = fs.readFileSync(filepath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// HTTP Client with Proxy Support
// ---------------------------------------------------------------------------

function httpGet(
  url: string,
  proxyRotator: ProxyRotator,
  options: {
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
    binary?: boolean;
  } = {},
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
  proxyName: string;
}> {
  const retries = options.retries ?? MAX_RETRIES;

  return (async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (shuttingDown) throw new Error('Shutting down');
      try {
        const result = await _doHttpGet(url, proxyRotator, options);
        if (result.status === 200 || result.status === 302) {
          proxyRotator.reportSuccess(result.proxyName);
          return result;
        }
        if (result.status >= 500 && attempt < retries) {
          proxyRotator.reportFailure(result.proxyName);
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        return result;
      } catch (err) {
        proxyRotator.reportFailure(proxyRotator.getAgent().proxyName);
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Max retries exceeded: ${url}`);
  })();
}

function _doHttpGet(
  url: string,
  proxyRotator: ProxyRotator,
  options: {
    headers?: Record<string, string>;
    timeout?: number;
    binary?: boolean;
  } = {},
): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
  proxyName: string;
}> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const { agent, proxyName } = proxyRotator.getAgent();

    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'identity',
        Connection: 'keep-alive',
        ...options.headers,
      },
      agent,
      timeout: options.timeout || 30000,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(reqOptions, (res) => {
      // Handle redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.host}${res.headers.location}`;
        res.resume();
        _doHttpGet(redirectUrl, proxyRotator, options).then(resolve).catch(reject);
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers as Record<string, string>,
          body: options.binary ? buffer : buffer.toString('utf-8'),
          proxyName,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
    req.end();
  });
}

/**
 * Download file with streaming write (doesn't buffer entire file in memory).
 */
function downloadFileStream(
  url: string,
  dest: string,
  proxyRotator: ProxyRotator,
  retries = MAX_RETRIES,
): Promise<{ ok: boolean; bytes: number }> {
  const dir = path.dirname(dest);
  ensureDir(dir);

  // Skip if already downloaded and non-empty
  if (fs.existsSync(dest)) {
    const size = fs.statSync(dest).size;
    if (size > 0) return Promise.resolve({ ok: true, bytes: size });
  }

  const tmpDest = `${dest}.tmp`;

  return (async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (shuttingDown) return { ok: false, bytes: 0 };
      try {
        const { agent, proxyName } = proxyRotator.getAgent();
        const bytes = await new Promise<number>((resolve, reject) => {
          const parsedUrl = new URL(url);
          const isHttps = parsedUrl.protocol === 'https:';
          const transport = isHttps ? https : http;

          const reqOptions: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
              Accept: '*/*',
              'Accept-Encoding': 'identity',
            },
            agent,
            timeout: 120000,
          };

          const req = transport.request(reqOptions, (res) => {
            // Handle redirects
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
              res.resume();
              const redirectUrl = res.headers.location.startsWith('http')
                ? res.headers.location
                : `${parsedUrl.protocol}//${parsedUrl.host}${res.headers.location}`;
              // Recursive call for redirect
              downloadFileStream(redirectUrl, dest, proxyRotator, 0)
                .then((r) => resolve(r.bytes))
                .catch(reject);
              return;
            }

            if (res.statusCode !== 200) {
              res.resume();
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }

            const ws = fs.createWriteStream(tmpDest);
            let totalBytes = 0;
            res.on('data', (chunk: Buffer) => {
              totalBytes += chunk.length;
            });
            res.pipe(ws);
            ws.on('finish', () => resolve(totalBytes));
            ws.on('error', reject);
            res.on('error', reject);
          });

          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout'));
          });
          req.end();
        });

        // After redirect, file may already be at dest (inner call handled rename)
        if (!fs.existsSync(tmpDest) && fs.existsSync(dest)) {
          const finalSize = fs.statSync(dest).size;
          if (finalSize > 0) {
            proxyRotator.reportSuccess(proxyName);
            return { ok: true, bytes: finalSize };
          }
        }

        if (bytes === 0) {
          if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
          if (attempt < retries) {
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          return { ok: false, bytes: 0 };
        }

        if (fs.existsSync(tmpDest)) {
          fs.renameSync(tmpDest, dest);
        }
        proxyRotator.reportSuccess(proxyName);
        return { ok: true, bytes };
      } catch (err) {
        if (fs.existsSync(tmpDest)) {
          try {
            fs.unlinkSync(tmpDest);
          } catch {
            // ignore
          }
        }
        proxyRotator.reportFailure(proxyRotator.getAgent().proxyName);
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
      }
    }
    return { ok: false, bytes: 0 };
  })();
}

// ---------------------------------------------------------------------------
// Phase 1: Index Acts
// ---------------------------------------------------------------------------

/**
 * Parse DSpace browse page HTML to extract act entries.
 *
 * Table structure (confirmed):
 *   <table summary="This table browses all dspace content">
 *     <tr>
 *       <td>11-Apr-1836</td>           <- Enactment Date
 *       <td><em>10</em></td>           <- Act Number
 *       <td><strong>Title</strong></td> <- Short Title
 *       <td><a href="/handle/123456789/XXXXX?view_type=browse">View...</a></td>
 *     </tr>
 */
function parseBrowsePage(
  html: string,
  category: ActCategory,
  stateSlug: string,
  handle: string,
): ActEntry[] {
  const entries: ActEntry[] = [];
  const seenIds = new Set<string>();

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[1];

    const viewMatch = row.match(/<a\s+href="(\/handle\/123456789\/(\d+)\?[^"]*)"[^>]*>View/i);
    if (!viewMatch) continue;

    const href = viewMatch[1];
    const actHandle = viewMatch[2];
    const actId = `IND_${category}_${actHandle}`;

    // O(1) dedup
    if (seenIds.has(actId)) continue;

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(cellMatch[1]);
    }

    const enactmentDate = cells[0] ? stripHtml(cells[0]).trim() : '';
    const actNumber = cells[1] ? stripHtml(cells[1]).trim() : '';
    const rawTitle = cells[2]
      ? stripHtml(cells[2])
          .replace(/&#x20;/g, ' ')
          .trim()
      : '';

    if (!rawTitle || rawTitle.length < 3) continue;

    const yearMatch = rawTitle.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
    const year = yearMatch ? yearMatch[1] : '';

    seenIds.add(actId);
    entries.push({
      actId,
      title: rawTitle,
      year,
      actNumber,
      category,
      state: stateSlug,
      handle: `123456789/${actHandle}`,
      sourceUrl: `${BASE_URL}${href}`,
      pdfUrl: '',
      department: '',
      ministry: '',
      enactmentDate,
      pdfDownloaded: false,
      htmlExtracted: false,
      sectionCount: 0,
      subordinateCount: 0,
      repealedFileRef: '',
    });
  }

  return entries;
}

/**
 * Parse repealed-act.jsp page (~4,627 entries).
 */
function parseRepealedPage(html: string): ActEntry[] {
  const entries: ActEntry[] = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[1];

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(cellMatch[1]);
    }

    if (cells.length < 3) continue;

    const slNo = stripHtml(cells[0]).trim();
    const name = stripHtml(cells[1]).trim();
    const year = stripHtml(cells[2]).trim();

    if (!slNo || !/^\d+$/.test(slNo)) continue;
    if (!name || name.length < 5) continue;

    const pdfMatch = row.match(/repealedfileopen\?rfilename=([^"&]+)/);
    const repealedFile = pdfMatch ? pdfMatch[1] : '';
    const pdfUrl = repealedFile ? `${BASE_URL}/repealedfileopen?rfilename=${repealedFile}` : '';

    const actNumMatch = name.match(/(\d+)\s+of\s+\d{4}/);
    const actNumber = actNumMatch ? actNumMatch[1] : '';

    entries.push({
      actId: `IND_REP_${slNo}_${year}`,
      title: name,
      year,
      actNumber,
      category: 'repealed',
      state: 'central',
      handle: '',
      sourceUrl: `${BASE_URL}/repealed-act/repealed-act.jsp`,
      pdfUrl,
      department: '',
      ministry: '',
      enactmentDate: '',
      pdfDownloaded: false,
      htmlExtracted: false,
      sectionCount: 0,
      subordinateCount: 0,
      repealedFileRef: repealedFile,
    });
  }

  return entries;
}

/**
 * Parse spent-act.jsp page (~14 entries).
 */
function parseSpentPage(html: string): ActEntry[] {
  const entries: ActEntry[] = [];

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[1];

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(cellMatch[1]);
    }

    if (cells.length < 3) continue;

    const slNo = stripHtml(cells[0]).trim();
    const name = stripHtml(cells[1]).trim();
    const year = stripHtml(cells[2]).trim();

    if (!slNo || !/^\d+$/.test(slNo)) continue;
    if (!name || name.length < 5) continue;

    const pdfMatch = row.match(/SpentActFileOpenServlet\?sfilename=([^"&]+)/);
    const spentFile = pdfMatch ? pdfMatch[1] : '';
    const pdfUrl = spentFile ? `${BASE_URL}/SpentActFileOpenServlet?sfilename=${spentFile}` : '';

    entries.push({
      actId: `IND_SPENT_${slNo}_${year}`,
      title: name,
      year,
      actNumber: '',
      category: 'spent',
      state: 'central',
      handle: '',
      sourceUrl: `${BASE_URL}/spent-act/spent-act.jsp`,
      pdfUrl,
      department: '',
      ministry: '',
      enactmentDate: '',
      pdfDownloaded: false,
      htmlExtracted: false,
      sectionCount: 0,
      subordinateCount: 0,
      repealedFileRef: spentFile,
    });
  }

  return entries;
}

/**
 * Index Central Acts from the browse page (paginated, ~847 acts).
 */
async function indexCentralActs(
  proxyRotator: ProxyRotator,
  testLimit?: number,
): Promise<ActEntry[]> {
  console.log(`\n[${timestamp()}] === Indexing Central Acts ===`);

  const existing = loadIndex('central');
  if (existing.length > 0 && !testLimit) {
    console.log(`  [SKIP] Already indexed ${existing.length} central acts`);
    return existing;
  }

  const entries: ActEntry[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    if (shuttingDown) break;
    const url = `${BASE_URL}/handle/123456789/1362/browse?type=shorttitle&sort_by=1&order=ASC&rpp=${RPP}&offset=${offset}`;
    console.log(`  [${timestamp()}] Fetching offset=${offset}...`);

    try {
      const resp = await httpGet(url, proxyRotator);
      const body = resp.body as string;

      const pageEntries = parseBrowsePage(body, 'central', 'central', '1362');

      if (pageEntries.length === 0) {
        hasMore = false;
        break;
      }

      for (const entry of pageEntries) {
        if (testLimit && entries.length >= testLimit) break;
        if (!seenIds.has(entry.actId)) {
          seenIds.add(entry.actId);
          entries.push(entry);
          appendToIndex(entry, 'central');
        }
      }

      console.log(`  Found ${pageEntries.length} on this page, total: ${entries.length}`);

      if (testLimit && entries.length >= testLimit) {
        console.log(`  [TEST] Reached limit of ${testLimit}`);
        break;
      }

      if (pageEntries.length < RPP) {
        hasMore = false;
      } else {
        offset += RPP;
        await sleep(proxyRotator.requestDelay);
      }
    } catch (err) {
      console.error(`  [ERROR] offset=${offset}: ${err instanceof Error ? err.message : err}`);
      offset += RPP;
      await sleep(RETRY_DELAY_MS);
    }
  }

  console.log(`  Total central acts indexed: ${entries.length}`);
  return entries;
}

/**
 * Index Repealed Acts from the single non-paginated page (~4,627 acts).
 */
async function indexRepealedActs(
  proxyRotator: ProxyRotator,
  testLimit?: number,
): Promise<ActEntry[]> {
  console.log(`\n[${timestamp()}] === Indexing Repealed Acts ===`);

  const existing = loadIndex('repealed');
  if (existing.length > 0 && !testLimit) {
    console.log(`  [SKIP] Already indexed ${existing.length} repealed acts`);
    return existing;
  }

  const url = `${BASE_URL}/repealed-act/repealed-act.jsp`;
  console.log(`  Fetching repealed acts page (may be large ~460KB)...`);

  try {
    const resp = await httpGet(url, proxyRotator, { timeout: 60000 });
    const body = resp.body as string;
    console.log(`  Page size: ${(body.length / 1024).toFixed(0)}KB`);

    const entries = parseRepealedPage(body);

    const limited = testLimit ? entries.slice(0, testLimit) : entries;
    for (const entry of limited) {
      appendToIndex(entry, 'repealed');
    }

    console.log(`  Total repealed acts indexed: ${limited.length}`);
    return limited;
  } catch (err) {
    console.error(
      `  [ERROR] Failed to fetch repealed acts: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

/**
 * Index Spent Acts (~14 acts).
 */
async function indexSpentActs(proxyRotator: ProxyRotator): Promise<ActEntry[]> {
  console.log(`\n[${timestamp()}] === Indexing Spent Acts ===`);

  const existing = loadIndex('spent');
  if (existing.length > 0) {
    console.log(`  [SKIP] Already indexed ${existing.length} spent acts`);
    return existing;
  }

  const url = `${BASE_URL}/spent-act/spent-act.jsp`;
  console.log(`  Fetching spent acts page...`);

  try {
    const resp = await httpGet(url, proxyRotator);
    const body = resp.body as string;

    const entries = parseSpentPage(body);
    for (const entry of entries) {
      appendToIndex(entry, 'spent');
    }

    console.log(`  Total spent acts indexed: ${entries.length}`);
    return entries;
  } catch (err) {
    console.error(
      `  [ERROR] Failed to fetch spent acts: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

/**
 * Index a single state's acts (paginated browse).
 */
async function indexSingleState(
  handle: string,
  stateSlug: string,
  proxyRotator: ProxyRotator,
  testLimit?: number,
): Promise<ActEntry[]> {
  const entries: ActEntry[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    if (shuttingDown) break;
    const url = `${BASE_URL}/handle/123456789/${handle}/browse?type=shorttitle&sort_by=1&order=ASC&rpp=${RPP}&offset=${offset}`;

    try {
      const resp = await httpGet(url, proxyRotator);
      const body = resp.body as string;

      const pageEntries = parseBrowsePage(body, 'state', stateSlug, handle);

      if (pageEntries.length === 0) {
        hasMore = false;
        break;
      }

      for (const entry of pageEntries) {
        if (testLimit && entries.length >= testLimit) break;
        if (!seenIds.has(entry.actId)) {
          seenIds.add(entry.actId);
          entries.push(entry);
          appendToIndex(entry, 'state', stateSlug);
        }
      }

      if (testLimit && entries.length >= testLimit) break;

      if (pageEntries.length < RPP) {
        hasMore = false;
      } else {
        offset += RPP;
        await sleep(proxyRotator.requestDelay);
      }
    } catch (err) {
      console.error(
        `  [ERROR] ${stateSlug} offset=${offset}: ${err instanceof Error ? err.message : err}`,
      );
      offset += RPP;
      await sleep(RETRY_DELAY_MS);
    }
  }

  return entries;
}

/**
 * Index State/UT Acts. Processes multiple states in parallel.
 */
async function indexStateActs(
  proxyRotator: ProxyRotator,
  progress: Progress,
  targetState?: string,
  testLimit?: number,
): Promise<ActEntry[]> {
  console.log(`\n[${timestamp()}] === Indexing State/UT Acts ===`);

  const allEntries: ActEntry[] = [];

  const stateEntries = Object.entries(STATE_HANDLES).filter(([, slug]) => {
    if (slug === 'central' || slug === 'states-community') return false;
    if (targetState) return slug === targetState;
    return true;
  });

  // Split into already-done and pending
  const pending: Array<[string, string]> = [];
  for (const [handle, stateSlug] of stateEntries) {
    if (isStateIndexed(stateSlug) && !testLimit) {
      const existing = loadIndex('state', stateSlug);
      console.log(`  [SKIP] ${stateSlug}: already indexed ${existing.length} acts`);
      allEntries.push(...existing);
    } else {
      pending.push([handle, stateSlug]);
    }
  }

  if (pending.length === 0) {
    console.log(`  All states already indexed.`);
    return allEntries;
  }

  console.log(`  ${pending.length} states to index (${MAX_INDEX_CONCURRENT} parallel)...`);
  const eta = new ETATracker(pending.length);

  // Process states with limited concurrency
  const sem = new Semaphore(MAX_INDEX_CONCURRENT);

  const statePromises = pending.map(async ([handle, stateSlug]) => {
    await sem.acquire();
    try {
      if (shuttingDown) return;
      const entries = await indexSingleState(handle, stateSlug, proxyRotator, testLimit);

      console.log(
        `  [${timestamp()}] ${stateSlug}: ${entries.length} acts | ${eta.formatProgress()}`,
      );
      allEntries.push(...entries);

      markStateIndexed(stateSlug);
      eta.tick();
      saveProgressDebounced(progress);
    } finally {
      sem.release();
    }
  });

  await Promise.all(statePromises);

  console.log(`\n  Total state/UT acts indexed: ${allEntries.length}`);
  return allEntries;
}

// ---------------------------------------------------------------------------
// Phase 2: Download PDFs + Extract HTML
// ---------------------------------------------------------------------------

/**
 * Discover PDF URL for an act by visiting its detail page.
 */
async function discoverPdfUrl(entry: ActEntry, proxyRotator: ProxyRotator): Promise<string> {
  if (entry.pdfUrl) return entry.pdfUrl;

  try {
    const resp = await httpGet(entry.sourceUrl, proxyRotator, {
      timeout: 20000,
    });
    const body = resp.body as string;

    // Pattern 1: bitstream PDF
    const bitstreamMatch = body.match(/href="(\/bitstream\/123456789\/\d+\/\d+\/[^"]+\.pdf)"/i);
    if (bitstreamMatch) return `${BASE_URL}${bitstreamMatch[1]}`;

    // Pattern 2: upload.indiacode.nic.in showfile
    const showfileMatch = body.match(
      /href="(https?:\/\/upload\.indiacode\.nic\.in\/showfile[^"]+)"/i,
    );
    if (showfileMatch) return showfileMatch[1];

    // Pattern 3: ViewFileUploaded
    const viewFileMatch = body.match(/href="(\/ViewFileUploaded[^"]+)"/i);
    if (viewFileMatch) return `${BASE_URL}${viewFileMatch[1]}`;

    // Pattern 4: repealedfileopen
    const repealedMatch = body.match(/href="(\/repealedfileopen[^"]+)"/i);
    if (repealedMatch) return `${BASE_URL}${repealedMatch[1]}`;

    // Pattern 5: Generic PDF link
    const genericPdf = body.match(/href="([^"]*\.pdf[^"]*)"/i);
    if (genericPdf) {
      const pdfHref = genericPdf[1];
      return pdfHref.startsWith('http') ? pdfHref : `${BASE_URL}${pdfHref}`;
    }
  } catch {
    // Fail silently
  }

  return '';
}

/**
 * Extract section content via the AJAX JSON API.
 */
async function extractActSections(
  entry: ActEntry,
  proxyRotator: ProxyRotator,
): Promise<{
  sections: Array<{ id: string; title: string; content: string; footnote: string }>;
  sectionCount: number;
}> {
  const sections: Array<{
    id: string;
    title: string;
    content: string;
    footnote: string;
  }> = [];

  try {
    const resp = await httpGet(entry.sourceUrl, proxyRotator, {
      timeout: 20000,
    });
    const body = resp.body as string;

    let actId = entry.actId;
    const actIdPageMatch = body.match(/actid=([A-Z_0-9]+)/);
    if (actIdPageMatch) {
      actId = actIdPageMatch[1];
    }

    // Skip non-API-compatible IDs
    if (!actId.startsWith('AC_')) {
      return { sections: [], sectionCount: 0 };
    }

    const sectionIdRegex = /sectionID[=:][\s'"]*(\d+)/gi;
    const sectionIds = new Set<string>();
    let sMatch;
    while ((sMatch = sectionIdRegex.exec(body)) !== null) {
      sectionIds.add(sMatch[1]);
    }

    if (sectionIds.size === 0) {
      return { sections: [], sectionCount: 0 };
    }

    // Fetch sections with limited concurrency (don't hammer the API)
    const sectionSem = new Semaphore(3);
    const sectionPromises = [...sectionIds].map(async (sectionId) => {
      await sectionSem.acquire();
      try {
        const sectionUrl = `${BASE_URL}/SectionPageContent?actid=${actId}&sectionID=${sectionId}`;
        const sResp = await httpGet(sectionUrl, proxyRotator, {
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          retries: 1,
        });

        const sBody = sResp.body as string;
        try {
          const json = JSON.parse(sBody);
          return {
            id: sectionId,
            title: `Section ${sectionId}`,
            content: json.content || '',
            footnote: json.footnote || '',
          };
        } catch {
          return null;
        }
      } catch {
        return null;
      } finally {
        sectionSem.release();
      }
    });

    const results = await Promise.all(sectionPromises);
    for (const r of results) {
      if (r) sections.push(r);
    }
  } catch {
    // Page fetch failed
  }

  return { sections, sectionCount: sections.length };
}

/**
 * Phase 2: Download PDFs and extract HTML using a concurrent worker pool.
 */
async function downloadAndExtract(
  entries: ActEntry[],
  proxyRotator: ProxyRotator,
  progress: Progress,
  options: { skipHtml?: boolean; testLimit?: number } = {},
): Promise<void> {
  const queue = entries.filter((e) => !isPdfDownloaded(e.actId));

  const limited = options.testLimit ? queue.slice(0, options.testLimit) : queue;

  if (limited.length === 0) {
    console.log(`\n[${timestamp()}] === Phase 2: Nothing to download ===`);
    return;
  }

  console.log(
    `\n[${timestamp()}] === Phase 2: Download & Extract (${limited.length} acts, ${MAX_CONCURRENT} workers) ===`,
  );

  const eta = new ETATracker(limited.length);
  let pdfSuccess = 0;
  let pdfFail = 0;
  let htmlSuccess = 0;

  const sem = new Semaphore(MAX_CONCURRENT);

  const workerPromises = limited.map(async (entry) => {
    await sem.acquire();
    if (shuttingDown) {
      sem.release();
      return;
    }
    try {
      let bytes = 0;

      // Step 1: Discover PDF URL
      const pdfUrl = await discoverPdfUrl(entry, proxyRotator);

      // Step 2: Download PDF (streaming)
      if (pdfUrl) {
        const categoryDir =
          entry.category === 'state'
            ? path.join(PDFS_DIR, entry.state)
            : path.join(PDFS_DIR, entry.category);

        const pdfFilename = `${slugify(entry.title, 60)}_${entry.year || 'unknown'}.pdf`;
        const pdfDest = path.join(categoryDir, pdfFilename);

        const result = await downloadFileStream(pdfUrl, pdfDest, proxyRotator);
        if (result.ok) {
          pdfSuccess++;
          bytes = result.bytes;
          entry.pdfUrl = pdfUrl;
          entry.pdfDownloaded = true;
        } else {
          pdfFail++;
        }
      } else {
        pdfFail++;
      }

      // Step 3: Extract HTML sections
      if (!options.skipHtml && entry.actId.startsWith('AC_')) {
        const { sections, sectionCount } = await extractActSections(entry, proxyRotator);

        if (sections.length > 0) {
          const htmlDir =
            entry.category === 'state'
              ? path.join(HTML_DIR, entry.state)
              : path.join(HTML_DIR, entry.category);
          ensureDir(htmlDir);

          const htmlFilename = `${slugify(entry.title, 60)}_${entry.year || 'unknown'}.json`;
          const htmlDest = path.join(htmlDir, htmlFilename);

          fs.writeFileSync(
            htmlDest,
            JSON.stringify({
              actId: entry.actId,
              title: entry.title,
              year: entry.year,
              category: entry.category,
              state: entry.state,
              sectionCount,
              sections,
            }),
          );

          htmlSuccess++;
          entry.htmlExtracted = true;
          entry.sectionCount = sectionCount;
          markHtmlExtracted(entry.actId);
        }
      }

      // Mark done
      markPdfDownloaded(entry.actId);
      eta.tick(bytes);

      // Log progress periodically
      if (eta.count % PROGRESS_LOG_INTERVAL === 0 || eta.count === limited.length) {
        console.log(
          `  [${timestamp()}] ${eta.formatProgress(`PDFs=${pdfSuccess}ok/${pdfFail}err HTML=${htmlSuccess}`)}`,
        );
      }

      // Save progress periodically
      progress.totalPdfs = pdfSuccess;
      progress.totalHtml = htmlSuccess;
      saveProgressDebounced(progress);
    } catch (err) {
      progress.errors.push({
        actId: entry.actId,
        phase: 'download',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
      markPdfDownloaded(entry.actId); // mark done to avoid retrying forever
      eta.tick();
    } finally {
      sem.release();
    }
  });

  await Promise.all(workerPromises);

  // Final save
  saveProgressSync(progress);

  console.log(
    `\n[${timestamp()}] Phase 2 complete: ${pdfSuccess} PDFs (${eta.mbDownloaded}MB), ${htmlSuccess} HTML, ${pdfFail} failed`,
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Subordinate Legislation
// ---------------------------------------------------------------------------

/**
 * Extract subordinate doc type from ViewFileUploaded path parameter.
 * e.g. "AC_.../rulesindividualfile/" → "rules"
 */
function extractSubType(urlStr: string): string {
  const typeMap: Record<string, string> = {
    rulesindividualfile: 'rules',
    regulationindividualfile: 'regulations',
    notificationindividualfile: 'notifications',
    orderindividualfile: 'orders',
    circularindividualfile: 'circulars',
    ordinanceindividualfile: 'ordinances',
    statuteindividualfile: 'statutes',
  };
  const pathMatch = urlStr.match(/\/([a-z]+individualfile)\//i);
  if (pathMatch) {
    const key = pathMatch[1].toLowerCase();
    return typeMap[key] || key.replace('individualfile', '');
  }
  const typeParam = urlStr.match(/[?&]type=([^&]+)/);
  if (typeParam) return typeParam[1];
  return 'subordinate';
}

/**
 * Extract filename from ViewFileUploaded URL's file= parameter.
 */
function extractFilename(urlStr: string): string | null {
  const fileMatch = urlStr.match(/[?&]file=([^&\s]+)/);
  if (!fileMatch) return null;
  try {
    return decodeURIComponent(fileMatch[1].replace(/\+/g, ' ')).replace(/[/\\:*?"<>|]/g, '_');
  } catch {
    return fileMatch[1].replace(/[/\\:*?"<>|]/g, '_');
  }
}

/**
 * Discover and download subordinate legislation for an act.
 */
async function scrapeSubordinateLegislation(
  entry: ActEntry,
  proxyRotator: ProxyRotator,
): Promise<{ count: number; bytes: number }> {
  // Only acts with a sourceUrl pointing to a detail page can have subordinate docs
  if (!entry.sourceUrl || !entry.sourceUrl.includes('/handle/')) return { count: 0, bytes: 0 };

  try {
    const resp = await httpGet(entry.sourceUrl, proxyRotator, {
      timeout: 30000,
    });
    const body = resp.body as string;

    // Match all subordinate doc links — trim whitespace from captured URLs
    const viewFileRegex = /href="(\/ViewFileUploaded\?[^"]+)"/gi;
    const showfileRegex = /href="((?:https?:\/\/upload\.indiacode\.nic\.in)?\/showfile\?[^"]+)"/gi;
    const scheduleRegex = /href="(\/schedulefile\?[^"]+)"/gi;
    const appendixRegex = /href="(\/appendixfile\?[^"]+)"/gi;

    const allLinks: Array<{ url: string; type: string; filename: string | null }> = [];
    const seen = new Set<string>();

    const addLink = (rawUrl: string, fallbackType: string) => {
      const url = rawUrl.trim();
      if (seen.has(url)) return;
      seen.add(url);
      allLinks.push({
        url,
        type: extractSubType(url) || fallbackType,
        filename: extractFilename(url),
      });
    };

    let m;
    while ((m = viewFileRegex.exec(body)) !== null) {
      addLink(`${BASE_URL}${m[1].trim()}`, 'subordinate');
    }

    while ((m = showfileRegex.exec(body)) !== null) {
      const raw = m[1].trim();
      const href = raw.startsWith('http') ? raw : `${UPLOAD_BASE}${raw}`;
      addLink(href, 'subordinate');
    }

    while ((m = scheduleRegex.exec(body)) !== null) {
      addLink(`${BASE_URL}${m[1].trim()}`, 'schedule');
    }

    while ((m = appendixRegex.exec(body)) !== null) {
      addLink(`${BASE_URL}${m[1].trim()}`, 'appendix');
    }

    if (allLinks.length === 0) return { count: 0, bytes: 0 };

    const subDir = path.join(
      SUBORDINATE_DIR,
      entry.category === 'state' ? entry.state : entry.category,
      slugify(entry.title, 50),
    );

    let downloaded = 0;
    let totalBytes = 0;

    // Download subordinate docs with limited concurrency
    const subSem = new Semaphore(6);
    const dlPromises = allLinks.map(async (link, i) => {
      await subSem.acquire();
      try {
        if (shuttingDown) return;
        const fname = link.filename ? `${link.type}_${link.filename}` : `${link.type}_${i + 1}.pdf`;
        // Truncate filename to avoid filesystem limits
        const safeName = fname.length > 200 ? fname.slice(0, 196) + '.pdf' : fname;
        const dest = path.join(subDir, safeName);

        const result = await downloadFileStream(link.url, dest, proxyRotator);
        if (result.ok) {
          downloaded++;
          totalBytes += result.bytes;
        }
      } finally {
        subSem.release();
      }
    });

    await Promise.all(dlPromises);

    // Save metadata JSONL for this act's subordinate docs
    if (downloaded > 0) {
      const metaPath = path.join(subDir, '_metadata.jsonl');
      const metaLines = allLinks
        .map((link, i) =>
          JSON.stringify({
            actId: entry.actId,
            title: entry.title,
            type: link.type,
            url: link.url,
            filename: link.filename || `${link.type}_${i + 1}.pdf`,
          }),
        )
        .join('\n');
      fs.writeFileSync(metaPath, metaLines + '\n');
    }

    return { count: downloaded, bytes: totalBytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/**
 * Phase 3: Subordinate legislation with concurrent worker pool.
 */
async function runSubordinatePhase(
  proxyRotator: ProxyRotator,
  progress: Progress,
  targetCategory?: string,
  targetState?: string,
  testLimit?: number,
): Promise<void> {
  const allEntries = loadAllIndexed();
  const eligible = allEntries.filter((e) => {
    // Only acts with detail pages (central + state browse acts) can have subordinate docs
    if (!e.sourceUrl || !e.sourceUrl.includes('/handle/')) return false;
    if (isSubordinateScraped(e.actId)) return false;
    if (targetCategory && e.category !== targetCategory) return false;
    if (targetState && e.state !== targetState) return false;
    return true;
  });

  // Sort by handle number descending — newer acts tend to have more subordinate docs
  const getHandle = (e: ActEntry): number => {
    const m = e.sourceUrl?.match(/\/123456789\/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  };
  eligible.sort((a, b) => getHandle(b) - getHandle(a));

  const limited = testLimit ? eligible.slice(0, testLimit) : eligible;

  if (limited.length === 0) {
    console.log(`\n[${timestamp()}] === Phase 3: No subordinate legislation to scrape ===`);
    return;
  }

  console.log(
    `\n[${timestamp()}] === Phase 3: Subordinate Legislation (${limited.length} acts, ${MAX_CONCURRENT} workers) ===`,
  );

  const eta = new ETATracker(limited.length);
  let totalSub = 0;

  const sem = new Semaphore(MAX_CONCURRENT);

  const workerPromises = limited.map(async (entry) => {
    await sem.acquire();
    if (shuttingDown) {
      sem.release();
      return;
    }
    try {
      const { count, bytes } = await scrapeSubordinateLegislation(entry, proxyRotator);

      if (count > 0) {
        totalSub += count;
        entry.subordinateCount = count;
      }

      markSubordinateScraped(entry.actId);
      eta.tick(bytes);

      if (eta.count % PROGRESS_LOG_INTERVAL === 0 || eta.count === limited.length) {
        console.log(`  [${timestamp()}] ${eta.formatProgress(`subDocs=${totalSub}`)}`);
      }

      saveProgressDebounced(progress);
    } catch (err) {
      progress.errors.push({
        actId: entry.actId,
        phase: 'subordinate',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
      markSubordinateScraped(entry.actId);
      eta.tick();
    } finally {
      sem.release();
    }
  });

  await Promise.all(workerPromises);

  saveProgressSync(progress);

  console.log(
    `\n[${timestamp()}] Phase 3 complete: ${totalSub} subordinate documents (${eta.mbDownloaded}MB)`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setupShutdownHandler();

  const args = process.argv.slice(2);
  const isTest = args.includes('--test');
  const noProxy = args.includes('--no-proxy');

  const phaseIdx = args.indexOf('--phase');
  const phase = phaseIdx >= 0 ? args[phaseIdx + 1] : 'all';

  const catIdx = args.indexOf('--category');
  const targetCategory = catIdx >= 0 ? args[catIdx + 1] : undefined;

  const stateIdx = args.indexOf('--state');
  const targetState = stateIdx >= 0 ? args[stateIdx + 1] : undefined;

  const testLimit = isTest ? 5 : undefined;

  // Ensure directories
  [DATA_DIR, INDEX_DIR, PDFS_DIR, HTML_DIR, SUBORDINATE_DIR].forEach(ensureDir);
  ensureDir(path.join(PDFS_DIR, 'central'));
  ensureDir(path.join(PDFS_DIR, 'repealed'));
  ensureDir(path.join(PDFS_DIR, 'spent'));

  // Setup proxy
  const proxyConfigs = buildProxyConfigs(noProxy);
  const proxyRotator = new ProxyRotator(proxyConfigs);

  console.log(`[${timestamp()}] IndiaCode Scraper - https://www.indiacode.nic.in`);
  console.log(`  Phase: ${phase}`);
  console.log(`  Category: ${targetCategory || 'all'}`);
  console.log(`  State: ${targetState || 'all'}`);
  console.log(`  Proxy: ${noProxy ? 'disabled' : `${proxyConfigs.length} providers`}`);
  console.log(`  Concurrency: ${MAX_CONCURRENT} (index: ${MAX_INDEX_CONCURRENT})`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Request delay: ${proxyRotator.requestDelay}ms`);
  if (isTest) console.log(`  TEST MODE: ${testLimit} acts per category`);
  console.log('');

  const progress = loadProgress();
  progressRef = progress; // for SIGINT handler

  // -----------------------------------------------------------------------
  // Phase 1: Index
  // -----------------------------------------------------------------------
  if (phase === 'all' || phase === 'index') {
    progress.phase = 'index';
    saveProgressSync(progress);

    const startTime = Date.now();
    const allEntries: ActEntry[] = [];

    if (!targetCategory || targetCategory === 'central') {
      const central = await indexCentralActs(proxyRotator, testLimit);
      allEntries.push(...central);
      if (!progress.indexCompleted.includes('central')) {
        progress.indexCompleted.push('central');
        saveProgressSync(progress);
      }
    }

    if (!targetCategory || targetCategory === 'repealed') {
      const repealed = await indexRepealedActs(proxyRotator, testLimit);
      allEntries.push(...repealed);
      if (!progress.indexCompleted.includes('repealed')) {
        progress.indexCompleted.push('repealed');
        saveProgressSync(progress);
      }
    }

    if (!targetCategory || targetCategory === 'spent') {
      const spent = await indexSpentActs(proxyRotator);
      allEntries.push(...spent);
      if (!progress.indexCompleted.includes('spent')) {
        progress.indexCompleted.push('spent');
        saveProgressSync(progress);
      }
    }

    if (!targetCategory || targetCategory === 'state') {
      const state = await indexStateActs(proxyRotator, progress, targetState, testLimit);
      allEntries.push(...state);
      if (!progress.indexCompleted.includes('state')) {
        progress.indexCompleted.push('state');
        saveProgressSync(progress);
      }
    }

    progress.totalActs = allEntries.length;
    saveProgressSync(progress);

    const elapsed = formatDuration(Date.now() - startTime);
    console.log(
      `\n[${timestamp()}] === Index Phase Complete: ${allEntries.length} total acts in ${elapsed} ===`,
    );
  }

  // -----------------------------------------------------------------------
  // Phase 2: Download PDFs + HTML
  // -----------------------------------------------------------------------
  if (phase === 'all' || phase === 'download') {
    progress.phase = 'download';
    saveProgressSync(progress);

    const allEntries = loadAllIndexed();
    console.log(`\n[${timestamp()}] Loaded ${allEntries.length} indexed acts for download`);

    const filtered = allEntries.filter((e) => {
      if (targetCategory && e.category !== targetCategory) return false;
      if (targetState && e.state !== targetState) return false;
      return true;
    });

    await downloadAndExtract(filtered, proxyRotator, progress, {
      testLimit,
    });
  }

  // -----------------------------------------------------------------------
  // Phase 3: Subordinate Legislation
  // -----------------------------------------------------------------------
  if (phase === 'all' || phase === 'subordinate') {
    progress.phase = 'subordinate';
    saveProgressSync(progress);

    await runSubordinatePhase(proxyRotator, progress, targetCategory, targetState, testLimit);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  saveProgressSync(progress);

  console.log(`\n[${timestamp()}] === Final Summary ===`);
  console.log(`  Acts indexed: ${progress.totalActs}`);
  console.log(`  PDFs downloaded: ${pdfDownloadedSet.size}`);
  console.log(`  HTML extracted: ${htmlExtractedSet.size}`);
  console.log(`  Subordinate scraped: ${subordinateScrapedSet.size}`);
  console.log(`  Errors: ${progress.errors.length}`);
  console.log(`  Proxy stats: ${proxyRotator.getStats()}`);
  console.log(`  Progress file: ${PROGRESS_FILE}`);

  if (progress.errors.length > 0) {
    const errFile = path.join(DATA_DIR, 'errors.json');
    fs.writeFileSync(errFile, JSON.stringify(progress.errors, null, 2));
    console.log(`  Error log: ${errFile}`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  if (progressRef && progressDirty) {
    saveProgressSync(progressRef);
    console.error('Progress saved before exit.');
  }
  process.exit(1);
});
