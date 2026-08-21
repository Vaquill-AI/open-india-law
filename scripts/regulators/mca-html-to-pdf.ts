/**
 * MCA HTML-to-PDF Converter
 * Converts MCA Acts and Rules (stored as HTML in the ebook system) to professional legal PDFs.
 *
 * MCA's DMS returns Acts/Rules as structured HTML, not PDFs. This script:
 *   1. Reads the existing metadata JSONL for acts/rules
 *   2. Fetches each document's HTML via Playwright (headed mode to bypass Akamai)
 *   3. Wraps in professional legal-style HTML template
 *   4. Renders to PDF using Playwright's page.pdf()
 *
 * Usage:
 *   HEADED=true npx tsx scripts/mca-html-to-pdf.ts                    # All acts + rules
 *   HEADED=true npx tsx scripts/mca-html-to-pdf.ts --category acts    # Acts only
 *   HEADED=true npx tsx scripts/mca-html-to-pdf.ts --category rules   # Rules only
 *   HEADED=true npx tsx scripts/mca-html-to-pdf.ts --test             # First 5 only
 *   HEADED=true npx tsx scripts/mca-html-to-pdf.ts --force            # Re-generate all (ignore done list)
 *
 * Environment:
 *   HEADED=true         Required for Akamai bypass (default: false)
 *   DELAY_MS=1000       Delay between page loads (default: 1000)
 */

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://www.mca.gov.in';
const DOCUMENT_API = '/bin/ebook/dms/getdocument';
const DELAY_MS = parseInt(process.env.DELAY_MS || '1000', 10);
const MAX_RETRIES = 3;

const DATA_DIR = 'data/regulatory/mca';
const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
const JSONL_FILE = path.join(DATA_DIR, 'mca-all-documents.jsonl');
const PDF_DONE_FILE = path.join(DATA_DIR, 'html-pdfs-generated.txt');

// ─── Types ───────────────────────────────────────────────────────────────────

interface McaDocument {
  docId: string;
  docName: string;
  docGroup: string;
  shortDescription: string;
  category_slug: string;
  link: string;
  notificationDate: string;
  version: string;
  pdf_url: string;
  pdf_filename: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  log('Shutting down gracefully...');
});
process.on('SIGTERM', () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
});

// Track completed PDFs
const doneSet = new Set<string>();

function initDone(): void {
  if (fs.existsSync(PDF_DONE_FILE)) {
    for (const line of fs.readFileSync(PDF_DONE_FILE, 'utf-8').split('\n')) {
      if (line) doneSet.add(line);
    }
  }
}

function markDone(filename: string): void {
  if (!doneSet.has(filename)) {
    doneSet.add(filename);
    fs.appendFileSync(PDF_DONE_FILE, filename + '\n');
  }
}

// ─── Legal PDF Template ──────────────────────────────────────────────────────

function buildLegalHtml(doc: McaDocument, bodyContent: string): string {
  const generatedDate = new Date().toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const categoryLabel = doc.category_slug === 'acts' ? 'Act' : 'Rule';
  const docTitle = escapeHtml(doc.docName || doc.shortDescription || 'MCA Document');
  const docGroup = escapeHtml(doc.docGroup || '');
  const notifDate = doc.notificationDate || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${docTitle}</title>
  <style>
    @page {
      size: A4;
      margin: 22mm 18mm 25mm 18mm;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: "Georgia", "Times New Roman", "Noto Serif", serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #1a1a1a;
      background: #fff;
    }

    /* ===== DOCUMENT HEADER ===== */
    .doc-header {
      text-align: center;
      padding-bottom: 15px;
      margin-bottom: 20px;
      border-bottom: 3px double #1a3a5c;
    }

    .govt-name {
      font-size: 11pt;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: #1a3a5c;
      margin-bottom: 4px;
    }

    .ministry-name {
      font-size: 13pt;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: #0d2137;
      text-transform: uppercase;
      margin-bottom: 2px;
    }

    .category-badge {
      display: inline-block;
      font-size: 8pt;
      font-weight: 600;
      padding: 2px 12px;
      border-radius: 2px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      background: #1a3a5c;
      color: #fff;
      margin: 8px 0;
    }

    .doc-title {
      font-size: 16pt;
      font-weight: 700;
      color: #0d2137;
      margin: 12px 0 6px 0;
      line-height: 1.3;
    }

    .doc-group {
      font-size: 10pt;
      color: #555;
      font-style: italic;
      margin-bottom: 4px;
    }

    .doc-meta {
      font-size: 9pt;
      color: #777;
      margin-top: 8px;
    }

    .doc-meta span {
      margin: 0 8px;
    }

    .separator {
      width: 200px;
      height: 1px;
      background: linear-gradient(90deg, transparent, #c9a227, transparent);
      margin: 10px auto;
    }

    /* ===== CONTENT BODY ===== */
    .content-body {
      margin-top: 20px;
    }

    /* MCA-specific content styles */
    .content-body h1 {
      font-size: 16pt;
      font-weight: 700;
      color: #0d2137;
      text-align: center;
      margin: 20px 0 10px 0;
      line-height: 1.3;
    }

    .content-body h2 {
      font-size: 13pt;
      font-weight: 700;
      color: #1a3a5c;
      margin: 18px 0 8px 0;
      padding-bottom: 4px;
      border-bottom: 1px solid #e0e0e0;
    }

    .content-body h3 {
      font-size: 12pt;
      font-weight: 700;
      color: #333;
      margin: 14px 0 6px 0;
    }

    .content-body p {
      font-size: 11pt;
      line-height: 1.65;
      margin: 6px 0;
      text-align: justify;
      hyphens: auto;
    }

    .content-body table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0;
      font-size: 10pt;
    }

    .content-body td, .content-body th {
      border: 1px solid #bbb;
      padding: 6px 10px;
      vertical-align: top;
      line-height: 1.4;
    }

    .content-body th {
      background: #f0f0f0;
      font-weight: 700;
      color: #1a3a5c;
      text-align: left;
    }

    .content-body tr:nth-child(even) td {
      background: #fafaf8;
    }

    .content-body a {
      color: #2c5282;
      text-decoration: none;
    }

    .content-body em, .content-body i {
      font-style: italic;
    }

    .content-body strong, .content-body b {
      font-weight: 700;
    }

    .content-body sup {
      font-size: 7pt;
      vertical-align: super;
    }

    .content-body ol, .content-body ul {
      margin: 8px 0 8px 25px;
    }

    .content-body li {
      margin-bottom: 4px;
      line-height: 1.5;
    }

    /* MCA ebook-specific class styles */
    .content-body .indent_llpa,
    .content-body .indentcl,
    .content-body .ci_llpa {
      margin: 6px 0;
      text-align: justify;
    }

    .content-body .ch_llpa {
      font-size: 13pt;
      font-weight: 700;
      text-align: center;
      margin: 20px 0 6px 0;
      color: #1a3a5c;
      text-transform: uppercase;
    }

    .content-body .hd_llpa {
      font-size: 12pt;
      font-weight: 700;
      text-align: center;
      margin-bottom: 12px;
      color: #333;
    }

    .content-body .actDetails {
      margin: 12px 0;
      padding: 10px 15px;
      background: #fafaf8;
      border-left: 3px solid #c9a227;
    }

    .content-body .greeno { color: #2e7d32; }
    .content-body .browno { color: #8b4513; }
    .content-body .blueo { color: #1565c0; }
    .content-body .red { color: #c62828; }

    /* Color legend for amendments */
    .content-body .c1 {
      text-decoration: none;
    }

    /* Section numbering */
    .content-body .indent_llpa strong:first-child {
      color: #0d2137;
    }

    /* Footnotes */
    .content-body .footnote,
    .content-body [id^="fn"] {
      font-size: 9pt;
      color: #555;
      margin-top: 15px;
      padding-top: 8px;
      border-top: 1px solid #ddd;
    }

    /* ===== FOOTER ===== */
    .doc-footer {
      margin-top: 30px;
      padding-top: 12px;
      border-top: 1px solid #ddd;
      text-align: center;
    }

    .footer-source {
      font-size: 8pt;
      color: #999;
      margin-bottom: 4px;
    }

    .footer-disclaimer {
      font-size: 7.5pt;
      color: #bbb;
      font-style: italic;
      max-width: 450px;
      margin: 0 auto;
      line-height: 1.4;
    }

    .footer-brand {
      font-size: 7.5pt;
      font-weight: 700;
      color: #2c5282;
      margin-top: 8px;
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>

  <!-- DOCUMENT HEADER -->
  <div class="doc-header">
    <div class="govt-name">Government of India</div>
    <div class="ministry-name">Ministry of Corporate Affairs</div>
    <div class="category-badge">${categoryLabel}</div>
    <div class="doc-title">${docTitle}</div>
    ${docGroup ? `<div class="doc-group">Under: ${docGroup}</div>` : ''}
    <div class="separator"></div>
    <div class="doc-meta">
      ${notifDate ? `<span>Date: ${escapeHtml(notifDate)}</span>` : ''}
      ${doc.version ? `<span>Version: ${escapeHtml(doc.version)}</span>` : ''}
      <span>Source: mca.gov.in</span>
    </div>
  </div>

  <!-- CONTENT -->
  <div class="content-body">
    ${bodyContent}
  </div>

  <!-- FOOTER -->
  <div class="doc-footer">
    <div class="footer-source">
      Source: Ministry of Corporate Affairs, Government of India &mdash; mca.gov.in<br/>
      Document ID: ${escapeHtml(doc.docId)} | Generated: ${generatedDate}
    </div>
    <div class="footer-disclaimer">
      This document has been extracted from the official MCA e-Book system for research
      and reference purposes. Verify all provisions at mca.gov.in for the authoritative version.
    </div>
    <div class="footer-brand">Vaquill Legal Intelligence</div>
  </div>

</body>
</html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const testMode = args.includes('--test');
  const forceMode = args.includes('--force');
  let categoryFilter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--category' && args[i + 1]) {
      categoryFilter = args[i + 1];
    }
  }

  const targetCategories = categoryFilter ? [categoryFilter] : ['acts', 'rules'];

  // Ensure dirs
  for (const cat of targetCategories) {
    fs.mkdirSync(path.join(PDFS_DIR, cat), { recursive: true });
  }

  if (!forceMode) {
    initDone();
  }

  // Load documents from JSONL
  const docs: McaDocument[] = [];
  if (!fs.existsSync(JSONL_FILE)) {
    log('No JSONL file found. Run mca-scraper.ts --metadata-only first.');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const doc = JSON.parse(line) as McaDocument;
      if (!targetCategories.includes(doc.category_slug)) continue;
      if (!doc.link && !doc.pdf_url) continue;

      if (!forceMode) {
        const pdfPath = path.join(PDFS_DIR, doc.category_slug, doc.pdf_filename);
        if (doneSet.has(doc.pdf_filename) || fs.existsSync(pdfPath)) {
          continue;
        }
      }

      docs.push(doc);
    } catch {
      /* skip */
    }
  }

  const total = testMode ? Math.min(5, docs.length) : docs.length;
  log(`\nMCA HTML-to-PDF Converter (Legal Style)`);
  log(`  Categories: ${targetCategories.join(', ')}`);
  log(`  Documents to convert: ${total} (${docs.length} total, ${doneSet.size} already done)`);
  log(`  Test mode: ${testMode}, Force: ${forceMode}`);

  if (total === 0) {
    log('  Nothing to convert.');
    return;
  }

  // Launch browser
  const useHeaded = process.env.HEADED === 'true' || process.env.HEADED === '1';
  log(`  Launching Playwright (${useHeaded ? 'headed' : 'headless'})...`);

  const browser = await chromium.launch({
    headless: !useHeaded,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1200, height: 900 },
    });

    const page = await context.newPage();

    // Establish Akamai session
    log('  Establishing session...');
    await page.goto(`${BASE_URL}/content/mca/global/en/acts-rules/ebooks/acts.html`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    const title = await page.title();
    log(`  Page title: ${title}`);

    if (title.includes('Access Denied')) {
      log('  Waiting for Akamai challenge...');
      await sleep(10000);
      await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
      const title2 = await page.title();
      log(`  After reload: ${title2}`);
      if (title2.includes('Access Denied')) {
        log('  ERROR: Cannot bypass Akamai. Try with HEADED=true');
        return;
      }
    }

    await sleep(3000);

    // Use a second page for PDF rendering (keeps Akamai session on first page)
    const renderPage = await context.newPage();

    let converted = 0;
    let failed = 0;
    const startTime = Date.now();

    for (let i = 0; i < total; i++) {
      if (shuttingDown) break;

      const doc = docs[i];
      const pdfPath = path.join(PDFS_DIR, doc.category_slug, doc.pdf_filename);
      const docUrl = doc.link
        ? `${BASE_URL}${DOCUMENT_API}?doc=${Buffer.from(doc.link).toString('base64')}&docCategory=${encodeURIComponent(doc.category_slug === 'acts' ? 'Acts' : 'Rules')}&type=open`
        : `${BASE_URL}${doc.pdf_url}`;

      await sleep(DELAY_MS);

      let success = false;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // Fetch the raw HTML content using the Akamai session page's context
          const htmlContent = await page.evaluate(async (url: string) => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.text();
          }, docUrl);

          if (!htmlContent || htmlContent.length < 50) {
            if (attempt < MAX_RETRIES - 1) {
              await sleep(2000);
              continue;
            }
            break;
          }

          if (htmlContent.includes('Access Denied') || htmlContent.includes('Error 403')) {
            if (attempt < MAX_RETRIES - 1) {
              await sleep(5000);
              continue;
            }
            break;
          }

          // Build professional legal-style HTML wrapping the content
          const fullHtml = buildLegalHtml(doc, htmlContent);

          // Render the HTML in the render page
          await renderPage.setContent(fullHtml, {
            waitUntil: 'networkidle',
            timeout: 15000,
          });

          await sleep(300);

          // Generate PDF
          const tmpPath = `${pdfPath}.tmp`;
          await renderPage.pdf({
            path: tmpPath,
            format: 'A4',
            printBackground: true,
            margin: { top: '22mm', bottom: '25mm', left: '18mm', right: '18mm' },
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: `
              <div style="width:100%; font-size:8pt; font-family:Georgia,serif; padding:0 18mm; display:flex; justify-content:space-between; color:#888;">
                <span>${escapeHtml(doc.docName?.slice(0, 50) || 'MCA Document')} | MCA</span>
                <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
              </div>
            `,
          });

          // Verify the PDF is valid
          const stats = fs.statSync(tmpPath);
          if (stats.size < 500) {
            fs.unlinkSync(tmpPath);
            if (attempt < MAX_RETRIES - 1) continue;
            break;
          }

          // Atomic rename
          fs.renameSync(tmpPath, pdfPath);
          converted++;
          markDone(doc.pdf_filename);
          success = true;

          if (converted % 25 === 0 || converted === 1) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = converted / elapsed;
            const remaining = total - converted - failed;
            const etaMin = rate > 0 ? Math.ceil(remaining / rate / 60) : 0;
            log(
              `  [${((converted / total) * 100).toFixed(1)}%] ${converted}/${total} converted, ${failed} failed, ${rate.toFixed(1)}/s, ETA: ${etaMin}m`,
            );
          }

          break;
        } catch (err) {
          if (attempt < MAX_RETRIES - 1) {
            await sleep(3000);
          }
        }
      }

      if (!success) {
        failed++;
        if (failed <= 5) {
          log(`  Failed: ${doc.docName?.slice(0, 60)} (${doc.docId})`);
        }
      }
    }

    log(`\n  Complete: ${converted} converted to PDF, ${failed} failed`);

    await renderPage.close();
    await page.close();
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
