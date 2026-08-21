/**
 * DRT/DRAT Scraper - Debt Recovery Tribunal / Debt Recovery Appellate Tribunal
 * Scrapes orders from https://drt.gov.in via the drtapi JSON REST API
 *
 * Architecture:
 *   - 44 tribunals: 39 DRTs (IDs 1-44) + 5 DRATs (IDs 100-104)
 *   - JSON REST API at https://drt.gov.in/drtapi/ (multipart/form-data POST)
 *   - No CAPTCHA, no auth, no rate limiting detected
 *   - PDFs via https://cis.drt.gov.in/drtlive/order/secure-pdf-serve.php
 *
 * Strategy:
 *   Phase 1 (DRAT): Date-range search via getDratOrderJudgementReportFromToDate
 *   Phase 2 (DRT):  Iterate case numbers per tribunal/caseType/year
 *   Phase 3: Download PDFs
 *
 * Usage:
 *   npx tsx scripts/drt-scraper.ts                          # Full run
 *   npx tsx scripts/drt-scraper.ts --test                   # Test (1 tribunal, 1 month)
 *   npx tsx scripts/drt-scraper.ts --metadata-only          # No PDF download
 *   npx tsx scripts/drt-scraper.ts --download-only          # PDFs only (requires metadata)
 *   npx tsx scripts/drt-scraper.ts --drat-only              # Only DRAT tribunals
 *   npx tsx scripts/drt-scraper.ts --drt-only               # Only DRT tribunals
 *   npx tsx scripts/drt-scraper.ts --tribunal 1             # Single tribunal by ID
 *   npx tsx scripts/drt-scraper.ts --year 2024              # Single year
 *   npx tsx scripts/drt-scraper.ts --start-year 2023        # Start from year
 *   npx tsx scripts/drt-scraper.ts --download-only --finals-only  # Download only final judgments (skip daily orders)
 *
 * Environment:
 *   WORKERS=10             Concurrent metadata workers (default: 10)
 *   PDF_WORKERS=10         Concurrent PDF downloads (default: 10)
 *   DELAY_MS=150           Delay between API requests in ms (default: 150)
 *   MAX_EMPTY=20           Stop iterating case numbers after N consecutive empties (default: 20)
 *   DATA_DIR=data/drt      Output directory (default: data/drt)
 */

import axios, { AxiosInstance } from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const DRT_API_BASE = 'https://drt.gov.in/drtapi';
const PDF_BASE_URL = 'https://cis.drt.gov.in/drtlive/order/secure-pdf-serve.php';

const WORKERS = parseInt(process.env.WORKERS || '10', 10);
const PDF_WORKERS = parseInt(process.env.PDF_WORKERS || '10', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '150', 10);
const MAX_EMPTY = parseInt(process.env.MAX_EMPTY || '20', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const DATA_DIR = process.env.DATA_DIR || 'data/tribunals/drt';
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const PROGRESS_FILE = path.join(DATA_DIR, 'scrape-progress.json');
const JSONL_FILE = path.join(DATA_DIR, 'drt-all-orders.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'pdfs-downloaded.txt');

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;

function setupShutdownHandler(progress: Progress): void {
  const handler = () => {
    if (shuttingDown) {
      log('Force exit');
      process.exit(1);
    }
    shuttingDown = true;
    log('Shutting down gracefully... (press Ctrl+C again to force)');
    saveProgress(progress);
    log(`Progress saved: ${progress.total_orders} orders, ${progress.total_pdfs} PDFs`);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

// ─── Tribunal Registry ──────────────────────────────────────────────────────

interface Tribunal {
  id: number;
  name: string;
  slug: string;
  type: 'DRT' | 'DRAT';
}

let TRIBUNALS: Tribunal[] = [];

const CASE_TYPES = [
  { id: 1, name: 'Original Application (OA)' },
  { id: 2, name: 'Review Application' },
  { id: 3, name: 'Misc Application' },
  { id: 4, name: 'Appeal' },
  { id: 5, name: 'URA' },
  { id: 6, name: 'Transfer Application' },
  { id: 7, name: 'Securitization Application' },
  { id: 8, name: 'AIR' },
  { id: 10, name: 'Counter Claim' },
  { id: 13, name: 'Execution' },
  { id: 14, name: 'Chamber Appeal' },
  { id: 100, name: 'IBC-C' },
  { id: 101, name: 'IBC-A' },
];

const PRIMARY_CASE_TYPES = [1, 7, 13, 4, 3, 2, 5, 6, 8, 10, 14, 100, 101];

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrderRecord {
  tribunal_id: number;
  tribunal_name: string;
  tribunal_type: 'DRT' | 'DRAT';
  order_type: 'daily' | 'final';
  case_number: string;
  diary_number: string;
  date_of_filing: string;
  applicant_name: string;
  respondent_name: string;
  pronounced_by: string;
  pdf_url: string;
  pdf_filename: string;
  item_no: string;
  case_type_id?: number;
  case_type_name?: string;
  case_year?: number;
  source: string;
  tribunal: string;
  country: string;
  scraped_at: string;
}

interface Progress {
  drat_completed: string[];
  drt_completed: string[];
  total_orders: number;
  total_pdfs: number;
  last_updated: string;
}

// Runtime sets for O(1) lookups (not serialized to JSON)
let dratCompletedSet: Set<string>;
let drtCompletedSet: Set<string>;
let pdfsDoneSet: Set<string>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(text: string, maxLen = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen);
}

function ensureDirs(): void {
  for (const dir of [DATA_DIR, METADATA_DIR, PDFS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadProgress(): Progress {
  if (fs.existsSync(PROGRESS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    // Migrate: drop pdfs_downloaded array if present (now tracked in separate file)
    const { pdfs_downloaded: _dropped, ...rest } = raw;
    return rest as Progress;
  }
  return {
    drat_completed: [],
    drt_completed: [],
    total_orders: 0,
    total_pdfs: 0,
    last_updated: new Date().toISOString(),
  };
}

function initSets(progress: Progress): void {
  dratCompletedSet = new Set(progress.drat_completed);
  drtCompletedSet = new Set(progress.drt_completed);

  // Load PDF done tracking from separate file (one filename per line)
  pdfsDoneSet = new Set<string>();
  if (fs.existsSync(PDF_DONE_FILE)) {
    const content = fs.readFileSync(PDF_DONE_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      if (line) pdfsDoneSet.add(line);
    }
  }
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function markDratComplete(progress: Progress, key: string): void {
  if (!dratCompletedSet.has(key)) {
    dratCompletedSet.add(key);
    progress.drat_completed.push(key);
  }
}

function markDrtComplete(progress: Progress, key: string): void {
  if (!drtCompletedSet.has(key)) {
    drtCompletedSet.add(key);
    progress.drt_completed.push(key);
  }
}

function markPdfDone(filename: string): void {
  if (!pdfsDoneSet.has(filename)) {
    pdfsDoneSet.add(filename);
    fs.appendFileSync(PDF_DONE_FILE, filename + '\n');
  }
}

/**
 * Transform API PDF URL to direct download URL.
 * API returns: https://cis.drt.gov.in/drtlive/order/qrpdfview.php?file=<base64>
 * Direct:     https://cis.drt.gov.in/drtlive/order/secure-pdf-serve.php?file=<base64>
 *
 * The base64 param often contains a `***<item_no>#<n>#<schema>` suffix
 * that must be stripped. Example decoded:
 *   drat/daily_order/2025/January/xxxx.pdf***46270#1#delhidrat
 */
function getDirectPdfUrl(apiPdfUrl: string): string {
  if (!apiPdfUrl) return '';
  try {
    let fileParam: string | null = null;

    try {
      const url = new URL(apiPdfUrl);
      fileParam = url.searchParams.get('file');
    } catch {
      const match = apiPdfUrl.match(/[?&]file=([^&]+)/);
      if (match) fileParam = match[1];
    }

    if (!fileParam) return apiPdfUrl;

    const decoded = Buffer.from(fileParam, 'base64').toString('utf-8');
    const cleanPath = decoded.split('***')[0];
    const cleanBase64 = Buffer.from(cleanPath).toString('base64');

    return `${PDF_BASE_URL}?file=${cleanBase64}`;
  } catch {
    return apiPdfUrl;
  }
}

function generatePdfFilename(order: OrderRecord): string {
  const caseSlug = slugify(order.case_number || order.diary_number, 40);
  const parts = [
    order.tribunal_type.toLowerCase(),
    String(order.tribunal_id),
    order.order_type,
    caseSlug,
    order.item_no || '',
  ].filter(Boolean);

  let base = parts.join('_');

  // Add a hash suffix from pdf_url to prevent collisions when item_no is empty
  if (order.pdf_url) {
    const hash = Buffer.from(order.pdf_url).toString('base64').slice(-8).replace(/[/+=]/g, 'x');
    base += `_${hash}`;
  }

  return `${base}.pdf`;
}

// ─── JSONL Writer (fd-based, no open/close per write) ────────────────────────

let jsonlFd: number | null = null;

function openJsonlWriter(): void {
  jsonlFd = fs.openSync(JSONL_FILE, 'a');
}

function appendToJsonl(orders: OrderRecord[]): void {
  if (jsonlFd === null) return;
  const lines = orders.map((o) => JSON.stringify(o)).join('\n') + '\n';
  fs.writeSync(jsonlFd, lines);
}

function closeJsonlWriter(): void {
  if (jsonlFd !== null) {
    fs.closeSync(jsonlFd);
    jsonlFd = null;
  }
}

// ─── API Client ──────────────────────────────────────────────────────────────

function createApiClient(): AxiosInstance {
  return axios.create({
    baseURL: DRT_API_BASE,
    timeout: 30000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://drt.gov.in',
      Referer: 'https://drt.gov.in/',
    },
  });
}

async function apiPost(
  client: AxiosInstance,
  endpoint: string,
  params: Record<string, string | number>,
  retries = MAX_RETRIES,
): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const formData = new FormData();
      for (const [key, value] of Object.entries(params)) {
        formData.append(key, String(value));
      }

      const resp = await client.post(endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      return resp.data;
    } catch (err) {
      if (attempt < retries) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`API ${endpoint} attempt ${attempt + 1}: ${msg}`);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      } else {
        throw err;
      }
    }
  }
  throw new Error(`API ${endpoint} failed after ${retries} retries`);
}

// ─── Phase 0: Fetch Tribunal Registry ────────────────────────────────────────

async function fetchTribunals(client: AxiosInstance): Promise<Tribunal[]> {
  log('Fetching tribunal registry...');
  const data = (await apiPost(client, 'getDrtDratScheamName', {})) as Array<{
    SchemaName: string;
    schemeNameDrtId: number;
  }>;

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Failed to fetch tribunal list from API');
  }

  const tribunals: Tribunal[] = data.map((t) => ({
    id: t.schemeNameDrtId,
    name: t.SchemaName,
    slug: slugify(t.SchemaName),
    type: t.schemeNameDrtId >= 100 ? 'DRAT' : 'DRT',
  }));

  log(
    `Found ${tribunals.length} tribunals (${tribunals.filter((t) => t.type === 'DRAT').length} DRATs, ${tribunals.filter((t) => t.type === 'DRT').length} DRTs)`,
  );

  fs.writeFileSync(
    path.join(DATA_DIR, 'tribunal-registry.json'),
    JSON.stringify(tribunals, null, 2),
  );

  return tribunals;
}

// ─── Phase 1: DRAT Orders (Date-Range Search) ───────────────────────────────

interface DratMonthTask {
  tribunalId: number;
  tribunalName: string;
  orderTypeId: number;
  orderTypeName: string;
  year: number;
  month: number;
  progressKey: string;
}

function generateDratTasks(drats: Tribunal[], startYear: number, endYear: number): DratMonthTask[] {
  const tasks: DratMonthTask[] = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  for (const drat of drats) {
    for (const orderType of [
      { id: 1, name: 'daily' },
      { id: 2, name: 'final' },
    ]) {
      for (let year = startYear; year >= endYear; year--) {
        const maxMonth = year === currentYear ? currentMonth : 12;
        for (let month = 1; month <= maxMonth; month++) {
          const key = `${drat.id}|${orderType.name}|${String(month).padStart(2, '0')}/${year}`;
          if (!dratCompletedSet.has(key)) {
            tasks.push({
              tribunalId: drat.id,
              tribunalName: drat.name,
              orderTypeId: orderType.id,
              orderTypeName: orderType.name,
              year,
              month,
              progressKey: key,
            });
          }
        }
      }
    }
  }

  return tasks;
}

async function scrapeDratMonth(client: AxiosInstance, task: DratMonthTask): Promise<OrderRecord[]> {
  const lastDay = new Date(task.year, task.month, 0).getDate();
  const fromDate = `01/${String(task.month).padStart(2, '0')}/${task.year}`;
  const toDate = `${lastDay}/${String(task.month).padStart(2, '0')}/${task.year}`;

  const data = await apiPost(client, 'getDratOrderJudgementReportFromToDate', {
    schemeNameDrtId: task.tribunalId,
    dratDailyFinalOrderId: task.orderTypeId,
    fromDate,
    toDate,
  });

  if (!data || (typeof data === 'object' && 'status' in (data as Record<string, unknown>))) {
    return [];
  }

  if (!Array.isArray(data)) {
    return [];
  }

  return (data as Array<Record<string, string>>).map((item) => {
    const rawPdfUrl = item.dailyOrderPdf || item.DratOrderPdf || '';
    const directPdfUrl = getDirectPdfUrl(rawPdfUrl);

    const record: OrderRecord = {
      tribunal_id: task.tribunalId,
      tribunal_name: task.tribunalName,
      tribunal_type: 'DRAT',
      order_type: task.orderTypeName as 'daily' | 'final',
      case_number: item.applicantno || item.caseNo || '',
      diary_number: item.diaryno || '',
      date_of_filing: item.dateoffiling || item.orderDate || '',
      applicant_name: item.applicantName || item.Applicant || '',
      respondent_name: item.respondentName || item.Respondent || '',
      pronounced_by: item.pronouncedBy || item.PronounceBy || '',
      pdf_url: directPdfUrl,
      pdf_filename: '',
      item_no: item.item_no || item.ItemNo || '',
      source: `drtapi/getDratOrderJudgementReportFromToDate`,
      tribunal: 'DRT',
      country: 'IN',
      scraped_at: new Date().toISOString(),
    };
    record.pdf_filename = generatePdfFilename(record);
    return record;
  });
}

async function scrapeDratOrders(
  client: AxiosInstance,
  drats: Tribunal[],
  startYear: number,
  endYear: number,
  progress: Progress,
  testMode: boolean,
): Promise<number> {
  const allTasks = generateDratTasks(drats, startYear, endYear);
  const tasks = testMode ? allTasks.slice(0, 2) : allTasks;

  if (tasks.length === 0) {
    log('DRAT: All months already scraped');
    return 0;
  }

  log(`\n=== Phase 1: DRAT Orders (${tasks.length} month-tasks across ${drats.length} DRATs) ===`);

  let orderCount = 0;
  const queue = new PQueue({ concurrency: WORKERS });
  let completed = 0;

  const promises = tasks.map((task) =>
    queue.add(async () => {
      if (shuttingDown) return;
      try {
        await sleep(DELAY_MS);
        const orders = await scrapeDratMonth(client, task);
        completed++;

        if (orders.length > 0) {
          orderCount += orders.length;
          appendToJsonl(orders);

          const monthFile = path.join(
            METADATA_DIR,
            `drat_${task.tribunalId}_${task.orderTypeName}_${task.year}_${String(task.month).padStart(2, '0')}.json`,
          );
          fs.writeFileSync(monthFile, JSON.stringify({ task, orders }, null, 2));
        }

        markDratComplete(progress, task.progressKey);
        progress.total_orders += orders.length;
        if (completed % 10 === 0) saveProgress(progress);

        const pct = ((completed / tasks.length) * 100).toFixed(1);
        log(
          `  [${pct}%] DRAT ${task.tribunalId} | ${task.orderTypeName} | ${String(task.month).padStart(2, '0')}/${task.year} → ${orders.length} orders (total: ${orderCount})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(
          `DRAT ${task.tribunalId} ${task.orderTypeName} ${task.month}/${task.year}: ${msg}`,
        );
      }
    }),
  );

  await Promise.all(promises);
  saveProgress(progress);

  log(`  DRAT phase complete: ${orderCount} orders collected`);
  return orderCount;
}

// ─── Phase 2: DRT Orders (Case Number Iteration) ────────────────────────────

interface DrtCaseTask {
  tribunalId: number;
  tribunalName: string;
  caseTypeId: number;
  caseTypeName: string;
  year: number;
  progressKey: string;
}

function generateDrtTasks(drts: Tribunal[], startYear: number, endYear: number): DrtCaseTask[] {
  const tasks: DrtCaseTask[] = [];

  for (const drt of drts) {
    for (const ct of PRIMARY_CASE_TYPES) {
      const ctInfo = CASE_TYPES.find((c) => c.id === ct);
      if (!ctInfo) continue;

      for (let year = startYear; year >= endYear; year--) {
        const key = `${drt.id}|${ct}|${year}`;
        if (!drtCompletedSet.has(key)) {
          tasks.push({
            tribunalId: drt.id,
            tribunalName: drt.name,
            caseTypeId: ct,
            caseTypeName: ctInfo.name,
            year,
            progressKey: key,
          });
        }
      }
    }
  }

  return tasks;
}

async function scrapeDrtCaseTypeYear(
  client: AxiosInstance,
  task: DrtCaseTask,
): Promise<OrderRecord[]> {
  const taskOrders: OrderRecord[] = [];
  let consecutiveEmpty = 0;

  for (let caseNo = 1; consecutiveEmpty < MAX_EMPTY; caseNo++) {
    if (shuttingDown) break;
    try {
      await sleep(DELAY_MS);

      const [dailyData, finalData] = await Promise.all([
        apiPost(client, 'getDrtDailyOrderReportCaseNo', {
          schemeNameDrtId: task.tribunalId,
          caseType: task.caseTypeId,
          caseNo,
          caseYear: task.year,
        }),
        apiPost(client, 'getDrtFinalOrderReportCaseNo', {
          schemeNameDrtId: task.tribunalId,
          caseType: task.caseTypeId,
          caseNo,
          caseYear: task.year,
        }),
      ]);

      let foundAny = false;

      for (const [orderType, data] of [
        ['daily', dailyData],
        ['final', finalData],
      ] as const) {
        if (!data || !Array.isArray(data)) continue;
        if (data.length === 0) continue;

        foundAny = true;
        const orders = (data as Array<Record<string, string>>).map((item) => {
          const rawPdfUrl = item.dailyOrderPdf || item.FinalOrderPdf || '';
          const directPdfUrl = getDirectPdfUrl(rawPdfUrl);

          const record: OrderRecord = {
            tribunal_id: task.tribunalId,
            tribunal_name: task.tribunalName,
            tribunal_type: 'DRT',
            order_type: orderType,
            case_number: item.applicantno || `${task.caseTypeId}/${caseNo}/${task.year}`,
            diary_number: item.diaryno || '',
            date_of_filing: item.dateoffiling || '',
            applicant_name: item.applicantName || '',
            respondent_name: item.respondentName || '',
            pronounced_by: item.pronouncedBy || '',
            pdf_url: directPdfUrl,
            pdf_filename: '',
            item_no: item.item_no || '',
            case_type_id: task.caseTypeId,
            case_type_name: task.caseTypeName,
            case_year: task.year,
            source: `drtapi/getDrt${orderType === 'daily' ? 'Daily' : 'Final'}OrderReportCaseNo`,
            tribunal: 'DRT',
            country: 'IN',
            scraped_at: new Date().toISOString(),
          };
          record.pdf_filename = generatePdfFilename(record);
          return record;
        });

        taskOrders.push(...orders);
      }

      if (foundAny) {
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
      }
    } catch {
      consecutiveEmpty++;
    }
  }

  return taskOrders;
}

async function scrapeDrtOrders(
  client: AxiosInstance,
  drts: Tribunal[],
  startYear: number,
  endYear: number,
  progress: Progress,
  testMode: boolean,
): Promise<number> {
  const allTasks = generateDrtTasks(drts, startYear, endYear);
  const tasks = testMode ? allTasks.slice(0, 1) : allTasks;

  if (tasks.length === 0) {
    log('DRT: All tribunal/caseType/year combos already scraped');
    return 0;
  }

  log(`\n=== Phase 2: DRT Orders (${tasks.length} tasks across ${drts.length} DRTs) ===`);
  log(`  Case types: ${PRIMARY_CASE_TYPES.join(', ')} | Max empty gap: ${MAX_EMPTY}`);

  let orderCount = 0;
  const queue = new PQueue({ concurrency: WORKERS });
  let completed = 0;

  const promises = tasks.map((task) =>
    queue.add(async () => {
      if (shuttingDown) return;
      try {
        const orders = await scrapeDrtCaseTypeYear(client, task);
        completed++;

        if (orders.length > 0) {
          orderCount += orders.length;
          appendToJsonl(orders);

          const metaFile = path.join(
            METADATA_DIR,
            `drt_${task.tribunalId}_ct${task.caseTypeId}_${task.year}.json`,
          );
          fs.writeFileSync(
            metaFile,
            JSON.stringify({ task, total: orders.length, sample: orders.slice(0, 5) }, null, 2),
          );
        }

        markDrtComplete(progress, task.progressKey);
        progress.total_orders += orders.length;
        if (completed % 5 === 0) saveProgress(progress);

        const pct = ((completed / tasks.length) * 100).toFixed(1);
        log(
          `  [${pct}%] DRT ${task.tribunalId} | CT${task.caseTypeId} | ${task.year} → ${orders.length} orders (total: ${orderCount})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`DRT ${task.tribunalId} CT${task.caseTypeId} ${task.year}: ${msg}`);
      }
    }),
  );

  await Promise.all(promises);
  saveProgress(progress);

  log(`  DRT phase complete: ${orderCount} orders collected`);
  return orderCount;
}

// ─── Phase 3: PDF Download (streaming JSONL reader) ──────────────────────────

async function* streamJsonlOrders(): AsyncGenerator<OrderRecord> {
  if (!fs.existsSync(JSONL_FILE)) return;

  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as OrderRecord;
    } catch {
      // skip malformed lines
    }
  }
}

async function retryFailedPdfs(progress: Progress): Promise<void> {
  const failedFile = path.join(DATA_DIR, 'pdfs-failed.txt');
  if (!fs.existsSync(failedFile)) {
    log('No pdfs-failed.txt found. Nothing to retry.');
    return;
  }

  // Deduplicate and filter out already-downloaded
  const entries = new Map<string, string>();
  const lines = fs.readFileSync(failedFile, 'utf-8').trim().split('\n');
  for (const line of lines) {
    const [filename, url] = line.split('\t');
    if (!filename || !url) continue;
    if (pdfsDoneSet.has(filename)) continue;
    if (fs.existsSync(path.join(PDFS_DIR, filename))) continue;
    entries.set(filename, url);
  }

  const toRetry = Array.from(entries.entries());
  log(`\n=== Retry Failed PDFs ===`);
  log(`  Total failed entries: ${lines.length}`);
  log(`  Unique: ${entries.size}`);
  log(`  Still need downloading: ${toRetry.length}`);
  log(`  Workers: ${PDF_WORKERS}`);

  if (toRetry.length === 0) {
    log('  All previously failed PDFs are now downloaded.');
    return;
  }

  const pdfQueue = new PQueue({ concurrency: Math.min(50, PDF_WORKERS) });
  let downloaded = 0;
  let failed = 0;
  const retryStartTime = Date.now();
  const stillFailed: string[] = [];

  for (const [pdfFilename, pdfUrl] of toRetry) {
    if (shuttingDown) break;

    pdfQueue.add(async () => {
      const dest = path.join(PDFS_DIR, pdfFilename);

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const resp = await axios.get(pdfUrl, {
            responseType: 'arraybuffer',
            timeout: 60_000,
            maxRedirects: 5,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            },
          });

          if (resp.status === 200 && resp.data.length > 100) {
            const header = Buffer.from(resp.data).toString('utf-8', 0, 5);
            if (header.startsWith('%PDF')) {
              fs.writeFileSync(dest, resp.data);
              downloaded++;
              markPdfDone(pdfFilename);
              progress.total_pdfs++;

              if (downloaded % 50 === 0) {
                saveProgress(progress);
                const elapsed = (Date.now() - retryStartTime) / 1000;
                const rate = downloaded / elapsed;
                const remaining = toRetry.length - downloaded - failed;
                const etaSec = rate > 0 ? remaining / rate : 0;
                const etaMin = Math.ceil(etaSec / 60);
                log(
                  `  Retry [${downloaded}/${toRetry.length}] downloaded, ${failed} still failed, ${rate.toFixed(0)}/s, ETA: ${etaMin}m`,
                );
              }
              return;
            }
          }

          if (attempt < 4) await sleep(2000 * (attempt + 1));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt === 4) {
            logError(`  RETRY FAIL [${pdfFilename}]: ${msg}`);
          }
          if (attempt < 4) await sleep(2000 * (attempt + 1));
        }
      }

      failed++;
      stillFailed.push(`${pdfFilename}\t${pdfUrl}`);
    });
  }

  await pdfQueue.onIdle();

  // Overwrite failed file with only the ones that still fail
  fs.writeFileSync(failedFile, stillFailed.join('\n') + (stillFailed.length ? '\n' : ''));
  saveProgress(progress);

  log(`\n  Retry complete: ${downloaded} recovered, ${failed} still failing`);
  log(`  Updated pdfs-failed.txt: ${stillFailed.length} entries remaining`);
}

async function downloadPdfs(
  progress: Progress,
  testMode: boolean,
  maxPdfs?: number,
  finalsOnly?: boolean,
): Promise<void> {
  if (!fs.existsSync(JSONL_FILE)) {
    logError('No metadata JSONL found. Run metadata scrape first.');
    return;
  }

  // First pass: count totals by streaming (no full load into memory)
  let totalWithPdf = 0;
  let toDownloadCount = 0;

  log(`\n=== Phase 3: PDF Downloads ===`);
  if (finalsOnly) log(`  Filter: FINALS ONLY (judgments)`);
  log(`  Scanning JSONL for download candidates...`);

  for await (const order of streamJsonlOrders()) {
    if (!order.pdf_url) continue;
    if (finalsOnly && order.order_type !== 'final') continue;
    totalWithPdf++;

    if (pdfsDoneSet.has(order.pdf_filename)) continue;
    if (fs.existsSync(path.join(PDFS_DIR, order.pdf_filename))) {
      markPdfDone(order.pdf_filename);
      continue;
    }
    toDownloadCount++;

    if (totalWithPdf % 50000 === 0) {
      log(`    Scanned ${totalWithPdf} orders...`);
    }
  }

  log(`  Total orders with PDFs: ${totalWithPdf}`);
  log(`  Already downloaded: ${pdfsDoneSet.size}`);
  log(`  To download: ${toDownloadCount}`);
  log(`  Workers: ${PDF_WORKERS}`);

  if (toDownloadCount === 0) {
    log('  Nothing to download.');
    return;
  }

  // Dynamic worker pool: scales up on success, backs off on errors
  const MIN_CONCURRENCY = 10;
  const MAX_CONCURRENCY = PDF_WORKERS;
  let currentConcurrency = Math.min(50, MAX_CONCURRENCY); // start moderate
  const pdfQueue = new PQueue({ concurrency: currentConcurrency });
  let downloaded = 0;
  let failed = 0;
  let failed404 = 0;
  let skippedBadUrl = 0;
  let queued = 0;
  const BATCH_SIZE = 1000;

  // Rolling window for error rate tracking (last 200 results)
  const WINDOW_SIZE = 200;
  const resultWindow: boolean[] = []; // true=success, false=error (non-404)
  let lastAdjust = 0;

  function adjustConcurrency(): void {
    if (resultWindow.length < 50) return; // need enough data
    const now = Date.now();
    if (now - lastAdjust < 5000) return; // adjust at most every 5s
    lastAdjust = now;

    const recentErrors = resultWindow.filter((r) => !r).length;
    const errorRate = recentErrors / resultWindow.length;

    const prevConcurrency = currentConcurrency;

    if (errorRate > 0.15) {
      // >15% errors: aggressive backoff
      currentConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(currentConcurrency * 0.5));
    } else if (errorRate > 0.05) {
      // >5% errors: gentle backoff
      currentConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(currentConcurrency * 0.8));
    } else if (errorRate < 0.01 && currentConcurrency < MAX_CONCURRENCY) {
      // <1% errors: scale up
      currentConcurrency = Math.min(MAX_CONCURRENCY, Math.floor(currentConcurrency * 1.3));
    } else if (errorRate < 0.03 && currentConcurrency < MAX_CONCURRENCY) {
      // <3% errors: gentle scale up
      currentConcurrency = Math.min(MAX_CONCURRENCY, currentConcurrency + 5);
    }

    if (currentConcurrency !== prevConcurrency) {
      pdfQueue.concurrency = currentConcurrency;
      log(
        `  [POOL] ${prevConcurrency} → ${currentConcurrency} workers (error rate: ${(errorRate * 100).toFixed(1)}%)`,
      );
    }
  }

  function recordResult(success: boolean, is404: boolean): void {
    // 404s are permanent (file doesn't exist), don't count toward rate limiting errors
    if (!is404) {
      resultWindow.push(success);
      if (resultWindow.length > WINDOW_SIZE) resultWindow.shift();
    }
    adjustConcurrency();
  }

  const downloadStartTime = Date.now();
  const downloadStartCount = 0;

  log(`  Starting with ${currentConcurrency} workers (max: ${MAX_CONCURRENCY})`);

  for await (const order of streamJsonlOrders()) {
    if (shuttingDown) break;
    if (!order.pdf_url) continue;
    if (finalsOnly && order.order_type !== 'final') continue;
    if (pdfsDoneSet.has(order.pdf_filename)) continue;
    if (fs.existsSync(path.join(PDFS_DIR, order.pdf_filename))) {
      markPdfDone(order.pdf_filename);
      continue;
    }

    if (testMode && queued >= 5) break;
    if (maxPdfs && queued >= maxPdfs) break;

    queued++;
    const pdfUrl = order.pdf_url;
    const pdfFilename = order.pdf_filename;

    // Skip URLs that are too long (embedded HTML judgment in base64, not a real PDF path)
    if (pdfUrl.length > 2000) {
      skippedBadUrl++;
      continue;
    }

    pdfQueue.add(async () => {
      if (shuttingDown) return;
      const dest = path.join(PDFS_DIR, pdfFilename);
      const tmpDest = dest + '.tmp';

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // Use curl instead of axios — better TLS fingerprint, avoids server blocking
          await execFileAsync('curl', [
            '-sS',
            '-f',
            '-o',
            tmpDest,
            '-m',
            '60',
            '-L',
            '--retry',
            '0',
            '-H',
            'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            pdfUrl,
          ]);

          // Verify it's actually a PDF
          if (fs.existsSync(tmpDest)) {
            const stat = fs.statSync(tmpDest);
            if (stat.size > 100) {
              const header = fs.readFileSync(tmpDest, { encoding: 'utf-8', flag: 'r' }).slice(0, 5);
              if (header.startsWith('%PDF')) {
                fs.renameSync(tmpDest, dest);
                downloaded++;
                markPdfDone(pdfFilename);
                progress.total_pdfs++;
                recordResult(true, false);

                if (downloaded % 100 === 0) {
                  saveProgress(progress);
                  const pct = ((downloaded / toDownloadCount) * 100).toFixed(2);
                  const elapsed = (Date.now() - downloadStartTime) / 1000;
                  const rate = downloaded / elapsed;
                  const remaining = toDownloadCount - downloaded;
                  const etaSec = rate > 0 ? remaining / rate : 0;
                  const etaMin = Math.floor(etaSec / 60);
                  const etaH = Math.floor(etaMin / 60);
                  const etaStr = etaH > 0 ? `${etaH}h${etaMin % 60}m` : `${etaMin}m`;
                  log(
                    `  PDF [${pct}%] ${downloaded}/${toDownloadCount} downloaded, ${failed} failed (${failed404} 404s), workers: ${currentConcurrency}, ${rate.toFixed(0)}/s, ETA: ${etaStr}`,
                  );
                }
                return;
              }
            }
            // Not a valid PDF, clean up
            try {
              fs.unlinkSync(tmpDest);
            } catch {}
          }

          if (attempt < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS * (attempt + 1));
        } catch (err: unknown) {
          try {
            fs.unlinkSync(tmpDest);
          } catch {}
          const msg = err instanceof Error ? err.message : String(err);
          const is404 = msg.includes('exit code 22') || msg.includes('404');
          if (is404) failed404++;
          if (attempt === MAX_RETRIES - 1) {
            if (!is404) logError(`  PDF FAIL [${pdfFilename}]: ${msg}`);
            recordResult(false, is404);
          }
          if (attempt < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS * (attempt + 1));
        }
      }

      failed++;
      if (failed % 100 === 0) {
        log(`  [WARN] ${failed} total failures so far (${failed404} are 404s)`);
      }
      // Track failed PDFs for retry later
      fs.appendFileSync(path.join(DATA_DIR, 'pdfs-failed.txt'), `${pdfFilename}\t${pdfUrl}\n`);
    });

    // Backpressure: if queue is full, wait for some to drain before adding more
    if (pdfQueue.size > BATCH_SIZE) {
      await pdfQueue.onSizeLessThan(BATCH_SIZE / 2);
    }
  }

  // Wait for remaining queued items to finish
  await pdfQueue.onIdle();
  saveProgress(progress);

  log(
    `\n  PDF download complete: ${downloaded} downloaded, ${failed} failed (${failed404} 404s), ${skippedBadUrl} skipped (bad URL)`,
  );
  log(`  Final concurrency: ${currentConcurrency}`);
}

// ─── CLI & Main ─────────────────────────────────────────────────────────────

function parseArgs(): {
  testMode: boolean;
  metadataOnly: boolean;
  downloadOnly: boolean;
  dratOnly: boolean;
  drtOnly: boolean;
  finalsOnly: boolean;
  retryFailed: boolean;
  tribunalFilter?: number;
  yearFilter?: number;
  startYear: number;
  endYear: number;
} {
  const args = process.argv.slice(2);

  const testMode = args.includes('--test');
  const metadataOnly = args.includes('--metadata-only');
  const downloadOnly = args.includes('--download-only');
  const dratOnly = args.includes('--drat-only');
  const drtOnly = args.includes('--drt-only');
  const finalsOnly = args.includes('--finals-only');
  const retryFailed = args.includes('--retry-failed');

  let tribunalFilter: number | undefined;
  let yearFilter: number | undefined;
  let startYear = 2025;
  let endYear = 2000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tribunal' && args[i + 1]) {
      tribunalFilter = parseInt(args[i + 1], 10);
    }
    if (args[i] === '--year' && args[i + 1]) {
      yearFilter = parseInt(args[i + 1], 10);
      startYear = yearFilter;
      endYear = yearFilter;
    }
    if (args[i] === '--start-year' && args[i + 1]) {
      startYear = parseInt(args[i + 1], 10);
    }
    if (args[i] === '--end-year' && args[i + 1]) {
      endYear = parseInt(args[i + 1], 10);
    }
  }

  if (testMode) {
    startYear = 2025;
    endYear = 2025;
  }

  return {
    testMode,
    metadataOnly,
    downloadOnly,
    dratOnly,
    drtOnly,
    finalsOnly,
    retryFailed,
    tribunalFilter,
    yearFilter,
    startYear,
    endYear,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  ensureDirs();

  const client = createApiClient();
  const progress = loadProgress();
  initSets(progress);
  setupShutdownHandler(progress);
  openJsonlWriter();

  TRIBUNALS = await fetchTribunals(client);

  let drats = TRIBUNALS.filter((t) => t.type === 'DRAT');
  let drts = TRIBUNALS.filter((t) => t.type === 'DRT');

  if (opts.tribunalFilter) {
    drats = drats.filter((t) => t.id === opts.tribunalFilter);
    drts = drts.filter((t) => t.id === opts.tribunalFilter);
  }

  const mode = opts.metadataOnly ? 'metadata-only' : opts.downloadOnly ? 'download-only' : 'full';

  console.log(`\nDRT/DRAT Scraper - Debt Recovery Tribunal`);
  console.log(`  Mode: ${mode}${opts.testMode ? ' (TEST)' : ''}`);
  console.log(
    `  DRATs: ${opts.drtOnly ? 0 : drats.length} | DRTs: ${opts.dratOnly ? 0 : drts.length}`,
  );
  console.log(`  Years: ${opts.startYear} → ${opts.endYear}`);
  console.log(`  Workers: ${WORKERS} metadata, ${PDF_WORKERS} PDF`);
  if (opts.finalsOnly) console.log(`  Filter: FINALS ONLY (judgments)`);
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Progress: ${progress.total_orders} orders, ${progress.total_pdfs} PDFs\n`);

  if (opts.retryFailed) {
    closeJsonlWriter();
    await retryFailedPdfs(progress);
    return;
  }

  if (opts.downloadOnly) {
    closeJsonlWriter();
    await downloadPdfs(progress, opts.testMode, undefined, opts.finalsOnly);
    return;
  }

  let totalNewOrders = 0;

  if (!opts.drtOnly && drats.length > 0) {
    totalNewOrders += await scrapeDratOrders(
      client,
      drats,
      opts.startYear,
      opts.endYear,
      progress,
      opts.testMode,
    );
  }

  if (!opts.dratOnly && drts.length > 0 && !shuttingDown) {
    totalNewOrders += await scrapeDrtOrders(
      client,
      drts,
      opts.startYear,
      opts.endYear,
      progress,
      opts.testMode,
    );
  }

  closeJsonlWriter();

  if (!opts.metadataOnly && !shuttingDown) {
    await downloadPdfs(progress, opts.testMode, undefined, opts.finalsOnly);
  }

  saveProgress(progress);
  console.log(`\n=== Scraping Complete ===`);
  console.log(`  New orders this run: ${totalNewOrders}`);
  console.log(`  Total orders (all time): ${progress.total_orders}`);
  console.log(`  Total PDFs (all time): ${progress.total_pdfs}`);
  console.log(`  DRAT months scraped: ${progress.drat_completed.length}`);
  console.log(`  DRT combos scraped: ${progress.drt_completed.length}`);
}

main().catch((err) => {
  closeJsonlWriter();
  console.error('Fatal error:', err);
  process.exit(1);
});
