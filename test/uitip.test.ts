/*
 * Tests for the uitip action (src/lib/tip.ts) - the 100ms-delayed hover tooltip that replaces
 * the browser's slow native `title`. Fake timers drive the delay; the tooltip element is a
 * .uitip div appended straight to document.body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tip } from '../src/lib/tip'

let node: HTMLButtonElement
beforeEach(() => {
  vi.useFakeTimers()
  node = document.createElement('button')
  document.body.appendChild(node)
})
afterEach(() => {
  vi.useRealTimers()
  node.remove()
  document.querySelector('.uitip')?.remove() // never leak a tooltip into the next test
})

const enter = () => node.dispatchEvent(new MouseEvent('mouseenter'))
const leave = () => node.dispatchEvent(new MouseEvent('mouseleave'))
const press = () => node.dispatchEvent(new MouseEvent('mousedown'))
const tipEl = () => document.querySelector('.uitip')

describe('uitip action', () => {
  it('appears 100ms after mouseenter, with the text and the fade-in class', () => {
    const action = tip(node, 'Reset')
    enter()
    expect(tipEl()).toBeNull() // not yet - the whole point is the tuned delay
    vi.advanceTimersByTime(100)
    const el = tipEl()!
    expect(el).toBeTruthy()
    expect(el.textContent).toBe('Reset')
    expect(el.classList.contains('on')).toBe(true) // fade-in committed
    action.destroy()
  })

  it('mouseleave removes it', () => {
    const action = tip(node, 'Reset')
    enter()
    vi.advanceTimersByTime(100)
    expect(tipEl()).toBeTruthy()
    leave()
    expect(tipEl()).toBeNull()
    action.destroy()
  })

  it('mousedown during the delay cancels the pending tooltip', () => {
    const action = tip(node, 'Reset')
    enter()
    press() // a click dismisses at once, including the not-yet-shown timer
    vi.advanceTimersByTime(500)
    expect(tipEl()).toBeNull()
    action.destroy()
  })

  it('update() rewrites the live tooltip text', () => {
    const action = tip(node, 'Undo (Ctrl+Z)')
    enter()
    vi.advanceTimersByTime(100)
    action.update('Undo (⌘Z)')
    expect(tipEl()!.textContent).toBe('Undo (⌘Z)')
    action.destroy()
  })

  it('destroy() detaches the listeners - a later hover creates nothing', () => {
    const action = tip(node, 'Reset')
    action.destroy()
    enter()
    vi.advanceTimersByTime(500)
    expect(tipEl()).toBeNull()
  })
})
