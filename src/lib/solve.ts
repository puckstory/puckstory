/*
 * solve.ts - the headless layout solver.
 *
 * Runs the EXACT physics GraphView's live simulation runs - same forces, same tuning, same decay
 * schedule - but off-screen and flat-out, so the final resting layout is known before a single
 * frame is drawn. GraphView pre-solves every view change in a worker (solve.worker.ts) and then
 * plays ONE designed tween from the current view to the solved final: the animation the user sees
 * is a smooth interpolation throughout, not live physics with its decaying tail.
 *
 * Everything model-shaped is precomputed by GraphView and arrives as flat arrays (per-node charge,
 * anchors and collide radii; per-link strengths; per-player own/foreign cup index lists), so this
 * module holds NO model logic. What it does own are the per-tick TERRITORY constants below -
 * GraphView's live forces import them from here, so the live simulation (drag re-heats, playback)
 * and the pre-solve can never drift apart.
 */
import { forceSimulation, forceManyBody, forceLink, forceCollide, forceX, forceY } from 'd3-force'

// ---- shared territory tuning (single source of truth; see graphview.ts makeXxxForce) ----
export const FOREIGN_TUNE = {
  net: { strength: 21, radius: 340, gate: 0.45, linear: false },
  hyb: { strength: 24, radius: 400, gate: 1, linear: true },
} as const
export const OWNPULL_CSTR = 0.5
export const ANNEAL = { TH: 0.12, K: 4, RISK: 1.5, FADE_FROM: 0.05, FLOOR: 0.02, RESNAP: 15 } as const
// the settle's decay schedule (applyFilters/onTick mirror these)
export const decayFor = (big: boolean) => 1 - Math.pow(0.001, 1 / (big ? 170 : 300))
export const FAST_TAIL = { below: 0.02, decay: 0.11 } as const

export interface SolveInput {
  gen: number // filter generation - stale results are dropped by the caller
  x: Float64Array; y: Float64Array
  r: Float64Array           // node radius (for link rest lengths)
  rcol: Float64Array        // collide radius (cup glyph extent / pill + pad, precomputed)
  charge: Float64Array      // per-node charge strength (negative)
  tx: Float64Array; ty: Float64Array   // anchor targets
  fxs: Float64Array; fys: Float64Array // per-node anchor strengths
  linkS: Uint32Array; linkT: Uint32Array; linkK: Float64Array // player-cup springs + strengths
  chainS: Uint32Array; chainT: Uint32Array // franchise cohesion pairs
  chainDist: number; chainK: number
  // per-player territory lists (node indices); own = visible cups he won, foreign = visible cups
  // of franchises he never won with. Cup nodes appear in NO list.
  pIdx: Uint32Array; pOwnOff: Uint32Array; pOwn: Uint32Array; pForeignOff: Uint32Array; pForeign: Uint32Array
  mode: 'net' | 'hyb' | 'off' // territory regime ('off' = timeline: pins only)
  big: boolean
}

export interface SolveResult { gen: number; x: Float64Array; y: Float64Array }

type SNode = { index: number; x: number; y: number; vx: number; vy: number }

export function solve(inp: SolveInput): SolveResult {
  const n = inp.x.length
  const nodes: SNode[] = new Array(n)
  for (let i = 0; i < n; i++) nodes[i] = { index: i, x: inp.x[i], y: inp.y[i], vx: 0, vy: 0 }
  const links = Array.from({ length: inp.linkS.length }, (_, i) => ({ source: inp.linkS[i], target: inp.linkT[i] }))
  const chains = Array.from({ length: inp.chainS.length }, (_, i) => ({ source: inp.chainS[i], target: inp.chainT[i] }))

  // per-player slices (own/foreign cup node lists), unpacked once
  const players: { node: SNode; own: SNode[]; foreign: SNode[] }[] = []
  for (let p = 0; p < inp.pIdx.length; p++) {
    const own: SNode[] = [], foreign: SNode[] = []
    for (let k = inp.pOwnOff[p]; k < inp.pOwnOff[p + 1]; k++) own.push(nodes[inp.pOwn[k]])
    for (let k = inp.pForeignOff[p]; k < inp.pForeignOff[p + 1]; k++) foreign.push(nodes[inp.pForeign[k]])
    players.push({ node: nodes[inp.pIdx[p]], own, foreign })
  }

  const sim = forceSimulation(nodes as any)
    .force('charge', forceManyBody().strength(((d: SNode) => inp.charge[d.index]) as any).distanceMax(850).theta(0.85))
    .force('link', forceLink(links as any)
      .distance(((l: any) => inp.r[l.source.index] + inp.r[l.target.index] + 52) as any)
      .strength(((l: any, i: number) => inp.linkK[i]) as any))
    .force('collide', forceCollide(((d: SNode) => inp.rcol[d.index]) as any).strength(0.95).iterations(inp.big ? 2 : 3))
    .force('x', forceX(((d: SNode) => inp.tx[d.index]) as any).strength(((d: SNode) => inp.fxs[d.index]) as any))
    .force('y', forceY(((d: SNode) => inp.ty[d.index]) as any).strength(((d: SNode) => inp.fys[d.index]) as any))
    .stop()
  if (chains.length) sim.force('cohesion', forceLink(chains as any).distance(inp.chainDist).strength(inp.chainK))

  // the territory trio - same formulas as GraphView's live forces, same constants (shared above)
  if (inp.mode !== 'off') {
    const { strength, radius: R, gate, linear } = FOREIGN_TUNE[inp.mode]
    sim.force('foreign', ((alpha: number) => {
      if (alpha >= gate) return
      for (const { node: nd, foreign } of players) {
        for (const c of foreign) {
          const dx = nd.x - c.x
          if (dx > R || dx < -R) continue
          const dy = nd.y - c.y
          if (dy > R || dy < -R) continue
          const d2 = dx * dx + dy * dy
          if (d2 >= R * R || d2 < 1e-4) continue
          const d = Math.sqrt(d2)
          const w = linear ? 1 - d / R : Math.min(3, R / d - 1) / 3
          const k = (strength * w * alpha) / d
          nd.vx += dx * k; nd.vy += dy * k
        }
      }
    }) as any)
    sim.force('ownpull', ((alpha: number) => {
      const k = OWNPULL_CSTR * alpha
      for (const { node: nd, own } of players) {
        if (own.length < 2) continue
        let best = Infinity, bx = 0, by = 0
        for (const c of own) { const d = (nd.x - c.x) ** 2 + (nd.y - c.y) ** 2; if (d < best) { best = d; bx = c.x; by = c.y } }
        nd.vx += (bx - nd.x) * k; nd.vy += (by - nd.y) * k
      }
    }) as any)
    let targets: { node: SNode; own: SNode[] }[] | null = null
    let sinceSnap = 0
    sim.force('anneal', ((alpha: number) => {
      if (alpha > ANNEAL.TH) { targets = null; return }
      if (targets && ++sinceSnap >= ANNEAL.RESNAP) targets = null
      if (!targets) {
        targets = []; sinceSnap = 0
        for (const { node: nd, own, foreign } of players) {
          if (!own.length) continue
          let od = Infinity, fd = Infinity
          for (const c of own) od = Math.min(od, (nd.x - c.x) ** 2 + (nd.y - c.y) ** 2)
          for (const c of foreign) fd = Math.min(fd, (nd.x - c.x) ** 2 + (nd.y - c.y) ** 2)
          if (Math.sqrt(fd) < Math.sqrt(od) * ANNEAL.RISK) targets.push({ node: nd, own })
        }
      }
      const kEff = ANNEAL.K * Math.min(1, Math.max(0, alpha - ANNEAL.FLOOR) / (ANNEAL.FADE_FROM - ANNEAL.FLOOR))
      if (!kEff) return
      for (const { node: nd, own } of targets) {
        let best = Infinity, bc = own[0]
        for (const c of own) { const d = (nd.x - c.x) ** 2 + (nd.y - c.y) ** 2; if (d < best) { best = d; bc = c } }
        const d = Math.sqrt(best) || 1
        nd.vx += ((bc.x - nd.x) / d) * kEff; nd.vy += ((bc.y - nd.y) / d) * kEff
      }
    }) as any)
  }

  // the live settle's schedule, run flat-out: designed decay to the fast-tail threshold, then the
  // steepened tail to a fully-parked 0.005 (the tween needs the true resting state)
  const base = decayFor(inp.big)
  sim.alphaDecay(base).alpha(0.7)
  let guard = 0
  while (sim.alpha() > 0.005 && guard++ < 500) {
    sim.alphaDecay(sim.alpha() < FAST_TAIL.below ? FAST_TAIL.decay : base)
    sim.tick()
  }

  const x = new Float64Array(n), y = new Float64Array(n)
  for (let i = 0; i < n; i++) { x[i] = nodes[i].x; y[i] = nodes[i].y }
  return { gen: inp.gen, x, y }
}
