import { describe, it, expect } from 'vitest'
import { DATA, buildModel, teamColor, posGroup, posFull, inEras, eraBounds, mergeEras, TEAM_COLORS, POS_COLORS, foldText } from '../src/lib/model'
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
  it('every node has a dynastyColor; split players get an rgb() blend', () => {
    expect(model.nodes.every(n=>typeof n.dynastyColor==='string' && n.dynastyColor!.length>0)).toBe(true)
    // a player whose cups span >=2 communities should be an rgb() blend
    const splitPlayer = model.nodes.find(n=>{
      if (n.type!=='player') return false
      const comms = new Set(n.cups!.map(c=>model.nodeById.get('cup-'+c.year)?.community))
      return comms.size>=2
    })
    expect(splitPlayer).toBeTruthy()
    expect(splitPlayer!.dynastyColor!.startsWith('rgb(')).toBe(true)
  })
})
