/**
 * SAT Scraper - Securities Appellate Tribunal
 * Scrapes orders from https://satweb.sat.gov.in
 *
 * Appeal Types:
 *   - SEBI:  ~37,159 orders (2006 - present)
 *   - IRDAI: ~700 orders   (2020 - present)
 *   - PFRDA: minimal       (2024 - present)
 *
 * The site uses CodeIgniter (PHP) with rotating CSRF tokens (security_token).
 * PDFs are returned as base64-encoded content in JSON responses.
 * No CAPTCHA, no rate limiting, no authentication required.
 *
 * Token rotation: Each AJAX response returns a new security_token that MUST
 * be used for the next request within a session. However, multiple independent
 * sessions can run in parallel (each has its own PHPSESSID + token chain).
 * Default: 5 parallel workers. Override with WORKERS=N env var.
 *
 * Usage:
 *   npx tsx scripts/sat-scraper.ts                           # Full run
 *   npx tsx scripts/sat-scraper.ts --metadata-only           # Metadata only
 *   npx tsx scripts/sat-scraper.ts --download-only           # PDFs only (requires metadata)
 *   npx tsx scripts/sat-scraper.ts --appeal-type sebi        # Single appeal type
 *   npx tsx scripts/sat-scraper.ts --year 2024               # Specific year only
 *   npx tsx scripts/sat-scraper.ts --test                    # Test (1 month, 5 PDFs)
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://satweb.sat.gov.in';
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/sat');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const COMBINED_JSONL = path.join(DATA_DIR, 'sat-all-metadata.jsonl');

const DELAY_BETWEEN_REQUESTS_MS = 500;
const DELAY_BETWEEN_PDFS_MS = 300;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const SESSION_REFRESH_INTERVAL = 50; // refresh session every N requests
const PDF_SESSION_REFRESH_INTERVAL = 100;
const PARALLEL_WORKERS = parseInt(process.env.WORKERS || '5', 10);

type AppealTypeName = 'sebi' | 'irdai' | 'pfrda';

interface AppealTypeConfig {
  name: AppealTypeName;
  label: 'SEBI' | 'IRDAI' | 'PFRDA';
  code: string; // "1", "2", "3"
  startYear: number;
}

const APPEAL_TYPES: AppealTypeConfig[] = [
  { name: 'sebi', label: 'SEBI', code: '1', startYear: 2006 },
  { name: 'irdai', label: 'IRDAI', code: '2', startYear: 2020 },
  { name: 'pfrda', label: 'PFRDA', code: '3', startYear: 2024 },
];

const ALL_APPEAL_TYPE_NAMES: AppealTypeName[] = ['sebi', 'irdai', 'pfrda'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SatOrder {
  id: number;
  appeal_type: 'SEBI' | 'IRDAI' | 'PFRDA';
  appeal_type_code: string;
  al_number: string;
  appeal_number: string;
  appellant: string;
  respondent: string;
  court: string;
  order_date: string; // DD/MM/YYYY
  order_year: number;
  order_month: number;
  pdf_filename: string;
  pdf_size_bytes: number;
  view_order_url: string;
  source_url: string;
  tribunal: string;
  country: string;
  scraped_at: string;
}

interface MonthMetadata {
  appeal_type: AppealTypeName;
  month_key: string; // "SEBI_2024_01"
  year: number;
  month: number;
  scraped_at: string;
  total_orders: number;
  orders: SatOrder[];
}

interface Progress {
  metadata_completed: string[]; // ["SEBI_2024_01", ...]
  pdfs_completed: Record<string, string[]>; // {sebi: ["sat_22389_...pdf"], ...}
  total_orders_found: number;
  total_pdfs_downloaded: number;
  last_updated: string;
}

interface SessionInfo {
  cookies: string;
  securityToken: string;
  requestCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    metadata_completed: [],
    pdfs_completed: {},
    total_orders_found: 0,
    total_pdfs_downloaded: 0,
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(text: string, maxLen = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Format date as dd-mm-yy for SAT's jQuery datepicker */
function formatDateForSat(year: number, month: number, day: number): string {
  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  // SAT uses dd-mm-yy format (4-digit year despite "yy" label)
  const yyyy = String(year);
  return `${dd}-${mm}-${yyyy}`;
}

/** Get first and last day of a month formatted for SAT */
function getMonthRange(year: number, month: number): { startDate: string; endDate: string } {
  const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
  return {
    startDate: formatDateForSat(year, month, 1),
    endDate: formatDateForSat(year, month, lastDay),
  };
}

/** Generate all month keys from startYear to now for an appeal type */
function generateMonthKeys(config: AppealTypeConfig): string[] {
  const keys: string[] = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  for (let y = config.startYear; y <= currentYear; y++) {
    const endMonth = y === currentYear ? currentMonth : 12;
    for (let m = 1; m <= endMonth; m++) {
      keys.push(`${config.label}_${y}_${String(m).padStart(2, '0')}`);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// HTTP Client
// ---------------------------------------------------------------------------

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects?: boolean;
    timeout?: number;
  } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  rawHeaders: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      rejectUnauthorized: false,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        Referer: `${BASE_URL}/orders`,
        ...options.headers,
      },
    };

    const req = lib.request(reqOptions, (res) => {
      // Handle redirects
      if (
        options.followRedirects !== false &&
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${BASE_URL}${res.headers.location}`;
        httpRequest(redirectUrl, options).then(resolve).catch(reject);
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers as Record<string, string | string[]>,
          body: Buffer.concat(chunks).toString('utf-8'),
          rawHeaders: res.headers,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(options.timeout || 30000, () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

async function getSession(): Promise<SessionInfo> {
  const resp = await httpRequest(`${BASE_URL}/orders`);

  // Extract cookies from set-cookie headers
  let cookieParts: string[] = [];
  const setCookieRaw = resp.rawHeaders['set-cookie'];
  if (setCookieRaw) {
    const cookies = Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw];
    cookieParts = cookies.map((c) => c.split(';')[0].trim());
  }
  const cookieStr = cookieParts.join('; ');

  // Extract security_token from hidden input
  const tokenMatch = resp.body.match(/id="security_token"\s+value="([^"]+)"/);
  if (!tokenMatch) {
    // Try alternate pattern
    const altMatch = resp.body.match(/name="security_token"[^>]*value="([^"]+)"/);
    if (!altMatch) {
      const inputMatch = resp.body.match(/value="([^"]+)"[^>]*id="security_token"/);
      if (!inputMatch) {
        throw new Error('Could not extract security_token from /orders page');
      }
      return {
        cookies: cookieStr,
        securityToken: inputMatch[1],
        requestCount: 0,
      };
    }
    return {
      cookies: cookieStr,
      securityToken: altMatch[1],
      requestCount: 0,
    };
  }

  return {
    cookies: cookieStr,
    securityToken: tokenMatch[1],
    requestCount: 0,
  };
}

// ---------------------------------------------------------------------------
// AJAX Endpoint Wrappers
// ---------------------------------------------------------------------------

interface SatAjaxResponse {
  status: string;
  content: string;
  token: string;
}

async function postAjax(
  session: SessionInfo,
  endpoint: string,
  params: Record<string, string>,
  retries = MAX_RETRIES,
): Promise<SatAjaxResponse> {
  const body = new URLSearchParams({
    ...params,
    security_token: session.securityToken,
  }).toString();

  try {
    const resp = await httpRequest(`${BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Cookie: session.cookies,
        Referer: `${BASE_URL}/orders`,
      },
      body,
    });

    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status} from ${endpoint}`);
    }

    const json: SatAjaxResponse = JSON.parse(resp.body);

    // Rotate token
    if (json.token) {
      session.securityToken = json.token;
    }
    session.requestCount++;

    return json;
  } catch (err) {
    if (retries > 0) {
      console.error(
        `  [RETRY] ${endpoint} failed: ${err instanceof Error ? err.message : err}, retrying in ${RETRY_DELAY_MS}ms...`,
      );
      await sleep(RETRY_DELAY_MS);
      return postAjax(session, endpoint, params, retries - 1);
    }
    throw err;
  }
}

async function fetchOrdersByDate(
  session: SessionInfo,
  appealTypeCode: string,
  startDate: string,
  endDate: string,
): Promise<SatAjaxResponse> {
  return postAjax(session, 'get-orders-by-date', {
    apl_type: appealTypeCode,
    startDate,
    endDate,
  });
}

async function fetchOrderDocument(session: SessionInfo, orderId: number): Promise<SatAjaxResponse> {
  return postAjax(session, 'view-order-document', {
    order: String(orderId),
  });
}

// ---------------------------------------------------------------------------
// HTML Table Parser
// ---------------------------------------------------------------------------

function parseOrdersHtml(html: string, appealConfig: AppealTypeConfig): SatOrder[] {
  const orders: SatOrder[] = [];

  if (!html || html.includes('No record found') || html.includes('No Record')) {
    return orders;
  }

  // Match table rows - skip header row
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[] = [];
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    // Skip header rows (containing <th>)
    if (rowMatch[1].includes('<th')) continue;
    rows.push(rowMatch[1]);
  }

  for (const rowHtml of rows) {
    try {
      // Extract all <td> contents
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(cellMatch[1].trim());
      }

      // Expected columns: S.No, AL No, Appeal No, Parties, Court, Order Date, View Order
      if (cells.length < 7) continue;

      const alNumber = stripHtml(cells[1]);
      const appealNumber = stripHtml(cells[2]);

      // Parse parties - the "vs" is inside <span class="vs">vs</span>
      // Replace span with plain " vs " before stripping HTML
      const partiesHtml = cells[3].replace(/<span[^>]*class="vs"[^>]*>vs<\/span>/i, ' vs ');
      const partiesRaw = stripHtml(partiesHtml);
      const court = stripHtml(cells[4]);
      const orderDate = stripHtml(cells[5]);

      let appellant = partiesRaw;
      let respondent = '';
      const vsMatch = partiesRaw.match(/^(.*?)\s+vs\.?\s+(.*?)$/i);
      if (vsMatch) {
        appellant = vsMatch[1].trim();
        respondent = vsMatch[2].trim();
      }

      // Extract order ID from view-order href URL: /view-order/{hash}/{id}
      const urlMatch = cells[6].match(/href="([^"]*view-order[^"]*)"/);
      const idMatch = cells[6].match(/view-order\/[a-f0-9]+\/(\d+)/);
      if (!idMatch) continue;

      const id = parseInt(idMatch[1], 10);
      const viewOrderUrl = urlMatch
        ? urlMatch[1].startsWith('http')
          ? urlMatch[1]
          : `${BASE_URL}${urlMatch[1]}`
        : '';

      // Parse order date DD/MM/YYYY
      let orderYear = 0;
      let orderMonth = 0;
      const dateMatch = orderDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (dateMatch) {
        orderMonth = parseInt(dateMatch[2], 10);
        orderYear = parseInt(dateMatch[3], 10);
      }

      // Generate filename
      const appealSlug = slugify(appealNumber, 40);
      const appellantSlug = slugify(appellant, 30);
      const pdfFilename = `sat_${id}_${appealSlug}_${appellantSlug}.pdf`;

      orders.push({
        id,
        appeal_type: appealConfig.label,
        appeal_type_code: appealConfig.code,
        al_number: alNumber,
        appeal_number: appealNumber,
        appellant,
        respondent,
        court,
        order_date: orderDate,
        order_year: orderYear,
        order_month: orderMonth,
        pdf_filename: pdfFilename,
        pdf_size_bytes: 0, // filled during PDF download
        view_order_url: viewOrderUrl,
        source_url: `${BASE_URL}/orders`,
        tribunal: 'SAT',
        country: 'IN',
        scraped_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`  [PARSE ERROR] Row: ${err instanceof Error ? err.message : err}`);
    }
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Phase 1: Scrape Metadata (date-wise crawl)
// ---------------------------------------------------------------------------

async function scrapeMetadata(
  appealTypes: AppealTypeConfig[],
  opts: { testMode?: boolean; yearFilter?: number },
): Promise<Map<AppealTypeName, SatOrder[]>> {
  const progress = loadProgress();
  const allOrders = new Map<AppealTypeName, SatOrder[]>();

  console.log(
    `\n=== Phase 1: Scraping metadata for ${appealTypes.map((a) => a.label).join(', ')} ===`,
  );

  let session = await getSession();
  console.log(`  Session acquired (token: ${session.securityToken.slice(0, 12)}...)`);

  for (const config of appealTypes) {
    const orders: SatOrder[] = [];
    const monthKeys = generateMonthKeys(config);

    // Filter by year if specified
    const filteredKeys = opts.yearFilter
      ? monthKeys.filter((k) => k.includes(`_${opts.yearFilter}_`))
      : monthKeys;

    // In test mode, use Jan 2025 (known to have data) or last completed month
    let keysToProcess: string[];
    if (opts.testMode) {
      const testKey = `${config.label}_2025_01`;
      if (filteredKeys.includes(testKey)) {
        keysToProcess = [testKey];
      } else {
        // Fallback: use a month 2 back from end (skip current incomplete month)
        keysToProcess = filteredKeys.slice(-3, -2);
        if (keysToProcess.length === 0) keysToProcess = filteredKeys.slice(-1);
      }
    } else {
      keysToProcess = filteredKeys;
    }

    console.log(`\n  --- ${config.label} (${keysToProcess.length} months to process) ---`);

    for (let i = 0; i < keysToProcess.length; i++) {
      const monthKey = keysToProcess[i];

      // Check if already done
      if (progress.metadata_completed.includes(monthKey)) {
        // Load from existing file
        const monthFile = path.join(METADATA_DIR, `sat-${monthKey.toLowerCase()}.json`);
        if (fs.existsSync(monthFile)) {
          const existing: MonthMetadata = JSON.parse(fs.readFileSync(monthFile, 'utf-8'));
          orders.push(...existing.orders);
          console.log(`  [SKIP] ${monthKey} - already scraped (${existing.total_orders} orders)`);
          continue;
        }
      }

      // Parse month key to get year/month
      const parts = monthKey.split('_');
      const year = parseInt(parts[1], 10);
      const month = parseInt(parts[2], 10);
      const { startDate, endDate } = getMonthRange(year, month);

      // Refresh session periodically
      if (session.requestCount >= SESSION_REFRESH_INTERVAL) {
        console.log(`  [SESSION] Refreshing (${session.requestCount} requests)...`);
        session = await getSession();
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
      }

      try {
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        const response = await fetchOrdersByDate(session, config.code, startDate, endDate);

        const monthOrders = parseOrdersHtml(response.content, config);
        orders.push(...monthOrders);

        // Save per-month metadata
        const monthMeta: MonthMetadata = {
          appeal_type: config.name,
          month_key: monthKey,
          year,
          month,
          scraped_at: new Date().toISOString(),
          total_orders: monthOrders.length,
          orders: monthOrders,
        };

        const monthFile = path.join(METADATA_DIR, `sat-${monthKey.toLowerCase()}.json`);
        fs.writeFileSync(monthFile, JSON.stringify(monthMeta, null, 2));

        // Update progress
        if (!progress.metadata_completed.includes(monthKey)) {
          progress.metadata_completed.push(monthKey);
        }
        progress.total_orders_found += monthOrders.length;
        saveProgress(progress);

        const pct = (((i + 1) / keysToProcess.length) * 100).toFixed(1);
        console.log(
          `  [${pct}%] ${monthKey}: ${monthOrders.length} orders (total: ${orders.length})`,
        );
      } catch (err) {
        console.error(`  [ERROR] ${monthKey}: ${err instanceof Error ? err.message : err}`);
        // Try refreshing session on error
        try {
          session = await getSession();
          await sleep(RETRY_DELAY_MS);
        } catch {
          console.error('  [FATAL] Cannot refresh session');
        }
      }
    }

    allOrders.set(config.name, orders);

    // Save per-type summary
    const summaryFile = path.join(METADATA_DIR, `sat-${config.name}-summary.json`);
    fs.writeFileSync(
      summaryFile,
      JSON.stringify(
        {
          appeal_type: config.name,
          label: config.label,
          total_orders: orders.length,
          scraped_at: new Date().toISOString(),
          year_breakdown: orders.reduce(
            (acc, o) => {
              acc[o.order_year] = (acc[o.order_year] || 0) + 1;
              return acc;
            },
            {} as Record<number, number>,
          ),
        },
        null,
        2,
      ),
    );

    console.log(`  ${config.label} total: ${orders.length} orders`);
  }

  // Write combined JSONL
  console.log(`\n  Writing combined JSONL -> ${COMBINED_JSONL}`);
  const jsonlStream = fs.createWriteStream(COMBINED_JSONL);
  let totalDocs = 0;

  for (const [, orders] of allOrders) {
    for (const order of orders) {
      jsonlStream.write(JSON.stringify(order) + '\n');
      totalDocs++;
    }
  }
  jsonlStream.end();
  console.log(`  Total: ${totalDocs} orders written to JSONL`);

  return allOrders;
}

// ---------------------------------------------------------------------------
// Phase 2: Download PDFs (parallel workers, each with own session)
// ---------------------------------------------------------------------------

type QueueItem = { order: SatOrder; dest: string; appealType: AppealTypeName };

interface WorkerResult {
  downloaded: number;
  failed: number;
  completedFiles: { appealType: AppealTypeName; filename: string }[];
}

/** Single worker: owns its session, processes its chunk serially */
async function pdfWorker(
  workerId: number,
  chunk: QueueItem[],
  totalAcrossWorkers: number,
  sharedCounter: { done: number; failed: number },
): Promise<WorkerResult> {
  const result: WorkerResult = { downloaded: 0, failed: 0, completedFiles: [] };
  if (chunk.length === 0) return result;

  let session = await getSession();
  console.log(`  [W${workerId}] Session acquired (${chunk.length} items)`);

  for (let i = 0; i < chunk.length; i++) {
    const item = chunk[i];

    // Refresh session periodically
    if (session.requestCount >= PDF_SESSION_REFRESH_INTERVAL) {
      session = await getSession();
      await sleep(DELAY_BETWEEN_PDFS_MS);
    }

    try {
      await sleep(DELAY_BETWEEN_PDFS_MS);

      const response = await fetchOrderDocument(session, item.order.id);

      if (response.status !== 'success') {
        result.failed++;
        sharedCounter.failed++;
        continue;
      }

      // Decode base64 PDF
      const pdfBuffer = Buffer.from(response.content, 'base64');

      // Validate PDF header
      if (pdfBuffer.length < 4 || pdfBuffer.toString('utf-8', 0, 4) !== '%PDF') {
        result.failed++;
        sharedCounter.failed++;
        continue;
      }

      // Atomic write
      const tmpDest = `${item.dest}.tmp`;
      fs.writeFileSync(tmpDest, pdfBuffer);
      fs.renameSync(tmpDest, item.dest);

      item.order.pdf_size_bytes = pdfBuffer.length;
      result.downloaded++;
      result.completedFiles.push({
        appealType: item.appealType,
        filename: item.order.pdf_filename,
      });
      sharedCounter.done++;

      // Log every 50 per worker
      if (result.downloaded % 50 === 0) {
        const globalPct = (
          ((sharedCounter.done + sharedCounter.failed) / totalAcrossWorkers) *
          100
        ).toFixed(1);
        const sizeKb = (pdfBuffer.length / 1024).toFixed(0);
        console.log(
          `  [W${workerId}] ${result.downloaded}/${chunk.length} | Global: ${globalPct}% (${sharedCounter.done} ok, ${sharedCounter.failed} fail) | Last: ID=${item.order.id} (${sizeKb}KB)`,
        );
      }
    } catch (err) {
      result.failed++;
      sharedCounter.failed++;

      // Refresh session on error
      try {
        session = await getSession();
        await sleep(RETRY_DELAY_MS);
      } catch {
        console.error(`  [W${workerId}] FATAL: Cannot refresh session, stopping worker.`);
        break;
      }
    }
  }

  console.log(`  [W${workerId}] Finished: ${result.downloaded} ok, ${result.failed} failed`);
  return result;
}

async function downloadPdfs(
  allOrders: Map<AppealTypeName, SatOrder[]>,
  opts: { testMode?: boolean; maxPdfs?: number },
): Promise<void> {
  const progress = loadProgress();
  let skippedCount = 0;

  // Build download queue
  const queue: QueueItem[] = [];

  for (const [appealType, orders] of allOrders) {
    const catDir = path.join(PDFS_DIR, appealType);
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

    const completedForType = progress.pdfs_completed[appealType] || [];

    for (const order of orders) {
      const dest = path.join(catDir, order.pdf_filename);

      if (completedForType.includes(order.pdf_filename)) {
        skippedCount++;
        continue;
      }

      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        if (!completedForType.includes(order.pdf_filename)) {
          completedForType.push(order.pdf_filename);
        }
        skippedCount++;
        continue;
      }

      queue.push({ order, dest, appealType });
    }

    progress.pdfs_completed[appealType] = completedForType;
  }

  saveProgress(progress);

  let totalToDownload = queue.length;
  if (opts.maxPdfs && opts.maxPdfs < totalToDownload) {
    queue.length = opts.maxPdfs;
    totalToDownload = opts.maxPdfs;
  }

  const numWorkers = opts.testMode ? 1 : Math.min(PARALLEL_WORKERS, totalToDownload);

  console.log(`\n=== Phase 2: Downloading PDFs (${numWorkers} parallel workers) ===`);
  console.log(`  Queue: ${totalToDownload}, Skipped (already done): ${skippedCount}`);
  console.log(`  Workers: ${numWorkers} (each with own session + token chain)\n`);

  if (totalToDownload === 0) {
    console.log('  Nothing to download.');
    return;
  }

  // Split queue into N chunks for workers
  const chunks: QueueItem[][] = Array.from({ length: numWorkers }, () => []);
  for (let i = 0; i < queue.length; i++) {
    chunks[i % numWorkers].push(queue[i]);
  }

  // Shared counter for global progress
  const sharedCounter = { done: 0, failed: 0 };

  // Launch all workers in parallel
  const results = await Promise.all(
    chunks.map((chunk, idx) => pdfWorker(idx, chunk, totalToDownload, sharedCounter)),
  );

  // Merge results into progress
  let totalDownloaded = 0;
  let totalFailed = 0;
  for (const r of results) {
    totalDownloaded += r.downloaded;
    totalFailed += r.failed;
    for (const f of r.completedFiles) {
      if (!progress.pdfs_completed[f.appealType]) {
        progress.pdfs_completed[f.appealType] = [];
      }
      if (!progress.pdfs_completed[f.appealType].includes(f.filename)) {
        progress.pdfs_completed[f.appealType].push(f.filename);
      }
    }
  }
  progress.total_pdfs_downloaded += totalDownloaded;
  saveProgress(progress);

  console.log(
    `\n  Done: ${totalDownloaded} downloaded, ${totalFailed} failed, ${skippedCount} skipped\n`,
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Verification
// ---------------------------------------------------------------------------

function verify(allOrders: Map<AppealTypeName, SatOrder[]>): void {
  console.log(`\n=== Phase 3: Verification ===\n`);

  let totalExpected = 0;
  let totalFound = 0;
  const missing: { appeal_type: string; id: number; filename: string }[] = [];

  for (const [appealType, orders] of allOrders) {
    const catDir = path.join(PDFS_DIR, appealType);
    let catExpected = 0;
    let catFound = 0;

    for (const order of orders) {
      catExpected++;
      const dest = path.join(catDir, order.pdf_filename);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        catFound++;
      } else {
        missing.push({
          appeal_type: appealType,
          id: order.id,
          filename: order.pdf_filename,
        });
      }
    }

    totalExpected += catExpected;
    totalFound += catFound;

    const status = catFound === catExpected ? 'OK' : 'INCOMPLETE';
    console.log(`  ${appealType}: ${catFound}/${catExpected} PDFs [${status}]`);
  }

  console.log(`\n  TOTAL: ${totalFound}/${totalExpected} PDFs downloaded`);

  if (missing.length > 0) {
    const missingFile = path.join(DATA_DIR, 'missing-pdfs.json');
    fs.writeFileSync(missingFile, JSON.stringify(missing, null, 2));
    console.log(`  Missing ${missing.length} PDFs (saved to ${missingFile})`);
    for (const m of missing.slice(0, 10)) {
      console.log(`    - ${m.appeal_type} ID=${m.id}: ${m.filename}`);
    }
    if (missing.length > 10) {
      console.log(`    ... and ${missing.length - 10} more`);
    }
  } else {
    console.log(`  All PDFs accounted for!`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isTest = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');

  // Parse --appeal-type
  let appealTypeFilter: AppealTypeName | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--appeal-type' && args[i + 1]) {
      const val = args[i + 1].toLowerCase() as AppealTypeName;
      if (ALL_APPEAL_TYPE_NAMES.includes(val)) {
        appealTypeFilter = val;
      } else {
        console.error(`Unknown appeal type: ${val}. Valid: ${ALL_APPEAL_TYPE_NAMES.join(', ')}`);
        process.exit(1);
      }
    }
  }

  // Parse --year
  let yearFilter: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) {
      yearFilter = parseInt(args[i + 1], 10);
      if (isNaN(yearFilter) || yearFilter < 2000 || yearFilter > 2030) {
        console.error(`Invalid year: ${args[i + 1]}`);
        process.exit(1);
      }
    }
  }

  const appealTypes = appealTypeFilter
    ? APPEAL_TYPES.filter((a) => a.name === appealTypeFilter)
    : APPEAL_TYPES;

  // Ensure directories exist
  fs.mkdirSync(METADATA_DIR, { recursive: true });
  for (const at of ALL_APPEAL_TYPE_NAMES) {
    fs.mkdirSync(path.join(PDFS_DIR, at), { recursive: true });
  }

  console.log(`SAT Scraper - Securities Appellate Tribunal`);
  console.log(`  Appeal Types: ${appealTypes.map((a) => a.label).join(', ')}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(
    `  Mode: ${metadataOnly ? 'metadata-only' : downloadOnly ? 'download-only' : 'full'}`,
  );
  if (yearFilter) console.log(`  Year filter: ${yearFilter}`);
  if (isTest) console.log(`  TEST MODE: 1 month metadata, 5 PDFs max`);

  let allOrders: Map<AppealTypeName, SatOrder[]>;

  if (downloadOnly) {
    // Load existing metadata
    allOrders = new Map();
    for (const config of appealTypes) {
      const orders: SatOrder[] = [];
      const monthKeys = generateMonthKeys(config);
      for (const key of monthKeys) {
        const monthFile = path.join(METADATA_DIR, `sat-${key.toLowerCase()}.json`);
        if (fs.existsSync(monthFile)) {
          const meta: MonthMetadata = JSON.parse(fs.readFileSync(monthFile, 'utf-8'));
          orders.push(...meta.orders);
        }
      }
      if (orders.length === 0) {
        console.error(`  [ERROR] No metadata for ${config.label}. Run metadata scrape first.`);
      } else {
        console.log(`  Loaded ${orders.length} ${config.label} orders from metadata`);
        allOrders.set(config.name, orders);
      }
    }
  } else {
    allOrders = await scrapeMetadata(appealTypes, {
      testMode: isTest,
      yearFilter,
    });
  }

  if (!metadataOnly) {
    const maxPdfs = isTest ? 5 : undefined;
    await downloadPdfs(allOrders, { testMode: isTest, maxPdfs });
  }

  verify(allOrders);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
