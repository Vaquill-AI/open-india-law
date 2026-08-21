/**
 * TDSAT Supplementary Scraper
 *
 * Downloads remaining high-value data from TDSAT:
 *   1. Judge/Member profiles (organize_auth1.php + formermember.php)
 *   2. Legally substantive notices (~45 PDFs from notices.php)
 *   3. Case status dossiers (checkhomedetail1.php - all case types × years)
 *
 * Usage:
 *   npx tsx scripts/tdsat-supplementary-scraper.ts
 *
 * Environment variables:
 *   MODE            - "all" (default) | "judges" | "notices" | "cases"
 *   CONCURRENCY     - Parallel downloads (default: 3)
 *   DRY_RUN         - Set to "true" to preview without downloading
 *   START_YEAR      - Start year for case scraping (default: 2000)
 *   END_YEAR        - End year for case scraping (default: current year)
 *   RESUME          - Set to "true" to resume from progress file
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

// ── Config ───────────────────────────────────────────────────────────
const BASE_URL = 'https://tdsat.gov.in';
const DATA_DIR = 'data/tribunals/tdsat';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const DRY_RUN = process.env.DRY_RUN === 'true';
const MODE = process.env.MODE || 'all';
const START_YEAR = parseInt(process.env.START_YEAR || '2000', 10);
const END_YEAR = parseInt(process.env.END_YEAR || new Date().getFullYear().toString(), 10);
const RESUME = process.env.RESUME === 'true';

// Case types with their numeric IDs
const CASE_TYPES: Record<number, string> = {
  1: 'BROADCASTING PETITION',
  2: 'TELECOM PETITION',
  3: 'BROADCASTING APPEAL',
  4: 'TELECOM APPEAL',
  5: 'MISC APPLICATION',
  7: 'REVIEW APPLICATION',
  8: 'EA',
  9: 'AERA PETITION',
  10: 'AERA APPEAL',
  11: 'CYBER APPEAL',
};

// ── Types ────────────────────────────────────────────────────────────
interface JudgeProfile {
  name: string;
  role: string;
  tenure_from: string;
  tenure_to: string;
  biography: string;
  source_page: string;
}

interface NoticeEntry {
  serial: number;
  title: string;
  date: string;
  pdf_url: string;
  full_pdf_url: string;
  category: string;
  rag_relevant: boolean;
}

interface CaseDossier {
  case_type: string;
  case_type_id: number;
  case_no: number;
  case_year: number;
  diary_no: string;
  diary_year: string;
  filing_date: string;
  status: string;
  petitioner: string;
  petitioner_advocate: string;
  additional_pet_advocate: string;
  respondent: string;
  respondent_advocate: string;
  additional_res_advocate: string;
  subject: string;
  court_no: string;
  next_date: string;
  next_purpose: string;
  proceedings: Proceeding[];
  documents: DocumentFiling[];
}

interface Proceeding {
  date: string;
  bench: string;
  purpose: string;
  status: string;
  order_link: string;
}

interface DocumentFiling {
  doc_type: string;
  filed_by: string;
  filer_name: string;
  filing_date: string;
}

interface CaseScrapeProgress {
  last_case_type_id: number;
  last_year: number;
  last_case_no: number;
  total_cases_found: number;
  total_empty: number;
  completed_types: number[];
}

// ── Utilities ────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout for ${url}`));
    });
  });
}

function postForm(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout for ${url}`));
    });
    req.write(body);
    req.end();
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
    });
    req.on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(new Error(`Timeout downloading ${url}`));
    });
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBetween(html: string, start: string, end: string): string {
  const startIdx = html.indexOf(start);
  if (startIdx === -1) return '';
  const contentStart = startIdx + start.length;
  const endIdx = html.indexOf(end, contentStart);
  if (endIdx === -1) return html.substring(contentStart);
  return html.substring(contentStart, endIdx);
}

// ── 1. Judge/Member Profile Scraper ──────────────────────────────────

/**
 * Parse TDSAT profile pages which use Bootstrap modal pattern:
 *   - Name + tenure in <p><strong><font> blocks before each modal
 *   - Biography in <div class="modal-body"><p>...</p></div>
 *   - Modal id="profile_{n}" links name card to bio
 *   - Role determined by section headers: CHAIRPERSON / FORMER CHAIRPERSON / MEMBERS / FORMER MEMBERS
 */
function parseProfilePage(html: string, sourcePage: string): JudgeProfile[] {
  const profiles: JudgeProfile[] = [];

  // Strategy: find each profile_N modal and its associated name card
  // Name pattern: <strong><font ...>NAME\n</p><p>From: DD-MM-YYYY  To : DD-MM-YYYY
  // Modal pattern: <div class="modal fade" id="profile_N"> ... <div class="modal-body"><p>BIO</p></div>

  // First, determine role sections by position
  const chairpersonIdx = html.indexOf('<u>CHAIRPERSON</u>');
  const formerChairIdx = html.indexOf('<u>FORMER CHAIRPERSON</u>');
  const membersIdx =
    html.indexOf('<u>MEMBERS, TDSAT</u>') !== -1
      ? html.indexOf('<u>MEMBERS, TDSAT</u>')
      : html.indexOf('<u>MEMBERS</u>');
  const formerMemberIdx =
    html.indexOf('<u>FORMER MEMBERS, TDSAT</u>') !== -1
      ? html.indexOf('<u>FORMER MEMBERS, TDSAT</u>')
      : html.indexOf('<u>FORMER MEMBERS</u>');

  function getRoleAtPosition(pos: number): string {
    const sections = [
      { idx: chairpersonIdx, role: 'Chairperson' },
      { idx: formerChairIdx, role: 'Former Chairperson' },
      { idx: membersIdx, role: 'Member' },
      { idx: formerMemberIdx, role: 'Former Member' },
    ]
      .filter((s) => s.idx !== -1)
      .sort((a, b) => a.idx - b.idx);

    let role = 'Unknown';
    for (const s of sections) {
      if (pos > s.idx) role = s.role;
    }
    return role;
  }

  // Find all profile modals
  const modalRegex =
    /id="profile_(\d+)"[\s\S]*?<div\s+class="modal-body">\s*<p>([\s\S]*?)<\/p>\s*<\/div>/g;
  const modals = new Map<string, string>();
  let mMatch;
  while ((mMatch = modalRegex.exec(html)) !== null) {
    const profileId = mMatch[1];
    const bioHtml = mMatch[2];
    modals.set(profileId, stripHtml(bioHtml));
  }

  // Find all name cards that reference profile modals
  // Pattern: data-target="#profile_N" ... <strong><font ...>NAME</p><p>From: DATE  To : DATE
  const cardRegex = /data-target="#profile_(\d+)"[\s\S]*?<strong><font[^>]*>\s*([\s\S]*?)<\/font>/g;
  let cMatch;
  while ((cMatch = cardRegex.exec(html)) !== null) {
    const profileId = cMatch[1];
    const cardText = cMatch[2];

    // Extract name: everything before </p>
    const nameText = stripHtml(cardText.split('</p>')[0] || cardText);
    // Clean up name
    const name = nameText
      .replace(/HON'?BLE\s+/i, '')
      .replace(/^MR\.?\s+/i, '')
      .replace(/^MS\.?\s+/i, '')
      .replace(/^DR\.?\s+/i, 'Dr. ')
      .trim();

    if (!name || name.length < 3) continue;

    // Extract tenure dates
    const tenureText = stripHtml(cardText);
    const fromMatch = tenureText.match(/From:\s*(\d{2}-\d{2}-\d{4})/i);
    const toMatch = tenureText.match(/To\s*:\s*(\d{2}-\d{2}-\d{4})/i);

    const role = getRoleAtPosition(cMatch.index);
    const bio = modals.get(profileId) || '';

    profiles.push({
      name,
      role,
      tenure_from: fromMatch ? fromMatch[1] : '',
      tenure_to: toMatch ? toMatch[1] : '',
      biography: bio,
      source_page: sourcePage,
    });
    console.log(
      `  ✓ ${name} (${role}, ${fromMatch ? fromMatch[1] : '?'}${toMatch ? ' - ' + toMatch[1] : ' - present'})`,
    );
  }

  return profiles;
}

async function scrapeJudgeProfiles(): Promise<JudgeProfile[]> {
  console.log('\n━━━ PHASE 1: Judge/Member Profiles ━━━\n');
  const profiles: JudgeProfile[] = [];
  const outDir = path.join(DATA_DIR, 'judges');
  ensureDir(outDir);

  // Scrape chairpersons page
  console.log('Fetching chairperson profiles (organize_auth1.php)...');
  try {
    const chairHtml = await fetchUrl(`${BASE_URL}/writereaddata/Delhi/docs/organize_auth1.php`);
    fs.writeFileSync(path.join(outDir, 'organize_auth1_raw.html'), chairHtml);
    const chairProfiles = parseProfilePage(chairHtml, 'organize_auth1.php');
    profiles.push(...chairProfiles);
    console.log(`  Found ${chairProfiles.length} chairperson profiles`);
  } catch (err) {
    console.error(`  ✗ Error fetching chairperson page: ${err}`);
  }

  await sleep(500);

  // Scrape members page
  console.log('\nFetching member profiles (formermember.php)...');
  try {
    const memberHtml = await fetchUrl(`${BASE_URL}/writereaddata/Delhi/docs/formermember.php`);
    fs.writeFileSync(path.join(outDir, 'formermember_raw.html'), memberHtml);
    const memberProfiles = parseProfilePage(memberHtml, 'formermember.php');
    profiles.push(...memberProfiles);
    console.log(`  Found ${memberProfiles.length} member profiles`);
  } catch (err) {
    console.error(`  ✗ Error fetching member page: ${err}`);
  }

  // Deduplicate by name (in case same person appears on both pages)
  const seen = new Set<string>();
  const deduped = profiles.filter((p) => {
    const key = p.name.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Save profiles
  fs.writeFileSync(path.join(outDir, 'all_profiles.json'), JSON.stringify(deduped, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'all_profiles.jsonl'),
    deduped.map((p) => JSON.stringify(p)).join('\n') + '\n',
  );

  console.log(`\n✅ Judge profiles: ${deduped.length} extracted → ${outDir}/all_profiles.json`);
  return deduped;
}

// ── 2. Notices Scraper ───────────────────────────────────────────────

// Keywords indicating legally substantive notices
const RAG_KEYWORDS = [
  'circular',
  'amendment',
  'practice direction',
  'procedure',
  'rule',
  'regulation',
  'guidelines',
  'facilitation',
  'e-filing',
  'virtual hearing',
  'hybrid mode',
  'mentioning',
  'requisition',
  'court proceeding',
  'mediation',
  'arbitration',
  'listing',
  'registry',
  'case management',
  'advocate',
  'counsel',
  'filing',
  'format',
  'proforma',
];

// Keywords indicating administrative/non-substantive notices
const SKIP_KEYWORDS = [
  'sitting',
  'non-sitting',
  'non sitting',
  'holiday',
  'vacation',
  'annual',
  'winter break',
  'summer break',
  'dusshera',
  'diwali',
  'holi',
  'independence day',
  'republic day',
  'christmas',
  'good friday',
  'id-ul',
  'eid',
  'guru nanak',
  'mahavir',
  'buddha',
  'mahatma gandhi',
  'dr. ambedkar',
  'vacancy',
  'recruitment',
  'internship',
  'tender',
  'appointment',
];

function classifyNotice(title: string): { category: string; ragRelevant: boolean } {
  const lower = title.toLowerCase();

  // Check skip keywords first
  for (const kw of SKIP_KEYWORDS) {
    if (lower.includes(kw)) {
      if (lower.includes('sitting') && !lower.includes('non')) {
        return { category: 'sitting-schedule', ragRelevant: false };
      }
      if (lower.includes('vacancy') || lower.includes('recruitment')) {
        return { category: 'vacancy', ragRelevant: false };
      }
      if (lower.includes('internship')) {
        return { category: 'internship', ragRelevant: false };
      }
      return { category: 'administrative', ragRelevant: false };
    }
  }

  // Check RAG-relevant keywords
  for (const kw of RAG_KEYWORDS) {
    if (lower.includes(kw)) {
      return { category: 'legal-procedural', ragRelevant: true };
    }
  }

  // Default: classify as potentially relevant if title is substantial
  if (title.length > 30 && !lower.includes('notice regarding')) {
    return { category: 'other-substantive', ragRelevant: true };
  }

  return { category: 'other', ragRelevant: false };
}

async function scrapeNotices(): Promise<NoticeEntry[]> {
  console.log('\n━━━ PHASE 2: Legally Substantive Notices ━━━\n');

  console.log('Fetching notices page...');
  const html = await fetchUrl(`${BASE_URL}/writereaddata/Delhi/docs/notices.php`);

  // Parse notice entries - HTML is malformed, entries are PDF links with surrounding <td> tags
  // Each entry has: <td>serial</td> <td><a href="...pdf">Title</a></td> <td>date</td>
  // Extract all PDF links directly since row structure is inconsistent
  const notices: NoticeEntry[] = [];

  // Find all PDF links in the page
  const pdfLinkRegex = /<a\s+href="([^"]*\.pdf)"[^>]*>(?:<font[^>]*>)?\s*([\s\S]*?)\s*<\/a>/gi;
  let linkMatch;
  let serial = 0;

  while ((linkMatch = pdfLinkRegex.exec(html)) !== null) {
    const pdfPath = linkMatch[1];
    const title = stripHtml(linkMatch[2]);
    if (!title || title.length < 3) continue;

    serial++;

    // Look for date near this link (within next 200 chars)
    const afterLink = html.substring(linkMatch.index, linkMatch.index + 500);
    const dateMatch = afterLink.match(/(\d{2}-\d{2}-\d{4})/);
    const date = dateMatch ? dateMatch[1] : '';

    // Build full URL - handle the ../../../../ prefix pattern
    let cleanPath = pdfPath.replace(/\.\.\/+/g, '/').replace(/\/+/g, '/');
    if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;
    const fullUrl = `${BASE_URL}${cleanPath}`;

    const { category, ragRelevant } = classifyNotice(title);

    notices.push({
      serial,
      title,
      date,
      pdf_url: pdfPath,
      full_pdf_url: fullUrl,
      category,
      rag_relevant: ragRelevant,
    });
  }

  console.log(`Found ${notices.length} total notices`);

  // Save all notice metadata
  const metaDir = path.join(DATA_DIR, 'metadata');
  ensureDir(metaDir);
  fs.writeFileSync(path.join(metaDir, 'all_notices.json'), JSON.stringify(notices, null, 2));

  // Filter for RAG-relevant notices
  const ragNotices = notices.filter((n) => n.rag_relevant);
  console.log(`RAG-relevant: ${ragNotices.length} of ${notices.length} notices`);

  // Categorization summary
  const catCounts: Record<string, number> = {};
  for (const n of notices) {
    catCounts[n.category] = (catCounts[n.category] || 0) + 1;
  }
  console.log('\nCategory breakdown:');
  for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  // Download RAG-relevant PDFs
  if (!DRY_RUN) {
    const noticeDir = path.join(DATA_DIR, 'notices');
    ensureDir(noticeDir);

    console.log(`\nDownloading ${ragNotices.length} substantive notice PDFs...`);
    let downloaded = 0;
    let failed = 0;

    for (let i = 0; i < ragNotices.length; i += CONCURRENCY) {
      const batch = ragNotices.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (notice) => {
          const filename = sanitizeFilename(
            `${notice.serial}_${notice.title.substring(0, 80)}.pdf`,
          );
          const dest = path.join(noticeDir, filename);

          if (fs.existsSync(dest)) {
            downloaded++;
            return;
          }

          try {
            await downloadFile(notice.full_pdf_url, dest);
            downloaded++;
            console.log(
              `  [${downloaded}/${ragNotices.length}] ✓ ${notice.title.substring(0, 60)}...`,
            );
          } catch (err) {
            failed++;
            console.log(
              `  [${downloaded + failed}/${ragNotices.length}] ✗ ${notice.title.substring(0, 60)}: ${err}`,
            );
          }
        }),
      );
      if (i + CONCURRENCY < ragNotices.length) await sleep(300);
    }

    console.log(`\n✅ Notices: ${downloaded} downloaded, ${failed} failed → ${noticeDir}/`);
  } else {
    console.log('\nDRY_RUN: Would download these notices:');
    for (const n of ragNotices) {
      console.log(`  - ${n.title}`);
    }
  }

  return notices;
}

// ── 3. Case Status Dossier Scraper ───────────────────────────────────

function parseCaseDossier(
  html: string,
  caseTypeId: number,
  caseNo: number,
  caseYear: number,
): CaseDossier | null {
  // Check if case exists
  if (
    html.includes('No Record Found') ||
    html.includes('no record found') ||
    html.includes('No Data Found') ||
    html.length < 500
  ) {
    return null;
  }

  // Must have CASE STATUS header to be valid
  if (!html.includes('CASE STATUS') && !html.includes('Case Status')) {
    return null;
  }

  const dossier: CaseDossier = {
    case_type: CASE_TYPES[caseTypeId] || `TYPE_${caseTypeId}`,
    case_type_id: caseTypeId,
    case_no: caseNo,
    case_year: caseYear,
    diary_no: '',
    diary_year: '',
    filing_date: '',
    status: '',
    petitioner: '',
    petitioner_advocate: '',
    additional_pet_advocate: '',
    respondent: '',
    respondent_advocate: '',
    additional_res_advocate: '',
    subject: '',
    court_no: '',
    next_date: '',
    next_purpose: '',
    proceedings: [],
    documents: [],
  };

  // TDSAT HTML structure:
  // <tr><td><font size="-1">Label</font></td><td><font size="-1">Value</font></td></tr>
  // OR for party details:
  // <td><font size="-1">Petitioner Name -NAME<br>Pet. Advocate Name: ADV<br>...</font></td>

  // Extract simple label-value pairs from table rows
  function extractField(label: string): string {
    const patterns = [
      // Pattern: Label</font></td>\n<td...><font...>Value</font></td>
      new RegExp(
        `${label}[\\s.:]*</font>\\s*</td>\\s*<td[^>]*>\\s*(?:<font[^>]*>)?\\s*([\\s\\S]*?)\\s*(?:</font>)?\\s*</td>`,
        'i',
      ),
      // Pattern: Label</td><td>Value</td>
      new RegExp(
        `${label}[\\s.:]*</td>\\s*<td[^>]*>\\s*(?:<font[^>]*>)?\\s*([\\s\\S]*?)\\s*(?:</font>)?\\s*</td>`,
        'i',
      ),
    ];
    for (const p of patterns) {
      const match = html.match(p);
      if (match && match[1]) {
        return stripHtml(match[1]).trim();
      }
    }
    return '';
  }

  // Extract diary number from "Diary no/Year" → "3/2024"
  const diaryField = extractField('Diary\\s*no[/\\s]*Year');
  if (diaryField) {
    const parts = diaryField.split('/');
    dossier.diary_no = parts[0] || '';
    dossier.diary_year = parts[1] || '';
  }

  dossier.filing_date = extractField('Date\\s*of\\s*Filing');
  dossier.status = extractField('Case\\s*Status');

  // Extract petitioner details section
  // Pattern: "Petitioner Name &nbsp;&nbsp;-NAME<br>Additional Party(Pet.):...<br>Pet. Advocate Name: ADV<br>Additional Advocate(Pet.):..."
  const petSection = html.match(
    /Petitioner\s*Name\s*(?:&nbsp;)*\s*[-:]\s*([\s\S]*?)(?:<\/font>|<\/td>|RESPONDENT)/i,
  );
  if (petSection) {
    const section = petSection[1];
    // Petitioner name: text before first <br> or tag, clean trailing labels
    const petName = stripHtml(section.split(/<br\s*\/?>/i)[0] || '')
      .replace(/\s*Additional\s*Party\s*\((?:Pet|Res)\.\)\s*:?\s*$/i, '')
      .trim();
    dossier.petitioner = petName;

    // Pet. Advocate
    const petAdvMatch = section.match(
      /Pet\.\s*Advocate\s*Name[:\s]*([\s\S]*?)(?:<br|<\/|Additional|$)/i,
    );
    if (petAdvMatch) dossier.petitioner_advocate = stripHtml(petAdvMatch[1]).replace(/^[-\s]+/, '');

    // Additional Advocate (Pet.)
    const addPetAdvMatch = section.match(
      /Additional\s*Advocate\s*\(\s*Pet\.\s*\)[:\s]*([\s\S]*?)(?:<br|<\/|$)/i,
    );
    if (addPetAdvMatch) dossier.additional_pet_advocate = stripHtml(addPetAdvMatch[1]);

    // Additional Party (Pet.)
    const addPetPartyMatch = section.match(
      /Additional\s*Party\s*\(\s*Pet\.\s*\)[:\s]*([\s\S]*?)(?:<br|<\/|Pet\.\s*Advocate|$)/i,
    );
    if (addPetPartyMatch) {
      const addParty = stripHtml(addPetPartyMatch[1]);
      if (addParty) dossier.petitioner += ` [Additional: ${addParty}]`;
    }
  }

  // Extract respondent details section
  const resSection = html.match(
    /Respondent\s*Name\s*(?:&nbsp;)*\s*[-:]\s*([\s\S]*?)(?:<\/font>|<\/td>|SUBJECT|DOCUMENT)/i,
  );
  if (resSection) {
    const section = resSection[1];
    const resName = stripHtml(section.split(/<br\s*\/?>/i)[0] || '')
      .replace(/\s*Additional\s*Party\s*\((?:Pet|Res)\.\)\s*:?\s*$/i, '')
      .trim();
    dossier.respondent = resName;

    const resAdvMatch = section.match(
      /Respondent\s*Advocate[:\s]*([\s\S]*?)(?:<br|<\/|Additional|$)/i,
    );
    if (resAdvMatch) dossier.respondent_advocate = stripHtml(resAdvMatch[1]).replace(/^[-\s]+/, '');

    const addResAdvMatch = section.match(
      /Additional\s*Advocate\s*\(\s*Res\.\s*\)[:\s]*([\s\S]*?)(?:<br|<\/|$)/i,
    );
    if (addResAdvMatch) dossier.additional_res_advocate = stripHtml(addResAdvMatch[1]);
  }

  // Extract subject
  const subjectMatch = html.match(
    /Subject[:\s]*(?:<\/font>)?(?:<\/td>)?\s*<td[^>]*>(?:<font[^>]*>)?\s*([\s\S]*?)(?:<\/font>)?<\/td>/i,
  );
  if (subjectMatch) dossier.subject = stripHtml(subjectMatch[1]);

  // Extract court number
  const courtMatch = html.match(
    /Court\s*(?:No|Number)[:\s.]*(?:<\/font>)?(?:<\/td>)?\s*<td[^>]*>(?:<font[^>]*>)?\s*([\s\S]*?)(?:<\/font>)?<\/td>/i,
  );
  if (courtMatch) dossier.court_no = stripHtml(courtMatch[1]);

  // Extract next listing date
  const nextDateMatch = html.match(
    /Next\s*(?:Listing\s*)?Date[:\s]*(?:<\/font>)?(?:<\/td>)?\s*<td[^>]*>(?:<font[^>]*>)?\s*([\s\S]*?)(?:<\/font>)?<\/td>/i,
  );
  if (nextDateMatch) dossier.next_date = stripHtml(nextDateMatch[1]);

  // Extract proceedings - rows with dates in the proceedings table
  // Pattern: <td><font><a onclick="...">DD/MM/YYYY</a></font></td><td>...bench...</td>...
  const procRegex =
    /<td[^>]*>\s*(?:<font[^>]*>)?\s*(?:<a[^>]*>)?\s*(\d{2}\/\d{2}\/\d{4})\s*(?:<\/a>)?\s*(?:<\/font>)?\s*<\/td>\s*<td[^>]*>\s*(?:<font[^>]*>)?\s*([\s\S]*?)\s*(?:<\/font>)?\s*<\/td>\s*<td[^>]*>\s*(?:<font[^>]*>)?\s*([\s\S]*?)\s*(?:<\/font>)?\s*<\/td>\s*<td[^>]*>\s*(?:<font[^>]*>)?\s*([\s\S]*?)\s*(?:<\/font>)?\s*<\/td>/g;
  let procMatch;
  while ((procMatch = procRegex.exec(html)) !== null) {
    const date = procMatch[1];
    const bench = stripHtml(procMatch[2]);
    const purpose = stripHtml(procMatch[3]);
    const statusOrOrder = stripHtml(procMatch[4]);

    // Skip header rows
    if (bench === 'Bench' || purpose === 'Purpose' || date === 'Date') continue;

    // Extract order link if present
    const orderLinkMatch = procMatch[0].match(/filing_no=([A-Za-z0-9=+/]+)/);
    const orderLink = orderLinkMatch ? orderLinkMatch[1] : '';

    dossier.proceedings.push({
      date,
      bench,
      purpose,
      status: statusOrOrder,
      order_link: orderLink,
    });
  }

  // Extract document filing details
  // Pattern in document table: Doc Type | Filed By | Filer Name | Filing Date
  const docTableMatch = html.match(/DOCUMENT\s*(?:FILING\s*)?DETAIL[\s\S]*?<\/table>/i);
  if (docTableMatch) {
    const docTable = docTableMatch[0];
    const docRowRegex =
      /<td[^>]*>\s*(?:<font[^>]*>)?\s*([\s\S]*?)\s*(?:<\/font>)?\s*<\/td>\s*<td[^>]*>\s*(?:<font[^>]*>)?\s*([\s\S]*?)\s*(?:<\/font>)?\s*<\/td>\s*<td[^>]*>\s*(?:<font[^>]*>)?\s*([\s\S]*?)\s*(?:<\/font>)?\s*<\/td>\s*<td[^>]*>\s*(?:<font[^>]*>)?\s*(\d{2}\/\d{2}\/\d{4})\s*(?:<\/font>)?\s*<\/td>/g;
    let docMatch;
    while ((docMatch = docRowRegex.exec(docTable)) !== null) {
      const docType = stripHtml(docMatch[1]);
      const filedBy = stripHtml(docMatch[2]);
      const filerName = stripHtml(docMatch[3]);
      const filingDate = docMatch[4];

      if (docType && docType !== 'Document Type' && docType.length > 1) {
        dossier.documents.push({
          doc_type: docType,
          filed_by: filedBy,
          filer_name: filerName,
          filing_date: filingDate,
        });
      }
    }
  }

  // Validate we got meaningful data
  const hasData =
    dossier.petitioner ||
    dossier.respondent ||
    dossier.status ||
    dossier.filing_date ||
    dossier.proceedings.length > 0;

  return hasData ? dossier : null;
}

async function scrapeCaseStatusDossiers(): Promise<void> {
  console.log('\n━━━ PHASE 3: Case Status Dossiers ━━━\n');

  const outDir = path.join(DATA_DIR, 'case-dossiers');
  const metaDir = path.join(DATA_DIR, 'metadata');
  ensureDir(outDir);
  ensureDir(metaDir);

  const progressFile = path.join(metaDir, 'case-scrape-progress.json');

  // Load or initialize progress
  let progress: CaseScrapeProgress = {
    last_case_type_id: 0,
    last_year: START_YEAR,
    last_case_no: 0,
    total_cases_found: 0,
    total_empty: 0,
    completed_types: [],
  };

  if (RESUME && fs.existsSync(progressFile)) {
    progress = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
    console.log(
      `Resuming from: type=${progress.last_case_type_id}, year=${progress.last_year}, case=${progress.last_case_no}`,
    );
    console.log(`Previously found: ${progress.total_cases_found} cases`);
  }

  const allDossiers: CaseDossier[] = [];
  const dossierFile = path.join(outDir, 'all_case_dossiers.jsonl');

  // If resuming, load existing dossiers count
  if (RESUME && fs.existsSync(dossierFile)) {
    const lines = fs
      .readFileSync(dossierFile, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    progress.total_cases_found = lines.length;
    console.log(`Existing dossiers in file: ${lines.length}`);
  }

  const caseTypeIds = Object.keys(CASE_TYPES)
    .map(Number)
    .sort((a, b) => a - b);
  const endpoint = `${BASE_URL}/Delhi/services/checkhomedetail1.php`;

  // Estimated max case numbers per type per year (from investigation)
  // Broadcasting Petition: ~460/year, others much less
  const MAX_CASE_ESTIMATES: Record<number, number> = {
    1: 500, // Broadcasting Petition (highest volume)
    2: 100, // Telecom Petition
    3: 50, // Broadcasting Appeal
    4: 30, // Telecom Appeal
    5: 150, // Misc Application
    7: 30, // Review Application
    8: 20, // EA
    9: 30, // AERA Petition
    10: 20, // AERA Appeal
    11: 15, // Cyber Appeal
  };

  const EMPTY_THRESHOLD = 10; // Stop after 10 consecutive empty results

  let shouldSkip = RESUME && progress.last_case_type_id > 0;

  for (const typeId of caseTypeIds) {
    if (progress.completed_types.includes(typeId)) {
      console.log(`Skipping completed type: ${CASE_TYPES[typeId]}`);
      continue;
    }

    const typeName = CASE_TYPES[typeId];
    const maxCaseEst = MAX_CASE_ESTIMATES[typeId] || 100;
    console.log(`\n── ${typeName} (ID: ${typeId}, est. max: ${maxCaseEst}/year) ──`);

    for (let year = START_YEAR; year <= END_YEAR; year++) {
      // Skip if resuming and haven't reached resume point
      if (shouldSkip) {
        if (typeId < progress.last_case_type_id) continue;
        if (typeId === progress.last_case_type_id && year < progress.last_year) continue;
        if (typeId === progress.last_case_type_id && year === progress.last_year) {
          shouldSkip = false;
          // Will start from last_case_no + 1
        } else if (typeId > progress.last_case_type_id) {
          shouldSkip = false;
        }
      }

      let consecutiveEmpty = 0;
      let yearCaseCount = 0;
      const startCaseNo =
        RESUME && typeId === progress.last_case_type_id && year === progress.last_year
          ? progress.last_case_no + 1
          : 1;

      for (let caseNo = startCaseNo; caseNo <= maxCaseEst + 50; caseNo++) {
        if (DRY_RUN && caseNo > 3) break;

        const body = `pet_type=1&casetype=${typeId}&caseno=${caseNo}&caseyear=${year}&submit1=Search`;

        try {
          const html = await postForm(endpoint, body);
          const dossier = parseCaseDossier(html, typeId, caseNo, year);

          if (dossier) {
            consecutiveEmpty = 0;
            yearCaseCount++;
            progress.total_cases_found++;

            // Append to JSONL file
            fs.appendFileSync(dossierFile, JSON.stringify(dossier) + '\n');

            if (yearCaseCount % 10 === 0 || yearCaseCount === 1) {
              console.log(
                `  ${typeName} ${caseNo}/${year}: ✓ ${dossier.petitioner?.substring(0, 30) || '?'} v. ${dossier.respondent?.substring(0, 30) || '?'} [${dossier.status}] (${dossier.proceedings.length} procs, ${dossier.documents.length} docs)`,
              );
            }
          } else {
            consecutiveEmpty++;
            progress.total_empty++;

            if (consecutiveEmpty >= EMPTY_THRESHOLD) {
              console.log(
                `  ${typeName} ${year}: ${yearCaseCount} cases found (stopped after ${EMPTY_THRESHOLD} empty at #${caseNo})`,
              );
              break;
            }
          }

          // Update progress
          progress.last_case_type_id = typeId;
          progress.last_year = year;
          progress.last_case_no = caseNo;

          // Save progress every 50 cases
          if (caseNo % 50 === 0 || consecutiveEmpty >= EMPTY_THRESHOLD) {
            fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
          }

          // Rate limiting - be gentle
          await sleep(200);
        } catch (err) {
          console.error(`  ✗ Error for ${typeName} ${caseNo}/${year}: ${err}`);
          await sleep(1000); // Back off on error
        }
      }

      if (yearCaseCount === 0 && year >= 2000) {
        console.log(`  ${typeName} ${year}: no cases found`);
      }
    }

    progress.completed_types.push(typeId);
    fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
    console.log(`\n✓ Completed ${typeName}. Running total: ${progress.total_cases_found} cases`);
  }

  // Save final progress and summary JSON
  fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));

  // Also create a summary JSON from the JSONL
  if (fs.existsSync(dossierFile)) {
    const lines = fs
      .readFileSync(dossierFile, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    const summary = {
      total_cases: lines.length,
      scrape_date: new Date().toISOString(),
      year_range: `${START_YEAR}-${END_YEAR}`,
      case_types_scraped: Object.values(CASE_TYPES),
    };
    fs.writeFileSync(path.join(outDir, 'scrape_summary.json'), JSON.stringify(summary, null, 2));
  }

  console.log(`\n✅ Case dossiers: ${progress.total_cases_found} cases → ${dossierFile}`);
}

// ── Main ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   TDSAT Supplementary Data Scraper       ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║ Mode: ${MODE.padEnd(35)}║`);
  console.log(`║ Concurrency: ${CONCURRENCY.toString().padEnd(28)}║`);
  console.log(`║ Dry Run: ${DRY_RUN.toString().padEnd(32)}║`);
  console.log(`║ Resume: ${RESUME.toString().padEnd(33)}║`);
  if (MODE === 'all' || MODE === 'cases') {
    console.log(
      `║ Case Years: ${START_YEAR}-${END_YEAR}${' '.repeat(24 - `${START_YEAR}-${END_YEAR}`.length)}║`,
    );
  }
  console.log('╚══════════════════════════════════════════╝');

  const startTime = Date.now();

  try {
    if (MODE === 'all' || MODE === 'judges') {
      await scrapeJudgeProfiles();
    }

    if (MODE === 'all' || MODE === 'notices') {
      await scrapeNotices();
    }

    if (MODE === 'all' || MODE === 'cases') {
      await scrapeCaseStatusDossiers();
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n━━━ All phases complete in ${elapsed}s ━━━`);
  } catch (err) {
    console.error(`\nFatal error: ${err}`);
    process.exit(1);
  }
}

main();
