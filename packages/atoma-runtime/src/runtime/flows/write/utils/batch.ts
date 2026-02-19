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

export async function runBatch<Input, Output>(args: {
    items: Input[]
    options?: StoreOperationOptions
    runner: (item: Input) => Promise<Output>
}): Promise<WriteManyResult<Output>> {
    const { items, runner } = args
    const concurrency = resolveConcurrency(args.options)
    const results: WriteManyResult<Output> = new Array(items.length)
    if (!items.length) return results

    const onSuccess = (index: number, value: Output): WriteManyItemOk<Output> => ({ index, ok: true, value })
    const onError = (index: number, error: unknown): WriteManyItemErr => ({ index, ok: false, error })

    if (concurrency <= 1 || items.length <= 1) {
        for (let index = 0; index < items.length; index++) {
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
            const index = cursor
            cursor += 1
            if (index >= items.length) return

            try {
                const value = await runner(items[index])
                results[index] = onSuccess(index, value)
            } catch (error) {
                results[index] = onError(index, error)
            }
        }
    }

    const workerCount = Math.min(concurrency, items.length)
    await Promise.all(new Array(workerCount).fill(null).map(() => worker()))
    return results
}
