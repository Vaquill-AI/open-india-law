/**
 * DGFT Scraper - Directorate General of Foreign Trade
 * Scrapes notifications, public notices, circulars, trade notices from https://dgft.gov.in
 *
 * Architecture:
 *   - Java-based portal (JSP/Servlet) with DataTables
 *   - Session: JSESSIONID + CSRF token required for search API
 *   - PDFs on S3 at content.dgft.gov.in (no auth needed)
 *   - No CAPTCHA, no rate limiting for public documents
 *
 * Categories:
 *   1. Notifications  (catId=1)  ~1,580 docs
 *   2. Public Notices  (catId=2)  ~2,037 docs
 *   3. Circulars       (catId=3)  ~697 docs
 *   4. Trade Notices   (catId=4)  ~450 docs
 *
 * Usage:
 *   npx tsx scripts/dgft-scraper.ts                              # Full run
 *   npx tsx scripts/dgft-scraper.ts --test                       # Test mode (5 docs per category, no PDFs)
 *   npx tsx scripts/dgft-scraper.ts --metadata-only              # Metadata only, skip PDF download
 *   npx tsx scripts/dgft-scraper.ts --download-only              # PDFs only (requires prior metadata run)
 *   npx tsx scripts/dgft-scraper.ts --category notifications     # Single category
 *
 * Environment:
 *   PDF_WORKERS=10         Concurrent PDF downloads (default: 10)
 *   DELAY_MS=200           Delay between requests in ms (default: 200)
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.dgft.gov.in';
const SEARCH_ENDPOINT = '/CP/webHP';
const SESSION_PAGE = '/CP/?opt=notification';

const PDF_WORKERS = parseInt(process.env.PDF_WORKERS || '10', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '200', 10);
const PDF_DELAY_MS = parseInt(process.env.PDF_DELAY_MS || '100', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // refresh every 30 min (timeout is 45 min)

const DATA_DIR = process.env.DATA_DIR || 'data/regulatory/dgft';
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const JSONL_FILE = path.join(DATA_DIR, 'dgft-all-documents.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'pdfs-downloaded.txt');

// ─── Category Registry ───────────────────────────────────────────────────────

type CategorySlug = 'notifications' | 'public-notices' | 'circulars' | 'trade-notices';

interface CategoryConfig {
  slug: CategorySlug;
  label: string;
  catId: number;
  opt: string;
  priority: number;
}

const CATEGORIES: CategoryConfig[] = [
  { slug: 'notifications', label: 'Notifications', catId: 1, opt: 'notification', priority: 1 },
  { slug: 'public-notices', label: 'Public Notices', catId: 2, opt: 'public-notice', priority: 2 },
  { slug: 'circulars', label: 'Circulars', catId: 3, opt: 'circular', priority: 3 },
  { slug: 'trade-notices', label: 'Trade Notices', catId: 4, opt: 'trade-notice', priority: 4 },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface DgftDocument {
  id: string; // UUID from PDF URL or serial
  category: string;
  category_slug: CategorySlug;
  document_number: string;
  fiscal_year: string;
  description: string;
  date: string; // DD/MM/YYYY
  date_iso: string; // YYYY-MM-DD
  pdf_url: string;
  pdf_filename: string;
  pdf_size_bytes: number;
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

interface SessionInfo {
  jsessionid: string;
  cookies: string;
  csrf: string;
  createdAt: number;
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

function slugify(text: string, maxLen = 80): string {
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

/**
 * Parse DGFT date format "DD/MM/YYYY" to ISO "YYYY-MM-DD"
 */
function parseDateToIso(dateStr: string): string {
  const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return '';
  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

/**
 * Extract UUID from DGFT PDF URL
 * Format: https://content.dgft.gov.in/Website/dgftprod/{uuid}/{filename}.pdf
 */
function extractUuidFromUrl(url: string): string {
  const match = url.match(/dgftprod\/([^/]+)\//);
  return match ? match[1] : '';
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
  const updated = {
    ...progress,
    last_updated: new Date().toISOString(),
  };
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

function appendToJsonl(docs: DgftDocument[]): void {
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

async function createSession(): Promise<SessionInfo> {
  const url = `${BASE_URL}${SESSION_PAGE}`;

  const resp = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    maxRedirects: 5,
    timeout: 30000,
    validateStatus: (s) => s < 400,
  });

  // Extract cookies
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
    throw new Error('Failed to obtain JSESSIONID');
  }

  // Extract CSRF token from HTML
  const html = resp.data as string;
  const csrfMatch =
    html.match(/_csrf"\s+content="([^"]+)"/) ||
    html.match(/name="_csrf"\s+value="([^"]+)"/) ||
    html.match(/meta\s+property="_csrf"\s+content="([^"]+)"/);

  if (!csrfMatch) {
    throw new Error('Failed to extract CSRF token from page');
  }

  log(`  Session created: ${jsessionid.slice(0, 30)}... CSRF: ${csrfMatch[1].slice(0, 20)}...`);

  return {
    jsessionid,
    cookies: cookieParts.join('; '),
    csrf: csrfMatch[1],
    createdAt: Date.now(),
  };
}

function isSessionExpired(session: SessionInfo): boolean {
  return Date.now() - session.createdAt > SESSION_MAX_AGE_MS;
}

// ─── Metadata Scraping ──────────────────────────────────────────────────────

async function fetchCategoryMetadata(
  session: SessionInfo,
  category: CategoryConfig,
): Promise<DgftDocument[]> {
  const url = `${BASE_URL}${SEARCH_ENDPOINT}?requestType=ApplicationRH&actionVal=getNewsDtlsBySearch&isPrivate=true&screenId=90000734`;

  const params = new URLSearchParams({
    _csrf: session.csrf,
    assetCat: String(category.catId),
    title: '',
    year: '',
  });

  const resp = await axios.post(url, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: session.cookies,
      Referer: `${BASE_URL}/CP/?opt=${category.opt}`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 60000, // large response
    validateStatus: (s) => s < 500,
  });

  if (resp.status !== 200) {
    throw new Error(`HTTP ${resp.status} from search API for ${category.slug}`);
  }

  const html = resp.data as string;

  if (html.length < 100) {
    throw new Error(`Empty response for ${category.slug} (${html.length} bytes)`);
  }

  // Parse the HTML table
  const $ = cheerio.load(html);
  const docs: DgftDocument[] = [];

  // The search API returns an HTML fragment with a table
  // Columns: S.No | Document Number | Year | Description | Date | PDF link
  $('table tbody tr, table tr').each((_i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 5) return;

    const docNumber = stripHtml($(cells[1]).html() || '').trim();
    const fiscalYear = stripHtml($(cells[2]).html() || '').trim();
    const description = stripHtml($(cells[3]).html() || '').trim();
    const date = stripHtml($(cells[4]).html() || '').trim();

    // Extract PDF URL from anchor tag in last column or any column
    let pdfUrl = '';
    $(row)
      .find('a[href*="content.dgft.gov.in"], a[href$=".pdf"]')
      .each((_j, link) => {
        const href = $(link).attr('href') || '';
        if (href.includes('.pdf') || href.includes('content.dgft.gov.in')) {
          pdfUrl = href.startsWith('http') ? href : `https:${href}`;
        }
      });

    // Also check onclick handlers for PDF links
    if (!pdfUrl) {
      $(row)
        .find('a[onclick], img[onclick]')
        .each((_j, el) => {
          const onclick = $(el).attr('onclick') || '';
          const urlMatch =
            onclick.match(/['"]([^'"]*content\.dgft\.gov\.in[^'"]*\.pdf)['"]/) ||
            onclick.match(/['"]([^'"]*\.pdf)['"]/);
          if (urlMatch) {
            pdfUrl = urlMatch[1].startsWith('http') ? urlMatch[1] : `https:${urlMatch[1]}`;
          }
        });
    }

    if (!docNumber && !description) return;

    const uuid = extractUuidFromUrl(pdfUrl);
    const dateIso = parseDateToIso(date);

    // Generate filename
    const pdfFilename = pdfUrl
      ? `dgft-${category.slug}-${slugify(docNumber || uuid || String(_i))}.pdf`
      : '';

    docs.push({
      id: uuid || `${category.catId}-${_i}`,
      category: category.label,
      category_slug: category.slug,
      document_number: docNumber,
      fiscal_year: fiscalYear,
      description,
      date,
      date_iso: dateIso,
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      pdf_size_bytes: 0,
      regulator: 'DGFT',
      country: 'IN',
      scraped_at: new Date().toISOString(),
    });
  });

  return docs;
}

// ─── PDF Download ────────────────────────────────────────────────────────────

async function downloadPdf(doc: DgftDocument, pdfPath: string): Promise<boolean> {
  if (!doc.pdf_url) return false;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(doc.pdf_url, {
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

      // Atomic write
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
  log('║       DGFT Document Scraper              ║');
  log('╚══════════════════════════════════════════╝');
  log(`  Categories: ${targetCategories.map((c) => c.label).join(', ')}`);
  log(
    `  Mode: ${testMode ? 'TEST' : metadataOnly ? 'METADATA ONLY' : downloadOnly ? 'DOWNLOAD ONLY' : 'FULL'}`,
  );
  log(`  PDF workers: ${PDF_WORKERS}`);
  log(`  Already downloaded: ${pdfsDoneSet.size} PDFs`);

  // ── Phase 1: Metadata Collection ──
  if (!downloadOnly) {
    log('\n── Phase 1: Metadata Collection ──');

    let session = await createSession();
    openJsonlWriter();

    let totalDocs = 0;

    for (const category of targetCategories) {
      if (shuttingDown) break;

      if (progress.categories_completed.includes(category.slug) && !testMode) {
        log(`  [SKIP] ${category.label} (already completed)`);
        continue;
      }

      log(`\n  Fetching ${category.label} (catId=${category.catId})...`);

      // Refresh session if needed
      if (isSessionExpired(session)) {
        log('  Refreshing session...');
        session = await createSession();
      }

      try {
        let docs = await fetchCategoryMetadata(session, category);

        if (testMode) {
          docs = docs.slice(0, 5);
        }

        log(`  → Parsed ${docs.length} documents from ${category.label}`);

        // Save per-category metadata JSON
        const metaPath = path.join(METADATA_DIR, `dgft_${category.slug}.json`);
        fs.writeFileSync(metaPath, JSON.stringify(docs, null, 2));

        // Append to JSONL
        appendToJsonl(docs);

        totalDocs += docs.length;
        progress.total_documents += docs.length;

        if (!testMode) {
          progress.categories_completed = [...progress.categories_completed, category.slug];
        }
        saveProgress(progress);

        await sleep(DELAY_MS);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`Failed to fetch ${category.label}: ${msg}`);

        // Retry with fresh session
        if (msg.includes('CSRF') || msg.includes('JSESSIONID') || msg.includes('Empty')) {
          log('  Retrying with fresh session...');
          session = await createSession();
          try {
            let docs = await fetchCategoryMetadata(session, category);
            if (testMode) docs = docs.slice(0, 5);
            log(`  → Retry parsed ${docs.length} documents`);

            const metaPath = path.join(METADATA_DIR, `dgft_${category.slug}.json`);
            fs.writeFileSync(metaPath, JSON.stringify(docs, null, 2));
            appendToJsonl(docs);
            totalDocs += docs.length;
            progress.total_documents += docs.length;
            if (!testMode) {
              progress.categories_completed = [...progress.categories_completed, category.slug];
            }
            saveProgress(progress);
          } catch (retryErr: unknown) {
            logError(
              `Retry also failed for ${category.label}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
            );
          }
        }
      }
    }

    closeJsonlWriter();
    log(`\n  Metadata complete: ${totalDocs} documents collected`);
  }

  // ── Phase 2: PDF Download ──
  if (!metadataOnly && !testMode) {
    log('\n── Phase 2: PDF Download ──');

    // Load all documents from JSONL
    const allDocs: DgftDocument[] = [];

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
        const doc = JSON.parse(line) as DgftDocument;
        if (categoryFilter && doc.category_slug !== categoryFilter) continue;
        if (!doc.pdf_url || !doc.pdf_filename) continue;

        const pdfPath = path.join(PDFS_DIR, doc.category_slug, doc.pdf_filename);
        if (pdfsDoneSet.has(doc.pdf_filename) || fs.existsSync(pdfPath)) continue;

        allDocs.push(doc);
      } catch {
        /* skip malformed lines */
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
            const stats = fs.statSync(pdfPath);
            downloaded++;
            markPdfDone(doc.pdf_filename);
            progress.total_pdfs++;

            if (downloaded % 100 === 0 || downloaded === 1) {
              const elapsed = (Date.now() - startTime) / 1000;
              const rate = downloaded / elapsed;
              const remaining = allDocs.length - downloaded - failed;
              const etaMin = rate > 0 ? Math.ceil(remaining / rate / 60) : 0;
              log(
                `  [${((downloaded / allDocs.length) * 100).toFixed(1)}%] ${downloaded}/${allDocs.length} downloaded (${(stats.size / 1024).toFixed(0)}KB), ${failed} failed, ${rate.toFixed(1)}/s, ETA: ${etaMin}m`,
              );
              saveProgress(progress);
            }
          } else {
            failed++;
            if (failed <= 10) {
              logError(`  Failed: ${doc.document_number} (${doc.pdf_url?.slice(0, 80)})`);
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
