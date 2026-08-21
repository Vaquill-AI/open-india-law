/**
 * CESTAT Supplementary Scraper
 *
 * Downloads all remaining valuable data from cestat.gov.in for Legal RAG:
 *   1. Larger Bench metadata (precedent-setting multi-member decisions)
 *   2. Member-wise order mapping (judge/member attribution)
 *   3. Notices, Circulars, RTI documents (administrative/procedural PDFs)
 *   4. Cause Lists (hearing schedules with bench composition)
 *   5. Judicial Manuals (2 static reference PDFs)
 *
 * Usage:
 *   npx tsx scripts/cestat-supplementary-scraper.ts
 *
 * Environment variables:
 *   TASKS=all              Comma-separated: larger-bench,members,notices,causelists,manuals (default: all)
 *   PDF_CONCURRENCY=40     Max concurrent PDF downloads (default: 40)
 *   DATA_DIR=data/cestat   Output directory (default: data/cestat)
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import PQueue from 'p-queue';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://cestat.gov.in';

const BENCHES = [
  { id: '107079', name: 'DELHI', slug: 'delhi' },
  { id: '127482', name: 'MUMBAI', slug: 'mumbai' },
  { id: '119315', name: 'KOLKATA', slug: 'kolkata' },
  { id: '133568', name: 'CHENNAI', slug: 'chennai' },
  { id: '129525', name: 'BANGALORE', slug: 'bangalore' },
  { id: '124438', name: 'AHMEDABAD', slug: 'ahmedabad' },
  { id: '109120', name: 'ALLAHABAD', slug: 'allahabad' },
  { id: '104044', name: 'CHANDIGARH', slug: 'chandigarh' },
  { id: '136507', name: 'HYDERABAD', slug: 'hyderabad' },
];

// All 100 CESTAT members extracted from /final-order-status-all page
const CESTAT_MEMBERS = [
  { id: '1', name: 'JUSTICE SACHCHIDANAND JHA' },
  { id: '2', name: 'JUSTICE R M S KHANDEPARKAR' },
  { id: '3', name: 'JYOTI BALASUNDARAM' },
  { id: '4', name: 'DR S L PEERAN' },
  { id: '5', name: 'DR C SATAPATHY' },
  { id: '6', name: 'T K JAYARAMAN' },
  { id: '7', name: 'DR T V SAIRAM' },
  { id: '8', name: 'P KARTHIKEYAN' },
  { id: '9', name: 'K K AGARWAL' },
  { id: '10', name: 'M VEERAIYAN' },
  { id: '11', name: 'A K SRIVASTAVA' },
  { id: '12', name: 'S K GAULE' },
  { id: '13', name: 'P R CHANDRASEKHARAN' },
  { id: '14', name: 'P BABU' },
  { id: '15', name: 'S VANKATESAN' },
  { id: '16', name: 'F S GILL' },
  { id: '17', name: 'G SANKARAN' },
  { id: '18', name: 'SH HARISH CHANDER' },
  { id: '19', name: 'JUSTICE U L BHAT' },
  { id: '20', name: 'JUSTICE K SREEDHARAN' },
  { id: '21', name: 'JUSTICE K K USHA' },
  { id: '22', name: 'JUSTICE R K ABHICHANDANI' },
  { id: '23', name: 'JUSTICE AJIT BHARIHOKE' },
  { id: '24', name: 'SH KRISHN KUMAR' },
  { id: '25', name: 'SH T ANJANEYULU' },
  { id: '26', name: 'SH S S SEKHON' },
  { id: '27', name: 'K D MANKAR' },
  { id: '28', name: 'SH MOHEB ALI M' },
  { id: '29', name: 'SH B S V MURTHY' },
  { id: '30', name: 'SH GOWRI SHANKAR' },
  { id: '31', name: 'SH C N B NAIR' },
  { id: '103', name: 'S.S.KANG' },
  { id: '105', name: 'ARCHANA WADHWA' },
  { id: '107', name: 'P.G.CHACKO' },
  { id: '112', name: 'M. V. RAVINDRAN' },
  { id: '117', name: 'D.N.PANDA' },
  { id: '118', name: 'P.K.DASS' },
  { id: '121', name: 'RAKESH KUMAR' },
  { id: '123', name: 'ASHOK JINDAL' },
  { id: '127', name: 'MR. SAHAB SINGH' },
  { id: '128', name: 'MATHEW JOHN' },
  { id: '130', name: 'D. M. MISRA' },
  { id: '132', name: 'ANIL CHOUDHARY' },
  { id: '133', name: 'MANMOHAN SINGH' },
  { id: '134', name: 'P.K. JAIN' },
  { id: '135', name: 'H.K. THAKUR' },
  { id: '137', name: 'JUSTICE G. RAGHURAM' },
  { id: '138', name: 'S. K. MOHANTY' },
  { id: '139', name: 'P.S.PRUTHI' },
  { id: '140', name: 'R.K.SINGH' },
  { id: '141', name: 'R. PERIASAMI' },
  { id: '142', name: 'P. K. CHOUDHARY' },
  { id: '143', name: 'SULEKHA BEEVI C.S.' },
  { id: '144', name: 'P. M. SALEEM' },
  { id: '145', name: 'ASHOK KUMAR ARYA' },
  { id: '146', name: 'B. RAVICHANDRAN' },
  { id: '147', name: 'RAJU' },
  { id: '148', name: 'C J MATHEW' },
  { id: '149', name: 'RAMESH KUMAR SINGLA' },
  { id: '150', name: 'RAMESH NAIR' },
  { id: '151', name: 'S. S. GARG' },
  { id: '152', name: 'DEVENDER SINGH' },
  { id: '153', name: 'VENKITKRISHNAN PADMANABHAN' },
  { id: '154', name: 'MADHU MOHAN DAMODAR' },
  { id: '155', name: 'ANIL.G.SHAKKARWAR' },
  { id: '156', name: 'JUSTICE (DR.) SATISH CHANDRA' },
  { id: '157', name: 'P. V. SUBBA RAO' },
  { id: '158', name: 'P DINESHA' },
  { id: '159', name: 'C. L. MAHAR' },
  { id: '160', name: 'AJAY SHARMA' },
  { id: '161', name: 'RACHNA GUPTA' },
  { id: '162', name: 'BIJAY KUMAR' },
  { id: '163', name: 'SANJIV SRIVASTAVA' },
  { id: '164', name: 'P. ANJANI KUMAR' },
  { id: '165', name: 'Dr. SUVENDU KUMAR PATI' },
  { id: '166', name: 'JUSTICE DILIP GUPTA' },
  { id: '168', name: 'BINU TAMTA' },
  { id: '169', name: 'R. MURALIDHAR' },
  { id: '170', name: 'SOMESH ARORA' },
  { id: '171', name: 'P.A. AUGUSTIAN' },
  { id: '172', name: 'HEMAMBIKA R. PRIYA' },
  { id: '173', name: 'M.M.PARTHIBAN' },
  { id: '174', name: 'RAJEEV TANDON' },
  { id: '175', name: 'K. ANPAZHAKAN' },
  { id: '176', name: 'M. AJIT KUMAR' },
  { id: '177', name: 'VASA SESHAGIRI RAO' },
  { id: '178', name: 'PULLELA NAGESWARA RAO' },
  { id: '179', name: 'R. BHAGYA DEVI' },
  { id: '180', name: 'A.K. JYOTISHI' },
  { id: '181', name: 'V.K. AGARWAL' },
  { id: '182', name: 'C.N.B NAIR' },
  { id: '183', name: 'ANGAD PRASAD' },
  { id: '184', name: 'AJAYAN T.V.' },
  { id: '185', name: 'Dr. AJAYA KRISHNA VISHVESHA' },
  { id: '186', name: 'SATENDRA VIKRAM SINGH' },
  { id: '187', name: 'G.R.SHARMA' },
  { id: '188', name: 'K. SHREEDHARAN' },
  { id: '189', name: 'P.S.BAJAJ' },
  { id: '190', name: 'K.K.BHATIA' },
  { id: '191', name: 'LAJJA RAM' },
];

interface SessionInfo {
  cookies: string;
  csrfToken: string;
}

// ─── Environment ─────────────────────────────────────────────────────────────

const TASKS_STR = process.env.TASKS || 'all';
const PDF_CONCURRENCY = parseInt(process.env.PDF_CONCURRENCY || '40', 10);
const DATA_DIR = process.env.DATA_DIR || 'data/tribunals/cestat';

const SUPP_DIR = path.join(DATA_DIR, 'supplementary');
const NOTICES_DIR = path.join(SUPP_DIR, 'notices');
const CAUSELISTS_DIR = path.join(SUPP_DIR, 'causelists');
const MANUALS_DIR = path.join(SUPP_DIR, 'manuals');
const METADATA_DIR = path.join(SUPP_DIR, 'metadata');

// ─── Utilities ───────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirs(): void {
  for (const dir of [SUPP_DIR, NOTICES_DIR, CAUSELISTS_DIR, MANUALS_DIR, METADATA_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const bench of BENCHES) {
    fs.mkdirSync(path.join(CAUSELISTS_DIR, bench.slug), { recursive: true });
  }
}

// ─── Session management ──────────────────────────────────────────────────────

async function getSession(page: string = 'final-order-status'): Promise<SessionInfo> {
  const url = `${BASE_URL}/${page}`;
  const response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  const setCookies = response.headers['set-cookie'] || [];
  const cookieStr = setCookies.map((c: string) => c.split(';')[0]).join('; ');

  const csrfMatch = response.data.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!csrfMatch) {
    throw new Error(`Failed to extract CSRF token from ${page}`);
  }

  return { cookies: cookieStr, csrfToken: csrfMatch[1] };
}

async function ajaxPost(
  session: SessionInfo,
  url: string,
  params: URLSearchParams,
  retries: number = 3,
): Promise<{ data: any; newCsrf: string }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(url, params.toString(), {
        timeout: 60000,
        headers: {
          Cookie: session.cookies,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        validateStatus: () => true,
      });

      const data = response.data;
      if (!data || typeof data !== 'object') {
        throw new Error(`Invalid response: ${typeof data}`);
      }

      // Check for CSRF errors
      if (data.data && !Array.isArray(data.data) && data.data.errors) {
        const errors = data.data.errors;
        if (errors.csrf_token || JSON.stringify(errors).includes('csrf')) {
          throw new Error('CSRF_EXPIRED');
        }
        throw new Error(`Server error: ${JSON.stringify(errors)}`);
      }

      return {
        data,
        newCsrf: data.csrf_token || session.csrfToken,
      };
    } catch (err: any) {
      if (err.message === 'CSRF_EXPIRED') {
        const fresh = await getSession('final-order-status-all');
        session.cookies = fresh.cookies;
        session.csrfToken = fresh.csrfToken;
        params.set('csrf_token', fresh.csrfToken);
        continue;
      }
      if (attempt === retries) throw err;
      const delay = 2000 * attempt;
      log(`  Retry ${attempt}/${retries} after ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
  throw new Error('Exhausted retries');
}

// ─── 1. Larger Bench Metadata ────────────────────────────────────────────────

async function scrapeLargerBench(): Promise<void> {
  log('═══ TASK 1: LARGER BENCH METADATA ═══');
  log('Scraping precedent-setting multi-member bench decisions...');

  const outFile = path.join(METADATA_DIR, 'larger_bench_orders.jsonl');
  let session = await getSession('final-order-status-all');
  let totalRecords = 0;

  // Search with wide date range to get all larger bench orders
  // Tab 2 = Larger Bench, uses from_date_l / to_date_l
  const years = Array.from({ length: 26 }, (_, i) => 2025 - i); // 2025 down to 2000

  for (const year of years) {
    const params = new URLSearchParams();
    params.append('csrf_token', session.csrfToken);
    params.append('tab', '2');
    params.append('from_date_l', `01-01-${year}`);
    params.append('to_date_l', `31-12-${year}`);
    params.append('captcha_code', '111111');

    try {
      const result = await ajaxPost(session, `${BASE_URL}/ajax/order-status-web-all`, params);
      session.csrfToken = result.newCsrf;

      const records = Array.isArray(result.data.data) ? result.data.data : [];

      if (records.length === 0) {
        log(`  ${year}: 0 larger bench orders`);
        continue;
      }

      // Parse and write records
      const parsed = records
        .map((row: string[]) => {
          // Larger bench format: [serial, case_number, parties_html, order_date, pdf_html]
          const partiesClean = (row[2] || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const partiesSplit = (row[2] || '').split(/<br\s*\/?>\s*vs\s*<br\s*\/?>/i);
          const appellant = partiesSplit[0] ? partiesSplit[0].replace(/<[^>]*>/g, '').trim() : '';
          const respondent = partiesSplit[1] ? partiesSplit[1].replace(/<[^>]*>/g, '').trim() : '';

          // Extract PDF URL - may be absolute or relative
          const pdfMatch = (row[4] || '').match(/href="([^"]+)"/);
          let pdfUrl = '';
          if (pdfMatch) {
            const rawUrl = pdfMatch[1].replace(/^\.\//, '');
            pdfUrl = rawUrl.startsWith('http') ? rawUrl : `${BASE_URL}/${rawUrl}`;
          }
          const pdfIdMatch = pdfUrl.match(/\/(\d+)$/);

          return {
            serial: row[0],
            case_number: (row[1] || '').trim(),
            parties: partiesClean,
            appellant,
            respondent,
            order_date: (row[3] || '').trim(),
            pdf_url: pdfUrl,
            pdf_id: pdfIdMatch ? pdfIdMatch[1] : '',
            bench_type: 'larger_bench',
            scraped_at: new Date().toISOString(),
          };
        })
        .filter((r: any) => r.pdf_url);

      const lines = parsed.map((r: any) => JSON.stringify(r)).join('\n');
      if (lines) {
        fs.appendFileSync(outFile, lines + '\n');
      }

      totalRecords += parsed.length;
      log(`  ${year}: ${parsed.length} larger bench orders`);
      await sleep(500);
    } catch (err: any) {
      log(`  ERROR ${year}: ${err.message}`);
      try {
        session = await getSession('final-order-status-all');
      } catch {
        await sleep(5000);
        session = await getSession('final-order-status-all');
      }
    }
  }

  log(`  Larger Bench complete: ${totalRecords} total records → ${outFile}`);
}

// ─── 2. Member-wise Order Mapping ────────────────────────────────────────────

async function scrapeMemberWise(): Promise<void> {
  log('═══ TASK 2: MEMBER-WISE ORDER MAPPING ═══');
  log('Mapping orders to authoring CESTAT members...');

  const outFile = path.join(METADATA_DIR, 'member_order_mapping.jsonl');
  let session = await getSession('final-order-status-all');
  let totalMappings = 0;

  // For each member, fetch their orders across years
  for (const member of CESTAT_MEMBERS) {
    let memberOrders = 0;

    // Tab 4 = Member-wise, uses member_name, from_date, to_date
    // Try a wide range first; if too many results, split by year
    const params = new URLSearchParams();
    params.append('csrf_token', session.csrfToken);
    params.append('tab', '4');
    params.append('member_name', member.id);
    params.append('from_date', '01-01-2000');
    params.append('to_date', '31-12-2025');
    params.append('captcha_code', '111111');

    try {
      const result = await ajaxPost(session, `${BASE_URL}/ajax/order-status-web-all`, params);
      session.csrfToken = result.newCsrf;

      const records = Array.isArray(result.data.data) ? result.data.data : [];

      if (records.length === 0) {
        log(`  ${member.name} (${member.id}): 0 orders`);
        continue;
      }

      // If we got results, check if we got all of them
      const total = result.data.iTotalRecords || records.length;

      if (total > records.length) {
        // Need to paginate by year
        log(`  ${member.name}: ${total} total, paginating by year...`);
        for (let year = 2025; year >= 2000; year--) {
          const yParams = new URLSearchParams();
          yParams.append('csrf_token', session.csrfToken);
          yParams.append('tab', '4');
          yParams.append('member_name', member.id);
          yParams.append('from_date', `01-01-${year}`);
          yParams.append('to_date', `31-12-${year}`);
          yParams.append('captcha_code', '111111');

          try {
            const yResult = await ajaxPost(
              session,
              `${BASE_URL}/ajax/order-status-web-all`,
              yParams,
            );
            session.csrfToken = yResult.newCsrf;

            const yRecords = Array.isArray(yResult.data.data) ? yResult.data.data : [];
            if (yRecords.length === 0) continue;

            const parsed = yRecords
              .map((row: string[]) => {
                const pdfMatch = (row[4] || '').match(/href="\.?\/?([^"]+)"/);
                const pdfPath = pdfMatch ? pdfMatch[1] : '';
                const pdfIdMatch = pdfPath.match(/\/(\d+)$/);
                return {
                  member_id: member.id,
                  member_name: member.name,
                  case_number: (row[1] || '').trim(),
                  order_date: (row[3] || '').trim(),
                  pdf_id: pdfIdMatch ? pdfIdMatch[1] : '',
                  year,
                };
              })
              .filter((r: any) => r.pdf_id);

            const lines = parsed.map((r: any) => JSON.stringify(r)).join('\n');
            if (lines) fs.appendFileSync(outFile, lines + '\n');
            memberOrders += parsed.length;
            await sleep(300);
          } catch {
            // Skip year on error
          }
        }
      } else {
        // Got all in one request
        const parsed = records
          .map((row: string[]) => {
            const pdfMatch = (row[4] || '').match(/href="\.?\/?([^"]+)"/);
            const pdfPath = pdfMatch ? pdfMatch[1] : '';
            const pdfIdMatch = pdfPath.match(/\/(\d+)$/);
            return {
              member_id: member.id,
              member_name: member.name,
              case_number: (row[1] || '').trim(),
              order_date: (row[3] || '').trim(),
              pdf_id: pdfIdMatch ? pdfIdMatch[1] : '',
            };
          })
          .filter((r: any) => r.pdf_id);

        const lines = parsed.map((r: any) => JSON.stringify(r)).join('\n');
        if (lines) fs.appendFileSync(outFile, lines + '\n');
        memberOrders = parsed.length;
      }

      totalMappings += memberOrders;
      log(`  ${member.name} (${member.id}): ${memberOrders} orders`);
      await sleep(300);
    } catch (err: any) {
      log(`  ERROR ${member.name}: ${err.message}`);
      try {
        session = await getSession('final-order-status-all');
      } catch {
        await sleep(5000);
        session = await getSession('final-order-status-all');
      }
    }
  }

  log(`  Member mapping complete: ${totalMappings} total mappings → ${outFile}`);
}

// ─── 3. Notices, Circulars & RTI Documents ───────────────────────────────────

interface NoticeRecord {
  id: number;
  title: string;
  date: string;
  category: string; // notices, circulars, tenders, rti
  pdf_url: string;
  pdf_file: string;
  scraped_at: string;
}

async function scrapeNotices(): Promise<void> {
  log('═══ TASK 3: NOTICES, CIRCULARS & RTI DOCUMENTS ═══');

  const metaFile = path.join(METADATA_DIR, 'notices_metadata.jsonl');
  const pdfDir = NOTICES_DIR;

  // Data is embedded in the HTML page (not AJAX), in 4 tables:
  // #notice (tab-1), #circular (tab-2), #tender (tab-3), #rti (tab-4)
  log('  Fetching noticestatus page (data embedded in HTML)...');
  const response = await axios.get(`${BASE_URL}/noticestatus`, {
    timeout: 60000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const html: string = response.data;
  const allNotices: NoticeRecord[] = [];

  // Parse each tab's table from the HTML
  // Tab boundaries in HTML:
  // Tab 1 (notices): lines 315 - ~5198 (id="notice")
  // Tab 2 (circulars): lines 5199 - ~31625 (id="circular")
  // Tab 3 (tenders): lines 31626 - ~31922 (id="tender")
  // Tab 4 (rti): lines 31923 - end (id="rti")

  const tabConfigs = [
    { id: 'notice', category: 'notices', label: 'Notices' },
    { id: 'circular', category: 'circulars', label: 'Circulars/Vacancies' },
    { id: 'tender', category: 'tenders', label: 'Tenders' },
    { id: 'rti', category: 'rti', label: 'RTI Responses' },
  ];

  for (const tabCfg of tabConfigs) {
    // Find the table for this tab
    const tableStartIdx = html.indexOf(`id="${tabCfg.id}"`);
    if (tableStartIdx === -1) {
      log(`  ${tabCfg.label}: table not found`);
      continue;
    }

    // Find the end of this table
    const tableEndStr = '</table>';
    const tableEndIdx = html.indexOf(tableEndStr, tableStartIdx);
    if (tableEndIdx === -1) continue;

    const tableHtml = html.slice(tableStartIdx, tableEndIdx + tableEndStr.length);

    // Extract rows: each <tr> in <tbody> contains <td>serial</td><td><a href="./openfile/2/ID">Title</a></td><td>date</td>
    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    let rowMatch;
    let count = 0;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[0];
      // Extract cells
      const cells: string[] = [];
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        cells.push(cellMatch[1]);
      }
      if (cells.length < 2) continue;

      // Find openfile link
      const idMatch = rowHtml.match(/openfile\/2\/(\d+)/);
      if (!idMatch) continue;

      const docId = parseInt(idMatch[1], 10);
      const title = cells[1].replace(/<[^>]*>/g, '').trim();
      const date = cells.length >= 3 ? cells[2].replace(/<[^>]*>/g, '').trim() : '';

      allNotices.push({
        id: docId,
        title,
        date,
        category: tabCfg.category,
        pdf_url: `${BASE_URL}/openfile/2/${docId}`,
        pdf_file: `${tabCfg.category}_${docId}.pdf`,
        scraped_at: new Date().toISOString(),
      });
      count++;
    }

    log(`  ${tabCfg.label}: ${count} entries`);
  }

  // Write metadata
  const lines = allNotices.map((n) => JSON.stringify(n)).join('\n');
  if (lines) fs.writeFileSync(metaFile, lines + '\n');
  log(`  Metadata: ${allNotices.length} documents → ${metaFile}`);

  // Download PDFs
  // Note: /openfile/2/{id} returns HTTP 404 status but body IS valid PDF
  log(`  Downloading ${allNotices.length} PDFs...`);
  const queue = new PQueue({ concurrency: PDF_CONCURRENCY });
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;

  const tasks = allNotices.map((notice) =>
    queue.add(async () => {
      const outPath = path.join(pdfDir, notice.pdf_file);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
        skipped++;
        return;
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const resp = await axios.get(notice.pdf_url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            // Accept ANY status since this endpoint returns 404 with valid PDF body
            validateStatus: () => true,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
          });

          const buffer = Buffer.from(resp.data);
          // Verify it's a PDF (starts with %PDF)
          if (buffer.length > 4 && buffer.slice(0, 4).toString() === '%PDF') {
            fs.writeFileSync(outPath, buffer);
            downloaded++;
            return;
          } else {
            // Not a PDF, skip
            failed++;
            return;
          }
        } catch {
          if (attempt === 3) {
            failed++;
          } else {
            await sleep(1000 * attempt);
          }
        }
      }
    }),
  );

  await Promise.all(tasks);
  await queue.onIdle();

  log(`  Notices complete: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
}

// ─── 4. Cause Lists ─────────────────────────────────────────────────────────

async function scrapeCauseLists(): Promise<void> {
  log('═══ TASK 4: CAUSE LISTS ═══');

  const metaFile = path.join(METADATA_DIR, 'causelists_metadata.jsonl');
  let totalPdfs = 0;
  let totalMeta = 0;

  // For each bench, fetch causelists going back in time
  // The causelist endpoint: POST /viewcauselist with schemas={bench_id}, from={DD-MM-YYYY}, captcha_code=111111
  // Returns HTML with links like /openfilec/{bench_id}/{causelist_id}

  for (const bench of BENCHES) {
    let session = await getSession('viewcauselist');
    const benchDir = path.join(CAUSELISTS_DIR, bench.slug);

    // Scan last ~2 years of causelists (daily, going back)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);

    const currentDate = new Date(endDate);
    let benchMeta = 0;
    let benchPdfs = 0;

    while (currentDate >= startDate) {
      const dd = String(currentDate.getDate()).padStart(2, '0');
      const mm = String(currentDate.getMonth() + 1).padStart(2, '0');
      const yyyy = currentDate.getFullYear();
      const dateStr = `${dd}-${mm}-${yyyy}`;

      const params = new URLSearchParams();
      params.append('csrf_token', session.csrfToken);
      params.append('schemas', bench.id);
      params.append('from', dateStr);
      params.append('captcha_code', '111111');

      try {
        const response = await axios.post(`${BASE_URL}/viewcauselist`, params.toString(), {
          timeout: 30000,
          headers: {
            Cookie: session.cookies,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          validateStatus: () => true,
        });

        // Update cookies if refreshed
        const newCookies = response.headers['set-cookie'];
        if (newCookies) {
          session.cookies = newCookies.map((c: string) => c.split(';')[0]).join('; ');
        }

        // Extract CSRF from response HTML for next request
        const csrfMatch = response.data.match(/name="csrf_token"\s+value="([^"]+)"/);
        if (csrfMatch) {
          session.csrfToken = csrfMatch[1];
        }

        const html: string = response.data;
        // Find causelist links: /openfilec/{bench_id}/{causelist_id}
        const linkRegex = /\/openfilec\/(\d+)\/(\d+)/g;
        let match;
        const clLinks: { benchId: string; clId: string; benchType: string }[] = [];

        while ((match = linkRegex.exec(html)) !== null) {
          clLinks.push({ benchId: match[1], clId: match[2], benchType: '' });
        }

        // Also extract bench type info from surrounding HTML
        // Pattern: <td>SERVICE TAX (DB)</td> ... <a href="/openfilec/...">
        const benchTypeRegex =
          /(?:<td[^>]*>([^<]*(?:SM|DB|MB)[^<]*)<\/td>[\s\S]*?)?\/openfilec\/(\d+)\/(\d+)/g;
        let btMatch;
        while ((btMatch = benchTypeRegex.exec(html)) !== null) {
          const existing = clLinks.find((l) => l.clId === btMatch[3]);
          if (existing && btMatch[1]) {
            existing.benchType = btMatch[1].trim();
          }
        }

        if (clLinks.length === 0) {
          // No causelists for this date, skip
          currentDate.setDate(currentDate.getDate() - 1);
          continue;
        }

        // Deduplicate
        const unique = [...new Map(clLinks.map((l) => [l.clId, l])).values()];

        // Write metadata
        for (const cl of unique) {
          const meta = {
            bench: bench.slug,
            bench_id: cl.benchId,
            causelist_id: cl.clId,
            date: dateStr,
            bench_type: cl.benchType,
            pdf_url: `${BASE_URL}/openfilec/${cl.benchId}/${cl.clId}`,
            scraped_at: new Date().toISOString(),
          };
          fs.appendFileSync(metaFile, JSON.stringify(meta) + '\n');
          benchMeta++;
        }

        // Download PDFs
        const queue = new PQueue({ concurrency: 10 });
        for (const cl of unique) {
          queue.add(async () => {
            const outPath = path.join(benchDir, `${cl.clId}.pdf`);
            if (fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
              return;
            }

            try {
              const resp = await axios.get(`${BASE_URL}/openfilec/${cl.benchId}/${cl.clId}`, {
                responseType: 'arraybuffer',
                timeout: 30000,
                validateStatus: () => true,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
              });

              const buffer = Buffer.from(resp.data);
              if (buffer.length > 4 && buffer.slice(0, 4).toString() === '%PDF') {
                fs.writeFileSync(outPath, buffer);
                benchPdfs++;
              }
            } catch {
              // Skip failed downloads
            }
          });
        }

        await queue.onIdle();
        await sleep(200);
      } catch (err: any) {
        // Session expired - refresh
        try {
          session = await getSession('viewcauselist');
        } catch {
          await sleep(5000);
          session = await getSession('viewcauselist');
        }
      }

      currentDate.setDate(currentDate.getDate() - 1);
    }

    totalMeta += benchMeta;
    totalPdfs += benchPdfs;
    log(`  ${bench.name}: ${benchMeta} causelists, ${benchPdfs} PDFs`);
  }

  log(`  Cause Lists complete: ${totalMeta} metadata records, ${totalPdfs} PDFs`);
}

// ─── 5. Judicial Manuals ────────────────────────────────────────────────────

async function downloadManuals(): Promise<void> {
  log('═══ TASK 5: JUDICIAL MANUALS ═══');

  const manuals = [
    { url: `${BASE_URL}/includes/vol-1.pdf`, name: 'cestat_judicial_manual_vol1.pdf' },
    { url: `${BASE_URL}/includes/vol2.pdf`, name: 'cestat_judicial_manual_vol2.pdf' },
  ];

  for (const manual of manuals) {
    const outPath = path.join(MANUALS_DIR, manual.name);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
      log(`  ${manual.name}: already downloaded, skipping`);
      continue;
    }

    try {
      const resp = await axios.get(manual.url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      fs.writeFileSync(outPath, Buffer.from(resp.data));
      const sizeMB = (resp.data.byteLength / (1024 * 1024)).toFixed(1);
      log(`  ${manual.name}: ${sizeMB} MB downloaded`);
    } catch (err: any) {
      log(`  ERROR ${manual.name}: ${err.message}`);
    }
  }

  log('  Judicial Manuals complete');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();

  log('╔══════════════════════════════════════════════════════════════╗');
  log('║        CESTAT SUPPLEMENTARY SCRAPER                        ║');
  log('║        Notices, Circulars, Members, Larger Bench, etc.     ║');
  log('╚══════════════════════════════════════════════════════════════╝');

  ensureDirs();

  const allTasks = ['larger-bench', 'members', 'notices', 'causelists', 'manuals'];
  const tasksToRun = TASKS_STR === 'all' ? allTasks : TASKS_STR.split(',').map((t) => t.trim());

  log(`Tasks: ${tasksToRun.join(', ')}`);
  log(`PDF Concurrency: ${PDF_CONCURRENCY}`);
  log(`Data Dir: ${DATA_DIR}`);
  log('');

  if (tasksToRun.includes('manuals')) {
    await downloadManuals();
    log('');
  }

  if (tasksToRun.includes('larger-bench')) {
    await scrapeLargerBench();
    log('');
  }

  if (tasksToRun.includes('members')) {
    await scrapeMemberWise();
    log('');
  }

  if (tasksToRun.includes('notices')) {
    await scrapeNotices();
    log('');
  }

  if (tasksToRun.includes('causelists')) {
    await scrapeCauseLists();
    log('');
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  log(`═══ ALL SUPPLEMENTARY TASKS COMPLETE in ${elapsed} min ═══`);

  // Print summary
  log('\nOutput files:');
  const metaFiles = fs.readdirSync(METADATA_DIR).filter((f) => f.endsWith('.jsonl'));
  for (const f of metaFiles) {
    const filePath = path.join(METADATA_DIR, f);
    const lineCount = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).length;
    log(`  ${f}: ${lineCount.toLocaleString()} records`);
  }

  const noticeCount = fs.readdirSync(NOTICES_DIR).filter((f) => f.endsWith('.pdf')).length;
  log(`  notices/ PDFs: ${noticeCount.toLocaleString()}`);

  let clCount = 0;
  for (const bench of BENCHES) {
    const benchDir = path.join(CAUSELISTS_DIR, bench.slug);
    if (fs.existsSync(benchDir)) {
      clCount += fs.readdirSync(benchDir).filter((f) => f.endsWith('.pdf')).length;
    }
  }
  log(`  causelists/ PDFs: ${clCount.toLocaleString()}`);

  const manualCount = fs.existsSync(MANUALS_DIR)
    ? fs.readdirSync(MANUALS_DIR).filter((f) => f.endsWith('.pdf')).length
    : 0;
  log(`  manuals/ PDFs: ${manualCount}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
