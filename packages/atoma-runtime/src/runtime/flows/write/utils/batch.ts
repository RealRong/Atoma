import type {
    StoreOperationOptions,
    WriteManyItemErr,
    WriteManyItemOk,
    WriteManyResult
} from 'atoma-types/core'

function resolveConcurrency(options?: StoreOperationOptions): number {
    const rawConcurrency = options?.batch?.concurrency
    const concurrency = (typeof rawConcurrency === 'number' && Number.isFinite(rawConcurrency))
        ? Math.max(1, Math.floor(rawConcurrency))
        : 1
    return concurrency
}

function resolveAbortError(signal?: AbortSignal): unknown {
    if (!signal?.aborted) return undefined
    if (signal.reason !== undefined) return signal.reason
    const error = new Error('[Atoma] runBatch aborted')
    error.name = 'AbortError'
    return error
}

function fillMissingResults<Output>({
    results,
    error
}: {
    results: WriteManyResult<Output>
    error: unknown
}) {
    for (let index = 0; index < results.length; index++) {
        if (results[index] !== undefined) continue
        results[index] = {
            index,
            ok: false,
            error
        }
    }
}

export async function runBatch<Input, Output>({
    items,
    options,
    runner
}: {
    items: Input[]
    options?: StoreOperationOptions
    runner: (item: Input) => Promise<Output>
}): Promise<WriteManyResult<Output>> {
    const concurrency = resolveConcurrency(options)
    const signal = options?.signal
    const results: WriteManyResult<Output> = new Array(items.length)
    if (!items.length) return results

    const onSuccess = (index: number, value: Output): WriteManyItemOk<Output> => ({ index, ok: true, value })
    const onError = (index: number, error: unknown): WriteManyItemErr => ({ index, ok: false, error })

    const abortedBeforeRun = resolveAbortError(signal)
    if (abortedBeforeRun !== undefined) {
        fillMissingResults({
            results,
            error: abortedBeforeRun
        })
        return results
    }

    if (concurrency <= 1 || items.length <= 1) {
        for (let index = 0; index < items.length; index++) {
            const abortError = resolveAbortError(signal)
            if (abortError !== undefined) {
                fillMissingResults({
                    results,
                    error: abortError
                })
                return results
            }

            try {
                const value = await runner(items[index])
                results[index] = onSuccess(index, value)
            } catch (error) {
                results[index] = onError(index, error)
            }
        }
        return results
    }

    let cursor = 0
    const worker = async () => {
        while (true) {
            if (resolveAbortError(signal) !== undefined) return

            const index = cursor
            cursor += 1
            if (index >= items.length) return

            if (resolveAbortError(signal) !== undefined) return

            try {
                const value = await runner(items[index])
                results[index] = onSuccess(index, value)
            } catch (error) {
                results[index] = onError(index, error)
            }
        }
    }

    const workerCount = Math.min(concurrency, items.length)
    const workers: Array<Promise<void>> = []
    for (let i = 0; i < workerCount; i++) {
        workers.push(worker())
    }
    await Promise.all(workers)

    const abortError = resolveAbortError(signal)
    fillMissingResults({
        results,
        error: abortError ?? new Error('[Atoma] runBatch: missing result')
    })

    return results
}
