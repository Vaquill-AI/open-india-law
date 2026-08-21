/**
 * RBI PDF Downloader - Phase 2 (Adaptive Throttle + Parallel Workers)
 *
 * Reads metadata JSONL from all RBI sections and downloads PDFs.
 * Supports parallel workers for faster downloads of static PDFs.
 * WAF detection pauses ALL workers globally if triggered.
 *
 * Usage:
 *   npx tsx scripts/rbi-pdf-downloader.ts
 *
 * Env vars:
 *   TYPE          — section name or "all" (default "all")
 *                   Sections: notifications, master_directions, circulars, fema,
 *                   master_circulars, speeches, bulletin, annual_reports,
 *                   vision_docs, press_releases, faqs
 *   RESUME        — "true" to skip already downloaded files (default true)
 *   BASE_DELAY_MS — base delay between downloads (default 3000, use 500 for fast)
 *   WORKERS       — parallel download workers (default 1, use 5 for fast)
 *   COOLDOWN_BATCH — downloads before cooldown (default 30, use 100 for fast)
 *   COOLDOWN_MS   — cooldown pause in ms (default 60000, use 10000 for fast)
 *   FAST          — "true" to auto-set fast defaults (500ms, 5 workers, etc.)
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const FAST = process.env.FAST === 'true';
const TYPE = process.env.TYPE || 'all';
const RESUME = process.env.RESUME !== 'false';
const WORKERS = parseInt(process.env.WORKERS || '1', 10);
const BASE_DELAY_MS = parseInt(process.env.BASE_DELAY_MS || (FAST ? '1500' : '3000'), 10);
const REQUEST_TIMEOUT_MS = 30000;
const PROGRESS_LOG_INTERVAL = 5;

// Adaptive throttle settings
const BACKOFF_DELAY_MS = 120_000; // 2 min pause when WAF detected
const MAX_CONSECUTIVE_FAILS = 3; // trigger backoff after 3 consecutive non-PDF responses
const COOLDOWN_BATCH_SIZE = parseInt(process.env.COOLDOWN_BATCH || (FAST ? '60' : '30'), 10);
const COOLDOWN_PAUSE_MS = parseInt(process.env.COOLDOWN_MS || (FAST ? '15000' : '60000'), 10);

// Global WAF pause — when any worker detects WAF, all workers pause
let globalWafPause = false;
let globalWafResumeAt = 0;

const BASE_DIR = path.join(process.cwd(), 'data', 'legal-sources', 'rbi');
const METADATA_DIR = path.join(BASE_DIR, 'metadata');
const PDF_DIR = path.join(BASE_DIR, 'pdfs');
const PROGRESS_FILE = path.join(PDF_DIR, 'download-progress.json');
const GENUINELY_FAILED_FILE = path.join(PDF_DIR, 'genuinely-failed.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RbiDocument {
  id: number | string;
  type: string; // notification, master_direction, circular, fema_notification, master_circular, speech, bulletin, annual_report, vision_document, press_release, faq
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

interface DownloadTask {
  doc: RbiDocument;
  outPath: string;
}

interface Stats {
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
  restricted: number;
  bytes: number;
  startTime: number;
  batchCount: number;
}

const stats: Stats = {
  total: 0,
  downloaded: 0,
  skipped: 0,
  failed: 0,
  restricted: 0,
  bytes: 0,
  startTime: Date.now(),
  batchCount: 0,
};

// ---------------------------------------------------------------------------
// HTTP download with WAF detection
// ---------------------------------------------------------------------------

type DownloadResult =
  | { status: 'ok'; size: number }
  | { status: 'restricted' } // 418 or genuinely restricted
  | { status: 'waf' } // F5 challenge page or empty body (rate limited)
  | { status: 'dead' } // 200 + 0 bytes (file removed)
  | { status: 'error'; message: string };

function downloadPdf(
  url: string,
  outPath: string,
  timeout = REQUEST_TIMEOUT_MS,
): Promise<DownloadResult> {
  const parsed = new URL(url);
  const getter = parsed.protocol === 'http:' ? http.get : https.get;

  return new Promise((resolve) => {
    const req = getter(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        timeout,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'application/pdf,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          Referer: 'https://rbi.org.in/Scripts/NotificationUser.aspx',
          Connection: 'keep-alive',
        },
      },
      (res) => {
        // Follow redirects
        if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          if (location) {
            const redirectUrl = location.startsWith('http')
              ? location
              : `${parsed.protocol}//${parsed.host}${location}`;
            res.resume();
            downloadPdf(redirectUrl, outPath, timeout).then(resolve);
            return;
          }
        }

        // 418 = "Unauthorised Access" (genuinely restricted)
        if (res.statusCode === 418) {
          res.resume();
          resolve({ status: 'restricted' });
          return;
        }

        // 403 = WAF block
        if (res.statusCode === 403) {
          res.resume();
          resolve({ status: 'waf' });
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          resolve({ status: 'error', message: `HTTP ${res.statusCode}` });
          return;
        }

        // Collect body to check if it's actually a PDF
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);

          // Empty body = dead file or WAF empty response
          if (body.length === 0) {
            resolve({ status: 'dead' });
            return;
          }

          // Check if it's actually a PDF (not an HTML challenge page)
          const isPdf = body.length > 4 && body.subarray(0, 4).toString() === '%PDF';
          if (!isPdf) {
            // It's an HTML page (F5 challenge or error)
            const isChallenge =
              body.toString('utf-8', 0, Math.min(500, body.length)).includes('bobcmn') ||
              body.toString('utf-8', 0, Math.min(500, body.length)).includes('Unauthorised');
            if (isChallenge || body.length > 10000) {
              resolve({ status: 'waf' });
            } else {
              resolve({ status: 'error', message: `Not PDF (${body.length}B)` });
            }
            return;
          }

          // Too small = error page saved as PDF
          if (body.length < 100) {
            resolve({ status: 'dead' });
            return;
          }

          // Valid PDF — write to disk
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, body);
          resolve({ status: 'ok', size: body.length });
        });

        res.on('error', (err) => {
          resolve({ status: 'error', message: err.message });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'error', message: 'timeout' });
    });
    req.on('error', (e) => {
      resolve({ status: 'error', message: e.message });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Load metadata
// ---------------------------------------------------------------------------

// Map of TYPE env var values to JSONL filenames
const SECTION_FILES: Record<string, string> = {
  notifications: 'notifications.jsonl',
  master_directions: 'master-directions.jsonl',
  circulars: 'circulars.jsonl',
  fema: 'fema-notifications.jsonl',
  master_circulars: 'master-circulars.jsonl',
  speeches: 'speeches.jsonl',
  bulletin: 'bulletin.jsonl',
  annual_reports: 'annual-reports.jsonl',
  vision_docs: 'vision-documents.jsonl',
  press_releases: 'press-releases.jsonl',
  faqs: 'faqs.jsonl',
};

function loadMetadata(): RbiDocument[] {
  const docs: RbiDocument[] = [];
  const files: string[] = [];

  if (TYPE === 'all') {
    files.push(...Object.values(SECTION_FILES));
  } else {
    const file = SECTION_FILES[TYPE];
    if (file) {
      files.push(file);
    } else {
      console.error(`Unknown TYPE: ${TYPE}. Valid: ${Object.keys(SECTION_FILES).join(', ')}, all`);
      process.exit(1);
    }
  }

  for (const file of files) {
    const fp = path.join(METADATA_DIR, file);
    if (!fs.existsSync(fp)) {
      console.log(`Skipping ${file} — not found`);
      continue;
    }
    const lines = fs
      .readFileSync(fp, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());

    let count = 0;
    for (const line of lines) {
      try {
        const doc = JSON.parse(line) as RbiDocument;
        if (doc.pdfUrl) {
          docs.push(doc);
          count++;
        }
      } catch {
        // skip invalid lines
      }
    }
    console.log(`  ${file}: ${count} docs with PDF URLs (${lines.length} total)`);
  }

  return docs;
}

// ---------------------------------------------------------------------------
// Output path
// ---------------------------------------------------------------------------

// Map document types to output subdirectory names
const TYPE_SUBDIRS: Record<string, string> = {
  notification: 'notifications',
  master_direction: 'master-directions',
  circular: 'circulars',
  fema_notification: 'fema-notifications',
  master_circular: 'master-circulars',
  speech: 'speeches',
  bulletin: 'bulletin',
  annual_report: 'annual-reports',
  vision_document: 'vision-documents',
  press_release: 'press-releases',
  faq: 'faqs',
};

function getOutputPath(doc: RbiDocument): string {
  let year = 'unknown';
  if (doc.date) {
    const yearMatch = doc.date.match(/\d{4}/);
    if (yearMatch) year = yearMatch[0];
  }

  const urlPath = new URL(doc.pdfUrl!).pathname;
  const filename = path.basename(urlPath);

  const subDir = TYPE_SUBDIRS[doc.type] || doc.type;

  return path.join(PDF_DIR, subDir, year, filename);
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

interface DownloadProgress {
  completed: string[];
  restricted: string[];
  dead: string[];
  failed: string[];
  startedAt: string;
  lastUpdatedAt: string;
}

function loadProgress(): DownloadProgress {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      return {
        completed: data.completed || [],
        restricted: data.restricted || [],
        dead: data.dead || [],
        failed: data.failed || [],
        startedAt: data.startedAt || new Date().toISOString(),
        lastUpdatedAt: data.lastUpdatedAt || new Date().toISOString(),
      };
    } catch {}
  }
  return {
    completed: [],
    restricted: [],
    dead: [],
    failed: [],
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(progress: DownloadProgress): void {
  progress.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function printStatus(delay: number): void {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const processed = stats.downloaded + stats.skipped + stats.failed + stats.restricted;
  const pct = ((processed / stats.total) * 100).toFixed(1);
  const mb = (stats.bytes / 1024 / 1024).toFixed(1);

  process.stdout.write(
    `\r[${pct}%] ${processed}/${stats.total} | ` +
      `dl=${stats.downloaded} skip=${stats.skipped} ` +
      `restricted=${stats.restricted} fail=${stats.failed} | ` +
      `${mb}MB | delay=${delay}ms | ` +
      `batch=${stats.batchCount}/${COOLDOWN_BATCH_SIZE}   `,
  );
}

// ---------------------------------------------------------------------------
// Queue for parallel workers
// ---------------------------------------------------------------------------

let taskQueue: DownloadTask[] = [];
let queueIndex = 0; // atomic-like index (safe in single-threaded Node.js)

function nextTask(): DownloadTask | null {
  if (queueIndex >= taskQueue.length) return null;
  return taskQueue[queueIndex++];
}

// ---------------------------------------------------------------------------
// Worker function — pulls tasks from shared queue
// ---------------------------------------------------------------------------

async function worker(
  workerId: number,
  progress: DownloadProgress,
  completedSet: Set<string>,
  restrictedSet: Set<string>,
  deadSet: Set<string>,
): Promise<void> {
  let consecutiveFails = 0;
  let currentDelay = BASE_DELAY_MS;

  while (true) {
    // Check for global WAF pause
    if (globalWafPause) {
      const waitMs = globalWafResumeAt - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      globalWafPause = false;
    }

    const task = nextTask();
    if (!task) break;

    const url = task.doc.pdfUrl!;

    // Skip already processed
    if (
      completedSet.has(url) ||
      restrictedSet.has(url) ||
      deadSet.has(url) ||
      (RESUME && fs.existsSync(task.outPath))
    ) {
      stats.skipped++;
      continue;
    }

    // Download
    const result = await downloadPdf(url, task.outPath);

    switch (result.status) {
      case 'ok':
        stats.downloaded++;
        stats.bytes += result.size;
        stats.batchCount++;
        progress.completed.push(url);
        completedSet.add(url);
        consecutiveFails = 0;
        currentDelay = BASE_DELAY_MS;
        break;

      case 'restricted':
        stats.restricted++;
        progress.restricted.push(url);
        restrictedSet.add(url);
        consecutiveFails = 0;
        break;

      case 'dead':
        stats.failed++;
        progress.dead.push(url);
        deadSet.add(url);
        consecutiveFails = 0;
        break;

      case 'waf':
        consecutiveFails++;
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          // Trigger global pause — all workers wait
          console.log(
            `\n[WAF] Worker ${workerId}: ${consecutiveFails} blocks. Global pause ${BACKOFF_DELAY_MS / 1000}s...`,
          );
          globalWafPause = true;
          globalWafResumeAt = Date.now() + BACKOFF_DELAY_MS;
          saveProgress(progress);
          await sleep(BACKOFF_DELAY_MS);
          consecutiveFails = 0;
          currentDelay = Math.min(currentDelay * 2, 15000);

          // Retry this URL
          const retryResult = await downloadPdf(url, task.outPath);
          if (retryResult.status === 'ok') {
            stats.downloaded++;
            stats.bytes += retryResult.size;
            stats.batchCount++;
            progress.completed.push(url);
            completedSet.add(url);
          } else if (retryResult.status === 'waf') {
            console.log(
              `\n[WAF] Worker ${workerId}: Still blocked. Extended pause ${(BACKOFF_DELAY_MS * 2) / 1000}s...`,
            );
            globalWafPause = true;
            globalWafResumeAt = Date.now() + BACKOFF_DELAY_MS * 2;
            await sleep(BACKOFF_DELAY_MS * 2);
            stats.failed++;
            progress.failed.push(url);
          } else if (retryResult.status === 'restricted') {
            stats.restricted++;
            progress.restricted.push(url);
            restrictedSet.add(url);
          } else {
            stats.failed++;
            progress.failed.push(url);
          }
        }
        break;

      case 'error':
        consecutiveFails++;
        stats.failed++;
        progress.failed.push(url);
        if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
          console.log(
            `\n[ERR] Worker ${workerId}: ${consecutiveFails} errors. Backing off ${BACKOFF_DELAY_MS / 1000}s...`,
          );
          saveProgress(progress);
          await sleep(BACKOFF_DELAY_MS);
          consecutiveFails = 0;
          currentDelay = Math.min(currentDelay * 2, 15000);
        }
        break;
    }

    // Progress logging
    const processed = stats.downloaded + stats.skipped + stats.failed + stats.restricted;
    if (processed % PROGRESS_LOG_INTERVAL === 0) {
      printStatus(currentDelay);
    }

    // Save progress periodically
    if (processed % 50 === 0) {
      saveProgress(progress);
    }

    // Proactive cooldown every N successful downloads (global)
    if (stats.batchCount >= COOLDOWN_BATCH_SIZE) {
      console.log(
        `\n[COOLDOWN] ${stats.batchCount} downloads. Pausing ${COOLDOWN_PAUSE_MS / 1000}s...`,
      );
      stats.batchCount = 0;
      saveProgress(progress);
      await sleep(COOLDOWN_PAUSE_MS);
    }

    // Delay between requests (per-worker)
    await sleep(currentDelay);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== RBI PDF Downloader (Phase 2 — Adaptive Throttle) ===');
  console.log(
    `Workers: ${WORKERS} | Delay: ${BASE_DELAY_MS}ms | Backoff: ${BACKOFF_DELAY_MS / 1000}s | Cooldown: ${COOLDOWN_BATCH_SIZE}/${COOLDOWN_PAUSE_MS / 1000}s`,
  );
  console.log(`Resume: ${RESUME} | Type: ${TYPE}${FAST ? ' | FAST MODE' : ''}`);
  console.log();

  const docs = loadMetadata();
  console.log(`Loaded ${docs.length} documents with PDF URLs`);

  if (docs.length === 0) {
    console.log('No documents to download. Run Phase 1 first.');
    return;
  }

  const tasks: DownloadTask[] = docs.map((doc) => ({
    doc,
    outPath: getOutputPath(doc),
  }));

  stats.total = tasks.length;

  const progress = loadProgress();
  const completedSet = new Set(progress.completed);
  const restrictedSet = new Set(progress.restricted);
  const deadSet = new Set(progress.dead);

  console.log(
    `Already: ${completedSet.size} downloaded, ${restrictedSet.size} restricted, ${deadSet.size} dead`,
  );

  // Ensure output dirs
  const dirs = new Set(tasks.map((t) => path.dirname(t.outPath)));
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Set up shared queue
  taskQueue = tasks;
  queueIndex = 0;

  // Launch workers
  const workerCount = Math.min(WORKERS, tasks.length);
  console.log(`Launching ${workerCount} worker(s)...\n`);

  const workers = Array.from({ length: workerCount }, (_, i) =>
    worker(i, progress, completedSet, restrictedSet, deadSet),
  );

  await Promise.all(workers);

  saveProgress(progress);

  console.log('\n\n=== Download Complete ===');
  console.log(`Downloaded: ${stats.downloaded}`);
  console.log(`Skipped (already done): ${stats.skipped}`);
  console.log(`Restricted (418): ${stats.restricted}`);
  console.log(`Dead/removed: ${progress.dead.length}`);
  console.log(`Failed (other): ${stats.failed}`);
  console.log(`Total size: ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Time: ${((Date.now() - stats.startTime) / 60000).toFixed(1)} minutes`);
}

main().catch(console.error);
