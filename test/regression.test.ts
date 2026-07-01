import { describe, it, expect } from 'vitest'
import { buildModel, inEras } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import { initState, defaultState } from '../src/lib/urlstate'
import type { ViewState } from '../src/lib/types'

const yearsOf = (id: string): number[] => {
  const n = model.nodeById.get(id)
  return n ? (n.type === 'cup' ? [n.year!] : (n.cups ?? []).map((c) => c.year)) : []
}

const model = buildModel()
const noop = () => {}
const base: ViewState = { eras:[{start:1980,end:1993}], positions:{F:true,D:true,G:true},
  multiOnly:false, colorMode:'position', layoutMode:'network' }
const setRect = (w:number,h:number) => { (globalThis as any).__rect = { width:w, height:h, left:0,top:0,right:w,bottom:h,x:0,y:0, toJSON(){} } }

describe('FIX: window resize re-frames the graph (onResize re-fits, not just repaints)', () => {
  it('content recentres into the new viewport after a resize', () => {
    setRect(1280,720)
    const gv:any = new GraphView(document.createElement('canvas'), model, {...base,eras:[{start:1980,end:1993}]}, {onStats:noop,onHover:noop})
    gv.fit()
    setRect(700,460)
    gv.onResize()
    expect(gv.W).toBe(700); expect(gv.H).toBe(460)
    // the visible-node bounding-box centre must map to the NEW viewport centre (proves a re-fit, not stale framing)
    const vis = model.nodes.filter((n:any)=>n.vis)
    let a=1e9,b=1e9,c=-1e9,d=-1e9
    // measure the same glyph-aware bbox computeFit frames (cups are tall) so this checks the exact
    // centre it targets, independent of how settled the layout is
    for (const n of vis){
      const lr=n.type==='cup'?n.r*0.66:n.r, up=n.type==='cup'?n.r*1.5:n.r, dn=n.type==='cup'?n.r*1.36:n.r
      a=Math.min(a,n.x-lr);b=Math.min(b,n.y-up);c=Math.max(c,n.x+lr);d=Math.max(d,n.y+dn)
    }
    const t=gv.transform, cx=(a+c)/2, cy=(b+d)/2
    expect(Math.abs(cx*t.k+t.x - gv.W/2)).toBeLessThan(2)
    expect(Math.abs(cy*t.k+t.y - gv.H/2)).toBeLessThan(2)
    setRect(1280,720); gv.destroy()
  })
})

describe('FIX: a stationary background click during a re-frame does NOT abort camera tracking', () => {
  it('zoom start (click) keeps trackFit; an actual pan/zoom clears it', () => {
    const gv:any = new GraphView(document.createElement('canvas'), model, {...base}, {onStats:noop,onHover:noop})
    gv.trackFit = true
    gv.zoomBeh.on('start')({ sourceEvent: { clientX:5, clientY:5 } })   // stationary click
    expect(gv.trackFit).toBe(true)                                       // tracking preserved
    gv.zoomBeh.on('zoom')({ sourceEvent: { clientX:5, clientY:5 }, transform:{x:0,y:0,k:1} }) // real movement
    expect(gv.trackFit).toBe(false)                                      // now stopped
    // a programmatic transform (no sourceEvent) must NOT clear tracking
    gv.trackFit = true
    gv.zoomBeh.on('zoom')({ transform:{x:0,y:0,k:1} })
    expect(gv.trackFit).toBe(true)
    gv.destroy()
  })
})

describe('FIX: malformed ?from=/?to= deep link does not blank the graph (real initState)', () => {
  it('non-numeric input keeps the default era (no NaN era)', () => {
    expect(initState('?from=abc&to=2000', yearsOf).eras).toEqual(defaultState().eras)
    expect(initState('?from=1980&to=xyz', yearsOf).eras).toEqual(defaultState().eras)
  })
  it('valid input produces a clamped, ordered era', () => {
    expect(initState('?from=1993&to=1980', yearsOf).eras).toEqual([{start:1980,end:1993}])
    expect(initState('?from=1850&to=2200', yearsOf).eras).toEqual([{start:1915,end:2026}])
  })
})

describe('FIX: a selection with no matches in the current era still greys the rest out', () => {
  it('highlightSet stays a dim-all (empty, non-null) set when the selection is hidden by the era', () => {
    setRect(1280, 720)
    const gv:any = new GraphView(document.createElement('canvas'), model, {...base}, {onStats:noop,onHover:noop})
    gv.setState({ eras:[{start:2006,end:2026}] })                 // Cap era: Florida (2024/2025) visible
    const fla = model.nodes.find((n:any) => n.type==='cup' && n.abbr==='FLA' && n.vis)!
    gv.selectNodes([fla.id])
    const hsIn = gv.highlightSet()
    expect(hsIn).not.toBeNull(); expect(hsIn.size).toBeGreaterThan(1)   // node + its player network
    gv.setState({ eras:[{start:1942,end:1967}] })                // Original Six: Florida has no Cups
    expect(fla.vis).toBe(false)
    const hsOut = gv.highlightSet()
    expect(hsOut).not.toBeNull()   // selection still active → still dims…
    expect(hsOut.size).toBe(0)     // …everything (nothing matches this era)
    gv.destroy()
  })
})

// setBg flips the canvas ink (edges / name labels / highlight edges) by the background's perceived
// brightness: light themes need dark ink, near-black (AMOLED) themes need extra edge opacity, and
// the light themes' label halo is painted in the background's OWN rgb (a pure-white halo read as
// chalky boxes on the cream backgrounds).
describe('setBg derives the canvas ink from the background luminance', () => {
  const mk = (): any => new GraphView(document.createElement('canvas'), model, {...base}, {onStats:noop,onHover:noop})
  it('a light theme (Solarized Light) flips to dark ink with a bg-matched label halo', () => {
    const g = mk()
    g.setBg('#fdf6e3')
    expect(g.edgeRgb).toBe('92,104,128')               // dark slate edges - light ones vanish on cream
    expect(g.edgeAlpha).toBe(0.30)                     // the most-lifted tier: dark-on-light contrast is worst
    expect(g.nameFill).toBe('#33373f')
    expect(g.nameHalo).toBe('rgba(253,246,227,0.92)')  // the bg's own r,g,b - melts in, still knocks out edges
    expect(g.hlEdge).toBe('40,44,52')                  // gold highlight edges vanish on light backgrounds
    g.destroy()
  })
  it('pure black (AMOLED) raises edge opacity above the standard dark tier and keeps gold highlights', () => {
    const g = mk()
    g.setBg('#000000')
    expect(g.edgeRgb).toBe('150,170,205')
    expect(g.edgeAlpha).toBe(0.25)                     // lifted above the 0.18 dark tier for true black
    expect(g.nameFill).toBe('#e8edf6')
    expect(g.nameHalo).toBe('rgba(6,9,16,0.92)')
    expect(g.hlEdge).toBe('255,207,77')                // gold reads fine on black
    g.destroy()
  })
  it('a standard dark grey (#1e1e2e, the :root fallback) uses the plain dark tier', () => {
    const g = mk()
    g.setBg('#fdf6e3') // leave the constructor default first - setBg no-ops on an unchanged value
    g.setBg('#1e1e2e')
    expect(g.edgeRgb).toBe('150,170,205')
    expect(g.edgeAlpha).toBe(0.18)                     // between the light (0.30) and AMOLED (0.25) tiers
    expect(g.nameFill).toBe('#e8edf6')
    expect(g.nameHalo).toBe('rgba(6,9,16,0.92)')
    expect(g.hlEdge).toBe('255,207,77')
    g.destroy()
  })
  it('an unparseable colour falls back to dark-theme ink (bgBrightness assumes mid-dark)', () => {
    const g = mk()
    g.setBg('#fdf6e3')          // start light so the fallback demonstrably flips BACK to dark ink
    g.setBg('hsl(20 30% 40%)')  // not #rrggbb - the luminance probe can't read it
    expect(g.edgeRgb).toBe('150,170,205')
    expect(g.edgeAlpha).toBe(0.18)
    expect(g.nameFill).toBe('#e8edf6')
    expect(g.nameHalo).toBe('rgba(6,9,16,0.92)')
    expect(g.hlEdge).toBe('255,207,77')
    g.destroy()
  })
  it('an unchanged (or empty) value is a no-op: no repaint scheduled, ink untouched', () => {
    const g = mk()
    g.setBg('#fdf6e3')
    let repaints = 0
    g.schedule = () => { repaints++ }  // instance shadow over the private scheduler - counts repaint requests
    g.setBg('#fdf6e3')                 // same value -> the guard returns before any derivation
    g.setBg('')                        // falsy -> ditto
    expect(repaints).toBe(0)
    expect(g.nameHalo).toBe('rgba(253,246,227,0.92)') // light-theme ink untouched
    g.setBg('#000000')                 // a REAL change still schedules exactly one repaint
    expect(repaints).toBe(1)
    g.destroy()
  })
})

describe('FIX: ?focus= derives an era so a historic node is visible (real initState)', () => {
  it('focusing a pre-2006 player yields an era covering their career (else hidden by default cap era)', () => {
    const henri = model.nodes.find(n=>n.type==='player' && n.name==='Henri Richard')!
    const ys = henri.cups!.map(c=>c.year)
    const s = initState(`?focus=${henri.id}`, yearsOf)   // the SHIPPED function, not a replica
    expect(s.eras).toEqual([{ start: Math.min(...ys), end: Math.max(...ys) }])
    expect(s.eras[0].start).toBeLessThan(2006)           // would be invisible under the default cap era
    expect(ys.every(y => inEras(y, s.eras))).toBe(true)  // every Cup of the career is visible
  })
  it('an unknown ?focus= id derives nothing (and App also refuses to select it)', () => {
    expect(initState('?focus=banana', yearsOf)).toEqual(defaultState())
  })
})

describe('FIX: undo of a colour-only change is render-only (no sim reheat, no camera refit)', () => {
  // restoreView used to refilter for ANY non-empty patch; minimalPatch includes colorMode, so
  // Cmd+Z after a Position<->Dynasty toggle re-heated the settled layout and auto-fit the
  // camera, destroying the user's pan/zoom - the forward action never did (setState treats
  // colour as render-only).
  it('a colorMode-only restore keeps the settle cold; a visibility restore still refits', () => {
    const gv: any = new GraphView(document.createElement('canvas'), model, { ...base }, { onStats: noop, onHover: noop })
    gv.trackFit = false                                        // pretend the boot settle finished
    gv.restoreView({ colorMode: 'dynasty' }, [], false)
    expect(gv.trackFit).toBe(false)                            // render-only: no refit armed
    gv.restoreView({ eras: [{ start: 2006, end: 2026 }] }, [], false)
    expect(gv.trackFit).toBe(true)                             // visibility patches still refilter
    gv.destroy()
  })
})
