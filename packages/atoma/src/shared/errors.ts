export function toError(reason: unknown): Error {
    if (reason instanceof Error) return reason
    if (typeof reason === 'string' && reason) return new Error(reason)
    try {
        return new Error(JSON.stringify(reason))
    } catch {
        return new Error('Unknown error')
    }
}

export function toErrorWithFallback(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error) return reason
    if (typeof reason === 'string' && reason) return new Error(reason)
    try {
        return new Error(`${fallbackMessage}: ${JSON.stringify(reason)}`)
    } catch {
        return new Error(fallbackMessage)
    }
}
