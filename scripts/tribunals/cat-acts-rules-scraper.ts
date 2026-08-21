/**
 * CAT Acts/Rules/Notices/Forms Scraper
 *
 * Downloads statutory documents from cgat.gov.in React API:
 *   - Acts (Administrative Tribunals Act 1985)
 *   - Rules (Procedure Rules, Rules of Practice, Recruitment Rules, etc.)
 *   - Notices/Circulars (721+ documents)
 *   - Forms (Application forms for filing)
 *
 * Also downloads from external government sources:
 *   - CAT Procedure Rules 1987 (THC)
 *   - CAT Rules of Practice 1993 (THC)
 *   - CIS Portal Act PDF
 *
 * API: AES-encrypted (CryptoJS format, key: "CatApplication")
 * Endpoints: get-modules/{benchId}/{type}, get-notice/{benchId}
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import PQueue from 'p-queue';

// ── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://cgat.gov.in/CAT_application/public/index.php/api/v1';
const API_HEADERS = {
  'X-user': 'zur1xjb4',
  'Content-Type': 'application/json',
};
const CRYPTO_KEY = 'CatApplication';

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'tribunals', 'cat-acts-rules');
const PDF_CONCURRENCY = 10;
const DELAY_MS = 200;

// Bench 20 (Principal Bench, Delhi) has all the data
const BENCH_ID = 20;

// All CAT bench IDs (for notice scanning)
const ALL_BENCH_IDS: Record<string, number> = {
  delhi: 20,
  'principal-bench': 100,
  ahmedabad: 120,
  allahabad: 330,
  bangalore: 103,
  chandigarh: 60,
  chennai: 310,
  cuttack: 260,
  ernakulam: 180,
  guwahati: 40,
  hyderabad: 21,
  jabalpur: 200,
  jaipur: 291,
  jammu: 117,
  jodhpur: 111,
  kolkata: 350,
  lucknow: 332,
  mumbai: 210,
  patna: 116,
  srinagar: 119,
};

// External source PDFs (already verified as valid)
const EXTERNAL_SOURCES = [
  {
    name: 'CAT Procedure Rules 1987 (THC)',
    url: 'https://thc.nic.in/Central%20Governmental%20Rules/Central%20Administrative%20Tribunal%20(Procedure)%20Rules,1987..pdf',
    filename: 'cat_procedure_rules_1987_thc.pdf',
    category: 'rules',
  },
  {
    name: 'CAT Rules of Practice 1993 (THC)',
    url: 'https://thc.nic.in/Central%20Governmental%20Rules/Central%20Administrative%20Tribunal%20Rules%20of%20Practice,1993.pdf',
    filename: 'cat_rules_of_practice_1993_thc.pdf',
    category: 'rules',
  },
  {
    name: 'Administrative Tribunals Act 1985 (CIS)',
    url: 'https://cis.cgat.gov.in/catlive/act/act.pdf',
    filename: 'administrative_tribunals_act_1985_cis.pdf',
    category: 'act',
  },
  {
    name: 'ATA Rules (DoPT)',
    url: 'https://dopt.gov.in/sites/default/files/ATA_Rules_01-B.pdf',
    filename: 'ata_rules_dopt.pdf',
    category: 'rules',
  },
  {
    name: 'CAT Preparation and Presentation Guide (CIS)',
    url: 'https://cis.cgat.gov.in/catlive/upload/PREPARATION%20AND%20PRESENTATION.pdf',
    filename: 'cat_preparation_and_presentation.pdf',
    category: 'guides',
  },
];

// ── Types ───────────────────────────────────────────────────────────────────

interface ModuleItem {
  id: number;
  subject: string;
  attachment?: string;
  date_of_issue?: string;
  module_type?: string;
  aad_file_hindi?: string;
  ref_bench: number;
  is_archieve?: number;
  created_at: string;
  updated_at: string;
}

interface NoticeItem {
  id: number;
  slug: string;
  title: string;
  summery?: string;
  description?: string;
  from_date: string;
  to_date?: string;
  aad_file?: string;
  aad_file_hindi?: string;
  ref_bench: number;
  is_archieve?: number;
  vel_categories_id: number;
  created_at: string;
  updated_at: string;
}

interface DownloadResult {
  category: string;
  title: string;
  url: string;
  filename: string;
  size: number;
  success: boolean;
  error?: string;
}

interface Stats {
  totalItems: number;
  totalPdfs: number;
  downloaded: number;
  failed: number;
  skipped: number;
  totalBytes: number;
}

// ── CryptoJS-compatible AES Decryption ──────────────────────────────────────

function decryptCryptoJS(ciphertext: string, passphrase: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  // CryptoJS format: "Salted__" (8 bytes) + salt (8 bytes) + encrypted data
  const salt = buf.subarray(8, 16);
  const encrypted = buf.subarray(16);

  // EVP_BytesToKey (MD5-based key derivation, CryptoJS default)
  let derivedBytes = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derivedBytes.length < 48) {
    block = crypto
      .createHash('md5')
      .update(Buffer.concat([block, Buffer.from(passphrase), salt]))
      .digest();
    derivedBytes = Buffer.concat([derivedBytes, block]);
  }

  const key = derivedBytes.subarray(0, 32);
  const iv = derivedBytes.subarray(32, 48);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

function decryptApiResponse<T>(encrypted: string): T {
  const json = decryptCryptoJS(encrypted, CRYPTO_KEY);
  return JSON.parse(json);
}

// ── API Calls ───────────────────────────────────────────────────────────────

async function fetchModules(benchId: number, moduleType: string): Promise<ModuleItem[]> {
  const url = `${BASE_URL}/get-modules/${benchId}/${moduleType}`;
  try {
    const resp = await fetch(url, { headers: API_HEADERS });
    if (!resp.ok) return [];
    const encrypted = await resp.text();
    if (!encrypted || encrypted.length < 50) return [];
    const data = decryptApiResponse<{ status: boolean; data: ModuleItem[] }>(encrypted);
    return data.status && data.data ? data.data : [];
  } catch (err) {
    console.error(`  Failed to fetch ${moduleType} for bench ${benchId}:`, err);
    return [];
  }
}

async function fetchNotices(benchId: number): Promise<NoticeItem[]> {
  const url = `${BASE_URL}/get-notice/${benchId}`;
  try {
    const resp = await fetch(url, { headers: API_HEADERS });
    if (!resp.ok) return [];
    const encrypted = await resp.text();
    if (!encrypted || encrypted.length < 50) return [];
    const data = decryptApiResponse<{ status: boolean; data: NoticeItem[] }>(encrypted);
    return data.status && data.data ? data.data : [];
  } catch (err) {
    console.error(`  Failed to fetch notices for bench ${benchId}:`, err);
    return [];
  }
}

// ── PDF Download ────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\-. ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 120);
}

async function downloadPdf(
  url: string,
  outputPath: string,
): Promise<{ size: number; success: boolean; error?: string }> {
  try {
    // Skip if already exists
    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.size > 1000) {
        return { size: stat.size, success: true };
      }
    }

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaquillBot/1.0)' },
      redirect: 'follow',
    });

    if (!resp.ok) {
      return { size: 0, success: false, error: `HTTP ${resp.status}` };
    }

    const buffer = Buffer.from(await resp.arrayBuffer());

    // Verify it's a PDF
    if (buffer.length < 100) {
      return { size: 0, success: false, error: 'Too small' };
    }

    const header = buffer.subarray(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      // Might be HTML error page
      return { size: 0, success: false, error: 'Not a PDF' };
    }

    fs.writeFileSync(outputPath, buffer);
    return { size: buffer.length, success: true };
  } catch (err) {
    return {
      size: 0,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main Scraper ────────────────────────────────────────────────────────────

async function scrapeModuleType(
  benchId: number,
  moduleType: string,
  queue: PQueue,
  stats: Stats,
): Promise<DownloadResult[]> {
  console.log(`\n📂 Fetching ${moduleType} (bench ${benchId})...`);
  const items = await fetchModules(benchId, moduleType);
  console.log(`   Found ${items.length} items`);
  stats.totalItems += items.length;

  const results: DownloadResult[] = [];
  const dir = path.join(OUTPUT_DIR, moduleType);
  fs.mkdirSync(dir, { recursive: true });

  for (const item of items) {
    const urls = (item.attachment || '').split(',').filter((u) => u.trim().endsWith('.pdf'));

    if (urls.length === 0) {
      stats.skipped++;
      continue;
    }

    stats.totalPdfs += urls.length;

    for (const pdfUrl of urls) {
      const trimmedUrl = pdfUrl.trim();
      const urlFilename = path.basename(new URL(trimmedUrl).pathname);
      const safeName = sanitizeFilename(`${item.id}_${item.subject || urlFilename}`);
      const ext = urlFilename.endsWith('.doc') ? '.doc' : '.pdf';
      const outputPath = path.join(dir, `${safeName}${ext}`);

      queue.add(async () => {
        const result = await downloadPdf(trimmedUrl, outputPath);
        if (result.success) {
          stats.downloaded++;
          stats.totalBytes += result.size;
          console.log(`   ✅ ${safeName}${ext} (${(result.size / 1024).toFixed(0)} KB)`);
        } else {
          stats.failed++;
          console.log(`   ❌ ${safeName}${ext}: ${result.error}`);
        }
        results.push({
          category: moduleType,
          title: item.subject || '',
          url: trimmedUrl,
          filename: `${safeName}${ext}`,
          size: result.size,
          success: result.success,
          error: result.error,
        });
        await new Promise((r) => setTimeout(r, DELAY_MS));
      });
    }
  }

  return results;
}

async function scrapeNotices(
  benchId: number,
  benchName: string,
  queue: PQueue,
  stats: Stats,
): Promise<DownloadResult[]> {
  console.log(`\n📋 Fetching notices (bench ${benchId} - ${benchName})...`);
  const items = await fetchNotices(benchId);
  const withPdf = items.filter((i) => i.aad_file);
  console.log(`   Found ${items.length} notices (${withPdf.length} with PDFs)`);
  stats.totalItems += items.length;
  stats.totalPdfs += withPdf.length;

  const results: DownloadResult[] = [];
  const dir = path.join(OUTPUT_DIR, 'notices', benchName);
  fs.mkdirSync(dir, { recursive: true });

  for (const item of withPdf) {
    const pdfUrl = item.aad_file!;
    const urlFilename = path.basename(new URL(pdfUrl).pathname);
    const datePrefix = item.from_date ? item.from_date.replace(/-/g, '') : 'undated';
    const safeName = sanitizeFilename(`${datePrefix}_${item.id}_${item.title || urlFilename}`);
    const outputPath = path.join(dir, `${safeName}.pdf`);

    queue.add(async () => {
      const result = await downloadPdf(pdfUrl, outputPath);
      if (result.success) {
        stats.downloaded++;
        stats.totalBytes += result.size;
      } else {
        stats.failed++;
        if (result.error !== 'Not a PDF') {
          console.log(`   ❌ ${safeName}: ${result.error}`);
        }
      }
      results.push({
        category: `notices/${benchName}`,
        title: item.title || '',
        url: pdfUrl,
        filename: `${safeName}.pdf`,
        size: result.size,
        success: result.success,
        error: result.error,
      });
      await new Promise((r) => setTimeout(r, DELAY_MS));
    });
  }

  return results;
}

async function scrapeExternalSources(queue: PQueue, stats: Stats): Promise<DownloadResult[]> {
  console.log('\n🌐 Downloading from external government sources...');
  const results: DownloadResult[] = [];
  const dir = path.join(OUTPUT_DIR, 'external');
  fs.mkdirSync(dir, { recursive: true });

  for (const source of EXTERNAL_SOURCES) {
    stats.totalPdfs++;
    const outputPath = path.join(dir, source.filename);

    queue.add(async () => {
      console.log(`   ⬇️  ${source.name}`);
      const result = await downloadPdf(source.url, outputPath);
      if (result.success) {
        stats.downloaded++;
        stats.totalBytes += result.size;
        console.log(`   ✅ ${source.filename} (${(result.size / 1024).toFixed(0)} KB)`);
      } else {
        stats.failed++;
        console.log(`   ❌ ${source.filename}: ${result.error}`);
      }
      results.push({
        category: source.category,
        title: source.name,
        url: source.url,
        filename: source.filename,
        size: result.size,
        success: result.success,
        error: result.error,
      });
      await new Promise((r) => setTimeout(r, DELAY_MS));
    });
  }

  return results;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' CAT Acts/Rules/Notices/Forms Scraper');
  console.log(' Source: cgat.gov.in (AES-encrypted API)');
  console.log('═══════════════════════════════════════════════════════════');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const queue = new PQueue({ concurrency: PDF_CONCURRENCY });
  const stats: Stats = {
    totalItems: 0,
    totalPdfs: 0,
    downloaded: 0,
    failed: 0,
    skipped: 0,
    totalBytes: 0,
  };

  const allResults: DownloadResult[] = [];

  // Phase 1: Module types from Principal Bench (benchId=20)
  console.log('\n━━━ Phase 1: Acts, Rules, Forms from Principal Bench ━━━');
  for (const moduleType of ['act', 'rule', 'forms']) {
    const results = await scrapeModuleType(BENCH_ID, moduleType, queue, stats);
    allResults.push(...results);
  }

  // Phase 2: Notices/Circulars from all benches
  console.log('\n━━━ Phase 2: Notices/Circulars from all benches ━━━');
  for (const [benchName, benchId] of Object.entries(ALL_BENCH_IDS)) {
    const results = await scrapeNotices(benchId, benchName, queue, stats);
    allResults.push(...results);
  }

  // Phase 3: External sources (THC, DoPT, CIS)
  console.log('\n━━━ Phase 3: External government sources ━━━');
  const extResults = await scrapeExternalSources(queue, stats);
  allResults.push(...extResults);

  // Wait for all downloads to complete
  console.log('\n⏳ Waiting for all downloads to complete...');
  await queue.onIdle();

  // Save metadata
  const metadataPath = path.join(OUTPUT_DIR, 'metadata.json');
  const metadata = {
    scraped_at: new Date().toISOString(),
    source: 'cgat.gov.in',
    api_base: BASE_URL,
    crypto_key: CRYPTO_KEY,
    stats,
    items: allResults,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' SCRAPE COMPLETE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total items found:    ${stats.totalItems}`);
  console.log(`  Total PDFs:           ${stats.totalPdfs}`);
  console.log(`  Downloaded:           ${stats.downloaded}`);
  console.log(`  Failed:               ${stats.failed}`);
  console.log(`  Skipped (no PDF):     ${stats.skipped}`);
  console.log(`  Total size:           ${(stats.totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Metadata:             ${metadataPath}`);
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(console.error);
