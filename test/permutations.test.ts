import { describe, it, expect } from 'vitest'
import { DATA, buildModel, posGroup, inEras } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import type { ViewState, Era, ColorMode, LayoutMode } from '../src/lib/types'

const d = DATA as any
const model = buildModel()
const noop = () => {}

// independent expected values straight from the dataset
function expected(eras: Era[], positions:{F:boolean;D:boolean;G:boolean}, multi:boolean) {
  let visCups = d.champions.filter((c:any)=>inEras(c.year,eras)).length
  let statPlayers=0, statMulti=0, visPlayers=0
  const posCounts:any = {F:0,D:0,G:0}
  for (const p of d.players) {
    let rcc=0; for (const c of p.cups) if (inEras(c.year,eras)) rcc++
    const g = posGroup(p.position)
    if (rcc>=1) { statPlayers++; if (rcc>=2) statMulti++; posCounts[g]++ }
    let ok = rcc>=1 && positions[g]; if (multi && rcc<2) ok=false
    if (ok) visPlayers++
  }
  return { visCups, visPlayers, statPlayers, statMulti, posCounts }
}

const ERAS: Era[][] = [
  [{start:2006,end:2026}],
  [{start:1942,end:1967}],
  [{start:1942,end:1967},{start:2006,end:2026}], // disjoint
  [{start:1968,end:1979},{start:1980,end:1993}], // adjacent -> merges
  [{start:1915,end:2026}],                        // full
  [{start:2016,end:2016}],                        // single year
  [],                                             // empty
]
const POS = [
  {F:true,D:true,G:true},{F:true,D:false,G:false},{F:false,D:true,G:false},
  {F:false,D:false,G:true},{F:false,D:false,G:false},
]

const canvas = document.createElement('canvas')
let stats:any = null
const gv = new GraphView(canvas as any, model, { eras:ERAS[0], positions:POS[0], multiOnly:false,
  colorMode:'position', layoutMode:'network' }, { onStats:s=>stats=s, onHover:noop })

describe('exhaustive display permutations', () => {
  let n = 0
  for (const layoutMode of ['network','timeline'] as LayoutMode[])
   for (const colorMode of ['position','dynasty'] as ColorMode[])
    for (const multiOnly of [false,true])
     for (const positions of POS)
      for (const eras of ERAS) {
        n++
        it(`#${n} ${layoutMode}/${colorMode}/multi=${multiOnly}/pos=${Object.entries(positions).filter(([,v])=>v).map(([k])=>k).join('')||'none'}/eras=${eras.length}`, () => {
          gv.setState({ layoutMode, colorMode, multiOnly, positions:{...positions}, eras:eras.map(e=>({...e})) })
          gv.render(); gv.fit(); gv.render()
          const exp = expected(eras, positions, multiOnly)
          // stats reflect the era selection
          expect(stats.champions).toBe(exp.visCups)
          expect(stats.players).toBe(exp.statPlayers)
          expect(stats.multi).toBe(exp.statMulti)
          expect(stats.posCounts).toEqual(exp.posCounts)
          // visibility reflects era + position + multi filters
          const vis = model.nodes.filter(nn=>nn.vis)
          expect(vis.filter(nn=>nn.type==='cup').length).toBe(exp.visCups)
          expect(vis.filter(nn=>nn.type==='player').length).toBe(exp.visPlayers)
          // every visible node has finite coordinates; camera transform finite
          expect(vis.every(nn=>Number.isFinite(nn.x)&&Number.isFinite(nn.y)&&Number.isFinite(nn.r))).toBe(true)
          const t=(gv as any).transform
          expect(Number.isFinite(t.x)&&Number.isFinite(t.y)&&Number.isFinite(t.k)).toBe(true)
          if (vis.length) expect(t.k).toBeGreaterThan(0)
          if (layoutMode==='timeline') {
            // wrapped grid assigns every visible champion a finite chronological cell
            const cups=vis.filter(nn=>nn.type==='cup')
            expect(cups.every(nn=>Number.isFinite((nn as any)._tx)&&Number.isFinite((nn as any)._ty))).toBe(true)
          }
        })
      }
  it(`ran all ${n} permutations`, () => { expect(n).toBe(2*2*2*5*7) })
})

describe('timeline wrapped grid (champions laid chronologically into a 2D grid)', () => {
  it('a multi-decade selection wraps into several columns AND rows (fills both axes)', () => {
    gv.setState({ layoutMode:'timeline', eras:[{start:1942,end:1967},{start:2006,end:2026}] })
    const cups = model.nodes.filter(n=>n.vis && n.type==='cup')
    const txs = new Set(cups.map(c=>Math.round((c as any)._tx)))
    const tys = new Set(cups.map(c=>Math.round((c as any)._ty)))
    // a wrapped grid occupies several columns and several rows - not a single line
    expect(txs.size).toBeGreaterThan(1); expect(tys.size).toBeGreaterThan(1)
  })
  it('champions are placed in chronological (year) order across the grid', () => {
    gv.setState({ layoutMode:'timeline', eras:[{start:2006,end:2026}] })
    const cups = model.nodes.filter(n=>n.vis && n.type==='cup').sort((a,b)=>a.year!-b.year!)
    // reading order (row-major): each successive year is either to the right, or wraps to a lower row
    for (let i=1;i<cups.length;i++){
      const p=cups[i-1] as any, q=cups[i] as any
      expect(q._ty > p._ty - 1 || q._tx > p._tx).toBe(true)
    }
  })
})

describe('colour mode is render-only (no vis/stats change)', () => {
  it('switching Position <-> Dynasty leaves visibility and stats untouched', () => {
    gv.setState({ layoutMode:'network', colorMode:'position', multiOnly:false, positions:POS[0], eras:[{start:1915,end:2026}] })
    const before = model.nodes.filter(n=>n.vis).length
    const statsBefore = {...stats}
    gv.setState({ colorMode:'dynasty' }); gv.render() // dynasty render path
    expect(model.nodes.filter(n=>n.vis).length).toBe(before)
    expect(stats.players).toBe(statsBefore.players)
    gv.setState({ colorMode:'position' }); gv.render()
  })
})
