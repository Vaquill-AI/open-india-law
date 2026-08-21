/**
 * APTEL Supplementary Scraper - Acts, Legal Forms, Statistics, Circulars
 * Scrapes non-judgment data from https://www.aptel.gov.in
 *
 * Data sources:
 *   - /en/acts           (7 PDFs - foundational statutes)
 *   - /en/downloads      (32 PDFs - legal forms, fee schedules)
 *   - /en/statistics     (4 PDFs - case disposal data)
 *   - /en/circulars      (15 PDFs - administrative circulars)
 *
 * Usage:
 *   npx tsx scripts/aptel-supplementary-scraper.ts                # Full run
 *   npx tsx scripts/aptel-supplementary-scraper.ts --category acts # Single category
 *   npx tsx scripts/aptel-supplementary-scraper.ts --metadata-only # Metadata only
 *   npx tsx scripts/aptel-supplementary-scraper.ts --test          # Test run
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
const SUPP_DIR = path.join(DATA_DIR, 'supplementary');
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

type Category = 'acts' | 'downloads' | 'statistics' | 'circulars';

const CATEGORIES: Record<
  Category,
  { url: string; dir: string; label: string; ragPriority: string }
> = {
  acts: {
    url: '/en/acts',
    dir: 'acts',
    label: 'Acts & Statutes',
    ragPriority: 'high',
  },
  downloads: {
    url: '/en/downloads',
    dir: 'downloads',
    label: 'Legal Forms & Downloads',
    ragPriority: 'medium',
  },
  statistics: {
    url: '/en/statistics',
    dir: 'statistics',
    label: 'Case Statistics',
    ragPriority: 'low',
  },
  circulars: {
    url: '/en/circulars',
    dir: 'circulars',
    label: 'Circulars & Orders',
    ragPriority: 'low',
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SupplementaryMetadata {
  serial_no: number;
  title: string;
  publish_date: string;
  category: Category;
  subcategory: string;
  pdf_url: string;
  pdf_filename: string;
  file_size: string;
  language: string;
  source_url: string;
  tribunal: string;
  country: string;
  rag_priority: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function fetchPage(urlPath: string): Promise<string> {
  const fullUrl = urlPath.startsWith('http') ? urlPath : BASE_URL + urlPath;
  return new Promise((resolve, reject) => {
    https
      .get(fullUrl, { rejectUnauthorized: false }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          fetchPage(res.headers.location).then(resolve).catch(reject);
          return;
        }
        const chunks: Uint8Array[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

function downloadFile(urlPath: string, dest: string, retries = MAX_RETRIES): Promise<boolean> {
  const fullUrl = urlPath.startsWith('http') ? urlPath : BASE_URL + urlPath;
  const tmpDest = dest + '.tmp';

  return new Promise((resolve) => {
    https
      .get(fullUrl, { rejectUnauthorized: false }, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          downloadFile(res.headers.location, dest, retries).then(resolve);
          return;
        }
        if (res.statusCode !== 200) {
          console.error(`  [FAIL] HTTP ${res.statusCode}: ${fullUrl}`);
          resolve(false);
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
            console.error(`  [FAIL] Rename error for ${dest}`);
            resolve(false);
          }
        });
        file.on('error', (err) => {
          if (resolved) return;
          resolved = true;
          console.error(`  [FAIL] Write error: ${err.message}`);
          try {
            fs.unlinkSync(tmpDest);
          } catch {
            /* ignore */
          }
          resolve(false);
        });
      })
      .on('error', (err) => {
        if (retries > 0) {
          console.log(`  [RETRY] ${err.message} - ${retries} left`);
          setTimeout(() => {
            downloadFile(urlPath, dest, retries - 1).then(resolve);
          }, RETRY_DELAY_MS);
        } else {
          console.error(`  [FAIL] ${err.message}: ${fullUrl}`);
          resolve(false);
        }
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseActsOrStatisticsPage(html: string, category: Category): SupplementaryMetadata[] {
  const results: SupplementaryMetadata[] = [];

  // Find tbody in the main content table
  const tbodyMatch = html.match(/<table class="table[^"]*"[^>]*>.*?<tbody>(.*?)<\/tbody>/s);
  if (!tbodyMatch) return results;

  const rows = tbodyMatch[1].match(/<tr>(.*?)<\/tr>/gs) || [];

  for (const row of rows) {
    const tds = row.match(/<td[^>]*>(.*?)<\/td>/gs) || [];
    if (tds.length < 4) continue;

    const serialNo = parseInt(stripHtml(tds[0]), 10);
    const title = stripHtml(tds[1]);
    const publishDate = stripHtml(tds[2]);

    // Extract PDF from this row
    const pdfMatch = row.match(/href="([^"]*\.pdf)"/);
    if (!pdfMatch) continue;
    const pdfUrl = pdfMatch[1];

    // Extract file size if present
    const sizeMatch = row.match(/file_size">([\d.]+\s*[KMG]B)/);
    const fileSize = sizeMatch ? sizeMatch[1] : '';

    // Extract language
    const langMatch = row.match(/Language\s*:\s*(\w+)/);
    const language = langMatch ? langMatch[1] : 'English';

    const pdfFilename = decodeURIComponent(pdfUrl.split('/').pop() || 'unknown.pdf');

    results.push({
      serial_no: serialNo,
      title,
      publish_date: publishDate,
      category,
      subcategory: category === 'acts' ? classifyAct(title) : 'statistics',
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      file_size: fileSize,
      language,
      source_url: BASE_URL + CATEGORIES[category].url,
      tribunal: 'APTEL',
      country: 'IN',
      rag_priority: CATEGORIES[category].ragPriority,
    });
  }

  return results;
}

function parseDownloadsPage(html: string): SupplementaryMetadata[] {
  const results: SupplementaryMetadata[] = [];

  // Downloads page has multiple tables with different structures
  const rows = html.match(/<tr>(.*?)<\/tr>/gs) || [];
  let serial = 0;

  for (const row of rows) {
    const pdfMatch = row.match(/href="([^"]*\.pdf)"/);
    if (!pdfMatch) continue;

    const tds = row.match(/<td[^>]*>(.*?)<\/td>/gs) || [];
    if (tds.length < 2) continue;

    serial++;
    const title = stripHtml(tds[1]);
    const pdfUrl = pdfMatch[1];

    const sizeMatch = row.match(/file_size">([\d.]+\s*[KMG]B)/);
    const fileSize = sizeMatch ? sizeMatch[1] : '';

    const langMatch = row.match(/Language\s*:\s*(\w+)/);
    const language = langMatch ? langMatch[1] : 'English';

    const pdfFilename = decodeURIComponent(pdfUrl.split('/').pop() || 'unknown.pdf');

    results.push({
      serial_no: serial,
      title,
      publish_date: '',
      category: 'downloads',
      subcategory: classifyDownload(title),
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      file_size: fileSize,
      language,
      source_url: BASE_URL + CATEGORIES.downloads.url,
      tribunal: 'APTEL',
      country: 'IN',
      rag_priority: classifyDownloadPriority(title),
    });
  }

  return results;
}

function parseCircularsPage(html: string): SupplementaryMetadata[] {
  const results: SupplementaryMetadata[] = [];

  const tbodyMatch = html.match(/<table class="table[^"]*"[^>]*>.*?<tbody>(.*?)<\/tbody>/s);
  if (!tbodyMatch) return results;

  const rows = tbodyMatch[1].match(/<tr>(.*?)<\/tr>/gs) || [];

  for (const row of rows) {
    const tds = row.match(/<td[^>]*>(.*?)<\/td>/gs) || [];
    if (tds.length < 4) continue;

    const serialNo = parseInt(stripHtml(tds[0]), 10);
    const title = stripHtml(tds[1]);
    const publishDate = stripHtml(tds[2]);

    const pdfMatch = row.match(/href="([^"]*\.pdf)"/);
    if (!pdfMatch) continue;
    const pdfUrl = pdfMatch[1];

    const sizeMatch = row.match(/file_size">([\d.]+\s*[KMG]B)/);
    const fileSize = sizeMatch ? sizeMatch[1] : '';

    const langMatch = row.match(/Language\s*:\s*(\w+)/);
    const language = langMatch ? langMatch[1] : 'English';

    const pdfFilename = decodeURIComponent(pdfUrl.split('/').pop() || 'unknown.pdf');

    results.push({
      serial_no: serialNo,
      title,
      publish_date: publishDate,
      category: 'circulars',
      subcategory: 'administrative',
      pdf_url: pdfUrl,
      pdf_filename: pdfFilename,
      file_size: fileSize,
      language,
      source_url: BASE_URL + CATEGORIES.circulars.url,
      tribunal: 'APTEL',
      country: 'IN',
      rag_priority: 'low',
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

function classifyAct(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('electricity act')) return 'statute';
  if (lower.includes('energy conservation')) return 'statute';
  if (lower.includes('petroleum')) return 'statute';
  if (lower.includes('constitution')) return 'statute';
  if (lower.includes('rule') || lower.includes('procedure')) return 'rules';
  return 'statute';
}

function classifyDownload(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('form -') || lower.includes('form-')) return 'legal_form';
  if (lower.includes('fee')) return 'fee_schedule';
  if (lower.includes('check list')) return 'filing_checklist';
  if (lower.includes('opening sheet')) return 'filing_template';
  if (lower.includes('vakalatnama')) return 'legal_form';
  if (lower.includes('affidavit')) return 'legal_form';
  if (lower.includes('advocate')) return 'filing_template';
  if (lower.includes('apar') || lower.includes('leave')) return 'administrative';
  return 'other';
}

function classifyDownloadPriority(title: string): string {
  const sub = classifyDownload(title);
  if (sub === 'legal_form' || sub === 'fee_schedule' || sub === 'filing_checklist') return 'medium';
  if (sub === 'filing_template') return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeCategory(category: Category): Promise<SupplementaryMetadata[]> {
  const config = CATEGORIES[category];
  console.log(`\n--- Scraping ${config.label} (${config.url}) ---`);

  const html = await fetchPage(config.url);
  console.log(`  Fetched ${html.length} bytes`);

  let items: SupplementaryMetadata[];
  switch (category) {
    case 'acts':
    case 'statistics':
      items = parseActsOrStatisticsPage(html, category);
      break;
    case 'downloads':
      items = parseDownloadsPage(html);
      break;
    case 'circulars':
      items = parseCircularsPage(html);
      break;
  }

  console.log(`  Parsed ${items.length} items`);
  return items;
}

async function downloadPdfs(
  items: SupplementaryMetadata[],
  category: Category,
): Promise<{ success: number; failed: string[] }> {
  const dir = path.join(SUPP_DIR, CATEGORIES[category].dir);
  fs.mkdirSync(dir, { recursive: true });

  let success = 0;
  const failed: string[] = [];
  const queue = [...items];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      const safeName = sanitizeFilename(
        `${String(item.serial_no).padStart(3, '0')}_${item.pdf_filename}`,
      );
      const dest = path.join(dir, safeName);

      if (fs.existsSync(dest)) {
        console.log(`  [SKIP] Already exists: ${safeName}`);
        success++;
        continue;
      }

      console.log(`  [DL] ${safeName}`);
      const ok = await downloadFile(item.pdf_url, dest);
      if (ok) {
        success++;
        // Update filename in metadata to match actual saved file
        item.pdf_filename = safeName;
      } else {
        failed.push(item.pdf_url);
      }

      await sleep(300);
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, () => worker());
  await Promise.all(workers);

  return { success, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const metadataOnly = args.includes('--metadata-only');
  const testMode = args.includes('--test');
  const categoryFlag = args.indexOf('--category');
  const targetCategories: Category[] =
    categoryFlag >= 0
      ? ([args[categoryFlag + 1]] as Category[])
      : (['acts', 'downloads', 'statistics', 'circulars'] as Category[]);

  console.log('=== APTEL Supplementary Scraper ===');
  console.log(`Categories: ${targetCategories.join(', ')}`);
  console.log(`Mode: ${metadataOnly ? 'metadata-only' : testMode ? 'test' : 'full'}`);

  // Ensure directories
  fs.mkdirSync(SUPP_DIR, { recursive: true });
  fs.mkdirSync(path.join(SUPP_DIR, 'metadata'), { recursive: true });

  const allItems: SupplementaryMetadata[] = [];
  const summary: Record<string, { total: number; downloaded: number; failed: string[] }> = {};

  for (const cat of targetCategories) {
    const items = await scrapeCategory(cat);
    allItems.push(...items);

    // Save per-category metadata
    const metaFile = path.join(SUPP_DIR, 'metadata', `aptel-${cat}.json`);
    fs.writeFileSync(metaFile, JSON.stringify(items, null, 2));
    console.log(`  Saved metadata: ${metaFile}`);

    if (!metadataOnly) {
      const maxItems = testMode ? items.slice(0, 2) : items;
      const result = await downloadPdfs(maxItems, cat);
      summary[cat] = {
        total: maxItems.length,
        downloaded: result.success,
        failed: result.failed,
      };
    } else {
      summary[cat] = { total: items.length, downloaded: 0, failed: [] };
    }
  }

  // Save combined JSONL
  const jsonlFile = path.join(SUPP_DIR, 'aptel-supplementary-all.jsonl');
  const jsonlContent = allItems.map((i) => JSON.stringify(i)).join('\n') + '\n';
  fs.writeFileSync(jsonlFile, jsonlContent);
  console.log(`\nSaved combined JSONL: ${jsonlFile} (${allItems.length} items)`);

  // Print summary
  console.log('\n=== SUMMARY ===');
  for (const [cat, s] of Object.entries(summary)) {
    const status =
      s.failed.length > 0
        ? `${s.downloaded}/${s.total} (${s.failed.length} failed)`
        : `${s.downloaded}/${s.total}`;
    console.log(`  ${cat}: ${status}`);
  }

  const totalFailed = Object.values(summary).flatMap((s) => s.failed);
  if (totalFailed.length > 0) {
    const failedFile = path.join(SUPP_DIR, 'failed-downloads.json');
    fs.writeFileSync(failedFile, JSON.stringify(totalFailed, null, 2));
    console.log(`\nFailed downloads saved: ${failedFile}`);
  }

  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
