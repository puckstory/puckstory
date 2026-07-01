import { test, expect, type Page } from '@playwright/test'

// Collect hard failures on every page: any uncaught exception or console.error fails the test.
function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  return errors
}

// Navigate and make the control bar usable: short landscape viewports boot with the chrome
// hidden (the graph gets the whole screen), so tests that drive the controls restore it first.
async function go(page: Page, url = '/') {
  await page.goto(url)
  const restore = page.locator('.showchrome')
  if (await restore.isVisible().catch(() => false)) await restore.click()
}

// Open a phone accordion submenu by its header title. No-op on desktop (headers are hidden
// there and the controls sit inline), and when the submenu is already open.
async function openSec(page: Page, name: 'Eras' | 'Filters' | 'Theme') {
  const h = page.locator('.msec-h', { hasText: name }).first()
  if (await h.isVisible().catch(() => false)) {
    if ((await h.getAttribute('aria-expanded')) !== 'true') await h.click()
  }
}

test('boots clean: title, canvas, controls, zero console errors', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/')
  await expect(page).toHaveTitle(/Puckstory/)
  await expect(page.locator('canvas')).toBeVisible()
  // short landscape phones boot chrome-hidden with the accent restore button instead of the bar
  const restore = page.locator('.showchrome')
  if (await restore.isVisible().catch(() => false)) {
    await expect(page.locator('.topbar')).not.toBeVisible()
    await restore.click()
  }
  await expect(page.locator('.topbar')).toBeVisible()
  await expect(page.getByRole('combobox')).toBeVisible()
  await page.waitForTimeout(800) // let the settle animation run a few frames
  expect(errors).toEqual([])
})

test('era pills union + URL sync: toggling writes a shareable query string', async ({ page }) => {
  await go(page)
  await openSec(page, 'Eras')
  await page.getByRole('button', { name: /Original Six/ }).click()
  await expect(page).toHaveURL(/eras=2006-2026(%2C|,)1942-1967/)
  // reload the synced URL: both pills come back pressed (the deep link round-trips).
  // Pills are matched by their aria-LABEL: the Eras submenu header's summary also says
  // "Original Six + Cap", so role/name queries would be ambiguous.
  await go(page, page.url())
  await openSec(page, 'Eras')
  await expect(page.getByLabel(/^Original Six,/)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel(/^Cap,/)).toHaveAttribute('aria-pressed', 'true')
})

test('deep link applies state to the controls', async ({ page }) => {
  await go(page, '/?eras=1980-1993&layout=timeline&multi=1&color=dynasty')
  await openSec(page, 'Eras')
  await expect(page.getByLabel(/^Dynasties,/)).toHaveAttribute('aria-pressed', 'true')
  await openSec(page, 'Filters') // the accordion swaps sections; these three live in Filters
  await expect(page.getByLabel('Multi-Cup only')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Timeline layout')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Colour by dynasty')).toHaveAttribute('aria-pressed', 'true')
})

test('an unknown ?focus= id is ignored (no crash, default view)', async ({ page }) => {
  const errors = watchErrors(page)
  await go(page, '/?focus=banana')
  await expect(page.locator('canvas')).toBeVisible()
  await openSec(page, 'Eras')
  await expect(page.getByLabel(/^Cap,/)).toHaveAttribute('aria-pressed', 'true')
  expect(errors).toEqual([])
})

test('search: out-of-era matches show greyed with a when-they-won note; picking still selects', async ({ page }) => {
  await go(page)
  const box = page.getByRole('combobox')
  // Gretzky has no Cup in the default cap era → he surfaces greyed, noting when he DID win
  await box.fill('gretzky')
  const opt = page.getByRole('option').first()
  await expect(opt).toHaveClass(/dim/)
  await expect(opt).toContainText('Not in the selected era')
  await expect(opt).toContainText('1984, 1985, 1987, 1988')
  // picking the hidden match still selects him - the graph enters the everything-faded state
  await box.press('Enter')
  await expect(page).toHaveURL(/focus=pl-[a-z]*gretzky/)
  await expect(box).toHaveValue('')
  // in his own era he is a normal, selectable result via the keyboard
  await openSec(page, 'Eras')
  await page.getByRole('button', { name: /Dynasties/ }).click()
  await page.getByRole('button', { name: /^Cap/ }).click() // drop the cap era
  await box.fill('gretzky')
  await expect(page.getByRole('option').first()).not.toHaveClass(/dim/)
  await box.press('ArrowDown')
  await box.press('Enter')
  await expect(box).toHaveValue('')
  await expect(page.getByRole('option')).toHaveCount(0)
  // a query matching NOTHING keeps the panel up with an explicit no-matches row (the whole
  // dropdown used to silently vanish mid-keystroke)
  await box.fill('zzgretzsky')
  await expect(page.locator('.tb-noresults')).toContainText('No players or teams match')
})

test('copy-link carries the SELECTION: picking syncs ?focus=, it round-trips, deselect clears it', async ({ page }) => {
  await go(page, '/?eras=1980-1993')
  const box = page.getByRole('combobox')
  await box.fill('gretzky')
  await box.press('Enter')
  await expect(page).toHaveURL(/focus=pl-[a-z]*gretzky/) // the selection is now in the URL
  await openSec(page, 'Eras')
  await page.getByRole('button', { name: /Original Six/ }).click()
  await expect(page).toHaveURL(/eras=/)                  // a filter change keeps the selection...
  await expect(page).toHaveURL(/focus=/)
  await go(page, page.url())                             // ...and the shared URL round-trips
  await expect(page).toHaveURL(/focus=pl-[a-z]*gretzky/)
  // cut (scissors): joins the URL and survives a reload of the shared link
  const scissors = page.getByLabel('Cut to selection')
  await scissors.click()
  await expect(page).toHaveURL(/cut=1/)
  await go(page, page.url())
  await expect(page.getByLabel('Cut to selection')).toHaveAttribute('aria-pressed', 'true')
  // a background misclick must NOT tear the cut down - exiting is explicit via the scissors,
  // which pulses as the "way out" hint when the tap is swallowed. Top-centre of the canvas is
  // GUARANTEED empty: fit() keeps >=36px padding above the content bbox (corners are not - the
  // fitted blob can reach them).
  const bb = (await page.locator('canvas').boundingBox())!
  const emptySpot = { position: { x: bb.width / 2, y: 12 } }
  await page.waitForTimeout(600) // let the post-reload fit settle so the padding claim holds
  await page.locator('canvas').click(emptySpot)
  await expect(page).toHaveURL(/cut=1/)
  await expect(page.getByLabel('Cut to selection')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Cut to selection')).toHaveClass(/pulse/)
  // un-cut first; only then does a background tap deselect, clearing both params
  await page.getByLabel('Cut to selection').click()
  await expect(page).not.toHaveURL(/cut=/)
  await page.waitForTimeout(600) // the un-cut refits; wait for the camera before the empty-spot tap
  await page.locator('canvas').click(emptySpot)
  await expect(page).not.toHaveURL(/focus=/)
  await expect(page.getByLabel('Cut to selection')).toBeDisabled()
})

test('typing a From year deselects the era pills and lights the From/To block as the custom range', async ({ page }) => {
  await go(page)
  await openSec(page, 'Eras')
  await expect(page.getByRole('button', { name: /^Cap/ })).toHaveAttribute('aria-pressed', 'true')
  const from = page.getByLabel('From year')
  await from.fill('1950')
  await from.press('Enter')
  await expect(page.getByRole('button', { name: /^Cap/ })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.years')).toHaveClass(/(^| )on( |$)/)
  await expect(page).toHaveURL(/eras=1950-2026/)
})

test('theme switching updates the document theme and persists', async ({ page }) => {
  await go(page)
  await openSec(page, 'Theme') // phones tuck the swatch strip into the Theme submenu
  await page.getByLabel('AMOLED').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'amoled')
  await go(page, page.url())
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'amoled')
})

test('the CANVAS repaints its background on a theme switch (not just the DOM chrome)', async ({ page }) => {
  // ?eras=none guarantees an empty canvas - the corner pixel is pure background, never an edge
  await go(page, '/?eras=none')
  const corner = () => page.evaluate(() => {
    const d = document.querySelector('canvas')!.getContext('2d')!.getImageData(0, 0, 1, 1).data
    return `${d[0]},${d[1]},${d[2]}`
  })
  expect(await corner()).toBe('253,246,227') // Solarized Light #fdf6e3 (the default theme)
  await openSec(page, 'Theme')
  await page.getByLabel('AMOLED').click()
  await page.waitForTimeout(250) // a frame or two for the repaint
  expect(await corner()).toBe('0,0,0')       // AMOLED true black
})

test('guidance overlays name the empty states instead of leaving a blank canvas', async ({ page }) => {
  // 1. no era at all
  await go(page, '/?eras=none')
  await expect(page.locator('.emptyera')).toContainText('No era selected')
  // 2. selection entirely outside the era (the dim-all state) - names who is missing and why
  await go(page)
  const box = page.getByRole('combobox')
  await box.fill('gretzky')
  await box.press('Enter') // Gretzky has no Cup in the default cap era
  await expect(page.locator('.emptyera')).toContainText(/Gretzky isn't in the selected era/)
  // 3. a cut whose Cups the era hides - points at the era and the scissors as ways out
  await go(page, '/?eras=1980-1993&focus=cup-2025&cut=1')
  await expect(page.locator('.emptyera')).toContainText('Nothing from this cut in 1980–1993')
  // 4. a selection hidden by a FILTER, not the era - the overlay must blame the real cause
  // (it used to say "isn't in the selected era" and prescribe widening, which did nothing)
  await go(page, '/?eras=1994-2004&focus=pl-patrickroy&pos=FD')
  await expect(page.locator('.emptyera')).toContainText('hidden by the position filter')
  await expect(page.locator('.emptyera')).toContainText('G (Goaltender)')
})

test('sr-only text alternative and JSON-LD are baked with live dataset facts', async ({ page }) => {
  await page.goto('/')
  const sr = page.locator('section.sr-only')
  await expect(sr).toHaveCount(1)
  await expect(sr).toContainText('Stanley Cup champions, 1915 to 2026')
  const ld = await page.locator('script[type="application/ld+json"]').textContent()
  expect(ld).toContain('"temporalCoverage": "1915/2026"')
  expect(ld).not.toContain('%%')
})

test('Stories: an empty focused search box offers curated views; picking one applies it as ONE action', async ({ page, hasTouch }) => {
  await go(page)
  await page.getByRole('combobox').click()
  await expect(page.locator('.tb-story').first()).toBeVisible()
  await page.getByRole('button', { name: /One Goal, Three Times/ }).click()
  await expect(page).toHaveURL(/eras=2006-2026/)
  await expect(page).toHaveURL(/focus=cup-2010(%2C|,)cup-2013(%2C|,)cup-2015/)
  await expect(page).not.toHaveURL(/cut=/) // stories are SELECTIONS against the faded map, never cuts
  // the result pill is desktop-only; phones let the story fill the screen unobstructed
  if (hasTouch) await expect(page.locator('.flashbar')).toHaveCount(0)
  else await expect(page.locator('.flashbar')).toContainText('three Cups in six years')
  await page.getByLabel('Undo').click() // one story = one undo step, straight back to the start
  await expect(page).not.toHaveURL(/cut=/)
  await expect(page).not.toHaveURL(/focus=/)
})

test('A Brief History of Stanley: playback transport appears, marches back in time, reverses home', async ({ page }) => {
  await go(page)
  await page.getByRole('combobox').click()
  await page.getByRole('button', { name: /A Brief History of Stanley/ }).click()
  const bar = page.locator('.playbar')
  await expect(bar).toBeVisible()
  await expect(bar.locator('.pb-year')).toHaveText(/^\d{4}$/)
  await expect(page.locator('.flashbar')).toHaveCount(0) // the transport IS the feedback - no pill anywhere
  // the show clears ALL other chrome away: no top bar, no floating restore button
  await expect(page.locator('.topbar')).toHaveCount(0)
  await expect(page.locator('.showchrome')).toHaveCount(0)
  // the transport is grab-and-drag: pull it by its grip toward the bottom-left
  const b0 = (await bar.boundingBox())!
  await page.mouse.move(b0.x + 8, b0.y + b0.height / 2)
  await page.mouse.down()
  await page.mouse.move(b0.x - 150, b0.y + 250, { steps: 6 })
  await page.mouse.up()
  const b1 = (await bar.boundingBox())!
  expect(b1.y).toBeGreaterThan(b0.y + 150)
  expect(b1.x).toBeLessThan(b0.x)
  // the show marches back in time on its own (a beat every second)
  const y1 = parseInt((await bar.locator('.pb-year').textContent()) ?? '0')
  await expect
    .poll(async () => parseInt((await bar.locator('.pb-year').textContent()) ?? '0'), { timeout: 10_000 })
    .toBeLessThan(y1)
  // pause parks the picture
  await page.getByLabel('Pause', { exact: true }).click()
  const parked = (await bar.locator('.pb-year').textContent()) ?? ''
  await page.waitForTimeout(1400)
  await expect(bar.locator('.pb-year')).toHaveText(parked)
  // reversing un-pauses and walks the reveals back until only the newest champion remains,
  // where it parks itself (the toggle reads Play again)
  await page.getByLabel('Reverse direction').click()
  await expect(page.getByLabel('Play', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(bar.locator('.pb-year')).toHaveText('2026') // parked on the newest champion
  // the anchor swap jumps to the opposite end of history and plays the other way: 1915, up
  await page.getByLabel(/^Jump to 1915/).click()
  await expect(bar.locator('.pb-year')).toHaveText('1915')
  await expect
    .poll(async () => parseInt((await bar.locator('.pb-year').textContent()) ?? '0'), { timeout: 10_000 })
    .toBeGreaterThan(1915)
  // ending the show closes the panel and brings the top bar back; the view is all-eras
  await page.getByLabel('End playback').click()
  await expect(bar).toHaveCount(0)
  await expect(page.locator('.topbar')).toBeVisible()
  await expect(page).toHaveURL(/eras=1915-1941/)
})

test('Escape ends the show and restores the chrome', async ({ page }) => {
  await go(page)
  await page.getByRole('combobox').click()
  await page.getByRole('button', { name: /A Brief History of Stanley/ }).click()
  await expect(page.locator('.playbar')).toBeVisible()
  await page.keyboard.press('Escape') // during the show the ✕ is otherwise the ONLY exit
  await expect(page.locator('.playbar')).toHaveCount(0)
  await expect(page.locator('.topbar')).toBeVisible()
})

test('Six Degrees: the 6° search button connects two players with a shareable chain', async ({ page, hasTouch }) => {
  await go(page)
  const box = page.getByRole('combobox')
  await box.fill('mario lemieux')
  await page.getByLabel(/^Six Degrees - connect Mario Lemieux/).click()
  await expect(box).toHaveAttribute('placeholder', /Connect Mario Lemieux to/)
  await box.fill('wayne gretzky')
  await box.press('Enter')
  // the chain becomes an EXACT selection: both endpoints in ?focus=, linked by at least one
  // Cup, and flagged ?chain=1 so linking Cups render without their rosters
  await expect(page).toHaveURL(/focus=pl-[a-z]*lemieux/)
  await expect(page).toHaveURL(/gretzky/)
  await expect(page).toHaveURL(/cup-/)
  await expect(page).toHaveURL(/chain=1/)
  // neither icon won in the default cap era: the FULL named era holding the chain (Dynasties,
  // 1980-1993) is APPENDED to the still-selected Cap era - both pills pressed
  await expect(page).toHaveURL(/eras=2006-2026(%2C|,)1980-1993/)
  await openSec(page, 'Eras')
  await expect(page.getByLabel(/^Cap,/)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel(/^Dynasties,/)).toHaveAttribute('aria-pressed', 'true')
  // the result pill is desktop-only; phones see the lit chain itself as the feedback
  if (hasTouch) await expect(page.locator('.flashbar')).toHaveCount(0)
  else await expect(page.locator('.flashbar')).toContainText(/Mario Lemieux → .*connected through \d+ Cups? spanning \d+ years/)
  // the shared URL reproduces the whole chain, flag included
  const url = page.url()
  await go(page, url)
  await expect(page).toHaveURL(/lemieux/)
  await expect(page).toHaveURL(/gretzky/)
  await expect(page).toHaveURL(/chain=1/)
})

test('Six Degrees re-enables the filters a chain needs: position pills and the 2+ filter', async ({ page }) => {
  // a goalie endpoint with G filtered out - connecting must press G back on (pos= leaves the URL)
  await go(page, '/?pos=FD&eras=1980-1993')
  const box = page.getByRole('combobox')
  await box.fill('patrick roy')
  await page.getByLabel(/^Six Degrees - connect Patrick Roy/).click()
  await box.fill('wayne gretzky')
  await box.press('Enter')
  await expect(page).toHaveURL(/chain=1/)
  await expect(page).not.toHaveURL(/pos=/)
  // a single-Cup endpoint under Multi-Cup - connecting must drop the 2+ filter
  await go(page, '/?multi=1')
  await box.fill('jordan binnington')
  await page.getByLabel(/^Six Degrees - connect Jordan Binnington/).click()
  await box.fill('sidney crosby')
  await box.press('Enter')
  await expect(page).toHaveURL(/chain=1/)
  await expect(page).not.toHaveURL(/multi=1/)
})

test('Six Degrees with a TEAM endpoint: exact chain, contiguous eras pressed across the span', async ({ page }) => {
  await go(page)
  const box = page.getByRole('combobox')
  await box.fill('seattle metropolitans')
  await page.getByLabel(/^Six Degrees - connect Seattle Metropolitans/).click()
  await box.fill('wayne gretzky')
  await box.press('Enter')
  // the chain runs 1917 → 1980s: every era in between is pressed, plus the kept default Cap
  await expect(page).toHaveURL(/eras=2006-2026(%2C|,)1915-1941(%2C|,)1942-1967(%2C|,)1968-1979(%2C|,)1980-1993/)
  // and it is an EXACT chain (?chain=1): one line from Seattle's lone Cup to Gretzky
  await expect(page).toHaveURL(/chain=1/)
  await expect(page).toHaveURL(/focus=cup-1917/)
  await expect(page).toHaveURL(/gretzky/)
})

test('undo/redo walk the view history: selection, then cut, back and forward', async ({ page }) => {
  await go(page, '/?eras=1980-1993')
  const undoB = page.getByLabel('Undo'), redoB = page.getByLabel('Redo')
  await expect(undoB).toBeDisabled() // the booted deep link is the baseline, not an action
  const box = page.getByRole('combobox')
  await box.fill('gretzky')
  await box.press('Enter')                       // action 1: select
  await expect(page).toHaveURL(/focus=/)
  await page.getByLabel('Cut to selection').click() // action 2: cut
  await expect(page).toHaveURL(/cut=1/)
  await undoB.click()                            // undo the cut - the selection survives
  await expect(page).not.toHaveURL(/cut=/)
  await expect(page).toHaveURL(/focus=/)
  await undoB.click()                            // undo the selection
  await expect(page).not.toHaveURL(/focus=/)
  await expect(undoB).toBeDisabled()
  await redoB.click()
  await redoB.click()                            // redo both
  await expect(page).toHaveURL(/cut=1/)
  await expect(page.getByLabel('Cut to selection')).toHaveAttribute('aria-pressed', 'true')
  await expect(redoB).toBeDisabled()
  // Reset is a HARD reset: filters, selection, cut, AND the whole history are gone
  await page.getByLabel('Reset').click()
  await expect(page).not.toHaveURL(/eras=|focus=|cut=/)
  await expect(undoB).toBeDisabled()
  await expect(redoB).toBeDisabled()
})

test.describe('desktop pointer', () => {
  test.skip(({ hasTouch }) => hasTouch, 'hover-only checks')

  test('Ctrl/Cmd+Z undoes and Shift adds redo', async ({ page }) => {
    await go(page)
    await page.getByRole('button', { name: /Original Six/ }).click()
    await expect(page).toHaveURL(/eras=/)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page).not.toHaveURL(/eras=/)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page).toHaveURL(/eras=/)
  })

  test('Ctrl+Y also redoes; chords typed INSIDE a text field stay native', async ({ page }) => {
    await go(page)
    await page.getByRole('button', { name: /Original Six/ }).click()
    await expect(page).toHaveURL(/eras=/)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page).not.toHaveURL(/eras=/)
    await page.keyboard.press('ControlOrMeta+y') // the Windows-style redo chord
    await expect(page).toHaveURL(/eras=/)
    // focus in the search box: the app must NOT hijack the chord (native text undo owns it)
    const box = page.getByRole('combobox')
    await box.click()
    await box.fill('gretzky')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page).toHaveURL(/eras=/) // the view undo did not fire
  })

  test('hovering a node in a cut shows its plain card', async ({ page }) => {
    await page.goto('/?focus=cup-2025&cut=1') // the cut cup settles at the canvas centre
    await page.waitForTimeout(2500)
    const cv = (await page.locator('canvas').boundingBox())!
    await page.mouse.move(cv.x + cv.width / 2, cv.y + cv.height / 2)
    const tipBox = page.locator('.tip')
    await expect(tipBox).toBeVisible()
    await expect(tipBox).toContainText('Florida Panthers')
  })

  test('the card states position + career total; the cut is told by dimmed rows, not a number', async ({ page }) => {
    // Patrick Roy: 1986+1993 MTL, 1996+2001 COL. A Canadiens-only cut inside an era that covers
    // all four keeps the sub-line era-free ("Goaltender · 4 Cups") and dims the two COL rows.
    await page.goto('/?eras=1980-2004&focus=cup-1986,cup-1993&cut=1')
    await page.waitForTimeout(2500)
    const pos = await page.evaluate(() => (window as any).__pkNodeScreen('pl-patrickroy'))
    expect(pos).not.toBeNull()
    await page.mouse.move(pos.x, pos.y)
    const tipBox = page.locator('.tip')
    await expect(tipBox).toContainText('Patrick Roy')
    await expect(tipBox).toContainText('Goaltender · 4 Cups')
    await expect(tipBox).not.toContainText('in this cut')
    // exactly the two cut-hidden Avalanche Cups render at the dimmed opacity
    expect(await tipBox.locator('.t-cup[style*="0.4"]').count()).toBe(2)
  })
})

test.describe('touch devices', () => {
  test.skip(({ hasTouch }) => !hasTouch, 'touch-only checks')

  test('search input is >=16px (no iOS focus auto-zoom) at ANY width', async ({ page }) => {
    await go(page)
    const fontSize = await page.getByRole('combobox').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect(fontSize).toBeGreaterThanOrEqual(16)
  })

  test('touch targets clear the 24px WCAG floor with headroom (≥30px everywhere)', async ({ page }) => {
    await go(page)
    await openSec(page, 'Filters') // the 2+ pill lives in the Filters submenu on phons
    for (const label of ['Fit view', 'Reset', 'Multi-Cup only']) {
      const box = await page.getByLabel(label).boundingBox()
      expect(box!.height, label).toBeGreaterThanOrEqual(30)
    }
  })

  test('the node card docks as a bottom sheet instead of floating at the tap point', async ({ page }) => {
    await page.goto('/?focus=cup-2025&cut=1') // the cut cup settles at the canvas centre
    await page.waitForTimeout(2500)
    const cv = (await page.locator('canvas').boundingBox())!
    await page.touchscreen.tap(cv.x + cv.width / 2, cv.y + cv.height / 2)
    const sheet = page.locator('.tip.docked')
    await expect(sheet).toBeVisible()
    await expect(sheet).toContainText('Florida Panthers')
    const sb = (await sheet.boundingBox())!
    expect(sb.y + sb.height).toBeGreaterThan(cv.y + cv.height - 60) // pinned to the stage bottom
    expect(sb.width).toBeGreaterThan(cv.width * 0.8)                // a full-width bar
    // in a cut, the tap only inspected (?focus= unchanged), and the LAST anchor offers no
    // "Remove from cut" action - that exit belongs to the scissors
    await expect(page).toHaveURL(/focus=cup-2025(&|$)/)
    await expect(page.locator('.tip-act')).toHaveCount(0)
    await page.getByLabel('Dismiss').click()
    await expect(sheet).not.toBeVisible()
  })

  test('the sheet is a compact label: no rosters, no team lists, no share on any card', async ({ page }) => {
    await page.goto('/?focus=cup-2025&cut=1')
    await page.waitForTimeout(2500)
    const cv = (await page.locator('canvas').boundingBox())!
    await page.touchscreen.tap(cv.x + cv.width / 2, cv.y + cv.height / 2)
    const sheet = page.locator('.tip.docked')
    await expect(sheet).toContainText('Florida Panthers')
    await expect(page.getByLabel('Share this card')).toHaveCount(0)
    // a PLAYER card is name + position + career total - the per-Cup team list is desktop-only
    const pos = await page.evaluate(() => (window as any).__pkNodeScreen('pl-bradmarchand'))
    await page.touchscreen.tap(pos.x, pos.y)
    await expect(sheet).toContainText('Brad Marchand')
    await expect(sheet).toContainText('2 Cups') // career total - no era/cut phrasing
    await expect(sheet).not.toContainText('2025 FLA')
    await expect(sheet).not.toContainText('2011 BOS')
    await expect(page).toHaveURL(/focus=cup-2025(&|$)/) // taps stayed inspect-only
  })

  test('sheet actions edit the cut: Add reveals hidden Cups, Remove prunes back', async ({ page }) => {
    // Brad Marchand: 2011 BOS + 2025 FLA. In a FLA-2025 cut with an era covering 2011, his
    // Boston Cup is cut-hidden but era-eligible → the sheet offers "Add to cut".
    await page.goto('/?eras=2006-2026&focus=cup-2025&cut=1')
    await page.waitForTimeout(2500)
    const pos = await page.evaluate(() => (window as any).__pkNodeScreen('pl-bradmarchand'))
    expect(pos).not.toBeNull()
    await page.touchscreen.tap(pos.x, pos.y)
    const sheet = page.locator('.tip.docked')
    await expect(sheet).toContainText('Brad Marchand')
    await expect(page).toHaveURL(/focus=cup-2025(&|$)/)          // the tap itself did NOT mutate
    await page.getByRole('button', { name: 'Add to cut' }).click()
    await expect(page).toHaveURL(/focus=cup-2025(%2C|,)pl-bradmarchand/)
    await expect(page.getByRole('button', { name: 'Remove from cut' })).toBeVisible() // now an anchor - the card refreshed in place
    await page.getByRole('button', { name: 'Remove from cut' }).click()
    await expect(page).not.toHaveURL(/bradmarchand/)             // pruned back out
  })

  test('a tap on the canvas neither crashes nor leaves the simulation hot', async ({ page }) => {
    const errors = watchErrors(page)
    await page.goto('/')
    await page.waitForTimeout(500)
    const canvas = page.locator('canvas')
    const bb = (await canvas.boundingBox())!
    // tap the centre (dense default view - likely a node) and a corner (background)
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2)
    await page.waitForTimeout(400) // longer than the hold threshold: any orphaned timer would fire
    await page.touchscreen.tap(bb.x + 10, bb.y + bb.height - 10)
    await page.waitForTimeout(300)
    expect(errors).toEqual([])
  })

  test('a two-finger pinch zooms the graph (CDP multi-touch)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Input.dispatchTouchEvent is CDP / Chromium-only')
    const errors = watchErrors(page)
    await page.goto('/')
    await page.waitForTimeout(2500) // let the layout settle so node positions hold still
    const dist = async () => {
      const [a, b] = await page.evaluate(() => [
        (window as any).__pkNodeScreen('cup-2025'), (window as any).__pkNodeScreen('cup-2006'),
      ])
      return Math.hypot(a.x - b.x, a.y - b.y)
    }
    const before = await dist()
    const cv = (await page.locator('canvas').boundingBox())!
    const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2
    const pts = (d: number) => [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(40) })
    for (let d = 50; d <= 150; d += 10)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(300)
    expect(await dist()).toBeGreaterThan(before * 1.4) // fingers spread ~3.7x; well past noise
    expect(errors).toEqual([])
  })
})

test.describe('short landscape phones', () => {
  test.skip(({ viewport, hasTouch }) =>
    !hasTouch || !viewport || viewport.height >= 480 || viewport.width <= viewport.height,
    'coarse + landscape + short only')

  // UNCONDITIONAL on this profile - the boots-clean test only handles the hidden chrome when it
  // happens to appear; this pins that it MUST (a regression here silently ate 40% of the screen)
  test('boots with the chrome hidden and the accent restore button in its place', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.showchrome')).toBeVisible()
    await expect(page.locator('.topbar')).not.toBeVisible()
    await page.locator('.showchrome').click()
    await expect(page.locator('.topbar')).toBeVisible()
    await expect(page.locator('.showchrome')).not.toBeVisible()
  })

  test('a swallowed cut-mode tap pulses the restore button when the scissors is hidden', async ({ page }) => {
    // chrome hidden = no scissors to pulse; the "way out" hint must forward to the ▾ button
    await page.goto('/?focus=cup-2025&cut=1')
    await page.waitForTimeout(2500)
    const bb = (await page.locator('canvas').boundingBox())!
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + 8) // top-centre: fit-guaranteed empty
    await expect(page.locator('.showchrome')).toHaveClass(/pulse/)
    await expect(page).toHaveURL(/cut=1/) // and the tap was swallowed, not a deselect
  })
})

test.describe('phone portrait menu', () => {
  test.skip(({ viewport, hasTouch }) => !hasTouch || !viewport || viewport.width > 640, 'portrait-phone only')

  test('the Eras submenu opens to full-name pills; the accordion swaps sections', async ({ page }) => {
    await go(page)
    // all submenus start closed: era pills are behind the Eras header, whose summary names the preset
    await expect(page.getByText('Original Six')).not.toBeVisible()
    await expect(page.locator('.msec-eras .mh-s')).toHaveText('Cap')
    await openSec(page, 'Eras')
    await expect(page.getByText('Original Six')).toBeVisible()
    await expect(page.getByText('1942-1967')).toBeVisible() // name AND range
    await openSec(page, 'Filters')                           // accordion: eras closes, filters opens
    await expect(page.getByText('Original Six')).not.toBeVisible()
    await expect(page.getByLabel('Multi-Cup only')).toBeVisible()
  })

  test('the collapsed menu stays compact: submenu headers + action row, no open bodies', async ({ page }) => {
    await go(page)
    // all three submenus boot closed, so the whole bar (search + headers + icons) stays short
    const bar = (await page.locator('.topbar').boundingBox())!
    expect(bar.height).toBeLessThan(220)
    await expect(page.locator('.msec-h')).toHaveCount(3)
    await expect(page.locator('.msec-b:visible')).toHaveCount(0)
  })

  test('hiding, restoring, and toggling submenus never moves or rescales the graph', async ({ page }) => {
    await go(page)
    await page.waitForTimeout(2500) // let the layout settle so positions are stable
    const pos = () => page.evaluate(() => (window as any).__pkNodeScreen('cup-2025'))
    const before = await pos()
    await page.getByLabel('Hide controls').click()   // bar away: the stage grows upward
    await page.waitForTimeout(500)
    const hidden = await pos()
    expect(Math.abs(hidden.x - before.x)).toBeLessThan(2)
    expect(Math.abs(hidden.y - before.y)).toBeLessThan(2)
    await page.locator('.showchrome').click()        // bar back: the stage shrinks again
    await page.waitForTimeout(500)
    const restored = await pos()
    expect(Math.abs(restored.x - before.x)).toBeLessThan(2)
    expect(Math.abs(restored.y - before.y)).toBeLessThan(2)
    await openSec(page, 'Eras')                      // submenu open/close changes the bar height too
    await page.waitForTimeout(500)
    const withMenu = await pos()
    expect(Math.abs(withMenu.y - before.y)).toBeLessThan(2)
  })

  test('the hide button sits at the BOTTOM-RIGHT of the open menu (thumb reach)', async ({ page, viewport }) => {
    await go(page)
    const bar = (await page.locator('.topbar').boundingBox())!
    const hide = (await page.getByLabel('Hide controls').boundingBox())!
    expect(hide.y + hide.height).toBeGreaterThan(bar.y + bar.height - 60) // last row
    expect(hide.x + hide.width).toBeGreaterThan(viewport!.width * 0.7)    // right corner
  })

  test('the bar never overflows the viewport', async ({ page, viewport }) => {
    await go(page)
    const w = await page.locator('.topbar').evaluate((el) => el.scrollWidth)
    expect(w).toBeLessThanOrEqual(viewport!.width + 1)
  })
})
