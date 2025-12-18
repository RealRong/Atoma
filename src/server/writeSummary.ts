export type WriteChangeSummary = {
    changedFields: string[]
    changedPaths?: Array<Array<string | number>>
}

export function summarizeCreateItem(item: unknown): WriteChangeSummary {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { changedFields: [] }
    return { changedFields: Object.keys(item as any) }
}

export function summarizeUpdateData(data: unknown): WriteChangeSummary {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { changedFields: [] }
    return { changedFields: Object.keys(data as any) }
}

export function summarizePatches(patches: unknown): WriteChangeSummary {
    const list = Array.isArray(patches) ? patches : []
    const changedFields: string[] = []
    const changedPaths: Array<Array<string | number>> = []

    for (const p of list) {
        const path = (p as any)?.path
        if (!Array.isArray(path) || !path.length) continue
        changedPaths.push(path as Array<string | number>)
        const first = path[0]
        if (typeof first === 'string' && first && !changedFields.includes(first)) {
            changedFields.push(first)
        }
    }

    return {
        changedFields,
        ...(changedPaths.length ? { changedPaths } : {})
    }
}

