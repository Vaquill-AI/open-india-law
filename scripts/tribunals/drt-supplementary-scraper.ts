/**
 * DRT/DRAT Supplementary Scraper
 * Scrapes additional data streams from https://drt.gov.in:
 *   1. Advocate Data - case-advocate mappings from all 44 tribunals
 *   2. Bench/Judge Assignments - PDFs from financialservices.gov.in
 *   3. RC/TRC Cases - Recovery Certificate / Transfer RC cases
 *
 * Usage:
 *   npx tsx scripts/drt-supplementary-scraper.ts --advocates     # Scrape advocate data
 *   npx tsx scripts/drt-supplementary-scraper.ts --bench          # Download bench/judge PDFs
 *   npx tsx scripts/drt-supplementary-scraper.ts --rc-trc         # Scrape RC/TRC cases
 *   npx tsx scripts/drt-supplementary-scraper.ts --all            # Run all three
 *   npx tsx scripts/drt-supplementary-scraper.ts --rc-trc --test  # Test mode (1 tribunal, 1 year)
 *
 * Environment:
 *   WORKERS=5              Concurrent workers for RC/TRC (default: 5)
 *   DELAY_MS=200           Delay between API requests (default: 200)
 *   MAX_EMPTY=15           Stop RC/TRC iteration after N consecutive empties (default: 15)
 *   DATA_DIR=data/drt      Output directory (default: data/drt)
 */

import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const DRT_API_BASE = 'https://drt.gov.in/drtapi';

const WORKERS = parseInt(process.env.WORKERS || '5', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '200', 10);
const MAX_EMPTY = parseInt(process.env.MAX_EMPTY || '15', 10);
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3000;

const DATA_DIR = process.env.DATA_DIR || 'data/tribunals/drt';
const ADVOCATES_DIR = path.join(DATA_DIR, 'advocates');
const BENCH_DIR = path.join(DATA_DIR, 'bench');
const RC_TRC_DIR = path.join(DATA_DIR, 'rc-trc');

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;

function setupShutdownHandler(onShutdown: () => void): void {
  const handler = () => {
    if (shuttingDown) {
      log('Force exit');
      process.exit(1);
    }
    shuttingDown = true;
    log('Shutting down gracefully... (press Ctrl+C again to force)');
    onShutdown();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface Tribunal {
  id: number;
  name: string;
  slug: string;
  type: 'DRT' | 'DRAT';
}

interface AdvocateRecord {
  tribunal_id: number;
  tribunal_name: string;
  tribunal_type: 'DRT' | 'DRAT';
  advocate_type: number; // 1 = applicant, 2 = respondent
  advocate_type_label: string;
  advocate_name: string;
  case_number: string;
  diary_number: string;
  case_type: string;
  filing_date: string;
  applicant_name: string;
  respondent_name: string;
  status: string;
  source: string;
  scraped_at: string;
}

interface RcTrcRecord {
  tribunal_id: number;
  tribunal_name: string;
  tribunal_type: 'DRT' | 'DRAT';
  rc_type: 'RC' | 'TRC';
  case_number: string;
  rc_number: string;
  year: number;
  case_no_iteration: number;
  applicant_name: string;
  respondent_name: string;
  status: string;
  order_date: string;
  pdf_url: string;
  raw_data: Record<string, unknown>;
  source: string;
  scraped_at: string;
}

interface SupplementaryProgress {
  advocates_completed: string[]; // tribunal slugs
  rc_trc_completed: string[]; // "tribunalId|rcType|year" keys
  total_advocate_records: number;
  total_rc_trc_records: number;
  last_updated: string;
}

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
  for (const dir of [DATA_DIR, ADVOCATES_DIR, BENCH_DIR, RC_TRC_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Progress ────────────────────────────────────────────────────────────────

const PROGRESS_FILE = path.join(DATA_DIR, 'supplementary-progress.json');

function loadProgress(): SupplementaryProgress {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return {
    advocates_completed: [],
    rc_trc_completed: [],
    total_advocate_records: 0,
    total_rc_trc_records: 0,
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: SupplementaryProgress): void {
  progress.last_updated = new Date().toISOString();
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

let advocatesCompletedSet: Set<string>;
let rcTrcCompletedSet: Set<string>;

function initSets(progress: SupplementaryProgress): void {
  advocatesCompletedSet = new Set(progress.advocates_completed);
  rcTrcCompletedSet = new Set(progress.rc_trc_completed);
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
}

// ─── Tribunal Registry ──────────────────────────────────────────────────────

async function fetchTribunals(client: AxiosInstance): Promise<Tribunal[]> {
  // Try loading from cached registry first
  const registryFile = path.join(DATA_DIR, 'tribunal-registry.json');
  if (fs.existsSync(registryFile)) {
    const cached = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
    if (Array.isArray(cached) && cached.length > 0) {
      log(`Loaded ${cached.length} tribunals from cache`);
      return cached;
    }
  }

  log('Fetching tribunal registry from API...');
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

  fs.writeFileSync(registryFile, JSON.stringify(tribunals, null, 2));
  return tribunals;
}

// ─── JSONL Writer ────────────────────────────────────────────────────────────

class JsonlWriter {
  private fd: number | null = null;

  constructor(private filePath: string) {}

  open(): void {
    this.fd = fs.openSync(this.filePath, 'a');
  }

  append(records: Record<string, unknown>[]): void {
    if (this.fd === null) return;
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.writeSync(this.fd, lines);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

// =============================================================================
// STREAM 1: ADVOCATE DATA
// =============================================================================

async function scrapeAdvocates(
  client: AxiosInstance,
  tribunals: Tribunal[],
  progress: SupplementaryProgress,
): Promise<void> {
  log('=== ADVOCATE DATA SCRAPING ===');

  const jsonlFile = path.join(ADVOCATES_DIR, 'drt-advocates.jsonl');
  const writer = new JsonlWriter(jsonlFile);
  writer.open();

  const advTypes = [
    { id: 1, label: 'Applicant Advocate' },
    { id: 2, label: 'Respondent Advocate' },
  ];

  let totalRecords = 0;
  let totalCalls = 0;
  const totalExpected = tribunals.length * advTypes.length;
  const startTime = Date.now();

  for (const tribunal of tribunals) {
    if (shuttingDown) break;

    for (const advType of advTypes) {
      const progressKey = `${tribunal.slug}|${advType.id}`;
      if (advocatesCompletedSet.has(progressKey)) {
        totalCalls++;
        continue;
      }

      try {
        const data = await apiPost(client, 'casedetail_adv_name_wise_mob', {
          catschemaId: tribunal.id,
          advType: advType.id,
          advName: '', // empty = return ALL
        });

        const records = Array.isArray(data) ? data : [];
        const advocateRecords: AdvocateRecord[] = records.map((r: Record<string, unknown>) => ({
          tribunal_id: tribunal.id,
          tribunal_name: tribunal.name,
          tribunal_type: tribunal.type,
          advocate_type: advType.id,
          advocate_type_label: advType.label,
          advocate_name: String(
            r.applicantadvocate || r.respondentadvocate || r.advName || '',
          ).trim(),
          case_number: String(r.caseno || r.caseNo || '').trim(),
          diary_number: String(r.diaryno || r.diaryNo || '').trim(),
          case_type: String(r.casetype || r.caseType || '').trim(),
          filing_date: String(r.dateoffiling || r.filingDate || '').trim(),
          applicant_name: String(r.applicant || r.applicantName || '').trim(),
          respondent_name: String(r.respondent || r.respondentName || '').trim(),
          status: String(r.stage || r.caseStatus || '').trim(),
          source: 'drt.gov.in',
          scraped_at: new Date().toISOString(),
        }));

        if (advocateRecords.length > 0) {
          writer.append(advocateRecords as unknown as Record<string, unknown>[]);
        }

        totalRecords += advocateRecords.length;
        totalCalls++;

        advocatesCompletedSet.add(progressKey);
        progress.advocates_completed.push(progressKey);
        progress.total_advocate_records += advocateRecords.length;
        saveProgress(progress);

        const elapsed = (Date.now() - startTime) / 1000;
        const rate = totalCalls / elapsed;
        const remaining = totalExpected - totalCalls;
        const etaSec = rate > 0 ? remaining / rate : 0;
        const etaMin = Math.ceil(etaSec / 60);

        log(
          `  [${totalCalls}/${totalExpected}] ${tribunal.name} (${advType.label}): ${advocateRecords.length} records | total: ${totalRecords} | ETA: ${etaMin}m`,
        );

        await sleep(DELAY_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`Failed ${tribunal.name} advType=${advType.id}: ${msg}`);
      }
    }
  }

  writer.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`=== ADVOCATE SCRAPING COMPLETE: ${totalRecords} records in ${elapsed}s ===`);
}

// =============================================================================
// STREAM 2: BENCH / JUDGE ASSIGNMENTS (PDF Downloads)
// =============================================================================

const BENCH_PDFS = [
  {
    name: 'DRT-DRAT-Judges-Nov-2023.pdf',
    url: 'https://financialservices.gov.in/beta/sites/default/files/2023-11/DRT-DRAT.pdf',
  },
  {
    name: 'DRT-DRAT-Judges-Oct-2024.pdf',
    url: 'https://financialservices.gov.in/beta/sites/default/files/2024-10/DRT-DRAT.pdf',
  },
  {
    name: 'DRT-DRAT-Judges-Feb-2025.pdf',
    url: 'https://financialservices.gov.in/beta/sites/default/files/2025-02/DRT-DRAT-02-2025.pdf',
  },
];

async function downloadBenchPdfs(): Promise<void> {
  log('=== BENCH/JUDGE PDF DOWNLOADS ===');

  for (const pdf of BENCH_PDFS) {
    const outPath = path.join(BENCH_DIR, pdf.name);

    if (fs.existsSync(outPath)) {
      const stats = fs.statSync(outPath);
      if (stats.size > 1000) {
        log(`  Already downloaded: ${pdf.name} (${(stats.size / 1024).toFixed(0)}KB)`);
        continue;
      }
    }

    log(`  Downloading: ${pdf.name}`);

    try {
      const response = await axios.get(pdf.url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        // Follow redirects, allow self-signed certs for gov.in
        maxRedirects: 5,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });

      fs.writeFileSync(outPath, response.data);
      const size = (response.data.length / 1024).toFixed(0);
      log(`  Saved: ${pdf.name} (${size}KB)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to download ${pdf.name}: ${msg}`);
    }
  }

  log('=== BENCH PDF DOWNLOADS COMPLETE ===');
}

// =============================================================================
// STREAM 3: RC/TRC CASES
// =============================================================================

// RC/TRC magic case type IDs discovered from JS bundle
const RC_TYPE_ID = 99999;
const TRC_TYPE_ID = 44444;

interface RcTrcTask {
  tribunal: Tribunal;
  rcType: 'RC' | 'TRC';
  caseTypeId: number;
  year: number;
  progressKey: string;
}

function generateRcTrcTasks(tribunals: Tribunal[], testMode: boolean): RcTrcTask[] {
  const tasks: RcTrcTask[] = [];
  const currentYear = new Date().getFullYear();
  const startYear = currentYear;
  const endYear = testMode ? 2024 : 2010; // RC/TRC data likely from 2010+

  const rcTypes: Array<{ type: 'RC' | 'TRC'; id: number }> = [
    { type: 'RC', id: RC_TYPE_ID },
    { type: 'TRC', id: TRC_TYPE_ID },
  ];

  const tribunalsToProcess = testMode ? tribunals.slice(0, 1) : tribunals;

  for (const tribunal of tribunalsToProcess) {
    for (const rc of rcTypes) {
      for (let year = startYear; year >= endYear; year--) {
        tasks.push({
          tribunal,
          rcType: rc.type,
          caseTypeId: rc.id,
          year,
          progressKey: `${tribunal.id}|${rc.type}|${year}`,
        });
      }
    }
  }

  return tasks;
}

async function scrapeRcTrcForTask(
  client: AxiosInstance,
  task: RcTrcTask,
  writer: JsonlWriter,
  progress: SupplementaryProgress,
): Promise<number> {
  let totalForTask = 0;
  let consecutiveEmpty = 0;

  for (let caseNo = 1; caseNo <= 10000; caseNo++) {
    if (shuttingDown) break;

    try {
      // API returns a single object per case, not an array
      // Use retries=0 since 500 means "no data" for RC/TRC
      const data = (await apiPost(
        client,
        'getRcTrcCaseStatusReport',
        {
          schemeNameDrtId: task.tribunal.id,
          caseTypeId: task.caseTypeId,
          caseNo: caseNo,
          caseYear: task.year,
        },
        0,
      )) as Record<string, unknown> | null;

      // Empty response or no case number = no data for this caseNo
      if (!data || !data.caseno) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_EMPTY) {
          break;
        }
        continue;
      }

      consecutiveEmpty = 0;

      const record: RcTrcRecord = {
        tribunal_id: task.tribunal.id,
        tribunal_name: task.tribunal.name,
        tribunal_type: task.tribunal.type,
        rc_type: task.rcType,
        case_number: String(data.caseno || `${task.rcType}/${caseNo}/${task.year}`).trim(),
        rc_number: String(data.rcNo || '').trim(),
        year: task.year,
        case_no_iteration: caseNo,
        applicant_name: String(data.petitionerName || '').trim(),
        respondent_name: String(data.respondentName || '').trim(),
        status: String(data.status || '').trim(),
        order_date: String(data.nextlistingdate || '').trim(),
        pdf_url: '',
        raw_data: data,
        source: 'drt.gov.in',
        scraped_at: new Date().toISOString(),
      };

      writer.append([record as unknown as Record<string, unknown>]);
      totalForTask++;

      if (caseNo % 100 === 0) {
        log(
          `    ${task.tribunal.name} ${task.rcType}/${task.year}: caseNo=${caseNo}, found=${totalForTask}`,
        );
      }

      await sleep(DELAY_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('500')) {
        // 500 typically means no data — treat as empty
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_EMPTY) break;
      } else if (msg.includes('timeout') || msg.includes('ECONNRESET')) {
        logError(`${task.tribunal.name} ${task.rcType}/${task.year} caseNo=${caseNo}: ${msg}`);
        await sleep(RETRY_DELAY_MS);
        // Don't count network errors as empty
      } else {
        logError(`${task.tribunal.name} ${task.rcType}/${task.year} caseNo=${caseNo}: ${msg}`);
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_EMPTY) break;
      }
    }
  }

  return totalForTask;
}

async function scrapeRcTrc(
  client: AxiosInstance,
  tribunals: Tribunal[],
  progress: SupplementaryProgress,
  testMode: boolean,
): Promise<void> {
  log('=== RC/TRC CASE SCRAPING ===');

  const jsonlFile = path.join(RC_TRC_DIR, 'drt-rc-trc.jsonl');
  const writer = new JsonlWriter(jsonlFile);
  writer.open();

  const allTasks = generateRcTrcTasks(tribunals, testMode);
  const pendingTasks = allTasks.filter((t) => !rcTrcCompletedSet.has(t.progressKey));

  log(`Total RC/TRC tasks: ${allTasks.length}, pending: ${pendingTasks.length}`);

  // Also try alternate endpoints to discover which ones return data
  // First, do a probe on the first tribunal to find working endpoints
  if (pendingTasks.length > 0) {
    log('Probing RC/TRC endpoints to find working ones...');
    const probeEndpoints = [
      'getRcTrcCaseStatusReport',
      'getRcTrcNewCreate',
      'getRcTrcDailyFinalOrderRcNo',
      'getRcCauselistReport',
    ];
    const probeTribunal = tribunals[0];

    for (const endpoint of probeEndpoints) {
      try {
        const params: Record<string, string | number> =
          endpoint === 'getRcTrcDailyFinalOrderRcNo'
            ? {
                schemeNameDrtId: probeTribunal.id,
                dailyFinalOrderId: 2,
                caseType: RC_TYPE_ID,
                dailyFinalRcNo: 1,
                dailyFinalRcYear: new Date().getFullYear(),
              }
            : endpoint === 'getRcTrcNewCreate'
              ? {
                  schemeNameDrtId: probeTribunal.id,
                  caseType: RC_TYPE_ID,
                  dailyFinalRcNo: 1,
                  dailyFinalRcYear: new Date().getFullYear(),
                }
              : {
                  schemeNameDrtId: probeTribunal.id,
                  caseTypeId: RC_TYPE_ID,
                  caseNo: 1,
                  caseYear: new Date().getFullYear(),
                };
        const data = await apiPost(client, endpoint, params);
        const result = Array.isArray(data) ? data : [];
        log(`  Probe ${endpoint}: ${result.length} results`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  Probe ${endpoint}: FAILED (${msg.slice(0, 80)})`);
      }
    }
  }

  let totalRecords = 0;
  let completedTasks = 0;
  const startTime = Date.now();

  const queue = new PQueue({ concurrency: WORKERS });

  for (const task of pendingTasks) {
    if (shuttingDown) break;

    queue.add(async () => {
      if (shuttingDown) return;

      const count = await scrapeRcTrcForTask(client, task, writer, progress);
      totalRecords += count;
      completedTasks++;

      rcTrcCompletedSet.add(task.progressKey);
      progress.rc_trc_completed.push(task.progressKey);
      progress.total_rc_trc_records += count;
      saveProgress(progress);

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = completedTasks / elapsed;
      const remaining = pendingTasks.length - completedTasks;
      const etaSec = rate > 0 ? remaining / rate : 0;
      const etaMin = Math.ceil(etaSec / 60);

      log(
        `  [${completedTasks}/${pendingTasks.length}] ${task.tribunal.name} ${task.rcType}/${task.year}: ${count} records | total: ${totalRecords} | ETA: ${etaMin}m`,
      );
    });
  }

  await queue.onIdle();
  writer.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(
    `=== RC/TRC SCRAPING COMPLETE: ${totalRecords} records across ${completedTasks} tasks in ${elapsed}s ===`,
  );
}

// =============================================================================
// MAIN
// =============================================================================

function parseArgs(): {
  advocates: boolean;
  bench: boolean;
  rcTrc: boolean;
  all: boolean;
  test: boolean;
} {
  const args = process.argv.slice(2);
  const advocates = args.includes('--advocates');
  const bench = args.includes('--bench');
  const rcTrc = args.includes('--rc-trc');
  const all = args.includes('--all');
  const test = args.includes('--test');

  // If none specified, show usage
  if (!advocates && !bench && !rcTrc && !all) {
    console.log(`
DRT/DRAT Supplementary Scraper

Usage:
  npx tsx scripts/drt-supplementary-scraper.ts --advocates   Scrape advocate data (88 API calls)
  npx tsx scripts/drt-supplementary-scraper.ts --bench       Download bench/judge PDFs (3 files)
  npx tsx scripts/drt-supplementary-scraper.ts --rc-trc      Scrape RC/TRC cases
  npx tsx scripts/drt-supplementary-scraper.ts --all         Run all three streams

Flags:
  --test    Test mode (1 tribunal for RC/TRC)
`);
    process.exit(0);
  }

  return { advocates, bench, rcTrc, all, test };
}

async function main(): Promise<void> {
  const opts = parseArgs();

  ensureDirs();

  const progress = loadProgress();
  initSets(progress);

  setupShutdownHandler(() => {
    saveProgress(progress);
    log(`Progress saved`);
  });

  const client = createApiClient();
  const tribunals = await fetchTribunals(client);

  log(`Loaded ${tribunals.length} tribunals`);
  log(
    `Progress: ${progress.total_advocate_records} advocate records, ${progress.total_rc_trc_records} RC/TRC records`,
  );

  // Stream 1: Advocate Data
  if (opts.advocates || opts.all) {
    await scrapeAdvocates(client, tribunals, progress);
  }

  // Stream 2: Bench/Judge PDFs
  if (opts.bench || opts.all) {
    await downloadBenchPdfs();
  }

  // Stream 3: RC/TRC Cases
  if (opts.rcTrc || opts.all) {
    await scrapeRcTrc(client, tribunals, progress, opts.test);
  }

  saveProgress(progress);
  log('All done!');
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
