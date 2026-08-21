/**
 * ITAT PDF Bulk Downloader
 * Downloads PDFs from collected metadata in parallel.
 * Safe to run while the metadata scraper is still running.
 *
 * Usage:
 *   WORKERS=20 npx tsx scripts/itat-pdf-downloader.ts
 *   PROXY_URL=... WORKERS=30 npx tsx scripts/itat-pdf-downloader.ts
 *
 * Re-runnable: skips already-downloaded files.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

// --- Config ---
const JSONL_PATH = path.resolve('data/tribunals/itat/itat-orders.jsonl');
const PDF_DIR = path.resolve('data/tribunals/itat/pdfs');
const PROGRESS_PATH = path.resolve('data/tribunals/itat/pdf-download-progress.json');
const NUM_WORKERS = parseInt(process.env.WORKERS || '20', 10);
const PROXY_URL = process.env.PROXY_URL || '';
const TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;
const DELAY_MS = parseInt(process.env.DELAY_MS || '500', 10);

// --- Agents for keep-alive ---
const proxyAgent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL, { keepAlive: true }) : undefined;
const keepAliveHttpAgent = new http.Agent({ keepAlive: true });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true });

function getAgents(): {
  httpAgent?: http.Agent;
  httpsAgent?: https.Agent | HttpsProxyAgent;
} {
  if (proxyAgent)
    return {
      httpsAgent: proxyAgent,
      httpAgent: proxyAgent as unknown as http.Agent,
    };
  return { httpAgent: keepAliveHttpAgent, httpsAgent: keepAliveHttpsAgent };
}

// --- Progress tracking ---
let downloaded: Set<string> = new Set();
const failed: Map<string, string> = new Map();
const stats = { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };

function loadProgress(): void {
  if (fs.existsSync(PROGRESS_PATH)) {
    const data = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
    downloaded = new Set(data.downloaded || []);
    console.log(`[init] Loaded progress: ${downloaded.size} already downloaded`);
  }
}

function saveProgress(): void {
  fs.writeFileSync(
    PROGRESS_PATH,
    JSON.stringify({
      downloaded: [...downloaded],
      failed: Object.fromEntries(failed),
      stats,
      last_saved: new Date().toISOString(),
    }),
  );
}

// --- Read unique PDF URLs from JSONL ---
function loadPdfUrls(): Map<string, string> {
  const urlToFilename: Map<string, string> = new Map();
  const content = fs.readFileSync(JSONL_PATH, 'utf-8');

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const order = JSON.parse(line);
      const url = order.pdf_url;
      if (url && !urlToFilename.has(url)) {
        const filename = order.pdf_filename || path.basename(new URL(url).pathname);
        urlToFilename.set(url, filename);
      }
    } catch {
      // skip malformed lines
    }
  }

  return urlToFilename;
}

// --- Download a single PDF ---
async function downloadPdf(url: string, filename: string, retries = 0): Promise<boolean> {
  const filepath = path.join(PDF_DIR, filename);

  // Skip if already on disk
  if (fs.existsSync(filepath)) {
    stats.skipped++;
    downloaded.add(url);
    return true;
  }

  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: TIMEOUT_MS,
      ...getAgents(),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
      maxRedirects: 5,
    });

    const buffer = Buffer.from(resp.data);

    // Validate it's a PDF
    if (buffer.length < 100) {
      throw new Error(`Too small: ${buffer.length} bytes`);
    }

    fs.writeFileSync(filepath, buffer);
    stats.downloaded++;
    stats.bytes += buffer.length;
    downloaded.add(url);
    return true;
  } catch (err: any) {
    if (retries < MAX_RETRIES) {
      await sleep(1000 * (retries + 1));
      return downloadPdf(url, filename, retries + 1);
    }
    stats.failed++;
    failed.set(url, err.message || 'Unknown error');
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// --- Worker ---
async function worker(id: number, queue: Array<[string, string]>): Promise<void> {
  while (queue.length > 0) {
    const item = queue.pop();
    if (!item) break;

    const [url, filename] = item;
    if (downloaded.has(url)) {
      stats.skipped++;
      continue;
    }

    await downloadPdf(url, filename);
    await sleep(DELAY_MS);
  }
}

// --- Main ---
async function main(): Promise<void> {
  console.log('=== ITAT PDF Bulk Downloader ===');
  console.log(`Workers: ${NUM_WORKERS}`);
  console.log(`Proxy: ${PROXY_URL ? 'YES' : 'NO (direct)'}`);
  console.log(`Output: ${PDF_DIR}`);
  console.log('');

  // Ensure output dir
  fs.mkdirSync(PDF_DIR, { recursive: true });

  // Load progress
  loadProgress();

  // Load URLs
  const urlMap = loadPdfUrls();
  console.log(`[init] Total unique PDFs in JSONL: ${urlMap.size}`);

  // Filter out already downloaded
  const queue: Array<[string, string]> = [];
  for (const [url, filename] of urlMap) {
    if (!downloaded.has(url)) {
      const filepath = path.join(PDF_DIR, filename);
      if (!fs.existsSync(filepath)) {
        queue.push([url, filename]);
      } else {
        downloaded.add(url);
        stats.skipped++;
      }
    } else {
      stats.skipped++;
    }
  }

  console.log(`[init] To download: ${queue.length} | Already done: ${stats.skipped}`);
  console.log('');

  if (queue.length === 0) {
    console.log('Nothing to download!');
    return;
  }

  const startTime = Date.now();

  // Progress reporter
  const total = queue.length;
  const progressInterval = setInterval(() => {
    const elapsed = (Date.now() - startTime) / 1000;
    const done = stats.downloaded + stats.failed;
    const rate = done / elapsed;
    const remaining = total - done;
    const etaMin = remaining / rate / 60;
    console.log(
      `[progress] ${done}/${total} (${((done * 100) / total).toFixed(1)}%) | ` +
        `${formatBytes(stats.bytes)} | ${rate.toFixed(1)}/s | ` +
        `${stats.failed} failed | ETA: ${etaMin.toFixed(0)}min`,
    );
    // Save progress every 30s
    saveProgress();
  }, 15000);

  // Launch workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < NUM_WORKERS; i++) {
    workers.push(worker(i, queue));
  }

  await Promise.all(workers);
  clearInterval(progressInterval);

  // Final save
  saveProgress();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log('');
  console.log('=== COMPLETE ===');
  console.log(`Downloaded: ${stats.downloaded}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Total size: ${formatBytes(stats.bytes)}`);
  console.log(`Time: ${elapsed}s`);

  if (failed.size > 0) {
    console.log(`\nFailed URLs saved to ${PROGRESS_PATH}`);
  }
}

main().catch(console.error);
