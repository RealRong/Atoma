import type { Patch } from 'immer'
import type { JsonPatch } from './types'

export function convertImmerPatchesToJsonPatches(
    patches: Patch[],
    entityId: string | number
): JsonPatch[] {
    return patches.map(p => {
        const pathArray = Array.isArray((p as any).path) ? (p as any).path : []
        const adjustedPath = pathArray.length > 0 && pathArray[0] === entityId
            ? pathArray.slice(1)
            : pathArray

        const jsonPatch: JsonPatch = {
            op: p.op as any,
            path: immerPathToJsonPointer(adjustedPath)
        }

        if ('value' in p) {
            jsonPatch.value = (p as any).value
        }

        return jsonPatch
    })
}

export function immerPathToJsonPointer(path: any[]): string {
    if (!path.length) return ''
    return '/' + path.map(segment => {
        return String(segment).replace(/~/g, '~0').replace(/\//g, '~1')
    }).join('/')
}

