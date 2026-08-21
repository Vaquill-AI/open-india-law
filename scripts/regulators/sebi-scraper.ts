/**
 * SEBI Scraper - Securities and Exchange Board of India
 * Scrapes circulars, orders, regulations, guidelines from https://www.sebi.gov.in
 *
 * Architecture:
 *   - Java Struts backend with AJAX endpoint returning HTML fragments
 *   - Session: JSESSIONID cookie required for AJAX calls (WAF blocks otherwise)
 *   - PDFs directly downloadable at /sebi_data/attachdocs/ (no auth)
 *   - No CAPTCHA, no rate limiting, no authentication for public docs
 *
 * Categories (by priority):
 *   1. Enforcement Orders  (sid=2, ssid=9)  - ~30,327 docs
 *   2. Circulars           (sid=1, ssid=7)  - ~2,756 docs
 *   3. Regulations         (sid=1, ssid=3)  - ~1,091 docs
 *   4. Informal Guidance   (sid=2, ssid=10) - ~465 docs
 *   5. Master Circulars    (sid=1, ssid=6)  - ~132 docs
 *   6. Archive Circulars   (sid=1, ssid=7, archive) - ~196 docs
 *   7. Press Releases      (sid=6, ssid=23) - ~5,828 docs
 *
 * Usage:
 *   npx tsx scripts/sebi-scraper.ts                              # Full run (all categories)
 *   npx tsx scripts/sebi-scraper.ts --test                       # Test mode (1 page per category, no PDFs)
 *   npx tsx scripts/sebi-scraper.ts --metadata-only              # Metadata only, skip PDF download
 *   npx tsx scripts/sebi-scraper.ts --download-only              # PDFs only (requires prior metadata run)
 *   npx tsx scripts/sebi-scraper.ts --category orders            # Single category
 *   npx tsx scripts/sebi-scraper.ts --category circulars --year 2024  # Category + year filter
 *   npx tsx scripts/sebi-scraper.ts --skip-details               # Skip detail page fetch (faster, less metadata)
 *
 * Environment:
 *   PDF_WORKERS=10         Concurrent PDF downloads (default: 10)
 *   DELAY_MS=1000          Delay between AJAX requests in ms (default: 1000)
 *   PDF_DELAY_MS=500       Delay between PDF downloads in ms (default: 500)
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.sebi.gov.in';
const AJAX_ENDPOINT = '/sebiweb/ajax/home/getnewslistinfo.jsp';
const ARCHIVE_AJAX_ENDPOINT = '/sebiweb/ajax/home/getArchiveCircularlistinfo.jsp';
const LISTING_PAGE = '/sebiweb/home/HomeAction.do';

const PDF_WORKERS = parseInt(process.env.PDF_WORKERS || '10', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '1000', 10);
const PDF_DELAY_MS = parseInt(process.env.PDF_DELAY_MS || '500', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const SESSION_REFRESH_INTERVAL = 100; // refresh session every N AJAX requests

const DATA_DIR = process.env.DATA_DIR || 'data/regulatory/sebi';
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const JSONL_FILE = path.join(DATA_DIR, 'sebi-all-documents.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'pdfs-downloaded.txt');

// ─── Category Registry ───────────────────────────────────────────────────────

type CategorySlug =
  | 'orders'
  | 'circulars'
  | 'regulations'
  | 'informal-guidance'
  | 'master-circulars'
  | 'archive-circulars'
  | 'press-releases'
  | 'guidelines'
  | 'gazette-notifications'
  | 'acts'
  | 'rules';

interface CategoryConfig {
  slug: CategorySlug;
  label: string;
  sid: number;
  ssid: number;
  sText: string;
  ssText: string;
  isArchive: boolean;
  priority: number;
}

const CATEGORIES: CategoryConfig[] = [
  {
    slug: 'orders',
    label: 'Enforcement Orders',
    sid: 2,
    ssid: 9,
    sText: 'Enforcement',
    ssText: 'Orders',
    isArchive: false,
    priority: 1,
  },
  {
    slug: 'circulars',
    label: 'Circulars',
    sid: 1,
    ssid: 7,
    sText: 'Legal',
    ssText: 'Circulars',
    isArchive: false,
    priority: 2,
  },
  {
    slug: 'regulations',
    label: 'Regulations',
    sid: 1,
    ssid: 3,
    sText: 'Legal',
    ssText: 'Regulations',
    isArchive: false,
    priority: 3,
  },
  {
    slug: 'informal-guidance',
    label: 'Informal Guidance',
    sid: 2,
    ssid: 10,
    sText: 'Enforcement',
    ssText: 'Informal Guidance',
    isArchive: false,
    priority: 4,
  },
  {
    slug: 'master-circulars',
    label: 'Master Circulars',
    sid: 1,
    ssid: 6,
    sText: 'Legal',
    ssText: 'Master Circulars',
    isArchive: false,
    priority: 5,
  },
  {
    slug: 'archive-circulars',
    label: 'Archive Circulars',
    sid: 1,
    ssid: 7,
    sText: 'Legal',
    ssText: 'Circulars',
    isArchive: true,
    priority: 6,
  },
  {
    slug: 'press-releases',
    label: 'Press Releases',
    sid: 6,
    ssid: 23,
    sText: 'Media',
    ssText: 'Press Releases',
    isArchive: false,
    priority: 7,
  },
  {
    slug: 'guidelines',
    label: 'Guidelines',
    sid: 1,
    ssid: 5,
    sText: 'Legal',
    ssText: 'Guidelines',
    isArchive: false,
    priority: 8,
  },
  {
    slug: 'gazette-notifications',
    label: 'Gazette Notifications',
    sid: 1,
    ssid: 82,
    sText: 'Legal',
    ssText: 'Gazette Notifications',
    isArchive: false,
    priority: 9,
  },
  {
    slug: 'acts',
    label: 'Acts',
    sid: 1,
    ssid: 1,
    sText: 'Legal',
    ssText: 'Acts',
    isArchive: false,
    priority: 10,
  },
  {
    slug: 'rules',
    label: 'Rules',
    sid: 1,
    ssid: 2,
    sText: 'Legal',
    ssText: 'Rules',
    isArchive: false,
    priority: 11,
  },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface SebiDocument {
  id: number;
  category: string;
  category_slug: CategorySlug;
  title: string;
  date: string; // "Mar 06, 2026" format from listing
  date_iso: string; // YYYY-MM-DD
  detail_url: string;
  reference_number: string;
  sub_category: string;
  pdf_url: string;
  pdf_filename: string;
  pdf_size_bytes: number;
  month_year: string; // "mar-2026" from URL
  section: string; // "legal", "enforcement"
  subsection: string; // "circulars", "orders"
  source_url: string;
  regulator: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  categories_completed: Record<string, number[]>; // {orders: [0,1,2,...], circulars: [0,1,...]}
  total_documents: number;
  total_pdfs: number;
  last_updated: string;
}

interface SessionInfo {
  jsessionid: string;
  cookies: string;
  requestCount: number;
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
    log(`Progress saved: ${progress.total_documents} docs, ${progress.total_pdfs} PDFs`);
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

function slugify(text: string, maxLen = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
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

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const cat of CATEGORIES) {
    fs.mkdirSync(path.join(PDFS_DIR, cat.slug), { recursive: true });
  }
}

/**
 * Parse SEBI date format "Mar 06, 2026" to ISO "2026-03-06"
 */
function parseDateToIso(dateStr: string): string {
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
  };

  const match = dateStr.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (!match) return '';

  const monthNum = months[match[1].toLowerCase().slice(0, 3)];
  if (!monthNum) return '';

  const day = match[2].padStart(2, '0');
  return `${match[3]}-${monthNum}-${day}`;
}

// ─── Progress Tracking ───────────────────────────────────────────────────────

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    categories_completed: {},
    total_documents: 0,
    total_pdfs: 0,
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
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

function appendToJsonl(docs: SebiDocument[]): void {
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

// ─── Session Management ──────────────────────────────────────────────────────

async function getSession(sid: number, ssid: number): Promise<SessionInfo> {
  const url = `${BASE_URL}${LISTING_PAGE}?doListing=yes&sid=${sid}&ssid=${ssid}&smid=0`;

  const resp = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    maxRedirects: 5,
    timeout: 30000,
    // We need the set-cookie header
    validateStatus: (s) => s < 400,
  });

  const setCookies: string[] = resp.headers['set-cookie'] || [];
  let jsessionid = '';
  const cookieParts: string[] = [];

  for (const cookie of setCookies) {
    const part = cookie.split(';')[0].trim();
    cookieParts.push(part);
    if (part.startsWith('JSESSIONID=')) {
      jsessionid = part;
    }
  }

  if (!jsessionid) {
    throw new Error('Failed to obtain JSESSIONID from session request');
  }

  return {
    jsessionid,
    cookies: cookieParts.join('; '),
    requestCount: 0,
  };
}

// ─── AJAX Listing Fetch ──────────────────────────────────────────────────────

interface ListingPage {
  html: string;
  totalPages: number;
  totalRecords: number;
}

async function fetchListingPage(
  session: SessionInfo,
  category: CategoryConfig,
  pageIndex: number,
  yearFilter?: number,
): Promise<ListingPage> {
  const endpoint = category.isArchive ? ARCHIVE_AJAX_ENDPOINT : AJAX_ENDPOINT;
  const url = `${BASE_URL}${endpoint}`;

  const params = new URLSearchParams({
    sid: String(category.sid),
    ssid: String(category.ssid),
    smid: '0',
    ssidhidden: String(category.ssid),
    intmid: '-1',
    doDirect: String(pageIndex),
    nextValue: String(pageIndex),
    next: 'n',
    search: '',
    fromDate: '',
    toDate: '',
    fromYear: yearFilter ? String(yearFilter) : '',
    toYear: yearFilter ? String(yearFilter) : '',
    deptId: '',
    sText: category.sText,
    ssText: category.ssText,
    smText: '',
  });

  const refererUrl = `${BASE_URL}${LISTING_PAGE}?doListing=yes&sid=${category.sid}&ssid=${category.ssid}&smid=0`;

  const resp = await axios.post(url, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookies,
      Referer: refererUrl,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 30000,
    validateStatus: (s) => s < 500,
  });

  if (resp.status !== 200) {
    throw new Error(`HTTP ${resp.status} from AJAX endpoint`);
  }

  const body = resp.data as string;

  // Check for WAF block
  if (body.includes('Unauthorized Activity Has Been Detected')) {
    throw new Error('WAF_BLOCKED: Session expired or invalid');
  }

  // Split response on #@# delimiter
  const parts = body.split('#@#');
  const html = parts[0] || '';

  // Extract total pages from hidden field
  // Formats: value=111 (no quotes), value='111', value="111"
  const totalPagesMatch =
    html.match(/name=['"]?totalpage['"]?[^>]*value=['"]?(\d+)['"]?/) ||
    html.match(/value=['"]?(\d+)['"]?[^>]*name=['"]?totalpage['"]?/);
  const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1], 10) : 1;

  // Extract total records from text like "1 to 25 of 2756 records" or "Total Records : 2,756"
  const totalRecordsMatch =
    html.match(/of\s+([\d,]+)\s+records/i) || html.match(/Total\s+Records?\s*:\s*([\d,]+)/i);
  const totalRecords = totalRecordsMatch ? parseInt(totalRecordsMatch[1].replace(/,/g, ''), 10) : 0;

  session.requestCount++;

  return { html, totalPages, totalRecords };
}

// ─── HTML Parser for Listing ─────────────────────────────────────────────────

function parseListingHtml(html: string, category: CategoryConfig): SebiDocument[] {
  const docs: SebiDocument[] = [];

  // Match table rows with links
  // Each document appears as a table row with date in first <td> and link in second <td>
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    // Skip header rows
    if (rowHtml.includes('<th')) continue;

    // Extract cells
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1].trim());
    }

    if (cells.length < 2) continue;

    // Date is typically in the first cell
    const dateStr = stripHtml(cells[0]).trim();

    // Link and title in second cell (or sometimes in a different cell)
    let linkHtml = cells[1];
    // Some categories have 3 columns, link might be in position 1 or 2
    if (cells.length >= 3 && !linkHtml.includes('<a')) {
      linkHtml = cells[2];
    }

    // Extract href and title from <a> tag
    const hrefMatch = linkHtml.match(/<a[^>]*href=["']([^"']+)["'][^>]*>/);
    if (!hrefMatch) continue;

    let detailUrl = hrefMatch[1].trim();
    if (detailUrl.startsWith('/')) {
      detailUrl = `${BASE_URL}${detailUrl}`;
    } else if (!detailUrl.startsWith('http')) {
      detailUrl = `${BASE_URL}/${detailUrl}`;
    }

    // Extract title from <a> tag content or title attribute
    const titleAttrMatch = linkHtml.match(/<a[^>]*title=["']([^"']+)["']/);
    const titleContentMatch = linkHtml.match(/<a[^>]*>([\s\S]*?)<\/a>/);
    const title = titleAttrMatch
      ? stripHtml(titleAttrMatch[1])
      : titleContentMatch
        ? stripHtml(titleContentMatch[1])
        : '';

    if (!title) continue;

    // Parse numeric ID from URL: _{id}.html
    const idMatch = detailUrl.match(/_(\d+)\.html/);
    const id = idMatch ? parseInt(idMatch[1], 10) : 0;

    // Parse URL path segments
    const urlPath = detailUrl.replace(BASE_URL, '');
    const pathParts = urlPath.split('/').filter(Boolean);
    // e.g., /legal/circulars/mar-2026/title-slug_100249.html
    const section = pathParts[0] || '';
    const subsection = pathParts[1] || '';
    const monthYear = pathParts[2] || '';

    const dateIso = parseDateToIso(dateStr);

    // Generate PDF filename
    const titleSlug = slugify(title, 50);
    const pdfFilename = `sebi_${category.slug}_${id}_${titleSlug}.pdf`;

    docs.push({
      id,
      category: category.label,
      category_slug: category.slug,
      title,
      date: dateStr,
      date_iso: dateIso,
      detail_url: detailUrl,
      reference_number: '', // filled from detail page
      sub_category: '', // filled from detail page
      pdf_url: '', // filled from detail page
      pdf_filename: pdfFilename,
      pdf_size_bytes: 0,
      month_year: monthYear,
      section,
      subsection,
      source_url: `${BASE_URL}${LISTING_PAGE}?doListing=yes&sid=${category.sid}&ssid=${category.ssid}&smid=0`,
      regulator: 'SEBI',
      country: 'IN',
      scraped_at: new Date().toISOString(),
    });
  }

  return docs;
}

// ─── Detail Page Fetch ───────────────────────────────────────────────────────

async function fetchDetailPage(
  doc: SebiDocument,
  retries = MAX_RETRIES,
): Promise<{ referenceNumber: string; subCategory: string; pdfUrl: string }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await axios.get(doc.detail_url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
        timeout: 30000,
        validateStatus: (s) => s < 500,
      });

      if (resp.status !== 200) {
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        return { referenceNumber: '', subCategory: '', pdfUrl: '' };
      }

      const html = resp.data as string;

      // Extract reference number from .id_area span
      // Pattern: <span>Circular No.:</span> <span>HO/24/12/...</span>
      // or: <span>Orders :</span> <span>Orders of AO</span>
      let referenceNumber = '';
      let subCategory = '';

      const idAreaMatch = html.match(/class=["']id_area["'][^>]*>([\s\S]*?)<\/div>/i);
      if (idAreaMatch) {
        const spans: string[] = [];
        const spanRegex = /<span[^>]*>([\s\S]*?)<\/span>/gi;
        let spanMatch: RegExpExecArray | null;
        while ((spanMatch = spanRegex.exec(idAreaMatch[1])) !== null) {
          spans.push(stripHtml(spanMatch[1]));
        }

        if (spans.length >= 2) {
          // First span is usually the label (e.g., "Circular No.:", "Orders :")
          // Second span is the value
          const label = spans[0];
          if (label.toLowerCase().includes('order')) {
            subCategory = spans[1] || '';
            referenceNumber = spans.length >= 3 ? spans[2] : '';
          } else {
            referenceNumber = spans[1] || '';
            subCategory = spans.length >= 3 ? spans[2] : '';
          }
        }
      }

      // Extract PDF URL from iframe src
      let pdfUrl = '';
      const iframeMatch =
        html.match(/<iframe[^>]*src=["']([^"']*sebi_data[^"']*)["']/i) ||
        html.match(/<iframe[^>]*src=["'][^"']*file=([^"'&]+)["'&]/i);

      if (iframeMatch) {
        const iframeSrc = iframeMatch[1];
        // The iframe src might be: /web/?file=/sebi_data/attachdocs/...
        // We want the actual PDF URL
        const fileParamMatch = iframeSrc.match(/[?&]file=([^&"']+)/);
        if (fileParamMatch) {
          pdfUrl = decodeURIComponent(fileParamMatch[1]);
        } else {
          pdfUrl = iframeSrc;
        }

        if (pdfUrl.startsWith('/')) {
          pdfUrl = `${BASE_URL}${pdfUrl}`;
        }
      }

      // Also try to find direct PDF links in the page
      if (!pdfUrl) {
        const pdfLinkMatch =
          html.match(/href=["']([^"']*sebi_data\/attachdocs[^"']*\.pdf)["']/i) ||
          html.match(/href=["']([^"']*\.pdf)["'][^>]*>/i);
        if (pdfLinkMatch) {
          pdfUrl = pdfLinkMatch[1];
          if (pdfUrl.startsWith('/')) {
            pdfUrl = `${BASE_URL}${pdfUrl}`;
          }
        }
      }

      return { referenceNumber, subCategory, pdfUrl };
    } catch (err) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  return { referenceNumber: '', subCategory: '', pdfUrl: '' };
}

// ─── Phase 1: Scrape Metadata ────────────────────────────────────────────────

async function scrapeCategory(
  category: CategoryConfig,
  progress: Progress,
  opts: { testMode?: boolean; yearFilter?: number; skipDetails?: boolean },
): Promise<SebiDocument[]> {
  const allDocs: SebiDocument[] = [];
  const completedPages = progress.categories_completed[category.slug] || [];
  const completedSet = new Set(completedPages);

  log(`\n--- ${category.label} (sid=${category.sid}, ssid=${category.ssid}) ---`);

  // Get session for this category
  let session = await getSession(category.sid, category.ssid);
  log(`  Session acquired: ${session.jsessionid.slice(0, 20)}...`);

  // Fetch first page to get total pages
  await sleep(DELAY_MS);
  const firstPage = await fetchListingPage(session, category, 0, opts.yearFilter);
  log(`  Total records: ${firstPage.totalRecords}, Total pages: ${firstPage.totalPages}`);

  const totalPages = opts.testMode ? Math.min(1, firstPage.totalPages) : firstPage.totalPages;

  // Process first page
  const firstPageDocs = parseListingHtml(firstPage.html, category);
  if (!completedSet.has(0)) {
    allDocs.push(...firstPageDocs);
    completedPages.push(0);
    completedSet.add(0);
  }

  log(`  Page 0: ${firstPageDocs.length} documents`);

  // Process remaining pages
  for (let pageIdx = 1; pageIdx < totalPages; pageIdx++) {
    if (shuttingDown) break;

    if (completedSet.has(pageIdx)) {
      // Load from cached metadata file
      const metaFile = path.join(METADATA_DIR, `sebi_${category.slug}_page_${pageIdx}.json`);
      if (fs.existsSync(metaFile)) {
        const cached: SebiDocument[] = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        allDocs.push(...cached);
      }
      continue;
    }

    // Refresh session periodically
    if (session.requestCount >= SESSION_REFRESH_INTERVAL) {
      log(`  [SESSION] Refreshing (${session.requestCount} requests)...`);
      session = await getSession(category.sid, category.ssid);
      await sleep(DELAY_MS);
    }

    try {
      await sleep(DELAY_MS);
      const page = await fetchListingPage(session, category, pageIdx, opts.yearFilter);
      const pageDocs = parseListingHtml(page.html, category);
      allDocs.push(...pageDocs);

      // Save per-page metadata
      const metaFile = path.join(METADATA_DIR, `sebi_${category.slug}_page_${pageIdx}.json`);
      fs.writeFileSync(metaFile, JSON.stringify(pageDocs, null, 2));

      // Update progress
      completedPages.push(pageIdx);
      completedSet.add(pageIdx);
      progress.categories_completed[category.slug] = completedPages;
      if (pageIdx % 10 === 0) saveProgress(progress);

      const pct = (((pageIdx + 1) / totalPages) * 100).toFixed(1);
      log(
        `  [${pct}%] Page ${pageIdx}/${totalPages}: ${pageDocs.length} docs (total: ${allDocs.length})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`  Page ${pageIdx}: ${msg}`);

      // If WAF blocked, refresh session and retry
      if (msg.includes('WAF_BLOCKED')) {
        try {
          session = await getSession(category.sid, category.ssid);
          await sleep(RETRY_DELAY_MS);
          pageIdx--; // retry this page
        } catch {
          logError('  Cannot refresh session');
        }
      }
    }
  }

  // Save first page metadata too
  const metaFile0 = path.join(METADATA_DIR, `sebi_${category.slug}_page_0.json`);
  if (!fs.existsSync(metaFile0)) {
    fs.writeFileSync(metaFile0, JSON.stringify(firstPageDocs, null, 2));
  }

  // Phase 1b: Fetch detail pages concurrently for reference numbers and PDF URLs
  if (!opts.skipDetails && allDocs.length > 0) {
    const DETAIL_WORKERS = parseInt(process.env.DETAIL_WORKERS || '8', 10);
    const docsNeedingDetail = allDocs.filter((d) => !d.pdf_url || !d.reference_number);
    const alreadyHaveDetail = allDocs.length - docsNeedingDetail.length;

    log(
      `  Fetching detail pages: ${docsNeedingDetail.length} to fetch, ${alreadyHaveDetail} already cached (${DETAIL_WORKERS} workers)`,
    );

    let detailCount = 0;
    let detailFailed = 0;
    const detailStartTime = Date.now();
    const detailQueue = new PQueue({ concurrency: DETAIL_WORKERS });

    for (const doc of docsNeedingDetail) {
      if (shuttingDown) break;

      detailQueue.add(async () => {
        if (shuttingDown) return;
        try {
          await sleep(150); // small delay per worker to avoid WAF
          const detail = await fetchDetailPage(doc);

          doc.reference_number = detail.referenceNumber;
          doc.sub_category = detail.subCategory;
          doc.pdf_url = detail.pdfUrl;

          detailCount++;
          if (detailCount % 100 === 0) {
            const pct = ((detailCount / docsNeedingDetail.length) * 100).toFixed(1);
            const elapsed = (Date.now() - detailStartTime) / 1000;
            const rate = detailCount / elapsed;
            const remaining = docsNeedingDetail.length - detailCount - detailFailed;
            const etaSec = rate > 0 ? remaining / rate : 0;
            log(
              `  [Details ${pct}%] ${detailCount}/${docsNeedingDetail.length} (${detailFailed} failed, ${rate.toFixed(0)}/s, ETA: ${Math.ceil(etaSec)}s)`,
            );
          }
        } catch {
          detailFailed++;
        }
      });
    }

    await detailQueue.onIdle();
    const totalElapsed = ((Date.now() - detailStartTime) / 1000).toFixed(1);
    log(`  Detail pages: ${detailCount} fetched, ${detailFailed} failed in ${totalElapsed}s`);
  }

  // Write to JSONL
  const docsWithContent = allDocs.filter((d) => d.title);
  appendToJsonl(docsWithContent);
  progress.total_documents += docsWithContent.length;
  progress.categories_completed[category.slug] = completedPages;
  saveProgress(progress);

  // Save category summary
  const summaryFile = path.join(METADATA_DIR, `sebi_${category.slug}_summary.json`);
  fs.writeFileSync(
    summaryFile,
    JSON.stringify(
      {
        category: category.slug,
        label: category.label,
        total_documents: docsWithContent.length,
        with_pdf_url: docsWithContent.filter((d) => d.pdf_url).length,
        with_reference: docsWithContent.filter((d) => d.reference_number).length,
        scraped_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  log(
    `  ${category.label} complete: ${docsWithContent.length} documents (${docsWithContent.filter((d) => d.pdf_url).length} with PDF URLs)`,
  );

  return docsWithContent;
}

async function scrapeMetadata(
  categories: CategoryConfig[],
  progress: Progress,
  opts: { testMode?: boolean; yearFilter?: number; skipDetails?: boolean },
): Promise<void> {
  log(`\n=== Phase 1: Scraping Metadata (${categories.length} categories) ===`);

  for (const category of categories) {
    if (shuttingDown) break;
    await scrapeCategory(category, progress, opts);
  }
}

// ─── Phase 2: Download PDFs ──────────────────────────────────────────────────

async function* streamJsonlDocs(): AsyncGenerator<SebiDocument> {
  if (!fs.existsSync(JSONL_FILE)) return;

  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as SebiDocument;
    } catch {
      // skip malformed lines
    }
  }
}

async function downloadPdfs(
  progress: Progress,
  testMode: boolean,
  categoryFilter?: CategorySlug,
): Promise<void> {
  if (!fs.existsSync(JSONL_FILE)) {
    logError('No metadata JSONL found. Run metadata scrape first.');
    return;
  }

  log(`\n=== Phase 2: PDF Downloads ===`);
  log(`  Scanning JSONL for download candidates...`);

  let totalWithPdf = 0;
  let toDownloadCount = 0;
  let alreadyDone = 0;

  for await (const doc of streamJsonlDocs()) {
    if (!doc.pdf_url) continue;
    if (categoryFilter && doc.category_slug !== categoryFilter) continue;
    totalWithPdf++;

    if (pdfsDoneSet.has(doc.pdf_filename)) {
      alreadyDone++;
      continue;
    }
    if (fs.existsSync(path.join(PDFS_DIR, doc.category_slug, doc.pdf_filename))) {
      markPdfDone(doc.pdf_filename);
      alreadyDone++;
      continue;
    }
    toDownloadCount++;
  }

  log(`  Total with PDF URLs: ${totalWithPdf}`);
  log(`  Already downloaded: ${alreadyDone}`);
  log(`  To download: ${toDownloadCount}`);
  log(`  Workers: ${PDF_WORKERS}`);

  if (toDownloadCount === 0) {
    log('  Nothing to download.');
    return;
  }

  const pdfQueue = new PQueue({ concurrency: PDF_WORKERS });
  let downloaded = 0;
  let failed = 0;
  let queued = 0;
  const downloadStartTime = Date.now();

  for await (const doc of streamJsonlDocs()) {
    if (shuttingDown) break;
    if (!doc.pdf_url) continue;
    if (categoryFilter && doc.category_slug !== categoryFilter) continue;
    if (pdfsDoneSet.has(doc.pdf_filename)) continue;
    if (fs.existsSync(path.join(PDFS_DIR, doc.category_slug, doc.pdf_filename))) {
      markPdfDone(doc.pdf_filename);
      continue;
    }

    if (testMode && queued >= 5) break;

    queued++;
    const pdfUrl = doc.pdf_url;
    const pdfFilename = doc.pdf_filename;
    const catSlug = doc.category_slug;

    pdfQueue.add(async () => {
      if (shuttingDown) return;
      const dest = path.join(PDFS_DIR, catSlug, pdfFilename);

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          await sleep(PDF_DELAY_MS);

          const resp = await axios.get(pdfUrl, {
            responseType: 'arraybuffer',
            timeout: 60000,
            maxRedirects: 5,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
          });

          if (resp.status === 200 && resp.data.length > 100) {
            const header = Buffer.from(resp.data).toString('utf-8', 0, 5);
            if (header.startsWith('%PDF')) {
              // Atomic write
              const tmpDest = `${dest}.tmp`;
              fs.writeFileSync(tmpDest, resp.data);
              fs.renameSync(tmpDest, dest);

              downloaded++;
              markPdfDone(pdfFilename);
              progress.total_pdfs++;

              if (downloaded % 50 === 0) {
                saveProgress(progress);
                const pct = ((downloaded / toDownloadCount) * 100).toFixed(2);
                const elapsed = (Date.now() - downloadStartTime) / 1000;
                const rate = downloaded / elapsed;
                const remaining = toDownloadCount - downloaded - failed;
                const etaSec = rate > 0 ? remaining / rate : 0;
                const etaMin = Math.ceil(etaSec / 60);
                log(
                  `  PDF [${pct}%] ${downloaded}/${toDownloadCount} downloaded, ${failed} failed, ${rate.toFixed(1)}/s, ETA: ${etaMin}m`,
                );
              }
              return;
            }
          }

          if (attempt < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS * (attempt + 1));
        } catch (err) {
          if (attempt < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS * (attempt + 1));
        }
      }

      failed++;
      fs.appendFileSync(path.join(DATA_DIR, 'pdfs-failed.txt'), `${pdfFilename}\t${pdfUrl}\n`);
    });

    // Backpressure
    if (pdfQueue.size > 500) {
      await pdfQueue.onSizeLessThan(250);
    }
  }

  await pdfQueue.onIdle();
  saveProgress(progress);

  log(`\n  PDF download complete: ${downloaded} downloaded, ${failed} failed`);
}

// ─── CLI & Main ──────────────────────────────────────────────────────────────

function parseArgs(): {
  testMode: boolean;
  metadataOnly: boolean;
  downloadOnly: boolean;
  skipDetails: boolean;
  categoryFilter?: CategorySlug;
  yearFilter?: number;
} {
  const args = process.argv.slice(2);

  const testMode = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');
  const skipDetails = args.includes('--skip-details');

  let categoryFilter: CategorySlug | undefined;
  let yearFilter: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      const val = args[i + 1] as CategorySlug;
      const found = CATEGORIES.find((c) => c.slug === val);
      if (!found) {
        console.error(`Unknown category: ${val}`);
        console.error(`Valid: ${CATEGORIES.map((c) => c.slug).join(', ')}`);
        process.exit(1);
      }
      categoryFilter = val;
    }
    if (args[i] === '--year' && args[i + 1]) {
      yearFilter = parseInt(args[i + 1], 10);
      if (isNaN(yearFilter) || yearFilter < 1990 || yearFilter > 2030) {
        console.error(`Invalid year: ${args[i + 1]}`);
        process.exit(1);
      }
    }
  }

  return { testMode, metadataOnly, downloadOnly, skipDetails, categoryFilter, yearFilter };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  ensureDirs();

  const progress = loadProgress();
  initPdfsDone();
  setupShutdownHandler(progress);
  openJsonlWriter();

  const categories = opts.categoryFilter
    ? CATEGORIES.filter((c) => c.slug === opts.categoryFilter)
    : CATEGORIES.sort((a, b) => a.priority - b.priority);

  const mode = opts.metadataOnly ? 'metadata-only' : opts.downloadOnly ? 'download-only' : 'full';

  console.log(`\nSEBI Scraper - Securities and Exchange Board of India`);
  console.log(`  URL: ${BASE_URL}`);
  console.log(`  Mode: ${mode}${opts.testMode ? ' (TEST)' : ''}`);
  console.log(`  Categories: ${categories.map((c) => c.slug).join(', ')}`);
  if (opts.yearFilter) console.log(`  Year filter: ${opts.yearFilter}`);
  if (opts.skipDetails) console.log(`  Skipping detail pages (faster, less metadata)`);
  console.log(`  PDF Workers: ${PDF_WORKERS}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Progress: ${progress.total_documents} docs, ${progress.total_pdfs} PDFs\n`);

  if (!opts.downloadOnly) {
    await scrapeMetadata(categories, progress, {
      testMode: opts.testMode,
      yearFilter: opts.yearFilter,
      skipDetails: opts.skipDetails,
    });
  }

  closeJsonlWriter();

  if (!opts.metadataOnly && !shuttingDown) {
    await downloadPdfs(progress, opts.testMode, opts.categoryFilter);
  }

  saveProgress(progress);
  console.log(`\n=== Scraping Complete ===`);
  console.log(`  Total documents: ${progress.total_documents}`);
  console.log(`  Total PDFs: ${progress.total_pdfs}`);
  console.log(`  Categories scraped: ${Object.keys(progress.categories_completed).join(', ')}`);
}

main().catch((err) => {
  closeJsonlWriter();
  console.error('Fatal error:', err);
  process.exit(1);
});
