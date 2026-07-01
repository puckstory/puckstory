/*
 * Stories are hand-written view states (src/lib/stories.ts) - nothing checks them at authoring
 * time, so this suite guards against link rot: every story must still resolve against the LIVE
 * dataset (ids exist, eras parse, the view it opens is non-empty). A data refresh that renames
 * a player id or drops a year fails here, not silently in the dropdown.
 */
import { describe, it, expect } from 'vitest'
import { STORIES } from '../src/lib/stories'
import { parseView } from '../src/lib/urlstate'
import { shortestPath } from '../src/lib/path'
import { buildModel, inEras, ERA_PRESETS } from '../src/lib/model'

const model = buildModel()
const yearsOf = (id: string): number[] => {
  const n = model.nodeById.get(id)
  return n ? (n.type === 'cup' ? [n.year!] : (n.cups ?? []).map((c) => c.year)) : []
}

describe('curated stories resolve against the live dataset', () => {
  for (const s of STORIES) {
    it(`"${s.title}" opens a real, non-empty view`, () => {
      const v = parseView('?' + s.qs, yearsOf, (id) => model.nodeById.has(id))
      // parseView silently DROPS unknown focus ids - so every id written in the story must survive
      const wanted = (new URLSearchParams(s.qs).get('focus') ?? '').split(',').filter(Boolean)
      expect(v.ids).toEqual(wanted)
      for (const id of v.ids) expect(model.nodeById.has(id)).toBe(true)
      expect(v.state.eras.length).toBeGreaterThan(0)
      // each focused node must actually be visible inside the story's own era range
      for (const id of v.ids) {
        const n = model.nodeById.get(id)!
        const years = n.type === 'cup' ? [n.year!] : n.cups!.map((c) => c.year)
        expect(years.some((y) => inEras(y, v.state.eras)), `${id} visible in ${s.title}`).toBe(true)
      }
      // a cut story needs something selected to cut to
      if (v.cut) expect(v.ids.length).toBeGreaterThan(0)
    })
  }

  it('titles and blurbs are short enough for the dropdown', () => {
    for (const s of STORIES) {
      expect(s.title.length).toBeLessThanOrEqual(40)
      expect(s.blurb.length).toBeLessThanOrEqual(90)
    }
  })
})

describe('story eras press the pills', () => {
  it('every era in every story is a NAMED preset range - a custom span would light only From/To', () => {
    for (const s of STORIES) {
      const v = parseView('?' + s.qs, yearsOf, (id) => model.nodeById.has(id))
      for (const e of v.state.eras) {
        const preset = ERA_PRESETS.some((p) => p.start === e.start && p.end === e.end)
        expect(preset, `${s.title}: ${e.start}-${e.end} matches no era pill`).toBe(true)
      }
    }
  })
})

describe('the Handshake stays the true shortest first-to-last chain', () => {
  it('its corridor IS a shortest path from cup-1915 to the newest Cup (recompute on data refresh)', () => {
    const hs = STORIES.find((s) => s.title.includes('Handshake'))!
    const ids = new URLSearchParams(hs.qs).get('focus')!.split(',')
    const latest = 'cup-' + Math.max(...model.cups.map((c) => c.year!))
    expect(ids[0]).toBe('cup-1915')
    expect(ids[ids.length - 1]).toBe(latest)
    // every link is a real engraving, and the length matches a fresh BFS
    for (let i = 1; i < ids.length; i++) expect(model.adj.get(ids[i - 1])!.has(ids[i]), `${ids[i - 1]} -> ${ids[i]}`).toBe(true)
    const bfs = shortestPath(model.adj, ['cup-1915'], [latest])!
    expect(ids.length).toBe(bfs.length)
  })
})
