import { describe, it, expect } from 'vitest'
import { forDark, forLight } from '../src/lib/render'

/*
 * The per-theme edge folds' BEHAVIOURAL contract: forLight caps luminance at 120 on the light
 * themes (plain RGB scale); forDark lifts dark colours into a legible band on the dark ones,
 * navigating in OKLCh (hue held, chroma gamut-fitted, lightness soft-clamped toward L 0.62).
 * Both must hold for EVERY input format they meet in the draw loop - #rrggbb team colours AND
 * the rgb(r,g,b) dynasty blends. The palette-wide separation + contrast floors these folds are
 * calibrated against live in test/palette.test.ts.
 */
const parse = (c: string): [number, number, number] => {
  const hx = /^#([0-9a-f]{6})$/i.exec(c)
  if (hx) return [0, 2, 4].map((i) => parseInt(hx[1].slice(i, i + 2), 16)) as [number, number, number]
  const rg = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(c)!
  return [+rg[1], +rg[2], +rg[3]]
}
const lum = (c: string): number => { const [r, g, b] = parse(c); return 0.299 * r + 0.587 * g + 0.114 * b }
const s2l = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
const contrastOnBlack = (c: string): number => {
  const [r, g, b] = parse(c)
  return (0.2126 * s2l(r) + 0.7152 * s2l(g) + 0.0722 * s2l(b) + 0.05) / 0.05
}

describe('forDark: dark-theme edge lift (OKLCh, toward L 0.62)', () => {
  it('lifts a dark navy into the legible band, preserving hue (still blue-dominant)', () => {
    const out = forDark('#1a53c1') // STL, OKLab L ~0.48
    expect(contrastOnBlack(out)).toBeGreaterThanOrEqual(3.4)
    const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(out)!
    expect(+m[3]).toBeGreaterThan(+m[2]) // still blue-dominant
    expect(+m[2]).toBeGreaterThan(+m[1])
  })
  it('lifts the saturated reds without bleaching them white (hue held, chroma gamut-fitted)', () => {
    for (const c of ['#d83009', '#ce1126', '#c00245', '#a51d3a']) { // CGY DET CAR NJD
      const out = forDark(c)
      expect(contrastOnBlack(out), c).toBeGreaterThanOrEqual(3.4)
      const [r, g, b] = parse(out)
      expect(r, c).toBeGreaterThan(g) // still red-dominant, not washed toward grey/white
      expect(r - Math.max(g, b), c).toBeGreaterThan(40)
    }
  })
  it('returns colours already above the floor untouched', () => {
    expect(forDark('#ffb81c')).toBe('#ffb81c') // BOS gold, OKLab L ~0.83
  })
  it('SOFT-clamps: two below-floor inputs keep a lightness difference (the old fold flattened all to one luma)', () => {
    // the discriminator between this algorithm and the RGB luma-lift it replaced: the old fold
    // normalized STL and DET both to luma 105 +/- 1; the soft-clamp keeps Q of the deficit, so
    // their folded lumas must still differ meaningfully
    expect(Math.abs(lum(forDark('#ce1126')) - lum(forDark('#1a53c1')))).toBeGreaterThan(3)
  })
  it('accepts rgb() dynasty-blend strings and lifts them', () => {
    const input = 'rgb(74, 57, 118)' // an STL+VML-ish blend, well under the floor
    const out = forDark(input)
    expect(out).not.toBe(input)
    expect(contrastOnBlack(out)).toBeGreaterThan(contrastOnBlack(input))
    expect(contrastOnBlack(out)).toBeGreaterThanOrEqual(3.0)
  })
  it('passes unknown formats through untouched', () => {
    expect(forDark('hsl(20 50% 40%)')).toBe('hsl(20 50% 40%)')
  })
  it('is deterministic (memoised): identical input, identical output', () => {
    expect(forDark('#1a53c1')).toBe(forDark('#1a53c1'))
  })
})

describe('forLight: light-theme edge luminance ceiling (120)', () => {
  it('folds a bright gold down to the ceiling', () => {
    expect(lum(forLight('#ffb81c'))).toBeLessThanOrEqual(120.5) // BOS
  })
  it('returns colours already below the ceiling untouched', () => {
    expect(forLight('#1a53c1')).toBe('#1a53c1') // STL, lum ~78
  })
})
