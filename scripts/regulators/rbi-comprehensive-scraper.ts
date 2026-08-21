/**
 * RBI Comprehensive Scraper - All Sections
 *
 * Scrapes ALL remaining RBI document types beyond notifications & master directions:
 *   1. Press Releases     — prid 1..63000
 *   2. Circulars Index    — year/month listings (1991-2026)
 *   3. FEMA Notifications — year/month listings (2000-2026)
 *   4. Master Circulars   — listing page extraction
 *   5. Speeches           — year/month listings (1990-2026)
 *   6. RBI Bulletin       — year/month listings (1997-2026)
 *   7. Annual Reports     — listing page extraction
 *   8. Vision Documents   — listing page extraction
 *   9. FAQs               — category listing extraction
 *
 * Usage:
 *   npx tsx scripts/rbi-comprehensive-scraper.ts
 *
 * Env vars:
 *   SECTION    — "press_releases"|"circulars"|"fema"|"master_circulars"|"speeches"|
 *                "bulletin"|"annual_reports"|"vision_docs"|"faqs"|"all" (default "all")
 *   WORKERS    — concurrent workers for ID enumeration (default 20)
 *   DELAY_MS   — ms between requests per worker (default 50)
 *   TEST_MODE  — "true" to limit scope
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SECTION = process.env.SECTION || 'all';
const WORKERS = parseInt(process.env.WORKERS || '20', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '50', 10);
const TEST_MODE = process.env.TEST_MODE === 'true';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const PROGRESS_LOG_INTERVAL = 50;

const BASE_URL = 'https://rbi.org.in';
const DATA_DIR = path.join(process.cwd(), 'data', 'legal-sources', 'rbi', 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'comprehensive-progress.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RbiDocument {
  id: number | string;
  type: string;
  title: string;
  date: string;
  refNumber: string;
  department: string;
  pdfUrl: string | null;
  pdfSize: string | null;
  htmlUrl: string;
  country: 'IN';
  source: 'RBI';
  signatory: string | null;
  speaker?: string;
  category?: string;
  scrapedAt: string;
}

interface Stats {
  totalScanned: number;
  found: number;
  empty: number;
  errors: number;
  startTime: number;
}

function freshStats(): Stats {
  return { totalScanned: 0, found: 0, empty: 0, errors: 0, startTime: Date.now() };
}

let stats = freshStats();

// ---------------------------------------------------------------------------
// HTTP utilities
// ---------------------------------------------------------------------------

function fetchUrl(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;
  const method = options.method || 'GET';

  return new Promise((resolve, reject) => {
    const reqOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        ...(options.headers || {}),
      },
    };

    if (options.body) {
      reqOptions.headers = {
        ...reqOptions.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(options.body).toString(),
      };
    }

    const req = lib.request(reqOptions, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        if (location) {
          const redirectUrl = location.startsWith('http')
            ? location
            : `${parsed.protocol}//${parsed.host}${location}`;
          res.resume();
          fetchUrl(redirectUrl, options).then(resolve).catch(reject);
          return;
        }
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers as Record<string, string>,
        });
      });
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
    req.on('error', reject);

    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchWithRetry(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
  retries = MAX_RETRIES,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchUrl(url, options);
    } catch (err) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Universal PDF href extractor — handles both http/https and single/double quotes.
 * RBI site inconsistently uses href="..." and href='...' across sections,
 * and uses http:// for master circulars but https:// for most others.
 */
function extractPdfUrls(html: string): Array<{ url: string; afterIndex: number }> {
  const regex = /href=["'](https?:\/\/rbidocs\.rbi\.org\.in\/rdocs\/[^"']+\.(?:PDF|pdf))["']/gi;
  const results: Array<{ url: string; afterIndex: number }> = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    results.push({ url: match[1], afterIndex: match.index + match[0].length });
  }
  return results;
}

/** Find a PDF URL near a specific pattern in the HTML (within charRadius characters) */
function findPdfNear(html: string, anchor: string, charRadius = 2000): string | null {
  const idx = html.indexOf(anchor);
  if (idx < 0) return null;
  const slice = html.substring(idx, Math.min(html.length, idx + charRadius));
  const pdfMatch = slice.match(
    /href=["'](https?:\/\/rbidocs\.rbi\.org\.in\/rdocs\/[^"']+\.(?:PDF|pdf))["']/i,
  );
  return pdfMatch ? pdfMatch[1] : null;
}

/** Extract size string (e.g. "123 kb") near an index position */
function findSizeNear(html: string, startIdx: number, charRadius = 500): string | null {
  const slice = html.substring(startIdx, Math.min(html.length, startIdx + charRadius));
  const sizeMatch = slice.match(/(\d[\d,]*)\s*kb/i);
  return sizeMatch ? `${sizeMatch[1]} kb` : null;
}

// ---------------------------------------------------------------------------
// JSONL writer
// ---------------------------------------------------------------------------

function appendJsonl(filePath: string, doc: RbiDocument): void {
  fs.appendFileSync(filePath, JSON.stringify(doc) + '\n');
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function printStatus(label: string, current: number, total: number): void {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const speed = stats.totalScanned / (elapsed / 60);
  const pct = total > 0 ? ((current / total) * 100).toFixed(1) : '?';

  process.stdout.write(
    `\r[${label}] ${pct}% ${current}/${total} | ` +
      `found=${stats.found} empty=${stats.empty} err=${stats.errors} | ` +
      `speed=${speed.toFixed(0)}/min   `,
  );
}

// ---------------------------------------------------------------------------
// ASP.NET postback helper
// ---------------------------------------------------------------------------

function extractViewState(html: string): {
  viewState: string;
  eventValidation: string;
  viewStateGen: string;
} {
  const vsMatch = html.match(/id="__VIEWSTATE"\s+value="([^"]*)"/);
  const evMatch = html.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/);
  const vsgMatch = html.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/);

  return {
    viewState: vsMatch ? vsMatch[1] : '',
    eventValidation: evMatch ? evMatch[1] : '',
    viewStateGen: vsgMatch ? vsgMatch[1] : '',
  };
}

function buildPostBody(
  viewState: string,
  eventValidation: string,
  viewStateGen: string,
  extraFields: Record<string, string>,
): string {
  const params: Record<string, string> = {
    __VIEWSTATE: viewState,
    __EVENTVALIDATION: eventValidation,
    __VIEWSTATEGENERATOR: viewStateGen,
    ...extraFields,
  };

  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ---------------------------------------------------------------------------
// ASP.NET year/month listing scraper (generic)
// ---------------------------------------------------------------------------

interface ListingConfig {
  pageUrl: string;
  label: string;
  outputFile: string;
  startYear: number;
  endYear: number;
  parseEntries: (html: string, year: number, month: number) => RbiDocument[];
  btnFieldName?: string;
}

async function scrapeYearMonthListings(config: ListingConfig): Promise<number> {
  const {
    pageUrl,
    label,
    outputFile,
    startYear,
    endYear,
    parseEntries,
    btnFieldName = 'btn',
  } = config;

  console.log(`\n--- Scraping ${label} (${startYear}-${endYear}) ---`);

  const fullUrl = `${BASE_URL}/Scripts/${pageUrl}`;
  let totalFound = 0;

  // Step 1: Fetch the initial page to get ViewState
  let resp: { status: number; body: string; headers: Record<string, string> };
  try {
    resp = await fetchWithRetry(fullUrl);
  } catch (err) {
    console.log(`  [ERR] Failed to fetch initial page: ${err}`);
    return 0;
  }

  let { viewState, eventValidation, viewStateGen } = extractViewState(resp.body);

  // Parse initial page entries (current month)
  const initialEntries = parseEntries(resp.body, endYear, new Date().getMonth() + 1);
  for (const entry of initialEntries) {
    appendJsonl(outputFile, entry);
    totalFound++;
  }

  // Step 2: Iterate through all years and months
  for (let year = endYear; year >= startYear; year--) {
    const maxMonth = year === endYear ? new Date().getMonth() + 1 : 12;
    const minMonth = 1;

    for (let month = maxMonth; month >= minMonth; month--) {
      // Skip current month (already parsed from initial page)
      if (year === endYear && month === new Date().getMonth() + 1) continue;

      try {
        const postBody = buildPostBody(viewState, eventValidation, viewStateGen, {
          hdnYear: year.toString(),
          hdnMonth: month.toString(),
          [btnFieldName]: '',
        });

        resp = await fetchWithRetry(fullUrl, {
          method: 'POST',
          body: postBody,
          headers: { Referer: fullUrl },
        });

        // Update ViewState for next request
        const newVs = extractViewState(resp.body);
        if (newVs.viewState) {
          viewState = newVs.viewState;
          eventValidation = newVs.eventValidation;
          viewStateGen = newVs.viewStateGen;
        }

        const entries = parseEntries(resp.body, year, month);
        for (const entry of entries) {
          appendJsonl(outputFile, entry);
          totalFound++;
        }

        stats.totalScanned++;
        const totalMonths = (endYear - startYear + 1) * 12;
        const currentMonth = (endYear - year) * 12 + (maxMonth - month);
        if (stats.totalScanned % 5 === 0 || entries.length > 0) {
          process.stdout.write(
            `\r  [${label}] ${year}-${String(month).padStart(2, '0')} | ` +
              `found=${totalFound} | ${entries.length} this page   `,
          );
        }

        await sleep(200); // polite delay between postbacks
      } catch (err) {
        stats.errors++;
        // ViewState expired, refetch initial page
        try {
          resp = await fetchWithRetry(fullUrl);
          const newVs = extractViewState(resp.body);
          viewState = newVs.viewState;
          eventValidation = newVs.eventValidation;
          viewStateGen = newVs.viewStateGen;
        } catch {
          console.log(`\n  [ERR] Lost ViewState at ${year}-${month}, skipping`);
        }
      }
    }
  }

  console.log(`\n  [DONE] ${label}: ${totalFound} documents found`);
  return totalFound;
}

// ---------------------------------------------------------------------------
// Section: Circulars (year/month listings, 1991-2026)
// ---------------------------------------------------------------------------

function parseCircularEntries(html: string, year: number, month: number): RbiDocument[] {
  const docs: RbiDocument[] = [];

  // Circulars are in a table with circular number, date, department, subject
  // Pattern: rows with circular number link, date, department, subject
  const rowRegex =
    /CircularIndexDisplay\.aspx\?Id=(\d+)[^"]*"[^>]*>([^<]+)<[\s\S]*?<td[^>]*>(\d{1,2}\.\d{1,2}\.\d{4})<[\s\S]*?<td[^>]*>([^<]+)<[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>([^<]*)</g;

  // Simpler approach: find all circular IDs and basic info
  const idRegex = /CircularIndexDisplay\.aspx\?Id=(\d+)/g;
  const ids: number[] = [];
  let match;
  while ((match = idRegex.exec(html)) !== null) {
    ids.push(parseInt(match[1], 10));
  }

  // Extract table rows more flexibly
  // Each circular is in a table row with multiple cells
  const tableSection = html.match(/class="tablebg"[\s\S]*?<\/table>/g);
  if (!tableSection) return docs;

  for (const table of tableSection) {
    // Find all rows
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let trMatch;
    while ((trMatch = trRegex.exec(table)) !== null) {
      const row = trMatch[1];

      // Extract circular ID
      const idMatch = row.match(/CircularIndexDisplay\.aspx\?Id=(\d+)/);
      if (!idMatch) continue;
      const id = parseInt(idMatch[1], 10);

      // Extract cells
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
      const cells: string[] = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(row)) !== null) {
        cells.push(decodeHtmlEntities(cellMatch[1]));
      }

      if (cells.length < 3) continue;

      // RBI circular tables vary: some have [circularNo, date, dept, subject, meantFor]
      // Others may have fewer columns. Extract what we can.
      const refNumber = cells[0] || '';
      const date = cells.length >= 4 ? cells[1] || '' : '';
      const department = cells.length >= 4 ? cells[2] || '' : cells.length >= 3 ? cells[1] : '';
      const subject = cells.length >= 4 ? cells[3] || '' : cells[cells.length - 1] || '';

      if (!subject && !refNumber) continue;

      docs.push({
        id,
        type: 'circular',
        title: subject || refNumber,
        date,
        refNumber,
        department,
        pdfUrl: null, // Circulars listing doesn't have PDFs, they're on detail pages
        pdfSize: null,
        htmlUrl: `${BASE_URL}/Scripts/BS_CircularIndexDisplay.aspx?Id=${id}`,
        country: 'IN',
        source: 'RBI',
        signatory: null,
        scrapedAt: new Date().toISOString(),
      });
    }
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Section: FEMA Notifications (year/month listings, 2000-2026)
// ---------------------------------------------------------------------------

function parseFemaEntries(html: string, year: number, month: number): RbiDocument[] {
  const docs: RbiDocument[] = [];

  // FEMA entries: links to BS_FemaNotifications.aspx?Id=XXXX (both quote styles)
  const entryRegex = /FemaNotifications\.aspx\?Id=(\d+)[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  const entries: Array<{ id: number; title: string; matchIndex: number }> = [];

  while ((match = entryRegex.exec(html)) !== null) {
    entries.push({
      id: parseInt(match[1], 10),
      title: decodeHtmlEntities(match[2]),
      matchIndex: match.index,
    });
  }

  for (const entry of entries) {
    const pdfUrl = findPdfNear(html, `Id=${entry.id}`, 2000);
    const pdfSize = findSizeNear(html, entry.matchIndex, 2000);

    // Extract date
    const dateSlice = html.substring(entry.matchIndex, entry.matchIndex + 500);
    const dateMatch = dateSlice.match(/([A-Z][a-z]+ \d{1,2},?\s*\d{4})/);

    docs.push({
      id: entry.id,
      type: 'fema_notification',
      title: entry.title,
      date: dateMatch ? dateMatch[1].trim() : `${year}-${String(month).padStart(2, '0')}`,
      refNumber: '',
      department: 'Foreign Exchange Department',
      pdfUrl,
      pdfSize,
      htmlUrl: `${BASE_URL}/Scripts/BS_FemaNotifications.aspx?Id=${entry.id}`,
      country: 'IN',
      source: 'RBI',
      signatory: null,
      scrapedAt: new Date().toISOString(),
    });
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Section: Press Releases (ID enumeration, prid 1..63000)
// ---------------------------------------------------------------------------

function parsePressReleasePage(html: string, id: number): RbiDocument | null {
  if (!html.includes('class="tablebg"') && !html.includes('class="tableheader"')) {
    if (!html.includes('Press Releases') || html.length < 15000) return null;
  }

  // Title extraction — RBI press releases put title after date line, inside <b> tag
  const titleMatch =
    html.match(/class="tableheader"[^>]*><b>([^<]+)<\/b>/) ||
    html.match(/<title>([^<]+)\s*-\s*Reserve Bank/);
  let title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  // Some press releases have only "Date : ..." in the header, title is in body
  if (!title || title === 'Press Releases' || /^\s*Date\s*:/i.test(title)) {
    // Try alternate title location: first bold text in tablebg
    const altTitle = html.match(/class="tablebg"[\s\S]*?<b>([^<]{10,300})<\/b>/);
    title = altTitle ? decodeHtmlEntities(altTitle[1].trim()) : '';
  }
  if (!title || title === 'Press Releases') return null;

  // PDF URL — universal extractor
  const pdfMatch = html.match(
    /href=["'](https?:\/\/rbidocs\.rbi\.org\.in\/rdocs\/[^"']+\.(?:PDF|pdf))["']/i,
  );
  const pdfUrl = pdfMatch ? pdfMatch[1] : null;

  const pdfSizeMatch = html.match(/aria-hidden="true">([^<]+)<\/span>\)/);
  const pdfSize = pdfSizeMatch ? pdfSizeMatch[1].trim() : null;

  const dateMatch = html.match(/align="right">\s*([A-Z][a-z]+ \d{1,2},? \d{4})/);
  const date = dateMatch ? dateMatch[1].trim() : '';

  return {
    id,
    type: 'press_release',
    title,
    date,
    refNumber: '',
    department: '',
    pdfUrl,
    pdfSize,
    htmlUrl: `${BASE_URL}/Scripts/BS_PressReleaseDisplay.aspx?prid=${id}`,
    country: 'IN',
    source: 'RBI',
    signatory: null,
    scrapedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Section: Speeches (year/month listings, 1990-2026)
// ---------------------------------------------------------------------------

function parseSpeechEntries(html: string, year: number, month: number): RbiDocument[] {
  const docs: RbiDocument[] = [];

  // Speech entries: SpeechesView.aspx?Id=XXXX (both quote styles)
  const entryRegex = /SpeechesView\.aspx\?Id=(\d+)[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  const entries: Array<{ id: number; title: string; matchIndex: number }> = [];

  while ((match = entryRegex.exec(html)) !== null) {
    entries.push({
      id: parseInt(match[1], 10),
      title: decodeHtmlEntities(match[2]),
      matchIndex: match.index,
    });
  }

  for (const entry of entries) {
    const pdfUrl = findPdfNear(html, `Id=${entry.id}`, 2000);
    const pdfSize = findSizeNear(html, entry.matchIndex, 2000);

    // Date: found in table header row before the entry
    const beforeSlice = html.substring(Math.max(0, entry.matchIndex - 500), entry.matchIndex);
    const dateMatch =
      beforeSlice.match(/<b>(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})<\/b>/) ||
      beforeSlice.match(/([A-Z][a-z]+ \d{1,2},?\s*\d{4})/);

    docs.push({
      id: entry.id,
      type: 'speech',
      title: entry.title,
      date: dateMatch ? dateMatch[1].trim() : `${year}-${String(month).padStart(2, '0')}`,
      refNumber: '',
      department: '',
      pdfUrl,
      pdfSize,
      htmlUrl: `${BASE_URL}/Scripts/BS_SpeechesView.aspx?Id=${entry.id}`,
      country: 'IN',
      source: 'RBI',
      signatory: null,
      scrapedAt: new Date().toISOString(),
    });
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Section: RBI Bulletin (year/month listings, 1997-2026)
// ---------------------------------------------------------------------------

function parseBulletinEntries(html: string, year: number, month: number): RbiDocument[] {
  const docs: RbiDocument[] = [];
  const seenIds = new Set<string>();

  // Bulletin page structure: each row has a ViewBulletin entry link + adjacent PDF link
  // HTML uses single-quoted hrefs: href='https://rbidocs.rbi.org.in/rdocs/Bulletin/PDFs/...'
  const entryRegex = /ViewBulletin\.aspx\?Id=(\d+)[^>]*>([\s\S]*?)<\/a>/g;
  let match;

  while ((match = entryRegex.exec(html)) !== null) {
    const id = parseInt(match[1], 10);
    const title = decodeHtmlEntities(match[2]);
    const key = `bulletin-${id}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);

    // Find PDF URL near this entry (within 2000 chars)
    const pdfUrl = findPdfNear(html, `Id=${id}`, 2000);
    const pdfSize = findSizeNear(html, match.index, 2000);

    docs.push({
      id,
      type: 'bulletin',
      title: title || `Bulletin Entry ${id}`,
      date: `${year}-${String(month).padStart(2, '0')}`,
      refNumber: '',
      department: 'RBI Bulletin',
      pdfUrl,
      pdfSize,
      htmlUrl: `${BASE_URL}/Scripts/BS_ViewBulletin.aspx?Id=${id}`,
      country: 'IN',
      source: 'RBI',
      signatory: null,
      scrapedAt: new Date().toISOString(),
    });
  }

  // Also capture any standalone PDF links (Bulletin PDFs without entry links)
  const allPdfs = extractPdfUrls(html);
  for (const pdf of allPdfs) {
    if (!pdf.url.toLowerCase().includes('/bulletin/')) continue;
    // Skip if already captured via entry link
    if (docs.some((d) => d.pdfUrl === pdf.url)) continue;

    const filenameMatch = pdf.url.match(/\/([^/]+)$/);
    const filename = filenameMatch ? filenameMatch[1] : pdf.url;
    const key = `bulletin-pdf-${filename}`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);

    // Get title from nearby text
    const beforeSlice = html.substring(Math.max(0, pdf.afterIndex - 500), pdf.afterIndex);
    const titleMatch = beforeSlice.match(/>([^<]{5,200})<\/a>\s*$/m);

    docs.push({
      id: `bulletin-${year}-${month}-${filename}`,
      type: 'bulletin',
      title: titleMatch ? decodeHtmlEntities(titleMatch[1]) : filename,
      date: `${year}-${String(month).padStart(2, '0')}`,
      refNumber: '',
      department: 'RBI Bulletin',
      pdfUrl: pdf.url,
      pdfSize: findSizeNear(html, pdf.afterIndex, 300),
      htmlUrl: `${BASE_URL}/Scripts/BS_ViewBulletin.aspx`,
      country: 'IN',
      source: 'RBI',
      signatory: null,
      scrapedAt: new Date().toISOString(),
    });
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Section: Master Circulars (listing page scrape)
// ---------------------------------------------------------------------------

async function scrapeMasterCirculars(): Promise<number> {
  console.log('\n--- Scraping Master Circulars ---');
  const outputFile = path.join(DATA_DIR, 'master-circulars.jsonl');
  const url = `${BASE_URL}/Scripts/BS_ViewMasterCirculars.aspx`;
  const seenIds = new Set<number>();

  let totalFound = 0;

  function extractMcEntries(html: string, fallbackYear: string): number {
    let found = 0;
    // Master circulars use double-quoted hrefs but http:// (not https://)
    const entryRegex = /MasterCirculars\.aspx\?Id=(\d+)[^>]*>([\s\S]*?)<\/a>/g;
    let match;

    while ((match = entryRegex.exec(html)) !== null) {
      const id = parseInt(match[1], 10);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const title = decodeHtmlEntities(match[2]);
      const pdfUrl = findPdfNear(html, `Id=${id}`, 3000);
      const pdfSize = findSizeNear(html, match.index, 3000);

      // Date from table header
      const beforeSlice = html.substring(Math.max(0, match.index - 500), match.index);
      const dateMatch =
        beforeSlice.match(/<b>(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})<\/b>/) ||
        beforeSlice.match(/([A-Z][a-z]+ \d{1,2},?\s*\d{4})/);

      const doc: RbiDocument = {
        id,
        type: 'master_circular',
        title,
        date: dateMatch ? dateMatch[1].trim() : fallbackYear,
        refNumber: '',
        department: '',
        pdfUrl,
        pdfSize,
        htmlUrl: `${BASE_URL}/Scripts/BS_ViewMasterCirculars.aspx?Id=${id}&Mode=0`,
        country: 'IN',
        source: 'RBI',
        signatory: null,
        scrapedAt: new Date().toISOString(),
      };

      appendJsonl(outputFile, doc);
      found++;
      totalFound++;
    }
    return found;
  }

  try {
    const resp = await fetchWithRetry(url);
    extractMcEntries(resp.body, '');

    // Year postback for historical master circulars
    let { viewState, eventValidation, viewStateGen } = extractViewState(resp.body);

    if (viewState) {
      for (let year = 2025; year >= 2000; year--) {
        try {
          const postBody = buildPostBody(viewState, eventValidation, viewStateGen, {
            hdnYear: year.toString(),
            hdnMonth: '0',
            btn: '',
          });

          const yearResp = await fetchWithRetry(url, {
            method: 'POST',
            body: postBody,
            headers: { Referer: url },
          });

          // Update ViewState
          const newVs = extractViewState(yearResp.body);
          if (newVs.viewState) {
            viewState = newVs.viewState;
            eventValidation = newVs.eventValidation;
            viewStateGen = newVs.viewStateGen;
          }

          extractMcEntries(yearResp.body, year.toString());
          process.stdout.write(`\r  [MasterCirc] year=${year} total=${totalFound}   `);
          await sleep(200);
        } catch {
          // year might not have entries
        }
      }
    }
  } catch (err) {
    console.log(`  [ERR] ${err}`);
  }

  console.log(`\n  [DONE] Master Circulars: ${totalFound} documents`);
  return totalFound;
}

// ---------------------------------------------------------------------------
// Section: Vision Documents (listing page scrape)
// ---------------------------------------------------------------------------

async function scrapeVisionDocuments(): Promise<number> {
  console.log('\n--- Scraping Vision Documents ---');
  const outputFile = path.join(DATA_DIR, 'vision-documents.jsonl');
  const url = `${BASE_URL}/Scripts/PublicationVisionDocuments.aspx`;

  let totalFound = 0;

  try {
    const resp = await fetchWithRetry(url);
    const html = resp.body;

    // Vision documents structure (from probe):
    //   <td><a class='link2' href=PublicationVisionDocuments.aspx?Id=1202>Title</a></td>
    //   <td><a id='APDF_...' target='_blank' href='https://rbidocs.../PDFs/FILE.PDF'>
    //        <img alt='PDF - Title'>  <span>123 kb</span></a></td>
    //
    // Note: uses SINGLE quotes for href, and both /PublicationReport/PDFs/ and /content/pdfs/

    // Strategy: find all entry links first, then find adjacent PDFs
    const entryRegex = /PublicationVisionDocuments\.aspx\?Id=(\d+)[^>]*>([^<]+)<\/a>/g;
    let match;

    while ((match = entryRegex.exec(html)) !== null) {
      const id = parseInt(match[1], 10);
      const title = decodeHtmlEntities(match[2]);

      // Find PDF URL near this entry (within 1000 chars after)
      const pdfUrl = findPdfNear(html, `Id=${id}`, 1000);

      // Date from table header before this entry
      const beforeSlice = html.substring(Math.max(0, match.index - 500), match.index);
      const dateMatch =
        beforeSlice.match(/<b>(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})<\/b>/) ||
        beforeSlice.match(/(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/);

      // Size from after entry
      const pdfSize = findSizeNear(html, match.index, 1000);

      const filenameMatch = pdfUrl?.match(/\/([^/]+)$/);
      const filename = filenameMatch ? filenameMatch[1] : `vision-${id}`;

      const doc: RbiDocument = {
        id: `vision-${id}`,
        type: 'vision_document',
        title,
        date: dateMatch ? dateMatch[1] : '',
        refNumber: '',
        department: 'RBI Publication',
        pdfUrl,
        pdfSize,
        htmlUrl: `${BASE_URL}/Scripts/PublicationVisionDocuments.aspx?Id=${id}`,
        country: 'IN',
        source: 'RBI',
        signatory: null,
        scrapedAt: new Date().toISOString(),
      };

      appendJsonl(outputFile, doc);
      totalFound++;
    }

    // Also capture any PDFs not associated with entry links (sidebar vision docs)
    const allPdfs = extractPdfUrls(html);
    for (const pdf of allPdfs) {
      // Skip sidebar/nav PDFs (Utkarsh, Accessibility)
      if (pdf.url.includes('content/pdfs/Utkarsh') || pdf.url.includes('Accessibility')) continue;
      // Skip if already captured
      if (docs_contains_pdf(totalFound, outputFile, pdf.url)) continue;

      const filenameMatch = pdf.url.match(/\/([^/]+)$/);
      const filename = filenameMatch ? filenameMatch[1] : pdf.url;

      const doc: RbiDocument = {
        id: `vision-extra-${filename}`,
        type: 'vision_document',
        title: filename.replace(/\.PDF$/i, ''),
        date: '',
        refNumber: '',
        department: 'RBI Publication',
        pdfUrl: pdf.url,
        pdfSize: findSizeNear(html, pdf.afterIndex, 300),
        htmlUrl: url,
        country: 'IN',
        source: 'RBI',
        signatory: null,
        scrapedAt: new Date().toISOString(),
      };

      appendJsonl(outputFile, doc);
      totalFound++;
    }
  } catch (err) {
    console.log(`  [ERR] ${err}`);
  }

  console.log(`  [DONE] Vision Documents: ${totalFound} documents`);
  return totalFound;
}

/** Quick check if a PDF URL already exists in a JSONL file (for dedup) */
function docs_contains_pdf(count: number, filePath: string, pdfUrl: string): boolean {
  if (count === 0 || !fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.includes(pdfUrl);
}

// ---------------------------------------------------------------------------
// Section: Annual Reports (listing page scrape)
// ---------------------------------------------------------------------------

async function scrapeAnnualReports(): Promise<number> {
  console.log('\n--- Scraping Annual Reports ---');
  const outputFile = path.join(DATA_DIR, 'annual-reports.jsonl');
  const baseUrl = `${BASE_URL}/Scripts/AnnualReportPublications.aspx`;
  const seenPdfs = new Set<string>();

  let totalFound = 0;

  function extractAnnualReportPdfs(html: string, year: string): number {
    let found = 0;
    const allPdfs = extractPdfUrls(html);

    for (const pdf of allPdfs) {
      // Skip sidebar/nav PDFs
      if (pdf.url.includes('content/pdfs/Utkarsh') || pdf.url.includes('Accessibility')) continue;
      if (seenPdfs.has(pdf.url)) continue;
      seenPdfs.add(pdf.url);

      const filenameMatch = pdf.url.match(/\/([^/]+)$/);
      const filename = filenameMatch ? filenameMatch[1] : pdf.url;

      // Title from nearby text
      const beforeSlice = html.substring(Math.max(0, pdf.afterIndex - 500), pdf.afterIndex);
      const titleMatch = beforeSlice.match(/>([^<]{5,300})<\/a>\s*$/m);

      const doc: RbiDocument = {
        id: `annual-${year}-${filename}`,
        type: 'annual_report',
        title: titleMatch ? decodeHtmlEntities(titleMatch[1]) : filename.replace(/\.PDF$/i, ''),
        date: year,
        refNumber: '',
        department: 'RBI Annual Report',
        pdfUrl: pdf.url,
        pdfSize: findSizeNear(html, pdf.afterIndex, 300),
        htmlUrl: baseUrl,
        country: 'IN',
        source: 'RBI',
        signatory: null,
        scrapedAt: new Date().toISOString(),
      };

      appendJsonl(outputFile, doc);
      found++;
      totalFound++;
    }
    return found;
  }

  try {
    // Initial page
    const resp = await fetchWithRetry(baseUrl);
    extractAnnualReportPdfs(resp.body, '');

    // Year postback navigation
    let { viewState, eventValidation, viewStateGen } = extractViewState(resp.body);

    if (viewState) {
      const endYear = TEST_MODE ? 2024 : 2025;
      const startYear = TEST_MODE ? 2023 : 1990;

      for (let year = endYear; year >= startYear; year--) {
        try {
          const postBody = buildPostBody(viewState, eventValidation, viewStateGen, {
            hdnYear: year.toString(),
            hdnMonth: '0',
            btn: '',
          });

          const yearResp = await fetchWithRetry(baseUrl, {
            method: 'POST',
            body: postBody,
            headers: { Referer: baseUrl },
          });

          // Update ViewState
          const newVs = extractViewState(yearResp.body);
          if (newVs.viewState) {
            viewState = newVs.viewState;
            eventValidation = newVs.eventValidation;
            viewStateGen = newVs.viewStateGen;
          }

          extractAnnualReportPdfs(yearResp.body, year.toString());
          process.stdout.write(`\r  [AnnualRpt] year=${year} total=${totalFound}   `);
          await sleep(200);
        } catch {
          // year might not have entries
        }
      }
    }

    // Also try the main display page
    try {
      const mainResp = await fetchWithRetry(`${BASE_URL}/Scripts/AnnualReportMainDisplay.aspx`);
      extractAnnualReportPdfs(mainResp.body, '');
    } catch {
      // might not exist
    }
  } catch (err) {
    console.log(`  [ERR] ${err}`);
  }

  console.log(`\n  [DONE] Annual Reports: ${totalFound} documents`);
  return totalFound;
}

// ---------------------------------------------------------------------------
// Section: FAQs (category + detail page scrape)
// ---------------------------------------------------------------------------

async function scrapeFaqs(): Promise<number> {
  console.log('\n--- Scraping FAQs ---');
  const outputFile = path.join(DATA_DIR, 'faqs.jsonl');
  const url = `${BASE_URL}/Scripts/FAQView.aspx`;
  const seenIds = new Set<number>();

  let totalFound = 0;

  function extractFaqEntries(html: string): number {
    let found = 0;
    // FAQ links: FAQView.aspx?Id=XXX (may or may not have quotes around href value)
    // Actual format: <a class="link2" href=FAQView.aspx?Id=145><b>date</b> title</a>
    const faqRegex = /FAQView\.aspx\?Id=(\d+)[^>]*>([\s\S]*?)<\/a>/g;
    let match;

    while ((match = faqRegex.exec(html)) !== null) {
      const id = parseInt(match[1], 10);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const rawContent = match[2];
      // Date is often in <b>date</b> followed by title text
      const dateInBold = rawContent.match(/<b>([^<]+)<\/b>/);
      const date = dateInBold ? dateInBold[1].trim() : '';
      // Title is the rest after the bold date
      const title = decodeHtmlEntities(rawContent.replace(/<b>[^<]*<\/b>\s*/g, '')).trim();

      if (!title) continue;

      const doc: RbiDocument = {
        id,
        type: 'faq',
        title,
        date,
        refNumber: '',
        department: '',
        pdfUrl: null,
        pdfSize: null,
        htmlUrl: `${BASE_URL}/Scripts/FAQView.aspx?Id=${id}`,
        country: 'IN',
        source: 'RBI',
        signatory: null,
        scrapedAt: new Date().toISOString(),
      };

      appendJsonl(outputFile, doc);
      found++;
      totalFound++;
    }
    return found;
  }

  try {
    const resp = await fetchWithRetry(url);
    extractFaqEntries(resp.body);

    // Also follow category links (FAQDisplay.aspx)
    const catRegex = /href=["']?([^"'\s>]*FAQDisplay\.aspx[^"'\s>]*)["']?/g;
    let catMatch;
    const catUrls = new Set<string>();

    while ((catMatch = catRegex.exec(resp.body)) !== null) {
      const href = catMatch[1];
      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}/Scripts/${href}`;
      catUrls.add(fullUrl);
    }

    for (const catUrl of catUrls) {
      try {
        const catResp = await fetchWithRetry(catUrl);
        extractFaqEntries(catResp.body);
        await sleep(200);
      } catch {
        // category page might not work
      }
    }
  } catch (err) {
    console.log(`  [ERR] ${err}`);
  }

  console.log(`  [DONE] FAQs: ${totalFound} documents`);
  return totalFound;
}

// ---------------------------------------------------------------------------
// Section: Press Releases (ID enumeration with workers)
// ---------------------------------------------------------------------------

interface IdTask {
  id: number;
}

async function idEnumWorker(
  queue: IdTask[],
  outputFile: string,
  parser: (html: string, id: number) => RbiDocument | null,
  urlTemplate: (id: number) => string,
  label: string,
  total: number,
): Promise<void> {
  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) break;

    try {
      const url = urlTemplate(task.id);
      const resp = await fetchWithRetry(url);
      stats.totalScanned++;

      if (resp.status === 200) {
        const doc = parser(resp.body, task.id);
        if (doc) {
          stats.found++;
          appendJsonl(outputFile, doc);
        } else {
          stats.empty++;
        }
      } else {
        stats.empty++;
      }
    } catch {
      stats.totalScanned++;
      stats.errors++;
    }

    if (stats.totalScanned % PROGRESS_LOG_INTERVAL === 0) {
      printStatus(label, stats.totalScanned, total);
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
}

async function scrapePressReleases(): Promise<number> {
  const outputFile = path.join(DATA_DIR, 'press-releases.jsonl');
  const startId = 1;
  const endId = TEST_MODE ? 100 : 63000;

  console.log(`\n--- Scraping Press Releases (prid ${startId}-${endId}) ---`);

  // Check for existing entries to resume
  const existingIds = new Set<number>();
  if (fs.existsSync(outputFile)) {
    const lines = fs.readFileSync(outputFile, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const doc = JSON.parse(line);
        existingIds.add(typeof doc.id === 'number' ? doc.id : parseInt(doc.id, 10));
      } catch {}
    }
    console.log(`  Resuming: ${existingIds.size} already scraped`);
  }

  const queue: IdTask[] = [];
  for (let id = startId; id <= endId; id++) {
    if (!existingIds.has(id)) queue.push({ id });
  }

  stats = freshStats();

  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < WORKERS; i++) {
    workerPromises.push(
      idEnumWorker(
        queue,
        outputFile,
        parsePressReleasePage,
        (id) => `${BASE_URL}/Scripts/BS_PressReleaseDisplay.aspx?prid=${id}`,
        'PressRel',
        queue.length,
      ),
    );
  }

  await Promise.all(workerPromises);

  console.log(
    `\n  [DONE] Press Releases: scanned=${stats.totalScanned} found=${stats.found} errors=${stats.errors}`,
  );
  return stats.found;
}

// ---------------------------------------------------------------------------
// Progress management
// ---------------------------------------------------------------------------

interface ComprehensiveProgress {
  sections: Record<
    string,
    { found: number; status: 'pending' | 'in_progress' | 'completed'; lastUpdated: string }
  >;
  startedAt: string;
}

function loadProgress(): ComprehensiveProgress {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    } catch {}
  }
  return {
    sections: {},
    startedAt: new Date().toISOString(),
  };
}

function saveProgress(progress: ComprehensiveProgress): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function updateSectionProgress(
  progress: ComprehensiveProgress,
  section: string,
  found: number,
  status: 'pending' | 'in_progress' | 'completed',
): void {
  progress.sections[section] = {
    found,
    status,
    lastUpdated: new Date().toISOString(),
  };
  saveProgress(progress);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== RBI Comprehensive Scraper ===');
  console.log(`Section: ${SECTION} | Workers: ${WORKERS} | Delay: ${DELAY_MS}ms`);
  console.log(`Test mode: ${TEST_MODE}`);
  console.log();

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const progress = loadProgress();
  const startTime = Date.now();

  // ---- Circulars (year/month) ----
  if (SECTION === 'all' || SECTION === 'circulars') {
    updateSectionProgress(progress, 'circulars', 0, 'in_progress');
    const found = await scrapeYearMonthListings({
      pageUrl: 'BS_CircularIndexDisplay.aspx',
      label: 'Circulars',
      outputFile: path.join(DATA_DIR, 'circulars.jsonl'),
      startYear: TEST_MODE ? 2024 : 1991,
      endYear: 2026,
      parseEntries: parseCircularEntries,
    });
    updateSectionProgress(progress, 'circulars', found, 'completed');
  }

  // ---- FEMA Notifications (year/month) ----
  if (SECTION === 'all' || SECTION === 'fema') {
    updateSectionProgress(progress, 'fema', 0, 'in_progress');
    const found = await scrapeYearMonthListings({
      pageUrl: 'BS_FemaNotifications.aspx',
      label: 'FEMA Notifications',
      outputFile: path.join(DATA_DIR, 'fema-notifications.jsonl'),
      startYear: TEST_MODE ? 2024 : 2000,
      endYear: 2026,
      parseEntries: parseFemaEntries,
    });
    updateSectionProgress(progress, 'fema', found, 'completed');
  }

  // ---- Master Circulars (listing) ----
  if (SECTION === 'all' || SECTION === 'master_circulars') {
    updateSectionProgress(progress, 'master_circulars', 0, 'in_progress');
    const found = await scrapeMasterCirculars();
    updateSectionProgress(progress, 'master_circulars', found, 'completed');
  }

  // ---- Speeches (year/month) ----
  if (SECTION === 'all' || SECTION === 'speeches') {
    updateSectionProgress(progress, 'speeches', 0, 'in_progress');
    const found = await scrapeYearMonthListings({
      pageUrl: 'BS_SpeechesView.aspx',
      label: 'Speeches',
      outputFile: path.join(DATA_DIR, 'speeches.jsonl'),
      startYear: TEST_MODE ? 2024 : 1990,
      endYear: 2026,
      parseEntries: parseSpeechEntries,
    });
    updateSectionProgress(progress, 'speeches', found, 'completed');
  }

  // ---- RBI Bulletin (year/month) ----
  if (SECTION === 'all' || SECTION === 'bulletin') {
    updateSectionProgress(progress, 'bulletin', 0, 'in_progress');
    const found = await scrapeYearMonthListings({
      pageUrl: 'BS_ViewBulletin.aspx',
      label: 'RBI Bulletin',
      outputFile: path.join(DATA_DIR, 'bulletin.jsonl'),
      startYear: TEST_MODE ? 2024 : 1997,
      endYear: 2026,
      parseEntries: parseBulletinEntries,
    });
    updateSectionProgress(progress, 'bulletin', found, 'completed');
  }

  // ---- Annual Reports (listing) ----
  if (SECTION === 'all' || SECTION === 'annual_reports') {
    updateSectionProgress(progress, 'annual_reports', 0, 'in_progress');
    const found = await scrapeAnnualReports();
    updateSectionProgress(progress, 'annual_reports', found, 'completed');
  }

  // ---- Vision Documents (listing) ----
  if (SECTION === 'all' || SECTION === 'vision_docs') {
    updateSectionProgress(progress, 'vision_docs', 0, 'in_progress');
    const found = await scrapeVisionDocuments();
    updateSectionProgress(progress, 'vision_docs', found, 'completed');
  }

  // ---- FAQs (listing) ----
  if (SECTION === 'all' || SECTION === 'faqs') {
    updateSectionProgress(progress, 'faqs', 0, 'in_progress');
    const found = await scrapeFaqs();
    updateSectionProgress(progress, 'faqs', found, 'completed');
  }

  // ---- Press Releases (ID enumeration - run last, it's the biggest) ----
  if (SECTION === 'all' || SECTION === 'press_releases') {
    updateSectionProgress(progress, 'press_releases', 0, 'in_progress');
    const found = await scrapePressReleases();
    updateSectionProgress(progress, 'press_releases', found, 'completed');
  }

  // Final report
  const elapsed = (Date.now() - startTime) / 60000;
  console.log('\n\n=== Comprehensive Scrape Complete ===');
  console.log(`Time: ${elapsed.toFixed(1)} minutes`);
  console.log('\nMetadata files:');

  for (const file of fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.jsonl'))) {
    const fp = path.join(DATA_DIR, file);
    const lines = fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).length;
    console.log(`  ${file}: ${lines} documents`);
  }
}

main().catch(console.error);
