// generate-reports.js

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const Handlebars = require('handlebars');
const puppeteer  = require('puppeteer');
const dayjs      = require('dayjs');
const { createClient } = require('@supabase/supabase-js');
const sgMail     = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// 0) Chunk-Config über ENV
const CHUNK_SIZE  = parseInt(process.env.CHUNK_SIZE, 10)  || Number.MAX_SAFE_INTEGER;
const CHUNK_INDEX = parseInt(process.env.CHUNK_INDEX, 10) || 0;

// 1) Supabase-Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2) Interval-Parsing und Runden auf Minuten
function parseIntervalToMs(interval) {
  if (typeof interval !== 'string') return 0;
  const neg = interval.trim().startsWith('-');
  const [h='0', m='0', s='0'] = interval.replace(/^-/, '').split(':');
  const totalSec = Number(h)*3600 + Number(m)*60 + Number(s);
  const totalMin = Math.round(totalSec / 60);
  return neg ? -totalMin * 60 * 1000 : totalMin * 60 * 1000;
}
function formatSigned(ms) {
  const neg = ms < 0;
  const absMs = Math.abs(ms);
  const totalMin = Math.floor(absMs / 60000);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  const str = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
  return neg ? `-${str}` : str;
}

// 3) Template & Logo laden
const templatePath = path.join(__dirname, 'template.html');
if (!fs.existsSync(templatePath)) {
  console.error('template.html fehlt');
  process.exit(1);
}
const templateSource = fs.readFileSync(templatePath, 'utf-8');
const template       = Handlebars.compile(templateSource);

let logoDataUri = '';
const logoPath = path.join(__dirname, 'logo.png');
if (fs.existsSync(logoPath)) {
  const buf = fs.readFileSync(logoPath);
  logoDataUri = 'data:image/png;base64,' + buf.toString('base64');
}

// 4) Hauptfunktion
async function run() {
  const today      = dayjs();
  const dayOfMonth = today.date();

  // 4a) Alle Kunden abrufen
  const { data: allKunden, error: kErr } = await supabase
    .schema('management')
    .from('kunden')
    .select('id, firma_slug, firmenname, kontakt_name, kontakt_email, pdf_versand_tag');
  if (kErr) throw kErr;

  // 4b) Nach heutigem pdf_versand_tag filtern
  const due = allKunden.filter(k => Number(k.pdf_versand_tag) === dayOfMonth);

  if (!due.length) {
    console.log('→ Keine Reports heute.');
    return;
  }

  // 4c) Chunking: slice den passenden Abschnitt
  const start = CHUNK_INDEX * CHUNK_SIZE;
  const slice = due.slice(start, start + CHUNK_SIZE);
  if (!slice.length) {
    console.log(`→ Chunk ${CHUNK_INDEX} ist leer (start=${start}, size=${CHUNK_SIZE}).`);
    return;
  }

  // 4d) Pro Kunde im Chunk
  for (const k of slice) {
    const schema    = k.firma_slug;
    const startDate = today.subtract(1, 'month').date(dayOfMonth).format('YYYY-MM-DD');
    const endDate   = today.subtract(1, 'day').format('YYYY-MM-DD');
    const monatName = dayjs(endDate).format('MMMM').toLowerCase();
    const jahr      = dayjs(startDate).format('YYYY');

    console.log(`\n→ [Chunk ${CHUNK_INDEX}] Kunde: ${schema} (Bericht ${monatName.charAt(0).toUpperCase()+monatName.slice(1)} ${jahr})`);

    // RPC: Arbeiter
    const { data: workers, error: wErr } = await supabase
      .schema('management')
      .rpc('get_arbeiter', { schema_name: schema });
    if (wErr || !workers?.length) {
      console.error('   ✖ get_arbeiter fehlgeschlagen oder leer');
      continue;
    }

    // 4e) Pro Arbeiter PDF bauen & hochladen
    for (const a of workers) {
      // RPC: Zeiteinträge
      const { data: zeiten, error: tErr } = await supabase
        .schema('management')
        .rpc('get_zeiten', {
          schema_name: schema,
          mitarbeiter: a.id,
          start_date:  startDate,
          end_date:    endDate
        });
      if (tErr || !zeiten) {
        console.error('     ✖ get_zeiten fehlgeschlagen');
        continue;
      }

      // Zeilen-HTML + Summen runden
      let gesNettoMs = 0, gesUberMs = 0;
      const zeilenHtml = zeiten.map(z => {
        const nettoMs = parseIntervalToMs(z.nettoarbeitszeit);
        const uberMs  = parseIntervalToMs(z.ueberstunden);
        const pauseMs = parseIntervalToMs(z.pausendauer);
        gesNettoMs += nettoMs;
        gesUberMs  += uberMs;
        return `
          <tr>
            <td>${dayjs(z.datum).format('DD.MM.YYYY')}</td>
            <td>${z.status}</td>
            <td>${z.arbeitsbeginn ? dayjs(z.arbeitsbeginn).format('HH:mm') : ''}</td>
            <td>${z.feierabend    ? dayjs(z.feierabend).format('HH:mm')   : ''}</td>
            <td>${formatSigned(pauseMs)} Std.</td>
            <td>${formatSigned(nettoMs)} Std.</td>
            <td>${formatSigned(uberMs)} Std.</td>
          </tr>`;
      }).join('');

      // Template füllen
      const html = template({
        logo:                    logoDataUri,
        Monat:                   monatName.charAt(0).toUpperCase() + monatName.slice(1),
        Jahr:                    jahr,
        firma_name:              k.firmenname,
        arbeiter:                { name: a.name },
        zeilen:                  zeilenHtml,
        gesamt_nettoarbeitszeit: formatSigned(gesNettoMs) + ' Std.',
        gesamt_ueberstunden:     formatSigned(gesUberMs)  + ' Std.',
        erstellungsdatum:        today.format('DD.MM.YYYY')
      });

      // PDF generieren
      const browser = await puppeteer.launch({ args:['--no-sandbox'] });
      const page    = await browser.newPage();
      await page.setContent(html, { waitUntil:'networkidle0' });
      const pdfBuffer = await page.pdf({ format:'A4', printBackground:true });
      await browser.close();

      // Upload ohne Unterordner
      const safeName   = a.name.replace(/ /g,'_');
      const uploadName = `${schema}-${safeName}-${monatName}-${jahr}.pdf`;
      const { error: upErr } = await supabase
        .storage
        .from('reports')
        .upload(uploadName, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true
        });
      if (upErr) {
        console.error(`     ✖ Upload ${uploadName}:`, upErr.message);
      } else {
        console.log(`     ✔ Hochgeladen: ${uploadName}`);
      }
    }

    // 4f) E-Mail an den Kunden versenden
    const empfaenger = k.kontakt_email || process.env.DEFAULT_REPORT_EMAIL;
    if (empfaenger) {
      const mail = {
        to: empfaenger,
        from: 'info@chrono-duo.de', // muss bei SendGrid verifiziert sein!
        subject: `ChronoPilot Berichtsversand – ${k.firmenname || k.firma_slug}`,
        text: `Hallo ${k.kontakt_name || 'Anwender'},\n\nIhr Monatsbericht für ${monatName.charAt(0).toUpperCase()+monatName.slice(1)} ${jahr} wurde soeben bereitgestellt. Die PDFs liegen für Sie im ChronoPilot-System bereit.\n\nViele Grüße\nIhr ChronoPilot Team`,
      };
      try {
        await sgMail.send(mail);
        console.log(`   ✔ Mail an ${empfaenger} gesendet.`);
      } catch (mailErr) {
        console.error(`   ✖ Mail an ${empfaenger} fehlgeschlagen:`, mailErr.message);
      }
    }

    // 4g) lastversand updaten
    const { error: lvErr } = await supabase
      .schema('management')
      .rpc('set_lastversand', {
        kunden_id: k.id,
        new_last:  dayOfMonth
      });
    if (lvErr) {
      console.error(`   ✖ lastversand für ${schema} konnte nicht gesetzt werden:`, lvErr.message);
    } else {
      console.log(`   → lastversand für ${schema} = ${dayOfMonth}`);
    }
  }

  console.log('\n✅ generate-reports.js abgeschlossen (Chunk ' + CHUNK_INDEX + ')');
}

run().catch(err => {
  console.error('❌ Fehler:', err.message);
  process.exit(1);
});
