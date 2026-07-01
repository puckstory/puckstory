import { defineConfig, type Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Build-time SEO + accessibility content. The graph is drawn on a <canvas>, which is opaque to both
// search engines and screen readers, so we inject a visually-hidden (sr-only) TEXT version of the same
// data - the champions by year and the players with the most Cups - generated from the dataset. It
// regenerates on every build (never hand-maintained) and does NOT change the visible page: the block is
// clipped off-screen by the .sr-only rule and sits beside #app, which the Svelte app never touches.
function seoContent(): Plugin {
  const esc = (s: unknown) => String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
  return {
    name: 'puckstory-seo-content',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const data: any = JSON.parse(readFileSync(resolve(process.cwd(), 'src/data/dataset.json'), 'utf8'))
        const y0 = data.window.startYear, y1 = data.window.endYear
        // Dataset facts in the static meta/JSON-LD are %%TOKENS%% substituted here, so the yearly
        // data refresh can never leave stale counts in the descriptions (they used to be hand-typed).
        const fmt = (n: number) => n.toLocaleString('en-US')
        for (const [tok, v] of Object.entries({
          '%%PLAYERS%%': fmt(data.players.length),
          '%%CHAMPIONS%%': fmt(data.champions.length),
          '%%ENGRAVINGS%%': fmt(data.stats?.totalEngravings ?? 0),
          '%%Y0%%': String(y0),
          '%%Y1%%': String(y1),
        })) html = html.split(tok).join(v)
        const champs = [...data.champions].sort((a: any, b: any) => a.year - b.year)
        const players = [...data.players].sort((a: any, b: any) => b.cupCount - a.cupCount).slice(0, 60)
        const champLi = champs.map((c: any) => {
          const extra: string[] = []
          if (c.runnerUp) extra.push('def. ' + esc(c.runnerUp))
          if (c.connSmythe) extra.push('Conn Smythe: ' + esc(c.connSmythe))
          return `<li>${c.year} ${esc(c.team)}${extra.length ? ' (' + extra.join('; ') + ')' : ''}</li>`
        }).join('')
        const playerLi = players.map((p: any) => {
          const teams = [...new Set(p.cups.map((cu: any) => cu.team || cu.abbr))].map(esc).join(', ')
          return `<li>${esc(p.name)} - ${p.cupCount} Cup${p.cupCount === 1 ? '' : 's'} (${teams})</li>`
        }).join('')
        const block =
`    <section class="sr-only" aria-label="Puckstory: Stanley Cup champions and engraved players, as text">
      <h1>Puckstory</h1>
      <p>Puckstory is an interactive network graph of every player engraved on the Stanley Cup from ${y0} to ${y1}, and the champion teams they won with. It covers ${data.players.length} players, ${data.champions.length} champions, and ${data.stats?.totalEngravings ?? ''} engravings. The graph is drawn on a canvas; this text version lists the same data so screen readers and search engines can read it.</p>
      <h2>Stanley Cup champions, ${y0} to ${y1}</h2>
      <ul>${champLi}</ul>
      <h2>Most Stanley Cups won (top ${players.length} engraved players)</h2>
      <ul>${playerLi}</ul>
    </section>
`
        // function replacement: the block holds data-derived names, which a string replacement
        // would mangle if one ever contained a `$&`-style pattern
        return html.replace('<div id="app"></div>', () => block + '    <div id="app"></div>')
      },
    },
  }
}

// Build emits ONE self-contained dist/index.html (libs + data inlined) - the portable
// artifact, produced by a real toolchain rather than runtime-CDN.
export default defineConfig({
  plugins: [seoContent(), svelte(), viteSingleFile()],
  // the 349KB dataset ships as JSON.parse('...') instead of a JS object literal - the engine
  // cold-parses a JSON string noticeably faster than the equivalent JS on the startup path
  json: { stringify: true },
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    chunkSizeWarningLimit: 5000,
    assetsInlineLimit: 100_000_000,
  },
})
