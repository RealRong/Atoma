import type { Entity } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import { buildWriteOps } from '../../persistence'
import { buildWritebackFromResults } from './finalize'
import type { ExecuteWriteRequest } from './types'
import { OptimisticService } from './OptimisticService'

export class PersistCoordinator {
    private readonly optimisticService: OptimisticService

    constructor(args?: { optimisticService?: OptimisticService }) {
        this.optimisticService = args?.optimisticService ?? new OptimisticService()
    }

    execute = async <T extends Entity>(args: ExecuteWriteRequest<T> & {
        before: Map<EntityId, T>
        optimisticState: Map<EntityId, T>
        changedIds: Set<EntityId>
    }): Promise<T | void> => {
        const runtime = args.runtime
        const { handle, intents, opContext } = args

        const plan = await buildWriteOps({
            runtime,
            handle,
            intents,
            opContext
        })

        const writeOps = plan.map(entry => entry.op)
        if (!writeOps.length) {
            const primary = intents.length === 1 ? intents[0] : undefined
            if (primary && primary.action !== 'delete') {
                return primary.value as T
            }
            return undefined
        }

        try {
            const persistResult = await runtime.persistence.persist({
                storeName: String(handle.storeName),
                writeStrategy: args.writeStrategy,
                handle,
                opContext,
                writeOps
            })

            const primaryIntent = intents.length === 1 ? intents[0] : undefined
            const resolved = (persistResult.results && persistResult.results.length)
                ? await buildWritebackFromResults<T>({
                    runtime,
                    handle,
                    plan,
                    results: persistResult.results,
                    primaryIntent
                })
                : {}

            if (resolved.writeback) {
                handle.state.applyWriteback(resolved.writeback)
            }

            return resolved.output ?? (primaryIntent?.value as T | undefined)
        } catch (error) {
            this.optimisticService.rollback({
                handle,
                before: args.before,
                optimisticState: args.optimisticState,
                changedIds: args.changedIds
            })
            throw error
        }
    }
}
