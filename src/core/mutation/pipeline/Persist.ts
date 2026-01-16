import type { Entity, StoreDispatchEvent, StoreHandle } from '../../types'
import type { PersistResult } from './types'
import type { MutationProgram } from './types'
import { executeWriteOps } from './Ops'
import type { ObservabilityContext } from '#observability'

export function resolvePersistModeFromOperations<T extends Entity>(operations: Array<StoreDispatchEvent<T>>): 'direct' | 'outbox' {
    const set = new Set<'direct' | 'outbox'>()
    for (const op of operations) {
        const m = op.persist
        if (m === 'outbox' || m === 'direct') set.add(m)
    }
    if (set.size === 0) return 'direct'
    if (set.size === 1) return Array.from(set)[0] as 'direct' | 'outbox'
    throw new Error('[Atoma] mixed persist modes in one mutation segment (direct vs outbox)')
}

export async function persistMutation<T extends Entity>(args: {
    handle: StoreHandle<T>
    program: MutationProgram<T>
    context?: ObservabilityContext
}): Promise<PersistResult<T>> {
    const persistDirect = async (): Promise<PersistResult<T>> => {
        const normalized = await executeWriteOps<T>({
            handle: args.handle,
            ops: args.program.writeOps,
            context: args.context
        })
        return {
            mode: 'direct',
            status: 'confirmed',
            ...(normalized.created ? { created: normalized.created } : {}),
            ...(normalized.writeback ? { writeback: normalized.writeback } : {})
        }
    }

    const persistOutbox = async (): Promise<PersistResult<T>> => {
        const outbox = args.handle.services.outbox
        if (!outbox) {
            throw new Error('[Atoma] outbox persist requested but runtime.outbox is not configured (sync not installed)')
        }

        const queueMode = outbox.queueMode === 'local-first' ? 'local-first' : 'queue'

        let localPersist: PersistResult<T> | undefined
        if (queueMode === 'local-first') {
            localPersist = await persistDirect()
        }

        const ops = args.program.writeOps.map(o => o.op)
        if (ops.length) {
            const enqueuer = outbox.ensureEnqueuer()
            await enqueuer.enqueueOps({ ops })
        }

        return {
            mode: 'outbox',
            status: 'enqueued',
            ...(localPersist?.created ? { created: localPersist.created } : {}),
            ...(localPersist?.writeback ? { writeback: localPersist.writeback } : {})
        }
    }

    return args.program.persistMode === 'direct' ? persistDirect() : persistOutbox()
}
