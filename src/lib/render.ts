/*
 * render.ts - the canvas painter (pure drawing, no state).
 *
 * draw() takes a plain snapshot (DrawState: the nodes, the camera, the theme colours) and paints one
 * frame back-to-front: the faint base edges, then the nodes (player dots and the Stanley Cup glyphs,
 * dimmed when a network is in focus), then - when something IS focused - that network's edges and
 * nodes AGAIN on top of the dimmed crowd, and finally the player-name labels, which avoid nodes and
 * one another where possible (a selected name always draws, clamped on-screen). This file also holds
 * the hand-traced Cup / Conn Smythe / captain-"C" silhouettes that the rest of the app reuses as icons.
 */
import type { GNode, GLink, ColorMode } from './types'
import { POS_COLORS, POS_COLORS_LIGHT, teamColor } from './model'

export interface DrawState {
  nodes: GNode[]
  links: GLink[]
  tx: number; ty: number; k: number
  W: number; H: number; dpr: number
  hoverSet: Set<string> | null
  focusIds: Set<string>
  focusT: number // 0..1 eased "focus active" amount, so the dim fades in/out instead of snapping
  colorMode: ColorMode
  communityColor: (c: number) => string
  bg: string // canvas background (follows the active theme)
  edgeRgb: string   // edge-colour rgb triplet, flipped for light themes
  edgeAlpha: number // base edge opacity, raised on low-contrast themes (AMOLED / light)
  nameFill: string  // player-name label fill
  nameHalo: string  // player-name label halo
  hlEdge: string    // highlighted-network edge rgb (gold on dark themes, dark slate on light)
  light: boolean    // light-theme background: player fills switch to the darkened palette
  // nodes LEAVING the view during a pre-solved transition: drawn as fading, shrinking echoes
  // gliding into their cup instead of vanishing on the spot (positions/alpha precomputed per frame)
  ghosts?: { n: GNode; x: number; y: number; r: number; a: number }[]
}

// On the two LIGHT themes, the vivid team colours can be too pale to read on the cream/ice
// background (Bruins/Penguins gold, Kings silver). Scale any colour brighter than a legible ceiling
// down toward black - preserving hue - so every dynasty node and line clears the contrast floor,
// exactly as POS_COLORS_LIGHT does for the position palette. Colours already dark enough pass
// through untouched. Dynasty mode only; memoised (the palette is a few dozen distinct strings).
// This one stays a plain RGB luma scale ON PURPOSE (do not "upgrade" it to the OKLCh treatment
// forDark uses): darkening toward black preserves the channel ratios - hue AND saturation - so the
// gold/orange families keep their chroma separation (EDM-ANA hold at CIEDE2000 5.1 here; an
// equal-contrast OKLCh lightness clamp merges them below 2.5). test/palette.test.ts pins both
// the post-fold pair floor and the contrast floor.
const LIGHT_ADJ = new Map<string, string>()
export function forLight(color: string): string {
  const hit = LIGHT_ADJ.get(color)
  if (hit) return hit
  let r: number, g: number, b: number
  const hx = /^#([0-9a-f]{6})$/i.exec(color)
  const rg = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(color)
  if (hx) { r = parseInt(hx[1].slice(0, 2), 16); g = parseInt(hx[1].slice(2, 4), 16); b = parseInt(hx[1].slice(4, 6), 16) }
  else if (rg) { r = +rg[1]; g = +rg[2]; b = +rg[3] }
  else { LIGHT_ADJ.set(color, color); return color } // unknown format: leave as-is
  const CEIL = 120 // perceived-luminance target, matching POS_COLORS_LIGHT (~95-111)
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  const out = lum > CEIL
    ? `rgb(${Math.round(r * CEIL / lum)},${Math.round(g * CEIL / lum)},${Math.round(b * CEIL / lum)})`
    : color
  LIGHT_ADJ.set(color, out)
  return out
}

// OKLab round-trip for forDark's lift (Björn Ottosson's matrices). Runs once per distinct colour
// string (the fold is memoised), so the transcendentals cost nothing per frame.
const srgb2lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const lin2srgb = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgb2lin(r), lg = srgb2lin(g), lb = srgb2lin(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    lin2srgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    lin2srgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    lin2srgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}
// largest chroma (≤ C) that still fits the sRGB gamut at lightness L for hue h - binary search;
// memoisation upstream makes the iteration count irrelevant
function fitChroma(L: number, C: number, h: number): [number, number, number] {
  const at = (c: number): [number, number, number] => oklabToRgb(L, c * Math.cos(h), c * Math.sin(h))
  const fits = (rgb: number[]) => rgb.every((v) => v >= -0.001 && v <= 255.001)
  if (fits(at(C))) return at(C)
  let lo = 0, hi = C
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (fits(at(mid))) lo = mid; else hi = mid }
  return at(lo)
}

// The mirror of forLight for the DARK themes: the darkest official team colours (Colorado burgundy,
// St. Louis navy) fall close to the background, so their thin EDGES vanish on black. This one works
// in OKLCh, NOT the RGB luma scale forLight uses: the old RGB lift (scale every channel to a flat
// luma floor, blend the clipped remainder toward white) normalized all dark colours to one lightness
// and desaturated the deep reds, which re-merged same-hue franchises the palette had deliberately
// pulled apart - MTL and DET edge fans met at CIEDE2000 1.75 on AMOLED, under a just-noticeable
// difference. Here the lift holds hue exactly, keeps as much chroma as the gamut allows at the new
// lightness, and SOFT-clamps L (keeps Q of the deficit below the floor) so families separated mainly
// by lightness - the STL/NYR royals - keep a compressed slice of that separation instead of landing
// on one point. Calibrated against the full palette (pinned in test/palette.test.ts): every folded
// pair stays ≥ CIEDE2000 2.9 and every folded colour clears 3.4:1 on pure black; the old fold
// bottomed out at 1.45 (NYR-TOR) with six pairs under 3.6. Applied to edges only; nodes keep their
// exact colour (they read on size + the label).
const DARK_ADJ = new Map<string, string>()
export function forDark(color: string): string {
  const hit = DARK_ADJ.get(color)
  if (hit) return hit
  let r: number, g: number, b: number
  const hx = /^#([0-9a-f]{6})$/i.exec(color)
  const rg = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(color)
  if (hx) { r = parseInt(hx[1].slice(0, 2), 16); g = parseInt(hx[1].slice(2, 4), 16); b = parseInt(hx[1].slice(4, 6), 16) }
  else if (rg) { r = +rg[1]; g = +rg[2]; b = +rg[3] }
  else { DARK_ADJ.set(color, color); return color } // unknown format: leave as-is
  const FLOOR = 0.62 // OKLab lightness a thin edge needs to read on the darkest (AMOLED) background
  const Q = 0.4 // deficit kept: 0 = hard clamp (collapses the lightness-separated royals), 1 = no lift
  const [L, A, B] = rgbToOklab(r, g, b)
  let out = color
  if (L < FLOOR) {
    const lifted = fitChroma(FLOOR - Q * (FLOOR - L), Math.hypot(A, B), Math.atan2(B, A))
    const cl = (v: number) => Math.round(Math.max(0, Math.min(255, v)))
    out = `rgb(${cl(lifted[0])},${cl(lifted[1])},${cl(lifted[2])})`
  }
  DARK_ADJ.set(color, out)
  return out
}

export function nodeColor(n: GNode, mode: ColorMode, cc: (c: number) => string, light = false): string {
  if (mode === 'dynasty') {
    // team colours are the official franchise values now, identical on every theme (draw() rings each
    // node for contrast instead of shifting the hue); only the community fallback still needs the fold
    if (n.dynastyColor) return n.dynastyColor
    return light ? forLight(cc(n.community)) : cc(n.community)
  }
  return n.type === 'cup' ? teamColor(n.abbr) : (light ? POS_COLORS_LIGHT : POS_COLORS)[n.group || 'F']
}

// The cup glyph's extent around its node centre, in node-radius units (from CUP_PATH's normalised
// box). Every consumer - fit framing, hit-testing, culling, label obstacles, collision radius - // shares these so the clickable/framed/avoided region always matches what is drawn.
export const CUP_EXT = { halfW: 0.66, up: 1.5, down: 1.36 } as const

// label-width cache (see the label loop): population is fixed by the dataset, so it never grows
// past ~2 entries per player name. A deep-linked selection can draw labels BEFORE Inter decodes,
// so widths measured against the fallback font are flushed once the real face is ready.
const labelWidths = new Map<string, number>()
if (typeof document !== 'undefined') document.fonts?.ready.then(() => labelWidths.clear())

// dynasty edge segments bucketed by team colour, reused across frames (arrays cleared, not
// reallocated). The colour set is fixed (~30 franchises), so this Map stays a fixed small size.
const edgeBuckets = new Map<string, number[]>()

export function draw(ctx: CanvasRenderingContext2D, s: DrawState) {
  const { tx, ty, k, W, H, dpr, hoverSet, colorMode, communityColor } = s
  const sx = (x: number) => x * k + tx
  const sy = (y: number) => y * k + ty
  const onScreen = (x: number, y: number, pad: number) => x > -pad && x < W + pad && y > -pad && y < H + pad

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = s.bg; ctx.fillRect(0, 0, W, H)

  // edges - base layer; when a network is highlighted the rest is gently dimmed (but
  // not as hard as before), and the highlighted network's edges are redrawn brighter on top.
  // Every edge in a pass shares one colour/width, so each pass accumulates ALL its segments
  // into a single path and strokes once - at full range that turns ~2,400 stroke() calls
  // (each with redundant style sets) into one, the dominant per-frame saving during settles.
  ctx.lineCap = 'round'
  ctx.lineWidth = 0.8 // 0.6 under-rendered on 1x displays; 0.8 + the alpha in setBg keeps dense views calm
  if (colorMode === 'dynasty') {
    // Colour each edge by its Cup's team (precomputed once as l._teamCol - the link's target is always
    // the Cup, see buildModel), so a player's lines fan out in the colours of the teams he won with.
    // Group segments by colour and stroke once per team (~30 strokes, trivial vs ~2,300 lines). Buckets
    // are REUSED across frames (arrays cleared, never reallocated); globalAlpha carries the focus-fade.
    // The highlighted network still redraws in gold on top (the highlight pass below).
    ctx.globalAlpha = s.edgeAlpha * (1 - 0.5 * s.focusT)
    for (const arr of edgeBuckets.values()) arr.length = 0
    for (const l of s.links) {
      const a = l.source as GNode, b = l.target as GNode
      if (!a.vis || !b.vis) continue
      if ((a._enter ?? 1) < 0.3 || (b._enter ?? 1) < 0.3) continue // endpoint still blooming in
      if (hoverSet && hoverSet.has(a.id) && hoverSet.has(b.id)) continue // drawn in the highlight pass below
      const x1 = sx(a.x!), y1 = sy(a.y!), x2 = sx(b.x!), y2 = sy(b.y!)
      if (!onScreen(x1, y1, 40) && !onScreen(x2, y2, 40)) continue
      // edges only: nudge the franchise colour into a legible luminance band for the current background
      // (brighten the too-dark on dark themes, darken the too-bright on light) so the thin connectors
      // never vanish; the NODES keep the exact official colour. Deterministic per colour, so bucketing holds.
      const raw = l._teamCol ?? teamColor(b.abbr)
      const col = s.light ? forLight(raw) : forDark(raw)
      let seg = edgeBuckets.get(col)
      if (!seg) { seg = []; edgeBuckets.set(col, seg) }
      seg.push(x1, y1, x2, y2)
    }
    for (const [col, segs] of edgeBuckets) {
      if (!segs.length) continue
      ctx.strokeStyle = col; ctx.beginPath()
      for (let i = 0; i < segs.length; i += 4) { ctx.moveTo(segs[i], segs[i + 1]); ctx.lineTo(segs[i + 2], segs[i + 3]) }
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  } else {
    ctx.strokeStyle = `rgba(${s.edgeRgb},${s.edgeAlpha * (1 - 0.5 * s.focusT)})`
    ctx.beginPath()
    for (const l of s.links) {
      const a = l.source as GNode, b = l.target as GNode
      if (!a.vis || !b.vis) continue
      if ((a._enter ?? 1) < 0.3 || (b._enter ?? 1) < 0.3) continue // endpoint still blooming in
      if (hoverSet && hoverSet.has(a.id) && hoverSet.has(b.id)) continue // drawn in the highlight pass below
      const x1 = sx(a.x!), y1 = sy(a.y!), x2 = sx(b.x!), y2 = sy(b.y!)
      if (!onScreen(x1, y1, 40) && !onScreen(x2, y2, 40)) continue
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2)
    }
    ctx.stroke()
  }

  // transition ghosts: nodes that just left the view glide into their cup as fading, shrinking
  // echoes - painted UNDER the surviving nodes so nothing settles behind a phantom
  if (s.ghosts) {
    for (const g of s.ghosts) {
      if (g.a <= 0.02) continue
      const x = sx(g.x), y = sy(g.y), r = Math.max(0.5, g.r * k)
      if (!onScreen(x, y, r + 20)) continue
      ctx.globalAlpha = g.a
      const col = nodeColor(g.n, colorMode, communityColor, s.light)
      if (g.n.type === 'cup') drawCup(ctx, x, y, r, col)
      else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill() }
    }
    ctx.globalAlpha = 1
  }

  // one node, either pass
  const drawNode = (n: GNode, dim: boolean) => {
    const en = n._enter ?? 1
    if (en <= 0.02) return // still waiting for its bloom window in a transition
    const x = sx(n.x!), y = sy(n.y!), r = n.r * en * k // cups + players scale straight with zoom, so the
    // rendered glyph always matches the space the collision force reserved for it (no overlap)
    // cups extend above/below their centre (the tall glyph), so they need a taller cull pad
    // than their nominal radius (shares CUP_EXT with fit/hit/obstacle math); players are circles.
    const cullPad = n.type === 'cup' ? r * CUP_EXT.up + 12 : r + 30
    if (!onScreen(x, y, cullPad)) return
    const col = nodeColor(n, colorMode, communityColor, s.light)
    if (n.type === 'cup') {
      // Cups draw OPAQUE, then get washed toward the background when dimmed - so a faded cup reads as
      // dimmed but still hides the edges/nodes behind it (a translucent globalAlpha let them show through).
      ctx.globalAlpha = 1
      drawCup(ctx, x, y, r, col)
      // team abbr + year stacked inside the barrel (no external label)
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'
      const haloW = r * 0.09, tf = r * 0.385, yf = r * 0.38 // pure proportional: the cup radius is a fixed constant (n.r = 30), so the abbr + year stay in ratio with the glyph
      ctx.strokeStyle = 'rgba(6,9,16,0.6)'; ctx.fillStyle = '#fff'; ctx.lineWidth = haloW
      ctx.font = '800 ' + tf + 'px Inter,-apple-system,Segoe UI,Roboto,sans-serif'
      ctx.strokeText(n.abbr!, x, y + r * 0.2); ctx.fillText(n.abbr!, x, y + r * 0.2)
      ctx.font = '600 ' + yf + 'px Inter,-apple-system,Segoe UI,Roboto,sans-serif'
      ctx.strokeText('' + n.year, x, y + r * 0.74); ctx.fillText('' + n.year, x, y + r * 0.74)
      if (dim) { // wash the whole glyph (body + label) toward the bg at the eased dim strength
        ctx.globalAlpha = 0.65 * s.focusT
        fillCup(ctx, x, y, r, s.bg)
        ctx.globalAlpha = 1
      }
    } else {
      ctx.globalAlpha = dim ? 1 - 0.65 * s.focusT : 1 // eased dim (1 -> 0.35) so it fades, not snaps
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = col; ctx.fill()
      // dynasty dots keep the exact franchise blend on EVERY theme, so - like the cups - they
      // carry the darkened rim to stay defined against the pale light-theme backgrounds.
      // Position mode folds its palette per theme instead and stays borderless.
      if (colorMode === 'dynasty') {
        ctx.strokeStyle = darkenHex(col, 0.42); ctx.lineWidth = Math.max(1, r * 0.07); ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
  }

  // Layering: everything FADED first (its nodes included), then the highlighted edges, then the
  // highlighted nodes - so a lit corridor crosses OVER the dimmed crowd instead of ducking under
  // every faded cup in its way, and no dimmed node ever covers a lit one.
  for (const n of s.nodes) {
    if (!n.vis) continue
    if (hoverSet && hoverSet.has(n.id)) continue // lit: drawn in the top pass below
    drawNode(n, !!hoverSet)
  }
  if (hoverSet) {
    // Ramp the highlight opacity UP from the base edge alpha (not from 0): these edges are skipped in
    // the base pass the instant a selection lands, so fading them in from 0 made them dip darker for a
    // few frames (a "disappear then reappear"). Starting at edgeAlpha keeps them at least as visible as
    // before, only ever brightening toward the 0.72 lit weight as the focus eases in.
    ctx.strokeStyle = `rgba(${s.hlEdge},${s.edgeAlpha + (0.72 - s.edgeAlpha) * s.focusT})`; ctx.lineWidth = 1.8
    ctx.beginPath()
    for (const l of s.links) {
      const a = l.source as GNode, b = l.target as GNode
      if (!a.vis || !b.vis || !hoverSet.has(a.id) || !hoverSet.has(b.id)) continue
      // the highlighted set is small; draw its edges unconditionally so a connector
      // whose endpoints are both just off-screen (but whose line crosses the view) isn't dropped
      ctx.moveTo(sx(a.x!), sy(a.y!)); ctx.lineTo(sx(b.x!), sy(b.y!))
    }
    ctx.stroke()
    for (const n of s.nodes) {
      if (!n.vis || !hoverSet.has(n.id)) continue
      drawNode(n, false)
    }
  }

  // labels - a player name is drawn only if it overlaps NO cup, NO player pill,
  // and NO already-placed name; otherwise it is dropped. Each name tries four
  // anchors (above / below / right / left) and takes the first collision-free slot.
  // Names appear only through interaction: the hovered/selected network's players all compete
  // for room (stars first; in a cut view that is everything on screen), while the idle graph
  // stays completely name-free.
  ctx.textBaseline = 'middle'
  // no hover and no selection means the candidate loop below can produce nothing (every
  // candidate needs isFocus or isPrimary) - skip the obstacle seeding outright rather than
  // build ~1,400 boxes per frame that nothing will ever query (every playback frame, and any
  // unfocused settle, lands here)
  if (!hoverSet && s.focusIds.size === 0) return
  type Box = { x: number; y: number; w: number; h: number }
  const hit = (b: Box, o: Box) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y
  // Obstacle lookups go through a grid of 128px buckets so each label only checks nearby boxes -
  // now that every player is a label candidate, comparing every label against every box would
  // grow with the SQUARE of the count (~1,300 candidates x 4 anchors x ~2,700 boxes at full range).
  const CELL = 128
  const grid = new Map<number, Box[]>()
  const gkey = (cx: number, cy: number) => cx * 100003 + cy // one number per cell: x is spread by a large prime so distinct (x,y) pairs practically never collide - and a rare collision only means one extra overlap check
  const addObstacle = (b: Box) => {
    const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + b.w) / CELL)
    const y0 = Math.floor(b.y / CELL), y1 = Math.floor((b.y + b.h) / CELL)
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const kk = gkey(cx, cy), arr = grid.get(kk)
      if (arr) arr.push(b); else grid.set(kk, [b])
    }
  }
  const blocked = (b: Box): boolean => {
    const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + b.w) / CELL)
    const y0 = Math.floor(b.y / CELL), y1 = Math.floor((b.y + b.h) / CELL)
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const arr = grid.get(gkey(cx, cy))
      if (arr) for (const o of arr) if (hit(b, o)) return true
    }
    return false
  }
  // Seed with every visible on-screen node; the grid then grows with each placed name so names
  // also avoid one another.
  for (const n of s.nodes) {
    if (!n.vis) continue
    const x = sx(n.x!), y = sy(n.y!), r = n.r * k
    if (n.type === 'cup') {
      if (!onScreen(x, y, r * CUP_EXT.up)) continue
      addObstacle({ x: x - CUP_EXT.halfW * r, y: y - CUP_EXT.up * r,
        w: 2 * CUP_EXT.halfW * r, h: (CUP_EXT.up + CUP_EXT.down) * r }) // glyph bbox
    } else {
      if (!onScreen(x, y, r + 12)) continue
      addObstacle({ x: x - r, y: y - r, w: 2 * r, h: 2 * r })
    }
  }

  type Cand = { n: GNode; x: number; y: number; pr: number; force: boolean }
  const cands: Cand[] = []
  for (const n of s.nodes) {
    if (!n.vis) continue
    if ((n._enter ?? 1) < 0.9) continue // no name before the node has bloomed in
    const x = sx(n.x!), y = sy(n.y!)
    if (!onScreen(x, y, 40)) continue
    if (n.type === 'cup') continue // championships label themselves inside the glyph
    const isFocus = !!(hoverSet && hoverSet.has(n.id))
    const isPrimary = s.focusIds.has(n.id)
    // no hover and no selection → no names at all; within a focused network, every member
    // competes for room, stars first (collision placement keeps a hovered roster a legible
    // subset rather than 25 piled-up labels)
    if (!isFocus && !isPrimary) continue
    // priority: selected names (100) always beat hover-network names (50-70); among the latter,
    // more Cups wins, capped so even an 11-Cup legend can never outrank a selected node
    const pr = isPrimary ? 100 : 50 + Math.min(20, n.rangeCupCount * 6)
    cands.push({ n, x, y, pr, force: isPrimary })
  }
  cands.sort((a, b) => b.pr - a.pr)
  // a name box that would leave the viewport counts as blocked - a half-clipped name at the
  // screen edge reads worse than none; forced (selected) names clamp back inside instead
  const inView = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H
  for (const c of cands) {
    const n = c.n, r = n.r * k
    const fs = n.rangeCupCount >= 2 ? 12 : 11
    ctx.font = (n.rangeCupCount >= 2 ? '700 ' : '500 ') + fs + 'px Inter,-apple-system,Segoe UI,Roboto,sans-serif'
    ctx.textAlign = 'center'
    const label = n.name!
    // measured widths depend only on (weight tier, label) - both stable across frames - so a
    // cut of a big franchise (~200 candidates, every frame of a settle) hits the cache instead
    // of re-measuring constants. Bounded: at most two entries per player name.
    const wKey = (fs === 12 ? 'b|' : 'n|') + label
    let w = labelWidths.get(wKey)
    if (w === undefined) { w = ctx.measureText(label).width; labelWidths.set(wKey, w) }
    const gap = 6, px = 5, py = 4
    const anchors: [number, number][] = [
      [c.x, c.y - r - gap - fs / 2],   // above
      [c.x, c.y + r + gap + fs / 2],   // below
      [c.x + r + gap + w / 2, c.y],    // right
      [c.x - r - gap - w / 2, c.y],    // left
    ]
    const mk = (lx: number, ly: number): Box => ({ x: lx - w / 2 - px, y: ly - fs / 2 - py, w: w + 2 * px, h: fs + 2 * py })
    let chosen: [number, number] | null = null
    for (const [lx, ly] of anchors) { const bb = mk(lx, ly); if (!blocked(bb) && inView(bb)) { chosen = [lx, ly]; break } }
    if (!chosen) {
      if (!c.force) continue // hover/selection focus is drawn even if cramped or at the edge…
      chosen = [ // …but clamped fully on-screen
        Math.max(w / 2 + px, Math.min(anchors[0][0], W - w / 2 - px)),
        Math.max(fs / 2 + py, Math.min(anchors[0][1], H - fs / 2 - py)),
      ]
    }
    const [lx, ly] = chosen
    addObstacle(mk(lx, ly))
    ctx.lineWidth = 3.2; ctx.strokeStyle = s.nameHalo; ctx.strokeText(label, lx, ly)
    ctx.fillStyle = s.nameFill; ctx.fillText(label, lx, ly)
  }
}

// Stanley Cup silhouette - outline traced from an official photograph of the real
// trophy (Wikimedia Commons "Stanley Cup, 2015", CC BY-SA 4.0): the silver cup was
// thresholded out of its white background, its per-row outer span extracted, then
// symmetrised and normalised to the glyph box (x:[-0.65,0.65], y:[-1.5,1.36] in node-radius
// units); the collar tiers were then de-lumped (the collar's width forced to only ever narrow
// upward, plus light smoothing) so the upper body reads cleanly at small node sizes. 136 points,
// drawn as one smooth curve that bends through each point between its neighbours' midpoints
// (canvas quadraticCurveTo) so the outline isn't a jagged polygon.
const CUP_PATH: readonly [number, number][] = [
  [0.082,-1.495], [0.246,-1.487], [0.312,-1.474], [0.368,-1.462], [0.407,-1.448],
  [0.428,-1.436], [0.434,-1.424], [0.432,-1.403], [0.424,-1.356], [0.412,-1.289],
  [0.395,-1.217], [0.372,-1.162], [0.342,-1.119], [0.303,-1.081], [0.243,-1.040],
  [0.191,-1.006], [0.154,-0.980], [0.159,-0.963], [0.179,-0.941], [0.208,-0.920],
  [0.232,-0.890], [0.245,-0.864], [0.252,-0.818], [0.258,-0.782], [0.267,-0.744],
  [0.278,-0.726], [0.285,-0.698], [0.288,-0.655], [0.289,-0.605], [0.289,-0.566],
  [0.291,-0.547], [0.300,-0.528], [0.316,-0.506], [0.329,-0.450], [0.333,-0.395],
  [0.335,-0.344], [0.344,-0.318], [0.370,-0.292], [0.413,-0.257], [0.460,-0.228],
  [0.499,-0.203], [0.525,-0.180], [0.541,-0.151], [0.555,-0.047], [0.563,0.060],
  [0.565,0.196], [0.566,0.279], [0.567,0.362], [0.568,0.442], [0.568,0.517],
  [0.571,0.590], [0.573,0.636], [0.573,0.716], [0.574,0.797], [0.574,0.881],
  [0.575,0.953], [0.576,1.018], [0.594,1.080], [0.615,1.102], [0.635,1.125],
  [0.644,1.153], [0.646,1.185], [0.638,1.218], [0.616,1.245], [0.579,1.271],
  [0.510,1.297], [0.405,1.322], [0.289,1.343], [0.089,1.355], [-0.289,1.343],
  [-0.405,1.322], [-0.510,1.297], [-0.579,1.271], [-0.616,1.245], [-0.638,1.218],
  [-0.646,1.185], [-0.644,1.153], [-0.635,1.125], [-0.615,1.102], [-0.594,1.080],
  [-0.576,1.018], [-0.575,0.953], [-0.574,0.881], [-0.574,0.797], [-0.573,0.716],
  [-0.573,0.636], [-0.571,0.590], [-0.568,0.517], [-0.568,0.442], [-0.567,0.362],
  [-0.566,0.279], [-0.565,0.196], [-0.563,0.060], [-0.555,-0.047], [-0.541,-0.151],
  [-0.525,-0.180], [-0.499,-0.203], [-0.460,-0.228], [-0.413,-0.257], [-0.370,-0.292],
  [-0.344,-0.318], [-0.335,-0.344], [-0.333,-0.395], [-0.329,-0.450], [-0.316,-0.506],
  [-0.300,-0.528], [-0.291,-0.547], [-0.289,-0.566], [-0.289,-0.605], [-0.288,-0.655],
  [-0.285,-0.698], [-0.278,-0.726], [-0.267,-0.744], [-0.258,-0.782], [-0.252,-0.818],
  [-0.245,-0.864], [-0.232,-0.890], [-0.208,-0.920], [-0.179,-0.941], [-0.159,-0.963],
  [-0.154,-0.980], [-0.191,-1.006], [-0.243,-1.040], [-0.303,-1.081], [-0.342,-1.119],
  [-0.372,-1.162], [-0.395,-1.217], [-0.412,-1.289], [-0.424,-1.356], [-0.432,-1.403],
  [-0.434,-1.424], [-0.428,-1.436], [-0.407,-1.448], [-0.368,-1.462], [-0.312,-1.474],
  [-0.246,-1.487]
]

// Darken a team colour toward black by t (0..1) for the cup and dynasty-dot rims. Team colours
// are #rrggbb; player dynasty blends arrive as rgb(r,g,b). Anything else falls back to a
// translucent black edge. Memoised because the draw loop now calls this per PLAYER per frame,
// not just per cup - and capped, since era changes mint fresh blend strings forever.
const RIM_MEMO = new Map<string, string>()
function darkenHex(color: string, t: number): string {
  const key = color + '|' + t
  const hit = RIM_MEMO.get(key)
  if (hit) return hit
  let r = -1, g = 0, b = 0
  const hx = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  const rg = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(color)
  if (hx) {
    let h = hx[1]; if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16)
  } else if (rg) { r = +rg[1]; g = +rg[2]; b = +rg[3] }
  const k = 1 - t
  const out = r < 0 ? 'rgba(0,0,0,0.45)' : `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`
  if (RIM_MEMO.size > 4096) RIM_MEMO.clear()
  RIM_MEMO.set(key, out)
  return out
}

// Fill the silhouette with one solid colour at (cx,cy), scaled to radius r, then add a thin
// team-darkened rim so the cup reads as a crisp object against the player dots it overlaps. The
// closed outline is drawn as quadratic segments through edge midpoints, which rounds the
// faceting/jitter of the raw polygon into smooth edges.
// The cup silhouette is the same 136-segment outline every frame, differing only by (cx,cy,r). Build
// it once as a unit Path2D (radius 1 at the origin) and blit it with a translate+scale instead of
// re-issuing 136 quadraticCurveTo calls per cup per frame. Falls back to a live trace where Path2D is
// unavailable (the headless test harness).
let unitCup: Path2D | null = null
function buildUnitCup(): Path2D | null {
  if (unitCup || typeof Path2D === 'undefined') return unitCup
  const p = CUP_PATH, n = p.length, path = new Path2D()
  const x1 = p[n - 1][0], y1 = p[n - 1][1], x2 = p[0][0], y2 = p[0][1]
  path.moveTo((x1 + x2) / 2, (y1 + y2) / 2) // start at the last edge's midpoint
  for (let i = 0; i < n; i++) {
    const ax = p[i][0], ay = p[i][1], bx = p[(i + 1) % n][0], by = p[(i + 1) % n][1]
    path.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2)
  }
  path.closePath()
  unitCup = path
  return unitCup
}

// Trace the silhouette onto ctx's current path at (cx,cy) scaled to r (fallback when Path2D is
// unavailable, e.g. the headless test harness; the Path2D paths translate+scale a cached unit path).
function traceCup(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const p = CUP_PATH, n = p.length
  ctx.beginPath()
  const x1 = cx + p[n - 1][0] * r, y1 = cy + p[n - 1][1] * r
  const x2 = cx + p[0][0] * r, y2 = cy + p[0][1] * r
  ctx.moveTo((x1 + x2) / 2, (y1 + y2) / 2)
  for (let i = 0; i < n; i++) {
    const ax = cx + p[i][0] * r, ay = cy + p[i][1] * r
    const bx = cx + p[(i + 1) % n][0] * r, by = cy + p[(i + 1) % n][1] * r
    ctx.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2)
  }
  ctx.closePath()
}

export function drawCup(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.lineJoin = 'round'
  const unit = buildUnitCup()
  if (unit) {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(r, r)
    ctx.fillStyle = color; ctx.fill(unit)
    // scale(r,r) also scales lineWidth, so divide by r to keep the rim's screen width at max(1, r*0.07)
    ctx.strokeStyle = darkenHex(color, 0.42); ctx.lineWidth = Math.max(1, r * 0.07) / r; ctx.stroke(unit)
    ctx.restore()
    return
  }
  traceCup(ctx, cx, cy, r)
  ctx.fillStyle = color; ctx.fill()
  ctx.strokeStyle = darkenHex(color, 0.42); ctx.lineWidth = Math.max(1, r * 0.07); ctx.stroke()
}

// Fill just the cup silhouette (no rim) with `color` at the current globalAlpha. Used to wash a dimmed
// cup toward the background so it fades WITHOUT becoming translucent (an opaque body still occludes).
export function fillCup(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  const unit = buildUnitCup()
  if (unit) {
    ctx.save(); ctx.translate(cx, cy); ctx.scale(r, r)
    ctx.fillStyle = color; ctx.fill(unit)
    ctx.restore()
    return
  }
  traceCup(ctx, cx, cy, r)
  ctx.fillStyle = color; ctx.fill()
}

// SVG path 'd' for the same cup silhouette (raw node-radius units, so it pairs with a viewBox of
// roughly x:[-0.66,0.66] y:[-1.5,1.36]) - lets the cup be reused as an inline HTML/CSS icon.
export function cupSvgPath(): string {
  const p = CUP_PATH, n = p.length
  const f = (v: number) => v.toFixed(3)
  const mid = (i: number, j: number, k: 0 | 1) => f((p[i][k] + p[j][k]) / 2)
  let d = `M${mid(n - 1, 0, 0)} ${mid(n - 1, 0, 1)}`
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    d += `Q${f(p[i][0])} ${f(p[i][1])} ${mid(i, j, 0)} ${mid(i, j, 1)}`
  }
  return d + 'Z'
}

// Conn Smythe Trophy silhouette - traced from an NHL photograph of the actual trophy (a silver maple
// leaf backing a Maple Leaf Gardens replica, on a tiered pedestal). The trophy was thresholded off
// its black background, its outer contour traced (marching squares, a standard outline-tracing
// method) and simplified, then
// normalised to height≈2 units, centred on x. 88 points, drawn as straight segments (the trophy is
// angular - leaf points + stepped base - so no smoothing). The signature maple leaf is scaled up
// and the base compressed so the leaf reads as the focal point. Pairs with a viewBox ≈ "-0.72 -1.04 1.44 2.08".
const CS_PATH: readonly [number, number][] = [
  [-0.499,1.0], [-0.497,0.966], [-0.442,0.836], [-0.429,0.818], [-0.373,0.795], [-0.305,0.623],
  [-0.267,0.565], [-0.267,0.389], [-0.241,0.29], [-0.455,0.178], [-0.613,0.109], [-0.542,0.062],
  [-0.488,0.053], [-0.462,-0.011], [-0.545,-0.078], [-0.53,-0.116], [-0.635,-0.206], [-0.556,-0.217],
  [-0.545,-0.259], [-0.575,-0.281], [-0.651,-0.439], [-0.643,-0.477], [-0.672,-0.529], [-0.681,-0.605],
  [-0.542,-0.586], [-0.497,-0.541], [-0.473,-0.572], [-0.398,-0.511], [-0.402,-0.628], [-0.383,-0.631],
  [-0.225,-0.48], [-0.267,-0.771], [-0.218,-0.775], [-0.166,-0.728], [-0.142,-0.737], [-0.128,-0.707],
  [-0.147,-0.771], [-0.138,-0.891], [-0.097,-0.872], [-0.086,-0.936], [0.016,-1.0], [0.068,-0.932],
  [0.094,-0.936], [0.106,-0.872], [0.128,-0.894], [0.147,-0.884], [0.155,-0.778], [0.128,-0.707],
  [0.158,-0.752], [0.174,-0.737], [0.276,-0.801], [0.234,-0.48], [0.347,-0.601], [0.392,-0.624],
  [0.411,-0.612], [0.407,-0.511], [0.482,-0.572], [0.497,-0.534], [0.542,-0.579], [0.565,-0.563],
  [0.61,-0.586], [0.662,-0.579], [0.681,-0.553], [0.614,-0.326], [0.553,-0.267], [0.565,-0.225],
  [0.643,-0.206], [0.546,-0.123], [0.539,-0.101], [0.561,-0.085], [0.471,-0.011], [0.489,0.024],
  [0.565,0.038], [0.572,0.069], [0.617,0.062], [0.629,0.08], [0.534,0.144], [0.478,0.154],
  [0.282,0.28], [0.311,0.399], [0.311,0.565], [0.35,0.628], [0.426,0.793], [0.469,0.813],
  [0.486,0.834], [0.572,0.991], [-0.426,0.99], [-0.494,0.992],
]
export function connSmytheSvgPath(): string {
  const p = CS_PATH, f = (v: number) => v.toFixed(3)
  let d = `M${f(p[0][0])} ${f(p[0][1])}`
  for (let i = 1; i < p.length; i++) d += `L${f(p[i][0])} ${f(p[i][1])}`
  return d + 'Z'
}

// Captain "C" - a hockey-jersey block letter (a thick ring open on the right with flat slab
// terminals), drawn as a glyph so it doesn't depend on a system font. Pairs with viewBox ≈ "-0.5 -0.5 0.98 1".
export const CAPTAIN_C_PATH =
  'M0.437 0.145L0.395 0.236L0.335 0.315L0.259 0.38L0.172 0.427L0.076 0.454L-0.024 0.459L-0.122 0.443' +
  'L-0.215 0.407L-0.297 0.351L-0.366 0.279L-0.417 0.193L-0.449 0.099L-0.46 0L-0.449 -0.099L-0.417 -0.193' +
  'L-0.366 -0.279L-0.297 -0.351L-0.215 -0.407L-0.122 -0.443L-0.024 -0.459L0.076 -0.454L0.172 -0.427' +
  'L0.259 -0.38L0.335 -0.315L0.395 -0.236L0.437 -0.145L0.21 -0.145L0.178 -0.183L0.139 -0.214L0.095 -0.237' +
  'L0.047 -0.251L-0.002 -0.255L-0.052 -0.25L-0.099 -0.235L-0.143 -0.211L-0.181 -0.179L-0.213 -0.141' +
  'L-0.236 -0.097L-0.25 -0.049L-0.255 0L-0.25 0.049L-0.236 0.097L-0.213 0.141L-0.181 0.179L-0.143 0.211' +
  'L-0.099 0.235L-0.052 0.25L-0.002 0.255L0.047 0.251L0.095 0.237L0.139 0.214L0.178 0.183L0.21 0.145Z'
