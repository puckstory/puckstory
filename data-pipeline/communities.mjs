#!/usr/bin/env node
/*
 * Final pipeline step: precompute the dynasty communities and bake them into the dataset.
 *
 * Runs the SAME community detection the app used to run at startup - Louvain, a standard
 * algorithm for finding tightly-knit groups in a network - with identical graph construction
 * order and the identical fixed random seed, so results match the app's historical output
 * exactly. Writes a `community` integer onto every champion and player record, and emits both
 * data-pipeline/dataset.full.json and src/data/dataset.json.
 * This removes graphology + graphology-communities-louvain from the runtime bundle (~20 KB
 * gzip) - the app now just reads the precomputed field (src/lib/model.ts).
 *
 * Pipeline order: build_full.py → resolve_build.py → node communities.mjs
 * (resolve_build.py rewrites dataset.full.json WITHOUT community fields; this step must
 * re-run after it. src/data/dataset.json is only ever written here, so app data always
 * carries communities.)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'

const HERE = dirname(fileURLToPath(import.meta.url))
const FULL = resolve(HERE, 'dataset.full.json')
const APP = resolve(HERE, '..', 'src', 'data', 'dataset.json')

// Fixed-seed random number generator (the "mulberry32" recipe): the same seed always yields the
// same sequence. MUST stay in sync with the seed the app shipped with historically (0x9e3779b9),
// so dynasty colours are stable across data refreshes too.
function seededRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const data = JSON.parse(readFileSync(FULL, 'utf8'))

// Graph construction mirrors src/lib/model.ts buildModel() exactly: champions first, then
// players, then one undirected edge per engraving (deduped) - order matters for the seeded run.
const G = new Graph({ type: 'undirected' })
for (const c of data.champions) G.addNode('cup-' + c.year)
for (const p of data.players) G.addNode('pl-' + p.id)
for (const p of data.players) {
  for (const cup of p.cups) {
    const s = 'pl-' + p.id, t = 'cup-' + cup.year
    if (!G.hasEdge(s, t)) G.addEdge(s, t)
  }
}
const comm = louvain(G, { resolution: 1, rng: seededRng(0x9e3779b9) })

for (const c of data.champions) c.community = comm['cup-' + c.year] ?? 0
for (const p of data.players) p.community = comm['pl-' + p.id] ?? 0
const n = new Set(Object.values(comm)).size

const out = JSON.stringify(data)
writeFileSync(FULL, out)
writeFileSync(APP, out)
console.log(`communities: ${n} clusters over ${data.champions.length + data.players.length} nodes → dataset.full.json + src/data/dataset.json`)
