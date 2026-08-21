/**
 * MCA Scraper - Ministry of Corporate Affairs
 * Scrapes acts, rules, notifications, circulars, forms, accounting standards from https://www.mca.gov.in
 *
 * Architecture:
 *   - Adobe Experience Manager (AEM) backend with DMS APIs
 *   - Akamai WAF blocks most direct HTTP, but some API endpoints accessible via axios
 *   - Confirmed working: Acts(10), Circulars(239), Accounting Standards(372), Forms(518), Others(96)
 *   - Rules use searchDoc API; Notifications need per-act docGroup filtering
 *   - PDF download: /bin/ebook/dms/getdocument?doc=<base64(linkId)>&docCategory=X&type=download
 *
 * Categories:
 *   1. Acts              (10 parent acts + versions)
 *   2. Rules             (~60-80 rule sets via searchDoc per act)
 *   3. Notifications     (~2,000-3,000+ via metadata per act)
 *   4. Circulars         (~239 via metadata)
 *   5. Accounting Standards (372 via metadata)
 *   6. Forms             (~518 via metadata)
 *   7. Others            (~96 via metadata)
 *
 * Usage:
 *   npx tsx scripts/mca-scraper.ts                         # Full run
 *   npx tsx scripts/mca-scraper.ts --test                  # Test mode (10 docs per cat, no PDFs)
 *   npx tsx scripts/mca-scraper.ts --metadata-only         # Metadata only
 *   npx tsx scripts/mca-scraper.ts --download-only         # PDFs only (requires prior metadata)
 *   npx tsx scripts/mca-scraper.ts --category circulars    # Single category
 *
 * Environment:
 *   PDF_WORKERS=5        Concurrent PDF downloads (default: 5)
 *   PDF_DELAY_MS=200     Delay between PDF downloads (default: 200)
 *   API_DELAY_MS=500     Delay between API calls (default: 500)
 */

import axios, { AxiosInstance } from 'axios';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.mca.gov.in';
const METADATA_API = '/bin/ebook/service/documentMetadata';
const SEARCH_API = '/bin/ebook/dms/searchDoc';
const DOCUMENT_API = '/bin/ebook/dms/getdocument';

const PDF_WORKERS = parseInt(process.env.PDF_WORKERS || '5', 10);
const PDF_DELAY_MS = parseInt(process.env.PDF_DELAY_MS || '200', 10);
const API_DELAY_MS = parseInt(process.env.API_DELAY_MS || '500', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const DATA_DIR = process.env.DATA_DIR || 'data/regulatory/mca';
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const JSONL_FILE = path.join(DATA_DIR, 'mca-all-documents.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'pdfs-downloaded.txt');

// ─── Category Registry ───────────────────────────────────────────────────────

type CategorySlug =
  | 'acts'
  | 'rules'
  | 'notifications'
  | 'circulars'
  | 'accounting-standards'
  | 'forms'
  | 'others';

interface CategoryConfig {
  slug: CategorySlug;
  label: string;
  docCategory: string;
  priority: number;
}

const CATEGORIES: CategoryConfig[] = [
  { slug: 'acts', label: 'Acts', docCategory: 'Acts', priority: 1 },
  { slug: 'rules', label: 'Rules', docCategory: 'Rules', priority: 2 },
  {
    slug: 'notifications',
    label: 'Notifications',
    docCategory: 'NotificationsAndCirculars',
    priority: 3,
  },
  { slug: 'circulars', label: 'Circulars', docCategory: 'Circulars', priority: 4 },
  {
    slug: 'accounting-standards',
    label: 'Accounting Standards',
    docCategory: 'Accounting Standards',
    priority: 5,
  },
  { slug: 'forms', label: 'Forms', docCategory: 'Forms', priority: 6 },
  {
    slug: 'others',
    label: 'Others (Amendments, Orders, Regulations)',
    docCategory: 'Others',
    priority: 7,
  },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface McaDocument {
  docId: string;
  docIdentifier: string;
  docName: string;
  docGroup: string;
  shortDescription: string;
  category: string;
  category_slug: CategorySlug;
  link: string;
  notificationDate: string;
  notificationDateIso: string;
  lastAmendmentDate: string;
  version: string;
  status: string;
  level: string;
  parent: string;
  root: string;
  originalDocId: string;
  amendmentNumber: string;
  pdfSize: string;
  uploadDate: string;
  sectionDocId: string;
  ruleDocId: string;
  pdf_url: string;
  pdf_filename: string;
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

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const cat of CATEGORIES) {
    fs.mkdirSync(path.join(PDFS_DIR, cat.slug), { recursive: true });
  }
}

function parseMcaDate(dateStr: string): string {
  if (!dateStr) return '';
  const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (match) return `${match[3]}-${match[1]}-${match[2]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);
  return '';
}

function encodeDocLink(linkId: string): string {
  return Buffer.from(linkId).toString('base64');
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
  const tmpFile = `${PROGRESS_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(updated, null, 2));
  fs.renameSync(tmpFile, PROGRESS_FILE);
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

function appendToJsonl(docs: McaDocument[]): void {
  if (jsonlFd === null || docs.length === 0) return;
  const lines = docs.map((d) => JSON.stringify(d)).join('\n') + '\n';
  fs.writeSync(jsonlFd, lines);
}

function closeJsonlWriter(): void {
  if (jsonlFd !== null) {
    fs.closeSync(jsonlFd);
    jsonlFd = null;
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
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${BASE_URL}/content/mca/global/en/acts-rules/ebooks.html`,
    },
    validateStatus: (s) => s < 500,
  });
}

// ─── API Functions ───────────────────────────────────────────────────────────

/**
 * Extract JSON array from API response, handling various response shapes
 */
function extractDataArray(data: unknown): Record<string, unknown>[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
  }
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
      if (parsed?.data && Array.isArray(parsed.data)) return parsed.data;
    } catch {
      /* not JSON */
    }
  }
  return [];
}

async function fetchMetadataApi(
  client: AxiosInstance,
  params: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const url = `${METADATA_API}?${new URLSearchParams(params).toString()}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await client.get(url);

      if (resp.status === 403) {
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        logError(`  403 for ${params.docCategory} (blocked by WAF)`);
        return [];
      }

      if (resp.status === 200) {
        return extractDataArray(resp.data);
      }

      logError(`  HTTP ${resp.status} for ${params.docCategory}`);
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  return [];
}

async function fetchSearchApi(
  client: AxiosInstance,
  params: Record<string, string>,
): Promise<{ data: Record<string, unknown>[]; recordsTotal: number }> {
  const url = `${SEARCH_API}?${new URLSearchParams(params).toString()}`;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await client.get(url);

      if (resp.status === 403) {
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
          continue;
        }
        return { data: [], recordsTotal: 0 };
      }

      if (resp.status === 200) {
        let d = resp.data;
        if (typeof d === 'string') {
          try {
            d = JSON.parse(d);
          } catch {
            /* ignore */
          }
        }
        if (d && typeof d === 'object') {
          return {
            data: (Array.isArray(d.data) ? d.data : []) as Record<string, unknown>[],
            recordsTotal: typeof d.recordsTotal === 'number' ? d.recordsTotal : 0,
          };
        }
      }
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  return { data: [], recordsTotal: 0 };
}

// ─── Document Processing ─────────────────────────────────────────────────────

function rawToMcaDocument(raw: Record<string, unknown>, category: CategoryConfig): McaDocument {
  const link = String(raw.link || raw.docLink || '');
  const docName = String(raw.docName || '');
  const docId = String(raw.docId || '');
  const titleSlug = slugify(docName, 50);
  const pdfFilename = link
    ? `mca_${category.slug}_${link}_${titleSlug}.pdf`
    : `mca_${category.slug}_${docId}_${titleSlug}.pdf`;

  const notificationDate = String(raw.notificationdate || raw.notificationDate || '');
  const pdfUrl = link
    ? `${DOCUMENT_API}?doc=${encodeDocLink(link)}&docCategory=${encodeURIComponent(category.docCategory)}&type=download`
    : '';

  return {
    docId,
    docIdentifier: String(raw.docIdentifier || ''),
    docName,
    docGroup: String(raw.docGroup || ''),
    shortDescription: String(raw.shortDescription || ''),
    category: category.label,
    category_slug: category.slug,
    link,
    notificationDate,
    notificationDateIso: parseMcaDate(notificationDate),
    lastAmendmentDate: String(raw.lastAmendmentDate || ''),
    version: String(raw.version || ''),
    status: String(raw.status || 'Current'),
    level: String(raw.level || ''),
    parent: String(raw.parent || ''),
    root: String(raw.root || ''),
    originalDocId: String(raw.originalDocId || ''),
    amendmentNumber: String(raw.amendmentNumber || ''),
    pdfSize: String(raw.PDFSize || raw.pdfSize || ''),
    uploadDate: String(raw.UploadDate || raw.uploadDate || ''),
    sectionDocId: String(raw.sectionDocId || ''),
    ruleDocId: String(raw.ruleDocId || ''),
    pdf_url: pdfUrl,
    pdf_filename: pdfFilename,
    regulator: 'MCA',
    country: 'IN',
    scraped_at: new Date().toISOString(),
  };
}

// ─── Phase 1: Scrape Metadata ────────────────────────────────────────────────

/** Known act names for per-act filtering (used for Rules/Notifications) */
const ACT_NAMES = [
  'The Companies Act, 2013',
  'The Limited Liability Partnership Act, 2008',
  'The Insolvency and Bankruptcy Code, 2016',
  'The Competition Act, 2002',
  'The Chartered Accountants Act, 1949',
  'The Cost Accountants Act, 1959',
  'The Company Secretaries Act, 1980',
  'The Partnership Act, 1932',
  'The Societies Registration Act, 1860',
  'The Companies (Donations to National Funds) Act, 1951',
];

async function scrapeActs(
  client: AxiosInstance,
  progress: Progress,
  testMode: boolean,
): Promise<McaDocument[]> {
  log('\n--- Acts ---');

  // Fetch top-level acts
  await sleep(API_DELAY_MS);
  const acts = await fetchMetadataApi(client, {
    docCategory: 'Acts',
    status: 'Current',
    Level: '1',
    _: String(Date.now()),
  });

  log(`  Top-level acts: ${acts.length}`);

  const allDocs: McaDocument[] = [];
  const catConfig = CATEGORIES.find((c) => c.slug === 'acts')!;

  for (const raw of acts) {
    allDocs.push(rawToMcaDocument(raw, catConfig));
  }

  // Fetch versions/amendments for each act
  if (!testMode) {
    for (const raw of acts) {
      if (shuttingDown) break;
      const actName = String(raw.docName || '');
      const actLink = String(raw.link || '');
      if (!actName) continue;

      await sleep(API_DELAY_MS);
      const children = await fetchMetadataApi(client, {
        docCategory: 'Acts',
        status: 'Current',
        flag: 'timeline',
        docGroup: actName,
        _: String(Date.now()),
      });

      let added = 0;
      for (const child of children) {
        if (String(child.link || '') === actLink) continue;
        allDocs.push(rawToMcaDocument(child, catConfig));
        added++;
      }
      if (added > 0) log(`  ${actName}: +${added} versions`);
    }
  }

  return allDocs;
}

async function scrapeRules(
  client: AxiosInstance,
  progress: Progress,
  testMode: boolean,
): Promise<McaDocument[]> {
  log('\n--- Rules ---');
  const catConfig = CATEGORIES.find((c) => c.slug === 'rules')!;
  const allDocs: McaDocument[] = [];

  // Try searchDoc API first (no docGroup filter)
  await sleep(API_DELAY_MS);
  const firstPage = await fetchSearchApi(client, {
    docCategory: 'Rules',
    searchType: 'Metadata',
    searchKeyword: '',
    searchField: 'Document Name',
    sortField: 'Document Name',
    sortOrder: 'A',
    start: '0',
    length: '500',
    draw: '1',
    _: String(Date.now()),
  });

  if (firstPage.recordsTotal > 0) {
    log(`  Search API: ${firstPage.recordsTotal} total records`);
    for (const raw of firstPage.data) {
      if (testMode && allDocs.length >= 10) break;
      allDocs.push(rawToMcaDocument(raw, catConfig));
    }

    // Fetch remaining pages
    let offset = 500;
    while (offset < firstPage.recordsTotal && !shuttingDown && !testMode) {
      await sleep(API_DELAY_MS);
      const page = await fetchSearchApi(client, {
        docCategory: 'Rules',
        searchType: 'Metadata',
        searchKeyword: '',
        searchField: 'Document Name',
        sortField: 'Document Name',
        sortOrder: 'A',
        start: String(offset),
        length: '500',
        draw: '1',
        _: String(Date.now()),
      });

      for (const raw of page.data) {
        allDocs.push(rawToMcaDocument(raw, catConfig));
      }

      const pct = ((offset / firstPage.recordsTotal) * 100).toFixed(1);
      log(`  [${pct}%] Offset ${offset}: +${page.data.length} (total: ${allDocs.length})`);
      offset += 500;
    }
  } else {
    // Search API returned 0 — try metadata API per act instead
    log('  Search API returned 0. Trying metadata API per act...');

    for (const actName of ACT_NAMES) {
      if (shuttingDown) break;
      if (testMode && allDocs.length >= 10) break;

      await sleep(API_DELAY_MS);
      const rules = await fetchMetadataApi(client, {
        docCategory: 'Rules',
        status: 'Current',
        flag: 'initial',
        docGroup: actName,
        _: String(Date.now()),
      });

      for (const raw of rules) {
        if (testMode && allDocs.length >= 10) break;
        allDocs.push(rawToMcaDocument(raw, catConfig));
      }

      if (rules.length > 0) log(`  ${actName}: ${rules.length} rules`);
    }
  }

  return allDocs;
}

async function scrapeNotifications(
  client: AxiosInstance,
  progress: Progress,
  testMode: boolean,
): Promise<McaDocument[]> {
  log('\n--- Notifications ---');
  const catConfig = CATEGORIES.find((c) => c.slug === 'notifications')!;
  const allDocs: McaDocument[] = [];

  // Try without docGroup first
  await sleep(API_DELAY_MS);
  const initial = await fetchMetadataApi(client, {
    docCategory: 'NotificationsAndCirculars',
    status: 'Current',
    flag: 'initial',
    _: String(Date.now()),
  });

  if (initial.length > 0) {
    log(`  Metadata API (no filter): ${initial.length} documents`);
    for (const raw of initial) {
      if (testMode && allDocs.length >= 10) break;
      allDocs.push(rawToMcaDocument(raw, catConfig));
    }
  } else {
    // Try per-act
    log('  Empty response. Trying per-act filtering...');

    for (const actName of ACT_NAMES) {
      if (shuttingDown) break;
      if (testMode && allDocs.length >= 10) break;

      await sleep(API_DELAY_MS);
      const notifs = await fetchMetadataApi(client, {
        docCategory: 'NotificationsAndCirculars',
        status: 'Current',
        flag: 'initial',
        docGroup: actName,
        _: String(Date.now()),
      });

      for (const raw of notifs) {
        if (testMode && allDocs.length >= 10) break;
        allDocs.push(rawToMcaDocument(raw, catConfig));
      }

      if (notifs.length > 0) log(`  ${actName}: ${notifs.length} notifications`);
    }

    // Also try 'Notifications' docCategory (without the "AndCirculars")
    if (allDocs.length === 0) {
      log('  Also trying docCategory=Notifications...');
      await sleep(API_DELAY_MS);
      const altNotifs = await fetchMetadataApi(client, {
        docCategory: 'Notifications',
        status: 'Current',
        flag: 'initial',
        _: String(Date.now()),
      });
      if (altNotifs.length > 0) {
        log(`  Alt Notifications: ${altNotifs.length} documents`);
        for (const raw of altNotifs) {
          if (testMode && allDocs.length >= 10) break;
          allDocs.push(rawToMcaDocument(raw, catConfig));
        }
      }
    }
  }

  return allDocs;
}

async function scrapeSimpleCategory(
  client: AxiosInstance,
  category: CategoryConfig,
  testMode: boolean,
): Promise<McaDocument[]> {
  log(`\n--- ${category.label} ---`);
  const allDocs: McaDocument[] = [];

  await sleep(API_DELAY_MS);
  const docs = await fetchMetadataApi(client, {
    docCategory: category.docCategory,
    status: 'Current',
    flag: 'initial',
    _: String(Date.now()),
  });

  log(`  Metadata API: ${docs.length} documents`);

  for (const raw of docs) {
    if (testMode && allDocs.length >= 10) break;
    allDocs.push(rawToMcaDocument(raw, category));
  }

  return allDocs;
}

async function scrapeAllMetadata(
  client: AxiosInstance,
  categories: CategoryConfig[],
  progress: Progress,
  testMode: boolean,
): Promise<void> {
  log(`\n=== Phase 1: Scraping Metadata (${categories.length} categories) ===`);

  for (const category of categories) {
    if (shuttingDown) break;

    // Skip if already completed
    if (progress.categories_completed.includes(category.slug)) {
      const cachedFile = path.join(METADATA_DIR, `mca_${category.slug}.json`);
      if (fs.existsSync(cachedFile)) {
        const cached: McaDocument[] = JSON.parse(fs.readFileSync(cachedFile, 'utf-8'));
        log(`\n--- ${category.label}: ${cached.length} docs (cached, skipping) ---`);
        continue;
      }
    }

    let docs: McaDocument[] = [];

    switch (category.slug) {
      case 'acts':
        docs = await scrapeActs(client, progress, testMode);
        break;
      case 'rules':
        docs = await scrapeRules(client, progress, testMode);
        break;
      case 'notifications':
        docs = await scrapeNotifications(client, progress, testMode);
        break;
      default:
        docs = await scrapeSimpleCategory(client, category, testMode);
        break;
    }

    // Deduplicate
    const seen = new Set<string>();
    const deduped = docs.filter((d) => {
      const key = d.link || d.docId;
      if (key && !seen.has(key)) {
        seen.add(key);
        return true;
      }
      return false;
    });

    if (docs.length !== deduped.length) {
      log(`  Deduped: ${docs.length} -> ${deduped.length}`);
    }

    // Save metadata
    const metaFile = path.join(METADATA_DIR, `mca_${category.slug}.json`);
    const tmpFile = `${metaFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(deduped, null, 2));
    fs.renameSync(tmpFile, metaFile);

    appendToJsonl(deduped);

    // Update progress
    progress.total_documents += deduped.length;
    if (!progress.categories_completed.includes(category.slug)) {
      progress.categories_completed.push(category.slug);
    }
    saveProgress(progress);

    // Summary
    const summaryFile = path.join(METADATA_DIR, `mca_${category.slug}_summary.json`);
    fs.writeFileSync(
      summaryFile,
      JSON.stringify(
        {
          category: category.slug,
          label: category.label,
          total_documents: deduped.length,
          with_pdf_url: deduped.filter((d) => d.pdf_url).length,
          scraped_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    log(
      `  ${category.label} complete: ${deduped.length} documents (${deduped.filter((d) => d.pdf_url).length} with PDF URLs)`,
    );
  }
}

// ─── Phase 2: Download PDFs ──────────────────────────────────────────────────

async function* streamJsonlDocs(): AsyncGenerator<McaDocument> {
  if (!fs.existsSync(JSONL_FILE)) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL_FILE),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as McaDocument;
    } catch {
      /* skip */
    }
  }
}

/**
 * Download PDFs using Playwright to bypass Akamai WAF.
 * Navigates to the ebook page to establish session, then intercepts download responses.
 */
async function downloadPdfs(
  progress: Progress,
  testMode: boolean,
  categoryFilter?: CategorySlug,
): Promise<void> {
  if (!fs.existsSync(JSONL_FILE)) {
    logError('No metadata JSONL found. Run metadata scrape first.');
    return;
  }

  log(`\n=== Phase 2: PDF Downloads (via Playwright) ===`);
  log(`  Scanning JSONL for download candidates...`);

  // Categories known to store HTML, not PDFs (Acts/Rules are ebook HTML, no individual PDFs)
  const HTML_ONLY_CATEGORIES: CategorySlug[] = ['acts', 'rules'];

  // Build download list
  const toDownload: McaDocument[] = [];
  let totalWithPdf = 0;
  let alreadyDone = 0;
  let skippedHtml = 0;

  for await (const doc of streamJsonlDocs()) {
    if (!doc.pdf_url || !doc.link) continue;
    if (categoryFilter && doc.category_slug !== categoryFilter) continue;

    // Skip categories that only have HTML content (not real PDFs)
    if (HTML_ONLY_CATEGORIES.includes(doc.category_slug)) {
      skippedHtml++;
      continue;
    }

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
    toDownload.push(doc);
  }

  if (skippedHtml > 0) {
    log(`  Skipped ${skippedHtml} HTML-only documents (Acts/Rules stored as HTML, not PDF)`);
  }

  log(`  Total with PDF URLs: ${totalWithPdf}`);
  log(`  Already downloaded: ${alreadyDone}`);
  log(`  To download: ${toDownload.length}`);

  if (toDownload.length === 0) {
    log('  Nothing to download.');
    return;
  }

  const total = testMode ? Math.min(5, toDownload.length) : toDownload.length;

  // Launch Playwright for PDF downloads
  // Headed mode may be needed to bypass Akamai bot detection
  const useHeaded = process.env.HEADED === 'true' || process.env.HEADED === '1';
  log(`  Launching Playwright (${useHeaded ? 'headed' : 'headless'})...`);
  const browser = await chromium.launch({
    headless: !useHeaded,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
    });

    const page = await context.newPage();

    // Navigate to establish Akamai session
    log('  Establishing session...');
    await page.goto(`${BASE_URL}/content/mca/global/en/acts-rules/ebooks/acts.html`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    const title = await page.title();
    log(`  Page title: ${title}`);

    // If Access Denied, wait longer for Akamai challenge resolution
    if (title.includes('Access Denied')) {
      log('  Waiting for Akamai challenge resolution...');
      await sleep(10000);
      await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
      const title2 = await page.title();
      log(`  After wait+reload: ${title2}`);
    }

    // Wait for Akamai cookies to be set
    await sleep(5000);

    // Test API from page context
    const testResult = await page.evaluate(async () => {
      try {
        const resp = await fetch(
          '/bin/ebook/service/documentMetadata?docCategory=Acts&status=Current&Level=1',
        );
        if (!resp.ok) return { ok: false, status: resp.status };
        const data = await resp.json();
        const count = Array.isArray(data?.data)
          ? data.data.length
          : Array.isArray(data)
            ? data.length
            : 0;
        return { ok: true, count };
      } catch (e: unknown) {
        return { ok: false, error: String(e) };
      }
    });
    log(`  API test from page: ${JSON.stringify(testResult)}`);

    let downloaded = 0;
    let failed = 0;
    let htmlOnly = 0; // Documents that are HTML, not PDF
    const downloadStartTime = Date.now();
    let consecutiveFails = 0;

    for (let i = 0; i < total; i++) {
      if (shuttingDown) break;
      if (consecutiveFails >= 10) {
        log('  10 consecutive failures, refreshing page session...');
        await page.goto(`${BASE_URL}/content/mca/global/en/acts-rules/ebooks/acts.html`, {
          waitUntil: 'networkidle',
          timeout: 60000,
        });
        await sleep(3000);
        consecutiveFails = 0;
      }

      const doc = toDownload[i];
      const dest = path.join(PDFS_DIR, doc.category_slug, doc.pdf_filename);
      const fullUrl = `${BASE_URL}${doc.pdf_url}`;

      await sleep(PDF_DELAY_MS);

      try {
        // Use page.evaluate to download as arraybuffer
        const result = await page.evaluate(async (url: string) => {
          try {
            const resp = await fetch(url);
            if (!resp.ok) return { error: `HTTP ${resp.status}`, size: 0 };

            const contentType = resp.headers.get('content-type') || '';
            const buffer = await resp.arrayBuffer();
            const bytes = new Uint8Array(buffer);

            // Check for PDF header (%PDF)
            if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50) {
              // Not a PDF - might be HTML content (Acts/Rules are stored as HTML)
              if (contentType.includes('html') || bytes.length < 100) {
                return { error: 'HTML content (not PDF)', size: bytes.length, isHtml: true };
              }
              const decoder = new TextDecoder();
              const preview = decoder.decode(bytes.slice(0, 200));
              if (preview.includes('<div') || preview.includes('<html')) {
                return { error: 'HTML content (not PDF)', size: bytes.length, isHtml: true };
              }
              return { error: 'Not a PDF', size: bytes.length, preview };
            }

            // Convert to base64 for transfer back to Node
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
              const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
              for (let j = 0; j < chunk.length; j++) {
                binary += String.fromCharCode(chunk[j]);
              }
            }
            return { base64: btoa(binary), size: bytes.length };
          } catch (e: unknown) {
            return { error: String(e), size: 0 };
          }
        }, fullUrl);

        if (result && 'base64' in result && result.base64) {
          const pdfBuffer = Buffer.from(result.base64, 'base64');
          const tmpDest = `${dest}.tmp`;
          fs.writeFileSync(tmpDest, pdfBuffer);
          fs.renameSync(tmpDest, dest);

          downloaded++;
          markPdfDone(doc.pdf_filename);
          progress.total_pdfs++;
          consecutiveFails = 0;

          if (downloaded % 25 === 0 || downloaded === 1) {
            saveProgress(progress);
            const pct = ((downloaded / total) * 100).toFixed(2);
            const elapsed = (Date.now() - downloadStartTime) / 1000;
            const rate = downloaded / elapsed;
            const remaining = total - downloaded - failed;
            const etaMin = rate > 0 ? Math.ceil(remaining / rate / 60) : 0;
            log(
              `  PDF [${pct}%] ${downloaded}/${total}, ${failed} failed, ${rate.toFixed(1)}/s, ETA: ${etaMin}m`,
            );
          }
        } else {
          const errMsg = result && 'error' in result ? result.error : 'unknown';
          const isHtml = result && 'isHtml' in result && (result as { isHtml: boolean }).isHtml;

          if (isHtml) {
            // HTML-only document (stored as HTML, not PDF)
            htmlOnly++;
            markPdfDone(doc.pdf_filename); // Skip in future runs
            if (htmlOnly <= 3) log(`  Skipping HTML-only doc: ${doc.pdf_filename.slice(0, 60)}`);
          } else {
            if (failed < 5) {
              log(`  PDF failed: ${errMsg} (URL: ${fullUrl.slice(0, 100)})`);
            }
            failed++;
            consecutiveFails++;
            fs.appendFileSync(
              path.join(DATA_DIR, 'pdfs-failed.txt'),
              `${doc.pdf_filename}\t${fullUrl}\n`,
            );
          }
        }
      } catch {
        failed++;
        consecutiveFails++;
        fs.appendFileSync(
          path.join(DATA_DIR, 'pdfs-failed.txt'),
          `${doc.pdf_filename}\t${fullUrl}\n`,
        );
      }
    }

    saveProgress(progress);
    log(
      `\n  PDF download complete: ${downloaded} downloaded, ${htmlOnly} HTML-only (skipped), ${failed} failed`,
    );

    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }
}

// ─── CLI & Main ──────────────────────────────────────────────────────────────

function parseArgs(): {
  testMode: boolean;
  metadataOnly: boolean;
  downloadOnly: boolean;
  categoryFilter?: CategorySlug;
} {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');

  let categoryFilter: CategorySlug | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      const val = args[i + 1] as CategorySlug;
      if (!CATEGORIES.find((c) => c.slug === val)) {
        console.error(`Unknown category: ${val}`);
        console.error(`Valid: ${CATEGORIES.map((c) => c.slug).join(', ')}`);
        process.exit(1);
      }
      categoryFilter = val;
    }
  }

  return { testMode, metadataOnly, downloadOnly, categoryFilter };
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

  console.log(`\nMCA Scraper - Ministry of Corporate Affairs`);
  console.log(`  URL: ${BASE_URL}`);
  console.log(`  Mode: ${mode}${opts.testMode ? ' (TEST)' : ''}`);
  console.log(`  Categories: ${categories.map((c) => c.slug).join(', ')}`);
  console.log(`  PDF Workers: ${PDF_WORKERS}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Progress: ${progress.total_documents} docs, ${progress.total_pdfs} PDFs\n`);

  const client = createClient();

  // Quick connectivity test
  log('Testing API connectivity...');
  try {
    const testResp = await client.get(
      `${METADATA_API}?docCategory=Acts&status=Current&Level=1&_=${Date.now()}`,
    );
    if (testResp.status === 200) {
      const count = extractDataArray(testResp.data).length;
      log(`  API test: OK (${count} acts)`);
    } else if (testResp.status === 403) {
      log(`  API test: 403 (Akamai WAF active)`);
      log(`  WARNING: Direct API access is blocked. Results may be empty.`);
      log(`  The WAF behavior is non-deterministic. Try again later or use a VPN.`);
    } else {
      log(`  API test: HTTP ${testResp.status}`);
    }
  } catch (err) {
    log(`  API test: Failed (${err instanceof Error ? err.message : String(err)})`);
  }

  if (!opts.downloadOnly) {
    await scrapeAllMetadata(client, categories, progress, opts.testMode);
  }

  closeJsonlWriter();

  if (!opts.metadataOnly && !shuttingDown) {
    await downloadPdfs(progress, opts.testMode, opts.categoryFilter);
  }

  saveProgress(progress);

  console.log(`\n=== Scraping Complete ===`);
  console.log(`  Total documents: ${progress.total_documents}`);
  console.log(`  Total PDFs: ${progress.total_pdfs}`);
  console.log(`  Categories scraped: ${progress.categories_completed.join(', ')}`);
}

main().catch((err) => {
  closeJsonlWriter();
  console.error('Fatal error:', err);
  process.exit(1);
});
