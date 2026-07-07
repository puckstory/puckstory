import { describe, it, expect } from 'vitest'
import { buildModel } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import type { ViewState } from '../src/lib/types'

const model = buildModel()
const noop = () => {}
const rect = (w: number, h: number) =>
  ((globalThis as any).__rect = { width: w, height: h, left: 0, top: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} })
const base: ViewState = { eras: [{ start: 1915, end: 2026 }], positions: { F: true, D: true, G: true },
  multiOnly: false, colorMode: 'position', layoutMode: 'timeline' }
const cols = () => new Set(model.nodes.filter((n: any) => n.vis && n.type === 'cup').map((c: any) => Math.round((c as any)._tx))).size
const rows = () => new Set(model.nodes.filter((n: any) => n.vis && n.type === 'cup').map((c: any) => Math.round((c as any)._ty))).size

// The wrapped timeline grid's columns:rows track the window aspect, computed inside applyFilters.
// A resize/chrome-collapse must RE-RUN that (reflow -> applyFilters), not just re-fit the stale grid,
// or a wide grid letterboxes into a tall viewport.
describe('timeline grid reshapes to the window aspect on resize/reflow', () => {
  it('a wide viewport uses more columns (and fewer rows) than a tall one for the same selection', () => {
    rect(1600, 500) // wide
    const gv: any = new GraphView(document.createElement('canvas'), model, { ...base, eras: [{ start: 1915, end: 2026 }] },
      { onStats: noop, onHover: noop })
    const wideCols = cols(), wideRows = rows()
    rect(500, 1600) // tall
    gv.reflow()     // resize + applyFilters at the new aspect
    const tallCols = cols(), tallRows = rows()
    expect(wideCols).toBeGreaterThan(tallCols) // wider window -> more columns
    expect(tallRows).toBeGreaterThan(wideRows) // taller window -> more rows
    rect(1280, 720); gv.destroy()
  })

  it('the grid snakes: each row starts directly below where the previous one ended, directions alternating', () => {
    rect(1280, 720)
    const gv: any = new GraphView(document.createElement('canvas'), model, { ...base, eras: [{ start: 1915, end: 2026 }] },
      { onStats: noop, onHover: noop })
    // group the pinned cups into rows by _ty, chronological within each row
    const cups = model.nodes.filter((n: any) => n.vis && n.type === 'cup') as any[]
    const byRow = new Map<number, any[]>()
    for (const c of cups) {
      const y = Math.round(c._ty)
      if (!byRow.has(y)) byRow.set(y, [])
      byRow.get(y)!.push(c)
    }
    const rowsTop = [...byRow.keys()].sort((a, b) => a - b).map((y) => byRow.get(y)!.sort((a, b) => a.year - b.year))
    expect(rowsTop.length).toBeGreaterThan(2)
    for (let r = 0; r + 1 < rowsTop.length; r++) {
      const row = rowsTop[r], next = rowsTop[r + 1]
      // the serpentine handoff: the year after a row's last sits in the SAME column one row down
      // (1950 directly under 1949) - including the short final row, which aligns to the snake
      expect(Math.abs(row[row.length - 1]._tx - next[0]._tx), `row ${r} -> row ${r + 1} handoff`).toBeLessThan(1)
      // and consecutive rows run in opposite directions (even L->R, odd R->L)
      if (row.length > 1 && next.length > 1) {
        const dir = (rw: any[]) => Math.sign(rw[rw.length - 1]._tx - rw[0]._tx)
        expect(dir(row) * dir(next), `rows ${r}/${r + 1} alternate direction`).toBe(-1)
      }
    }
    rect(1280, 720); gv.destroy()
  })

  it('onResize dedupes the paired window+ResizeObserver events (no re-fit when size is unchanged)', () => {
    rect(1280, 720)
    const gv: any = new GraphView(document.createElement('canvas'), model, { ...base, layoutMode: 'network' },
      { onStats: noop, onHover: noop })
    let fits = 0
    const realFit = gv.fit.bind(gv)
    gv.fit = () => { fits++; realFit() }
    gv.onResize() // dimensions unchanged since construction -> should early-return, no fit
    expect(fits).toBe(0)
    rect(900, 600)
    gv.onResize() // real change -> one fit
    expect(fits).toBe(1)
    rect(1280, 720); gv.destroy()
  })
})

// An open docked bottom sheet covers the stage bottom; fit must frame the content in the strip
// ABOVE it (setBottomInset), or the framed graph sits half-hidden underneath the sheet.
describe('setBottomInset frames fits above the docked bottom sheet', () => {
  it('fit centres the content at (H-inset)/2; inset 0 restores full-height centring', () => {
    rect(1280, 720)
    const gv: any = new GraphView(document.createElement('canvas'), model, { ...base, layoutMode: 'network' },
      { onStats: noop, onHover: noop })
    // the same glyph-aware bbox computeFit frames (cup glyphs extend past their nominal radius)
    const centre = () => {
      let a = 1e9, b = 1e9, c = -1e9, d = -1e9
      for (const n of model.nodes.filter((x: any) => x.vis) as any[]) {
        const lr = n.type === 'cup' ? n.r * 0.66 : n.r, up = n.type === 'cup' ? n.r * 1.5 : n.r, dn = n.type === 'cup' ? n.r * 1.36 : n.r
        a = Math.min(a, n.x - lr); b = Math.min(b, n.y - up); c = Math.max(c, n.x + lr); d = Math.max(d, n.y + dn)
      }
      return { cx: (a + c) / 2, cy: (b + d) / 2 }
    }
    gv.setBottomInset(240); gv.fit()
    let t = gv.transform, m = centre()
    expect(Math.abs(m.cy * t.k + t.y - (720 - 240) / 2)).toBeLessThan(2) // mid-way up the VISIBLE strip
    expect(Math.abs(m.cx * t.k + t.x - 1280 / 2)).toBeLessThan(2)       // horizontal centring unaffected
    gv.setBottomInset(0); gv.fit()
    t = gv.transform; m = centre()
    expect(Math.abs(m.cy * t.k + t.y - 720 / 2)).toBeLessThan(2)        // sheet closed: back to mid-window
    rect(1280, 720); gv.destroy()
  })
})

// A monitor-to-monitor window move changes devicePixelRatio WITHOUT resizing the canvas box, so
// neither the resize listener nor the ResizeObserver fires. GraphView watches a dpr-specific
// resolution media query instead - and must re-arm it at each new value (the query itself names
// the dpr, so the old one never fires again).
describe('devicePixelRatio change rescales the canvas backing store (watchDpr)', () => {
  it('the resolution media-query listener re-runs resize at the new dpr and re-arms for it', () => {
    rect(1280, 720)
    const glob: any = globalThis as any
    const realMM = glob.matchMedia
    const queries: string[] = []
    let onChange: (() => void) | null = null
    // stub matchMedia BEFORE construction to capture the query watchDpr arms + its change listener
    // (isCoarsePointer also probes matchMedia at construction but never attaches a listener)
    glob.matchMedia = (q: string) => {
      queries.push(q)
      return { matches: false, media: q,
        addEventListener: (_t: string, fn: any) => { onChange = fn },
        removeEventListener: noop }
    }
    try {
      const canvas = document.createElement('canvas')
      const gv: any = new GraphView(canvas, model, { ...base, layoutMode: 'network' }, { onStats: noop, onHover: noop })
      expect(queries.some((q) => q.includes('1dppx'))).toBe(true) // armed for the constructor-time dpr
      expect(onChange).toBeTruthy()
      expect(canvas.width).toBe(1280)                             // backing store at dpr 1
      glob.window.devicePixelRatio = 2                            // the "dragged onto a retina monitor" moment
      onChange!()                                                 // the dpr-specific query flips exactly then
      expect(gv.dpr).toBe(2)
      expect(canvas.width).toBe(1280 * 2)                         // backing store rescaled to the new dpr...
      expect(canvas.height).toBe(720 * 2)
      expect(queries.at(-1)).toContain('2dppx')                   // ...and the watch re-armed at that dpr
      gv.destroy()
    } finally {
      glob.matchMedia = realMM
      glob.window.devicePixelRatio = 1
      rect(1280, 720)
    }
  })
})

// Hiding/restoring the top bar (or toggling a phone submenu) resizes the STAGE, not the window.
// An armed anchorNextResize must keep the graph pinned to the physical screen: same scale, the
// camera shifted by exactly how far the canvas box moved, and no refit/reshape scooting things.
describe('anchorNextResize pins the graph while the chrome changes height', () => {
  it('an announced resize shifts the camera by the canvas-top delta and skips refit + reshape', () => {
    rect(1280, 620)
    ;(globalThis as any).__rect.top = 100 // stage starts 100px down (below the bar)
    const gv: any = new GraphView(document.createElement('canvas'), model, { ...base, layoutMode: 'network' },
      { onStats: noop, onHover: noop })
    const t0 = { ...gv.transform }
    let fits = 0
    const realFit = gv.fit.bind(gv)
    gv.fit = () => { fits++; realFit() }
    gv.anchorNextResize()
    // the bar collapses: the canvas grows 100px UPWARD (top 100 -> 0, height 620 -> 720)
    rect(1280, 720)
    gv.onResize()
    expect(gv.H).toBe(720)                                  // box re-measured...
    expect(gv.transform.k).toBe(t0.k)                       // ...but no rescale
    expect(gv.transform.y).toBeCloseTo(t0.y + 100, 6)       // content pinned: camera follows the box
    expect(gv.transform.x).toBeCloseTo(t0.x, 6)
    expect(fits).toBe(0)                                    // no refit...
    expect(gv.reshapeTimer).toBe(0)                         // ...and no delayed reshape pending
    rect(1280, 720); gv.destroy()
  })

  it('an expired or absent arm falls through to the normal refit + reshape path', () => {
    rect(1280, 720)
    const gv: any = new GraphView(document.createElement('canvas'), model, { ...base, layoutMode: 'network' },
      { onStats: noop, onHover: noop })
    let fits = 0
    const realFit = gv.fit.bind(gv)
    gv.fit = () => { fits++; realFit() }
    gv.anchorUntil = Date.now() - 1 // an arm that timed out (e.g. a desktop submenu toggle that never resized)
    gv.anchorRect = { left: 0, top: 0 }
    rect(900, 600)
    gv.onResize()
    expect(fits).toBe(1)                 // normal path: immediate reframe
    expect(gv.reshapeTimer).not.toBe(0)  // and the debounced reshape armed
    clearTimeout(gv.reshapeTimer); gv.reshapeTimer = 0
    rect(1280, 720); gv.destroy()
  })
})

describe('anchored resize during a settle', () => {
  it("keeps fit-tracking alive - killing it froze the camera while the layout kept moving", () => {
    rect(1280, 720)
    const gv: any = new GraphView(document.createElement('canvas'), model, { ...base, layoutMode: 'network' },
      { onStats: noop, onHover: noop })
    gv.trackFit = true            // an in-flight settle easing toward its fit
    gv.anchorNextResize()
    rect(1280, 820)               // the bar collapses
    gv.onResize()
    expect(gv.trackFit).toBe(true) // the settle keeps framing itself in the new space
    rect(1280, 720); gv.destroy()
  })
})
