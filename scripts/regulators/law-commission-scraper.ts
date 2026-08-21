/**
 * Law Commission of India Scraper
 * Downloads all reports (1-289+), consultation papers, working papers, and documents
 * from lawcommissionofindia.nic.in
 *
 * Content:
 *   - 22 Law Commission terms → ~350+ report PDFs (1955-2024)
 *   - Archives → consultation papers, questionnaires, working papers
 *   - Documents → annual reports, gazette notifications
 *
 * All PDFs hosted on S3 CDN: cdnbbsr.s3waas.gov.in (fast, no auth)
 *
 * Usage:
 *   npx tsx scripts/law-commission-scraper.ts                    # Full run
 *   npx tsx scripts/law-commission-scraper.ts --metadata-only    # Extract links only
 *   npx tsx scripts/law-commission-scraper.ts --download-only    # Download from metadata
 *   npx tsx scripts/law-commission-scraper.ts --test             # Test (3 PDFs)
 *
 * Environment:
 *   DELAY_MS=100          Delay between downloads (default: 100)
 *   CONCURRENCY=10        Parallel downloads (default: 10)
 *   DATA_DIR=data/legal-sources/law-commission   Output directory
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://lawcommissionofindia.nic.in';
const DELAY_MS = parseInt(process.env.DELAY_MS || '100', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 30_000;

const DATA_DIR = path.resolve(
  __dirname,
  '..',
  process.env.DATA_DIR || 'data/legal-sources/law-commission',
);
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const ALL_METADATA_JSONL = path.join(DATA_DIR, 'law-commission-all-metadata.jsonl');

// ─── Commission Pages ────────────────────────────────────────────────────────

interface CommissionConfig {
  ordinal: string;
  slug: string;
  reportRange: string;
  pdfSubdir: string;
}

const COMMISSIONS: CommissionConfig[] = [
  { ordinal: '1st', slug: 'report_first', reportRange: '1-14', pdfSubdir: 'reports/01-first' },
  { ordinal: '2nd', slug: 'report_second', reportRange: '15-22', pdfSubdir: 'reports/02-second' },
  { ordinal: '3rd', slug: 'report_third', reportRange: '23-28', pdfSubdir: 'reports/03-third' },
  { ordinal: '4th', slug: 'report_fourth', reportRange: '29-38', pdfSubdir: 'reports/04-fourth' },
  { ordinal: '5th', slug: 'report_fifth', reportRange: '39-44', pdfSubdir: 'reports/05-fifth' },
  { ordinal: '6th', slug: 'report_sixth', reportRange: '45-50', pdfSubdir: 'reports/06-sixth' },
  { ordinal: '7th', slug: 'report_seventh', reportRange: '51-59', pdfSubdir: 'reports/07-seventh' },
  { ordinal: '8th', slug: 'report_eighth', reportRange: '60-67', pdfSubdir: 'reports/08-eighth' },
  { ordinal: '9th', slug: 'report_ninth', reportRange: '68-79', pdfSubdir: 'reports/09-ninth' },
  { ordinal: '10th', slug: 'report_tenth', reportRange: '80-97', pdfSubdir: 'reports/10-tenth' },
  {
    ordinal: '11th',
    slug: 'report_eleventh',
    reportRange: '98-109',
    pdfSubdir: 'reports/11-eleventh',
  },
  {
    ordinal: '12th',
    slug: 'report_twelfth',
    reportRange: '110-120',
    pdfSubdir: 'reports/12-twelfth',
  },
  {
    ordinal: '13th',
    slug: 'report_thirteenth',
    reportRange: '121-147',
    pdfSubdir: 'reports/13-thirteenth',
  },
  {
    ordinal: '14th',
    slug: 'report_fourteenth',
    reportRange: '148-160',
    pdfSubdir: 'reports/14-fourteenth',
  },
  {
    ordinal: '15th',
    slug: 'report_fifteenth',
    reportRange: '161-179',
    pdfSubdir: 'reports/15-fifteenth',
  },
  {
    ordinal: '16th',
    slug: 'report_sixteenth',
    reportRange: '180-186',
    pdfSubdir: 'reports/16-sixteenth',
  },
  {
    ordinal: '17th',
    slug: 'report_seventeenth',
    reportRange: '187-201',
    pdfSubdir: 'reports/17-seventeenth',
  },
  {
    ordinal: '18th',
    slug: 'report_eighteenth',
    reportRange: '202-234',
    pdfSubdir: 'reports/18-eighteenth',
  },
  {
    ordinal: '19th',
    slug: 'report_nineteenth',
    reportRange: '235-243',
    pdfSubdir: 'reports/19-nineteenth',
  },
  {
    ordinal: '20th',
    slug: 'report_twentieth',
    reportRange: '244-262',
    pdfSubdir: 'reports/20-twentieth',
  },
  {
    ordinal: '21st',
    slug: 'report_twentyfirst',
    reportRange: '263-277',
    pdfSubdir: 'reports/21-twentyfirst',
  },
  {
    ordinal: '22nd',
    slug: 'report_twentysecond',
    reportRange: '278-289',
    pdfSubdir: 'reports/22-twentysecond',
  },
];

// Additional pages to scrape
const EXTRA_PAGES = [
  { label: 'Archives (Consultation Papers)', url: '/archives/', pdfSubdir: 'consultation-papers' },
  {
    label: 'ADR & Case Management Conference',
    url: '/archive_goto/',
    pdfSubdir: 'consultation-papers',
  },
  { label: 'Documents (Page 1)', url: '/documents/', pdfSubdir: 'documents' },
  { label: 'Documents (Page 2)', url: '/documents/page/2', pdfSubdir: 'documents' },
];

// 29 category pages — these have Hindi versions of reports not on commission pages
const CATEGORY_PAGES = [
  'cat_Indian_Penal_Code',
  'cat_Code_of_Criminal_Procedure',
  'cat_Evidence',
  'cat_New',
  'cat_Marriage_Divorce_Maintenance',
  'cat_Custody',
  'cat_Succession',
  'cat_Code_of_Civil_Procedure',
  'cat_ELECTORAL_REFORMS',
  'cat_Registration_Act',
  'cat_Arbitration',
  'cat_Tribunals',
  'cat_Supreme_Court_And_High_Court',
  'cat_Constitution',
  'cat_Mass_Media',
  'cat_Obsolete_Laws',
  'cat_Legal_Profession',
  'cat_Specific_Relief_Act',
  'cat_Transfer_of_property_Act',
  'cat_Land_Acquisition',
  'cat_motor_vehicles',
  'cat_Prisoners',
  'cat_Public_Sector_Undertaking',
  'cat_Sale_of_Goods',
  'cat_Stamp',
  'cat_Sales_Tax',
  'cat_General_Clauses_Act',
  'cat_Contract',
  'cat_Income_Tax',
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface PdfEntry {
  reportNumber: string | null;
  title: string;
  url: string;
  commission: string;
  source: string; // 'report' | 'consultation' | 'document' | 'archive'
  chairman: string | null;
  tenure: string | null;
  year?: string | null;
  date?: string | null;
  filename: string;
  downloaded: boolean;
  downloadedAt: string | null;
  fileSizeBytes: number | null;
}

interface Progress {
  lastRun: string;
  completedDownloads: string[];
  stats: Record<string, { extracted: number; downloaded: number }>;
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

// ─── Progress ────────────────────────────────────────────────────────────────

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { lastRun: '', completedDownloads: [], stats: {} };
}

function saveProgress(progress: Progress): void {
  progress.lastRun = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  maxSockets: CONCURRENCY + 5,
});

async function fetchPage(url: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(url, {
        timeout: PAGE_TIMEOUT_MS,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,*/*',
        },
        httpsAgent,
        maxRedirects: 5,
      });
      return resp.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        log(`  Retry ${attempt}/${MAX_RETRIES} fetching page: ${msg}`);
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES} attempts: ${msg}`);
      }
    }
  }
  throw new Error('Unreachable');
}

// ─── PDF Link Extraction ─────────────────────────────────────────────────────

function extractReportPdfs(html: string, commission: CommissionConfig): PdfEntry[] {
  const $ = cheerio.load(html);
  const entries: PdfEntry[] = [];
  const seenUrls = new Set<string>();

  // Extract chairman and tenure from <caption> tag
  // Format: "(Chairman Mr. M. C. Setalvad 1955-1958)" or "(Chairman, Justice Ritu Raj Awasthi 2020-2024)"
  let chairman: string | null = null;
  let tenure: string | null = null;
  const captionText = $('table.data-table-1 caption').text().trim();
  if (captionText) {
    const captionMatch = captionText.match(
      /Chairman[,\s]+(?:Mr\.?\s*|Mrs\.?\s*|Justice\s+|Dr\.?\s*|Prof\.?\s*|Shri\.?\s*|Smt\.?\s*)?(.+?)\s+(\d{4}\s*[-–]\s*\d{4})/i,
    );
    if (captionMatch) {
      chairman = captionMatch[1].replace(/\s+/g, ' ').trim();
      tenure = captionMatch[2].replace(/\s+/g, '').trim();
    } else {
      // Try without tenure
      const nameOnly = captionText.match(
        /Chairman[,\s]+(?:Mr\.?\s*|Mrs\.?\s*|Justice\s+|Dr\.?\s*|Prof\.?\s*|Shri\.?\s*|Smt\.?\s*)?(.+?)\s*\)?\s*$/i,
      );
      if (nameOnly) chairman = nameOnly[1].replace(/\s+/g, ' ').trim();
    }
  }

  // Walk each table row to extract structured data
  // Table format: Report No. | Subject | Year | Download pdf
  $('table.data-table-1 tbody tr').each((_i, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 3) return;

    // Determine if this is a 4-column report table or 3-column
    const is4Col = cells.length >= 4;

    // Extract structured fields from table cells
    const reportNumText = is4Col ? cells.eq(0).text().trim() : null;
    const subjectText = is4Col ? cells.eq(1).text().trim() : cells.eq(1).text().trim();
    const yearText = is4Col ? cells.eq(2).text().trim() : null;
    const linkCell = is4Col ? cells.eq(3) : cells.eq(2);

    // Extract report number (clean up dots, dashes etc)
    let reportNumber: string | null = null;
    if (reportNumText && /^\d+/.test(reportNumText)) {
      reportNumber = reportNumText.replace(/[.\s]/g, '');
      // Handle en-dash for non-report rows
      if (reportNumber === '–' || reportNumber === '-') reportNumber = null;
    }

    // Extract year (clean up sup tags like "17th March 2023")
    let year: string | null = null;
    if (yearText) {
      // Remove HTML entities and sup tags content, extract 4-digit year
      const cleanYear = yearText.replace(/\s+/g, ' ').trim();
      const yearMatch = cleanYear.match(/(\d{4})/);
      if (yearMatch) year = yearMatch[1];
    }

    // Find all PDF links in the download cell
    linkCell.find('a[href*=".pdf"]').each((_j, a) => {
      let href = $(a).attr('href');
      if (!href || !href.includes('.pdf')) return;

      // Normalize URL
      if (href.startsWith('//')) href = 'https:' + href;
      else if (href.startsWith('/')) href = BASE_URL + href;
      else if (!href.startsWith('http')) href = BASE_URL + '/' + href;

      if (seenUrls.has(href)) return;
      seenUrls.add(href);

      // Title comes from the Subject column, NOT the link text
      let title = subjectText || '';
      title = title.replace(/\s+/g, ' ').trim();

      // If subject cell is empty, try link text or aria-label
      if (!title || title.length < 3) {
        title = $(a).attr('aria-label') || $(a).text().trim();
        title = title.replace(/\s*\(\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes?)\)\s*/gi, ' ').trim();
      }

      // Last resort: use filename from URL
      if (!title || title.length < 3) {
        title = decodeURIComponent(path.basename(new URL(href).pathname)).replace(/\.pdf$/i, '');
      }

      // For multi-PDF rows (e.g., "Part 02 of Report No.1"), append part info
      const linkText = $(a).text().trim();
      const partMatch = linkText.match(/Part\s*(\d+)/i);
      if (partMatch && title) {
        title = `${title} (Part ${partMatch[1]})`;
      }

      // Build filename: prefer report-number prefix
      let filename: string;
      if (reportNumber) {
        const paddedNum = reportNumber.padStart(3, '0');
        const partSuffix = partMatch ? `-part${partMatch[1]}` : '';
        filename = `${paddedNum}-${sanitizeFilename(title)}${partSuffix}.pdf`;
      } else {
        const urlFilename = decodeURIComponent(path.basename(new URL(href).pathname));
        filename = urlFilename.endsWith('.pdf') ? urlFilename : sanitizeFilename(title) + '.pdf';
      }

      if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';

      entries.push({
        reportNumber,
        title,
        url: href,
        commission: `${commission.ordinal} Law Commission (${commission.reportRange})`,
        source: 'report',
        chairman,
        tenure,
        filename,
        downloaded: false,
        downloadedAt: null,
        fileSizeBytes: null,
        ...(year ? { year } : {}),
      });
    });
  });

  // Fallback: also find any PDF links NOT inside the table (loose links on page)
  $('a[href*=".pdf"]').each((_i, el) => {
    const inTable = $(el).closest('table.data-table-1').length > 0;
    if (inTable) return; // already handled above

    let href = $(el).attr('href');
    if (!href || !href.includes('.pdf')) return;

    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = BASE_URL + href;
    else if (!href.startsWith('http')) href = BASE_URL + '/' + href;

    if (seenUrls.has(href)) return;
    seenUrls.add(href);

    let title = $(el).attr('aria-label') || $(el).text().trim();
    title = title.replace(/\s*\(\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes?)\)\s*/gi, ' ').trim();
    if (!title || title.length < 3) {
      title = decodeURIComponent(path.basename(new URL(href).pathname)).replace(/\.pdf$/i, '');
    }

    const urlFilename = decodeURIComponent(path.basename(new URL(href).pathname));
    const filename = urlFilename.endsWith('.pdf') ? urlFilename : sanitizeFilename(title) + '.pdf';

    entries.push({
      reportNumber: null,
      title: title.replace(/\s+/g, ' ').trim(),
      url: href,
      commission: `${commission.ordinal} Law Commission (${commission.reportRange})`,
      source: 'report',
      chairman,
      tenure,
      filename,
      downloaded: false,
      downloadedAt: null,
      fileSizeBytes: null,
    });
  });

  return entries;
}

function extractGenericPdfs(html: string, label: string, source: string): PdfEntry[] {
  const $ = cheerio.load(html);
  const entries: PdfEntry[] = [];
  const seenUrls = new Set<string>();

  // Strategy 1: Walk table rows for structured data
  // Archives format: S.No. | Title/Archives | Download Link
  // Documents format: Title | Date | View/Download
  $('table tbody tr').each((_i, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 2) return;

    // Detect table type: documents have "role=rowheader" on first cell
    const isDocTable = cells.eq(0).attr('role') === 'rowheader';

    let title: string;
    let dateText: string | null = null;

    if (isDocTable) {
      // Documents: td[0]=Title, td[1]=Date, td[2]=Download
      title = cells.eq(0).text().trim();
      dateText = cells.eq(1).text().trim() || null;
    } else if (cells.length >= 3) {
      // Archives: td[0]=S.No., td[1]=Title, td[2]=Download
      title = cells.eq(1).text().trim();
    } else {
      // 2-column: td[0]=Title, td[1]=Download
      title = cells.eq(0).text().trim();
    }

    // Clean up title
    title = title.replace(/\s+/g, ' ').trim();

    // Find all PDF links in this row
    $(tr)
      .find('a[href*=".pdf"]')
      .each((_j, a) => {
        let href = $(a).attr('href');
        if (!href || !href.includes('.pdf')) return;

        if (href.startsWith('//')) href = 'https:' + href;
        else if (href.startsWith('/')) href = BASE_URL + href;
        else if (!href.startsWith('http')) href = BASE_URL + '/' + href;

        if (seenUrls.has(href)) return;
        seenUrls.add(href);

        // Use table row title, falling back to aria-label then link text
        let entryTitle = title;
        if (!entryTitle || entryTitle.length < 3) {
          const ariaLabel = $(a).attr('aria-label') || '';
          // aria-label format: "View, Budget Information 2025-2026 PDF 305 KB - opens in a new window"
          const ariaMatch = ariaLabel.match(/^View,\s*(.+?)\s*PDF/i);
          entryTitle = ariaMatch
            ? ariaMatch[1].trim()
            : ariaLabel.replace(/\s*-\s*opens in.*$/i, '').trim();
        }
        if (!entryTitle || entryTitle.length < 3) {
          entryTitle = $(a).text().trim();
          entryTitle = entryTitle
            .replace(/\s*\(\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes?)\)\s*/gi, ' ')
            .trim();
        }
        if (!entryTitle || entryTitle.length < 3) {
          entryTitle = decodeURIComponent(path.basename(new URL(href).pathname)).replace(
            /\.pdf$/i,
            '',
          );
        }

        // Detect Hindi/English variant from link text
        const linkText = $(a).text().trim();
        const langMatch = linkText.match(/(?:Accessible_?)?(Hindi|English)/i);
        if (langMatch) {
          entryTitle = `${entryTitle} (${langMatch[1]})`;
        }

        const urlFilename = decodeURIComponent(path.basename(new URL(href).pathname));
        const filename = urlFilename.endsWith('.pdf')
          ? urlFilename
          : sanitizeFilename(entryTitle) + '.pdf';

        entries.push({
          reportNumber: null,
          title: entryTitle.replace(/\s+/g, ' ').trim(),
          url: href,
          commission: label,
          source,
          chairman: null,
          tenure: null,
          filename,
          downloaded: false,
          downloadedAt: null,
          fileSizeBytes: null,
          ...(dateText ? { date: dateText } : {}),
        });
      });
  });

  // Strategy 2: Catch any PDF links NOT in tables (loose links in lists, paragraphs, etc.)
  $('a[href*=".pdf"]').each((_i, el) => {
    const inTable = $(el).closest('table').length > 0;
    if (inTable) return; // already handled above

    let href = $(el).attr('href');
    if (!href || !href.includes('.pdf')) return;

    if (href.startsWith('//')) href = 'https:' + href;
    else if (href.startsWith('/')) href = BASE_URL + href;
    else if (!href.startsWith('http')) href = BASE_URL + '/' + href;

    if (seenUrls.has(href)) return;
    seenUrls.add(href);

    // Try parent context for a better title
    let title = '';
    const parent = $(el).closest('li, .views-row, .field__item, p');
    if (parent.length) {
      title = parent.text().trim().split('\n')[0]?.trim() || '';
      title = title.replace(/\s*\(\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes?)\)\s*/gi, ' ').trim();
    }
    if (!title || title.length < 3) {
      title = $(el).attr('aria-label') || $(el).text().trim();
      title = title.replace(/\s*\(\d+(?:\.\d+)?\s*(?:KB|MB|GB|bytes?)\)\s*/gi, ' ').trim();
    }
    if (!title || title.length < 3) {
      title = decodeURIComponent(path.basename(new URL(href).pathname)).replace(/\.pdf$/i, '');
    }

    const urlFilename = decodeURIComponent(path.basename(new URL(href).pathname));
    const filename = urlFilename.endsWith('.pdf') ? urlFilename : sanitizeFilename(title) + '.pdf';

    entries.push({
      reportNumber: null,
      title: title.replace(/\s+/g, ' ').trim(),
      url: href,
      commission: label,
      source,
      chairman: null,
      tenure: null,
      filename,
      downloaded: false,
      downloadedAt: null,
      fileSizeBytes: null,
    });
  });

  return entries;
}

// ─── Parallel PDF Download ───────────────────────────────────────────────────

async function downloadPdf(entry: PdfEntry, outDir: string): Promise<boolean> {
  const outPath = path.join(outDir, entry.filename);

  // Skip if exists and valid
  if (fs.existsSync(outPath)) {
    const stats = fs.statSync(outPath);
    if (stats.size > 500) {
      entry.downloaded = true;
      entry.downloadedAt = new Date().toISOString();
      entry.fileSizeBytes = stats.size;
      return true;
    }
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (shuttingDown) return false;

    try {
      const resp = await axios.get(entry.url, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Accept: 'application/pdf,*/*',
        },
        httpsAgent,
        maxRedirects: 5,
      });

      const data = Buffer.from(resp.data);

      if (data.length < 100) {
        logError(`  ${entry.filename}: Too small (${data.length}B)`);
        return false;
      }

      // Validate PDF header
      const header = data.subarray(0, 5).toString('ascii');
      if (header !== '%PDF-') {
        logError(`  ${entry.filename}: Not PDF (header: ${header})`);
        return false;
      }

      fs.writeFileSync(outPath, data);
      entry.downloaded = true;
      entry.downloadedAt = new Date().toISOString();
      entry.fileSizeBytes = data.length;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        logError(`  Failed: ${entry.filename} - ${msg}`);
      }
    }
  }
  return false;
}

async function downloadBatch(
  entries: PdfEntry[],
  outDir: string,
  progress: Progress,
): Promise<{ downloaded: number; failed: number; skipped: number }> {
  fs.mkdirSync(outDir, { recursive: true });

  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  // Filter already completed
  const pending = entries.filter((e) => {
    if (progress.completedDownloads.includes(e.url)) {
      e.downloaded = true;
      skipped++;
      return false;
    }
    // Check file on disk
    const outPath = path.join(outDir, e.filename);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
      e.downloaded = true;
      e.fileSizeBytes = fs.statSync(outPath).size;
      progress.completedDownloads.push(e.url);
      skipped++;
      return false;
    }
    return true;
  });

  if (skipped > 0) log(`  Skipped ${skipped} already downloaded`);

  // Process in parallel batches
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    if (shuttingDown) break;

    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const ok = await downloadPdf(entry, outDir);
        if (ok) {
          progress.completedDownloads.push(entry.url);
          downloaded++;
          const sizeKb = entry.fileSizeBytes ? (entry.fileSizeBytes / 1024).toFixed(0) : '?';
          log(`  [${downloaded + skipped}/${entries.length}] ${entry.filename} (${sizeKb}KB)`);
        } else {
          failed++;
        }
        return ok;
      }),
    );

    // Small delay between batches
    if (i + CONCURRENCY < pending.length) await sleep(DELAY_MS);
  }

  return { downloaded, failed, skipped };
}

// ─── Metadata ────────────────────────────────────────────────────────────────

function saveMetadata(entries: PdfEntry[], name: string): void {
  const metaPath = path.join(METADATA_DIR, `${name}-metadata.json`);
  fs.writeFileSync(metaPath, JSON.stringify(entries, null, 2));
}

function loadAllMetadata(): PdfEntry[] {
  const all: PdfEntry[] = [];
  if (!fs.existsSync(METADATA_DIR)) return all;
  for (const file of fs.readdirSync(METADATA_DIR)) {
    if (file.endsWith('-metadata.json')) {
      const entries = JSON.parse(fs.readFileSync(path.join(METADATA_DIR, file), 'utf-8'));
      all.push(...entries);
    }
  }
  return all;
}

function writeAllMetadataJsonl(entries: PdfEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(ALL_METADATA_JSONL, lines + '\n');
  log(`Combined metadata: ${ALL_METADATA_JSONL} (${entries.length} entries)`);
}

// ─── Main Pipeline ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  setupShutdownHandler();

  const args = process.argv.slice(2);
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');
  const testMode = args.includes('--test');

  log('=== Law Commission of India Scraper ===');
  log(`Concurrency: ${CONCURRENCY} | Delay: ${DELAY_MS}ms | Retries: ${MAX_RETRIES}`);
  if (metadataOnly) log('Mode: metadata-only');
  if (downloadOnly) log('Mode: download-only');
  if (testMode) log('Mode: TEST (3 PDFs only)');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PDFS_DIR, { recursive: true });
  fs.mkdirSync(METADATA_DIR, { recursive: true });

  const progress = loadProgress();
  const allEntries: PdfEntry[] = [];
  let totalDownloaded = 0;
  let totalFailed = 0;

  if (downloadOnly) {
    // Load all existing metadata
    const loaded = loadAllMetadata();
    if (loaded.length === 0) {
      logError('No metadata found. Run without --download-only first.');
      process.exit(1);
    }
    log(`Loaded ${loaded.length} entries from metadata`);
    // Group by source directory and download
    const byDir = new Map<string, PdfEntry[]>();
    for (const e of loaded) {
      // Reconstruct output dir from commission/source info
      let dir = path.join(PDFS_DIR, 'other');
      if (e.source === 'report') {
        const comm = COMMISSIONS.find((c) => e.commission.startsWith(c.ordinal));
        if (comm) dir = path.join(PDFS_DIR, comm.pdfSubdir);
      } else if (e.source === 'consultation' || e.source === 'archive') {
        dir = path.join(PDFS_DIR, 'consultation-papers');
      } else if (e.source === 'document') {
        dir = path.join(PDFS_DIR, 'documents');
      }
      const existing = byDir.get(dir) || [];
      existing.push(e);
      byDir.set(dir, existing);
    }
    for (const [dir, entries] of byDir) {
      const { downloaded, failed } = await downloadBatch(entries, dir, progress);
      totalDownloaded += downloaded;
      totalFailed += failed;
    }
    allEntries.push(...loaded);
  } else {
    // ── Phase 1: Scrape all 22 commission report pages ──────────────────
    log(`\n${'═'.repeat(70)}`);
    log('PHASE 1: Law Commission Reports (22 commissions)');
    log(`${'═'.repeat(70)}`);

    for (const comm of COMMISSIONS) {
      if (shuttingDown) break;

      const pageUrl = `${BASE_URL}/${comm.slug}/`;
      log(`\n── ${comm.ordinal} Law Commission (Reports ${comm.reportRange}) ──`);
      log(`  Fetching: ${pageUrl}`);

      try {
        const html = await fetchPage(pageUrl);
        const entries = extractReportPdfs(html, comm);
        log(`  Found ${entries.length} PDFs`);

        saveMetadata(entries, comm.slug);
        allEntries.push(...entries);

        if (!metadataOnly && !shuttingDown) {
          const toDownload = testMode ? entries.slice(0, 3) : entries;
          const outDir = path.join(PDFS_DIR, comm.pdfSubdir);
          const { downloaded, failed } = await downloadBatch(toDownload, outDir, progress);
          totalDownloaded += downloaded;
          totalFailed += failed;

          progress.stats[comm.slug] = {
            extracted: entries.length,
            downloaded: downloaded + (entries.length - toDownload.length),
          };
          saveProgress(progress);
        }

        if (testMode && allEntries.length >= 3) {
          log('Test mode: stopping after first commission');
          break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`Failed ${comm.ordinal}: ${msg}`);
      }

      await sleep(200); // polite delay between page fetches
    }

    // ── Phase 2: Archives (consultation papers) ─────────────────────────
    if (!testMode && !shuttingDown) {
      log(`\n${'═'.repeat(70)}`);
      log('PHASE 2: Archives & Documents');
      log(`${'═'.repeat(70)}`);

      for (const page of EXTRA_PAGES) {
        if (shuttingDown) break;

        const pageUrl = `${BASE_URL}${page.url}`;
        log(`\n── ${page.label} ──`);
        log(`  Fetching: ${pageUrl}`);

        try {
          const html = await fetchPage(pageUrl);
          const source = page.pdfSubdir === 'consultation-papers' ? 'archive' : 'document';
          const entries = extractGenericPdfs(html, page.label, source);
          log(`  Found ${entries.length} PDFs`);

          // Deduplicate against existing entries
          const newEntries = entries.filter(
            (e) => !allEntries.some((existing) => existing.url === e.url),
          );
          log(`  New (deduplicated): ${newEntries.length}`);

          const metaName = page.pdfSubdir + (page.url.includes('page/2') ? '-p2' : '');
          saveMetadata(newEntries, metaName);
          allEntries.push(...newEntries);

          if (!metadataOnly && !shuttingDown) {
            const outDir = path.join(PDFS_DIR, page.pdfSubdir);
            const { downloaded, failed } = await downloadBatch(newEntries, outDir, progress);
            totalDownloaded += downloaded;
            totalFailed += failed;

            progress.stats[metaName] = {
              extracted: newEntries.length,
              downloaded,
            };
            saveProgress(progress);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(`Failed ${page.label}: ${msg}`);
        }
      }
    }

    // ── Phase 3: Category pages (Hindi versions + any missed PDFs) ──────
    if (!testMode && !shuttingDown) {
      log(`\n${'═'.repeat(70)}`);
      log('PHASE 3: Category Pages (29 categories — Hindi translations)');
      log(`${'═'.repeat(70)}`);

      const seenUrls = new Set(allEntries.map((e) => e.url));

      for (const catSlug of CATEGORY_PAGES) {
        if (shuttingDown) break;

        const catLabel = catSlug.replace('cat_', '').replace(/_/g, ' ');
        const pageUrl = `${BASE_URL}/${catSlug}/`;
        log(`\n── Category: ${catLabel} ──`);

        try {
          const html = await fetchPage(pageUrl);
          const entries = extractGenericPdfs(html, `Category: ${catLabel}`, 'report');
          log(`  Found ${entries.length} PDFs`);

          // Only keep new URLs we haven't seen
          const newEntries = entries.filter((e) => !seenUrls.has(e.url));
          for (const e of newEntries) seenUrls.add(e.url);
          log(`  New (deduplicated): ${newEntries.length}`);

          if (newEntries.length > 0) {
            saveMetadata(newEntries, catSlug);
            allEntries.push(...newEntries);

            if (!metadataOnly && !shuttingDown) {
              const outDir = path.join(PDFS_DIR, 'categories', catSlug.replace('cat_', ''));
              const { downloaded, failed } = await downloadBatch(newEntries, outDir, progress);
              totalDownloaded += downloaded;
              totalFailed += failed;

              progress.stats[catSlug] = { extracted: newEntries.length, downloaded };
              saveProgress(progress);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError(`Failed category ${catLabel}: ${msg}`);
        }

        await sleep(150);
      }
    }
  }

  // ── Write combined JSONL ────────────────────────────────────────────────
  writeAllMetadataJsonl(allEntries);
  saveProgress(progress);

  // ── Summary ─────────────────────────────────────────────────────────────
  log(`\n${'═'.repeat(70)}`);
  log('SUMMARY');
  log(`${'═'.repeat(70)}`);

  const downloadedCount = allEntries.filter((e) => e.downloaded).length;
  const totalSize = allEntries.reduce((sum, e) => sum + (e.fileSizeBytes || 0), 0);
  const totalSizeMb = (totalSize / (1024 * 1024)).toFixed(1);

  // By source
  const bySource = new Map<string, { total: number; downloaded: number }>();
  for (const e of allEntries) {
    const s = bySource.get(e.source) || { total: 0, downloaded: 0 };
    s.total++;
    if (e.downloaded) s.downloaded++;
    bySource.set(e.source, s);
  }
  for (const [source, stats] of bySource) {
    log(`  ${source}: ${stats.downloaded}/${stats.total}`);
  }

  log(`  TOTAL: ${downloadedCount}/${allEntries.length} PDFs (${totalSizeMb} MB)`);
  if (totalFailed > 0) log(`  Failed: ${totalFailed}`);
  log(`\n  Metadata: ${ALL_METADATA_JSONL}`);
  log(`  PDFs: ${PDFS_DIR}/`);
  log('=== Law Commission Scraper Complete ===');
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
