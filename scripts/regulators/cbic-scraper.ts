/**
 * CBIC Tax Information Portal Scraper (API-Based)
 * Target: taxinformation.cbic.gov.in
 *
 * Phase 1: Metadata extraction via REST APIs (no Playwright needed)
 * Phase 2: PDF download via Playwright (needs session cookies for auth)
 *
 * Doc types and their endpoint patterns:
 *   - Circulars:     fetchCircularByYearCategory (paginated by year, works for Customs/CentralExcise)
 *   - Notifications:  fetchNotificationByYearAndCategory (paginated by year, ServiceTax only)
 *   - Instructions:   base endpoint returns ALL 570 items (no year/taxId filtering)
 *   - Orders:         base endpoint returns ALL 360 items
 *   - Acts:           base endpoint returns ALL 15 items
 *   - Rules:          base endpoint returns ALL 94 items
 *   - Regulations:    base endpoint returns ALL 572 items
 *   - Forms:          base endpoint returns ALL 401 items
 *
 * Note: GST (taxId=1000001) returns 500 on ALL endpoints — backend is broken.
 *       Notification endpoints return 500 for Customs/CentralExcise.
 *
 * Usage:
 *   PHASE=1 npx tsx scripts/cbic-scraper.ts                    # Full metadata extraction
 *   PHASE=1 TEST_MODE=true npx tsx scripts/cbic-scraper.ts     # Quick test
 *   PHASE=2 npx tsx scripts/cbic-scraper.ts                    # PDF download
 *   PHASE=2 CONCURRENCY=3 npx tsx scripts/cbic-scraper.ts      # PDF with concurrency
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://taxinformation.cbic.gov.in';
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: `${BASE}/content-page/explore-notification`,
  Origin: BASE,
};

const PHASE = process.env.PHASE || '1';
const TEST_MODE = process.env.TEST_MODE === 'true';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);

const DATA_DIR = path.join(process.cwd(), 'data', 'legal-sources', 'cbic');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDF_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(METADATA_DIR, 'scrape-progress.json');

// Tax sections
const TAX_SECTIONS = {
  customs: { id: 1000002, name: 'Customs' },
  'central-excise': { id: 1000003, name: 'Central Excise' },
  'service-tax': { id: 1000004, name: 'Service Tax' },
  gst: { id: 1000001, name: 'GST' }, // broken but included for completeness
} as const;

// Year ranges
const FULL_YEARS = Array.from({ length: 27 }, (_, i) => 2026 - i); // 2026-2000
const TEST_YEARS = [2024, 2023];

// ──────────────────────── Helpers ────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Progress {
  completedKeys: string[];
  stats: Record<string, number>;
  lastUpdated: string;
}

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { completedKeys: [], stats: {}, lastUpdated: '' };
}

function saveProgress(p: Progress): void {
  p.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

async function fetchJSON(endpoint: string, retries = 3): Promise<{ status: number; data: any }> {
  const url = `${BASE}${endpoint}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 200) {
        const data = await res.json();
        return { status: 200, data };
      }
      const text = await res.text();
      return { status: res.status, data: text.substring(0, 200) };
    } catch (err: any) {
      if (attempt < retries - 1) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      return { status: -1, data: err.message?.substring(0, 100) || 'fetch failed' };
    }
  }
  return { status: -1, data: 'max retries' };
}

function appendJSONL(filePath: string, records: any[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines);
}

// ──────────────────────── Phase 1: Metadata ────────────────────────

async function scrapeCirculars(progress: Progress): Promise<number> {
  log('=== CIRCULARS (paginated by year) ===');
  const outputFile = path.join(METADATA_DIR, 'cbic-circulars.jsonl');
  let total = 0;

  // Customs and Central Excise work. GST returns 500. Service Tax returns 0.
  const workingSections = [
    TAX_SECTIONS.customs,
    TAX_SECTIONS['central-excise'],
    TAX_SECTIONS['service-tax'],
  ];

  const years = TEST_MODE ? TEST_YEARS : FULL_YEARS;

  for (const section of workingSections) {
    for (const year of years) {
      const key = `circular|${section.id}|${year}`;
      if (progress.completedKeys.includes(key)) continue;

      const ep = `/api/cbic-circular-msts/fetchCircularByYearCategory?year=${year}&page=0&size=500&taxId=${section.id}`;
      const { status, data } = await fetchJSON(ep);

      if (status === 200 && Array.isArray(data)) {
        if (data.length > 0) {
          // Add metadata fields
          const enriched = data.map((item: any) => ({
            ...item,
            _docType: 'circular',
            _section: section.name,
            _taxId: section.id,
            _year: year,
            _scrapedAt: new Date().toISOString(),
          }));
          appendJSONL(outputFile, enriched);
          total += data.length;
          log(`  ${section.name} ${year}: ${data.length} circulars`);
        }
      } else if (status === 500) {
        log(`  ${section.name} ${year}: 500 (backend broken)`);
      } else {
        log(
          `  ${section.name} ${year}: [${status}] ${typeof data === 'string' ? data.substring(0, 80) : ''}`,
        );
      }

      progress.completedKeys.push(key);
      saveProgress(progress);
      await sleep(500); // Be polite
    }
  }

  return total;
}

async function scrapeNotifications(progress: Progress): Promise<number> {
  log('\n=== NOTIFICATIONS (ServiceTax only — others broken) ===');
  const outputFile = path.join(METADATA_DIR, 'cbic-notifications.jsonl');
  let total = 0;

  // Only Service Tax notifications work
  const section = TAX_SECTIONS['service-tax'];
  const years = TEST_MODE ? TEST_YEARS : FULL_YEARS;

  for (const year of years) {
    const key = `notification|${section.id}|${year}`;
    if (progress.completedKeys.includes(key)) continue;

    const ep = `/api/cbic-notification-msts/fetchNotificationByYearAndCategory?year=${year}&page=0&size=500&taxId=${section.id}&category=null`;
    const { status, data } = await fetchJSON(ep);

    if (status === 200 && Array.isArray(data)) {
      if (data.length > 0) {
        const enriched = data.map((item: any) => ({
          ...item,
          _docType: 'notification',
          _section: section.name,
          _taxId: section.id,
          _year: year,
          _scrapedAt: new Date().toISOString(),
        }));
        appendJSONL(outputFile, enriched);
        total += data.length;
        log(`  ${section.name} ${year}: ${data.length} notifications`);
      }
    } else {
      log(`  ${section.name} ${year}: [${status}]`);
    }

    progress.completedKeys.push(key);
    saveProgress(progress);
    await sleep(500);
  }

  // Also attempt Customs/Central Excise in case backend gets fixed
  for (const sec of [TAX_SECTIONS.customs, TAX_SECTIONS['central-excise']]) {
    const testKey = `notification|${sec.id}|test`;
    if (progress.completedKeys.includes(testKey)) continue;

    const { status } = await fetchJSON(
      `/api/cbic-notification-msts/fetchNotificationByYearAndCategory?year=2024&page=0&size=10&taxId=${sec.id}&category=null`,
    );
    if (status === 500) {
      log(`  ${sec.name}: still broken (500), skipping all years`);
    } else if (status === 200) {
      log(`  ${sec.name}: FIXED! Would need to scrape all years.`);
    }
    progress.completedKeys.push(testKey);
    saveProgress(progress);
  }

  return total;
}

async function scrapeBulkEndpoint(
  docType: string,
  apiBase: string,
  progress: Progress,
): Promise<number> {
  const key = `bulk|${docType}`;
  if (progress.completedKeys.includes(key)) {
    log(`  ${docType}: already scraped, skipping`);
    return 0;
  }

  const outputFile = path.join(METADATA_DIR, `cbic-${docType}.jsonl`);

  // These endpoints return ALL data regardless of year/taxId params
  // Just need any valid taxId to make the request work
  const ep = `/api/cbic-${docType}-msts?year=2024&taxId=1000002`;
  const { status, data } = await fetchJSON(ep);

  if (status === 200 && Array.isArray(data)) {
    const enriched = data.map((item: any) => ({
      ...item,
      _docType: docType,
      _scrapedAt: new Date().toISOString(),
    }));
    appendJSONL(outputFile, enriched);
    log(`  ${docType}: ${data.length} items`);

    progress.completedKeys.push(key);
    progress.stats[docType] = data.length;
    saveProgress(progress);
    return data.length;
  }

  log(`  ${docType}: [${status}] ${typeof data === 'string' ? data.substring(0, 80) : ''}`);
  return 0;
}

async function phase1(): Promise<void> {
  log('=== PHASE 1: CBIC Metadata Extraction ===\n');
  fs.mkdirSync(METADATA_DIR, { recursive: true });

  const progress = loadProgress();
  let grandTotal = 0;

  // 1. Circulars (paginated by year for each section)
  const circularCount = await scrapeCirculars(progress);
  grandTotal += circularCount;
  progress.stats.circulars = (progress.stats.circulars || 0) + circularCount;

  // 2. Notifications (Service Tax only)
  const notifCount = await scrapeNotifications(progress);
  grandTotal += notifCount;
  progress.stats.notifications = (progress.stats.notifications || 0) + notifCount;

  // 3. Bulk endpoints (Instructions, Orders, Acts, Rules, Regulations, Forms)
  const bulkTypes = ['instruction', 'order', 'act', 'rule', 'regulation', 'form'];

  log('\n=== BULK ENDPOINTS (return all data in single call) ===');
  for (const dt of bulkTypes) {
    const count = await scrapeBulkEndpoint(dt, `/api/cbic-${dt}-msts`, progress);
    grandTotal += count;
    await sleep(500);
  }

  // Summary
  log(`\n${'='.repeat(60)}`);
  log('PHASE 1 COMPLETE');
  log(`${'='.repeat(60)}`);
  log(`Total records extracted: ${grandTotal}`);
  log('Breakdown:');
  for (const [key, val] of Object.entries(progress.stats)) {
    log(`  ${key}: ${val}`);
  }
  log(`\nMetadata saved to: ${METADATA_DIR}`);
  log(`Files:`);
  const files = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    const lines = fs
      .readFileSync(path.join(METADATA_DIR, f), 'utf-8')
      .split('\n')
      .filter(Boolean).length;
    const size = fs.statSync(path.join(METADATA_DIR, f)).size;
    log(`  ${f}: ${lines} records (${(size / 1024).toFixed(1)} KB)`);
  }
  saveProgress(progress);
}

// ──────────────────────── Phase 2: PDF Downloads ────────────────────────

interface PDFTarget {
  contentId: number;
  docFilePath: string;
  docFileName: string;
  docType: string;
  section: string;
  id: number;
}

function collectPDFTargets(): PDFTarget[] {
  const targets: PDFTarget[] = [];
  const seen = new Set<number>();

  const jsonlFiles = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.jsonl'));

  for (const file of jsonlFiles) {
    const lines = fs
      .readFileSync(path.join(METADATA_DIR, file), 'utf-8')
      .split('\n')
      .filter(Boolean);

    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        const contentId = rec.contentId;
        if (!contentId || seen.has(contentId)) continue;
        seen.add(contentId);

        // Different doc types have different file path fields
        const docFilePath = rec.docFilePath || rec.contentFilePath || '';
        const docFileName = rec.docFileName || rec.contentFileName || '';

        if (!docFilePath && !docFileName) continue;

        const docType = rec._docType || file.replace('cbic-', '').replace('.jsonl', '');
        const section = rec._section || rec.tax?.id?.toString() || 'unknown';

        targets.push({
          contentId,
          docFilePath: docFilePath.replace(/\\\\/g, '/').replace(/\\/g, '/'),
          docFileName,
          docType,
          section,
          id: rec.id,
        });
      } catch {}
    }
  }

  return targets;
}

async function phase2(): Promise<void> {
  log('=== PHASE 2: PDF Downloads ===\n');
  fs.mkdirSync(PDF_DIR, { recursive: true });

  const targets = collectPDFTargets();
  log(`Found ${targets.length} unique documents with content IDs`);

  // Filter already downloaded
  const existingFiles = new Set(fs.readdirSync(PDF_DIR));
  const pending = targets.filter((t) => {
    const filename = `${t.docType}-${t.contentId}.pdf`;
    return !existingFiles.has(filename);
  });
  log(`Already downloaded: ${targets.length - pending.length}`);
  log(`Pending: ${pending.length}\n`);

  if (pending.length === 0) {
    log('All PDFs already downloaded!');
    return;
  }

  // Use Playwright for authenticated PDF downloads
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: HEADERS['User-Agent'],
    acceptDownloads: true,
  });

  // Establish session by visiting the site
  log('Establishing browser session...');
  const sessionPage = await ctx.newPage();
  try {
    await sessionPage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sessionPage.waitForTimeout(5000);
    log('Session established');
  } catch (err: any) {
    log(`Session establishment warning: ${err.message.substring(0, 60)}`);
  }

  let downloaded = 0;
  let failed = 0;
  const skipped = 0;

  // Process in batches
  for (let i = 0; i < pending.length; i++) {
    const target = pending[i];
    const filename = `${target.docType}-${target.contentId}.pdf`;
    const destPath = path.join(PDF_DIR, filename);

    try {
      // Try multiple URL patterns
      const urlsToTry = [
        // Pattern 1: view-pdf with content type
        `${BASE}/api/cbicContentMsts/view-pdf/${target.contentId}/ENG/${getContentType(target.docType)}`,
        // Pattern 2: Direct path conversion
        target.docFilePath ? `${BASE}/${target.docFilePath}` : null,
        // Pattern 3: API download
        `${BASE}/api/cbic-content-msts/view-pdf/${target.contentId}/ENG/${getContentType(target.docType)}`,
      ].filter(Boolean) as string[];

      let success = false;

      for (const url of urlsToTry) {
        try {
          const response = await sessionPage.evaluate(async (fetchUrl) => {
            const res = await fetch(fetchUrl);
            if (!res.ok) return { ok: false, status: res.status };
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('pdf') && !ct.includes('octet-stream')) {
              return { ok: false, status: res.status, ct };
            }
            // Convert to base64
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let j = 0; j < bytes.length; j++) {
              binary += String.fromCharCode(bytes[j]);
            }
            return { ok: true, data: btoa(binary), size: bytes.length };
          }, url);

          if (response.ok && response.data) {
            const buffer = Buffer.from(response.data, 'base64');
            fs.writeFileSync(destPath, buffer);
            downloaded++;
            success = true;
            break;
          }
        } catch {}
      }

      if (!success) {
        failed++;
      }
    } catch (err: any) {
      failed++;
    }

    // Progress logging
    if ((i + 1) % 50 === 0 || i === pending.length - 1) {
      log(
        `Progress: ${downloaded} downloaded, ${failed} failed, ${pending.length - i - 1} remaining`,
      );
    }

    // Rate limiting
    if ((i + 1) % 10 === 0) await sleep(1000);
  }

  log(`\n${'='.repeat(60)}`);
  log(`PHASE 2 COMPLETE: ${downloaded} downloaded, ${failed} failed, ${skipped} skipped`);
  log(`PDFs saved to: ${PDF_DIR}`);

  await browser.close();
}

function getContentType(docType: string): string {
  const map: Record<string, string> = {
    circular: 'Circulars',
    notification: 'Notifications',
    instruction: 'Instructions',
    order: 'Orders',
    act: 'Acts',
    rule: 'Rules',
    regulation: 'Regulations',
    form: 'Forms',
  };
  return map[docType] || docType;
}

// ──────────────────────── Main ────────────────────────

async function main(): Promise<void> {
  log(`CBIC Scraper — Phase ${PHASE}, Test=${TEST_MODE}`);
  log(`Data dir: ${DATA_DIR}\n`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(METADATA_DIR, { recursive: true });

  if (PHASE === '1') {
    await phase1();
  } else if (PHASE === '2') {
    await phase2();
  } else {
    log('Invalid PHASE. Use PHASE=1 or PHASE=2');
  }
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
