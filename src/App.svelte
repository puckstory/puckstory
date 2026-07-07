<script lang="ts">
  /*
   * App.svelte - the app shell.
   *
   * Owns the top-level view state, builds the search index, creates the GraphView on mount and
   * relays every control change to it, and renders the chrome layered over the canvas: the top
   * bar, the node card (a hover tooltip on desktop, a right-corner card with per-Cup rows on tablets, a
   * docked bottom-sheet one-liner on phones), the guidance
   * overlays for the empty states, and the floating restore button. The graph itself is drawn on
   * the <canvas> by GraphView - this file is the glue between the controls and that engine.
   */
  import { onMount, onDestroy, tick, afterUpdate } from 'svelte'
  import { buildModel, DATA, teamColor, posFull, posGroup, inEras, mergeEras, ERA_PRESETS } from './lib/model'
  import { GraphView, type RangeStats, type PlaybackState } from './lib/graphview'
  import type { ViewState, GNode, Era } from './lib/types'
  import { parseView, viewToQuery, defaultState } from './lib/urlstate'
  import { shortestPath } from './lib/path'
  import type { Story } from './lib/stories'
  import { init as histInit, record as histRecord, undo as histUndo, redo as histRedo, minimalPatch, type Hist } from './lib/history'
  import { buildSearchIndex, type SearchItem } from './lib/search'
  import { applyTheme, loadTheme, type ThemeId } from './lib/theme'
  import { connSmytheSvgPath, CAPTAIN_C_PATH } from './lib/render'
  import { tip as uitip } from './lib/tip'
  import { isCoarsePointer, isCornerCard } from './lib/env'
  import TopBar from './components/TopBar.svelte'

  // Conn Smythe Trophy silhouette (maple-leaf-on-a-base), shown in place of a trophy emoji
  const csIcon = `<svg class="cs-icon" viewBox="-0.72 -1.04 1.44 2.08" aria-hidden="true"><path d="${connSmytheSvgPath()}" fill="currentColor"/></svg>`
  // Captain marker - a jersey-style block "C" glyph
  const capIcon = `<svg class="cap-c" viewBox="-0.5 -0.5 0.98 1" aria-hidden="true"><path d="${CAPTAIN_C_PATH}" fill="currentColor"/></svg>`

  const Y0 = DATA.window.startYear
  const Y1 = DATA.window.endYear
  const model = buildModel()
  const searchItems: SearchItem[] = buildSearchIndex(model)

  // theme: set the document attribute now (so the CSS vars apply before first paint), then point
  // the canvas background at the active theme's --bg once the GraphView exists (onMount).
  let theme: ThemeId = loadTheme()
  document.documentElement.dataset.theme = theme
  function changeTheme(t: ThemeId) { theme = t; gv?.setBg(applyTheme(t)) }

  // "1984–1990" for one interval ("1993" alone, not "1993–1993"); "1942–1967 + 1980–1993" for a
  // few; "N eras (1915–2026)" for many.
  function eraLabel(eras: Era[]): string {
    const m = mergeEras(eras)
    const fmt = (e: Era) => (e.start === e.end ? `${e.start}` : `${e.start}–${e.end}`)
    if (!m.length) return '-'
    if (m.length <= 3) return m.map(fmt).join(' + ')
    return `${m.length} eras (${m[0].start}–${m[m.length - 1].end})`
  }

  let canvas: HTMLCanvasElement
  let gv: GraphView | undefined

  // the years a ?focus= node needs visible ([] = unknown id → the focus is ignored entirely)
  const yearsOf = (id: string): number[] => {
    const n = model.nodeById.get(id)
    return n ? (n.type === 'cup' ? [n.year!] : (n.cups ?? []).map((c) => c.year)) : []
  }
  const bootView = parseView(location.search, yearsOf, (id) => model.nodeById.has(id))
  let state: ViewState = bootView.state
  let stats: RangeStats | null = null
  let hoverNode: GNode | null = null
  let tipX = 0, tipY = 0
  let tipEl: HTMLDivElement | undefined
  let tipH = 260               // measured tooltip height, used to clamp so tall rosters don't clip
  let measuredFor: GNode | null = null
  let winW = window.innerWidth, winH = window.innerHeight
  // Touch devices dock the node card as a bottom sheet instead of floating it at the tap point,
  // where it lands under the finger, covers the node just tapped, and jumps with every tap.
  // Desktop keeps the cursor-following tooltip (hover exists there).
  const dockTip = isCoarsePointer() // must agree with GraphView's tapTipOnly (same probe)
  // iPad-class devices dock the card as a right-CORNER card (app.css true-tablet tier), which
  // changes two things below: the card carries the desktop per-Cup rows (there's room), and it
  // reserves NO fit inset (it overlays a corner like the desktop tooltip, not a bottom strip)
  const cornerCard = isCornerCard()
  // short landscape phones start with the chrome hidden - the bar ate 40% of a 360px-tall
  // viewport; the accent ▾ restore button (top-right) brings it back
  let chromeHidden = (() => {
    try { return matchMedia('(pointer: coarse)').matches && window.innerHeight < 480 && window.innerWidth > window.innerHeight } catch { return false }
  })()

  let selectedIds: string[] = [] // the live selection, mirrored into ?focus= (see syncUrl)
  let cutActive = false          // cut mode (scissors): mirrored into ?cut=1
  let chainActive = false        // Six Degrees chain: exact-nodes highlight, mirrored into ?chain=1
  let cutPulse = 0               // bumped when cut-mode swallows a background tap → scissors pulses
  let announce = ''              // aria-live text: cut on/off and undo/redo are otherwise silent to AT

  // when the chrome is hidden the scissors (the swallowed tap's usual pulse target) does not
  // exist - forward the "way out" pulse to the floating restore button instead
  let scSeen = 0
  let scPulsing = false
  let scTimer: ReturnType<typeof setTimeout> | 0 = 0
  $: if (cutPulse !== scSeen) {
    scSeen = cutPulse
    if (chromeHidden) {
      scPulsing = false
      if (scTimer) clearTimeout(scTimer)
      // double rAF: the class removal must reach a style recalc before the re-add, or a second
      // bump inside the animation window never restarts it
      requestAnimationFrame(() => requestAnimationFrame(() => (scPulsing = true)))
      scTimer = setTimeout(() => (scPulsing = false), 1300)
    }
  }

  // guidance overlays: name the invisible state and point at the way out. Priority: no era at
  // all → cut emptied by the era → selection entirely outside the era (the dim-all view).
  $: hiddenSelection = selectedIds.length > 0 && !!state &&
    selectedIds.every((id) => !model.nodeById.get(id)?.vis)
  $: hiddenNames = (() => {
    const names = selectedIds.slice(0, 2).map((id) => {
      const n = model.nodeById.get(id)
      return n ? (n.type === 'cup' ? `${n.year} ${n.abbr}` : n.name!) : id
    })
    return names.join(' & ') + (selectedIds.length > 2 ? ` +${selectedIds.length - 2} more` : '')
  })()
  // WHY the selection is hidden decides what the overlay prescribes: a player with in-era Cups
  // hidden by an unpressed position pill (or the 2+ filter) is NOT an era problem - telling the
  // user to widen the era would do nothing. Priority mirrors applyFilters' visibility rule.
  $: hiddenWhy = (() => {
    if (!hiddenSelection) return null as null | { kind: 'era' | 'pos' | 'multi'; hint: string }
    let pos: 'F' | 'D' | 'G' | null = null, multi = false
    for (const id of selectedIds) {
      const n = model.nodeById.get(id)
      if (!n || n.type === 'cup') return { kind: 'era', hint: '' } // a hidden cup can only be the era
      const inEra = n.cups!.filter((c) => inEras(c.year, state.eras)).length
      if (inEra === 0) return { kind: 'era', hint: '' }
      if (!state.positions[n.group!]) pos = n.group!
      else if (state.multiOnly && inEra < 2) multi = true
    }
    if (pos) return { kind: 'pos', hint: `${pos} (${posFull(pos)})` }
    if (multi) return { kind: 'multi', hint: '' }
    return { kind: 'era', hint: '' }
  })()

  // ---- undo / redo -------------------------------------------------------------------------
  // Every discrete mutation records a full JSON snapshot of the shareable view (filters +
  // selection + cut + chain). Simple changes record inside the two funnels - change() and the
  // onSelection callback; composite actions (a story, a Six Degrees connect, an undo restore)
  // suppress those with the `restoring` flag and record their end state themselves, so one
  // gesture is one undo step.
  // The camera and node physics are deliberately NOT actions. The stack itself is pure data in
  // lib/history.ts (unit-tested there); restores replay wholesale with recording suppressed.
  type Snap = { state: ViewState; ids: string[]; cut: boolean; chain: boolean }
  const snap = (): Snap => ({ state: JSON.parse(JSON.stringify(state)), ids: [...selectedIds], cut: cutActive, chain: chainActive })
  // the view captured just before "A Brief History of Stanley" ran, so closing the show returns to it
  let prePlayback: Snap | null = null
  let hist: Hist<Snap> = histInit({ state: JSON.parse(JSON.stringify(state)), ids: [], cut: false, chain: false })
  let restoring = false
  $: canUndo = hist.past.length > 0
  $: canRedo = hist.future.length > 0
  function record() {
    if (restoring) return
    hist = histRecord(hist, snap()) // deep-equal no-ops are skipped inside
  }
  function applySnap(s: Snap) {
    restoring = true
    const patch = minimalPatch(state, s.state) // selection-only steps must not reheat the layout
    state = JSON.parse(JSON.stringify(s.state))
    gv?.restoreView(patch, s.ids, s.cut, s.chain) // atomic: at most one refilter + sim restart
    hoverNode = null // the card/sheet described the pre-restore world - never a restored ghost
    restoring = false
    syncUrl()
  }
  function undo() {
    const h = histUndo(hist)
    if (!h) return
    hist = h
    applySnap(h.present)
    announce = 'Undone'
  }
  function redo() {
    const h = histRedo(hist)
    if (!h) return
    hist = h
    applySnap(h.present)
    announce = 'Redone'
  }
  function onKey(e: KeyboardEvent) {
    // Escape ends a running show - with the top bar gone the only other exits are the
    // transport's ✕ and the undo/redo chords (the show is ephemeral, never an undo step, so
    // mid-show they simply end it, restoring the pre-show view) - and Escape is the reflex
    // reach for "stop this"
    if (e.key === 'Escape' && pb) { gv?.stopPlayback(); return }
    if (!(e.metaKey || e.ctrlKey)) return
    const t = e.target as HTMLElement
    if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return // native text undo stays native
    const k = e.key.toLowerCase()
    // mid-show, undo/redo mean "get me out": end the show instead of popping history - a pop
    // would land one step BEFORE the pre-show view (the story never records), and it would
    // re-enter applySnap from inside restoreView's stopPlayback callback
    if ((k === 'z' || k === 'y') && pb) { e.preventDefault(); gv?.stopPlayback(); return }
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
    else if (k === 'y') { e.preventDefault(); redo() }
  }

  onMount(() => {
    gv = new GraphView(canvas, model, state, {
      onHover: (n, cx, cy) => { hoverNode = n; tipX = cx; tipY = cy },
      onStats: (s) => { stats = s },
      onSelection: (ids, cut, chain) => {
        if (cut !== cutActive) announce = cut ? 'Cut applied - showing only the selected network' : 'Cut removed'
        selectedIds = ids; cutActive = cut; chainActive = chain; syncUrl()
        // a sheet action can hide the very node it describes ("Remove from cut" on a branch
        // whose network leaves the keep-set) - close the sheet rather than describe a ghost
        if (hoverNode && !hoverNode.vis) hoverNode = null
        record()
      },
      onCutNudge: () => { cutPulse++ },
      onPlayback: (st) => {
        const ended = pb && !st
        // keyboard focus lives on a transport button that is about to unmount - remember that
        // BEFORE Svelte tears the panel down, so it can land somewhere useful afterwards
        const hadFocusInBar = ended && !!pbEl && pbEl.contains(document.activeElement)
        pb = st
        if (!st) editingYear = false // the show closed - drop any half-typed year
        // the show is over (closed, finished with, or interrupted): restore the bar it hid,
        // tell screen readers (the panel just vanishing is otherwise silent), and re-home
        // focus dropped by the unmount
        if (!st && pbHidChrome) { pbHidChrome = false; if (chromeHidden) toggleChrome(false) }
        if (ended) {
          // return the graph to exactly the view it had before the show started (eras, selection,
          // cut). If an applySnap is already in flight (its restoreView is what stopped the show),
          // THAT restore is the exit and owns the target view - drop the stale snapshot rather
          // than re-entering applySnap from inside itself
          if (prePlayback) { const p = prePlayback; prePlayback = null; if (!restoring) applySnap(p) }
          announce = 'Playback ended'
          tick().then(() => {
            if (hadFocusInBar || document.activeElement === document.body) {
              const home = document.querySelector<HTMLElement>('[aria-label="Fit view"], .showchrome')
              home?.focus()
            }
          })
        }
      },
    })
    gv.setBg(applyTheme(theme)) // paint the canvas in the active theme's background
    // deterministic node targeting for the e2e suite (and a handy console helper)
    ;(window as any).__pkNodeScreen = (id: string) => gv?.nodeScreen(id) ?? null
    document.fonts?.ready.then(() => gv?.fit()) // redraw canvas labels once Inter has decoded
    // apply the deep link's selection + cut (parseView already filtered unknown ids - a
    // mistyped/stale id must not load the graph dimmed with no explanation). The boot
    // application is the undo BASELINE, not an undoable action.
    restoring = true
    if (bootView.ids.length) {
      if (bootView.chain) gv.selectChain(bootView.ids)
      else gv.selectNodes(bootView.ids)
      if (bootView.cut) gv.setCut(true)
    }
    restoring = false
    hist = histInit(snap())

    // Lock browser PAGE zoom so a pinch (or trackpad-pinch) zooms the GRAPH via the canvas's own
    // d3-zoom, never the whole page - otherwise the fixed menu chrome scales with the visual viewport.
    // The viewport meta covers Android; iOS Safari ignores it, so kill its pinch gesture events, and
    // desktop trackpad-pinch arrives as ctrl+wheel. (Desktop keyboard zoom is the browser's own a11y
    // control and can't be intercepted - and the graph stays fully zoomable, so content zoom is intact.)
    const noGesture: EventListener = (e) => e.preventDefault()
    const noCtrlWheel = (e: WheelEvent) => { if (e.ctrlKey) e.preventDefault() }
    document.addEventListener('gesturestart', noGesture)
    document.addEventListener('gesturechange', noGesture)
    document.addEventListener('wheel', noCtrlWheel, { passive: false })
    return () => {
      document.removeEventListener('gesturestart', noGesture)
      document.removeEventListener('gesturechange', noGesture)
      document.removeEventListener('wheel', noCtrlWheel)
    }
  })
  onDestroy(() => gv?.destroy())

  // Keep the address bar in sync with the view (it used to be read once at boot and never
  // updated): every control,
  // selection, or cut change rewrites the query via replaceState, so the copied URL reproduces
  // this exact view - filters, selected nodes (?focus=), cut mode (?cut=1), and Six Degrees chain (?chain=1) included.
  // viewToQuery owns the serialisation (it pins ?eras= whenever a focus rides along). The
  // try/catch guards Safari's replaceState rate quota: a throw here must never abort the
  // caller mid-mutation (it would punch holes in the undo history).
  function syncUrl() {
    try {
      const qs = viewToQuery({ state, ids: selectedIds, cut: cutActive, chain: chainActive })
      history.replaceState(null, '', qs ? `?${qs}` : location.pathname)
    } catch {}
  }
  function change(patch: Partial<ViewState>) {
    state = { ...state, ...patch }
    gv?.setState(patch)
    // a filter change can hide the node the open tooltip describes - drop it rather than let it
    // float over an era it isn't part of (on touch there is no hover to refresh it)
    if (hoverNode && !hoverNode.vis) hoverNode = null
    syncUrl()
    record()
  }
  // search dropdown pick → select the node(s): one player, or a team's whole set of Cups.
  // A single visible pick also OPENS its card at the node - immediate feedback, and the only
  // keyboard-accessible path to the card (the canvas itself is not focusable).
  function pick(item: SearchItem) {
    gv?.selectNodes(item.ids)
    if (item.ids.length === 1) {
      const n = model.nodeById.get(item.ids[0])
      const p = n?.vis ? gv?.nodeScreen(item.ids[0]) : null
      if (n && p) { hoverNode = n; tipX = p.x; tipY = p.y }
    }
  }

  // The view swaps here (and in connect below) are heavy synchronous work - a refilter plus a
  // simulation restart can hold the main thread for a frame or two, and the search dropdown that
  // just closed would linger PAINTED on screen through it (a visible dark remnant). Two animation
  // frames give desktop one clean paint first. Phones need more: the same tap dismisses the
  // on-screen KEYBOARD, and its ~300ms hide animation janks against the swap, smearing the
  // dropdown's pixels - wait the animation out before starting.
  const afterPaint = (fn: () => void) => {
    const run = () => requestAnimationFrame(() => requestAnimationFrame(fn))
    if (dockTip) setTimeout(run, 350)
    else run()
  }

  // a Story is a saved view state (the same thing a shared link carries): apply it wholesale
  // like an undo restore, but AS one recorded, undoable action
  function applyStory(s: Story) {
    afterPaint(() => {
      const v = parseView('?' + s.qs, yearsOf, (id) => model.nodeById.has(id))
      if (s.playback) prePlayback = snap() // remember the current view before the show overwrites it
      applySnap({ state: v.state, ids: v.ids, cut: v.cut, chain: v.chain })
      if (s.playback) {
        // the show is EPHEMERAL: hand over to the playback engine (it refits every beat), and DON'T
        // record an undo step - closing the show restores the pre-story view (prePlayback), so the
        // story leaves no trace. The top bar leaves for the duration (the transport is the only
        // chrome) and comes back when the show ends. The blurb goes to screen readers only.
        hoverNode = null
        if (!chromeHidden) { pbHidChrome = true; toggleChrome(true) }
        gv?.startPlayback()
        showFlash(s.blurb, false)
        return
      }
      record()
      gv?.fit()
      showFlash(s.blurb) // the blurb pill (top-centre, ~5.6s, wraps if long) - shown on every device
    })
  }

  // live playback state (null = no show running) - drives the bottom-docked transport panel
  let pb: PlaybackState | null = null
  let pbEl: HTMLDivElement | undefined // the transport panel (kept only for focus-restore on show end)
  // The transport is fixed at the bottom-centre of the stage. Its year readout doubles as a
  // jump field: clicking it pauses the show and turns it into an input; typing a year and
  // pressing Enter jumps the assembly to that year (in whichever direction time is flowing).
  let editingYear = false
  let yearInput = ''
  function startYearEdit() {
    if (!pb) return
    if (pb.playing) gv?.playbackToggle() // clicking the year stops the show first
    yearInput = String(pb.year ?? Y1)
    editingYear = true
  }
  function commitYear() {
    if (!editingYear) return
    editingYear = false
    const y = parseInt(yearInput, 10)
    if (!Number.isNaN(y)) gv?.playbackJumpToYear(Math.min(Y1, Math.max(Y0, y))) // clamp to the data span
  }
  function yearKey(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitYear() }
    else if (e.key === 'Escape') { e.preventDefault(); editingYear = false } // leave the show where it is
  }
  // focus + select the year input the instant it appears, so the typed year replaces the old one
  function focusSelect(node: HTMLInputElement) { node.focus(); node.select() }
  // the fixed transport reports its real height (it wraps to two rows on narrow screens) so the
  // camera reserves exactly that bottom strip and frames the show above the bar
  function pbInset(node: HTMLElement) {
    const report = () => gv?.setPlaybackInset(node.offsetHeight + 24) // bar height + its bottom gap
    const ro = new ResizeObserver(report)
    ro.observe(node); report()
    return { destroy() { ro.disconnect() } }
  }
  // The two play buttons map to the TIME axis, not the internal assemble/peel dir: ◀ plays toward
  // OLDER years (1915), ▶ toward NEWER years (2026) - so a right arrow always advances the year,
  // matching the timeline. movingToward is which way time is currently flowing (assembling on an
  // ascending order climbs to newer; on a descending one it falls to older), so the LIT button
  // always matches the ticking year. gv.playbackPlay() handles both the lone-pivot pick and the
  // running-show pause/reverse. 0 = parked pivot (no direction chosen), so neither button lights.
  $: movingToward = pb && pb.playing ? (pb.fromOldest ? pb.dir : -pb.dir) : 0
  $: playingOlder = movingToward === -1
  $: playingNewer = movingToward === 1
  // the show hid the top bar itself (vs the user having hidden it beforehand): only then does
  // ending the show bring the bar back
  let pbHidChrome = false

  // transient top-centre notice for results that would otherwise be invisible (sr-only announce
  // covers AT; sighted users need the outcome of a connect stated somewhere too). `visual:false`
  // announces without the pill - on phones the pill crowds the small screen after a story or a
  // connect whose result is already filling the viewport.
  let flash = ''
  let flashTimer: ReturnType<typeof setTimeout> | 0 = 0
  function showFlash(msg: string, visual = true) {
    announce = msg
    if (!visual) return
    flash = msg
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (flash = ''), 5600) // long enough to read the chain, short enough to not linger
  }

  // "Six Degrees": light the shortest engraved chain between two endpoints (a player, or a team
  // = all of its Cups). The chain lives in the engravings, not the current view, so the search
  // runs on the FULL graph and every era the chain spans toggles ON; the chain then becomes the
  // selection (its names force on) and shares/undoes through the existing machinery as ONE action.
  function connect(a: SearchItem, b: SearchItem) { afterPaint(() => connectNow(a, b)) }
  function connectNow(a: SearchItem, b: SearchItem) {
    const path = shortestPath(model.adj, a.ids, b.ids)
    if (!path) { showFlash(`No engraved connection between ${a.label} and ${b.label}`); return }
    if (path.length === 1) { pick(b); return } // both ends are the same node - just select it
    restoring = true
    if (cutActive) gv?.setCut(false) // a wholesale new selection must not silently rewrite a cut
    const years = path
      .map((id) => model.nodeById.get(id))
      .filter((n) => n?.type === 'cup')
      .map((n) => n!.year!)
    // toggle ON every era the chain SPANS - first to last linking Cup, contiguously - so a
    // Gretzky→Staal chain presses Dynasties, Dead Puck, AND Cap even when its Cups happen to
    // hop straight over Dead Puck's years. Appended to whatever was already selected
    // (never replacing; entries stay distinct so each pill reads pressed).
    const lo = Math.min(...years), hi = Math.max(...years)
    const have = new Set(state.eras.map((e) => `${e.start}-${e.end}`))
    const add: Era[] = []
    for (const p of ERA_PRESETS) {
      if (p.end < lo || p.start > hi || have.has(`${p.start}-${p.end}`)) continue
      have.add(`${p.start}-${p.end}`)
      add.push({ start: p.start, end: p.end })
    }
    const patch: Partial<ViewState> = {}
    if (add.length) patch.eras = [...state.eras, ...add]
    // the ERA widening alone doesn't make the chain visible: the position pills and the 2+
    // filter also hide players, and a chain with an off-position member (a goalie with G
    // unpressed) or a single-Cup bridge under Multi-Cup rendered as a broken corridor while
    // the flash claimed success. Re-enable exactly what the chain needs, in the SAME action.
    const newEras = patch.eras ?? state.eras
    const pos = { ...state.positions }
    let posChanged = false
    let needSingle = false
    for (const id of path) {
      const n = model.nodeById.get(id)
      if (n?.type !== 'player') continue
      if (!pos[n.group || 'F']) { pos[n.group || 'F'] = true; posChanged = true }
      if (n.cups!.filter((c) => inEras(c.year, newEras)).length < 2) needSingle = true
    }
    if (posChanged) patch.positions = pos
    if (state.multiOnly && needSingle) patch.multiOnly = false
    if (Object.keys(patch).length) change(patch)
    gv?.selectChain(path) // EXACT chain: the linking Cups appear without their rosters
    hoverNode = null // an open card described the pre-connect world - never leave a stale ghost
    restoring = false
    record()
    syncUrl()
    gv?.fit()
    // phones: the lit chain IS the feedback; the failure case above keeps its pill everywhere.
    // The span is often the astonishing part (Seattle to Gretzky crosses 67 years) - say it.
    const spanYears = hi - lo
    showFlash(`${a.label} → ${b.label}: connected through ${years.length} Cup${years.length !== 1 ? 's' : ''}`
      + (spanYears > 0 ? ` spanning ${spanYears} years` : ''))
  }
  // collapse the entire top bar so the graph gets the whole viewport. The graph itself must NOT
  // move or rescale - anchorNextResize pins it to the screen while the stage grows/shrinks.
  async function toggleChrome(hide: boolean) {
    gv?.anchorNextResize()
    chromeHidden = hide
    await tick()
    // the button that had focus (Hide, or the restore chevron) just unmounted - land focus on its
    // counterpart so keyboard users aren't stranded on <body> (symmetric with the playback-end path)
    document.querySelector<HTMLElement>(hide ? '.showchrome' : '[aria-label="Fit view"]')?.focus()
  }
  function reset() {
    // Reset is a HARD reset: nothing it does records, and the history is wiped afterwards -
    // the fresh state becomes the new undo baseline. "Start over" should mean it.
    restoring = true
    gv?.clearSelection()
    hoverNode = null
    change(defaultState())
    restoring = false
    gv?.fit()
    hist = histInit(snap())
  }

  // Tooltip follows the cursor (offset down-right), clamped so it stays on-screen. The vertical
  // reserve is the tooltip's ACTUAL measured height (an 11-Cup player like Henri Richard is ~290px,
  // well over any fixed guess), measured once per hovered node below. box-sizing:border-box caps the
  // box at 300px so the horizontal 312 reserve already prevents a right-edge clip.
  afterUpdate(() => {
    if (dockTip) {
      // reserve the sheet's height at the stage bottom so auto-fit frames content ABOVE it - but
      // NOT for the tablet corner card, which overlays one corner (reserving its height across the
      // full stage width shoved the whole graph up as if a sheet were open)
      gv?.setBottomInset(!cornerCard && hoverNode && tipEl ? tipEl.offsetHeight + 16 : 0)
      return
    }
    if (hoverNode && tipEl && hoverNode !== measuredFor) {
      const h = tipEl.offsetHeight; if (h) tipH = h; measuredFor = hoverNode
    }
  })
  $: tx = Math.max(8, Math.min(tipX + 16, winW - 312))
  $: ty = Math.max(8, Math.min(tipY + 16, winH - tipH - 14))

  // The sheet offers "Add to cut" only when adding would actually REVEAL something - the node
  // has neighbours the cut currently hides AND the era would let appear (a cut-hidden neighbour
  // that the era also hides stays hidden after an add). Referencing `state` keeps this reactive
  // across era/filter changes while the sheet stays open.
  $: sheetCanAdd = !!(state && hoverNode && cutActive && !selectedIds.includes(hoverNode.id) &&
    [...(model.adj.get(hoverNode.id) ?? [])].some((id) => {
      const nb = model.nodeById.get(id)
      if (!nb || nb.vis) return false
      return nb.type === 'cup' ? inEras(nb.year!, state.eras) : nb.rangeCupCount > 0
    }))

  // HTML-escape data-derived text before it goes into the {@html} tooltip. The current
  // dataset is clean, but names/teams originate from Wikipedia and the ETL is re-run yearly,
  // so a future `&`/`<`/`>` must not break or inject into the markup.
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

  // Takes the view state and cut flag explicitly so the {@html} expression below re-renders when
  // eras/filters/cut change - Svelte 4 only traces the template's own dependencies, not this
  // function's body. A player card states position + CAREER Cup total; the per-Cup rows (with
  // era/cut dimming) belong to desktop AND tablet corner cards - the phone sheet collapses to a
  // one-line label, not a directory.
  // `sel` is referenced purely so Svelte re-renders the {@html} card when the SELECTION changes:
  // in a cut the desktop rows dim by the keep-set, which moves with the selection.
  function tip(n: GNode, st: ViewState, cut: boolean, sel?: string[]): string {
    void sel
    if (n.type === 'cup') {
      let h = `<div class="t-name">${n.year} ${esc(n.team!)}</div>`
      h += `<div class="t-sub">Stanley Cup Champions · def. ${n.runnerUp ? esc(n.runnerUp) : '-'}${n.series ? ` <span style="white-space:nowrap">${esc(n.series)}</span>` : ''} · ${n.playerCount} engraved players</div>`
      if (n.connSmythe) h += `<div class="t-cup">${csIcon}Conn Smythe: <b>${esc(n.connSmythe)}</b></div>`
      // (champion cards deliberately carry NO roster list - the roster is what the canvas shows)
      return h
    }
    // dim the Cups the current view excludes; in a cut that is the Cup NODE's visibility
    // (cut keep-set ∩ era), outside a cut it is the era alone
    const inRange = (year: number) => cut ? !!model.nodeById.get(`cup-${year}`)?.vis : inEras(year, st.eras)
    if (dockTip && !cornerCard) {
      // phones: the whole card collapses to ONE inline line - "Name · F · 2 Cups: 1991 PIT, 1992 PIT"
      // (the roster is short for a player; it wraps if long). Each Cup that the current view excludes
      // dims. Tablet corner cards fall through to the desktop rows - a 360px card has the room, and
      // the one-liner there just wasted it (no swatches, no captain/Conn Smythe marks).
      const cups = n.cups!.map((c) =>
        `<span class="tc"${inRange(c.year) ? '' : ' style="opacity:.4"'}>${c.year} ${esc(c.abbr)}`
        + (inRange(c.year) ? '' : '<span class="sr-only"> (not in the current view)</span>') + `</span>`).join(', ')
      return `<div class="t-solo"><b>${esc(n.name!)}</b> · ${esc(posGroup(n.position))} · `
        + `${n.cupCount} Cup${n.cupCount !== 1 ? 's' : ''}: ${cups}</div>`
    }
    // desktop + tablet corner card: name, sub, then one row per Cup (swatch + year/team + captain/Conn Smythe marks)
    let h = `<div class="t-name">${esc(n.name!)}</div>`
    h += `<div class="t-sub">${esc(posFull(n.position))} · ${n.cupCount} Cup${n.cupCount !== 1 ? 's' : ''}</div>`
    for (const c of n.cups!) {
      // the dimming is opacity-only, which a screen reader can't hear - say it in words too
      h += `<div class="t-cup" style="opacity:${inRange(c.year) ? 1 : 0.4}"><span class="sw" style="background:${teamColor(c.abbr)}"></span>${c.year} ${esc(c.abbr)}`
        + (c.captain ? capIcon : '')
        + (c.connSmythe ? csIcon : '')
        + (inRange(c.year) ? '' : '<span class="sr-only"> (not in the current view)</span>') + `</div>`
    }
    return h
  }

</script>

<svelte:window on:resize={() => { winW = window.innerWidth; winH = window.innerHeight }} on:keydown={onKey} />

<div class="app">
  {#if !chromeHidden}
    <TopBar {state} {Y0} {Y1} {stats} {change} {reset} {theme} onTheme={changeTheme} {searchItems} onPick={pick} onConnect={connect}
      cut={cutActive} canCut={selectedIds.length > 0} onCut={() => gv?.setCut(!cutActive)} pulse={cutPulse}
      {canUndo} {canRedo} onUndo={undo} onRedo={redo}
      onLayoutShift={() => gv?.anchorNextResize()} onStory={applyStory}
      fit={() => gv?.fit()} hide={() => toggleChrome(true)} />
  {/if}

  <div class="stage">
    <!-- svelte-ignore a11y-no-interactive-element-to-noninteractive-role - WAI-ARIA permits any
         role on <canvas> (it has no implicit one); role="img" + a name is exactly how an
         inaccessible drawing surface should present itself, with the build-time sr-only block as
         the full text alternative -->
    <canvas bind:this={canvas} role="img"
      aria-label="Interactive network graph of Stanley Cup champions and engraved players. A text version of the same data follows this application for screen readers."></canvas>

    {#if chromeHidden && !pb}
      <button class="showchrome" class:pulse={scPulsing} on:click={() => toggleChrome(false)} use:uitip={'Show controls'} aria-label="Show controls">
        <!-- the exact chevron the Hide button uses, REVERSED: Hide points ^ (collapse the menu away),
             this points ▾ to pull it back (flipped to ▴ on the bottom-docked phone menu, see app.css) -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    {/if}

    <!-- playback transport for "A Brief History of Stanley": fixed at the bottom-centre of the
         stage. Year field (click to pause and type a year to jump to), rewind / play (two
         directional buttons - the lit one is the current direction, click it to pause), anchor
         jump (restart from the opposite end of history), speed, and exit. While the show runs this
         panel is the ONLY chrome - the top bar leaves and returns when the show ends. -->
    {#if pb}
      <div class="playbar" bind:this={pbEl} use:pbInset>
        {#if editingYear}
          <input class="pb-year pb-year-edit" type="number" inputmode="numeric" min={Y0} max={Y1}
            bind:value={yearInput} on:keydown={yearKey} on:blur={commitYear}
            use:focusSelect aria-label="Jump to year" />
        {:else}
          <button class="pb-year" on:click={startYearEdit} use:uitip={'Jump to a year'}
            aria-label={`Year ${pb.year ?? ''} - click to jump to a specific year`}>{pb.year ?? '–'}</button>
        {/if}
        <!-- two directional plays mapped to the TIME axis: ◀ toward older years (1915), ▶ toward
             newer years (2026), so a right arrow always moves the year up. The LIT one (accent) is
             the way time is currently flowing - click it to pause, click the other to reverse and
             play. movingToward (above), derived into playingOlder/playingNewer, resolves the current
             time direction for either show order, so this stays correct after an anchor swap. -->
        <button class="pb-btn" class:pb-on={playingOlder} on:click={() => gv?.playbackPlay(-1)}
          use:uitip={playingOlder ? 'Pause' : 'Older'}
          aria-label={playingOlder ? 'Pause' : 'Play back toward older years'}>
          {#if playingOlder}
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="16 5 5 12 16 19"/></svg>
          {/if}
        </button>
        <button class="pb-btn" class:pb-on={playingNewer} on:click={() => gv?.playbackPlay(1)}
          use:uitip={playingNewer ? 'Pause' : 'Newer'}
          aria-label={playingNewer ? 'Pause' : 'Play forward toward newer years'}>
          {#if playingNewer}
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="8 5 19 12 8 19"/></svg>
          {/if}
        </button>
        <!-- the jump button names its DESTINATION: the year it will restart the show from -->
        <button class="pb-btn pb-jump" on:click={() => gv?.playbackFlip()}
          use:uitip={pb.fromOldest ? `Jump to ${Y1}, play down the years` : `Jump to ${Y0}, play up the years`}
          aria-label={pb.fromOldest ? `Jump to ${Y1} and play down the years` : `Jump to ${Y0} and play up the years`}>
          {#if pb.fromOldest}
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 5 16 12 5 19"/><rect x="17" y="5" width="2.6" height="14" rx="1"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="19 5 8 12 19 19"/><rect x="4.4" y="5" width="2.6" height="14" rx="1"/></svg>
          {/if}
          <span>{pb.fromOldest ? Y1 : Y0}</span>
        </button>
        <button class="pb-btn pb-speed" on:click={() => gv?.playbackSpeed()} use:uitip={'Speed'} aria-label="Playback speed: {pb.speed === 0.5 ? 'half' : pb.speed + 'x'}">
          {pb.speed === 0.5 ? '½×' : `${pb.speed}×`}
        </button>
        <button class="pb-btn" on:click={() => gv?.stopPlayback()} use:uitip={'End playback'} aria-label="End playback">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
        </button>
      </div>
    {/if}

    <!-- guidance overlays: never leave a blank or fully-dimmed canvas unexplained -->
    {#if state.eras.length === 0}
      <div class="emptyera">
        <div class="big">No era selected</div>
        <div class="small">Pick one or more eras from the Eras menu{chromeHidden ? ' (tap the show-controls chevron in the corner)' : ' above'}</div>
      </div>
    {:else if cutActive && stats && stats.visible === 0}
      <div class="emptyera">
        <div class="big">Nothing from this cut in {eraLabel(state.eras)}</div>
        <div class="small">Change the era to bring the cut's Cups back - or tap the scissors to exit the cut</div>
      </div>
    {:else if hiddenSelection}
      <div class="emptyera">
        {#if hiddenWhy?.kind === 'pos'}
          <div class="big">{hiddenNames} {selectedIds.length === 1 ? 'is' : 'are'} hidden by the position filter</div>
          <div class="small">Turn the {hiddenWhy.hint} pill back on to light {selectedIds.length === 1 ? 'them' : 'them all'} up - or press Undo</div>
        {:else if hiddenWhy?.kind === 'multi'}
          <div class="big">{hiddenNames} {selectedIds.length === 1 ? 'is' : 'are'} hidden by the 2+ filter</div>
          <div class="small">Turn off the multi-Cup filter to light {selectedIds.length === 1 ? 'them' : 'them all'} up - or press Undo</div>
        {:else}
          <div class="big">{hiddenNames} {selectedIds.length === 1 ? "isn't" : "aren't"} in the selected era</div>
          <div class="small">Widen the era to light {selectedIds.length === 1 ? 'them' : 'them all'} up - or press Undo</div>
        {/if}
      </div>
    {/if}

    <!-- polite announcements for state changes that are otherwise invisible to screen readers -->
    <div class="sr-only" aria-live="polite">{announce}</div>

    {#if flash}
      <div class="flashbar">{flash}</div>
    {/if}

    {#if hoverNode}
      <div class="tip" class:docked={dockTip} bind:this={tipEl}
        style={dockTip ? '' : `left:${tx}px; top:${ty}px`}>
        {#if dockTip}
          <button class="tip-close" on:click={() => { hoverNode = null; gv?.dismissHover() }} aria-label="Dismiss">✕</button>
        {/if}
        {@html tip(hoverNode, state, cutActive, selectedIds)}
        {#if dockTip && cutActive}
          <!-- in cut mode, touch taps are inspect-only; the sheet carries the explicit edit -
             add this node's hidden network to the cut, or prune an anchor (never the last:
             that exit is the scissors). No button when it would visibly do nothing. -->
          {#if sheetCanAdd}
            <button class="tip-act add" on:click={() => hoverNode && gv?.selectNodes([hoverNode.id])}>Add to cut</button>
          {:else if selectedIds.includes(hoverNode.id) && selectedIds.length > 1}
            <button class="tip-act" on:click={() => hoverNode && gv?.deselectNode(hoverNode.id)}>Remove from cut</button>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
</div>
