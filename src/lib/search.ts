/*
 * search.ts - the search index and the dropdown filter.
 *
 * buildSearchIndex() runs once at startup: every team (its Cups grouped) plus every engraved
 * player, each with a punctuation/accent/space-folded key (searchKey) so the queries people
 * actually type match ("kandre" → K'Andre Miller, "beliveau" → Béliveau, "jc tremblay" →
 * J. C. Tremblay). filterSearch() is the dropdown's rule: every folded match surfaces, but items
 * the current view hides (era, position pills, the 2+ filter) come back greyed with a note saying
 * why - picking one still selects it, and the graph shows its everything-faded state until the
 * filters change to cover it.
 */
import type { Model } from './model'
import { searchKey, posFull, inEras } from './model'
import type { ViewState } from './types'

export interface SearchItem {
  kind: 'team' | 'player'
  label: string
  sub: string
  key: string
  ids: string[]
  years: number[]
  group?: 'F' | 'D' | 'G' // players only: position group, so the F/D/G pills gate the results
}

export function buildSearchIndex(model: Model): SearchItem[] {
  const teams = new Map<string, { name: string; years: number[]; ids: string[] }>()
  const players: SearchItem[] = []
  for (const n of model.nodes) {
    if (n.type === 'cup') {
      const t = teams.get(n.abbr!) ?? { name: n.team!, years: [], ids: [] }
      t.name = n.team!; t.years.push(n.year!); t.ids.push(n.id); teams.set(n.abbr!, t)
    } else {
      const cs = n.cups ?? []
      players.push({ kind: 'player', label: n.name!, sub: `${posFull(n.position)} · ${cs.length} Cup${cs.length !== 1 ? 's' : ''}`,
        key: searchKey(n.name!), ids: [n.id], years: cs.map((cp) => cp.year), group: n.group })
    }
  }
  const teamItems: SearchItem[] = [...teams.entries()].map(([abbr, t]) => {
    const ys = [...t.years].sort((a, b) => a - b)
    return { kind: 'team', label: t.name, sub: `Team · ${ys.join(', ')}`,
      key: searchKey(`${t.name} ${abbr}`), ids: t.ids, years: ys }
  })
  return [...teamItems, ...players]
}

/** A dropdown row: the matched item plus, when the current view hides it, WHY (which filter) and
 *  WHEN they won - so out-of-era matches surface greyed instead of silently vanishing. */
export interface SearchResult extends SearchItem {
  hiddenNote: string | null
}

const POS_NAME = { F: 'forwards', D: 'defensemen', G: 'goaltenders' } as const

// "1984, 1985, 1987, 1988" for short careers; "1916–1993" for long team histories
function yearsLabel(years: number[]): string {
  const ys = [...new Set(years)].sort((a, b) => a - b)
  return ys.length <= 4 ? ys.join(', ') : `${ys[0]}–${ys[ys.length - 1]}`
}

/** Two SearchItems are the same endpoint (used to keep an armed Six Degrees item out of its own
 *  target list - a team containing that player is still a legitimate target). */
export const sameItem = (a: SearchItem, b: SearchItem): boolean =>
  a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i])

/** The dropdown's results: every folded-substring match surfaces. Items the current view hides
 *  carry a hiddenNote explaining why (no Cups in the selected era - and when they DID win - or a
 *  position/2+ filter). Picking a hidden item still selects it: the graph then shows the standard
 *  "selection not in this view" state, everything faded, until the era/filters cover it.
 *  Selectable matches sort before hidden ones, prefix matches before mid-name, capped at `limit`.
 *  `omit` is excluded BEFORE the cap, so the list backfills instead of losing a slot. */
export function filterSearch(items: SearchItem[], query: string, st: ViewState, limit = 8, omit?: SearchItem): SearchResult[] {
  const q = searchKey(query)
  if (!q) return []
  const out: SearchResult[] = []
  for (const i of items) {
    if (!i.key.includes(q)) continue
    if (omit && sameItem(i, omit)) continue
    let inEra = 0
    for (const y of i.years) if (inEras(y, st.eras)) inEra++
    let hiddenNote: string | null = null
    if (!inEra) hiddenNote = `Not in the selected era - won ${yearsLabel(i.years)}`
    else if (i.kind === 'player' && i.group && !st.positions[i.group])
      hiddenNote = `Hidden - ${POS_NAME[i.group]} are filtered out`
    else if (i.kind === 'player' && st.multiOnly && inEra < 2)
      hiddenNote = `Hidden by the 2+ filter - 1 Cup in range`
    out.push({ ...i, hiddenNote })
  }
  return out
    .sort((a, b) =>
      Number(!!a.hiddenNote) - Number(!!b.hiddenNote) ||
      Number(b.key.startsWith(q)) - Number(a.key.startsWith(q)))
    .slice(0, limit)
}
