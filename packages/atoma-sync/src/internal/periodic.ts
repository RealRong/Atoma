import { AbortError } from 'p-retry'

export async function runPeriodic(args: {
    intervalMs: number
    initialDelayMs?: number
    signal: AbortSignal
    shouldContinue: () => boolean
    runOnce: () => Promise<void>
}): Promise<void> {
    const intervalMs = Math.max(0, Math.floor(args.intervalMs))
    const initialDelayMs = Math.max(0, Math.floor(args.initialDelayMs ?? 0))

    if (initialDelayMs > 0) {
        await sleep(initialDelayMs, args.signal)
    }

    while (args.shouldContinue()) {
        if (args.signal.aborted) throw new AbortError('aborted')
        await args.runOnce()
        if (!intervalMs) return
        await sleep(intervalMs, args.signal)
    }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const delayMs = Math.max(0, Math.floor(ms))
    if (!delayMs) return
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        if (!signal) return
        if (signal.aborted) {
            clearTimeout(timer)
            reject(new AbortError('aborted'))
            return
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(new AbortError('aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

