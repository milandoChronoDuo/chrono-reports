// .github/scripts/send-report-reminder.js

const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

async function main() {
  // Aktueller Tag (z. B. 20)
  const today = new Date().getDate();

  const { data, error } = await supabase
    .from('kunden')
    .select('firma_slug, kontakt_email, firmenname')
    .eq('pdf_versand_tag', today)
    .eq('status', 'aktiv'); // Optional

  if (error) throw error;
  if (!data || data.length === 0) {
    console.log('Keine Kunden für den heutigen Versandtag.');
    return;
  }

  for (const kunde of data) {
    if (!kunde.kontakt_email) continue;
    const msg = {
      to: kunde.kontakt_email,
      from: 'noreply@DEINEDOMAIN.de', // muss mit SendGrid-Settings matchen
      subject: 'Ihr Berichtsversand bei ChronoPilot',
      text: `Hallo ${kunde.firmenname},\n\nHeute werden Ihre Monatsberichte per PDF verschickt. Bei Fragen melden Sie sich gerne.\n\nViele Grüße,\nIhr ChronoPilot Team`
    };
    await sgMail.send(msg);
    console.log(`E-Mail an ${kunde.kontakt_email} gesendet.`);
  }
}
main().catch(err => {
  console.error('Fehler:', err);
  process.exit(1);
});
