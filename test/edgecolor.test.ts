import { describe, it, expect } from 'vitest'
import { forDark, forLight } from '../src/lib/render'

/*
 * The per-theme edge folds: forLight caps luminance at 120 on the light themes, forDark lifts it
 * to a 105 floor on the dark ones. Both must hold for EVERY input format they meet in the draw
 * loop - #rrggbb team colours AND the rgb(r,g,b) dynasty blends - and forDark must reach its
 * floor even for saturated colours whose channels clip at 255 (the white-blend remainder path).
 */
const lum = (c: string): number => {
  const hx = /^#([0-9a-f]{6})$/i.exec(c)
  const rg = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(c)
  const [r, g, b] = hx
    ? [0, 2, 4].map((i) => parseInt(hx[1].slice(i, i + 2), 16))
    : [+rg![1], +rg![2], +rg![3]]
  return 0.299 * r + 0.587 * g + 0.114 * b
}

describe('forDark: dark-theme edge luminance floor (105)', () => {
  it('lifts a dark navy to the floor, preserving channel order', () => {
    const out = forDark('#1a53c1') // STL, lum ~78
    expect(lum(out)).toBeGreaterThanOrEqual(104.5)
    const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(out)!
    expect(+m[3]).toBeGreaterThan(+m[2]) // still blue-dominant
    expect(+m[2]).toBeGreaterThan(+m[1])
  })
  it('reaches the floor for saturated reds too (channel clipping is compensated toward white)', () => {
    // pure uniform scaling can NOT get these to 105 - red clips at 255 while green/blue absorb
    // nothing; the white-blend remainder must make up the difference
    for (const c of ['#d83009', '#ce1126', '#c00245', '#a51d3a']) { // CGY DET CAR NJD
      expect(lum(forDark(c)), c).toBeGreaterThanOrEqual(104.5)
    }
  })
  it('returns colours already above the floor untouched', () => {
    expect(forDark('#ffb81c')).toBe('#ffb81c') // BOS gold, lum ~187
  })
  it('accepts rgb() dynasty-blend strings', () => {
    expect(lum(forDark('rgb(20, 40, 60)'))).toBeGreaterThanOrEqual(104.5)
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
