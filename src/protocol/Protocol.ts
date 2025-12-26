import { error } from './error'
import { ops } from './ops'
import { encodeWriteIntent } from './ops/encodeWrite'
import { convertImmerPatchesToJsonPatches, immerPathToJsonPointer } from './jsonPatch/immer'
import { sse } from './sse'
import { trace } from './trace'

export const Protocol = {
    trace,
    error,
    ops: {
        ...ops,
        encodeWriteIntent
    },
    jsonPatch: {
        convertImmerPatchesToJsonPatches,
        immerPathToJsonPointer
    },
    sse,
    collab: {}
} as const
