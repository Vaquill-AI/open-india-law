/**
 * Punjab RERA + REAT Scraper
 * Scrapes orders from https://rera.punjab.gov.in
 *
 * Punjab RERA dumps ALL orders in a single server-rendered HTML page (~4MB).
 * No pagination, no AJAX, no CAPTCHA. Just fetch and parse.
 *
 * RERA Orders:  ~4,148 (authority decisions on complaints)
 * REAT Orders:  ~400   (appellate tribunal decisions)
 *
 * Tech: ASP.NET MVC + IIS 10, __RequestVerificationToken in forms
 * PDFs: Hosted at rera.punjab.gov.in/rera/rwdataOrdersJudgements/...
 *       URL encoding issue (backslashes in HTML) requires fixup.
 *
 * Usage:
 *   npx tsx scripts/rera-punjab-scraper.ts                    # Full run (metadata + PDFs)
 *   npx tsx scripts/rera-punjab-scraper.ts --metadata-only    # Metadata only
 *   npx tsx scripts/rera-punjab-scraper.ts --download-only    # PDFs only (needs metadata)
 *   npx tsx scripts/rera-punjab-scraper.ts --test             # Test (5 orders, 2 PDFs)
 *   npx tsx scripts/rera-punjab-scraper.ts --reat-only        # REAT orders only
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

const BASE_URL = 'https://rera.punjab.gov.in';
const RERA_ORDERS_PATH = '/reraindex/CourtView/OrderJudgementsInfo';
const REAT_ORDERS_PATH = '/reraindex/courtREAT/REATcourtOrderJudgementsAppellateTribunalInfo';

const DATA_DIR = path.resolve(__dirname, '../data/tribunals/rera-punjab');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

const DELAY_BETWEEN_PDFS_MS = 300;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const PARALLEL_PDF_WORKERS = parseInt(process.env.WORKERS || '3', 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReraOrder {
  sr_no: number;
  complaint_no: string;
  complainant: string;
  respondent: string;
  order_date: string;
  pdf_url: string;
  pdf_filename: string;
  source: 'rera' | 'reat';
  tribunal: string;
  court: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  rera_metadata_done: boolean;
  reat_metadata_done: boolean;
  pdfs_completed: string[];
  total_orders_found: number;
  total_pdfs_downloaded: number;
  last_updated: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    rera_metadata_done: false,
    reat_metadata_done: false,
    pdfs_completed: [],
    total_orders_found: 0,
    total_pdfs_downloaded: 0,
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function slugify(text: string, maxLen = 80): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

/**
 * Fix Punjab RERA PDF URLs.
 * The HTML contains backslashes instead of forward slashes in paths:
 *   .../rwdataOrdersJudgements\2026\M4321\/20260213FormM_OJbyAuth{GUID}.pdf
 * Also has double slashes after case ID.
 */
function fixPdfUrl(rawUrl: string): string {
  return rawUrl
    .replace(/\\/g, '/') // backslashes -> forward slashes
    .replace(/\/\//g, '/') // double slashes -> single
    .replace('https:/', 'https://'); // restore protocol double slash
}

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// HTTP Client
// ---------------------------------------------------------------------------

function httpGet(
  url: string,
  options: { timeout?: number; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        rejectUnauthorized: false,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          ...options.headers,
        },
        timeout: options.timeout || 120_000,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${BASE_URL}${res.headers.location}`;
          httpGet(redirectUrl, options).then(resolve).catch(reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout: ${url}`));
    });
    req.end();
  });
}

function downloadPdf(url: string, filepath: string): Promise<{ success: boolean; size: number }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        rejectUnauthorized: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Referer: `${BASE_URL}${RERA_ORDERS_PATH}`,
        },
        timeout: 60_000,
      },
      (res) => {
        if (res.statusCode === 200) {
          const ws = fs.createWriteStream(filepath);
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            ws.write(chunk);
          });
          res.on('end', () => {
            ws.end();
            resolve({ success: true, size });
          });
          res.on('error', (err) => {
            ws.end();
            reject(err);
          });
        } else {
          // Consume response
          res.resume();
          resolve({ success: false, size: 0 });
        }
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`PDF download timeout: ${url}`));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTML Parser
// ---------------------------------------------------------------------------

/**
 * Parse Punjab RERA/REAT HTML table.
 *
 * RERA columns: Sr.No | Complaint No | Complainant | Respondent | Date | PDF
 * REAT columns: Sr.No | Appeal No | Complainant(NA) | Respondent | Against | Date | PDF
 */
function parseOrdersHtml(html: string, source: 'rera' | 'reat'): ReraOrder[] {
  const orders: ReraOrder[] = [];
  const now = new Date().toISOString();

  // Match table rows: <tr> ... </tr>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Extract all <td> contents
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(tdMatch[1]);
    }

    // Skip header rows or rows without enough cells
    if (cells.length < 5) continue;

    // Extract sr_no - must be a number
    const srNo = parseInt(stripHtml(cells[0]), 10);
    if (isNaN(srNo)) continue;

    // Extract PDF URL from the last cell
    const pdfLinkMatch = cells[cells.length - 1].match(/href="([^"]*\.pdf[^"]*)"/i);
    const rawPdfUrl = pdfLinkMatch ? pdfLinkMatch[1] : '';
    const pdfUrl = rawPdfUrl ? fixPdfUrl(rawPdfUrl) : '';

    let complaintNo: string;
    let complainant: string;
    let respondent: string;
    let orderDate: string;

    if (source === 'rera') {
      // RERA: Sr.No | Complaint No | Complainant | Respondent | Date | PDF
      complaintNo = stripHtml(cells[1]);
      complainant = stripHtml(cells[2]);
      respondent = stripHtml(cells[3]);
      orderDate = stripHtml(cells[4]);
    } else {
      // REAT: Sr.No | Appeal No | Complainant | Respondent | Against | Date | PDF
      complaintNo = stripHtml(cells[1]);
      complainant = stripHtml(cells[2]);
      respondent = stripHtml(cells[3]);
      // cells[4] is "Against" - skip
      orderDate = stripHtml(cells[cells.length - 2]);
    }

    // Generate a filename for the PDF
    const dateSlug = orderDate.replace(/[^0-9A-Za-z-]/g, '-');
    const caseSlug = slugify(complaintNo);
    const pdfFilename = pdfUrl ? `punjab_${source}_${caseSlug}_${dateSlug}.pdf` : '';

    orders.push({
      sr_no: srNo,
      complaint_no: complaintNo,
      complainant,
      respondent,
      order_date: orderDate,
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      source,
      tribunal: source === 'rera' ? 'Punjab RERA' : 'Punjab REAT',
      court: 'Real Estate Regulatory Authority, Punjab',
      country: 'India',
      scraped_at: now,
    });
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Scraping Logic
// ---------------------------------------------------------------------------

async function scrapeMetadata(source: 'rera' | 'reat'): Promise<ReraOrder[]> {
  const urlPath = source === 'rera' ? RERA_ORDERS_PATH : REAT_ORDERS_PATH;
  const fullUrl = `${BASE_URL}${urlPath}`;
  const label = source.toUpperCase();

  console.log(`\n[${label}] Fetching orders from ${fullUrl}`);

  let html: string;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await httpGet(fullUrl, { timeout: 180_000 });
      if (resp.status !== 200) {
        throw new Error(`HTTP ${resp.status}`);
      }
      html = resp.body;
      console.log(`[${label}] Received ${(html.length / 1024 / 1024).toFixed(1)}MB`);
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${label}] Attempt ${attempt} failed: ${msg}`);
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  const orders = parseOrdersHtml(html!, source);
  console.log(`[${label}] Parsed ${orders.length} orders`);

  // Save metadata
  const metaFile = path.join(METADATA_DIR, `punjab-${source}-orders.json`);
  fs.writeFileSync(metaFile, JSON.stringify(orders, null, 2));

  // Save as JSONL for pipeline
  const jsonlFile = path.join(DATA_DIR, `punjab-${source}-all-metadata.jsonl`);
  const jsonlContent = orders.map((o) => JSON.stringify(o)).join('\n') + '\n';
  fs.writeFileSync(jsonlFile, jsonlContent);
  console.log(`[${label}] Saved metadata to ${metaFile}`);

  return orders;
}

async function downloadPdfs(
  orders: ReraOrder[],
  progress: Progress,
  limit?: number,
): Promise<void> {
  const toDownload = orders.filter(
    (o) => o.pdf_url && !progress.pdfs_completed.includes(o.pdf_filename),
  );

  const queue = limit ? toDownload.slice(0, limit) : toDownload;
  console.log(
    `\n[PDF] ${queue.length} to download (${toDownload.length - queue.length} skipped by limit, ${orders.length - toDownload.length} already done)`,
  );

  let downloaded = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < queue.length; i += PARALLEL_PDF_WORKERS) {
    const batch = queue.slice(i, i + PARALLEL_PDF_WORKERS);
    const results = await Promise.allSettled(
      batch.map(async (order) => {
        const filepath = path.join(PDFS_DIR, order.pdf_filename);
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = await downloadPdf(order.pdf_url, filepath);
            if (result.success && result.size > 0) {
              progress.pdfs_completed.push(order.pdf_filename);
              progress.total_pdfs_downloaded++;
              downloaded++;
              return { success: true, order };
            }
            // 404 or empty - skip
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            return { success: false, order };
          } catch {
            if (attempt === MAX_RETRIES) {
              if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
              return { success: false, order };
            }
            await sleep(RETRY_DELAY_MS);
          }
        }
        return { success: false, order };
      }),
    );

    for (const r of results) {
      if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.success)) {
        failed++;
      }
    }

    saveProgress(progress);

    if (i % 30 === 0 && i > 0) {
      console.log(
        `[PDF] Progress: ${downloaded} downloaded, ${failed} failed, ${i + batch.length}/${queue.length} processed`,
      );
    }

    await sleep(DELAY_BETWEEN_PDFS_MS);
  }

  console.log(`[PDF] Complete: ${downloaded} downloaded, ${failed} failed out of ${queue.length}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');
  const testMode = args.includes('--test');
  const reatOnly = args.includes('--reat-only');
  const reraOnly = args.includes('--rera-only');

  ensureDirs();
  const progress = loadProgress();

  console.log('=== Punjab RERA/REAT Scraper ===');
  console.log(
    `Mode: ${testMode ? 'TEST' : metadataOnly ? 'METADATA ONLY' : downloadOnly ? 'DOWNLOAD ONLY' : 'FULL'}`,
  );
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(
    `Progress: ${progress.total_orders_found} orders, ${progress.total_pdfs_downloaded} PDFs\n`,
  );

  const allOrders: ReraOrder[] = [];

  // ── Metadata Phase ──
  if (!downloadOnly) {
    if (!reatOnly) {
      const reraOrders = await scrapeMetadata('rera');
      progress.rera_metadata_done = true;
      allOrders.push(...reraOrders);
    }

    if (!reraOnly) {
      const reatOrders = await scrapeMetadata('reat');
      progress.reat_metadata_done = true;
      allOrders.push(...reatOrders);
    }

    progress.total_orders_found = allOrders.length;
    saveProgress(progress);

    // Combined JSONL
    const combinedFile = path.join(DATA_DIR, 'punjab-all-metadata.jsonl');
    const combined = allOrders.map((o) => JSON.stringify(o)).join('\n') + '\n';
    fs.writeFileSync(combinedFile, combined);
    console.log(`\nTotal: ${allOrders.length} orders saved to ${combinedFile}`);
  }

  // ── PDF Phase ──
  if (!metadataOnly) {
    // Load from files if download-only
    if (downloadOnly || allOrders.length === 0) {
      for (const source of ['rera', 'reat'] as const) {
        if (reatOnly && source === 'rera') continue;
        if (reraOnly && source === 'reat') continue;
        const metaFile = path.join(METADATA_DIR, `punjab-${source}-orders.json`);
        if (fs.existsSync(metaFile)) {
          const loaded: ReraOrder[] = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
          allOrders.push(...loaded);
        }
      }
    }

    const pdfLimit = testMode ? 2 : undefined;
    const ordersWithPdfs = allOrders.filter((o) => o.pdf_url);
    console.log(`\n${ordersWithPdfs.length} orders have PDF URLs`);
    await downloadPdfs(ordersWithPdfs, progress, pdfLimit);
  }

  saveProgress(progress);
  console.log('\n=== Done ===');
  console.log(`Total orders: ${progress.total_orders_found}`);
  console.log(`Total PDFs: ${progress.total_pdfs_downloaded}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
