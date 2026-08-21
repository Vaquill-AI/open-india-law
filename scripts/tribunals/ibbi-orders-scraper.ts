/**
 * IBBI Orders Scraper - Insolvency and Bankruptcy Board of India
 * Scrapes court orders from https://ibbi.gov.in/orders/{category}
 *
 * Categories: NCLT (29,883), NCLAT (5,360), Supreme Court (780),
 *             High Courts (548), IBBI (781), IPA/RVO (76), Other Courts (56)
 * Total: ~37,484 orders with direct PDF downloads
 *
 * No auth/captcha required. Simple server-rendered pagination.
 *
 * Output:
 *   data/ibbi/metadata/{category}-orders.jsonl   (one JSON per line per order)
 *   data/ibbi/pdfs/{category}/{filename}.pdf      (downloaded PDFs)
 *   data/ibbi/scrape-progress.json                (resume state)
 *
 * Usage:
 *   npx tsx scripts/ibbi-orders-scraper.ts                      # Full run (metadata + PDFs)
 *   npx tsx scripts/ibbi-orders-scraper.ts --metadata-only      # Scrape metadata only (fast ~1-2h)
 *   npx tsx scripts/ibbi-orders-scraper.ts --download-only      # Download PDFs only (needs metadata)
 *   npx tsx scripts/ibbi-orders-scraper.ts --category nclt      # Single category
 *   npx tsx scripts/ibbi-orders-scraper.ts --test               # Test: 2 pages of nclt, max 5 PDFs
 *   MAX_CONCURRENT=10 npx tsx scripts/ibbi-orders-scraper.ts    # Control download concurrency
 */

import { chromium, type Browser, type Page } from 'playwright';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://ibbi.gov.in';
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/ibbi');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const COMBINED_JSONL = path.join(DATA_DIR, 'ibbi-all-metadata.jsonl');

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5', 10);
const DELAY_BETWEEN_PAGES_MS = 1500;
const DELAY_BETWEEN_PDFS_MS = 200;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const PAGE_TIMEOUT = 30000;

const CATEGORIES: CategoryDef[] = [
  { slug: 'nclt', name: 'NCLT', tribunal: 'National Company Law Tribunal' },
  { slug: 'nclat', name: 'NCLAT', tribunal: 'National Company Law Appellate Tribunal' },
  { slug: 'supreme-court', name: 'Supreme Court', tribunal: 'Supreme Court of India' },
  { slug: 'high-courts', name: 'High Courts', tribunal: 'High Courts of India' },
  { slug: 'ibbi', name: 'IBBI', tribunal: 'Insolvency and Bankruptcy Board of India' },
  {
    slug: 'ipa-rvo',
    name: 'IPA/RVO',
    tribunal: 'Insolvency Professional Agency / Registered Valuers Organisation',
  },
  { slug: 'other-courts', name: 'Other Courts', tribunal: 'Other Courts' },
];

// CLI flags
const args = process.argv.slice(2);
const TEST_MODE = args.includes('--test');
const METADATA_ONLY = args.includes('--metadata-only');
const DOWNLOAD_ONLY = args.includes('--download-only');

const categoryFlag = args.find((a, i) => args[i - 1] === '--category');
const SELECTED_CATEGORIES = categoryFlag
  ? CATEGORIES.filter(
      (c) => c.slug === categoryFlag || c.name.toLowerCase() === categoryFlag.toLowerCase(),
    )
  : CATEGORIES;

if (categoryFlag && SELECTED_CATEGORIES.length === 0) {
  console.error(`Unknown category: ${categoryFlag}`);
  console.error(`Valid: ${CATEGORIES.map((c) => c.slug).join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CategoryDef {
  slug: string;
  name: string;
  tribunal: string;
}

interface OrderMetadata {
  sr_no: number;
  date: string;
  date_iso: string;
  subject: string;
  case_name: string;
  petition_number: string;
  bench: string;
  order_remarks: string;
  pdf_path: string;
  pdf_url: string;
  pdf_filename: string;
  file_size: string;
  category_slug: string;
  category_name: string;
  tribunal: string;
  country: string;
  country_code: string;
  source: string;
  source_url: string;
  scraped_at: string;
  content_hash: string;
}

interface Progress {
  metadata: {
    completed_categories: string[];
    current_category: string;
    current_page: number;
    total_scraped: number;
  };
  downloads: {
    completed: Record<string, string[]>; // category -> downloaded filenames
    total_downloaded: number;
    total_failed: number;
  };
  last_updated: string;
}

// ---------------------------------------------------------------------------
// NCLT Bench Codes (extracted from petition numbers)
// ---------------------------------------------------------------------------

const BENCH_CODES: Record<string, string> = {
  MUM: 'Mumbai',
  MB: 'Mumbai',
  MUMBAI: 'Mumbai',
  DEL: 'Delhi',
  DL: 'Delhi',
  DELHI: 'Delhi',
  ND: 'New Delhi',
  CHE: 'Chennai',
  CHN: 'Chennai',
  MAA: 'Chennai',
  CHENNAI: 'Chennai',
  KOL: 'Kolkata',
  KOLKATA: 'Kolkata',
  KB: 'Kolkata',
  HYD: 'Hyderabad',
  HYDERABAD: 'Hyderabad',
  HDB: 'Hyderabad',
  CHD: 'Chandigarh',
  CHANDIGARH: 'Chandigarh',
  CH: 'Chandigarh',
  KOC: 'Kochi',
  KOCHI: 'Kochi',
  IND: 'Indore',
  INDORE: 'Indore',
  GUW: 'Guwahati',
  GUWAHATI: 'Guwahati',
  AHM: 'Ahmedabad',
  AHMEDABAD: 'Ahmedabad',
  CUT: 'Cuttack',
  CUTTACK: 'Cuttack',
  CTB: 'Cuttack',
  BLR: 'Bengaluru',
  BEN: 'Bengaluru',
  BENGALURU: 'Bengaluru',
  BANGALORE: 'Bengaluru',
  BB: 'Bengaluru',
  JPR: 'Jaipur',
  JAIPUR: 'Jaipur',
  ALD: 'Allahabad',
  ALH: 'Allahabad',
  ALLAHABAD: 'Allahabad',
  AMR: 'Amravati',
  AMRAVATI: 'Amravati',
  PB: 'Principal Bench',
};

// ---------------------------------------------------------------------------
// Progress Management
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    metadata: {
      completed_categories: [],
      current_category: '',
      current_page: 1,
      total_scraped: 0,
    },
    downloads: {
      completed: {},
      total_downloaded: 0,
      total_failed: 0,
    },
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

function md5(data: string): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

function appendJsonl(filePath: string, obj: Record<string, unknown>): void {
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDate(dateStr: string): string {
  // "10 Feb, 2026" -> "2026-02-10"
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
  const cleaned = dateStr.replace(/,/g, '').trim();
  const parts = cleaned.split(/\s+/);
  if (parts.length === 3) {
    const day = parts[0].padStart(2, '0');
    const month = months[parts[1]] || '01';
    const year = parts[2];
    return `${year}-${month}-${day}`;
  }
  return dateStr;
}

function extractPetitionNumber(subject: string): string {
  // Extract [C.P. (IB)/68/JPR/2024] or similar patterns
  const m = subject.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1].trim() : '';
}

function extractCaseName(subject: string): string {
  // Remove "In the matter of " prefix and [petition number] suffix
  let name = subject.replace(/\[([^\]]+)\]\s*$/, '').trim();
  name = name.replace(/^In the matter of\s+/i, '').trim();
  // Remove trailing nbsp/whitespace
  name = name.replace(/\s+$/, '').trim();
  return name;
}

function extractBench(petitionNumber: string, subject: string): string {
  // Try petition number FIRST (most reliable), then subject as fallback
  // e.g., "C.P. (IB)/68/JPR/2024" -> JPR -> Jaipur
  // e.g., "C.P.(IB)/443(AHM)2025" -> AHM -> Ahmedabad
  const sources = [petitionNumber, subject];
  for (const text of sources) {
    if (!text) continue;
    for (const [code, bench] of Object.entries(BENCH_CODES)) {
      const patterns = [
        new RegExp(`/${code}/`, 'i'),
        new RegExp(`\\(${code}\\)`, 'i'),
        new RegExp(`\\b${code}\\b`, 'i'),
      ];
      for (const pat of patterns) {
        if (pat.test(text)) return bench;
      }
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Metadata Scraping (parallel page fetching)
// ---------------------------------------------------------------------------

const META_WORKERS = parseInt(process.env.META_WORKERS || '10', 10);

interface RawRow {
  sr_no: string;
  date: string;
  subject: string;
  onclick: string;
  order_remarks: string;
  file_size: string;
}

/** Scrape a single page and return raw rows. Returns [] on error. */
async function scrapeSinglePage(browser: Browser, url: string): Promise<RawRow[]> {
  let page: Page | null = null;
  try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });

    const rows = await page.evaluate(() => {
      const results: Array<{
        sr_no: string;
        date: string;
        subject: string;
        onclick: string;
        order_remarks: string;
        file_size: string;
      }> = [];

      const trs = document.querySelectorAll('table tr');
      for (let i = 1; i < trs.length; i++) {
        const tds = trs[i].querySelectorAll('td');
        if (tds.length < 3) continue;

        const sr = tds[0]?.textContent?.trim() || '';
        const dateText = tds[1]?.textContent?.trim() || '';
        const subjectTd = tds[2];
        const remarksTd = tds[3];

        const link = subjectTd?.querySelector('a[onclick*="newwindow1"]');
        const onclick = link?.getAttribute('onclick') || '';

        let subjectText = subjectTd?.textContent?.trim() || '';
        const sizeMatch = subjectText.match(/\([\d.]+ [KMG]B\)\s*$/);
        const fileSize = sizeMatch ? sizeMatch[0].replace(/[()]/g, '').trim() : '';
        subjectText = subjectText.replace(/\([\d.]+ [KMG]B\)\s*$/, '').trim();

        results.push({
          sr_no: sr,
          date: dateText,
          subject: subjectText,
          onclick,
          order_remarks: remarksTd?.textContent?.trim() || '',
          file_size: fileSize,
        });
      }
      return results;
    });

    await page.close();
    return rows;
  } catch {
    if (page) await page.close().catch(() => {});
    return [];
  }
}

/** Convert raw rows to OrderMetadata and append to JSONL */
function processRows(
  rows: RawRow[],
  cat: CategoryDef,
  sourceUrl: string,
  jsonlPath: string,
): number {
  let count = 0;
  for (const row of rows) {
    const pdfMatch = row.onclick.match(/newwindow1\(['"]([^'"]+)['"]\)/);
    const pdfPath = pdfMatch ? pdfMatch[1] : '';
    const pdfUrl = pdfPath ? (pdfPath.startsWith('http') ? pdfPath : `${BASE_URL}${pdfPath}`) : '';
    const pdfFilename = pdfPath ? path.basename(pdfPath) : '';

    const petitionNumber = extractPetitionNumber(row.subject);
    const caseName = extractCaseName(row.subject);
    const bench = extractBench(petitionNumber, row.subject);

    const order: OrderMetadata = {
      sr_no: parseInt(row.sr_no, 10) || 0,
      date: row.date,
      date_iso: parseDate(row.date),
      subject: row.subject,
      case_name: caseName,
      petition_number: petitionNumber,
      bench,
      order_remarks: row.order_remarks,
      pdf_path: pdfPath,
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      file_size: row.file_size,
      category_slug: cat.slug,
      category_name: cat.name,
      tribunal: cat.tribunal,
      country: 'India',
      country_code: 'IN',
      source: 'IBBI (Insolvency and Bankruptcy Board of India)',
      source_url: sourceUrl,
      scraped_at: new Date().toISOString(),
      content_hash: md5(row.subject + row.date + pdfPath),
    };

    appendJsonl(jsonlPath, order as unknown as Record<string, unknown>);
    count++;
  }
  return count;
}

async function scrapeCategoryMetadata(
  browser: Browser,
  cat: CategoryDef,
  progress: Progress,
): Promise<number> {
  const jsonlPath = path.join(METADATA_DIR, `${cat.slug}-orders.jsonl`);

  // Determine start page
  let startPage = 1;
  if (progress.metadata.current_category === cat.slug && progress.metadata.current_page > 1) {
    startPage = progress.metadata.current_page;
    log(`  Resuming ${cat.name} from page ${startPage}`);
  }

  progress.metadata.current_category = cat.slug;

  let totalForCategory = 0;
  let pageNum = startPage;
  const metaStartTime = Date.now();
  let workers = META_WORKERS;
  let batchDelayMs = 500; // Adaptive delay — increases on rate limiting
  let consecutiveEmptyBatches = 0;

  log(`  ${cat.name}: using ${workers} parallel workers`);

  while (true) {
    if (TEST_MODE && pageNum > 2) break;

    // Build a batch of page URLs
    const batch: Array<{ pageNum: number; url: string }> = [];
    for (let w = 0; w < workers; w++) {
      const pn = pageNum + w;
      if (TEST_MODE && pn > 2) break;
      const url =
        pn === 1 ? `${BASE_URL}/orders/${cat.slug}` : `${BASE_URL}/orders/${cat.slug}?page=${pn}`;
      batch.push({ pageNum: pn, url });
    }

    if (batch.length === 0) break;

    // Fetch all pages in parallel
    const results = await Promise.all(
      batch.map(async (b) => {
        const rows = await scrapeSinglePage(browser, b.url);
        return { pageNum: b.pageNum, url: b.url, rows };
      }),
    );

    // Process results IN ORDER (important for sequential sr_no in JSONL)
    let batchEmpty = 0;
    for (const r of results.sort((a, b) => a.pageNum - b.pageNum)) {
      if (r.rows.length === 0) {
        batchEmpty++;
      } else {
        const count = processRows(r.rows, cat, r.url, jsonlPath);
        totalForCategory += count;
        progress.metadata.total_scraped += count;
      }
    }

    // If SOME pages in batch are empty (partial failure), slow down
    if (batchEmpty > 0 && batchEmpty < batch.length) {
      log(`  Warning: ${batchEmpty}/${batch.length} pages empty in batch — slowing down`);
      batchDelayMs = Math.min(5000, batchDelayMs + 500);
      workers = Math.max(2, workers - 1);
    }

    // If ALL pages in batch were empty, verify it's truly the end (not rate limiting)
    if (batchEmpty === batch.length) {
      let confirmed = false;
      // Retry a SINGLE page with exponential backoff to distinguish rate limiting from end-of-data
      for (let retryAttempt = 1; retryAttempt <= 3; retryAttempt++) {
        const backoffMs = 5000 * Math.pow(2, retryAttempt - 1); // 5s, 10s, 20s
        log(
          `  Batch empty at page ${pageNum} — retrying single page in ${backoffMs / 1000}s (attempt ${retryAttempt}/3)...`,
        );
        await delay(backoffMs);
        const verifyUrl =
          pageNum === 1
            ? `${BASE_URL}/orders/${cat.slug}`
            : `${BASE_URL}/orders/${cat.slug}?page=${pageNum}`;
        const verifyRows = await scrapeSinglePage(browser, verifyUrl);
        if (verifyRows.length > 0) {
          // Rate limiting was the cause — process this page and continue
          log(
            `  Rate limit detected! Got ${verifyRows.length} rows after backoff. Reducing workers & adding delay.`,
          );
          const count = processRows(verifyRows, cat, verifyUrl, jsonlPath);
          totalForCategory += count;
          progress.metadata.total_scraped += count;
          confirmed = true;
          // Adapt: reduce workers, increase batch delay
          workers = Math.max(2, Math.floor(workers / 2));
          batchDelayMs = Math.min(5000, batchDelayMs * 2);
          consecutiveEmptyBatches = 0;
          log(`  Adapted: workers=${workers}, delay=${batchDelayMs}ms`);
          await delay(3000);
          break;
        }
      }
      if (!confirmed) {
        log(`  No more results for ${cat.name} at page ${pageNum} (confirmed after 3 retries)`);
        break;
      }
    }

    const highestPage = batch[batch.length - 1].pageNum;
    progress.metadata.current_page = highestPage + 1;
    saveProgress(progress);

    // Progress log every batch
    const elapsed = (Date.now() - metaStartTime) / 1000;
    const pagesScraped = highestPage - startPage + 1;
    const pagesPerSec = elapsed > 0 ? (pagesScraped / elapsed).toFixed(1) : '?';
    const ordersPerSec = elapsed > 0 ? (totalForCategory / elapsed).toFixed(0) : '?';
    log(
      `  ${cat.name}: page ${highestPage}, ${totalForCategory} orders | ${pagesPerSec} pg/s | ${ordersPerSec} orders/s`,
    );

    pageNum = highestPage + 1;
    consecutiveEmptyBatches = 0; // Reset on successful batch
    await delay(batchDelayMs);
  }

  log(`  ${cat.name} metadata complete: ${totalForCategory} orders`);
  progress.metadata.completed_categories.push(cat.slug);
  progress.metadata.current_category = '';
  progress.metadata.current_page = 1;
  saveProgress(progress);

  return totalForCategory;
}

// ---------------------------------------------------------------------------
// PDF Download
// ---------------------------------------------------------------------------

function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Accept: 'application/pdf,*/*',
        },
        timeout: 60000,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          // Follow redirect
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${BASE_URL}${res.headers.location}`;
          downloadFile(redirectUrl, destPath).then(resolve);
          return;
        }

        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(true);
        });
        file.on('error', () => {
          fs.unlink(destPath, () => {});
          resolve(false);
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function downloadWithRetry(
  url: string,
  destPath: string,
  retries = MAX_RETRIES,
): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ok = await downloadFile(url, destPath);
    if (ok) {
      // Verify file exists and is not empty
      try {
        const stat = fs.statSync(destPath);
        if (stat.size > 100) return true;
        fs.unlinkSync(destPath);
      } catch {
        // File doesn't exist despite ok response - retry
      }
    }
    if (attempt < retries) await delay(RETRY_DELAY_MS * attempt);
  }
  return false;
}

async function downloadCategoryPdfs(
  cat: CategoryDef,
  progress: Progress,
): Promise<{ downloaded: number; failed: number }> {
  const jsonlPath = path.join(METADATA_DIR, `${cat.slug}-orders.jsonl`);
  if (!fs.existsSync(jsonlPath)) {
    log(`  No metadata for ${cat.name}, skipping downloads`);
    return { downloaded: 0, failed: 0 };
  }

  const categoryPdfsDir = path.join(PDFS_DIR, cat.slug);
  fs.mkdirSync(categoryPdfsDir, { recursive: true });

  const completedSet = new Set(progress.downloads.completed[cat.slug] || []);

  // Read all orders from JSONL
  const orders: OrderMetadata[] = fs
    .readFileSync(jsonlPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  const toDownload = orders.filter(
    (o) => o.pdf_url && o.pdf_filename && !completedSet.has(o.pdf_filename),
  );

  if (toDownload.length === 0) {
    log(`  ${cat.name}: all PDFs already downloaded`);
    return { downloaded: 0, failed: 0 };
  }

  log(`  ${cat.name}: ${toDownload.length} PDFs to download (${completedSet.size} already done)`);

  let downloaded = 0;
  let failed = 0;
  const maxPdfs = TEST_MODE ? 5 : Infinity;
  const startTime = Date.now();
  const limit = pLimit(MAX_CONCURRENT);
  let lastLogTime = Date.now();

  const items = toDownload.slice(0, Math.min(toDownload.length, maxPdfs));

  const tasks = items.map((order) =>
    limit(async () => {
      const destPath = path.join(categoryPdfsDir, order.pdf_filename);
      const ok = await downloadWithRetry(order.pdf_url, destPath);
      if (ok) {
        downloaded++;
        completedSet.add(order.pdf_filename);
      } else {
        failed++;
        logError(`  Failed: ${order.pdf_filename}`);
      }

      // Log progress every 10s or every 100 downloads
      const now = Date.now();
      if (now - lastLogTime > 10000 || (downloaded + failed) % 100 === 0) {
        lastLogTime = now;
        const elapsed = (now - startTime) / 1000;
        const rate = downloaded > 0 ? (downloaded / elapsed).toFixed(1) : '0';
        const remaining = items.length - downloaded - failed;
        const eta = downloaded > 0 ? Math.round(remaining / (downloaded / elapsed) / 60) : 0;
        progress.downloads.completed[cat.slug] = Array.from(completedSet);
        saveProgress(progress);
        log(
          `  ${cat.name}: ${completedSet.size}/${orders.length} PDFs | ${rate}/s | ${failed} failed | ETA ~${eta}m`,
        );
      }
    }),
  );

  await Promise.all(tasks);

  progress.downloads.completed[cat.slug] = Array.from(completedSet);
  saveProgress(progress);

  return { downloaded, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('=== IBBI Orders Scraper ===');
  log(`Categories: ${SELECTED_CATEGORIES.map((c) => `${c.name}`).join(', ')}`);
  log(
    `Mode: ${TEST_MODE ? 'TEST' : METADATA_ONLY ? 'METADATA-ONLY' : DOWNLOAD_ONLY ? 'DOWNLOAD-ONLY' : 'FULL'}`,
  );
  log(`Concurrent downloads: ${MAX_CONCURRENT}`);

  // Ensure directories
  fs.mkdirSync(METADATA_DIR, { recursive: true });
  fs.mkdirSync(PDFS_DIR, { recursive: true });

  const progress = loadProgress();
  let totalMetadata = 0;
  let totalDownloaded = 0;
  let totalFailed = 0;

  // SIGINT handler
  let shuttingDown = false;
  process.on('SIGINT', () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log('\nGraceful shutdown... saving progress');
    saveProgress(progress);
    process.exit(0);
  });

  // Phase 1: Metadata scraping
  if (!DOWNLOAD_ONLY) {
    log('\n--- Phase 1: Metadata Scraping ---');
    const browser = await chromium.launch({ headless: true });

    for (const cat of SELECTED_CATEGORIES) {
      if (progress.metadata.completed_categories.includes(cat.slug)) {
        log(`  ${cat.name}: metadata already scraped, skipping`);
        continue;
      }
      log(`  Scraping ${cat.name}...`);
      const count = await scrapeCategoryMetadata(browser, cat, progress);
      totalMetadata += count;
      // Cool-down between categories to avoid rate limiting
      if (SELECTED_CATEGORIES.indexOf(cat) < SELECTED_CATEGORIES.length - 1) {
        log(`  Cooling down 10s before next category...`);
        await delay(10000);
      }
    }

    await browser.close();
    log(`\nMetadata phase complete: ${totalMetadata} new orders scraped`);
    log(`Total metadata across all runs: ${progress.metadata.total_scraped}`);

    // Generate combined JSONL from all category files
    log('Generating combined metadata file...');
    let combinedCount = 0;
    if (fs.existsSync(COMBINED_JSONL)) fs.unlinkSync(COMBINED_JSONL);
    for (const cat of CATEGORIES) {
      const catJsonl = path.join(METADATA_DIR, `${cat.slug}-orders.jsonl`);
      if (fs.existsSync(catJsonl)) {
        const lines = fs
          .readFileSync(catJsonl, 'utf-8')
          .split('\n')
          .filter((l) => l.trim());
        for (const line of lines) {
          fs.appendFileSync(COMBINED_JSONL, line + '\n');
          combinedCount++;
        }
      }
    }
    log(`Combined JSONL: ${combinedCount} records -> ${COMBINED_JSONL}`);
  }

  // Phase 2: PDF downloads
  if (!METADATA_ONLY) {
    log('\n--- Phase 2: PDF Downloads ---');

    for (const cat of SELECTED_CATEGORIES) {
      log(`  Downloading ${cat.name} PDFs...`);
      const result = await downloadCategoryPdfs(cat, progress);
      totalDownloaded += result.downloaded;
      totalFailed += result.failed;
    }

    log(`\nDownload phase complete: ${totalDownloaded} downloaded, ${totalFailed} failed`);
  }

  // Final progress save
  progress.downloads.total_downloaded = Object.values(progress.downloads.completed).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  saveProgress(progress);

  // Summary
  log('\n=== Final Summary ===');
  log(`Metadata scraped this run: ${totalMetadata}`);
  log(`PDFs downloaded this run: ${totalDownloaded}`);
  log(`PDFs failed this run: ${totalFailed}`);
  log(`Total PDFs across all runs: ${progress.downloads.total_downloaded}`);
  log(`Progress saved to: ${PROGRESS_FILE}`);

  // Folder structure reference
  log('\n=== Output Structure ===');
  log(`  ${DATA_DIR}/`);
  log(`    metadata/           <- JSONL per category`);
  log(`    pdfs/{category}/    <- PDFs organized by tribunal`);
  log(`    ibbi-all-metadata.jsonl  <- Combined metadata`);
  log(`    scrape-progress.json     <- Resume checkpoint`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
