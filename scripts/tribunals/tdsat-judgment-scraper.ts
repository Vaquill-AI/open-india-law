/**
 * TDSAT Judgment Scraper
 *
 * Scrapes all final judgments (PDFs) from the Telecom Disputes Settlement
 * and Appellate Tribunal (TDSAT) website.
 *
 * Two-phase approach:
 *   Phase 1: Fetch judgment metadata via date-wise search on judgment.php
 *   Phase 2: Download all judgment PDFs to local directory
 *
 * Usage:
 *   npx tsx scripts/tdsat-judgment-scraper.ts
 *
 * Environment variables:
 *   DOWNLOAD_DIR    - Output directory (default: data/tdsat/judgments)
 *   CONCURRENCY     - Parallel downloads (default: 3)
 *   SKIP_DOWNLOAD   - Set to "true" to only extract metadata
 *   START_YEAR      - Start year for scraping (default: 2000)
 *   END_YEAR        - End year for scraping (default: current year)
 *   DRY_RUN         - Set to "true" to preview without downloading
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

// ── Config ───────────────────────────────────────────────────────────
const BASE_URL = 'https://tdsat.gov.in';
const JUDGMENT_ENDPOINT = `${BASE_URL}/Delhi/services/judgment.php`;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || 'data/tribunals/tdsat/judgments';
const METADATA_DIR = 'data/tribunals/tdsat/metadata';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const SKIP_DOWNLOAD = process.env.SKIP_DOWNLOAD === 'true';
const DRY_RUN = process.env.DRY_RUN === 'true';
const START_YEAR = parseInt(process.env.START_YEAR || '2000', 10);
const END_YEAR = parseInt(process.env.END_YEAR || new Date().getFullYear().toString(), 10);

// ── Types ────────────────────────────────────────────────────────────
interface JudgmentMetadata {
  serial: number;
  case_no: string;
  case_type: string;
  member: string;
  petitioner: string;
  respondent: string;
  judgment_date: string;
  pdf_url: string;
  full_pdf_url: string;
  year: number;
  filename: string;
}

interface ScrapeProgress {
  lastCompletedYear: number;
  lastCompletedMonth: number;
  totalMetadataExtracted: number;
  totalPDFsDownloaded: number;
  failedDownloads: string[];
  completedDownloads: string[];
}

// ── Utilities ────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function loadProgress(): ScrapeProgress {
  const progressFile = path.join(METADATA_DIR, 'scrape-progress.json');
  if (fs.existsSync(progressFile)) {
    return JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
  }
  return {
    lastCompletedYear: START_YEAR - 1,
    lastCompletedMonth: 12,
    totalMetadataExtracted: 0,
    totalPDFsDownloaded: 0,
    failedDownloads: [],
    completedDownloads: [],
  };
}

function saveProgress(progress: ScrapeProgress): void {
  const progressFile = path.join(METADATA_DIR, 'scrape-progress.json');
  fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
}

// ── HTTP Helpers ─────────────────────────────────────────────────────
function fetchPost(url: string, body: string): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Referer: `${BASE_URL}/Delhi/services/judgment.php`,
        'User-Agent': 'Mozilla/5.0 (compatible; VaquillLegalBot/1.0; +https://vaquill.com)',
      },
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, data });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VaquillLegalBot/1.0; +https://vaquill.com)',
      },
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          downloadFile(
            redirectUrl.startsWith('http') ? redirectUrl : `${BASE_URL}${redirectUrl}`,
            dest,
          )
            .then(resolve)
            .catch(reject);
          return;
        }
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ── HTML Parsing ─────────────────────────────────────────────────────
function parseJudgmentResults(html: string): JudgmentMetadata[] {
  const judgments: JudgmentMetadata[] = [];

  // Match table rows with judgment data
  const rowRegex =
    /<tr>\s*<td colspan="1" >(\d+)<\/td>\s*<td colspan="2" >\s*([\s\S]*?)<\/td>[\s\S]*?<td>\s*([\s\S]*?)<\/td>\s*<td colspan="2">\s*([\s\S]*?)<\/td>\s*<td colspan="2">\s*([\d-]+)<\/td>[\s\S]*?href="([^"]+\.pdf)"/g;

  let match;
  while ((match = rowRegex.exec(html)) !== null) {
    const [, serial, caseNoHtml, memberHtml, partiesHtml, date, pdfUrl] = match;

    const caseNo = stripHtml(caseNoHtml).trim();
    const member = stripHtml(memberHtml).trim();

    // Extract petitioner/respondent from colored font tags
    const partyMatches = partiesHtml.match(/color='black'>(.*?)<\/font>/g);
    const petitioner = partyMatches?.[0] ? stripHtml(partyMatches[0]).trim() : '';
    const respondent = partyMatches?.[1] ? stripHtml(partyMatches[1]).trim() : '';

    // Determine case type from case number
    const caseType = caseNo.split('/')[0] || 'UNKNOWN';

    // Parse year from date (DD-MM-YYYY)
    const dateParts = date.split('-');
    const year = parseInt(dateParts[2], 10);

    // Generate filename from case number and date
    const filename = sanitizeFilename(`${caseNo.replace(/\//g, '_')}_${date}.pdf`);

    judgments.push({
      serial: parseInt(serial, 10),
      case_no: caseNo,
      case_type: caseType,
      member,
      petitioner,
      respondent,
      judgment_date: date,
      pdf_url: pdfUrl,
      full_pdf_url: `${BASE_URL}${pdfUrl}`,
      year,
      filename,
    });
  }

  return judgments;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ── Phase 1: Metadata Extraction ─────────────────────────────────────
async function extractAllMetadata(): Promise<JudgmentMetadata[]> {
  log('=== Phase 1: Extracting judgment metadata ===');

  const allJudgments: JudgmentMetadata[] = [];

  // Search the entire date range at once (TDSAT returns all results, no pagination)
  const fromDate = `01/01/${START_YEAR}`;
  const toDate = `31/12/${END_YEAR}`;
  const body = `from_date1=${encodeURIComponent(fromDate)}&to_date1=${encodeURIComponent(toDate)}&frm3=&submit11=Go`;

  log(`Fetching judgments from ${fromDate} to ${toDate}...`);

  const response = await fetchPost(JUDGMENT_ENDPOINT, body);

  if (response.status !== 200) {
    throw new Error(`Failed to fetch judgments: HTTP ${response.status}`);
  }

  const judgments = parseJudgmentResults(response.data);
  log(`Extracted ${judgments.length} judgments`);

  allJudgments.push(...judgments);

  // Save metadata
  ensureDir(METADATA_DIR);
  const metadataFile = path.join(METADATA_DIR, 'all_judgments.json');
  fs.writeFileSync(metadataFile, JSON.stringify(allJudgments, null, 2));
  log(`Saved metadata to ${metadataFile}`);

  // Also save as JSONL for pipeline compatibility
  const jsonlFile = path.join(METADATA_DIR, 'all_judgments.jsonl');
  const jsonlContent = allJudgments.map((j) => JSON.stringify(j)).join('\n');
  fs.writeFileSync(jsonlFile, jsonlContent);
  log(`Saved JSONL to ${jsonlFile}`);

  // Print summary by year
  const byYear: Record<number, number> = {};
  for (const j of allJudgments) {
    byYear[j.year] = (byYear[j.year] || 0) + 1;
  }
  log('\nJudgments by year:');
  for (const y of Object.keys(byYear).map(Number).sort()) {
    log(`  ${y}: ${byYear[y]}`);
  }

  // Print summary by case type
  const byType: Record<string, number> = {};
  for (const j of allJudgments) {
    byType[j.case_type] = (byType[j.case_type] || 0) + 1;
  }
  log('\nJudgments by case type:');
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    log(`  ${type}: ${count}`);
  }

  return allJudgments;
}

// ── Phase 2: PDF Downloads ───────────────────────────────────────────
async function downloadJudgments(judgments: JudgmentMetadata[]): Promise<void> {
  log(`\n=== Phase 2: Downloading ${judgments.length} judgment PDFs ===`);

  ensureDir(DOWNLOAD_DIR);

  const progress = loadProgress();
  const completed = new Set(progress.completedDownloads);
  const failed: string[] = [];
  let downloaded = 0;
  let skipped = 0;

  // Filter out already downloaded
  const toDownload = judgments.filter((j) => {
    const dest = path.join(DOWNLOAD_DIR, j.filename);
    if (completed.has(j.pdf_url) || fs.existsSync(dest)) {
      skipped++;
      return false;
    }
    return true;
  });

  log(`To download: ${toDownload.length} (skipping ${skipped} already downloaded)`);

  if (DRY_RUN) {
    log('DRY RUN - would download:');
    for (const j of toDownload.slice(0, 10)) {
      log(`  ${j.filename} from ${j.full_pdf_url}`);
    }
    if (toDownload.length > 10) {
      log(`  ... and ${toDownload.length - 10} more`);
    }
    return;
  }

  // Process in batches
  for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
    const batch = toDownload.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (judgment) => {
        const dest = path.join(DOWNLOAD_DIR, judgment.filename);

        try {
          await downloadFile(judgment.full_pdf_url, dest);

          // Verify file was actually written
          const stat = fs.statSync(dest);
          if (stat.size < 1000) {
            throw new Error(`File too small: ${stat.size} bytes`);
          }

          downloaded++;
          progress.completedDownloads.push(judgment.pdf_url);
          log(
            `  [${downloaded + skipped}/${judgments.length}] Downloaded: ${judgment.filename} (${(stat.size / 1024).toFixed(0)} KB)`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`  FAILED: ${judgment.filename} - ${msg}`);
          failed.push(judgment.pdf_url);
        }
      }),
    );

    // Save progress after each batch
    progress.totalPDFsDownloaded = downloaded + skipped;
    progress.failedDownloads = failed;
    saveProgress(progress);

    // Polite delay between batches
    if (i + CONCURRENCY < toDownload.length) {
      await sleep(500);
    }
  }

  log(`\nDownload complete: ${downloaded} new, ${skipped} skipped, ${failed.length} failed`);

  if (failed.length > 0) {
    log('\nFailed downloads:');
    for (const url of failed) {
      log(`  ${url}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  log('TDSAT Judgment Scraper');
  log('=====================');
  log(`Download dir: ${DOWNLOAD_DIR}`);
  log(`Concurrency: ${CONCURRENCY}`);
  log(`Year range: ${START_YEAR}-${END_YEAR}`);
  log(`Skip download: ${SKIP_DOWNLOAD}`);
  log(`Dry run: ${DRY_RUN}`);
  log('');

  ensureDir(DOWNLOAD_DIR);
  ensureDir(METADATA_DIR);

  // Phase 1: Extract metadata
  const judgments = await extractAllMetadata();

  if (judgments.length === 0) {
    log('No judgments found. Exiting.');
    return;
  }

  // Phase 2: Download PDFs
  if (!SKIP_DOWNLOAD) {
    await downloadJudgments(judgments);
  } else {
    log('\nSkipping download phase (SKIP_DOWNLOAD=true)');
  }

  // Final summary
  const progress = loadProgress();
  log('\n=== Final Summary ===');
  log(`Total judgments found: ${judgments.length}`);
  log(`PDFs downloaded: ${progress.totalPDFsDownloaded}`);
  log(`Failed downloads: ${progress.failedDownloads.length}`);
  log(`Metadata saved to: ${METADATA_DIR}/all_judgments.json`);
  log(`PDFs saved to: ${DOWNLOAD_DIR}/`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
