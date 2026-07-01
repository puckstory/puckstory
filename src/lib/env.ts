/*
 * env.ts - tiny runtime environment probes shared across modules.
 *
 * App.svelte (dockTip: bottom-sheet tooltip) and GraphView (tapTipOnly: tap-driven tooltip)
 * must agree on what a "touch device" is - one probe, one answer.
 */
export const isCoarsePointer = (): boolean => {
  try { return matchMedia('(pointer: coarse)').matches } catch { return false }
}
