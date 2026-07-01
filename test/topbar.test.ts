import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/svelte'
import { tick } from 'svelte'
import TopBar from '../src/components/TopBar.svelte'
import { buildModel } from '../src/lib/model'
import { buildSearchIndex } from '../src/lib/search'
import { defaultState } from '../src/lib/urlstate'
import type { ViewState } from '../src/lib/types'

// Real component tests for the control bar - era-pill union toggling, From/To collapse, the
// search dropdown's keyboard path, and toggle-state exposure (aria-pressed) - none of which had
// any coverage before (only the pure helpers underneath them did).

const model = buildModel()
const searchItems = buildSearchIndex(model)

function mount(statePatch: Partial<ViewState> = {}, extra: Record<string, unknown> = {}) {
  const change = vi.fn(), reset = vi.fn(), fit = vi.fn(), hide = vi.fn(), onTheme = vi.fn(), onPick = vi.fn()
  const state: ViewState = { ...defaultState(), ...statePatch }
  const utils = render(TopBar, {
    props: { state, Y0: 1915, Y1: 2026, stats: null, change, reset, fit, hide,
      theme: 'solarized-light', onTheme, searchItems, onPick, ...extra },
  })
  return { ...utils, change, reset, fit, hide, onTheme, onPick, state }
}
afterEach(cleanup)

describe('the From/To boxes reject an emptied value', () => {
  // +'' is 0 -> clamp() -> 1915: an emptied box used to silently collapse the whole era range
  // to the single year 1915. It must restore the displayed bound and change() nothing.
  it('clearing To restores 2026 and commits no change', async () => {
    const { getByLabelText, change } = mount()
    const to = getByLabelText('To year') as HTMLInputElement
    await fireEvent.change(to, { target: { value: '' } })
    expect(change).not.toHaveBeenCalled()
    expect(to.value).toBe('2026')
  })
  it('clearing From restores 2006 and commits no change', async () => {
    const { getByLabelText, change } = mount()
    const from = getByLabelText('From year') as HTMLInputElement
    await fireEvent.change(from, { target: { value: '' } })
    expect(change).not.toHaveBeenCalled()
    expect(from.value).toBe('2006')
  })
})

describe('era pills combine as a union', () => {
  it('tapping an inactive pill ADDS its range to the selection', async () => {
    const { getByText, change } = mount() // default: cap era active
    await fireEvent.click(getByText('Original Six').closest('button')!)
    expect(change).toHaveBeenCalledWith({ eras: [{ start: 2006, end: 2026 }, { start: 1942, end: 1967 }] })
  })
  it('tapping an active pill REMOVES only its range', async () => {
    const { getByText, change } = mount({ eras: [{ start: 2006, end: 2026 }, { start: 1942, end: 1967 }] })
    await fireEvent.click(getByText('Cap').closest('button')!)
    expect(change).toHaveBeenCalledWith({ eras: [{ start: 1942, end: 1967 }] })
  })
  it('active pills expose their state via aria-pressed', () => {
    // by aria-label: the Eras submenu summary also reads "Cap", so text queries are ambiguous
    const { getByLabelText } = mount()
    expect(getByLabelText('Cap, 2006-2026').getAttribute('aria-pressed')).toBe('true')
    expect(getByLabelText('Original Six, 1942-1967').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('From/To year boxes', () => {
  it('typing a From year collapses the selection to one range', async () => {
    const { getByLabelText, change } = mount({ eras: [{ start: 1942, end: 1967 }, { start: 2006, end: 2026 }] })
    await fireEvent.change(getByLabelText('From year'), { target: { value: '1980' } })
    expect(change).toHaveBeenCalledWith({ eras: [{ start: 1980, end: 2026 }] })
  })
  it('typing a To year collapses the selection to one range ending there', async () => {
    const { getByLabelText, change } = mount({ eras: [{ start: 1942, end: 1967 }] })
    await fireEvent.change(getByLabelText('To year'), { target: { value: '1950' } })
    expect(change).toHaveBeenCalledWith({ eras: [{ start: 1942, end: 1950 }] })
  })
  it('a To year below the current start collapses to that single year', async () => {
    // setTo takes min(bounds[0], value) as the new start, so the range never inverts
    const { getByLabelText, change } = mount({ eras: [{ start: 1942, end: 1967 }] })
    await fireEvent.change(getByLabelText('To year'), { target: { value: '1930' } })
    expect(change).toHaveBeenCalledWith({ eras: [{ start: 1930, end: 1930 }] })
  })
  it('a From year far below the dataset floor clamps to Y0', async () => {
    const { getByLabelText, change } = mount() // default cap era 2006-2026, Y0 = 1915
    await fireEvent.change(getByLabelText('From year'), { target: { value: '1800' } })
    expect(change).toHaveBeenCalledWith({ eras: [{ start: 1915, end: 2026 }] })
  })
  it('a custom range lights the From/To block as the active "pill"; a preset leaves it plain', () => {
    const custom = mount({ eras: [{ start: 1950, end: 1980 }] })
    expect(custom.container.querySelector('.years')!.classList.contains('on')).toBe(true)
    // and no era pill claims the selection
    const pressed = [...custom.container.querySelectorAll('.pill.era')].map((b) => b.getAttribute('aria-pressed'))
    expect(pressed.every((p) => p === 'false')).toBe(true)
    cleanup()
    const preset = mount() // default cap era: the Cap pill owns the selection, not the year boxes
    expect(preset.container.querySelector('.years')!.classList.contains('on')).toBe(false)
    expect(preset.getByLabelText('Cap, 2006-2026').getAttribute('aria-pressed')).toBe('true')
  })
})

describe('search dropdown', () => {
  it('typing shows results; ArrowDown + Enter picks the highlighted one and clears the box', async () => {
    const { getByRole, getAllByRole, onPick } = mount({ eras: [{ start: 1980, end: 1993 }] })
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'gretzky' } })
    const options = getAllByRole('option')
    expect(options.length).toBeGreaterThan(0)
    await fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe('tb-opt-0')
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0].label).toContain('Gretzky')
    expect(input.value).toBe('')
  })
  it('Enter with no highlight picks the first (best) result', async () => {
    const { getByRole, onPick } = mount({ eras: [{ start: 1980, end: 1993 }] })
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'messier' } })
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    // WHICH one matters: selectable matches sort first, so in-era Mark Messier (1984-1990,
    // all Oilers - his Rangers Cup is 1994, outside this era) must beat out-of-era Éric Messier (2001)
    expect(onPick.mock.calls[0][0].label).toBe('Mark Messier')
  })
  it('Escape clears the query, closes the dropdown, and blurs the input', async () => {
    const { getByRole, queryByRole } = mount({ eras: [{ start: 1980, end: 1993 }] })
    const input = getByRole('combobox') as HTMLInputElement
    input.focus()
    await fireEvent.input(input, { target: { value: 'gretzky' } })
    expect(queryByRole('listbox')).toBeTruthy()
    await fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('')
    expect(queryByRole('listbox')).toBeNull()
    expect(document.activeElement).not.toBe(input) // blurred, so the mobile keyboard dismisses
  })
  it('ArrowUp with no highlight wraps to the tail of the list instead of clamping at the top', async () => {
    const { getByRole, getAllByRole } = mount({ eras: [{ start: 1980, end: 1993 }] })
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'mark' } })
    const n = getAllByRole('option').length
    expect(n).toBeGreaterThan(2)
    await fireEvent.keyDown(input, { key: 'ArrowUp' })
    // from no highlight (active=-1), ArrowUp lands on the TRUE last row
    expect(input.getAttribute('aria-activedescendant')).toBe(`tb-opt-${n - 1}`)
  })
  it('a pointerdown outside the search closes the dropdown; blurring the input does not', async () => {
    const { getByRole, queryByRole } = mount({ eras: [{ start: 1980, end: 1993 }] })
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'gretzky' } })
    expect(queryByRole('listbox')).toBeTruthy()
    // blur alone must NOT dismiss - keyboard Tab has to be able to reach the results
    await fireEvent.blur(input)
    expect(queryByRole('listbox')).toBeTruthy()
    await fireEvent.pointerDown(document.body)
    expect(queryByRole('listbox')).toBeNull()
  })
  it('players hidden by the current view appear greyed with an explanatory note', async () => {
    const { getByRole, getAllByRole } = mount({
      eras: [{ start: 1980, end: 1993 }],
      positions: { F: true, D: true, G: false },
    })
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'grant fuhr' } }) // 80s Oilers goalie
    const opts = getAllByRole('option')
    expect(opts.length).toBeGreaterThan(0)
    expect(opts[0].className).toContain('dim')
    expect(opts[0].textContent).toMatch(/goaltenders are filtered out/)
  })
})

describe('share (Link) button', () => {
  // happy-dom may not define navigator.clipboard at all - install one per test (configurable
  // so it can be removed) and restore whatever was there before
  function stubClipboard(writeText: (t: string) => Promise<void>) {
    const desc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    return () => {
      if (desc) Object.defineProperty(navigator, 'clipboard', desc)
      else delete (navigator as any).clipboard
    }
  }
  it('copy success: the caption flips to Copied and the live region announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const restore = stubClipboard(writeText)
    try {
      const { getByLabelText, container } = mount()
      await fireEvent.click(getByLabelText('Copy a link to this view'))
      await new Promise((r) => setTimeout(r, 0)) // let the writeText promise + DOM update settle
      expect(writeText).toHaveBeenCalledWith(window.location.href)
      expect(container.querySelector('.i-link .cap')!.textContent).toBe('Copied')
      expect(container.querySelector('.i-link .sr-only')!.textContent).toBe('Link copied to clipboard')
    } finally { restore() }
  })
  it('copy failure: falls back to window.prompt with the URL and shows no Copied state', async () => {
    const restore = stubClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    const origPrompt = window.prompt
    const prompt = vi.fn()
    window.prompt = prompt as any
    try {
      const { getByLabelText, container } = mount()
      await fireEvent.click(getByLabelText('Copy a link to this view'))
      await new Promise((r) => setTimeout(r, 0))
      expect(prompt).toHaveBeenCalledWith('Copy this link:', window.location.href)
      expect(container.querySelector('.i-link .cap')!.textContent).toBe('Link')
      expect(container.querySelector('.i-link .sr-only')!.textContent).toBe('')
    } finally { window.prompt = origPrompt; restore() }
  })
})

describe('cut (scissors) button', () => {
  it('disabled with no selection; clickable when something is selected; pressed while cutting', async () => {
    const off = mount()
    expect((off.getByLabelText('Cut to selection') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const onCut = vi.fn()
    const armed = mount({}, { canCut: true, onCut })
    const btn = armed.getByLabelText('Cut to selection') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    await fireEvent.click(btn)
    expect(onCut).toHaveBeenCalledTimes(1)
    cleanup()
    const cutting = mount({}, { canCut: true, cut: true })
    expect(cutting.getByLabelText('Cut to selection').getAttribute('aria-pressed')).toBe('true')
  })
  it('a remount with a stale pulse count does not pulse; a fresh bump does', async () => {
    // pulseSeen seeds from the MOUNT-time count, so a bar remount must not replay an old pulse
    const { component, getByLabelText } = mount({}, { canCut: true, pulse: 3 })
    const btn = getByLabelText('Cut to selection')
    expect(btn.classList.contains('pulse')).toBe(false)
    // a NEW bump pulses - stub rAF to actually run its callback (setup.ts's stub swallows it)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
    try {
      component.$set({ pulse: 4 })
      await tick()
      expect(btn.classList.contains('pulse')).toBe(true)
    } finally { vi.unstubAllGlobals() }
  })
})

describe('mobile menu submenus', () => {
  it('submenus are an accordion: opening one closes the other, summaries reflect state', async () => {
    const { container, getByText } = mount({ multiOnly: true, colorMode: 'dynasty' })
    const headers = [...container.querySelectorAll('.msec-h')] as HTMLButtonElement[]
    expect(headers.length).toBe(3) // Eras / Filters / Theme
    expect(headers.every((h) => h.getAttribute('aria-expanded') === 'false')).toBe(true) // all closed
    const [eras, filters] = headers
    await fireEvent.click(eras)
    expect(eras.getAttribute('aria-expanded')).toBe('true')
    await fireEvent.click(filters)                            // accordion: eras closes
    expect(filters.getAttribute('aria-expanded')).toBe('true')
    expect(eras.getAttribute('aria-expanded')).toBe('false')
    expect(getByText('2+ · Dynasty · Network')).toBeTruthy()  // the Filters summary shows the state
    expect(container.querySelector('.msec-eras .mh-s')!.textContent).toBe('Cap') // Eras summary names the preset
  })
})

describe('undo / redo buttons', () => {
  it('disabled at the baseline; call their handlers when armed', async () => {
    const off = mount()
    expect((off.getByLabelText('Undo') as HTMLButtonElement).disabled).toBe(true)
    expect((off.getByLabelText('Redo') as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const onUndo = vi.fn(), onRedo = vi.fn()
    const armed = mount({}, { canUndo: true, canRedo: true, onUndo, onRedo })
    await fireEvent.click(armed.getByLabelText('Undo'))
    await fireEvent.click(armed.getByLabelText('Redo'))
    expect(onUndo).toHaveBeenCalledTimes(1)
    expect(onRedo).toHaveBeenCalledTimes(1)
  })
})

describe('toggle state exposure', () => {
  it('2+ pill and segment buttons carry aria-pressed', async () => {
    const { getByLabelText, change } = mount()
    const multi = getByLabelText('Multi-Cup only')
    expect(multi.getAttribute('aria-pressed')).toBe('false')
    await fireEvent.click(multi)
    expect(change).toHaveBeenCalledWith({ multiOnly: true })
    expect(getByLabelText('Colour by position').getAttribute('aria-pressed')).toBe('true')
    expect(getByLabelText('Colour by dynasty').getAttribute('aria-pressed')).toBe('false')
    expect(getByLabelText('Timeline layout').getAttribute('aria-pressed')).toBe('false')
  })
})

describe('Six Degrees (connect mode)', () => {
  it('every result row carries a 6° connector button', async () => {
    const { getByRole, getAllByLabelText } = mount()
    await fireEvent.input(getByRole('combobox'), { target: { value: 'mark' } })
    const degs = getAllByLabelText(/^Six Degrees - connect/)
    expect(degs.length).toBeGreaterThan(1)
    expect(degs[0].textContent).toBe('6°')
  })
  it('arming, then picking, calls onConnect(from, to) - not onPick', async () => {
    const onConnect = vi.fn()
    const { getByRole, getAllByRole, getAllByLabelText, onPick } = mount({}, { onConnect })
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'lemieux' } })
    await fireEvent.click(getAllByLabelText(/^Six Degrees - connect Mario Lemieux/)[0])
    // armed: the box asks for the other end, the banner shows, the 6° buttons retire
    expect(input.placeholder).toContain('Connect Mario Lemieux to')
    expect(document.querySelector('.tb-connect')?.textContent).toContain('Mario Lemieux')
    await fireEvent.input(input, { target: { value: 'gretzky' } })
    expect(document.querySelectorAll('.r-deg').length).toBe(0)
    await fireEvent.click(getAllByRole('option')[0].querySelector('.r-main')!)
    expect(onConnect).toHaveBeenCalledTimes(1)
    const [from, to] = onConnect.mock.calls[0]
    expect(from.label).toBe('Mario Lemieux')
    expect(to.label).toContain('Gretzky')
    expect(onPick).not.toHaveBeenCalled()
    expect(input.placeholder).toContain('Search players / teams') // disarmed after the pick
  })
  it('Escape disarms the connector first; a second Escape closes the dropdown', async () => {
    const { getByRole, getAllByLabelText, queryByRole } = mount()
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'lemieux' } })
    await fireEvent.click(getAllByLabelText(/^Six Degrees - connect Mario Lemieux/)[0])
    await fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.placeholder).toContain('Search players / teams') // disarmed...
    await fireEvent.input(input, { target: { value: 'lemieux' } })
    expect(queryByRole('listbox')).toBeTruthy()                    // ...dropdown still usable
    await fireEvent.keyDown(input, { key: 'Escape' })
    expect(queryByRole('listbox')).toBeNull()
  })
})

describe('stories in the empty search dropdown', () => {
  it('focusing the empty box offers the curated stories; typing swaps to results', async () => {
    const { getByRole, container } = mount()
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.focus(input)
    expect(container.querySelectorAll('.tb-story').length).toBeGreaterThanOrEqual(4)
    await fireEvent.input(input, { target: { value: 'gretzky' } })
    expect(container.querySelectorAll('.tb-story').length).toBe(0) // real results take over
  })
  it('picking a story calls onStory and closes the dropdown', async () => {
    const onStory = vi.fn()
    const { getByRole, container, queryByRole } = mount({}, { onStory })
    await fireEvent.focus(getByRole('combobox'))
    const first = container.querySelector('.tb-story') as HTMLButtonElement
    const title = first.querySelector('.s-title')!.textContent
    await fireEvent.click(first)
    expect(onStory).toHaveBeenCalledTimes(1)
    expect(onStory.mock.calls[0][0].title).toBe(title)
    expect(queryByRole('listbox')).toBeNull()
  })
  it('stories stand aside while the Six Degrees connector is armed', async () => {
    const { getByRole, getAllByLabelText, container } = mount()
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'lemieux' } })
    await fireEvent.click(getAllByLabelText(/^Six Degrees - connect Mario Lemieux/)[0])
    expect(input.placeholder).toContain('Connect') // armed, query cleared...
    expect(container.querySelectorAll('.tb-story').length).toBe(0) // ...but no stories in the way
  })
})

describe('Six Degrees exclusions', () => {
  it('the armed endpoint disappears from the target results (no self-connections)', async () => {
    const { getByRole, getAllByLabelText, getAllByRole, queryAllByRole } = mount()
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'lemieux' } })
    const before = getAllByRole('option').map((o) => o.textContent)
    expect(before.some((t) => t!.includes('Mario Lemieux'))).toBe(true)
    await fireEvent.click(getAllByLabelText(/^Six Degrees - connect Mario Lemieux/)[0])
    await fireEvent.input(input, { target: { value: 'lemieux' } })
    const after = queryAllByRole('option').map((o) => o.textContent)
    expect(after.some((t) => t!.includes('Mario Lemieux'))).toBe(false) // he is the FROM end
    expect(after.some((t) => t!.includes('Claude Lemieux'))).toBe(true) // namesakes still offered
  })
})

describe('keyboard highlight stays inside the list', () => {
  it('narrowing the query clamps a stale highlight - Enter never picks undefined', async () => {
    const { getByRole, getAllByRole, onPick } = mount()
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'mar' } })
    const n = getAllByRole('option').length
    for (let i = 0; i < n; i++) await fireEvent.keyDown(input, { key: 'ArrowDown' }) // land on the last row
    await fireEvent.input(input, { target: { value: 'mario lemieux' } })             // list shrinks under it
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0][0]?.label).toBe('Mario Lemieux') // the first result, not undefined
  })
  it('disarming the connector with Esc resets the highlight (the armed item re-enters the list)', async () => {
    const { getByRole, getAllByLabelText } = mount()
    const input = getByRole('combobox') as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'lemieux' } })
    await fireEvent.click(getAllByLabelText(/^Six Degrees - connect Mario Lemieux/)[0])
    await fireEvent.input(input, { target: { value: 'lemieux' } })
    await fireEvent.keyDown(input, { key: 'ArrowDown' })                 // highlight row 0 (Mario excluded)
    await fireEvent.keyDown(input, { key: 'Escape' })                    // disarm - Mario re-enters at row 0
    expect(input.getAttribute('aria-activedescendant')).toBeNull()       // reset, not silently shifted
  })
})
