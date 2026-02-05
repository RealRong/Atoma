import { AbortError } from '#sync/internal/abort'

export async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
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

