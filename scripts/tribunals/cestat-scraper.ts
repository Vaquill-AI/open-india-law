/**
 * CESTAT (Customs, Excise & Service Tax Appellate Tribunal) Scraper
 *
 * Two-phase scraper:
 *   Phase 1: Collect order metadata via AJAX endpoints (fast, ~5 min)
 *   Phase 2: Download order PDFs (bulk, ~2-4 hours depending on bandwidth)
 *
 * Usage:
 *   npx tsx scripts/cestat-scraper.ts
 *
 * Environment variables:
 *   PDF_CONCURRENCY=40       Max concurrent PDF downloads (default: 40)
 *   META_CONCURRENCY=9       Max concurrent metadata workers (default: 9)
 *   START_YEAR=2025          Year to start from (default: 2025)
 *   END_YEAR=2000            Year to stop at (default: 2000)
 *   ORDER_TYPE=F             F=Final, D=Daily, BOTH=both (default: BOTH)
 *   BENCHES=delhi,mumbai     Comma-separated bench filter (default: all)
 *   SKIP_METADATA=false      Skip Phase 1 if metadata already collected
 *   SKIP_PDFS=false          Skip Phase 2
 *   MAX_PDFS=0               Limit PDFs for testing (0=unlimited)
 *   DATA_DIR=data/cestat     Output directory
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://cestat.gov.in';

const BENCHES = [
  { id: '107079', name: 'DELHI', slug: 'delhi' },
  { id: '127482', name: 'MUMBAI', slug: 'mumbai' },
  { id: '119315', name: 'KOLKATA', slug: 'kolkata' },
  { id: '133568', name: 'CHENNAI', slug: 'chennai' },
  { id: '129525', name: 'BANGALORE', slug: 'bangalore' },
  { id: '124438', name: 'AHMEDABAD', slug: 'ahmedabad' },
  { id: '109120', name: 'ALLAHABAD', slug: 'allahabad' },
  { id: '104044', name: 'CHANDIGARH', slug: 'chandigarh' },
  { id: '136507', name: 'HYDERABAD', slug: 'hyderabad' },
];

interface OrderRecord {
  serial: string;
  case_number: string;
  parties: string;
  appellant: string;
  respondent: string;
  order_date: string;
  pdf_url: string;
  pdf_id: string;
  bench: string;
  order_type: string; // F=Final, D=Daily
  scraped_at: string;
}

interface SessionInfo {
  cookies: string;
  csrfToken: string;
}

interface Progress {
  metadata: {
    completed: Record<string, string[]>; // bench -> ["2025-01", "2025-02", ...]
    totalOrders: number;
  };
  pdfs: {
    downloaded: number;
    failed: number;
    skipped: number;
  };
}

// ─── Environment ─────────────────────────────────────────────────────────────

const PDF_CONCURRENCY = parseInt(process.env.PDF_CONCURRENCY || '40', 10);
const META_CONCURRENCY = parseInt(process.env.META_CONCURRENCY || '9', 10);
const START_YEAR = parseInt(process.env.START_YEAR || '2025', 10);
const END_YEAR = parseInt(process.env.END_YEAR || '2000', 10);
const ORDER_TYPE = process.env.ORDER_TYPE || 'BOTH'; // F, D, BOTH
const BENCH_FILTER = process.env.BENCHES
  ? process.env.BENCHES.split(',').map((b) => b.trim().toLowerCase())
  : null;
const SKIP_METADATA = process.env.SKIP_METADATA === 'true';
const SKIP_PDFS = process.env.SKIP_PDFS === 'true';
const MAX_PDFS = parseInt(process.env.MAX_PDFS || '0', 10);
const DATA_DIR = process.env.DATA_DIR || 'data/tribunals/cestat';

// ─── Directories ─────────────────────────────────────────────────────────────

const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const ORDERS_DIR = path.join(DATA_DIR, 'orders');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, ORDERS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const bench of BENCHES) {
    fs.mkdirSync(path.join(ORDERS_DIR, bench.slug), { recursive: true });
  }
}

// ─── Progress tracking ───────────────────────────────────────────────────────

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    metadata: { completed: {}, totalOrders: 0 },
    pdfs: { downloaded: 0, failed: 0, skipped: 0 },
  };
}

function saveProgress(progress: Progress): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── Session management ──────────────────────────────────────────────────────

async function getSession(orderType: string = 'F'): Promise<SessionInfo> {
  const url = orderType === 'F' ? `${BASE_URL}/final-order-status` : `${BASE_URL}/order-status`;

  const response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  // Extract cookies
  const setCookies = response.headers['set-cookie'] || [];
  const cookieStr = setCookies.map((c: string) => c.split(';')[0]).join('; ');

  // Extract CSRF token
  const csrfMatch = response.data.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!csrfMatch) {
    throw new Error('Failed to extract CSRF token');
  }

  return { cookies: cookieStr, csrfToken: csrfMatch[1] };
}

// ─── AJAX search ─────────────────────────────────────────────────────────────

interface AjaxResponse {
  draw: number;
  iTotalRecords: number;
  iTotalDisplayRecords: number;
  data: string[][] | { errors: Record<string, string>; messages?: string };
  csrf_token: string;
}

async function searchOrders(
  session: SessionInfo,
  benchId: string,
  fromDate: string,
  toDate: string,
  orderType: string,
  retries: number = 3,
): Promise<{ records: string[][]; total: number; newCsrf: string }> {
  const url = `${BASE_URL}/ajax/order-status-web`;
  const params = new URLSearchParams();
  params.append('csrf_token', session.csrfToken);
  params.append('s', 's');
  params.append('bench', benchId);
  params.append('tab', '4'); // Order Date Wise
  params.append('from', fromDate);
  params.append('to', toDate);
  params.append('captcha_code', '111111');
  if (orderType === 'F') {
    params.append('order_type', 'F');
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post<AjaxResponse>(url, params.toString(), {
        timeout: 60000,
        headers: {
          Cookie: session.cookies,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        validateStatus: () => true,
      });

      const data = response.data;
      if (!data || typeof data !== 'object') {
        throw new Error(`Invalid response: ${typeof data}`);
      }

      // Check for errors
      if (data.data && !Array.isArray(data.data) && (data.data as any).errors) {
        const errors = (data.data as any).errors;
        // CSRF expired - need new session
        if (errors.csrf_token || JSON.stringify(errors).includes('csrf')) {
          throw new Error('CSRF_EXPIRED');
        }
        throw new Error(`Server error: ${JSON.stringify(errors)}`);
      }

      const records = Array.isArray(data.data) ? data.data : [];
      return {
        records,
        total: data.iTotalRecords || 0,
        newCsrf: data.csrf_token || session.csrfToken,
      };
    } catch (err: any) {
      if (err.message === 'CSRF_EXPIRED') {
        // Get a fresh session
        const fresh = await getSession(orderType);
        session.cookies = fresh.cookies;
        session.csrfToken = fresh.csrfToken;
        continue;
      }
      if (attempt === retries) {
        throw err;
      }
      const delay = 2000 * attempt;
      log(`  Retry ${attempt}/${retries} after ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
  throw new Error('Exhausted retries');
}

// ─── Metadata parsing ────────────────────────────────────────────────────────

function parseOrderRecord(row: string[], benchSlug: string, orderType: string): OrderRecord | null {
  if (!row || row.length < 5) return null;

  const [serial, caseNumber, partiesHtml, orderDate, pdfHtml] = row;

  // Extract parties: "PARTY A<br>vs<br>PARTY B"
  const partiesClean = partiesHtml.replace(/<br\s*\/?>/gi, ' ').trim();
  const partiesSplit = partiesHtml.split(/<br\s*\/?>\s*vs\s*<br\s*\/?>/i);
  const appellant = partiesSplit[0] ? partiesSplit[0].replace(/<[^>]*>/g, '').trim() : '';
  const respondent = partiesSplit[1] ? partiesSplit[1].replace(/<[^>]*>/g, '').trim() : '';

  // Extract PDF URL: <a href="./weborders/file/delhi/407286" ...>
  const pdfMatch = pdfHtml.match(/href="\.?\/?(weborders\/file\/[^"]+)"/);
  if (!pdfMatch) return null;

  const pdfPath = pdfMatch[1];
  const pdfIdMatch = pdfPath.match(/\/(\d+)$/);
  const pdfId = pdfIdMatch ? pdfIdMatch[1] : '';

  return {
    serial,
    case_number: caseNumber.trim(),
    parties: partiesClean.replace(/<[^>]*>/g, ''),
    appellant,
    respondent,
    order_date: orderDate.trim(),
    pdf_url: `${BASE_URL}/${pdfPath}`,
    pdf_id: pdfId,
    bench: benchSlug,
    order_type: orderType,
    scraped_at: new Date().toISOString(),
  };
}

// ─── Phase 1: Metadata collection ────────────────────────────────────────────

async function collectMetadataForBench(
  bench: (typeof BENCHES)[0],
  orderType: string,
  progress: Progress,
): Promise<OrderRecord[]> {
  const allRecords: OrderRecord[] = [];
  const typeLabel = orderType === 'F' ? 'FINAL' : 'DAILY';

  let session = await getSession(orderType);
  let sessionAge = Date.now();

  for (let year = START_YEAR; year >= END_YEAR; year--) {
    // Check if already completed
    const key = `${bench.slug}_${orderType}`;
    const monthKeys = progress.metadata.completed[key] || [];

    // Try full year first
    const yearKey = `${year}`;
    if (monthKeys.includes(yearKey)) {
      continue;
    }

    // Refresh session if older than 15 minutes
    if (Date.now() - sessionAge > 15 * 60 * 1000) {
      session = await getSession(orderType);
      sessionAge = Date.now();
    }

    const fromDate = `01-01-${year}`;
    const toDate = `31-12-${year}`;

    try {
      const result = await searchOrders(session, bench.id, fromDate, toDate, orderType);

      session.csrfToken = result.newCsrf;

      if (result.total === 0) {
        log(`  ${bench.name} ${typeLabel} ${year}: 0 records`);
        // Mark complete
        if (!progress.metadata.completed[key]) {
          progress.metadata.completed[key] = [];
        }
        progress.metadata.completed[key].push(yearKey);
        continue;
      }

      // If too many records (>5000), split by month
      if (result.total > 5000 && result.records.length < result.total) {
        log(`  ${bench.name} ${typeLabel} ${year}: ${result.total} records (splitting by month)`);
        for (let month = 1; month <= 12; month++) {
          const monthKey = `${year}-${String(month).padStart(2, '0')}`;
          if (monthKeys.includes(monthKey)) continue;

          const lastDay = new Date(year, month, 0).getDate();
          const mFrom = `01-${String(month).padStart(2, '0')}-${year}`;
          const mTo = `${lastDay}-${String(month).padStart(2, '0')}-${year}`;

          // Refresh session if needed
          if (Date.now() - sessionAge > 15 * 60 * 1000) {
            session = await getSession(orderType);
            sessionAge = Date.now();
          }

          const mResult = await searchOrders(session, bench.id, mFrom, mTo, orderType);
          session.csrfToken = mResult.newCsrf;

          const parsed = mResult.records
            .map((r) => parseOrderRecord(r, bench.slug, orderType))
            .filter((r): r is OrderRecord => r !== null);

          allRecords.push(...parsed);
          log(
            `  ${bench.name} ${typeLabel} ${monthKey}: ${parsed.length}/${mResult.total} records`,
          );

          if (!progress.metadata.completed[key]) {
            progress.metadata.completed[key] = [];
          }
          progress.metadata.completed[key].push(monthKey);
          progress.metadata.totalOrders += parsed.length;

          await sleep(300);
        }
      } else {
        // Parse all records from the year query
        const parsed = result.records
          .map((r) => parseOrderRecord(r, bench.slug, orderType))
          .filter((r): r is OrderRecord => r !== null);

        allRecords.push(...parsed);
        log(`  ${bench.name} ${typeLabel} ${year}: ${parsed.length}/${result.total} records`);

        if (!progress.metadata.completed[key]) {
          progress.metadata.completed[key] = [];
        }
        progress.metadata.completed[key].push(yearKey);
        progress.metadata.totalOrders += parsed.length;
      }

      await sleep(300);
    } catch (err: any) {
      log(`  ERROR ${bench.name} ${typeLabel} ${year}: ${err.message}`);
      // Refresh session and continue
      try {
        session = await getSession(orderType);
        sessionAge = Date.now();
      } catch {
        log(`  Failed to refresh session, sleeping 10s...`);
        await sleep(10000);
        session = await getSession(orderType);
        sessionAge = Date.now();
      }
    }
  }

  return allRecords;
}

async function collectAllMetadata(progress: Progress): Promise<OrderRecord[]> {
  log('═══ PHASE 1: METADATA COLLECTION ═══');

  const activeBenches = BENCH_FILTER
    ? BENCHES.filter((b) => BENCH_FILTER!.includes(b.slug))
    : BENCHES;

  const orderTypes: string[] = ORDER_TYPE === 'BOTH' ? ['F', 'D'] : [ORDER_TYPE];

  const allRecords: OrderRecord[] = [];
  const queue = new PQueue({ concurrency: META_CONCURRENCY });

  const tasks: Promise<void>[] = [];

  for (const orderType of orderTypes) {
    for (const bench of activeBenches) {
      tasks.push(
        queue.add(async () => {
          const records = await collectMetadataForBench(bench, orderType, progress);
          allRecords.push(...records);

          // Save metadata for this bench incrementally
          const metaFile = path.join(
            METADATA_DIR,
            `${bench.slug}_${orderType === 'F' ? 'final' : 'daily'}.jsonl`,
          );
          const lines = records.map((r) => JSON.stringify(r)).join('\n');
          if (lines) {
            fs.appendFileSync(metaFile, lines + '\n');
          }

          saveProgress(progress);
        }),
      );
    }
  }

  await Promise.all(tasks);
  await queue.onIdle();

  log(`\n  Metadata collection complete: ${allRecords.length} total records`);
  saveProgress(progress);

  return allRecords;
}

// ─── Phase 2: PDF Download ───────────────────────────────────────────────────

async function downloadPDF(record: OrderRecord, retries: number = 3): Promise<boolean> {
  const outFile = path.join(ORDERS_DIR, record.bench, `${record.pdf_id}.pdf`);

  // Skip if already exists and non-empty
  if (fs.existsSync(outFile)) {
    const stat = fs.statSync(outFile);
    if (stat.size > 100) {
      return true; // already downloaded
    }
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(record.pdf_url, {
        timeout: 30000,
        responseType: 'arraybuffer',
        validateStatus: (status) => status === 200,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const data = Buffer.from(response.data);
      if (data.length < 100) {
        // Empty or invalid PDF
        return false;
      }

      fs.writeFileSync(outFile, data);
      return true;
    } catch (err: any) {
      if (attempt === retries) {
        return false;
      }
      await sleep(1000 * attempt);
    }
  }
  return false;
}

async function downloadAllPDFs(records: OrderRecord[], progress: Progress): Promise<void> {
  log('\n═══ PHASE 2: PDF DOWNLOAD ═══');

  // Deduplicate by pdf_id + bench
  const seen = new Set<string>();
  const unique = records.filter((r) => {
    const key = `${r.bench}/${r.pdf_id}`;
    if (seen.has(key) || !r.pdf_id) return false;
    seen.add(key);
    return true;
  });

  // Filter out already downloaded
  const toDownload = unique.filter((r) => {
    const outFile = path.join(ORDERS_DIR, r.bench, `${r.pdf_id}.pdf`);
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100) {
      progress.pdfs.skipped++;
      return false;
    }
    return true;
  });

  const limit = MAX_PDFS > 0 ? Math.min(MAX_PDFS, toDownload.length) : toDownload.length;
  const batch = toDownload.slice(0, limit);

  log(
    `  Total unique: ${unique.length}, Already downloaded: ${progress.pdfs.skipped}, To download: ${batch.length}`,
  );

  if (batch.length === 0) {
    log('  Nothing to download!');
    return;
  }

  const queue = new PQueue({ concurrency: PDF_CONCURRENCY });
  let completed = 0;
  let failed = 0;
  const startTime = Date.now();
  let lastProgressLog = Date.now();

  const tasks = batch.map((record) =>
    queue.add(async () => {
      const ok = await downloadPDF(record);
      if (ok) {
        completed++;
        progress.pdfs.downloaded++;
      } else {
        failed++;
        progress.pdfs.failed++;
      }

      // Log progress every 5 seconds
      const now = Date.now();
      if (now - lastProgressLog > 5000) {
        lastProgressLog = now;
        const elapsed = (now - startTime) / 1000;
        const rate = completed / elapsed;
        const remaining = (batch.length - completed - failed) / Math.max(rate, 0.1);
        const etaMin = Math.round(remaining / 60);
        log(
          `  Progress: ${completed + failed}/${batch.length} (${completed} ok, ${failed} fail) | ${rate.toFixed(1)}/s | ETA: ${etaMin}m`,
        );
        // Save progress periodically
        saveProgress(progress);
      }
    }),
  );

  await Promise.all(tasks);
  await queue.onIdle();

  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log(`\n  PDF download complete: ${completed} downloaded, ${failed} failed in ${totalTime} min`);
  saveProgress(progress);
}

// ─── Load existing metadata from JSONL files ─────────────────────────────────

function loadExistingMetadata(): OrderRecord[] {
  const records: OrderRecord[] = [];
  if (!fs.existsSync(METADATA_DIR)) return records;

  const files = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.jsonl'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(METADATA_DIR, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  return records;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDirs();
  const progress = loadProgress();

  log('╔══════════════════════════════════════════════╗');
  log('║         CESTAT ORDER SCRAPER                 ║');
  log('╚══════════════════════════════════════════════╝');
  log(`  Config:`);
  log(`    PDF Concurrency:  ${PDF_CONCURRENCY}`);
  log(`    Meta Concurrency: ${META_CONCURRENCY}`);
  log(`    Years:            ${START_YEAR} → ${END_YEAR}`);
  log(`    Order Types:      ${ORDER_TYPE}`);
  log(`    Benches:          ${BENCH_FILTER ? BENCH_FILTER.join(', ') : 'ALL (9)'}`);
  log(`    Data Dir:         ${DATA_DIR}`);
  log(`    Skip Metadata:    ${SKIP_METADATA}`);
  log(`    Skip PDFs:        ${SKIP_PDFS}`);
  log(`    Max PDFs:         ${MAX_PDFS || 'unlimited'}`);
  log('');

  let records: OrderRecord[];

  if (SKIP_METADATA) {
    log('  Skipping metadata collection, loading from disk...');
    records = loadExistingMetadata();
    log(`  Loaded ${records.length} records from existing metadata`);
  } else {
    records = await collectAllMetadata(progress);
  }

  if (!SKIP_PDFS && records.length > 0) {
    await downloadAllPDFs(records, progress);
  }

  // Final summary
  log('\n╔══════════════════════════════════════════════╗');
  log('║              SCRAPING COMPLETE               ║');
  log('╚══════════════════════════════════════════════╝');
  log(`  Total metadata records: ${records.length}`);
  log(`  PDFs downloaded:        ${progress.pdfs.downloaded}`);
  log(`  PDFs failed:            ${progress.pdfs.failed}`);
  log(`  PDFs skipped (existed): ${progress.pdfs.skipped}`);

  // Count files on disk
  let totalPdfs = 0;
  for (const bench of BENCHES) {
    const benchDir = path.join(ORDERS_DIR, bench.slug);
    if (fs.existsSync(benchDir)) {
      const count = fs.readdirSync(benchDir).filter((f) => f.endsWith('.pdf')).length;
      totalPdfs += count;
      if (count > 0) log(`    ${bench.name}: ${count} PDFs`);
    }
  }
  log(`  Total PDFs on disk:     ${totalPdfs}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
