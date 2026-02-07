import type { StoreOperationOptions } from 'atoma-types/core'

function normalizeConcurrency(options?: StoreOperationOptions): number {
    const raw = options?.batch?.concurrency
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
    return Math.max(1, Math.floor(raw))
}

export class WriteBatchRunner {
    runMany = async <T, R>(args: {
        items: T[]
        options?: StoreOperationOptions
        runner: (item: T) => Promise<R>
        toResult: (args: { index: number; value: R }) => any
        toError: (args: { index: number; error: unknown }) => any
    }) => {
        const { items, runner, toResult, toError } = args
        const concurrency = normalizeConcurrency(args.options)
        const results: any[] = new Array(items.length)

        if (!items.length) return results

        if (concurrency <= 1 || items.length <= 1) {
            for (let index = 0; index < items.length; index++) {
                const entry = items[index]
                try {
                    const value = await runner(entry)
                    results[index] = toResult({ index, value })
                } catch (error) {
                    results[index] = toError({ index, error })
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
                    results[index] = toResult({ index, value })
                } catch (error) {
                    results[index] = toError({ index, error })
                }
            }
        }

        const workers = new Array(Math.min(concurrency, items.length)).fill(null).map(() => worker())
        await Promise.all(workers)
        return results
    }
}
