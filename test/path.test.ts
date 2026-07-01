/*
 * "Six Degrees" - the shortest-chain search (src/lib/path.ts).
 * Small hand-built graphs pin the BFS contract; the real dataset then proves the feature's
 * headline case (two icons who never shared a room still connect through the engravings).
 */
import { describe, it, expect } from 'vitest'
import { shortestPath } from '../src/lib/path'
import { buildModel } from '../src/lib/model'

// tiny undirected adjacency helper: pairs of ids become a symmetric Map<string, Set<string>>
function graph(...edges: [string, string][]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const at = (id: string) => { if (!adj.has(id)) adj.set(id, new Set()); return adj.get(id)! }
  for (const [a, b] of edges) { at(a).add(b); at(b).add(a) }
  return adj
}

describe('shortestPath (BFS over the engraving graph)', () => {
  it('direct teammates: player-cup-player, one linking Cup', () => {
    const adj = graph(['p1', 'c1'], ['p2', 'c1'])
    expect(shortestPath(adj, ['p1'], ['p2'])).toEqual(['p1', 'c1', 'p2'])
  })

  it('multi-hop: takes the fewest engravings, not the first path found', () => {
    // p1-c1-p2-c2-p3 (short) vs p1-c3-p4-c4-p5-c5-p3 (long)
    const adj = graph(
      ['p1', 'c1'], ['p2', 'c1'], ['p2', 'c2'], ['p3', 'c2'],
      ['p1', 'c3'], ['p4', 'c3'], ['p4', 'c4'], ['p5', 'c4'], ['p5', 'c5'], ['p3', 'c5'],
    )
    expect(shortestPath(adj, ['p1'], ['p3'])).toEqual(['p1', 'c1', 'p2', 'c2', 'p3'])
  })

  it('a team endpoint is a SET of cup nodes: the nearest one wins', () => {
    // team = {c1, c9}; p2 sits on c1, so the chain must use c1 and ignore distant c9
    const adj = graph(['p1', 'c1'], ['p2', 'c1'], ['p9', 'c9'])
    expect(shortestPath(adj, ['c1', 'c9'], ['p2'])).toEqual(['c1', 'p2'])
  })

  it('returns null when nothing connects the endpoints', () => {
    const adj = graph(['p1', 'c1'], ['p2', 'c2'])
    expect(shortestPath(adj, ['p1'], ['p2'])).toBeNull()
  })

  it('overlapping endpoints collapse to that single node', () => {
    const adj = graph(['p1', 'c1'])
    expect(shortestPath(adj, ['c1', 'p1'], ['p1'])).toEqual(['p1'])
  })

  it('unknown ids are ignored rather than crashing', () => {
    const adj = graph(['p1', 'c1'], ['p2', 'c1'])
    expect(shortestPath(adj, ['ghost'], ['p2'])).toBeNull()
    expect(shortestPath(adj, ['ghost', 'p1'], ['p2'])).toEqual(['p1', 'c1', 'p2'])
  })

  it('real dataset: Lemieux to Gretzky alternates player/cup and both ends hold', () => {
    const model = buildModel()
    const byName = (name: string) => model.nodes.find((n) => n.type === 'player' && n.name === name)!.id
    const mario = byName('Mario Lemieux'), wayne = byName('Wayne Gretzky')
    const path = shortestPath(model.adj, [mario], [wayne])!
    expect(path).not.toBeNull()
    expect(path[0]).toBe(mario)
    expect(path[path.length - 1]).toBe(wayne)
    expect(path.length % 2).toBe(1) // player, cup, player, ... - always odd
    for (let i = 0; i < path.length; i++) {
      const n = model.nodeById.get(path[i])!
      expect(n.type).toBe(i % 2 === 0 ? 'player' : 'cup')
      if (i > 0) expect(model.adj.get(path[i - 1])!.has(path[i])).toBe(true) // real engravings only
    }
    // the two never won together, so at least two Cups link them - and BFS keeps it tight
    expect(path.length).toBeGreaterThanOrEqual(5)
    expect(path.length).toBeLessThanOrEqual(9)
  })
})
