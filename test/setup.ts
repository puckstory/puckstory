// Headless harness: mock the canvas 2D context + DOM bits GraphView/render need, so the real
// GraphView logic (visibility, stats, layout, fit, interaction) runs in node under happy-dom.
const noop = () => {}
function makeCtx(): any {
  const c: any = {}
  for (const m of ['setTransform','clearRect','fillRect','beginPath','moveTo','lineTo','stroke',
    'arc','fill','strokeText','fillText','quadraticCurveTo','closePath','save','restore','scale',
    'translate','rect','clip','setLineDash','ellipse','bezierCurveTo']) c[m] = noop
  c.measureText = (t: any) => ({ width: (t == null ? 0 : String(t).length) * 6 })
  return c
}
// __rect is a SHARED MUTABLE global: every canvas reports this as its size, and the resize tests
// overwrite it to fake new dimensions - reset it if your test changes it.
;(globalThis as any).__rect = { width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720, x: 0, y: 0, toJSON(){} }
const HC: any = (globalThis as any).HTMLCanvasElement
HC.prototype.getContext = function () { return makeCtx() }
HC.prototype.getBoundingClientRect = function () { return (globalThis as any).__rect }
;(globalThis as any).ResizeObserver = class { observe(){} unobserve(){} disconnect(){} }
// this happy-dom setup exposes no localStorage; the app guards every access with try/catch,
// but persistence tests (theme) need a working store - an in-memory shim
if (!(globalThis as any).window.localStorage) {
  const store = new Map<string, string>()
  ;(globalThis as any).window.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
}
// keep d3-timer / rAF inert so simulations don't tick asynchronously during tests
;(globalThis as any).requestAnimationFrame = () => 0
;(globalThis as any).cancelAnimationFrame = noop
;(globalThis as any).window.devicePixelRatio = 1
