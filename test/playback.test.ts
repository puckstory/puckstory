/*
 * Playback ("A Brief History of Stanley"): the graph assembles champion by champion, newest
 * first, two beats per year - the Cup alone, then its roster pops out of it - all the way back
 * to 1915. These tests drive the beat timer with fake timers (ONLY setTimeout is faked, so the
 * d3 simulation doesn't burn thousands of synchronous ticks) and assert the visibility state
 * machine: forward stepping, pause, reversal back to the start, speed changes, roster seeding
 * at the Cup, and that any real view change ends the show cleanly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildModel } from '../src/lib/model'
import { GraphView, type PlaybackState } from '../src/lib/graphview'
import type { ViewState } from '../src/lib/types'

const base: ViewState = { eras: [{ start: 2006, end: 2026 }], positions: { F: true, D: true, G: true },
  multiOnly: false, colorMode: 'position', layoutMode: 'network' }

function fresh() {
  const model = buildModel()
  const canvas = document.createElement('canvas')
  const pbs: Array<PlaybackState | null> = []
  const stats: Array<{ champions: number; players: number }> = []
  let hover: { id: string } | null = null
  const gv = new GraphView(canvas as any, model, { ...base, eras: base.eras.map((e) => ({ ...e })) },
    { onPlayback: (st) => pbs.push(st), onHover: (n) => { hover = n },
      onStats: (s) => stats.push({ champions: s.champions, players: s.players }) })
  const last = () => pbs[pbs.length - 1]
  const visCups = () => model.nodes.filter((n) => n.vis && n.type === 'cup').map((n) => n.year!).sort((a, b) => b - a)
  const visPlayers = () => model.nodes.filter((n) => n.vis && n.type === 'player')
  return { gv, model, pbs, stats, last, visCups, visPlayers, getHover: () => hover }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

describe('playback state machine', () => {
  it('opens on the newest Cup ALONE, then pops its roster, then adds the next Cup', () => {
    const { gv, last, visCups, visPlayers } = fresh()
    gv.startPlayback()
    const latest = visCups()[0]
    expect(visCups()).toEqual([latest])                    // beat 0: one Cup, nobody on it yet
    expect(visPlayers().length).toBe(0)
    expect(last()).toMatchObject({ playing: true, dir: 1, speed: 1, year: latest })

    vi.advanceTimersByTime(1000)                           // beat 1: the roster pops out
    expect(visCups()).toEqual([latest])
    const roster = visPlayers()
    expect(roster.length).toBeGreaterThan(15)
    expect(roster.every((p) => p.cups!.some((c) => c.year === latest))).toBe(true)
    expect(last()!.year).toBe(latest)

    vi.advanceTimersByTime(1000)                           // beat 2: the previous champion appears, alone
    expect(visCups()).toEqual([latest, latest - 1])
    expect(visPlayers().every((p) => p.cups!.some((c) => c.year === latest))).toBe(true)
    expect(last()!.year).toBe(latest - 1)
    gv.destroy()
  })

  it('newly revealed players spawn AT their Cup (the pop-out starts from the trophy)', () => {
    const { gv, model, visCups, visPlayers } = fresh()
    gv.startPlayback()
    const cup = model.nodeById.get('cup-' + visCups()[0])!
    vi.advanceTimersByTime(1000)
    for (const p of visPlayers()) {
      const d = Math.hypot(p.x! - cup.x!, p.y! - cup.y!)
      expect(d, `${p.id} seeded ${Math.round(d)} units from its Cup`).toBeLessThan(120)
    }
    gv.destroy()
  })

  it('player size and the stats pills grow with the REVEALED Cups, not the era', () => {
    const { gv, model, stats } = fresh()
    gv.startPlayback()
    expect(stats[stats.length - 1]).toMatchObject({ champions: 1, players: 0 })
    vi.advanceTimersByTime(1000)
    const s1 = stats[stats.length - 1]
    expect(s1.champions).toBe(1)
    expect(s1.players).toBeGreaterThan(15)
    // a multi-Cup veteran counts (and sizes) only by what has been revealed so far
    for (const n of model.nodes) if (n.vis && n.type === 'player') expect(n.rangeCupCount).toBe(1)
    gv.destroy()
  })

  it('pause holds the picture; play resumes it', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()
    vi.advanceTimersByTime(2000)                           // two beats in
    const cups = visCups()
    gv.playbackToggle()
    expect(last()!.playing).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(visCups()).toEqual(cups)                        // nothing moved while paused
    gv.playbackToggle()
    expect(last()!.playing).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(visCups().length).toBeGreaterThanOrEqual(cups.length) // marching again
    gv.destroy()
  })

  it('reversing keeps playing but walks the reveals BACK, pausing once only the newest remains', () => {
    const { gv, last, visCups, visPlayers } = fresh()
    gv.startPlayback()
    const latest = visCups()[0]
    vi.advanceTimersByTime(5000)                           // several beats: 3 cups on screen
    expect(visCups().length).toBeGreaterThan(2)
    gv.playbackDir()
    expect(last()).toMatchObject({ playing: true, dir: -1 })
    vi.advanceTimersByTime(20_000)                          // plenty of beats to unwind
    expect(visCups()).toEqual([latest])                    // back where the show began...
    expect(visPlayers().length).toBeGreaterThan(15)        // ...with the newest roster out
    expect(last()!.playing).toBe(false)                    // and it parked itself there
    gv.destroy()
  })

  it('reversing during the opening beat parks on the anchor Cup - never a blank stage', () => {
    const { gv, last, visCups, visPlayers } = fresh()
    gv.startPlayback()                    // (idx 0, halfCup): the anchor Cup alone
    const latest = visCups()[0]
    gv.playbackDir()                      // reverse immediately, before the first beat lands
    vi.advanceTimersByTime(5000)          // beats fire; the floor must hold
    expect(visCups()).toEqual([latest])   // the anchor Cup never left the stage
    expect(last()).toMatchObject({ playing: false, year: latest }) // parked with a real year, not '-'
    gv.playbackToggle()                   // Play from this park turns the show around
    expect(last()).toMatchObject({ playing: true, dir: 1 })
    vi.advanceTimersByTime(1000)
    expect(visPlayers().length).toBeGreaterThan(15) // marching forward again
    gv.destroy()
  })

  it('Play at the fully assembled end turns around and unwinds instead of dying', () => {
    const { gv, model, last, visCups } = fresh()
    gv.startPlayback()
    gv.playbackSpeed()                                     // 2x
    const total = model.cups.length
    for (let i = 0; i < total * 2 + 4 && last()!.playing; i++) vi.advanceTimersByTime(500)
    expect(last()!.playing).toBe(false)                    // parked, fully assembled
    expect(visCups().length).toBe(total)
    gv.playbackToggle()
    expect(last()).toMatchObject({ playing: true, dir: -1 }) // Play = unwind from here
    vi.advanceTimersByTime(1000)                           // two 2x beats: the oldest year retracts
    expect(visCups().length).toBe(total - 1)
    gv.destroy()
  })

  it('node clicks during the show are inspect-only: the card opens, nothing is selected', () => {
    const { gv, last, visPlayers, getHover } = fresh()
    const g = gv as any
    gv.startPlayback()
    vi.advanceTimersByTime(1000)                           // the newest roster is out
    const n = visPlayers()[0]
    const p = { clientX: n.x! * g.transform.k + g.transform.x, clientY: n.y! * g.transform.k + g.transform.y }
    g.onDown({ pointerType: 'mouse', button: 0, buttons: 0, preventDefault: () => {}, ...p })
    g.onUp({ pointerType: 'mouse', ...p })
    expect(g.selSet.size).toBe(0)                          // no selection recorded mid-show
    expect(getHover()?.id).toBe(n.id)                      // but the card opened
    expect(last()).not.toBe(null)                          // and the show is still running
    gv.destroy()
  })

  it('the camera inset follows the transport: reserved while docked top, released when dragged off', () => {
    const { gv } = fresh()
    const g = gv as any
    gv.setPlaybackTopInset(30)
    expect(g.insetT).toBe(0)              // no show running: ignored
    gv.startPlayback()
    expect(g.insetT).toBe(64)             // docked top by default
    gv.setPlaybackTopInset(0)             // dragged off the top strip
    expect(g.insetT).toBe(0)
    gv.setPlaybackTopInset(64)            // dragged back up
    expect(g.insetT).toBe(64)
    gv.stopPlayback()
    expect(g.insetT).toBe(0)              // the show always cleans up
    gv.destroy()
  })

  it('the anchor swap restarts the show at the OTHER end of history, playing the other way', () => {
    const { gv, last, visCups, visPlayers } = fresh()
    gv.startPlayback()
    const latest = visCups()[0]
    expect(last()!.fromOldest).toBe(false)                 // default show: newest-first
    vi.advanceTimersByTime(5000)                           // a few champions in
    gv.playbackFlip()
    expect(visCups()).toEqual([1915])                      // straight to the far end, Cup alone
    expect(visPlayers().length).toBe(0)
    expect(last()).toMatchObject({ playing: true, dir: 1, fromOldest: true, year: 1915 })
    vi.advanceTimersByTime(1000)                           // the 1915 roster pops
    expect(visPlayers().length).toBeGreaterThan(5)
    expect(visPlayers().every((p) => p.cups!.some((c) => c.year === 1915))).toBe(true)
    vi.advanceTimersByTime(1000)                           // now marching UP the years
    expect(visCups()).toEqual([1916, 1915])
    gv.playbackFlip()                                      // and straight back to the newest anchor
    expect(visCups()).toEqual([latest])
    expect(last()).toMatchObject({ fromOldest: false, year: latest })
    gv.destroy()
  })

  it('speed cycles 1x -> 2x -> 4x -> 0.5x and rescales the beat', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()
    gv.playbackSpeed()
    expect(last()!.speed).toBe(2)
    vi.advanceTimersByTime(500)                            // a 2x beat lands in 500ms
    expect(visCups().length + 0).toBe(1)                   // still one cup (roster beat)
    gv.playbackSpeed()
    expect(last()!.speed).toBe(4)
    vi.advanceTimersByTime(250)                            // a 4x beat lands in 250ms
    expect(visCups().length).toBe(2)                       // the next champion is out already
    gv.playbackSpeed()
    expect(last()!.speed).toBe(0.5)
    gv.playbackSpeed()
    expect(last()!.speed).toBe(1)
    gv.destroy()
  })

  it('runs all the way back to 1915, every player on the ice, then parks', () => {
    const { gv, model, last, visCups, visPlayers } = fresh()
    gv.startPlayback()
    gv.playbackSpeed()                                     // 2x - half the fake-time to drain
    const total = model.cups.length
    for (let i = 0; i < total * 2 + 4 && last()!.playing; i++) vi.advanceTimersByTime(500)
    expect(last()!.playing).toBe(false)
    expect(visCups().length).toBe(total)
    expect(visCups()[visCups().length - 1]).toBe(1915)
    expect(visPlayers().length).toBe(model.nodes.filter((n) => n.type === 'player').length)
    // full careers restored: multi-Cup legends are at full size again
    const henri = model.nodes.find((n) => n.name === 'Henri Richard')!
    expect(henri.rangeCupCount).toBe(11)
    gv.destroy()
  })

  it('any real view change (setState / restoreView) ends the show and restores the era view', () => {
    const { gv, model, last, visCups } = fresh()
    gv.startPlayback()
    vi.advanceTimersByTime(3000)
    gv.setState({ eras: [{ start: 2006, end: 2026 }] })
    expect(last()).toBe(null)                              // the panel is told to close
    expect(visCups().length).toBeGreaterThan(10)           // the era view is back
    expect(model.nodes.filter((n) => n.vis && n.type === 'player').length).toBeGreaterThan(300)

    gv.startPlayback()
    expect(last()).not.toBe(null)
    gv.restoreView({}, ['cup-2025'], false)                // undo/redo path
    expect(last()).toBe(null)
    expect(visCups().length).toBeGreaterThan(10)
    gv.destroy()
  })

  it('the close button path (stopPlayback) restores the era view itself', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()
    vi.advanceTimersByTime(2000)
    gv.stopPlayback()
    expect(last()).toBe(null)
    expect(visCups().length).toBeGreaterThan(10)
    gv.destroy()
  })

  it('starting the show clears any selection or cut first', () => {
    const { gv, model, visCups } = fresh()
    gv.selectNodes(['cup-2025'])
    gv.setCut(true)
    gv.startPlayback()
    expect(visCups().length).toBe(1)                       // playback regime, not the cut
    expect(model.nodes.filter((n) => n.vis && n.type === 'player').length).toBe(0)
    gv.destroy()
  })
})
