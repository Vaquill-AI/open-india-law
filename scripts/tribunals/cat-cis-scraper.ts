/**
 * CAT CIS Scraper — Central Administrative Tribunal Case Information System
 * Source: cis.cgat.gov.in (2022-2025 judgments/orders)
 *
 * ─── DATA SOURCES ───
 * PAST (1985-2021): catjudgements.nic.in (DSpace) — 162K judgments, already scraped
 * PRESENT (2022-2025): cis.cgat.gov.in (CIS) — this scraper
 *
 * The DSpace system stopped receiving uploads after Oct 2021.
 * CAT migrated to the CIS portal for all new filings and orders.
 * This scraper covers the gap from Nov 2021 to present.
 *
 * ─── STRATEGY ───
 * Uses the daily order endpoint: order_detail.php with date range queries
 * Iterates day-by-day across all 19 benches to discover all orders with PDFs.
 * No CAPTCHA, no login required, minimal rate limiting.
 *
 * ─── ENDPOINTS ───
 * Daily orders (date range): GET order_detail.php?benchCode3={id}&from_date={dd/mm/yyyy}&to_date={dd/mm/yyyy}&id=partynamewise
 * Final orders (date range): GET fiorder_detail.php?benchCode3={id}&from_date={dd/mm/yyyy}&to_date={dd/mm/yyyy}&id=partynamewise
 * Case search (by number):   GET partyDetail.php?caseNo={n}&benchCode1={id}&caseType={1-8}&year={yyyy}&id=casetypewise
 * Case detail page:          GET home1.php?no={base64_encoded_filing_no}
 * Order PDF:                 GET pdf/order.php?file={base64_encoded_path}
 * Judgment PDF:              GET pdf/judge.php?file={base64_encoded_path}
 *
 * ─── BENCH CODES ───
 * Numeric IDs used in API calls (not base64 in API, base64 only in bench selector JS)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Bench Registry ──
const BENCHES: Record<string, number> = {
  delhi: 100,
  ahmedabad: 120,
  allahabad: 330,
  bangalore: 103,
  chandigarh: 60,
  chennai: 310,
  cuttack: 260,
  ernakulam: 180,
  guwahati: 40,
  hyderabad: 21,
  jabalpur: 200,
  jaipur: 291,
  jammu: 117,
  jodhpur: 111,
  kolkata: 350,
  lucknow: 332,
  mumbai: 210,
  patna: 116,
  srinagar: 119,
};

// ── Case Type Codes ──
const CASE_TYPES: Record<number, string> = {
  1: 'Original Application',
  2: 'Transfer Application',
  3: 'Misc Application',
  4: 'Contempt Petition',
  5: 'Petition for Transfer',
  6: 'Review Application',
  7: 'Criminal Contempt Petition',
  8: 'OA Obj',
};

// ── Config ──
const BASE_URL = 'https://cis.cgat.gov.in/catlive';
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'tribunals', 'cat-cis');
const METADATA_FILE = path.join(OUTPUT_DIR, 'cat-cis-all-metadata.jsonl');
const PROGRESS_FILE = path.join(OUTPUT_DIR, 'scrape-progress.json');

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);
const START_DATE = process.env.START_DATE || '2021-11-01'; // DSpace stops Oct 2021
const END_DATE = process.env.END_DATE || new Date().toISOString().slice(0, 10); // Today

// ── Types ──
interface OrderRecord {
  case_number: string;
  case_type: string;
  petitioner: string;
  respondent: string;
  order_date: string; // dd/mm/yyyy from source
  order_date_iso: string; // yyyy-mm-dd
  pdf_url: string; // Full URL to PDF
  pdf_encoded_path: string; // Base64 encoded path param
  bench_name: string;
  bench_code: number;
  source: 'cis'; // Distinguish from DSpace data
  source_system: 'cis.cgat.gov.in';
  scraped_at: string;
}

interface Progress {
  last_bench: string;
  last_date: string; // yyyy-mm-dd
  total_collected: number;
  completed_benches: string[];
}

// ── Helpers ──
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateForAPI(isoDate: string): string {
  // yyyy-mm-dd -> dd/mm/yyyy
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function parseOrderDate(ddmmyyyy: string): string {
  // dd/mm/yyyy -> yyyy-mm-dd
  const parts = ddmmyyyy.trim().split('/');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return ddmmyyyy;
}

function generateDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  const endDate = new Date(end);
  while (current <= endDate) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ── Progress Management ──
function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    last_bench: '',
    last_date: '',
    total_collected: 0,
    completed_benches: [],
  };
}

function saveProgress(progress: Progress): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ── HTML Parsing ──
function parseOrdersResponse(html: string, benchName: string, benchCode: number): OrderRecord[] {
  const $ = cheerio.load(html);
  const records: OrderRecord[] = [];

  $('table.table-bordered tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const caseNumber = $(cells[1]).text().trim();
    if (!caseNumber) return;

    // Parse party details (HTML formatted with font tags)
    const partyHtml = $(cells[2]).html() || '';
    const partyText = $(cells[2]).text().trim();
    let petitioner = '';
    let respondent = '';

    // Pattern: PETITIONER VS RESPONDENT
    const vsMatch = partyText.split(/VS/i);
    if (vsMatch.length === 2) {
      petitioner = vsMatch[0].trim();
      respondent = vsMatch[1].trim();
    } else {
      petitioner = partyText;
    }

    const orderDate = $(cells[3]).text().trim();

    // Extract PDF URL from the link
    const pdfLink = $(cells[4])?.find('a')?.attr('href') || '';
    let pdfUrl = '';
    let pdfEncodedPath = '';

    if (pdfLink) {
      // Extract the file= parameter
      const fileMatch = pdfLink.match(/file=([A-Za-z0-9+/=]+)/);
      if (fileMatch) {
        pdfEncodedPath = fileMatch[1];
        // Construct full URL
        if (pdfLink.startsWith('./')) {
          pdfUrl = `${BASE_URL}/${pdfLink.slice(2)}`;
        } else if (pdfLink.startsWith('http')) {
          pdfUrl = pdfLink;
        } else {
          pdfUrl = `${BASE_URL}/${pdfLink}`;
        }
      }
    }

    if (!pdfUrl) return; // Skip entries without PDFs

    // Determine case type from case number prefix
    let caseType = 'Unknown';
    const typeMatch = caseNumber.match(/^([A-Z.]+)\//);
    if (typeMatch) {
      const prefix = typeMatch[1];
      const typeMap: Record<string, string> = {
        'O.A.': 'Original Application',
        'T.A.': 'Transfer Application',
        'M.A.': 'Misc Application',
        'C.P.': 'Contempt Petition',
        'R.A.': 'Review Application',
        'C.C.P.': 'Criminal Contempt Petition',
      };
      caseType = typeMap[prefix] || prefix;
    }

    records.push({
      case_number: caseNumber,
      case_type: caseType,
      petitioner,
      respondent,
      order_date: orderDate,
      order_date_iso: parseOrderDate(orderDate),
      pdf_url: pdfUrl,
      pdf_encoded_path: pdfEncodedPath,
      bench_name: benchName,
      bench_code: benchCode,
      source: 'cis',
      source_system: 'cis.cgat.gov.in',
      scraped_at: new Date().toISOString(),
    });
  });

  return records;
}

// ── Fetch with Retries ──
async function fetchWithRetry(url: string, maxRetries = 3): Promise<string | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,*/*',
          Referer: `${BASE_URL}/daily_order.php`,
        },
      });
      if (resp.ok) {
        return await resp.text();
      }
      if (resp.status === 429 || resp.status === 503) {
        console.log(`  Rate limited (${resp.status}), waiting ${(attempt + 1) * 5}s...`);
        await sleep((attempt + 1) * 5000);
        continue;
      }
      console.error(`  HTTP ${resp.status} for ${url}`);
      return null;
    } catch (err) {
      if (attempt < maxRetries - 1) {
        await sleep((attempt + 1) * 2000);
        continue;
      }
      console.error(`  Fetch error: ${err}`);
      return null;
    }
  }
  return null;
}

// ── Core Scraping ──
async function scrapeBenchDate(
  benchName: string,
  benchCode: number,
  date: string,
): Promise<OrderRecord[]> {
  const formattedDate = formatDateForAPI(date);

  // Fetch daily orders for this bench on this date
  const url = `${BASE_URL}/order_detail.php?benchCode3=${benchCode}&from_date=${formattedDate}&to_date=${formattedDate}&id=partynamewise`;

  const html = await fetchWithRetry(url);
  if (!html) return [];

  // Check for "No Record Found"
  if (html.includes('No Record Found')) return [];

  const records = parseOrdersResponse(html, benchName, benchCode);
  return records;
}

// ── Main ──
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   CAT CIS Scraper (2022-2025)                   ║');
  console.log('║   Source: cis.cgat.gov.in                        ║');
  console.log('║   Past data (1985-2021): catjudgements.nic.in    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const progress = loadProgress();
  console.log(
    `Progress: ${progress.total_collected} collected, ${progress.completed_benches.length} benches done`,
  );

  // Generate date range
  const allDates = generateDateRange(START_DATE, END_DATE);
  console.log(`Date range: ${START_DATE} → ${END_DATE} (${allDates.length} days)`);
  console.log(`Benches: ${Object.keys(BENCHES).length}, Concurrency: ${CONCURRENCY}`);
  console.log();

  // Open output file for appending
  const outStream = fs.createWriteStream(METADATA_FILE, { flags: 'a' });

  const benchEntries = Object.entries(BENCHES);
  let totalNew = 0;
  let totalDays = 0;
  const startTime = Date.now();
  const seenCases = new Set<string>();

  // Load existing case IDs for dedup
  if (fs.existsSync(METADATA_FILE)) {
    const existing = fs.readFileSync(METADATA_FILE, 'utf-8').split('\n');
    for (const line of existing) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        seenCases.add(`${rec.case_number}_${rec.order_date}_${rec.bench_name}`);
      } catch {
        // skip bad lines
      }
    }
    console.log(`Loaded ${seenCases.size} existing records for dedup`);
  }

  for (const [benchName, benchCode] of benchEntries) {
    if (progress.completed_benches.includes(benchName)) {
      console.log(`  ${benchName}: already completed, skipping`);
      continue;
    }

    console.log(`\n─── ${benchName.toUpperCase()} (code: ${benchCode}) ───`);

    // Find start date for this bench (resume support)
    let benchDates = allDates;
    if (progress.last_bench === benchName && progress.last_date) {
      const resumeIdx = allDates.indexOf(progress.last_date);
      if (resumeIdx >= 0) {
        benchDates = allDates.slice(resumeIdx + 1);
        console.log(`  Resuming from ${progress.last_date}`);
      }
    }

    let benchNew = 0;

    // Process dates in chunks for controlled concurrency
    for (let i = 0; i < benchDates.length; i += CONCURRENCY) {
      const chunk = benchDates.slice(i, i + CONCURRENCY);

      const results = await Promise.all(
        chunk.map((date) => scrapeBenchDate(benchName, benchCode, date)),
      );

      for (let j = 0; j < results.length; j++) {
        const records = results[j];
        const date = chunk[j];

        for (const rec of records) {
          const dedupKey = `${rec.case_number}_${rec.order_date}_${rec.bench_name}`;
          if (seenCases.has(dedupKey)) continue;
          seenCases.add(dedupKey);

          outStream.write(JSON.stringify(rec) + '\n');
          benchNew++;
          totalNew++;
        }

        totalDays++;
        progress.last_bench = benchName;
        progress.last_date = date;
        progress.total_collected += records.length;
      }

      // Progress log every 50 days
      if (totalDays % 50 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = totalDays / elapsed;
        console.log(
          `  [${totalDays}/${allDates.length * benchEntries.length} days] ` +
            `${rate.toFixed(1)} days/sec — new=${totalNew} bench=${benchName} date=${chunk[chunk.length - 1]}`,
        );
        saveProgress(progress);
      }

      await sleep(DELAY_MS);
    }

    console.log(`  ${benchName}: ${benchNew} new records`);
    progress.completed_benches.push(benchName);
    saveProgress(progress);
  }

  outStream.end();
  saveProgress(progress);

  const elapsed = (Date.now() - startTime) / 1000;
  console.log();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  COMPLETE: ${totalNew} new records in ${elapsed.toFixed(0)}s`);
  console.log(`║  Output: ${METADATA_FILE}`);
  console.log('║  Note: PDFs not downloaded — use R2 streamer      ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch(console.error);
