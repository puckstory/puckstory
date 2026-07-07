import { describe, it, expect } from 'vitest'
import { buildModel, DATA, teamColor } from '../src/lib/model'

// Dynasty communities are PRECOMPUTED by data-pipeline/communities.mjs (seeded Louvain, baked into
// dataset.json) and still carried by every record. They no longer drive the on-screen colour -
// the "dynasty" colouring now follows each node's TEAM (a blend for multi-team players) - but the
// community ids remain part of the dataset, so these guard that they stay sane and deterministic.
describe('precomputed dynasty communities', () => {
  const d = DATA as any
  it('every champion and player record carries a community id', () => {
    expect(d.champions.every((c: any) => Number.isInteger(c.community))).toBe(true)
    expect(d.players.every((p: any) => Number.isInteger(p.community))).toBe(true)
  })
  it('the clustering is real: several communities, and none trivially singleton-sized overall', () => {
    const m = buildModel()
    expect(m.numCommunities).toBeGreaterThan(5)
    expect(m.numCommunities).toBeLessThan(200)
    // dynasties are era/franchise families - the biggest should hold many nodes
    const counts = new Map<number, number>()
    for (const n of m.nodes) counts.set(n.community, (counts.get(n.community) ?? 0) + 1)
    expect(Math.max(...counts.values())).toBeGreaterThan(50)
  })
  it('two independent builds produce identical communities and dynasty colours (blend included)', () => {
    const m1 = buildModel(), m2 = buildModel()
    expect(m2.numCommunities).toBe(m1.numCommunities)
    for (const n1 of m1.nodes) {
      const n2 = m2.nodeById.get(n1.id)!
      expect(n2.community).toBe(n1.community)
      expect(n2.dynastyColor).toBe(n1.dynastyColor)
    }
  })
  it('dynasty colour follows the TEAM, not the community: every Cup wears its own team colour', () => {
    const m = buildModel()
    for (const c of m.cups) expect(c.dynastyColor).toBe(teamColor(c.abbr))
  })
})
