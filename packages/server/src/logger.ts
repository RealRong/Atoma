export type AtomaServerLogger = {
    child?: (bindings: Record<string, unknown>) => AtomaServerLogger
    debug?: (msg: string, meta?: any) => void
    info?: (msg: string, meta?: any) => void
    warn?: (msg: string, meta?: any) => void
    error?: (msg: string, meta?: any) => void
}

export function createNoopLogger(): AtomaServerLogger {
    return {}
}

