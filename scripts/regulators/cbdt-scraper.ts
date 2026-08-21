/**
 * CBDT Circulars Scraper
 *
 * Scrapes all CBDT circulars from incometaxindia.gov.in using Playwright.
 * Uses year-by-year filtering for reliable pagination (avoids session timeout).
 *
 * Phase 1: Extract metadata from listing page → JSONL
 * Phase 2: Download PDFs using exported cookies
 *
 * Usage:
 *   npx tsx scripts/cbdt-scraper.ts                    # Full scrape
 *   PHASE=1 npx tsx scripts/cbdt-scraper.ts            # Metadata only
 *   PHASE=2 npx tsx scripts/cbdt-scraper.ts            # PDF download only
 *   TEST_MODE=true npx tsx scripts/cbdt-scraper.ts     # First 3 years only
 *   SECTION=notifications npx tsx scripts/cbdt-scraper.ts  # Scrape notifications
 */

import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PHASE = process.env.PHASE || 'all';
const TEST_MODE = process.env.TEST_MODE === 'true';
const SECTION = process.env.SECTION || 'circulars';
const RESUME = process.env.RESUME !== 'false';

const DATA_DIR = path.join(process.cwd(), 'data', 'legal-sources', 'cbdt', 'metadata');
const PDF_DIR = path.join(process.cwd(), 'data', 'legal-sources', 'cbdt', 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'download-progress.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// PDF download settings
const BASE_DELAY_MS = parseInt(process.env.BASE_DELAY_MS || '1500', 10);
const COOLDOWN_BATCH = parseInt(process.env.COOLDOWN_BATCH || '50', 10);
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '15000', 10);
const BACKOFF_MS = parseInt(process.env.BACKOFF_MS || '120000', 10);
const REQUEST_TIMEOUT_MS = 30000;

const SECTION_CONFIG: Record<string, { url: string; file: string; label: string }> = {
  circulars: {
    url: 'https://incometaxindia.gov.in/pages/communications/circulars.aspx',
    file: 'cbdt-circulars.jsonl',
    label: 'CBDT Circulars',
  },
  notifications: {
    url: 'https://incometaxindia.gov.in/pages/communications/notifications.aspx',
    file: 'cbdt-notifications.jsonl',
    label: 'CBDT Notifications',
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CbdtDocument {
  id: string;
  type: string;
  circularNumber: string;
  year: number;
  title: string;
  subject: string;
  date: string;
  fileReference: string;
  status: string;
  pdfUrl: string | null;
  htmlUrl: string;
  country: 'IN';
  source: 'CBDT';
  section: string;
  scrapedAt: string;
}

interface DownloadProgress {
  completed: string[];
  restricted: string[];
  dead: string[];
  failed: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadProgress(): DownloadProgress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { completed: [], restricted: [], dead: [], failed: [] };
}

function saveProgress(p: DownloadProgress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

// ---------------------------------------------------------------------------
// Phase 1: Metadata Extraction (Year-by-Year)
// ---------------------------------------------------------------------------

async function extractPageEntries(page: Page, section: string): Promise<CbdtDocument[]> {
  const raw = await page.evaluate(() => {
    const entries: any[] = [];
    const anchors = document.querySelectorAll("a[onclick*='OpenFormByType']");

    for (const a of anchors) {
      const onclick = a.getAttribute('onclick') || '';
      const text = a.textContent?.trim() || '';

      // Extract PDF URL from onclick
      const urlMatch = onclick.match(/OpenFormByType\('([^'&]+)/);
      const pdfUrl = urlMatch ? urlMatch[1] : null;

      // Get parent for metadata
      const parentRow = a.closest('.ms-vb2') || a.closest('tr') || a.parentElement?.parentElement;
      const fullText = parentRow?.textContent?.trim() || text;

      // Extract date
      const dateMatch = fullText.match(
        /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i,
      );

      // Extract file reference
      const fnoMatch = fullText.match(/F\.?\s*No\.?\s*[\d\/.\-\w]+/i);

      entries.push({
        text,
        pdfUrl,
        fullText: fullText.substring(0, 1000),
        date: dateMatch ? dateMatch[1] : null,
        fileReference: fnoMatch ? fnoMatch[0] : null,
      });
    }
    return entries;
  });

  const now = new Date().toISOString();

  return raw.map((r: any) => {
    const numMatch = r.text.match(
      /(?:Circular|Notification)\s+No\.?\s*(\d+[\w-]*)\s*[\/\\]\s*(\d{4})/i,
    );
    const circularNumber = numMatch ? numMatch[1] : '';
    const year = numMatch ? parseInt(numMatch[2], 10) : 0;

    const titleParts = r.text.split(/:\s*/);
    const title = titleParts[0]?.trim() || r.text.trim();
    const subject = titleParts.slice(1).join(': ').trim() || '';

    const id =
      circularNumber && year
        ? `${section}-${circularNumber}-${year}`
        : `${section}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    return {
      id,
      type: section === 'circulars' ? 'circular' : 'notification',
      circularNumber,
      year,
      title: title.replace(/\s+/g, ' '),
      subject: subject.replace(/\s+/g, ' '),
      date: r.date || '',
      fileReference: r.fileReference || '',
      status: 'active',
      pdfUrl: r.pdfUrl || null,
      htmlUrl: SECTION_CONFIG[section].url,
      country: 'IN' as const,
      source: 'CBDT' as const,
      section,
      scrapedAt: now,
    };
  });
}

async function getAvailableYears(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const select = document.querySelector("select[id*='ddlYear']") as HTMLSelectElement;
    if (!select) return [];
    return Array.from(select.options)
      .map((o) => o.value)
      .filter((v) => v && v !== 'All');
  });
}

async function selectYear(page: Page, year: string): Promise<boolean> {
  try {
    // Use Playwright's selectOption which properly triggers change events
    const dropdown = page.locator("select[id*='ddlYear']");
    await dropdown.selectOption(year);

    // Click the Search/Submit button
    const searchBtn = page.locator("input[id*='btnSubmit'][value='Search']");
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
      searchBtn.click(),
    ]);

    await page.waitForTimeout(2000);
    return true;
  } catch (e) {
    console.log(`  [DEBUG] selectYear error: ${e}`);
    return false;
  }
}

async function scrapeAllPagesForCurrentFilter(
  page: Page,
  section: string,
): Promise<CbdtDocument[]> {
  const allEntries: CbdtDocument[] = [];

  // Get page count
  const pageInfo = await page.evaluate(() => {
    try {
      const text = document.body?.innerText || '';
      const match = text.match(/(\d+)\s*Record\(s\)\s*\|\s*Page\s*\[(\d+)\s*of\s*(\d+)\]/);
      return match
        ? { total: parseInt(match[1]), current: parseInt(match[2]), totalPages: parseInt(match[3]) }
        : null;
    } catch {
      return null;
    }
  });

  if (!pageInfo || pageInfo.total === 0) return [];

  const totalPages = pageInfo.totalPages;

  for (let p = 1; p <= totalPages; p++) {
    try {
      const entries = await extractPageEntries(page, section);
      allEntries.push(...entries);
    } catch {
      // Skip failed page
    }

    if (p < totalPages) {
      const nextBtn = await page.$("input[title='Next Page']:not([disabled])");
      if (!nextBtn) break;

      try {
        await Promise.all([
          page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
          nextBtn.click(),
        ]);
      } catch {}
      await page.waitForTimeout(1500);
    }
  }

  return allEntries;
}

async function scrapeMetadata(): Promise<CbdtDocument[]> {
  const config = SECTION_CONFIG[SECTION];
  if (!config) {
    console.error(`Unknown section: ${SECTION}`);
    process.exit(1);
  }

  console.log(`\n=== ${config.label} — Metadata Extraction ===\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();

  console.log('Loading listing page...');
  await page.goto(config.url, { waitUntil: 'networkidle', timeout: 60000 });

  // Get available years
  const years = await getAvailableYears(page);
  console.log(`Available years: ${years.length} (${years[0]} to ${years[years.length - 1]})`);

  // Check for resume — load existing docs and skip completed years
  const jsonlPath = path.join(DATA_DIR, config.file);
  let allDocs: CbdtDocument[] = [];
  const completedYears = new Set<string>();

  if (RESUME && fs.existsSync(jsonlPath)) {
    allDocs = fs
      .readFileSync(jsonlPath, 'utf-8')
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    // Mark years that are fully scraped
    for (const doc of allDocs) {
      if (doc.year > 0) completedYears.add(String(doc.year));
    }
    console.log(`Resume: ${allDocs.length} docs from ${completedYears.size} years already scraped`);
  }

  const yearsToScrape = years.filter((y) => !completedYears.has(y));
  const maxYears = TEST_MODE ? Math.min(3, yearsToScrape.length) : yearsToScrape.length;
  console.log(`Scraping ${maxYears} years${TEST_MODE ? ' (TEST MODE)' : ''}...\n`);

  for (let i = 0; i < maxYears; i++) {
    const year = yearsToScrape[i];

    // Reload the page fresh for each year (prevents stale sessions)
    // Retry up to 3 times on network errors
    if (i > 0) {
      let loaded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.goto(config.url, { waitUntil: 'networkidle', timeout: 60000 });
          loaded = true;
          break;
        } catch (e) {
          console.log(`  [RETRY ${attempt + 1}/3] Page reload failed: ${e}. Waiting 10s...`);
          await sleep(10000);
        }
      }
      if (!loaded) {
        console.log(`  [WARN] Could not reload page for year ${year}. Skipping.`);
        continue;
      }
    }

    // Select the year filter
    const filtered = await selectYear(page, year);
    if (!filtered) {
      console.log(`  [WARN] Failed to filter year ${year}. Skipping.`);
      continue;
    }

    // Scrape all pages for this year
    const yearEntries = await scrapeAllPagesForCurrentFilter(page, SECTION);
    allDocs.push(...yearEntries);

    const pdfCount = yearEntries.filter((e) => e.pdfUrl).length;
    process.stdout.write(
      `\r[${i + 1}/${maxYears}] Year ${year}: ${yearEntries.length} docs (${pdfCount} PDFs) | Total: ${allDocs.length}     \n`,
    );

    // Save incrementally
    const lines = allDocs.map((d) => JSON.stringify(d)).join('\n') + '\n';
    fs.writeFileSync(jsonlPath, lines);
  }

  // Also scrape "All" to catch any entries without year classification
  console.log('\nScraping unfiltered (All years) for any missed entries...');
  try {
    await page.goto(config.url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch {
    console.log('  [WARN] Could not load unfiltered view. Skipping.');
  }

  // Get total from "All" view
  const totalInfo = await page.evaluate(() => {
    try {
      const text = document.body?.innerText || '';
      const match = text.match(/(\d+)\s*Record\(s\)/);
      return match ? parseInt(match[1]) : 0;
    } catch {
      return 0;
    }
  });

  // Export cookies for Phase 2
  const cookies = await ctx.cookies();
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  fs.writeFileSync(path.join(DATA_DIR, 'cookies.txt'), cookieStr);

  await browser.close();

  // Deduplicate by PDF URL
  const seen = new Set<string>();
  const deduped = allDocs.filter((d) => {
    const key = d.pdfUrl || d.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\nExtracted ${deduped.length} unique documents (from ${allDocs.length} raw)`);
  console.log(`  Official total: ${totalInfo}`);
  const withPdf = deduped.filter((d) => d.pdfUrl).length;
  console.log(`  With PDF URLs: ${withPdf}`);
  console.log(`  Without PDF: ${deduped.length - withPdf}`);

  // Final save
  const lines = deduped.map((d) => JSON.stringify(d)).join('\n') + '\n';
  fs.writeFileSync(jsonlPath, lines);
  console.log(`\nSaved to ${jsonlPath}`);

  return deduped;
}

// ---------------------------------------------------------------------------
// Phase 2: PDF Download via Playwright (AES cookie challenge requires browser)
// ---------------------------------------------------------------------------

// Number of parallel download workers
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);

async function downloadWithWorker(
  workerPage: Page,
  url: string,
  dest: string,
): Promise<{ ok: boolean; size: number; status: string }> {
  try {
    ensureDir(path.dirname(dest));

    // Reuse same page — navigate to PDF, catch download event
    const [download] = await Promise.all([
      workerPage.waitForEvent('download', { timeout: 30000 }),
      workerPage.goto(url, { timeout: 30000 }).catch(() => {}),
    ]);

    await download.saveAs(dest);

    const size = fs.statSync(dest).size;
    if (size < 500) {
      fs.unlinkSync(dest);
      return { ok: false, size: 0, status: 'too_small' };
    }

    return { ok: true, size, status: 'ok' };
  } catch (e: any) {
    const msg = e.message || '';
    if (msg.includes('404') || msg.includes('Not Found')) {
      return { ok: false, size: 0, status: 'dead' };
    }
    return { ok: false, size: 0, status: 'error' };
  }
}

// Browser restart threshold — AES cookie degrades after ~150 downloads
const BROWSER_RESTART_EVERY = parseInt(process.env.BROWSER_RESTART_EVERY || '150', 10);

interface BrowserSession {
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  ctx: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>;
  workers: Page[];
}

async function createBrowserSession(warmupUrl: string): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: UA,
    acceptDownloads: true,
  });

  // Warm up — solve AES challenge, cookie persists for all pages in context
  const warmup = await ctx.newPage();
  await warmup.goto(warmupUrl, { waitUntil: 'networkidle', timeout: 60000 });
  await warmup.close();

  // Create worker pages
  const workers: Page[] = [];
  for (let w = 0; w < CONCURRENCY; w++) {
    workers.push(await ctx.newPage());
  }

  return { browser, ctx, workers };
}

async function closeBrowserSession(session: BrowserSession) {
  for (const w of session.workers) await w.close().catch(() => {});
  await session.browser.close().catch(() => {});
}

async function downloadPdfs() {
  const config = SECTION_CONFIG[SECTION];
  const jsonlPath = path.join(DATA_DIR, config.file);

  if (!fs.existsSync(jsonlPath)) {
    console.error(`No metadata file found: ${jsonlPath}`);
    console.error('Run Phase 1 first.');
    process.exit(1);
  }

  const docs: CbdtDocument[] = fs
    .readFileSync(jsonlPath, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  const withPdf = docs.filter((d) => d.pdfUrl);
  console.log(`\n=== ${config.label} — PDF Download (Playwright, ${CONCURRENCY} workers) ===`);
  console.log(`Loaded ${withPdf.length} documents with PDF URLs (${docs.length} total)`);
  console.log(`Browser restart every ${BROWSER_RESTART_EVERY} downloads`);

  const progress = loadProgress();
  // Clear previous failed list — they'll be retried with fresh browser
  progress.failed = [];
  const completedSet = new Set(progress.completed);
  const deadSet = new Set(progress.dead);

  console.log(`Already: ${completedSet.size} downloaded, ${deadSet.size} dead`);

  // Build queue (skip completed, dead, and already-on-disk)
  const queue: Array<{ doc: CbdtDocument; dest: string }> = [];
  let skipped = 0;

  for (const doc of withPdf) {
    const url = doc.pdfUrl!;
    if (completedSet.has(url) || deadSet.has(url)) continue;

    const filename = url.split('/').pop() || `${doc.id}.pdf`;
    const yearDir = doc.year > 0 ? String(doc.year) : 'unknown';
    const dest = path.join(PDF_DIR, SECTION, yearDir, sanitizeFilename(filename));

    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      progress.completed.push(url);
      completedSet.add(url);
      skipped++;
      continue;
    }

    queue.push({ doc, dest });
  }

  console.log(`Skipped (already on disk): ${skipped}`);
  console.log(`Queue: ${queue.length} to download\n`);
  if (queue.length === 0) {
    console.log('Nothing to download!');
    saveProgress(progress);
    return;
  }

  let downloaded = 0;
  let failed = 0;
  let dead = 0;
  let totalBytes = 0;
  let processed = 0;
  let sessionDownloads = 0;
  const startTime = Date.now();

  // Create initial browser session
  console.log('Starting browser session #1...');
  let session = await createBrowserSession(config.url);
  let sessionNum = 1;
  console.log('AES cookie established. Starting downloads.\n');

  // Process queue in batches of CONCURRENCY
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);

    const results = await Promise.all(
      batch.map((item, idx) => {
        const worker = session.workers[idx % session.workers.length];
        return downloadWithWorker(worker, item.doc.pdfUrl!, item.dest);
      }),
    );

    let batchFails = 0;
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const url = batch[j].doc.pdfUrl!;
      processed++;

      if (result.ok) {
        progress.completed.push(url);
        completedSet.add(url);
        downloaded++;
        sessionDownloads++;
        totalBytes += result.size;
      } else if (result.status === 'dead') {
        progress.dead.push(url);
        deadSet.add(url);
        dead++;
      } else {
        progress.failed.push(url);
        failed++;
        batchFails++;
      }
    }

    // Restart browser if session is stale (too many downloads or entire batch failed)
    const needsRestart =
      sessionDownloads >= BROWSER_RESTART_EVERY ||
      (batchFails === batch.length && batch.length > 1);

    if (needsRestart) {
      sessionNum++;
      console.log(
        `\n  [RESTART] Session had ${sessionDownloads} downloads. Starting browser session #${sessionNum}...`,
      );
      await closeBrowserSession(session);
      await sleep(3000);
      session = await createBrowserSession(config.url);
      sessionDownloads = 0;
      console.log('  New session ready.');
    }

    // Progress display
    const pct = ((processed / queue.length) * 100).toFixed(1);
    const mb = (totalBytes / 1024 / 1024).toFixed(1);
    const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    const rate =
      downloaded > 0 ? (downloaded / ((Date.now() - startTime) / 60000)).toFixed(0) : '0';
    process.stdout.write(
      `\r[${pct}%] ${processed}/${queue.length} | dl=${downloaded} dead=${dead} fail=${failed} | ${mb}MB | ${elapsed}min | ~${rate}/min | session#${sessionNum}   `,
    );

    // Save progress periodically
    if (processed % 50 === 0) saveProgress(progress);

    // Polite delay between batches
    await sleep(BASE_DELAY_MS);
  }

  saveProgress(progress);
  await closeBrowserSession(session);

  const elapsed = (Date.now() - startTime) / 60000;
  console.log(`\n\n=== Download Complete ===`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Skipped (already done): ${skipped}`);
  console.log(`Dead/404: ${dead}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Time: ${elapsed.toFixed(1)} minutes`);
  console.log(`Browser sessions used: ${sessionNum}`);
  if (elapsed > 0) console.log(`Avg rate: ${(downloaded / elapsed).toFixed(1)} PDFs/min`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(PDF_DIR);

  console.log(`=== CBDT Scraper ===`);
  console.log(`Section: ${SECTION}`);
  console.log(`Phase: ${PHASE}`);
  console.log(`Test mode: ${TEST_MODE}\n`);

  if (PHASE === '1' || PHASE === 'all') {
    await scrapeMetadata();
  }

  if (PHASE === '2' || PHASE === 'all') {
    await downloadPdfs();
  }
}

main().catch(console.error);
