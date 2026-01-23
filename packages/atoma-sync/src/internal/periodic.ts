import { AbortError } from '#sync/internal/abort'
import { sleepMs } from '#sync/internal/sleep'

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
        await sleepMs(initialDelayMs, args.signal)
    }

    while (args.shouldContinue()) {
        if (args.signal.aborted) throw new AbortError('aborted')
        await args.runOnce()
        if (!intervalMs) return
        await sleepMs(intervalMs, args.signal)
    }
}
