/*
 * env.ts - tiny runtime environment probes shared across modules.
 *
 * App.svelte (dockTip: bottom-sheet tooltip) and GraphView (tapTipOnly: tap-driven tooltip)
 * must agree on what a "touch device" is - one probe, one answer.
 */
export const isCoarsePointer = (): boolean => {
  try { return matchMedia('(pointer: coarse)').matches } catch { return false }
}

/* True tablets (iPad-class): a coarse pointer with room in BOTH axes. app.css turns the docked
 * card into a right-corner card behind the SAME query - App.svelte keys the card's content
 * (desktop rows vs the phone one-liner) and the fit inset off this probe, so the thresholds must
 * stay in lockstep with the `(width > 640px) and (height > 500px)` tier in app.css. */
export const isCornerCard = (): boolean => {
  try { return matchMedia('(pointer: coarse) and (width > 640px) and (height > 500px)').matches } catch { return false }
}
