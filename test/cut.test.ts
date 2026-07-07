import { describe, it, expect, vi } from 'vitest'
import { buildModel, teamRgb } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import type { ViewState, Era } from '../src/lib/types'

/*
 * Cut mode (the scissors button): visibility becomes "passes the era/position/multi filters AND
 * belongs to the selection's network" - selected ids plus everything directly connected. The
 * keep-set is re-derived from the LIVE selection on every filter pass, so era changes after a cut
 * reveal the selection's nodes in the new range while unconnected nodes stay hidden (not faded).
 */

const noop = () => {}
const base: ViewState = { eras: [{ start: 2006, end: 2026 }], positions: { F: true, D: true, G: true },
  multiOnly: false, colorMode: 'position', layoutMode: 'network' }

function fresh(eras: Era[] = base.eras) {
  const model = buildModel() // per-test model so visibility mutations can't leak between tests
  const canvas = document.createElement('canvas')
  const calls: Array<{ ids: string[]; cut: boolean }> = []
  const nudges = { count: 0 } // onCutNudge fires when cut-mode swallows a background tap
  const hovers: Array<{ id: string } | null> = []
  const gv = new GraphView(canvas as any, model, { ...base, eras: eras.map((e) => ({ ...e })) },
    { onStats: noop, onHover: (n) => hovers.push(n), onSelection: (ids, cut) => calls.push({ ids, cut }),
      onCutNudge: () => nudges.count++ })
  return { gv, model, calls, nudges, hovers }
}

describe('cut mode', () => {
  it('cutting a selected cup keeps exactly the cup + its roster - the rest is HIDDEN, not faded', () => {
    const { gv, model } = fresh()
    const cup = model.nodeById.get('cup-2025')! // 2025 Florida Panthers
    gv.selectNodes([cup.id])
    const visBefore = model.nodes.filter((n) => n.vis).length
    gv.setCut(true)
    const keep = new Set([cup.id, ...model.adj.get(cup.id)!])
    const vis = model.nodes.filter((n) => n.vis)
    expect(vis.length).toBeGreaterThan(10)          // the roster survived
    expect(vis.length).toBeLessThan(visBefore / 2)  // the rest of the era is gone
    expect(vis.every((n) => keep.has(n.id))).toBe(true)
    gv.destroy()
  })
  it("changing the era AFTER a cut reveals the selection's nodes in the new range", () => {
    const { gv, model } = fresh([{ start: 1984, end: 1984 }])
    const gretzky = model.nodes.find((n) => n.type === 'player' && n.name === 'Wayne Gretzky')!
    gv.selectNodes([gretzky.id])
    gv.setCut(true)
    expect(model.nodes.filter((n) => n.vis && n.type === 'cup').map((n) => n.year)).toEqual([1984])
    gv.setState({ eras: [{ start: 1980, end: 1993 }] }) // widen the era while cut
    const cups = model.nodes.filter((n) => n.vis && n.type === 'cup').map((n) => n.year!).sort()
    expect(cups).toEqual([1984, 1985, 1987, 1988])      // his other Cups appear...
    const others = model.nodes.filter((n) => n.vis && n.type === 'player' && n.id !== gretzky.id)
    expect(others.length).toBe(0)                       // ...unconnected nodes stay gone
    gv.destroy()
  })
  it('a team selection (all its Cup ids) spans eras through a cut', () => {
    const { gv, model } = fresh([{ start: 2025, end: 2025 }])
    const fla = model.nodes.filter((n) => n.type === 'cup' && n.abbr === 'FLA').map((n) => n.id)
    expect(fla.length).toBeGreaterThan(1) // 2024 + 2025
    gv.selectNodes(fla)
    gv.setCut(true)
    expect(model.nodes.filter((n) => n.vis && n.type === 'cup').length).toBe(1)  // era hides 2024
    gv.setState({ eras: [{ start: 2024, end: 2025 }] })
    expect(model.nodes.filter((n) => n.vis && n.type === 'cup').length).toBe(2)  // era change reveals it
    gv.destroy()
  })
  it('moving the era OFF the selection shows nothing - no faded remnants of the network', () => {
    const { gv, model } = fresh()
    gv.selectNodes(['cup-2025']) // 2025 Florida Panthers
    gv.setCut(true)
    // 2006-2024 excludes the selected cup; several 2025 roster players still pass the era filter
    // via other Cups (e.g. back-to-back winners, ex-Tampa champions) and used to linger as faded
    // orphans with their engraved cup hidden
    gv.setState({ eras: [{ start: 2006, end: 2024 }] })
    expect(model.nodes.filter((n) => n.vis).length).toBe(0)
    // era back over the selection → the network returns, whole
    gv.setState({ eras: [{ start: 2006, end: 2026 }] })
    const keep = new Set(['cup-2025', ...model.adj.get('cup-2025')!])
    const vis = model.nodes.filter((n) => n.vis)
    expect(vis.length).toBeGreaterThan(10)
    expect(vis.every((n) => keep.has(n.id))).toBe(true)
    gv.destroy()
  })
  it('with a multi-node selection, only the era-visible selected nodes keep their networks', () => {
    const { gv, model } = fresh()
    const fla = model.nodes.filter((n) => n.type === 'cup' && n.abbr === 'FLA').map((n) => n.id)
    gv.selectNodes(fla) // 2024 + 2025
    gv.setCut(true)
    gv.setState({ eras: [{ start: 2006, end: 2024 }] }) // 2025 falls out of range
    const keep2024 = new Set(['cup-2024', ...model.adj.get('cup-2024')!])
    const vis = model.nodes.filter((n) => n.vis)
    expect(vis.some((n) => n.id === 'cup-2024')).toBe(true)
    expect(vis.every((n) => keep2024.has(n.id))).toBe(true) // nothing kept via the hidden 2025 cup
    gv.destroy()
  })
  it("player sizes reflect the CUT's cups, not every in-era cup (Roy in a Canadiens cut)", () => {
    // Dynasties + Dead Puck: Roy's in-era Cups are MTL 1986/1993 AND COL 1996/2001 (4 total)
    const { gv, model } = fresh([{ start: 1980, end: 1993 }, { start: 1994, end: 2004 }])
    const roy = model.nodes.find((n) => n.type === 'player' && n.name === 'Patrick Roy')!
    expect(roy.rangeCupCount).toBe(4)
    const four = roy.r
    gv.selectNodes(['cup-1986', 'cup-1993']) // the Canadiens' Cups in range
    gv.setCut(true)
    // inside the cut only his Montréal wins are on screen - the dot must weigh 2, not 4
    expect(roy.vis).toBe(true)
    expect(roy.rangeCupCount).toBe(2)
    expect(roy.r).toBeLessThan(four)
    expect(model.nodeById.get('cup-1996')!.vis).toBe(false) // the Avalanche cups are gone...
    expect(model.nodeById.get('cup-2001')!.vis).toBe(false)
    gv.setCut(false) // ...and un-cutting restores the full in-era weighting
    expect(roy.rangeCupCount).toBe(4)
    expect(roy.r).toBe(four)
    gv.destroy()
  })
  it('a stationary background click does NOT tear down a cut (misclick protection)', () => {
    const { gv, model, calls, nudges } = fresh()
    gv.selectNodes(['cup-2025'])
    gv.setCut(true)
    const visCut = model.nodes.filter((n) => n.vis).length
    const g: any = gv
    // a stationary background click, exactly as d3-zoom's start/end handlers see it
    g.zoomBeh.on('start')({ sourceEvent: { clientX: 5, clientY: 5 } })
    g.zoomBeh.on('end')({ sourceEvent: { clientX: 5, clientY: 5, type: 'mouseup' } })
    expect(g.selSet.size).toBe(1)                                  // the selection survives...
    expect(calls.at(-1)).toEqual({ ids: ['cup-2025'], cut: true }) // ...and so does the cut
    expect(model.nodes.filter((n) => n.vis).length).toBe(visCut)
    expect(nudges.count).toBe(1) // ...and the UI is told to pulse the scissors (the way out)
    // out of cut mode, the same tap clears the selection as it always has
    gv.setCut(false)
    g.zoomBeh.on('start')({ sourceEvent: { clientX: 5, clientY: 5 } })
    g.zoomBeh.on('end')({ sourceEvent: { clientX: 5, clientY: 5, type: 'mouseup' } })
    expect(g.selSet.size).toBe(0)
    expect(nudges.count).toBe(1) // no nudge outside cut mode
    gv.destroy()
  })
  it('desktop clicks edit a cut symmetrically - but never remove the LAST anchor', () => {
    // the Mario Lemieux case: his selection IS the cut, so clicking his node must not end it -
    // yet once a second anchor exists, clicking an anchor prunes just that branch
    const { gv, model, calls } = fresh([{ start: 1980, end: 1993 }])
    const mario = model.nodes.find((n) => n.type === 'player' && n.name === 'Mario Lemieux')!
    gv.selectNodes([mario.id])
    gv.setCut(true)
    const g: any = gv
    g.toggleSelect(mario)                                        // last anchor: protected
    expect(g.selSet.has(mario.id)).toBe(true)
    expect(calls.at(-1)).toEqual({ ids: [mario.id], cut: true })
    g.toggleSelect(model.nodeById.get('cup-1991')!)              // clicking something NEW adds
    expect(g.selSet.size).toBe(2)
    expect(model.nodes.filter((n) => n.vis).length).toBeGreaterThan(3) // the 1991 roster joined the cut
    g.toggleSelect(mario)                                        // two anchors: pruning is allowed
    expect(g.selSet.has(mario.id)).toBe(false)
    expect(calls.at(-1)).toEqual({ ids: ['cup-1991'], cut: true }) // the cut survives, reshaped
    expect(mario.vis).toBe(true)                                 // he stays: he is on the 1991 roster
    gv.destroy()
  })
  it('sheet actions: deselectNode prunes an anchor, refuses the last; touch taps only inspect', () => {
    const { gv, model, calls, hovers } = fresh([{ start: 1980, end: 1993 }])
    gv.selectNodes(['cup-1991', 'cup-1992'])
    gv.setCut(true)
    gv.deselectNode('cup-1992')                                  // "Remove from cut"
    expect(calls.at(-1)).toEqual({ ids: ['cup-1991'], cut: true })
    expect(model.nodeById.get('cup-1992')!.vis).toBe(false)      // the pruned branch leaves the view
    gv.deselectNode('cup-1991')                                  // last anchor: refused
    expect(calls.at(-1)).toEqual({ ids: ['cup-1991'], cut: true })
    // on sheet-tooltip (coarse) devices, a tap in a cut is inspect-only - the sheet mutates
    const g: any = gv
    g.tapTipOnly = true
    const pid = [...model.adj.get('cup-1991')!].find((id) => id.startsWith('pl-'))!
    const n = model.nodeById.get(pid)!
    const ev = { pointerType: 'touch', pointerId: 9, preventDefault: noop,
      clientX: n.x! * g.transform.k + g.transform.x, clientY: n.y! * g.transform.k + g.transform.y }
    g.onDown(ev); g.onUp(ev)
    expect(g.selSet.has(pid)).toBe(false)                        // the tap did NOT add...
    expect(hovers.at(-1)?.id).toBe(pid)                          // ...it opened the sheet on the node
    gv.destroy()
  })
  it('restoreView applies state + selection + cut atomically with a SINGLE sim restart', () => {
    const { gv, model, calls } = fresh()
    const g: any = gv
    const restarts = vi.spyOn(g.sim, 'restart')
    gv.restoreView({ eras: [{ start: 1980, end: 1993 }] }, ['cup-1984'], true) // crosses era AND cut
    expect(restarts).toHaveBeenCalledTimes(1)
    expect(calls.at(-1)).toEqual({ ids: ['cup-1984'], cut: true })
    const keep = new Set(['cup-1984', ...model.adj.get('cup-1984')!])
    expect(model.nodes.filter((n) => n.vis).every((n) => keep.has(n.id))).toBe(true)
    restarts.mockClear()
    gv.restoreView({}, ['cup-1984'], true) // restoring the same view again: no restart at all
    expect(restarts).toHaveBeenCalledTimes(0)
    gv.destroy()
  })
  it('setSelectionIds replaces the selection wholesale (the undo/redo restore path)', () => {
    const { gv, model, calls } = fresh()
    gv.selectNodes(['cup-2025', 'cup-2024'])
    gv.setCut(true)
    gv.setSelectionIds(['cup-2024', 'pl-nonexistent'])           // unknown ids dropped
    expect(calls.at(-1)).toEqual({ ids: ['cup-2024'], cut: true })
    const keep = new Set(['cup-2024', ...model.adj.get('cup-2024')!])
    expect(model.nodes.filter((n) => n.vis).every((n) => keep.has(n.id))).toBe(true)
    gv.setSelectionIds([])                                       // restoring to empty ends the cut
    expect(calls.at(-1)).toEqual({ ids: [], cut: false })
    gv.destroy()
  })
  it('deselecting everything ends the cut and restores the full era view', () => {
    const { gv, model, calls } = fresh()
    const before = model.nodes.filter((n) => n.vis).length
    gv.selectNodes(['cup-2025'])
    gv.setCut(true)
    gv.clearSelection()
    expect(calls.at(-1)).toEqual({ ids: [], cut: false })          // cut auto-cleared
    expect(model.nodes.filter((n) => n.vis).length).toBe(before)   // everything is back
    gv.destroy()
  })
  it('setCut with nothing selected is a no-op', () => {
    const { gv, model, calls } = fresh()
    const before = model.nodes.filter((n) => n.vis).length
    gv.setCut(true)
    expect(calls.some((c) => c.cut)).toBe(false)
    expect(model.nodes.filter((n) => n.vis).length).toBe(before)
    gv.destroy()
  })
  it('the selection callback carries the cut flag (drives ?cut=1 in the URL)', () => {
    const { gv, calls } = fresh()
    gv.selectNodes(['cup-2025'])
    expect(calls.at(-1)).toEqual({ ids: ['cup-2025'], cut: false })
    gv.setCut(true)
    expect(calls.at(-1)).toEqual({ ids: ['cup-2025'], cut: true })
    gv.setCut(false)
    expect(calls.at(-1)).toEqual({ ids: ['cup-2025'], cut: false })
    gv.destroy()
  })
})

/*
 * Six Degrees chains are EXACT selections (selectChain): the highlight and any cut keep
 * precisely the chain's own nodes - a linking Cup appears WITHOUT its roster. Ordinary
 * selection changes drop back to expand-to-network behaviour.
 */
describe('chain selections (Six Degrees)', () => {
  it('cutting a chain keeps exactly the chain - the linking Cups come without their rosters', () => {
    const { gv, model } = fresh([{ start: 1984, end: 1992 }])
    // a real corridor: Lemieux - 1991 PIT - Coffey - 1984 EDM - Gretzky
    const chain = ['pl-mariolemieux', 'cup-1991', 'pl-paulcoffey', 'cup-1984', 'pl-waynegretzky']
    gv.selectChain(chain)
    gv.setCut(true)
    const vis = model.nodes.filter((n) => n.vis).map((n) => n.id).sort()
    expect(vis).toEqual([...chain].sort()) // NOT the 1991/1984 rosters - just the corridor
    gv.destroy()
  })
  it('the chain flag reaches the onSelection callback and an ordinary selection clears it', () => {
    const { gv } = fresh([{ start: 1984, end: 1992 }])
    const seen: boolean[] = []
    ;(gv as any).cb.onSelection = (_ids: string[], _cut: boolean, chain: boolean) => seen.push(chain)
    gv.selectChain(['pl-mariolemieux', 'cup-1991', 'pl-paulcoffey'])
    expect(seen.at(-1)).toBe(true)
    gv.selectNodes(['cup-1992'])      // a search pick reshapes the selection...
    expect(seen.at(-1)).toBe(false)   // ...back to normal network semantics
    gv.destroy()
  })
  it('restoreView round-trips the chain flag (undo/redo across a Six Degrees step)', () => {
    const { gv, model } = fresh([{ start: 1984, end: 1992 }])
    const chain = ['pl-mariolemieux', 'cup-1991', 'pl-paulcoffey']
    gv.restoreView({}, chain, true, true) // a restored chain-cut
    const vis = model.nodes.filter((n) => n.vis).map((n) => n.id).sort()
    expect(vis).toEqual([...chain].sort())
    gv.restoreView({}, chain, true, false) // same ids WITHOUT the chain flag -> whole networks return
    expect(model.nodes.filter((n) => n.vis).length).toBeGreaterThan(chain.length + 10)
    gv.destroy()
  })
})

describe('chain cuts under era changes', () => {
  it('members left with zero visible chain Cups hide instead of floating as "0 Cups" orphans', () => {
    const { gv, model } = fresh([{ start: 1980, end: 2026 }])
    // McCarty and Chelios both won again in 2008 (Cap era), so narrowing to Cap leaves them
    // ERA-visible while both chain Cups (2002, 1986) vanish - they must hide with the chain,
    // triggering the "Nothing from this cut" overlay, not linger as linkless dots
    gv.selectChain(['pl-darrenmccarty', 'cup-2002', 'pl-chrischelios', 'cup-1986'])
    gv.setCut(true)
    gv.setState({ eras: [{ start: 2006, end: 2026 }] })
    expect(model.nodes.filter((n) => n.vis).length).toBe(0)
    gv.destroy()
  })
  it('the last-anchor refusal leaves chainSel intact - no silent desync from the ?chain=1 URL', () => {
    const { gv, model } = fresh([{ start: 1984, end: 1992 }])
    gv.restoreView({}, ['cup-1991'], true, true) // a shared single-node chain-cut view
    expect((gv as any).chainSel).toBe(true)
    ;(gv as any).toggleSelect(model.nodeById.get('cup-1991')) // tapping the lone anchor is refused
    expect((gv as any).chainSel).toBe(true)  // ...and must not half-apply
    expect((gv as any).selSet.size).toBe(1)
    gv.destroy()
  })
})

/*
 * Dynasty colours follow the VIEW like node size does: the blend runs over the Cups actually
 * shown, not the whole career.
 */
describe('view-relative dynasty colours', () => {
  it("a split player wears only the visible Cups' team colour (Brad Richards: pure CHI in the cap era)", () => {
    const { gv, model } = fresh([{ start: 2006, end: 2026 }]) // 2004 TBL out of view
    const br = model.nodes.find((n) => n.type === 'player' && n.name === 'Brad Richards')!
    const chi = model.nodeById.get('cup-2015')!
    const [r, g, b] = teamRgb(chi.abbr)
    expect(br.dynastyColor).toBe(`rgb(${r},${g},${b})`) // exactly the 2015 CHI team colour, nothing else
    // widening to include 2004 (his Lightning Cup) brings the two-team blend back
    gv.setState({ eras: [{ start: 1994, end: 2026 }] })
    expect(br.dynastyColor).not.toBe(`rgb(${r},${g},${b})`)
    gv.destroy()
  })
  it('a cut narrows the blend further: only the KEPT Cups colour the player', () => {
    const { gv, model } = fresh([{ start: 1980, end: 2004 }])
    // Roy selected via his two MTL Cups: inside the cut his colour is the MTL team colour only
    gv.selectNodes(['cup-1986', 'cup-1993'])
    gv.setCut(true)
    const roy = model.nodes.find((n) => n.type === 'player' && n.name === 'Patrick Roy')!
    const mtl86 = model.nodeById.get('cup-1986')!, mtl93 = model.nodeById.get('cup-1993')!
    const [r1, g1, b1] = teamRgb(mtl86.abbr), [r2, g2, b2] = teamRgb(mtl93.abbr)
    const expected = `rgb(${Math.round((r1 + r2) / 2)},${Math.round((g1 + g2) / 2)},${Math.round((b1 + b2) / 2)})`
    expect(roy.dynastyColor).toBe(expected) // the COL Cups contribute nothing while cut away
    gv.destroy()
  })
})
