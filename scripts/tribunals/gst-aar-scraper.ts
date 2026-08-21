/**
 * GST AAR/AAAR Scraper - Authority for Advance Ruling / Appellate Authority
 * Scrapes advance ruling orders from https://gstcouncil.gov.in
 *
 * Data Sources:
 *   - AAR Orders:  /authority-for-advance-ruling  (~2,864 orders, 287 pages)
 *   - AAAR Orders: /appellate-orders              (~537 orders, 54 pages)
 *
 * Tech: Drupal 10 with standard Views pagination (?page=N), server-rendered HTML.
 * No auth, no CAPTCHA, no rate limiting. PDFs directly downloadable.
 *
 * Usage:
 *   npx tsx scripts/gst-aar-scraper.ts                          # Full run (metadata + PDFs)
 *   npx tsx scripts/gst-aar-scraper.ts --metadata-only          # Scrape metadata only
 *   npx tsx scripts/gst-aar-scraper.ts --download-only          # Download PDFs only (requires metadata)
 *   npx tsx scripts/gst-aar-scraper.ts --type aar               # AAR orders only
 *   npx tsx scripts/gst-aar-scraper.ts --type aaar              # AAAR orders only
 *   npx tsx scripts/gst-aar-scraper.ts --test                   # Test run (3 pages, max 5 PDFs)
 *   MAX_CONCURRENT=10 npx tsx scripts/gst-aar-scraper.ts        # Control concurrency
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://gstcouncil.gov.in';
const AAR_PATH = '/authority-for-advance-ruling';
const AAAR_PATH = '/appellate-orders';

const DATA_DIR = path.resolve(__dirname, '../data/tribunals/gst-aar');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const AAR_PDFS_DIR = path.join(PDFS_DIR, 'aar');
const AAAR_PDFS_DIR = path.join(PDFS_DIR, 'aaar');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const COMBINED_JSONL = path.join(DATA_DIR, 'gst-aar-all-metadata.jsonl');

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5', 10);
const DELAY_BETWEEN_PAGES_MS = parseInt(process.env.DELAY_BETWEEN_PAGES_MS || '800', 10);
const DELAY_BETWEEN_PDFS_MS = parseInt(process.env.DELAY_BETWEEN_PDFS_MS || '300', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || '2000', 10);
const REQUEST_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OrderType = 'aar' | 'aaar';

interface AAROrder {
  sr_no: number;
  applicant_name: string;
  state_ut: string;
  brief_of_order: string;
  order_no_date: string;
  pdf_url: string;
  pdf_filename: string;
  pdf_size: string;
  category: string;
  source_page: number;
  order_type: 'aar';
  tribunal: string;
  country: string;
}

interface AAAAROrder {
  sr_no: number;
  applicant_name: string;
  state_ut: string;
  appeal_order_no_date: string;
  brief_of_order: string;
  pdf_url: string;
  pdf_filename: string;
  pdf_size: string;
  original_ar_order: string;
  source_page: number;
  order_type: 'aaar';
  tribunal: string;
  country: string;
}

type GSTOrder = AAROrder | AAAAROrder;

interface TypeMetadata {
  order_type: OrderType;
  scraped_at: string;
  total_orders: number;
  total_pages_scraped: number;
  orders: GSTOrder[];
}

interface Progress {
  aar_pages_completed: number[];
  aaar_pages_completed: number[];
  aar_total_pages: number;
  aaar_total_pages: number;
  pdfs_downloaded: string[];
  last_updated: string;
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const metadataOnly = args.includes('--metadata-only');
const downloadOnly = args.includes('--download-only');
const testMode = args.includes('--test');

function getTypeFilter(): OrderType[] {
  const idx = args.indexOf('--type');
  if (idx !== -1 && args[idx + 1]) {
    const val = args[idx + 1] as OrderType;
    if (val === 'aar' || val === 'aaar') return [val];
    console.error(`Invalid --type: ${val}. Must be 'aar' or 'aaar'.`);
    process.exit(1);
  }
  return ['aar', 'aaar'];
}

const typeFilter = getTypeFilter();

const TEST_MAX_PAGES = 3;
const TEST_MAX_PDFS = 5;

// ---------------------------------------------------------------------------
// User-Agent Rotation
// ---------------------------------------------------------------------------

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ---------------------------------------------------------------------------
// Progress Helpers
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    aar_pages_completed: [],
    aaar_pages_completed: [],
    aar_total_pages: 0,
    aaar_total_pages: 0,
    pdfs_downloaded: [],
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(href: string): string {
  if (!href) return '';
  let url = href.replace(/&amp;/g, '&');
  if (url.startsWith('/')) {
    url = `${BASE_URL}${url}`;
  } else if (!url.startsWith('http')) {
    url = `${BASE_URL}/${url}`;
  }
  return url.replace('http://', 'https://');
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 200);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// HTTP Fetch with Retry
// ---------------------------------------------------------------------------

function fetchUrl(url: string, retries = MAX_RETRIES): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        rejectUnauthorized: false,
        headers: {
          'User-Agent': randomUA(),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        // Handle redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${BASE_URL}${res.headers.location}`;
          fetchUrl(redirectUrl, retries).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          const msg = `HTTP ${res.statusCode} for ${url}`;
          if (retries > 0) {
            console.warn(`  [WARN] ${msg}, retrying in ${RETRY_DELAY_MS}ms...`);
            setTimeout(() => {
              fetchUrl(url, retries - 1)
                .then(resolve)
                .catch(reject);
            }, RETRY_DELAY_MS);
          } else {
            reject(new Error(msg));
          }
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', (err) => {
          if (retries > 0) {
            setTimeout(() => {
              fetchUrl(url, retries - 1)
                .then(resolve)
                .catch(reject);
            }, RETRY_DELAY_MS);
          } else {
            reject(err);
          }
        });
      },
    );

    req.on('error', (err) => {
      if (retries > 0) {
        console.warn(`  [WARN] Network error: ${err.message}, retrying in ${RETRY_DELAY_MS}ms...`);
        setTimeout(() => {
          fetchUrl(url, retries - 1)
            .then(resolve)
            .catch(reject);
        }, RETRY_DELAY_MS);
      } else {
        reject(err);
      }
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      if (retries > 0) {
        console.warn(`  [WARN] Timeout for ${url}, retrying in ${RETRY_DELAY_MS}ms...`);
        setTimeout(() => {
          fetchUrl(url, retries - 1)
            .then(resolve)
            .catch(reject);
        }, RETRY_DELAY_MS);
      } else {
        reject(new Error(`Timeout: ${url}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// PDF Download with Retry + Atomic Write
// ---------------------------------------------------------------------------

async function downloadFile(url: string, dest: string, retries = MAX_RETRIES): Promise<boolean> {
  const dir = path.dirname(dest);
  ensureDir(dir);

  // Skip if already downloaded and non-empty
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return true;
  }

  const tmpDest = `${dest}.tmp`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await execAsync(`curl -sL --max-time 120 --retry 2 -o "${tmpDest}" "${url}"`, {
        timeout: 150_000,
      });

      if (fs.existsSync(tmpDest) && fs.statSync(tmpDest).size > 0) {
        fs.renameSync(tmpDest, dest);
        return true;
      }
    } catch {
      // Clean up partial download
      try {
        if (fs.existsSync(tmpDest)) fs.unlinkSync(tmpDest);
      } catch {}
    }

    if (attempt < retries) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  console.error(`  [FAIL] ${url}`);
  return false;
}

// ---------------------------------------------------------------------------
// HTML Parsing - AAR Orders
// ---------------------------------------------------------------------------

function parseAARPage(html: string, pageNum: number): AAROrder[] {
  const orders: AAROrder[] = [];

  // Extract the view-content table body
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return orders;

  const tbody = tbodyMatch[1];
  const rows = tbody.split('</tr>').filter((r) => r.includes('<td'));

  for (const row of rows) {
    const tds: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)(?=<\/td>)/g;
    let match: RegExpExecArray | null;
    while ((match = tdRegex.exec(row)) !== null) {
      tds.push(match[1]);
    }

    // AAR has 7 columns: Sr.No, Applicant, State, Brief, Order No & Date, Download, Category
    if (tds.length < 6) continue;

    const srNo = parseInt(stripHtml(tds[0]), 10);
    if (isNaN(srNo)) continue; // Skip header row or malformed

    // Extract PDF URL from download column
    const pdfHrefMatch = tds[5].match(/href="([^"]*\.pdf[^"]*)"/);
    const pdfUrl = pdfHrefMatch ? normalizeUrl(pdfHrefMatch[1]) : '';

    // Extract file size
    const sizeMatch = tds[5].match(/Size:\s*([^)<]+)/);
    const pdfSize = sizeMatch ? sizeMatch[1].trim() : '';

    // Generate filename from URL
    const pdfFilename = pdfUrl ? sanitizeFilename(path.basename(new URL(pdfUrl).pathname)) : '';

    orders.push({
      sr_no: srNo,
      applicant_name: stripHtml(tds[1]),
      state_ut: stripHtml(tds[2]),
      brief_of_order: stripHtml(tds[3]),
      order_no_date: stripHtml(tds[4]),
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      pdf_size: pdfSize,
      category: tds.length >= 7 ? stripHtml(tds[6]) : '',
      source_page: pageNum,
      order_type: 'aar',
      tribunal: 'GST-AAR',
      country: 'IN',
    });
  }

  return orders;
}

// ---------------------------------------------------------------------------
// HTML Parsing - AAAR (Appellate) Orders
// ---------------------------------------------------------------------------

function parseAAAARPage(html: string, pageNum: number): AAAAROrder[] {
  const orders: AAAAROrder[] = [];

  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return orders;

  const tbody = tbodyMatch[1];
  const rows = tbody.split('</tr>').filter((r) => r.includes('<td'));

  for (const row of rows) {
    const tds: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)(?=<\/td>)/g;
    let match: RegExpExecArray | null;
    while ((match = tdRegex.exec(row)) !== null) {
      tds.push(match[1]);
    }

    // AAAR has 7 columns: Sr.No, Applicant, State, Appeal Order No & Date, Brief, Download, Original AR Order
    if (tds.length < 6) continue;

    const srNo = parseInt(stripHtml(tds[0]), 10);
    if (isNaN(srNo)) continue;

    // Extract PDF URL from download column
    const pdfHrefMatch = tds[5].match(/href="([^"]*\.pdf[^"]*)"/);
    const pdfUrl = pdfHrefMatch ? normalizeUrl(pdfHrefMatch[1]) : '';

    // Extract file size
    const sizeMatch = tds[5].match(/Size:\s*([^)<]+)/);
    const pdfSize = sizeMatch ? sizeMatch[1].trim() : '';

    const pdfFilename = pdfUrl ? sanitizeFilename(path.basename(new URL(pdfUrl).pathname)) : '';

    orders.push({
      sr_no: srNo,
      applicant_name: stripHtml(tds[1]),
      state_ut: stripHtml(tds[2]),
      appeal_order_no_date: stripHtml(tds[3]),
      brief_of_order: stripHtml(tds[4]),
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      pdf_size: pdfSize,
      original_ar_order: tds.length >= 7 ? stripHtml(tds[6]) : '',
      source_page: pageNum,
      order_type: 'aaar',
      tribunal: 'GST-AAAR',
      country: 'IN',
    });
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Discover Total Pages
// ---------------------------------------------------------------------------

function extractTotalPages(html: string): number {
  // Drupal pager: <a href="?page=286" title="Go to last page">
  const lastPageMatch = html.match(/href="\?[^"]*page=(\d+)"[^>]*title="Go to last page"/);
  if (lastPageMatch) {
    return parseInt(lastPageMatch[1], 10);
  }

  // Fallback: find the highest page= value in pager links
  const pageMatches = html.matchAll(/href="\?[^"]*page=(\d+)"/g);
  let maxPage = 0;
  for (const m of pageMatches) {
    const p = parseInt(m[1], 10);
    if (p > maxPage) maxPage = p;
  }
  return maxPage;
}

// ---------------------------------------------------------------------------
// Phase 1: Metadata Scraping
// ---------------------------------------------------------------------------

async function scrapeMetadata(orderType: OrderType, progress: Progress): Promise<GSTOrder[]> {
  const urlPath = orderType === 'aar' ? AAR_PATH : AAAR_PATH;
  const label = orderType.toUpperCase();
  const pagesCompleted =
    orderType === 'aar' ? progress.aar_pages_completed : progress.aaar_pages_completed;

  console.log(`\n=== Phase 1: Scraping ${label} Metadata ===`);

  // Fetch first page to discover total pages
  const firstPageUrl = `${BASE_URL}${urlPath}`;
  console.log(`  [FETCH] ${firstPageUrl}`);
  const firstPageHtml = await fetchUrl(firstPageUrl);

  let totalPages = extractTotalPages(firstPageHtml);
  if (totalPages === 0) {
    // Single page only
    totalPages = 0;
  }

  // Store total pages in progress for resume info
  if (orderType === 'aar') {
    progress.aar_total_pages = totalPages;
  } else {
    progress.aaar_total_pages = totalPages;
  }

  const maxPages = testMode ? Math.min(TEST_MAX_PAGES - 1, totalPages) : totalPages;
  console.log(
    `  [INFO] ${label}: ${totalPages + 1} total pages (0..${totalPages})${testMode ? `, test mode: scraping 0..${maxPages}` : ''}`,
  );

  const allOrders: GSTOrder[] = [];

  for (let page = 0; page <= maxPages; page++) {
    // Check if already scraped
    if (pagesCompleted.includes(page)) {
      console.log(`  [SKIP] ${label} page ${page} - already scraped`);
      continue;
    }

    const pageUrl = page === 0 ? `${BASE_URL}${urlPath}` : `${BASE_URL}${urlPath}?page=${page}`;

    try {
      const html = page === 0 ? firstPageHtml : await fetchUrl(pageUrl);

      const orders = orderType === 'aar' ? parseAARPage(html, page) : parseAAAARPage(html, page);

      allOrders.push(...orders);
      pagesCompleted.push(page);
      saveProgress(progress);

      const pct = (((page + 1) / (maxPages + 1)) * 100).toFixed(1);
      console.log(`  [OK]   ${label} page ${page}/${maxPages}: ${orders.length} orders (${pct}%)`);

      // Polite delay between pages
      if (page < maxPages) {
        await sleep(DELAY_BETWEEN_PAGES_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] ${label} page ${page}: ${msg}`);
      // Continue to next page rather than failing entirely
    }
  }

  return allOrders;
}

// ---------------------------------------------------------------------------
// Phase 2: PDF Download
// ---------------------------------------------------------------------------

async function downloadPdfs(
  allOrders: GSTOrder[],
  progress: Progress,
): Promise<{ ok: number; fail: number; skipped: number }> {
  console.log(`\n=== Phase 2: Downloading PDFs ===`);

  // Build download queue (deduplicated by filename)
  const queue: Array<{
    url: string;
    dest: string;
    filename: string;
    label: string;
  }> = [];
  const seenFilenames = new Set<string>(progress.pdfs_downloaded);

  for (const order of allOrders) {
    if (!order.pdf_url || !order.pdf_filename) continue;
    if (seenFilenames.has(order.pdf_filename)) continue;

    const subDir = order.order_type === 'aar' ? AAR_PDFS_DIR : AAAR_PDFS_DIR;
    const dest = path.join(subDir, order.pdf_filename);

    // Also skip if file already exists on disk
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      progress.pdfs_downloaded.push(order.pdf_filename);
      seenFilenames.add(order.pdf_filename);
      continue;
    }

    seenFilenames.add(order.pdf_filename);
    queue.push({
      url: order.pdf_url,
      dest,
      filename: order.pdf_filename,
      label: `${order.order_type.toUpperCase()} #${order.sr_no}`,
    });
  }

  const maxDownloads = testMode ? Math.min(TEST_MAX_PDFS, queue.length) : queue.length;
  const downloadQueue = queue.slice(0, maxDownloads);

  console.log(
    `  [INFO] ${downloadQueue.length} PDFs to download (${queue.length - downloadQueue.length} skipped/already done)`,
  );

  let ok = 0;
  let fail = 0;
  let idx = 0;

  while (idx < downloadQueue.length) {
    const batch = downloadQueue.slice(idx, idx + MAX_CONCURRENT);

    const results = await Promise.all(
      batch.map(async (item) => {
        const success = await downloadFile(item.url, item.dest);
        return { ...item, success };
      }),
    );

    for (const r of results) {
      if (r.success) {
        ok++;
        progress.pdfs_downloaded.push(r.filename);
      } else {
        fail++;
      }
    }

    saveProgress(progress);

    const total = ok + fail;
    const pct = ((total / downloadQueue.length) * 100).toFixed(1);
    const batchOk = results.filter((r) => r.success).length;
    const batchFail = results.filter((r) => !r.success).length;
    console.log(
      `  [${pct}%] Batch: ${batchOk} ok, ${batchFail} fail | Total: ${ok} downloaded, ${fail} failed (${total}/${downloadQueue.length})`,
    );

    idx += MAX_CONCURRENT;

    if (idx < downloadQueue.length) {
      await sleep(DELAY_BETWEEN_PDFS_MS);
    }
  }

  const skipped = allOrders.filter(
    (o) => o.pdf_url && !downloadQueue.find((q) => q.url === o.pdf_url),
  ).length;

  return { ok, fail, skipped };
}

// ---------------------------------------------------------------------------
// Phase 3: Verification
// ---------------------------------------------------------------------------

function verify(allOrders: GSTOrder[]): void {
  console.log(`\n=== Phase 3: Verification ===`);

  const aarOrders = allOrders.filter((o) => o.order_type === 'aar');
  const aaarOrders = allOrders.filter((o) => o.order_type === 'aaar');

  const aarWithPdf = aarOrders.filter((o) => o.pdf_url);
  const aaarWithPdf = aaarOrders.filter((o) => o.pdf_url);

  // Count actual PDFs on disk
  const aarOnDisk = fs.existsSync(AAR_PDFS_DIR)
    ? fs.readdirSync(AAR_PDFS_DIR).filter((f) => f.endsWith('.pdf')).length
    : 0;
  const aaarOnDisk = fs.existsSync(AAAR_PDFS_DIR)
    ? fs.readdirSync(AAAR_PDFS_DIR).filter((f) => f.endsWith('.pdf')).length
    : 0;

  console.log(
    `  AAR  : ${aarOrders.length} orders, ${aarWithPdf.length} with PDF, ${aarOnDisk} downloaded`,
  );
  console.log(
    `  AAAR : ${aaarOrders.length} orders, ${aaarWithPdf.length} with PDF, ${aaarOnDisk} downloaded`,
  );
  console.log(
    `  Total: ${allOrders.length} orders, ${aarWithPdf.length + aaarWithPdf.length} with PDF, ${aarOnDisk + aaarOnDisk} downloaded`,
  );

  // List missing PDFs
  const missing: Array<{ type: string; name: string; url: string }> = [];

  for (const order of allOrders) {
    if (!order.pdf_url || !order.pdf_filename) continue;
    const subDir = order.order_type === 'aar' ? AAR_PDFS_DIR : AAAR_PDFS_DIR;
    const dest = path.join(subDir, order.pdf_filename);
    if (!fs.existsSync(dest)) {
      missing.push({
        type: order.order_type.toUpperCase(),
        name: order.applicant_name,
        url: order.pdf_url,
      });
    }
  }

  if (missing.length > 0) {
    console.log(`\n  [WARN] ${missing.length} PDFs missing:`);
    for (const m of missing.slice(0, 20)) {
      console.log(`    ${m.type}: ${m.name} -> ${m.url}`);
    }
    if (missing.length > 20) {
      console.log(`    ... and ${missing.length - 20} more`);
    }
  } else {
    console.log(`\n  [OK] All PDFs downloaded successfully!`);
  }
}

// ---------------------------------------------------------------------------
// Write Metadata Files
// ---------------------------------------------------------------------------

function writeMetadata(orderType: OrderType, orders: GSTOrder[]): void {
  const metaFile = path.join(METADATA_DIR, `${orderType}-orders.json`);
  const metadata: TypeMetadata = {
    order_type: orderType,
    scraped_at: new Date().toISOString(),
    total_orders: orders.length,
    total_pages_scraped: new Set(orders.map((o) => o.source_page)).size,
    orders,
  };
  fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
  console.log(`  [SAVE] ${metaFile} (${orders.length} orders)`);
}

function writeCombinedJsonl(allOrders: GSTOrder[]): void {
  const stream = fs.createWriteStream(COMBINED_JSONL);
  let count = 0;
  for (const order of allOrders) {
    stream.write(JSON.stringify(order) + '\n');
    count++;
  }
  stream.end();
  console.log(`  [SAVE] ${COMBINED_JSONL} (${count} records)`);
}

function loadExistingMetadata(orderType: OrderType): GSTOrder[] {
  const metaFile = path.join(METADATA_DIR, `${orderType}-orders.json`);
  if (fs.existsSync(metaFile)) {
    const data: TypeMetadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    return data.orders;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('============================================');
  console.log('  GST AAR/AAAR Scraper');
  console.log('============================================');
  console.log(
    `  Mode: ${metadataOnly ? 'metadata-only' : downloadOnly ? 'download-only' : 'full'}`,
  );
  console.log(`  Types: ${typeFilter.join(', ')}`);
  console.log(`  Test: ${testMode}`);
  console.log(`  Concurrency: ${MAX_CONCURRENT}`);
  console.log(`  Page delay: ${DELAY_BETWEEN_PAGES_MS}ms`);
  console.log(`  PDF delay: ${DELAY_BETWEEN_PDFS_MS}ms`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log('============================================');

  // Ensure directories
  ensureDir(DATA_DIR);
  ensureDir(METADATA_DIR);
  ensureDir(AAR_PDFS_DIR);
  ensureDir(AAAR_PDFS_DIR);

  const progress = loadProgress();
  const allOrders: GSTOrder[] = [];

  // Phase 1: Metadata
  if (!downloadOnly) {
    for (const orderType of typeFilter) {
      const orders = await scrapeMetadata(orderType, progress);

      // Merge with any previously scraped orders from completed pages
      const existingOrders = loadExistingMetadata(orderType);
      const existingPages = new Set(existingOrders.map((o) => o.source_page));
      const newPages = new Set(orders.map((o) => o.source_page));

      // Keep existing orders from pages we didn't re-scrape
      const merged = [...existingOrders.filter((o) => !newPages.has(o.source_page)), ...orders];

      // Sort by sr_no
      merged.sort((a, b) => a.sr_no - b.sr_no);

      writeMetadata(orderType, merged);
      allOrders.push(...merged);

      const newPagesCount = [...newPages].filter((p) => !existingPages.has(p)).length;
      console.log(
        `  [INFO] ${orderType.toUpperCase()}: ${merged.length} total orders (${newPagesCount} new pages this run)`,
      );
    }

    writeCombinedJsonl(allOrders);
  } else {
    // Download-only: load existing metadata
    for (const orderType of typeFilter) {
      const orders = loadExistingMetadata(orderType);
      if (orders.length === 0) {
        console.error(
          `  [ERROR] No metadata found for ${orderType}. Run without --download-only first.`,
        );
        process.exit(1);
      }
      allOrders.push(...orders);
      console.log(`  [LOAD] ${orderType.toUpperCase()}: ${orders.length} orders from metadata`);
    }
  }

  // Phase 2: PDFs
  if (!metadataOnly) {
    const { ok, fail, skipped } = await downloadPdfs(allOrders, progress);
    console.log(`\n  PDF Summary: ${ok} downloaded, ${fail} failed, ${skipped} skipped`);
  }

  // Phase 3: Verification
  verify(allOrders);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
