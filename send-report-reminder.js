const sgMail = require('@sendgrid/mail');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
sgMail.setApiKey(SENDGRID_API_KEY);

async function main() {
  const today = new Date().getDate();
  console.log("HEUTE ist der Tag:", today);

  const url = `${SUPABASE_URL}/rest/v1/kunden?select=firma_slug,kontakt_email,kontakt_name,pdf_versand_tag,status`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) throw new Error(`Fehler beim Laden der Kunden: ${res.statusText}`);
  const allKunden = await res.json();

  // Jetzt im Skript filtern
  const data = allKunden.filter(
    k => Number(k.pdf_versand_tag) === today && k.status === "aktiv"
  );
  console.log("Gefundene Kunden für Versand:", data);

  if (!data.length) {
    console.log('Keine Kunden für den heutigen Versandtag.');
    return;
  }

  for (const kunde of data) {
    if (!kunde.kontakt_email) continue;
    const msg = {
      to: kunde.kontakt_email,
      from: 'info@chrono-duo.de',
      subject: 'Ihr Berichtsversand bei ChronoPilot',
      text: `Hallo ${kunde.kontakt_name},\n\nheute werden Ihre Monatsberichte per PDF verschickt. Bei Fragen melden Sie sich gerne bei uns.\n\nViele Grüße\nIhr ChronoPilot Team`,
    };
    await sgMail.send(msg);
    console.log(`E-Mail an ${kunde.kontakt_email} gesendet.`);
  }
}

main().catch(err => {
  console.error('Fehler:', err);
  process.exit(1);
});
