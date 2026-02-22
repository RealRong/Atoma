import type {
    Entity,
    WriteManyResult
} from 'atoma-types/core'
import type {
    Runtime,
    WriteEventSource
} from 'atoma-types/runtime'
import { commitWrites } from './commit/commitWrites'
import { prepareLocalWrites } from './prepare/prepareLocalWrite'
import type {
    IntentCommand,
    IntentInput,
    PreparedWrites,
    WriteScope
} from './types'

export type OrchestrateWriteResult<T extends Entity> = Readonly<{
    prepared: PreparedWrites<T>
    status: 'confirmed' | 'partial' | 'rejected' | 'enqueued'
    results: WriteManyResult<T | void>
}>

export async function orchestrateWrite<T extends Entity>({
    runtime,
    session,
    source,
    intents
}: {
    runtime: Runtime
    session: WriteScope<T>
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

    const inputs: IntentInput<T>[] = intents.map((intent) => ({
        kind: 'intent',
        scope: session,
        ...intent
    }))
    const prepared = await prepareLocalWrites(runtime, inputs)
    const writeEntries = prepared.map((item) => item.entry)
    const { handle, context } = session
    runtime.events.emit.writeStart({
        storeName: handle.storeName,
        context,
        source,
        writeEntries
    })

    try {
        const commitResult = await commitWrites<T>({
            runtime,
            scope: session,
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

        runtime.events.emit.writeCommitted({
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
        runtime.events.emit.writeFailed({
            storeName: handle.storeName,
            context,
            writeEntries,
            error
        })
        throw error
    }
}
