import type {
    Entity,
    WriteManyResult
} from 'atoma-types/core'
import type {
    Runtime,
    WriteEventSource,
    WriteStatus
} from 'atoma-types/runtime'
import { commitWrites } from './commit'
import { prepare } from './prepare'
import type {
    IntentCommand,
    PreparedWrites,
    WriteScope
} from './contracts'

export type OrchestrateWriteResult<T extends Entity> = Readonly<{
    prepared: PreparedWrites<T>
    status: WriteStatus
    results: WriteManyResult<T | void>
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
            prepared: [],
            status: 'confirmed',
            results: []
        }
    }

    const prepared = await prepare(runtime, scope, intents)
    const writeEntries = prepared.map((item) => item.entry)
    const { handle, context } = scope
    runtime.events.emit('writeStart', {
        storeName: handle.storeName,
        context,
        source,
        writeEntries
    })

    try {
        const commitResult = await commitWrites<T>({
            runtime,
            scope,
            prepared
        })
        const singleResult = prepared.length === 1
            ? commitResult.results[0]
            : undefined
        if (prepared.length === 1) {
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
            status: commitResult.status,
            results: commitResult.results,
            ...(singleResult?.ok ? { result: singleResult.value } : {}),
            changes: commitResult.changes
        })
        return {
            prepared,
            status: commitResult.status,
            results: commitResult.results
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
