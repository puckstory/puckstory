/*
 * urlstate.ts - the URL ⇄ view-state mapping.
 *
 * One place owns both directions of the deep-link story: parseView() reads the query params
 * (?eras=, ?from=/?to=, ?color=, ?layout=, ?multi=, ?pos=, ?focus=, ?cut=, ?chain=) into the full
 * shareable view - filters, selection, and cut (initState/stateToQuery handle the filter half) -
 * and viewToQuery() serialises it back to one standard query string (omitting defaults, so the
 * address bar stays clean at the default view). App.svelte keeps the address bar in sync via
 * history.replaceState on every change, which makes every view shareable.
 */
import type { Era, ViewState } from './types'
import { DATA } from './model'

const Y0 = DATA.window.startYear
const Y1 = DATA.window.endYear

export const clampYear = (y: number) => Math.max(Y0, Math.min(Y1, y))

export function defaultState(): ViewState {
  return {
    eras: [{ start: Math.max(Y0, 2006), end: Y1 }], // default: cap era
    positions: { F: true, D: true, G: true }, multiOnly: false,
    colorMode: 'dynasty', layoutMode: 'network',
  }
}

/** "1942-1967,1980-1993" → eras. Clamps to the dataset window, orders min/max, and drops
 *  malformed parts (a NaN era would otherwise blank the screen). */
export function parseEras(s: string): Era[] {
  const out: Era[] = []
  for (const part of s.split(',')) {
    const m = part.split('-').map((x) => parseInt(x, 10))
    if (m.length === 2 && Number.isFinite(m[0]) && Number.isFinite(m[1]))
      out.push({ start: clampYear(Math.min(m[0], m[1])), end: clampYear(Math.max(m[0], m[1])) })
  }
  return out
}

/** The era that makes a ?focus= node visible: the span of the given years (a cup's single year,
 *  or a player's full Cup career). Null when the node is unknown - the caller must then ignore
 *  the focus entirely rather than load a fully-dimmed graph. */
export function focusEra(years: number[]): Era | null {
  if (!years.length) return null
  return { start: Math.min(...years), end: Math.max(...years) }
}

/** Build the initial view state from a location.search string. `yearsOf` resolves a ?focus= node
 *  id to the years that must be visible ([] for an unknown id). */
export function initState(search: string, yearsOf: (id: string) => number[]): ViewState {
  const s = defaultState()
  const q = new URLSearchParams(search)
  const eras = q.get('eras')
  const from = q.get('from'), to = q.get('to')
  if (eras === 'none') s.eras = [] // the shareable "No era selected" state
  else if (eras) { const e = parseEras(eras); if (e.length) s.eras = e }
  else if (from || to) {
    const a = +(from || Y0), b = +(to || Y1) // || (not ??) so an EMPTY ?from=/?to= falls back to the window edge, not +('')===0
    // guard against non-numeric ?from=/?to= (would otherwise yield a {NaN,NaN} era → blank screen)
    if (Number.isFinite(a) && Number.isFinite(b))
      s.eras = [{ start: clampYear(Math.min(a, b)), end: clampYear(Math.max(a, b)) }]
  }
  const c = q.get('color'); if (c === 'position' || c === 'dynasty') s.colorMode = c
  const l = q.get('layout'); if (l === 'network' || l === 'hybrid' || l === 'timeline') s.layoutMode = l
  if (q.get('multi') === '1') s.multiOnly = true
  const pos = q.get('pos')
  if (pos !== null && /^[FDG]{0,3}$/.test(pos))
    s.positions = { F: pos.includes('F'), D: pos.includes('D'), G: pos.includes('G') }
  // ?focus=<id>[,<id>...] with no explicit era → widen the era to the focused nodes' combined
  // span so they're actually visible (otherwise the default cap era hides historic nodes and the
  // focus would be a silent no-op). Unknown ids contribute nothing. App-written URLs ALWAYS
  // carry ?eras= alongside a focus (see viewToQuery), so this branch only fires for hand-typed
  // links - it must never narrow a shared view.
  const focus = q.get('focus')
  if (focus && !eras && !from && !to) {
    const e = focusEra(focus.split(',').flatMap((id) => yearsOf(id)))
    if (e) s.eras = [e]
  }
  return s
}

/** Serialise the URL-addressable parts of a view state, omitting values still at their default.
 *  forceEras keeps ?eras= even at the default: any URL that carries ?focus= must pin its era,
 *  or initState's focus-widening would rewrite the recipient's view. eras=[] ("No era selected")
 *  round-trips as the explicit token `none`. */
export function stateToQuery(s: ViewState, forceEras = false): string {
  const q = new URLSearchParams()
  const d = defaultState()
  const key = (e: Era[]) => e.map((x) => `${x.start}-${x.end}`).join(',')
  if (!s.eras.length) q.set('eras', 'none')
  else if (forceEras || key(s.eras) !== key(d.eras)) q.set('eras', key(s.eras))
  if (s.colorMode !== d.colorMode) q.set('color', s.colorMode)
  if (s.layoutMode !== d.layoutMode) q.set('layout', s.layoutMode)
  if (s.multiOnly) q.set('multi', '1')
  const pos = (['F', 'D', 'G'] as const).filter((g) => s.positions[g]).join('')
  if (pos !== 'FDG') q.set('pos', pos)
  return q.toString()
}

/** The full shareable view: filters + selection + cut + chain (a Six Degrees selection whose
 *  highlight shows exactly its own nodes, not their networks). parseView/viewToQuery are the
 *  ONE owning pair for the URL in both directions - App must not assemble params by hand. */
export interface ViewSnapshot { state: ViewState; ids: string[]; cut: boolean; chain: boolean }

export function parseView(search: string, yearsOf: (id: string) => number[], hasNode: (id: string) => boolean): ViewSnapshot {
  const state = initState(search, yearsOf)
  const q = new URLSearchParams(search)
  const ids = (q.get('focus') ?? '').split(',').filter((id) => id && hasNode(id))
  const cut = q.get('cut') === '1' && ids.length > 0
  const chain = q.get('chain') === '1' && ids.length > 0
  return { state, ids, cut, chain }
}

export function viewToQuery(v: ViewSnapshot): string {
  // an era param must ride along with any focus - otherwise the recipient's initState would
  // "widen" (i.e. REPLACE) the era to the focus span and silently change the shared view
  const parts = [stateToQuery(v.state, v.ids.length > 0)]
  if (v.ids.length) parts.push('focus=' + v.ids.map(encodeURIComponent).join(','))
  if (v.cut && v.ids.length) parts.push('cut=1')
  if (v.chain && v.ids.length) parts.push('chain=1')
  return parts.filter(Boolean).join('&')
}
