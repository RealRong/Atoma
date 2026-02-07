import type { StoreOperationOptions } from 'atoma-types/core'

function normalizeConcurrency(options?: StoreOperationOptions): number {
    const raw = options?.batch?.concurrency
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
    return Math.max(1, Math.floor(raw))
}

export async function runWriteBatch<Input, Success, Result>(args: {
    items: Input[]
    options?: StoreOperationOptions
    runner: (item: Input) => Promise<Success>
    onSuccess: (args: { index: number; value: Success }) => Result
    onError: (args: { index: number; error: unknown }) => Result
}): Promise<Result[]> {
    const { items, runner, onSuccess, onError } = args
    const concurrency = normalizeConcurrency(args.options)
    const results: Result[] = new Array(items.length)

    if (!items.length) return results

    if (concurrency <= 1 || items.length <= 1) {
        for (let index = 0; index < items.length; index++) {
            const entry = items[index]
            try {
                const value = await runner(entry)
                results[index] = onSuccess({ index, value })
            } catch (error) {
                results[index] = onError({ index, error })
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

            const entry = items[index]
            try {
                const value = await runner(entry)
                results[index] = onSuccess({ index, value })
            } catch (error) {
                results[index] = onError({ index, error })
            }
        }
    }

    const workers = new Array(Math.min(concurrency, items.length)).fill(null).map(() => worker())
    await Promise.all(workers)
    return results
}
