/**
 * RBI Metadata Scraper - Phase 1
 *
 * Collects rich metadata from rbi.org.in by enumerating document IDs.
 * No proxy needed — RBI has no WAF/CDN blocking.
 *
 * Content types:
 *   1. Notifications/Circulars  — NotificationUser.aspx?Id={1..14000}
 *   2. Master Directions        — BS_ViewMasDirections.aspx?id={known IDs from listing}
 *   3. Press Releases            — BS_PressReleaseDisplay.aspx?prid={1..63000}  (optional)
 *
 * Usage:
 *   npx tsx scripts/rbi-metadata-scraper.ts
 *
 * Env vars:
 *   WORKERS          — concurrent workers (default 30)
 *   TYPE             — "notifications" | "master_directions" | "press_releases" | "all" (default "all")
 *   START_ID         — start from this ID (for resume)
 *   END_ID           — stop at this ID
 *   TEST_MODE        — "true" to limit to 50 IDs
 *   DELAY_MS         — ms between requests per worker (default 30)
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORKERS = parseInt(process.env.WORKERS || '30', 10);
const TYPE = process.env.TYPE || 'all';
const TEST_MODE = process.env.TEST_MODE === 'true';
const DELAY_MS = parseInt(process.env.DELAY_MS || '30', 10);
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const PROGRESS_LOG_INTERVAL = 50;

const BASE_URL = 'https://rbi.org.in';
const DATA_DIR = path.join(process.cwd(), 'data', 'legal-sources', 'rbi', 'metadata');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');

// ID ranges
const NOTIFICATION_START = parseInt(process.env.START_ID || '1', 10);
const NOTIFICATION_END = parseInt(process.env.END_ID || '14000', 10);

// Known Master Direction IDs (extracted from listing page)
const MASTER_DIRECTION_IDS = [
  10190, 10191, 10192, 10193, 10196, 10197, 10198, 10201, 10202, 10203, 10204, 10205, 10395, 10404,
  10476, 10477, 10485, 10495, 10519, 10520, 10620, 10621, 10622, 10637, 10738, 10833, 10868, 10999,
  11037, 11060, 11148, 11200, 11322, 11327, 11328, 11394, 11395, 11510, 11518, 11620, 11621, 11959,
  12032, 12055, 12056, 12061, 12108, 12156, 12163, 12226, 12269, 12270, 12328, 12427, 12479, 12480,
  12481, 12482, 12483, 12562, 12586, 12592, 12613, 12616, 12645, 12646, 12648, 12653, 12682, 12702,
  12703, 12704, 12710, 12715, 12742, 12765, 12777, 12799, 12809, 12810, 12814, 12818, 12839, 12843,
  12870, 12896, 12898, 12920, 12925, 12926, 12927, 12928, 12929, 12930, 12931, 12932, 12933, 12934,
  12935, 12936, 12937, 12938, 12939, 12940, 12941, 12942, 12943, 12944, 12945, 12946, 12947, 12948,
  12949, 12950, 12951, 12952, 12953, 12954, 12955, 12956, 12957, 12958, 12959, 12960, 12961, 12962,
  12963, 12964, 12965, 12966, 12967, 12968, 12969, 12970, 12971, 12972, 12973, 12974, 12975, 12976,
  12977, 12978, 12979, 12980, 12981, 12982, 12983, 12984, 12986, 12987, 12988, 12989, 12990, 12991,
  12992, 12993, 12994, 12995, 12996, 12997, 12998, 12999, 13000, 13001, 13002, 13003, 13004, 13005,
  13006, 13007, 13008, 13010, 13011, 13012, 13013, 13014, 13015, 13016, 13017, 13018, 13019, 13020,
  13021, 13022, 13023, 13024, 13025, 13026, 13027, 13028, 13029, 13030, 13031, 13032, 13033, 13034,
  13036, 13038, 13039, 13040, 13041, 13042, 13043, 13044, 13045, 13046, 13047, 13048, 13049, 13050,
  13051, 13052, 13053, 13054, 13055, 13056, 13057, 13058, 13059, 13060, 13061, 13062, 13063, 13064,
  13065, 13066, 13067, 13068, 13069, 13070, 13071, 13072, 13073, 13074, 13075, 13076, 13077, 13078,
  13079, 13080, 13081, 13082, 13083, 13084, 13085, 13086, 13087, 13088, 13089, 13090, 13091, 13092,
  13093, 13094, 13095, 13096, 13097, 13098, 13099, 13100, 13101, 13102, 13103, 13104, 13105, 13106,
  13107, 13108, 13109, 13110, 13111, 13112, 13113, 13114, 13115, 13116, 13117, 13118, 13119, 13120,
  13121, 13122, 13123, 13124, 13125, 13126, 13127, 13128, 13129, 13130, 13131, 13132, 13133, 13134,
  13135, 13136, 13137, 13138, 13139, 13140, 13141, 13142, 13143, 13144, 13145, 13146, 13147, 13148,
  13149, 13150, 13151, 13152, 13153, 13154, 13155, 13156, 13157, 13158, 13159, 13160, 13161, 13162,
  13163, 13164, 13165, 13166, 13167, 13168, 13202, 13203, 13204, 13205, 13214, 13271, 13272, 13273,
  13274, 13275, 13276,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RbiDocument {
  id: number;
  type: 'notification' | 'master_direction' | 'press_release';
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
  scrapedAt: string;
}

interface Progress {
  notifications: { lastId: number; found: number; scanned: number };
  masterDirections: { completed: number; total: number };
  pressReleases: { lastId: number; found: number; scanned: number };
  startedAt: string;
  lastUpdatedAt: string;
}

interface Stats {
  totalScanned: number;
  found: number;
  empty: number;
  errors: number;
  startTime: number;
}

const stats: Stats = {
  totalScanned: 0,
  found: 0,
  empty: 0,
  errors: 0,
  startTime: Date.now(),
};

// ---------------------------------------------------------------------------
// HTTP fetch (no proxy needed for RBI)
// ---------------------------------------------------------------------------

function fetchUrl(
  url: string,
  timeout = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: string }> {
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        timeout,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          if (location) {
            const redirectUrl = location.startsWith('http')
              ? location
              : `${parsed.protocol}//${parsed.host}${location}`;
            fetchUrl(redirectUrl, timeout).then(resolve).catch(reject);
            return;
          }
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout: ${url}`));
    });
    req.on('error', reject);
  });
}

async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES,
): Promise<{ status: number; body: string }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fetchUrl(url);
      return result;
    } catch (err) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed after ${retries} attempts: ${url}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTML Parsers
// ---------------------------------------------------------------------------

function parseNotificationPage(html: string, id: number): RbiDocument | null {
  // Detection: valid notification pages have class="tablebg" tables
  if (!html.includes('class="tablebg"')) return null;

  // Title: inside <b> tag within tableheader after PDF link
  const titleMatch = html.match(/class="tableheader"><b>([^<]+)<\/b>/);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  if (!title) return null;

  // PDF URL
  const pdfMatch = html.match(/href="(https:\/\/rbidocs\.rbi\.org\.in\/rdocs\/[^"]+\.PDF)"/i);
  const pdfUrl = pdfMatch ? pdfMatch[1] : null;

  // PDF size
  const pdfSizeMatch = html.match(/aria-hidden="true">([^<]+)<\/span>\)<\/td>/);
  const pdfSize = pdfSizeMatch ? pdfSizeMatch[1].trim() : null;

  // Reference number: e.g., RBI/2025-26/220
  const refMatch = html.match(/<p>(RBI\/[^<]+?)<br/);
  const refNumber = refMatch ? decodeHtmlEntities(refMatch[1].trim()) : '';

  // Department code: line after ref number
  const deptMatch = html.match(/RBI\/[^<]+<br>\s*([A-Z][A-Z0-9\.\/\(\)\-\s]+?)(?:<\/p>|<br)/);
  const department = deptMatch ? decodeHtmlEntities(deptMatch[1].trim()) : '';

  // Date: right-aligned paragraph
  const dateMatch = html.match(/align="right">\s*([A-Z][a-z]+ \d{1,2},? \d{4})/);
  const date = dateMatch ? dateMatch[1].trim() : '';

  // Signatory
  const sigMatch = html.match(
    /\(([A-Z][a-zA-Z\s\.]+)\)<br>\s*([A-Z][a-zA-Z\s\-]+(?:Manager|Director|Governor|Officer|Chief|Secretary)[a-zA-Z\s\-]*)/,
  );
  const signatory = sigMatch ? `${sigMatch[1].trim()}, ${sigMatch[2].trim()}` : null;

  return {
    id,
    type: 'notification',
    title,
    date,
    refNumber,
    department,
    pdfUrl,
    pdfSize,
    htmlUrl: `${BASE_URL}/Scripts/NotificationUser.aspx?Id=${id}&Mode=0`,
    country: 'IN',
    source: 'RBI',
    signatory,
    scrapedAt: new Date().toISOString(),
  };
}

function parseMasterDirectionPage(html: string, id: number): RbiDocument | null {
  if (!html.includes('class="tablebg"')) return null;

  // Title
  const titleMatch = html.match(/class="tableheader"><b>([^<]+)<\/b>/);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  if (!title) return null;

  // PDF URL
  const pdfMatch = html.match(/href="(https:\/\/rbidocs\.rbi\.org\.in\/rdocs\/[^"]+\.PDF)"/i);
  const pdfUrl = pdfMatch ? pdfMatch[1] : null;

  // PDF size
  const pdfSizeMatch = html.match(/aria-hidden="true">([^<]+)<\/span>\)<\/td>/);
  const pdfSize = pdfSizeMatch ? pdfSizeMatch[1].trim() : null;

  // Ref number
  const refMatch = html.match(/<p>(RBI\/[^<]+?)<br/);
  const refNumber = refMatch ? decodeHtmlEntities(refMatch[1].trim()) : '';

  // Department
  const deptMatch = html.match(/RBI\/[^<]+<br>\s*([A-Z][A-Z0-9\.\/\(\)\-\s]+?)(?:<\/p>|<br)/);
  const department = deptMatch ? decodeHtmlEntities(deptMatch[1].trim()) : '';

  // Date
  const dateMatch = html.match(/align="right">\s*([A-Z][a-z]+ \d{1,2},? \d{4})/);
  const date = dateMatch ? dateMatch[1].trim() : '';

  // Signatory
  const sigMatch = html.match(
    /\(([A-Z][a-zA-Z\s\.]+)\)<br>\s*([A-Z][a-zA-Z\s\-]+(?:Manager|Director|Governor|Officer|Chief|Secretary)[a-zA-Z\s\-]*)/,
  );
  const signatory = sigMatch ? `${sigMatch[1].trim()}, ${sigMatch[2].trim()}` : null;

  return {
    id,
    type: 'master_direction',
    title,
    date,
    refNumber,
    department,
    pdfUrl,
    pdfSize,
    htmlUrl: `${BASE_URL}/Scripts/BS_ViewMasDirections.aspx?id=${id}`,
    country: 'IN',
    source: 'RBI',
    signatory,
    scrapedAt: new Date().toISOString(),
  };
}

function parsePressReleasePage(html: string, id: number): RbiDocument | null {
  // Press releases have a different structure
  // Check for content presence
  if (!html.includes('class="tablebg"') && !html.includes('class="tableheader"')) {
    // Some press releases use different markup
    if (!html.includes('Press Releases') || html.length < 15000) return null;
  }

  // Title from page
  const titleMatch =
    html.match(/class="tableheader"><b>([^<]+)<\/b>/) ||
    html.match(/<title>([^<]+) - Reserve Bank/);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  if (!title || title === 'Press Releases') return null;

  // PDF
  const pdfMatch = html.match(/href="(https:\/\/rbidocs\.rbi\.org\.in\/rdocs\/[^"]+\.PDF)"/i);
  const pdfUrl = pdfMatch ? pdfMatch[1] : null;

  const pdfSizeMatch = html.match(/aria-hidden="true">([^<]+)<\/span>\)/);
  const pdfSize = pdfSizeMatch ? pdfSizeMatch[1].trim() : null;

  // Date
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

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

// ---------------------------------------------------------------------------
// Progress management
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    } catch {
      // corrupted
    }
  }
  return {
    notifications: { lastId: 0, found: 0, scanned: 0 },
    masterDirections: { completed: 0, total: MASTER_DIRECTION_IDS.length },
    pressReleases: { lastId: 0, found: 0, scanned: 0 },
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// JSONL writer (append mode, thread-safe via sync writes)
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
  const pct = ((current / total) * 100).toFixed(1);
  const remaining = total - current;
  const eta = speed > 0 ? remaining / speed : 0;
  const etaStr =
    eta > 60 ? `${Math.floor(eta / 60)}h ${Math.round(eta % 60)}m` : `${Math.round(eta)}m`;

  process.stdout.write(
    `\r[${label}] ${pct}% ${current}/${total} | ` +
      `found=${stats.found} empty=${stats.empty} err=${stats.errors} | ` +
      `speed=${speed.toFixed(0)}/min | ETA=${etaStr}   `,
  );
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

interface Task {
  id: number;
  type: 'notification' | 'master_direction' | 'press_release';
}

async function worker(
  queue: Task[],
  outputFiles: Record<string, string>,
  totalTasks: number,
  label: string,
): Promise<void> {
  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) break;

    try {
      let url: string;
      let parser: (html: string, id: number) => RbiDocument | null;

      switch (task.type) {
        case 'notification':
          url = `${BASE_URL}/Scripts/NotificationUser.aspx?Id=${task.id}&Mode=0`;
          parser = parseNotificationPage;
          break;
        case 'master_direction':
          url = `${BASE_URL}/Scripts/BS_ViewMasDirections.aspx?id=${task.id}`;
          parser = parseMasterDirectionPage;
          break;
        case 'press_release':
          url = `${BASE_URL}/Scripts/BS_PressReleaseDisplay.aspx?prid=${task.id}`;
          parser = parsePressReleasePage;
          break;
      }

      const resp = await fetchWithRetry(url);
      stats.totalScanned++;

      if (resp.status === 200) {
        const doc = parser(resp.body, task.id);
        if (doc) {
          stats.found++;
          appendJsonl(outputFiles[task.type], doc);
        } else {
          stats.empty++;
        }
      } else {
        stats.empty++;
      }
    } catch (err) {
      stats.totalScanned++;
      stats.errors++;
    }

    if (stats.totalScanned % PROGRESS_LOG_INTERVAL === 0) {
      printStatus(label, stats.totalScanned, totalTasks);
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// Scrape functions
// ---------------------------------------------------------------------------

async function scrapeNotifications(progress: Progress): Promise<void> {
  const startId =
    progress.notifications.lastId > 0 ? progress.notifications.lastId + 1 : NOTIFICATION_START;
  const endId = TEST_MODE ? Math.min(startId + 49, NOTIFICATION_END) : NOTIFICATION_END;

  const outputFile = path.join(DATA_DIR, 'notifications.jsonl');
  const tasks: Task[] = [];

  for (let id = startId; id <= endId; id++) {
    tasks.push({ id, type: 'notification' });
  }

  console.log(
    `\nScraping notifications: IDs ${startId}→${endId} (${tasks.length} tasks, ${WORKERS} workers)`,
  );

  stats.totalScanned = 0;
  stats.found = 0;
  stats.empty = 0;
  stats.errors = 0;
  stats.startTime = Date.now();

  const workers: Promise<void>[] = [];
  for (let i = 0; i < WORKERS; i++) {
    workers.push(worker(tasks, { notification: outputFile }, endId - startId + 1, 'Notifications'));
  }

  const saveInterval = setInterval(() => {
    progress.notifications.lastId = startId + stats.totalScanned - 1;
    progress.notifications.found += 0; // will update at end
    progress.notifications.scanned = stats.totalScanned;
    saveProgress(progress);
  }, 10000);

  await Promise.all(workers);
  clearInterval(saveInterval);

  progress.notifications.lastId = endId;
  progress.notifications.found = stats.found;
  progress.notifications.scanned = stats.totalScanned;
  saveProgress(progress);

  console.log(
    `\n✓ Notifications: scanned=${stats.totalScanned} found=${stats.found} empty=${stats.empty} errors=${stats.errors} (${((Date.now() - stats.startTime) / 60000).toFixed(1)} min)`,
  );
}

async function scrapeMasterDirections(progress: Progress): Promise<void> {
  const outputFile = path.join(DATA_DIR, 'master-directions.jsonl');
  const tasks: Task[] = MASTER_DIRECTION_IDS.map((id) => ({
    id,
    type: 'master_direction' as const,
  }));

  if (TEST_MODE) tasks.splice(10);

  console.log(`\nScraping Master Directions: ${tasks.length} known IDs (${WORKERS} workers)`);

  stats.totalScanned = 0;
  stats.found = 0;
  stats.empty = 0;
  stats.errors = 0;
  stats.startTime = Date.now();

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(WORKERS, tasks.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      worker(tasks, { master_direction: outputFile }, MASTER_DIRECTION_IDS.length, 'MasterDir'),
    );
  }

  await Promise.all(workers);

  progress.masterDirections.completed = stats.found;
  saveProgress(progress);

  console.log(
    `\n✓ Master Directions: scanned=${stats.totalScanned} found=${stats.found} empty=${stats.empty} errors=${stats.errors} (${((Date.now() - stats.startTime) / 60000).toFixed(1)} min)`,
  );
}

async function scrapePressReleases(progress: Progress): Promise<void> {
  // Press releases have IDs up to ~62000+. This is a large range.
  // Start from last known ID or 1
  const startId = progress.pressReleases.lastId > 0 ? progress.pressReleases.lastId + 1 : 1;
  const endId = TEST_MODE ? Math.min(startId + 49, 63000) : 63000;

  const outputFile = path.join(DATA_DIR, 'press-releases.jsonl');
  const tasks: Task[] = [];

  for (let id = startId; id <= endId; id++) {
    tasks.push({ id, type: 'press_release' });
  }

  console.log(
    `\nScraping press releases: IDs ${startId}→${endId} (${tasks.length} tasks, ${WORKERS} workers)`,
  );

  stats.totalScanned = 0;
  stats.found = 0;
  stats.empty = 0;
  stats.errors = 0;
  stats.startTime = Date.now();

  const workers: Promise<void>[] = [];
  for (let i = 0; i < WORKERS; i++) {
    workers.push(worker(tasks, { press_release: outputFile }, endId - startId + 1, 'PressRel'));
  }

  const saveInterval = setInterval(() => {
    progress.pressReleases.lastId = startId + stats.totalScanned - 1;
    progress.pressReleases.scanned = stats.totalScanned;
    saveProgress(progress);
  }, 10000);

  await Promise.all(workers);
  clearInterval(saveInterval);

  progress.pressReleases.lastId = endId;
  progress.pressReleases.found = stats.found;
  progress.pressReleases.scanned = stats.totalScanned;
  saveProgress(progress);

  console.log(
    `\n✓ Press Releases: scanned=${stats.totalScanned} found=${stats.found} empty=${stats.empty} errors=${stats.errors} (${((Date.now() - stats.startTime) / 60000).toFixed(1)} min)`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== RBI Metadata Scraper (Phase 1) ===');
  console.log(`Workers: ${WORKERS} | Delay: ${DELAY_MS}ms | Type: ${TYPE}`);
  console.log(`Test mode: ${TEST_MODE}`);
  console.log();

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const progress = loadProgress();

  if (TYPE === 'all' || TYPE === 'master_directions') {
    await scrapeMasterDirections(progress);
  }

  if (TYPE === 'all' || TYPE === 'notifications') {
    await scrapeNotifications(progress);
  }

  if (TYPE === 'press_releases') {
    await scrapePressReleases(progress);
  }

  console.log('\n=== Scraping Complete ===');

  // Final stats
  for (const file of ['notifications.jsonl', 'master-directions.jsonl', 'press-releases.jsonl']) {
    const fp = path.join(DATA_DIR, file);
    if (fs.existsSync(fp)) {
      const lines = fs
        .readFileSync(fp, 'utf-8')
        .split('\n')
        .filter((l) => l.trim()).length;
      console.log(`  ${file}: ${lines} documents`);
    }
  }
}

main().catch(console.error);
