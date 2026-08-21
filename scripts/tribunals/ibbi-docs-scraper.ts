/**
 * IBBI Documents Scraper
 * Downloads all non-order documents from ibbi.gov.in:
 * Legal Framework, Research, Publications, Press Releases, etc.
 *
 * Usage:
 *   npx tsx scripts/ibbi-docs-scraper.ts
 *   npx tsx scripts/ibbi-docs-scraper.ts --category regulations
 *   npx tsx scripts/ibbi-docs-scraper.ts --dry-run
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import pLimit from 'p-limit';
import crypto from 'crypto';

// ─── Config ────────────────────────────────────────────────────
const BASE_URL = 'https://ibbi.gov.in';
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'tribunals', 'ibbi', 'documents');
const PROGRESS_FILE = path.join(
  process.cwd(),
  'data',
  'tribunals',
  'ibbi',
  'docs-scrape-progress.json',
);
const LOG_FILE = path.join(process.cwd(), 'data', 'tribunals', 'ibbi', 'docs-download.log');
const MAX_CONCURRENT = 15;
const REQUEST_TIMEOUT = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_CATEGORY = process.argv.find((a, i) => process.argv[i - 1] === '--category') || '';

// ─── Categories ────────────────────────────────────────────────
interface CategoryDef {
  slug: string;
  name: string;
  url: string;
  totalPages: number; // estimated, will be auto-detected
  linkPattern: 'newwindow' | 'href' | 'both';
  uploadPrefix?: string; // filter to only include links matching this prefix
}

const CATEGORIES: CategoryDef[] = [
  // Legal Framework (Critical)
  {
    slug: 'regulations',
    name: 'Regulations',
    url: '/legal-framework/updated',
    totalPages: 7,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/legalframwork',
  },
  {
    slug: 'circulars',
    name: 'Circulars',
    url: '/legal-framework/circulars',
    totalPages: 5,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/legalframwork',
  },
  {
    slug: 'guidelines',
    name: 'Guidelines',
    url: '/legal-framework/guidelines',
    totalPages: 3,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/legalframwork',
  },
  {
    slug: 'act',
    name: 'Act',
    url: '/legal-framework/act',
    totalPages: 2,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/legalframwork',
  },
  {
    slug: 'rules',
    name: 'Rules',
    url: '/legal-framework/rules',
    totalPages: 2,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/legalframwork',
  },
  {
    slug: 'notifications',
    name: 'Notifications',
    url: '/legal-framework/notifications',
    totalPages: 5,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/',
  },
  {
    slug: 'other-authorities',
    name: 'By Other Authorities',
    url: '/legal-framework/other-authorities',
    totalPages: 3,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/',
  },
  // Facilitation (landmark judgments + jurisprudence)
  {
    slug: 'facilitation',
    name: 'Facilitation',
    url: '/legal-framework/facilitation',
    totalPages: 5,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/',
  },
  // Research & Analysis
  {
    slug: 'discussion-papers',
    name: 'Discussion Papers',
    url: '/public-comments/comments-on',
    totalPages: 3,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/public_comments',
  },
  {
    slug: 'reports',
    name: 'Reports',
    url: '/resources/reports',
    totalPages: 3,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/resources',
  },
  {
    slug: 'articles',
    name: 'Articles',
    url: '/resources/articles',
    totalPages: 5,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/resources',
  },
  {
    slug: 'speeches',
    name: 'Speeches',
    url: '/resources/speeches',
    totalPages: 2,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/resources',
  },
  // Publications
  {
    slug: 'newsletters',
    name: 'Quarterly Newsletters',
    url: '/publication',
    totalPages: 2,
    linkPattern: 'both',
    uploadPrefix: '/uploads/publication',
  },
  {
    slug: 'annual-reports',
    name: 'Annual Reports',
    url: '/publication/reports',
    totalPages: 2,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/publication',
  },
  // Press & Notices
  {
    slug: 'press-releases',
    name: 'Press Releases',
    url: '/media/press-releases',
    totalPages: 15,
    linkPattern: 'newwindow',
    uploadPrefix: '/uploads/press',
  },
  // What's New (resolution plan approvals + misc)
  {
    slug: 'whats-new',
    name: "What's New",
    url: '/whats-new',
    totalPages: 109,
    linkPattern: 'href',
    uploadPrefix: '/uploads/',
  },
  // Downloads (forms/templates)
  {
    slug: 'downloads',
    name: 'Forms & Templates',
    url: '/home/downloads',
    totalPages: 1,
    linkPattern: 'href',
    uploadPrefix: '/uploads/downloads',
  },
];

// ─── Progress ──────────────────────────────────────────────────
interface Progress {
  completed: Record<string, string[]>; // category -> downloaded filenames
  stats: {
    totalDiscovered: number;
    totalDownloaded: number;
    totalFailed: number;
    startedAt: string;
    lastUpdatedAt: string;
  };
}

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    completed: {},
    stats: {
      totalDiscovered: 0,
      totalDownloaded: 0,
      totalFailed: 0,
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
    },
  };
}

function saveProgress(progress: Progress): void {
  progress.stats.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ─── Logging ───────────────────────────────────────────────────
let logStream: fs.WriteStream;

function log(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  logStream?.write(line + '\n');
}

function logError(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ERROR: ${msg}`;
  console.error(line);
  logStream?.write(line + '\n');
}

// ─── HTTP Helpers ──────────────────────────────────────────────
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
    const client = fullUrl.startsWith('https') ? https : http;

    const req = client.get(
      fullUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        // Follow redirects
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          fetchPage(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${fullUrl}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout for ${fullUrl}`));
    });
  });
}

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
    const client = fullUrl.startsWith('https') ? https : http;

    const req = client.get(
      fullUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          downloadFile(res.headers.location, destPath).then(resolve);
          return;
        }
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }
        const ws = fs.createWriteStream(destPath);
        res.pipe(ws);
        ws.on('finish', () => {
          ws.close();
          resolve(true);
        });
        ws.on('error', () => resolve(false));
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function downloadWithRetry(url: string, destPath: string): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ok = await downloadFile(url, destPath);
    if (ok) {
      try {
        const stat = fs.statSync(destPath);
        if (stat.size > 100) return true;
        fs.unlinkSync(destPath);
      } catch {
        // File doesn't exist - retry
      }
    }
    if (attempt < MAX_RETRIES) await delay(RETRY_DELAY_MS * attempt);
  }
  return false;
}

// ─── Link Extraction ───────────────────────────────────────────
function extractPdfLinks(
  html: string,
  pattern: 'newwindow' | 'href' | 'both',
  uploadPrefix?: string,
): string[] {
  const links = new Set<string>();

  if (pattern === 'newwindow' || pattern === 'both') {
    // Match newwindow1('URL') - handles both HTML entities and regular quotes
    const decoded = html.replace(/&#039;/g, "'").replace(/&amp;/g, '&');
    const newwindowRegex = /newwindow1\('([^']+\.(pdf|xlsx|docx|doc))'\)/g;
    let match;
    while ((match = newwindowRegex.exec(decoded)) !== null) {
      links.add(match[1]);
    }
  }

  if (pattern === 'href' || pattern === 'both') {
    // Match href="/uploads/..." links
    const hrefRegex = /href="([^"]*\/uploads\/[^"]*\.(pdf|xlsx|docx|doc)[^"]*)"/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      links.add(match[1]);
    }
  }

  // Normalize and filter
  return Array.from(links)
    .map((url) => {
      // Remove double slashes (//uploads -> /uploads)
      let normalized = url.replace(/([^:])\/\//g, '$1/');
      // Make relative if full URL
      if (normalized.startsWith(BASE_URL)) {
        normalized = normalized.replace(BASE_URL, '');
      }
      return normalized;
    })
    .filter((url) => {
      // Filter by upload prefix if specified
      if (uploadPrefix && !url.includes(uploadPrefix.replace(/^\//, ''))) {
        return false;
      }
      // Skip common header/footer assets
      if (url.includes('/homepage/') || url.includes('/structure/')) {
        return false;
      }
      return true;
    });
}

function detectTotalPages(html: string): number {
  // Look for pagination: "?page=N" patterns
  const pageRegex = /\?page=(\d+)/g;
  let maxPage = 1;
  let match;
  while ((match = pageRegex.exec(html)) !== null) {
    const page = parseInt(match[1]);
    if (page > maxPage) maxPage = page;
  }
  return maxPage;
}

// ─── Filename from URL ─────────────────────────────────────────
function urlToFilename(url: string): string {
  // Extract the last path segment
  const parts = url.split('/');
  let filename = parts[parts.length - 1];

  // URL decode
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // leave as is
  }

  // Sanitize for filesystem
  filename = filename.replace(/[<>:"|?*]/g, '_').replace(/\s+/g, '_');

  // If filename is too long, hash it
  if (filename.length > 200) {
    const ext = path.extname(filename);
    const hash = crypto.createHash('md5').update(url).digest('hex');
    filename = hash + ext;
  }

  return filename;
}

// ─── Category Scraper ──────────────────────────────────────────
async function scrapeCategory(
  cat: CategoryDef,
  progress: Progress,
): Promise<{ discovered: number; downloaded: number; failed: number }> {
  const categoryDir = path.join(OUTPUT_DIR, cat.slug);
  fs.mkdirSync(categoryDir, { recursive: true });

  const completedSet = new Set(progress.completed[cat.slug] || []);
  const allLinks: string[] = [];

  // Phase 1: Discover all PDF links across all pages
  log(`  [${cat.name}] Scanning pages for PDF links...`);

  // Fetch first page to detect actual total pages
  let firstPageHtml: string;
  try {
    firstPageHtml = await fetchPage(cat.url);
  } catch (err) {
    logError(`  [${cat.name}] Failed to fetch first page: ${err}`);
    return { discovered: 0, downloaded: 0, failed: 0 };
  }

  const actualPages = Math.max(detectTotalPages(firstPageHtml), 1);
  const totalPages = Math.min(actualPages, cat.totalPages + 5); // safety cap

  // Extract from first page
  const firstLinks = extractPdfLinks(firstPageHtml, cat.linkPattern, cat.uploadPrefix);
  allLinks.push(...firstLinks);

  // Fetch remaining pages
  if (totalPages > 1) {
    for (let page = 1; page < totalPages; page++) {
      const pageUrl = `${cat.url}?page=${page}`;
      try {
        await delay(300); // gentle delay between pages
        const html = await fetchPage(pageUrl);
        const links = extractPdfLinks(html, cat.linkPattern, cat.uploadPrefix);
        allLinks.push(...links);
      } catch (err) {
        logError(`  [${cat.name}] Failed page ${page}: ${err}`);
      }
    }
  }

  // Deduplicate
  const uniqueLinks = [...new Set(allLinks)];
  const toDownload = uniqueLinks.filter((url) => {
    const filename = urlToFilename(url);
    return !completedSet.has(filename);
  });

  log(
    `  [${cat.name}] Found ${uniqueLinks.length} unique PDFs (${toDownload.length} new, ${completedSet.size} already done)`,
  );

  if (DRY_RUN) {
    log(`  [${cat.name}] DRY RUN - would download ${toDownload.length} files`);
    // Save link list for reference
    const linksFile = path.join(categoryDir, '_links.txt');
    fs.writeFileSync(linksFile, uniqueLinks.join('\n'));
    return { discovered: uniqueLinks.length, downloaded: 0, failed: 0 };
  }

  if (toDownload.length === 0) {
    return { discovered: uniqueLinks.length, downloaded: 0, failed: 0 };
  }

  // Phase 2: Download PDFs
  const limit = pLimit(MAX_CONCURRENT);
  let downloaded = 0;
  let failed = 0;
  const startTime = Date.now();
  let lastLogTime = Date.now();

  const tasks = toDownload.map((url) =>
    limit(async () => {
      const filename = urlToFilename(url);
      const destPath = path.join(categoryDir, filename);

      const ok = await downloadWithRetry(url, destPath);
      if (ok) {
        downloaded++;
        completedSet.add(filename);
      } else {
        failed++;
        logError(`  [${cat.name}] Failed: ${filename}`);
      }

      const now = Date.now();
      if (now - lastLogTime > 5000 || (downloaded + failed) % 50 === 0) {
        lastLogTime = now;
        const elapsed = (now - startTime) / 1000;
        const rate = downloaded > 0 ? (downloaded / elapsed).toFixed(1) : '0';
        const remaining = toDownload.length - downloaded - failed;

        // Save progress periodically
        progress.completed[cat.slug] = Array.from(completedSet);
        saveProgress(progress);

        log(
          `  [${cat.name}] ${downloaded}/${toDownload.length} | ${rate}/s | ${failed} failed | ${remaining} remaining`,
        );
      }
    }),
  );

  await Promise.all(tasks);

  // Final save
  progress.completed[cat.slug] = Array.from(completedSet);
  saveProgress(progress);

  return { discovered: uniqueLinks.length, downloaded, failed };
}

// ─── Main ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

  const progress = loadProgress();
  if (!progress.stats.startedAt) {
    progress.stats.startedAt = new Date().toISOString();
  }

  const categories = ONLY_CATEGORY
    ? CATEGORIES.filter((c) => c.slug === ONLY_CATEGORY)
    : CATEGORIES;

  if (categories.length === 0) {
    log(`Unknown category: ${ONLY_CATEGORY}`);
    log(`Available: ${CATEGORIES.map((c) => c.slug).join(', ')}`);
    process.exit(1);
  }

  log('=== IBBI Documents Scraper ===');
  log(`Categories: ${categories.map((c) => c.name).join(', ')}`);
  log(`Output: ${OUTPUT_DIR}`);
  log(`Concurrent: ${MAX_CONCURRENT}`);
  if (DRY_RUN) log('MODE: DRY RUN (discovery only)');
  log('');

  const grandTotal = { discovered: 0, downloaded: 0, failed: 0 };

  for (const cat of categories) {
    log(`--- ${cat.name} ---`);
    const result = await scrapeCategory(cat, progress);
    grandTotal.discovered += result.discovered;
    grandTotal.downloaded += result.downloaded;
    grandTotal.failed += result.failed;
    log(
      `  ${cat.name} done: ${result.discovered} found, ${result.downloaded} downloaded, ${result.failed} failed`,
    );
    log('');
  }

  // Update stats
  progress.stats.totalDiscovered += grandTotal.discovered;
  progress.stats.totalDownloaded += grandTotal.downloaded;
  progress.stats.totalFailed += grandTotal.failed;
  saveProgress(progress);

  log('=== Summary ===');
  log(`Discovered: ${grandTotal.discovered}`);
  log(`Downloaded: ${grandTotal.downloaded}`);
  log(`Failed: ${grandTotal.failed}`);
  log('');

  // Print per-category stats
  for (const cat of categories) {
    const dir = path.join(OUTPUT_DIR, cat.slug);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => !f.startsWith('_'));
      const size = files.reduce((sum, f) => {
        try {
          return sum + fs.statSync(path.join(dir, f)).size;
        } catch {
          return sum;
        }
      }, 0);
      log(`  ${cat.name}: ${files.length} files, ${(size / 1024 / 1024).toFixed(1)} MB`);
    }
  }

  log(`\nProgress saved to: ${PROGRESS_FILE}`);
  logStream.end();
}

// Handle SIGINT
process.on('SIGINT', () => {
  log('\nInterrupted - saving progress...');
  process.exit(0);
});

main().catch((err) => {
  logError(`Fatal: ${err}`);
  process.exit(1);
});
