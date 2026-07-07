/*
 * path.ts - "Six Degrees": the shortest teammate chain between two endpoints.
 *
 * The engraving graph alternates players and Cups (an edge = one engraving), so a breadth-first
 * search over the adjacency map finds the chain with the fewest linking Cups between two
 * endpoints. Either endpoint may be a SET of node ids - a player is one id, a team is all of its
 * Cup nodes - and the search runs on the FULL graph, ignoring the current era/filters: the chain
 * exists in the engravings, not in the view (the caller widens the era to show it). Returns the
 * whole alternating chain including both endpoints, or null when nothing connects them.
 * ~1,400 nodes and ~2,300 edges make this instant.
 */
export function shortestPath(
  adj: Map<string, Set<string>>,
  from: string[],
  to: string[],
): string[] | null {
  const targets = new Set(to)
  for (const f of from) if (targets.has(f)) return [f] // endpoints overlap - already the same node

  // multi-source BFS: parent links let the first target reached walk its chain back to a source
  const parent = new Map<string, string | null>()
  let frontier: string[] = []
  for (const f of from) {
    if (adj.has(f) && !parent.has(f)) { parent.set(f, null); frontier.push(f) }
  }
  while (frontier.length) {
    const next: string[] = []
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (parent.has(nb)) continue
        parent.set(nb, id)
        if (targets.has(nb)) {
          const path: string[] = []
          for (let cur: string | null = nb; cur !== null; cur = parent.get(cur) ?? null) path.push(cur)
          return path.reverse()
        }
        next.push(nb)
      }
    }
    frontier = next
  }
  return null
}
