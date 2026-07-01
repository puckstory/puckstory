/*
 * model.ts - the data model (built once at startup).
 *
 * buildModel() turns the raw dataset (champion teams + engraved players) into the graph the app
 * draws: one node per Cup and per player, an edge for every engraving, an adjacency map for hover
 * highlighting, and a "dynasty" colour per node from the community ids baked into the dataset
 * (Louvain clustering - a standard way of finding tightly-knit groups in a network - precomputed
 * by data-pipeline/communities.mjs so the graph libraries stay out of the bundle). Also the small
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
export const TEAM_COLORS: Record<string, string> = {
  PIT: '#f7c520', WSH: '#e01b3f', STL: '#1f5fc4', TBL: '#36a0ff', COL: '#7d2348',
  VGK: '#c2a35a', FLA: '#f0563f', CAR: '#b3122c',
  MTL: '#a6192e', BOS: '#f5b301', PHI: '#f7591f', NYI: '#1f6fd6', EDM: '#ff6a13',
  CGY: '#d11a2a', NYR: '#1660e0', NJD: '#d8112e', DET: '#ff2d3f', DAL: '#1aa34a',
  ANA: '#b58a3c', CHI: '#e6442e', LAK: '#9aa3a8', TOR: '#2b6cd4',
  // historical / defunct champions (1915–1967)
  VML: '#9b1c4b', SEA: '#1f9d6b', TOA: '#3a78c2', OTS: '#c0392b', TSP: '#2f9e54',
  VIC: '#2aa3a3', MMR: '#8c3b54',
}
export const POS_COLORS = { F: '#ff8a4c', D: '#9b8cff', G: '#3ad0a6' } as const
// Same hues, darkened for the two light themes: the bright dark-theme fills measure only
// ~1.7-2.6:1 against the cream/ice backgrounds (under the 3:1 WCAG floor for non-text UI);
// these all clear 3.8:1 on both. render.ts picks the set by the canvas background.
export const POS_COLORS_LIGHT = { F: '#c2551b', D: '#6353d9', G: '#0d8a63' } as const

export const teamColor = (ab?: string) => (ab && TEAM_COLORS[ab]) || '#8895ad'
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

// Distinct, evenly-spaced hues for community (dynasty) coloring - each next colour sits 137.5°
// further around the colour wheel (the "golden angle"), so hues never repeat or bunch up.
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
// RGB of a community colour (same hue/sat/light as the palette), for blending split players.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}
const COMM_RGB = new Map<number, [number, number, number]>()
export function communityRgb(c: number): [number, number, number] {
  let v = COMM_RGB.get(c)
  if (!v) { v = hslToRgb(commHue(c), 0.62, 0.6); COMM_RGB.set(c, v) }
  return v
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
      if (s && t) links.push({ source: s, target: t })
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
  // Dynasty colour per node: a Cup belongs to one cluster, but a player split across clusters gets
  // a blend of its Cups' cluster colours, weighted by how many Cups it won in each. This build-time
  // pass covers the FULL career (the sensible default before any filtering); GraphView.applyFilters
  // re-blends over the VISIBLE Cups on every era/cut change, so the colour follows the view exactly
  // like node size does.
  for (const n of nodes) {
    if (n.type === 'cup') { n.dynastyColor = communityColor(n.community); continue }
    const counts = new Map<number, number>()
    for (const cup of n.cups!) {
      const cn = nodeById.get('cup-' + cup.year)
      const c = cn ? cn.community : n.community
      counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    let r = 0, g = 0, b = 0, tot = 0
    for (const [c, w] of counts) { const [cr, cg, cb] = communityRgb(c); r += cr * w; g += cg * w; b += cb * w; tot += w }
    n.dynastyColor = tot
      ? `rgb(${Math.round(r / tot)},${Math.round(g / tot)},${Math.round(b / tot)})`
      : communityColor(n.community)
  }

  const cups = nodes.filter((n) => n.type === 'cup').sort((a, b) => a.year! - b.year!)
  return { nodes, links, nodeById, cups, adj, communityColor, numCommunities: commSet.size }
}
