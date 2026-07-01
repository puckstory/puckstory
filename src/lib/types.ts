/*
 * types.ts - the shared TypeScript types.
 *
 * The shapes that pass between the data model, the graph engine, and the UI: the raw dataset records,
 * the graph node and link (GNode / GLink), and ViewState - every control's current value (selected
 * eras, position toggles, multi-Cup, colour mode, layout mode).
 */
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'

export interface CupRef {
  year: number
  abbr: string
  team: string
  captain: boolean
  connSmythe: boolean
}
export interface PlayerRec {
  id: string
  name: string
  position: string
  cupCount: number
  cups: CupRef[]
  community: number // dynasty cluster, precomputed by data-pipeline/communities.mjs
}
export interface Champion {
  year: number
  team: string
  abbr: string
  runnerUp: string
  series?: string // Final result, champion's wins first ("4–2") - parsed from the Final's infobox
  connSmythe: string | null
  playerCount: number
  community: number // dynasty cluster, precomputed by data-pipeline/communities.mjs
}
export interface Dataset {
  window: { startYear: number; endYear: number; note: string }
  champions: Champion[]
  players: PlayerRec[]
  stats: { seasons: number; totalPlayers: number; multiCupPlayers: number; totalEngravings: number }
}

export type NodeType = 'cup' | 'player'

export interface GNode extends SimulationNodeDatum {
  id: string
  type: NodeType
  // layout
  r: number
  vis: boolean
  rangeCupCount: number
  community: number
  dynastyColor?: string // precomputed dynasty colour (blend of cluster colours for split players)
  _tx?: number // layout target (its timeline grid cell, or the middle of its cups' cells); 0 in network mode
  _ty?: number
  // cup
  year?: number
  team?: string
  abbr?: string
  runnerUp?: string
  series?: string // "4–2", champion's wins first
  connSmythe?: string | null
  playerCount?: number
  // player
  name?: string
  position?: string
  group?: 'F' | 'D' | 'G'
  cups?: CupRef[]
  cupCount?: number
}

export interface GLink extends SimulationLinkDatum<GNode> {
  source: GNode | string
  target: GNode | string
}

export type ColorMode = 'position' | 'dynasty'
export type LayoutMode = 'network' | 'timeline'

/** A closed year interval [start, end]. The era selection is a union of these. */
export interface Era { start: number; end: number }

export interface ViewState {
  /** Selected eras (union of intervals). A single interval = a plain custom range. */
  eras: Era[]
  positions: { F: boolean; D: boolean; G: boolean }
  multiOnly: boolean
  colorMode: ColorMode
  layoutMode: LayoutMode
}
