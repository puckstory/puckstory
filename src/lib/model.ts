/*
 * model.ts - the data model (built once at startup).
 *
 * buildModel() turns the raw dataset (champion teams + engraved players) into the graph the app
 * draws: one node per Cup and per player, an edge for every engraving, an adjacency map for hover
 * highlighting, and a "dynasty" colour per node derived from the TEAM it won with (a Cup takes its
 * franchise colour, a multi-team player a Cup-weighted blend of his teams' colours). The Louvain
 * community ids baked into the dataset (by data-pipeline/communities.mjs, so the graph libraries stay
 * out of the bundle) are still carried per node but no longer drive colour or layout. Also the small
 * colour, era, and name helpers that the rest of the app shares.
 */
import type { Dataset, GNode, GLink, Era } from './types'
import rawData from '../data/dataset.json'

export const DATA = rawData as unknown as Dataset

/* ---------- era (union-of-intervals) helpers ---------- */
export const inEras = (y: number, eras: Era[]): boolean => {
  for (const e of eras) if (y >= e.start && y <= e.end) return true
  return false
}
export const eraBounds = (eras: Era[]): [number, number] =>
  eras.length
    ? [Math.min(...eras.map((e) => e.start)), Math.max(...eras.map((e) => e.end))]
    : [DATA.window.startYear, DATA.window.endYear]
// The six named NHL eras that tile the whole timeline (2005 is the no-Cup lockout year). The
// bar's pills and Six Degrees' era-appending both read THIS list, so they can never disagree.
export const ERA_PRESETS: { name: string; start: number; end: number }[] = [
  { name: 'Pre-O6', start: 1915, end: 1941 },
  { name: 'Original Six', start: 1942, end: 1967 },
  { name: 'Expansion', start: 1968, end: 1979 },
  { name: 'Dynasties', start: 1980, end: 1993 },
  { name: 'Dead Puck', start: 1994, end: 2004 },
  { name: 'Cap', start: 2006, end: DATA.window.endYear },
]
/** Sort the eras and merge any that touch or overlap, so the same selection always reduces to one standard list. */
export const mergeEras = (eras: Era[]): Era[] => {
  const out: Era[] = []
  for (const e of [...eras].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && e.start <= last.end + 1) last.end = Math.max(last.end, e.end)
    else out.push({ ...e })
  }
  return out
}
// Team colours are the pixel-exact official franchise primaries, EXCEPT the members of a colour
// collision (marked "← official …" or "was …"), nudged the minimum needed so no two teams read as the
// same colour in the graph (every nudged pair now clears OKLab dE 0.045; closest official pairs sit
// at ~0.03, e.g. MTL-NJD, EDM-ANA - the accepted texture of an official-first palette). Every value is identical on every theme (AMOLED black through cream) - render.ts draws
// a team-darkened contrast rim around every cup and dynasty dot instead of shifting hue per theme.
//   • Revert any single "← official …" team to its noted value for exact fidelity on that club.
//   • Revert every "← official …" team → fully pixel-exact official (accepting that some teams then share a colour).
//   • The prior fully hue-spread palette (max distinguishability, less official) is in git history.
// Most collisions keep ONE anchor at its exact official colour and move only the others; the exception is
// the navy/royal family (STL/TBL/TOR/NYR), where every official value reads too dark as a filled cup icon,
// so all are lifted and none stays exact (STL is only the relatively least-moved of them).
export const TEAM_COLORS: Record<string, string> = {
  PIT: '#f0a30f', // ← official #fcb514 - Penguins & Bruins share a gold; BOS keeps the exact one
  WSH: '#e01b3f', // ← official #c8102e - identical to FLA, near DET/NJD crimson
  STL: '#1a53c1', // ← official #002f87 - true Blues navy reads too dark as a cup icon; lifted (still the navy-side anchor TBL moved off), then brightened a step off the TOR royal
  TBL: '#267ec3', // ← official #002868 - reads identical to the STL/TOR navy; STL keeps the navy. Deepened off the cut-mode accent #2f80e0 too (a TBL swatch sat beside the identical "Add to cut" button)
  COL: '#8f3352', // ← official #6f263d - true Avalanche burgundy reads dark on the dark themes; lifted
  VGK: '#b4975a',
  FLA: '#f0563f', // ← official #c8102e - identical to WSH
  CAR: '#c00245', // ← official #ce1126 - identical to DET/NJD, and the first crimson nudge landed on MTL's official red; pushed to a raspberry red clear of all three
  MTL: '#af1e2d',
  BOS: '#ffb81c', //   gold anchor (PIT moves off it)
  PHI: '#f74902', //   orange anchor (EDM moves off it)
  NYI: '#00539b', EDM: '#ff6a13', // EDM ← official #ff4c00 - near-identical to the PHI orange
  CGY: '#d83009', // ← official #d2001c - sits right on the DET red anchor; warmed toward flame orange-red
  NYR: '#2f66d2', // ← official #0038a8 - true Rangers royal reads too dark as a filled cup icon; lifted
  NJD: '#a51d3a', // ← official #ce1126 - shares DET's red AND both play Dead Puck; wine-red separates them
  DET: '#ce1126', //   red anchor (WSH/FLA/CAR/NJD/CHI move off it)
  DAL: '#006847', ANA: '#f47a38',
  CHI: '#e6442e', // ← official #cf0a2c - reads identical to the DET crimson
  LAK: '#a2aaad',
  TOR: '#2a56a6', // ← official #00205b - true Leafs navy reads too dark as a filled cup icon; lifted
  // historical / defunct champions (1915–1967)
  VML: '#7a1f2b', //   maroon anchor (VIC moves off it)
  SEA: '#0f8a4c', TSP: '#1b6e3c',
  TOA: '#2945a6', // indigo side of the NYI royal (was #1f4e9c, which read identical to NYI)
  OTS: '#9a2218', // darker brick, clear of the NJD wine and the MTL crimson (was #a5232f)
  VIC: '#2aa3a3', // ← official ~#7a1f2b - identical to the VML maroon
  MMR: '#884859', // rosied a step off the lifted COL burgundy (was #8c3b54)
}
export const POS_COLORS = { F: '#ff8a4c', D: '#9b8cff', G: '#3ad0a6' } as const
// Same hues, darkened for the two light themes: the bright dark-theme fills measure only
// ~1.7-2.6:1 against the cream/ice backgrounds (under the 3:1 WCAG floor for non-text UI);
// these all clear 3.8:1 on both. render.ts picks the set by the canvas background.
export const POS_COLORS_LIGHT = { F: '#c2551b', D: '#6353d9', G: '#0d8a63' } as const

export const teamColor = (ab?: string) => (ab && TEAM_COLORS[ab]) || '#8895ad'
// RGB triplet of a team's colour (parsed from its hex once, cached) - for blending the node colour
// of a player who won with more than one team. Unknown teams share teamColor()'s neutral slate.
const TEAM_RGB = new Map<string, [number, number, number]>()
export function teamRgb(ab?: string): [number, number, number] {
  const hex = teamColor(ab)
  let v = TEAM_RGB.get(hex)
  if (!v) { v = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; TEAM_RGB.set(hex, v) }
  return v
}
// Accent-fold for search: lower-case + strip diacritics so a plain query ("jagr", "beliveau")
// matches an accented name ("Jágr", "Béliveau"). NFD splits é→e+◌́, then drop the combining marks.
export const foldText = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
// Search-match key: accent-fold, then ALSO drop punctuation and spaces, applied to both the index
// key and the query so the two always fold the same way. This is what lets the queries people
// actually type find punctuated engravings: "kandre" \u2192 K'Andre Miller, "oconnor" \u2192 Buddy O'Connor,
// "jc tremblay" \u2192 J. C. Tremblay, "smith pelly" \u2192 Devante Smith-Pelly.
export const searchKey = (s: string) => foldText(s).replace(/[.'\u2019\-\s]+/g, '')
export const posGroup = (p?: string): 'F' | 'D' | 'G' => (p === 'G' ? 'G' : p === 'D' ? 'D' : 'F')
export const posFull = (p?: string) =>
  (({ C: 'Center', LW: 'Left Wing', RW: 'Right Wing', D: 'Defense', G: 'Goaltender', F: 'Forward' } as Record<string, string>)[p || ''] || p || '')

export interface Model {
  nodes: GNode[]
  links: GLink[]
  nodeById: Map<string, GNode>
  cups: GNode[]
  adj: Map<string, Set<string>>
  communityColor: (c: number) => string
  numCommunities: number
}

// Distinct, evenly-spaced hues keyed by community id (the fallback colour when a node has no team
// dynastyColor) - each next colour sits 137.5° further around the colour wheel (the "golden angle"),
// so hues never repeat or bunch up.
const commHue = (c: number) => (c * 137.508) % 360
function makeCommunityPalette(): (c: number) => string {
  const cache = new Map<number, string>()
  return (c: number) => {
    if (cache.has(c)) return cache.get(c)!
    const col = `hsl(${commHue(c).toFixed(1)} 62% 60%)`
    cache.set(c, col)
    return col
  }
}
export function buildModel(): Model {
  const nodes: GNode[] = []
  const nodeById = new Map<string, GNode>()
  const commSet = new Set<number>()

  for (const c of DATA.champions) {
    const n: GNode = {
      id: 'cup-' + c.year, type: 'cup', year: c.year, team: c.team, abbr: c.abbr,
      runnerUp: c.runnerUp, series: c.series, connSmythe: c.connSmythe, playerCount: c.playerCount,
      r: 21, vis: true, rangeCupCount: 1,
      // dynasty cluster ids are precomputed by data-pipeline/communities.mjs (seeded Louvain,
      // same seed the app historically ran at startup) so the graph libraries stay out of the bundle
      community: c.community ?? 0,
    }
    commSet.add(n.community)
    nodes.push(n); nodeById.set(n.id, n)
  }
  for (const p of DATA.players) {
    const g = posGroup(p.position)
    const n: GNode = {
      id: 'pl-' + p.id, type: 'player', name: p.name, position: p.position, group: g,
      cups: p.cups, cupCount: p.cupCount, r: 6,
      vis: true, rangeCupCount: p.cupCount, community: p.community ?? 0,
    }
    commSet.add(n.community)
    nodes.push(n); nodeById.set(n.id, n)
  }

  const links: GLink[] = []
  for (const p of DATA.players) {
    for (const cup of p.cups) {
      const s = nodeById.get('pl-' + p.id), t = nodeById.get('cup-' + cup.year)
      if (s && t) links.push({ source: s, target: t, _teamCol: teamColor(t.abbr) }) // target is always the Cup; its franchise colour never changes
    }
  }

  // adjacency (for hover highlight)
  const adj = new Map<string, Set<string>>()
  nodes.forEach((n) => adj.set(n.id, new Set()))
  for (const l of links) {
    const s = (l.source as GNode).id, t = (l.target as GNode).id
    adj.get(s)!.add(t); adj.get(t)!.add(s)
  }

  const communityColor = makeCommunityPalette()
  // Dynasty colour per node = the TEAM it won with. A Cup wears its franchise's colour; a player who
  // won with more than one team gets a blend of those team colours, weighted by how many Cups he won
  // with each (2 with a red team + 1 with a blue reads two-thirds red). This build-time pass covers
  // the FULL career; GraphView.applyFilters re-blends over the VISIBLE Cups on every era/cut change,
  // so the colour follows the view exactly like node size does.
  for (const n of nodes) {
    if (n.type === 'cup') { n.dynastyColor = teamColor(n.abbr); continue }
    let r = 0, g = 0, b = 0, tot = 0
    for (const cup of n.cups!) { const [cr, cg, cb] = teamRgb(cup.abbr); r += cr; g += cg; b += cb; tot++ }
    n.dynastyColor = tot
      ? `rgb(${Math.round(r / tot)},${Math.round(g / tot)},${Math.round(b / tot)})`
      : teamColor(n.abbr)
  }

  const cups = nodes.filter((n) => n.type === 'cup').sort((a, b) => a.year! - b.year!)
  return { nodes, links, nodeById, cups, adj, communityColor, numCommunities: commSet.size }
}
