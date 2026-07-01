/*
 * stories.ts - curated entry points into the graph.
 *
 * Each story is nothing but URL state (the same query string a shared link carries), plus a
 * title and a one-line setup. The search dropdown offers them when the box is focused but
 * empty - the graph already contains the stories; new visitors just don't know where to dig.
 * A unit test (test/stories.test.ts) asserts every id and era below still resolves against the
 * live dataset, so a data refresh can't quietly break an entry.
 */
// Every story but the first opens as a SELECTION (or an exact chain) against the whole faded
// map - never a cut - so the era's full context stays visible behind what the story is about.
// The playback story is the exception: it selects nothing and hands the view to
// GraphView.startPlayback, which reveals the map champion by champion.
export interface Story {
  title: string
  blurb: string
  qs: string // the view, exactly as ?query-string state (parseView applies it)
  playback?: boolean // animated show: assemble the century champion by champion (GraphView.startPlayback)
}

export const STORIES: Story[] = [
  {
    title: 'A Brief History of Stanley',
    blurb: 'Watch the whole century assemble, one champion at a time, from 2026 back to 1915.',
    // qs is the view the playback RUNS IN (all eras, nothing selected); the playback flag makes
    // applyStory start the show instead of just applying the snapshot
    qs: 'eras=1915-1941,1942-1967,1968-1979,1980-1993,1994-2004,2006-2026',
    playback: true,
  },
  {
    title: 'The Hundred-Year Handshake',
    blurb: 'The very first Cup to the newest in nine handshakes - one unbroken line of teammates.',
    // a CHAIN (?chain=1): the SHORTEST path from cup-1915 to the latest champion, lit against
    // the whole faded century. A stories test re-runs the BFS, so a data refresh that adds a
    // year (or shortens the route) fails loudly until this corridor is recomputed.
    qs: 'eras=1915-1941,1942-1967,1968-1979,1980-1993,1994-2004,2006-2026'
      + '&focus=cup-1915,pl-franknighbor,cup-1927,pl-alecconnell,cup-1935,pl-toeblake,cup-1944,'
      + 'pl-mauricerichard,cup-1956,pl-henririchard,cup-1973,pl-larryrobinson,cup-1986,pl-claudelemieux,cup-1995,'
      + 'pl-billguerin,cup-2009,pl-jordanstaal,cup-2026&chain=1',
  },
  {
    title: 'Have Skates, Will Travel',
    blurb: 'Nine men won with three different franchises. No one has ever managed four.',
    qs: 'eras=1915-1941,1942-1967,1968-1979,1980-1993,1994-2004,2006-2026'
      + '&focus=pl-markrecchi,pl-larryhillman,pl-claudelemieux,pl-joenieuwendyk,pl-alarbour,pl-hapholmes,pl-regnoble,pl-gordpettinger,pl-mikekeane',
  },
  {
    title: "The Pocket Rocket's Eleven",
    blurb: 'Engraved eleven times, 1956–1973 - all Montreal. Nobody else is close.',
    // era lists here use the NAMED preset ranges (not one custom span) so the era pills read
    // as pressed when the story opens - a custom range lights only the From/To boxes
    qs: 'eras=1942-1967,1968-1979&focus=pl-henririchard',
  },
  {
    title: 'One Goal, Three Times',
    blurb: '2010, 2013, 2015: three Cups in six years around Toews, Kane, and Keith.',
    qs: 'eras=2006-2026&focus=cup-2010,cup-2013,cup-2015',
  },
  {
    title: 'The Boys on the Bus',
    blurb: 'Five Cups in seven years around Gretzky, Messier, Kurri, and Fuhr.',
    qs: 'eras=1980-1993&focus=cup-1984,cup-1985,cup-1987,cup-1988,cup-1990',
  },
]
