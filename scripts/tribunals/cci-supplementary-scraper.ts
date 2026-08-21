/**
 * CCI Supplementary Scraper - All remaining data sources from cci.gov.in
 *
 * Scrapes 20 DataTable-backed categories + 7 static pages NOT covered
 * by the primary cci-scraper.ts (which handles antitrust orders,
 * combination orders sec 31, main press releases, and regulations).
 *
 * Categories (DataTable AJAX):
 *   Legal Framework:
 *     - rules                 (35)   GET /legal-framwork/fetch-ruleslist
 *     - notifications         (7)    GET /legal-framwork/notifications
 *     - judgements            (28)   GET /legal-framwork/fetch-judgementslist
 *   Combination (additional):
 *     - penalty_orders        (67)   GET /combination/orders-section43a_44
 *     - approved_modified     (33)   GET /combination/cases-approved-with-modification
 *     - green_channel         (137)  GET /combination/green-channel
 *     - notices_under_review  (17)   GET /combination/notice-under-review
 *     - combo_notifications   (23)   GET /combination/legal-framwork/notifications
 *     - combo_regulations     (2)    GET /combination/legal-framwork/regulations
 *     - combo_press_releases  (438)  GET /combination/press-release
 *   Antitrust (additional):
 *     - antitrust_press       (67)   GET /antitrust/press-release
 *   Advocacy:
 *     - speeches              (111)  GET /advocacy/publications/speeches
 *     - fair_play             (72)   GET /advocacy/publications/fair-play
 *   Economics Research:
 *     - market_studies        (9)    GET /economics-research/market-studies/list
 *     - econ_conferences      (10)   GET /economics-research/economics-conferences/list
 *   International:
 *     - intl_mous             (10)   GET /international-cooperation/fetch-mouslist
 *     - intl_events           (7)    GET /international-cooperation/fetch-eventslist
 *   Other:
 *     - public_notices        (13)   GET /public-notices
 *     - stakeholder_consult   (12)   GET /fetch-stackholder-topic
 *     - annual_reports        (16)   GET /fetch-annual-report-list
 *
 * Static pages (HTML-embedded PDFs):
 *     - act, combo_act, advocacy_booklets, competition_assessment,
 *       compliance_manual, diagnostics_tool, training_modules
 *
 * Usage:
 *   npx tsx scripts/cci-supplementary-scraper.ts                    # Full run
 *   npx tsx scripts/cci-supplementary-scraper.ts --test             # 5 records/cat
 *   npx tsx scripts/cci-supplementary-scraper.ts --metadata-only    # Metadata only
 *   npx tsx scripts/cci-supplementary-scraper.ts --download-only    # PDFs only
 *   npx tsx scripts/cci-supplementary-scraper.ts --category rules   # Single category
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://www.cci.gov.in';
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/cci');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'supplementary-progress.json');
const COMBINED_JSONL = path.join(DATA_DIR, 'cci-supplementary-metadata.jsonl');

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const PAGE_SIZE = 50;
const DELAY_BETWEEN_REQUESTS_MS = 1500;
const DELAY_BETWEEN_CATEGORIES_MS = 8000;
const DELAY_BETWEEN_PDFS_MS = 400;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const RATE_LIMIT_BACKOFF_MS = 30000;

// ---------------------------------------------------------------------------
// Category Configuration (data-driven)
// ---------------------------------------------------------------------------

interface CategoryConfig {
  slug: string;
  label: string;
  parentUrl: string;
  ajaxUrl: string;
  columns: string[];
  /** "datatable" (default) or "static" for HTML-embedded PDFs */
  type: 'datatable' | 'static';
  /** Which raw fields contain file_content JSON */
  fileFields: string[];
  /** Extra metadata fields to extract */
  extraFields?: string[];
}

const DATATABLE_CATEGORIES: CategoryConfig[] = [
  // --- Legal Framework ---
  {
    slug: 'rules',
    label: 'Legal Framework - Rules',
    parentUrl: `${BASE_URL}/legal-framwork/rules`,
    ajaxUrl: `${BASE_URL}/legal-framwork/fetch-ruleslist`,
    columns: ['DT_RowIndex', 'title', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  {
    slug: 'notifications',
    label: 'Legal Framework - Notifications',
    parentUrl: `${BASE_URL}/legal-framwork/notifications`,
    ajaxUrl: `${BASE_URL}/legal-framwork/notifications`,
    columns: ['DT_RowIndex', 'title'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  {
    slug: 'judgements',
    label: 'Legal Framework - Judgements',
    parentUrl: `${BASE_URL}/legal-framwork/judgements`,
    ajaxUrl: `${BASE_URL}/legal-framwork/fetch-judgementslist`,
    columns: ['DT_RowIndex', 'title', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  // --- Combination (additional) ---
  {
    slug: 'penalty_orders',
    label: 'Combination - Sec 43A/44 Penalty Orders',
    parentUrl: `${BASE_URL}/combination/orders-section43a_44`,
    ajaxUrl: `${BASE_URL}/combination/orders-section43a_44`,
    columns: [
      'DT_RowIndex',
      'combination_no',
      'description',
      'section',
      'decision_date',
      'order_files',
    ],
    type: 'datatable',
    fileFields: ['order_file_content'],
    extraFields: ['combination_no', 'section', 'decision_date'],
  },
  {
    slug: 'approved_modified',
    label: 'Combination - Cases Approved With Modification',
    parentUrl: `${BASE_URL}/combination/cases-approved-with-modification`,
    ajaxUrl: `${BASE_URL}/combination/cases-approved-with-modification`,
    columns: ['DT_RowIndex', 'combination_no', 'party_name', 'order_files'],
    type: 'datatable',
    fileFields: ['order_file_content'],
    extraFields: ['combination_no', 'party_name'],
  },
  {
    slug: 'green_channel',
    label: 'Combination - Green Channel',
    parentUrl: `${BASE_URL}/combination/green-channel`,
    ajaxUrl: `${BASE_URL}/combination/green-channel`,
    columns: [
      'DT_RowIndex',
      'combination_no',
      'party_name',
      'form_type',
      'notification_date',
      'order_status',
      'summary_files',
    ],
    type: 'datatable',
    fileFields: ['summary_file_content'],
    extraFields: ['combination_no', 'party_name', 'form_type', 'notification_date', 'order_status'],
  },
  {
    slug: 'notices_under_review',
    label: 'Combination - Notices Under Review',
    parentUrl: `${BASE_URL}/combination/notice-under-review`,
    ajaxUrl: `${BASE_URL}/combination/notice-under-review`,
    columns: [
      'DT_RowIndex',
      'combination_no',
      'party_name',
      'form_type',
      'notification_date',
      'order_status',
      'summary_files',
      'order_files',
    ],
    type: 'datatable',
    fileFields: ['summary_file_content', 'order_file_content'],
    extraFields: ['combination_no', 'party_name', 'form_type', 'notification_date', 'order_status'],
  },
  {
    slug: 'combo_notifications',
    label: 'Combination - Notifications',
    parentUrl: `${BASE_URL}/combination/legal-framwork/notifications`,
    ajaxUrl: `${BASE_URL}/combination/legal-framwork/notifications`,
    columns: ['DT_RowIndex', 'title'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  {
    slug: 'combo_regulations',
    label: 'Combination - Regulations',
    parentUrl: `${BASE_URL}/combination/legal-framwork/regulations`,
    ajaxUrl: `${BASE_URL}/combination/legal-framwork/regulations`,
    columns: ['DT_RowIndex', 'title', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  {
    slug: 'combo_press_releases',
    label: 'Combination - Press Releases',
    parentUrl: `${BASE_URL}/combination/press-release`,
    ajaxUrl: `${BASE_URL}/combination/press-release`,
    columns: ['DT_RowIndex', 'title', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  // --- Antitrust (additional) ---
  {
    slug: 'antitrust_press',
    label: 'Antitrust - Press Releases',
    parentUrl: `${BASE_URL}/antitrust/press-release`,
    ajaxUrl: `${BASE_URL}/antitrust/press-release`,
    columns: ['DT_RowIndex', 'title', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  // --- Advocacy ---
  {
    slug: 'speeches',
    label: 'Advocacy - Speeches',
    parentUrl: `${BASE_URL}/advocacy/publications/speeches`,
    ajaxUrl: `${BASE_URL}/advocacy/publications/speeches`,
    columns: ['DT_RowIndex', 'title', 'name', 'designation', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
    extraFields: ['name', 'designation'],
  },
  {
    slug: 'fair_play',
    label: 'Advocacy - Fair Play',
    parentUrl: `${BASE_URL}/advocacy/publications/fair-play`,
    ajaxUrl: `${BASE_URL}/advocacy/publications/fair-play`,
    columns: ['DT_RowIndex', 'title', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  // --- Economics Research ---
  {
    slug: 'market_studies',
    label: 'Economics Research - Market Studies',
    parentUrl: `${BASE_URL}/economics-research/market-studies`,
    ajaxUrl: `${BASE_URL}/economics-research/market-studies/list`,
    columns: ['DT_RowIndex', 'title', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  {
    slug: 'econ_conferences',
    label: 'Economics Research - Conferences',
    parentUrl: `${BASE_URL}/economics-research/economics-conferences`,
    ajaxUrl: `${BASE_URL}/economics-research/economics-conferences/list`,
    columns: ['DT_RowIndex', 'title', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  // --- International Cooperation ---
  {
    slug: 'intl_mous',
    label: 'International Cooperation - MoUs',
    parentUrl: `${BASE_URL}/international-cooperation/mous`,
    ajaxUrl: `${BASE_URL}/international-cooperation/fetch-mouslist`,
    columns: ['DT_RowIndex', 'title', 'description', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  {
    slug: 'intl_events',
    label: 'International Cooperation - Events',
    parentUrl: `${BASE_URL}/international-cooperation/events`,
    ajaxUrl: `${BASE_URL}/international-cooperation/fetch-eventslist`,
    columns: ['DT_RowIndex', 'title', 'order_date', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  // --- Other ---
  {
    slug: 'public_notices',
    label: 'Public Notices',
    parentUrl: `${BASE_URL}/public-notices`,
    ajaxUrl: `${BASE_URL}/public-notices`,
    columns: ['DT_RowIndex', 'title', 'file_name'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
  {
    slug: 'stakeholder_consult',
    label: 'Stakeholder Consultations',
    parentUrl: `${BASE_URL}/stakeholders-topics-consultations`,
    ajaxUrl: `${BASE_URL}/fetch-stackholder-topic`,
    columns: ['DT_RowIndex', 'title', 'attachment', 'star_date', 'end_date', 'status', 'comment'],
    type: 'datatable',
    fileFields: ['file_content'],
    extraFields: ['star_date', 'end_date', 'status'],
  },
  {
    slug: 'annual_reports',
    label: 'Annual Reports',
    parentUrl: `${BASE_URL}/annual-report`,
    ajaxUrl: `${BASE_URL}/fetch-annual-report-list`,
    columns: ['DT_RowIndex', 'title', 'files'],
    type: 'datatable',
    fileFields: ['file_content'],
  },
];

interface StaticPageConfig {
  slug: string;
  label: string;
  url: string;
}

const STATIC_PAGES: StaticPageConfig[] = [
  {
    slug: 'act',
    label: 'Legal Framework - The Competition Act',
    url: `${BASE_URL}/legal-framwork/act`,
  },
  {
    slug: 'combo_act',
    label: 'Combination - The Competition Act',
    url: `${BASE_URL}/combination/legal-framwork/act`,
  },
  {
    slug: 'advocacy_booklets',
    label: 'Advocacy - Booklets',
    url: `${BASE_URL}/advocacy/publications/advocacy-booklets`,
  },
  {
    slug: 'competition_assessment',
    label: 'Advocacy - Competition Assessment Toolkit',
    url: `${BASE_URL}/advocacy/publications/competition-assesment`,
  },
  {
    slug: 'compliance_manual',
    label: 'Advocacy - Compliance Manual',
    url: `${BASE_URL}/advocacy/publications/compliance-manual`,
  },
  {
    slug: 'diagnostics_tool',
    label: 'Advocacy - Diagnostics Tool',
    url: `${BASE_URL}/advocacy/publications/diagnostics-tool-for-public-procurement-officers`,
  },
  {
    slug: 'training_modules',
    label: 'Advocacy - Training Modules',
    url: `${BASE_URL}/advocacy/publications/training-module-for-administrative-and-judicial-academies`,
  },
];

const ALL_SLUGS = [...DATATABLE_CATEGORIES.map((c) => c.slug), ...STATIC_PAGES.map((p) => p.slug)];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CciDocument {
  id: number;
  category: string;
  case_no: string;
  description: string;
  type: string;
  section: string;
  order_date: string;
  pdf_urls: string[];
  pdf_filenames: string[];
  pdf_sizes_kb: number[];
  source_url: string;
  detail_url: string;
  tribunal: string;
  country: string;
  /** Dynamic extra metadata from category config */
  [key: string]: unknown;
}

interface CategoryMetadata {
  category: string;
  scraped_at: string;
  total_records: number;
  total_pdfs: number;
  documents: CciDocument[];
}

interface Progress {
  metadata_completed: string[];
  pdfs_completed: Record<string, string[]>;
  last_updated: string;
}

interface SessionInfo {
  cookies: string;
  csrfToken: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { metadata_completed: [], pdfs_completed: {}, last_updated: new Date().toISOString() };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
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

function slugify(text: string, maxLen = 70): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanJson(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]/g, ' ');
}

// ---------------------------------------------------------------------------
// HTTP Client (reused from primary scraper)
// ---------------------------------------------------------------------------

function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects?: boolean;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml,application/json',
        ...options.headers,
      },
    };

    const req = https.request(reqOptions, (res) => {
      if (
        options.followRedirects !== false &&
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${BASE_URL}${res.headers.location}`;
        httpRequest(redirectUrl, options).then(resolve).catch(reject);
        return;
      }

      const chunks: Uint8Array[] = [];
      res.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers as Record<string, string>,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

function downloadFile(url: string, dest: string, retries = MAX_RETRIES): Promise<boolean> {
  return new Promise((resolve) => {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      resolve(true);
      return;
    }

    const tmpDest = `${dest}.tmp`;

    const req = https.get(
      url,
      {
        rejectUnauthorized: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${BASE_URL}${res.headers.location}`;
          downloadFile(redirectUrl, dest, retries).then(resolve);
          return;
        }

        if (res.statusCode !== 200) {
          console.error(`  [FAIL] HTTP ${res.statusCode}: ${url}`);
          if (retries > 0) {
            setTimeout(() => downloadFile(url, dest, retries - 1).then(resolve), RETRY_DELAY_MS);
          } else {
            resolve(false);
          }
          return;
        }

        const file = fs.createWriteStream(tmpDest);
        let resolved = false;
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          if (resolved) return;
          resolved = true;
          try {
            if (fs.existsSync(tmpDest)) fs.renameSync(tmpDest, dest);
            resolve(true);
          } catch {
            resolve(false);
          }
        });
        file.on('error', () => {
          if (resolved) return;
          resolved = true;
          fs.unlink(tmpDest, () => {});
          resolve(false);
        });
      },
    );

    req.on('error', (err) => {
      console.error(`  [FAIL] Network: ${err.message} - ${url}`);
      if (retries > 0) {
        setTimeout(() => downloadFile(url, dest, retries - 1).then(resolve), RETRY_DELAY_MS);
      } else {
        resolve(false);
      }
    });

    req.setTimeout(60000, () => {
      req.destroy();
      if (retries > 0) {
        setTimeout(() => downloadFile(url, dest, retries - 1).then(resolve), RETRY_DELAY_MS);
      } else {
        resolve(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

async function getSession(pageUrl: string): Promise<SessionInfo> {
  const resp = await httpRequest(pageUrl);

  const setCookieHeaders = resp.headers['set-cookie'];
  let cookieStr = '';
  if (setCookieHeaders) {
    const cookies = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : setCookieHeaders.split(/,(?=[^;]*=)/);
    cookieStr = cookies.map((c) => c.split(';')[0].trim()).join('; ');
  }

  const tokenMatch = resp.body.match(/name="_token"\s+type="hidden"\s+value="([^"]+)"/);
  const altTokenMatch = resp.body.match(/type="hidden"\s+name="_token"\s+value="([^"]+)"/);
  const csrfToken = tokenMatch ? tokenMatch[1] : altTokenMatch ? altTokenMatch[1] : '';

  return { cookies: cookieStr, csrfToken };
}

// ---------------------------------------------------------------------------
// Generic DataTable Fetcher
// ---------------------------------------------------------------------------

interface DataTablesResponse {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: Record<string, unknown>[];
}

async function fetchDataTablePage(
  config: CategoryConfig,
  session: SessionInfo,
  start: number,
  length: number,
): Promise<DataTablesResponse> {
  const params = new URLSearchParams();
  params.append('draw', '1');
  config.columns.forEach((col, i) => {
    params.append(`columns[${i}][data]`, col);
    params.append(`columns[${i}][name]`, col);
  });
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  params.append('start', String(start));
  params.append('length', String(length));

  const url = `${config.ajaxUrl}?${params.toString()}`;

  const resp = await httpRequest(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
      Cookie: session.cookies,
      Referer: config.parentUrl,
    },
  });

  // Detect rate limiting or HTML error pages
  const body = cleanJson(resp.body).trim();
  if (body.startsWith('<!') || body.startsWith('<html') || body.startsWith('<!DOCTYPE')) {
    throw new Error(`RATE_LIMIT: Server returned HTML instead of JSON (status ${resp.status})`);
  }

  if (resp.status === 429) {
    throw new Error(`RATE_LIMIT: HTTP 429 Too Many Requests`);
  }

  try {
    return JSON.parse(body);
  } catch (parseErr) {
    throw new Error(
      `JSON_PARSE: Failed to parse response (status ${resp.status}, first 200 chars: ${body.slice(0, 200)})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Generic Record Parser
// ---------------------------------------------------------------------------

function parseFileContent(
  rawFileContent: string | null | undefined,
): { url: string; title: string; sizeKb: number }[] {
  if (!rawFileContent) return [];

  const decoded = rawFileContent
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\\\//g, '/');

  try {
    const items: { title?: string; file_name?: string; file_size?: string }[] = JSON.parse(decoded);
    return items
      .filter((item) => item.file_name)
      .map((item) => ({
        url: `${BASE_URL}/${item.file_name}`,
        title: item.title || 'Document',
        sizeKb: parseFloat(item.file_size || '0'),
      }));
  } catch {
    return [];
  }
}

function parseGenericRecord(raw: Record<string, unknown>, config: CategoryConfig): CciDocument {
  const id = (raw.id as number) || 0;
  const title = stripHtml(String(raw.title || raw.description || raw.party_name || ''));
  const orderDate = String(
    raw.order_date || raw.decision_date || raw.notification_date || raw.star_date || '',
  );
  const caseNo = String(raw.case_no || raw.combination_no || `${config.slug.toUpperCase()}-${id}`);
  const section = String(raw.section || '');
  const description = stripHtml(String(raw.description || raw.party_name || raw.title || ''));

  // Collect PDFs from all file fields
  const allFiles: { url: string; title: string; sizeKb: number }[] = [];
  for (const field of config.fileFields) {
    const content = raw[field];
    if (content) {
      allFiles.push(...parseFileContent(String(content)));
    }
  }

  const slug = slugify(title || caseNo);

  const doc: CciDocument = {
    id,
    category: config.slug,
    case_no: caseNo,
    description,
    type: config.label,
    section,
    order_date: orderDate,
    pdf_urls: allFiles.map((f) => f.url),
    pdf_filenames: allFiles.map(
      (f, i) => `${config.slug}_${id}_${slug}${allFiles.length > 1 ? `_${i + 1}` : ''}.pdf`,
    ),
    pdf_sizes_kb: allFiles.map((f) => f.sizeKb),
    source_url: config.parentUrl,
    detail_url: config.parentUrl,
    tribunal: 'CCI',
    country: 'IN',
  };

  // Add extra metadata fields
  if (config.extraFields) {
    for (const field of config.extraFields) {
      const val = raw[field];
      if (val !== undefined && val !== null) {
        doc[field] = stripHtml(String(val));
      }
    }
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Phase 1a: Scrape DataTable Category
// ---------------------------------------------------------------------------

async function scrapeDataTableCategory(
  config: CategoryConfig,
  testLimit?: number,
): Promise<CategoryMetadata> {
  console.log(`\n  --- Scraping: ${config.label} (${config.slug}) ---`);

  const session = await getSession(config.parentUrl);

  if (!session.cookies) {
    throw new Error(`RATE_LIMIT: Failed to get session cookies for ${config.slug}`);
  }

  console.log(`  Session acquired (CSRF: ${session.csrfToken.slice(0, 8) || 'none'}...)`);

  const documents: CciDocument[] = [];
  let start = 0;

  // First request
  const firstPage = await fetchDataTablePage(config, session, 0, PAGE_SIZE);

  if (!firstPage || !firstPage.data || !Array.isArray(firstPage.data)) {
    throw new Error(`RATE_LIMIT: Invalid DataTables response for ${config.slug}`);
  }

  const totalRecords = firstPage.recordsTotal;
  const effectiveTotal = testLimit ? Math.min(testLimit, totalRecords) : totalRecords;

  console.log(`  Total records: ${totalRecords}${testLimit ? ` (test limit: ${testLimit})` : ''}`);

  // Parse first page
  for (const raw of firstPage.data) {
    if (documents.length >= effectiveTotal) break;
    try {
      documents.push(parseGenericRecord(raw, config));
    } catch (err) {
      console.error(`  [PARSE ERROR] ID=${raw.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  start = firstPage.data.length;

  // Paginate remaining
  while (start < effectiveTotal) {
    const pageLen = Math.min(PAGE_SIZE, effectiveTotal - start);
    await sleep(DELAY_BETWEEN_REQUESTS_MS);

    try {
      // Refresh session periodically
      let activeSession = session;
      if (start % 200 === 0 && start > 0) {
        console.log(`  [SESSION] Refreshing at offset ${start}...`);
        activeSession = await getSession(config.parentUrl);
        Object.assign(session, activeSession);
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
      }

      const page = await fetchDataTablePage(config, session, start, pageLen);

      for (const raw of page.data) {
        if (documents.length >= effectiveTotal) break;
        try {
          documents.push(parseGenericRecord(raw, config));
        } catch (err) {
          console.error(
            `  [PARSE ERROR] ID=${raw.id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      const pct = ((documents.length / effectiveTotal) * 100).toFixed(1);
      console.log(`  [${pct}%] Fetched ${documents.length}/${effectiveTotal} records`);

      start += page.data.length;

      if (page.data.length === 0) {
        console.warn(`  [WARN] Empty page at offset ${start}, stopping.`);
        break;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] Page at offset ${start}: ${errMsg}`);

      const isRateLimit = errMsg.includes('RATE_LIMIT') || errMsg.includes('JSON_PARSE');
      const backoffMs = isRateLimit ? RATE_LIMIT_BACKOFF_MS : DELAY_BETWEEN_REQUESTS_MS * 3;

      if (isRateLimit) {
        console.log(`  [RATE LIMIT] Backing off for ${backoffMs / 1000}s...`);
      }

      // Retry with fresh session after backoff
      try {
        await sleep(backoffMs);
        console.log(`  [RETRY] Refreshing session...`);
        const newSession = await getSession(config.parentUrl);
        Object.assign(session, newSession);
        await sleep(DELAY_BETWEEN_REQUESTS_MS);

        const retryPage = await fetchDataTablePage(config, session, start, pageLen);
        for (const raw of retryPage.data) {
          if (documents.length >= effectiveTotal) break;
          try {
            documents.push(parseGenericRecord(raw, config));
          } catch (parseErr) {
            console.error(`  [PARSE ERROR on retry]: ${parseErr}`);
          }
        }
        start += retryPage.data.length;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        if (retryMsg.includes('RATE_LIMIT')) {
          console.log(`  [RATE LIMIT] Still rate limited. Waiting 60s before next attempt...`);
          await sleep(60000);
          try {
            const freshSession = await getSession(config.parentUrl);
            Object.assign(session, freshSession);
            await sleep(DELAY_BETWEEN_REQUESTS_MS);
            const retryPage2 = await fetchDataTablePage(config, session, start, pageLen);
            for (const raw of retryPage2.data) {
              if (documents.length >= effectiveTotal) break;
              try {
                documents.push(parseGenericRecord(raw, config));
              } catch {}
            }
            start += retryPage2.data.length;
          } catch {
            console.error(`  [FATAL] Still failing at offset ${start} after extended backoff.`);
            break;
          }
        } else {
          console.error(`  [FATAL] Retry failed at offset ${start}: ${retryMsg}`);
          break;
        }
      }
    }
  }

  const totalPdfs = documents.reduce((sum, d) => sum + d.pdf_urls.length, 0);
  console.log(`  Done: ${documents.length} documents, ${totalPdfs} PDF links`);

  return {
    category: config.slug,
    scraped_at: new Date().toISOString(),
    total_records: documents.length,
    total_pdfs: totalPdfs,
    documents,
  };
}

// ---------------------------------------------------------------------------
// Phase 1b: Scrape Static Pages (HTML-embedded PDFs)
// ---------------------------------------------------------------------------

async function scrapeStaticPage(config: StaticPageConfig): Promise<CategoryMetadata> {
  console.log(`\n  --- Scraping static: ${config.label} (${config.slug}) ---`);

  const resp = await httpRequest(config.url);

  // Extract PDFs from DownloadFile('...') and href="...pdf"
  const downloadFileMatches = resp.body.match(/DownloadFile\('([^']+\.pdf)'\)/g) || [];
  const hrefMatches = resp.body.match(/href="([^"]*\.pdf)"/g) || [];

  const pdfUrls = new Set<string>();

  for (const m of downloadFileMatches) {
    const urlMatch = m.match(/DownloadFile\('([^']+)'\)/);
    if (urlMatch) pdfUrls.add(urlMatch[1]);
  }

  for (const m of hrefMatches) {
    const urlMatch = m.match(/href="([^"]+)"/);
    if (urlMatch) {
      const url = urlMatch[1].startsWith('http') ? urlMatch[1] : `${BASE_URL}${urlMatch[1]}`;
      pdfUrls.add(url);
    }
  }

  // Also extract titles from surrounding context
  const documents: CciDocument[] = [];
  let idx = 0;

  for (const pdfUrl of pdfUrls) {
    idx++;
    // Try to extract title from nearby blue span or text
    const filename = path.basename(pdfUrl);
    const titleMatch = resp.body.match(
      new RegExp(
        `class="blue">([^<]+)</span>[^]*?${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        's',
      ),
    );
    const title = titleMatch
      ? stripHtml(titleMatch[1])
      : filename.replace(/\.pdf$/, '').replace(/[-_]/g, ' ');

    const slug = slugify(title);

    documents.push({
      id: idx,
      category: config.slug,
      case_no: `${config.slug.toUpperCase()}-${idx}`,
      description: title,
      type: config.label,
      section: '',
      order_date: '',
      pdf_urls: [pdfUrl],
      pdf_filenames: [`${config.slug}_${idx}_${slug}.pdf`],
      pdf_sizes_kb: [0],
      source_url: config.url,
      detail_url: config.url,
      tribunal: 'CCI',
      country: 'IN',
    });
  }

  console.log(`  Done: ${documents.length} documents (static PDFs)`);

  return {
    category: config.slug,
    scraped_at: new Date().toISOString(),
    total_records: documents.length,
    total_pdfs: documents.length,
    documents,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Scrape All Metadata
// ---------------------------------------------------------------------------

async function scrapeAllMetadata(
  slugFilter: string[],
  testLimit?: number,
): Promise<Map<string, CategoryMetadata>> {
  const progress = loadProgress();
  const allMetadata = new Map<string, CategoryMetadata>();

  const dtCategories =
    slugFilter.length > 0
      ? DATATABLE_CATEGORIES.filter((c) => slugFilter.includes(c.slug))
      : DATATABLE_CATEGORIES;

  const staticPages =
    slugFilter.length > 0 ? STATIC_PAGES.filter((p) => slugFilter.includes(p.slug)) : STATIC_PAGES;

  const totalCats = dtCategories.length + staticPages.length;
  console.log(`\n=== Phase 1: Scraping metadata for ${totalCats} categories ===`);

  // DataTable categories
  let catIdx = 0;
  for (const config of dtCategories) {
    catIdx++;
    const metaFile = path.join(METADATA_DIR, `cci-${config.slug}.json`);

    if (
      !testLimit &&
      progress.metadata_completed.includes(config.slug) &&
      fs.existsSync(metaFile)
    ) {
      console.log(`\n  [SKIP] ${config.slug} - already scraped`);
      const existing: CategoryMetadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      allMetadata.set(config.slug, existing);
      continue;
    }

    // Inter-category delay to avoid rate limiting
    if (catIdx > 1) {
      console.log(
        `\n  [COOLDOWN] Waiting ${DELAY_BETWEEN_CATEGORIES_MS / 1000}s before next category...`,
      );
      await sleep(DELAY_BETWEEN_CATEGORIES_MS);
    }

    let retryCount = 0;
    const maxCatRetries = 2;

    while (retryCount <= maxCatRetries) {
      try {
        const metadata = await scrapeDataTableCategory(config, testLimit);
        fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
        allMetadata.set(config.slug, metadata);

        if (!progress.metadata_completed.includes(config.slug)) {
          progress.metadata_completed.push(config.slug);
        }
        saveProgress(progress);
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`  [ERROR] ${config.slug}: ${errMsg}`);

        if (errMsg.includes('RATE_LIMIT') && retryCount < maxCatRetries) {
          retryCount++;
          const waitMs = RATE_LIMIT_BACKOFF_MS * retryCount;
          console.log(
            `  [RATE LIMIT] Retry ${retryCount}/${maxCatRetries} after ${waitMs / 1000}s backoff...`,
          );
          await sleep(waitMs);
        } else {
          break;
        }
      }
    }
  }

  // Static pages
  for (const config of staticPages) {
    const metaFile = path.join(METADATA_DIR, `cci-${config.slug}.json`);

    if (
      !testLimit &&
      progress.metadata_completed.includes(config.slug) &&
      fs.existsSync(metaFile)
    ) {
      console.log(`\n  [SKIP] ${config.slug} - already scraped`);
      const existing: CategoryMetadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      allMetadata.set(config.slug, existing);
      continue;
    }

    // Delay between static pages too
    console.log(`\n  [COOLDOWN] Waiting 3s before static page...`);
    await sleep(3000);

    try {
      const metadata = await scrapeStaticPage(config);
      fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
      allMetadata.set(config.slug, metadata);

      if (!progress.metadata_completed.includes(config.slug)) {
        progress.metadata_completed.push(config.slug);
      }
      saveProgress(progress);
    } catch (err) {
      console.error(`  [ERROR] ${config.slug}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Write combined JSONL
  console.log(`\n  Writing combined JSONL -> ${COMBINED_JSONL}`);
  const jsonlStream = fs.createWriteStream(COMBINED_JSONL);
  let totalDocs = 0;
  let totalPdfs = 0;

  for (const slug of ALL_SLUGS) {
    const meta = allMetadata.get(slug);
    if (!meta) continue;
    for (const doc of meta.documents) {
      jsonlStream.write(JSON.stringify(doc) + '\n');
      totalDocs++;
      totalPdfs += doc.pdf_urls.length;
    }
  }
  jsonlStream.end();

  console.log(`\n  Total: ${totalDocs} documents, ${totalPdfs} PDF links\n`);

  return allMetadata;
}

// ---------------------------------------------------------------------------
// Phase 2: Download PDFs
// ---------------------------------------------------------------------------

async function downloadPdfs(
  allMetadata: Map<string, CategoryMetadata>,
  maxPdfs?: number,
): Promise<void> {
  const progress = loadProgress();
  let downloadedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  const queue: {
    url: string;
    dest: string;
    category: string;
    label: string;
  }[] = [];

  for (const [cat, meta] of allMetadata) {
    const catDir = path.join(PDFS_DIR, cat);
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

    const completedForCat = progress.pdfs_completed[cat] || [];

    for (const doc of meta.documents) {
      for (let i = 0; i < doc.pdf_urls.length; i++) {
        const filename = doc.pdf_filenames[i];
        const dest = path.join(catDir, filename);

        if (completedForCat.includes(filename)) {
          skippedCount++;
          continue;
        }

        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          if (!completedForCat.includes(filename)) {
            completedForCat.push(filename);
          }
          skippedCount++;
          continue;
        }

        queue.push({
          url: doc.pdf_urls[i],
          dest,
          category: cat,
          label: `${doc.case_no} - ${filename}`,
        });
      }
    }

    progress.pdfs_completed[cat] = completedForCat;
  }

  saveProgress(progress);

  let totalToDownload = queue.length;
  if (maxPdfs && maxPdfs < totalToDownload) {
    queue.length = maxPdfs;
    totalToDownload = maxPdfs;
  }

  console.log(`\n=== Phase 2: Downloading PDFs ===`);
  console.log(`  Queue: ${totalToDownload}, Skipped (already done): ${skippedCount}`);
  console.log(`  Concurrency: ${MAX_CONCURRENT}\n`);

  let idx = 0;
  while (idx < queue.length) {
    const batch = queue.slice(idx, idx + MAX_CONCURRENT);
    const results = await Promise.all(
      batch.map(async (item) => {
        const ok = await downloadFile(item.url, item.dest);
        if (ok) {
          downloadedCount++;
          if (!progress.pdfs_completed[item.category]) {
            progress.pdfs_completed[item.category] = [];
          }
          const filename = path.basename(item.dest);
          if (!progress.pdfs_completed[item.category].includes(filename)) {
            progress.pdfs_completed[item.category].push(filename);
          }
        } else {
          failedCount++;
        }
        return { ...item, ok };
      }),
    );

    const completed = downloadedCount + failedCount + skippedCount;
    const totalExpected = totalToDownload + skippedCount;
    const pct = ((completed / totalExpected) * 100).toFixed(1);
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok).length;
    console.log(
      `  [${pct}%] Batch: ${ok} ok, ${fail} fail | Total: ${downloadedCount}/${totalToDownload} downloaded, ${failedCount} failed`,
    );

    saveProgress(progress);
    idx += MAX_CONCURRENT;

    if (idx < queue.length) {
      await sleep(DELAY_BETWEEN_PDFS_MS);
    }
  }

  console.log(
    `\n  Done: ${downloadedCount} downloaded, ${failedCount} failed, ${skippedCount} skipped\n`,
  );
}

// ---------------------------------------------------------------------------
// Phase 3: Verify
// ---------------------------------------------------------------------------

function verify(allMetadata: Map<string, CategoryMetadata>): void {
  console.log(`\n=== Phase 3: Verification ===\n`);

  let totalExpected = 0;
  let totalFound = 0;

  for (const [cat, meta] of allMetadata) {
    const catDir = path.join(PDFS_DIR, cat);
    let catExpected = 0;
    let catFound = 0;

    for (const doc of meta.documents) {
      for (const filename of doc.pdf_filenames) {
        catExpected++;
        const dest = path.join(catDir, filename);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          catFound++;
        }
      }
    }

    totalExpected += catExpected;
    totalFound += catFound;

    if (catExpected > 0) {
      const status = catFound === catExpected ? 'OK' : 'INCOMPLETE';
      console.log(`  ${cat}: ${catFound}/${catExpected} PDFs [${status}]`);
    }
  }

  console.log(`\n  TOTAL: ${totalFound}/${totalExpected} PDFs downloaded`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isTest = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');

  // Parse --category flags
  const catFlags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      const val = args[i + 1];
      if (ALL_SLUGS.includes(val)) {
        catFlags.push(val);
      } else {
        console.error(`Unknown category: ${val}\nValid: ${ALL_SLUGS.join(', ')}`);
        process.exit(1);
      }
    }
  }

  const testLimit = isTest ? 5 : undefined;

  fs.mkdirSync(METADATA_DIR, { recursive: true });
  fs.mkdirSync(PDFS_DIR, { recursive: true });

  console.log(`CCI Supplementary Scraper`);
  console.log(
    `  Categories: ${catFlags.length > 0 ? catFlags.join(', ') : 'all (' + ALL_SLUGS.length + ')'}`,
  );
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(
    `  Mode: ${metadataOnly ? 'metadata-only' : downloadOnly ? 'download-only' : 'full'}`,
  );
  if (isTest) console.log(`  TEST MODE: ${testLimit} records per category`);

  let allMetadata: Map<string, CategoryMetadata>;

  if (downloadOnly) {
    allMetadata = new Map();
    const slugsToLoad = catFlags.length > 0 ? catFlags : ALL_SLUGS;
    for (const slug of slugsToLoad) {
      const metaFile = path.join(METADATA_DIR, `cci-${slug}.json`);
      if (fs.existsSync(metaFile)) {
        allMetadata.set(slug, JSON.parse(fs.readFileSync(metaFile, 'utf-8')));
      } else {
        console.error(`  [ERROR] No metadata for ${slug}. Run metadata scrape first.`);
      }
    }
  } else {
    allMetadata = await scrapeAllMetadata(catFlags, testLimit);
  }

  if (!metadataOnly) {
    const maxPdfs = isTest ? 20 : undefined;
    await downloadPdfs(allMetadata, maxPdfs);
  }

  verify(allMetadata);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
