import { describe, it, expect } from 'vitest'
import { buildModel } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import type { ViewState } from '../src/lib/types'

const base: ViewState = { eras:[{start:2006,end:2026}], positions:{F:true,D:true,G:true},
  multiOnly:false, colorMode:'position', layoutMode:'network' }
const model = buildModel()

describe('harness smoke', () => {
  it('builds model with expected counts', () => {
    expect(model.nodes.length).toBe(model.cups.length + 1306)
    expect(model.cups.length).toBe(110)
  })
  it('constructs GraphView (network) and emits stats without throwing', () => {
    const canvas = document.createElement('canvas')
    let stats: any = null
    const gv = new GraphView(canvas as any, model, { ...base }, { onStats: s => stats = s, onHover: noop })
    expect(stats).toBeTruthy()
    expect(stats.players).toBeGreaterThan(0)
    expect(Number.isFinite((gv as any).transform.k)).toBe(true)
    gv.destroy()
  })
  it('switches to timeline (animated settle) and settles to finite positions', () => {
    const canvas = document.createElement('canvas')
    let stats: any = null
    const gv = new GraphView(canvas as any, model, { ...base }, { onStats: s => stats = s, onHover: noop })
    gv.setState({ layoutMode: 'timeline' })
    const sim:any=(gv as any).sim; sim.alpha(0.9); for(let i=0;i<60;i++) sim.tick(); sim.alpha(0).stop()
    const vis = (model.nodes as any[]).filter(n => n.vis)
    expect(vis.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
    expect(Number.isFinite((gv as any).transform.k)).toBe(true)
    gv.destroy()
  })
})
const noop = () => {}
