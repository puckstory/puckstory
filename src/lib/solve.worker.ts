/*
 * solve.worker.ts - runs the headless layout solve off the main thread.
 *
 * One message in (SolveInput), one message out (SolveResult, positions transferred). The UI stays
 * fully responsive while a full-range solve (~100 ticks of forces) computes; GraphView drops any
 * result whose generation is stale. Bundled inline (?worker&inline) so the single-file build stays
 * a single file and the worker still boots from file:// and data: contexts.
 */
import { solve, type SolveInput } from './solve'

self.onmessage = (e: MessageEvent<SolveInput>) => {
  const res = solve(e.data)
  ;(self as unknown as Worker).postMessage(res, [res.x.buffer, res.y.buffer] as any)
}
