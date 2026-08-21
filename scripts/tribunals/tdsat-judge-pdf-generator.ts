/**
 * TDSAT Judge & Member Profiles — Professional Legal PDF Generator
 *
 * Generates a formal, legal-proceeding-style PDF compendium of all
 * TDSAT Chairpersons and Members with proper formatting, headers,
 * Ashoka Pillar emblem, and structured biographical sections.
 *
 * Usage:
 *   npx tsx scripts/tdsat-judge-pdf-generator.ts
 *
 * Output:
 *   data/tdsat/judges/TDSAT_Bench_Profiles.pdf
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface JudgeProfile {
  name: string;
  role: string;
  tenure_from: string;
  tenure_to: string;
  biography: string;
  source_page: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(raw: string): string {
  if (!raw) return 'Present';
  const parts = raw.split('-');
  if (parts.length !== 3) return raw;
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const [dd, mm, yyyy] = parts;
  const monthIdx = parseInt(mm, 10) - 1;
  return `${parseInt(dd, 10)} ${months[monthIdx] ?? mm} ${yyyy}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Break long biography into structured paragraphs at natural sentence breaks */
function formatBiography(bio: string): string {
  const cleaned = bio
    .replace(/&amp;amp;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  // Split into sentences
  const sentences = cleaned.split(/(?<=\.)\s+/);
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const sentence of sentences) {
    current.push(sentence);
    // Create a new paragraph every 3-4 sentences for readability
    if (current.length >= 3) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(' '));
  }

  return paragraphs.map((p) => `<p class="bio-para">${escapeHtml(p)}</p>`).join('\n');
}

// ---------------------------------------------------------------------------
// HTML Template — Legal-style document
// ---------------------------------------------------------------------------

function generateHTML(profiles: JudgeProfile[]): string {
  const chairpersons = profiles.filter(
    (p) => p.role === 'Chairperson' || p.role === 'Former Chairperson',
  );
  const members = profiles.filter((p) => p.role === 'Member' || p.role === 'Former Member');

  const generatedDate = new Date().toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  function renderProfile(p: JudgeProfile, idx: number): string {
    const tenureStr = `${formatDate(p.tenure_from)} to ${formatDate(p.tenure_to)}`;
    const isCurrent = !p.tenure_to;
    const statusBadge = isCurrent
      ? `<span class="badge badge-current">Currently Serving</span>`
      : `<span class="badge badge-former">Former</span>`;

    return `
      <div class="profile-entry ${isCurrent ? 'current' : ''}">
        <div class="profile-header">
          <div class="serial-number">${idx + 1}.</div>
          <div class="profile-title">
            <h3 class="judge-name">${escapeHtml(p.name)}</h3>
            <div class="designation">
              <span class="role-text">${escapeHtml(p.role)}</span>
              ${statusBadge}
            </div>
          </div>
        </div>
        <div class="profile-meta">
          <div class="meta-row">
            <span class="meta-label">Tenure:</span>
            <span class="meta-value">${tenureStr}</span>
          </div>
        </div>
        <div class="profile-body">
          <div class="section-label">Biographical Details</div>
          ${formatBiography(p.biography)}
        </div>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TDSAT Bench Profiles</title>
  <style>
    @page {
      size: A4;
      margin: 22mm 20mm 25mm 20mm;

      @bottom-center {
        content: "Page " counter(page) " of " counter(pages);
        font-family: "Georgia", "Times New Roman", serif;
        font-size: 9pt;
        color: #666;
      }

      @bottom-right {
        content: "CONFIDENTIAL";
        font-family: "Georgia", "Times New Roman", serif;
        font-size: 8pt;
        color: #999;
        letter-spacing: 1px;
      }
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: "Georgia", "Times New Roman", "Noto Serif", serif;
      font-size: 11pt;
      line-height: 1.55;
      color: #1a1a1a;
      background: #fff;
    }

    /* ===== COVER PAGE ===== */
    .cover-page {
      page-break-after: always;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
      padding: 60px 40px;
    }

    .emblem {
      width: 90px;
      height: auto;
      margin-bottom: 20px;
      opacity: 0.85;
    }

    .cover-govt {
      font-size: 13pt;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: #1a3a5c;
      margin-bottom: 6px;
    }

    .cover-tribunal-name {
      font-size: 20pt;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: #0d2137;
      margin-bottom: 4px;
      text-transform: uppercase;
    }

    .cover-subtitle {
      font-size: 11pt;
      color: #555;
      font-style: italic;
      margin-bottom: 40px;
    }

    .cover-separator {
      width: 280px;
      height: 2px;
      background: linear-gradient(90deg, transparent, #8b6914, #c9a227, #8b6914, transparent);
      margin: 0 auto 40px auto;
    }

    .cover-doc-title {
      font-size: 22pt;
      font-weight: 700;
      color: #1a1a1a;
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }

    .cover-doc-subtitle {
      font-size: 14pt;
      color: #444;
      margin-bottom: 50px;
    }

    .cover-meta {
      font-size: 10pt;
      color: #666;
      margin-top: auto;
    }

    .cover-meta-row {
      margin-bottom: 4px;
    }

    .cover-meta-label {
      font-weight: 600;
      color: #333;
    }

    /* ===== TABLE OF CONTENTS ===== */
    .toc-page {
      page-break-after: always;
      padding: 40px 0;
    }

    .toc-title {
      font-size: 16pt;
      font-weight: 700;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 3px;
      color: #1a3a5c;
      margin-bottom: 30px;
      padding-bottom: 10px;
      border-bottom: 2px solid #c9a227;
    }

    .toc-section {
      margin-bottom: 25px;
    }

    .toc-section-title {
      font-size: 12pt;
      font-weight: 700;
      color: #1a3a5c;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 10px;
      padding-bottom: 4px;
      border-bottom: 1px solid #ddd;
    }

    .toc-entry {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 3px 0;
      font-size: 10.5pt;
    }

    .toc-name {
      color: #333;
    }

    .toc-tenure {
      color: #777;
      font-size: 9.5pt;
      white-space: nowrap;
      margin-left: 10px;
    }

    .toc-dots {
      flex: 1;
      border-bottom: 1px dotted #ccc;
      margin: 0 8px;
      min-width: 30px;
    }

    /* ===== SECTION HEADERS ===== */
    .section-page {
      page-break-before: always;
    }

    .section-heading {
      font-size: 16pt;
      font-weight: 700;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 3px;
      color: #1a3a5c;
      padding: 15px 0;
      margin-bottom: 30px;
      border-top: 3px double #c9a227;
      border-bottom: 3px double #c9a227;
    }

    /* ===== PROFILE ENTRIES ===== */
    .profile-entry {
      margin-bottom: 35px;
      padding-bottom: 25px;
      border-bottom: 1px solid #e0e0e0;
      page-break-inside: avoid;
    }

    .profile-entry:last-child {
      border-bottom: none;
    }

    .profile-entry.current {
      border-left: 3px solid #c9a227;
      padding-left: 15px;
    }

    .profile-header {
      display: flex;
      align-items: flex-start;
      margin-bottom: 10px;
    }

    .serial-number {
      font-size: 14pt;
      font-weight: 700;
      color: #1a3a5c;
      min-width: 30px;
      padding-top: 2px;
    }

    .profile-title {
      flex: 1;
    }

    .judge-name {
      font-size: 14pt;
      font-weight: 700;
      color: #0d2137;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 3px;
    }

    .designation {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .role-text {
      font-size: 10.5pt;
      font-style: italic;
      color: #555;
    }

    .badge {
      font-size: 8pt;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }

    .badge-current {
      background: #e8f5e9;
      color: #2e7d32;
      border: 1px solid #a5d6a7;
    }

    .badge-former {
      background: #f5f5f5;
      color: #888;
      border: 1px solid #ddd;
    }

    .profile-meta {
      margin-bottom: 12px;
      padding: 8px 12px;
      background: #fafaf8;
      border: 1px solid #eee;
      border-radius: 3px;
    }

    .meta-row {
      font-size: 10pt;
    }

    .meta-label {
      font-weight: 700;
      color: #1a3a5c;
      text-transform: uppercase;
      font-size: 8.5pt;
      letter-spacing: 1px;
      margin-right: 8px;
    }

    .meta-value {
      color: #333;
    }

    .section-label {
      font-size: 9pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #1a3a5c;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid #eee;
    }

    .bio-para {
      font-size: 10.5pt;
      line-height: 1.65;
      color: #2a2a2a;
      margin-bottom: 8px;
      text-align: justify;
      hyphens: auto;
    }

    .bio-para:last-child {
      margin-bottom: 0;
    }

    /* ===== FOOTER NOTE ===== */
    .footer-page {
      page-break-before: always;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      min-height: 50vh;
      text-align: center;
      padding: 60px 40px;
    }

    .footer-separator {
      width: 200px;
      height: 1px;
      background: #ccc;
      margin: 0 auto 25px auto;
    }

    .footer-note {
      font-size: 10pt;
      color: #666;
      font-style: italic;
      max-width: 450px;
      line-height: 1.6;
    }

    .footer-source {
      margin-top: 20px;
      font-size: 9pt;
      color: #999;
    }

    .disclaimer {
      margin-top: 30px;
      font-size: 8.5pt;
      color: #aaa;
      max-width: 500px;
      line-height: 1.5;
      border-top: 1px solid #eee;
      padding-top: 15px;
    }
  </style>
</head>
<body>

  <!-- ===== COVER PAGE ===== -->
  <div class="cover-page">
    <img class="emblem"
         src="https://upload.wikimedia.org/wikipedia/commons/5/55/Emblem_of_India.svg"
         alt="Emblem of India"
         onerror="this.style.display='none'" />
    <div class="cover-govt">Government of India</div>
    <div class="cover-tribunal-name">Telecom Disputes Settlement<br/>& Appellate Tribunal</div>
    <div class="cover-subtitle">Established under the TRAI Act, 1997 (as amended)</div>

    <div class="cover-separator"></div>

    <div class="cover-doc-title">Bench Composition &<br/>Biographical Compendium</div>
    <div class="cover-doc-subtitle">Chairpersons & Members (2000 &ndash; 2026)</div>

    <div class="cover-meta">
      <div class="cover-meta-row">
        <span class="cover-meta-label">Total Profiles:</span> ${profiles.length}
        (${chairpersons.length} Chairpersons, ${members.length} Members)
      </div>
      <div class="cover-meta-row">
        <span class="cover-meta-label">Generated:</span> ${generatedDate}
      </div>
      <div class="cover-meta-row">
        <span class="cover-meta-label">Source:</span> Official TDSAT Website (tdsat.gov.in)
      </div>
      <div class="cover-meta-row">
        <span class="cover-meta-label">Classification:</span> Public Record
      </div>
    </div>
  </div>

  <!-- ===== TABLE OF CONTENTS ===== -->
  <div class="toc-page">
    <div class="toc-title">Table of Contents</div>

    <div class="toc-section">
      <div class="toc-section-title">Part I &mdash; Chairpersons</div>
      ${chairpersons
        .map(
          (p) => `
        <div class="toc-entry">
          <span class="toc-name">${escapeHtml(p.name)}</span>
          <span class="toc-dots"></span>
          <span class="toc-tenure">${formatDate(p.tenure_from)} &ndash; ${formatDate(p.tenure_to)}</span>
        </div>`,
        )
        .join('\n')}
    </div>

    <div class="toc-section">
      <div class="toc-section-title">Part II &mdash; Members</div>
      ${members
        .map(
          (p) => `
        <div class="toc-entry">
          <span class="toc-name">${escapeHtml(p.name)}</span>
          <span class="toc-dots"></span>
          <span class="toc-tenure">${formatDate(p.tenure_from)} &ndash; ${formatDate(p.tenure_to)}</span>
        </div>`,
        )
        .join('\n')}
    </div>
  </div>

  <!-- ===== PART I: CHAIRPERSONS ===== -->
  <div class="section-page">
    <div class="section-heading">Part I &mdash; Chairpersons</div>
    ${chairpersons.map((p, i) => renderProfile(p, i)).join('\n')}
  </div>

  <!-- ===== PART II: MEMBERS ===== -->
  <div class="section-page">
    <div class="section-heading">Part II &mdash; Members</div>
    ${members.map((p, i) => renderProfile(p, i)).join('\n')}
  </div>

  <!-- ===== END NOTE ===== -->
  <div class="footer-page">
    <div class="footer-separator"></div>
    <div class="footer-note">
      This compendium contains biographical profiles of all Chairpersons and Members
      who have served on the Bench of the Telecom Disputes Settlement &amp; Appellate
      Tribunal from its inception in May 2000 to the present date.
    </div>
    <div class="footer-source">
      Source: Official TDSAT Website &mdash; tdsat.gov.in<br/>
      Extracted on ${generatedDate}
    </div>
    <div class="disclaimer">
      This document has been compiled from publicly available records on the official
      TDSAT website for research and reference purposes. All biographical information
      is reproduced as published by the Tribunal. No warranties are made regarding the
      completeness or accuracy of information beyond what was available at the source.
    </div>
  </div>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// PDF Generation using Playwright
// ---------------------------------------------------------------------------

async function generatePDF() {
  const profilesPath = path.join(process.cwd(), 'data/tdsat/judges/all_profiles.json');
  const outputDir = path.join(process.cwd(), 'data/tdsat/judges');
  const htmlPath = path.join(outputDir, 'TDSAT_Bench_Profiles.html');
  const pdfPath = path.join(outputDir, 'TDSAT_Bench_Profiles.pdf');

  console.log('Loading profiles...');
  const profiles: JudgeProfile[] = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
  console.log(`  ${profiles.length} profiles loaded`);

  console.log('Generating HTML...');
  const html = generateHTML(profiles);
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`  HTML written to ${htmlPath}`);

  console.log('Launching browser for PDF generation...');

  // Dynamic import for playwright
  let chromium: any;
  try {
    const pw = await import('playwright');
    chromium = pw.chromium;
  } catch {
    try {
      const pw = await import('playwright-core');
      chromium = pw.chromium;
    } catch {
      console.error(
        'Neither playwright nor playwright-core found. Install with: pnpm add -D playwright',
      );
      console.log('\nHTML file has been generated. You can open it in a browser and print to PDF.');
      console.log(`  ${htmlPath}`);
      return;
    }
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });

  // Wait a bit for any font loading
  await page.waitForTimeout(1000);

  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '22mm',
      bottom: '25mm',
      left: '20mm',
      right: '20mm',
    },
    displayHeaderFooter: true,
    headerTemplate: `<span></span>`,
    footerTemplate: `
      <div style="width:100%; font-size:8pt; font-family:Georgia,serif; padding:0 20mm; display:flex; justify-content:space-between; color:#888;">
        <span>TDSAT Bench Profiles</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `,
  });

  await browser.close();

  const stats = fs.statSync(pdfPath);
  const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
  console.log(`\nPDF generated successfully!`);
  console.log(`  ${pdfPath} (${sizeMB} MB)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

generatePDF().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
