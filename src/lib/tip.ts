// A lightweight tooltip that appears 100ms after hover - matching the canvas node tooltip, and
// far snappier than the browser's native `title` (which the OS delays ~500ms and we can't tune).
// Usage: <button use:tip={'Reset'} aria-label="Reset"> - keep an aria-label for accessibility,
// since this replaces `title` (which otherwise doubles up as a second, slow tooltip).
export function tip(node: HTMLElement, text: string) {
  let label = text
  let el: HTMLDivElement | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function show() {
    timer = null
    if (el || !label) return
    el = document.createElement('div')
    el.className = 'uitip'
    el.textContent = label
    document.body.appendChild(el)
    // reading the size makes the browser lay the tip out NOW, locking in the invisible
    // (opacity:0) start so the fade-in below animates; then place below the control and clamp to
    // the viewport. Controls can live near the bottom edge (the playback transport is draggable
    // anywhere), so a tip that would overflow flips ABOVE its control instead of rendering
    // off-screen on a page that cannot scroll.
    const r = node.getBoundingClientRect()
    const t = el.getBoundingClientRect()
    const left = Math.max(6, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 6))
    const below = r.bottom + 6
    const top = below + t.height > window.innerHeight ? Math.max(6, r.top - t.height - 6) : below
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(top)}px`
    el.classList.add('on') // fade in from the committed opacity:0
  }
  function hide() {
    if (timer !== null) { clearTimeout(timer); timer = null }
    el?.remove(); el = null
  }
  const enter = () => { if (timer === null && !el) timer = setTimeout(show, 100) }

  node.addEventListener('mouseenter', enter)
  node.addEventListener('mouseleave', hide)
  node.addEventListener('mousedown', hide) // a click dismisses it at once
  return {
    update(next: string) { label = next; if (el) el.textContent = next },
    destroy() {
      hide()
      node.removeEventListener('mouseenter', enter)
      node.removeEventListener('mouseleave', hide)
      node.removeEventListener('mousedown', hide)
    },
  }
}
