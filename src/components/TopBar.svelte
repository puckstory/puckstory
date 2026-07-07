<script lang="ts">
  /*
   * TopBar.svelte - the control bar.
   *
   * Every control the user touches: the search box, the Fit / Link / Undo / Reset / Cut / Redo
   * action grid, the era pills and From / To year boxes, the position (F/D/G) and Multi-Cup
   * filters, the Position/Dynasty and Network/Hybrid/Timeline toggles, the theme swatches, the GitHub
   * link, and the hide button - plus the phone-only popover submenus that regroup them.
   * It holds no graph state of its own - each control calls back into App.svelte
   * (change / reset / fit / onPick / ...), which drives GraphView.
   */
  import type { ViewState } from '../lib/types'
  import type { RangeStats } from '../lib/graphview'
  import { POS_COLORS, eraBounds, ERA_PRESETS } from '../lib/model'
  import { filterSearch, type SearchItem } from '../lib/search'
  // (the armed-endpoint exclusion happens inside filterSearch, BEFORE its result cap)
  import { STORIES, type Story } from '../lib/stories'
  import { isCoarsePointer } from '../lib/env'
  import { cupSvgPath } from '../lib/render'
  import { THEMES, type ThemeId } from '../lib/theme'
  import { tip } from '../lib/tip'

  const cupD = cupSvgPath() // Stanley Cup silhouette (same outline as the team nodes), for the Multi-Cup pill

  export let state: ViewState
  export let Y0: number
  export let Y1: number
  export let stats: RangeStats | null
  export let change: (p: Partial<ViewState>) => void
  export let reset: () => void
  export let fit: () => void
  export let hide: () => void
  export let theme: ThemeId
  export let onTheme: (t: ThemeId) => void
  export let cut = false                       // cut mode active (scissors pressed)
  export let canCut = false                    // something is selected, so there is a network to cut to
  export let onCut: () => void = () => {}
  export let canUndo = false
  export let canRedo = false
  export let onUndo: () => void = () => {}
  export let onRedo: () => void = () => {}
  // bumped by App whenever cut-mode swallows a background misclick; each bump replays the
  // scissors' pulse animation (drop the class, re-add next frame so the animation restarts).
  // pulseSeen seeds with the MOUNT-time count: the bar unmounts while the chrome is hidden, and
  // a remount must not replay a pulse that already fired (only a fresh bump should).
  export let pulse = 0
  let pulseSeen = pulse
  let pulsing = false
  let pulseTimer: ReturnType<typeof setTimeout> | 0 = 0
  $: if (pulse !== pulseSeen) {
    pulseSeen = pulse
    pulsing = false
    if (pulseTimer) clearTimeout(pulseTimer)
    // double rAF: the class removal must reach a style recalc before the re-add, or a second
    // bump inside the 1.3s animation window never restarts it
    requestAnimationFrame(() => requestAnimationFrame(() => (pulsing = true)))
    pulseTimer = setTimeout(() => (pulsing = false), 1300)
  }
  export let searchItems: SearchItem[] = []
  export let onPick: (item: SearchItem) => void
  export let onConnect: (from: SearchItem, to: SearchItem) => void = () => {}
  // announced before a chrome change that could shift the bar's height (hide/restore, desktop layout) so the graph transform stays pinned and doesn't jump - submenu popovers no longer resize the bar, so that is no longer a trigger
  export let onLayoutShift: () => void = () => {}
  export let onStory: (s: Story) => void = () => {}

  type Preset = { name: string; years: string; from: number; to: number }
  // The six named NHL eras, covering the timeline end to end; tap any combination to combine
  // them. The list itself lives in lib/model.ts (ERA_PRESETS) - Six Degrees appends from it too.
  const eras: Preset[] = ERA_PRESETS.map((p) => ({ name: p.name, years: `${p.start}-${p.end}`, from: p.start, to: p.end }))
  // ordered so the Multi-Cup + F/D/G 2×2 grid reads [2+  G] / [F  D]
  const groups: ('F' | 'D' | 'G')[] = ['G', 'F', 'D']
  const posTip: Record<'F' | 'D' | 'G', string> =
    { F: 'Show or hide forwards', D: 'Show or hide defensemen', G: 'Show or hide goaltenders' }

  const isOn = (p: Preset) => state.eras.some((e) => e.start === p.from && e.end === p.to)
  function toggleEra(p: Preset) {
    if (isOn(p)) change({ eras: state.eras.filter((e) => !(e.start === p.from && e.end === p.to)) })
    else change({ eras: [...state.eras, { start: p.from, end: p.to }] })
  }
  $: bounds = eraBounds(state.eras)                      // [lo, hi] of current selection
  $: activeKeys = new Set(state.eras.map((e) => `${e.start}-${e.end}`))
  // typing a year collapses the selection to ONE custom range, which deselects every era pill
  // (none matches); the From/To block then highlights as the active "pill" itself
  $: isCustom = state.eras.length === 1 &&
    !eras.some((p) => p.from === state.eras[0].start && p.to === state.eras[0].end)
  const clamp = (v: number) => Math.max(Y0, Math.min(Y1, Math.round(v)))
  // Typing a year collapses the selection to ONE custom range spanning both boxes. An emptied
  // box must NOT commit: +'' is 0, which clamp() would turn into Y0 and silently collapse the
  // whole range to 1915 (the ?from=/?to= URL parse guards exactly this; the live inputs must
  // too). Restore the displayed bound instead - value= is one-way, so put it back by hand.
  function setFrom(raw: string, el: HTMLInputElement) {
    if (!raw.trim() || !Number.isFinite(+raw)) { el.value = String(bounds[0]); return }
    const a = clamp(+raw); change({ eras: [{ start: a, end: Math.max(a, bounds[1]) }] })
  }
  function setTo(raw: string, el: HTMLInputElement) {
    if (!raw.trim() || !Number.isFinite(+raw)) { el.value = String(bounds[1]); return }
    const b = clamp(+raw); change({ eras: [{ start: Math.min(b, bounds[0]), end: b }] })
  }
  function togglePos(g: 'F' | 'D' | 'G') { change({ positions: { ...state.positions, [g]: !state.positions[g] } }) }

  // search dropdown: folded-key matches; items the current filters hide (era, position pills,
  // 2+) still surface, greyed with a note saying why - best (prefix) matches first - see lib/search.ts
  let query = ''
  let open = false
  let active = -1                       // arrow-key highlighted row (-1 = none)
  let searchEl: HTMLInputElement | undefined
  // while the connector is armed, its own endpoint disappears from the results - you can't
  // six-degree a player to themselves (a team target containing that player is still fine)
  $: results = filterSearch(searchItems, query, state, 8, connectFrom ?? undefined)
  // reset the arrow-key highlight whenever it no longer points INSIDE the list - narrowing a
  // query used to leave a stale index past the end, and Enter then picked undefined
  $: if (results.length === 0 || query === '' || active >= results.length) active = -1

  // "Six Degrees": the 6° button on a result arms a CONNECTOR - the next pick doesn't select,
  // it asks App to light the shortest engraved chain between the two endpoints. Esc disarms.
  let connectFrom: SearchItem | null = null
  function armConnect(item: SearchItem) {
    connectFrom = item
    query = ''; active = -1; open = true
    searchEl?.focus() // keep typing - the second endpoint comes from this same box
  }
  function pickResult(item: SearchItem) {
    const from = connectFrom
    connectFrom = null
    query = ''; open = false; active = -1
    // dismiss the mobile keyboard - tapping the canvas to do it would deselect. TOUCH ONLY:
    // on desktop the search pick is the keyboard path to the card, and blurring dropped a
    // keyboard user onto <body> (a full re-Tab through the bar) after every single pick
    if (isCoarsePointer()) searchEl?.blur()
    if (from) onConnect(from, item)
    else onPick(item)
  }
  function pickStory(s: Story) {
    query = ''; open = false; active = -1
    if (isCoarsePointer()) searchEl?.blur() // touch only - see pickResult
    onStory(s)
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); open = true; active = (active + 1) % results.length }
    else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); open = true; active = (active <= 0 ? results.length : active) - 1 }
    else if (e.key === 'Enter' && results.length) {
      e.preventDefault()
      const item = results[active >= 0 && active < results.length ? active : 0]
      // Shift+Enter is the keyboard 6°: arm the connector on the highlighted result instead of
      // picking it (the visual 6° button is pointer-only - aria-hidden, out of the Tab order)
      if (e.shiftKey && !connectFrom) armConnect(item)
      else pickResult(item)
    }
    else if (e.key === 'Escape') {
      // first Esc only disarms the connector; the highlight resets too - disarming lets the
      // armed item back into the list, which would silently shift a kept index onto another row
      if (connectFrom) { connectFrom = null; active = -1; return }
      query = ''; open = false; active = -1
      if (isCoarsePointer()) searchEl?.blur() // touch only - see pickResult
    }
  }

  // the search dropdown closes on an outside tap. (It deliberately does NOT close on input blur:
  // that used to dismiss it before keyboard Tab could ever reach a result.)
  function onDocClick(e: PointerEvent) {
    const t = e.target as HTMLElement
    if (open && !t.closest?.('.tb-searchwrap')) { open = false; active = -1 }
    // a tap outside an open submenu (its header + popover body live inside .msec) closes it, like the
    // search dropdown - so tapping the graph dismisses a Filters/Eras popover instead of stranding it
    if (openSection && !t.closest?.('.msec')) closeSection()
  }
  // Escape closes an open submenu too (mirrors the search dropdown's Escape). Playback owns Escape
  // while a show runs, but the top bar is hidden then, so there is no conflict.
  function onWinKey(e: KeyboardEvent) { if (e.key === 'Escape' && openSection) closeSection(true) }
  // every submenu now opens as a popover (absolute, no reflow), so closing never changes the bar
  // height. Keyboard closes (Escape) return focus to the section's header - display:none would
  // otherwise strand it on <body>; pointer closes leave focus where the tap put it.
  let secH: Record<string, HTMLButtonElement | undefined> = {}
  function closeSection(refocus = false) {
    if (refocus && openSection) secH[openSection]?.focus()
    openSection = null
  }

  // On phones the bar docks at the BOTTOM in two rows: row 1 is search + the Filters and Eras submenu
  // headers, row 2 is the Theme icon-button + the icon actions + hide. Only one submenu opens at a
  // time; all three (Filters, Eras, Theme) open as popovers above their own header. The ▾ hide button
  // hands the whole screen to the graph. Session-local, all closed by default. Desktop renders the
  // wrappers as display:contents - no change there.
  let openSection: 'eras' | 'filters' | 'theme' | null = null
  const toggleSection = (s: 'eras' | 'filters' | 'theme') => {
    onLayoutShift() // keep the graph transform pinned across the toggle (App → GraphView)
    openSection = openSection === s ? null : s
  }
  $: eraSummary = (() => {
    const names = eras.filter((p) => state.eras.some((e) => e.start === p.from && e.end === p.to)).map((p) => p.name)
    if (names.length) return names.join(' + ')
    if (!state.eras.length) return 'None'
    if (state.eras.length === 1) {
      const e = state.eras[0]
      return e.start === e.end ? `${e.start}` : `${e.start}–${e.end}` // "1993", not "1993–1993"
    }
    return `${state.eras.length} ranges`
  })()
  $: filterSummary = [
    state.multiOnly ? '2+' : '',
    (['F', 'D', 'G'] as const).some((g) => !state.positions[g])
      ? 'no ' + (['F', 'D', 'G'] as const).filter((g) => !state.positions[g]).join('/') : '',
    state.colorMode === 'dynasty' ? 'Dynasty' : 'Position',
    state.layoutMode === 'timeline' ? 'Timeline' : state.layoutMode === 'hybrid' ? 'Hybrid' : 'Network',
  ].filter(Boolean).join(' · ')
  $: curTheme = THEMES.find((t) => t.id === theme) ?? THEMES[0]

  // undo/redo tooltips show the platform's own shortcut - "Ctrl+Z" on a Mac reads as a foreign OS
  const mod = (() => { try { return /Mac|iP(hone|ad|od)/.test(navigator.platform) ? '⌘' : 'Ctrl+' } catch { return 'Ctrl+' } })()

  // share: the address bar is kept in sync with the view state (App.syncUrl), so sharing is just
  // copying the current URL
  let copied = false
  async function share() {
    // phones get the OS share sheet (Messages, AirDrop, ...) instead of a silent clipboard
    // write; a cancelled sheet just closes. Desktop keeps the copy behaviour.
    if (isCoarsePointer() && (navigator as { share?: (d: object) => Promise<void> }).share) {
      try { await (navigator as unknown as { share: (d: object) => Promise<void> }).share({ title: 'Puckstory', url: location.href }) } catch {}
      return
    }
    try { await navigator.clipboard.writeText(location.href) } catch {
      // clipboard denied or unavailable (http, iframe, permissions) - a prompt still hands the
      // user a selectable link instead of failing silently
      try { window.prompt('Copy this link:', location.href) } catch {}
      return
    }
    copied = true
    setTimeout(() => (copied = false), 1400)
  }
</script>

<svelte:window on:pointerdown={onDocClick} on:keydown={onWinKey} />

<div class="topbar">
  <div class="tb-searchwrap">
    <input class="tb-search" placeholder={connectFrom ? `Connect ${connectFrom.label} to…` : 'Search players / teams…'}
      aria-label={connectFrom ? `Connect ${connectFrom.label} to another player or team` : 'Search players and teams'} autocomplete="off"
      role="combobox" aria-expanded={open} aria-controls="tb-results" aria-autocomplete="list"
      aria-activedescendant={active >= 0 ? `tb-opt-${active}` : undefined} aria-describedby="tb-search-hint"
      bind:this={searchEl} bind:value={query}
      on:focus={() => (open = true)} on:input={() => (open = true)} on:keydown={onSearchKey} />
    <!-- the keyboard mirror of the pointer-only 6° button (which is aria-hidden: an interactive
         child would flatten into every option's announced name and fight the activedescendant
         focus model) - announced once when the box takes focus -->
    <span class="sr-only" id="tb-search-hint">Shift plus Enter connects the highlighted result to another player or team through Six Degrees</span>
    <!-- the panel stays mounted for ANY open state: a typo that matches nothing gets an explicit
         "no matches" row instead of the whole dropdown vanishing mid-keystroke -->
    {#if open}
      <div class="tb-results" id="tb-results" role="listbox" aria-label="Search results">
        {#if connectFrom}
          <div class="tb-connect">6° Connecting <b>{connectFrom.label}</b> - pick the other end (Esc cancels)</div>
        {/if}
        {#if !query && !connectFrom}
          <!-- an EMPTY focused box offers the curated stories - each is just a saved view state,
               the same thing a shared link carries; typing anything swaps to real results -->
          <div class="tb-stories" role="none">
            <div class="st-head">Stories</div>
            {#each STORIES as s}
              <button class="tb-story" on:mousedown|preventDefault={() => {}} on:click={() => pickStory(s)}>
                <span class="s-title">{s.title}</span><span class="s-blurb">{s.blurb}</span>
              </button>
            {/each}
          </div>
        {/if}
        <!-- mousedown|preventDefault (action-less) stops the input's blur from dismissing the
             dropdown before a pick can land; the ACTION rides on click, which keyboards fire
             too (Enter/Space on a focused button) - action-on-mousedown left Tab users dead -->
        <!-- APG combobox: the ROW is the option and must have no interactive descendants in the
             a11y tree - the option's announced name is its flattened content. Keyboard runs
             entirely through the input (arrows highlight, Enter picks, Shift+Enter connects), so
             the row itself is never focused; the 6° button is pointer-only chrome (aria-hidden,
             out of the Tab order) whose action Shift+Enter mirrors. -->
        {#each results as r, i}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-interactive-supports-focus -->
          <div class="tb-result" class:active={i === active} class:dim={!!r.hiddenNote}
            id="tb-opt-{i}" role="option" aria-selected={i === active}
            on:mousedown|preventDefault={() => {}} on:click={() => pickResult(r)}>
            <span class="r-main">
              <span class="r-label">{r.label}</span><span class="r-sub">{r.sub}</span>
              {#if r.hiddenNote}<span class="r-note">{r.hiddenNote}</span>{/if}
            </span>
            {#if !connectFrom}
              <button class="r-deg" tabindex="-1" aria-hidden="true"
                on:mousedown|preventDefault={() => {}} on:click|stopPropagation={() => armConnect(r)}
                use:tip={'Six Degrees - find the shortest teammate chain to another player or team'}>6°</button>
            {/if}
          </div>
        {/each}
        {#if query && !results.length}
          <div class="tb-noresults" role="status">No players or teams match “{query}”</div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- action grid: [fit][link][undo] over [reset][cut][redo] (a single 6-across row on phones) -->
  <div class="iconstack">
    <!-- fit: corner brackets FRAMING a dot - "put the content in the frame" - instead of the
         bare maximize corners, which read as a window control -->
    <button class="iconbtn i-fit" on:click={fit} use:tip={'Fit view to the current selection'} aria-label="Fit view">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>
        <circle cx="12" cy="12" r="3.1" fill="currentColor" stroke="none"/>
      </svg>
      <span class="cap" aria-hidden="true">Fit</span>
    </button>
    <button class="iconbtn i-link" on:click={share} aria-label="Copy a link to this view" use:tip={'Copy a link to this exact view'}>
      {#if copied}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
      {/if}
      <span class="cap" aria-hidden="true">{copied ? 'Copied' : 'Link'}</span>
      <span class="sr-only" aria-live="polite">{copied ? 'Link copied to clipboard' : ''}</span>
    </button>
    <button class="iconbtn i-undo" disabled={!canUndo} on:click={onUndo} use:tip={`Undo (${mod}Z)`} aria-label="Undo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>
      </svg>
      <span class="cap" aria-hidden="true">Undo</span>
    </button>
    <button class="iconbtn i-reset" on:click={reset} use:tip={'Reset - start over (clears filters, selection, and undo history)'} aria-label="Reset">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
      </svg>
      <span class="cap" aria-hidden="true">Reset</span>
    </button>
    <button class="iconbtn i-cut" class:on={cut} class:pulse={pulsing} aria-pressed={cut} disabled={!cut && !canCut} on:click={onCut}
      use:tip={'Cut - keep only the selected network and hide everything else'} aria-label="Cut to selection">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88"/><path d="M14.47 14.48 20 20"/><path d="M8.12 8.12 12 12"/>
      </svg>
      <span class="cap" aria-hidden="true">Cut</span>
    </button>
    <button class="iconbtn i-redo" disabled={!canRedo} on:click={onRedo} use:tip={`Redo (${mod}Shift+Z)`} aria-label="Redo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>
      </svg>
      <span class="cap" aria-hidden="true">Redo</span>
    </button>
  </div>

  <span class="divider"></span>

  <!-- On phones each .msec is a bottom-bar submenu (header + body); the Eras/Filters bodies open as
       upward popovers above their header, and Theme's body opens the same way. On desktop the
       wrappers are display:contents and the headers display:none - the flex row is untouched. -->
  <div class="msec msec-eras" class:mopen={openSection === 'eras'}>
    <button class="msec-h" bind:this={secH.eras} on:click={() => toggleSection('eras')}
      aria-expanded={openSection === 'eras'} aria-controls="msec-b-eras">
      <span class="mh-t">Eras</span><span class="mh-s">{eraSummary}</span><svg class="mh-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="msec-b" id="msec-b-eras">
      <div class="grp">
        <!-- --mob-order: the phone menu lists eras most-recent-first (CSS `order`); tying the
             value to the data here keeps it correct if an era is ever added or reordered -->
        {#each eras as p, i}
          <button class="pill era" style="--mob-order:{eras.length - i}"
            class:on={activeKeys.has(`${p.from}-${p.to}`)} aria-pressed={activeKeys.has(`${p.from}-${p.to}`)}
            aria-label={`${p.name}, ${p.years}`} on:click={() => toggleEra(p)}>
            <span class="en">{p.name}</span>
            <span class="ey">{p.years}</span>
          </button>
        {/each}
      </div>

      <div class="grp years" class:on={isCustom}>
        <!-- On phones each year is ONE bordered field with its label inside ([FROM 2006][TO 2026],
             side by side); desktop hides the labels and keeps the compact stacked boxes - the
             .ybox wrappers are display:contents there (aria-labels cover AT everywhere) -->
        <label class="ybox">
          <span class="ylab" aria-hidden="true">From</span>
          <input type="number" min={Y0} max={Y1} value={bounds[0]} aria-label="From year"
            on:change={(e) => setFrom(e.currentTarget.value, e.currentTarget)} />
        </label>
        <label class="ybox">
          <span class="ylab" aria-hidden="true">To</span>
          <input type="number" min={Y0} max={Y1} value={bounds[1]} aria-label="To year"
            on:change={(e) => setTo(e.currentTarget.value, e.currentTarget)} />
        </label>
      </div>
    </div>
  </div>

  <span class="divider"></span>

  <div class="msec msec-filt" class:mopen={openSection === 'filters'}>
    <button class="msec-h" bind:this={secH.filters} on:click={() => toggleSection('filters')}
      aria-expanded={openSection === 'filters'} aria-controls="msec-b-filters">
      <span class="mh-t">Filters</span><span class="mh-s">{filterSummary}</span><svg class="mh-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="msec-b" id="msec-b-filters">
      <div class="grp posgrid">
        <button class="pill multi" class:on={state.multiOnly} aria-pressed={state.multiOnly}
          on:click={() => change({ multiOnly: !state.multiOnly })}
          aria-label="Multi-Cup only" use:tip={'Multi-Cup only - players who won 2 or more Cups in the selected range'}>
          <svg class="cupicon" viewBox="-0.66 -1.5 1.32 2.86" aria-hidden="true"><path d={cupD} fill="currentColor" /></svg>2+
        </button>
        {#each groups as g}
          <button class="pill pos" class:on={state.positions[g]} aria-pressed={state.positions[g]}
            style="--c:{POS_COLORS[g]}" on:click={() => togglePos(g)}
            use:tip={posTip[g]} aria-label={posTip[g]}>
            {g}{stats ? ` ${stats.posCounts[g]}` : ''}
          </button>
        {/each}
      </div>

      <span class="divider"></span>

      <div class="segstack">
        <div class="seg" role="group" aria-label="Colour by">
          <button class:on={state.colorMode === 'position'} aria-pressed={state.colorMode === 'position'}
            on:click={() => change({ colorMode: 'position' })} aria-label="Colour by position">Position</button>
          <button class:on={state.colorMode === 'dynasty'} aria-pressed={state.colorMode === 'dynasty'}
            on:click={() => change({ colorMode: 'dynasty' })} aria-label="Colour by dynasty">Dynasty</button>
        </div>
        <!-- Layout toggle: text on desktop, icons on phones (CSS swaps .seg-tx <-> .seg-ic). aria-label
             carries the name for both. Network = connected hub; Hybrid = a connected chain flowing down
             (network ordered by time); Timeline = a grid of nodes (chronological rows). -->
        <div class="seg seg-layout" role="group" aria-label="Layout">
          <button class:on={state.layoutMode === 'network'} aria-pressed={state.layoutMode === 'network'}
            on:click={() => change({ layoutMode: 'network' })} aria-label="Network layout">
            <svg class="seg-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M12 12 5 6M12 12 19 7M12 12 7 19M12 12 18 18"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><circle cx="5" cy="6" r="1.9" fill="currentColor" stroke="none"/><circle cx="19" cy="7" r="1.9" fill="currentColor" stroke="none"/><circle cx="7" cy="19" r="1.9" fill="currentColor" stroke="none"/><circle cx="18" cy="18" r="1.9" fill="currentColor" stroke="none"/></svg><span class="seg-tx">Network</span></button>
          <button class:on={state.layoutMode === 'hybrid'} aria-pressed={state.layoutMode === 'hybrid'}
            on:click={() => change({ layoutMode: 'hybrid' })} aria-label="Hybrid layout: network blob ordered by year">
            <svg class="seg-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 5 13 11 8 16 18 19"/><circle cx="6" cy="5" r="1.9" fill="currentColor" stroke="none"/><circle cx="13" cy="11" r="1.9" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.9" fill="currentColor" stroke="none"/><circle cx="18" cy="19" r="1.9" fill="currentColor" stroke="none"/></svg><span class="seg-tx">Hybrid</span></button>
          <button class:on={state.layoutMode === 'timeline'} aria-pressed={state.layoutMode === 'timeline'}
            on:click={() => change({ layoutMode: 'timeline' })} aria-label="Timeline layout">
            <svg class="seg-ic" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="6" r="1.5"/><circle cx="11" cy="6" r="1.5"/><circle cx="17" cy="6" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="12" r="1.5"/><circle cx="17" cy="12" r="1.5"/><circle cx="5" cy="18" r="1.5"/><circle cx="11" cy="18" r="1.5"/><circle cx="17" cy="18" r="1.5"/></svg><span class="seg-tx">Timeline</span></button>
        </div>
      </div>
    </div>
  </div>

  <span class="divider"></span>

  <div class="tb-actions">
    <div class="themewrap msec" class:mopen={openSection === 'theme'}>
      <button class="msec-h" bind:this={secH.theme} on:click={() => toggleSection('theme')}
        aria-expanded={openSection === 'theme'} aria-controls="msec-b-theme">
        <span class="mh-t">Theme</span><span class="mh-s">{curTheme.label}</span><svg class="mh-c" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="msec-b" id="msec-b-theme">
        <!-- the swatch strip shows inline on desktop; on phones it is the Theme submenu's body -->
        <div class="themegrid" role="group" aria-label="Colour theme">
          {#each THEMES as t}
            <button class="swatch" class:on={theme === t.id} style="--sw-bg:{t.bg}; --sw-acc:{t.accent}"
              aria-label={t.label} aria-pressed={theme === t.id}
              on:click={() => onTheme(t.id)}></button>
          {/each}
        </div>
      </div>
    </div>

    <!-- source link: official GitHub mark (Octicons mark-github, per github.com/logos brand toolkit) -->
    <a class="ghlink" href="https://github.com/puckstory/puckstory" target="_blank" rel="noopener noreferrer"
      aria-label="View Puckstory source on GitHub" use:tip={'View source on GitHub'}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    </a>
    <!-- hide lives inside tb-actions so the phone grid places it on the actions row; on desktop
         tb-actions is display:contents, so this stays the same right-pinned flex item as ever -->
    <button class="ghost icon" on:click={hide} aria-label="Hide controls" use:tip={'Hide controls - maximize the graph'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
    </button>
  </div>
</div>
