/**
 * MoEFCC Scraper - Ministry of Environment, Forest and Climate Change
 * Scrapes notifications, circulars, orders, EIA clearances, CRZ notifications
 * from moef.gov.in, parivesh.nic.in, environmentclearance.nic.in
 *
 * Architecture:
 *   - parivesh.nic.in: Public REST JSON APIs (Spring Boot) - no auth required
 *   - moef.gov.in: Laravel/W3CMS static HTML pages - no auth required
 *   - environmentclearance.nic.in: ASP.NET, sequential PDF URLs - no auth required
 *   - No CAPTCHA, no rate limiting, no WAF on any portal
 *
 * Categories (by priority):
 *   1. OM/Circular Compilation      (parivesh API)   - 357 docs
 *   2. ESZ Notifications            (moef.gov.in)    - ~1,147 PDFs
 *   3. Legal Repository             (envclr)         - 191 PDFs
 *   4. EAC Meeting Minutes Central  (parivesh API)   - ~1,454 docs
 *   5. EAC Agendas Central          (parivesh API)   - ~1,421 docs
 *   6. State EAC Minutes            (parivesh API)   - ~13,406 docs
 *   7. State EAC Agendas            (parivesh API)   - ~13,140 docs
 *   8. ESA Notifications            (moef.gov.in)    - ~103 PDFs
 *   9. Orders & Notifications       (moef.gov.in)    - ~438 PDFs
 *  10. FAC/REC/CRZ/Wildlife/CAMPA   (parivesh API)   - ~2,187 docs
 *  11. Annual Reports               (moef.gov.in)    - ~40 PDFs
 *  12. Acts & Rules                 (moef.gov.in)    - ~15 PDFs
 *
 * Usage:
 *   npx tsx scripts/moefcc-scraper.ts                              # Full run
 *   npx tsx scripts/moefcc-scraper.ts --test                       # Test mode (5 docs per category, no PDFs)
 *   npx tsx scripts/moefcc-scraper.ts --metadata-only              # Metadata only, skip PDF download
 *   npx tsx scripts/moefcc-scraper.ts --download-only              # PDFs only (requires prior metadata run)
 *   npx tsx scripts/moefcc-scraper.ts --category om-circulars      # Single category
 *   npx tsx scripts/moefcc-scraper.ts --category esz-notifications # Single category
 *
 * Environment:
 *   PDF_WORKERS=10         Concurrent PDF downloads (default: 10)
 *   DELAY_MS=500           Delay between requests in ms (default: 500)
 *   PDF_DELAY_MS=300       Delay between PDF downloads in ms (default: 300)
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PARIVESH_BASE = 'https://parivesh.nic.in';
const MOEF_BASE = 'https://moef.gov.in';
const ENVCLR_BASE = 'https://environmentclearance.nic.in';

const PDF_WORKERS = parseInt(process.env.PDF_WORKERS || '10', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);
const PDF_DELAY_MS = parseInt(process.env.PDF_DELAY_MS || '300', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const DATA_DIR = process.env.DATA_DIR || 'data/regulatory/moefcc';
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const JSONL_FILE = path.join(DATA_DIR, 'moefcc-all-documents.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'pdfs-downloaded.txt');
const PDF_FAIL_FILE = path.join(DATA_DIR, 'pdfs-failed.txt');

// ─── Category Registry ───────────────────────────────────────────────────────

type CategorySlug =
  | 'om-circulars'
  | 'esz-notifications'
  | 'esa-notifications'
  | 'legal-repository'
  | 'eac-center-mom'
  | 'eac-center-agenda'
  | 'eac-state-mom'
  | 'eac-state-agenda'
  | 'fac'
  | 'rec-fc'
  | 'crz-committee'
  | 'wildlife-committee'
  | 'campa'
  | 'orders-notifications'
  | 'orders-archive'
  | 'annual-reports'
  | 'acts-rules'
  | 'forest-conservation';

interface CategoryConfig {
  slug: CategorySlug;
  label: string;
  source: 'parivesh' | 'moef' | 'envclr';
  priority: number;
}

const CATEGORIES: CategoryConfig[] = [
  { slug: 'om-circulars', label: 'OM/Circular Compilation', source: 'parivesh', priority: 1 },
  { slug: 'esz-notifications', label: 'ESZ Notifications', source: 'moef', priority: 2 },
  { slug: 'legal-repository', label: 'Legal Repository', source: 'envclr', priority: 3 },
  { slug: 'eac-center-mom', label: 'EAC Central Minutes', source: 'parivesh', priority: 4 },
  { slug: 'eac-center-agenda', label: 'EAC Central Agendas', source: 'parivesh', priority: 5 },
  { slug: 'eac-state-mom', label: 'State EAC Minutes', source: 'parivesh', priority: 6 },
  { slug: 'eac-state-agenda', label: 'State EAC Agendas', source: 'parivesh', priority: 7 },
  { slug: 'esa-notifications', label: 'ESA Notifications', source: 'moef', priority: 8 },
  { slug: 'orders-notifications', label: 'Orders & Notifications', source: 'moef', priority: 9 },
  { slug: 'orders-archive', label: 'Orders Archive', source: 'moef', priority: 10 },
  { slug: 'fac', label: 'Forest Advisory Committee', source: 'parivesh', priority: 11 },
  { slug: 'rec-fc', label: 'Regional Empowered Committee', source: 'parivesh', priority: 12 },
  { slug: 'crz-committee', label: 'CRZ Committee', source: 'parivesh', priority: 13 },
  { slug: 'wildlife-committee', label: 'Wildlife Committee', source: 'parivesh', priority: 14 },
  { slug: 'campa', label: 'CAMPA', source: 'parivesh', priority: 15 },
  { slug: 'annual-reports', label: 'Annual Reports', source: 'moef', priority: 16 },
  { slug: 'acts-rules', label: 'Acts & Rules', source: 'moef', priority: 17 },
  { slug: 'forest-conservation', label: 'Forest Conservation', source: 'moef', priority: 18 },
];

// Parivesh API committee configs
interface PariveshCommitteeConfig {
  slug: CategorySlug;
  committee: string;
  workgroup: string;
  type: string;
  authority: string;
}

const PARIVESH_COMMITTEES: PariveshCommitteeConfig[] = [
  {
    slug: 'eac-center-mom',
    committee: 'MoMCatA',
    workgroup: 'EC',
    type: 'Mom',
    authority: 'Center',
  },
  {
    slug: 'eac-center-agenda',
    committee: 'CatA',
    workgroup: 'EC',
    type: 'Agenda',
    authority: 'Center',
  },
  { slug: 'eac-state-mom', committee: 'MoMCatB', workgroup: 'EC', type: 'Mom', authority: 'State' },
  {
    slug: 'eac-state-agenda',
    committee: 'CatB',
    workgroup: 'EC',
    type: 'Agenda',
    authority: 'State',
  },
  { slug: 'fac', committee: 'FAC', workgroup: 'FC', type: 'Agenda', authority: 'Center' },
  { slug: 'rec-fc', committee: 'REC', workgroup: 'FC', type: 'Agenda', authority: 'Center' },
  {
    slug: 'crz-committee',
    committee: 'CRZ',
    workgroup: 'CRZ',
    type: 'Agenda',
    authority: 'Center',
  },
  {
    slug: 'wildlife-committee',
    committee: 'Wildlife',
    workgroup: 'WLC',
    type: 'Agenda',
    authority: 'Center',
  },
  { slug: 'campa', committee: 'Campa', workgroup: 'FC', type: 'Agenda', authority: 'Center' },
];

// moef.gov.in page configs
interface MoefPageConfig {
  slug: CategorySlug;
  urls: string[];
}

const MOEF_PAGES: MoefPageConfig[] = [
  { slug: 'esz-notifications', urls: ['/esz-notifications'] },
  { slug: 'esa-notifications', urls: ['/esa-notifications'] },
  { slug: 'orders-notifications', urls: ['/orders-and-notification-2'] },
  { slug: 'orders-archive', urls: ['/orders-notifications-archive'] },
  { slug: 'annual-reports', urls: ['/annual-reports'] },
  { slug: 'acts-rules', urls: ['/environment-protection'] },
  { slug: 'forest-conservation', urls: ['/forest-conservation'] },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface MoefccDocument {
  id: string;
  category: string;
  category_slug: CategorySlug;
  title: string;
  date: string;
  date_iso: string;
  detail_url: string;
  pdf_url: string;
  pdf_filename: string;
  pdf_size_bytes: number;
  document_number: string;
  subject: string;
  source_portal: string;
  regulator: string;
  country: string;
  scraped_at: string;
  // Parivesh-specific
  sector?: string;
  classification?: string;
  chapter?: string;
  brief_contents?: string;
  meeting_id?: string;
  state?: string;
  authority?: string;
}

interface Progress {
  categories_completed: string[];
  total_documents: number;
  total_pdfs: number;
  last_updated: string;
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
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(dateStr: string): string {
  if (!dateStr) return '';
  // Try YYYY-MM-DD
  const isoMatch = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  // Try DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = dateStr.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmyMatch)
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
  // Try "Month DD, YYYY" or "DD Month YYYY"
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
  const mdyMatch = dateStr.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdyMatch) {
    const m = months[mdyMatch[1].toLowerCase()];
    if (m) return `${mdyMatch[3]}-${m}-${mdyMatch[2].padStart(2, '0')}`;
  }
  const dmyMatch2 = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (dmyMatch2) {
    const m = months[dmyMatch2[2].toLowerCase()];
    if (m) return `${dmyMatch2[3]}-${m}-${dmyMatch2[1].padStart(2, '0')}`;
  }
  return '';
}

function makeAbsoluteUrl(base: string, href: string): string {
  if (!href) return '';
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) {
    // Extract origin from base
    const originMatch = base.match(/^(https?:\/\/[^/]+)/);
    const origin = originMatch ? originMatch[1] : base;
    return `${origin}${href}`;
  }
  // Handle relative paths like ../writereaddata/...
  if (href.startsWith('../') || href.startsWith('./')) {
    try {
      return new URL(href, base.endsWith('/') ? base : base + '/').href;
    } catch {
      return `${base}/${href}`;
    }
  }
  return `${base}/${href}`;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Progress ────────────────────────────────────────────────────────────────

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { categories_completed: [], total_documents: 0, total_pdfs: 0, last_updated: '' };
}

function saveProgress(progress: Progress): void {
  const updated = { ...progress, last_updated: new Date().toISOString() };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(updated, null, 2));
}

// ─── JSONL Writer ────────────────────────────────────────────────────────────

let jsonlFd: number | null = null;

function openJsonl(): void {
  ensureDir(DATA_DIR);
  jsonlFd = fs.openSync(JSONL_FILE, 'a');
}

function writeJsonl(doc: MoefccDocument): void {
  if (jsonlFd === null) openJsonl();
  fs.writeSync(jsonlFd!, JSON.stringify(doc) + '\n');
}

function closeJsonl(): void {
  if (jsonlFd !== null) {
    fs.closeSync(jsonlFd);
    jsonlFd = null;
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

let shuttingDown = false;
let currentProgress: Progress = loadProgress();

function setupShutdownHandler(): void {
  const handler = () => {
    if (shuttingDown) {
      log('Force exit');
      process.exit(1);
    }
    shuttingDown = true;
    log('Shutting down gracefully... (press Ctrl+C again to force)');
    saveProgress(currentProgress);
    closeJsonl();
    process.exit(0);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

function createClient(baseURL: string, acceptJson = false): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: 120000,
    maxRedirects: 5,
    maxContentLength: 100 * 1024 * 1024, // 100MB
    validateStatus: (s) => s < 500,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: acceptJson
        ? 'application/json, text/plain, */*'
        : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
}

const pariveshClient = createClient(PARIVESH_BASE, true);
const moefClient = createClient(MOEF_BASE);
const envclrClient = createClient(ENVCLR_BASE);

// ─── Retry Wrapper ───────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`${label} attempt ${attempt}/${MAX_RETRIES}: ${msg}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  logError(`${label} failed after ${MAX_RETRIES} attempts`);
  return null;
}

// ─── Phase 1: Parivesh OM/Circular API ──────────────────────────────────────

async function scrapeOmCirculars(testMode: boolean): Promise<MoefccDocument[]> {
  log('Fetching OM/Circular Compilation from Parivesh API...');
  const resp = await withRetry(
    () =>
      pariveshClient.post(
        '/cms/omCircularCompilation/search',
        {},
        {
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    'om-circulars-api',
  );
  if (!resp || !resp.data) {
    logError('Failed to fetch OM/Circulars');
    return [];
  }

  const records: unknown[] = Array.isArray(resp.data) ? resp.data : resp.data.data || [];
  log(`  Got ${records.length} OM/Circular records`);

  const docs: MoefccDocument[] = [];
  const limit = testMode ? 5 : records.length;

  for (let i = 0; i < Math.min(limit, records.length); i++) {
    const r = records[i] as Record<string, unknown>;
    const dateRaw = String(r.date || '');
    const pdfLink = String(r.viewDownloadLink || '');

    const doc: MoefccDocument = {
      id: `moefcc-om-${r.id || i}`,
      category: 'OM/Circular Compilation',
      category_slug: 'om-circulars',
      title: stripHtml(String(r.subject || r.keyword || '')),
      date: dateRaw,
      date_iso: parseDate(dateRaw),
      detail_url: '',
      pdf_url: pdfLink.startsWith('http') ? pdfLink : makeAbsoluteUrl(ENVCLR_BASE, pdfLink),
      pdf_filename: '',
      pdf_size_bytes: 0,
      document_number: String(r.omCircularNumber || ''),
      subject: stripHtml(String(r.subject || '')),
      source_portal: 'parivesh.nic.in',
      regulator: 'MoEFCC',
      country: 'IN',
      scraped_at: new Date().toISOString(),
      sector: String(r.sectorName || ''),
      classification: String(r.classification || ''),
      chapter: String(r.chapter || ''),
      brief_contents: stripHtml(String(r.briefContents || '')),
    };
    doc.pdf_filename = doc.pdf_url
      ? `moefcc_om_${slugify(doc.document_number || String(i))}.pdf`
      : '';
    docs.push(doc);
  }

  log(`  Processed ${docs.length} OM/Circular documents`);
  return docs;
}

// ─── Phase 1: Parivesh Committee APIs ────────────────────────────────────────

async function scrapePariveshCommittee(
  config: PariveshCommitteeConfig,
  testMode: boolean,
): Promise<MoefccDocument[]> {
  const catConfig = CATEGORIES.find((c) => c.slug === config.slug)!;
  log(`Fetching ${catConfig.label} from Parivesh API...`);

  const url = `/parivesh_api/proponentApplicant/getParivesh1AgendaMom?committee=${config.committee}&workgroup=${config.workgroup}&type=${config.type}&authority=${config.authority}`;

  const resp = await withRetry(() => pariveshClient.get(url), `${config.slug}-api`);
  if (!resp) {
    logError(`Failed to fetch ${catConfig.label}: no response`);
    return [];
  }

  // Debug: log response type
  const dataType = typeof resp.data;
  const isArr = Array.isArray(resp.data);
  log(`  Response: status=${resp.status}, type=${dataType}, isArray=${isArr}`);

  // Parse response - may be string if content-type mismatched
  let parsed: unknown = resp.data;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      logError(`Failed to parse ${catConfig.label} response as JSON`);
      return [];
    }
  }

  const records: unknown[] = Array.isArray(parsed)
    ? parsed
    : ((parsed as Record<string, unknown>)?.data as unknown[]) || [];
  log(`  Got ${records.length} ${catConfig.label} records`);

  const docs: MoefccDocument[] = [];
  const limit = testMode ? 5 : records.length;

  for (let i = 0; i < Math.min(limit, records.length); i++) {
    const r = records[i] as Record<string, unknown>;
    const dateRaw = String(r.from_date || r.date || '');
    // Handle both MoM and Agenda URL fields, and different id field names
    const agendaUrl = String(
      r.Agenda_URL || r.agenda_url || r.MoM_URL || r.Mom_URL || r.mom_url || '',
    );
    const subject = String(r.subject || r.Subject || '');
    const meetingId = String(r.meeting_id || r.Agenda_id || r.agenda_id || r.id || '');
    const sector = String(r.Project_Sector || r.project_sector || '');

    const doc: MoefccDocument = {
      id: `moefcc-${config.slug}-${meetingId || i}`,
      category: catConfig.label,
      category_slug: config.slug,
      title: stripHtml(subject) || `${catConfig.label} - ${meetingId}`,
      date: dateRaw,
      date_iso: parseDate(dateRaw),
      detail_url: '',
      pdf_url: agendaUrl.startsWith('http') ? agendaUrl : makeAbsoluteUrl(ENVCLR_BASE, agendaUrl),
      pdf_filename: '',
      pdf_size_bytes: 0,
      document_number: meetingId,
      subject: stripHtml(subject),
      source_portal: 'parivesh.nic.in',
      regulator: 'MoEFCC',
      country: 'IN',
      scraped_at: new Date().toISOString(),
      meeting_id: meetingId,
      sector,
      authority: config.authority,
    };
    doc.pdf_filename = doc.pdf_url
      ? `moefcc_${slugify(config.slug)}_${slugify(meetingId || String(i))}.pdf`
      : '';
    docs.push(doc);
  }

  log(`  Processed ${docs.length} ${catConfig.label} documents`);
  return docs;
}

// ─── Phase 2: moef.gov.in HTML Scraping ──────────────────────────────────────

async function scrapeMoefPage(
  pageConfig: MoefPageConfig,
  testMode: boolean,
): Promise<MoefccDocument[]> {
  const catConfig = CATEGORIES.find((c) => c.slug === pageConfig.slug)!;
  log(`Scraping ${catConfig.label} from moef.gov.in...`);

  const allDocs: MoefccDocument[] = [];

  for (const urlPath of pageConfig.urls) {
    if (shuttingDown) break;

    const resp = await withRetry(() => moefClient.get(urlPath), `moef-${pageConfig.slug}`);
    if (!resp || resp.status !== 200) {
      logError(`Failed to fetch ${MOEF_BASE}${urlPath}`);
      continue;
    }

    const $ = cheerio.load(resp.data);
    const docs: MoefccDocument[] = [];
    let docIndex = 0;

    // Strategy: Find all links to PDFs on the page
    $('a[href*=".pdf"], a[href*=".PDF"]').each((_i, el) => {
      if (testMode && docIndex >= 5) return false;
      const $el = $(el);
      const href = $el.attr('href') || '';
      if (!href) return;

      const pdfUrl = makeAbsoluteUrl(MOEF_BASE, href);
      const title = stripHtml($el.text()) || stripHtml($el.attr('title') || '');

      // Try to find date from surrounding context
      const parentRow = $el.closest('tr, li, div.row, p');
      const rowText = parentRow.text() || '';
      const dateMatch = rowText.match(
        /(\d{1,2}[/-]\d{1,2}[/-]\d{4})|(\d{4}-\d{2}-\d{2})|(\d{1,2}\s+\w+\s+\d{4})/,
      );
      const dateRaw = dateMatch ? dateMatch[0] : '';

      // Extract document number from text
      const docNumMatch = rowText.match(/(?:S\.O\.|F\.No\.|No\.|Ref\.|G\.S\.R\.)\s*[\w./-]+/i);

      const doc: MoefccDocument = {
        id: `moefcc-${pageConfig.slug}-${docIndex}`,
        category: catConfig.label,
        category_slug: pageConfig.slug,
        title: title || `${catConfig.label} Document ${docIndex + 1}`,
        date: dateRaw,
        date_iso: parseDate(dateRaw),
        detail_url: `${MOEF_BASE}${urlPath}`,
        pdf_url: pdfUrl,
        pdf_filename: `moefcc_${slugify(pageConfig.slug)}_${docIndex}_${slugify(title || 'doc', 50)}.pdf`,
        pdf_size_bytes: 0,
        document_number: docNumMatch ? docNumMatch[0].trim() : '',
        subject: title,
        source_portal: 'moef.gov.in',
        regulator: 'MoEFCC',
        country: 'IN',
        scraped_at: new Date().toISOString(),
      };
      docs.push(doc);
      docIndex++;
    });

    log(`  Found ${docs.length} PDF links on ${urlPath}`);
    allDocs.push(...docs);
    await sleep(DELAY_MS);
  }

  return allDocs;
}

// ─── Phase 3: Legal Repository (environmentclearance.nic.in) ─────────────────

async function scrapeLegalRepository(testMode: boolean): Promise<MoefccDocument[]> {
  log('Scraping Legal Repository from environmentclearance.nic.in...');

  const resp = await withRetry(
    () => envclrClient.get('/report/Legal_Repository.html'),
    'legal-repository-html',
  );

  const docs: MoefccDocument[] = [];

  if (resp && resp.status === 200) {
    // Parse the HTML table - structure is:
    // <tr><th>191</td> <td>S.O. 2903(E)</td> <td>03-07-2023</td> <td>Subject...</td>
    //   <td>date</td> <td>date</td> <td><a href="../writereaddata/LegalRepository/190.pdf">...</a></td>
    const $ = cheerio.load(resp.data);
    let docIndex = 0;

    // Find all rows that start with a serial number in <th>
    $('table.table-bordered tr').each((_i, row) => {
      if (testMode && docIndex >= 5) return false;
      const $row = $(row);

      // Serial number is in first <th> element
      const serialTh = $row.find('th[scope="col"]').first();
      const serialNo = serialTh.text().trim();
      if (!serialNo || isNaN(parseInt(serialNo))) return;

      // Get all <td> cells in this row
      const cells = $row.find('td');
      if (cells.length < 3) return;

      const gazetteNo = $(cells[0]).text().trim();
      const dateRaw = $(cells[1]).text().trim();
      const subject = stripHtml($(cells[2]).text());

      // Find PDF link - relative path like ../writereaddata/LegalRepository/190.pdf
      const pdfLink = $row.find('a[href*="LegalRepository"]').attr('href') || '';
      const pdfUrl = pdfLink
        ? makeAbsoluteUrl(ENVCLR_BASE + '/report', pdfLink)
        : `${ENVCLR_BASE}/writereaddata/LegalRepository/${serialNo}.pdf`;

      // Extract PDF serial from URL (may differ from serial no)
      const pdfSerialMatch = pdfUrl.match(/\/(\d+)\.pdf/);
      const pdfSerial = pdfSerialMatch ? pdfSerialMatch[1] : serialNo;

      const doc: MoefccDocument = {
        id: `moefcc-legal-repo-${serialNo}`,
        category: 'Legal Repository',
        category_slug: 'legal-repository',
        title: subject || `Legal Repository Notification ${serialNo}`,
        date: dateRaw,
        date_iso: parseDate(dateRaw),
        detail_url: `${ENVCLR_BASE}/report/Legal_Repository.html`,
        pdf_url: pdfUrl,
        pdf_filename: `moefcc_legal-repo_${pdfSerial}.pdf`,
        pdf_size_bytes: 0,
        document_number: gazetteNo || `LR-${serialNo}`,
        subject,
        source_portal: 'environmentclearance.nic.in',
        regulator: 'MoEFCC',
        country: 'IN',
        scraped_at: new Date().toISOString(),
      };
      docs.push(doc);
      docIndex++;
    });

    log(`  Parsed ${docs.length} docs from Legal Repository HTML`);
  }

  // If HTML parsing yielded few results, also generate sequential URLs (1-191)
  if (docs.length < 50 && !testMode) {
    log('  Supplementing with sequential URL generation (1-191)...');
    const existingSerials = new Set(docs.map((d) => d.document_number.replace('LR-', '')));
    const maxSerial = 191;
    for (let i = 1; i <= maxSerial; i++) {
      if (existingSerials.has(String(i))) continue;
      docs.push({
        id: `moefcc-legal-repo-${i}`,
        category: 'Legal Repository',
        category_slug: 'legal-repository',
        title: `Legal Repository Notification ${i}`,
        date: '',
        date_iso: '',
        detail_url: `${ENVCLR_BASE}/report/Legal_Repository.html`,
        pdf_url: `${ENVCLR_BASE}/writereaddata/LegalRepository/${i}.pdf`,
        pdf_filename: `moefcc_legal-repo_${i}.pdf`,
        pdf_size_bytes: 0,
        document_number: `LR-${i}`,
        subject: `Legal Repository Notification ${i}`,
        source_portal: 'environmentclearance.nic.in',
        regulator: 'MoEFCC',
        country: 'IN',
        scraped_at: new Date().toISOString(),
      });
    }
    log(`  Total Legal Repository docs: ${docs.length}`);
  }

  return docs;
}

// ─── Phase 4: PDF Downloads ──────────────────────────────────────────────────

async function downloadPdfs(categoryFilter?: string): Promise<void> {
  if (!fs.existsSync(JSONL_FILE)) {
    logError(`No JSONL file found at ${JSONL_FILE}. Run metadata scraping first.`);
    return;
  }

  // Load already-downloaded set
  const doneSet = new Set<string>();
  if (fs.existsSync(PDF_DONE_FILE)) {
    const content = fs.readFileSync(PDF_DONE_FILE, 'utf-8');
    content
      .split('\n')
      .filter(Boolean)
      .forEach((f) => doneSet.add(f));
  }
  log(`${doneSet.size} PDFs already downloaded`);

  // Read JSONL and collect download tasks
  const tasks: { url: string; filename: string; category: string }[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const doc = JSON.parse(line) as MoefccDocument;
      if (categoryFilter && doc.category_slug !== categoryFilter) continue;
      if (!doc.pdf_url || !doc.pdf_filename) continue;
      if (doneSet.has(doc.pdf_filename)) continue;
      tasks.push({
        url: doc.pdf_url,
        filename: doc.pdf_filename,
        category: doc.category_slug,
      });
    } catch {
      // skip malformed lines
    }
  }

  log(`${tasks.length} PDFs to download`);
  if (tasks.length === 0) return;

  const queue = new PQueue({ concurrency: PDF_WORKERS });
  const doneFd = fs.openSync(PDF_DONE_FILE, 'a');
  const failFd = fs.openSync(PDF_FAIL_FILE, 'a');
  let completed = 0;
  let failed = 0;

  for (const task of tasks) {
    if (shuttingDown) break;

    queue.add(async () => {
      if (shuttingDown) return;

      const catDir = path.join(PDFS_DIR, task.category);
      ensureDir(catDir);
      const outPath = path.join(catDir, task.filename);
      const tmpPath = outPath + '.tmp';

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const resp = await axios.get(task.url, {
            responseType: 'arraybuffer',
            timeout: 120000,
            maxRedirects: 5,
            validateStatus: (s) => s < 500,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
          });

          if (resp.status !== 200) {
            throw new Error(`HTTP ${resp.status}`);
          }

          const buf = Buffer.from(resp.data);
          // Validate PDF header
          if (buf.length < 100 || buf.subarray(0, 5).toString() !== '%PDF-') {
            throw new Error(
              `Invalid PDF (${buf.length} bytes, header: ${buf.subarray(0, 5).toString()})`,
            );
          }

          // Atomic write
          fs.writeFileSync(tmpPath, buf);
          fs.renameSync(tmpPath, outPath);

          fs.writeSync(doneFd, task.filename + '\n');
          completed++;
          currentProgress.total_pdfs = completed;

          if (completed % 100 === 0) {
            log(
              `  PDFs: ${completed} done, ${failed} failed, ${tasks.length - completed - failed} remaining`,
            );
          }

          await sleep(PDF_DELAY_MS);
          return;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt === MAX_RETRIES) {
            fs.writeSync(failFd, `${task.url}\t${task.filename}\t${msg}\n`);
            failed++;
          } else {
            await sleep(RETRY_DELAY_MS * attempt);
          }
        }
      }
    });
  }

  await queue.onIdle();
  fs.closeSync(doneFd);
  fs.closeSync(failFd);
  log(`PDF download complete: ${completed} done, ${failed} failed`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');

  const catIdx = args.indexOf('--category');
  const categoryFilter = catIdx !== -1 ? args[catIdx + 1] : undefined;

  if (categoryFilter && !CATEGORIES.find((c) => c.slug === categoryFilter)) {
    logError(`Unknown category: ${categoryFilter}`);
    logError(`Valid categories: ${CATEGORIES.map((c) => c.slug).join(', ')}`);
    process.exit(1);
  }

  ensureDir(DATA_DIR);
  ensureDir(METADATA_DIR);
  ensureDir(PDFS_DIR);

  currentProgress = loadProgress();
  setupShutdownHandler();

  log('=== MoEFCC Scraper ===');
  log(
    `Mode: ${testMode ? 'TEST' : downloadOnly ? 'DOWNLOAD-ONLY' : metadataOnly ? 'METADATA-ONLY' : 'FULL'}`,
  );
  if (categoryFilter) log(`Category filter: ${categoryFilter}`);
  log(
    `Already completed: ${currentProgress.categories_completed.length} categories, ${currentProgress.total_documents} docs, ${currentProgress.total_pdfs} PDFs`,
  );

  // ── Download-only mode ─────────────────────────────────────────────────
  if (downloadOnly) {
    await downloadPdfs(categoryFilter);
    return;
  }

  // ── Metadata scraping ──────────────────────────────────────────────────
  openJsonl();
  let totalNewDocs = 0;

  const categoriesToScrape = categoryFilter
    ? CATEGORIES.filter((c) => c.slug === categoryFilter)
    : CATEGORIES;

  for (const cat of categoriesToScrape) {
    if (shuttingDown) break;
    if (currentProgress.categories_completed.includes(cat.slug)) {
      log(`Skipping ${cat.label} (already completed)`);
      continue;
    }

    let docs: MoefccDocument[] = [];

    try {
      if (cat.source === 'parivesh') {
        if (cat.slug === 'om-circulars') {
          docs = await scrapeOmCirculars(testMode);
        } else {
          const committeeConfig = PARIVESH_COMMITTEES.find((c) => c.slug === cat.slug);
          if (committeeConfig) {
            docs = await scrapePariveshCommittee(committeeConfig, testMode);
          }
        }
      } else if (cat.source === 'moef') {
        const pageConfig = MOEF_PAGES.find((p) => p.slug === cat.slug);
        if (pageConfig) {
          docs = await scrapeMoefPage(pageConfig, testMode);
        }
      } else if (cat.source === 'envclr') {
        if (cat.slug === 'legal-repository') {
          docs = await scrapeLegalRepository(testMode);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to scrape ${cat.label}: ${msg}`);
      continue;
    }

    // Write docs to JSONL
    for (const doc of docs) {
      writeJsonl(doc);
    }

    // Save per-category metadata
    const metaFile = path.join(METADATA_DIR, `${cat.slug}.json`);
    fs.writeFileSync(metaFile, JSON.stringify(docs, null, 2));

    totalNewDocs += docs.length;
    currentProgress.total_documents += docs.length;
    currentProgress.categories_completed = [...currentProgress.categories_completed, cat.slug];
    saveProgress(currentProgress);

    log(`✓ ${cat.label}: ${docs.length} documents`);
    await sleep(DELAY_MS);
  }

  closeJsonl();
  log(
    `\nMetadata scraping complete: ${totalNewDocs} new documents across ${categoriesToScrape.length} categories`,
  );
  log(`Total in JSONL: ${currentProgress.total_documents} documents`);

  // ── PDF download phase ─────────────────────────────────────────────────
  if (!metadataOnly && !testMode) {
    log('\n=== Starting PDF Downloads ===');
    await downloadPdfs(categoryFilter);
  }

  saveProgress(currentProgress);
  log('\n=== Done ===');
}

main().catch((err) => {
  logError(`Fatal: ${err.message || err}`);
  saveProgress(currentProgress);
  closeJsonl();
  process.exit(1);
});
