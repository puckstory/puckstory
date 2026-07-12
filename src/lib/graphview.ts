/*
 * graphview.ts - the interactive graph engine.
 *
 * GraphView owns everything that happens on the canvas: it runs a small physics simulation
 * (d3-force) to position the nodes, drives the camera (pan / zoom / auto-fit), tracks hover,
 * selection and node-dragging, recomputes the header stats, and hands a per-frame snapshot to
 * render.ts to paint. App.svelte creates ONE GraphView and talks to it through setState() plus a
 * handful of small methods (fit, reflow, selectNodes, setBg, clearSelection, ...).
 */
import {
  forceSimulation, forceManyBody, forceLink, forceCollide, forceX, forceY,
  type Simulation, type ForceX, type ForceY, type Force,
} from 'd3-force'
import { select } from 'd3-selection'
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type D3ZoomEvent } from 'd3-zoom'
import type { GNode, GLink, ViewState, Era } from './types'
import type { Model } from './model'
import { inEras, eraBounds, mergeEras, teamRgb } from './model'
import { draw, CUP_EXT } from './render'
import { isCoarsePointer } from './env'
import { FOREIGN_TUNE, OWNPULL_CSTR, ANNEAL, decayFor, FAST_TAIL, type SolveInput, type SolveResult } from './solve'
// the pre-solver runs in a worker so the UI never blocks; ?worker&inline keeps the single-file
// build a single file (the worker ships as an inlined blob and boots even from file://)
import SolveWorker from './solve.worker?worker&inline'

// a shared empty focus set for render() to pass when the story highlight is deferred (avoids a
// per-frame allocation; never mutated)
const EMPTY_FOCUS = new Set<string>()

// The background's own r,g,b - the light themes' label halo is painted in exactly this colour
// (a pure-white halo read as chalky boxes on the cream backgrounds; the bg-matched one melts in
// while still knocking out the edges under the text).
function bgRgb(c: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return '255,255,255'
  const n = parseInt(m[1], 16)
  return `${n >> 16},${(n >> 8) & 255},${n & 255}`
}
// A theme's --bg can be light (Latte, Solarized Light) or dark; the canvas edge/label ink is
// flipped by its perceived brightness so the network doesn't vanish on a light background.
function bgBrightness(c: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return 40 // assume a mid-dark theme
  const n = parseInt(m[1], 16)
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
}

export interface RangeStats {
  rangeStart: number; rangeEnd: number  // overall bounds of the selection
  eras: Era[]                           // the selected intervals (merged)
  champions: number; players: number; multi: number
  posCounts: { F: number; D: number; G: number }
  visible: number                       // nodes actually on screen (cut-aware, unlike the era counts)
}
/** Live playback state, mirrored to the App's transport panel. */
export interface PlaybackState {
  playing: boolean
  dir: 1 | -1        // 1 = assembling in show order, -1 = peeling back toward the show's anchor
  speed: number      // 0.5 | 1 | 2 | 4
  year: number | null // the year currently being revealed / retracted
  fromOldest: boolean // show order: false = newest-first (2026 down), true = oldest-first (1915 up)
}
export interface ViewCallbacks {
  onHover?: (n: GNode | null, cx: number, cy: number) => void
  onPlayback?: (st: PlaybackState | null) => void
  onStats?: (s: RangeStats) => void
  /** Fires with the full id list + cut flag whenever the selection or cut mode changes - App
   *  mirrors them into the ?focus= / ?cut= URL params so a copied link reproduces the exact view. */
  onSelection?: (ids: string[], cut: boolean, chain: boolean) => void
  /** Fires when a background tap is swallowed by cut-mode misclick protection - the UI pulses
   *  the scissors button as a "here's the way out" hint. */
  onCutNudge?: () => void
}

export class GraphView {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private m: Model
  private st: ViewState
  private cb: ViewCallbacks
  private W = 0; private H = 0; private dpr = 1
  private transform = { x: 0, y: 0, k: 1 }
  private sim: Simulation<GNode, GLink>
  private fx: ForceX<GNode>; private fy: ForceY<GNode>
  private zoomBeh: ZoomBehavior<HTMLCanvasElement, unknown>
  private hover: GNode | null = null
  private selSet = new Set<string>()  // multi-selection of pinned nodes
  private pressNode: GNode | null = null
  private dragNode: GNode | null = null
  private suppressHoverId: string | null = null // node just de-selected: don't re-highlight while parked on it
  // The selection is an exact CHAIN (Six Degrees): highlight and cut keep-set show precisely the
  // selected nodes - a linking Cup appears WITHOUT its whole roster. Any ordinary selection
  // change (click, search pick, card row) drops back to normal expand-to-network behaviour.
  private chainSel = false
  private cut = false                 // cut mode: HIDE everything outside the selection's network (see setCut)
  private focusT = 0                    // eased focus amount (0 = nothing dimmed, 1 = full dim); animates the hover fade
  private lastFocus: Set<string> | null = null // retained focus set so the dim can ease back out after hover ends
  // The highlight + focus sets change when the hover, selection, or chain changes, or when a filter pass
  // flips a selected anchor's visibility (highlightSet drops hidden anchors) - not during a settle or a
  // fade. Key them on a cheap signature of exactly those - filterGen covers the visibility case since
  // applyFilters bumps it - so the frames in between reuse the cached sets instead of re-walking the
  // adjacency and re-allocating. Any real input change re-keys, so the cache is never stale.
  private focusSig = '\0'
  private hsCache: Set<string> | null = null
  private fiCache = new Set<string>()
  private ensureFocusSets() {
    let sig = (this.hover ? this.hover.id : '') + '|' + (this.chainSel ? 1 : 0) + '|' + this.filterGen + '|'
    for (const id of this.selSet) sig += id + ','
    if (sig === this.focusSig) return
    this.focusSig = sig
    this.hsCache = this.highlightSet()
    this.fiCache = this.focusIds()
  }
  private raf = 0                       // pending scheduled frame - every repaint coalesces through it
  private downX = 0; private downY = 0
  private zDownX = 0; private zDownY = 0 // pointer at the start of a d3-zoom gesture
  private trackFit = false            // while true, the camera eases toward the live fit each tick
  private bg = '#1e1e2e'               // canvas background, set from the active theme
  // canvas ink, derived from bg luminance so edges/names stay legible on light themes too
  private edgeRgb = '150,170,205'
  private edgeAlpha = 0.14
  private nameFill = '#e8edf6'
  private nameHalo = 'rgba(6,9,16,0.92)'
  private hlEdge = '255,207,77'        // highlighted-network edge rgb: gold on dark themes, dark slate on light
  private ro: ResizeObserver | null = null
  private reshapeTimer: ReturnType<typeof setTimeout> | 0 = 0 // reshape waits until resizing pauses, not every pixel (see onResize)
  private lightBg = false // light-theme canvas: player fills use the darkened position palette
  private anchorRect: { left: number; top: number } | null = null // canvas position when anchorNextResize armed
  private anchorUntil = 0 // the arm expires (ms timestamp) so a no-op arm can't poison a later window resize
  // Playback ("A Brief History of Stanley"): champion-by-champion assembly in show order -
  // newest-first by default, oldest-first after an anchor flip. Each year lands in two beats -
  // the Cup alone, then its roster popping out of it; reversing peels years off in the opposite
  // order until only the show's first champion remains.
  private pb: {
    years: number[]    // show order: years[0] is the anchor the show builds from
    idx: number        // fully revealed years (cup + roster)
    halfCup: boolean   // years[idx]'s cup is on screen without its roster yet
    dir: 1 | -1
    speed: number
    playing: boolean
    timer: ReturnType<typeof setTimeout> | 0
  } | null = null
  private holdTimer: ReturnType<typeof setTimeout> | 0 = 0 // touch long-press-to-grab-a-node timer
  // --- touch gesture ownership (see the comment above onDown) ---
  private touchPtr: number | null = null   // pointerId of the finger whose gesture WE own (it started on a node)
  private touch2Ptr: number | null = null  // second finger during a manual pinch
  private touchMode: 'press' | 'drag' | 'pan' | 'pinch' | null = null
  private t1 = { x: 0, y: 0 }; private t2 = { x: 0, y: 0 } // the fingers' last client positions
  private zoomTouchActive = false // a d3-zoom TOUCH gesture is live (its first finger began on background)
  private dprMql: MediaQueryList | null = null // resolution media query, re-armed per dpr (see watchDpr)
  // On coarse-pointer devices the tooltip is TAP-driven (App docks it as a bottom sheet); mouse
  // hover still highlights but must not drive the tooltip - a stray trackpad/mouse move would
  // dismiss (or hijack) the sheet the user just tapped open.
  private tapTipOnly = isCoarsePointer() // must agree with App's dockTip (same probe, lib/env.ts)

  constructor(canvas: HTMLCanvasElement, model: Model, state: ViewState, cb: ViewCallbacks) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.m = model
    this.st = { ...state }
    this.cb = cb

    this.seedRing() // seed positions so the first frame isn't a blob

    // The layout is a tiny physics simulation (d3-force) with four forces that run every "tick":
    //   charge  - every node gently pushes the others away, so the graph spreads out instead of piling up.
    //   link    - each edge acts like a spring, pulling a player and a Cup they won toward a set distance.
    //   collide - nodes bounce off one another so their circles / Cup glyphs never overlap.
    //   x / y   - a soft pull toward each node's target spot (its timeline grid cell, or the centre).
    // The sim carries an "alpha" (its energy): it starts warm so things move, then cools until they rest.
    this.fx = forceX<GNode>((n) => n._tx ?? 0).strength(0.045)
    this.fy = forceY<GNode>((n) => n._ty ?? 0).strength(0.045)
    this.sim = forceSimulation<GNode>(model.nodes)
      .force('charge', forceManyBody<GNode>().strength((n) => -(24 + n.r * 4)).distanceMax(850).theta(0.85))
      .force('link', forceLink<GNode, GLink>(model.links).id((d: any) => d.id)
        .distance((l) => (l.source as GNode).r + (l.target as GNode).r + 52)
        .strength((l) => Math.min(0.85, 0.85 / Math.max(1, (l.source as GNode).rangeCupCount ?? 1))))
      // cups collide on their full glyph extent (~1.5r tall), pills on their circle,
      // so neither cups nor pills ever overlap one another. (Pill padding 5, not 9: part of the
      // territory tuning below - the wider halo overcrowded rosters and expelled their own
      // players into neighbouring franchises' space.)
      .force('collide', forceCollide<GNode>((n) => (n.type === 'cup' ? n.r * CUP_EXT.up : n.r + 5)).strength(0.95).iterations(3))
      // The territory quartet (tuned TOGETHER on the full dataset - each knob's combined optimum
      // sits well below its solo optimum, because all four target the same stragglers):
      //   cohesion - consecutive same-franchise cups chain together (links set per applyFilters)
      //   foreign  - players are pushed out of franchises they never won with
      //   ownpull  - multi-cup players drift toward their nearest own cup
      //   anneal   - the last stragglers glide home once the settle has converged
      // Together with the sector seeding (seedRing) they cut "player parked in a foreign
      // cluster" cases ~85-90% while keeping the blob's size, hybrid's time gradient, and the
      // settle budget intact; test/layout-territory.test.ts pins that. Timeline mode and
      // playback gate them (see applyFilters / each force).
      .force('cohesion', forceLink<GNode, GLink>([]).id((d: any) => d.id).distance(80))
      .force('foreign', this.makeForeignForce())
      .force('ownpull', this.makeOwnPullForce())
      .force('anneal', this.makeAnnealForce())
      .force('x', this.fx).force('y', this.fy)
      .on('tick', () => this.onTick())
      // the settle's final frame: keep EASING into the exact fit instead of calling fit()'s
      // instant transform - the tracking camera deliberately lags its target by ~16%/frame, and
      // snapping that residual in one jump read as an abrupt "clunk" at the end of every settle
      .on('end', () => { if (this.trackFit) { this.trackFit = false; this.glideFit() } this.releaseHighlight() })

    // The pre-solver (see the pre-solved transitions block above). Anything failing here - no
    // Worker in the environment, blob-URL workers blocked, test runners - degrades cleanly:
    // this.solver stays null and every view change uses the live-physics settle instead.
    try {
      this.solver = new SolveWorker()
      // hold the first frame(s) invisible until the solved layout lands (see revealCanvas / the
      // .stage canvas opacity transition in app.css). The safety timer is generous: a slow phone
      // full-range solve can take >1s, and revealing the seed early would reintroduce the very
      // teleport this hides - 4s only ever catches a genuinely hung worker.
      this.canvas.style.opacity = '0'
      this.bootRevealTimer = setTimeout(() => { this.bootRevealTimer = 0; this.canvas.style.opacity = '1' }, 4000)
      this.solver.onmessage = (e: MessageEvent<SolveResult>) => {
        this.solveBusy = false
        if (this.solveQueued && this.solver) { this.solveBusy = true; this.solver.postMessage(this.solveQueued); this.solveQueued = null }
        this.onSolved(e.data)
      }
      this.solver.onerror = () => {
        // a dying worker mid-solve must not leave the view frozen: drop the solver for the rest
        // of the session and finish the pending change with the live settle
        this.solver?.terminate()
        this.solver = null
        this.solveBusy = false; this.solveQueued = null
        this.revealCanvas() // if the worker died before the first present, un-hide the live settle
        if (this.pendingSolve) {
          const p = this.pendingSolve
          this.pendingSolve = null
          for (const nd of p.enter) delete nd._enter // the live settle shows them normally
          // finish the pending change with a live settle - but only if it is still the CURRENT
          // view and nothing else owns the graph (a stale generation, a running show, or an
          // active drag must not be reheated and refit out from under the user)
          if (p.gen === this.filterGen && !this.pb && !this.dragNode) {
            this.cancelTween()
            this.trackFit = true
            this.sim.alpha(0.7).restart()
          }
        }
      }
    } catch { this.solver = null }

    this.zoomBeh = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.04, 8])
      .filter((ev: any) => {
        if (ev.type === 'wheel') return true
        if (ev.type === 'mousedown') return !this.nodeAt(ev.clientX, ev.clientY) // pan only off-node
        if (ev.type === 'touchstart') {
          // a gesture WE own (it started on a node - see onDown) keeps d3-zoom out entirely,
          // including any later fingers: the manual pan/pinch below handles them instead
          if (this.touchPtr !== null || this.dragNode) return false
          if (ev.touches.length > 1) return true // two fingers from empty space: native pinch-zoom
          const t = ev.touches[0] // one finger: pan from empty space; touches ON a node are ours
          return !this.nodeAt(t.clientX, t.clientY)
        }
        return !ev.button
      })
      .on('start', (ev: any) => {
        // a USER gesture takes the camera: stop the settle landing, the tween's camera sweep
        // (nodes keep going), and mark the auto-fit stale. Programmatic transforms (fit(), the
        // chrome-toggle pin) also dispatch 'start' but carry no sourceEvent - they must not
        // cancel the very animations they cooperate with.
        if (ev.sourceEvent) {
          cancelAnimationFrame(this.glideRaf)
          if (this.tw) { this.tw.cam0 = this.tw.cam1 = null }
          this.autoFit = false
        }
        const s = ev.sourceEvent
        // remember when d3-zoom owns a live TOUCH gesture: a second finger landing on a NODE
        // during it must stay d3's (forming a native pinch) instead of being claimed by our
        // node paths - the two engines fighting over the transform froze the camera entirely
        if (s?.touches) this.zoomTouchActive = true
        const p = s && (s.changedTouches?.[0] ?? s.touches?.[0] ?? s) // touch: read the finger position
        this.zDownX = p ? p.clientX : 0; this.zDownY = p ? p.clientY : 0
      })
      .on('zoom', (ev: D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        // An ACTUAL pan/zoom (real sourceEvent, i.e. drag-move or wheel) means the user grabbed the
        // view - stop auto-tracking. A stationary background click fires start+end but no 'zoom', so
        // trackFit stays set and the settle's final fit still lands. Programmatic fits have no sourceEvent.
        const se: any = (ev as any).sourceEvent
        if (se) this.trackFit = false
        // a touch pan/zoom moves the graph out from under the tap-selected tooltip - dismiss it
        // (there is no hover on touch to refresh its position)
        if (se?.touches) this.cb.onHover?.(null, 0, 0)
        this.transform = { x: ev.transform.x, y: ev.transform.y, k: ev.transform.k }
        this.schedule()
      })
      .on('end', (ev: any) => {
        this.zoomTouchActive = false
        // A stationary tap/click on empty BACKGROUND clears the selection. d3-zoom owns background
        // touches and the background mouseup (it consumes them for panning), so the de-select is
        // detected here. Node presses are excluded from d3-zoom (see filter) and handled by onUp.
        const s = ev.sourceEvent
        if (!s || s.type === 'wheel') return
        const p = s.changedTouches?.[0] ?? s.touches?.[0] ?? s
        const cx = p.clientX ?? this.zDownX, cy = p.clientY ?? this.zDownY
        const stationary = Math.abs(cx - this.zDownX) + Math.abs(cy - this.zDownY) <= 4
        if (stationary && this.selSet.size) {
          // In cut mode, a background tap is far more likely a misclick than an intent to tear
          // down a deliberately carved view (most of the canvas IS background there, and losing
          // the selection would end the cut with it). Exiting stays explicit: the lit scissors
          // or Reset. The tap still dismisses the tooltip, and the scissors pulses so the way
          // out stays discoverable.
          if (this.cut) { this.cb.onHover?.(null, cx, cy); this.cb.onCutNudge?.(); return }
          this.chainSel = false; this.selSet.clear(); this.selectionChanged(); this.cb.onHover?.(null, cx, cy); this.computeStats(); this.schedule()
        } else if (stationary && this.hover) {
          // only inspecting (a tap-to-inspect during playback/cut, no selection): drop the highlight + card
          this.hover = null; this.schedule(); this.cb.onHover?.(null, cx, cy)
        }
      })
    // wheel-zoom + drag-pan only; kill d3-zoom's default double-click-to-zoom, which otherwise
    // fires when you click a node twice (select then deselect) and yanks the camera in
    select(this.canvas).call(this.zoomBeh as any).on('dblclick.zoom', null)

    // Pointer (not mouse) events, so one path covers mouse + pen; background touches are left to
    // d3-zoom (pan / pinch-zoom + tap-to-deselect in its 'end' handler), touches that start on a
    // node are handled entirely here (tap / hold-drag / pan / pinch - see onDown).
    this.canvas.addEventListener('pointerdown', this.onDown)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    // the browser can take a gesture away mid-stream (notification shade, incoming call, screen
    // lock): release everything a pointerup would have, or the node stays pinned and the sim
    // keeps simmering at alphaTarget 0.3 forever
    window.addEventListener('pointercancel', this.onCancel)
    window.addEventListener('resize', this.onResize)
    this.ro = new ResizeObserver(() => this.onResize())
    this.ro.observe(this.canvas)
    this.watchDpr()

    this.resize()
    // Settle ASYNCHRONOUSLY, exactly like a runtime era/layout change (the path every setState takes):
    // kick the sim and let onTick ease the camera to the live fit each frame, then stop on 'end'.
    // fit() frames the seeded layout for an immediate, well-composed first paint that then eases into
    // the settled network - instead of blocking the main thread on a synchronous 320-tick settle,
    // which froze first paint ~400ms at the default era and ~2s if deep-linked to the full range.
    this.applyFilters(true, true)
    this.fit()
  }

  /* ---------- public ---------- */
  setState(patch: Partial<ViewState>) {
    const prev = this.st
    this.st = { ...this.st, ...patch }
    const layoutChanged = patch.layoutMode && patch.layoutMode !== prev.layoutMode
    const rangeOrPos = patch.eras !== undefined ||
      patch.positions !== undefined || patch.multiOnly !== undefined
    // any real view change ends a running playback (its visibility regime no longer applies)
    const hadPb = !!this.pb
    if (hadPb) this.stopPlayback(false)
    // Any change to which nodes are visible or how they're laid out - eras, position pills,
    // multi-Cup, or a layout switch - re-runs the simulation and seamlessly re-frames the camera
    // so the selection keeps filling the window. Colour is render-only.
    if (rangeOrPos || layoutChanged || hadPb) this.applyFilters(true, true)
    else this.schedule()
  }
  /** Re-measure the canvas box, reshape the aspect-dependent layout, and re-frame, so the graph
   *  fills the new space. (Goes through applyFilters, not a bare fit, so the timeline grid
   *  re-columns to the new aspect.) Chrome show/hide deliberately does NOT use this - see
   *  anchorNextResize: the graph must not move when only the bar changes height. */
  reflow() { this.resize(); this.applyFilters(true, true) }
  /** Seed a fresh Network-style ring: cups on an index ring, players scattered around their first Cup.
   *  Used at construction and re-run whenever the layout switches (back) to Network, so the toggle
   *  produces a genuinely fresh layout rather than relaxing the previous mode's blob. */
  private seedRing() {
    this.m.cups.forEach((n, i) => {
      const a = (i / this.m.cups.length) * Math.PI * 2 - Math.PI / 2
      n.x = Math.cos(a) * 360; n.y = Math.sin(a) * 360
    })
    // Sector seeding: each player starts in a cone on the side of his anchor FACING AWAY from
    // the nearest foreign franchise's cup - born in his own territory instead of uniformly
    // around the anchor. Roughly halves cross-cluster misplacement before any force acts, and
    // costs nothing at steady state. Anchor = the centroid of a multi-cup career (the springs
    // will hold him between his cups anyway), or the lone cup itself.
    for (const n of this.m.nodes) {
      if (n.type !== 'player') continue
      const franchises = new Set(n.cups!.map((c) => c.abbr))
      let ax = 0, ay = 0
      for (const c of n.cups!) { const cup = this.m.nodeById.get('cup-' + c.year); ax += cup?.x ?? 0; ay += cup?.y ?? 0 }
      ax /= n.cups!.length; ay /= n.cups!.length
      let best = Infinity, bx = 1, by = 0
      for (const o of this.m.cups) {
        if (franchises.has(o.abbr!)) continue
        const d = (o.x! - ax) ** 2 + (o.y! - ay) ** 2
        if (d < best) { best = d; bx = o.x! - ax; by = o.y! - ay }
      }
      const a = Math.atan2(-by, -bx) + (Math.random() - 0.5) * (Math.PI / 2)
      const rr = 90 + Math.random() * 100
      n.x = ax + Math.cos(a) * rr; n.y = ay + Math.sin(a) * rr
      n.vx = 0; n.vy = 0
    }
  }

  /* ---------- the territory forces ----------
     Empirically tuned as a SET on the full dataset (129 cups x 1306 players, 3 seeds, both
     layouts): the goal is that no player reads as part of a franchise he never won with, without
     collapsing the blob (area held), breaking hybrid's top-to-bottom time gradient (year-y
     correlation stays > 0.97), or blowing the settle budget (all four together add ~0.5ms to a
     ~6ms tick). Every force reads the ACTIVE node set from its initialize() - sim.nodes(active)
     in applyFilters re-runs those, so era / cut / position / playback filtering is respected
     with no extra bookkeeping here. Foreign/anneal sit out during playback (entrances must pop
     out of their Cup and tiny early assemblies would be scattered); everything sits out in
     timeline, whose grid pins ARE the layout. */
  // which regime the per-tick forces run in - set by applyFilters, read at tick time
  private clusterFx: 'net' | 'hyb' | 'off' = 'hyb'
  // timeline/hybrid grid cell pitch, stored by timelineTargets (px between adjacent year cells)
  private gridS = 150
  // the settle's designed decay rate (set per restart); onTick steepens it below alpha .02
  private baseAlphaDecay = decayFor(true)
  /* ---------- pre-solved transitions ----------
     Every view change (era, filter, layout, cut - anything but playback and drag) is SOLVED to
     its final resting layout in a worker first, then presented as ONE eased tween from the
     current view to that known final: the visible animation is a designed interpolation, smooth
     from first frame to last, landing exactly at the resting state - never live physics with its
     decaying tail. The live simulation stays fully wired as the fallback (no Worker, worker
     death) and remains the engine for playback beats and drag re-heats. */
  private solver: Worker | null = null
  private solveBusy = false            // one solve in flight at a time...
  private solveQueued: SolveInput | null = null // ...the LATEST superseding request waits (older ones drop)
  private hasPresented = false // first solved layout is applied instantly (nothing to animate from)
  // FIRST-PAINT reveal: with a worker, boot holds the canvas invisible (the page shows solid --bg)
  // until the first solved layout is ready, then fades it in - so the compact ring SEED never
  // flashes on screen only to teleport to the settled layout a beat later. A safety timer force-
  // reveals if no solve ever arrives (a hung worker degrades to the seed, not a blank screen).
  private bootRevealTimer: ReturnType<typeof setTimeout> | 0 = 0
  private revealCanvas() {
    if (this.bootRevealTimer) { clearTimeout(this.bootRevealTimer); this.bootRevealTimer = 0 }
    this.canvas.style.opacity = '1'
  }
  // the camera currently shows an AUTO fit (solved presentation / fit / glide) that no user
  // gesture has overridden - a chrome-toggle resize arriving PROMPTLY after it (the boot
  // restore on short landscape phones) re-frames for the new geometry instead of only pinning;
  // once the view has sat quietly the pin wins, as ever (chrome toggles must not move the graph)
  private autoFit = false
  private autoFitAt = 0
  private pendingSolve: {
    gen: number; nodes: GNode[]; wantFit: boolean
    enter: GNode[] // nodes NEW to this view - hidden through the solve, then bloomed out of their cup
    ghosts: { n: GNode; x0: number; y0: number; cup: GNode | null }[] // nodes that left - fade into their cup
  } | null = null
  private tw: {
    nodes: GNode[]; x0: Float64Array; y0: Float64Array; x1: Float64Array; y1: Float64Array
    cx: Float64Array; cy: Float64Array   // per-node bezier control (curved, not shoved, paths)
    del: Float64Array                    // per-node start delay - the chronological wave
    isEnter: Uint8Array
    ghosts: { n: GNode; x0: number; y0: number; cup: GNode | null }[]
    cam0: { x: number; y: number; k: number } | null; cam1: { x: number; y: number; k: number } | null
    t0: number; travel: number; total: number; raf: number
  } | null = null
  // per-frame ghost snapshot handed to render() while a transition plays
  private ghostDraw: { n: GNode; x: number; y: number; r: number; a: number }[] | null = null
  // A story applies its era filter AND its highlighted network in one action, but the two should
  // read as a SEQUENCE: the map transitions into place first, then the story's connection lights
  // up. The selection is set logically at once (URL / undo / onSelection fire normally); only its
  // VISUAL (the dim + the lit corridor) is held back - focusT stays pinned at 0 while the
  // transition runs, then eases in once it lands. Cleared on every fresh relayout (applyFilters
  // top) and armed by restoreView only when that relayout will actually transition.
  private highlightDeferred = false
  private releaseHighlight() { if (this.highlightDeferred) { this.highlightDeferred = false; this.schedule() } }
  // the cohesion chain set + params of the CURRENT view (built per applyFilters, shared by the
  // live force and the solve payload so the two can never disagree)
  private chainPairs: [GNode, GNode][] = []
  private chainDist = 80
  private chainK = 0.1

  /** Foreign-cup repulsion: push each player away from nearby cups of franchises he never won
   *  with. The two layouts want OPPOSITE regimes: network's ring seed needs the hot phase free
   *  to organise (ungated pushes scatter rosters before their springs engage), so it engages
   *  only below alpha .45 with a sharp near-cup falloff; hybrid starts pre-organised from the
   *  timeline grid and takes a longer-range, linear, always-on push. Squared-distance early-outs
   *  keep the full-range cost at ~0.3-0.5ms/tick; the player -> foreign-cup lists rebuild only
   *  when the sim's node set changes, never per tick. */
  private makeForeignForce(): Force<GNode, GLink> {
    let pairs: [GNode, GNode[]][] = []
    const force = (alpha: number) => {
      if (this.clusterFx === 'off' || this.pb) return
      const { strength, radius: R, gate, linear } = FOREIGN_TUNE[this.clusterFx]
      if (alpha >= gate) return
      for (const [n, foreign] of pairs) {
        for (const c of foreign) {
          const dx = n.x! - c.x!
          if (dx > R || dx < -R) continue
          const dy = n.y! - c.y!
          if (dy > R || dy < -R) continue
          const d2 = dx * dx + dy * dy
          if (d2 >= R * R || d2 < 1e-4) continue
          const d = Math.sqrt(d2)
          const w = linear ? 1 - d / R : Math.min(3, R / d - 1) / 3 // ramp to 0 at R | strong near the cup
          const k = (strength * w * alpha) / d
          n.vx! += dx * k; n.vy! += dy * k
        }
      }
    }
    ;(force as unknown as { initialize: (nodes: GNode[]) => void }).initialize = (nodes) => {
      const cups = nodes.filter((n) => n.type === 'cup')
      pairs = []
      for (const n of nodes) {
        if (n.type !== 'player') continue
        // CAREER franchise set: a cup he actually won with never repels him, even when that win
        // is outside the current era range
        const mine = new Set(n.cups!.map((c) => c.abbr))
        const foreign = cups.filter((c) => !mine.has(c.abbr!))
        if (foreign.length) pairs.push([n, foreign])
      }
    }
    return force as Force<GNode, GLink>
  }

  /** Own-territory pull: multi-cup players drift toward their nearest VISIBLE own cup. Their
   *  springs are deliberately weak (strength splits across their cups - see the link force), so
   *  charge pressure can strand them in no-man's-land between wins; this reels them toward
   *  whichever of their own camps is closest. Single-cup players already sit tight on one strong
   *  spring and are skipped. Runs through playback too - it only ever reinforces assembly. */
  private makeOwnPullForce(): Force<GNode, GLink> {
    let entries: [GNode, GNode[]][] = []
    const force = (alpha: number) => {
      if (this.clusterFx === 'off') return
      const k = OWNPULL_CSTR * alpha
      for (const [n, own] of entries) {
        let best = Infinity, bx = 0, by = 0
        for (const c of own) {
          const d = (n.x! - c.x!) ** 2 + (n.y! - c.y!) ** 2
          if (d < best) { best = d; bx = c.x!; by = c.y! }
        }
        n.vx! += (bx - n.x!) * k; n.vy! += (by - n.y!) * k
      }
    }
    ;(force as unknown as { initialize: (nodes: GNode[]) => void }).initialize = (nodes) => {
      entries = []
      for (const n of nodes) {
        if (n.type !== 'player') continue
        const own: GNode[] = []
        for (const c of n.cups!) { const cup = this.m.nodeById.get('cup-' + c.year); if (cup?.vis) own.push(cup) }
        if (own.length >= 2) entries.push([n, own])
      }
    }
    return force as Force<GNode, GLink>
  }

  /** End-game anneal: once a settle is largely organised (alpha < .12), snapshot the
   *  players still parked nearer a foreign franchise than 1.5x their own distance - the
   *  stragglers every steady-state force failed to place - and glide exactly those toward their
   *  nearest own cup at a few px per tick. The whole glide lives INSIDE the settle's last
   *  coherent stretch (alpha .12 down to the .02 sim floor, ~45 ticks) and its strength fades
   *  to exactly ZERO at the floor, so the stragglers land WITH the rest of the graph in one
   *  motion - no second act of crawling dots after the bulk has parked, and no mid-stride
   *  freeze. K is higher than the old constant-speed version to fit the correction into the
   *  shorter window. The snapshot clears whenever alpha rises again, so every re-heat (drag,
   *  filter, layout switch) re-arms it; the periodic re-census both catches stragglers that
   *  form late and releases the already-repaired. */
  private makeAnnealForce(): Force<GNode, GLink> {
    const { TH: ALPHA_TH, K, RISK, FADE_FROM, FLOOR, RESNAP } = ANNEAL
    let players: GNode[] = [], cups: GNode[] = []
    let targets: [GNode, GNode[]][] | null = null
    let sinceSnap = 0
    const force = (alpha: number) => {
      if (this.clusterFx === 'off' || this.pb || alpha > ALPHA_TH) { targets = null; return }
      // re-census every RESNAP ticks: starting at .08 means the layout is still moving, so a
      // single snapshot both misses stragglers that form later AND keeps boosting players who
      // have already made it home - the refresh catches the former and releases the latter
      if (targets && ++sinceSnap >= RESNAP) targets = null
      if (!targets) {
        targets = []
        sinceSnap = 0
        for (const n of players) {
          const mineYears = new Set(n.cups!.map((c) => c.year))
          const franchises = new Set(n.cups!.map((c) => c.abbr))
          const own: GNode[] = []
          let od = Infinity, fd = Infinity
          for (const c of cups) {
            const d = (n.x! - c.x!) ** 2 + (n.y! - c.y!) ** 2
            if (mineYears.has(c.year!)) { own.push(c); od = Math.min(od, d) }
            else if (!franchises.has(c.abbr!)) fd = Math.min(fd, d)
          }
          if (own.length && Math.sqrt(fd) < Math.sqrt(od) * RISK) targets.push([n, own])
        }
      }
      // full glide from .08 to .05, then fade linearly to ZERO at the sim's own stopping alpha
      const kEff = K * Math.min(1, Math.max(0, alpha - FLOOR) / (FADE_FROM - FLOOR))
      for (const [n, own] of targets) {
        let best = Infinity, bc = own[0]
        for (const c of own) { const d = (n.x! - c.x!) ** 2 + (n.y! - c.y!) ** 2; if (d < best) { best = d; bc = c } }
        const d = Math.sqrt(best) || 1
        n.vx! += ((bc.x! - n.x!) / d) * kEff; n.vy! += ((bc.y! - n.y!) / d) * kEff
      }
    }
    ;(force as unknown as { initialize: (nodes: GNode[]) => void }).initialize = (nodes) => {
      players = nodes.filter((n) => n.type === 'player')
      cups = nodes.filter((n) => n.type === 'cup')
      targets = null
    }
    return force as Force<GNode, GLink>
  }

  /** Arm the NEXT stage resize (within ~400ms) to keep the graph pinned to the SCREEN: the canvas
   *  box is re-measured, but the camera shifts by exactly how far the canvas moved, so nothing
   *  rescales or jumps. Hiding/restoring the top bar or toggling a submenu announces itself here;
   *  unannounced resizes (a real window resize) keep the usual refit + reshape. The deadline lets
   *  a no-op arm (desktop submenu toggles never change the stage) expire harmlessly. */
  anchorNextResize() {
    const r = this.canvas.getBoundingClientRect()
    this.anchorRect = { left: r.left, top: r.top }
    this.anchorUntil = Date.now() + 400
  }
  setBg(c: string) {
    if (!c || c === this.bg) return
    this.bg = c
    const lum = bgBrightness(c) // flip canvas ink for light themes so edges/names don't vanish
    const light = lum > 150
    this.lightBg = light // player fills switch to the darkened position palette (render.ts)
    this.edgeRgb = light ? '92,104,128' : '150,170,205'
    // Edge opacity by background: intensity chosen so the 0.8px lines read strongly without being
    // thicker. 0.30 on the dark themes, lifted further where contrast is worst: dark edges on a light
    // bg and light edges on a near-black (AMOLED) bg.
    this.edgeAlpha = light ? 0.46 : (lum < 14 ? 0.40 : 0.30)
    this.nameFill = light ? '#33373f' : '#e8edf6'
    this.nameHalo = light ? `rgba(${bgRgb(c)},0.92)` : 'rgba(6,9,16,0.92)'
    // gold highlight edges vanish on light backgrounds, so use a dark slate there instead
    this.hlEdge = light ? '40,44,52' : '255,207,77'
    this.schedule()
  }
  private selectionChanged() {
    // the cut keep-set follows the selection LIVE (add/remove nodes reshapes it); an emptied
    // selection ends the cut - a cut to nothing would just blank the canvas
    if (this.cut) {
      if (!this.selSet.size) this.cut = false
      this.applyFilters(true, true)
    }
    this.cb.onSelection?.([...this.selSet], this.cut, this.chainSel)
  }
  /** Cut mode: keep only the selection's network - the selected nodes plus everything directly
   *  connected (a cup's roster, a player's cups) - and HIDE the rest outright instead of fading
   *  it. The keep-set is re-derived from the live selection on every filter pass, so changing the
   *  era afterwards reveals the selection's nodes in the new range (a team's other Cups, a
   *  player's other rosters) while everything unconnected stays gone. */
  setCut(on: boolean) {
    if (on === this.cut) return
    if (on && !this.selSet.size) return // nothing selected - nothing to cut to
    this.cut = on
    this.applyFilters(true, true)
    this.cb.onSelection?.([...this.selSet], this.cut, this.chainSel)
  }
  clearSelection() { this.chainSel = false; this.selSet.clear(); this.hover = null; this.selectionChanged(); this.computeStats(); this.schedule() }
  /** Drop a transient inspect highlight when its card is dismissed (the tap-to-inspect path during playback/cut). */
  dismissHover() { if (this.hover) { this.hover = null; this.schedule() } }
  setSelection(id: string | null) { this.chainSel = false; this.selSet = new Set(id ? [id] : []); this.selectionChanged(); this.computeStats(); this.schedule() }
  /** Add these node ids to the selection (on top of whatever is already selected) - the search
   *  dropdown uses this to add a player (one id) or a whole team (all its Cup ids), exactly as if
   *  the nodes had been clicked, which builds a selection up rather than replacing it. */
  selectNodes(ids: string[]) { this.chainSel = false; for (const id of ids) this.selSet.add(id); this.hover = null; this.suppressHoverId = null; this.selectionChanged(); this.computeStats(); this.schedule() }
  /** Replace the selection WHOLESALE - the undo/redo restore path. Unknown ids are dropped;
   *  selectionChanged() handles the cut keep-set (and ends the cut if the set comes back empty). */
  setSelectionIds(ids: string[]) {
    this.chainSel = false
    this.selSet = new Set(ids.filter((id) => this.m.nodeById.has(id)))
    this.hover = null
    this.suppressHoverId = null
    this.selectionChanged()
    this.computeStats()
    this.schedule()
  }
  /** Replace the selection with an exact CHAIN (Six Degrees): only these nodes highlight - a
   *  linking Cup shows without its roster - and a later cut keeps only the chain itself. */
  selectChain(ids: string[]) {
    this.selSet = new Set(ids.filter((id) => this.m.nodeById.has(id)))
    this.chainSel = this.selSet.size > 0
    this.hover = null
    this.suppressHoverId = null
    this.selectionChanged()
    this.computeStats()
    this.schedule()
  }
  /** Atomic undo/redo restore: apply a ViewState patch, replace the selection wholesale, and
   *  set the cut flag - with at most ONE refilter + sim restart. The piecewise path
   *  (setState + setSelectionIds + setCut) restarted the settle twice whenever a single undo
   *  step crossed a cut boundary. */
  restoreView(patch: Partial<ViewState>, ids: string[], cut: boolean, chain = false, deferHighlight = false) {
    const hadPb = !!this.pb
    if (hadPb) this.stopPlayback(false)
    // only these keys change which nodes are visible / where they sit - the same set setState
    // refilters for. A colorMode-only patch (undoing a colour toggle) must NOT reheat the
    // settled simulation or refit the camera: colour is render-only.
    const visPatch = patch.eras !== undefined || patch.positions !== undefined ||
      patch.multiOnly !== undefined || patch.layoutMode !== undefined
    this.st = { ...this.st, ...patch }
    const next = new Set(ids.filter((id) => this.m.nodeById.has(id)))
    const selChanged = next.size !== this.selSet.size || [...next].some((id) => !this.selSet.has(id))
    this.selSet = next
    const chainChanged = (chain && next.size > 0) !== this.chainSel
    this.chainSel = chain && next.size > 0
    const newCut = cut && next.size > 0
    const cutChanged = newCut !== this.cut
    this.cut = newCut
    this.hover = null
    this.suppressHoverId = null
    // a refilter is only owed when the visible set can actually change: a state patch, a cut
    // transition, or a selection/chain change while cut (the keep-set follows both)
    const willTransition = hadPb || visPatch || cutChanged || (newCut && (selChanged || chainChanged))
    if (willTransition) this.applyFilters(true, true)
    else { this.computeStats(); this.schedule() }
    // arm the deferred highlight ONLY when there is a transition to wait for (applyFilters cleared
    // the flag; set it AFTER so it sticks). No transition → nothing to wait for → highlight shows now.
    this.highlightDeferred = deferHighlight && willTransition
    this.cb.onSelection?.([...this.selSet], this.cut, this.chainSel)
  }

  /* ---------- playback ("A Brief History of Stanley") ---------- */
  /** Begin the show: clear any selection/cut, reveal the newest champion's Cup alone, then walk
   *  back a year at a time - two beats per year (the Cup, then its roster pops out). */
  startPlayback() {
    if (this.pb?.timer) clearTimeout(this.pb.timer)
    if (this.selSet.size || this.cut) {
      this.cut = false; this.chainSel = false; this.selSet.clear(); this.selectionChanged()
    }
    this.hover = null
    this.suppressHoverId = null
    const years = this.m.cups.map((c) => c.year!).sort((a, b) => b - a)
    this.pb = { years, idx: 0, halfCup: true, dir: 1, speed: 1, playing: true, timer: 0 }
    this.insetPB = 84 // the transport docks bottom-centre - reserve a strip so the show frames ABOVE it (App refines this to the bar's real height)
    this.applyFilters(true, true)
    this.emitPb()
    this.armPb()
  }
  /** End the show and return to the normal era view. reapply=false when the caller
   *  (setState/restoreView) runs its own refilter anyway. */
  stopPlayback(reapply = true) {
    if (!this.pb) return
    if (this.pb.timer) clearTimeout(this.pb.timer)
    this.pb = null
    this.insetPB = 0
    const gen = this.filterGen
    this.cb.onPlayback?.(null)
    // App's ended handler restores the pre-show view synchronously (applySnap -> restoreView ->
    // applyFilters + restart); a second identical pass here would re-walk every node and link
    // and reheat the sim for nothing - only reapply if the callback did NOT already refilter
    if (reapply && this.filterGen === gen) this.applyFilters(true, true)
  }
  playbackToggle() {
    if (!this.pb) return
    const pb = this.pb
    pb.playing = !pb.playing
    if (pb.playing) {
      // Play from a parked terminal turns around instead of dying: pressing Play on the fully
      // assembled show unwinds it, and at the anchor it rebuilds. (Without this, stepPb would
      // hit the same terminal guard and silently re-park after one beat.)
      if (pb.dir === 1 && !pb.halfCup && pb.idx >= pb.years.length) pb.dir = -1
      else if (pb.dir === -1 && pb.idx <= 1 && (!pb.halfCup || pb.idx === 0)) pb.dir = 1
      this.armPb()
    } else if (pb.timer) { clearTimeout(pb.timer); pb.timer = 0 }
    this.emitPb()
  }
  /** The rewind/forward transport: play the reveals in a given direction, or - if that direction
   *  is ALREADY the one playing - pause. dir 1 assembles (forward through the show), dir -1 peels
   *  the reveals back. Pressing a direction that has nowhere left to go (forward at the fully
   *  assembled end, back at the anchor) just points the arrow there and stays parked, rather than
   *  silently turning around the way a single Play button has to. */
  playbackPlayDir(dir: 1 | -1) {
    const pb = this.pb
    if (!pb) return
    if (pb.playing && pb.dir === dir) { // clicking the lit direction pauses
      pb.playing = false
      if (pb.timer) { clearTimeout(pb.timer); pb.timer = 0 }
      this.emitPb()
      return
    }
    pb.dir = dir
    // headroom in the requested direction? (mirror of stepPb's advance conditions)
    const canGo = dir === 1
      ? pb.halfCup || pb.idx < pb.years.length
      : (pb.halfCup && pb.idx > 0) || pb.idx > 1
    pb.playing = canGo
    if (canGo) this.armPb()
    else if (pb.timer) { clearTimeout(pb.timer); pb.timer = 0 }
    this.emitPb()
  }
  /** A directional play button on the TIME axis: toward +1 plays toward NEWER years, -1 toward
   *  OLDER. From a lone pivot (a fresh year-jump - one champion showing, parked) the first press
   *  CHOOSES the exploration direction: rebuild the reveal order from the pivot toward those years
   *  and play. Otherwise it's the running show - translate the time direction into this ordering's
   *  assemble/peel dir and hand off to playbackPlayDir (same-direction press pauses, opposite one
   *  reverses). Peeling that has already reached the anchor re-pivots and CONTINUES past it into
   *  the other half of history (jump to 1999, play up, reverse: the show walks back down to 1999
   *  and then keeps going into 1998, 1997, ... instead of parking on the pivot as a dead end).
   *  This is what the ◀ / ▶ transport buttons call. */
  playbackPlay(toward: 1 | -1) {
    const pb = this.pb
    if (!pb) return
    if (pb.years.length === 1) { // lone pivot: the press picks which way to roll off it
      const pivot = pb.years[0]
      const all = this.m.cups.map((c) => c.year!)
      const ys = all.filter((y) => (toward === 1 ? y >= pivot : y <= pivot)).sort((a, b) => (toward === 1 ? a - b : b - a))
      if (ys.length < 2) return // pivot is the newest/oldest champion - nothing to roll toward this way; stay parked on it
      pb.years = ys
      pb.idx = 0; pb.halfCup = true; pb.dir = 1; pb.playing = true
      this.applyFilters(true, true)
      this.emitPb()
      this.armPb()
      return
    }
    const asc = pb.years[0] < pb.years[pb.years.length - 1] // ascending order == assembling toward newer
    const dir = (asc ? toward : -toward) as 1 | -1
    // Peel with NO headroom = the show sits on its anchor already. After a year-jump that anchor
    // is a mid-century pivot, and this press asks to continue PAST it - so re-pivot on the anchor
    // and roll off its other side, the exact mirror of the lone-pivot first press above. At the
    // true ends of history the filter finds nothing to roll toward and the parked behavior stands.
    if (dir === -1 && !((pb.halfCup && pb.idx > 0) || pb.idx > 1)) {
      const pivot = pb.years[0]
      const all = this.m.cups.map((c) => c.year!)
      const ys = all.filter((y) => (toward === 1 ? y >= pivot : y <= pivot)).sort((a, b) => (toward === 1 ? a - b : b - a))
      if (ys.length >= 2) {
        pb.years = ys
        pb.idx = 0; pb.halfCup = true; pb.dir = 1; pb.playing = true
        this.applyFilters(true, true)
        this.emitPb()
        this.armPb()
        return
      }
    }
    this.playbackPlayDir(dir)
  }
  /** Flip the direction and keep going - reversing mid-show plays the reveals back in the
   *  opposite order (and un-pauses, so flipping at either end resumes from there). */
  playbackDir() {
    if (!this.pb) return
    this.pb.dir = this.pb.dir === 1 ? -1 : 1
    if (!this.pb.playing) { this.pb.playing = true; this.armPb() }
    this.emitPb()
  }
  /** Jump to the OTHER end of history and rebuild from there: a show running 2026-down restarts
   *  at 1915 playing up the years, and vice versa. Lands on the anchor Cup alone, playing. Rebuilds
   *  the FULL century in the flipped order (not just a reverse) so a prior year-jump that trimmed
   *  the reveal list to one side can't shrink the anchor swap's range. */
  playbackFlip() {
    if (!this.pb) return
    const asc = this.pb.years[0] < this.pb.years[this.pb.years.length - 1] // current order
    this.pb.years = this.m.cups.map((c) => c.year!).sort((a, b) => (asc ? b - a : a - b)) // opposite, full range
    this.pb.idx = 0
    this.pb.halfCup = true
    this.pb.dir = 1
    this.pb.playing = true
    this.applyFilters(true, true)
    this.emitPb()
    this.armPb()
  }
  /** Cycle 1x -> 2x -> 4x -> 0.5x -> 1x. The next beat is re-armed at the new pace immediately. */
  playbackSpeed() {
    if (!this.pb) return
    this.pb.speed = this.pb.speed === 1 ? 2 : this.pb.speed === 2 ? 4 : this.pb.speed === 4 ? 0.5 : 1
    if (this.pb.playing) this.armPb()
    this.emitPb()
  }
  /** The bottom-docked transport reports its real height so the camera reserves exactly that strip
   *  and frames the show cleanly above it. */
  setPlaybackInset(px: number) {
    const v = Math.max(0, Math.round(px))
    if (!this.pb || v === this.insetPB) return
    this.insetPB = v
    this.fit()
  }
  /** Jump to a chosen year: park on that year's champion shown ALONE (snapped to the nearest Cup),
   *  paused, with no direction chosen yet - the two play buttons then decide which way to explore
   *  from this pivot (◀ back through older champions, ▶ on through newer ones). Picking 1999 lands
   *  on Dallas alone; the user then presses ▶ to roll toward 2026 or ◀ toward 1915. playbackPlay
   *  reads this lone pivot and rebuilds the reveal order from it in the direction pressed. */
  playbackJumpToYear(year: number) {
    const pb = this.pb
    if (!pb) return
    const all = this.m.cups.map((c) => c.year!)
    const snapped = all.includes(year) // a lockout / off year snaps to the nearest champion
      ? year
      : all.reduce((b, y) => (Math.abs(y - year) < Math.abs(b - year) ? y : b), all[0])
    pb.years = [snapped] // a lone pivot: shown alone, parked; the play buttons pick the direction
    pb.idx = 0
    pb.halfCup = true    // the champion alone (no roster yet), just like an opening beat
    pb.dir = 1
    pb.playing = false   // parked - the user picks ◀ or ▶ to start the show from here
    if (pb.timer) { clearTimeout(pb.timer); pb.timer = 0 }
    this.applyFilters(true, true)
    this.emitPb()
  }
  private armPb() {
    if (!this.pb || !this.pb.playing) return
    if (this.pb.timer) clearTimeout(this.pb.timer)
    this.pb.timer = setTimeout(() => this.stepPb(), 1000 / this.pb.speed)
  }
  // One beat. Forward: (cup alone) -> (roster out) -> (next cup alone) -> ... until the far end
  // of the show order is full. Backward: exactly the reverse, pausing once only the anchor
  // champion (the show's first year) remains.
  private stepPb() {
    const pb = this.pb
    if (!pb || !pb.playing) return
    if (pb.dir === 1) {
      if (pb.halfCup) { pb.halfCup = false; pb.idx++ }
      else if (pb.idx < pb.years.length) pb.halfCup = true
      else { pb.playing = false; this.emitPb(); return }
    } else {
      // the floor going backward is the ANCHOR CHAMPION fully revealed (idx 1, roster out);
      // the guard also refuses to retract the opening Cup itself when reversed before the very
      // first beat (idx 0, halfCup) - past either, the canvas would blank and the show wedge
      if (pb.halfCup && pb.idx > 0) pb.halfCup = false
      else if (pb.idx > 1) { pb.idx--; pb.halfCup = true }
      else { pb.playing = false; this.emitPb(); return }
    }
    this.applyFilters(true, true)
    this.emitPb()
    this.armPb()
  }
  private emitPb() {
    const pb = this.pb
    this.cb.onPlayback?.(pb ? {
      playing: pb.playing, dir: pb.dir, speed: pb.speed,
      year: pb.halfCup ? pb.years[pb.idx] : pb.idx > 0 ? pb.years[pb.idx - 1] : null,
      fromOldest: pb.years[0] < pb.years[pb.years.length - 1],
    } : null)
  }
  private insetB = 0 // stage-bottom pixels covered by the docked sheet - fits frame above it
  private insetPB = 0 // stage-bottom pixels covered by the (bottom-docked) playback transport - fits frame above it
  private filterGen = 0 // bumped by every applyFilters - stopPlayback uses it to skip a duplicate reapply
  private hybridSig = '' // era signature the hybrid layout was last seeded for; re-seed only when it changes
  private lastLayout = '' // last applied layoutMode; switching modes re-seeds the incoming one so the toggle refreshes
  /** Reserve space at the stage bottom (the open bottom sheet) so auto-fit and settle-tracking
   *  frame the content in the VISIBLE area instead of centring it underneath the sheet. */
  setBottomInset(px: number) { this.insetB = Math.max(0, Math.round(px)) }
  /** Screen (client) coordinates of a node's centre - places the search-pick card and powers
   *  the e2e node-targeting hook. Null while the node is hidden. */
  nodeScreen(id: string): { x: number; y: number } | null {
    const n = this.m.nodeById.get(id)
    // report null for a node that is not actually PAINTED - hidden, or mid-transition below the
    // draw threshold (matches drawNode's `_enter <= 0.02` skip). A "visible but never painted"
    // node (stuck at _enter=0) is exactly the reset-from-cut bug this guards against.
    if (!n || !n.vis || (n._enter ?? 1) <= 0.02) return null
    const r = this.canvas.getBoundingClientRect()
    return { x: n.x! * this.transform.k + this.transform.x + r.left,
             y: n.y! * this.transform.k + this.transform.y + r.top }
  }
  /** Debug/e2e probe: the eased dim amount (0 = no highlight showing) and whether a story's
   *  highlight is being held back until its map transition lands, plus whether a transition runs. */
  focusState(): { focusT: number; deferred: boolean; animating: boolean } {
    return { focusT: this.focusT, deferred: this.highlightDeferred, animating: this.tw !== null }
  }
  /** Remove ONE node from the selection - the bottom sheet's "Remove from cut" action. Refuses
   *  the last remaining anchor while cut (that exit is the scissors, not a card button). */
  deselectNode(id: string) {
    if (!this.selSet.has(id)) return
    if (this.cut && this.selSet.size <= 1) return
    this.selSet.delete(id)
    this.selectionChanged()
    this.computeStats()
    this.schedule()
  }
  // Compute (but don't apply) the camera transform that frames all visible nodes with a tight
  // margin. Shared by fit() (instant) and the per-tick fit-tracking (seamless).
  private computeFit(): { x: number; y: number; k: number } | null {
    // bounds over visible nodes, inlined (no intermediate .filter() array - this runs every settle tick)
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9, any = false
    for (const n of this.m.nodes) {
      if (!n.vis) continue
      any = true
      // cups extend above/below their node centre (the tall glyph) - shared CUP_EXT box
      const lr = n.type === 'cup' ? n.r * CUP_EXT.halfW : n.r
      const up = n.type === 'cup' ? n.r * CUP_EXT.up : n.r
      const dn = n.type === 'cup' ? n.r * CUP_EXT.down : n.r
      a = Math.min(a, n.x! - lr); b = Math.min(b, n.y! - up); c = Math.max(c, n.x! + lr); d = Math.max(d, n.y! + dn)
    }
    if (!any) return null
    // Tight margin so the graph fills the window rather than floating in a wide dark border;
    // the cap lets small selections grow much larger before they stop scaling up. Both bottom
    // insets (an open docked sheet, and the docked playback transport) shrink the usable height
    // so content frames above them.
    const availH = Math.max(1, this.H - this.insetB - this.insetPB)
    const w = Math.max(1, c - a), h = Math.max(1, d - b), pad = 36
    const k = Math.max(0.05, Math.min((this.W - pad * 2) / w, (availH - pad * 2) / h, 3.4))
    const x = this.W / 2 - ((a + c) / 2) * k, y = availH / 2 - ((b + d) / 2) * k
    return { x, y, k }
  }
  fit() {
    const t = this.computeFit()
    if (!t) { this.schedule(); return } // nothing visible - still repaint (e.g. after a resize)
    select(this.canvas).call(this.zoomBeh.transform as any, zoomIdentity.translate(t.x, t.y).scale(t.k))
    this.transform = t
    this.autoFit = true; this.autoFitAt = performance.now()
    this.schedule()
  }
  /** Post-settle camera landing: carry on easing toward the final fit with the SAME constant the
   *  live tracking uses, so the last visible motion decelerates into place (an exponential
   *  ease-out) instead of snapping the tracker's residual lag in one frame when the sim stops.
   *  Self-cancels when the gap goes sub-pixel; any user gesture or a fresh settle supersedes it. */
  private glideRaf = 0
  private glideFit() {
    cancelAnimationFrame(this.glideRaf)
    this.autoFit = true; this.autoFitAt = performance.now()
    const step = () => {
      const t = this.computeFit()
      if (!t) return
      const dx = t.x - this.transform.x, dy = t.y - this.transform.y, dk = t.k - this.transform.k
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dk) * Math.max(this.W, this.H) < 0.5) {
        this.transform = t
        ;(this.canvas as any).__zoom = zoomIdentity.translate(t.x, t.y).scale(t.k)
        this.schedule()
        return
      }
      const e = 0.16 // must match onTick's tracking ease - the landing is a continuation, not a new move
      this.transform = { x: this.transform.x + dx * e, y: this.transform.y + dy * e, k: this.transform.k + dk * e }
      ;(this.canvas as any).__zoom = zoomIdentity.translate(this.transform.x, this.transform.y).scale(this.transform.k)
      this.schedule()
      this.glideRaf = requestAnimationFrame(step)
    }
    this.glideRaf = requestAnimationFrame(step)
  }
  /* ---------- the pre-solved transition path ---------- */
  /** Flatten the current view into the worker's SolveInput: positions, per-node force parameters
   *  (MUST mirror the charge/fx/fy/collide lambdas in the constructor + applyFilters), per-link
   *  spring strengths, the cohesion chains, and each player's own/foreign cup index lists in CSR
   *  layout. The worker owns no model logic - everything semantic is decided here. */
  private buildSolveInput(active: GNode[], activeLinks: GLink[], timeline: boolean, hybrid: boolean, big: boolean, aspect: number): SolveInput {
    const n = active.length
    const idx = new Map<GNode, number>()
    active.forEach((nd, i) => idx.set(nd, i))
    const x = new Float64Array(n), y = new Float64Array(n), r = new Float64Array(n), rcol = new Float64Array(n)
    const charge = new Float64Array(n), tx = new Float64Array(n), ty = new Float64Array(n)
    const fxs = new Float64Array(n), fys = new Float64Array(n)
    const tSX = timeline ? 0.06 : hybrid ? 0.015 / aspect : 0.022 / aspect
    const tSY = timeline ? 0.06 : hybrid ? 0.015 * aspect : 0.022 * aspect
    for (let i = 0; i < n; i++) {
      const nd = active[i]
      x[i] = nd.x ?? 0; y[i] = nd.y ?? 0; r[i] = nd.r
      rcol[i] = nd.type === 'cup' ? nd.r * CUP_EXT.up : nd.r + 5
      charge[i] = -(24 + nd.r * 4) * (hybrid ? 1.35 : 1)
      tx[i] = nd._tx ?? 0; ty[i] = nd._ty ?? 0
      fxs[i] = nd.type === 'cup' && timeline ? 0.65 : nd.type === 'cup' && hybrid ? 0.015 : tSX
      fys[i] = nd.type === 'cup' && timeline ? 0.65 : tSY
    }
    const L = activeLinks.length
    const linkS = new Uint32Array(L), linkT = new Uint32Array(L), linkK = new Float64Array(L)
    for (let i = 0; i < L; i++) {
      const s = activeLinks[i].source as GNode, t = activeLinks[i].target as GNode
      linkS[i] = idx.get(s)!; linkT[i] = idx.get(t)!
      linkK[i] = Math.min(0.85, 0.85 / Math.max(1, s.rangeCupCount ?? 1))
    }
    const chainS = new Uint32Array(this.chainPairs.length), chainT = new Uint32Array(this.chainPairs.length)
    this.chainPairs.forEach(([s, t], i) => { chainS[i] = idx.get(s)!; chainT[i] = idx.get(t)! })
    // per-player own/foreign visible-cup lists (the same classification the live forces build in
    // their initialize passes): own = cups he won, foreign = cups of franchises he never won with
    const cupAt: [string, number][] = []
    for (let i = 0; i < n; i++) if (active[i].type === 'cup') cupAt.push([active[i].abbr!, i])
    const yearAt = new Map<number, number>()
    for (let i = 0; i < n; i++) if (active[i].type === 'cup') yearAt.set(active[i].year!, i)
    const pIdx: number[] = [], pOwn: number[] = [], pForeign: number[] = []
    const pOwnOff: number[] = [0], pForeignOff: number[] = [0]
    for (let i = 0; i < n; i++) {
      const nd = active[i]
      if (nd.type !== 'player') continue
      const mine = new Set(nd.cups!.map((c) => c.abbr))
      for (const c of nd.cups!) { const ci = yearAt.get(c.year); if (ci !== undefined) pOwn.push(ci) }
      for (const [ab, ci] of cupAt) if (!mine.has(ab)) pForeign.push(ci)
      pIdx.push(i); pOwnOff.push(pOwn.length); pForeignOff.push(pForeign.length)
    }
    return {
      gen: this.filterGen, x, y, r, rcol, charge, tx, ty, fxs, fys, linkS, linkT, linkK,
      chainS, chainT, chainDist: this.chainDist, chainK: this.chainK,
      pIdx: new Uint32Array(pIdx), pOwnOff: new Uint32Array(pOwnOff), pOwn: new Uint32Array(pOwn),
      pForeignOff: new Uint32Array(pForeignOff), pForeign: new Uint32Array(pForeign),
      mode: this.clusterFx, big,
    }
  }

  /** A solved layout arrived: play ONE choreographed transition from the view as it stands to
   *  the known final resting positions. Not a lockstep slide - a WAVE: cups lead, staggered by
   *  year, so the reorganisation sweeps chronologically across the graph; each roster trails
   *  its cup a beat behind; every path bows into a gentle arc; nodes new to the view bloom out
   *  of their cup instead of dropping in, and departed nodes fade into theirs as ghosts. The
   *  camera sweeps to the final fit across the whole motion. Stale generations are dropped; a
   *  live drag falls back to physics - the transition must not fight the user's hand. */
  private onSolved(res: SolveResult) {
    const p = this.pendingSolve
    if (!p || res.gen !== this.filterGen || p.gen !== this.filterGen) return
    this.pendingSolve = null
    const nodes = p.nodes
    const settleEnter = () => { for (const nd of p.enter) delete nd._enter }
    if (res.x.length !== nodes.length) { settleEnter(); this.releaseHighlight(); this.schedule(); return } // defensive: never strand the highlight even on a (currently unreachable) size mismatch
    // a drag took over while we were solving: physics owns the graph - any older transition
    // stands down, and the sim continues gently from the positions as they are
    if (this.dragNode) { settleEnter(); this.cancelTween(); this.releaseHighlight(); this.sim.alpha(0.3).restart(); return }
    const n = nodes.length
    const cam1 = p.wantFit ? this.computeFitOf(nodes, res.x, res.y) : null
    // two cases present the final state directly: reduced-motion users, and the very FIRST
    // layout of this GraphView's life - a fresh page (or shared link) has no prior view worth
    // animating away from, so the graph simply appears already settled
    const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
    const first = !this.hasPresented
    this.hasPresented = true
    if (reduced || first) {
      this.cancelTween()
      for (let i = 0; i < n; i++) { nodes[i].x = res.x[i]; nodes[i].y = res.y[i]; nodes[i].vx = 0; nodes[i].vy = 0 }
      settleEnter()
      if (cam1) {
        this.transform = cam1
        ;(this.canvas as any).__zoom = zoomIdentity.translate(cam1.x, cam1.y).scale(cam1.k)
        this.autoFit = true; this.autoFitAt = performance.now()
      }
      this.schedule()
      if (first) this.revealCanvas() // fade the settled layout in over the solid --bg boot screen
      this.releaseHighlight() // instant/reduced-motion present: the map is in place, ease the highlight in
      return
    }

    // ---- choreography ----
    const x1 = res.x, y1 = res.y
    const x0 = new Float64Array(n), y0 = new Float64Array(n)
    const cx = new Float64Array(n), cy = new Float64Array(n)
    const del = new Float64Array(n)
    const isEnter = new Uint8Array(n)
    const entering = new Set(p.enter)
    const hash01 = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return ((h >>> 0) % 1024) / 1024 }
    // the wave: cups take their cue from their YEAR - the reorganisation sweeps through time
    const cups = nodes.filter((nd) => nd.type === 'cup').sort((a, b) => a.year! - b.year!)
    const span = Math.min(1100, 380 + n * 0.55) // stagger window: bigger views get a longer sweep
    const cupDelay = new Map<GNode, number>()
    cups.forEach((c, i) => cupDelay.set(c, (cups.length > 1 ? i / (cups.length - 1) : 0) * span * 0.8))
    const anchorOf = (nd: GNode): GNode | null => {
      if (nd.type !== 'player') return null
      for (const c of nd.cups!) { const cc = this.m.nodeById.get('cup-' + c.year); if (cc?.vis) return cc }
      return null
    }
    for (let i = 0; i < n; i++) {
      const nd = nodes[i]
      const anchor = anchorOf(nd)
      // entrances are born AT their cup's starting spot and ride the wave out of it
      if (entering.has(nd)) {
        isEnter[i] = 1
        x0[i] = anchor?.x ?? x1[i]; y0[i] = anchor?.y ?? y1[i]
      } else { x0[i] = nd.x ?? x1[i]; y0[i] = nd.y ?? y1[i] }
      del[i] = nd.type === 'cup'
        ? cupDelay.get(nd) ?? 0
        : Math.min(span, (anchor ? cupDelay.get(anchor) ?? 0 : span * 0.4) + 120 + hash01(nd.id) * 200)
      // curved flight: bow the path perpendicular to the straight line, more for longer trips
      const dx = x1[i] - x0[i], dy = y1[i] - y0[i]
      const dist = Math.hypot(dx, dy)
      const mx = (x0[i] + x1[i]) / 2, my = (y0[i] + y1[i]) / 2
      if (dist < 40) { cx[i] = mx; cy[i] = my }
      else {
        const bow = Math.min(90, dist * 0.14) * (hash01(nd.id + 'b') < 0.5 ? -1 : 1)
        cx[i] = mx + (-dy / dist) * bow; cy[i] = my + (dx / dist) * bow
      }
    }
    const travel = 1250 // each node's own journey time; the stagger makes the whole longer
    this.startTween(nodes, x0, y0, x1, y1, cx, cy, del, isEnter, p.ghosts, cam1, travel, span + travel)
  }

  private startTween(nodes: GNode[], x0: Float64Array, y0: Float64Array, x1: Float64Array, y1: Float64Array,
    cx: Float64Array, cy: Float64Array, del: Float64Array, isEnter: Uint8Array,
    ghosts: { n: GNode; x0: number; y0: number; cup: GNode | null }[],
    cam1: { x: number; y: number; k: number } | null, travel: number, total: number) {
    this.cancelTween()
    cancelAnimationFrame(this.glideRaf)
    if (cam1) { this.autoFit = true; this.autoFitAt = performance.now() }
    const cam0 = cam1 ? { ...this.transform } : null
    this.tw = { nodes, x0, y0, x1, y1, cx, cy, del, isEnter, ghosts, cam0, cam1, t0: performance.now(), travel, total, raf: 0 }
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) // easeInOutCubic
    const smooth = (t: number) => t * t * (3 - 2 * t)
    const GHOST_MS = 700
    const step = () => {
      const tw = this.tw
      if (!tw) return
      const t = performance.now() - tw.t0
      for (let i = 0; i < tw.nodes.length; i++) {
        const nd = tw.nodes[i]
        const lt = Math.min(1, Math.max(0, (t - tw.del[i]) / tw.travel))
        const e = ease(lt)
        const u = 1 - e
        // quadratic bezier through the bowed control point
        nd.x = u * u * tw.x0[i] + 2 * u * e * tw.cx[i] + e * e * tw.x1[i]
        nd.y = u * u * tw.y0[i] + 2 * u * e * tw.cy[i] + e * e * tw.y1[i]
        nd.vx = 0; nd.vy = 0
        if (tw.isEnter[i]) nd._enter = lt >= 1 ? 1 : smooth(Math.min(1, lt / 0.45))
      }
      if (tw.cam0 && tw.cam1) {
        const ce = ease(Math.min(1, t / tw.total))
        const x = tw.cam0.x + (tw.cam1.x - tw.cam0.x) * ce
        const y = tw.cam0.y + (tw.cam1.y - tw.cam0.y) * ce
        const k = tw.cam0.k + (tw.cam1.k - tw.cam0.k) * ce
        this.transform = { x, y, k }
        ;(this.canvas as any).__zoom = zoomIdentity.translate(x, y).scale(k)
      }
      // departed nodes glide into their (moving) cup and dissolve
      if (tw.ghosts.length && t < GHOST_MS) {
        const gp = t / GHOST_MS, ge = gp * gp
        this.ghostDraw = tw.ghosts.map((g) => {
          const txx = g.cup?.vis ? g.cup.x! : g.x0, tyy = g.cup?.vis ? g.cup.y! : g.y0
          return { n: g.n, x: g.x0 + (txx - g.x0) * ge, y: g.y0 + (tyy - g.y0) * ge, r: g.n.r * (1 - 0.7 * gp), a: 0.85 * (1 - gp) }
        })
      } else this.ghostDraw = null
      this.schedule()
      if (t < tw.total) tw.raf = requestAnimationFrame(step)
      else {
        for (let i = 0; i < tw.nodes.length; i++) {
          tw.nodes[i].x = tw.x1[i]; tw.nodes[i].y = tw.y1[i]
          if (tw.isEnter[i]) delete tw.nodes[i]._enter
        }
        this.ghostDraw = null
        this.tw = null
        this.releaseHighlight() // map has landed - now fade the story's connection in
        this.schedule()
      }
    }
    this.tw.raf = requestAnimationFrame(step)
  }
  private cancelTween() {
    if (this.tw) {
      cancelAnimationFrame(this.tw.raf)
      // never strand a half-bloomed node invisible or a phantom on screen
      for (let i = 0; i < this.tw.nodes.length; i++) if (this.tw.isEnter[i]) delete this.tw.nodes[i]._enter
      this.ghostDraw = null
      this.tw = null
    }
    // NB: no releaseHighlight here - startTween() calls cancelTween() to replace a prior tween,
    // and releasing there would fade the story's highlight in at the START of its map transition.
    // The release fires at genuine completions (tween end / settle end / instant present) and when
    // a drag takes the graph over (onDown / touch-drag / the onSolved drag-bail).
  }

  /** computeFit against explicit positions (the solved final) instead of the live node coords. */
  private computeFitOf(nodes: GNode[], xs: Float64Array, ys: Float64Array): { x: number; y: number; k: number } | null {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9, any = false
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      if (!n.vis) continue
      any = true
      const lr = n.type === 'cup' ? n.r * CUP_EXT.halfW : n.r
      const up = n.type === 'cup' ? n.r * CUP_EXT.up : n.r
      const dn = n.type === 'cup' ? n.r * CUP_EXT.down : n.r
      a = Math.min(a, xs[i] - lr); b = Math.min(b, ys[i] - up); c = Math.max(c, xs[i] + lr); d = Math.max(d, ys[i] + dn)
    }
    if (!any) return null
    const availH = Math.max(1, this.H - this.insetB - this.insetPB)
    const w = Math.max(1, c - a), h = Math.max(1, d - b), pad = 36
    const k = Math.max(0.05, Math.min((this.W - pad * 2) / w, (availH - pad * 2) / h, 3.4))
    return { x: this.W / 2 - ((a + c) / 2) * k, y: availH / 2 - ((b + d) / 2) * k, k }
  }

  // Runs on every simulation tick (driven by d3's internal timer). While a re-frame is active,
  // ease the camera toward the *live* fit target so the layout reshaping and the re-framing are
  // one continuous motion - no settle-then-snap second pass.
  private onTick() {
    // Fast tail: below alpha .02 the bulk of the graph is visually parked, but at the base decay
    // the remaining whisper of energy dribbles on for ~70 more ticks - long enough to read as a
    // second, phantom settle (stragglers crawling, the camera re-framing around them). Steepen
    // the decay there so that last whisper FADES OUT in ~25 ticks instead: one landing, ending
    // in a fade rather than either a long crawl or a single-frame freeze. Restored above the
    // threshold so drag re-heats and fresh settles keep their designed pacing.
    this.sim.alphaDecay(this.sim.alpha() < FAST_TAIL.below ? FAST_TAIL.decay : this.baseAlphaDecay)
    if (this.trackFit) {
      const t = this.computeFit()
      if (t) {
        const e = 0.16
        const k = this.transform.k + (t.k - this.transform.k) * e
        const x = this.transform.x + (t.x - this.transform.x) * e
        const y = this.transform.y + (t.y - this.transform.y) * e
        this.transform = { x, y, k }
        // keep d3-zoom's stored transform in sync without dispatching a zoom event, so a later
        // user gesture continues seamlessly from where the camera tracked to
        ;(this.canvas as any).__zoom = zoomIdentity.translate(x, y).scale(k)
      }
    }
    this.schedule()
  }
  destroy() {
    this.sim.stop()
    if (this.raf) cancelAnimationFrame(this.raf)
    cancelAnimationFrame(this.glideRaf)
    this.cancelTween()
    if (this.bootRevealTimer) { clearTimeout(this.bootRevealTimer); this.bootRevealTimer = 0 }
    this.solver?.terminate()
    this.solver = null
    if (this.reshapeTimer) clearTimeout(this.reshapeTimer)
    if (this.pb?.timer) clearTimeout(this.pb.timer)
    this.clearHold()
    this.canvas.removeEventListener('pointerdown', this.onDown)
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('pointercancel', this.onCancel)
    window.removeEventListener('resize', this.onResize)
    this.ro?.disconnect()
    this.dprMql?.removeEventListener?.('change', this.onDprChange)
  }

  /* ---------- filtering / sizing / layout ---------- */
  private inRange = (y: number) => inEras(y, this.st.eras)
  private applyFilters(restart: boolean, refit = false) {
    this.filterGen++ // lets stopPlayback see that a callback already refiltered (skip its own)
    this.highlightDeferred = false // any fresh relayout drops a stale story-highlight defer; restoreView re-arms it after
    const { positions, multiOnly, layoutMode } = this.st
    const timeline = layoutMode === 'timeline'
    const hybrid = layoutMode === 'hybrid' // network-like blob, but softly biased toward the timeline grid so time reads as a gradient
    const layoutSwitched = layoutMode !== this.lastLayout // a mode toggle - re-seed the incoming layout so it visibly refreshes
    this.lastLayout = layoutMode
    // playback needs to know who was ALREADY on screen, so entrances can be seeded (below)
    if (this.pb) for (const n of this.m.nodes) (n as unknown as { _pv?: boolean })._pv = n.vis
    // who was visible BEFORE this pass - and where: the pre-solved transition stages entrances
    // (new nodes bloom out of their cup), exits (departed nodes ghost into theirs), and restores
    // carried-over nodes to these positions after the seed pass, so the wave departs from the
    // view AS THE USER SEES IT (the seeds are the solver's starting point, never a visible state)
    const prevVis = new Set<string>()
    const prevPos = new Map<string, [number, number]>()
    for (const n of this.m.nodes) if (n.vis) { prevVis.add(n.id); prevPos.set(n.id, [n.x ?? 0, n.y ?? 0]) }
    // window aspect, clamped - reused by the timeline grid shape and the network force bias
    const aspect = Math.min(1.9, Math.max(0.6, this.W / Math.max(1, this.H)))
    // size by Cups won: +4r per Cup so every count 1..11 (the record) stays a distinct size,
    // instead of the old +5r that saturated at 6 Cups and made 6/7/8/9/10/11 all identical
    const sizeFor = (rcc: number) => Math.min(48, 6 + (Math.max(1, rcc) - 1) * 4)
    // Pass 1: visibility + radius for every node.
    for (const n of this.m.nodes) {
      n._tx = 0; n._ty = 0
      if (n.type === 'cup') {
        n.vis = this.inRange(n.year!)
        n.r = 30 // larger so the abbr + year read clearly inside the barrel
        continue
      }
      let rcc = 0
      for (const c of n.cups!) if (this.inRange(c.year)) rcc++
      n.rangeCupCount = rcc
      let ok = rcc >= 1 && positions[n.group!]
      if (multiOnly && rcc < 2) ok = false
      n.vis = ok
      n.r = sizeFor(rcc)
    }
    // Playback overrides the era pass: only revealed Cups (plus, mid-beat, the next Cup alone)
    // and their rosters show. Players size by REVEALED Cups so the legends grow as history
    // assembles, and every newcomer spawns AT its Cup so the roster visibly pops out of it.
    if (this.pb) {
      const revealed = new Set(this.pb.years.slice(0, this.pb.idx))
      const pending = this.pb.halfCup ? this.pb.years[this.pb.idx] : -1
      const justYear = this.pb.years[this.pb.idx - 1]
      for (const n of this.m.nodes) {
        const was = (n as unknown as { _pv?: boolean })._pv === true
        if (n.type === 'cup') {
          n.vis = revealed.has(n.year!) || n.year === pending
          if (n.vis && !was) {
            // a new Cup enters at the crowd's edge: the visible centroid pushed outward on a
            // per-year angle, so consecutive years fan around the growing assembly
            let cx = 0, cy = 0, k = 0
            for (const o of this.m.cups) if (o !== n && o.vis) { cx += o.x ?? 0; cy += o.y ?? 0; k++ }
            const a = ((n.year! % 12) / 12) * 2 * Math.PI
            n.x = (k ? cx / k : 0) + Math.cos(a) * 150
            n.y = (k ? cy / k : 0) + Math.sin(a) * 150
            n.vx = 0; n.vy = 0
          }
          continue
        }
        let rcc = 0
        for (const c of n.cups!) if (revealed.has(c.year)) rcc++
        n.rangeCupCount = rcc
        n.r = sizeFor(rcc)
        n.vis = rcc >= 1
        if (n.vis && !was) {
          // pop out of the Cup that just revealed this player (deterministic per-player angle)
          const src = n.cups!.some((c) => c.year === justYear)
            ? this.m.nodeById.get('cup-' + justYear)
            : this.m.nodeById.get('cup-' + n.cups!.find((c) => revealed.has(c.year))!.year)
          let hash = 0
          for (let i = 0; i < n.id.length; i++) hash = (hash * 31 + n.id.charCodeAt(i)) | 0
          const a = ((hash >>> 0) % 360) / 360 * 2 * Math.PI
          const rr = (src?.r ?? 30) + n.r + 4
          n.x = (src?.x ?? 0) + Math.cos(a) * rr
          n.y = (src?.y ?? 0) + Math.sin(a) * rr
          n.vx = 0; n.vy = 0
        }
      }
    }
    // Cut mode: restrict visibility to the selection's network ON TOP of the era/position/multi
    // filters above - so the keep-set tracks the live selection and the current range together.
    // Only ERA-VISIBLE selected nodes contribute: a selected cup outside the current range keeps
    // NONE of its roster (those players would otherwise survive via their other-era Cups and
    // render as faded, disconnected orphans - the dim-all kicks in because the selection itself
    // is hidden). A cut view is therefore always fully lit, or empty when the era misses the
    // selection entirely - and moving the era back over it restores the network.
    if (this.cut && this.selSet.size && !this.pb) {
      const keep = new Set<string>()
      for (const id of this.selSet) {
        const s = this.m.nodeById.get(id)
        if (!s?.vis) continue
        keep.add(id)
        // an exact chain (Six Degrees) cuts to precisely its own nodes - a linking Cup comes
        // WITHOUT its roster; ordinary selections keep their whole adjacent network
        if (!this.chainSel) this.m.adj.get(id)?.forEach((nb) => keep.add(nb))
      }
      for (const n of this.m.nodes) if (n.vis && !keep.has(n.id)) n.vis = false
      // Within a cut, a player sizes by the Cups actually SHOWN, not by every in-era Cup - Roy
      // inside a Canadiens cut over 1980-2004 is his two Montréal wins, not a 4-Cup dot weighted
      // by Avalanche championships whose nodes the cut removed. (In an ordinary cut every kept
      // player has at least one visible cup; an exact CHAIN can break that - a chain player can
      // stay era-visible through a non-chain Cup while all his chain Cups leave the era. Such a
      // linkless orphan would render as a floating dot reading "0 Cups in this cut" - hide it,
      // and a fully-emptied chain then gets the proper "Nothing from this cut" overlay.)
      for (const n of this.m.nodes) {
        if (!n.vis || n.type !== 'player') continue
        let rcc = 0
        for (const c of n.cups!) if (this.m.nodeById.get('cup-' + c.year)?.vis) rcc++
        if (rcc === 0 && this.chainSel) { n.vis = false; continue }
        n.rangeCupCount = rcc
        n.r = sizeFor(rcc)
      }
    }
    // Dynasty colours follow the VIEW exactly like node size does: re-blend each visible player
    // over the teams of the Cups actually SHOWN (era + cut). Brad Richards inside the cap era wears
    // the pure Blackhawks colour - not a career blend muddied by his out-of-view 2004 Lightning
    // win. Hidden players keep their stale colour harmlessly (they aren't drawn).
    for (const n of this.m.nodes) {
      if (!n.vis || n.type !== 'player') continue
      let r = 0, g = 0, b = 0, tot = 0
      for (const c of n.cups!) {
        if (!this.m.nodeById.get('cup-' + c.year)?.vis) continue
        const [cr, cg, cb] = teamRgb(c.abbr)
        r += cr; g += cg; b += cb; tot++
      }
      if (tot) n.dynastyColor = `rgb(${Math.round(r / tot)},${Math.round(g / tot)},${Math.round(b / tot)})`
    }
    // Pass 2. TIMELINE pins each cup to its chronological serpentine grid cell (timelineTargets) and
    // each player to the centroid of its cups' cells -> crisp year-rows held there.
    // HYBRID "pre-renders as Timeline, then clicks Network": it SEEDS x/y from that same grid, keeps a
    // soft y-only anchor on the CUPS (their grid row - see below; _tx stays 0 and players keep both 0),
    // and lets the Network forces relax the rest into an organic blob that still remembers where each
    // era started. Re-seeded only when the era set changes
    // or on (re)entry (see hybridSig below), not on a position/cut toggle; skipped during playback.
    // Network leaves both position and _tx/_ty untouched here and lets its centred forces shape the blob.
    // hybrid re-seeds from the timeline grid only when the ERA SET changes or on (re)entry - not on a
    // position/cut/2+ toggle, which just hides nodes within the same layout. Leaving hybrid clears the
    // signature so the next entry re-seeds.
    if (!hybrid) this.hybridSig = ''
    if (timeline) {
      const pos = this.timelineTargets(aspect)
      for (const n of this.m.nodes) { if (!n.vis) continue; const p = pos.get(n.id); if (p) { n._tx = p[0]; n._ty = p[1] } }
    } else if (hybrid && !this.pb) {
      const erasSig = this.st.eras.map((e) => e.start + '-' + e.end).join(',')
      // The grid is built TWICE as wide as the window on purpose: the settle contracts x hard
      // (consecutive years sit side by side in the serpentine and share most of their rosters,
      // so hundreds of player springs pull neighbouring columns together - measured, cups end
      // ~500px inside their columns while holding rows to ~120px) and expands y past the grid.
      // Seeding ~2x wide means the post-settle blob lands near the WINDOW's aspect instead of
      // filling barely half its width. Anchors alone can't do this - holding columns against
      // the roster springs would need timeline-strength pins.
      const pos = this.timelineTargets(aspect * 2)
      // soft grid anchors: every visible cup keeps a gentle pull toward its grid cell - y (its
      // row) holds the top-to-bottom time gradient through any number of hot restarts (the seed
      // alone measured 0.97 after one settle, 0.92 after two, once the cohesion chains existed),
      // and a same-strength x pull slows the column contraction (settled width 1.63x-window vs
      // 1.42x without it). Players keep _tx/_ty 0 (the ordinary centring).
      for (const c of this.m.cups) { if (!c.vis) continue; const p = pos.get(c.id); if (p) { c._tx = p[0]; c._ty = p[1] } }
      if (erasSig !== this.hybridSig) {
        this.hybridSig = erasSig
        for (const n of this.m.nodes) { if (!n.vis) continue; const p = pos.get(n.id); if (p) { n.x = p[0]; n.y = p[1] } }
        // sector offset (the hybrid half of seedRing's cone seeding): single-cup players start a
        // step off their cup's grid cell on the side FACING AWAY from the nearest foreign cup,
        // so the relax phase never has to drag them back across someone else's roster. Multi-cup
        // players stay at their centroid - their springs place them between camps by design.
        const away = new Map<string, number>()
        for (const c of this.m.cups) {
          if (!c.vis) continue
          let best = Infinity, bx = 1, by = 0
          for (const o of this.m.cups) {
            if (!o.vis || o === c || o.abbr === c.abbr) continue
            const d = (o.x! - c.x!) ** 2 + (o.y! - c.y!) ** 2
            if (d < best) { best = d; bx = o.x! - c.x!; by = o.y! - c.y! }
          }
          away.set(c.id, Math.atan2(-by, -bx))
        }
        for (const n of this.m.nodes) {
          if (!n.vis || n.type !== 'player' || n.rangeCupCount !== 1) continue
          const ref = n.cups!.find((c) => this.inRange(c.year))
          const cup = ref && this.m.nodeById.get('cup-' + ref.year)
          if (!cup?.vis) continue
          const a = (away.get(cup.id) ?? 0) + (Math.random() - 0.5) * (Math.PI / 2)
          const rr = 30 * (0.6 + Math.random() * 0.8)
          n.x = cup.x! + Math.cos(a) * rr; n.y = cup.y! + Math.sin(a) * rr
        }
      }
    } else if (layoutSwitched && !this.pb) {
      // switched (back) to Network: re-seed a fresh ring so the graph re-lays-out from scratch instead of
      // just relaxing the previous mode's positions - the toggle visibly refreshes in both directions.
      this.seedRing()
    }
    // restrict simulation + links to visible
    const active = this.m.nodes.filter((n) => n.vis)
    const activeLinks = this.m.links.filter((l) => (l.source as GNode).vis && (l.target as GNode).vis)
    this.sim.nodes(active)
    ;(this.sim.force('link') as any).links(activeLinks)
    // Franchise cohesion: consecutive VISIBLE same-franchise cups chain together so a dynasty's
    // halos merge into one coherent territory. The year-gap cap is LOAD-BEARING, not a nicety:
    // uncapped chains drag MTL 1916 toward MTL 1993, fight hybrid's top-to-bottom time gradient,
    // and measured WORSE than no cohesion at all. Timeline gets no chains (its grid pins are the
    // semantics); playback inherits the visible-cup filter, so a newly revealed cup slides toward
    // its franchise siblings as the century assembles.
    const cohesion = this.sim.force('cohesion') as any
    this.chainPairs = []
    if (!timeline) {
      const gapCap = hybrid ? 8 : 5
      const lastByAbbr = new Map<string, GNode>()
      for (const c of this.m.cups) { // already year-sorted
        if (!c.vis) continue
        const prev = lastByAbbr.get(c.abbr!)
        if (prev && c.year! - prev.year! <= gapCap) this.chainPairs.push([prev, c])
        lastByAbbr.set(c.abbr!, c)
      }
    }
    // hybrid's chain rest length scales with the grid pitch (0.57x - the ratio the recipe was
    // validated at): a fixed 80px against a ~280px pitch pulled every consecutive-year dynasty
    // run to a third of its row space, which is what used to squeeze the whole blob narrow.
    // Network keeps the validated fixed 80 (its ring geometry has no pitch).
    this.chainDist = hybrid ? Math.max(80, Math.round(this.gridS * 0.57)) : 80
    this.chainK = hybrid ? 0.5 : 0.1
    cohesion.links(this.chainPairs.map(([s, t]) => ({ source: s, target: t }))).distance(this.chainDist).strength(this.chainK)
    // which regime the territory forces run in (foreign/ownpull/anneal read this at tick time)
    this.clusterFx = timeline ? 'off' : hybrid ? 'hyb' : 'net'
    // Network mode: bias the centring forces by the window aspect so the blob spreads to the
    // window's proportions instead of settling into a square that wastes horizontal space in a
    // wide window - weaker x-pull spreads it wider, stronger y-pull keeps it short. (Timeline
    // keeps its strong year-pinned x pull.) Clamped so ultra-wide/tall windows don't over-stretch.
    // Timeline (wrapped grid): pin cups hard to their cell (both axes); pull players only softly toward
    // their cups' centroid so the link force does the clustering (a blob per year). Network: aspect-bias.
    // Hybrid: like Network but a looser centring (below) plus a stronger charge, so weakly-bound nodes
    // (single-Cup satellites, thin cross-era links) drift apart while tight rosters stay clustered.
    const tStrengthX = timeline ? 0.06 : hybrid ? 0.015 / aspect : 0.022 / aspect
    const tStrengthY = timeline ? 0.06 : hybrid ? 0.015 * aspect : 0.022 * aspect // gentler centring so loose (single-Cup) satellites aren't packed as tight
    // hybrid cups: a fixed 0.015 x-pull toward their (widened) grid COLUMN - see the _tx anchor
    // above; everything else keeps the aspect-biased centring toward 0
    this.fx.strength((n) => (n.type === 'cup' && timeline ? 0.65 : n.type === 'cup' && hybrid ? 0.015 : tStrengthX))
    this.fy.strength((n) => (n.type === 'cup' && timeline ? 0.65 : tStrengthY))
    // hybrid repels a bit harder so loose nodes spread out; the link springs still hold tight rosters together
    ;(this.sim.force('charge') as any).strength((n: GNode) => -(24 + n.r * 4) * (hybrid ? 1.35 : 1))
    // (sim.nodes(active) above already re-initialised every force, collide included, so no manual
    // re-init is needed here. Initial player positions are seeded with Math.random(), so the settled
    // layout is not identical run-to-run.)
    this.computeStats()
    if (restart) {
      // All three layouts (network, hybrid, timeline) animate the settle and let the camera ease to fit each tick (onTick),
      // so the reshape + re-framing are one continuous, perfectly smooth motion - no synchronous snap and
      // no main-thread freeze regardless of selection size. Sticky so a layout switch's pending refit
      // survives an intervening era/position change during the settle.
      this.trackFit = this.trackFit || refit
      // Large selections pay ~6ms of forces per tick (collide dominates), so they settle with
      // fewer collide passes and a faster alpha decay: full-range era clicks converge in roughly
      // half the frames instead of committing to ~5s of hot ones. Small selections keep the
      // gentler, prettier settle.
      const big = active.length > 700
      ;(this.sim.force('collide') as any).iterations(big ? 2 : 3)
      this.baseAlphaDecay = decayFor(big)
      this.sim.alphaDecay(this.baseAlphaDecay)
      cancelAnimationFrame(this.glideRaf) // a fresh settle owns the camera (onTick tracking)
      if (this.solver && !this.pb && !this.dragNode) {
        // pre-solved path: freeze the live sim, solve the final layout in the worker, then play
        // one choreographed transition (onSolved) from the view as it stands to the known
        // resting state. A live drag skips this branch entirely - stopping the sim would freeze
        // the node under the user's pointer; drags stay on live physics, as designed.
        this.sim.stop()
        // A still-pending solve is being SUPERSEDED by this pass (two applyFilters before the
        // first's solve returns - e.g. RESET fires it twice: clearSelection then setState). Its
        // solve will be dropped stale, so un-stage its entrances now: the fresh staging below
        // re-hides whatever is genuinely new to the NEW view, but any node the old pass hid that
        // this pass leaves visible would otherwise be stranded at _enter=0 (visible + positioned
        // yet never painted) forever. Clear first, then re-stage.
        if (this.pendingSolve) for (const nd of this.pendingSolve.enter) delete nd._enter
        // stage the cast: entrances hide until their bloom (no dropping in at stale positions),
        // exits become ghosts that dissolve into their cup once the transition plays. Only after
        // the first presentation - the initial layout appears settled, no theatrics.
        const enter: GNode[] = []
        const ghosts: { n: GNode; x0: number; y0: number; cup: GNode | null }[] = []
        if (this.hasPresented) {
          for (const n of this.m.nodes) {
            const was = prevVis.has(n.id)
            if (n.vis && !was) { n._enter = 0; enter.push(n) }
            else if (!n.vis && was && Number.isFinite(n.x)) {
              let cup: GNode | null = null
              if (n.type === 'player') {
                for (const c of n.cups!) { const cc = this.m.nodeById.get('cup-' + c.year); if (cc?.vis) { cup = cc; break } }
              }
              ghosts.push({ n, x0: n.x!, y0: n.y!, cup })
            }
          }
        }
        this.pendingSolve = { gen: this.filterGen, nodes: active, wantFit: this.trackFit || refit, enter, ghosts }
        this.trackFit = false
        // collapse rapid-fire changes: one solve in flight, only the NEWEST waits behind it -
        // scrubbing era pills must cost two solves (current + last), never a backlog of stale ones
        const input = this.buildSolveInput(active, activeLinks, timeline, hybrid, big, aspect)
        // the input has now CAPTURED any fresh seed positions (hybrid grid re-seed, layout-switch
        // ring) as the solver's starting point - put every carried-over node back where the user
        // last saw it. Without this an era change jump-cut the whole graph to the raw seed
        // scramble and held it there for the entire solve window.
        for (const nd of active) {
          const pp = prevPos.get(nd.id)
          if (pp) { nd.x = pp[0]; nd.y = pp[1]; nd.vx = 0; nd.vy = 0 }
        }
        if (this.solveBusy) this.solveQueued = input
        else { this.solveBusy = true; this.solver.postMessage(input) }
        this.schedule() // paint the filter change (visibility/colour) while the worker solves
      } else {
        // live-physics restart (playback beat, active drag, no worker): the simulation owns the
        // graph now - an in-flight presentation MUST stand down or two engines fight over every
        // node position and the camera, and a stale pending solve must not resurrect later
        this.cancelTween()
        if (this.pendingSolve) { for (const nd of this.pendingSolve.enter) delete nd._enter; this.pendingSolve = null }
        this.sim.alpha(0.7).restart()
      }
    } else this.schedule()
  }
  /** Chronological serpentine ("boustrophedon") grid target for every visible node - the timeline
   *  layout. Cups fill a grid whose columns:rows match the window aspect; even rows run left→right,
   *  odd rows right→left, so each row starts directly below where the last ended (a continuous
   *  snake, never a carriage-return jump). A player sits at the centroid of the cells of the
   *  in-range Cups he won. Two callers in applyFilters: the timeline branch pins the returned
   *  positions as _tx/_ty (crisp rows); the hybrid branch seeds them as node x/y (then relaxes). */
  private timelineTargets(aspect: number): Map<string, [number, number]> {
    const cups = this.m.cups.filter((c) => c.vis).sort((a, b) => a.year! - b.year!)
    const Nc = Math.max(1, cups.length)
    const C = Math.max(1, Math.round(Math.sqrt(aspect * Nc)))  // cols:rows ≈ window aspect
    const R = Math.ceil(Nc / C)
    // cell spacing from the densest roster so adjacent year-blobs don't collide
    let maxRoster = 1
    for (const c of cups) {
      let m = 0
      this.m.adj.get(c.id)?.forEach((id) => { const p = this.m.nodeById.get(id); if (p?.vis && p.type === 'player') m++ })
      if (m > maxRoster) maxRoster = m
    }
    const S = Math.min(460, Math.max(150, Math.sqrt(maxRoster) * 50))
    this.gridS = S // the live cell pitch - hybrid's cohesion distance scales with it (applyFilters)
    const pos = new Map<string, [number, number]>()
    cups.forEach((c, i) => {
      const row = Math.floor(i / C)
      const idxInRow = i - row * C
      const physCol = row % 2 === 0 ? idxInRow : (C - 1) - idxInRow // even L→R, odd R→L (the short last row aligns to the snake, so 1950 sits under 1949)
      pos.set(c.id, [(physCol - (C - 1) / 2) * S, (row - (R - 1) / 2) * S])
    })
    for (const n of this.m.nodes) {
      if (!n.vis || n.type !== 'player') continue
      let sx = 0, sy = 0, k = 0
      for (const c of n.cups!) if (this.inRange(c.year)) { const cc = pos.get('cup-' + c.year); if (cc) { sx += cc[0]; sy += cc[1]; k++ } }
      pos.set(n.id, [k ? sx / k : 0, k ? sy / k : 0])
    }
    return pos
  }
  private computeStats() {
    // one pass over players: count those with >=1 in-range Cup, by position, and multi-Cup.
    // During playback the pills track what has ASSEMBLED so far (n.vis / revealed counts),
    // not the full era - the numbers grow with the show.
    const posCounts = { F: 0, D: 0, G: 0 } as Record<'F' | 'D' | 'G', number>
    let players = 0, multi = 0
    for (const n of this.m.nodes) {
      if (n.type !== 'player') continue
      let rcc = 0
      if (this.pb) rcc = n.vis ? n.rangeCupCount : 0
      else for (const c of n.cups!) if (this.inRange(c.year)) rcc++
      if (rcc >= 1) {
        players++
        if (rcc >= 2) multi++
        // the F/D/G pills mirror the canvas: with "2+" on, only multi-Cup players count, exactly
        // as applyFilters hides rcc<2. Playback overrides the multi filter (it shows every revealed
        // player), so the assembling pills keep counting everyone during the show.
        if (this.pb || !this.st.multiOnly || rcc >= 2) posCounts[n.group!]++
      }
    }
    const champions = this.pb
      ? this.m.cups.filter((c) => c.vis).length
      : this.m.cups.filter((c) => this.inRange(c.year!)).length
    const [lo, hi] = eraBounds(this.st.eras)
    // when something is selected, the F/D/G pills reflect the selected/lit roster, not the era total
    const sel = this.selectionPosCounts()
    // visible counts the CUT-restricted view (n.vis), unlike the era counts above - the App's
    // "nothing from this cut in this era" empty state keys on it
    let visible = 0
    for (const n of this.m.nodes) if (n.vis) visible++
    this.cb.onStats?.({ rangeStart: lo, rangeEnd: hi, eras: mergeEras(this.st.eras), champions, players, multi, posCounts: sel ?? posCounts, visible })
  }
  // F/D/G breakdown of the visible players lit up by the current selection (the selected nodes plus
  // their neighbours: a team's whole roster, or a player's own node). null when nothing is selected,
  // or the selection isn't visible in the current era, so the pills fall back to the era totals.
  private selectionPosCounts(): { F: number; D: number; G: number } | null {
    if (!this.selSet.size) return null
    const lit = new Set<string>()
    for (const id of this.selSet) {
      const n = this.m.nodeById.get(id)
      if (!n || !n.vis) continue
      lit.add(id)
      // an exact chain counts only its own nodes - the same guard highlightSet uses; without it
      // the F/D/G pills showed the linking Cups' full rosters while the canvas lit 3 players
      if (!this.chainSel) this.m.adj.get(id)?.forEach((nb) => lit.add(nb))
    }
    const c = { F: 0, D: 0, G: 0 } as Record<'F' | 'D' | 'G', number>
    let any = false
    for (const id of lit) {
      const n = this.m.nodeById.get(id)
      if (n && n.vis && n.type === 'player' && n.group) { c[n.group]++; any = true }
    }
    return any ? c : null
  }

  /* ---------- interaction ---------- */
  private screenToWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.transform.x) / this.transform.k, (sy - this.transform.y) / this.transform.k]
  }
  private nodeAt(clientX: number, clientY: number): GNode | null {
    const rect = this.canvas.getBoundingClientRect()
    const [wx, wy] = this.screenToWorld(clientX - rect.left, clientY - rect.top)
    const tol = (this.tapTipOnly ? 14 : 4) / this.transform.k // click forgiveness in SCREEN px - wider for a fingertip than a cursor - converted to world units so it doesn't grow when zoomed in
    let best: GNode | null = null, bd2 = 1e18 // squared distance - avoids a sqrt per node on every pointermove
    for (const n of this.m.nodes) {
      if (!n.vis) continue
      if ((n._enter ?? 1) < 0.5) continue // still blooming into a transition - not clickable yet
      const dx = wx - n.x!, dy = wy - n.y!, dd2 = dx * dx + dy * dy
      // cups: hit-test the tall/narrow glyph as an ellipse (the shared CUP_EXT box, so the
      // clickable region matches what's drawn and the empty corners beside it stay pannable);
      // players: a plain circle.
      let inside: boolean
      if (n.type === 'cup') {
        const hw = n.r * CUP_EXT.halfW + tol, ry = (dy < 0 ? n.r * CUP_EXT.up : n.r * CUP_EXT.down) + tol
        inside = (dx * dx) / (hw * hw) + (dy * dy) / (ry * ry) <= 1
      } else {
        const rr = n.r + tol; inside = dd2 < rr * rr
      }
      if (inside && dd2 < bd2) { best = n; bd2 = dd2 }
    }
    return best
  }
  // highlight = union of every focused node's own id + its neighbours, across the
  // whole selection plus the hovered node (so a built-up selection stays lit and
  // hovering temporarily adds to it)
  private highlightSet(): Set<string> | null {
    const foci: GNode[] = []
    if (this.hover) foci.push(this.hover)
    // visible selected nodes light up their networks; everything else fades
    for (const id of this.selSet) { const n = this.m.nodeById.get(id); if (n && n.vis) foci.push(n) }
    if (foci.length) {
      const s = new Set<string>()
      for (const f of foci) {
        s.add(f.id)
        // an exact chain highlights only its own nodes (a linking Cup without its roster);
        // the HOVERED node still expands, so exploring a chain member lights its network briefly
        if (!this.chainSel || f === this.hover) this.m.adj.get(f.id)?.forEach((id) => s.add(id))
      }
      return s
    }
    // an active selection whose nodes are ALL hidden by the current era still greys everything out
    // (an empty, non-null set) - switching to an era your selection doesn't touch keeps the
    // "nothing selected here" dim instead of dropping it and flashing the whole graph back bright
    if (this.selSet.size) return new Set()
    return null
  }
  // the directly-focused nodes (selected + hovered) - these always get a name label
  private focusIds(): Set<string> {
    const s = new Set<string>(this.selSet)
    if (this.hover) s.add(this.hover.id)
    return s
  }
  private toggleSelect(n: GNode) {
    if (this.selSet.has(n.id)) {
      // While cut, anchors can be removed as long as another anchor remains - but never the
      // LAST one: that would end the whole cut on a click that most plausibly means "inspect"
      // (the scissors is the exit). On touch the sheet's explicit buttons drive this instead.
      // (The refusal must leave ALL state untouched - clearing chainSel before it desynced
      // GraphView from App's ?chain=1 without ever firing onSelection.)
      if (this.cut && this.selSet.size <= 1) return
      this.chainSel = false // a manual click reshapes the selection - back to normal highlighting
      this.selSet.delete(n.id)
      // de-selecting the node you're hovering should drop its highlight immediately,
      // not wait for the cursor to leave; suppress re-hover until the pointer moves off it
      if (this.hover === n) { this.hover = null; this.suppressHoverId = n.id; this.cb.onHover?.(null, 0, 0) }
    } else {
      this.chainSel = false // a manual click reshapes the selection - back to normal highlighting
      this.selSet.add(n.id)
    }
    this.selectionChanged()
    this.computeStats()
    this.schedule()
  }

  /*
   * Touch gestures. The FIRST finger decides who owns the gesture:
   *   - on empty background → d3-zoom owns it natively (pan / pinch / tap-to-deselect), untouched;
   *   - on a node → WE own it, and d3-zoom's filter keeps it (and every later finger) out.
   * While we own a gesture, all state is keyed to pointerIds so a second finger can neither orphan
   * the hold timer nor steal the drag (both used to permanently pin nodes):
   *   press  - finger down on the node, nothing decided yet: a stationary release = tap-select
   *            (however slow - crossing the hold threshold no longer eats the tap);
   *   drag   - held still HOLD_MS: the node is grabbed; the sim reheats on the first real move;
   *   pan    - moved past the slop before the hold fired: the camera pans (this gesture used to
   *            be completely dead);
   *   pinch  - a second finger landed: manual two-finger zoom around the midpoint (d3-zoom never
   *            registered the first finger, so its native pinch can't handle this case).
   */
  private static readonly HOLD_MS = 250
  private static readonly SLOP = 8
  private clearHold() { if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = 0 } }
  private releaseDrag() {
    if (!this.dragNode) return
    this.dragNode.fx = null; this.dragNode.fy = null; this.dragNode = null
    this.sim.alphaTarget(0)
  }
  private resetTouch() { this.clearHold(); this.touchPtr = null; this.touch2Ptr = null; this.touchMode = null }
  private setTransform(x: number, y: number, k: number) {
    this.transform = { x, y, k }
    // keep d3-zoom's stored transform in sync so a later native gesture continues from here
    ;(this.canvas as any).__zoom = zoomIdentity.translate(x, y).scale(k)
    this.schedule()
  }
  private applyPinch(p1: { x: number; y: number }, p2: { x: number; y: number },
                     n1: { x: number; y: number }, n2: { x: number; y: number }) {
    const rect = this.canvas.getBoundingClientRect()
    const d0 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1
    const d1 = Math.hypot(n2.x - n1.x, n2.y - n1.y) || 1
    const k = Math.max(0.04, Math.min(8, this.transform.k * (d1 / d0))) // same scaleExtent as d3-zoom
    // keep the world point under the previous midpoint pinned under the new midpoint
    const m0x = (p1.x + p2.x) / 2 - rect.left, m0y = (p1.y + p2.y) / 2 - rect.top
    const m1x = (n1.x + n2.x) / 2 - rect.left, m1y = (n1.y + n2.y) / 2 - rect.top
    const wx = (m0x - this.transform.x) / this.transform.k, wy = (m0y - this.transform.y) / this.transform.k
    this.setTransform(m1x - wx * k, m1y - wy * k, k)
  }

  private onDown = (e: PointerEvent) => {
    cancelAnimationFrame(this.glideRaf) // a touch/drag takes the camera - stop the settle landing
    if (e.pointerType === 'touch') {
      if (this.touchPtr === null) {
        // a second finger landing on a NODE while d3-zoom already owns a background-started
        // gesture belongs to d3: its touchstart passes the filter (touches.length > 1) and
        // forms a native pinch. Claiming it here made the two engines fight over the
        // transform - camera frozen for the whole gesture.
        if (this.zoomTouchActive) return
        const n = this.nodeAt(e.clientX, e.clientY)
        if (!n) return // background touch: d3-zoom's gesture, not ours
        this.touchPtr = e.pointerId; this.touchMode = 'press'
        this.pressNode = n
        this.downX = e.clientX; this.downY = e.clientY
        this.t1 = { x: e.clientX, y: e.clientY }
        this.clearHold() // defensive: never let two timers exist
        this.holdTimer = setTimeout(() => {
          this.holdTimer = 0
          if (this.touchMode !== 'press' || !this.pressNode) return // became a pan/pinch meanwhile
          this.touchMode = 'drag'
          this.dragNode = this.pressNode; this.trackFit = false
          this.dragNode.fx = this.dragNode.x; this.dragNode.fy = this.dragNode.y
          // NOT reheating the sim here: a slow stationary tap that crosses the threshold should
          // not jiggle the layout - onMove reheats when the grab actually moves
        }, GraphView.HOLD_MS)
      } else if (this.touch2Ptr === null && e.pointerId !== this.touchPtr) {
        // a second finger while we own the gesture → manual pinch; a grab in progress stays a grab
        this.clearHold()
        if (this.touchMode === 'press' || this.touchMode === 'pan') {
          this.touchMode = 'pinch'
          this.touch2Ptr = e.pointerId
          this.t2 = { x: e.clientX, y: e.clientY }
          this.pressNode = null
          this.trackFit = false
          this.cb.onHover?.(null, 0, 0) // zooming moves the graph out from under any open tooltip
        }
      }
      return
    }
    this.downX = e.clientX; this.downY = e.clientY
    this.pressNode = this.nodeAt(e.clientX, e.clientY)
    // remember the node under the press, but don't pin/restart yet - only an actual
    // drag should move it; a click should just (de)select without reflowing the graph
    if (this.pressNode) e.preventDefault()
  }
  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (e.pointerId === this.touchPtr) {
        const prev = this.t1
        this.t1 = { x: e.clientX, y: e.clientY }
        if (this.touchMode === 'press' &&
            Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) > GraphView.SLOP) {
          // moved before the hold fired: a PAN that happens to have started on a node
          this.clearHold(); this.touchMode = 'pan'; this.pressNode = null; this.trackFit = false
          this.cb.onHover?.(null, 0, 0) // panning moves the graph out from under any open tooltip
        }
        if (this.touchMode === 'pan') {
          this.setTransform(this.transform.x + (e.clientX - prev.x), this.transform.y + (e.clientY - prev.y), this.transform.k)
          e.preventDefault()
        } else if (this.touchMode === 'drag' && this.dragNode) {
          if (!this.sim.alphaTarget()) { this.cancelTween(); this.releaseHighlight(); this.sim.alphaTarget(0.3).restart() } // reheat on the first real drag move (live physics takes over from any transition)
          const rect = this.canvas.getBoundingClientRect()
          const [wx, wy] = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
          this.dragNode.fx = wx; this.dragNode.fy = wy
          e.preventDefault()
        } else if (this.touchMode === 'pinch') {
          this.applyPinch(prev, this.t2, this.t1, this.t2)
        }
      } else if (e.pointerId === this.touch2Ptr && this.touchMode === 'pinch') {
        const prev = this.t2
        this.t2 = { x: e.clientX, y: e.clientY }
        this.applyPinch(this.t1, prev, this.t1, this.t2)
      }
      return
    }
    // a press on a node that then moves past the click threshold becomes a drag
    if (this.pressNode && !this.dragNode &&
        Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) > 4) {
      this.dragNode = this.pressNode
      this.trackFit = false // dragging a node shouldn't be fought by the auto-fit camera
      this.autoFit = false
      this.cancelTween(); this.releaseHighlight() // live physics takes over from any in-flight transition
      this.dragNode.fx = this.dragNode.x; this.dragNode.fy = this.dragNode.y
      this.sim.alphaTarget(0.3).restart()
    }
    if (this.dragNode) {
      const rect = this.canvas.getBoundingClientRect()
      const [wx, wy] = this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top)
      this.dragNode.fx = wx; this.dragNode.fy = wy
      return
    }
    if (e.buttons) return // panning via d3-zoom
    const n = this.nodeAt(e.clientX, e.clientY)
    // a just-deselected node stays un-highlighted while the cursor remains parked on it
    if (n && n.id === this.suppressHoverId) {
      if (this.hover) { this.hover = null; this.schedule() }
      if (!this.tapTipOnly) this.cb.onHover?.(null, e.clientX, e.clientY)
      return
    }
    this.suppressHoverId = null
    if (n !== this.hover) { this.hover = n; this.schedule() }
    if (!this.tapTipOnly) this.cb.onHover?.(this.hover, e.clientX, e.clientY)
  }
  private onUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (e.pointerId === this.touchPtr) {
        this.clearHold()
        // FIRST finger lifted mid-pinch: promote the second finger to gesture owner and
        // continue as a one-finger pan (it used to be orphaned - both fingers dead)
        if (this.touchMode === 'pinch' && this.touch2Ptr !== null) {
          this.touchPtr = this.touch2Ptr
          this.touch2Ptr = null
          this.t1 = { ...this.t2 }
          this.touchMode = 'pan'
          this.pressNode = null
          return
        }
        const still = Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) <= GraphView.SLOP
        const n = this.pressNode
        this.releaseDrag()
        if ((this.touchMode === 'press' || this.touchMode === 'drag') && still && n) {
          // a stationary tap selects and shows the tooltip (there is no hover on touch) - even a
          // slow tap whose hold already fired: the grab never moved, so selecting is what was meant.
          // In CUT mode on sheet-tooltip devices, taps are inspect-only: the docked sheet's
          // explicit "Add to / Remove from cut" buttons do the mutating, so a curious tap can
          // never silently reshape a carved view. During PLAYBACK taps are inspect-only too: a
          // selection made mid-show would dim the whole assembly once its node is unrevealed,
          // and would record undo steps / rewrite the URL while the show runs.
          if (this.pb || (this.cut && this.tapTipOnly)) {
            // inspect-only (no select), but light up the node's network like a desktop hover would, so
            // a tap during playback/cut gives the same on-canvas feedback instead of a flat card
            this.hover = n; this.schedule()
            this.cb.onHover?.(n, e.clientX, e.clientY)
          } else {
            this.toggleSelect(n)
            this.cb.onHover?.(this.selSet.has(n.id) ? n : null, e.clientX, e.clientY)
          }
        }
        this.pressNode = null
        this.resetTouch()
      } else if (e.pointerId === this.touch2Ptr) {
        // second finger lifted mid-pinch: continue as a one-finger pan with the remaining finger
        this.touch2Ptr = null
        if (this.touchMode === 'pinch') this.touchMode = 'pan'
      }
      return
    }
    const wasClick = Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) <= 4
    if (this.dragNode) {
      this.dragNode.fx = null; this.dragNode.fy = null
      this.dragNode = null; this.pressNode = null
      this.sim.alphaTarget(0)
      return
    }
    // click a node → add/remove it; empty-background clears are handled in the zoom 'end' handler.
    // On sheet-tooltip (coarse) devices a MOUSE user has no other way to open the node card, so
    // the click also drives the sheet - and in cut mode it is inspect-only, mirroring touch taps.
    // During playback ALL clicks are inspect-only (see the touch path above for why).
    if (wasClick && this.pressNode) {
      const n = this.pressNode
      if (this.pb || (this.cut && this.tapTipOnly)) {
        this.hover = n; this.schedule() // light up the inspected node's network (matches hover)
        this.cb.onHover?.(n, e.clientX, e.clientY)
      } else {
        this.toggleSelect(n)
        if (this.tapTipOnly) this.cb.onHover?.(this.selSet.has(n.id) ? n : null, e.clientX, e.clientY)
      }
    }
    this.pressNode = null
  }
  // pointercancel: the browser/OS took the gesture (notification shade, incoming call, app
  // switch, screen lock). Release exactly what a pointerup would - minus the tap-select.
  private onCancel = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      if (e.pointerId === this.touch2Ptr) {
        this.touch2Ptr = null
        if (this.touchMode === 'pinch') this.touchMode = 'pan'
        return
      }
      if (e.pointerId !== this.touchPtr) return
      // first finger cancelled mid-pinch: hand the gesture to the surviving second finger
      if (this.touchMode === 'pinch' && this.touch2Ptr !== null) {
        this.touchPtr = this.touch2Ptr
        this.touch2Ptr = null
        this.t1 = { ...this.t2 }
        this.touchMode = 'pan'
        this.pressNode = null
        return
      }
      this.releaseDrag()
      this.pressNode = null
      this.resetTouch()
      return
    }
    this.clearHold()
    this.releaseDrag()
    this.pressNode = null
  }
  // Re-measure AND re-frame on window/stage resize, so the graph keeps filling the new viewport
  // instead of being left off-centre/clipped at the old framing.
  private onResize = () => {
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height))
    const dpr = window.devicePixelRatio || 1
    // a window resize fires BOTH the window 'resize' listener and the ResizeObserver; skip the
    // second (dimensions unchanged) so we don't re-measure/re-fit twice per resize
    if (w === this.W && h === this.H && dpr === this.dpr) return
    if (this.anchorRect && Date.now() < this.anchorUntil) {
      // an ANNOUNCED chrome-height change (bar hidden/restored, submenu toggled): re-measure the
      // box but pin the graph to the physical screen - shift the camera by exactly how far the
      // canvas's top-left moved, and skip the refit/reshape that would scoot everything around
      const dx = this.anchorRect.left - rect.left, dy = this.anchorRect.top - rect.top
      this.anchorRect = null; this.anchorUntil = 0
      // trackFit deliberately survives: mid-settle the layout is moving anyway, and killing the
      // ease left seconds of drifting nodes with a frozen camera. Idle (the normal case) it is
      // already false, so the pin holds exactly as intended.
      this.resize()
      if (dx || dy) {
        const t = this.transform
        const nt = { x: t.x + dx, y: t.y + dy, k: t.k }
        select(this.canvas).call(this.zoomBeh.transform as any, zoomIdentity.translate(nt.x, nt.y).scale(nt.k))
        this.transform = nt
      }
      // an already-armed reshapeTimer belongs to an EARLIER real window resize whose aspect
      // reshape is still owed - leave it to fire; the bar's own height change arms nothing here
      // paint NOW, not on the next animation frame: resizing the backing store CLEARS the
      // canvas, and one rAF of emptiness reads as a visible flash when the bar toggles
      this.render()
      // the pin preserved the physical framing, but the stage's usable box changed. Under the
      // old live tracking the settle re-framed afterwards on its own; with pre-solved
      // presentations that window doesn't exist, so re-frame here explicitly: a tween in flight
      // re-aims its camera sweep at the fit for the NEW geometry, and an untouched auto fit
      // glides to it. A camera the user owns (autoFit false, no sweep) keeps the pin, as before.
      if (this.tw && this.tw.cam1) this.tw.cam1 = this.computeFitOf(this.tw.nodes, this.tw.x1, this.tw.y1)
      else if (this.autoFit && performance.now() - this.autoFitAt < 1500) this.glideFit()
      return
    }
    this.resize()
    // a transition in flight owns the camera: re-aim its sweep at the fit for the NEW viewport
    // instead of snapping a fit() it would immediately fight frame-by-frame toward a stale target
    if (this.tw && this.tw.cam1) this.tw.cam1 = this.computeFitOf(this.tw.nodes, this.tw.x1, this.tw.y1)
    else this.fit()
    this.render() // same flash guard: reframe AND paint before the browser shows the cleared canvas
    // The timeline grid's column/row count and the network aspect-bias are derived from the canvas
    // aspect inside applyFilters, so an aspect change must RE-RUN it to reshape the layout - a bare
    // fit() only reframes the stale grid (a wide grid would letterbox into a tall window). Debounced
    // so a drag-resize doesn't restart the sim every pixel; the fit() above holds the frame meanwhile.
    if (this.reshapeTimer) clearTimeout(this.reshapeTimer)
    this.reshapeTimer = setTimeout(() => { this.reshapeTimer = 0; this.applyFilters(true, true) }, 180)
  }
  private resize() {
    // measure the canvas's own box (it fills the .stage below the top bar) - not the window
    this.dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    this.W = Math.max(1, Math.round(rect.width)); this.H = Math.max(1, Math.round(rect.height))
    this.canvas.width = Math.floor(this.W * this.dpr); this.canvas.height = Math.floor(this.H * this.dpr)
  }
  // A monitor-to-monitor window move changes devicePixelRatio WITHOUT resizing the canvas box, so
  // neither the resize listener nor the ResizeObserver fires and the backing store stays at the
  // old scale (blurry, or wastefully supersampled). A resolution media query flips exactly then;
  // it is dpr-specific, so re-arm it at each new value.
  private onDprChange = () => { this.onResize(); this.watchDpr() }
  private watchDpr() {
    if (typeof matchMedia !== 'function') return
    this.dprMql?.removeEventListener?.('change', this.onDprChange)
    try { this.dprMql = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) } catch { this.dprMql = null; return }
    this.dprMql?.addEventListener?.('change', this.onDprChange)
  }

  /* ---------- render ---------- */
  // Every repaint trigger (sim tick, zoom, hover, pinch, theme change) funnels through this
  // scheduler, which batches them into a single requestAnimationFrame callback - any number of
  // same-frame triggers produce exactly ONE draw. Wheel events alone can arrive 2-3x per display
  // frame during a fast zoom. Falls back to an immediate draw where rAF is missing entirely.
  private schedule() {
    if (this.raf) return
    if (typeof requestAnimationFrame !== 'function') { this.render(); return }
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render() })
  }
  render() {
    // a direct (synchronous) render satisfies any repaint already queued for the next frame -
    // consume it, or every resize paints the identical frame twice
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0 }
    this.ensureFocusSets()
    const hs = this.hsCache
    if (hs) this.lastFocus = hs
    // deferred story highlight: while the map transitions into place, draw it UN-dimmed and
    // UN-highlighted (focusT pinned 0, no lit set); releaseHighlight() lifts this when the
    // transition lands, and the ease below then fades the connection in
    let drawSet: Set<string> | null
    let focusIds: Set<string>
    let target: number
    if (this.highlightDeferred) {
      // focusIds ALSO suppressed: it drives the forced NAME labels of selected nodes, which the
      // label pass paints at full opacity regardless of focusT - so a carried-over story player
      // (already on screen from the previous era) would otherwise show its name mid-transition,
      // before the corridor and dim arrive. Everything about the highlight waits for the landing.
      this.focusT = 0; target = 0; drawSet = null; focusIds = EMPTY_FOCUS
    } else {
      // ease focusT toward "is a focus active" so the dim fades in/out instead of snapping.
      target = hs ? 1 : 0
      const d = target - this.focusT
      this.focusT = Math.abs(d) < 0.01 ? target : this.focusT + d * 0.25
      // while fading OUT (hover just ended, hs is null) keep dimming against the last set until fully clear
      drawSet = hs ?? (this.focusT > 0.001 ? this.lastFocus : null)
      focusIds = this.fiCache
    }
    draw(this.ctx, {
      nodes: this.m.nodes, links: this.m.links,
      tx: this.transform.x, ty: this.transform.y, k: this.transform.k,
      W: this.W, H: this.H, dpr: this.dpr,
      hoverSet: drawSet,
      focusIds,
      focusT: this.focusT,
      colorMode: this.st.colorMode,
      communityColor: this.m.communityColor,
      bg: this.bg,
      edgeRgb: this.edgeRgb, edgeAlpha: this.edgeAlpha, nameFill: this.nameFill, nameHalo: this.nameHalo, hlEdge: this.hlEdge,
      light: this.lightBg,
      ghosts: this.ghostDraw ?? undefined,
    })
    // keep animating until the fade settles (used when idle; sim ticks drive their own frames)
    if (this.focusT !== target && typeof requestAnimationFrame === 'function') this.schedule()
  }
}
