import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildModel } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import type { ViewState } from '../src/lib/types'

/*
 * Touch gesture regressions. These encode the failure modes of the old single-pointer touch
 * state machine (fixed by pointerId-tracked ownership):
 *   - a second finger orphaned the hold timer, which then fired with no finger down, leaving the
 *     sim hot at alphaTarget 0.3 forever and/or a node PERMANENTLY pinned (fx/fy never cleared);
 *   - pointercancel was unhandled, so an OS-interrupted drag never released;
 *   - a swipe that started on a node was a completely dead gesture (no pan);
 *   - a slow (>hold-threshold) stationary tap failed to select.
 */

const model = buildModel()
const noop = () => {}
const base: ViewState = { eras: [{ start: 2006, end: 2026 }], positions: { F: true, D: true, G: true },
  multiOnly: false, colorMode: 'position', layoutMode: 'network' }

function fresh() {
  const canvas = document.createElement('canvas')
  let hover: any = null
  const gv = new GraphView(canvas as any, model, { ...base, eras: base.eras.map((e) => ({ ...e })) },
    { onStats: noop, onHover: (n) => { hover = n } })
  ;(gv as any).sim.stop() // the constructor settle is irrelevant here; keep ticks deterministic
  return { gv, g: gv as any, getHover: () => hover }
}
const screen = (g: any, n: any) => ({ clientX: n.x * g.transform.k + g.transform.x, clientY: n.y * g.transform.k + g.transform.y })
const tev = (id: number, p: { clientX: number; clientY: number }) =>
  ({ pointerType: 'touch', pointerId: id, preventDefault: noop, ...p })
const visPlayers = () => model.nodes.filter((n: any) => n.vis && n.type === 'player')

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('taps', () => {
  it('a quick tap selects the node and shows its tooltip', () => {
    const { gv, g, getHover } = fresh()
    const n = visPlayers()[0]
    const p = screen(g, n)
    g.onDown(tev(1, p))
    vi.advanceTimersByTime(100) // well under the hold threshold
    g.onUp(tev(1, p))
    expect(g.selSet.has(n.id)).toBe(true)
    expect(getHover()?.id).toBe(n.id)
    expect(n.fx == null).toBe(true) // no pin left behind
    gv.destroy()
  })
  it('a SLOW stationary tap (past the hold threshold) still selects - and leaves no pin', () => {
    const { gv, g } = fresh()
    const n = visPlayers()[0]
    const p = screen(g, n)
    g.onDown(tev(1, p))
    vi.advanceTimersByTime(400) // hold fires: the node is silently grabbed
    expect(g.dragNode).toBe(n)
    g.onUp(tev(1, p)) // ...but released without moving = the user meant a tap
    expect(g.selSet.has(n.id)).toBe(true)
    expect(n.fx == null).toBe(true)
    expect(g.dragNode).toBe(null)
    expect(g.sim.alphaTarget()).toBe(0) // the silent grab never reheated the sim
    gv.destroy()
  })
})

describe('coarse-pointer devices with a MOUSE (tapTipOnly)', () => {
  const mev = (p: { clientX: number; clientY: number }) => ({ pointerType: 'mouse', button: 0, buttons: 0, preventDefault: noop, ...p })
  it('mouse hover highlights but does NOT drive the tooltip (it would dismiss the tapped-open sheet)', () => {
    const { gv, g, getHover } = fresh()
    g.tapTipOnly = true
    const n = visPlayers()[0]
    g.onMove(mev(screen(g, n)))
    expect(g.hover).toBe(n)                        // highlight follows the mouse...
    expect(getHover()).toBe(null)                  // ...the sheet does not
    gv.destroy()
  })
  it('a mouse CLICK still selects and opens the sheet - the only card path for mouse users there', () => {
    const { gv, g, getHover } = fresh()
    g.tapTipOnly = true
    const n = visPlayers()[0]
    const p = screen(g, n)
    g.onDown(mev(p)); g.onUp(mev(p))
    expect(g.selSet.has(n.id)).toBe(true)
    expect(getHover()?.id).toBe(n.id)
    gv.destroy()
  })
  it('in cut mode a mouse click is inspect-only, mirroring touch taps', () => {
    const { gv, g, getHover } = fresh()
    g.tapTipOnly = true
    const cup = model.nodes.find((x) => x.vis && x.type === 'cup')!
    gv.selectNodes([cup.id])
    gv.setCut(true)
    const other = visPlayers()[0] // a roster member kept visible by the cut
    const p = screen(g, other)
    g.onDown(mev(p)); g.onUp(mev(p))
    expect(g.selSet.has(other.id)).toBe(false)     // did not mutate the cut...
    expect(getHover()?.id).toBe(other.id)          // ...opened the card
    gv.destroy()
  })
})

describe('the orphaned-hold-timer bugs (two fingers landing on nodes)', () => {
  it('a two-finger quick tap leaves NO delayed grab, NO pin, and NO hot simulation', () => {
    const { gv, g } = fresh()
    const [a, b] = visPlayers()
    g.onDown(tev(1, screen(g, a)))
    vi.advanceTimersByTime(50)
    g.onDown(tev(2, screen(g, b))) // second finger: used to orphan finger 1's timer
    vi.advanceTimersByTime(50)
    g.onUp(tev(1, screen(g, a))); g.onUp(tev(2, screen(g, b)))
    vi.advanceTimersByTime(1000) // the orphaned timer used to fire here, with zero fingers down
    expect(g.dragNode).toBe(null)
    expect(a.fx == null && b.fx == null).toBe(true)
    expect(g.sim.alphaTarget()).toBe(0)
    gv.destroy()
  })
  it('holding two fingers on two nodes never leaves either node permanently pinned', () => {
    const { gv, g } = fresh()
    const [a, b] = visPlayers()
    g.onDown(tev(1, screen(g, a)))
    vi.advanceTimersByTime(100)
    g.onDown(tev(2, screen(g, b)))
    vi.advanceTimersByTime(1000) // both timers would have fired under the old code
    g.onUp(tev(1, screen(g, a))); g.onUp(tev(2, screen(g, b)))
    expect(a.fx == null && a.fy == null).toBe(true) // node A used to stay frozen until reload
    expect(b.fx == null && b.fy == null).toBe(true)
    expect(g.sim.alphaTarget()).toBe(0)
    gv.destroy()
  })
})

describe('hold-to-drag', () => {
  it('hold then move drags the node (pin follows the finger, sim reheats); release unpins', () => {
    const { gv, g } = fresh()
    const n = visPlayers()[0]
    const p = screen(g, n)
    g.onDown(tev(1, p))
    vi.advanceTimersByTime(300) // hold fires → grab
    expect(g.dragNode).toBe(n)
    g.onMove(tev(1, { clientX: p.clientX + 60, clientY: p.clientY + 40 }))
    expect(Number.isFinite(n.fx)).toBe(true)
    expect(g.sim.alphaTarget()).toBeCloseTo(0.3) // reheated on the first real drag move
    g.onUp(tev(1, { clientX: p.clientX + 60, clientY: p.clientY + 40 }))
    expect(n.fx == null).toBe(true)
    expect(g.dragNode).toBe(null)
    expect(g.sim.alphaTarget()).toBe(0)
    expect(g.selSet.has(n.id)).toBe(false) // a drag is not a select
    gv.destroy()
  })
  it('pointercancel mid-drag releases the pin and cools the sim (OS took the gesture)', () => {
    const { gv, g } = fresh()
    const n = visPlayers()[0]
    const p = screen(g, n)
    g.onDown(tev(1, p))
    vi.advanceTimersByTime(300)
    g.onMove(tev(1, { clientX: p.clientX + 60, clientY: p.clientY + 40 }))
    expect(g.sim.alphaTarget()).toBeCloseTo(0.3)
    g.onCancel(tev(1, { clientX: p.clientX + 60, clientY: p.clientY + 40 }))
    expect(n.fx == null).toBe(true)
    expect(g.dragNode).toBe(null)
    expect(g.sim.alphaTarget()).toBe(0)
    expect(g.touchPtr).toBe(null)
    gv.destroy()
  })
})

describe('pan + pinch for gestures that start on a node', () => {
  it('a swipe starting on a node PANS the camera (this used to be a dead gesture)', () => {
    const { gv, g } = fresh()
    const n = visPlayers()[0]
    const p = screen(g, n)
    const t0 = { ...g.transform }
    g.onDown(tev(1, p))
    vi.advanceTimersByTime(60) // move before the hold fires
    g.onMove(tev(1, { clientX: p.clientX + 30, clientY: p.clientY + 15 }))
    g.onMove(tev(1, { clientX: p.clientX + 70, clientY: p.clientY + 45 }))
    expect(g.transform.x - t0.x).toBeCloseTo(70)
    expect(g.transform.y - t0.y).toBeCloseTo(45)
    expect(g.transform.k).toBe(t0.k)
    g.onUp(tev(1, { clientX: p.clientX + 70, clientY: p.clientY + 45 }))
    expect(g.selSet.size).toBe(0) // a pan is not a select
    expect(g.dragNode).toBe(null)
    vi.advanceTimersByTime(1000)
    expect(n.fx == null).toBe(true)
    gv.destroy()
  })
  it('a second finger turns the gesture into a pinch-zoom (spreading fingers zooms in)', () => {
    const { gv, g } = fresh()
    const n = visPlayers()[0]
    const p = screen(g, n)
    const k0 = g.transform.k
    g.onDown(tev(1, p))
    vi.advanceTimersByTime(60)
    g.onDown(tev(2, { clientX: p.clientX + 100, clientY: p.clientY })) // pinch begins; hold cancelled
    vi.advanceTimersByTime(1000) // the hold must NOT fire mid-pinch
    expect(g.dragNode).toBe(null)
    // spread: finger 2 moves 100px further away → distance doubles → zoom roughly doubles
    g.onMove(tev(2, { clientX: p.clientX + 200, clientY: p.clientY }))
    expect(g.transform.k).toBeGreaterThan(k0 * 1.8)
    expect(g.transform.k).toBeLessThan(k0 * 2.2)
    g.onUp(tev(1, p)); g.onUp(tev(2, { clientX: p.clientX + 200, clientY: p.clientY }))
    expect(g.touchPtr).toBe(null); expect(g.touch2Ptr).toBe(null)
    gv.destroy()
  })
  it('a second finger on a NODE during a d3-owned background gesture stays with d3 (native pinch)', () => {
    const { gv, g } = fresh()
    const n = visPlayers()[0]
    // finger 1 began on background: d3-zoom fired its start handler with a touch sourceEvent
    g.zoomBeh.on('start')({ sourceEvent: { touches: [{ clientX: 5, clientY: 5 }], clientX: 5, clientY: 5 } })
    expect(g.zoomTouchActive).toBe(true)
    g.onDown(tev(2, screen(g, n)))                 // finger 2 lands on a node mid-gesture
    expect(g.touchPtr).toBe(null)                  // we do NOT claim it...
    const filter = g.zoomBeh.filter()
    expect(filter({ type: 'touchstart', touches: [{}, {}] })).toBe(true) // ...d3's pinch forms
    g.zoomBeh.on('end')({ sourceEvent: { type: 'touchend', changedTouches: [{ clientX: 5, clientY: 5 }] } })
    expect(g.zoomTouchActive).toBe(false)          // gesture over: node touches are ours again
    gv.destroy()
  })
  it('lifting the FIRST finger mid-pinch hands the gesture to the second finger as a pan', () => {
    const { gv, g } = fresh()
    const n = visPlayers()[0]
    const p = screen(g, n)
    g.onDown(tev(1, p))
    vi.advanceTimersByTime(60)
    g.onDown(tev(2, { clientX: p.clientX + 100, clientY: p.clientY })) // pinch
    g.onUp(tev(1, p))                                                  // FIRST finger lifts
    expect(g.touchPtr).toBe(2)                                         // finger 2 promoted...
    expect(g.touchMode).toBe('pan')
    const t0 = { ...g.transform }
    g.onMove(tev(2, { clientX: p.clientX + 130, clientY: p.clientY + 20 }))
    expect(g.transform.x - t0.x).toBeCloseTo(30)                       // ...and it pans
    expect(g.transform.y - t0.y).toBeCloseTo(20)
    g.onUp(tev(2, { clientX: p.clientX + 130, clientY: p.clientY + 20 }))
    expect(g.touchPtr).toBe(null)
    gv.destroy()
  })
  it('while we own a touch gesture, the d3-zoom filter rejects new touchstarts', () => {
    const { gv, g } = fresh()
    const n = visPlayers()[0]
    const p = screen(g, n)
    g.onDown(tev(1, p))
    const filter = g.zoomBeh.filter()
    expect(filter({ type: 'touchstart', touches: [{ clientX: 1, clientY: 1 }, { clientX: 2, clientY: 2 }] })).toBe(false)
    g.onUp(tev(1, p))
    // gesture over: two background fingers are d3-zoom's native pinch again
    expect(filter({ type: 'touchstart', touches: [{ clientX: 1, clientY: 1 }, { clientX: 2, clientY: 2 }] })).toBe(true)
    gv.destroy()
  })
})
