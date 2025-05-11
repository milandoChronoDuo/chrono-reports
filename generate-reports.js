// generate-reports.js

require('dotenv').config()
const fs         = require('fs')
const path       = require('path')
const Handlebars = require('handlebars')
const puppeteer  = require('puppeteer')
const dayjs      = require('dayjs')
const { createClient } = require('@supabase/supabase-js')

// ── Supabase-Client ───────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// ── Interval-Parsing ──────────────────────────────────────────────────────────
function parseIntervalToMs(interval) {
  if (typeof interval !== 'string') return 0
  const [h='0', m='0', s='0'] = interval.split(':')
  return (Number(h)*3600 + Number(m)*60 + Number(s)) * 1000
}
function msToHHMM(ms) {
  const totalSec = Math.floor(ms/1000)
  const hh       = Math.floor(totalSec/3600)
  const mm       = Math.floor((totalSec%3600)/60)
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`
}

// ── Template & Logo laden ─────────────────────────────────────────────────────
const templatePath = path.join(__dirname,'template.html')
if (!fs.existsSync(templatePath)) {
  console.error('template.html fehlt'); process.exit(1)
}
const templateSource = fs.readFileSync(templatePath,'utf-8')
const template       = Handlebars.compile(templateSource)

let logoDataUri = ''
const logoPath = path.join(__dirname,'logo.png')
if (fs.existsSync(logoPath)) {
  const buf = fs.readFileSync(logoPath)
  logoDataUri = 'data:image/png;base64,' + buf.toString('base64')
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────
async function run() {
  const today      = dayjs()
  const dayOfMonth = today.date()

  // 1) Kunden, deren Versand-Tag heute ist
  const { data: allKunden, error: kErr } = await supabase
    .schema('management')
    .from('kunden')
    .select('firma_slug,firmenname,pdf_versand_tag')
  if (kErr) throw kErr

  const due = allKunden.filter(k => k.pdf_versand_tag === dayOfMonth)
  if (!due.length) {
    console.log('→ Keine Reports heute.')
    return
  }

  // 2) Pro Kunde
  for (const k of due) {
    const schema    = k.firma_slug
    const monatName = today.format('MMMM')
    const jahr      = today.format('YYYY')

    console.log(`\n→ Kunde: ${schema} (${k.firmenname}) für ${monatName} ${jahr}`)

    // 2a) Zeiteinträge-Intervall
    const startDate = today.subtract(1,'month').date(dayOfMonth).format('YYYY-MM-DD')
    const endDate   = today.subtract(1,'day').format('YYYY-MM-DD')

    // 2b) Alle Arbeiter per RPC
    const { data: workers, error: wErr } = await supabase
      .schema('management')
      .rpc('get_arbeiter',{ schema_name: schema })
    if (wErr) {
      console.error('   ✖ get_arbeiter fehlgeschlagen:', wErr.message)
      continue
    }
    if (!workers.length) {
      console.log('   → Keine Arbeiter.')
      continue
    }

    // 3) Pro Arbeiter: Report erzeugen & ins Root-Verzeichnis laden
    for (const a of workers) {
      console.log(`   - Erstelle Report für ${a.name}`)

      // 3a) Zeiten holen
      const { data: zeiten, error: tErr } = await supabase
        .schema('management')
        .rpc('get_zeiten',{
          schema_name: schema,
          mitarbeiter: a.id,
          start_date:  startDate,
          end_date:    endDate
        })
      if (tErr) {
        console.error('     ✖ get_zeiten fehlgeschlagen:', tErr.message)
        continue
      }

      // 3b) Zeilen-HTML & Summen
      let gesNettoMs = 0, gesUberMs = 0
      const zeilenHtml = zeiten.map(z => {
        const nettoMs = parseIntervalToMs(z.nettoarbeitszeit)
        const uberMs  = parseIntervalToMs(z.ueberstunden)
        const pauseMs = parseIntervalToMs(z.pausendauer)
        gesNettoMs += nettoMs
        gesUberMs  += uberMs
        return `
          <tr>
            <td>${dayjs(z.datum).format('DD.MM.YYYY')}</td>
            <td>${z.status}</td>
            <td>${z.arbeitsbeginn?dayjs(z.arbeitsbeginn).format('HH:mm'):''}</td>
            <td>${z.feierabend?dayjs(z.feierabend).format('HH:mm'):''}</td>
            <td>${msToHHMM(pauseMs)} Std.</td>
            <td>${msToHHMM(nettoMs)} Std.</td>
            <td>${msToHHMM(uberMs)} Std.</td>
          </tr>`
      }).join('')

      // 3c) Template füllen
      const html = template({
        logo: logoDataUri,
        Monat: monatName,
        Jahr: jahr,
        firma_name: k.firmenname,
        arbeiter: { name: a.name },
        zeilen: zeilenHtml,
        gesamt_nettoarbeitszeit: msToHHMM(gesNettoMs) + ' Std.',
        gesamt_ueberstunden:     msToHHMM(gesUberMs)  + ' Std.',
        erstellungsdatum:        today.format('DD.MM.YYYY')
      })

      // 3d) PDF via Puppeteer
      const browser   = await puppeteer.launch({ args:['--no-sandbox'] })
      const page      = await browser.newPage()
      await page.setContent(html, { waitUntil:'networkidle0' })
      const pdfBuffer = await page.pdf({ format:'A4', printBackground:true })
      await browser.close()

      // 3e) Dateiname: firma_slug-namearbeiter-mmmm-yyyy.pdf
      const safeName = a.name.replace(/ /g,'_')
      const fileName = `${schema}-${safeName}-${monatName}-${jahr}.pdf`

      // 3f) Upload ins Bucket-Root
      const { error: upErr } = await supabase
        .storage
        .from('reports')
        .upload(fileName, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true
        })
      if (upErr) {
        console.error(`     ✖ Upload ${fileName} fehlgeschlagen:`, upErr.message)
      } else {
        console.log(`     ✔ Hochgeladen: ${fileName}`)
      }
    }
  }
}

run().catch(err => {
  console.error('❌ Fehler:', err.message)
  process.exit(1)
})
