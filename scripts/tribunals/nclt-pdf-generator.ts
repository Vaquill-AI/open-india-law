/**
 * NCLT Case Summary PDF Generator
 *
 * Converts NCLT e-filing JSONL records into professional legal-style PDFs.
 * Each PDF includes: case header, party details, hearing history, case status,
 * and a source attribution link to efiling.nclt.gov.in.
 *
 * Usage:
 *   npx tsx scripts/nclt-pdf-generator.ts --sample         # Generate 1 sample PDF
 *   npx tsx scripts/nclt-pdf-generator.ts --bench mumbai    # Generate for one bench
 *   npx tsx scripts/nclt-pdf-generator.ts                   # Generate all PDFs
 *   WORKERS=8 npx tsx scripts/nclt-pdf-generator.ts         # Parallel generation
 */

import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DATA_DIR = path.resolve(__dirname, '../data/tribunals/nclt');
const METADATA_DIR = path.join(DATA_DIR, 'metadata');
const PDF_DIR = path.join(DATA_DIR, 'pdfs');
const EFILING_BASE = 'https://efiling.nclt.gov.in';

// Colors
const NAVY = '#1a2744';
const DARK_GREY = '#333333';
const MEDIUM_GREY = '#555555';
const LIGHT_GREY = '#888888';
const ACCENT_BLUE = '#2c5282';
const BORDER_GREY = '#cccccc';
const BG_LIGHT = '#f7f8fa';
const STATUS_GREEN = '#276749';
const STATUS_RED = '#9b2c2c';
const STATUS_AMBER = '#975a16';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CaseRecord {
  filing_no: string;
  bench_id: string;
  bench_name: string;
  discovery_term: string;
  scraped_at: string;
  content_hash: string;
  search_result: Record<string, unknown>;
  detail_response: {
    partydetailslist?: Record<string, unknown>[];
    allproceedingdtls?: Record<string, unknown>[];
    allfinalstatuslist?: Record<string, unknown>[];
    allIADetailsList?: Record<string, unknown>[];
  };
}

interface Party {
  name: string;
  type: string;
  role: string;
  advocate: string;
  email: string;
  mobile: string;
}

interface Hearing {
  date: string;
  nextDate: string;
  purpose: string;
  action: string;
  courtNo: string;
  orderType: string;
  caseStatus: string;
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------
function cleanVal(val: unknown): string {
  if (val === null || val === undefined || val === 'NA' || val === 'none' || val === '') return '';
  const s = String(val).trim();
  return s === 'NA' ? '' : s;
}

function extractParties(record: CaseRecord): Party[] {
  const list = record.detail_response?.partydetailslist || [];
  return list
    .map((p) => ({
      name: cleanVal(p.party_name),
      type: cleanVal(p.party_type),
      role: (cleanVal(p.party_type) || '').startsWith('P') ? 'Petitioner' : 'Respondent',
      advocate: cleanVal(p.party_lawer_name),
      email: cleanVal(p.full_party_email) || cleanVal(p.party_email),
      mobile: cleanVal(p.full_party_mobile) || cleanVal(p.party_mobile),
    }))
    .filter((p) => p.name);
}

function extractHearings(record: CaseRecord): Hearing[] {
  const list = record.detail_response?.allproceedingdtls || [];
  return list
    .map((h) => ({
      date: cleanVal(h.listing_date),
      nextDate: cleanVal(h.next_list_date),
      purpose: cleanVal(h.purpose),
      action: cleanVal(h.today_action),
      courtNo: cleanVal(h.court_no),
      orderType: cleanVal(h.path_descr),
      caseStatus: cleanVal(h.case_status),
    }))
    .filter((h) => h.date);
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('disposed') || s.includes('closed') || s.includes('dismissed')) return STATUS_RED;
  if (s.includes('pending')) return STATUS_AMBER;
  if (s.includes('admitted') || s.includes('approved')) return STATUS_GREEN;
  return DARK_GREY;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  // Input: DD-MM-YYYY or DD-MM-YYYY HH:MM:SS
  const parts = dateStr.split(' ')[0].split('-');
  if (parts.length !== 3) return dateStr;
  const months = [
    '',
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const m = parseInt(parts[1], 10);
  return `${parts[0]} ${months[m] || parts[1]} ${parts[2]}`;
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------
async function generateCasePdf(record: CaseRecord, outputPath: string): Promise<void> {
  const sr = record.search_result;
  const parties = extractParties(record);
  const hearings = extractHearings(record);
  const finalStatus = record.detail_response?.allfinalstatuslist?.[0] || {};
  const ias = record.detail_response?.allIADetailsList || [];

  const caseNo = cleanVal(sr.case_no) || record.filing_no;
  const caseType = cleanVal(sr.case_type_desc_cis);
  const petitioner = cleanVal(sr.case_title1);
  const respondent = cleanVal(sr.case_title2);
  const benchName = cleanVal(sr.bench_location_name) || record.bench_name;
  const filingDate = cleanVal(sr.date_of_filing);
  const regDate = cleanVal(sr.regis_date);
  const status = cleanVal(sr.status) || cleanVal(finalStatus.case_status) || 'Unknown';
  const nextDate = cleanVal(sr.next_list_date);
  const benchNature = cleanVal(finalStatus.bench_nature_descr);
  const courtNo = cleanVal(finalStatus.court_no);
  const currentStatus = cleanVal(finalStatus.current_status)?.replace(/<br>/g, '\n');

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 55, right: 55 },
    info: {
      Title: `${caseNo} - ${petitioner} vs ${respondent}`,
      Author: 'Vaquill Legal Intelligence',
      Subject: `NCLT ${benchName} Bench - Case Record`,
      Creator: 'Vaquill NCLT PDF Generator',
    },
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // =========================================================================
  // HEADER - Court emblem style
  // =========================================================================

  // Top border line
  doc
    .moveTo(doc.page.margins.left, 45)
    .lineTo(doc.page.width - doc.page.margins.right, 45)
    .lineWidth(2)
    .strokeColor(NAVY)
    .stroke();

  doc.y = 55;

  // Court name
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(NAVY)
    .text('NATIONAL COMPANY LAW TRIBUNAL', { align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor(DARK_GREY)
    .text(`${benchName.toUpperCase()} BENCH`, { align: 'center' });

  if (benchNature) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(9)
      .fillColor(MEDIUM_GREY)
      .text(`(${benchNature}${courtNo ? `, Court No. ${courtNo}` : ''})`, { align: 'center' });
  }

  doc.moveDown(0.3);

  // Thin separator
  const sepY = doc.y;
  doc
    .moveTo(doc.page.margins.left + 80, sepY)
    .lineTo(doc.page.width - doc.page.margins.right - 80, sepY)
    .lineWidth(0.5)
    .strokeColor(BORDER_GREY)
    .stroke();

  doc.moveDown(0.5);

  // Case number - prominent
  doc.font('Helvetica-Bold').fontSize(12).fillColor(ACCENT_BLUE).text(caseNo, { align: 'center' });

  if (caseType) {
    doc.font('Helvetica').fontSize(9).fillColor(MEDIUM_GREY).text(caseType, { align: 'center' });
  }

  doc.moveDown(0.6);

  // =========================================================================
  // CASE TITLE - "X vs Y" style
  // =========================================================================

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(DARK_GREY)
    .text(petitioner || 'Unknown Petitioner', { align: 'center' });

  doc
    .font('Helvetica-Oblique')
    .fontSize(9)
    .fillColor(LIGHT_GREY)
    .text('versus', { align: 'center' });

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(DARK_GREY)
    .text(respondent || 'Unknown Respondent', { align: 'center' });

  doc.moveDown(0.8);

  // Double line separator
  const dblY = doc.y;
  doc
    .moveTo(doc.page.margins.left, dblY)
    .lineTo(doc.page.width - doc.page.margins.right, dblY)
    .lineWidth(1.5)
    .strokeColor(NAVY)
    .stroke();
  doc
    .moveTo(doc.page.margins.left, dblY + 3)
    .lineTo(doc.page.width - doc.page.margins.right, dblY + 3)
    .lineWidth(0.5)
    .strokeColor(NAVY)
    .stroke();

  doc.y = dblY + 12;

  // =========================================================================
  // CASE INFORMATION TABLE
  // =========================================================================

  sectionHeader(doc, 'CASE INFORMATION');

  const infoRows: [string, string][] = [
    ['Filing Number', record.filing_no],
    ['Case Number', caseNo],
    ['Case Type', caseType],
    ['Bench', `${benchName}${benchNature ? ` (${benchNature})` : ''}`],
    ['Date of Filing', formatDate(filingDate)],
    ['Date of Registration', formatDate(regDate)],
    ['Current Status', status],
    ['Next Listing Date', formatDate(nextDate)],
  ];

  if (currentStatus) {
    infoRows.push(['Stage', currentStatus]);
  }

  drawInfoTable(doc, infoRows, pageWidth, status);

  // =========================================================================
  // PARTIES
  // =========================================================================

  if (parties.length > 0) {
    checkPageBreak(doc, 100);
    sectionHeader(doc, 'PARTIES');

    const petitioners = parties.filter((p) => p.role === 'Petitioner');
    const respondents = parties.filter((p) => p.role === 'Respondent');

    if (petitioners.length > 0) {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(ACCENT_BLUE)
        .text('Petitioner(s):', { underline: false });
      doc.moveDown(0.2);

      for (const p of petitioners) {
        drawPartyBlock(doc, p, pageWidth);
      }
    }

    if (respondents.length > 0) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT_BLUE).text('Respondent(s):');
      doc.moveDown(0.2);

      for (const p of respondents) {
        drawPartyBlock(doc, p, pageWidth);
      }
    }
  }

  // =========================================================================
  // HEARING HISTORY (last 20)
  // =========================================================================

  if (hearings.length > 0) {
    checkPageBreak(doc, 120);
    sectionHeader(doc, `PROCEEDINGS HISTORY (${hearings.length} hearings)`);

    const displayHearings = hearings.slice(0, 20);

    // Table header
    const colWidths = [70, 70, 130, 130, 85];
    const headers = ['Date', 'Next Date', 'Purpose', 'Action', 'Order'];
    drawTableHeader(doc, headers, colWidths);

    for (let i = 0; i < displayHearings.length; i++) {
      checkPageBreak(doc, 25);
      const h = displayHearings[i];
      const row = [
        formatDate(h.date),
        formatDate(h.nextDate),
        h.purpose || '-',
        h.action || '-',
        h.orderType || '-',
      ];
      drawTableRow(doc, row, colWidths, i % 2 === 0);
    }

    if (hearings.length > 20) {
      doc.moveDown(0.3);
      doc.x = doc.page.margins.left;
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(LIGHT_GREY)
        .text(
          `... and ${hearings.length - 20} earlier hearings (see e-filing portal for complete history)`,
          doc.page.margins.left,
          doc.y,
          { align: 'center', width: pageWidth },
        );
    }
  }

  // =========================================================================
  // INTERLOCUTORY APPLICATIONS
  // =========================================================================

  if (ias.length > 0) {
    checkPageBreak(doc, 80);
    sectionHeader(doc, `INTERLOCUTORY APPLICATIONS (${ias.length})`);

    const iaColWidths = [120, 100, 100, 165];
    const iaHeaders = ['IA Number', 'Filed Date', 'Status', 'Purpose'];
    drawTableHeader(doc, iaHeaders, iaColWidths);

    for (let i = 0; i < Math.min(ias.length, 15); i++) {
      checkPageBreak(doc, 25);
      const ia = ias[i];
      const row = [
        cleanVal(ia.case_no) || cleanVal(ia.filing_no) || '-',
        formatDate(cleanVal(ia.date_of_filing)),
        cleanVal(ia.case_status) || cleanVal(ia.status) || '-',
        cleanVal(ia.purpose) || '-',
      ];
      drawTableRow(doc, row, iaColWidths, i % 2 === 0);
    }

    if (ias.length > 15) {
      doc.moveDown(0.3);
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(LIGHT_GREY)
        .text(`... and ${ias.length - 15} more IAs`, { align: 'center' });
    }
  }

  // =========================================================================
  // FOOTER
  // =========================================================================

  // Reset x position (tables can shift it) and ensure enough space
  const footerLeft = doc.page.margins.left;
  const footerWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  checkPageBreak(doc, 140);
  doc.moveDown(1.5);
  doc.x = footerLeft;

  // Separator
  const footSepY = doc.y;
  doc
    .moveTo(footerLeft, footSepY)
    .lineTo(doc.page.width - doc.page.margins.right, footSepY)
    .lineWidth(0.5)
    .strokeColor(BORDER_GREY)
    .stroke();

  doc.y = footSepY + 8;

  // Source attribution
  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(MEDIUM_GREY)
    .text('SOURCE & VERIFICATION', footerLeft, doc.y, { width: footerWidth });

  doc.moveDown(0.2);

  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor(LIGHT_GREY)
    .text(`Data Source: NCLT E-Filing Portal (${EFILING_BASE})`, footerLeft, doc.y, {
      width: footerWidth,
    })
    .text(`Filing Number: ${record.filing_no}`, footerLeft, doc.y, { width: footerWidth })
    .text(
      `Scraped: ${new Date(record.scraped_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
      footerLeft,
      doc.y,
      { width: footerWidth },
    )
    .text(`Content Hash: ${record.content_hash}`, footerLeft, doc.y, { width: footerWidth });

  doc.moveDown(0.3);

  doc
    .font('Helvetica-Oblique')
    .fontSize(7)
    .fillColor(LIGHT_GREY)
    .text(
      'This document is a formatted summary generated by Vaquill Legal Intelligence from publicly available ' +
        'data on the NCLT E-Filing Portal. It is not an official court document. Verify all information at ' +
        `${EFILING_BASE} using the filing number above.`,
      footerLeft,
      doc.y,
      { align: 'justify', width: footerWidth },
    );

  doc.moveDown(0.5);

  // Vaquill branding
  doc
    .font('Helvetica-Bold')
    .fontSize(7)
    .fillColor(ACCENT_BLUE)
    .text('Vaquill Legal Intelligence', footerLeft, doc.y, {
      align: 'center',
      width: footerWidth,
      link: 'https://vaquill.com',
    });

  doc
    .font('Helvetica')
    .fontSize(6.5)
    .fillColor(LIGHT_GREY)
    .text('AI-Powered Legal Research & Case Intelligence', footerLeft, doc.y, {
      align: 'center',
      width: footerWidth,
    });

  doc.end();

  return new Promise<void>((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function sectionHeader(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.6);

  const y = doc.y;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  // Background bar
  doc.rect(left, y - 2, right - left, 18).fill(NAVY);

  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor('#ffffff')
    .text(title, left + 8, y + 1);

  doc.y = y + 22;
  doc.fillColor(DARK_GREY);
}

function drawInfoTable(
  doc: PDFKit.PDFDocument,
  rows: [string, string][],
  pageWidth: number,
  status: string,
): void {
  const labelWidth = 140;
  const left = doc.page.margins.left;

  for (const [label, value] of rows) {
    if (!value) continue;
    const y = doc.y;

    doc
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(MEDIUM_GREY)
      .text(`${label}:`, left + 8, y, { width: labelWidth });

    if (label === 'Current Status') {
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(statusColor(status))
        .text(value.toUpperCase(), left + labelWidth + 8, y, {
          width: pageWidth - labelWidth - 16,
        });
    } else {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(DARK_GREY)
        .text(value, left + labelWidth + 8, y, { width: pageWidth - labelWidth - 16 });
    }

    doc.y = Math.max(doc.y, y + 14);
  }
}

function drawPartyBlock(doc: PDFKit.PDFDocument, party: Party, pageWidth: number): void {
  const left = doc.page.margins.left;

  doc
    .font('Helvetica-Bold')
    .fontSize(8.5)
    .fillColor(DARK_GREY)
    .text(`  ${party.type}. ${party.name}`, left);

  if (party.advocate) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(8)
      .fillColor(MEDIUM_GREY)
      .text(`      Advocate: ${party.advocate}`, left);
  }

  doc.moveDown(0.15);
}

function drawTableHeader(doc: PDFKit.PDFDocument, headers: string[], colWidths: number[]): void {
  const left = doc.page.margins.left;
  const y = doc.y;

  doc
    .rect(
      left,
      y - 1,
      colWidths.reduce((a, b) => a + b, 0),
      16,
    )
    .fill(ACCENT_BLUE);

  let x = left + 4;
  for (let i = 0; i < headers.length; i++) {
    doc
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .fillColor('#ffffff')
      .text(headers[i], x, y + 2, { width: colWidths[i] - 8 });
    x += colWidths[i];
  }

  doc.y = y + 18;
  doc.fillColor(DARK_GREY);
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  cells: string[],
  colWidths: number[],
  isEven: boolean,
): void {
  const left = doc.page.margins.left;
  const y = doc.y;
  const rowHeight = 14;

  if (isEven) {
    doc
      .rect(
        left,
        y - 1,
        colWidths.reduce((a, b) => a + b, 0),
        rowHeight,
      )
      .fill(BG_LIGHT);
  }

  let x = left + 4;
  for (let i = 0; i < cells.length; i++) {
    const text = cells[i].length > 35 ? cells[i].substring(0, 33) + '..' : cells[i];
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor(DARK_GREY)
      .text(text, x, y + 2, { width: colWidths[i] - 8 });
    x += colWidths[i];
  }

  doc.y = y + rowHeight;
}

function checkPageBreak(doc: PDFKit.PDFDocument, needed: number): void {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const isSample = process.argv.includes('--sample');
  const benchArg = process.argv.find((a, i) => process.argv[i - 1] === '--bench');

  // Ensure output directory
  fs.mkdirSync(PDF_DIR, { recursive: true });

  if (isSample) {
    // Generate one sample PDF from the richest case we found
    const lines = fs
      .readFileSync(path.join(METADATA_DIR, 'mumbai-cases.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean);

    let best: CaseRecord | null = null;
    let bestScore = 0;

    for (let i = 0; i < Math.min(lines.length, 300); i++) {
      const r: CaseRecord = JSON.parse(lines[i]);
      const det = r.detail_response || {};
      const parties = (det.partydetailslist || []).length;
      const hearings = (det.allproceedingdtls || []).length;
      const iaCount = (det.allIADetailsList || []).length;
      const score = parties + hearings * 2 + iaCount * 3;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }

    if (!best) {
      console.error('No cases found');
      process.exit(1);
    }

    const outFile = path.join(PDF_DIR, `SAMPLE-${best.filing_no}.pdf`);
    console.log(`Generating sample PDF: ${outFile}`);
    console.log(`Case: ${cleanVal(best.search_result.case_no)}`);
    console.log(
      `Title: ${cleanVal(best.search_result.case_title1)} vs ${cleanVal(best.search_result.case_title2)}`,
    );

    await generateCasePdf(best, outFile);
    console.log(`Done! Output: ${outFile}`);
    return;
  }

  // Full generation mode
  const files = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('-cases.jsonl'));
  const targetFiles = benchArg ? files.filter((f) => f.startsWith(benchArg.toLowerCase())) : files;

  if (targetFiles.length === 0) {
    console.error(`No JSONL files found${benchArg ? ` for bench "${benchArg}"` : ''}`);
    process.exit(1);
  }

  let totalGenerated = 0;
  let totalSkipped = 0;

  for (const file of targetFiles) {
    const benchName = file.replace('-cases.jsonl', '');
    const benchPdfDir = path.join(PDF_DIR, benchName);
    fs.mkdirSync(benchPdfDir, { recursive: true });

    // Stream JSONL line by line to avoid OOM on large files
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(METADATA_DIR, file)),
      crlfDelay: Infinity,
    });

    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      const record: CaseRecord = JSON.parse(line);
      const caseNo = cleanVal(record.search_result.case_no) || record.filing_no;
      const safeName = caseNo.replace(/[/\\:*?"<>|]/g, '_');
      const outFile = path.join(benchPdfDir, `${safeName}.pdf`);

      if (fs.existsSync(outFile)) {
        totalSkipped++;
        continue;
      }

      await generateCasePdf(record, outFile);
      totalGenerated++;

      if (totalGenerated % 500 === 0) {
        console.log(
          `  [${benchName}] ${lineCount} lines, ${totalGenerated} generated, ${totalSkipped} skipped`,
        );
      }
    }

    console.log(`  [${benchName}] Done - ${lineCount} cases (${totalSkipped} skipped)`);
  }

  console.log(`\nTotal PDFs generated: ${totalGenerated}`);
  console.log(`Total skipped (already exist): ${totalSkipped}`);
  console.log(`Output directory: ${PDF_DIR}`);
}

main().catch(console.error);
