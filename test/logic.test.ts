import { describe, it, expect } from 'vitest'
import { DATA, buildModel, teamColor, teamRgb, posGroup, posFull, inEras, eraBounds, mergeEras, TEAM_COLORS, POS_COLORS, foldText } from '../src/lib/model'
import { cupSvgPath, connSmytheSvgPath, CAPTAIN_C_PATH, nodeColor } from '../src/lib/render'
import type { Era } from '../src/lib/types'

const model = buildModel()

describe('search accent-folding (a plain query matches accented names, e.g. jagr → Jágr)', () => {
  it('foldText lower-cases and strips diacritics', () => {
    expect(foldText('Jaromír Jágr')).toBe('jaromir jagr')
    expect(foldText('Jean Béliveau')).toBe('jean beliveau')
    expect(foldText('Zdeno Chára')).toBe('zdeno chara')
  })
  it('every accented player name folds to a pure-ASCII key that its plain last name matches', () => {
    const accented = model.nodes.filter((n: any) => n.type === 'player' && /[^\x00-\x7F]/.test(n.name || ''))
    expect(accented.length).toBeGreaterThan(0) // the dataset really contains accented names
    for (const n of accented) {
      const key = foldText(n.name!)
      expect(/[^\x00-\x7F]/.test(key)).toBe(false)                 // key is de-accented ASCII
      expect(key.includes(foldText(n.name!.split(' ').pop()!))).toBe(true) // plain last name matches
    }
  })
})

describe('era helpers', () => {
  it('inEras', () => {
    expect(inEras(2010, [{start:2006,end:2026}])).toBe(true)
    expect(inEras(2005, [{start:2006,end:2026}])).toBe(false)
    expect(inEras(1950, [{start:1942,end:1967},{start:2006,end:2026}])).toBe(true)
    expect(inEras(1980, [])).toBe(false)
  })
  it('eraBounds', () => {
    expect(eraBounds([{start:1942,end:1967},{start:2006,end:2026}])).toEqual([1942,2026])
    expect(eraBounds([])).toEqual([DATA.window.startYear, DATA.window.endYear])
  })
  it('mergeEras coalesces touching/overlapping and sorts', () => {
    const m = (e:Era[]) => mergeEras(e).map(x=>[x.start,x.end])
    expect(m([])).toEqual([])
    expect(m([{start:1942,end:1967},{start:1968,end:1979}])).toEqual([[1942,1979]]) // touching (+1)
    expect(m([{start:1942,end:1967},{start:2006,end:2026}])).toEqual([[1942,1967],[2006,2026]]) // disjoint
    expect(m([{start:1942,end:1970},{start:1960,end:1980}])).toEqual([[1942,1980]]) // overlap
    expect(m([{start:2006,end:2026},{start:1942,end:1967}])).toEqual([[1942,1967],[2006,2026]]) // unsorted
  })
})

describe('data integrity', () => {
  it('every champion carries a series result: champion-first, decided, ties only where real', () => {
    // guards the ETL: a yearly re-run that drops or flips `series` must go red here
    for (const c of DATA.champions) {
      expect(c.series, `${c.year} missing series`).toMatch(/^[2-4]\u2013[0-3](\u2013[1-9])?$/)
      const [cw, rw] = c.series!.split('\u2013').map(Number)
      expect(cw, `${c.year} champion must win more games`).toBeGreaterThan(rw)
    }
    expect(DATA.champions.find((c) => c.year === 2025)!.series).toBe('4\u20132')
    expect(DATA.champions.find((c) => c.year === 1927)!.series).toBe('2\u20130\u20132') // the tie-era Final
    expect(DATA.champions.filter((c) => /\u2013\d+\u2013/.test(c.series!)).length).toBe(1) // 1927 alone
  })
  const d = DATA as any
  it('headline counts + sum invariant', () => {
    expect(d.champions.length).toBe(110)
    expect(d.players.length).toBe(1306)
    const sumCup = d.players.reduce((a:number,p:any)=>a+p.cupCount,0)
    const sumPC = d.champions.reduce((a:number,c:any)=>a+c.playerCount,0)
    expect(sumCup).toBe(2307); expect(sumPC).toBe(2307)
    expect(d.stats.totalEngravings).toBe(2307)
  })
  it('no duplicate player ids; 1919 & 2005 absent', () => {
    const ids = new Set(d.players.map((p:any)=>p.id)); expect(ids.size).toBe(d.players.length)
    const yrs = d.champions.map((c:any)=>c.year)
    expect(yrs.includes(1919)).toBe(false); expect(yrs.includes(2005)).toBe(false)
  })
  it('every team abbr has a real color (no grey fallback)', () => {
    const abbrs = new Set<string>()
    d.champions.forEach((c:any)=>abbrs.add(c.abbr))
    d.players.forEach((p:any)=>p.cups.forEach((c:any)=>abbrs.add(c.abbr)))
    const missing = [...abbrs].filter(a=>!(a in TEAM_COLORS))
    expect(missing).toEqual([])
  })
  it('TEAM_COLORS carries no dead keys (every entry is worn by some champion)', () => {
    const abbrs = new Set<string>()
    d.champions.forEach((c:any)=>abbrs.add(c.abbr))
    d.players.forEach((p:any)=>p.cups.forEach((c:any)=>abbrs.add(c.abbr)))
    expect(Object.keys(TEAM_COLORS).filter((k) => !abbrs.has(k))).toEqual([])
  })
  // The palette's contract (model.ts): official primaries, nudged the minimum needed so no two
  // teams read as the same colour. The palette comments INVITE reverting nudged entries to their
  // official values - several of which are exact duplicates of a kept anchor (CAR's and NJD's
  // official #ce1126 IS Detroit's colour) - so distinctness must be pinned here or one
  // well-meaning revert silently merges two franchises in dynasty mode.
  it('no two team colours read the same: pairwise OKLab dE ≥ 0.045 (documented official-texture pairs ≥ 0.025)', () => {
    const oklab = (hex: string): [number, number, number] => {
      const v = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      const [r, g, b] = v
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
      return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
    }
    const de = (a: string, b: string) => {
      const [x, y] = [oklab(a), oklab(b)]
      return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
    }
    // close-but-distinct pairs of ALL-OFFICIAL values the palette accepts (see model.ts header)
    const TEXTURE = new Set(['MTL|NJD', 'DAL|TSP', 'NYI|TOR', 'FLA|PHI', 'ANA|EDM', 'CHI|FLA', 'CHI|PHI'])
    const keys = Object.keys(TEAM_COLORS)
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const pair = [keys[i], keys[j]].sort().join('|')
      const dist = de(TEAM_COLORS[keys[i]], TEAM_COLORS[keys[j]])
      expect(dist, `${pair} dE=${dist.toFixed(3)}`).toBeGreaterThanOrEqual(TEXTURE.has(pair) ? 0.025 : 0.045)
    }
  })
  it('every position maps to a known group and a non-raw full name', () => {
    const pos = new Set(d.players.map((p:any)=>p.position))
    for (const p of pos) { expect(['F','D','G']).toContain(posGroup(p)); expect(posFull(p).length).toBeGreaterThan(0) }
  })
  it('Wayne Hicks bracket fixed; Ovechkin 2018 Conn Smythe flagged', () => {
    expect(d.players.some((p:any)=>p.name==='[Wayne Hicks')).toBe(false)
    expect(d.players.some((p:any)=>p.name==='Wayne Hicks')).toBe(true)
    const ov = d.players.find((p:any)=>p.id==='alexanderovechkin')
    expect(ov.cups.find((c:any)=>c.year===2018).connSmythe).toBe(true)
  })
  it('every player cup entry points at a real champion of that year, with the matching team', () => {
    const byYear = new Map(d.champions.map((c: any) => [c.year, c]))
    const bad = d.players.flatMap((p: any) =>
      p.cups.filter((c: any) => byYear.get(c.year)?.abbr !== c.abbr).map((c: any) => `${p.id}:${c.year}`))
    expect(bad).toEqual([])
  })
  it("each champion's playerCount equals the players engraved that year", () => {
    const counts = new Map<number, number>()
    d.players.forEach((p: any) => p.cups.forEach((c: any) => counts.set(c.year, (counts.get(c.year) ?? 0) + 1)))
    const bad = d.champions.filter((c: any) => counts.get(c.year) !== c.playerCount).map((c: any) => c.year)
    expect(bad).toEqual([])
  })
  it('the dataset window is exactly the min/max champion years', () => {
    const yrs = d.champions.map((c: any) => c.year)
    expect(d.window.startYear).toBe(Math.min(...yrs))
    expect(d.window.endYear).toBe(Math.max(...yrs))
  })
  it('Conn Smythe names: on-roster winners match a node; only off-roster losers do not', () => {
    const nodeNames = new Set(d.players.map((p:any)=>p.name))
    const unmatched = d.champions.filter((c:any)=>c.connSmythe && !nodeNames.has(c.connSmythe)).map((c:any)=>c.year)
    // 1966 Crozier, 1987 Hextall, 2024 McDavid (never won a Cup) - losing-team winners with no node
    expect(unmatched.sort()).toEqual([1966,1987,2024])
    // no champion >=1965 has a null Conn Smythe
    expect(d.champions.filter((c:any)=>c.year>=1965 && !c.connSmythe).length).toBe(0)
  })
})

// deep-link parsing (parseEras / initState / stateToQuery) is tested against the REAL shipped
// functions in test/urlstate.test.ts - the replica that used to live here could drift from source.

describe('icon path generators', () => {
  const valid = (d:string) => {
    expect(d.startsWith('M')).toBe(true); expect(d.endsWith('Z')).toBe(true)
    const nums = d.match(/-?\d*\.?\d+/g)!.map(Number)
    expect(nums.every(Number.isFinite)).toBe(true)
    expect(nums.length).toBeGreaterThan(20)
  }
  it('cup, conn smythe, captain-C paths are valid closed paths', () => {
    valid(cupSvgPath()); valid(connSmytheSvgPath()); valid(CAPTAIN_C_PATH)
  })
})

describe('coloring', () => {
  it('teamColor known vs fallback', () => {
    expect(teamColor('EDM')).toBe(TEAM_COLORS.EDM)
    expect(teamColor('ZZZ')).toBe('#8895ad')
  })
  it('nodeColor position mode = team/pos colors; dynasty mode = per-node dynastyColor', () => {
    const cup = model.nodes.find(n=>n.type==='cup')!
    const pl = model.nodes.find(n=>n.type==='player')!
    expect(nodeColor(cup,'position',model.communityColor)).toBe(teamColor(cup.abbr))
    expect(nodeColor(pl,'position',model.communityColor)).toBe(POS_COLORS[pl.group!])
    expect(nodeColor(pl,'dynasty',model.communityColor)).toBe(pl.dynastyColor)
  })
  it('dynasty colour = team: every node has one; a Cup and a one-team player wear the team colour', () => {
    expect(model.nodes.every(n=>typeof n.dynastyColor==='string' && n.dynastyColor!.length>0)).toBe(true)
    const cup = model.nodes.find(n=>n.type==='cup' && n.abbr==='MTL')!
    expect(cup.dynastyColor).toBe(teamColor('MTL'))
    // Henri Richard won all 11 of his Cups with Montreal -> a solid MTL colour (rgb of one team)
    const henri = model.nodes.find(n=>n.name==='Henri Richard')!
    const [r,g,b] = teamRgb('MTL')
    expect(henri.dynastyColor).toBe(`rgb(${r},${g},${b})`)
  })
  it('a player who won with two different teams gets a proportional rgb() blend of the two', () => {
    const split = model.nodes.find(n=>n.type==='player' && new Set(n.cups!.map(c=>c.abbr)).size===2)!
    expect(split).toBeTruthy()
    expect(split.dynastyColor!.startsWith('rgb(')).toBe(true)
    // a blend of two DISTINCT team colours is strictly between them - never identical to either
    for (const ab of new Set(split.cups!.map(c=>c.abbr))) {
      const [r,g,b] = teamRgb(ab)
      expect(split.dynastyColor).not.toBe(`rgb(${r},${g},${b})`)
    }
  })
})
