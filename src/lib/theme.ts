// Selectable colour themes. The actual palette values live in app.css as `[data-theme="…"]`
// CSS-variable blocks; this module is just the picker list + persistence helpers. The canvas
// background follows the active theme by reading the computed `--bg` (see App.svelte).
export type ThemeId =
  | 'nord' | 'gruvbox' | 'solarized' | 'amoled'
  | 'latte' | 'solarized-light'

// `bg`/`accent` mirror each theme's --bg/--accent in app.css so a swatch can preview a theme
// (its background colour, with a diagonal accent corner) without that theme being the active one.
// Six deliberately-spaced identities: two lights (warm cream / cool white) and four darks (true
// black + amber, deep teal + yellow, blue-grey + ice, grey + orange). Catppuccin and Everforest
// were dropped for sitting within a just-noticeable difference of Nord/Gruvbox - four themes
// read as one dark grey. loadTheme() falls anyone with a dropped id back to the default.
export const THEMES: { id: ThemeId; label: string; accent: string; bg: string }[] = [
  { id: 'nord', label: 'Nord', accent: '#88c0d0', bg: '#2e3440' },
  { id: 'gruvbox', label: 'Gruvbox', accent: '#fe8019', bg: '#282828' },
  { id: 'solarized', label: 'Solarized', accent: '#b58900', bg: '#002b36' },
  { id: 'amoled', label: 'AMOLED', accent: '#ffb454', bg: '#000000' },
  { id: 'latte', label: 'Latte', accent: '#df8e1d', bg: '#eff1f5' },
  { id: 'solarized-light', label: 'Solarized Light', accent: '#8ecae6', bg: '#fdf6e3' },
]

export const DEFAULT_THEME: ThemeId = 'amoled'
const KEY = 'sw-theme'

export function loadTheme(): ThemeId {
  try {
    const t = localStorage.getItem(KEY)
    if (t && THEMES.some((x) => x.id === t)) return t as ThemeId
  } catch {}
  return DEFAULT_THEME
}

/** Apply a theme: set the document attribute (drives the CSS vars), persist it, and return the
 *  resolved canvas background colour (the computed `--bg`) so the renderer can match. */
export function applyTheme(id: ThemeId): string {
  document.documentElement.dataset.theme = id
  try { localStorage.setItem(KEY, id) } catch {}
  return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#1e1e2e'
}
