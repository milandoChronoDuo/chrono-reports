/* generate-manual-report.js – Rev 2
   Manuell angeforderte Berichte mit Revisionierung */

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const Handlebars = require('handlebars');
const puppeteer  = require('puppeteer');
const dayjs      = require('dayjs');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Argument-Parsing ───────────────────────────────────────────────────────
const [schema, workerArg, startDate, endDate] = process.argv.slice(2);
if (!schema || !workerArg || !startDate || !endDate) {
  console.error('Usage: node generate-manual-report.js <schema> <workerIdsCSV> <start> <end>');
  process.exit(1);
}
const workerIds = workerArg.split(',').map(s => s.trim()).filter(Boolean);

// ─── Template & Logo laden ─────────────────────────────────────────────────
const template = Handlebars.compile(
  fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8')
);
const logoDataUri = fs.existsSync(path.join(__dirname, 'logo.png'))
  ? 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'logo.png')).toString('base64')
  : '';

// ─── Hilfsfunktionen (wie bisher) ──────────────────────────────────────────
const MONATE_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const ms = i => {
  const neg = i.startsWith('-'); const [h='0',m='0',s='0'] = i.replace(/^-/,'').split(':');
  const msec = (Number(h)*3600+Number(m)*60+Number(s))*1000;
  return neg ? -msec : msec;
};
const fmt = v => {
  const neg = v<0; const abs=Math.abs(v); const min=Math.round(abs/60000);
  const txt=`${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}`;
  return (neg?'-':'')+txt;
};

// ─── Hauptablauf ───────────────────────────────────────────────────────────
(async () => {
  // Firmen­namen für die Kopfzeile holen
  const { data: kunde } = await sb
    .schema('management')
    .from('kunden')
    .select('firmenname')
    .eq('firma_slug', schema)
    .single();
  const firmaName = kunde?.firmenname || schema;

  // Alle Arbeiter dieses Schemas über RPC holen
  const { data: allWorkers, error: wErr } = await sb
    .schema('management')
    .rpc('get_arbeiter', { schema_name: schema });

  if (wErr) {
    console.error('RPC get_arbeiter error:', wErr.message);
    process.exit(1);
  }

  // Nur die gewünschten IDs herausfiltern
  const workers = (allWorkers || []).filter(w => workerIds.includes(w.id));
  if (!workers.length) {
    console.error('Keine passenden Arbeiter gefunden – prüfe UUID & Schema.');
    process.exit(1);
  }

  for (const a of workers) {
    // Zeit­einträge via RPC
    const { data: zeiten, error: tErr } = await sb
      .schema('management')
      .rpc('get_zeiten', {
        schema_name: schema,
        mitarbeiter: a.id,
        start_date:  startDate,
        end_date:    endDate
      });

    if (tErr) {
      console.error(`get_zeiten‐Fehler für ${a.name}:`, tErr.message);
      continue;
    }
    if (!zeiten?.length) {
      console.warn(`⚠️  Keine Zeiten für ${a.name} im Zeitraum ${startDate}–${endDate}`);
      continue;
    }

    // Revision bestimmen
    const monatName = MONATE_DE[dayjs(startDate).month()];
    const jahr      = dayjs(startDate).year();
    const safeName  = a.name.replace(/ /g,'_');
    const prefix    = `${schema}-${safeName}-${monatName}-${jahr}-rev`;

    const { data: files } = await sb.storage.from('reports').list('', { limit:1000 });
    const rev = Math.max(
      0,
      ...files
        .map(f => (f.name.match(new RegExp(`^${prefix}(\\d+)\\.pdf$`)) || [])[1])
        .filter(Boolean)
        .map(Number)
    ) + 1;

    const uploadName = `${prefix}${rev}.pdf`;

    // Summen & Zeilen
    let netto=0, ueber=0;
    const bodyRows = zeiten.map(z=>{
      const n=ms(z.nettoarbeitszeit||'0'); netto+=n;
      const u=ms(z.ueberstunden||'0');     ueber+=u;
      const p=ms(z.pausendauer||'0');
      return `<tr>
        <td>${dayjs(z.datum).format('DD.MM.YYYY')}</td>
        <td>${z.status}</td>
        <td>${z.arbeitsbeginn?dayjs(z.arbeitsbeginn).format('HH:mm'):''}</td>
        <td>${z.feierabend?dayjs(z.feierabend).format('HH:mm'):''}</td>
        <td>${fmt(p)} Std.</td>
        <td>${fmt(n)} Std.</td>
        <td>${fmt(u)} Std.</td>
      </tr>`;
    }).join('');

    // HTML → PDF
    const html = template({
      logo: logoDataUri,
      Monat: monatName,
      Jahr:  jahr,
      firma_name: firmaName,
      arbeiter: { name: a.name },
      zeilen: bodyRows,
      gesamt_nettoarbeitszeit: fmt(netto)+' Std.',
      gesamt_ueberstunden:     fmt(ueber)+' Std.',
      erstellungsdatum: dayjs().format('DD.MM.YYYY')
    });

    const browser = await puppeteer.launch({ args:['--no-sandbox'] });
    const page    = await browser.newPage();
    await page.setContent(html, { waitUntil:'networkidle0' });
    const pdfBuf  = await page.pdf({ format:'A4', printBackground:true });
    await browser.close();

    // Upload
    const { error: upErr } = await sb
      .storage
      .from('reports')
      .upload(uploadName, pdfBuf, { contentType:'application/pdf', upsert:true });

    if (upErr) {
      console.error(`❌ Upload fehlgeschlagen (${uploadName}):`, upErr.message);
    } else {
      console.log(`✔ Bericht hochgeladen: ${uploadName}`);
    }
  }
})().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
