// generate-reports.js

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const Handlebars = require('handlebars');
const puppeteer  = require('puppeteer');
const dayjs      = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

// 0) Chunk‐Konfiguration aus ENV
const CHUNK_SIZE  = parseInt(process.env.CHUNK_SIZE, 10)  || Number.MAX_SAFE_INTEGER;
const CHUNK_INDEX = parseInt(process.env.CHUNK_INDEX, 10) || 0;

// 1) Supabase‐Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2) Interval‐Parsing & Formatierung
function parseIntervalToMs(interval) {
  if (typeof interval !== 'string') return 0;
  const str = interval.trim();
  const isNeg = str.startsWith('-');
  const parts = str.replace(/^-/, '').split(':');
  const [h = '0', m = '0', s = '0'] = parts;
  const totalMs = (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
  return isNeg ? -totalMs : totalMs;
}

function msToHHMM(ms) {
  const totalSec = Math.floor(ms / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function formatSigned(ms) {
  const sign = ms < 0 ? '-' : '';
  return sign + msToHHMM(Math.abs(ms));
}

// 3) Template & Logo laden
const templatePath = path.join(__dirname, 'template.html');
if (!fs.existsSync(templatePath)) {
  console.error('✖ template.html fehlt');
  process.exit(1);
}
const templateSource = fs.readFileSync(templatePath, 'utf-8');
const template       = Handlebars.compile(templateSource);

// Logo (falls vorhanden) als Base64
let logoDataUri = '';
const logoPath = path.join(__dirname, 'logo.png');
if (fs.existsSync(logoPath)) {
  const buf = fs.readFileSync(logoPath);
  logoDataUri = 'data:image/png;base64,' + buf.toString('base64');
}

// 4) Haupt‐Routine
async function run() {
  const dispatchDate = dayjs().startOf('day');
  const dispatchDay  = dispatchDate.date();

  console.log(`→ Generiere Reports für Tag ${dispatchDay}, Chunk ${CHUNK_INDEX}/${CHUNK_SIZE}`);

  // 4a) Kunden mit heutigem Versand‐Tag laden
  let { data: allKunden, error: kErr } = await supabase
    .schema('management')
    .from('kunden')
    .select('id, firma_slug, firmenname, pdf_versand_tag, lastversand');
  if (kErr) throw kErr;

  allKunden = allKunden.filter(k => k.pdf_versand_tag === dispatchDay);
  if (!allKunden.length) {
    console.log('→ Keine Reports heute.');
    return;
  }

  // 4b) Chunking
  const startIdx = CHUNK_INDEX * CHUNK_SIZE;
  const chunk    = allKunden.slice(startIdx, startIdx + CHUNK_SIZE);
  if (!chunk.length) {
    console.log(`→ Chunk ${CHUNK_INDEX} ist leer.`);
    return;
  }

  // 4c) Für jeden Kunden im Chunk
  for (const k of chunk) {
    console.log(`\n→ Kunde: ${k.firma_slug} (“${k.firmenname}”)`);

    // Zeitraum bestimmen
    let startDate;
    if (k.lastversand) {
      startDate = dispatchDate.subtract(1, 'month')
                              .date(k.lastversand)
                              .startOf('day');
    } else {
      startDate = dispatchDate.subtract(1, 'month')
                              .date(dispatchDay)
                              .add(1, 'day')
                              .startOf('day');
    }
    const endDate = dispatchDate.subtract(1, 'day').startOf('day');
    console.log(`   Zeitraum: ${startDate.format('YYYY-MM-DD')} … ${endDate.format('YYYY-MM-DD')}`);

    // 4c.2) Arbeiter per RPC holen
    const { data: workers, error: wErr } = await supabase
      .schema('management')
      .rpc('get_arbeiter', { schema_name: k.firma_slug });
    if (wErr || !workers.length) {
      console.error(`   ✖ get_arbeiter fehlgeschlagen oder leer:`, wErr?.message);
      continue;
    }

    // 4c.3) Für jeden Arbeiter PDF erstellen
    for (const a of workers) {
      console.log(`   → Mitarbeiter: ${a.name}`);

      // Zeiteinträge per RPC
      const { data: zeiten, error: zErr } = await supabase
        .schema('management')
        .rpc('get_zeiten', {
          schema_name: k.firma_slug,
          mitarbeiter: a.id,
          start_date:  startDate.format('YYYY-MM-DD'),
          end_date:    endDate.format('YYYY-MM-DD')
        });
      if (zErr) {
        console.error(`     ✖ get_zeiten fehlgeschlagen:`, zErr.message);
        continue;
      }

      // Zeilen‐HTML und Summen bauen
      let sumNettoMs = 0;
      let sumUberMs  = 0;
      const rowsHtml = zeiten.map(z => {
        const nettoMs = parseIntervalToMs(z.nettoarbeitszeit);
        const uberMs  = parseIntervalToMs(z.ueberstunden);
        const pauseMs = parseIntervalToMs(z.pausendauer);

        sumNettoMs += nettoMs;
        sumUberMs  += uberMs;

        return `
          <tr>
            <td>${dayjs(z.datum).format('DD.MM.YYYY')}</td>
            <td>${z.status}</td>
            <td>${z.arbeitsbeginn ? dayjs(z.arbeitsbeginn).format('HH:mm') : ''}</td>
            <td>${z.feierabend    ? dayjs(z.feierabend).format('HH:mm')   : ''}</td>
            <td>${msToHHMM(pauseMs)} Std.</td>
            <td>${msToHHMM(nettoMs)} Std.</td>
            <td>${formatSigned(uberMs)} Std.</td>
          </tr>`;
      }).join('');

      // 4c.3.c) Template‐Kontext inkl. id_number & urlaubskonto
      const html = template({
        logo:                    logoDataUri,
        Monat:                   dispatchDate.format('MMMM'),
        Jahr:                    dispatchDate.format('YYYY'),
        firma_name:              k.firmenname,
        arbeiter: {
          name:        a.name,
          id_number:   a.id_number,
          urlaubskonto: a.urlaubskonto
        },
        zeilen:                  rowsHtml,
        gesamt_nettoarbeitszeit: `${msToHHMM(sumNettoMs)} Std.`,
        gesamt_ueberstunden:     `${formatSigned(sumUberMs)} Std.`,
        erstellungsdatum:        dispatchDate.format('DD.MM.YYYY')
      });

      // PDF erzeugen
      const browser   = await puppeteer.launch({ args: ['--no-sandbox'] });
      const page      = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ format:'A4', printBackground:true });
      await browser.close();

      // Upload ins Storage
      const fileName = `${a.name.replace(/ /g,'_')}_${dispatchDate.format('YYYY-MM-DD')}.pdf`;
      const folder   = `${k.firma_slug}/${dispatchDate.format('MMMM-YYYY')}`;
      const { error: upErr } = await supabase
        .storage
        .from('reports')
        .upload(`${folder}/${fileName}`, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true
        });
      if (upErr) {
        console.error(`     ✖ Upload fehlgeschlagen:`, upErr.message);
      } else {
        console.log(`     ✔ Hochgeladen: ${folder}/${fileName}`);
      }
    }

    // 4c.4) lastversand per RPC updaten
    const { error: lvErr } = await supabase
      .schema('management')
      .rpc('set_lastversand', {
        kunden_id: k.id,
        new_last:  dispatchDay
      });
    if (lvErr) {
      console.error(`   ✖ set_lastversand fehlgeschlagen:`, lvErr.message);
    } else {
      console.log(`   → lastversand = ${dispatchDay}`);
    }
  }

  console.log('\n✅ generate-reports.js abgeschlossen');
}

run().catch(err => {
  console.error('❌ Ungefangener Fehler:', err.message);
  process.exit(1);
});
