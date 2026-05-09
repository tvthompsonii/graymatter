import type { Node } from './moveTree'
import { canonicalPathKey, forEachNodeDepthFirst } from './moveTree'

export type TrainingNodeEntry = {
  /** Same string as `canonicalPathKey(SAN[])` from root to this node (inclusive position). */
  pathKey: string
  needsPractice: boolean
}

export type SerializedTrainingFile = {
  version: 2
  keyKind: 'canonicalPathKey'
  /** One row per trie node; `pathKey` uniquely identifies the node for this repertoire. */
  nodes: TrainingNodeEntry[]
}

// Serializes every node’s practice flag keyed by SAN path so you can persist progress outside the app.
// Arguments: root — repertoire trie to snapshot.
export function serializeTrainingStatus(root: Node): SerializedTrainingFile {
  const nodes: TrainingNodeEntry[] = []
  forEachNodeDepthFirst(root, (n, pathSans) => {
    nodes.push({
      pathKey: canonicalPathKey(pathSans),
      needsPractice: n.needsPractice,
    })
  })
  return { version: 2, keyKind: 'canonicalPathKey', nodes }
}

// Overwrites needsPractice on nodes whose pathKey appears in a saved file; unknown keys are ignored so mismatched files fail soft.
// Arguments: root — live trie to mutate; data — parsed training snapshot (version/kind must match).
export function applyTrainingStatus(root: Node, data: SerializedTrainingFile): void {
  if (data.version !== 2 || data.keyKind !== 'canonicalPathKey') return
  const byKey = new Map<string, boolean>()
  for (const row of data.nodes) byKey.set(row.pathKey, row.needsPractice)

  forEachNodeDepthFirst(root, (n, pathSans) => {
    const k = canonicalPathKey(pathSans)
    if (byKey.has(k)) n.needsPractice = byKey.get(k)!
  })
}

// Validates JSON shape before merging into the tree so UI code can show a clear error instead of throwing.
// Arguments: text — raw JSON file contents from disk.
export function parseTrainingFileJson(text: string): SerializedTrainingFile | { error: string } {
  try {
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object') return { error: 'Invalid JSON.' }
    const o = raw as SerializedTrainingFile
    if (o.version !== 2 || o.keyKind !== 'canonicalPathKey' || !Array.isArray(o.nodes))
      return { error: 'Not a training status file (expected version 2, canonicalPathKey).' }
    return o
  }
  catch {
    return { error: 'Could not parse JSON.' }
  }
}

// Triggers a browser download of the snapshot (SPA has no filesystem write path besides download).
// Arguments: data — object to stringify; filename — suggested download name including .json.
export function triggerJsonDownload(data: SerializedTrainingFile, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
