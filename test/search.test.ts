import { describe, it, expect } from 'vitest'
import { buildModel, searchKey } from '../src/lib/model'
import { buildSearchIndex, filterSearch } from '../src/lib/search'
import { defaultState } from '../src/lib/urlstate'
import type { ViewState, Era } from '../src/lib/types'

// These exercise the REAL shipped search code (src/lib/search.ts) - the index App.svelte builds
// and the exact filter TopBar's dropdown runs - not a re-implementation.

const model = buildModel()
const ITEMS = buildSearchIndex(model)
const st = (eras: Era[], patch: Partial<ViewState> = {}): ViewState => ({ ...defaultState(), eras, ...patch })
const full: Era[] = [{ start: 1915, end: 2026 }]

describe('searchKey folding (accent + punctuation + spaces)', () => {
  it('strips diacritics, punctuation, and spaces', () => {
    expect(searchKey('Jaromír Jágr')).toBe('jaromirjagr')
    expect(searchKey("K'Andre Miller")).toBe('kandremiller')
    expect(searchKey('J. C. Tremblay')).toBe('jctremblay')
    expect(searchKey('Devante Smith-Pelly')).toBe('devantesmithpelly')
  })
  it('every player name folds to a key with no uppercase, spaces, or punctuation', () => {
    for (const n of model.nodes) {
      if (n.type !== 'player') continue
      expect(/[A-Z\s.'’-]/.test(searchKey(n.name!))).toBe(false)
    }
  })
})

describe('punctuated names are findable by the queries people actually type', () => {
  it.each([
    ['kandre', "K'Andre"],
    ['oconnor', "O'Connor"],
    ['jc tremblay', 'J. C. Tremblay'],
    ['smith pelly', 'Smith-Pelly'],
    ['st laurent', 'St. Laurent'],
  ])('"%s" finds %s', (q, expected) => {
    expect(filterSearch(ITEMS, q, st(full)).some((i) => i.label.includes(expected))).toBe(true)
  })
  it('plain ASCII still matches accented names', () => {
    expect(filterSearch(ITEMS, 'jagr', st(full)).some((i) => i.label.includes('Jágr'))).toBe(true)
    expect(filterSearch(ITEMS, 'beliveau', st(full)).some((i) => i.label.includes('Béliveau'))).toBe(true)
  })
})

describe('everything is searchable; matches the view hides carry a why/when note', () => {
  it('era: an out-of-era match surfaces GREYED with the years they DID win, instead of vanishing', () => {
    const r = filterSearch(ITEMS, 'gretzky', st([{ start: 2006, end: 2026 }]))
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].hiddenNote).toMatch(/1984, 1985, 1987, 1988/)
    expect(r[0].hiddenNote).toMatch(/Not in the selected era/)
    expect(filterSearch(ITEMS, 'gretzky', st([{ start: 1980, end: 1993 }]))[0].hiddenNote).toBeNull()
  })
  it('long team histories note a year RANGE, not two dozen years', () => {
    const r = filterSearch(ITEMS, 'canadiens', st([{ start: 2006, end: 2026 }]))
    const mtl = r.find((i) => i.kind === 'team')!
    expect(mtl.hiddenNote).toMatch(/won 1916–1993/)
  })
  it('position pills: a goalie greys out with the responsible filter named', () => {
    const s = st(full); s.positions = { F: true, D: true, G: false }
    const roy = filterSearch(ITEMS, 'patrick roy', s).find((i) => i.kind === 'player')!
    expect(roy.hiddenNote).toMatch(/goaltenders/)
    s.positions = { F: true, D: true, G: true }
    expect(filterSearch(ITEMS, 'patrick roy', s).find((i) => i.kind === 'player')!.hiddenNote).toBeNull()
  })
  it('2+ filter: a single-Cup (in range) player greys out with the 2+ filter named', () => {
    // Gretzky won all 4 Cups 1984-1990; in a range covering only 1984 he is single-Cup
    const s1 = st([{ start: 1984, end: 1984 }], { multiOnly: true })
    expect(filterSearch(ITEMS, 'gretzky', s1).find((i) => i.kind === 'player')!.hiddenNote).toMatch(/2\+/)
    const s2 = st([{ start: 1984, end: 1990 }], { multiOnly: true })
    expect(filterSearch(ITEMS, 'gretzky', s2).find((i) => i.kind === 'player')!.hiddenNote).toBeNull()
  })
  it('teams are unaffected by position/2+ filters (their Cups stay visible)', () => {
    const s = st([{ start: 1980, end: 1993 }], { multiOnly: true })
    s.positions = { F: false, D: false, G: false }
    const oil = filterSearch(ITEMS, 'oilers', s).find((i) => i.kind === 'team')
    expect(oil).toBeTruthy()
    expect(oil!.hiddenNote).toBeNull()
    expect(oil!.ids.length).toBeGreaterThan(1)
    expect(oil!.ids.every((id) => model.nodeById.get(id)?.type === 'cup')).toBe(true)
  })
  it('selectable matches sort before hidden ones', () => {
    const seq = filterSearch(ITEMS, 'a', st([{ start: 2006, end: 2026 }])).map((i) => !!i.hiddenNote)
    expect(seq).toEqual([...seq].sort((x, y) => Number(x) - Number(y)))
  })
})

describe('dropdown mechanics', () => {
  it('a picked player resolves to real node id(s)', () => {
    const r = filterSearch(ITEMS, 'gretzky', st(full))
    expect(r[0].kind).toBe('player')
    expect(r[0].ids.every((id) => model.nodeById.has(id))).toBe(true)
  })
  it('results are capped at 8; empty/whitespace queries yield nothing', () => {
    expect(filterSearch(ITEMS, 'a', st(full)).length).toBeLessThanOrEqual(8)
    expect(filterSearch(ITEMS, '   ', st(full)).length).toBe(0)
  })
  it('prefix matches sort before mid-name matches', () => {
    // "guy" prefixes Guy Lafleur/Lapointe/... but is buried mid-key in Alex Tanguay
    const r = filterSearch(ITEMS, 'guy', st(full))
    expect(r.some((i) => !i.key.startsWith('guy'))).toBe(true) // a mid-name match is present...
    expect(r[0].key.startsWith('guy')).toBe(true)              // ...but a prefix match leads
  })
})

describe('the omit parameter (an armed Six Degrees endpoint)', () => {
  it('excludes BEFORE the result cap, so the list backfills to the full limit', () => {
    const s = st([{ start: 1915, end: 2026 }])
    const all = filterSearch(ITEMS, 'ma', s, 8)
    expect(all).toHaveLength(8)
    const withOmit = filterSearch(ITEMS, 'ma', s, 8, all[0])
    expect(withOmit).toHaveLength(8) // a different 8th item backfills - not a 7-row list
    expect(withOmit.some((r) => r.label === all[0].label)).toBe(false)
  })
})
