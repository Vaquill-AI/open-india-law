/**
 * CAT Supplementary Scraper - E-Filing Portal Final Orders
 *
 * Source: efiling.cgat.gov.in/ecat/fiorder_detail.php
 * Scrapes final/oral orders that may not yet be on DSpace.
 * PDFs served via pdf/judge.php with double-base64 encoded server paths.
 *
 * No CAPTCHA, no authentication, no rate limiting.
 * AJAX endpoints return server-rendered HTML via plain GET requests.
 *
 * Usage:
 *   npx tsx scripts/cat-supplementary-scraper.ts                    # Full run
 *   npx tsx scripts/cat-supplementary-scraper.ts --metadata-only    # Metadata only
 *   npx tsx scripts/cat-supplementary-scraper.ts --download-only    # PDFs only
 *   npx tsx scripts/cat-supplementary-scraper.ts --test             # Test (1 bench, 1 month)
 *   npx tsx scripts/cat-supplementary-scraper.ts --bench delhi      # Single bench
 *   npx tsx scripts/cat-supplementary-scraper.ts --year 2025        # Specific year
 *
 * Environment variables:
 *   PDF_CONCURRENCY=10       Max concurrent PDF downloads (default: 10)
 *   START_YEAR=2026          Year to start from (default: current year)
 *   END_YEAR=2020            Year to stop at (default: 2020)
 *   DATA_DIR=data/cat-efiling Output directory
 */

import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://efiling.cgat.gov.in/ecat';

interface BenchConfig {
  name: string;
  slug: string;
  code: string; // e-filing bench code
}

const BENCHES: BenchConfig[] = [
  { name: 'Principal Bench (Delhi)', slug: 'delhi', code: '100' },
  { name: 'Ahmedabad', slug: 'ahmedabad', code: '120' },
  { name: 'Allahabad', slug: 'allahabad', code: '330' },
  { name: 'Bangalore', slug: 'bangalore', code: '103' },
  { name: 'Chandigarh', slug: 'chandigarh', code: '60' },
  { name: 'Chennai', slug: 'chennai', code: '310' },
  { name: 'Cuttack', slug: 'cuttack', code: '260' },
  { name: 'Ernakulam', slug: 'ernakulam', code: '180' },
  { name: 'Gangtok', slug: 'gangtok', code: '921' },
  { name: 'Guwahati', slug: 'guwahati', code: '40' },
  { name: 'Hyderabad', slug: 'hyderabad', code: '21' },
  { name: 'Jabalpur', slug: 'jabalpur', code: '200' },
  { name: 'Jaipur', slug: 'jaipur', code: '291' },
  { name: 'Jammu', slug: 'jammu', code: '117' },
  { name: 'Jodhpur', slug: 'jodhpur', code: '111' },
  { name: 'Kolkata', slug: 'kolkata', code: '350' },
  { name: 'Lucknow', slug: 'lucknow', code: '332' },
  { name: 'Mumbai', slug: 'mumbai', code: '210' },
  { name: 'Patna', slug: 'patna', code: '116' },
  { name: 'Srinagar', slug: 'srinagar', code: '119' },
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface FinalOrder {
  serial: string;
  diary_number: string;
  case_number: string;
  order_date: string;
  applicant: string;
  respondent: string;
  pdf_encoded: string; // base64 encoded file param
  pdf_url: string;
  bench_name: string;
  bench_slug: string;
  bench_code: string;
  order_type: string;
  tribunal: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  metadata: {
    completed: Record<string, string[]>; // bench_slug -> ["2026-01", "2026-02", ...]
    totalOrders: number;
  };
  pdfs: {
    downloaded: number;
    failed: number;
    skipped: number;
  };
  last_updated: string;
}

// ─── Environment ─────────────────────────────────────────────────────────────

const PDF_CONCURRENCY = parseInt(process.env.PDF_CONCURRENCY || '10', 10);
const START_YEAR = parseInt(process.env.START_YEAR || String(new Date().getFullYear()), 10);
const END_YEAR = parseInt(process.env.END_YEAR || '2020', 10);
const DATA_DIR = process.env.DATA_DIR || 'data/tribunals/cat-efiling';

const args = process.argv.slice(2);
const METADATA_ONLY = args.includes('--metadata-only');
const DOWNLOAD_ONLY = args.includes('--download-only');
const TEST_MODE = args.includes('--test');
const BENCH_FILTER = (() => {
  const idx = args.indexOf('--bench');
  return idx >= 0 && args[idx + 1] ? args[idx + 1].toLowerCase() : null;
})();
const YEAR_FILTER = (() => {
  const idx = args.indexOf('--year');
  return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : null;
})();

// ─── Directories ─────────────────────────────────────────────────────────────

const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const bench of BENCHES) {
    fs.mkdirSync(path.join(PDFS_DIR, bench.slug), { recursive: true });
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
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

const client = axios.create({
  timeout: 60000,
  maxRedirects: 5,
  validateStatus: (status) => status < 500,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
});

// ─── Fetch final orders for a bench + date range ─────────────────────────────

async function fetchFinalOrders(
  bench: BenchConfig,
  fromDate: string,
  toDate: string,
  retries: number = 3,
): Promise<FinalOrder[]> {
  // Uses fiorder_detail.php for final/oral orders (NOT order_detail.php for daily orders)
  // Date-wise endpoint: benchCode3 + from_date + to_date + id=partynamewise
  const url = `${BASE_URL}/fiorder_detail.php?benchCode3=${bench.code}&from_date=${fromDate}&to_date=${toDate}&id=partynamewise`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await client.get(url);
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      return parseFinalOrderHtml(response.data, bench);
    } catch (err: any) {
      if (attempt === retries) {
        log(`  ERROR ${bench.slug} ${fromDate}-${toDate}: ${err.message}`);
        return [];
      }
      await sleep(2000 * attempt);
    }
  }
  return [];
}

function parseFinalOrderHtml(html: string, bench: BenchConfig): FinalOrder[] {
  const $ = cheerio.load(html);
  const orders: FinalOrder[] = [];

  // HTML structure: 5 cells per row
  // td[0] = Sr. No. | td[1] = Case No. | td[2] = Party Details (combined) | td[3] = Order Date | td[4] = PDF link
  $('tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const serial = $(cells[0]).text().trim();
    if (!serial || isNaN(parseInt(serial))) return; // skip header rows

    const caseNumber = $(cells[1]).text().trim();

    // Party details: <font color='red'>APPLICANT</font> VS <font color='red'>RESPONDENT</font>
    // Cheerio restructures malformed HTML, creating an empty first red font
    const partyCell = $(cells[2]);
    const redTexts: string[] = [];
    partyCell.find('font[color="red"]').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) redTexts.push(txt);
    });
    const applicant = redTexts[0] || '';
    const respondent = redTexts[1] || '';

    const orderDate = $(cells[3]).text().trim();

    // Extract PDF link - final orders use pdf/judge.php
    const pdfLink = $(row).find('a[href*="pdf/judge.php"]').attr('href') || '';
    if (!pdfLink) return;

    const fileMatch = pdfLink.match(/file=([^&"]+)/);
    const pdfEncoded = fileMatch ? fileMatch[1] : '';
    if (!pdfEncoded) return;

    const pdfUrl = `${BASE_URL}/pdf/judge.php?file=${pdfEncoded}`;

    orders.push({
      serial,
      diary_number: '',
      case_number: caseNumber,
      order_date: orderDate,
      applicant,
      respondent,
      pdf_encoded: pdfEncoded,
      pdf_url: pdfUrl,
      bench_name: bench.name,
      bench_slug: bench.slug,
      bench_code: bench.code,
      order_type: 'FINAL',
      tribunal: 'CAT',
      country: 'IN',
      scraped_at: new Date().toISOString(),
    });
  });

  return orders;
}

// ─── Phase 1: Metadata collection ────────────────────────────────────────────

async function collectMetadata(progress: Progress): Promise<FinalOrder[]> {
  log('═══ PHASE 1: METADATA COLLECTION (E-Filing Final Orders) ═══');

  const activeBenches = BENCH_FILTER ? BENCHES.filter((b) => b.slug === BENCH_FILTER) : BENCHES;

  const startYear = YEAR_FILTER || START_YEAR;
  const endYear = YEAR_FILTER || END_YEAR;

  if (activeBenches.length === 0) {
    log(`  No benches matched filter '${BENCH_FILTER}'`);
    return [];
  }

  log(`  Benches: ${activeBenches.length}`);
  log(`  Years: ${startYear} → ${endYear}`);

  const allRecords: FinalOrder[] = [];

  for (const bench of activeBenches) {
    for (let year = startYear; year >= endYear; year--) {
      for (let month = 12; month >= 1; month--) {
        // Skip future months
        const now = new Date();
        if (
          year > now.getFullYear() ||
          (year === now.getFullYear() && month > now.getMonth() + 1)
        ) {
          continue;
        }

        const monthKey = `${year}-${String(month).padStart(2, '0')}`;
        const completedMonths = progress.metadata.completed[bench.slug] || [];
        if (completedMonths.includes(monthKey)) {
          continue;
        }

        // Build date range
        const lastDay = new Date(year, month, 0).getDate();
        const fromDate = `01/${String(month).padStart(2, '0')}/${year}`;
        const toDate = `${lastDay}/${String(month).padStart(2, '0')}/${year}`;

        const orders = await fetchFinalOrders(bench, fromDate, toDate);

        if (orders.length > 0) {
          allRecords.push(...orders);

          // Save metadata for this month
          const metaFile = path.join(METADATA_DIR, `${bench.slug}_${monthKey}.jsonl`);
          const lines = orders.map((r) => JSON.stringify(r)).join('\n');
          fs.writeFileSync(metaFile, lines + '\n');
        }

        log(
          `  ${bench.name} ${monthKey}: ${orders.length} final orders | total: ${allRecords.length}`,
        );

        // Mark complete
        if (!progress.metadata.completed[bench.slug]) {
          progress.metadata.completed[bench.slug] = [];
        }
        progress.metadata.completed[bench.slug].push(monthKey);
        progress.metadata.totalOrders = allRecords.length;
        saveProgress(progress);

        // Test mode: stop after first month with results
        if (TEST_MODE && orders.length > 0) {
          log('  Test mode: stopping after first successful month');
          return allRecords;
        }

        await sleep(500); // polite delay between months
      }
    }
  }

  log(`\n  Metadata complete: ${allRecords.length} final orders`);
  return allRecords;
}

// ─── Phase 2: PDF download ───────────────────────────────────────────────────

async function downloadPDF(order: FinalOrder, retries: number = 3): Promise<boolean> {
  const benchDir = path.join(PDFS_DIR, order.bench_slug);
  fs.mkdirSync(benchDir, { recursive: true });

  // Generate a deterministic filename from diary number + case number
  const safeName = `${order.case_number}_${order.order_date}`
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_');
  const outFile = path.join(benchDir, `${safeName}.pdf`);

  if (fs.existsSync(outFile)) {
    const stat = fs.statSync(outFile);
    if (stat.size > 500) return true;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(order.pdf_url, {
        timeout: 60000,
        responseType: 'arraybuffer',
        validateStatus: (status) => status === 200,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      const data = Buffer.from(response.data);
      if (data.length < 500) return false;

      // Verify PDF
      if (data.subarray(0, 5).toString() !== '%PDF-') {
        return false;
      }

      fs.writeFileSync(outFile, data);
      return true;
    } catch (err: any) {
      if (attempt === retries) return false;
      await sleep(1000 * attempt);
    }
  }
  return false;
}

async function downloadAllPDFs(records: FinalOrder[], progress: Progress): Promise<void> {
  log('\n═══ PHASE 2: PDF DOWNLOAD ═══');

  // Deduplicate by case_number + order_date
  const seen = new Set<string>();
  const unique = records.filter((r) => {
    const key = `${r.bench_slug}/${r.case_number}/${r.order_date}`;
    if (seen.has(key) || !r.pdf_url) return false;
    seen.add(key);
    return true;
  });

  // Filter already downloaded
  const toDownload = unique.filter((r) => {
    const safeName = `${r.case_number}_${r.order_date}`
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_');
    const outFile = path.join(PDFS_DIR, r.bench_slug, `${safeName}.pdf`);
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 500) {
      progress.pdfs.skipped++;
      return false;
    }
    return true;
  });

  const limit = TEST_MODE ? Math.min(5, toDownload.length) : toDownload.length;
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

// ─── Load existing metadata ──────────────────────────────────────────────────

function loadExistingMetadata(): FinalOrder[] {
  const records: FinalOrder[] = [];
  if (!fs.existsSync(METADATA_DIR)) return records;

  const files = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.jsonl'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(METADATA_DIR, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip
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

  log('╔══════════════════════════════════════════════════╗');
  log('║    CAT SUPPLEMENTARY SCRAPER (E-Filing Finals)   ║');
  log('╚══════════════════════════════════════════════════╝');
  log(`  Source:            ${BASE_URL}`);
  log(`  Config:`);
  log(`    PDF Concurrency:  ${PDF_CONCURRENCY}`);
  log(`    Years:            ${YEAR_FILTER || START_YEAR} → ${YEAR_FILTER || END_YEAR}`);
  log(`    Bench Filter:     ${BENCH_FILTER || `ALL (${BENCHES.length})`}`);
  log(`    Test Mode:        ${TEST_MODE}`);
  log(`    Metadata Only:    ${METADATA_ONLY}`);
  log(`    Download Only:    ${DOWNLOAD_ONLY}`);
  log(`    Data Dir:         ${DATA_DIR}`);
  log('');

  let records: FinalOrder[];

  if (DOWNLOAD_ONLY) {
    log('  Skipping metadata, loading from disk...');
    records = loadExistingMetadata();
    log(`  Loaded ${records.length} records from existing metadata`);
  } else {
    records = await collectMetadata(progress);
  }

  if (!METADATA_ONLY && records.length > 0) {
    await downloadAllPDFs(records, progress);
  }

  // Final summary
  log('\n╔══════════════════════════════════════════════════╗');
  log('║              SCRAPING COMPLETE                   ║');
  log('╚══════════════════════════════════════════════════╝');
  log(`  Total metadata records: ${records.length}`);
  log(`  PDFs downloaded:        ${progress.pdfs.downloaded}`);
  log(`  PDFs failed:            ${progress.pdfs.failed}`);
  log(`  PDFs skipped (existed): ${progress.pdfs.skipped}`);

  // Count on disk
  if (fs.existsSync(PDFS_DIR)) {
    let totalPdfs = 0;
    for (const bench of BENCHES) {
      const benchDir = path.join(PDFS_DIR, bench.slug);
      if (fs.existsSync(benchDir)) {
        const count = fs.readdirSync(benchDir).filter((f) => f.endsWith('.pdf')).length;
        totalPdfs += count;
        if (count > 0) log(`    ${bench.name}: ${count} PDFs`);
      }
    }
    log(`  Total PDFs on disk:     ${totalPdfs}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
