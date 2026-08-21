/**
 * DFS Scraper - Department of Financial Services (financialservices.gov.in)
 *
 * Scrapes all Acts, Rules, Regulations, Schemes, and associated legal PDFs
 * from the Department of Financial Services website for RAG pipeline ingestion.
 *
 * Categories scraped:
 *   1. Banking Acts & Associated Rules/Schemes/Regulations (~60-80 PDFs)
 *   2. Insurance Acts & IRDAI Regulations (~50-60 PDFs)
 *   3. Pension Reforms Acts & Rules (~15-20 PDFs)
 *   4. Related Laws (DICGC, Factoring, Payment Systems, etc.) (~15-20 PDFs)
 *   5. Ombudsman Scheme documents
 *   6. Unified Pension Scheme / NPS documents
 *
 * Usage:
 *   npx tsx scripts/dfs-scraper.ts                      # Full run (all categories)
 *   npx tsx scripts/dfs-scraper.ts --category banking    # Single category
 *   npx tsx scripts/dfs-scraper.ts --category insurance
 *   npx tsx scripts/dfs-scraper.ts --category pension
 *   npx tsx scripts/dfs-scraper.ts --category related-laws
 *   npx tsx scripts/dfs-scraper.ts --category ombudsman
 *   npx tsx scripts/dfs-scraper.ts --category ups-nps
 *   npx tsx scripts/dfs-scraper.ts --metadata-only       # Extract links only, no downloads
 *   npx tsx scripts/dfs-scraper.ts --download-only        # Download from existing metadata
 *   npx tsx scripts/dfs-scraper.ts --test                 # Test mode (3 PDFs per category)
 *
 * Environment:
 *   DELAY_MS=500           Delay between downloads (default: 500)
 *   DATA_DIR=data/dfs      Output directory (default: data/dfs)
 *   MAX_RETRIES=3          Retry attempts per download (default: 3)
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

const BASE_URL = 'https://financialservices.gov.in';
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_DELAY_MS = 3000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data/legal-sources/dfs');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const ALL_METADATA_JSONL = path.join(DATA_DIR, 'dfs-all-metadata.jsonl');

type CategoryName = 'banking' | 'insurance' | 'pension' | 'related-laws' | 'ombudsman' | 'ups-nps';

interface PageConfig {
  category: CategoryName;
  label: string;
  url: string;
  pdfSubdir: string;
}

const PAGES: PageConfig[] = [
  {
    category: 'banking',
    label: 'Banking Acts & Associated Rules',
    url: '/beta/en/acts-associated-rules',
    pdfSubdir: 'banking',
  },
  {
    category: 'insurance',
    label: 'Insurance Acts & Associated Rules',
    url: '/beta/en/insurance-act-associated-rules',
    pdfSubdir: 'insurance',
  },
  {
    category: 'pension',
    label: 'Pension Reforms Acts & Rules',
    url: '/beta/en/pension-reforms-act',
    pdfSubdir: 'pension',
  },
  {
    category: 'related-laws',
    label: 'Related Laws',
    url: '/beta/en/related-laws',
    pdfSubdir: 'related-laws',
  },
  {
    category: 'ombudsman',
    label: 'Banking Ombudsman',
    url: '/beta/en/banking-ombudsman',
    pdfSubdir: 'ombudsman',
  },
  {
    category: 'ups-nps',
    label: 'Unified Pension Scheme',
    url: '/beta/en/ups',
    pdfSubdir: 'ups-nps',
  },
];

interface PdfEntry {
  title: string;
  url: string;
  category: CategoryName;
  parentAct: string | null;
  docType: 'act' | 'rule' | 'regulation' | 'scheme' | 'notification' | 'other';
  fileSize: string | null;
  filename: string;
  downloaded: boolean;
  downloadedAt: string | null;
  localPath: string | null;
}

interface Progress {
  lastRun: string;
  categories: Record<string, { extracted: number; downloaded: number; lastUpdated: string }>;
  completedDownloads: string[]; // URLs already downloaded
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
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
    timeout: 60_000,
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
  progress.lastRun = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
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

function classifyDocType(
  title: string,
  href: string,
): 'act' | 'rule' | 'regulation' | 'scheme' | 'notification' | 'other' {
  const t = title.toLowerCase();
  const h = href.toLowerCase();
  if (t.includes('regulation') || h.includes('regulation')) return 'regulation';
  if (t.includes('scheme') || h.includes('scheme')) return 'scheme';
  if (t.includes('rule') || h.includes('rule')) return 'rule';
  if (t.includes('notification') || h.includes('notification') || h.includes('gazette'))
    return 'notification';
  if (t.includes('act') || h.includes('act')) return 'act';
  return 'other';
}

function resolveUrl(href: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('/')) return `${BASE_URL}${href}`;
  return `${BASE_URL}/${href}`;
}

function extractFilename(url: string, title: string): string {
  // Try to get a meaningful filename from the URL
  const urlPath = new URL(url).pathname;
  const urlFilename = path.basename(urlPath);
  const decoded = decodeURIComponent(urlFilename);

  // If URL filename is meaningful, use it
  if (decoded.length > 5 && decoded.endsWith('.pdf')) {
    return decoded;
  }

  // Fall back to title-based filename
  return sanitizeFilename(title) + '.pdf';
}

// ─── PDF Link Extraction ─────────────────────────────────────────────────────

function extractPdfLinks(html: string, category: CategoryName, pageLabel: string): PdfEntry[] {
  const $ = cheerio.load(html);
  const entries: PdfEntry[] = [];
  const seenUrls = new Set<string>();

  // Strategy 1: Find all PDF links directly
  $('a[href*=".pdf"]').each((_i, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const fullUrl = resolveUrl(href);
    if (seenUrls.has(fullUrl)) return;
    seenUrls.add(fullUrl);

    // Get the link text as title
    let title = $(el).text().trim();

    // If link text is just a file size or icon, try to find context
    if (!title || title.length < 3 || /^\d+(\.\d+)?\s*(KB|MB|GB|bytes?)$/i.test(title)) {
      // Look for parent context
      const parentTd = $(el).closest('td');
      const parentLi = $(el).closest('li');
      const parentDiv = $(el).closest('.field__item, .views-row, .accordion-body');

      title =
        parentTd.prev('td').text().trim() ||
        parentLi.text().trim().split('\n')[0]?.trim() ||
        parentDiv.find('h3, h4, h5, strong, .field__label').first().text().trim() ||
        '';
    }

    // Still no title? Use filename
    if (!title || title.length < 3) {
      title = decodeURIComponent(path.basename(new URL(fullUrl).pathname))
        .replace(/\.pdf$/i, '')
        .replace(/%20/g, ' ');
    }

    // Clean up title
    title = title.replace(/\s+/g, ' ').trim();

    // Extract file size if present near the link
    const parentText = $(el).parent().text();
    const sizeMatch = parentText.match(/(\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes?))/i);
    const fileSize = sizeMatch ? sizeMatch[1] : null;

    // Try to determine parent act from context
    let parentAct: string | null = null;
    const accordion = $(el).closest('.accordion-item, .card, details');
    if (accordion.length) {
      parentAct =
        accordion.find('.accordion-header, .card-header, summary, h3').first().text().trim() ||
        null;
    }
    // Also try table structure
    if (!parentAct) {
      const table = $(el).closest('table');
      if (table.length) {
        const headerRow = table.find('thead tr, tr').first();
        const actCell = $(el).closest('tr').find('td').first();
        if (actCell.length && actCell.index() > 0) {
          // Find the act name from the first column or previous rows
          const actName = actCell.text().trim();
          if (actName.length > 5) parentAct = actName;
        }
      }
    }

    const filename = extractFilename(fullUrl, title);
    const docType = classifyDocType(title, fullUrl);

    entries.push({
      title,
      url: fullUrl,
      category,
      parentAct,
      docType,
      fileSize,
      filename,
      downloaded: false,
      downloadedAt: null,
      localPath: null,
    });
  });

  log(`  [${pageLabel}] Found ${entries.length} PDF links`);
  return entries;
}

// ─── PDF Download ────────────────────────────────────────────────────────────

async function downloadPdf(
  client: AxiosInstance,
  entry: PdfEntry,
  outDir: string,
  progress: Progress,
): Promise<boolean> {
  if (progress.completedDownloads.includes(entry.url)) {
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
      if (!progress.completedDownloads.includes(entry.url)) {
        progress.completedDownloads.push(entry.url);
      }
      return true;
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (shuttingDown) return false;

    try {
      const response = await axios.get(entry.url, {
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

      // Validate it's actually a PDF (starts with %PDF)
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

      if (!progress.completedDownloads.includes(entry.url)) {
        progress.completedDownloads.push(entry.url);
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

// ─── Metadata Persistence ────────────────────────────────────────────────────

function saveMetadata(entries: PdfEntry[], category: CategoryName): void {
  const metaPath = path.join(METADATA_DIR, `${category}-metadata.json`);
  fs.writeFileSync(metaPath, JSON.stringify(entries, null, 2));
  log(`  Saved metadata: ${metaPath} (${entries.length} entries)`);
}

function loadMetadata(category: CategoryName): PdfEntry[] | null {
  const metaPath = path.join(METADATA_DIR, `${category}-metadata.json`);
  if (fs.existsSync(metaPath)) {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }
  return null;
}

function writeAllMetadataJsonl(allEntries: PdfEntry[]): void {
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
): Promise<PdfEntry[]> {
  log(`\n${'='.repeat(70)}`);
  log(`CATEGORY: ${page.label} (${page.category})`);
  log(`${'='.repeat(70)}`);

  let entries: PdfEntry[];

  if (opts.downloadOnly) {
    // Load existing metadata
    const loaded = loadMetadata(page.category);
    if (!loaded || loaded.length === 0) {
      logError(`No metadata found for ${page.category}. Run without --download-only first.`);
      return [];
    }
    entries = loaded;
    log(`  Loaded ${entries.length} entries from metadata`);
  } else {
    // Fetch page and extract PDF links
    log(`  Fetching: ${BASE_URL}${page.url}`);
    try {
      const response = await client.get(page.url);
      entries = extractPdfLinks(response.data, page.category, page.label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to fetch ${page.url}: ${msg}`);
      return [];
    }

    // Save metadata
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
  let downloaded = 0;
  const skipped = 0;
  let failed = 0;

  for (const entry of toDownload) {
    if (shuttingDown) break;

    const result = await downloadPdf(client, entry, pdfDir, progress);
    if (result) {
      if (progress.completedDownloads.includes(entry.url)) {
        // Could be a skip (already existed) or fresh download
        downloaded++;
      }
    } else {
      failed++;
    }

    await sleep(DELAY_MS);
  }

  // Update progress for this category
  progress.categories[page.category] = {
    extracted: entries.length,
    downloaded,
    lastUpdated: new Date().toISOString(),
  };
  saveProgress(progress);

  // Re-save metadata with download status
  saveMetadata(entries, page.category);

  log(
    `  Category ${page.category}: ${downloaded} downloaded, ${failed} failed, ${entries.length} total`,
  );
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

  log('=== DFS Scraper - Department of Financial Services ===');
  log(`Base URL: ${BASE_URL}`);
  log(`Data dir: ${DATA_DIR}`);
  log(`Delay: ${DELAY_MS}ms | Retries: ${MAX_RETRIES}`);
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
  const allEntries: PdfEntry[] = [];

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
    if (entry.downloaded) cat.downloaded++;
    byCategory.set(entry.category, cat);
  }

  for (const [cat, stats] of byCategory) {
    log(`  ${cat}: ${stats.downloaded}/${stats.total} downloaded`);
  }

  const totalDownloaded = allEntries.filter((e) => e.downloaded).length;
  log(`  TOTAL: ${totalDownloaded}/${allEntries.length} PDFs`);
  log(`\nMetadata: ${ALL_METADATA_JSONL}`);
  log(`PDFs: ${PDFS_DIR}/`);
  log('=== DFS Scraper Complete ===');
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
