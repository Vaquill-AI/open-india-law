/**
 * MahaRERA Scraper
 * Scrapes orders from https://maharera.maharashtra.gov.in/orders-judgements
 *
 * MahaRERA orders: ~562 across 57 pages (10 per page, last page has 2)
 *
 * Card fields: Project ID, Project Name, Heard By, Complainant Name,
 *              Complaint No, Respondent Name, Upload Date
 * PDFs: Embedded inline as base64 in oj-data attribute (no separate URL)
 *
 * Tech: Drupal 10 + PHP 8.1 + Apache. TLS connection is FLAKY (~33% fail rate).
 *       Scraper uses aggressive retries to compensate.
 *
 * Usage:
 *   npx tsx scripts/rera-maharera-scraper.ts                    # Full run
 *   npx tsx scripts/rera-maharera-scraper.ts --metadata-only    # Metadata only (no PDFs)
 *   npx tsx scripts/rera-maharera-scraper.ts --download-only    # PDFs only (needs metadata)
 *   npx tsx scripts/rera-maharera-scraper.ts --test             # Test (2 pages, 2 PDFs)
 *   npx tsx scripts/rera-maharera-scraper.ts --start-page 10    # Resume from page 10
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://maharera.maharashtra.gov.in';
const ORDERS_PATH = '/orders-judgements';

const DATA_DIR = path.resolve(__dirname, '../data/tribunals/rera-maharera');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

const ORDERS_PER_PAGE = 10;
const MAX_RETRIES = 6; // Higher due to flaky TLS
const RETRY_DELAY_MS = 3000;
const DELAY_BETWEEN_PAGES_MS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MahaReraOrder {
  sr_no: number;
  project_id: string;
  project_name: string;
  heard_by: string;
  complainant: string;
  complaint_no: string;
  respondent: string;
  upload_date: string;
  pdf_filename: string;
  has_pdf: boolean;
  source: 'maharera';
  tribunal: string;
  court: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  pages_completed: number[];
  total_orders_found: number;
  total_pdfs_saved: number;
  total_pages: number;
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
    pages_completed: [],
    total_orders_found: 0,
    total_pdfs_saved: 0,
    total_pages: 0,
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
// HTTP Client (with aggressive retry for flaky TLS)
// ---------------------------------------------------------------------------

function httpsGet(url: string, timeout = 120_000): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        rejectUnauthorized: false,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'identity',
        },
        timeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks),
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

async function fetchWithRetry(url: string, label: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await httpsGet(url);
      if (resp.status === 200 && resp.body.length > 1000) {
        return resp.body.toString('utf-8');
      }
      throw new Error(`HTTP ${resp.status}, body ${resp.body.length} bytes`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_RETRIES) {
        throw new Error(`${label}: All ${MAX_RETRIES} attempts failed. Last: ${msg}`);
      }
      const delay = RETRY_DELAY_MS * attempt;
      console.log(`  [${label}] Attempt ${attempt} failed: ${msg}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw new Error('Unreachable');
}

// ---------------------------------------------------------------------------
// HTML Parser
// ---------------------------------------------------------------------------

function parseOrdersPage(
  html: string,
  pageNum: number,
): {
  orders: MahaReraOrder[];
  pdfDataMap: Map<string, string>; // filename -> base64 data
  totalPages: number;
} {
  const orders: MahaReraOrder[] = [];
  const pdfDataMap = new Map<string, string>();
  const now = new Date().toISOString();

  // Extract total pages
  let totalPages = 0;
  const pagesMatch = html.match(/Pages\s*<span[^>]*>\d+<\/span>of\s*(\d+)/);
  if (pagesMatch) {
    totalPages = parseInt(pagesMatch[1], 10);
  }

  // Split on card boundaries
  const parts = html.split('row shadow p-3 mb-5 bg-body rounded');
  // First element is everything before the first card
  const cardParts = parts.slice(1);

  for (let i = 0; i < cardParts.length; i++) {
    const card = cardParts[i];

    // Project ID
    const pidMatch = card.match(/#(P\d+)/);
    const projectId = pidMatch ? pidMatch[1] : '';

    // Project Name
    const nameMatch = card.match(/<strong>(.*?)<\/strong>/);
    const projectName = nameMatch ? nameMatch[1].trim() : '';

    // Heard By
    const heardMatch = card.match(/Heard By<\/label>\s*<p>(.*?)<\/p>/);
    const heardBy = heardMatch ? heardMatch[1].trim() : '';

    // Complainant Name
    const compMatch = card.match(/Complainant Name<\/label>\s*<p>(.*?)<\/p>/);
    const complainant = compMatch ? compMatch[1].trim() : '';

    // Complaint No
    const cnoMatch = card.match(/Complainant No\.<\/label>\s*<p>(.*?)<\/p>/);
    const complaintNo = cnoMatch ? cnoMatch[1].trim() : '';

    // Respondent Name
    const respMatch = card.match(/Respondent Name<\/label>\s*<p>(.*?)<\/p>/);
    const respondent = respMatch ? respMatch[1].trim() : '';

    // Upload Date
    const dateMatch = card.match(/<p class="darkBlue\s+m-0">([\d-]+\s[\d:]+)<\/p>/);
    const uploadDate = dateMatch ? dateMatch[1].trim() : '';

    // Base64 PDF data
    const ojDataMatch = card.match(/oj-data="([^"]+)"/);
    const hasBase64Pdf = !!ojDataMatch && ojDataMatch[1].length > 100;

    // Generate global serial number
    const srNo = (pageNum - 1) * ORDERS_PER_PAGE + i + 1;

    // Generate filename
    const caseSlug = slugify(complaintNo || projectId);
    const dateSlug = uploadDate
      .replace(/[^0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const pdfFilename = hasBase64Pdf ? `maharera_${caseSlug}_${dateSlug}.pdf` : '';

    // Store base64 data for later saving
    if (hasBase64Pdf && pdfFilename) {
      pdfDataMap.set(pdfFilename, ojDataMatch![1]);
    }

    orders.push({
      sr_no: srNo,
      project_id: projectId,
      project_name: projectName,
      heard_by: heardBy,
      complainant,
      complaint_no: complaintNo,
      respondent,
      upload_date: uploadDate,
      pdf_filename: pdfFilename,
      has_pdf: hasBase64Pdf,
      source: 'maharera',
      tribunal: 'MahaRERA',
      court: 'Maharashtra Real Estate Regulatory Authority',
      country: 'India',
      scraped_at: now,
    });
  }

  return { orders, pdfDataMap, totalPages };
}

// ---------------------------------------------------------------------------
// PDF Saving
// ---------------------------------------------------------------------------

function saveBase64Pdf(filename: string, base64Data: string): boolean {
  try {
    const filepath = path.join(PDFS_DIR, filename);
    const buffer = Buffer.from(base64Data, 'base64');

    // Validate it's a PDF (starts with %PDF)
    if (buffer.length < 10 || buffer.toString('utf-8', 0, 4) !== '%PDF') {
      console.log(`  [PDF] ${filename}: Invalid PDF header, skipping`);
      return false;
    }

    fs.writeFileSync(filepath, buffer);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [PDF] ${filename}: Save error: ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scraping Logic
// ---------------------------------------------------------------------------

async function scrapePage(
  pageNum: number,
  savePdfs: boolean,
): Promise<{
  orders: MahaReraOrder[];
  pdfsSaved: number;
  totalPages: number;
}> {
  const url = `${BASE_URL}${ORDERS_PATH}?from_date=&to_date=&page=${pageNum}&op=Submit`;
  const label = `Page ${pageNum}`;

  const html = await fetchWithRetry(url, label);
  const { orders, pdfDataMap, totalPages } = parseOrdersPage(html, pageNum);

  let pdfsSaved = 0;
  if (savePdfs) {
    for (const [filename, base64Data] of pdfDataMap) {
      if (saveBase64Pdf(filename, base64Data)) {
        pdfsSaved++;
      }
    }
  }

  return { orders, pdfsSaved, totalPages };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');
  const testMode = args.includes('--test');

  // Parse --start-page N
  let startPage = 1;
  const startIdx = args.indexOf('--start-page');
  if (startIdx >= 0 && args[startIdx + 1]) {
    startPage = parseInt(args[startIdx + 1], 10);
  }

  ensureDirs();
  const progress = loadProgress();

  console.log('=== MahaRERA Scraper ===');
  console.log(
    `Mode: ${testMode ? 'TEST' : metadataOnly ? 'METADATA ONLY' : downloadOnly ? 'DOWNLOAD ONLY' : 'FULL'}`,
  );
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(
    `Progress: ${progress.total_orders_found} orders, ${progress.total_pdfs_saved} PDFs, ${progress.pages_completed.length} pages done`,
  );
  console.log(`Starting from page: ${startPage}\n`);

  // If download-only, re-read metadata and save PDFs from stored base64
  if (downloadOnly) {
    console.log('[INFO] Download-only mode re-fetches pages to extract inline PDFs');
  }

  const allOrders: MahaReraOrder[] = [];
  let totalPdfsSaved = progress.total_pdfs_saved;
  let detectedTotalPages = progress.total_pages || 57; // default 57

  const maxPages = testMode ? 2 : detectedTotalPages;
  const endPage = Math.min(startPage + maxPages - 1, detectedTotalPages);

  for (let page = startPage; page <= endPage; page++) {
    // Skip if already completed (unless download-only which re-fetches for PDFs)
    if (!downloadOnly && progress.pages_completed.includes(page)) {
      console.log(`[Page ${page}/${endPage}] Already done, skipping`);
      // Load existing data
      const pageFile = path.join(METADATA_DIR, `maharera-page-${page}.json`);
      if (fs.existsSync(pageFile)) {
        const loaded: MahaReraOrder[] = JSON.parse(fs.readFileSync(pageFile, 'utf-8'));
        allOrders.push(...loaded);
      }
      continue;
    }

    console.log(`[Page ${page}/${endPage}] Fetching...`);

    try {
      const savePdfs = !metadataOnly;
      const { orders, pdfsSaved, totalPages } = await scrapePage(page, savePdfs);

      if (totalPages > 0) {
        detectedTotalPages = totalPages;
        progress.total_pages = totalPages;
      }

      // Save page metadata
      const pageFile = path.join(METADATA_DIR, `maharera-page-${page}.json`);
      fs.writeFileSync(pageFile, JSON.stringify(orders, null, 2));

      // Append to JSONL
      const jsonlFile = path.join(DATA_DIR, 'maharera-all-metadata.jsonl');
      const jsonlLines = orders.map((o) => JSON.stringify(o)).join('\n') + '\n';
      fs.appendFileSync(jsonlFile, jsonlLines);

      allOrders.push(...orders);
      totalPdfsSaved += pdfsSaved;

      // Track progress
      if (!progress.pages_completed.includes(page)) {
        progress.pages_completed.push(page);
      }
      progress.total_orders_found = progress.pages_completed.length * ORDERS_PER_PAGE; // approximate
      progress.total_pdfs_saved = totalPdfsSaved;
      saveProgress(progress);

      console.log(`[Page ${page}/${endPage}] ${orders.length} orders, ${pdfsSaved} PDFs saved`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Page ${page}] FAILED: ${msg}`);
      // Continue to next page instead of crashing
    }

    // Delay between pages
    if (page < endPage) {
      await sleep(DELAY_BETWEEN_PAGES_MS);
    }
  }

  // Update final counts
  progress.total_orders_found = allOrders.length;
  progress.total_pdfs_saved = totalPdfsSaved;
  saveProgress(progress);

  console.log('\n=== Done ===');
  console.log(`Pages scraped: ${progress.pages_completed.length}`);
  console.log(`Total orders: ${allOrders.length}`);
  console.log(`Total PDFs: ${totalPdfsSaved}`);
  console.log(`Total pages in dataset: ${detectedTotalPages}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
