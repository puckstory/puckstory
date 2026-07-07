import { describe, it, expect } from 'vitest'
import { init, record, undo, redo, canUndo, canRedo, minimalPatch } from '../src/lib/history'
import { defaultState } from '../src/lib/urlstate'

describe('history stack (pure)', () => {
  it('record advances present; undo/redo walk it; a new action clears the redo branch', () => {
    let h = init('a')
    h = record(h, 'b')
    h = record(h, 'c')
    expect(canUndo(h)).toBe(true)
    h = undo(h)!
    expect(h.present).toBe('b')
    expect(canRedo(h)).toBe(true)
    h = redo(h)!
    expect(h.present).toBe('c')
    h = undo(h)!
    h = record(h, 'd')
    expect(h.future).toEqual([]) // a new action prunes the redo branch
    expect(h.past).toEqual(['a', 'b'])
    expect(h.present).toBe('d')
  })
  it('deep-equal no-ops are skipped (re-picks and idle Resets create no steps)', () => {
    const h = init({ x: 1, y: [1, 2] })
    expect(record(h, { x: 1, y: [1, 2] })).toBe(h)
    expect(record(h, { x: 2, y: [1, 2] })).not.toBe(h)
  })
  it('undo/redo at the ends return null', () => {
    const h = init('a')
    expect(undo(h)).toBe(null)
    expect(redo(h)).toBe(null)
  })
  it('the cap bounds the past without corrupting order', () => {
    let h = init(0)
    for (let i = 1; i <= 150; i++) h = record(h, i, 100)
    expect(h.past.length).toBe(100)
    expect(h.present).toBe(150)
    expect(h.past[0]).toBe(50)
    expect(h.past[99]).toBe(149)
    let steps = 0
    while (canUndo(h)) { h = undo(h)!; steps++ }
    expect(steps).toBe(100)
    expect(h.present).toBe(50) // the oldest retained snapshot
  })
})

describe('minimalPatch (what a restore actually re-applies)', () => {
  it('identical states produce an empty patch - a selection-only undo stays sim-cold', () => {
    expect(minimalPatch(defaultState(), defaultState())).toEqual({})
  })
  it('every changed ViewState key is included, unchanged ones are not', () => {
    const a = defaultState()
    const b = defaultState()
    b.eras = [{ start: 1980, end: 1993 }]
    b.positions = { F: true, D: false, G: true }
    b.multiOnly = true
    b.colorMode = 'position' // dynasty is the default, so position is the changed value here
    b.layoutMode = 'timeline'
    const p = minimalPatch(a, b)
    expect(Object.keys(p).sort()).toEqual(['colorMode', 'eras', 'layoutMode', 'multiOnly', 'positions'])
    expect(p.eras).toEqual(b.eras)
    expect(minimalPatch(b, b)).toEqual({})
  })
})
