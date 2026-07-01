/*
 * Functional tests for the player-name label placement in render.draw() - the collision /
 * viewport policy, not the pixels. A proxy canvas context records fillText calls (names land
 * via strokeText halo + fillText fill) and answers measureText with a deterministic width, so
 * each case can assert WHICH names were drawn and WHERE.
 */
import { describe, it, expect } from 'vitest'
import { draw, type DrawState } from '../src/lib/render'
import type { GNode, GLink } from '../src/lib/types'

type TextCall = { text: string; x: number; y: number }
type XY = { x: number; y: number }

// Every method the painter touches becomes a recorded no-op; only measureText and fillText
// carry behaviour. Property assignments (fillStyle, font, ...) are accepted and ignored.
// An optional `moves` array also records moveTo - each edge segment starts with one, so
// counting them counts the edges a pass actually drew.
function mockCtx(calls: TextCall[], moves?: XY[]): CanvasRenderingContext2D {
  const target: Record<string, unknown> = {
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: (t: string, x: number, y: number) => calls.push({ text: t, x, y }),
  }
  if (moves) target.moveTo = (x: number, y: number) => moves.push({ x, y })
  return new Proxy(target, {
    get(o, k: string) {
      if (!(k in o)) o[k] = () => {}
      return o[k]
    },
    set(o, k: string, v) { o[k] = v; return true },
  }) as unknown as CanvasRenderingContext2D
}

function player(id: string, name: string, x: number, y: number, over: Partial<GNode> = {}): GNode {
  return {
    id, type: 'player', name, x, y, r: 5, vis: true,
    rangeCupCount: 1, cupCount: 1, community: 0, group: 'F', position: 'C', cups: [],
    ...over,
  } as GNode
}

// identity camera over an 800x600 stage; no focus unless a test overrides
function state(nodes: GNode[], over: Partial<DrawState> = {}): DrawState {
  return {
    nodes, links: [],
    tx: 0, ty: 0, k: 1, W: 800, H: 600, dpr: 1,
    hoverSet: null, focusIds: new Set(), focusT: 0,
    colorMode: 'position', communityColor: () => '#888',
    bg: '#000', edgeRgb: '255,255,255', edgeAlpha: 0.18,
    nameFill: '#fff', nameHalo: '#000', hlEdge: '255,215,0',
    ...over,
  }
}

const names = (calls: TextCall[]) => calls.map((c) => c.text)

describe('label placement (render.draw)', () => {
  it('the idle graph draws NO names - labels appear only through hover or selection', () => {
    const calls: TextCall[] = []
    draw(mockCtx(calls), state([player('a', 'Wayne Gretzky', 400, 300), player('b', 'Mark Messier', 200, 150)]))
    expect(names(calls)).toEqual([])
  })

  it('a hovered network labels its members; nodes outside it stay unlabelled', () => {
    const calls: TextCall[] = []
    const nodes = [player('a', 'Wayne Gretzky', 400, 300), player('b', 'Mark Messier', 200, 150)]
    draw(mockCtx(calls), state(nodes, { hoverSet: new Set(['a']), focusT: 1 }))
    expect(names(calls)).toEqual(['Wayne Gretzky'])
  })

  it('prefers the above-anchor, falling to below when a neighbour blocks it', () => {
    const calls: TextCall[] = []
    const a = player('a', 'Wayne Gretzky', 400, 300)
    // a fat node sitting exactly where a's above-label would go
    const blockerAbove = player('x', 'Blocker', 400, 280, { r: 14 })
    draw(mockCtx(calls), state([a, blockerAbove], { hoverSet: new Set(['a']), focusT: 1 }))
    const g = calls.find((c) => c.text === 'Wayne Gretzky')!
    expect(g).toBeTruthy()
    expect(g.y).toBeGreaterThan(300) // pushed to the below-anchor
  })

  it('drops a non-forced name when every anchor is blocked', () => {
    const calls: TextCall[] = []
    const a = player('a', 'Wayne Gretzky', 400, 300)
    // box the label in on all four sides with oversized neighbours
    const walls = [
      player('n', 'N', 400, 278, { r: 16 }), player('s', 'S', 400, 322, { r: 16 }),
      player('e', 'E', 452, 300, { r: 30 }), player('w', 'W', 348, 300, { r: 30 }),
    ]
    draw(mockCtx(calls), state([a, ...walls], { hoverSet: new Set(['a']), focusT: 1 }))
    expect(names(calls)).not.toContain('Wayne Gretzky')
  })

  it('a selected (forced) name is drawn even when every anchor is blocked', () => {
    const calls: TextCall[] = []
    const a = player('a', 'Wayne Gretzky', 400, 300)
    const walls = [
      player('n', 'N', 400, 278, { r: 16 }), player('s', 'S', 400, 322, { r: 16 }),
      player('e', 'E', 452, 300, { r: 30 }), player('w', 'W', 348, 300, { r: 30 }),
    ]
    draw(mockCtx(calls), state([a, ...walls],
      { hoverSet: new Set(['a']), focusT: 1, focusIds: new Set(['a']) }))
    expect(names(calls)).toContain('Wayne Gretzky')
  })

  it('rejects anchors that would leave the viewport (no half-clipped names at the edge)', () => {
    const calls: TextCall[] = []
    // near the top edge: the preferred above-anchor sits at y<0, so below must win
    const a = player('a', 'Wayne Gretzky', 400, 8)
    draw(mockCtx(calls), state([a], { hoverSet: new Set(['a']), focusT: 1 }))
    const g = calls.find((c) => c.text === 'Wayne Gretzky')!
    expect(g).toBeTruthy()
    expect(g.y).toBeGreaterThan(8)
  })

  it('clamps a forced name fully on-screen when its node sits at the viewport corner', () => {
    const calls: TextCall[] = []
    const a = player('a', 'Wayne Gretzky', 2, 2)
    draw(mockCtx(calls), state([a], { hoverSet: new Set(['a']), focusT: 1, focusIds: new Set(['a']) }))
    const g = calls.find((c) => c.text === 'Wayne Gretzky')!
    expect(g).toBeTruthy()
    const w = 'Wayne Gretzky'.length * 6
    expect(g.x - w / 2).toBeGreaterThanOrEqual(0) // left edge of the box inside the viewport
    expect(g.y).toBeGreaterThanOrEqual(0)
  })

  it('a cup labels itself inside the glyph (abbr + year) and never gets an external name', () => {
    const calls: TextCall[] = []
    const cup = { id: 'cup-1984', type: 'cup', name: 'Edmonton Oilers', team: 'Edmonton Oilers',
      abbr: 'EDM', year: 1984, x: 400, y: 300, r: 14, vis: true, rangeCupCount: 4, community: 0 } as GNode
    // even hovered AND selected (which forces player names through), the candidate loop skips cups
    draw(mockCtx(calls), state([cup],
      { hoverSet: new Set(['cup-1984']), focusT: 1, focusIds: new Set(['cup-1984']) }))
    expect(names(calls)).toEqual(['EDM', '1984'])
  })

  it('two crowded names do not overlap: the second yields to another anchor', () => {
    const calls: TextCall[] = []
    // stacked so both "above" boxes would collide; both are in the hovered network
    const a = player('a', 'Wayne Gretzky', 400, 300, { rangeCupCount: 4 })
    const b = player('b', 'Mark Messier', 406, 302)
    draw(mockCtx(calls), state([a, b], { hoverSet: new Set(['a', 'b']), focusT: 1 }))
    const got = calls.filter((c) => c.text === 'Wayne Gretzky' || c.text === 'Mark Messier')
    expect(got).toHaveLength(2)
    const [p, q] = got
    // centre distance beats the sum of half-heights or half-widths → boxes are disjoint
    const apart = Math.abs(p.x - q.x) > (p.text.length + q.text.length) * 3 + 10 ||
      Math.abs(p.y - q.y) > 12 + 8
    expect(apart).toBe(true)
  })
})

describe('edge passes (render.draw)', () => {
  it('the base pass culls a link with both endpoints far off-screen; the highlight pass draws it anyway', () => {
    const a = player('a', 'Alice', -500, -500)
    const b = player('b', 'Bob', -600, -600)
    const link = { source: a, target: b } as GLink
    // base pass, no hover: both endpoints beyond the 40px pad → the segment is skipped
    const baseMoves: XY[] = []
    draw(mockCtx([], baseMoves), state([a, b], { links: [link] }))
    expect(baseMoves).toHaveLength(0)
    // control: one endpoint on-screen → the base pass draws it (the recorder really works)
    const c = player('c', 'Carol', 400, 300)
    const ctrlMoves: XY[] = []
    draw(mockCtx([], ctrlMoves), state([c, b], { links: [{ source: c, target: b } as GLink] }))
    expect(ctrlMoves).toHaveLength(1)
    // highlight pass: the hovered network's edges draw unconditionally, so a connector whose
    // line crosses the view (endpoints just outside) is never dropped
    const hlMoves: XY[] = []
    draw(mockCtx([], hlMoves), state([a, b], { links: [link], hoverSet: new Set(['a', 'b']), focusT: 1 }))
    expect(hlMoves).toHaveLength(1)
  })
})
