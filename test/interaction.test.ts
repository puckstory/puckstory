import { describe, it, expect } from 'vitest'
import { buildModel, inEras } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import type { ViewState } from '../src/lib/types'

const model = buildModel()
const noop = () => {}
const base: ViewState = { eras:[{start:1980,end:1993}], positions:{F:true,D:true,G:true},
  multiOnly:false, colorMode:'position', layoutMode:'network' }

function fresh() {
  const canvas = document.createElement('canvas')
  let hover:any; let hx=0, hy=0
  const gv = new GraphView(canvas as any, model, {...base, eras:base.eras.map(e=>({...e}))},
    { onStats:noop, onHover:(n,x,y)=>{hover=n;hx=x;hy=y} })
  return { gv, getHover:()=>hover }
}
// screen position of a node under the current transform (canvas rect at 0,0)
function screen(gv:any, n:any){ const t=gv.transform; return { clientX:n.x*t.k+t.x, clientY:n.y*t.k+t.y } }
const ev = (o:any)=>({ button:0, buttons:0, preventDefault:noop, ...o })

describe('selection (click) + highlight', () => {
  it('clicking a node selects it; highlight = node + neighbours', () => {
    const { gv } = fresh(); const g:any = gv
    const n = model.nodes.find(x=>x.vis && x.type==='player' && x.rangeCupCount>=2)!
    const p = screen(g,n)
    g.onDown(ev(p)); g.onUp(ev(p))
    expect(g.selSet.has(n.id)).toBe(true)
    const hs:Set<string> = g.highlightSet()
    expect(hs.has(n.id)).toBe(true)
    // a neighbour cup is in the highlight
    const nb = [...g.m.adj.get(n.id)][0]
    expect(hs.has(nb)).toBe(true)
    // click again deselects
    g.onDown(ev(p)); g.onUp(ev(p))
    expect(g.selSet.has(n.id)).toBe(false)
    gv.destroy()
  })
  it('setSelection/clearSelection (the ?focus= deep-link path)', () => {
    const { gv } = fresh(); const g:any = gv
    const n = model.nodes.find(x=>x.vis)!
    gv.setSelection(n.id); expect(g.selSet.has(n.id)).toBe(true)
    gv.clearSelection(); expect(g.selSet.size).toBe(0)
    gv.destroy()
  })
  it('selectNodes adds to the selection (search picks build up, like clicking nodes)', () => {
    const { gv } = fresh(); const g:any = gv
    // a team pick = all its Cup ids at once (e.g. Florida 2024 + 2025)
    const fla = model.nodes.filter(x => x.type === 'cup' && x.abbr === 'FLA').map(x => x.id)
    expect(fla.length).toBeGreaterThan(1)
    gv.selectNodes(fla)
    expect(g.selSet.size).toBe(fla.length)
    // picking another (a player) ADDS to the selection rather than replacing it
    const player = model.nodes.find(x => x.type === 'player')!
    gv.selectNodes([player.id])
    expect(g.selSet.size).toBe(fla.length + 1)
    for (const id of fla) expect(g.selSet.has(id)).toBe(true)
    expect(g.selSet.has(player.id)).toBe(true)
    gv.clearSelection(); expect(g.selSet.size).toBe(0)
    gv.destroy()
  })
})

describe('onSelection callback (drives the ?focus= URL sync)', () => {
  it('fires with the full id list on select, add, and clear', () => {
    const canvas = document.createElement('canvas')
    const calls: string[][] = []
    const gv = new GraphView(canvas as any, model, {...base, eras: base.eras.map(e=>({...e}))},
      { onStats: noop, onHover: noop, onSelection: (ids) => calls.push(ids) })
    const g: any = gv
    const n = model.nodes.find(x=>x.vis && x.type==='player')!
    const p = screen(g, n)
    g.onDown(ev(p)); g.onUp(ev(p))                       // click-select
    expect(calls.at(-1)).toEqual([n.id])
    const fla = model.nodes.filter(x => x.type==='cup' && x.abbr==='FLA').map(x=>x.id)
    gv.selectNodes(fla)                                  // search pick adds
    expect(calls.at(-1)).toEqual([n.id, ...fla])
    gv.clearSelection()                                  // reset / background tap
    expect(calls.at(-1)).toEqual([])
    gv.destroy()
  })
})

describe('hover', () => {
  it('moving over a node sets hover; off-node clears it', () => {
    const { gv, getHover } = fresh(); const g:any = gv
    const n = model.nodes.find(x=>x.vis && x.type==='cup')!
    g.onMove(ev(screen(g,n)))
    expect(getHover()?.id).toBe(n.id)
    g.onMove(ev({ clientX:5, clientY:5 })) // empty corner
    expect(getHover()).toBeFalsy()
    gv.destroy()
  })
})

describe('deselecting under the cursor suppresses re-hover (suppressHoverId)', () => {
  it('the node stays unlit while the pointer parks on it; leaving and returning re-lights it', () => {
    const { gv, getHover } = fresh(); const g:any = gv
    const n = model.nodes.find(x=>x.vis && x.type==='player')!
    const p = screen(g,n)
    g.onDown(ev(p)); g.onUp(ev(p))            // click: select
    g.onMove(ev(p))                           // hover the node we just selected
    expect(getHover()?.id).toBe(n.id)
    g.onDown(ev(p)); g.onUp(ev(p))            // click again: DESELECT under the cursor
    expect(g.selSet.has(n.id)).toBe(false)
    // the highlight must drop immediately, not wait for the cursor to move off the node
    expect(getHover()).toBe(null)
    expect(g.suppressHoverId).toBe(n.id)
    g.onMove(ev(p))                           // pointer still parked on the node...
    expect(g.hover).toBe(null)                // ...it must NOT instantly re-light itself
    expect(getHover()).toBe(null)
    g.onMove(ev({ clientX:5, clientY:5 }))    // leaving to an empty corner clears the suppression
    g.onMove(ev(p))                           // return to the very same node
    expect(getHover()?.id).toBe(n.id)         // hover behaves normally again
    gv.destroy()
  })
})

describe('drag', () => {
  it('press+move past threshold pins the node; release unpins', () => {
    const { gv } = fresh(); const g:any = gv
    const n = model.nodes.find(x=>x.vis && x.type==='player')!
    const p = screen(g,n)
    g.onDown(ev(p))
    g.onMove(ev({ clientX:p.clientX+40, clientY:p.clientY+40 }))
    expect(g.dragNode).toBe(n)
    expect(Number.isFinite(n.fx) && Number.isFinite(n.fy)).toBe(true)
    g.onUp(ev({ clientX:p.clientX+40, clientY:p.clientY+40 }))
    expect(g.dragNode).toBe(null)
    expect(n.fx).toBe(null)
    gv.destroy()
  })
})

// When something is selected, the header's F/D/G pills describe the LIT roster (the selection plus
// its neighbours), not the whole era - and fall back to the era totals whenever the current era
// hides the entire selection (selectionPosCounts returns null then).
describe('selection drives the F/D/G stat pills (selectionPosCounts)', () => {
  it('a selected cup reports its roster; an era hiding it falls back to totals; clear restores', () => {
    let stats:any = null
    const gv = new GraphView(document.createElement('canvas') as any, model,
      { ...base, eras:[{start:2006,end:2026}] },
      { onStats:(s)=>{stats=s}, onHover:noop })
    // era totals computed independently of GraphView: every player with >=1 in-era Cup, by position
    const totals = (eras:{start:number;end:number}[]) => {
      const c:any = { F:0, D:0, G:0 }
      for (const n of model.nodes)
        if (n.type==='player' && n.cups!.some((cc)=>inEras(cc.year, eras))) c[n.group!]++
      return c
    }
    const cap = [{start:2006,end:2026}], o6 = [{start:1942,end:1967}]
    expect(stats.posCounts).toEqual(totals(cap))       // nothing selected: pills show era totals
    gv.selectNodes(['cup-2025'])
    // expected roster straight from the adjacency map: a cup's neighbours ARE its engraved players
    const roster:any = { F:0, D:0, G:0 }
    model.adj.get('cup-2025')!.forEach((id)=>{
      const n = model.nodeById.get(id)!
      if (n.type==='player') roster[n.group!]++
    })
    expect(stats.posCounts).toEqual(roster)            // pills switched to the lit roster...
    expect(stats.posCounts).not.toEqual(totals(cap))   // ...which is genuinely narrower than the era
    gv.setState({ eras:o6.map(e=>({...e})) })          // Original Six: the 2025 Cup isn't in this era
    expect((model.nodeById.get('cup-2025') as any).vis).toBe(false)
    expect(stats.posCounts).toEqual(totals(o6))        // whole selection hidden -> era totals again
    gv.setState({ eras:cap.map(e=>({...e})) })         // era moves back over the selection...
    expect(stats.posCounts).toEqual(roster)            // ...the roster breakdown returns
    gv.clearSelection()
    expect(stats.posCounts).toEqual(totals(cap))       // no selection -> totals restored
    gv.destroy()
  })
})

// The "2+" (Multi-Cup only) filter must narrow the F/D/G pill counts to multi-Cup players, exactly
// as it narrows the canvas - a single-Cup forward can't still be tallied once 2+ hides it.
// (Regression: computeStats used to count every in-era player into posCounts regardless of 2+.)
describe('the 2+ (Multi-Cup) filter narrows the F/D/G stat pills', () => {
  it('turning 2+ on drops single-Cup players from posCounts; off restores them', () => {
    let stats:any = null
    const eras = [{start:1980,end:1993}]        // Islanders + Oilers era: plenty of single-Cup role players
    const gv = new GraphView(document.createElement('canvas') as any, model,
      { ...base, eras: eras.map(e=>({...e})), multiOnly:false },
      { onStats:(s)=>{stats=s}, onHover:noop })
    // independent breakdowns from the dataset: all in-era players, and multi-Cup-in-era only
    const byPos = (min:number) => {
      const c:any = { F:0, D:0, G:0 }
      for (const n of model.nodes) {
        if (n.type!=='player') continue
        let rcc=0; for (const cc of n.cups!) if (inEras(cc.year, eras)) rcc++
        if (rcc>=min) c[n.group!]++
      }
      return c
    }
    const all = byPos(1), multi = byPos(2)
    expect(multi).not.toEqual(all)                     // guard: the era genuinely has single-Cup players
    expect(stats.posCounts).toEqual(all)               // 2+ off: every in-era player counts
    gv.setState({ multiOnly:true })
    expect(stats.posCounts).toEqual(multi)             // 2+ on: only multi-Cup players remain
    // pills now agree with the canvas: with all positions on, the F/D/G total == visible players
    const visPlayers = model.nodes.filter(n=>n.vis && n.type==='player').length
    expect(multi.F+multi.D+multi.G).toBe(visPlayers)
    gv.setState({ multiOnly:false })
    expect(stats.posCounts).toEqual(all)               // 2+ off again: restored
    gv.destroy()
  })
})

describe('a selection with no visible matches greys the whole graph out', () => {
  it('highlightSet stays a dim-all (empty, non-null) set once the only selected node is hidden', () => {
    const { gv } = fresh(); const g:any = gv
    const n = model.nodes.find(x=>x.vis && x.type==='player')!
    gv.setSelection(n.id)
    expect((g.highlightSet() as Set<string>).has(n.id)).toBe(true)
    // pick an era where this player has no Cup -> it becomes invisible
    const yrs = new Set(n.cups.map((c:any)=>c.year))
    let era = {start:2006,end:2026}; if ([...yrs].some(y=>y>=2006)) era = {start:1915,end:1941}
    gv.setState({ eras:[era] })
    expect(n.vis).toBe(false)
    const hs = g.highlightSet()
    expect(hs).not.toBe(null)  // selection still active -> keeps dimming...
    expect(hs.size).toBe(0)    // ...everything (the selected node isn't in this era)
    gv.destroy()
  })
})

describe('chain selections keep the stat pills exact', () => {
  it('selectChain counts only the chain players in posCounts - not the linking Cups rosters', () => {
    // the F/D/G pills must agree with the canvas: 3 lit chain players, not ~40 roster members
    const m2 = buildModel()
    let stats: any = null
    const gv: any = new GraphView(document.createElement('canvas'), m2,
      { ...base, eras: [{ start: 1984, end: 1992 }] },
      { onStats: (s: any) => (stats = s), onHover: noop })
    gv.selectChain(['pl-mariolemieux', 'cup-1991', 'pl-paulcoffey', 'cup-1985', 'pl-waynegretzky'])
    expect(stats.posCounts).toEqual({ F: 2, D: 1, G: 0 }) // Lemieux + Gretzky (F), Coffey (D)
    gv.destroy()
  })
})
