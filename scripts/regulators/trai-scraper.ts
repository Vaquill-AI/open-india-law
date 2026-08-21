/**
 * TRAI Scraper - Telecom Regulatory Authority of India (trai.gov.in)
 *
 * Scrapes all Regulations, Recommendations, Consultation Papers, Directions,
 * Tariff Orders, and supplementary documents from trai.gov.in for RAG pipeline.
 *
 * Categories scraped:
 *   1. Regulations (~350 docs, 1999-present)
 *   2. Recommendations (~342 docs)
 *   3. Consultation Papers (~420 docs)
 *   4. Directions (~391 docs)
 *   5. Consolidated Tariff Orders - Telecom (~4 docs)
 *   6. Consolidated Tariff Orders - Broadcasting (~4 docs)
 *   7. Miscellaneous (~150 docs)
 *   8. Consolidated Regulations - Telecom (~60 docs)
 *   9. Consolidated Regulations - Broadcasting (~30 docs)
 *  10. Standing Directions (5 sub-categories, ~10 docs total)
 *  11. Press Releases (~151 docs)
 *  12. Publications (~31 docs)
 *  13. Annual Reports (~20 docs)
 *  14. Study Papers
 *
 * Site: Drupal CMS, server-rendered HTML, no auth/CAPTCHA.
 * Pagination: ?page=X (0-indexed), 30 items per page.
 * PDFs: /sites/default/files/YYYY-MM/filename.pdf (direct download, no auth)
 *
 * Usage:
 *   npx tsx scripts/trai-scraper.ts                        # Full run (all categories)
 *   npx tsx scripts/trai-scraper.ts --category regulations  # Single category
 *   npx tsx scripts/trai-scraper.ts --category recommendations
 *   npx tsx scripts/trai-scraper.ts --category consultation
 *   npx tsx scripts/trai-scraper.ts --category directions
 *   npx tsx scripts/trai-scraper.ts --category tariff-telecom
 *   npx tsx scripts/trai-scraper.ts --category tariff-broadcasting
 *   npx tsx scripts/trai-scraper.ts --category press-releases
 *   npx tsx scripts/trai-scraper.ts --category publications
 *   npx tsx scripts/trai-scraper.ts --category annual-reports
 *   npx tsx scripts/trai-scraper.ts --category study-papers
 *   npx tsx scripts/trai-scraper.ts --metadata-only         # Extract links only, no downloads
 *   npx tsx scripts/trai-scraper.ts --download-only          # Download from existing metadata
 *   npx tsx scripts/trai-scraper.ts --test                   # Test mode (3 PDFs per category)
 *
 * Environment:
 *   DELAY_MS=500           Delay between requests (default: 500)
 *   DATA_DIR=data/legal-sources/trai   Output directory
 *   MAX_RETRIES=3          Retry attempts per download (default: 3)
 *   CONCURRENCY=5          Parallel downloads (default: 5)
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

const BASE_URL = 'https://trai.gov.in';
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const RETRY_DELAY_MS = 3000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 30_000;
const ITEMS_PER_PAGE = 28; // Most pages have 30-31 items; use 28 as threshold to avoid early stop

const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data/legal-sources/trai');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const ALL_METADATA_JSONL = path.join(DATA_DIR, 'trai-all-metadata.jsonl');

// ─── Types ───────────────────────────────────────────────────────────────────

type CategoryName =
  | 'regulations'
  | 'recommendations'
  | 'consultation'
  | 'directions'
  | 'tariff-telecom'
  | 'tariff-broadcasting'
  | 'miscellaneous'
  | 'consolidated-regs-telecom'
  | 'consolidated-regs-broadcasting'
  | 'standing-directions-broadband'
  | 'standing-directions-broadcasting'
  | 'standing-directions-financial'
  | 'standing-directions-network'
  | 'standing-directions-qos'
  | 'press-releases'
  | 'publications'
  | 'annual-reports'
  | 'study-papers';

interface PageConfig {
  category: CategoryName;
  label: string;
  urlPath: string;
  pdfSubdir: string;
  paginated: boolean;
}

const PAGES: PageConfig[] = [
  {
    category: 'regulations',
    label: 'Regulations',
    urlPath: '/release-publication/regulations',
    pdfSubdir: 'regulations',
    paginated: true,
  },
  {
    category: 'recommendations',
    label: 'Recommendations',
    urlPath: '/release-publication/recommendation',
    pdfSubdir: 'recommendations',
    paginated: true,
  },
  {
    category: 'consultation',
    label: 'Consultation Papers',
    urlPath: '/release-publication/consultation',
    pdfSubdir: 'consultation',
    paginated: true,
  },
  {
    category: 'directions',
    label: 'Directions',
    urlPath: '/release-publication/directions',
    pdfSubdir: 'directions',
    paginated: true,
  },
  {
    category: 'tariff-telecom',
    label: 'Consolidated Tariff Orders (Telecom)',
    urlPath: '/release-publication/consolidated-tariff-orders/telecom',
    pdfSubdir: 'tariff-orders/telecom',
    paginated: false,
  },
  {
    category: 'tariff-broadcasting',
    label: 'Consolidated Tariff Orders (Broadcasting)',
    urlPath: '/release-publication/consolidated-tariff-orders/broadcasting',
    pdfSubdir: 'tariff-orders/broadcasting',
    paginated: false,
  },
  {
    category: 'miscellaneous',
    label: 'Miscellaneous',
    urlPath: '/release-publication/miscellaneous',
    pdfSubdir: 'miscellaneous',
    paginated: true,
  },
  {
    category: 'consolidated-regs-telecom',
    label: 'Consolidated Regulations (Telecom)',
    urlPath: '/release-publication/consolidated-regulations/telecom',
    pdfSubdir: 'consolidated-regulations/telecom',
    paginated: true,
  },
  {
    category: 'consolidated-regs-broadcasting',
    label: 'Consolidated Regulations (Broadcasting)',
    urlPath: '/release-publication/consolidated-regulations/broadcasting',
    pdfSubdir: 'consolidated-regulations/broadcasting',
    paginated: true,
  },
  {
    category: 'standing-directions-broadband',
    label: 'Standing Directions (Broadband & Policy)',
    urlPath: '/release-publication/standing-directions/broadband-and-policy-analysis',
    pdfSubdir: 'standing-directions/broadband',
    paginated: false,
  },
  {
    category: 'standing-directions-broadcasting',
    label: 'Standing Directions (Broadcasting & Cable)',
    urlPath: '/release-publication/standing-directions/broadcasting-and-cable-services',
    pdfSubdir: 'standing-directions/broadcasting',
    paginated: false,
  },
  {
    category: 'standing-directions-financial',
    label: 'Standing Directions (Financial & Economic)',
    urlPath: '/release-publication/standing-directions/financial-and-economic-analysis',
    pdfSubdir: 'standing-directions/financial',
    paginated: false,
  },
  {
    category: 'standing-directions-network',
    label: 'Standing Directions (Network, Spectrum & Licensing)',
    urlPath: '/release-publication/standing-directions/network-spectrum-and-licensing',
    pdfSubdir: 'standing-directions/network',
    paginated: false,
  },
  {
    category: 'standing-directions-qos',
    label: 'Standing Directions (Quality of Service)',
    urlPath: '/release-publication/standing-directions/quality-of-Service',
    pdfSubdir: 'standing-directions/qos',
    paginated: false,
  },
  {
    category: 'press-releases',
    label: 'Press Releases',
    urlPath: '/notifications/press-release',
    pdfSubdir: 'press-releases',
    paginated: true,
  },
  {
    category: 'publications',
    label: 'Publications',
    urlPath: '/notifications/publication',
    pdfSubdir: 'publications',
    paginated: true,
  },
  {
    category: 'annual-reports',
    label: 'Annual Reports',
    urlPath: '/about-us/annual-reports',
    pdfSubdir: 'annual-reports',
    paginated: false,
  },
  {
    category: 'study-papers',
    label: 'Study Papers',
    urlPath: '/release-publication/reports/study-paper',
    pdfSubdir: 'study-papers',
    paginated: true,
  },
];

interface DocumentEntry {
  serialNumber: number | null;
  title: string;
  releaseDate: string | null;
  division: string | null;
  pdfUrl: string;
  fileSize: string | null;
  category: CategoryName;
  filename: string;
  amendmentsPageUrl: string | null;
  downloaded: boolean;
  downloadedAt: string | null;
  localPath: string | null;
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

function resolveUrl(href: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('/')) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
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

function parseFileSize(text: string): string | null {
  const match = text.match(/\((\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes?))\)/i);
  return match ? match[1] : null;
}

// ─── Document Extraction ─────────────────────────────────────────────────────

function extractDocumentsFromPage(
  html: string,
  category: CategoryName,
): { entries: DocumentEntry[]; itemCount: number } {
  const $ = cheerio.load(html);
  const entries: DocumentEntry[] = [];
  const seenUrls = new Set<string>();
  let itemCount = 0;

  // Strategy 1: Parse structured list items (primary category pages)
  $('li').each((_i, li) => {
    const $li = $(li);

    const serialText = $li.find('.serial-number .field-content').text().trim();
    const title = $li.find('.title-number .field-content').text().trim();
    const dateText = $li.find('.release-date .field-content').text().trim();
    const division = $li.find('.division-section .field-content').text().trim() || null;

    // Skip if no title (not a document row)
    if (!title) return;

    itemCount++;

    // Check for amendments page
    const amendmentsLink = $li.find('.comment-field a[href*="amendments-page"]');
    const amendmentsPageUrl =
      amendmentsLink.length > 0 ? resolveUrl(amendmentsLink.attr('href') || '') : null;

    const serialNumber = serialText ? parseInt(serialText, 10) : null;

    // Find ALL PDF links within this list item (main + sub-documents)
    $li.find('a[href*=".pdf"]').each((_j, pdfEl) => {
      const href = $(pdfEl).attr('href');
      if (!href) return;

      const fullUrl = resolveUrl(href);
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      // Extract file size from link text or aria-label
      const ariaLabel = $(pdfEl).attr('aria-label') || '';
      const linkText = $(pdfEl).text();
      const fileSize = parseFileSize(ariaLabel) || parseFileSize(linkText);

      // For sub-documents, try to get a more specific title from aria-label
      let docTitle = title;
      if (ariaLabel) {
        const labelMatch = ariaLabel.match(
          /Download PDF for (.+?)(?:\s*-\s*\([\d.]+\s*[KMG]B\))?(?:,\s*opens)?/i,
        );
        if (labelMatch && labelMatch[1].length > 5) {
          docTitle = labelMatch[1].trim();
        }
      }

      entries.push({
        serialNumber: isNaN(serialNumber as number) ? null : serialNumber,
        title: docTitle,
        releaseDate: dateText || null,
        division,
        pdfUrl: fullUrl,
        fileSize,
        category,
        filename: extractFilename(fullUrl, docTitle),
        amendmentsPageUrl,
        downloaded: false,
        downloadedAt: null,
        localPath: null,
      });
    });
  });

  // Strategy 2: If no structured items found, fall back to all PDF links
  if (entries.length === 0) {
    $('a[href*=".pdf"]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      const fullUrl = resolveUrl(href);
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      let docTitle = $(el).text().trim();
      if (!docTitle || docTitle.length < 3) {
        // Try parent context
        const parent = $(el).closest('td, li, div.field-content, div.views-row');
        docTitle = parent.text().trim().split('\n')[0]?.trim() || '';
      }
      if (!docTitle || docTitle.length < 3) {
        docTitle = decodeURIComponent(path.basename(new URL(fullUrl).pathname))
          .replace(/\.pdf$/i, '')
          .replace(/%20/g, ' ');
      }

      const ariaLabel = $(el).attr('aria-label') || '';
      const linkText = $(el).text();
      const fileSize = parseFileSize(ariaLabel) || parseFileSize(linkText);

      entries.push({
        serialNumber: null,
        title: docTitle.replace(/\s+/g, ' ').trim(),
        releaseDate: null,
        division: null,
        pdfUrl: fullUrl,
        fileSize,
        category,
        filename: extractFilename(fullUrl, docTitle),
        amendmentsPageUrl: null,
        downloaded: false,
        downloadedAt: null,
        localPath: null,
      });
    });
    itemCount = entries.length;
  }

  return { entries, itemCount };
}

// ─── Paginated Fetching ──────────────────────────────────────────────────────

async function fetchAllPages(client: AxiosInstance, config: PageConfig): Promise<DocumentEntry[]> {
  const allEntries: DocumentEntry[] = [];
  const seenUrls = new Set<string>();

  if (!config.paginated) {
    // Single page - just fetch it
    log(`  Fetching: ${config.urlPath}`);
    try {
      const response = await client.get(config.urlPath);
      const { entries } = extractDocumentsFromPage(response.data, config.category);
      log(`  Found ${entries.length} documents`);
      return entries;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to fetch ${config.urlPath}: ${msg}`);
      return [];
    }
  }

  // Paginated - iterate until no more documents
  let page = 0;
  let consecutiveEmpty = 0;

  while (!shuttingDown) {
    const url = `${config.urlPath}?page=${page}`;
    log(`  Fetching page ${page}: ${url}`);

    try {
      const response = await client.get(url);
      const { entries, itemCount } = extractDocumentsFromPage(response.data, config.category);

      // Filter out already-seen URLs
      const newEntries = entries.filter((e) => {
        if (seenUrls.has(e.pdfUrl)) return false;
        seenUrls.add(e.pdfUrl);
        return true;
      });

      if (newEntries.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) {
          log(`  No new documents on page ${page}, stopping pagination`);
          break;
        }
      } else {
        consecutiveEmpty = 0;
        allEntries.push(...newEntries);
        log(`  Page ${page}: ${newEntries.length} new documents (total: ${allEntries.length})`);
      }

      // Use itemCount (serial numbers) for pagination, not PDF count
      if (itemCount < ITEMS_PER_PAGE && itemCount > 0) {
        log(`  Partial page (${itemCount} items/${ITEMS_PER_PAGE}), likely last page`);
        break;
      }

      page++;
      await sleep(DELAY_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        log(`  Page ${page} returned 404, stopping pagination`);
        break;
      }
      logError(`Failed to fetch page ${page}: ${msg}`);
      // Retry once
      await sleep(RETRY_DELAY_MS);
      try {
        const response = await client.get(url);
        const { entries } = extractDocumentsFromPage(response.data, config.category);
        const newEntries = entries.filter((e) => {
          if (seenUrls.has(e.pdfUrl)) return false;
          seenUrls.add(e.pdfUrl);
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

// ─── PDF Download ────────────────────────────────────────────────────────────

async function downloadPdf(
  entry: DocumentEntry,
  outDir: string,
  progress: Progress,
): Promise<boolean> {
  if (progress.completedDownloads.includes(entry.pdfUrl)) {
    return true;
  }

  const outPath = path.join(outDir, entry.filename);

  // Skip if already downloaded and has content
  if (fs.existsSync(outPath)) {
    const stats = fs.statSync(outPath);
    if (stats.size > 500) {
      entry.downloaded = true;
      entry.downloadedAt = new Date().toISOString();
      entry.localPath = outPath;
      if (!progress.completedDownloads.includes(entry.pdfUrl)) {
        progress.completedDownloads.push(entry.pdfUrl);
      }
      return true;
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (shuttingDown) return false;

    try {
      const response = await axios.get(entry.pdfUrl, {
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
        logError(`  ${entry.filename}: Too small (${data.length} bytes), skipping`);
        return false;
      }

      const header = data.subarray(0, 5).toString('ascii');
      if (header !== '%PDF-') {
        logError(`  ${entry.filename}: Not a valid PDF (header: ${header}), skipping`);
        return false;
      }

      fs.writeFileSync(outPath, data);
      entry.downloaded = true;
      entry.downloadedAt = new Date().toISOString();
      entry.localPath = outPath;

      if (!progress.completedDownloads.includes(entry.pdfUrl)) {
        progress.completedDownloads.push(entry.pdfUrl);
      }

      const sizeKb = (data.length / 1024).toFixed(0);
      log(`  Downloaded: ${entry.filename} (${sizeKb}KB)`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        log(`  Retry ${attempt}/${MAX_RETRIES} for ${entry.filename}: ${msg}`);
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        logError(`  Failed after ${MAX_RETRIES} attempts: ${entry.filename} - ${msg}`);
      }
    }
  }

  return false;
}

async function downloadBatch(
  entries: DocumentEntry[],
  outDir: string,
  progress: Progress,
): Promise<{ downloaded: number; failed: number }> {
  let downloaded = 0;
  let failed = 0;

  // Process in batches for concurrency
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

    // Save progress periodically
    if (i % (CONCURRENCY * 5) === 0 && i > 0) {
      saveProgress(progress);
    }

    await sleep(DELAY_MS);
  }

  return { downloaded, failed };
}

// ─── Metadata Persistence ────────────────────────────────────────────────────

function saveMetadata(entries: DocumentEntry[], category: CategoryName): void {
  const metaPath = path.join(METADATA_DIR, `${category}-metadata.json`);
  fs.writeFileSync(metaPath, JSON.stringify(entries, null, 2));
  log(`  Saved metadata: ${metaPath} (${entries.length} entries)`);
}

function loadMetadata(category: CategoryName): DocumentEntry[] | null {
  const metaPath = path.join(METADATA_DIR, `${category}-metadata.json`);
  if (fs.existsSync(metaPath)) {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }
  return null;
}

function writeAllMetadataJsonl(allEntries: DocumentEntry[]): void {
  const lines = allEntries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(ALL_METADATA_JSONL, lines + '\n');
  log(`Wrote combined metadata: ${ALL_METADATA_JSONL} (${allEntries.length} entries)`);
}

// ─── Category Processing ─────────────────────────────────────────────────────

async function processCategory(
  client: AxiosInstance,
  page: PageConfig,
  progress: Progress,
  opts: { metadataOnly: boolean; downloadOnly: boolean; testMode: boolean },
): Promise<DocumentEntry[]> {
  log(`\n${'='.repeat(70)}`);
  log(`CATEGORY: ${page.label} (${page.category})`);
  log(`${'='.repeat(70)}`);

  let entries: DocumentEntry[];

  if (opts.downloadOnly) {
    const loaded = loadMetadata(page.category);
    if (!loaded || loaded.length === 0) {
      logError(`No metadata found for ${page.category}. Run without --download-only first.`);
      return [];
    }
    entries = loaded;
    log(`  Loaded ${entries.length} entries from metadata`);
  } else {
    entries = await fetchAllPages(client, page);
    if (entries.length === 0) {
      log(`  No documents found for ${page.category}`);
      return [];
    }
    saveMetadata(entries, page.category);
  }

  if (opts.metadataOnly) {
    log(`  Metadata-only mode: skipping downloads`);
    return entries;
  }

  // Download PDFs
  const pdfDir = path.join(PDFS_DIR, page.pdfSubdir);
  fs.mkdirSync(pdfDir, { recursive: true });

  const toDownload = opts.testMode ? entries.slice(0, 3) : entries;

  // Filter out already downloaded
  const pendingDownloads = toDownload.filter(
    (e) => !progress.completedDownloads.includes(e.pdfUrl),
  );

  if (pendingDownloads.length === 0) {
    log(`  All ${toDownload.length} documents already downloaded`);
  } else {
    log(
      `  Downloading ${pendingDownloads.length} PDFs (${toDownload.length - pendingDownloads.length} already done)`,
    );
    const { downloaded, failed } = await downloadBatch(pendingDownloads, pdfDir, progress);
    log(`  Category ${page.category}: ${downloaded} downloaded, ${failed} failed`);
  }

  // Update progress
  const downloadedCount = entries.filter(
    (e) => e.downloaded || progress.completedDownloads.includes(e.pdfUrl),
  ).length;
  progress.categories[page.category] = {
    extracted: entries.length,
    downloaded: downloadedCount,
    lastUpdated: new Date().toISOString(),
  };
  saveProgress(progress);
  saveMetadata(entries, page.category);

  log(`  Category ${page.category}: ${downloadedCount}/${entries.length} total`);
  return entries;
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): {
  category: CategoryName | null;
  metadataOnly: boolean;
  downloadOnly: boolean;
  testMode: boolean;
} {
  const args = process.argv.slice(2);
  let category: CategoryName | null = null;
  let metadataOnly = false;
  let downloadOnly = false;
  let testMode = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--category':
        category = args[++i] as CategoryName;
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

  log('=== TRAI Scraper - Telecom Regulatory Authority of India ===');
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
  const allEntries: DocumentEntry[] = [];

  // Filter pages if category specified
  const pages = opts.category ? PAGES.filter((p) => p.category === opts.category) : PAGES;

  if (pages.length === 0) {
    logError(`Unknown category: ${opts.category}`);
    logError(`Valid categories: ${PAGES.map((p) => p.category).join(', ')}`);
    process.exit(1);
  }

  for (const page of pages) {
    if (shuttingDown) break;
    const entries = await processCategory(client, page, progress, opts);
    allEntries.push(...entries);
  }

  // Write combined JSONL
  writeAllMetadataJsonl(allEntries);
  saveProgress(progress);

  // Summary
  log(`\n${'='.repeat(70)}`);
  log('SUMMARY');
  log(`${'='.repeat(70)}`);

  const byCategory = new Map<string, { total: number; downloaded: number }>();
  for (const entry of allEntries) {
    const cat = byCategory.get(entry.category) || { total: 0, downloaded: 0 };
    cat.total++;
    if (entry.downloaded || progress.completedDownloads.includes(entry.pdfUrl)) cat.downloaded++;
    byCategory.set(entry.category, cat);
  }

  for (const [cat, stats] of byCategory) {
    log(`  ${cat}: ${stats.downloaded}/${stats.total} downloaded`);
  }

  const totalDownloaded = allEntries.filter(
    (e) => e.downloaded || progress.completedDownloads.includes(e.pdfUrl),
  ).length;
  log(`  TOTAL: ${totalDownloaded}/${allEntries.length} PDFs`);
  log(`\nMetadata: ${ALL_METADATA_JSONL}`);
  log(`PDFs: ${PDFS_DIR}/`);
  log('=== TRAI Scraper Complete ===');
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
