/**
 * ATFP Scraper - Appellate Tribunal for Forfeited Property
 * Scrapes orders and judgments from https://atfp.gov.in
 *
 * Architecture:
 *   - Single tribunal in New Delhi (3 courts, no regional benches)
 *   - Classic ASP on IIS 8.5, server-rendered HTML tables
 *   - POST forms → paginated HTML results (500/page orders, 100/page judgments)
 *   - No CAPTCHA, no rate limiting, no auth, direct PDF download
 *
 * Jurisdiction (5 Acts):
 *   - PMLA   (Prevention of Money-Laundering Act)      ~63,500 orders + ~2,050 judgments
 *   - FEMA   (Foreign Exchange Management Act)          ~17,500 orders + ~720 judgments
 *   - BENAMI (Prohibition of Benami Property Tx)        ~13,100 orders + ~324 judgments
 *   - NDPS   (Narcotic Drugs & Psychotropic Substances) ~9,400 orders + ~289 judgments
 *   - SAFEMA (Smugglers & Foreign Exchange Manipulators) ~464 orders + ~100 judgments
 *
 * Total: ~107,500 documents (orders + judgments)
 *
 * Usage:
 *   npx tsx scripts/atfp-scraper.ts                          # Full run
 *   npx tsx scripts/atfp-scraper.ts --test                   # Test (5 pages per act)
 *   npx tsx scripts/atfp-scraper.ts --metadata-only          # No PDF download
 *   npx tsx scripts/atfp-scraper.ts --download-only          # PDFs only (requires metadata)
 *   npx tsx scripts/atfp-scraper.ts --judgments-only         # Only judgments (not orders)
 *   npx tsx scripts/atfp-scraper.ts --orders-only            # Only orders (not judgments)
 *   npx tsx scripts/atfp-scraper.ts --act PMLA               # Single act type
 *   npx tsx scripts/atfp-scraper.ts --act NDPS --test        # Single act, test mode
 *
 * Environment:
 *   PDF_WORKERS=5         Concurrent PDF downloads (default: 5)
 *   DELAY_MS=500          Delay between page requests in ms (default: 500)
 *   DATA_DIR=data/atfp    Output directory (default: data/atfp)
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://atfp.gov.in';

const PDF_WORKERS = parseInt(process.env.PDF_WORKERS || '5', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const DATA_DIR = process.env.DATA_DIR || 'data/tribunals/atfp';
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const JSONL_FILE = path.join(DATA_DIR, 'atfp-all-documents.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'pdfs-downloaded.txt');

// ─── Act Types ───────────────────────────────────────────────────────────────

interface ActType {
  id: string;
  name: string;
  formValue: string; // URL-encoded form value
  shortName: string;
}

const ACT_TYPES: ActType[] = [
  {
    id: 'pmla',
    name: 'Prevention of Money-Laundering Act',
    formValue: 'PMLA/FPA-PMLA',
    shortName: 'PMLA',
  },
  {
    id: 'fema',
    name: 'Foreign Exchange Management Act',
    formValue: 'FEMA/FERA/FPA-FE',
    shortName: 'FEMA',
  },
  {
    id: 'benami',
    name: 'Prohibition of Benami Property Transactions Act',
    formValue: 'FPA/BP',
    shortName: 'BENAMI',
  },
  {
    id: 'ndps',
    name: 'Narcotic Drugs & Psychotropic Substances Act',
    formValue: 'NDPS/FPA/ND',
    shortName: 'NDPS',
  },
  {
    id: 'safema',
    name: 'Smugglers & Foreign Exchange Manipulators Act',
    formValue: 'SAFEMA/FPA\u20131',
    shortName: 'SAFEMA',
  },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface AtfpDocument {
  serial_no: number;
  doc_type: 'order' | 'judgment';
  act_id: string;
  act_name: string;
  case_number: string;
  date: string; // DD-MM-YYYY as on site
  date_iso: string; // YYYY-MM-DD for sorting
  appellant_name: string;
  respondent_name: string;
  full_parties: string;
  pdf_url: string;
  pdf_filename: string;
  source_url: string;
  tribunal: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  orders_completed: string[]; // "actId|pageN"
  judgments_completed: string[];
  total_orders: number;
  total_judgments: number;
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
    log(
      `Progress saved: ${progress.total_orders} orders, ${progress.total_judgments} judgments, ${progress.total_pdfs} PDFs`,
    );
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

// ─── Runtime Sets ────────────────────────────────────────────────────────────

let ordersCompletedSet: Set<string>;
let judgmentsCompletedSet: Set<string>;
let pdfsDoneSet: Set<string>;

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

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    orders_completed: [],
    judgments_completed: [],
    total_orders: 0,
    total_judgments: 0,
    total_pdfs: 0,
    last_updated: new Date().toISOString(),
  };
}

function initSets(progress: Progress): void {
  ordersCompletedSet = new Set(progress.orders_completed);
  judgmentsCompletedSet = new Set(progress.judgments_completed);

  pdfsDoneSet = new Set<string>();
  if (fs.existsSync(PDF_DONE_FILE)) {
    const content = fs.readFileSync(PDF_DONE_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      if (line) pdfsDoneSet.add(line);
    }
  }
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function markPdfDone(filename: string): void {
  if (!pdfsDoneSet.has(filename)) {
    pdfsDoneSet.add(filename);
    fs.appendFileSync(PDF_DONE_FILE, filename + '\n');
  }
}

/**
 * Parse date from DD-MM-YYYY to YYYY-MM-DD
 */
function parseDate(dateStr: string): string {
  const match = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
  if (!match) return '';
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/**
 * Normalize PDF URL from HTML source.
 * HTML uses backslashes: \writereaddata\upload\\Order\Order_XXX.PDF
 * We need forward slashes for HTTP: /writereaddata/upload/Order/Order_XXX.PDF
 */
function normalizePdfUrl(rawHref: string): string {
  const cleaned = rawHref
    .replace(/\\/g, '/') // backslash → forward slash
    .replace(/\/+/g, '/') // collapse multiple slashes
    .replace(/^\.\//, '/'); // remove leading ./

  if (cleaned.startsWith('/')) {
    return `${BASE_URL}${cleaned}`;
  }
  if (cleaned.startsWith('http')) {
    return cleaned;
  }
  return `${BASE_URL}/${cleaned}`;
}

function generatePdfFilename(doc: AtfpDocument): string {
  const caseSlug = slugify(doc.case_number, 40);
  const dateSlug = doc.date_iso.replace(/-/g, '');
  const base = `atfp_${doc.doc_type}_${doc.act_id}_${dateSlug}_${caseSlug}`;

  // Add hash suffix from PDF URL for uniqueness
  if (doc.pdf_url) {
    const hash = Buffer.from(doc.pdf_url).toString('base64').slice(-8).replace(/[/+=]/g, 'x');
    return `${base}_${hash}.pdf`;
  }
  return `${base}.pdf`;
}

// ─── JSONL Writer ────────────────────────────────────────────────────────────

let jsonlFd: number | null = null;

function openJsonlWriter(): void {
  jsonlFd = fs.openSync(JSONL_FILE, 'a');
}

function appendToJsonl(docs: AtfpDocument[]): void {
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

// ─── JSONL Reader (streaming) ────────────────────────────────────────────────

async function* streamJsonlDocs(): AsyncGenerator<AtfpDocument> {
  if (!fs.existsSync(JSONL_FILE)) return;

  const rl = await import('readline');
  const stream = fs.createReadStream(JSONL_FILE, 'utf-8');
  const lines = rl.createInterface({ input: stream });

  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as AtfpDocument;
    } catch {
      // skip malformed lines
    }
  }
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

function createClient(): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE_URL,
      Referer: `${BASE_URL}/orders.asp`,
    },
    // Don't follow redirects automatically - handle 302 etc ourselves
    maxRedirects: 5,
  });
}

async function fetchPage(
  client: AxiosInstance,
  endpoint: string,
  formData: string,
  page: number,
  retries = MAX_RETRIES,
): Promise<string> {
  const url = page > 1 ? `${endpoint}?currentPage=${page}` : endpoint;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await client.post(url, formData, {
        responseType: 'text',
      });
      return resp.data as string;
    } catch (err) {
      if (attempt < retries) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`${endpoint} page ${page} attempt ${attempt + 1}: ${msg}`);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`${endpoint} page ${page} failed after ${retries} retries`);
}

// ─── HTML Parsing ────────────────────────────────────────────────────────────

function parseResultsTable(
  html: string,
  docType: 'order' | 'judgment',
  act: ActType,
): AtfpDocument[] {
  const $ = cheerio.load(html);
  const docs: AtfpDocument[] = [];

  $('table.table-bordered tr').each((_i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const serialText = $(cells[0]).text().trim();
    const serialNo = parseInt(serialText.replace('.', ''), 10);
    if (isNaN(serialNo)) return; // skip header rows

    const caseNumber = $(cells[1]).text().trim();
    const dateStr = $(cells[2]).text().trim();
    const fullParties = $(cells[3]).text().trim();

    // Extract PDF URL from anchor tag
    const pdfAnchor = $(cells[4]).find('a');
    const rawPdfHref = pdfAnchor.attr('href') || '';
    const pdfUrl = rawPdfHref ? normalizePdfUrl(rawPdfHref) : '';

    // Split parties by "Versus" or "vs" or "V/s"
    const partySplit = fullParties.split(/\s+(?:Versus|vs\.?|V\/s)\s+/i);
    const appellantName = (partySplit[0] || '').trim();
    const respondentName = (partySplit[1] || '').trim();

    const dateIso = parseDate(dateStr);

    const doc: AtfpDocument = {
      serial_no: serialNo,
      doc_type: docType,
      act_id: act.id,
      act_name: act.shortName,
      case_number: caseNumber,
      date: dateStr,
      date_iso: dateIso,
      appellant_name: appellantName,
      respondent_name: respondentName,
      full_parties: fullParties,
      pdf_url: pdfUrl,
      pdf_filename: '',
      source_url: BASE_URL,
      tribunal: 'ATFP',
      country: 'IN',
      scraped_at: new Date().toISOString(),
    };
    doc.pdf_filename = generatePdfFilename(doc);

    docs.push(doc);
  });

  return docs;
}

/**
 * Check if there's a "Next" pagination link on the page.
 */
function hasNextPage(html: string): boolean {
  return html.includes('class="pull-right next"') || html.includes('>Next<');
}

// ─── Scrape Orders ───────────────────────────────────────────────────────────

async function scrapeOrdersForAct(
  client: AxiosInstance,
  act: ActType,
  progress: Progress,
  testMode: boolean,
): Promise<number> {
  const endpoint = '/Ordersdetails.asp';
  const formData = `ACTAPPEALTYPE=${encodeURIComponent(act.formValue)}&q=a`;
  const maxTestPages = 5;

  let totalDocs = 0;
  let page = 1;
  let consecutiveEmpty = 0;

  while (!shuttingDown) {
    const progressKey = `${act.id}|orders|p${page}`;
    if (ordersCompletedSet.has(progressKey)) {
      page++;
      continue;
    }

    await sleep(DELAY_MS);

    try {
      const html = await fetchPage(client, endpoint, formData, page);
      const docs = parseResultsTable(html, 'order', act);

      if (docs.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) {
          log(`    ${act.shortName} orders: No more results after page ${page}`);
          break;
        }
        page++;
        continue;
      }

      consecutiveEmpty = 0;
      totalDocs += docs.length;
      appendToJsonl(docs);

      // Save per-act page metadata
      const pageFile = path.join(METADATA_DIR, `orders_${act.id}_p${page}.json`);
      fs.writeFileSync(
        pageFile,
        JSON.stringify({ act: act.id, page, count: docs.length, docs }, null, 2),
      );

      ordersCompletedSet.add(progressKey);
      progress.orders_completed.push(progressKey);
      progress.total_orders += docs.length;

      if (page % 5 === 0) saveProgress(progress);

      log(`    ${act.shortName} orders page ${page}: ${docs.length} records (total: ${totalDocs})`);

      if (!hasNextPage(html) && docs.length < 500) {
        log(`    ${act.shortName} orders: Last page reached (${page})`);
        break;
      }

      if (testMode && page >= maxTestPages) {
        log(`    ${act.shortName} orders: Test mode limit (${maxTestPages} pages)`);
        break;
      }

      page++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`${act.shortName} orders page ${page}: ${msg}`);
      // On error, skip page and continue
      page++;
      consecutiveEmpty++;
      if (consecutiveEmpty >= 5) break;
    }
  }

  return totalDocs;
}

// ─── Scrape Judgments ────────────────────────────────────────────────────────

async function scrapeJudgmentsForAct(
  client: AxiosInstance,
  act: ActType,
  progress: Progress,
  testMode: boolean,
): Promise<number> {
  const endpoint = '/judgementsdetails.asp';
  // Note: judgments endpoint uses 'z' parameter instead of 'q'
  const formData = `ACTAPPEALTYPE=${encodeURIComponent(act.formValue)}&z=a`;
  const maxTestPages = 5;

  let totalDocs = 0;
  let page = 1;
  let consecutiveEmpty = 0;

  while (!shuttingDown) {
    const progressKey = `${act.id}|judgments|p${page}`;
    if (judgmentsCompletedSet.has(progressKey)) {
      page++;
      continue;
    }

    await sleep(DELAY_MS);

    try {
      const html = await fetchPage(client, endpoint, formData, page);
      const docs = parseResultsTable(html, 'judgment', act);

      if (docs.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) {
          log(`    ${act.shortName} judgments: No more results after page ${page}`);
          break;
        }
        page++;
        continue;
      }

      consecutiveEmpty = 0;
      totalDocs += docs.length;
      appendToJsonl(docs);

      const pageFile = path.join(METADATA_DIR, `judgments_${act.id}_p${page}.json`);
      fs.writeFileSync(
        pageFile,
        JSON.stringify({ act: act.id, page, count: docs.length, docs }, null, 2),
      );

      judgmentsCompletedSet.add(progressKey);
      progress.judgments_completed.push(progressKey);
      progress.total_judgments += docs.length;

      if (page % 5 === 0) saveProgress(progress);

      log(
        `    ${act.shortName} judgments page ${page}: ${docs.length} records (total: ${totalDocs})`,
      );

      if (!hasNextPage(html) && docs.length < 100) {
        log(`    ${act.shortName} judgments: Last page reached (${page})`);
        break;
      }

      if (testMode && page >= maxTestPages) {
        log(`    ${act.shortName} judgments: Test mode limit (${maxTestPages} pages)`);
        break;
      }

      page++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`${act.shortName} judgments page ${page}: ${msg}`);
      page++;
      consecutiveEmpty++;
      if (consecutiveEmpty >= 5) break;
    }
  }

  return totalDocs;
}

// ─── PDF Downloads ───────────────────────────────────────────────────────────

async function downloadPdfs(
  progress: Progress,
  testMode: boolean,
  docTypeFilter?: 'order' | 'judgment',
): Promise<void> {
  if (!fs.existsSync(JSONL_FILE)) {
    logError('No metadata JSONL found. Run metadata scrape first.');
    return;
  }

  log('\n=== PDF Downloads ===');
  log('  Scanning JSONL for download candidates...');

  let totalWithPdf = 0;
  let toDownloadCount = 0;

  for await (const doc of streamJsonlDocs()) {
    if (!doc.pdf_url) continue;
    if (docTypeFilter && doc.doc_type !== docTypeFilter) continue;
    totalWithPdf++;

    if (pdfsDoneSet.has(doc.pdf_filename)) continue;
    if (fs.existsSync(path.join(PDFS_DIR, doc.pdf_filename))) {
      markPdfDone(doc.pdf_filename);
      continue;
    }
    toDownloadCount++;
  }

  log(`  Total documents with PDFs: ${totalWithPdf}`);
  log(`  Already downloaded: ${pdfsDoneSet.size}`);
  log(`  To download: ${toDownloadCount}`);
  log(`  Workers: ${PDF_WORKERS}`);

  if (toDownloadCount === 0) {
    log('  Nothing to download.');
    return;
  }

  const pdfQueue = new PQueue({ concurrency: PDF_WORKERS });
  let downloaded = 0;
  let failed = 0;
  const maxPdfs = testMode ? 20 : Infinity;

  for await (const doc of streamJsonlDocs()) {
    if (shuttingDown) break;
    if (!doc.pdf_url) continue;
    if (docTypeFilter && doc.doc_type !== docTypeFilter) continue;
    if (pdfsDoneSet.has(doc.pdf_filename)) continue;
    if (fs.existsSync(path.join(PDFS_DIR, doc.pdf_filename))) {
      markPdfDone(doc.pdf_filename);
      continue;
    }

    if (downloaded + pdfQueue.pending >= maxPdfs) break;

    pdfQueue.add(async () => {
      if (shuttingDown) return;

      const destPath = path.join(PDFS_DIR, doc.pdf_filename);

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const resp = await axios.get(doc.pdf_url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
              Referer: `${BASE_URL}/orders.asp`,
            },
          });

          const contentType = resp.headers['content-type'] || '';
          if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
            logError(`  ${doc.pdf_filename}: Not a PDF (${contentType})`);
            failed++;
            return;
          }

          fs.writeFileSync(destPath, resp.data);
          markPdfDone(doc.pdf_filename);
          downloaded++;
          progress.total_pdfs++;

          if (downloaded % 50 === 0) {
            const sizeKb = Math.round(resp.data.length / 1024);
            log(`  Downloaded ${downloaded}/${toDownloadCount} PDFs (last: ${sizeKb}KB)`);
            saveProgress(progress);
          }
          return;
        } catch (err) {
          if (attempt < MAX_RETRIES - 1) {
            await sleep(RETRY_DELAY_MS * (attempt + 1));
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            logError(`  ${doc.pdf_filename}: ${msg}`);
            failed++;
          }
        }
      }
    });
  }

  await pdfQueue.onIdle();
  saveProgress(progress);

  log(`  PDF download complete: ${downloaded} downloaded, ${failed} failed`);
}

// ─── Cause Lists & Court Notices (Supplementary) ─────────────────────────────

async function scrapeCauseLists(client: AxiosInstance): Promise<number> {
  log('\n=== Supplementary: Cause Lists ===');

  try {
    const resp = await client.get('/cause-list.asp', { responseType: 'text' });
    const $ = cheerio.load(resp.data as string);
    const docs: AtfpDocument[] = [];

    $('table.table-bordered tr').each((_i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const title = $(cells[0]).text().trim();
      if (!title || title === 'Cause List') return;

      const pdfAnchor = $(cells[1]).find('a');
      const rawHref = pdfAnchor.attr('href') || '';
      if (!rawHref) return;

      const pdfUrl = normalizePdfUrl(rawHref);

      // Extract date from title like "Cause List for 17.02.2026 Court -3"
      const dateMatch = title.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      const dateStr = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : '';
      const dateIso = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : '';

      const doc: AtfpDocument = {
        serial_no: docs.length + 1,
        doc_type: 'order', // cause lists are supplementary
        act_id: 'cause_list',
        act_name: 'Cause List',
        case_number: title,
        date: dateStr,
        date_iso: dateIso,
        appellant_name: '',
        respondent_name: '',
        full_parties: title,
        pdf_url: pdfUrl,
        pdf_filename: `atfp_causelist_${dateIso.replace(/-/g, '')}_${slugify(title, 30)}.pdf`,
        source_url: `${BASE_URL}/cause-list.asp`,
        tribunal: 'ATFP',
        country: 'IN',
        scraped_at: new Date().toISOString(),
      };
      docs.push(doc);
    });

    if (docs.length > 0) {
      appendToJsonl(docs);
      const outFile = path.join(METADATA_DIR, 'cause-lists.json');
      fs.writeFileSync(outFile, JSON.stringify({ count: docs.length, docs }, null, 2));
    }

    log(`  Found ${docs.length} cause list entries`);
    return docs.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Cause lists: ${msg}`);
    return 0;
  }
}

async function scrapeCourtNotices(client: AxiosInstance): Promise<number> {
  log('\n=== Supplementary: Court Notices ===');

  try {
    const resp = await client.get('/court-notices.asp', { responseType: 'text' });
    const $ = cheerio.load(resp.data as string);
    const docs: AtfpDocument[] = [];

    $('table.table-bordered tr').each((_i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const title = $(cells[0]).text().trim();
      if (!title || title.includes('View/Download')) return;

      const pdfAnchor = $(cells[1]).find('a');
      const rawHref = pdfAnchor.attr('href') || '';
      if (!rawHref) return;

      const pdfUrl = normalizePdfUrl(rawHref);

      const doc: AtfpDocument = {
        serial_no: docs.length + 1,
        doc_type: 'order',
        act_id: 'court_notice',
        act_name: 'Court Notice',
        case_number: title,
        date: '',
        date_iso: '',
        appellant_name: '',
        respondent_name: '',
        full_parties: title,
        pdf_url: pdfUrl,
        pdf_filename: `atfp_notice_${slugify(title, 50)}.pdf`,
        source_url: `${BASE_URL}/court-notices.asp`,
        tribunal: 'ATFP',
        country: 'IN',
        scraped_at: new Date().toISOString(),
      };
      docs.push(doc);
    });

    if (docs.length > 0) {
      appendToJsonl(docs);
      const outFile = path.join(METADATA_DIR, 'court-notices.json');
      fs.writeFileSync(outFile, JSON.stringify({ count: docs.length, docs }, null, 2));
    }

    log(`  Found ${docs.length} court notice entries`);
    return docs.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Court notices: ${msg}`);
    return 0;
  }
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

interface CliOptions {
  testMode: boolean;
  metadataOnly: boolean;
  downloadOnly: boolean;
  ordersOnly: boolean;
  judgmentsOnly: boolean;
  actFilter: string | null;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    testMode: false,
    metadataOnly: false,
    downloadOnly: false,
    ordersOnly: false,
    judgmentsOnly: false,
    actFilter: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--test':
        opts.testMode = true;
        break;
      case '--metadata-only':
        opts.metadataOnly = true;
        break;
      case '--download-only':
        opts.downloadOnly = true;
        break;
      case '--orders-only':
        opts.ordersOnly = true;
        break;
      case '--judgments-only':
        opts.judgmentsOnly = true;
        break;
      case '--act':
        opts.actFilter = (args[++i] || '').toLowerCase();
        break;
    }
  }

  return opts;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();
  const startTime = Date.now();

  log('╔══════════════════════════════════════════════════════════╗');
  log('║  ATFP Scraper - Appellate Tribunal for Forfeited Property ║');
  log('╚══════════════════════════════════════════════════════════╝');
  log(`  Mode: ${opts.testMode ? 'TEST' : 'FULL'}`);
  if (opts.metadataOnly) log('  Metadata only (no PDFs)');
  if (opts.downloadOnly) log('  Download only (PDFs)');
  if (opts.ordersOnly) log('  Orders only');
  if (opts.judgmentsOnly) log('  Judgments only');
  if (opts.actFilter) log(`  Act filter: ${opts.actFilter}`);

  ensureDirs();

  const progress = loadProgress();
  initSets(progress);
  setupShutdownHandler(progress);

  const client = createClient();

  // Filter acts if requested
  const acts = opts.actFilter
    ? ACT_TYPES.filter(
        (a) => a.id === opts.actFilter || a.shortName.toLowerCase() === opts.actFilter,
      )
    : ACT_TYPES;

  if (acts.length === 0) {
    logError(`Unknown act: ${opts.actFilter}. Valid: ${ACT_TYPES.map((a) => a.id).join(', ')}`);
    process.exit(1);
  }

  openJsonlWriter();

  try {
    if (!opts.downloadOnly) {
      // Phase 1: Scrape orders
      if (!opts.judgmentsOnly) {
        log('\n=== Phase 1: Orders ===');
        let totalOrders = 0;
        for (const act of acts) {
          if (shuttingDown) break;
          log(`  Scraping ${act.shortName} orders...`);
          const count = await scrapeOrdersForAct(client, act, progress, opts.testMode);
          totalOrders += count;
        }
        log(`  Orders phase complete: ${totalOrders} records`);
        saveProgress(progress);
      }

      // Phase 2: Scrape judgments
      if (!opts.ordersOnly) {
        log('\n=== Phase 2: Judgments ===');
        let totalJudgments = 0;
        for (const act of acts) {
          if (shuttingDown) break;
          log(`  Scraping ${act.shortName} judgments...`);
          const count = await scrapeJudgmentsForAct(client, act, progress, opts.testMode);
          totalJudgments += count;
        }
        log(`  Judgments phase complete: ${totalJudgments} records`);
        saveProgress(progress);
      }

      // Phase 2.5: Supplementary data
      if (!opts.ordersOnly && !opts.judgmentsOnly && !opts.actFilter) {
        await scrapeCauseLists(client);
        await scrapeCourtNotices(client);
        saveProgress(progress);
      }
    }

    // Phase 3: Download PDFs
    if (!opts.metadataOnly) {
      const dlFilter = opts.judgmentsOnly
        ? ('judgment' as const)
        : opts.ordersOnly
          ? ('order' as const)
          : undefined;
      await downloadPdfs(progress, opts.testMode, dlFilter);
    }
  } finally {
    closeJsonlWriter();
    saveProgress(progress);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log('\n════════════════════════════════════════');
  log(`  Total orders:    ${progress.total_orders}`);
  log(`  Total judgments: ${progress.total_judgments}`);
  log(`  Total PDFs:      ${progress.total_pdfs}`);
  log(`  Elapsed:         ${elapsed} minutes`);
  log(`  Data dir:        ${DATA_DIR}`);
  log('════════════════════════════════════════');
}

main().catch((err) => {
  logError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
