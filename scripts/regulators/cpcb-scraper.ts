/**
 * CPCB Scraper - Central Pollution Control Board (cpcb.nic.in)
 *
 * Scrapes Standards, Guidelines, Directions, Reports, Circulars, Rules,
 * Publications, and NGT-related documents from cpcb.nic.in for RAG pipeline.
 *
 * Architecture:
 *   - Apache + PHP/MySQL backend, server-side rendered HTML
 *   - DataTables for client-side table pagination (all rows in DOM)
 *   - PDFs via openpdffile.php?id={base64_path} or direct URLs
 *   - No CAPTCHA, no rate limiting, no auth required
 *   - Self-signed SSL cert (rejectUnauthorized: false)
 *
 * Categories (~3,000 docs total):
 *   1. Directions (General)         - ~625 docs
 *   2. Directions (5EP)             - ~774 docs
 *   3. Directions to SPCBs          - ~182 docs
 *   4. Directions to Industries     - ~80 docs
 *   5. OCEMS Directions 2017        - ~148 docs
 *   6. OCEMS Directions 2016        - ~83 docs
 *   7. Fortnightly Reports          - ~145 docs
 *   8. Technical Guidelines/SOPs    - ~44 docs
 *   9. Publications (18 sub-cats)   - ~371 docs
 *  10. Circulars                    - ~28 docs
 *  11. Effluent/Emission Standards  - ~43 docs
 *  12. Environmental Acts           - ~10 docs
 *  13. Rules (9 sub-cats)           - ~88 docs
 *  14. Annual Reports               - ~15 docs
 *  15. NGT Court Matters            - ~48 docs
 *  16. Air/Water Quality Standards  - ~22 docs
 *  17. Reports (current + archive)  - ~36 docs
 *
 * Usage:
 *   npx tsx scripts/cpcb-scraper.ts                           # Full run
 *   npx tsx scripts/cpcb-scraper.ts --test                    # Test mode (3 PDFs max per category)
 *   npx tsx scripts/cpcb-scraper.ts --metadata-only           # Extract links only, skip downloads
 *   npx tsx scripts/cpcb-scraper.ts --download-only           # Download from existing metadata
 *   npx tsx scripts/cpcb-scraper.ts --category directions     # Single category
 *
 * Environment:
 *   DELAY_MS=500          Delay between page requests (default: 500)
 *   PDF_DELAY_MS=300      Delay between PDF downloads (default: 300)
 *   CONCURRENCY=5         Parallel PDF downloads (default: 5)
 *   DATA_DIR=data/regulatory/cpcb  Output directory
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

const BASE_URL = 'https://cpcb.nic.in';
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);
const PDF_DELAY_MS = parseInt(process.env.PDF_DELAY_MS || '300', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_DELAY_MS = 3000;
const PAGE_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const DATA_DIR = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data/regulatory/cpcb');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const JSONL_FILE = path.join(DATA_DIR, 'cpcb-all-documents.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'pdfs-downloaded.txt');
const PDF_FAILED_FILE = path.join(DATA_DIR, 'pdfs-failed.txt');

// ─── Types ───────────────────────────────────────────────────────────────────

type CategorySlug =
  | 'directions-general'
  | 'directions-5ep'
  | 'directions-spcb'
  | 'directions-industries'
  | 'directions-ocems-2017'
  | 'directions-ocems-2016'
  | 'directions-ocems-old'
  | 'directions-common'
  | 'directions-plastic'
  | 'fortnightly-reports'
  | 'technical-guidelines'
  | 'circulars'
  | 'effluent-emission'
  | 'env-protection-act'
  | 'rules-hw'
  | 'rules-ewaste'
  | 'rules-msw'
  | 'rules-bmw'
  | 'rules-plastic'
  | 'rules-batteries'
  | 'rules-crz'
  | 'rules-eia'
  | 'rules-fly-ash'
  | 'air-quality-standards'
  | 'water-quality-standards'
  | 'ngt-court-matters'
  | 'ngt-court-cases'
  | 'ngt-committees'
  | 'ngt-bmw'
  | 'reports-current'
  | 'reports-archive'
  | 'annual-reports'
  | 'publications'
  | 'announcements';

interface PageConfig {
  slug: CategorySlug;
  label: string;
  urlPath: string;
  pdfSubdir: string;
  priority: number;
  /** Custom table parser key (default: 'auto') */
  parser?: 'table-with-download' | 'table-standard' | 'pdf-links' | 'auto';
}

const PAGES: PageConfig[] = [
  // Directions
  {
    slug: 'directions-general',
    label: 'CPCB Directions (General)',
    urlPath: '/cpcb-directions.php',
    pdfSubdir: 'directions/general',
    priority: 1,
  },
  {
    slug: 'directions-5ep',
    label: 'CPCB Directions (5EP)',
    urlPath: '/cpcb-directions-5ep.php',
    pdfSubdir: 'directions/5ep',
    priority: 2,
  },
  {
    slug: 'directions-spcb',
    label: 'Directions to SPCBs (18-1-b)',
    urlPath: '/directions-spcb-18-1-b/',
    pdfSubdir: 'directions/spcb',
    priority: 3,
  },
  {
    slug: 'directions-industries',
    label: 'Directions to Industries',
    urlPath: '/directions-industries-authorities/',
    pdfSubdir: 'directions/industries',
    priority: 4,
  },
  {
    slug: 'directions-ocems-2017',
    label: 'OCEMS Directions 2017',
    urlPath: '/directions-ocems-2017/',
    pdfSubdir: 'directions/ocems-2017',
    priority: 5,
  },
  {
    slug: 'directions-ocems-2016',
    label: 'OCEMS Directions 2016',
    urlPath: '/directions-ocems-2016/',
    pdfSubdir: 'directions/ocems-2016',
    priority: 6,
  },
  {
    slug: 'directions-ocems-old',
    label: 'OCEMS Directions (Older)',
    urlPath: '/direction-ocems/',
    pdfSubdir: 'directions/ocems-old',
    priority: 7,
  },
  {
    slug: 'directions-common',
    label: 'Common Directions',
    urlPath: '/common-directions-issued/',
    pdfSubdir: 'directions/common',
    priority: 8,
  },
  {
    slug: 'directions-plastic',
    label: 'Directions (Plastic)',
    urlPath: '/directions-issued/',
    pdfSubdir: 'directions/plastic',
    priority: 9,
  },

  // Reports & Guidelines
  {
    slug: 'fortnightly-reports',
    label: 'Fortnightly Reports',
    urlPath: '/fortnightly-reports/',
    pdfSubdir: 'reports/fortnightly',
    priority: 10,
  },
  {
    slug: 'technical-guidelines',
    label: 'Technical Guidelines/SOPs',
    urlPath: '/cpcb-technical-guidelines-sops/',
    pdfSubdir: 'guidelines',
    priority: 11,
  },
  {
    slug: 'reports-current',
    label: 'Reports (Current)',
    urlPath: '/report.php',
    pdfSubdir: 'reports/current',
    priority: 12,
  },
  {
    slug: 'reports-archive',
    label: 'Reports (Archive)',
    urlPath: '/archivereport.php',
    pdfSubdir: 'reports/archive',
    priority: 13,
  },
  {
    slug: 'annual-reports',
    label: 'Annual Reports',
    urlPath: '/annual-report.php',
    pdfSubdir: 'reports/annual',
    priority: 14,
  },

  // Standards & Regulations
  {
    slug: 'circulars',
    label: 'Circulars',
    urlPath: '/circular.php',
    pdfSubdir: 'circulars',
    priority: 15,
  },
  {
    slug: 'effluent-emission',
    label: 'Effluent/Emission Standards',
    urlPath: '/effluent-emission/',
    pdfSubdir: 'standards/effluent-emission',
    priority: 16,
  },
  {
    slug: 'env-protection-act',
    label: 'Environmental Acts',
    urlPath: '/env-protection-act/',
    pdfSubdir: 'acts',
    priority: 17,
  },
  {
    slug: 'air-quality-standards',
    label: 'Air Quality Standards',
    urlPath: '/air-quality-standard/',
    pdfSubdir: 'standards/air-quality',
    priority: 18,
  },
  {
    slug: 'water-quality-standards',
    label: 'Water Quality Standards',
    urlPath: '/wqstandards/',
    pdfSubdir: 'standards/water-quality',
    priority: 19,
  },

  // Rules
  {
    slug: 'rules-hw',
    label: 'Hazardous Waste Rules',
    urlPath: '/rules/',
    pdfSubdir: 'rules/hazardous-waste',
    priority: 20,
  },
  {
    slug: 'rules-ewaste',
    label: 'E-Waste Rules',
    urlPath: '/rules-2/',
    pdfSubdir: 'rules/ewaste',
    priority: 21,
  },
  {
    slug: 'rules-msw',
    label: 'Municipal Solid Waste Rules',
    urlPath: '/rules-3/',
    pdfSubdir: 'rules/msw',
    priority: 22,
  },
  {
    slug: 'rules-bmw',
    label: 'Bio-Medical Waste Rules',
    urlPath: '/rules-4/',
    pdfSubdir: 'rules/bmw',
    priority: 23,
  },
  {
    slug: 'rules-plastic',
    label: 'Plastic Waste Rules',
    urlPath: '/rules-5/',
    pdfSubdir: 'rules/plastic',
    priority: 24,
  },
  {
    slug: 'rules-batteries',
    label: 'Batteries Rules',
    urlPath: '/rules-6/',
    pdfSubdir: 'rules/batteries',
    priority: 25,
  },
  {
    slug: 'rules-crz',
    label: 'CRZ Rules',
    urlPath: '/rules-7/',
    pdfSubdir: 'rules/crz',
    priority: 26,
  },
  {
    slug: 'rules-eia',
    label: 'EIA Rules',
    urlPath: '/rules-9/',
    pdfSubdir: 'rules/eia',
    priority: 27,
  },
  {
    slug: 'rules-fly-ash',
    label: 'Fly Ash Rules',
    urlPath: '/rules-10/',
    pdfSubdir: 'rules/fly-ash',
    priority: 28,
  },

  // NGT
  {
    slug: 'ngt-court-matters',
    label: 'NGT Court Matters',
    urlPath: '/ngt-court-matters/',
    pdfSubdir: 'ngt/court-matters',
    priority: 29,
  },
  {
    slug: 'ngt-court-cases',
    label: 'NGT Court Cases',
    urlPath: '/ngt-court-cases/',
    pdfSubdir: 'ngt/court-cases',
    priority: 30,
  },
  {
    slug: 'ngt-committees',
    label: 'NGT Committees',
    urlPath: '/ngt-committees/',
    pdfSubdir: 'ngt/committees',
    priority: 31,
  },
  {
    slug: 'ngt-bmw',
    label: 'Court/NGT Matter (BMW)',
    urlPath: '/court-ngt-matter/',
    pdfSubdir: 'ngt/bmw',
    priority: 32,
  },

  // Publications & Misc
  {
    slug: 'publications',
    label: 'Publications',
    urlPath: '/publication.php',
    pdfSubdir: 'publications',
    priority: 33,
  },
  {
    slug: 'announcements',
    label: 'Important Announcements',
    urlPath: '/important-announcements.php',
    pdfSubdir: 'announcements',
    priority: 34,
  },
];

// Publication sub-categories (pid=base64(1) through base64(18))
const PUBLICATION_SUBCATS = [
  { pid: 1, name: 'CUPS', label: 'Comprehensive Environmental Pollution Index' },
  { pid: 2, name: 'PROBES', label: 'Programme on Biological Studies' },
  { pid: 3, name: 'COINDS', label: 'Comprehensive Industry Documents' },
  { pid: 4, name: 'ADSORBS', label: 'Assessment & Development of Standards' },
  { pid: 5, name: 'COPOCS', label: 'Control of Pollution from Operations' },
  { pid: 6, name: 'LATS', label: 'Laboratory Analytical Techniques' },
  { pid: 7, name: 'MINARS', label: 'Minimal National Standards' },
  { pid: 8, name: 'NAAQMS', label: 'National Ambient Air Quality Monitoring' },
  { pid: 9, name: 'EIAS', label: 'Environmental Impact Assessment' },
  { pid: 10, name: 'PCLS', label: 'Pollution Control Law Series' },
  { pid: 11, name: 'HAZWAMS', label: 'Hazardous Waste Management' },
  { pid: 12, name: 'RERES', label: 'Research & Development' },
  { pid: 13, name: 'GWQS', label: 'Ground Water Quality Standards' },
  { pid: 14, name: 'IMPACTS', label: 'Impact Assessment' },
  { pid: 15, name: 'EMAPS', label: 'Environmental Mapping' },
  { pid: 16, name: 'NEWSLTR', label: 'Newsletter/Parivesh' },
  { pid: 17, name: 'MISC', label: 'Miscellaneous Publications' },
  { pid: 18, name: 'OTHER', label: 'Other Publications' },
];

interface CpcbDocument {
  id: string;
  title: string;
  date: string | null;
  date_iso: string | null;
  category: string;
  category_slug: CategorySlug;
  sub_category: string | null;
  issued_to: string | null;
  act: string | null;
  direction_type: string | null;
  state: string | null;
  division: string | null;
  pdf_url: string;
  pdf_filename: string;
  pdf_size_bytes: number;
  source_url: string;
  regulator: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  lastRun: string;
  categories_completed: string[];
  total_documents: number;
  total_pdfs: number;
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
let currentProgress: Progress = {
  lastRun: '',
  categories_completed: [],
  total_documents: 0,
  total_pdfs: 0,
};

function setupShutdownHandler(): void {
  const handler = () => {
    if (shuttingDown) {
      log('Force exit');
      process.exit(1);
    }
    shuttingDown = true;
    log('Shutting down gracefully... saving progress');
    saveProgress(currentProgress);
    process.exit(0);
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
    validateStatus: (s) => s < 500,
  });
}

// ─── Progress Management ─────────────────────────────────────────────────────

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { lastRun: '', categories_completed: [], total_documents: 0, total_pdfs: 0 };
}

function saveProgress(progress: Progress): void {
  const updated = { ...progress, lastRun: new Date().toISOString() };
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(updated, null, 2));
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

function generateId(slug: CategorySlug, index: number, title: string): string {
  const titleSlug = sanitizeFilename(title).toLowerCase().slice(0, 40);
  return `cpcb_${slug}_${index}_${titleSlug}`;
}

function parseDate(dateStr: string): { date: string; date_iso: string | null } {
  if (!dateStr || dateStr.trim() === '') return { date: '', date_iso: null };

  const cleaned = dateStr.trim();

  // Try DD/MM/YYYY or DD-MM-YYYY
  const dmy = cleaned.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return {
      date: cleaned,
      date_iso: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
    };
  }

  // Try "DD Mon YYYY" or "DD Month YYYY"
  const months: Record<string, string> = {
    jan: '01',
    january: '01',
    feb: '02',
    february: '02',
    mar: '03',
    march: '03',
    apr: '04',
    april: '04',
    may: '05',
    jun: '06',
    june: '06',
    jul: '07',
    july: '07',
    aug: '08',
    august: '08',
    sep: '09',
    september: '09',
    oct: '10',
    october: '10',
    nov: '11',
    november: '11',
    dec: '12',
    december: '12',
  };
  const dMonY = cleaned.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (dMonY) {
    const [, d, mon, y] = dMonY;
    const m = months[mon.toLowerCase()];
    if (m) {
      return {
        date: cleaned,
        date_iso: `${y}-${m}-${d.padStart(2, '0')}`,
      };
    }
  }

  // Try "Month DD, YYYY"
  const monDY = cleaned.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monDY) {
    const [, mon, d, y] = monDY;
    const m = months[mon.toLowerCase()];
    if (m) {
      return {
        date: cleaned,
        date_iso: `${y}-${m}-${d.padStart(2, '0')}`,
      };
    }
  }

  return { date: cleaned, date_iso: null };
}

function loadDownloadedSet(): Set<string> {
  if (fs.existsSync(PDF_DONE_FILE)) {
    const lines = fs.readFileSync(PDF_DONE_FILE, 'utf-8').split('\n').filter(Boolean);
    return new Set(lines);
  }
  return new Set();
}

function appendDownloaded(url: string): void {
  fs.appendFileSync(PDF_DONE_FILE, url + '\n');
}

function appendFailed(url: string, reason: string): void {
  fs.appendFileSync(PDF_FAILED_FILE, `${url}\t${reason}\n`);
}

// ─── Document Extraction ─────────────────────────────────────────────────────

function extractFromTable(
  html: string,
  slug: CategorySlug,
  sourceUrl: string,
  subCategory: string | null = null,
): CpcbDocument[] {
  const $ = cheerio.load(html);
  const docs: CpcbDocument[] = [];
  const seenUrls = new Set<string>();
  let index = 0;

  // Strategy 1: Find DataTables or standard HTML tables with PDF links
  $('table').each((_tableIdx, table) => {
    const $table = $(table);

    // Get header columns to understand table structure
    const headers: string[] = [];
    $table.find('thead th, thead td, tr:first-child th, tr:first-child td').each((_i, th) => {
      headers.push($(th).text().trim().toLowerCase());
    });

    // Skip non-data tables (nav, layout)
    const hasDownload = headers.some(
      (h) =>
        h.includes('download') || h.includes('pdf') || h.includes('view') || h.includes('link'),
    );
    const hasSubject = headers.some(
      (h) =>
        h.includes('subject') ||
        h.includes('title') ||
        h.includes('name') ||
        h.includes('description'),
    );

    // If no recognizable headers, check if table has PDF links at all
    const tableHasPdfs =
      $table.find('a[href*="openpdffile"], a[href*=".pdf"], a[href*="displaypdf"]').length > 0;
    if (!hasDownload && !hasSubject && !tableHasPdfs) return;

    // Determine column indices
    const colMap = {
      sno: headers.findIndex(
        (h) => h.includes('s.no') || h.includes('s no') || h.includes('sl') || h === '#',
      ),
      issuedTo: headers.findIndex((h) => h.includes('issued to') || h.includes('issued')),
      act: headers.findIndex((h) => h.includes('act') || h.includes('legislation')),
      subject: headers.findIndex(
        (h) =>
          h.includes('subject') ||
          h.includes('title') ||
          h.includes('name') ||
          h.includes('description'),
      ),
      directionType: headers.findIndex((h) => h.includes('direction type') || h.includes('type')),
      state: headers.findIndex((h) => h.includes('state') || h.includes('region')),
      date: headers.findIndex((h) => h.includes('date') || h.includes('year')),
      download: headers.findIndex(
        (h) =>
          h.includes('download') || h.includes('pdf') || h.includes('view') || h.includes('link'),
      ),
      division: headers.findIndex((h) => h.includes('division') || h.includes('department')),
      category: headers.findIndex((h) => h.includes('category')),
    };

    // Parse data rows (skip header row)
    const rows = $table.find('tbody tr, tr').toArray();
    const startRow = headers.length > 0 ? 0 : 1; // skip first row if it was headers

    for (const row of rows) {
      const $row = $(row);
      const cells = $row.find('td').toArray();
      if (cells.length < 2) continue;

      // Skip header-like rows
      const firstCellText = $(cells[0]).text().trim().toLowerCase();
      if (
        firstCellText.includes('s.no') ||
        firstCellText.includes('subject') ||
        firstCellText === '#'
      )
        continue;

      // Extract fields from columns
      const getCellText = (idx: number): string =>
        idx >= 0 && idx < cells.length ? $(cells[idx]).text().trim() : '';

      const subject = getCellText(colMap.subject) || getCellText(1); // fallback to 2nd column
      const issuedTo = getCellText(colMap.issuedTo);
      const act = getCellText(colMap.act);
      const directionType = getCellText(colMap.directionType);
      const state = getCellText(colMap.state);
      const dateStr = getCellText(colMap.date);
      const division = getCellText(colMap.division);

      // Find all PDF links in this row
      $row
        .find('a[href*="openpdffile"], a[href*=".pdf"], a[href*="displaypdf"]')
        .each((_j, link) => {
          const href = $(link).attr('href');
          if (!href) return;

          const fullUrl = resolveUrl(href);
          if (seenUrls.has(fullUrl)) return;
          seenUrls.add(fullUrl);

          const title =
            subject || $(link).attr('title') || $(link).text().trim() || `Document ${index + 1}`;
          const { date, date_iso } = parseDate(dateStr);

          index++;
          docs.push({
            id: generateId(slug, index, title),
            title,
            date,
            date_iso,
            category: slug.replace(/-/g, ' '),
            category_slug: slug,
            sub_category: subCategory,
            issued_to: issuedTo || null,
            act: act || null,
            direction_type: directionType || null,
            state: state || null,
            division: division || null,
            pdf_url: fullUrl,
            pdf_filename: sanitizeFilename(title) + '.pdf',
            pdf_size_bytes: 0,
            source_url: sourceUrl,
            regulator: 'CPCB',
            country: 'IN',
            scraped_at: new Date().toISOString(),
          });
        });
    }
  });

  // Strategy 2: If no table docs found, scan for any PDF links on the page
  if (docs.length === 0) {
    $('a[href*="openpdffile"], a[href*=".pdf"], a[href*="displaypdf"]').each((_i, link) => {
      const href = $(link).attr('href');
      if (!href) return;

      const fullUrl = resolveUrl(href);
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      // Skip navigation/header/footer links
      const linkText = $(link).text().trim();
      if (linkText.length < 2) return;

      let title = linkText;
      // Try parent element for better context
      if (
        title.toLowerCase() === 'download' ||
        title.toLowerCase() === 'view' ||
        title.toLowerCase() === 'click here'
      ) {
        const parent = $(link).closest('td, li, div, p');
        title = parent.text().trim().split('\n')[0]?.trim() || title;
      }

      const { date, date_iso } = parseDate('');
      index++;
      docs.push({
        id: generateId(slug, index, title),
        title,
        date,
        date_iso,
        category: slug.replace(/-/g, ' '),
        category_slug: slug,
        sub_category: subCategory,
        issued_to: null,
        act: null,
        direction_type: null,
        state: null,
        division: null,
        pdf_url: fullUrl,
        pdf_filename: sanitizeFilename(title) + '.pdf',
        pdf_size_bytes: 0,
        source_url: sourceUrl,
        regulator: 'CPCB',
        country: 'IN',
        scraped_at: new Date().toISOString(),
      });
    });
  }

  return docs;
}

// ─── Fetch with Retry ────────────────────────────────────────────────────────

async function fetchWithRetry(
  client: AxiosInstance,
  url: string,
  retries: number = MAX_RETRIES,
): Promise<string | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await client.get(url, { timeout: PAGE_TIMEOUT_MS });
      if (resp.status === 200) return resp.data as string;
      logError(`HTTP ${resp.status} for ${url}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        log(`  Retry ${attempt + 1}/${retries} for ${url}: ${errMsg}`);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
        logError(`Failed after ${retries + 1} attempts: ${url} — ${errMsg}`);
      }
    }
  }
  return null;
}

// ─── PDF Download ────────────────────────────────────────────────────────────

async function downloadPdf(
  client: AxiosInstance,
  doc: CpcbDocument,
  outputDir: string,
): Promise<boolean> {
  const filePath = path.join(outputDir, doc.pdf_filename);

  // Skip if already exists and non-empty
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (stat.size > 100) return true;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await client.get(doc.pdf_url, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        headers: { Accept: 'application/pdf,*/*' },
      });

      if (resp.status !== 200) {
        logError(`  PDF HTTP ${resp.status}: ${doc.pdf_url}`);
        continue;
      }

      let buffer = Buffer.from(resp.data);

      // CPCB wraps PDFs in HTML: <html><head>...</head><body>\n%PDF-...
      // Strip the HTML wrapper if present
      const htmlHeader = buffer.slice(0, 6).toString('ascii');
      if (htmlHeader.startsWith('<html') || htmlHeader.startsWith('<HTML')) {
        const pdfMarker = buffer.indexOf('%PDF-');
        if (pdfMarker > 0) {
          buffer = buffer.slice(pdfMarker);
        }
      }

      // Validate PDF
      if (buffer.length < 100) {
        logError(`  PDF too small (${buffer.length}B): ${doc.pdf_url}`);
        continue;
      }

      const header = buffer.slice(0, 5).toString('ascii');
      if (header !== '%PDF-') {
        logError(`  Not a PDF (header: ${header}): ${doc.pdf_url}`);
        continue;
      }

      fs.writeFileSync(filePath, buffer);
      return true;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
        logError(`  PDF download failed: ${doc.pdf_url} — ${errMsg}`);
      }
    }
  }
  return false;
}

// ─── Scrape Category ─────────────────────────────────────────────────────────

async function scrapeCategory(
  client: AxiosInstance,
  page: PageConfig,
  testMode: boolean,
): Promise<CpcbDocument[]> {
  const url = `${BASE_URL}${page.urlPath}`;
  log(`Scraping: ${page.label} — ${url}`);

  const html = await fetchWithRetry(client, url);
  if (!html) {
    logError(`  Failed to fetch ${page.label}`);
    return [];
  }

  const docs = extractFromTable(html, page.slug, url);
  log(`  Found ${docs.length} documents in ${page.label}`);

  if (testMode && docs.length > 3) {
    return docs.slice(0, 3);
  }

  return docs;
}

// ─── Scrape Publications (sub-categories) ────────────────────────────────────

async function scrapePublications(
  client: AxiosInstance,
  testMode: boolean,
): Promise<CpcbDocument[]> {
  const allDocs: CpcbDocument[] = [];

  for (const subcat of PUBLICATION_SUBCATS) {
    if (shuttingDown) break;

    // pid is base64(integer)
    const pid = Buffer.from(String(subcat.pid)).toString('base64');
    const url = `${BASE_URL}/publication-details.php?pid=${pid}`;
    log(`  Publications sub-category: ${subcat.name} (${subcat.label})`);

    const html = await fetchWithRetry(client, url);
    if (!html) {
      logError(`  Failed to fetch publication ${subcat.name}`);
      continue;
    }

    const docs = extractFromTable(html, 'publications', url, subcat.name);
    log(`    Found ${docs.length} docs in ${subcat.name}`);

    if (testMode && docs.length > 2) {
      allDocs.push(...docs.slice(0, 2));
    } else {
      allDocs.push(...docs);
    }

    await sleep(DELAY_MS);
  }

  return allDocs;
}

// ─── Write JSONL ─────────────────────────────────────────────────────────────

function appendJsonl(docs: CpcbDocument[]): void {
  const lines = docs.map((d) => JSON.stringify(d)).join('\n');
  if (lines) {
    fs.appendFileSync(JSONL_FILE, lines + '\n');
  }
}

function writeCategoryMetadata(slug: string, docs: CpcbDocument[]): void {
  const metaPath = path.join(METADATA_DIR, `${slug}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(docs, null, 2));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');
  const categoryFilter = args.includes('--category') ? args[args.indexOf('--category') + 1] : null;

  log('═══════════════════════════════════════════════');
  log('  CPCB Scraper - Central Pollution Control Board');
  log(
    `  Mode: ${testMode ? 'TEST' : downloadOnly ? 'DOWNLOAD-ONLY' : metadataOnly ? 'METADATA-ONLY' : 'FULL'}`,
  );
  if (categoryFilter) log(`  Category filter: ${categoryFilter}`);
  log('═══════════════════════════════════════════════');

  // Create directories
  for (const dir of [DATA_DIR, PDFS_DIR, METADATA_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  setupShutdownHandler();
  currentProgress = loadProgress();

  const client = createClient();
  const downloadedSet = loadDownloadedSet();
  let allDocs: CpcbDocument[] = [];

  if (downloadOnly) {
    // Load existing metadata
    if (!fs.existsSync(JSONL_FILE)) {
      logError('No metadata file found. Run without --download-only first.');
      process.exit(1);
    }
    const lines = fs.readFileSync(JSONL_FILE, 'utf-8').split('\n').filter(Boolean);
    allDocs = lines.map((l) => JSON.parse(l) as CpcbDocument);
    log(`Loaded ${allDocs.length} documents from metadata`);
  } else {
    // Clear JSONL for fresh run (unless resuming)
    if (currentProgress.categories_completed.length === 0 && fs.existsSync(JSONL_FILE)) {
      fs.unlinkSync(JSONL_FILE);
    }

    // Scrape each category
    const pagesToScrape = categoryFilter
      ? PAGES.filter((p) => p.slug === categoryFilter || p.slug.startsWith(categoryFilter))
      : PAGES;

    for (const page of pagesToScrape) {
      if (shuttingDown) break;

      // Skip completed categories (resume support)
      if (currentProgress.categories_completed.includes(page.slug)) {
        log(`Skipping (already done): ${page.label}`);
        continue;
      }

      let docs: CpcbDocument[];

      if (page.slug === 'publications') {
        docs = await scrapePublications(client, testMode);
      } else {
        docs = await scrapeCategory(client, page, testMode);
      }

      if (docs.length > 0) {
        appendJsonl(docs);
        writeCategoryMetadata(page.slug, docs);
        allDocs.push(...docs);
      }

      currentProgress.categories_completed.push(page.slug);
      currentProgress.total_documents += docs.length;
      saveProgress(currentProgress);

      await sleep(DELAY_MS);
    }

    log(`\nMetadata extraction complete: ${allDocs.length} documents`);
  }

  if (metadataOnly) {
    log('Metadata-only mode — skipping PDF downloads');
    printSummary(allDocs);
    return;
  }

  // Download PDFs
  log('\n─── PDF Downloads ───');

  const toDownload = allDocs.filter((d) => !downloadedSet.has(d.pdf_url));
  log(`${toDownload.length} PDFs to download (${downloadedSet.size} already done)`);

  let downloaded = 0;
  let failed = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    if (shuttingDown) break;

    const batch = toDownload.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (doc) => {
        const pdfDir = path.join(PDFS_DIR, doc.category_slug);
        fs.mkdirSync(pdfDir, { recursive: true });

        const ok = await downloadPdf(client, doc, pdfDir);
        if (ok) {
          appendDownloaded(doc.pdf_url);
          downloaded++;
        } else {
          appendFailed(doc.pdf_url, 'download-failed');
          failed++;
        }
        return ok;
      }),
    );

    if ((i + CONCURRENCY) % 50 === 0 || i + CONCURRENCY >= toDownload.length) {
      log(
        `  Progress: ${downloaded + failed}/${toDownload.length} (${downloaded} ok, ${failed} failed)`,
      );
    }

    await sleep(PDF_DELAY_MS);
  }

  currentProgress.total_pdfs = downloaded;
  saveProgress(currentProgress);

  log(`\nPDF downloads complete: ${downloaded} downloaded, ${failed} failed`);
  printSummary(allDocs);
}

function printSummary(docs: CpcbDocument[]): void {
  log('\n═══════════════════════════════════════════════');
  log('  Summary');
  log('═══════════════════════════════════════════════');

  // Group by category
  const byCat: Record<string, number> = {};
  for (const d of docs) {
    byCat[d.category_slug] = (byCat[d.category_slug] || 0) + 1;
  }

  for (const [cat, count] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    log(`  ${cat}: ${count}`);
  }

  log(`\n  Total: ${docs.length} documents`);
  log(`  Output: ${JSONL_FILE}`);
  log(`  PDFs:   ${PDFS_DIR}/`);
  log('═══════════════════════════════════════════════');
}

main().catch((err) => {
  logError(`Fatal: ${err}`);
  process.exit(1);
});
