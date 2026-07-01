import { describe, it, expect } from 'vitest'
import { buildModel } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import type { ViewState, Era } from '../src/lib/types'

const noop = () => {}
const ms = (f:()=>void, reps=1) => { const t=performance.now(); for(let i=0;i<reps;i++) f(); return (performance.now()-t)/reps }
const base: ViewState = { eras:[{start:2006,end:2026}], positions:{F:true,D:true,G:true},
  multiOnly:false, colorMode:'position', layoutMode:'network' }

describe('performance (logged; soft thresholds)', () => {
  it('buildModel (graph construction + dynasty blend; communities precomputed by the pipeline)', () => {
    const t = ms(()=>buildModel())
    console.log(`  buildModel: ${t.toFixed(1)}ms`)
    expect(t).toBeLessThan(1500)
  })

  const model = buildModel()
  const canvas = document.createElement('canvas')
  const gv = new GraphView(canvas as any, model, {...base}, { onStats:noop, onHover:noop })

  it('network applyFilters (setState) - typical + full range', () => {
    const cap = ms(()=>gv.setState({ layoutMode:'network', eras:[{start:2006,end:2026}] }), 5)
    const full = ms(()=>gv.setState({ layoutMode:'network', eras:[{start:1915,end:2026}] }), 5)
    console.log(`  network setState: cap=${cap.toFixed(1)}ms  full=${full.toFixed(1)}ms`)
    expect(full).toBeLessThan(200)
  })


  it('render() JS cost (cull + label placement; excludes real canvas raster)', () => {
    gv.setState({ layoutMode:'network', eras:[{start:1915,end:2026}], colorMode:'dynasty' })
    const r = ms(()=>gv.render(), 20)
    console.log(`  render() JS: ${r.toFixed(2)}ms (full range, dynasty)`)
    expect(r).toBeLessThan(60)
  })

  it('fit() cost', () => {
    const f = ms(()=>gv.fit(), 50)
    console.log(`  fit(): ${f.toFixed(2)}ms`)
    expect(f).toBeLessThan(20)
  })
})
