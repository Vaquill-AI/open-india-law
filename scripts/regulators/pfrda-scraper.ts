/**
 * PFRDA Scraper - Pension Fund Regulatory and Development Authority
 * Scrapes circulars, regulations, notifications, orders, guidelines from pfrda.org.in
 *
 * Architecture:
 *   - Liferay DXP CMS with server-rendered HTML (basic-card elements)
 *   - Pagination: ?delta=10&start={page} (1-indexed page number)
 *   - PDFs at /documents/33652/{folderId}/{filename}.pdf (direct download, cached on Google CDN)
 *   - No CAPTCHA, no rate limiting, no session/cookies required
 *   - Two-pass: listing pages -> detail pages -> PDF download
 *
 * Categories (~867 docs total):
 *   1. Active Circulars       (206 docs)
 *   2. Archived Circulars     (245 docs)
 *   3. Notifications          (141 docs)
 *   4. Regulations            (78 docs)
 *   5. Guidelines             (27 docs)
 *   6. Enforcement Orders     (23 docs)
 *   7. Notices                (10 docs)
 *   8. Active Master Circulars (13 docs)
 *   9. Exposure Drafts        (27 docs)
 *  10. Reports                (13 docs)
 *  11. Rules                  (9 docs)
 *  12. Press Releases         (61 docs)
 *  13. Annual Reports         (14 docs)
 *
 * Usage:
 *   npx tsx scripts/pfrda-scraper.ts                                   # Full run
 *   npx tsx scripts/pfrda-scraper.ts --category active-circulars       # Single category
 *   npx tsx scripts/pfrda-scraper.ts --metadata-only                   # Extract metadata only
 *   npx tsx scripts/pfrda-scraper.ts --download-only                   # Download PDFs from metadata
 *   npx tsx scripts/pfrda-scraper.ts --test                            # Test mode (3 PDFs per category)
 *
 * Environment:
 *   DELAY_MS=1000           Delay between requests (default: 1000)
 *   CONCURRENCY=5           Parallel PDF downloads (default: 5)
 *   MAX_RETRIES=3           Retry attempts (default: 3)
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.pfrda.org.in';
const SITE_GROUP_ID = '33652';
const ITEMS_PER_PAGE = 10;
const DELAY_MS = parseInt(process.env.DELAY_MS || '1000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const RETRY_DELAY_MS = 3000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 30_000;

const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data/legal-sources/pfrda');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const ALL_METADATA_JSONL = path.join(DATA_DIR, 'pfrda-all-metadata.jsonl');

// ─── Types ───────────────────────────────────────────────────────────────────

type CategorySlug =
  | 'active-circulars'
  | 'archived-circulars'
  | 'notifications'
  | 'regulations'
  | 'guidelines'
  | 'enforcement-orders'
  | 'general-orders'
  | 'notices'
  | 'active-master-circulars'
  | 'archived-master-circulars'
  | 'exposure-drafts'
  | 'reports'
  | 'acts'
  | 'rules'
  | 'press-releases'
  | 'annual-reports'
  | 'consultation-papers'
  | 'working-papers';

interface CategoryConfig {
  slug: CategorySlug;
  label: string;
  urlPath: string;
  pdfSubdir: string;
  estimatedCount: number;
  priority: number;
}

const CATEGORIES: CategoryConfig[] = [
  {
    slug: 'active-circulars',
    label: 'Active Circulars',
    urlPath: '/regulatory-framework/circulars/active-circulars',
    pdfSubdir: 'circulars/active',
    estimatedCount: 206,
    priority: 1,
  },
  {
    slug: 'archived-circulars',
    label: 'Archived Circulars',
    urlPath: '/regulatory-framework/circulars/inoperative',
    pdfSubdir: 'circulars/archived',
    estimatedCount: 245,
    priority: 2,
  },
  {
    slug: 'notifications',
    label: 'Notifications',
    urlPath: '/regulatory-framework/notifications',
    pdfSubdir: 'notifications',
    estimatedCount: 141,
    priority: 3,
  },
  {
    slug: 'regulations',
    label: 'Regulations',
    urlPath: '/regulatory-framework/regulations',
    pdfSubdir: 'regulations',
    estimatedCount: 78,
    priority: 4,
  },
  {
    slug: 'guidelines',
    label: 'Guidelines',
    urlPath: '/regulatory-framework/guidelines',
    pdfSubdir: 'guidelines',
    estimatedCount: 27,
    priority: 5,
  },
  {
    slug: 'enforcement-orders',
    label: 'Enforcement Orders',
    urlPath: '/regulatory-framework/orders/enforcement-orders',
    pdfSubdir: 'orders/enforcement',
    estimatedCount: 23,
    priority: 6,
  },
  {
    slug: 'general-orders',
    label: 'General Orders',
    urlPath: '/regulatory-framework/orders/general-orders',
    pdfSubdir: 'orders/general',
    estimatedCount: 10,
    priority: 7,
  },
  {
    slug: 'notices',
    label: 'Notices',
    urlPath: '/regulatory-framework/orders/notices',
    pdfSubdir: 'orders/notices',
    estimatedCount: 10,
    priority: 8,
  },
  {
    slug: 'active-master-circulars',
    label: 'Active Master Circulars',
    urlPath: '/regulatory-framework/master-circulars/active-master-circulars',
    pdfSubdir: 'master-circulars/active',
    estimatedCount: 13,
    priority: 9,
  },
  {
    slug: 'archived-master-circulars',
    label: 'Archived Master Circulars',
    urlPath: '/regulatory-framework/master-circulars/archived-master-circulars',
    pdfSubdir: 'master-circulars/archived',
    estimatedCount: 10,
    priority: 10,
  },
  {
    slug: 'exposure-drafts',
    label: 'Exposure Drafts',
    urlPath: '/regulatory-framework/exposure-drafts',
    pdfSubdir: 'exposure-drafts',
    estimatedCount: 27,
    priority: 11,
  },
  {
    slug: 'reports',
    label: 'Reports',
    urlPath: '/regulatory-framework/reports',
    pdfSubdir: 'reports',
    estimatedCount: 13,
    priority: 12,
  },
  {
    slug: 'acts',
    label: 'Acts',
    urlPath: '/regulatory-framework/acts',
    pdfSubdir: 'acts',
    estimatedCount: 5,
    priority: 13,
  },
  {
    slug: 'rules',
    label: 'Rules',
    urlPath: '/regulatory-framework/rules',
    pdfSubdir: 'rules',
    estimatedCount: 9,
    priority: 14,
  },
  {
    slug: 'press-releases',
    label: 'Press Releases',
    urlPath: '/press-releases',
    pdfSubdir: 'press-releases',
    estimatedCount: 61,
    priority: 15,
  },
  {
    slug: 'annual-reports',
    label: 'Annual Reports',
    urlPath: '/research-publications/annual-reports',
    pdfSubdir: 'annual-reports',
    estimatedCount: 14,
    priority: 16,
  },
  {
    slug: 'consultation-papers',
    label: 'Consultation Papers',
    urlPath: '/consultation-papers',
    pdfSubdir: 'consultation-papers',
    estimatedCount: 10,
    priority: 17,
  },
  {
    slug: 'working-papers',
    label: 'Working Papers',
    urlPath: '/research-publications/working-papers',
    pdfSubdir: 'working-papers',
    estimatedCount: 5,
    priority: 18,
  },
];

interface PfrdaDocument {
  id: string;
  title: string;
  category: string;
  category_slug: CategorySlug;
  detail_url: string;
  pdf_url: string;
  pdf_filename: string;
  date: string;
  date_iso: string;
  reference_number: string;
  regulator: string;
  country: string;
  source_url: string;
  scraped_at: string;
  downloaded: boolean;
  downloaded_at: string | null;
}

interface Progress {
  lastRun: string;
  categories: Record<string, { extracted: number; downloaded: number; lastUpdated: string }>;
  completedDownloads: string[];
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ERROR: ${msg}\n`);
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

let shuttingDown = false;

function setupShutdownHandler(): void {
  const handler = () => {
    if (shuttingDown) {
      log('Force exit');
      process.exit(1);
    }
    shuttingDown = true;
    log('Shutting down gracefully... (press Ctrl+C again to force)');
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

function createClient(): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    timeout: PAGE_TIMEOUT_MS,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    maxRedirects: 5,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });
}

// ─── Progress Management ─────────────────────────────────────────────────────

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { lastRun: '', categories: {}, completedDownloads: [] };
}

function saveProgress(progress: Progress): void {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify({ ...progress, lastRun: new Date().toISOString() }, null, 2),
  );
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

function extractFilename(url: string, title: string): string {
  try {
    const urlPath = new URL(url).pathname;
    const urlFilename = path.basename(urlPath);
    const decoded = decodeURIComponent(urlFilename);
    if (decoded.length > 5 && decoded.toLowerCase().endsWith('.pdf')) {
      return decoded;
    }
  } catch {
    // fall through to title-based
  }
  return sanitizeFilename(title) + '.pdf';
}

/**
 * Parse PFRDA date formats: "DD-MM-YYYY", "DD/MM/YYYY", "Month DD, YYYY"
 */
function parseDateToIso(dateStr: string): string {
  // DD-MM-YYYY or DD/MM/YYYY
  const ddmmyyyy = dateStr.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (ddmmyyyy) {
    const day = ddmmyyyy[1].padStart(2, '0');
    const month = ddmmyyyy[2].padStart(2, '0');
    return `${ddmmyyyy[3]}-${month}-${day}`;
  }

  // Month DD, YYYY
  const months: Record<string, string> = {
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    may: '05',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
    january: '01',
    february: '02',
    march: '03',
    april: '04',
    june: '06',
    july: '07',
    august: '08',
    september: '09',
    october: '10',
    november: '11',
    december: '12',
  };
  const monthMatch = dateStr.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthMatch) {
    const monthNum = months[monthMatch[1].toLowerCase()];
    if (monthNum) {
      const day = monthMatch[2].padStart(2, '0');
      return `${monthMatch[3]}-${monthNum}-${day}`;
    }
  }

  // DD Month YYYY
  const dmyMatch = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dmyMatch) {
    const monthNum = months[dmyMatch[2].toLowerCase()];
    if (monthNum) {
      const day = dmyMatch[1].padStart(2, '0');
      return `${dmyMatch[3]}-${monthNum}-${day}`;
    }
  }

  return '';
}

// ─── Listing Page Extraction ─────────────────────────────────────────────────

interface ListingResult {
  entries: Array<{ title: string; detailUrl: string }>;
  totalCount: number;
}

function extractListingEntries(html: string): ListingResult {
  const $ = cheerio.load(html);
  const entries: Array<{ title: string; detailUrl: string }> = [];

  // Extract from basic-card elements (Liferay SearchResultsPortlet)
  $('div.basic-card').each((_i, card) => {
    const $card = $(card);
    const $link = $card.find('a.basic-link');
    const title = $card.find('h2.basic-title').text().trim();
    let href = $link.attr('href') || '';

    if (!title || !href) return;

    // Clean up the URL - remove p_l_back_url parameter noise
    if (href.includes('?')) {
      const urlObj = new URL(href, BASE_URL);
      // Keep the path, drop tracking params
      href = urlObj.origin + urlObj.pathname;
    }

    if (!href.startsWith('http')) {
      href = `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
    }

    entries.push({ title, detailUrl: href });
  });

  // Extract total count from pagination footer: "Showing 1 to 10 of 206 entries."
  let totalCount = 0;
  const totalMatch = html.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)/i);
  if (totalMatch) {
    totalCount = parseInt(totalMatch[1], 10);
  }

  return { entries, totalCount };
}

// ─── Detail Page Extraction ──────────────────────────────────────────────────

interface DetailResult {
  pdfUrls: string[];
  date: string;
  referenceNumber: string;
}

function extractDetailPage(html: string): DetailResult {
  const $ = cheerio.load(html);
  const pdfUrls: string[] = [];
  const seenPdfs = new Set<string>();

  // Find PDF links matching /documents/33652/...
  $('a[href*="/documents/"]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('.pdf') || href.includes(`/${SITE_GROUP_ID}/`)) {
      let fullUrl = href;
      if (!fullUrl.startsWith('http')) {
        fullUrl = `${BASE_URL}${fullUrl.startsWith('/') ? '' : '/'}${fullUrl}`;
      }
      if (!seenPdfs.has(fullUrl)) {
        seenPdfs.add(fullUrl);
        pdfUrls.push(fullUrl);
      }
    }
  });

  // Also check for iframe-embedded PDFs
  $('iframe[src*="/documents/"]').each((_i, el) => {
    const src = $(el).attr('src') || '';
    let fullUrl = src;
    if (!fullUrl.startsWith('http')) {
      fullUrl = `${BASE_URL}${fullUrl.startsWith('/') ? '' : '/'}${fullUrl}`;
    }
    if (!seenPdfs.has(fullUrl)) {
      seenPdfs.add(fullUrl);
      pdfUrls.push(fullUrl);
    }
  });

  // Also find any .pdf href links as fallback
  if (pdfUrls.length === 0) {
    $('a[href$=".pdf"]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      let fullUrl = href;
      if (!fullUrl.startsWith('http')) {
        fullUrl = `${BASE_URL}${fullUrl.startsWith('/') ? '' : '/'}${fullUrl}`;
      }
      if (!seenPdfs.has(fullUrl)) {
        seenPdfs.add(fullUrl);
        pdfUrls.push(fullUrl);
      }
    });
  }

  // Extract date - look for DD-MM-YYYY or similar patterns in the page content
  let date = '';
  const bodyText = $('body').text();
  const datePatterns = [
    /dated?\s*:?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i,
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
    /(\d{1,2})[-/](\d{1,2})[-/](\d{4})/,
  ];
  for (const pattern of datePatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      date = match[0].replace(/dated?\s*:?\s*/i, '').trim();
      break;
    }
  }

  // Extract reference/circular number
  let referenceNumber = '';
  const refPatterns = [
    /(?:Circular|Notification|Order|Guideline)\s+No\.?\s*:?\s*([A-Z0-9/\-().]+(?:\s*\([^)]*\))?)/i,
    /(?:PFRDA|No\.?)\s*[:/]?\s*([A-Z0-9/\-().]+(?:\s+dated\s+\d{1,2}[-/]\d{1,2}[-/]\d{4})?)/i,
    /Ref\.?\s*(?:No\.?)?\s*:?\s*([A-Z0-9/\-().]+)/i,
    /F\.?\s*No\.?\s*:?\s*([A-Z0-9/\-().]+)/i,
  ];
  for (const pattern of refPatterns) {
    const match = bodyText.match(pattern);
    if (match && match[1].length >= 4 && match[1].length <= 80) {
      referenceNumber = match[1].trim();
      break;
    }
  }

  return { pdfUrls, date, referenceNumber };
}

// ─── Paginated Listing Fetch ─────────────────────────────────────────────────

async function fetchAllListingPages(
  client: AxiosInstance,
  config: CategoryConfig,
): Promise<Array<{ title: string; detailUrl: string }>> {
  const allEntries: Array<{ title: string; detailUrl: string }> = [];
  const seenUrls = new Set<string>();

  // Fetch first page to get total count
  const listingUrl = `/web/pfrda${config.urlPath}`;
  log(`  Fetching: ${listingUrl}`);

  let totalCount = 0;
  let page = 1;

  while (!shuttingDown) {
    const url = `${listingUrl}?delta=${ITEMS_PER_PAGE}&start=${page}`;

    try {
      const response = await client.get(url);
      const { entries, totalCount: tc } = extractListingEntries(response.data);

      if (page === 1 && tc > 0) {
        totalCount = tc;
        log(`  Total documents: ${totalCount}`);
      }

      // Filter duplicates
      const newEntries = entries.filter((e) => {
        if (seenUrls.has(e.detailUrl)) return false;
        seenUrls.add(e.detailUrl);
        return true;
      });

      if (newEntries.length === 0) {
        log(`  No new entries on page ${page}, stopping`);
        break;
      }

      allEntries.push(...newEntries);

      const totalPages = totalCount > 0 ? Math.ceil(totalCount / ITEMS_PER_PAGE) : page + 1;
      const pct = totalCount > 0 ? ((allEntries.length / totalCount) * 100).toFixed(1) : '?';
      log(
        `  Page ${page}/${totalPages}: ${newEntries.length} entries (total: ${allEntries.length}, ${pct}%)`,
      );

      // Check if we've got all entries
      if (totalCount > 0 && allEntries.length >= totalCount) {
        break;
      }

      // Check if this was a partial page (less than delta items)
      if (entries.length < ITEMS_PER_PAGE) {
        log(`  Partial page (${entries.length}/${ITEMS_PER_PAGE}), likely last page`);
        break;
      }

      page++;
      await sleep(DELAY_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        log(`  Page ${page} returned 404, stopping`);
        break;
      }
      logError(`Failed to fetch page ${page}: ${msg}`);

      // Retry once
      await sleep(RETRY_DELAY_MS);
      try {
        const response = await client.get(url);
        const { entries } = extractListingEntries(response.data);
        const newEntries = entries.filter((e) => {
          if (seenUrls.has(e.detailUrl)) return false;
          seenUrls.add(e.detailUrl);
          return true;
        });
        if (newEntries.length > 0) {
          allEntries.push(...newEntries);
        }
        page++;
      } catch {
        logError(`Retry failed for page ${page}, stopping`);
        break;
      }
    }
  }

  return allEntries;
}

// ─── Detail Fetch with Retry ─────────────────────────────────────────────────

async function fetchDetailWithRetry(
  client: AxiosInstance,
  detailUrl: string,
): Promise<DetailResult> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (shuttingDown) return { pdfUrls: [], date: '', referenceNumber: '' };

    try {
      const response = await client.get(detailUrl.replace(BASE_URL, ''));
      return extractDetailPage(response.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        log(`  Retry ${attempt}/${MAX_RETRIES} for detail page: ${msg}`);
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        logError(`  Failed after ${MAX_RETRIES} attempts: ${detailUrl} - ${msg}`);
      }
    }
  }
  return { pdfUrls: [], date: '', referenceNumber: '' };
}

// ─── PDF Download ────────────────────────────────────────────────────────────

async function downloadPdf(
  entry: PfrdaDocument,
  outDir: string,
  progress: Progress,
): Promise<boolean> {
  if (progress.completedDownloads.includes(entry.pdf_url)) {
    return true;
  }

  const outPath = path.join(outDir, entry.pdf_filename);

  // Skip if already downloaded
  if (fs.existsSync(outPath)) {
    const stats = fs.statSync(outPath);
    if (stats.size > 500) {
      entry.downloaded = true;
      entry.downloaded_at = new Date().toISOString();
      if (!progress.completedDownloads.includes(entry.pdf_url)) {
        progress.completedDownloads.push(entry.pdf_url);
      }
      return true;
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (shuttingDown) return false;

    try {
      const response = await axios.get(entry.pdf_url, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Accept: 'application/pdf,*/*',
        },
        maxRedirects: 5,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });

      const data = Buffer.from(response.data);

      if (data.length < 100) {
        logError(`  ${entry.pdf_filename}: Too small (${data.length} bytes), skipping`);
        return false;
      }

      const header = data.subarray(0, 5).toString('ascii');
      if (header !== '%PDF-') {
        logError(`  ${entry.pdf_filename}: Not a valid PDF (header: ${header}), skipping`);
        return false;
      }

      // Atomic write
      const tmpPath = `${outPath}.tmp`;
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, outPath);

      entry.downloaded = true;
      entry.downloaded_at = new Date().toISOString();

      if (!progress.completedDownloads.includes(entry.pdf_url)) {
        progress.completedDownloads.push(entry.pdf_url);
      }

      const sizeKb = (data.length / 1024).toFixed(0);
      log(`  Downloaded: ${entry.pdf_filename} (${sizeKb}KB)`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        log(`  Retry ${attempt}/${MAX_RETRIES} for ${entry.pdf_filename}: ${msg}`);
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        logError(`  Failed after ${MAX_RETRIES} attempts: ${entry.pdf_filename} - ${msg}`);
      }
    }
  }

  return false;
}

async function downloadBatch(
  entries: PfrdaDocument[],
  outDir: string,
  progress: Progress,
): Promise<{ downloaded: number; failed: number }> {
  let downloaded = 0;
  let failed = 0;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    if (shuttingDown) break;

    const batch = entries.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((entry) => downloadPdf(entry, outDir, progress)));

    for (const result of results) {
      if (result) {
        downloaded++;
      } else {
        failed++;
      }
    }

    if (i % (CONCURRENCY * 5) === 0 && i > 0) {
      saveProgress(progress);
    }

    await sleep(DELAY_MS);
  }

  return { downloaded, failed };
}

// ─── Metadata Persistence ────────────────────────────────────────────────────

function saveMetadata(entries: PfrdaDocument[], category: CategorySlug): void {
  const metaPath = path.join(METADATA_DIR, `${category}-metadata.json`);
  fs.writeFileSync(metaPath, JSON.stringify(entries, null, 2));
  log(`  Saved metadata: ${metaPath} (${entries.length} entries)`);
}

function loadMetadata(category: CategorySlug): PfrdaDocument[] | null {
  const metaPath = path.join(METADATA_DIR, `${category}-metadata.json`);
  if (fs.existsSync(metaPath)) {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }
  return null;
}

function writeAllMetadataJsonl(allEntries: PfrdaDocument[]): void {
  const lines = allEntries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(ALL_METADATA_JSONL, lines + '\n');
  log(`Wrote combined metadata: ${ALL_METADATA_JSONL} (${allEntries.length} entries)`);
}

// ─── Category Processing ─────────────────────────────────────────────────────

async function processCategory(
  client: AxiosInstance,
  config: CategoryConfig,
  progress: Progress,
  opts: { metadataOnly: boolean; downloadOnly: boolean; testMode: boolean },
): Promise<PfrdaDocument[]> {
  log(`\n${'='.repeat(70)}`);
  log(`CATEGORY: ${config.label} (${config.slug})`);
  log(`${'='.repeat(70)}`);

  let documents: PfrdaDocument[];

  if (opts.downloadOnly) {
    const loaded = loadMetadata(config.slug);
    if (!loaded || loaded.length === 0) {
      logError(`No metadata found for ${config.slug}. Run without --download-only first.`);
      return [];
    }
    documents = loaded;
    log(`  Loaded ${documents.length} entries from metadata`);
  } else {
    // Phase 1: Get listing entries
    const listingEntries = await fetchAllListingPages(client, config);

    if (listingEntries.length === 0) {
      log(`  No documents found for ${config.slug}`);
      return [];
    }

    log(`  Found ${listingEntries.length} listing entries, fetching detail pages...`);

    // Phase 2: Fetch detail pages for PDF URLs and dates
    documents = [];
    let detailIdx = 0;

    for (const entry of listingEntries) {
      if (shuttingDown) break;

      detailIdx++;
      const detail = await fetchDetailWithRetry(client, entry.detailUrl);

      if (detail.pdfUrls.length === 0) {
        // Document with no PDF - still record it but with empty pdf_url
        documents.push({
          id: `pfrda-${config.slug}-${detailIdx}`,
          title: entry.title,
          category: config.label,
          category_slug: config.slug,
          detail_url: entry.detailUrl,
          pdf_url: '',
          pdf_filename: '',
          date: detail.date,
          date_iso: parseDateToIso(detail.date),
          reference_number: detail.referenceNumber,
          regulator: 'PFRDA',
          country: 'IN',
          source_url: `${BASE_URL}/web/pfrda${config.urlPath}`,
          scraped_at: new Date().toISOString(),
          downloaded: false,
          downloaded_at: null,
        });
      } else {
        // One document entry per PDF found
        for (let pIdx = 0; pIdx < detail.pdfUrls.length; pIdx++) {
          const pdfUrl = detail.pdfUrls[pIdx];
          const filename = extractFilename(pdfUrl, entry.title + (pIdx > 0 ? `-${pIdx + 1}` : ''));

          documents.push({
            id: `pfrda-${config.slug}-${detailIdx}${pIdx > 0 ? `-${pIdx + 1}` : ''}`,
            title: entry.title + (detail.pdfUrls.length > 1 ? ` (Attachment ${pIdx + 1})` : ''),
            category: config.label,
            category_slug: config.slug,
            detail_url: entry.detailUrl,
            pdf_url: pdfUrl,
            pdf_filename: filename,
            date: detail.date,
            date_iso: parseDateToIso(detail.date),
            reference_number: detail.referenceNumber,
            regulator: 'PFRDA',
            country: 'IN',
            source_url: `${BASE_URL}/web/pfrda${config.urlPath}`,
            scraped_at: new Date().toISOString(),
            downloaded: false,
            downloaded_at: null,
          });
        }
      }

      if (detailIdx % 10 === 0) {
        const pct = ((detailIdx / listingEntries.length) * 100).toFixed(1);
        log(
          `  [${pct}%] Detail ${detailIdx}/${listingEntries.length}: ${documents.length} documents`,
        );
      }

      await sleep(DELAY_MS);
    }

    saveMetadata(documents, config.slug);
  }

  if (opts.metadataOnly) {
    log(`  Metadata-only mode: skipping downloads`);
    return documents;
  }

  // Phase 3: Download PDFs
  const docsWithPdf = documents.filter((d) => d.pdf_url);
  if (docsWithPdf.length === 0) {
    log(`  No PDFs to download for ${config.slug}`);
    return documents;
  }

  const pdfDir = path.join(PDFS_DIR, config.pdfSubdir);
  fs.mkdirSync(pdfDir, { recursive: true });

  const toDownload = opts.testMode ? docsWithPdf.slice(0, 3) : docsWithPdf;

  const pendingDownloads = toDownload.filter(
    (e) => !progress.completedDownloads.includes(e.pdf_url),
  );

  if (pendingDownloads.length === 0) {
    log(`  All ${toDownload.length} PDFs already downloaded`);
  } else {
    log(
      `  Downloading ${pendingDownloads.length} PDFs (${toDownload.length - pendingDownloads.length} already done)`,
    );
    const { downloaded, failed } = await downloadBatch(pendingDownloads, pdfDir, progress);
    log(`  Category ${config.slug}: ${downloaded} downloaded, ${failed} failed`);
  }

  // Update progress
  const downloadedCount = documents.filter(
    (e) => e.downloaded || progress.completedDownloads.includes(e.pdf_url),
  ).length;
  progress.categories[config.slug] = {
    extracted: documents.length,
    downloaded: downloadedCount,
    lastUpdated: new Date().toISOString(),
  };
  saveProgress(progress);
  saveMetadata(documents, config.slug);

  log(`  Category ${config.slug}: ${downloadedCount}/${docsWithPdf.length} PDFs total`);
  return documents;
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): {
  category: CategorySlug | null;
  metadataOnly: boolean;
  downloadOnly: boolean;
  testMode: boolean;
} {
  const args = process.argv.slice(2);
  let category: CategorySlug | null = null;
  let metadataOnly = false;
  let downloadOnly = false;
  let testMode = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--category':
        category = args[++i] as CategorySlug;
        break;
      case '--metadata-only':
        metadataOnly = true;
        break;
      case '--download-only':
        downloadOnly = true;
        break;
      case '--test':
        testMode = true;
        break;
    }
  }

  return { category, metadataOnly, downloadOnly, testMode };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  setupShutdownHandler();

  const opts = parseArgs();

  log('=== PFRDA Scraper - Pension Fund Regulatory and Development Authority ===');
  log(`Base URL: ${BASE_URL}`);
  log(`Data dir: ${DATA_DIR}`);
  log(`Delay: ${DELAY_MS}ms | Retries: ${MAX_RETRIES} | Concurrency: ${CONCURRENCY}`);
  if (opts.category) log(`Category filter: ${opts.category}`);
  if (opts.metadataOnly) log(`Mode: metadata-only`);
  if (opts.downloadOnly) log(`Mode: download-only`);
  if (opts.testMode) log(`Mode: TEST (3 PDFs per category)`);

  // Create directories
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PDFS_DIR, { recursive: true });
  fs.mkdirSync(METADATA_DIR, { recursive: true });

  const client = createClient();
  const progress = loadProgress();
  const allDocuments: PfrdaDocument[] = [];

  // Filter categories
  const categories = opts.category
    ? CATEGORIES.filter((c) => c.slug === opts.category)
    : CATEGORIES.sort((a, b) => a.priority - b.priority);

  if (categories.length === 0) {
    logError(`Unknown category: ${opts.category}`);
    logError(`Valid categories: ${CATEGORIES.map((c) => c.slug).join(', ')}`);
    process.exit(1);
  }

  for (const cat of categories) {
    if (shuttingDown) break;
    const docs = await processCategory(client, cat, progress, opts);
    allDocuments.push(...docs);
  }

  // Write combined JSONL
  writeAllMetadataJsonl(allDocuments);
  saveProgress(progress);

  // Summary
  log(`\n${'='.repeat(70)}`);
  log('SUMMARY');
  log(`${'='.repeat(70)}`);

  const byCategory = new Map<string, { total: number; withPdf: number; downloaded: number }>();
  for (const doc of allDocuments) {
    const cat = byCategory.get(doc.category_slug) || { total: 0, withPdf: 0, downloaded: 0 };
    cat.total++;
    if (doc.pdf_url) cat.withPdf++;
    if (doc.downloaded || progress.completedDownloads.includes(doc.pdf_url)) cat.downloaded++;
    byCategory.set(doc.category_slug, cat);
  }

  for (const [cat, stats] of byCategory) {
    log(`  ${cat}: ${stats.downloaded}/${stats.withPdf} PDFs downloaded (${stats.total} entries)`);
  }

  const totalWithPdf = allDocuments.filter((d) => d.pdf_url).length;
  const totalDownloaded = allDocuments.filter(
    (e) => e.downloaded || progress.completedDownloads.includes(e.pdf_url),
  ).length;
  log(`  TOTAL: ${totalDownloaded}/${totalWithPdf} PDFs (${allDocuments.length} entries)`);
  log(`\nMetadata: ${ALL_METADATA_JSONL}`);
  log(`PDFs: ${PDFS_DIR}/`);
  log('=== PFRDA Scraper Complete ===');
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
