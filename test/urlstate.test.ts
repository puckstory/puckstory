import { describe, it, expect } from 'vitest'
import { initState, defaultState, parseEras, stateToQuery, parseView, viewToQuery } from '../src/lib/urlstate'
import { buildModel, DATA } from '../src/lib/model'

// These exercise the REAL deep-link functions the app ships (src/lib/urlstate.ts) - they used to
// be tested only through copy-pasted replicas that could drift from the source.

const model = buildModel()
const yearsOf = (id: string): number[] => {
  const n = model.nodeById.get(id)
  return n ? (n.type === 'cup' ? [n.year!] : (n.cups ?? []).map((c) => c.year)) : []
}
const Y0 = DATA.window.startYear, Y1 = DATA.window.endYear

describe('parseEras', () => {
  it('parses multi-range with comma + dash', () => {
    expect(parseEras('1942-1967,1980-1993')).toEqual([{ start: 1942, end: 1967 }, { start: 1980, end: 1993 }])
  })
  it('clamps out-of-range and orders min/max', () => {
    expect(parseEras('1990-1850')).toEqual([{ start: Y0, end: 1990 }])
    expect(parseEras('2100-2200')).toEqual([{ start: Y1, end: Y1 }])
  })
  it('drops malformed parts instead of producing NaN eras', () => {
    expect(parseEras('abc,1980-banana,1942-1967')).toEqual([{ start: 1942, end: 1967 }])
    expect(parseEras('')).toEqual([])
  })
})

describe('initState', () => {
  it('no params → the default cap-era state', () => {
    expect(initState('', yearsOf)).toEqual(defaultState())
  })
  it('?eras= wins over ?from/?to', () => {
    const s = initState('?eras=1942-1967&from=1980&to=1993', yearsOf)
    expect(s.eras).toEqual([{ start: 1942, end: 1967 }])
  })
  it('non-numeric ?from/?to keeps the default era (no NaN blank screen)', () => {
    expect(initState('?from=abc&to=2000', yearsOf).eras).toEqual(defaultState().eras)
    expect(initState('?from=1980&to=xyz', yearsOf).eras).toEqual(defaultState().eras)
  })
  it('?from/?to are ordered and clamped', () => {
    expect(initState('?from=1993&to=1980', yearsOf).eras).toEqual([{ start: 1980, end: 1993 }])
    expect(initState('?from=1850&to=2200', yearsOf).eras).toEqual([{ start: Y0, end: Y1 }])
  })
  it('color / layout / multi / pos params apply; junk values are ignored', () => {
    const s = initState('?color=dynasty&layout=timeline&multi=1&pos=FG', yearsOf)
    expect(s.colorMode).toBe('dynasty'); expect(s.layoutMode).toBe('timeline'); expect(s.multiOnly).toBe(true)
    expect(s.positions).toEqual({ F: true, D: false, G: true })
    const junk = initState('?color=purple&layout=spiral&pos=XYZ', yearsOf)
    expect(junk).toEqual(defaultState())
  })
  it('?focus= on a KNOWN historic player widens the era to their career span', () => {
    const henri = model.nodes.find((n) => n.type === 'player' && n.name === 'Henri Richard')!
    const ys = henri.cups!.map((c) => c.year)
    const s = initState(`?focus=${henri.id}`, yearsOf)
    expect(s.eras).toEqual([{ start: Math.min(...ys), end: Math.max(...ys) }])
    expect(s.eras[0].start).toBeLessThan(2006) // would be hidden under the default cap era
  })
  it('?focus= on an UNKNOWN id changes nothing (the app must also not select it)', () => {
    expect(initState('?focus=pl-wanyegretzky', yearsOf)).toEqual(defaultState())
  })
  it('an explicit era beats the focus-derived one', () => {
    const s = initState('?focus=cup-1984&eras=2006-2026', yearsOf)
    expect(s.eras).toEqual([{ start: 2006, end: 2026 }])
  })
  it('?focus= with MULTIPLE ids (a shared selection) widens to their combined span', () => {
    const s = initState('?focus=cup-1984,cup-2016', yearsOf)
    expect(s.eras).toEqual([{ start: 1984, end: 2016 }])
  })
  it('unknown ids in a multi-focus list contribute nothing', () => {
    const s = initState('?focus=cup-1984,banana', yearsOf)
    expect(s.eras).toEqual([{ start: 1984, end: 1984 }])
  })
})

describe('stateToQuery (the write side of deep links)', () => {
  it('the default state serialises to an empty query', () => {
    expect(stateToQuery(defaultState())).toBe('')
  })
  it('every non-default field round-trips through initState', () => {
    const s = defaultState()
    s.eras = [{ start: 1942, end: 1967 }, { start: 1980, end: 1993 }]
    s.colorMode = 'dynasty'; s.layoutMode = 'timeline'; s.multiOnly = true
    s.positions = { F: true, D: false, G: true }
    const q = stateToQuery(s)
    expect(initState('?' + q, yearsOf)).toEqual(s)
  })
  it('single custom ranges round-trip too', () => {
    const s = defaultState()
    s.eras = [{ start: 1980, end: 1993 }]
    expect(initState('?' + stateToQuery(s), yearsOf).eras).toEqual(s.eras)
  })
  it('all positions OFF round-trips (the empty pos= value survives)', () => {
    // pos='' is a real value, not an omission - dropping it would silently turn every group back on
    const s = defaultState()
    s.positions = { F: false, D: false, G: false }
    const q = stateToQuery(s)
    expect(q).toContain('pos=')
    expect(initState('?' + q, yearsOf).positions).toEqual({ F: false, D: false, G: false })
  })
})

describe('parseView / viewToQuery (the whole shareable view, both directions)', () => {
  const hasNode = (id: string) => model.nodeById.has(id)
  it('a selection made at the DEFAULT era round-trips: ?eras= is pinned so focus-widening cannot narrow it', () => {
    // the bug: ?focus=cup-2024,cup-2025 with no eras param loaded as a 2024-2025 view
    const v = { state: defaultState(), ids: ['cup-2024', 'cup-2025'], cut: false, chain: false }
    const qs = viewToQuery(v)
    expect(qs).toMatch(/eras=2006-2026/)
    const back = parseView('?' + qs, yearsOf, hasNode)
    expect(back.state.eras).toEqual(defaultState().eras) // NOT [{2024,2025}]
    expect(back.ids).toEqual(v.ids)
  })
  it('cut views round-trip whole', () => {
    const v = { state: defaultState(), ids: ['cup-2025'], cut: true, chain: false }
    const back = parseView('?' + viewToQuery(v), yearsOf, hasNode)
    expect(back).toEqual(v)
  })
  it('a Six Degrees chain round-trips whole (and chain cannot ride without a selection)', () => {
    const v = { state: defaultState(), ids: ['pl-mariolemieux', 'cup-1991', 'pl-paulcoffey'], cut: false, chain: true }
    const qs = viewToQuery(v)
    expect(qs).toMatch(/chain=1/)
    expect(parseView('?' + qs, yearsOf, hasNode)).toEqual(v)
    expect(parseView('?chain=1', yearsOf, hasNode).chain).toBe(false) // no focus, no chain
  })
  it('the "No era selected" state is shareable via eras=none', () => {
    const s = defaultState(); s.eras = []
    const qs = viewToQuery({ state: s, ids: [], cut: false, chain: false })
    expect(qs).toBe('eras=none')
    expect(parseView('?' + qs, yearsOf, hasNode).state.eras).toEqual([])
  })
  it('hand-typed ?focus= without eras still widens (the deep-link affordance survives)', () => {
    const back = parseView('?focus=cup-1984', yearsOf, hasNode)
    expect(back.state.eras).toEqual([{ start: 1984, end: 1984 }])
  })
  it('unknown focus ids are dropped and cut cannot ride without a selection', () => {
    const back = parseView('?focus=banana&cut=1', yearsOf, hasNode)
    expect(back.ids).toEqual([])
    expect(back.cut).toBe(false)
  })
})
