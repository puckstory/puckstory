import { describe, it, expect } from 'vitest'
import { TEAM_COLORS } from '../src/lib/model'
import { forDark, forLight } from '../src/lib/render'

/*
 * The palette's separation invariants, raw AND post-fold. The raw floors used to live only in a
 * model.ts comment, and the edge folds silently violated them twice (July 2026: a luma-flattening
 * forDark re-merged MTL-DET to CIEDE2000 1.75 on the default theme after the palette had pulled
 * them apart). The colour maths here (OKLab, CIEDE2000, WCAG contrast) is an INDEPENDENT
 * implementation, deliberately not imported from src, so a bug in render.ts colour code cannot
 * vouch for itself.
 */

// ---- independent colour math (sRGB -> OKLab / CIE Lab -> CIEDE2000 / WCAG) ----
const s2l = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const parse = (c: string): [number, number, number] => {
  const hx = /^#([0-9a-f]{6})$/i.exec(c)
  if (hx) return [0, 2, 4].map((i) => parseInt(hx[1].slice(i, i + 2), 16)) as [number, number, number]
  const rg = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(c)!
  return [+rg[1], +rg[2], +rg[3]]
}
function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [s2l(r), s2l(g), s2l(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
const dEok = (c1: string, c2: string): number => {
  const [a, b] = [oklab(parse(c1)), oklab(parse(c2))]
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const [lr, lg, lb] = [s2l(r), s2l(g), s2l(b)]
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const x = f((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047)
  const y = f(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb)
  const z = f((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}
function ciede2000(c1: string, c2: string): number {
  const [[L1, a1, b1], [L2, a2, b2]] = [lab(parse(c1)), lab(parse(c2))]
  const rad = Math.PI / 180, deg = 180 / Math.PI
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2)
  const h1p = C1p === 0 ? 0 : (Math.atan2(b1, a1p) * deg + 360) % 360
  const h2p = C2p === 0 ? 0 : (Math.atan2(b2, a2p) * deg + 360) % 360
  const dLp = L2 - L1, dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360 }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad)
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2
  let hbp = h1p + h2p
  if (C1p * C2p !== 0) { if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360; hbp /= 2 }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad)
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2))
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7))
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2)
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T
  const RT = -Math.sin(2 * dTheta * rad) * RC
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH))
}
const relLum = ([r, g, b]: [number, number, number]) => 0.2126 * s2l(r) + 0.7152 * s2l(g) + 0.0722 * s2l(b)
const wcag = (c1: string, c2: string): number => {
  const [a, b] = [relLum(parse(c1)), relLum(parse(c2))].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

const TEAMS = Object.keys(TEAM_COLORS)
const pairs: [string, string][] = []
for (let i = 0; i < TEAMS.length; i++) for (let j = i + 1; j < TEAMS.length; j++) pairs.push([TEAMS[i], TEAMS[j]])
const col = (ab: string) => TEAM_COLORS[ab]

// the "← official …"/"was …" members of model.ts - pairs touching these carry the 0.045 promise
const NUDGED = new Set(['PIT', 'WSH', 'STL', 'TBL', 'COL', 'FLA', 'CAR', 'EDM', 'CGY', 'NYR', 'NJD', 'CHI', 'TOR', 'TOA', 'OTS', 'VIC', 'MMR'])
// the accepted sub-floor nudged pairs (documented in the model.ts header): EDM-ANA - two oranges,
// eras 14 years apart, and the only move left re-collides EDM with PHI's official orange anchor;
// MTL-NJD - the wine was pushed off DET's red into a corner boxed in by CAR/OTS/COL, and MTL is
// an untouchable official anchor
const ACCEPTED = new Set(['EDM-ANA', 'MTL-NJD'])
// every pair that has EVER collided and been fixed - the do-not-regress list
const FIXED: [string, string][] = [
  ['CGY', 'DET'], ['CAR', 'MTL'], ['COL', 'MMR'], ['NJD', 'OTS'], ['NYI', 'TOA'], // 2026-07-07 batch
  ['FLA', 'CHI'], ['NYI', 'TOR'], ['FLA', 'PHI'], ['PHI', 'CHI'], // 2026-07-10/11 batch
]

describe('raw palette separation (the model.ts header contract)', () => {
  it('no two teams sit within OKLab 0.027 of each other (the accepted official-pair floor)', () => {
    for (const [a, b] of pairs) expect(dEok(col(a), col(b)), `${a}-${b}`).toBeGreaterThanOrEqual(0.027)
  })
  it('every pair with a nudged member clears OKLab 0.045 (nudges must never land on anyone)', () => {
    for (const [a, b] of pairs) {
      if (!NUDGED.has(a) && !NUDGED.has(b)) continue
      if (ACCEPTED.has(`${a}-${b}`) || ACCEPTED.has(`${b}-${a}`)) continue // held to the 0.027 all-pairs floor above
      expect(dEok(col(a), col(b)), `${a}-${b}`).toBeGreaterThanOrEqual(0.045)
    }
  })
  it('previously-collided pairs stay fixed', () => {
    for (const [a, b] of FIXED) expect(dEok(col(a), col(b)), `${a}-${b}`).toBeGreaterThanOrEqual(0.045)
  })
})

// Post-fold floors are CALIBRATED, not axiomatic: each sits ~15% under the minimum the current
// palette + fold actually achieve (dark min 2.93 STL-NYR, light min 2.61 PIT-BOS), so a legitimate
// one-hex-unit palette tweak that honours the raw floors above will not trip them, while a fold
// regression still fails decisively (the old luma-flattening fold bottomed out at 1.45, a hard
// L-clamp at 0.45). If a deliberate palette change lands under a floor, re-derive the calibration
// (the fold-tune harness lives in the session scratchpad / can be rebuilt from this file's maths)
// rather than just lowering the number.
describe('forDark keeps the folded palette apart AND legible (dark themes, worst case AMOLED)', () => {
  it('every folded pair stays at least CIEDE2000 2.5 apart (the old fold bottomed out at 1.45)', () => {
    for (const [a, b] of pairs)
      expect(ciede2000(forDark(col(a)), forDark(col(b))), `${a}-${b}`).toBeGreaterThanOrEqual(2.5)
  })
  it('every folded colour clears 3.4:1 on pure black (thin-edge legibility)', () => {
    for (const ab of TEAMS) expect(wcag(forDark(col(ab)), '#000000'), ab).toBeGreaterThanOrEqual(3.4)
  })
  it('the six pairs the old fold collapsed are all comfortably distinct now', () => {
    for (const [a, b, min] of [
      ['MTL', 'DET', 4.0], ['NYR', 'TOR', 6.0], ['CHI', 'OTS', 7.5],
      ['WSH', 'DET', 3.9], ['STL', 'NYR', 2.5], ['WSH', 'MTL', 4.5],
    ] as [string, string, number][])
      expect(ciede2000(forDark(col(a)), forDark(col(b))), `${a}-${b}`).toBeGreaterThanOrEqual(min)
  })
  it('two-team dynasty blends stay legible after the fold (the darkest realistic edge inputs)', () => {
    for (const [a, b] of pairs) {
      const [c1, c2] = [parse(col(a)), parse(col(b))]
      const blend = `rgb(${Math.round((c1[0] + c2[0]) / 2)},${Math.round((c1[1] + c2[1]) / 2)},${Math.round((c1[2] + c2[2]) / 2)})`
      expect(wcag(forDark(blend), '#000000'), `${a}+${b}`).toBeGreaterThanOrEqual(3.0)
    }
  })
})

describe('forLight keeps the folded palette apart AND legible (light themes, worst case Solarized Light)', () => {
  it('every folded pair stays at least CIEDE2000 2.3 apart', () => {
    for (const [a, b] of pairs)
      expect(ciede2000(forLight(col(a)), forLight(col(b))), `${a}-${b}`).toBeGreaterThanOrEqual(2.3)
  })
  it('every folded colour clears 3.0:1 on the brightest background (#fdf6e3)', () => {
    for (const ab of TEAMS) expect(wcag(forLight(col(ab)), '#fdf6e3'), ab).toBeGreaterThanOrEqual(3.0)
  })
  it('the golds the palette deliberately separated survive the fold (PIT vs BOS)', () => {
    expect(ciede2000(forLight(col('PIT')), forLight(col('BOS')))).toBeGreaterThanOrEqual(2.3)
  })
})
