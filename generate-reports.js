// generate-reports.js

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const Handlebars = require('handlebars');
const puppeteer  = require('puppeteer');
const dayjs      = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

// 1) Supabase-Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2) Interval‐Parsing (HH:MM:SS → ms)
function parseIntervalToMs(interval) {
  if (typeof interval !== 'string') return 0;
  const [h='0', m='0', s='0'] = interval.split(':');
  return (Number(h)*3600 + Number(m)*60 + Number(s)) * 1000;
}
function msToHHMM(ms) {
  const totalSec = Math.floor(ms/1000);
  const hh = Math.floor(totalSec/3600);
  const mm = Math.floor((totalSec%3600)/60);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
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

  // 4a) Alle Kunden aus management.kunden
  const { data: allKunden, error: kErr } = await supabase
    .schema('management')
    .from('kunden')
    .select('id, firma_slug, firmenname, pdf_versand_tag');
  if (kErr) throw kErr;

  // 4b) Filtern nach heutigem Versand-Tag
  const kunden = allKunden.filter(k => k.pdf_versand_tag === dayOfMonth);
  if (!kunden.length) {
    console.log('Keine Reports heute');
    return;
  }

  // 4c) Pro Kunde
  for (const k of kunden) {
    const schema     = k.firma_slug;
    const startDate  = today.subtract(1, 'month').date(dayOfMonth).format('YYYY-MM-DD');
    const endDate    = today.subtract(1, 'day').format('YYYY-MM-DD');
    const monatName  = dayjs(startDate).format('MMMM').toLowerCase();
    const jahr       = dayjs(startDate).format('YYYY');

    // RPC: Alle Arbeiter
    const { data: workers } = await supabase
      .schema('management')
      .rpc('get_arbeiter', { schema_name: schema });
    if (!workers?.length) continue;

    // 4d) Pro Arbeiter
    for (const a of workers) {
      // RPC: Zeiteinträge
      const { data: zeiten } = await supabase
        .schema('management')
        .rpc('get_zeiten', {
          schema_name: schema,
          mitarbeiter: a.id,
          start_date:  startDate,
          end_date:    endDate
        });
      if (!zeiten) continue;

      // 4e) Zeilen‐HTML bauen
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
            <td>${msToHHMM(pauseMs)} Std.</td>
            <td>${msToHHMM(nettoMs)} Std.</td>
            <td>${msToHHMM(uberMs)} Std.</td>
          </tr>`;
      }).join('');

      // 4f) Template‐Kontext
      const html = template({
        logo:                    logoDataUri,
        Monat:                   monatName.charAt(0).toUpperCase() + monatName.slice(1),
        Jahr:                    jahr,
        firma_name:              k.firmenname,
        arbeiter:                { name: a.name },
        zeilen:                  zeilenHtml,
        gesamt_nettoarbeitszeit: msToHHMM(gesNettoMs) + ' Std.',
        gesamt_ueberstunden:     msToHHMM(gesUberMs)  + ' Std.',
        erstellungsdatum:        today.format('DD.MM.YYYY')
      });

      // 4g) PDF generieren
      const browser = await puppeteer.launch({ args:['--no-sandbox'] });
      const page    = await browser.newPage();
      await page.setContent(html, { waitUntil:'networkidle0' });
      const pdfBuffer = await page.pdf({ format:'A4', printBackground:true });
      await browser.close();

      // 4h) Upload direkt im Bucket
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
        console.error(`Upload ${uploadName} fehlgeschlagen:`, upErr.message);
      } else {
        console.log(`✔ Hochgeladen: ${uploadName}`);
      }
    }

    // 4i) lastversand updaten
    const { error: lvErr } = await supabase
      .schema('management')
      .rpc('set_lastversand', {
        kunden_id: k.id,
        new_last:  dayOfMonth
      });
    if (lvErr) {
      console.error(`lastversand für ${schema} konnte nicht gesetzt werden:`, lvErr.message);
    } else {
      console.log(`→ lastversand für ${schema} = ${dayOfMonth}`);
    }
  }
}

run().catch(err => {
  console.error('Fehler:', err.message);
  process.exit(1);
});
