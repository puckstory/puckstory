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

  it('the camera reserves a bottom strip for the fixed transport, sized to the bar and cleared on end', () => {
    const { gv } = fresh()
    const g = gv as any
    gv.setPlaybackInset(30)
    expect(g.insetPB).toBe(0)             // no show running: ignored
    gv.startPlayback()
    expect(g.insetPB).toBeGreaterThan(0)  // a default strip is reserved for the bottom bar
    gv.setPlaybackInset(72)               // App reports the bar's real (measured) height
    expect(g.insetPB).toBe(72)
    gv.stopPlayback()
    expect(g.insetPB).toBe(0)             // the show always cleans up
    gv.destroy()
  })

  it('picking a year parks on that champion ALONE, no direction chosen yet', () => {
    const { gv, last, visCups, visPlayers } = fresh()
    gv.startPlayback()                                     // (auto-plays; the jump interrupts it)
    gv.playbackJumpToYear(1999)                            // Dallas 1999
    expect(visCups()).toEqual([1999])                      // just the one Cup...
    expect(visPlayers().length).toBe(0)                    // ...on its own, no roster
    expect(last()).toMatchObject({ playing: false, year: 1999 }) // PARKED, waiting for a play button
    vi.advanceTimersByTime(5000)                           // nothing ticks while parked
    expect(visCups()).toEqual([1999])
    gv.destroy()
  })

  it('from the parked pivot, ▶ (newer) rolls up the years and ◀ (older) rolls down', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()
    gv.playbackJumpToYear(1999)
    gv.playbackPlay(1)                                     // ▶ newer
    expect(last()).toMatchObject({ playing: true, year: 1999 })
    vi.advanceTimersByTime(2000)                           // roster, then the next NEWER champion
    expect(Math.max(...visCups())).toBeGreaterThan(1999)
    expect(visCups().every((y) => y >= 1999)).toBe(true)  // nothing older than the pivot
    // re-jump and pick the other way
    gv.playbackJumpToYear(1999)
    expect(visCups()).toEqual([1999])
    gv.playbackPlay(-1)                                    // ◀ older
    vi.advanceTimersByTime(2000)
    expect(Math.min(...visCups())).toBeLessThan(1999)
    expect(visCups().every((y) => y <= 1999)).toBe(true)  // nothing newer than the pivot
    gv.destroy()
  })

  it('reversing back to a year-jump pivot is not a dead end: the next press continues past it', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()
    gv.playbackJumpToYear(1999)
    gv.playbackPlay(1)                                     // ▶ explore NEWER from the pivot
    vi.advanceTimersByTime(4000)
    expect(Math.max(...visCups())).toBeGreaterThan(1999)
    gv.playbackPlay(-1)                                    // ◀ peels the newer reveals back...
    vi.advanceTimersByTime(10_000)                         // ...all the way to the anchor floor
    expect(visCups()).toEqual([1999])
    expect(last()).toMatchObject({ playing: false, year: 1999 })
    gv.playbackPlay(-1)                                    // ◀ again: re-pivot and roll into OLDER years
    expect(last()!.playing).toBe(true)
    vi.advanceTimersByTime(3000)
    expect(Math.min(...visCups())).toBeLessThan(1999)
    expect(visCups().every((y) => y <= 1999)).toBe(true)  // the newer half retracted with the re-pivot
    gv.destroy()
  })

  it('...and the mirror: exploring older first, then forward past the pivot into newer years', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()
    gv.playbackJumpToYear(1999)
    gv.playbackPlay(-1)                                    // ◀ explore OLDER from the pivot
    vi.advanceTimersByTime(4000)
    expect(Math.min(...visCups())).toBeLessThan(1999)
    gv.playbackPlay(1)                                     // ▶ peels back to the pivot...
    vi.advanceTimersByTime(10_000)
    expect(last()).toMatchObject({ playing: false, year: 1999 })
    gv.playbackPlay(1)                                     // ▶ again: continue into NEWER years
    expect(last()!.playing).toBe(true)
    vi.advanceTimersByTime(3000)
    expect(Math.max(...visCups())).toBeGreaterThan(1999)
    expect(visCups().every((y) => y >= 1999)).toBe(true)
    gv.destroy()
  })

  it('a lockout / off year snaps to the nearest champion', () => {
    const { gv, visCups } = fresh()
    gv.startPlayback()
    gv.playbackJumpToYear(2005)                            // no Cup in 2005 (lockout)
    expect([2004, 2006]).toContain(visCups()[0])          // the nearest champion, alone
    gv.destroy()
  })

  it('jumping to the newest/oldest champion then pressing TOWARD that end stays parked (no degenerate one-year show)', () => {
    const { gv, model, last, visCups } = fresh()
    gv.startPlayback()
    const newest = Math.max(...model.cups.map((c) => c.year!))
    gv.playbackJumpToYear(newest)                          // pivot on the newest champion, parked
    expect(visCups()).toEqual([newest])
    expect(last()!.playing).toBe(false)
    gv.playbackPlay(1)                                     // ▶ (newer) - nothing is newer than the newest
    expect(last()!.playing).toBe(false)                   // stays parked, NOT a broken un-pausable 1-year show
    expect(visCups()).toEqual([newest])
    vi.advanceTimersByTime(3000)
    expect(visCups()).toEqual([newest])                   // no beats fired - genuinely parked
    gv.playbackPlay(-1)                                    // ◀ (older) - now there IS somewhere to roll
    expect(last()!.playing).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(visCups().length).toBeGreaterThan(1)           // assembles back through the older champions
    gv.destroy()
  })

  it('while a direction is playing, pressing it pauses and pressing the opposite reverses', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()                                     // descending default: time flows toward OLDER (◀ active)
    vi.advanceTimersByTime(4000)
    const n = visCups().length
    gv.playbackPlay(-1)                                    // press ◀ (the active/older direction) -> pause
    expect(last()!.playing).toBe(false)
    vi.advanceTimersByTime(3000)
    expect(visCups().length).toBe(n)                      // paused, nothing moved
    gv.playbackPlay(1)                                     // press ▶ (opposite) -> reverse, peel back toward newer
    expect(last()!.playing).toBe(true)
    vi.advanceTimersByTime(3000)
    expect(visCups().length).toBeLessThan(n)              // reveals walked back
    gv.destroy()
  })

  it('the directional buttons: click a direction to play it; click the LIT one to pause', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()
    vi.advanceTimersByTime(3000)                          // playing forward (default), a few beats in
    expect(last()).toMatchObject({ playing: true, dir: 1 })
    gv.playbackPlayDir(1)                                 // click the LIT (forward) button -> pause
    expect(last()).toMatchObject({ playing: false, dir: 1 })
    const held = visCups()
    vi.advanceTimersByTime(3000)
    expect(visCups()).toEqual(held)                       // nothing moved while paused
    gv.playbackPlayDir(1)                                 // click forward again -> resume forward
    expect(last()).toMatchObject({ playing: true, dir: 1 })
    gv.destroy()
  })

  it('clicking the OTHER direction flips and plays that way - no separate reverse control needed', () => {
    const { gv, last, visCups } = fresh()
    gv.startPlayback()
    vi.advanceTimersByTime(5000)                          // forward, a few cups on screen
    const n = visCups().length
    expect(n).toBeGreaterThan(2)
    gv.playbackPlayDir(-1)                                // click rewind -> now peeling back
    expect(last()).toMatchObject({ playing: true, dir: -1 })
    vi.advanceTimersByTime(4000)
    expect(visCups().length).toBeLessThan(n)              // reveals walked back
    gv.destroy()
  })

  it('pressing a direction with nowhere to go stays parked - never silently turns around', () => {
    const { gv, model, last, visCups } = fresh()
    gv.startPlayback()
    gv.playbackSpeed()                                    // 2x - drain to the fully assembled end
    const total = model.cups.length
    for (let i = 0; i < total * 2 + 4 && last()!.playing; i++) vi.advanceTimersByTime(500)
    expect(visCups().length).toBe(total)                 // fully assembled, parked
    gv.playbackPlayDir(1)                                 // press FORWARD at the end - nothing ahead
    expect(last()).toMatchObject({ playing: false, dir: 1 }) // stays put, does NOT unwind
    expect(visCups().length).toBe(total)
    gv.playbackPlayDir(-1)                                // press REWIND - there IS room to peel back
    expect(last()).toMatchObject({ playing: true, dir: -1 })
    vi.advanceTimersByTime(1000)
    expect(visCups().length).toBeLessThan(total)
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
