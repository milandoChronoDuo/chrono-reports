// generate-reports.js

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const Handlebars = require('handlebars');
const puppeteer  = require('puppeteer');
const dayjs      = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

// 0) Chunk-Konfiguration (für GitHub Actions Matrix)
const CHUNK_SIZE  = parseInt(process.env.CHUNK_SIZE, 10)  || Number.MAX_SAFE_INTEGER;
const CHUNK_INDEX = parseInt(process.env.CHUNK_INDEX, 10) || 0;

// 1) Supabase-Client (Service Role Key)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2) Interval-Parsing & Formatierung
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
  console.error('✖ template.html fehlt'); process.exit(1);
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
  const dispatchDate = dayjs().startOf('day');
  const dispatchDay  = dispatchDate.date();

  console.log(`→ Generiere Reports für Tag ${dispatchDay} (${dispatchDate.format('YYYY-MM-DD')}), Chunk ${CHUNK_INDEX} (Größe ${CHUNK_SIZE})`);

  // 4a) Alle Kunden abrufen, die heute ihren Versand haben
  const { data: allKunden, error: kErr } = await supabase
    .schema('management')
    .from('kunden')
    .select('id, firma_slug, firmenname, pdf_versand_tag, lastversand')
    .eq('pdf_versand_tag', dispatchDay);
  if (kErr) {
    console.error('✖ Fehler beim Laden der Kunden:', kErr.message);
    process.exit(1);
  }
  if (!allKunden.length) {
    console.log('→ Keine Reports heute.');
    return;
  }

  // 4b) Chunking
  const startIdx = CHUNK_INDEX * CHUNK_SIZE;
  const chunkCustomers = allKunden.slice(startIdx, startIdx + CHUNK_SIZE);
  if (!chunkCustomers.length) {
    console.log(`→ Chunk ${CHUNK_INDEX} ist leer.`);
    return;
  }

  // 4c) Pro Kunde im Chunk
  for (const k of chunkCustomers) {
    console.log(`\n→ Kunde: ${k.firma_slug} (“${k.firmenname}”)`);

    // 4c.1) Zeitraum bestimmen
    let startDate;
    if (k.lastversand) {
      // exakt am Tag, der in lastversand steht im Vormonat
      startDate = dispatchDate
        .subtract(1, 'month')
        .date(k.lastversand)
        .startOf('day');
    } else {
      // ab Tag nach Sollversand im Vormonat (falls lastversand nicht gesetzt)
      startDate = dispatchDate
        .subtract(1, 'month')
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
    if (wErr) {
      console.error(`   ✖ get_arbeiter fehlgeschlagen:`, wErr.message);
      continue;
    }
    if (!workers.length) {
      console.log('   → Keine Arbeiter gefunden.');
      continue;
    }

    // 4c.3) PDF für jeden Arbeiter erstellen
    for (const a of workers) {
      console.log(`   → Mitarbeiter: ${a.name}`);

      // Zeiteinträge via RPC
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

      // Zeilen & Summen bauen
      let gesNettoMs = 0, gesÜberMs = 0;
      const zeilenHtml = zeiten.map(z => {
        const nettoMs = parseIntervalToMs(z.nettoarbeitszeit);
        const überMs  = parseIntervalToMs(z.ueberstunden);
        const pauseMs = parseIntervalToMs(z.pausendauer);
        gesNettoMs += nettoMs;
        gesÜberMs  += überMs;
        return `
          <tr>
            <td>${dayjs(z.datum).format('DD.MM.YYYY')}</td>
            <td>${z.status}</td>
            <td>${z.arbeitsbeginn ? dayjs(z.arbeitsbeginn).format('HH:mm') : ''}</td>
            <td>${z.feierabend    ? dayjs(z.feierabend).format('HH:mm')   : ''}</td>
            <td>${msToHHMM(pauseMs)} Std.</td>
            <td>${msToHHMM(nettoMs)} Std.</td>
            <td>${msToHHMM(überMs)} Std.</td>
          </tr>`;
      }).join('');

      // 4c.4) Template füllen
      const html = template({
        logo:                        logoDataUri,
        Monat:                       dispatchDate.format('MMMM'),
        Jahr:                        dispatchDate.format('YYYY'),
        firma_name:                  k.firmenname,
        arbeiter:                    { name: a.name },
        zeilen:                      zeilenHtml,
        gesamt_nettoarbeitszeit:     `${msToHHMM(gesNettoMs)} Std.`,
        gesamt_ueberstunden:         `${msToHHMM(gesÜberMs)} Std.`,
        erstellungsdatum:            dispatchDate.format('DD.MM.YYYY')
      });

      // 4c.5) PDF erzeugen
      const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
      const page    = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
      await browser.close();

      // 4c.6) Upload ins Storage
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

    // 4d) lastversand per RPC setzen
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

// Skript ausführen
run().catch(err => {
  console.error('❌ Ungefangener Fehler:', err.message);
  process.exit(1);
});
