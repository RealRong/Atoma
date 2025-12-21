export function byteLength(input: string): number {
    if (typeof input !== 'string') return 0

    const anyGlobal = globalThis as any
    const buffer = anyGlobal?.Buffer
    if (buffer?.byteLength) {
        return buffer.byteLength(input, 'utf8')
    }

    const encoder = anyGlobal?.TextEncoder ? new anyGlobal.TextEncoder() : undefined
    if (encoder?.encode) {
        return encoder.encode(input).length
    }

    // Fallback approximation (UTF-16 code units)
    return input.length * 2
}
