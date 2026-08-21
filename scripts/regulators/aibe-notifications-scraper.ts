import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    'Missing environment variables: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

interface AIBENotification {
  id: string;
  title: string;
  date: string; // ISO date string if possible, or original text
  content: string;
  link?: string;
  is_new?: boolean;
}

async function scrapeAIBENotifications() {
  console.log('Starting AIBE notification scrape...');

  try {
    // 1. Fetch the AIBE homepage
    const response = await fetch('https://www.allindiabarexamination.com/');
    if (!response.ok) {
      throw new Error(`Failed to fetch AIBE website: ${response.statusText}`);
    }
    const html = await response.text();

    // 2. Parse HTML
    const $ = cheerio.load(html);
    const notifications: AIBENotification[] = [];

    // 3. Extract Notifications
    // Selector based on browser inspection: section.Notice
    $('section.Notice').each((_, element) => {
      const $el = $(element);

      // Title usually in h3 or h5
      const $title = $el.find('h3, h5').first();
      const titleText = $title.text().trim();

      // Content in p tags
      const $content = $el.find('p').first(); // simplistic, maybe take all text?
      const contentText = $content.text().trim();

      // Attempt to extract date from title or content
      // Format usually: "Important Notice Dated 14/01/2026"
      const dateMatch = titleText.match(/(\d{2})[/\-.](\d{2})[/\-.](\d{4})/);
      let date = new Date().toISOString(); // Default to now if parse fails

      if (dateMatch) {
        // DD/MM/YYYY -> YYYY-MM-DD
        const [_, day, month, year] = dateMatch;
        try {
          date = new Date(`${year}-${month}-${day}`).toISOString();
        } catch (e) {
          console.warn('Failed to parse date:', dateMatch[0]);
        }
      }

      // Check for links/attachments
      const $link = $el.find('a').first();
      let link = $link.attr('href');
      if (link && !link.startsWith('http')) {
        link = `https://www.allindiabarexamination.com/${link}`;
      }

      if (titleText) {
        notifications.push({
          id: Buffer.from(titleText).toString('base64').substring(0, 10), // persistent ID based on title
          title: titleText,
          date: date,
          content: contentText,
          link: link || undefined,
          is_new: true, // potentially flag logic could be complex, keeping simple for now
        });
      }
    });

    console.log(`Found ${notifications.length} notifications.`);

    if (notifications.length === 0) {
      console.warn('No notifications found. Selectors might need update.');
      return;
    }

    // 4. Update Database
    // Get the current active exam
    const { data: currentExam, error: fetchError } = await supabase
      .from('aibe_exams')
      .select('id, edition_number')
      .eq('is_active', true)
      .single();

    if (fetchError || !currentExam) {
      console.error('No active AIBE exam found to update.', fetchError);
      return;
    }

    console.log(
      `Updating AIBE ${currentExam.edition_number} (ID: ${currentExam.id}) with latest notifications.`,
    );

    const { error: updateError } = await supabase
      .from('aibe_exams')
      .update({
        notifications: notifications,
        // updated_at: new Date().toISOString() // Assuming there is an updated_at column
      })
      .eq('id', currentExam.id);

    if (updateError) {
      console.error('Failed to update database:', updateError);
      throw updateError;
    }

    console.log('Success! Database updated.');
  } catch (error) {
    console.error('Error scraping AIBE notifications:', error);
    process.exit(1);
  }
}

scrapeAIBENotifications();
