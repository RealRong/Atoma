const fnv1a32 = (input: string) => {
    let hash = 0x811c9dc5
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return hash >>> 0
}

export function isSampled(traceId: string, sampleRate: number): boolean {
    if (!traceId) return false
    if (!Number.isFinite(sampleRate)) return false
    if (sampleRate <= 0) return false
    if (sampleRate >= 1) return true
    const v = fnv1a32(traceId) / 0xffffffff
    return v < sampleRate
}
