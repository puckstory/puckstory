/*
 * history.ts - the undo/redo stack, as pure data and functions.
 *
 * App.svelte records a snapshot of the shareable view after each discrete action - simple
 * changes at its two mutation funnels (change() and the onSelection callback), composite ones
 * (stories, Six Degrees) as a single directly-recorded end state - and restores wholesale on
 * undo/redo; everything stack-shaped lives here so it is unit-testable
 * and Svelte reactivity just reassigns the returned structures. minimalPatch() computes the
 * smallest ViewState delta for a restore, so a selection-only undo never restarts the settled
 * simulation.
 */
import type { ViewState } from './types'

export interface Hist<T> { past: T[]; present: T; future: T[] }

export const init = <T>(present: T): Hist<T> => ({ past: [], present, future: [] })

/** Record a new present. Deep-equal no-ops are skipped (a re-picked selection or an idle Reset
 *  must not create a do-nothing undo step); a new action always clears the redo branch. */
export function record<T>(h: Hist<T>, next: T, cap = 100): Hist<T> {
  if (JSON.stringify(next) === JSON.stringify(h.present)) return h
  return { past: [...h.past.slice(-(cap - 1)), h.present], present: next, future: [] }
}

export const canUndo = <T>(h: Hist<T>): boolean => h.past.length > 0
export const canRedo = <T>(h: Hist<T>): boolean => h.future.length > 0

export function undo<T>(h: Hist<T>): Hist<T> | null {
  if (!h.past.length) return null
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [...h.future, h.present] }
}

export function redo<T>(h: Hist<T>): Hist<T> | null {
  if (!h.future.length) return null
  return { past: [...h.past, h.present], present: h.future[h.future.length - 1], future: h.future.slice(0, -1) }
}

/** The smallest ViewState patch turning `from` into `to`. Restores pass it to GraphView so only
 *  genuinely layout-affecting keys trigger a refilter + sim restart. */
export function minimalPatch(from: ViewState, to: ViewState): Partial<ViewState> {
  const p: Partial<ViewState> = {}
  if (JSON.stringify(from.eras) !== JSON.stringify(to.eras)) p.eras = to.eras
  if (JSON.stringify(from.positions) !== JSON.stringify(to.positions)) p.positions = to.positions
  if (from.multiOnly !== to.multiOnly) p.multiOnly = to.multiOnly
  if (from.colorMode !== to.colorMode) p.colorMode = to.colorMode
  if (from.layoutMode !== to.layoutMode) p.layoutMode = to.layoutMode
  return p
}
