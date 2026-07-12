import { describe, it, expect } from 'vitest'
import { buildModel } from '../src/lib/model'
import { GraphView } from '../src/lib/graphview'
import { solve } from '../src/lib/solve'
import type { ViewState } from '../src/lib/types'

/*
 * The territory contract: no player should read as part of a franchise he never won with.
 * Two layers of defence:
 *   1. WHOLE-SET census (below): the combined effect of sector seeding + the four territory
 *      forces on the REAL GraphView at full range, both force-driven layouts. Baselines for
 *      scale: before this machinery the full graph settled with ~450 players nearer a foreign
 *      cup than their own (~130 at less than HALF the distance). Observed post-recipe ranges
 *      over many runs (Math.random seeds): network mis 57-165 / deep 3-26, hybrid mis 35-103 /
 *      deep 6-27 - thresholds sit above that noise but far below the old failure mode.
 *   2. PER-FORCE canaries (bottom): the census alone cannot see a single dead force while the
 *      others compensate (each solo ablation still clears the census thresholds - verified by
 *      mutation testing), so every force body is also invoked DIRECTLY with a constructed
 *      scenario, and the structural pieces (anchors, chains, collide pad) are asserted exactly.
 */
const model = buildModel()
const noop = () => {}
const base: ViewState = { eras: [{ start: 1915, end: 2026 }], positions: { F: true, D: true, G: true },
  multiOnly: false, colorMode: 'position', layoutMode: 'network' }
const canvas = document.createElement('canvas')
const gv: any = new GraphView(canvas as any, model, { ...base }, { onStats: noop, onHover: noop })

function settle(layoutMode: 'network' | 'hybrid' | 'timeline', ticks = 220) {
  gv.setState({ layoutMode, eras: [{ start: 1915, end: 2026 }] })
  gv.sim.alpha(0.9)
  for (let i = 0; i < ticks; i++) gv.sim.tick()
  gv.sim.alpha(0).stop()
}

/** misplacement census over the settled positions: own = nearest cup he won, foreign = nearest
 *  cup of a franchise he NEVER won with (career-wide, same rule the forces use) */
function census() {
  const cups = model.nodes.filter((n: any) => n.vis && n.type === 'cup')
  let mis = 0, deep = 0, players = 0
  for (const n of model.nodes as any[]) {
    if (!n.vis || n.type !== 'player') continue
    players++
    const mine = new Set(n.cups.map((c: any) => c.year))
    const franchises = new Set(n.cups.map((c: any) => c.abbr))
    let own = Infinity, foreign = Infinity
    for (const c of cups as any[]) {
      const d = Math.hypot(n.x - c.x, n.y - c.y)
      if (mine.has(c.year)) own = Math.min(own, d)
      else if (!franchises.has(c.abbr)) foreign = Math.min(foreign, d)
    }
    if (foreign < own) mis++
    if (foreign < own / 2) deep++
  }
  return { mis, deep, players }
}

describe('territory: players settle with their own franchise, not inside foreign clusters', () => {
  for (const mode of ['network', 'hybrid'] as const) {
    it(`${mode}: full range settles with few misplaced players and almost no deep intruders`, () => {
      settle(mode)
      const { mis, deep, players } = census()
      console.log(`  ${mode}: ${mis}/${players} nearer a foreign cup (deep ${deep})`)
      expect(players).toBeGreaterThan(1200) // full range really is on screen
      expect(mis).toBeLessThan(220)         // was ~450 before the territory work
      expect(deep).toBeLessThan(60)         // was ~130
    })
  }

  it('hybrid: the top-to-bottom time gradient survives the cohesion chains AND repeated re-settles', () => {
    // twice on purpose: the second settle relaxes from already-settled positions (no grid
    // re-seed), which is where the gradient used to drift before the cups got their soft
    // y-anchor - one settle alone cannot catch that regression
    settle('hybrid')
    settle('hybrid')
    const cups = model.nodes.filter((n: any) => n.vis && n.type === 'cup') as any[]
    const my = cups.reduce((s, c) => s + c.year, 0) / cups.length
    const mp = cups.reduce((s, c) => s + c.y, 0) / cups.length
    let num = 0, dy = 0, dp = 0
    for (const c of cups) { num += (c.year - my) * (c.y - mp); dy += (c.year - my) ** 2; dp += (c.y - mp) ** 2 }
    const corr = num / Math.sqrt(dy * dp)
    console.log(`  hybrid yearCorr = ${corr.toFixed(3)}`)
    // observed 0.944-0.953 with the 2x-wide grid (fewer rows = slightly noisier than the old
    // 0.97); the floor asserts "time still reads top-to-bottom" - outright DELETION of the
    // anchors is caught deterministically by the structural canary below, not by this number
    expect(corr).toBeGreaterThan(0.92)
  })

  it('timeline: the territory machinery stands down (grid pins are the layout)', () => {
    settle('timeline', 60)
    expect(gv.clusterFx).toBe('off')
    expect((gv.sim.force('cohesion') as any).links().length).toBe(0)
  })

  it('hybrid: the settled blob spreads to the window aspect instead of a narrow column', () => {
    settle('hybrid')
    const vis = model.nodes.filter((n: any) => n.vis) as any[]
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
    for (const n of vis) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y) }
    const asp = (x1 - x0) / (y1 - y0)
    console.log(`  hybrid settled content aspect = ${asp.toFixed(2)} (window aspect here ~1.9)`)
    // the 2x-widened seed grid + cup column anchors + pitch-scaled cohesion distance hold the
    // settled blob near the window's shape; before them it collapsed to ~0.85 (a tall oval
    // wasting half a wide window)
    expect(asp).toBeGreaterThan(1.2)
  })

  it('network/hybrid ticks stay inside the frame budget with all territory forces live', () => {
    settle('hybrid', 30) // warm, forces initialized, alpha still hot
    gv.sim.alpha(0.4)
    let best = Infinity
    for (let b = 0; b < 8; b++) {
      const t = performance.now()
      for (let i = 0; i < 8; i++) gv.sim.tick()
      best = Math.min(best, (performance.now() - t) / 8)
    }
    console.log(`  hybrid sim.tick() with territory forces = ${best.toFixed(2)}ms/frame (budget 16ms)`)
    expect(best).toBeLessThan(16)
  })
})

describe('pre-solver: the worker path must produce the same quality layout as the live settle', () => {
  it('solve() on the real payload lands a full-range hybrid within the same census thresholds', () => {
    // arrange the exact state applyFilters builds, then run the solver the worker runs -
    // this exercises buildSolveInput + solve end-to-end minus only the Worker transport
    gv.setState({ layoutMode: 'hybrid', eras: [{ start: 1915, end: 2026 }] })
    const active = model.nodes.filter((n: any) => n.vis)
    const links = model.links.filter((l: any) => l.source.vis && l.target.vis)
    const input = (gv as any).buildSolveInput(active, links, false, true, true, 1.9)
    const t0 = performance.now()
    const res = solve(input)
    const ms = performance.now() - t0
    // census on the SOLVED positions
    const pos = new Map<string, [number, number]>()
    active.forEach((n: any, i: number) => pos.set(n.id, [res.x[i], res.y[i]]))
    const cups = active.filter((n: any) => n.type === 'cup')
    let mis = 0, deep = 0
    for (const n of active as any[]) {
      if (n.type !== 'player') continue
      const [px, py] = pos.get(n.id)!
      const mine = new Set(n.cups.map((c: any) => c.year))
      const franchises = new Set(n.cups.map((c: any) => c.abbr))
      let own = Infinity, foreign = Infinity
      for (const c of cups as any[]) {
        const [cx, cy] = pos.get(c.id)!
        const d = Math.hypot(px - cx, py - cy)
        if (mine.has(c.year)) own = Math.min(own, d)
        else if (!franchises.has(c.abbr)) foreign = Math.min(foreign, d)
      }
      if (foreign < own) mis++
      if (foreign < own / 2) deep++
    }
    console.log(`  solver census: mis ${mis}, deep ${deep} | solve took ${ms.toFixed(0)}ms`)
    expect(mis).toBeLessThan(220)
    expect(deep).toBeLessThan(60)
    expect(res.x.every((v) => Number.isFinite(v))).toBe(true)
    expect(ms).toBeLessThan(3000) // worker-side budget; the UI never blocks on this
  })
})

describe('territory: per-force canaries (a dead force must fail SOMETHING, not hide behind the set)', () => {
  // real cups to anchor the constructed scenarios (positions come from the settled hybrid)
  const cupA = () => model.nodeById.get('cup-1956') as any // MTL
  const cupB = () => model.nodeById.get('cup-1957') as any // MTL
  const foreignCup = () => model.nodeById.get('cup-2010') as any // CHI - never MTL
  const mkPlayer = (cups: { year: number; abbr: string }[], x: number, y: number): any =>
    ({ id: 'pl-canary', type: 'player', cups, x, y, vx: 0, vy: 0, r: 6, vis: true, rangeCupCount: cups.length })
  const reinit = () => gv.sim.nodes(gv.sim.nodes()) // re-bind every force to the real node set

  it('structural: hybrid cups carry grid anchors, chains exist, pads are 5', () => {
    settle('hybrid', 40)
    const anchored = model.cups.filter((c: any) => c.vis && (c._ty !== 0 || c._tx !== 0)).length
    expect(anchored).toBeGreaterThan(100) // the _tx/_ty anchor pass ran (deleting it -> 0)
    expect((gv.sim.force('cohesion') as any).links().length).toBeGreaterThan(40) // chains built
    const player = model.nodes.find((n: any) => n.type === 'player' && n.vis) as any
    expect((gv.sim.force('collide') as any).radius()(player)).toBe(player.r + 5)
    // hybrid cohesion rest length scales with the grid pitch (fixed 80 was the width-killer)
    expect((gv.sim.force('cohesion') as any).distance()({})).toBeGreaterThan(100)
  })

  it('foreign repulsion pushes a player planted on a foreign cup away from it', () => {
    settle('hybrid', 40)
    const f = foreignCup(), force = gv.sim.force('foreign') as any
    const p = mkPlayer([{ year: 1956, abbr: 'MTL' }, { year: 1957, abbr: 'MTL' }], f.x + 20, f.y)
    force.initialize([p, f, cupA(), cupB()])
    const d0 = Math.hypot(p.x - f.x, p.y - f.y)
    gv.clusterFx = 'hyb'
    for (let i = 0; i < 12; i++) { force(0.3); p.x += p.vx; p.y += p.vy; p.vx = 0; p.vy = 0 }
    const d1 = Math.hypot(p.x - f.x, p.y - f.y)
    expect(d1).toBeGreaterThan(d0 + 30) // pushed out, not parked
    reinit()
  })

  it('own-pull reels a multi-cup player toward his nearest own cup', () => {
    settle('hybrid', 40)
    const a = cupA(), force = gv.sim.force('ownpull') as any
    const p = mkPlayer([{ year: 1956, abbr: 'MTL' }, { year: 1957, abbr: 'MTL' }], a.x + 600, a.y + 600)
    force.initialize([p, a, cupB()])
    const d0 = Math.hypot(p.x - a.x, p.y - a.y)
    for (let i = 0; i < 12; i++) { force(0.3); p.x += p.vx; p.y += p.vy; p.vx = 0; p.vy = 0 }
    const near = Math.min(Math.hypot(p.x - a.x, p.y - a.y), Math.hypot(p.x - cupB().x, p.y - cupB().y))
    expect(near).toBeLessThan(d0 - 100) // moved decisively toward his own camp
    reinit()
  })

  it('the anneal glides an at-risk straggler home once the settle has converged', () => {
    settle('hybrid', 40)
    const a = cupA(), f = foreignCup(), force = gv.sim.force('anneal') as any
    const p = mkPlayer([{ year: 1956, abbr: 'MTL' }], f.x + 15, f.y) // parked on a foreign cup
    force.initialize([p, a, f])
    gv.sim.alpha(0.04) // below the 0.05 engage threshold
    const d0 = Math.hypot(p.x - a.x, p.y - a.y)
    for (let i = 0; i < 30; i++) { force(0.04); p.x += p.vx; p.y += p.vy; p.vx = 0; p.vy = 0 }
    expect(Math.hypot(p.x - a.x, p.y - a.y)).toBeLessThan(d0 - 40) // gliding toward his own cup
    reinit()
  })

  it('sector seeding starts single-cup players on the away side of their cup', () => {
    ;(gv as any).seedRing()
    let away = 0, singles = 0
    for (const n of model.nodes as any[]) {
      if (n.type !== 'player' || n.cups.length !== 1) continue
      singles++
      const cup = model.nodeById.get('cup-' + n.cups[0].year) as any
      // nearest foreign cup to this player's cup, in the ring geometry just seeded
      let best = Infinity, fx = 0, fy = 0
      for (const c of model.cups as any[]) {
        if (c.abbr === cup.abbr) continue
        const d = (c.x - cup.x) ** 2 + (c.y - cup.y) ** 2
        if (d < best) { best = d; fx = c.x; fy = c.y }
      }
      // away side = the player-offset points opposite the foreign direction (positive dot with -foreign)
      if ((n.x - cup.x) * (cup.x - fx) + (n.y - cup.y) * (cup.y - fy) > 0) away++
    }
    // the cone is pi/2 wide pointed dead-away, so essentially every single is on the away side;
    // a uniform ring seed puts only ~half there
    expect(away / singles).toBeGreaterThan(0.8)
    gv.setState({ layoutMode: 'hybrid' }) // leave the shared gv in a sane mode
  })
})
