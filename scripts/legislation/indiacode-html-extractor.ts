/**
 * IndiaCode HTML Section Extractor
 * Extracts structured section text from IndiaCode acts via SectionPageContent API.
 *
 * For each act:
 *   1. Fetch handle page → extract AC_ act ID + section IDs + labels
 *   2. Call /SectionPageContent for each section → { content, footnote }
 *   3. Save as JSON per act in data/indiacode/html/
 *
 * Output format per act:
 *   {
 *     actId, title, handle, acId,
 *     preamble: { content, footnote },
 *     sections: [{ sectionId, sectionNo, label, content, footnote }],
 *     schedules: [{ scheduleId, label, pdfUrl }],
 *     chapters: [{ chapterId, label }]
 *   }
 *
 * Usage:
 *   npx tsx scripts/indiacode-html-extractor.ts
 *   npx tsx scripts/indiacode-html-extractor.ts --test          # 5 acts only
 *   npx tsx scripts/indiacode-html-extractor.ts --workers 30    # concurrency
 *   npx tsx scripts/indiacode-html-extractor.ts --category central
 *   npx tsx scripts/indiacode-html-extractor.ts --resume        # skip already done
 */

import * as https from 'https';

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = 'https://www.indiacode.nic.in';
const DATA_DIR = path.resolve(__dirname, '../data/indiacode');
const INDEX_DIR = path.join(DATA_DIR, 'index');
const HTML_DIR = path.join(DATA_DIR, 'html');
const PROGRESS_FILE = path.join(DATA_DIR, 'html-extract-progress.json');

const WORKERS = parseInt(process.env.WORKERS || '30', 10);
const TEST_MODE = process.argv.includes('--test');
const RESUME = process.argv.includes('--resume') || !process.argv.includes('--fresh');
const CATEGORY_FILTER = (() => {
  const idx = process.argv.indexOf('--category');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();
const MAX_ACTS = parseInt(process.env.MAX_ACTS || '0', 10) || (TEST_MODE ? 5 : 0);

// Proxy (optional — use --no-proxy for direct connection)
const NO_PROXY = process.argv.includes('--no-proxy');
const PROXY_USER = process.env.DATAIMPULSE_USERNAME || '';
const PROXY_PASS = process.env.DATAIMPULSE_PASSWORD || '';
const PROXY_HOST = 'gw.dataimpulse.com';
const PROXY_PORT = 823;
const PROXY_URL = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;

const SECTION_DELAY_MS = NO_PROXY ? 10 : 30; // delay between section API calls
const ACT_DELAY_MS = NO_PROXY ? 20 : 50; // delay between acts per worker
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 20000;
const PROGRESS_LOG_INTERVAL = 25;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActEntry {
  actId: string;
  title: string;
  handle: string;
  sourceUrl: string;
  category: string;
  year: string;
}

interface SectionInfo {
  sectionId: string;
  sectionNo: string;
  label: string;
  type: 'section' | 'preamble' | 'heading' | 'schedule';
}

interface SectionContent {
  sectionId: string;
  sectionNo: string;
  label: string;
  type: string;
  content: string;
  footnote: string;
}

interface ActHtml {
  actId: string;
  acId: string; // AC_CEN_... format
  title: string;
  handle: string;
  extractedAt: string;
  sectionCount: number;
  sections: SectionContent[];
  schedules: { scheduleId: string; label: string; pdfUrl: string }[];
}

interface Progress {
  totalActs: number;
  completed: number;
  failed: number;
  skipped: number;
  completedHandles: string[];
  failedHandles: string[];
  startedAt: string;
  lastUpdatedAt: string;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const stats = {
  actsProcessed: 0,
  actsSucceeded: 0,
  actsFailed: 0,
  actsSkipped: 0,
  sectionsExtracted: 0,
  totalActs: 0,
  startTime: Date.now(),
  proxySuccess: 0,
  proxyFail: 0,
};

// ---------------------------------------------------------------------------
// HTTP fetch (direct or via proxy)
// ---------------------------------------------------------------------------

function fetchUrl(
  url: string,
  opts: { timeout?: number; json?: boolean } = {},
): Promise<{ status: number; body: string }> {
  const timeout = opts.timeout || REQUEST_TIMEOUT_MS;
  const parsed = new URL(url);
  const agent = NO_PROXY ? undefined : new HttpsProxyAgent(PROXY_URL);

  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        ...(agent ? { agent } : {}),
        timeout,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: opts.json
            ? 'application/json, text/plain, */*'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: BASE_URL + '/',
          'X-Requested-With': opts.json ? 'XMLHttpRequest' : '',
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
            fetchUrl(redirectUrl, opts).then(resolve).catch(reject);
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
      reject(new Error(`Timeout after ${timeout}ms: ${url}`));
    });
    req.on('error', reject);
  });
}

async function fetchWithRetry(
  url: string,
  opts: { timeout?: number; json?: boolean } = {},
  retries = MAX_RETRIES,
): Promise<{ status: number; body: string }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await fetchUrl(url, opts);
      if (result.status === 200) {
        stats.proxySuccess++;
        return result;
      }
      if (result.status === 403 || result.status === 429) {
        // Proxy got blocked, retry with delay
        stats.proxyFail++;
        if (attempt < retries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
      }
      return result;
    } catch (err) {
      stats.proxyFail++;
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
// Parse act page HTML → extract AC_ID + section list
// ---------------------------------------------------------------------------

function parseActPage(html: string): {
  acId: string;
  sections: SectionInfo[];
  schedules: { scheduleId: string; label: string; pdfUrl: string }[];
} {
  const sections: SectionInfo[] = [];
  const schedules: { scheduleId: string; label: string; pdfUrl: string }[] = [];
  let acId = '';

  // Extract AC_ ID from the preamble or first section link
  // Pattern: id="AC_CEN_..._..." class="preambletitle"
  const preambleMatch = html.match(/id="(AC_[A-Z0-9_]+)"\s+class="preambletitle"/);
  if (preambleMatch) {
    acId = preambleMatch[1];
    sections.push({
      sectionId: 'preamble',
      sectionNo: '0',
      label: 'Preamble',
      type: 'preamble',
    });
  }

  // Extract sections — pattern:
  // <a id="AC_ID#sectionId#AC_ID" class="title" ... href=...sectionId=XXXX&sectionno=Y...>
  //   <span class="label label-default"> Section N.</span>&nbsp; Section Title </a>
  const sectionRegex =
    /id="(AC_[A-Z0-9_]+)#(\d+)#(?:AC_[A-Z0-9_]+)"\s+class="title"\s+[^>]*href=[^>]*sectionno=(\d+)[^>]*>\s*<span[^>]*class="label label-default">\s*Section\s+(\S+?)\s*<\/span>\s*(?:&nbsp;)?\s*([^<]*?)\s*<\/a>/gi;

  let match;
  while ((match = sectionRegex.exec(html)) !== null) {
    if (!acId) acId = match[1];
    sections.push({
      sectionId: match[2],
      sectionNo: match[4].replace('.', ''),
      label: match[5].trim(),
      type: 'section',
    });
  }

  // Also try simpler pattern if regex above misses some
  // <span ... class="aaa secbtn sectionTitle" ... href="#collapseXXXXX">
  if (sections.length <= 1) {
    // Only preamble found, try broader pattern
    const broadRegex =
      /id="(AC_[A-Z0-9_]+)#(\d+)#[^"]*"\s+class="title"[^>]*>[^]*?Section\s+(\S+?)\.\s*<\/span>\s*(?:&nbsp;)?\s*([^<]*?)\s*<\/a>/gi;

    while ((match = broadRegex.exec(html)) !== null) {
      if (!acId) acId = match[1];
      const secId = match[2];
      // Avoid duplicates
      if (!sections.find((s) => s.sectionId === secId)) {
        sections.push({
          sectionId: secId,
          sectionNo: match[3].replace('.', ''),
          label: match[4].trim(),
          type: 'section',
        });
      }
    }
  }

  // Extract chapter headings
  // <a id="AC_ID#chId#orgId#AC_ID" class="headingtwo">
  const headingRegex = /id="(AC_[A-Z0-9_]+)#(\d+)#(\d+)#(?:AC_[A-Z0-9_]+)"\s+class="headingtwo"/gi;
  while ((match = headingRegex.exec(html)) !== null) {
    if (!acId) acId = match[1];
  }

  // Extract schedules
  // <a id="AC_ID#schedId" class="schedulebtnzain" ... > Schedule N. TITLE </a>
  // PDF: href="https://upload.indiacode.nic.in/schedulefile?aid=AC_ID&rid=schedId"
  const scheduleRegex =
    /id="(AC_[A-Z0-9_]+)#(\d+)"\s+class="schedulebtnzain[^"]*"[^>]*>\s*<span[^>]*>\s*Schedule\s+(\d+)\.\s*<\/span>\s*(?:&nbsp;)?\s*([^<]*?)\s*<\/a>/gi;

  while ((match = scheduleRegex.exec(html)) !== null) {
    if (!acId) acId = match[1];
    schedules.push({
      scheduleId: match[2],
      label: `Schedule ${match[3]}. ${match[4].trim()}`,
      pdfUrl: `https://upload.indiacode.nic.in/schedulefile?aid=${match[1]}&rid=${match[2]}`,
    });
  }

  // If still no acId, try any AC_ pattern in the page
  if (!acId) {
    const anyAc = html.match(/id="(AC_[A-Z0-9_]+?)(?:#|\s|")/);
    if (anyAc) acId = anyAc[1];
  }

  return { acId, sections, schedules };
}

// ---------------------------------------------------------------------------
// Fetch section content from API
// ---------------------------------------------------------------------------

async function fetchSectionContent(
  acId: string,
  sectionId: string,
): Promise<{ content: string; footnote: string } | null> {
  const url = `${BASE_URL}/SectionPageContent?actid=${encodeURIComponent(acId)}&sectionID=${encodeURIComponent(sectionId)}`;

  try {
    const resp = await fetchWithRetry(url, { json: true, timeout: 15000 });
    if (resp.status !== 200) return null;

    try {
      const data = JSON.parse(resp.body);
      if (data.content || data.footnote) {
        return {
          content: data.content || '',
          footnote: data.footnote || '',
        };
      }
      return null; // empty {} response
    } catch {
      // Not JSON, might be HTML error page
      return null;
    }
  } catch {
    return null;
  }
}

async function fetchPreamble(acId: string): Promise<{ content: string; footnote: string } | null> {
  // Preamble uses the actId directly as the sectionID in some cases,
  // or a special preamble endpoint
  const url = `${BASE_URL}/SectionPageContent?actid=${encodeURIComponent(acId)}&sectionID=preamble`;

  try {
    const resp = await fetchWithRetry(url, { json: true, timeout: 15000 });
    if (resp.status === 200) {
      try {
        const data = JSON.parse(resp.body);
        if (data.content || data.footnote) {
          return { content: data.content || '', footnote: data.footnote || '' };
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ---------------------------------------------------------------------------
// Process a single act
// ---------------------------------------------------------------------------

async function processAct(entry: ActEntry): Promise<boolean> {
  const handle = entry.handle;
  if (!handle) return false;

  const outFile = path.join(HTML_DIR, entry.category, `${handle.replace(/\//g, '_')}.json`);

  // 1. Fetch act page
  const pageUrl = `${BASE_URL}/handle/${handle}?view_type=browse&locale=en`;
  let pageResp;
  try {
    pageResp = await fetchWithRetry(pageUrl, { timeout: 30000 });
  } catch (err) {
    return false;
  }

  if (pageResp.status !== 200) return false;

  // 2. Parse sections
  const { acId, sections, schedules } = parseActPage(pageResp.body);

  if (!acId) {
    // No AC_ ID found — act page may have no sections (e.g. repealed/empty)
    // Save minimal record
    const minimal: ActHtml = {
      actId: entry.actId,
      acId: '',
      title: entry.title,
      handle,
      extractedAt: new Date().toISOString(),
      sectionCount: 0,
      sections: [],
      schedules: [],
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(minimal, null, 2));
    return true;
  }

  // 3. Fetch content for each section
  const sectionContents: SectionContent[] = [];

  for (const sec of sections) {
    let content: { content: string; footnote: string } | null = null;

    if (sec.type === 'preamble') {
      content = await fetchPreamble(acId);
    } else {
      content = await fetchSectionContent(acId, sec.sectionId);
    }

    if (content) {
      sectionContents.push({
        sectionId: sec.sectionId,
        sectionNo: sec.sectionNo,
        label: sec.label,
        type: sec.type,
        content: content.content,
        footnote: content.footnote,
      });
      stats.sectionsExtracted++;
    }

    if (SECTION_DELAY_MS > 0) await sleep(SECTION_DELAY_MS);
  }

  // 4. Save result
  const result: ActHtml = {
    actId: entry.actId,
    acId,
    title: entry.title,
    handle,
    extractedAt: new Date().toISOString(),
    sectionCount: sectionContents.length,
    sections: sectionContents,
    schedules,
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
// Load index
// ---------------------------------------------------------------------------

function loadIndex(): ActEntry[] {
  const entries: ActEntry[] = [];

  const files = fs.readdirSync(INDEX_DIR).filter((f) => f.endsWith('.jsonl'));

  for (const file of files) {
    const category = file.replace('.jsonl', '');

    if (CATEGORY_FILTER && !category.includes(CATEGORY_FILTER)) continue;
    // Skip repealed and spent — they don't have handle pages with sections
    if (category === 'repealed' || category === 'spent') continue;

    const lines = fs
      .readFileSync(path.join(INDEX_DIR, file), 'utf-8')
      .split('\n')
      .filter((l) => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ActEntry;
        if (entry.handle) {
          entries.push({ ...entry, category });
        }
      } catch {
        // skip invalid lines
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Progress management
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    } catch {
      // corrupted, start fresh
    }
  }
  return {
    totalActs: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    completedHandles: [],
    failedHandles: [],
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function printStatus(): void {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const speed = stats.actsProcessed / (elapsed / 60);
  const remaining = stats.totalActs - stats.actsProcessed;
  const eta = speed > 0 ? remaining / speed : 0;
  const etaStr =
    eta > 60 ? `${Math.floor(eta / 60)}h ${Math.round(eta % 60)}m` : `${Math.round(eta)}m`;

  const pct = ((stats.actsProcessed / stats.totalActs) * 100).toFixed(1);

  process.stdout.write(
    `\r[${pct}%] ${stats.actsProcessed}/${stats.totalActs} | ` +
      `ok=${stats.actsSucceeded} fail=${stats.actsFailed} skip=${stats.actsSkipped} | ` +
      `sections=${stats.sectionsExtracted} | ` +
      `speed=${speed.toFixed(1)}/min | ETA=${etaStr} | ` +
      `proxy=${stats.proxySuccess}ok/${stats.proxyFail}err`,
  );
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

async function worker(
  queue: ActEntry[],
  progress: Progress,
  completedSet: Set<string>,
): Promise<void> {
  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) break;

    const handle = entry.handle;

    // Skip if already done
    if (completedSet.has(handle)) {
      stats.actsSkipped++;
      stats.actsProcessed++;
      if (stats.actsProcessed % PROGRESS_LOG_INTERVAL === 0) printStatus();
      continue;
    }

    try {
      const success = await processAct(entry);
      stats.actsProcessed++;

      if (success) {
        stats.actsSucceeded++;
        if (!completedSet.has(handle)) {
          progress.completed++;
          progress.completedHandles.push(handle);
          completedSet.add(handle);
        }
      } else {
        stats.actsFailed++;
        progress.failed++;
        progress.failedHandles.push(handle);
      }
    } catch (err) {
      stats.actsProcessed++;
      stats.actsFailed++;
      progress.failed++;
      progress.failedHandles.push(handle);
    }

    if (stats.actsProcessed % PROGRESS_LOG_INTERVAL === 0) {
      printStatus();
      saveProgress(progress);
    }

    if (ACT_DELAY_MS > 0) await sleep(ACT_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== IndiaCode HTML Section Extractor ===');
  console.log(
    `Workers: ${WORKERS} | ${NO_PROXY ? 'DIRECT (no proxy)' : `Proxy: ${PROXY_HOST}:${PROXY_PORT}`}`,
  );
  console.log(`Test mode: ${TEST_MODE} | Resume: ${RESUME}`);
  if (CATEGORY_FILTER) console.log(`Category filter: ${CATEGORY_FILTER}`);
  console.log();

  // Ensure directories
  fs.mkdirSync(HTML_DIR, { recursive: true });

  // Load index
  let entries = loadIndex();
  console.log(`Loaded ${entries.length} acts from index (excl repealed/spent)`);

  // Sort by handle desc (newer acts first — more likely to have sections)
  entries.sort((a, b) => {
    const ha = parseInt(a.handle.split('/').pop() || '0', 10);
    const hb = parseInt(b.handle.split('/').pop() || '0', 10);
    return hb - ha;
  });

  if (MAX_ACTS > 0) {
    entries = entries.slice(0, MAX_ACTS);
    console.log(`Limited to ${MAX_ACTS} acts`);
  }

  // Load progress
  const progress = loadProgress();
  const completedSet = new Set(progress.completedHandles);

  if (RESUME && completedSet.size > 0) {
    console.log(`Resuming: ${completedSet.size} acts already completed`);
  }

  stats.totalActs = entries.length;
  progress.totalActs = entries.length;

  console.log(`Starting extraction of ${entries.length} acts with ${WORKERS} workers...`);
  console.log();

  // Create worker queue
  const queue = [...entries];

  // Launch workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < WORKERS; i++) {
    workers.push(worker(queue, progress, completedSet));
  }

  // Progress save interval
  const saveInterval = setInterval(() => saveProgress(progress), 15000);

  await Promise.all(workers);

  clearInterval(saveInterval);
  saveProgress(progress);

  console.log();
  console.log('=== Extraction Complete ===');
  console.log(`Total: ${stats.actsProcessed}`);
  console.log(`Succeeded: ${stats.actsSucceeded}`);
  console.log(`Failed: ${stats.actsFailed}`);
  console.log(`Skipped: ${stats.actsSkipped}`);
  console.log(`Sections extracted: ${stats.sectionsExtracted}`);
  console.log(`Time: ${((Date.now() - stats.startTime) / 60000).toFixed(1)} minutes`);
}

main().catch(console.error);
