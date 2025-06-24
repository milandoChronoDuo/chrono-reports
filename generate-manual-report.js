/* generate-manual-report.js – Revision-aware Manual Reports */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const Handlebars = require('handlebars');
const puppeteer  = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL,
                        process.env.SUPABASE_SERVICE_ROLE_KEY);

// ─── Args ────────────────────────────────────────────────────────────────
const [schema, workerCsv, startDate, endDate] = process.argv.slice(2);
if (!schema || !workerCsv || !startDate || !endDate) {
  console.error('Usage: node generate-manual-report.js <schema> <workerIdsCSV> <start> <end>');
  process.exit(1);
}
const workerIds = workerCsv.split(',').map(s=>s.trim()).filter(Boolean);

// ─── Assets ──────────────────────────────────────────────────────────────
const template = Handlebars.compile(
  fs.readFileSync(path.join(__dirname,'template.html'),'utf8')
);
const logoDataUri = fs.existsSync(path.join(__dirname,'logo.png'))
  ? 'data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'logo.png')).toString('base64')
  : '';

// Helpers
const MONATE_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const toMs = i => { if(!i) return 0; const n=i.startsWith('-'); const [h='0',m='0',s='0']=i.replace(/^-/,'').split(':'); const ms=(+h*3600+ +m*60+ +s)*1e3; return n?-ms:ms; };
const fmt  = v => { const n=v<0; const a=Math.abs(v); const m=Math.round(a/6e4); const str=`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; return (n?'-':'')+str; };

(async ()=>{
  // Firmenname
  const { data: k } = await sb.schema('management')
    .from('kunden').select('firmenname').eq('firma_slug',schema).single();
  const firmaName = k?.firmenname || schema;

  // Alle Arbeiter via RPC
  const { data: allWorkers } = await sb
    .schema('management').rpc('get_arbeiter',{ schema_name:schema });
  const workers = (allWorkers||[]).filter(w=>workerIds.includes(w.id));
  if(!workers.length){
    console.error('No workers found – check UUIDs & schema');
    process.exit(1);
  }

  for(const w of workers){
    // Zeiten via RPC
    const { data: times } = await sb.schema('management').rpc('get_zeiten',{
      schema_name:schema, mitarbeiter:w.id, start_date:startDate, end_date:endDate
    });
    if(!times?.length){ console.warn(`No times for ${w.name}`); continue; }

    // Revision ermitteln
    const monatName = MONATE_DE[dayjs(startDate).month()];
    const jahr      = dayjs(startDate).year();
    const safeName  = w.name.replace(/ /g,'_');
    const prefix    = `${schema}-${safeName}-${monatName}-${jahr}-rev`;
    const { data: files } = await sb.storage.from('reports').list('',{ limit:1000 });
    const rev = Math.max(0, ...files.map(f=>(f.name.match(new RegExp(`^${prefix}(\\d+)\\.pdf$`))||[])[1]).filter(Boolean).map(Number)) + 1;
    const uploadName = `${prefix}${rev}.pdf`;

    // Zeilen/Summen
    let net=0, ov=0;
    const rows = times.map(t=>{
      const netMs = toMs(t.nettoarbeitszeit); net+=netMs;
      const ovMs  = toMs(t.ueberstunden);     ov+=ovMs;
      const paMs  = toMs(t.pausendauer);
      return `<tr>
        <td>${dayjs(t.datum).format('DD.MM.YYYY')}</td>
        <td>${t.status}</td>
        <td>${t.arbeitsbeginn?dayjs(t.arbeitsbeginn).format('HH:mm'):''}</td>
        <td>${t.feierabend?dayjs(t.feierabend).format('HH:mm'):''}</td>
        <td>${fmt(paMs)} Std.</td>
        <td>${fmt(netMs)} Std.</td>
        <td>${fmt(ovMs)} Std.</td>
      </tr>`;
    }).join('');

    // Render
    const html = template({
      logo: logoDataUri,
      Monat: monatName, Jahr: jahr,
      firma_name: firmaName,
      arbeiter:{ name:w.name },
      zeilen: rows,
      gesamt_nettoarbeitszeit: fmt(net)+' Std.',
      gesamt_ueberstunden:     fmt(ov)+' Std.',
      erstellungsdatum: dayjs().format('DD.MM.YYYY')
    });

    const browser = await puppeteer.launch({ args:['--no-sandbox'] });
    const page    = await browser.newPage();
    await page.setContent(html,{ waitUntil:'networkidle0' });
    const pdfBuf  = await page.pdf({ format:'A4', printBackground:true });
    await browser.close();

    const { error: upErr } = await sb.storage.from('reports')
      .upload(uploadName,pdfBuf,{ contentType:'application/pdf', upsert:true });
    if(upErr) console.error('Upload error',uploadName,upErr.message);
    else      console.log('Uploaded',uploadName);
  }
})().catch(e=>{console.error(e);process.exit(1);});
