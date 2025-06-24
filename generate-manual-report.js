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

// Argumente: via ENV oder CLI
const schema     = process.env.SCHEMA      || process.argv[2];
const workerIds  = (process.env.WORKERS    || process.argv[3] || '').split(',').filter(Boolean); // UUIDs
const startDate  = process.env.START_DATE  || process.argv[4]; // yyyy-mm-dd
const endDate    = process.env.END_DATE    || process.argv[5]; // yyyy-mm-dd

if (!schema || !workerIds.length || !startDate || !endDate) {
  console.error('Fehlende Argumente: schema, workers, start_date, end_date');
  process.exit(1);
}

// Template laden
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

// DEUTSCHE MONATSNAMEN-Mapping
const MONATE_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
];
function getGermanMonth(dateStr) {
  const monthIdx = dayjs(dateStr).month(); // 0-basiert
  return MONATE_DE[monthIdx] || '';
}
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

// Hauptfunktion
async function run() {
  // Firmenname aus management.kunden
  const { data: kunde, error: kErr } = await supabase
    .schema('management')
    .from('kunden')
    .select('firmenname')
    .eq('firma_slug', schema)
    .maybeSingle();
  if (kErr || !kunde) {
    console.error('Firmenname konnte nicht geladen werden.');
    process.exit(1);
  }
  const firma_name = kunde.firmenname;

  // Arbeiterdaten laden (Name)
  const { data: workers, error: wErr } = await supabase
    .schema(schema)
    .from('arbeiter')
    .select('id, name')
    .in('id', workerIds);
  if (wErr || !workers?.length) {
    console.error('Arbeiterdaten konnten nicht geladen werden.');
    process.exit(1);
  }

  for (const a of workers) {
    // Zeiteinträge für Zeitraum laden
    const { data: zeiten, error: tErr } = await supabase
      .schema(schema)
      .from('zeiten')
      .select('*')
      .eq('mitarbeiter_id', a.id)
      .gte('datum', startDate)
      .lte('datum', endDate)
      .order('datum', { ascending: true });

    if (tErr || !zeiten) {
      console.error(`Zeiten für ${a.name} konnten nicht geladen werden.`);
      continue;
    }

    // Monat & Jahr aus Startdatum
    const monatName = getGermanMonth(startDate);
    const jahr      = dayjs(startDate).format('YYYY');

    // Nächste Revision herausfinden:
    const safeName = a.name.replace(/ /g, '_');
    const prefix = `${schema}-${safeName}-${monatName}-${jahr}-rev`;
    // Liste der vorhandenen Dateien im Bucket
    const { data: files, error: listErr } = await supabase
      .storage
      .from('reports')
      .list('', { limit: 1000 });
    let revNum = 1;
    if (files && files.length > 0) {
      const regex = new RegExp(`^${schema}-${safeName}-${monatName}-${jahr}-rev(\\d+)\\.pdf$`, 'i');
      const revisions = files
        .map(f => {
          const m = f.name.match(regex);
          return m ? Number(m[1]) : null;
        })
        .filter(Boolean);
      if (revisions.length > 0) {
        revNum = Math.max(...revisions) + 1;
      }
    }
    const uploadName = `${schema}-${safeName}-${monatName}-${jahr}-rev${revNum}.pdf`;

    // Zeilen/Summen wie gehabt
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
      Monat:                   monatName,
      Jahr:                    jahr,
      firma_name:              firma_name,
      arbeiter:                { name: a.name },
      zeilen:                  zeilenHtml,
      gesamt_nettoarbeitszeit: formatSigned(gesNettoMs) + ' Std.',
      gesamt_ueberstunden:     formatSigned(gesUberMs)  + ' Std.',
      erstellungsdatum:        dayjs().format('DD.MM.YYYY')
    });

    // PDF generieren
    const browser = await puppeteer.launch({ args:['--no-sandbox'] });
    const page    = await browser.newPage();
    await page.setContent(html, { waitUntil:'networkidle0' });
    const pdfBuffer = await page.pdf({ format:'A4', printBackground:true });
    await browser.close();

    // Upload mit Revision!
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
}

run().catch(err => {
  console.error('❌ Fehler:', err.message);
  process.exit(1);
});
