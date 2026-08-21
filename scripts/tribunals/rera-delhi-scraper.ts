/**
 * Delhi RERA + REAT Scraper
 * Scrapes orders from https://erera.co.in (old ASP.NET backend behind Angular SPA)
 *
 * Delhi RERA Authority orders: ~10,465 (server-rendered HTML table, single page ~9.5MB)
 * Delhi REAT Appellate orders: ~402   (server-rendered HTML table, single page ~480KB)
 *
 * Authority order columns: Sr.No | Complaint Number | Complainant Name | Respondent Name | Date | PDF
 * REAT order columns:      Sr.No | Appeal Number | Date | PDF
 *
 * Tech: ASP.NET MVC + IIS 10 (legacy backend, Angular SPA wraps via iframe/externallink)
 * PDFs: Authority orders hosted at erera.co.in/delhirera/rwdataOrdersJudgements2019/...  (working)
 *       REAT orders hosted at erera.co.in/delhirera/readwriteReatOrder/...              (404 - broken)
 *
 * Usage:
 *   npx tsx scripts/rera-delhi-scraper.ts                    # Full run (metadata + PDFs)
 *   npx tsx scripts/rera-delhi-scraper.ts --metadata-only    # Metadata only
 *   npx tsx scripts/rera-delhi-scraper.ts --download-only    # PDFs only (needs metadata)
 *   npx tsx scripts/rera-delhi-scraper.ts --test             # Test (5 orders, 2 PDFs)
 *   npx tsx scripts/rera-delhi-scraper.ts --reat-only        # REAT orders only
 *   npx tsx scripts/rera-delhi-scraper.ts --rera-only        # RERA authority orders only
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

const BASE_URL = 'https://erera.co.in';
const RERA_AUTHORITY_PATH = '/reradelhiindex/courtview/OrderJudgementsAuthorityInfo';
const REAT_ORDERS_PATH = '/reradelhiindex/courtREAT/REATcourtOrderJudgementsAppellateTribunalInfo';

const DATA_DIR = path.resolve(__dirname, '../data/tribunals/rera-delhi');
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

interface DelhiOrder {
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

function downloadPdf(
  url: string,
  filepath: string,
  referer: string,
): Promise<{ success: boolean; size: number }> {
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
          Referer: referer,
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
          // Consume response body
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
// HTML Parsers
// ---------------------------------------------------------------------------

/**
 * Parse Delhi RERA Authority orders HTML table.
 * Columns: Sr.No | Complaint Number | Complainant Name | Respondent Name | Date | PDF
 */
function parseAuthorityOrders(html: string): DelhiOrder[] {
  const orders: DelhiOrder[] = [];
  const now = new Date().toISOString();

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(tdMatch[1]);
    }

    // Authority orders have 6 cells
    if (cells.length < 6) continue;

    const srNo = parseInt(stripHtml(cells[0]), 10);
    if (isNaN(srNo)) continue;

    const complaintNo = stripHtml(cells[1]);
    const complainant = stripHtml(cells[2]);
    const respondent = stripHtml(cells[3]);
    const orderDate = stripHtml(cells[4]);

    // Extract PDF URL
    const pdfLinkMatch = cells[5].match(/href="([^"]*\.pdf[^"]*)"/i);
    const pdfUrl = pdfLinkMatch ? pdfLinkMatch[1] : '';

    const dateSlug = orderDate.replace(/[^0-9A-Za-z-]/g, '-');
    const caseSlug = slugify(complaintNo);
    const pdfFilename = pdfUrl ? `delhi_rera_${caseSlug}_${dateSlug}.pdf` : '';

    orders.push({
      sr_no: srNo,
      complaint_no: complaintNo,
      complainant,
      respondent,
      order_date: orderDate,
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      source: 'rera',
      tribunal: 'Delhi RERA',
      court: 'Real Estate Regulatory Authority, NCT of Delhi',
      country: 'India',
      scraped_at: now,
    });
  }

  return orders;
}

/**
 * Parse Delhi REAT Appellate orders HTML table.
 * Columns: Sr.No | Appeal Number | Date of Decision | View Judgement (PDF)
 *
 * Note: REAT orders lack complainant/respondent metadata.
 * Note: REAT PDF links (erera.co.in/delhirera/readwriteReatOrder/*.pdf) return 404.
 */
function parseReatOrders(html: string): DelhiOrder[] {
  const orders: DelhiOrder[] = [];
  const now = new Date().toISOString();

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(tdMatch[1]);
    }

    // REAT orders have 4 cells
    if (cells.length < 4) continue;

    const srNo = parseInt(stripHtml(cells[0]), 10);
    if (isNaN(srNo)) continue;

    const appealNo = stripHtml(cells[1]);
    const orderDate = stripHtml(cells[2]);

    // Extract PDF URL
    const pdfLinkMatch = cells[3].match(/href="([^"]*\.pdf[^"]*)"/i);
    const pdfUrl = pdfLinkMatch ? pdfLinkMatch[1] : '';

    const dateSlug = orderDate.replace(/[^0-9A-Za-z-]/g, '-');
    const caseSlug = slugify(appealNo);
    const pdfFilename = pdfUrl ? `delhi_reat_${caseSlug}_${dateSlug}.pdf` : '';

    orders.push({
      sr_no: srNo,
      complaint_no: appealNo,
      complainant: '', // REAT orders lack this field
      respondent: '', // REAT orders lack this field
      order_date: orderDate,
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      source: 'reat',
      tribunal: 'Delhi REAT',
      court: 'Real Estate Appellate Tribunal, NCT of Delhi',
      country: 'India',
      scraped_at: now,
    });
  }

  return orders;
}

// ---------------------------------------------------------------------------
// Scraping Logic
// ---------------------------------------------------------------------------

async function scrapeMetadata(source: 'rera' | 'reat'): Promise<DelhiOrder[]> {
  const urlPath = source === 'rera' ? RERA_AUTHORITY_PATH : REAT_ORDERS_PATH;
  const fullUrl = `${BASE_URL}${urlPath}`;
  const label = source.toUpperCase();

  console.log(`\n[${label}] Fetching orders from ${fullUrl}`);

  let html = '';
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await httpGet(fullUrl, { timeout: 300_000 });
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

  const orders = source === 'rera' ? parseAuthorityOrders(html) : parseReatOrders(html);

  console.log(`[${label}] Parsed ${orders.length} orders`);

  // Save metadata as JSON
  const metaFile = path.join(METADATA_DIR, `delhi-${source}-orders.json`);
  fs.writeFileSync(metaFile, JSON.stringify(orders, null, 2));

  // Save as JSONL for pipeline
  const jsonlFile = path.join(DATA_DIR, `delhi-${source}-all-metadata.jsonl`);
  const jsonlContent = orders.map((o) => JSON.stringify(o)).join('\n') + '\n';
  fs.writeFileSync(jsonlFile, jsonlContent);
  console.log(`[${label}] Saved metadata to ${metaFile}`);

  return orders;
}

async function downloadPdfs(
  orders: DelhiOrder[],
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

  if (queue.length === 0) return;

  // Check for REAT PDFs (known broken) and warn
  const reatCount = queue.filter((o) => o.source === 'reat').length;
  if (reatCount > 0) {
    console.log(
      `[PDF] WARNING: ${reatCount} REAT orders have broken PDF URLs (404). Will attempt but expect failures.`,
    );
  }

  let downloaded = 0;
  let failed = 0;

  const referer = `${BASE_URL}${RERA_AUTHORITY_PATH}`;

  for (let i = 0; i < queue.length; i += PARALLEL_PDF_WORKERS) {
    const batch = queue.slice(i, i + PARALLEL_PDF_WORKERS);
    const results = await Promise.allSettled(
      batch.map(async (order) => {
        const filepath = path.join(PDFS_DIR, order.pdf_filename);
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const result = await downloadPdf(order.pdf_url, filepath, referer);
            if (result.success && result.size > 0) {
              progress.pdfs_completed.push(order.pdf_filename);
              progress.total_pdfs_downloaded++;
              downloaded++;
              return { success: true, order };
            }
            // 404 or empty - clean up and skip
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

  console.log('=== Delhi RERA/REAT Scraper ===');
  console.log(
    `Mode: ${testMode ? 'TEST' : metadataOnly ? 'METADATA ONLY' : downloadOnly ? 'DOWNLOAD ONLY' : 'FULL'}`,
  );
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(
    `Progress: ${progress.total_orders_found} orders, ${progress.total_pdfs_downloaded} PDFs\n`,
  );

  const allOrders: DelhiOrder[] = [];

  // -- Metadata Phase --
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
    const combinedFile = path.join(DATA_DIR, 'delhi-all-metadata.jsonl');
    const combined = allOrders.map((o) => JSON.stringify(o)).join('\n') + '\n';
    fs.writeFileSync(combinedFile, combined);
    console.log(`\nTotal: ${allOrders.length} orders saved to ${combinedFile}`);
  }

  // -- PDF Phase --
  if (!metadataOnly) {
    // Load from files if download-only
    if (downloadOnly || allOrders.length === 0) {
      for (const source of ['rera', 'reat'] as const) {
        if (reatOnly && source === 'rera') continue;
        if (reraOnly && source === 'reat') continue;
        const metaFile = path.join(METADATA_DIR, `delhi-${source}-orders.json`);
        if (fs.existsSync(metaFile)) {
          const loaded: DelhiOrder[] = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
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
