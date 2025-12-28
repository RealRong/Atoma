import { convertImmerPatchesToJsonPatches, immerPathToJsonPointer } from './immer'

export type { JsonPatchOp, JsonPatch } from './types'

export const jsonPatch = {
    convertImmerPatchesToJsonPatches,
    immerPathToJsonPointer
} as const

export { convertImmerPatchesToJsonPatches, immerPathToJsonPointer }
