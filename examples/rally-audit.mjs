// One-pass page audit over the running browse-tool Chrome (authed session).
// Navigates every route, captures HTTP status, redirects, console/page errors,
// render state, and a screenshot. Single CDP connection — no per-route spawns.
import { connect, activeOrFirstPage } from '../lib/connect.js'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'

const BASE = 'http://localhost:5173'
const SLUG = 'net-battle-demo'        // populated tournament (12 teams, 3 courts)
const EMPTY_SLUG = 'bell-pepper-open' // setup-phase tournament (0 teams)
const NINO = process.env.AUDIT_USER_ID // set to a real user UUID for /admin/users/[id] and /admin/partners/[userId] routes
if (!NINO) {
  console.error('Set AUDIT_USER_ID to a real user UUID before running (needed for /admin/users/[id] and /admin/partners/[userId]).')
  process.exit(1)
}
const OUT = '/tmp/rally-audit'
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

function toUrl(route) {
  let r = route
  if (route.startsWith('/admin/users/')) r = r.replace('[id]', NINO)
  else if (route.startsWith('/admin/partners/')) r = r.replace('[userId]', NINO)
  else if (route.startsWith('/demo/tutorial/')) r = r.replace('[id]', '1')
  r = r.replace('[slug]', SLUG).replace('[court]', '1')
       .replace('[season]', '1').replace('[teamSlug]', 'unknown-team')
       .replace('[token]', 'none')
  return r
}

// Base route list from the filesystem enumeration.
const routes = readFileSync('/tmp/routes-all.txt', 'utf8').trim().split('\n').map(s => s.trim()).filter(Boolean)
// Empty-state variants for key tournament surfaces.
const emptyVariants = ['/t/[slug]', '/t/[slug]/teams', '/manage/[slug]'].map(r => ({ route: r + ' [empty]', url: BASE + r.replace('[slug]', EMPTY_SLUG) }))

const targets = [
  ...routes.map(route => ({ route, url: BASE + toUrl(route) })),
  ...emptyVariants,
]

const browser = await connect()
const page = await activeOrFirstPage(browser)
page.setDefaultNavigationTimeout(30000)
// Desktop width: the app is desktop-first for dashboards. The headless window
// defaults to ~756px, which trips the ≤768px mobile breakpoint and produces
// false "table overflow"/"FAB visible" findings. Pin a true desktop viewport.
await page.setViewport({ width: 1440, height: 900 })

const results = []
for (const { route, url } of targets) {
  const consoleErrors = []
  const pageErrors = []
  const onConsole = m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)) }
  const onPageErr = e => pageErrors.push(String(e).slice(0, 300))
  page.on('console', onConsole)
  page.on('pageerror', onPageErr)
  let httpStatus = null
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 })
    httpStatus = resp ? resp.status() : null
    await new Promise(r => setTimeout(r, 350)) // settle client render
  } catch (e) {
    pageErrors.push('NAV_FAIL: ' + String(e.message).slice(0, 200))
  }
  let info = {}
  try {
    info = await page.evaluate(() => ({
      finalUrl: location.pathname + location.search,
      title: document.title,
      heading: (document.querySelector('h1,h2')?.innerText || '').slice(0, 90),
      bodyLen: (document.body?.innerText || '').length,
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
      viteError: !!document.querySelector('vite-error-overlay'),
      errorMarker: /\b(internal error|something went wrong|unexpected error|application error)\b/i.test((document.body?.innerText || '').slice(0, 600)),
    }))
  } catch (e) { info.evalErr = String(e.message).slice(0, 150) }
  const safe = route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root'
  try { await page.screenshot({ path: `${SHOTS}/${safe}.png` }) } catch {}
  page.off('console', onConsole)
  page.off('pageerror', onPageErr)
  results.push({ route, url, httpStatus, ...info, consoleErrors, pageErrors })
  process.stdout.write('.')
}

writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2))
browser.disconnect()

// Summary
const err = results.filter(r => r.viteError || r.pageErrors.length || (r.httpStatus && r.httpStatus >= 500) || r.errorMarker)
const redir = results.filter(r => r.finalUrl && r.finalUrl !== new URL(r.url).pathname && !err.includes(r))
const thin = results.filter(r => !err.includes(r) && !redir.includes(r) && (r.bodyLen ?? 0) < 80)
console.log(`\n\n=== AUDIT: ${results.length} routes ===`)
console.log(`errors/crashes: ${err.length}`)
err.forEach(r => console.log(`  ✘ ${r.route} [${r.httpStatus}] vite=${r.viteError} pageErr=${r.pageErrors.length} mark=${r.errorMarker} :: ${(r.pageErrors[0]||r.consoleErrors[0]||r.bodyText||'').slice(0,120)}`))
console.log(`redirected: ${redir.length}`)
redir.forEach(r => console.log(`  → ${r.route}  =>  ${r.finalUrl}`))
console.log(`thin/blank (<80 chars): ${thin.length}`)
thin.forEach(r => console.log(`  ? ${r.route} [${r.httpStatus}] len=${r.bodyLen}`))
const consoleErrRoutes = results.filter(r => r.consoleErrors.length && !err.includes(r))
console.log(`console-errors only: ${consoleErrRoutes.length}`)
consoleErrRoutes.forEach(r => console.log(`  ! ${r.route} :: ${r.consoleErrors[0].slice(0,120)}`))
console.log(`\nreport: ${OUT}/report.json   shots: ${SHOTS}/`)
