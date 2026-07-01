/*
 * loadTheme() persistence guard (src/lib/theme.ts): the picker list is the source of truth -
 * junk in localStorage (an old build's id, a hand edit) must fall back to the default instead
 * of shipping an unknown data-theme attribute.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { loadTheme, DEFAULT_THEME, THEMES } from '../src/lib/theme'

const KEY = 'sw-theme' // theme.ts's private storage key
afterEach(() => window.localStorage.removeItem(KEY))

describe('loadTheme', () => {
  it('returns the default when nothing is stored', () => {
    window.localStorage.removeItem(KEY)
    expect(loadTheme()).toBe(DEFAULT_THEME)
  })
  it('returns the default for a junk stored value', () => {
    window.localStorage.setItem(KEY, 'banana')
    expect(loadTheme()).toBe(DEFAULT_THEME)
  })
  it('honours a valid stored id', () => {
    expect(THEMES.some((t) => t.id === 'nord')).toBe(true) // still a real theme
    window.localStorage.setItem(KEY, 'nord')
    expect(loadTheme()).toBe('nord')
  })
})
