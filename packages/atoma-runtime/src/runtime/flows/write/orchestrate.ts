import type {
    Entity,
    StoreChange,
    WriteManyResult
} from 'atoma-types/core'
import type {
    Runtime,
    WriteEventSource,
    WriteStatus
} from 'atoma-types/runtime'
import type {
    IntentCommand,
    WriteScope
} from './contracts'
import {
    build,
    commit,
    createContext,
    hydrate,
    preflight,
    reconcileEmit
} from './pipeline'

export type OrchestrateWriteResult<T extends Entity> = Readonly<{
    status: WriteStatus
    results: WriteManyResult<T | void>
    changes: ReadonlyArray<StoreChange<T>>
}>

export async function orchestrateWrite<T extends Entity>({
    runtime,
    scope,
    source,
    intents
}: {
    runtime: Runtime
    scope: WriteScope<T>
    source: WriteEventSource
    intents: ReadonlyArray<IntentCommand<T>>
}): Promise<OrchestrateWriteResult<T>> {
    if (!intents.length) {
        return {
            status: 'confirmed',
            results: [],
            changes: []
        }
    }

    const ctx = createContext({
        runtime,
        scope
    })
    preflight(ctx, intents)
    await hydrate(ctx)
    await build(ctx)

    const writeEntries = ctx.rows.map((row, index) => {
        if (!row.entry) {
            throw new Error(`[Atoma] write: missing write entry at index=${index}`)
        }
        return row.entry
    })
    const { handle, context } = scope
    runtime.events.emit('writeStart', {
        storeName: handle.storeName,
        context,
        source,
        writeEntries
    })

    try {
        await commit(ctx)
        await reconcileEmit(ctx)

        const singleResult = ctx.rows.length === 1
            ? ctx.results[0]
            : undefined
        if (ctx.rows.length === 1) {
            if (!singleResult) {
                throw new Error('[Atoma] write: missing write result at index=0')
            }
            if (!singleResult.ok) {
                throw singleResult.error
            }
        }

        runtime.events.emit('writeCommitted', {
            storeName: handle.storeName,
            context,
            writeEntries,
            status: ctx.status,
            results: ctx.results,
            ...(singleResult?.ok ? { result: singleResult.value } : {}),
            changes: ctx.changes
        })
        return {
            status: ctx.status,
            results: ctx.results,
            changes: ctx.changes
        }
    } catch (error) {
        runtime.events.emit('writeFailed', {
            storeName: handle.storeName,
            context,
            writeEntries,
            error
        })
        throw error
    }
}
