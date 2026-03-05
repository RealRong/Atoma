import type { Entity } from 'atoma-types/core'
import type { WriteCtx } from '../context'

export async function hydrate<T extends Entity>(ctx: WriteCtx<T>) {
    const { runtime, scope, rows } = ctx
    const snapshot = scope.handle.state.snapshot()
    const missing = new Set<string>()

    rows.forEach((row) => {
        const intent = row.intent
        if (intent.action !== 'update' && intent.action !== 'delete') return

        const cached = snapshot.get(intent.id)
        if (cached) {
            row.base = cached
            return
        }
        missing.add(intent.id)
    })

    if (!missing.size) return

    const consistency = runtime.execution.getConsistency()
    if (consistency.base !== 'fetch') {
        const id = Array.from(missing)[0]
        throw new Error(`[Atoma] write: 缓存缺失且当前写入模式禁止补读，请先 fetch 再写入（id=${String(id)}）`)
    }
    if (!runtime.execution.hasExecutor('query')) {
        const id = Array.from(missing)[0]
        throw new Error(`[Atoma] write: 缓存缺失且未安装远端 query 执行器（id=${String(id)}）`)
    }

    const fetched = await runtime.stores.use<T>(scope.handle.storeName).hydrate(
        Array.from(missing),
        {
            signal: scope.signal,
            context: scope.context,
            mode: 'missing'
        }
    )

    rows.forEach((row) => {
        const intent = row.intent
        if (intent.action !== 'update' && intent.action !== 'delete') return
        if (row.base) return

        const base = fetched.get(intent.id)
        if (!base) {
            throw new Error(`Item with id ${intent.id} not found`)
        }
        row.base = base
    })
}
