import type { Node } from './moveTree'
import { canonicalPathKey, forEachNodeDepthFirst } from './moveTree'

export type TrainingNodeEntry = {
    /** Same string as `canonicalPathKey(SAN[])` from root to this node (inclusive position). */
    pathKey: string
    needsPractice: boolean
}

export type DualTrainingFile = {
    version: 3
    keyKind: 'canonicalPathKey'
    white: TrainingNodeEntry[]
    black: TrainingNodeEntry[]
}

function serializeTree(root: Node): TrainingNodeEntry[] {
    const nodes: TrainingNodeEntry[] = []
    forEachNodeDepthFirst(root, (n, pathSans) => {
        nodes.push({
            pathKey: canonicalPathKey(pathSans),
            needsPractice: n.needsPractice,
        })
    })
    return nodes
}

export function serializeDualTrainingStatus(
    whiteRoot: Node,
    blackRoot: Node,
): DualTrainingFile {
    return {
        version: 3,
        keyKind: 'canonicalPathKey',
        white: serializeTree(whiteRoot),
        black: serializeTree(blackRoot),
    }
}

function applyTreeStatus(root: Node, nodes: TrainingNodeEntry[]): void {
    const byKey = new Map<string, boolean>()
    for (const row of nodes) byKey.set(row.pathKey, row.needsPractice)

    forEachNodeDepthFirst(root, (n, pathSans) => {
        const k = canonicalPathKey(pathSans)
        if (byKey.has(k)) n.needsPractice = byKey.get(k)!
    })
}

export function applyDualTrainingStatus(
    whiteRoot: Node,
    blackRoot: Node,
    data: DualTrainingFile,
): void {
    if (data.version !== 3 || data.keyKind !== 'canonicalPathKey') return
    applyTreeStatus(whiteRoot, data.white)
    applyTreeStatus(blackRoot, data.black)
}

export function parseTrainingFileJson(
    text: string,
): DualTrainingFile | { error: string } {
    try {
        const raw = JSON.parse(text) as unknown
        if (!raw || typeof raw !== 'object') return { error: 'Invalid JSON.' }
        const o = raw as DualTrainingFile
        if (
            o.version !== 3
            || o.keyKind !== 'canonicalPathKey'
            || !Array.isArray(o.white)
            || !Array.isArray(o.black)
        ) {
            return {
                error: 'Not a training status file (expected version 3 with white/black nodes).',
            }
        }
        return o
    }
    catch {
        return { error: 'Could not parse JSON.' }
    }
}
