export function preserveReferenceShallow<T>(existing: T | undefined, incoming: T): T {
    if (existing === undefined || existing === null) return incoming
    if (existing === incoming) return existing

    if (typeof existing !== 'object' || existing === null) return incoming
    if (typeof incoming !== 'object' || incoming === null) return incoming
    if (Array.isArray(existing) || Array.isArray(incoming)) return incoming

    const a = existing as any
    const b = incoming as any

    for (const k in a) {
        if (!Object.prototype.hasOwnProperty.call(a, k)) continue
        if (a[k] !== b[k]) return incoming
    }
    for (const k in b) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) continue
        if (b[k] !== a[k]) return incoming
    }

    return existing
}

