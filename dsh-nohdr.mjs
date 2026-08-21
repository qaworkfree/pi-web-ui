import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 120)))
await page.goto('http://127.0.0.1:3091/', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(8000)
const info = await page.evaluate(() => ({
  headerBtns: document.querySelectorAll('.ut-header-btn').length,
  panel: !!document.querySelector('.ut-panel'),
  panelTabs: document.querySelectorAll('.ut-view-tabs button').length,
  tabLabels: [...document.querySelectorAll('.ut-view-tabs button')].map((b) => b.textContent.trim()),
  panelW: Math.round(document.querySelector('.ut-panel')?.getBoundingClientRect().width || 0),
}))
console.log(JSON.stringify(info))
console.log('errors:', errs.slice(0, 3))
await browser.close()
