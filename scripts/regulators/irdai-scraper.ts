/**
 * IRDAI Scraper - Insurance Regulatory and Development Authority of India
 * Scrapes circulars, orders, guidelines, regulations, notifications, exposure drafts
 * from https://irdai.gov.in
 *
 * Architecture:
 *   - Liferay DXP portal behind Azure Front Door WAF
 *   - Pagination requires Playwright (Liferay portlet POST forms, GET returns page 1 only)
 *   - PDFs downloadable via plain GET (no auth needed)
 *   - No CAPTCHA, no JS challenges
 *
 * Categories (~1,641 docs):
 *   1. Circulars           ~585 docs
 *   2. Exposure Drafts     ~229 docs
 *   3. Orders              ~192 docs
 *   4. Consolidated Regs   ~191 docs
 *   5. Guidelines          ~90 docs
 *   6. Notifications       ~40 docs
 *   7. Annual Reports      ~27 docs
 *   8. Handbook            ~18 docs
 *   9. Acts                ~7 docs
 *  10. Rules               ~6 docs
 *
 * Usage:
 *   npx tsx scripts/irdai-scraper.ts                              # Full run
 *   npx tsx scripts/irdai-scraper.ts --test                       # Test mode (1 page per category)
 *   npx tsx scripts/irdai-scraper.ts --metadata-only              # Metadata only, skip PDF download
 *   npx tsx scripts/irdai-scraper.ts --download-only              # PDFs only (requires prior metadata run)
 *   npx tsx scripts/irdai-scraper.ts --category circulars         # Single category
 *
 * Environment:
 *   PDF_WORKERS=5          Concurrent PDF downloads (default: 5)
 *   DELAY_MS=3000          Delay between page navigations (default: 3000)
 *   PDF_DELAY_MS=500       Delay between PDF downloads (default: 500)
 */

import { chromium, Page } from 'playwright';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://irdai.gov.in';
const PDF_WORKERS = parseInt(process.env.PDF_WORKERS || '5', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '3000', 10);
const PDF_DELAY_MS = parseInt(process.env.PDF_DELAY_MS || '500', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const ITEMS_PER_PAGE = 60; // max Liferay allows

const DATA_DIR = process.env.DATA_DIR || 'data/regulatory/irdai';
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const JSONL_FILE = path.join(DATA_DIR, 'irdai-all-documents.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'pdfs-downloaded.txt');

// ─── Category Registry ───────────────────────────────────────────────────────

type CategorySlug =
  | 'circulars'
  | 'exposure-drafts'
  | 'orders'
  | 'regulations'
  | 'guidelines'
  | 'notifications'
  | 'annual-reports'
  | 'handbook'
  | 'acts'
  | 'rules';

interface CategoryConfig {
  slug: CategorySlug;
  label: string;
  urlPath: string;
  priority: number;
}

const CATEGORIES: CategoryConfig[] = [
  { slug: 'circulars', label: 'Circulars', urlPath: '/circulars', priority: 1 },
  { slug: 'exposure-drafts', label: 'Exposure Drafts', urlPath: '/exposure-drafts', priority: 2 },
  { slug: 'orders', label: 'Orders', urlPath: '/orders1', priority: 3 },
  {
    slug: 'regulations',
    label: 'Consolidated Regulations',
    urlPath: '/consolidated-gazette-notified-regulations',
    priority: 4,
  },
  { slug: 'guidelines', label: 'Guidelines', urlPath: '/guidelines', priority: 5 },
  { slug: 'notifications', label: 'Notifications', urlPath: '/notifications', priority: 6 },
  { slug: 'annual-reports', label: 'Annual Reports', urlPath: '/annual-reports', priority: 7 },
  {
    slug: 'handbook',
    label: 'Handbook of Indian Insurance',
    urlPath: '/handbook-of-indian-insurance',
    priority: 8,
  },
  { slug: 'acts', label: 'Acts', urlPath: '/acts', priority: 9 },
  { slug: 'rules', label: 'Rules', urlPath: '/rules', priority: 10 },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface IrdaiDocument {
  id: string;
  category: string;
  category_slug: CategorySlug;
  title: string;
  date: string;
  date_iso: string;
  reference_no: string;
  file_size: string;
  file_url: string;
  pdf_filename: string;
  pdf_size_bytes: number;
  uuid: string;
  version: string;
  regulator: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  categories_completed: string[];
  total_documents: number;
  total_pdfs: number;
  last_updated: string;
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

let shuttingDown = false;

function setupShutdownHandler(progress: Progress): void {
  const handler = () => {
    if (shuttingDown) {
      log('Force exit');
      process.exit(1);
    }
    shuttingDown = true;
    log('Shutting down gracefully... (press Ctrl+C again to force)');
    saveProgress(progress);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
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

/**
 * Parse IRDAI date "DD-MM-YYYY" or "DD/MM/YYYY" to ISO "YYYY-MM-DD"
 */
function parseDateToIso(dateStr: string): string {
  const match = dateStr.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (!match) return '';
  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

/**
 * Extract UUID from IRDAI document URL
 * Format: /documents/{groupId}/{folderId}/{filename}/{uuid}
 */
function extractUuidFromUrl(url: string): string {
  const parts = url.split('/');
  // UUID is typically the last path segment before query params
  const lastSegment = parts[parts.length - 1]?.split('?')[0] || '';
  if (/^[0-9a-f-]{36}$/.test(lastSegment)) return lastSegment;
  // Try second-to-last
  const secondLast = parts[parts.length - 2]?.split('?')[0] || '';
  if (/^[0-9a-f-]{36}$/.test(secondLast)) return secondLast;
  return '';
}

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const cat of CATEGORIES) {
    fs.mkdirSync(path.join(PDFS_DIR, cat.slug), { recursive: true });
  }
}

// ─── Progress Tracking ───────────────────────────────────────────────────────

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    categories_completed: [],
    total_documents: 0,
    total_pdfs: 0,
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  const updated = { ...progress, last_updated: new Date().toISOString() };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(updated, null, 2));
}

const pdfsDoneSet: Set<string> = new Set();

function initPdfsDone(): void {
  if (fs.existsSync(PDF_DONE_FILE)) {
    const content = fs.readFileSync(PDF_DONE_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      if (line) pdfsDoneSet.add(line);
    }
  }
}

function markPdfDone(filename: string): void {
  if (!pdfsDoneSet.has(filename)) {
    pdfsDoneSet.add(filename);
    fs.appendFileSync(PDF_DONE_FILE, filename + '\n');
  }
}

// ─── JSONL Writer ────────────────────────────────────────────────────────────

let jsonlFd: number | null = null;

function openJsonlWriter(): void {
  jsonlFd = fs.openSync(JSONL_FILE, 'a');
}

function appendToJsonl(docs: IrdaiDocument[]): void {
  if (jsonlFd === null) return;
  const lines = docs.map((d) => JSON.stringify(d)).join('\n') + '\n';
  fs.writeSync(jsonlFd, lines);
}

function closeJsonlWriter(): void {
  if (jsonlFd !== null) {
    fs.closeSync(jsonlFd);
    jsonlFd = null;
  }
}

// ─── Metadata Scraping (Playwright) ─────────────────────────────────────────

/**
 * Extract document entries from the current page's document listing table/cards.
 * IRDAI uses Liferay's asset publisher which renders document cards.
 */
async function extractDocumentsFromPage(
  page: Page,
  category: CategoryConfig,
): Promise<IrdaiDocument[]> {
  return page.evaluate(
    (cat) => {
      const docs: {
        id: string;
        category: string;
        category_slug: string;
        title: string;
        date: string;
        date_iso: string;
        reference_no: string;
        file_size: string;
        file_url: string;
        pdf_filename: string;
        pdf_size_bytes: number;
        uuid: string;
        version: string;
        regulator: string;
        country: string;
        scraped_at: string;
      }[] = [];

      /**
       * IRDAI Liferay table structure (by class):
       *   Cell 0: checkbox (table-cell nosort first)
       *   Cell 1: archive status (table-col-archive-nonarchive) — "Non-Archived"/"Archived"
       *   Cell 2: short description (table-col-shortDesc) — bilingual title (Hindi / English)
       *   Cell 3: subtitle (table-col-subTitle) — has detail link with documentId
       *   Cell 4: date (table-col-lastUpdated) — DD-MM-YYYY
       *   Cell 5: documents (table-col-documents last) — PDF download link + file size
       *
       * Some sections may have additional columns (e.g., referenceNo / visibleText).
       */
      const tableRows = document.querySelectorAll('table tbody tr');

      tableRows.forEach((row, idx) => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) return;

        // Find cells by class names for reliable extraction
        const shortDescCell = row.querySelector('.table-col-shortDesc') as HTMLElement;
        const subTitleCell = row.querySelector('.table-col-subTitle') as HTMLElement;
        const dateCell = row.querySelector('.table-col-lastUpdated') as HTMLElement;
        const docsCell = row.querySelector('.table-col-documents') as HTMLElement;
        const refCell = row.querySelector(
          '.table-col-visibleText, .table-col-referenceNo',
        ) as HTMLElement;

        // Extract PDF download link from documents column
        const downloadLink = (docsCell || row).querySelector(
          'a[href*="/documents/"]',
        ) as HTMLAnchorElement;
        if (!downloadLink) return;

        const fileUrl = downloadLink.href;

        // Extract title: prefer shortDesc, then subTitle, then link text
        // Clean bilingual: take English part after " / " or " _ "
        const rawTitle =
          shortDescCell?.textContent?.trim() || subTitleCell?.textContent?.trim() || '';
        // Extract English part from "Hindi / English" or "Hindi _ English"
        const enMatch = rawTitle.match(/[\/\|_]\s*([A-Z][^]*?)$/);
        const title = enMatch ? enMatch[1].trim() : rawTitle;

        // Date
        const rawDate = dateCell?.textContent?.trim() || '';
        const dateMatch = rawDate.match(/(\d{1,2}-\d{1,2}-\d{4})/);
        const date = dateMatch ? dateMatch[1] : '';

        // Date ISO
        let dateIso = '';
        const dm = date.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
        if (dm) {
          dateIso = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
        }

        // Reference number
        const referenceNo = refCell?.textContent?.trim() || '';

        // File size from documents column text (e.g., "filename.pdf\n393 KB")
        const docsText = docsCell?.textContent?.trim() || '';
        const sizeMatch = docsText.match(/([\d.]+\s*(?:KB|MB|GB))/i);
        const fileSize = sizeMatch ? sizeMatch[1].trim() : '';

        // Extract UUID from URL path segments
        const urlPath = new URL(fileUrl).pathname;
        const pathParts = urlPath.split('/');
        let uuid = '';
        for (const part of pathParts) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(part)) {
            uuid = part;
            break;
          }
        }

        // Extract documentId from detail link
        const detailLink = subTitleCell?.querySelector(
          'a[href*="documentId"]',
        ) as HTMLAnchorElement;
        const docIdMatch = detailLink?.href?.match(/documentId=(\d+)/);
        const documentId = docIdMatch ? docIdMatch[1] : '';

        // Version from URL
        const versionMatch = fileUrl.match(/version=([\d.]+)/);
        const version = versionMatch ? versionMatch[1] : '';

        // Build clean filename from English title
        const slug = title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 80);
        const ext = fileUrl.match(/\.(pdf|xlsx?|zip|docx?)(\?|$)/i)?.[1]?.toLowerCase() || 'pdf';
        const pdfFilename = `irdai-${cat.category_slug}-${slug || documentId || uuid || idx}.${ext}`;

        docs.push({
          id: documentId || uuid || `${cat.category_slug}-${idx}`,
          category: cat.label,
          category_slug: cat.category_slug,
          title,
          date,
          date_iso: dateIso,
          reference_no: referenceNo,
          file_size: fileSize,
          file_url: fileUrl,
          pdf_filename: pdfFilename,
          pdf_size_bytes: 0,
          uuid,
          version,
          regulator: 'IRDAI',
          country: 'IN',
          scraped_at: new Date().toISOString(),
        });
      });

      // Fallback: if no table rows, find all download links
      if (docs.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/documents/"]');
        allLinks.forEach((link, idx) => {
          const anchor = link as HTMLAnchorElement;
          const fileUrl = anchor.href;
          if (!fileUrl || fileUrl.includes('javascript:')) return;

          const title = anchor.textContent?.trim() || anchor.title || '';
          if (!title || title.length < 3) return;

          // Dedup by href
          const urlPath = new URL(fileUrl).pathname;
          const pathParts = urlPath.split('/');
          let uuid = '';
          for (const part of pathParts) {
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(part)) {
              uuid = part;
              break;
            }
          }

          const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 80);
          const ext = fileUrl.match(/\.(pdf|xlsx?|zip|docx?)(\?|$)/i)?.[1]?.toLowerCase() || 'pdf';
          const pdfFilename = `irdai-${cat.category_slug}-${slug || uuid || idx}.${ext}`;

          docs.push({
            id: uuid || `${cat.category_slug}-${idx}`,
            category: cat.label,
            category_slug: cat.category_slug,
            title,
            date: '',
            date_iso: '',
            reference_no: '',
            file_size: '',
            file_url: fileUrl,
            pdf_filename: pdfFilename,
            pdf_size_bytes: 0,
            uuid,
            version: '',
            regulator: 'IRDAI',
            country: 'IN',
            scraped_at: new Date().toISOString(),
          });
        });
      }

      return docs;
    },
    { label: category.label, category_slug: category.slug },
  );
}

/**
 * Get total results count from page text like "Showing 1 - 60 of 585 results"
 */
async function getTotalResults(page: Page): Promise<number> {
  return page.evaluate(() => {
    const text = document.body.innerText;
    // "Showing X - Y of Z results" or "X to Y of Z"
    const match =
      text.match(/of\s+([\d,]+)\s+results/i) ||
      text.match(/of\s+([\d,]+)\s+entries/i) ||
      text.match(/(\d[\d,]*)\s+results/i);
    if (match) return parseInt(match[1].replace(/,/g, ''), 10);

    // Count total from pagination: "Page 1 of N"
    const pageMatch = text.match(/Page\s+\d+\s+of\s+(\d+)/i);
    if (pageMatch) return parseInt(pageMatch[1], 10) * 60; // approximate

    return 0;
  });
}

/**
 * Extract portlet ID and total pages from current listing page.
 * Liferay pagination uses URL params like:
 *   _com_irdai_document_media_IRDAIDocumentMediaPortlet_cur=N
 *   _com_irdai_document_media_IRDAIDocumentMediaPortlet_delta=20
 * And shows "Page X of Y" and "Showing A - B of C results"
 */
async function getPaginationInfo(
  page: Page,
): Promise<{ portletId: string; totalPages: number; totalResults: number }> {
  return page.evaluate(() => {
    // Extract portlet ID from pagination links
    let portletId = '';
    const pagLinks = document.querySelectorAll('.taglib-page-iterator a[href*="_cur="]');
    for (const link of pagLinks) {
      const href = (link as HTMLAnchorElement).href;
      const match = href.match(/p_p_id=([^&]+)/);
      if (match) {
        portletId = match[1];
        break;
      }
    }

    // Extract total pages from "Page X of Y"
    let totalPages = 1;
    const pageText = document.querySelector('.lfr-icon-menu-text')?.textContent || '';
    const pageMatch = pageText.match(/Page\s+\d+\s+of\s+(\d+)/);
    if (pageMatch) {
      totalPages = parseInt(pageMatch[1], 10);
    }

    // Extract total results from "Showing A - B of C results"
    let totalResults = 0;
    const resultEls = document.querySelectorAll(
      '.search-results, .taglib-search-iterator-page-iterator-top',
    );
    for (const el of resultEls) {
      const text = el.textContent || '';
      const resMatch = text.match(/of\s+([\d,]+)\s+results/i);
      if (resMatch) {
        totalResults = parseInt(resMatch[1].replace(/,/g, ''), 10);
        break;
      }
    }

    return { portletId, totalPages, totalResults };
  });
}

/**
 * Scrape all documents from a category using Playwright pagination
 */
async function scrapeCategoryMetadata(
  page: Page,
  category: CategoryConfig,
  testMode: boolean,
): Promise<IrdaiDocument[]> {
  const url = `${BASE_URL}${category.urlPath}`;
  log(`  Navigating to ${url}...`);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(2000);

  // Get pagination info from initial page
  const pagInfo = await getPaginationInfo(page);
  const totalPages = pagInfo.totalPages;
  const portletId = pagInfo.portletId;

  log(
    `  Total: ${pagInfo.totalResults} results, ${totalPages} pages (portlet: ${portletId ? 'found' : 'none'})`,
  );

  const allDocs: IrdaiDocument[] = [];
  const seenUrls = new Set<string>();

  // Extract page 1
  const page1Docs = await extractDocumentsFromPage(page, category);
  const newPage1 = page1Docs.filter((d) => {
    if (seenUrls.has(d.file_url)) return false;
    seenUrls.add(d.file_url);
    return true;
  });
  allDocs.push(...newPage1);
  log(`  Page 1/${totalPages}: ${newPage1.length} documents`);

  if (testMode || totalPages <= 1) {
    return allDocs;
  }

  // Paginate through remaining pages using URL-based navigation
  const delta = 20; // default items per page
  const prefix = `_${portletId.replace(/\./g, '_')}`;

  for (let pageNum = 2; pageNum <= totalPages; pageNum++) {
    if (shuttingDown) break;

    // Build pagination URL
    const pageUrl = `${BASE_URL}${category.urlPath}?p_p_id=${encodeURIComponent(portletId)}&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&${prefix}_delta=${delta}&${prefix}_resetCur=false&${prefix}_cur=${pageNum}`;

    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(1500);

      const pageDocs = await extractDocumentsFromPage(page, category);
      const newDocs = pageDocs.filter((d) => {
        if (seenUrls.has(d.file_url)) return false;
        seenUrls.add(d.file_url);
        return true;
      });

      allDocs.push(...newDocs);

      if (pageNum % 5 === 0 || pageNum === totalPages) {
        log(`  Page ${pageNum}/${totalPages}: ${newDocs.length} new (${allDocs.length} total)`);
      }

      if (newDocs.length === 0) break;

      await sleep(DELAY_MS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`  Page ${pageNum} failed: ${msg}`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  return allDocs;
}

// ─── PDF Download ────────────────────────────────────────────────────────────

async function downloadPdf(doc: IrdaiDocument, pdfPath: string): Promise<boolean> {
  if (!doc.file_url) return false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(doc.file_url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        validateStatus: (s) => s < 400,
      });

      const buffer = Buffer.from(resp.data);
      if (buffer.length < 100) {
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return false;
      }

      const tmpPath = `${pdfPath}.tmp`;
      fs.writeFileSync(tmpPath, buffer);
      fs.renameSync(tmpPath, pdfPath);
      return true;
    } catch (err: unknown) {
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');

  let categoryFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      categoryFilter = args[i + 1];
    }
  }

  const targetCategories = categoryFilter
    ? CATEGORIES.filter(
        (c) =>
          c.slug === categoryFilter ||
          c.label.toLowerCase().includes(categoryFilter!.toLowerCase()),
      )
    : CATEGORIES;

  if (targetCategories.length === 0) {
    logError(
      `No category matching "${categoryFilter}". Available: ${CATEGORIES.map((c) => c.slug).join(', ')}`,
    );
    process.exit(1);
  }

  ensureDirs();
  initPdfsDone();
  const progress = loadProgress();
  setupShutdownHandler(progress);

  log('\n╔══════════════════════════════════════════╗');
  log('║       IRDAI Document Scraper             ║');
  log('╚══════════════════════════════════════════╝');
  log(`  Categories: ${targetCategories.map((c) => c.label).join(', ')}`);
  log(
    `  Mode: ${testMode ? 'TEST' : metadataOnly ? 'METADATA ONLY' : downloadOnly ? 'DOWNLOAD ONLY' : 'FULL'}`,
  );
  log(`  PDF workers: ${PDF_WORKERS}`);
  log(`  Already downloaded: ${pdfsDoneSet.size} PDFs`);

  // ── Phase 1: Metadata Collection (Playwright) ──
  if (!downloadOnly) {
    log('\n── Phase 1: Metadata Collection (Playwright) ──');

    const browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    });

    try {
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
      });

      const page = await context.newPage();

      // Warm up session
      log('  Establishing session...');
      await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(2000);

      openJsonlWriter();
      let totalDocs = 0;

      for (const category of targetCategories) {
        if (shuttingDown) break;

        if (progress.categories_completed.includes(category.slug) && !testMode) {
          log(`  [SKIP] ${category.label} (already completed)`);
          continue;
        }

        log(`\n  ── ${category.label} ──`);

        try {
          const docs = await scrapeCategoryMetadata(page, category, testMode);
          log(`  → ${docs.length} documents from ${category.label}`);

          if (docs.length > 0) {
            // Save per-category metadata
            const metaPath = path.join(METADATA_DIR, `irdai_${category.slug}.json`);
            fs.writeFileSync(metaPath, JSON.stringify(docs, null, 2));

            appendToJsonl(docs);
            totalDocs += docs.length;
            progress.total_documents += docs.length;
          }

          if (!testMode) {
            progress.categories_completed = [...progress.categories_completed, category.slug];
          }
          saveProgress(progress);

          await sleep(DELAY_MS);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(`Failed ${category.label}: ${msg}`);
        }
      }

      closeJsonlWriter();
      log(`\n  Metadata complete: ${totalDocs} documents collected`);

      await page.close();
      await context.close();
    } finally {
      await browser.close();
    }
  }

  // ── Phase 2: PDF Download ──
  if (!metadataOnly && !testMode) {
    log('\n── Phase 2: PDF Download ──');

    const allDocs: IrdaiDocument[] = [];

    if (!fs.existsSync(JSONL_FILE)) {
      logError('No JSONL file found. Run metadata phase first.');
      return;
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(JSONL_FILE),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const doc = JSON.parse(line) as IrdaiDocument;
        if (categoryFilter && doc.category_slug !== categoryFilter) continue;
        if (!doc.file_url || !doc.pdf_filename) continue;

        const pdfPath = path.join(PDFS_DIR, doc.category_slug, doc.pdf_filename);
        if (pdfsDoneSet.has(doc.pdf_filename) || fs.existsSync(pdfPath)) continue;

        allDocs.push(doc);
      } catch {
        /* skip */
      }
    }

    log(`  Documents to download: ${allDocs.length} (${pdfsDoneSet.size} already done)`);

    if (allDocs.length === 0) {
      log('  Nothing to download.');
    } else {
      const queue = new PQueue({ concurrency: PDF_WORKERS });
      let downloaded = 0;
      let failed = 0;
      const startTime = Date.now();

      for (const doc of allDocs) {
        if (shuttingDown) break;

        queue.add(async () => {
          if (shuttingDown) return;

          const pdfPath = path.join(PDFS_DIR, doc.category_slug, doc.pdf_filename);
          await sleep(PDF_DELAY_MS);

          const success = await downloadPdf(doc, pdfPath);

          if (success) {
            downloaded++;
            markPdfDone(doc.pdf_filename);
            progress.total_pdfs++;

            if (downloaded % 50 === 0 || downloaded === 1) {
              const elapsed = (Date.now() - startTime) / 1000;
              const rate = downloaded / elapsed;
              const remaining = allDocs.length - downloaded - failed;
              const etaMin = rate > 0 ? Math.ceil(remaining / rate / 60) : 0;
              log(
                `  [${((downloaded / allDocs.length) * 100).toFixed(1)}%] ${downloaded}/${allDocs.length} downloaded, ${failed} failed, ${rate.toFixed(1)}/s, ETA: ${etaMin}m`,
              );
              saveProgress(progress);
            }
          } else {
            failed++;
            if (failed <= 10) {
              logError(`  Failed: ${doc.title?.slice(0, 60)} (${doc.file_url?.slice(0, 80)})`);
            }
          }
        });
      }

      await queue.onIdle();
      log(`\n  PDF download complete: ${downloaded} downloaded, ${failed} failed`);
      saveProgress(progress);
    }
  }

  // ── Summary ──
  log('\n╔══════════════════════════════════════════╗');
  log('║       Scraping Complete                  ║');
  log('╚══════════════════════════════════════════╝');
  log(`  Total documents: ${progress.total_documents}`);
  log(`  Total PDFs: ${progress.total_pdfs}`);
  log(`  Categories: ${progress.categories_completed.join(', ')}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
