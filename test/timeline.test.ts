import { describe, it, expect } from 'vitest'
import { buildModel } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import type { ViewState, Era } from '../src/lib/types'

const model = buildModel()
const noop = () => {}
const base: ViewState = { eras:[{start:2006,end:2026}], positions:{F:true,D:true,G:true},
  multiOnly:false, colorMode:'position', layoutMode:'timeline' }
const canvas = document.createElement('canvas')
const gv:any = new GraphView(canvas as any, model, {...base}, { onStats:noop, onHover:noop })
const ms = (f:()=>void,r=1)=>{const t=performance.now();for(let i=0;i<r;i++)f();return (performance.now()-t)/r}

function settle(eras: Era[], ticks=140) {
  gv.setState({ layoutMode:'timeline', eras: eras.map(e=>({...e})) })
  gv.sim.alpha(0.9); for (let i=0;i<ticks;i++) gv.sim.tick(); gv.sim.alpha(0).stop()
}
function bbox() {
  const vis = model.nodes.filter((n:any)=>n.vis)
  let a=1e9,b=1e9,c=-1e9,d=-1e9
  for (const n of vis){ a=Math.min(a,n.x!);b=Math.min(b,n.y!);c=Math.max(c,n.x!);d=Math.max(d,n.y!) }
  return { w:c-a, h:d-b, n:vis.length, finite: vis.every((n:any)=>Number.isFinite(n.x)&&Number.isFinite(n.y)) }
}

describe('timeline: animated settle is non-blocking + smooth (per-frame cost)', () => {
  it('setState does not block the main thread (settle runs async over frames)', () => {
    const t = ms(()=>gv.setState({ layoutMode:'timeline', eras:[{start:1915,end:2026}] }), 3)
    console.log(`  timeline setState (async): full range = ${t.toFixed(2)}ms (non-blocking)`)
    expect(t).toBeLessThan(30)
  })
  it('a single sim tick (one animation frame) stays under the 16ms frame budget, even full range', () => {
    gv.setState({ layoutMode:'timeline', eras:[{start:1915,end:2026}] })
    // MIN of several small batches, not one long average: parallel vitest workers contend for
    // cores and a contention burst poisons any single window - contention only ever ADDS time,
    // so the fastest batch is the honest per-tick cost (~6ms on an idle machine).
    let best = Infinity
    for (let b = 0; b < 8; b++) best = Math.min(best, ms(()=>gv.sim.tick(), 8))
    console.log(`  sim.tick() full range = ${best.toFixed(2)}ms/frame (budget 16ms)`)
    expect(best).toBeLessThan(16)
  })
})

describe('timeline: settled layout is finite and fills the window aspect', () => {
  const cases: [string, Era[]][] = [
    ['cap 2006-26', [{start:2006,end:2026}]],
    ['O6 1942-67', [{start:1942,end:1967}]],
    ['dynasties 1980-93', [{start:1980,end:1993}]],
    ['full 1915-26', [{start:1915,end:2026}]],
    ['disjoint O6+Cap', [{start:1942,end:1967},{start:2006,end:2026}]],
  ]
  const winAspect = 1280/720 // ~1.78 (the test viewport)
  const wide = new Set(['full 1915-26']) // the whole sweep stays wider than the window (pan-worthy), the rest fill
  for (const [name, eras] of cases) {
    it(`${name}: finite + fills / stays within a sane aspect`, () => {
      settle(eras)
      const bb = bbox()
      expect(bb.finite).toBe(true)
      const aspect = bb.w / Math.max(1, bb.h)
      console.log(`  ${name.padEnd(18)} content aspect=${aspect.toFixed(2)}  (window ${winAspect.toFixed(2)})  nodes=${bb.n}`)
      // roughly tracks the window (fills both axes); the full multi-decade sweep may run wider
      expect(aspect).toBeGreaterThan(winAspect * 0.55)
      expect(aspect).toBeLessThan(winAspect * (wide.has(name) ? 4 : 1.8))
    })
  }
})
