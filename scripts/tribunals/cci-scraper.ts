/**
 * CCI Scraper - Competition Commission of India
 * Scrapes orders, press releases, and regulations from https://www.cci.gov.in
 *
 * Categories:
 *   - Antitrust Orders:    ~1,185 (Feb 2010 - present)  POST /antitrust/orders/list
 *   - Combination Orders:  ~1,388 (Jul 2011 - present)  GET  /combination/orders-section31
 *   - Press Releases:      ~530                          GET  /media-gallery/press-release
 *   - Regulations:         ~46                           GET  /legal-framwork/fetch-regulationslist
 *
 * The site uses Laravel with DataTables (server-side). CSRF token + session cookies
 * are required for POST endpoints. PDFs are directly downloadable without auth.
 *
 * Rate limit: 60 requests/minute (x-ratelimit-limit header).
 *
 * Usage:
 *   npx tsx scripts/cci-scraper.ts                           # Full run (all categories)
 *   npx tsx scripts/cci-scraper.ts --metadata-only           # Scrape metadata only
 *   npx tsx scripts/cci-scraper.ts --download-only           # Download PDFs only (requires metadata)
 *   npx tsx scripts/cci-scraper.ts --category antitrust      # Single category
 *   npx tsx scripts/cci-scraper.ts --category combination    # Single category
 *   npx tsx scripts/cci-scraper.ts --test                    # Test run (5 records per category)
 *   MAX_CONCURRENT=3 npx tsx scripts/cci-scraper.ts          # Control concurrency
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
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const COMBINED_JSONL = path.join(DATA_DIR, 'cci-all-metadata.jsonl');

const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const PAGE_SIZE = 50; // DataTables records per request
const DELAY_BETWEEN_REQUESTS_MS = 1200; // stay under 60/min rate limit
const DELAY_BETWEEN_PDFS_MS = 400;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

type CategoryName = 'antitrust' | 'combination' | 'press_releases' | 'regulations';

const ALL_CATEGORIES: CategoryName[] = [
  'antitrust',
  'combination',
  'press_releases',
  'regulations',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CciDocument {
  id: number;
  category: CategoryName;
  case_no: string;
  description: string;
  type: string;
  section: string;
  order_date: string;
  main_order_date: string;
  pdf_urls: string[];
  pdf_filenames: string[];
  pdf_sizes_kb: number[];
  source_url: string;
  detail_url: string;
  tribunal: string;
  country: string;
  // Combination-specific
  combination_no?: string;
  party_name?: string;
  form_type?: string;
  order_type?: string;
  order_status?: string;
  notification_date?: string;
  decision_date?: string;
}

interface CategoryMetadata {
  category: CategoryName;
  scraped_at: string;
  total_records: number;
  total_pdfs: number;
  documents: CciDocument[];
}

interface Progress {
  metadata_completed: CategoryName[];
  pdfs_completed: Record<string, string[]>; // category -> downloaded filenames
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
  return {
    metadata_completed: [],
    pdfs_completed: {},
    last_updated: new Date().toISOString(),
  };
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

/** Clean JSON control characters that CCI sometimes includes in responses */
function cleanJson(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f]/g, ' ');
}

// ---------------------------------------------------------------------------
// HTTP Client
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
      rejectUnauthorized: false, // CCI has invalid SSL cert
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'text/html,application/xhtml+xml,application/json',
        ...options.headers,
      },
    };

    const req = https.request(reqOptions, (res) => {
      // Handle redirects
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

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function downloadFile(url: string, dest: string, retries = MAX_RETRIES): Promise<boolean> {
  return new Promise((resolve) => {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Skip if already downloaded and non-empty
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      resolve(true);
      return;
    }

    const tmpDest = `${dest}.tmp`;

    const req = https.get(
      url,
      {
        rejectUnauthorized: false, // CCI has invalid SSL cert
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
            setTimeout(() => {
              downloadFile(url, dest, retries - 1).then(resolve);
            }, RETRY_DELAY_MS);
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
            if (fs.existsSync(tmpDest)) {
              fs.renameSync(tmpDest, dest);
            }
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
        setTimeout(() => {
          downloadFile(url, dest, retries - 1).then(resolve);
        }, RETRY_DELAY_MS);
      } else {
        resolve(false);
      }
    });

    req.setTimeout(60000, () => {
      req.destroy();
      if (retries > 0) {
        setTimeout(() => {
          downloadFile(url, dest, retries - 1).then(resolve);
        }, RETRY_DELAY_MS);
      } else {
        resolve(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Session Management (CSRF + Cookies)
// ---------------------------------------------------------------------------

async function getSession(pageUrl: string): Promise<SessionInfo> {
  const resp = await httpRequest(pageUrl);

  // Extract cookies from set-cookie headers
  const setCookieHeaders = resp.headers['set-cookie'];
  let cookieStr = '';
  if (setCookieHeaders) {
    // set-cookie can be a single string or joined with comma/semicolon
    const cookies = Array.isArray(setCookieHeaders)
      ? setCookieHeaders
      : setCookieHeaders.split(/,(?=[^;]*=)/);
    cookieStr = cookies.map((c) => c.split(';')[0].trim()).join('; ');
  }

  // Extract CSRF token from HTML
  const tokenMatch = resp.body.match(/name="_token"\s+type="hidden"\s+value="([^"]+)"/);
  const csrfToken = tokenMatch ? tokenMatch[1] : '';

  if (!csrfToken) {
    console.warn(`  [WARN] No CSRF token found on ${pageUrl}`);
  }

  return { cookies: cookieStr, csrfToken };
}

// ---------------------------------------------------------------------------
// DataTables API Callers
// ---------------------------------------------------------------------------

interface DataTablesResponse {
  draw: number;
  recordsTotal: number;
  recordsFiltered: number;
  data: Record<string, unknown>[];
}

async function fetchAntitrustPage(
  session: SessionInfo,
  start: number,
  length: number,
): Promise<DataTablesResponse> {
  const columns = [
    'DT_RowIndex',
    'case_no',
    'description',
    'type',
    'main_order_date',
    'order_date',
    'files',
  ];

  const params = new URLSearchParams();
  params.append('_token', session.csrfToken);
  params.append('draw', '1');
  columns.forEach((col, i) => {
    params.append(`columns[${i}][data]`, col);
    params.append(`columns[${i}][name]`, col);
  });
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  params.append('start', String(start));
  params.append('length', String(length));
  params.append('case_type', '');
  params.append('case_no', '');
  params.append('case_year', '');

  const resp = await httpRequest(`${BASE_URL}/antitrust/orders/list`, {
    method: 'POST',
    headers: {
      'X-CSRF-TOKEN': session.csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Cookie: session.cookies,
      Referer: `${BASE_URL}/antitrust/orders`,
    },
    body: params.toString(),
  });

  return JSON.parse(cleanJson(resp.body));
}

async function fetchCombinationPage(
  session: SessionInfo,
  start: number,
  length: number,
): Promise<DataTablesResponse> {
  const columns = [
    'DT_RowIndex',
    'combination_no',
    'party_name',
    'form_type',
    'notification_date',
    'order_status',
    'decision_date',
    'summary_files',
    'order_files',
  ];

  const params = new URLSearchParams();
  params.append('draw', '1');
  columns.forEach((col, i) => {
    params.append(`columns[${i}][data]`, col);
    params.append(`columns[${i}][name]`, col);
  });
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  params.append('start', String(start));
  params.append('length', String(length));

  const url = `${BASE_URL}/combination/orders-section31?${params.toString()}`;

  const resp = await httpRequest(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
      Cookie: session.cookies,
      Referer: `${BASE_URL}/combination/orders-section31`,
    },
  });

  return JSON.parse(cleanJson(resp.body));
}

async function fetchPressReleasePage(
  session: SessionInfo,
  start: number,
  length: number,
): Promise<DataTablesResponse> {
  const columns = ['DT_RowIndex', 'title', 'order_date', 'files'];

  const params = new URLSearchParams();
  params.append('draw', '1');
  columns.forEach((col, i) => {
    params.append(`columns[${i}][data]`, col);
    params.append(`columns[${i}][name]`, col);
  });
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  params.append('start', String(start));
  params.append('length', String(length));

  const url = `${BASE_URL}/media-gallery/press-release?${params.toString()}`;

  const resp = await httpRequest(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
      Cookie: session.cookies,
      Referer: `${BASE_URL}/media-gallery/press-release`,
    },
  });

  return JSON.parse(cleanJson(resp.body));
}

async function fetchRegulationsPage(
  session: SessionInfo,
  start: number,
  length: number,
): Promise<DataTablesResponse> {
  const columns = ['DT_RowIndex', 'title', 'order_date', 'files'];

  const params = new URLSearchParams();
  params.append('draw', '1');
  columns.forEach((col, i) => {
    params.append(`columns[${i}][data]`, col);
    params.append(`columns[${i}][name]`, col);
  });
  params.append('order[0][column]', '0');
  params.append('order[0][dir]', 'desc');
  params.append('start', String(start));
  params.append('length', String(length));

  const url = `${BASE_URL}/legal-framwork/fetch-regulationslist?${params.toString()}`;

  const resp = await httpRequest(url, {
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json',
      Cookie: session.cookies,
      Referer: `${BASE_URL}/legal-framwork/regulations`,
    },
  });

  return JSON.parse(cleanJson(resp.body));
}

// ---------------------------------------------------------------------------
// Record Parsers - Extract rich metadata + PDF URLs from raw API responses
// ---------------------------------------------------------------------------

function parseFileContent(
  rawFileContent: string | null | undefined,
): { url: string; title: string; sizeKb: number }[] {
  if (!rawFileContent) return [];

  // file_content comes HTML-entity-encoded from the API
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

function extractSectionFromTitle(titleHtml: string): string {
  const match = titleHtml.match(/Section [\d()]+/);
  return match ? match[0] : '';
}

function parseAntitrustRecord(raw: Record<string, unknown>): CciDocument {
  const id = raw.id as number;
  const caseNo = String(raw.case_no || '');
  const description = stripHtml(String(raw.description || ''));
  const type = String(raw.type || '');
  const section = extractSectionFromTitle(String(raw.title || ''));
  const orderDate = String(raw.order_date || '');
  const mainOrderDate = String(raw.main_order_date || '');
  const fileContent = String(raw.file_content || '');
  const categoryId = raw.antitrust_categories_id as number;

  const files = parseFileContent(fileContent);
  const slug = slugify(description || caseNo);

  return {
    id,
    category: 'antitrust',
    case_no: caseNo,
    description,
    type,
    section,
    order_date: orderDate,
    main_order_date: mainOrderDate,
    pdf_urls: files.map((f) => f.url),
    pdf_filenames: files.map(
      (f, i) => `antitrust_${id}_${slug}${files.length > 1 ? `_${i + 1}` : ''}.pdf`,
    ),
    pdf_sizes_kb: files.map((f) => f.sizeKb),
    source_url: `${BASE_URL}/antitrust/orders`,
    detail_url: `${BASE_URL}/antitrust/orders/details/${id}/0`,
    tribunal: 'CCI',
    country: 'IN',
    // Encode the antitrust_categories_id in the type for RAG context
    type: `${type} [category_id=${categoryId}]`,
  };
}

function parseCombinationRecord(raw: Record<string, unknown>): CciDocument {
  const id = raw.id as number;
  const combinationNo = String(raw.combination_no || '');
  const partyName = stripHtml(String(raw.description || raw.party_name || ''));
  const formType = String(raw.form_type || '');
  const orderType = String(raw.order_type || '');
  const orderStatus = String(raw.order_status || '');
  const notificationDate = String(raw.notification_date || '');
  const decisionDate = String(raw.decision_date || '');
  const summaryFileContent = String(raw.summary_file_content || '');
  const orderFileContent = String(raw.order_file_content || '');

  const summaryFiles = parseFileContent(summaryFileContent);
  const orderFiles = parseFileContent(orderFileContent);
  const allFiles = [...summaryFiles, ...orderFiles];

  const slug = slugify(partyName || combinationNo);

  return {
    id,
    category: 'combination',
    case_no: combinationNo,
    description: partyName,
    type: orderType,
    section: 'Section 31',
    order_date: decisionDate,
    main_order_date: notificationDate,
    pdf_urls: allFiles.map((f) => f.url),
    pdf_filenames: allFiles.map(
      (f, i) =>
        `combo_${id}_${f.title === 'Summary' ? 'summary' : 'order'}_${slug}${allFiles.length > 1 ? `_${i + 1}` : ''}.pdf`,
    ),
    pdf_sizes_kb: allFiles.map((f) => f.sizeKb),
    source_url: `${BASE_URL}/combination/orders-section31`,
    detail_url: `${BASE_URL}/combination/order/details/summary/${id}/0/orders-section31`,
    tribunal: 'CCI',
    country: 'IN',
    combination_no: combinationNo,
    party_name: partyName,
    form_type: formType,
    order_type: orderType,
    order_status: orderStatus,
    notification_date: notificationDate,
    decision_date: decisionDate,
  };
}

function parsePressReleaseRecord(raw: Record<string, unknown>): CciDocument {
  const id = raw.id as number;
  const title = stripHtml(String(raw.title || ''));
  const description = stripHtml(String(raw.description || title));
  const orderDate = String(raw.order_date || '');
  const fileContent = String(raw.file_content || '');

  const files = parseFileContent(fileContent);
  const slug = slugify(title);

  return {
    id,
    category: 'press_releases',
    case_no: `PR-${id}`,
    description,
    type: 'Press Release',
    section: '',
    order_date: orderDate,
    main_order_date: orderDate,
    pdf_urls: files.map((f) => f.url),
    pdf_filenames: files.map(
      (f, i) => `press_${id}_${slug}${files.length > 1 ? `_${i + 1}` : ''}.pdf`,
    ),
    pdf_sizes_kb: files.map((f) => f.sizeKb),
    source_url: `${BASE_URL}/media-gallery/press-release`,
    detail_url: `${BASE_URL}/media-gallery/press-release/details/${id}/0`,
    tribunal: 'CCI',
    country: 'IN',
  };
}

function parseRegulationRecord(raw: Record<string, unknown>): CciDocument {
  const id = raw.id as number;
  const title = stripHtml(String(raw.title || ''));
  const orderDate = String(raw.order_date || '');
  const fileContent = String(raw.file_content || '');

  const files = parseFileContent(fileContent);
  const slug = slugify(title);

  return {
    id,
    category: 'regulations',
    case_no: `REG-${id}`,
    description: title,
    type: 'Regulation',
    section: '',
    order_date: orderDate,
    main_order_date: orderDate,
    pdf_urls: files.map((f) => f.url),
    pdf_filenames: files.map(
      (f, i) => `reg_${id}_${slug}${files.length > 1 ? `_${i + 1}` : ''}.pdf`,
    ),
    pdf_sizes_kb: files.map((f) => f.sizeKb),
    source_url: `${BASE_URL}/legal-framwork/regulations`,
    detail_url: `${BASE_URL}/legal-framwork/regulations`,
    tribunal: 'CCI',
    country: 'IN',
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Scrape Metadata (paginate through DataTables API)
// ---------------------------------------------------------------------------

async function scrapeCategory(
  category: CategoryName,
  testLimit?: number,
): Promise<CategoryMetadata> {
  console.log(`\n  --- Scraping: ${category} ---`);

  // Get session for the parent page
  const parentPages: Record<CategoryName, string> = {
    antitrust: `${BASE_URL}/antitrust/orders`,
    combination: `${BASE_URL}/combination/orders-section31`,
    press_releases: `${BASE_URL}/media-gallery/press-release`,
    regulations: `${BASE_URL}/legal-framwork/regulations`,
  };

  const session = await getSession(parentPages[category]);
  console.log(`  Session acquired (CSRF: ${session.csrfToken.slice(0, 8)}...)`);

  const fetchFn: Record<
    CategoryName,
    (s: SessionInfo, start: number, len: number) => Promise<DataTablesResponse>
  > = {
    antitrust: fetchAntitrustPage,
    combination: fetchCombinationPage,
    press_releases: fetchPressReleasePage,
    regulations: fetchRegulationsPage,
  };

  const parseFn: Record<CategoryName, (raw: Record<string, unknown>) => CciDocument> = {
    antitrust: parseAntitrustRecord,
    combination: parseCombinationRecord,
    press_releases: parsePressReleaseRecord,
    regulations: parseRegulationRecord,
  };

  const documents: CciDocument[] = [];
  let start = 0;
  let totalRecords = 0;

  // First request to get total count
  const firstPage = await fetchFn[category](session, 0, PAGE_SIZE);
  totalRecords = firstPage.recordsTotal;
  const effectiveTotal = testLimit ? Math.min(testLimit, totalRecords) : totalRecords;

  console.log(`  Total records: ${totalRecords}${testLimit ? ` (test limit: ${testLimit})` : ''}`);

  // Parse first page
  for (const raw of firstPage.data) {
    if (documents.length >= effectiveTotal) break;
    try {
      documents.push(parseFn[category](raw));
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
      // Refresh session every 200 records to avoid CSRF expiry
      let activeSession = session;
      if (start % 200 === 0 && start > 0) {
        console.log(`  [SESSION] Refreshing at offset ${start}...`);
        activeSession = await getSession(parentPages[category]);
        // Update session reference
        Object.assign(session, activeSession);
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
      }

      const page = await fetchFn[category](session, start, pageLen);

      for (const raw of page.data) {
        if (documents.length >= effectiveTotal) break;
        try {
          documents.push(parseFn[category](raw));
        } catch (err) {
          console.error(
            `  [PARSE ERROR] ID=${raw.id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }

      const pct = ((documents.length / effectiveTotal) * 100).toFixed(1);
      console.log(`  [${pct}%] Fetched ${documents.length}/${effectiveTotal} records`);

      start += page.data.length;

      // Safety: break if server returns no data
      if (page.data.length === 0) {
        console.warn(`  [WARN] Empty page at offset ${start}, stopping.`);
        break;
      }
    } catch (err) {
      console.error(
        `  [ERROR] Page at offset ${start}: ${err instanceof Error ? err.message : err}`,
      );
      // Try refreshing session and retrying once
      try {
        console.log(`  [RETRY] Refreshing session and retrying...`);
        const newSession = await getSession(parentPages[category]);
        Object.assign(session, newSession);
        await sleep(DELAY_BETWEEN_REQUESTS_MS * 2);

        const retryPage = await fetchFn[category](session, start, pageLen);
        for (const raw of retryPage.data) {
          if (documents.length >= effectiveTotal) break;
          try {
            documents.push(parseFn[category](raw));
          } catch (parseErr) {
            console.error(`  [PARSE ERROR on retry]: ${parseErr}`);
          }
        }
        start += retryPage.data.length;
      } catch (retryErr) {
        console.error(`  [FATAL] Retry failed at offset ${start}: ${retryErr}`);
        break;
      }
    }
  }

  const totalPdfs = documents.reduce((sum, d) => sum + d.pdf_urls.length, 0);
  console.log(`  Done: ${documents.length} documents, ${totalPdfs} PDF links`);

  return {
    category,
    scraped_at: new Date().toISOString(),
    total_records: documents.length,
    total_pdfs: totalPdfs,
    documents,
  };
}

async function scrapeAllMetadata(
  categories: CategoryName[],
  testLimit?: number,
): Promise<Map<CategoryName, CategoryMetadata>> {
  const progress = loadProgress();
  const allMetadata = new Map<CategoryName, CategoryMetadata>();

  console.log(`\n=== Phase 1: Scraping metadata for ${categories.length} categories ===`);

  for (const cat of categories) {
    const metaFile = path.join(METADATA_DIR, `cci-${cat}.json`);

    // Check if already scraped (skip in test mode to always re-scrape)
    if (!testLimit && progress.metadata_completed.includes(cat) && fs.existsSync(metaFile)) {
      console.log(`\n  [SKIP] ${cat} - already scraped`);
      const existing: CategoryMetadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      allMetadata.set(cat, existing);
      continue;
    }

    try {
      const metadata = await scrapeCategory(cat, testLimit);

      // Save per-category metadata
      fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2));
      allMetadata.set(cat, metadata);

      // Update progress
      if (!progress.metadata_completed.includes(cat)) {
        progress.metadata_completed.push(cat);
      }
      saveProgress(progress);
    } catch (err) {
      console.error(`  [ERROR] ${cat}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Write combined JSONL
  console.log(`\n  Writing combined JSONL -> ${COMBINED_JSONL}`);
  const jsonlStream = fs.createWriteStream(COMBINED_JSONL);
  let totalDocs = 0;
  let totalPdfs = 0;

  for (const cat of ALL_CATEGORIES) {
    const meta = allMetadata.get(cat);
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
  allMetadata: Map<CategoryName, CategoryMetadata>,
  maxPdfs?: number,
): Promise<void> {
  const progress = loadProgress();
  let downloadedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  // Build download queue
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

function verify(allMetadata: Map<CategoryName, CategoryMetadata>): void {
  console.log(`\n=== Phase 3: Verification ===\n`);

  let totalExpected = 0;
  let totalFound = 0;
  const missing: { category: string; id: number; url: string }[] = [];

  for (const [cat, meta] of allMetadata) {
    const catDir = path.join(PDFS_DIR, cat);
    let catExpected = 0;
    let catFound = 0;

    for (const doc of meta.documents) {
      for (let i = 0; i < doc.pdf_filenames.length; i++) {
        catExpected++;
        const dest = path.join(catDir, doc.pdf_filenames[i]);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          catFound++;
        } else {
          missing.push({
            category: cat,
            id: doc.id,
            url: doc.pdf_urls[i] || 'N/A',
          });
        }
      }
    }

    totalExpected += catExpected;
    totalFound += catFound;

    const status = catFound === catExpected ? 'OK' : 'INCOMPLETE';
    console.log(`  ${cat}: ${catFound}/${catExpected} PDFs [${status}]`);
  }

  console.log(`\n  TOTAL: ${totalFound}/${totalExpected} PDFs downloaded`);

  if (missing.length > 0) {
    const missingFile = path.join(DATA_DIR, 'missing-pdfs.json');
    fs.writeFileSync(missingFile, JSON.stringify(missing, null, 2));
    console.log(`  Missing ${missing.length} PDFs (saved to ${missingFile})`);
    for (const m of missing.slice(0, 10)) {
      console.log(`    - ${m.category} ID=${m.id}: ${m.url}`);
    }
    if (missing.length > 10) {
      console.log(`    ... and ${missing.length - 10} more`);
    }
  } else {
    console.log(`  All PDFs accounted for!`);
  }
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
  const catFlags: CategoryName[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      const val = args[i + 1] as CategoryName;
      if (ALL_CATEGORIES.includes(val)) {
        catFlags.push(val);
      } else {
        console.error(`Unknown category: ${val}. Valid: ${ALL_CATEGORIES.join(', ')}`);
        process.exit(1);
      }
    }
  }

  const categories = catFlags.length > 0 ? catFlags : ALL_CATEGORIES;
  const testLimit = isTest ? 5 : undefined;

  // Ensure directories exist
  fs.mkdirSync(METADATA_DIR, { recursive: true });
  fs.mkdirSync(PDFS_DIR, { recursive: true });

  console.log(`CCI Scraper - Competition Commission of India`);
  console.log(`  Categories: ${categories.join(', ')}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Concurrency: ${MAX_CONCURRENT}`);
  console.log(
    `  Mode: ${metadataOnly ? 'metadata-only' : downloadOnly ? 'download-only' : 'full'}`,
  );
  if (isTest) console.log(`  TEST MODE: ${testLimit} records per category`);

  let allMetadata: Map<CategoryName, CategoryMetadata>;

  if (downloadOnly) {
    allMetadata = new Map();
    for (const cat of categories) {
      const metaFile = path.join(METADATA_DIR, `cci-${cat}.json`);
      if (fs.existsSync(metaFile)) {
        allMetadata.set(cat, JSON.parse(fs.readFileSync(metaFile, 'utf-8')));
      } else {
        console.error(`  [ERROR] No metadata for ${cat}. Run metadata scrape first.`);
      }
    }
  } else {
    allMetadata = await scrapeAllMetadata(categories, testLimit);
  }

  if (!metadataOnly) {
    const maxPdfs = isTest ? 10 : undefined;
    await downloadPdfs(allMetadata, maxPdfs);
  }

  verify(allMetadata);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
