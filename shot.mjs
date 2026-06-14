import puppeteer from 'puppeteer'

const URL = process.argv[2] || 'http://localhost:5173/'
const SCROLL = parseFloat(process.argv[3] || '0') // 0..1 target scroll progress
const OUT = process.argv[4] || '/tmp/katana.png'

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--window-size=1280,800',
  ],
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })

const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 })

// let the model load + a few frames settle
await new Promise((r) => setTimeout(r, 2500))

// Drive the ScrollControls scroller to a target progress, then settle.
await page.evaluate((s) => {
  const el = document.querySelector('div[style*="overflow"]') // ScrollControls fill
  const scrollers = [...document.querySelectorAll('*')].filter((e) => e.scrollHeight > e.clientHeight + 10)
  const target = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
  if (target) target.scrollTop = (target.scrollHeight - target.clientHeight) * s
  return { found: !!target }
}, SCROLL)
await new Promise((r) => setTimeout(r, 1500))

const dbg = await page.evaluate(() => window.__dbg || null)

await page.screenshot({ path: OUT })
console.log('=== CONSOLE ===')
console.log(logs.join('\n') || '(none)')
console.log('\n=== __dbg ===')
console.log(JSON.stringify(dbg, null, 2))
console.log('\nscreenshot →', OUT)

await browser.close()
