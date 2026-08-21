/**
 * APTEL Scraper - Appellate Tribunal for Electricity
 * Scrapes judgments/orders from https://www.aptel.gov.in/en/old-judgement-data
 *
 * Data: 2008-2026, ~2730 cases, ~2887 PDFs
 * No auth/captcha required. SSL cert is self-signed (ignored).
 *
 * Usage:
 *   npx tsx scripts/aptel-scraper.ts                         # Full run (metadata + PDFs)
 *   npx tsx scripts/aptel-scraper.ts --metadata-only         # Scrape metadata only
 *   npx tsx scripts/aptel-scraper.ts --download-only         # Download PDFs only (requires metadata)
 *   npx tsx scripts/aptel-scraper.ts --year 2008             # Single year
 *   npx tsx scripts/aptel-scraper.ts --year 2008 --year 2009 # Multiple years
 *   npx tsx scripts/aptel-scraper.ts --test                  # Test run (2026 only, max 5 PDFs)
 *   MAX_CONCURRENT=10 npx tsx scripts/aptel-scraper.ts       # Control concurrency
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

const BASE_URL = 'https://www.aptel.gov.in';
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/aptel');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const COMBINED_JSONL = path.join(DATA_DIR, 'aptel-all-metadata.jsonl');

const ALL_YEARS = Array.from({ length: 2026 - 2008 + 1 }, (_, i) => 2008 + i);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5', 10);
const DELAY_BETWEEN_PDFS_MS = 300; // polite delay
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CaseMetadata {
  serial_no: number | string;
  year: number;
  appeal_petition: string;
  cause_title: string;
  bench: string;
  date_of_decision: string;
  pdf_urls: string[];
  pdf_filenames: string[];
  source_url: string;
  tribunal: string;
  country: string;
}

interface YearMetadata {
  year: number;
  scraped_at: string;
  total_cases: number;
  total_pdfs: number;
  cases: CaseMetadata[];
}

interface Progress {
  metadata_completed: number[];
  pdfs_completed: Record<string, string[]>; // year -> downloaded filenames
  last_updated: string;
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

function slugify(text: string, maxLen = 80): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

function normalizeUrl(href: string): string {
  if (!href) return '';

  // Decode HTML entities
  let url = href.replace(/&amp;/g, '&');

  // Handle relative URLs
  if (url.startsWith('/')) {
    url = `${BASE_URL}${url}`;
  } else if (url.startsWith('judgments/')) {
    // Relative path without leading slash
    url = `${BASE_URL}/${url}`;
  } else if (!url.startsWith('http')) {
    url = `${BASE_URL}/${url}`;
  }

  // Normalize domain (some links use aptel.gov.in without www)
  url = url.replace('http://', 'https://');

  return url;
}

function fetchPage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        rejectUnauthorized: false, // self-signed cert
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      },
      (res) => {
        // Handle redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${BASE_URL}${res.headers.location}`;
          fetchPage(redirectUrl).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        const chunks: Uint8Array[] = [];
        res.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
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
        rejectUnauthorized: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      },
      (res) => {
        // Handle redirects
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
          } catch (renameErr) {
            console.error(`  [FAIL] Rename error: ${renameErr}`);
            resolve(false);
          }
        });
        file.on('error', (err) => {
          if (resolved) return;
          resolved = true;
          fs.unlink(tmpDest, () => {});
          console.error(`  [FAIL] Write error: ${err.message}`);
          resolve(false);
        });
      },
    );

    req.on('error', (err) => {
      console.error(`  [FAIL] Network error: ${err.message} - ${url}`);
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
      console.error(`  [FAIL] Timeout: ${url}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// HTML Parsing
// ---------------------------------------------------------------------------

function parseYearPage(html: string, year: number): CaseMetadata[] {
  const cases: CaseMetadata[] = [];
  const sourceUrl = `${BASE_URL}/en/old-judgement-data?field_judge_year_value=${year}`;

  // Extract tbody content
  const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) {
    console.warn(`  No <tbody> found for year ${year}`);
    return cases;
  }

  const tbody = tbodyMatch[1];
  // Split by </tr> to get rows
  const rows = tbody.split('</tr>').filter((r) => r.includes('<td'));

  for (const row of rows) {
    // Extract all <td> contents (greedy within each td)
    const tds: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)(?=<\/td>)/g;
    let match: RegExpExecArray | null;
    while ((match = tdRegex.exec(row)) !== null) {
      tds.push(match[1]);
    }

    if (tds.length < 5) continue;

    // Column 0: S.NO - skip header row
    const serialNo = stripHtml(tds[0]);
    if (serialNo === 'S. NO' || serialNo.toLowerCase() === 's. no') continue;

    // Column 1: APPEAL/PETITION (contains PDF link(s))
    const appealHtml = tds[1];
    const appealText = stripHtml(appealHtml);

    // Extract ALL PDF URLs from this cell
    const pdfUrls: string[] = [];
    const hrefRegex = /href="([^"]*\.pdf[^"]*)"/g;
    let hrefMatch: RegExpExecArray | null;
    while ((hrefMatch = hrefRegex.exec(appealHtml)) !== null) {
      const normalized = normalizeUrl(hrefMatch[1]);
      if (normalized && !pdfUrls.includes(normalized)) {
        pdfUrls.push(normalized);
      }
    }

    // Column 2: CAUSE TITLE
    const causeTitle = stripHtml(tds[2]);

    // Column 3: Bench
    const bench = stripHtml(tds[3]);

    // Column 4: DATE OF DECISION - clean up "Uploaded On" text
    const rawDate = stripHtml(tds[4]);
    const dateOfDecision = rawDate.replace(/Uploaded\s+On\s+\d{2}\.\d{2}\.\d{4}/gi, '').trim();

    // Generate PDF filenames
    const pdfFilenames = pdfUrls.map((_url, idx) => {
      const suffix = pdfUrls.length > 1 ? `_${idx + 1}` : '';
      const slug = slugify(appealText, 60);
      return `${serialNo}_${slug}${suffix}.pdf`;
    });

    cases.push({
      serial_no: isNaN(Number(serialNo)) ? serialNo : Number(serialNo),
      year,
      appeal_petition: appealText,
      cause_title: causeTitle,
      bench,
      date_of_decision: dateOfDecision,
      pdf_urls: pdfUrls,
      pdf_filenames: pdfFilenames,
      source_url: sourceUrl,
      tribunal: 'APTEL',
      country: 'IN',
    });
  }

  return cases;
}

// ---------------------------------------------------------------------------
// Phase 1: Scrape Metadata
// ---------------------------------------------------------------------------

async function scrapeMetadata(years: number[]): Promise<Map<number, YearMetadata>> {
  const progress = loadProgress();
  const allMetadata = new Map<number, YearMetadata>();

  console.log(`\n=== Phase 1: Scraping metadata for ${years.length} years ===\n`);

  for (const year of years) {
    // Check if already scraped and metadata file exists
    const metaFile = path.join(METADATA_DIR, `aptel-${year}.json`);
    if (progress.metadata_completed.includes(year) && fs.existsSync(metaFile)) {
      console.log(`  [SKIP] ${year} - already scraped`);
      const existing: YearMetadata = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      allMetadata.set(year, existing);
      continue;
    }

    const url = `${BASE_URL}/en/old-judgement-data?field_judge_year_value=${year}`;
    console.log(`  [FETCH] ${year} ...`);

    try {
      const html = await fetchPage(url);
      const cases = parseYearPage(html, year);
      const totalPdfs = cases.reduce((sum, c) => sum + c.pdf_urls.length, 0);

      const yearMeta: YearMetadata = {
        year,
        scraped_at: new Date().toISOString(),
        total_cases: cases.length,
        total_pdfs: totalPdfs,
        cases,
      };

      // Save per-year metadata
      fs.writeFileSync(metaFile, JSON.stringify(yearMeta, null, 2));
      allMetadata.set(year, yearMeta);

      // Update progress
      if (!progress.metadata_completed.includes(year)) {
        progress.metadata_completed.push(year);
      }
      saveProgress(progress);

      console.log(`  [OK]    ${year}: ${cases.length} cases, ${totalPdfs} PDFs`);

      // Small delay between page fetches
      await sleep(500);
    } catch (err) {
      console.error(`  [ERROR] ${year}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Write combined JSONL
  console.log(`\n  Writing combined JSONL -> ${COMBINED_JSONL}`);
  const jsonlStream = fs.createWriteStream(COMBINED_JSONL);
  let totalCases = 0;
  let totalPdfs = 0;

  for (const year of [...allMetadata.keys()].sort()) {
    const meta = allMetadata.get(year)!;
    for (const c of meta.cases) {
      jsonlStream.write(JSON.stringify(c) + '\n');
      totalCases++;
      totalPdfs += c.pdf_urls.length;
    }
  }
  jsonlStream.end();

  console.log(`\n  Total: ${totalCases} cases, ${totalPdfs} PDF links\n`);

  return allMetadata;
}

// ---------------------------------------------------------------------------
// Phase 2: Download PDFs
// ---------------------------------------------------------------------------

async function downloadPdfs(
  allMetadata: Map<number, YearMetadata>,
  maxPdfs?: number,
): Promise<void> {
  const progress = loadProgress();
  let downloadedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let totalToDownload = 0;

  // Build download queue
  const queue: { url: string; dest: string; year: string; label: string }[] = [];

  for (const [year, meta] of allMetadata) {
    const yearDir = path.join(PDFS_DIR, String(year));
    if (!fs.existsSync(yearDir)) fs.mkdirSync(yearDir, { recursive: true });

    const completedForYear = progress.pdfs_completed[String(year)] || [];

    for (const c of meta.cases) {
      for (let i = 0; i < c.pdf_urls.length; i++) {
        const filename = c.pdf_filenames[i];
        const dest = path.join(yearDir, filename);

        if (completedForYear.includes(filename)) {
          skippedCount++;
          continue;
        }

        // Also skip if file already exists on disk
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          if (!completedForYear.includes(filename)) {
            completedForYear.push(filename);
          }
          skippedCount++;
          continue;
        }

        queue.push({
          url: c.pdf_urls[i],
          dest,
          year: String(year),
          label: `S.NO ${c.serial_no} - ${filename}`,
        });
      }
    }

    progress.pdfs_completed[String(year)] = completedForYear;
  }

  saveProgress(progress);
  totalToDownload = queue.length;

  if (maxPdfs && maxPdfs < totalToDownload) {
    queue.length = maxPdfs;
    totalToDownload = maxPdfs;
  }

  console.log(`\n=== Phase 2: Downloading PDFs ===`);
  console.log(`  Queue: ${totalToDownload}, Skipped (already done): ${skippedCount}`);
  console.log(`  Concurrency: ${MAX_CONCURRENT}\n`);

  // Process in batches
  let idx = 0;
  while (idx < queue.length) {
    const batch = queue.slice(idx, idx + MAX_CONCURRENT);
    const results = await Promise.all(
      batch.map(async (item) => {
        const ok = await downloadFile(item.url, item.dest);
        if (ok) {
          downloadedCount++;
          // Update progress
          if (!progress.pdfs_completed[item.year]) {
            progress.pdfs_completed[item.year] = [];
          }
          const filename = path.basename(item.dest);
          if (!progress.pdfs_completed[item.year].includes(filename)) {
            progress.pdfs_completed[item.year].push(filename);
          }
        } else {
          failedCount++;
        }
        return { ...item, ok };
      }),
    );

    // Log batch progress
    const completed = downloadedCount + failedCount + skippedCount;
    const totalExpected = totalToDownload + skippedCount;
    const pct = ((completed / totalExpected) * 100).toFixed(1);
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok).length;
    console.log(
      `  [${pct}%] Batch: ${ok} ok, ${fail} fail | Total: ${downloadedCount} downloaded, ${failedCount} failed`,
    );

    // Save progress every batch
    saveProgress(progress);

    idx += MAX_CONCURRENT;

    // Polite delay between batches
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

function verify(allMetadata: Map<number, YearMetadata>): void {
  console.log(`\n=== Phase 3: Verification ===\n`);

  let totalExpected = 0;
  let totalFound = 0;
  let totalMissing = 0;
  const missing: { year: number; sno: number | string; url: string }[] = [];

  for (const [year, meta] of allMetadata) {
    const yearDir = path.join(PDFS_DIR, String(year));
    let yearExpected = 0;
    let yearFound = 0;

    for (const c of meta.cases) {
      for (let i = 0; i < c.pdf_filenames.length; i++) {
        yearExpected++;
        const dest = path.join(yearDir, c.pdf_filenames[i]);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          yearFound++;
        } else {
          missing.push({
            year,
            sno: c.serial_no,
            url: c.pdf_urls[i],
          });
        }
      }
    }

    totalExpected += yearExpected;
    totalFound += yearFound;
    totalMissing += yearExpected - yearFound;

    const status = yearFound === yearExpected ? 'OK' : 'INCOMPLETE';
    console.log(`  ${year}: ${yearFound}/${yearExpected} PDFs [${status}]`);
  }

  console.log(`\n  TOTAL: ${totalFound}/${totalExpected} PDFs downloaded`);

  if (missing.length > 0) {
    console.log(`  Missing ${missing.length} PDFs:`);
    const missingFile = path.join(DATA_DIR, 'missing-pdfs.json');
    fs.writeFileSync(missingFile, JSON.stringify(missing, null, 2));
    console.log(`  Saved missing list to ${missingFile}`);
    // Show first few
    for (const m of missing.slice(0, 10)) {
      console.log(`    - Year ${m.year}, S.NO ${m.sno}: ${m.url}`);
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

  // Parse --year flags
  const yearFlags: number[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) {
      yearFlags.push(parseInt(args[i + 1], 10));
    }
  }

  let years = yearFlags.length > 0 ? yearFlags : ALL_YEARS;

  if (isTest) {
    years = [2026]; // smallest dataset
    console.log('=== TEST MODE: year 2026 only, max 5 PDFs ===');
  }

  // Ensure directories exist
  fs.mkdirSync(METADATA_DIR, { recursive: true });
  fs.mkdirSync(PDFS_DIR, { recursive: true });

  console.log(`APTEL Scraper`);
  console.log(`  Years: ${years.join(', ')}`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Concurrency: ${MAX_CONCURRENT}`);
  console.log(
    `  Mode: ${metadataOnly ? 'metadata-only' : downloadOnly ? 'download-only' : 'full'}`,
  );

  let allMetadata: Map<number, YearMetadata>;

  if (downloadOnly) {
    // Load existing metadata from disk
    allMetadata = new Map();
    for (const year of years) {
      const metaFile = path.join(METADATA_DIR, `aptel-${year}.json`);
      if (fs.existsSync(metaFile)) {
        allMetadata.set(year, JSON.parse(fs.readFileSync(metaFile, 'utf-8')));
      } else {
        console.error(`  [ERROR] No metadata for ${year}. Run metadata scrape first.`);
      }
    }
  } else {
    allMetadata = await scrapeMetadata(years);
  }

  if (!metadataOnly) {
    const maxPdfs = isTest ? 5 : undefined;
    await downloadPdfs(allMetadata, maxPdfs);
  }

  verify(allMetadata);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
