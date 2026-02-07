import type { Entity } from 'atoma-types/core'
import type { ExecuteWriteRequest } from '../types'
import { resolveWriteResultFromOperationResults } from '../utils/resolveWriteResult'
import { applyOptimisticCommit, rollbackOptimisticCommit } from '../utils/optimisticCommit'
import { WriteOpsPlanner } from './WriteOpsPlanner'

export class WriteCommitFlow {
    private readonly writeOpsPlanner: WriteOpsPlanner

    constructor(args?: {
        writeOpsPlanner?: WriteOpsPlanner
    }) {
        this.writeOpsPlanner = args?.writeOpsPlanner ?? new WriteOpsPlanner()
    }

    execute = async <T extends Entity>(args: ExecuteWriteRequest<T>): Promise<T | void> => {
        const intents = args.intents ?? []
        const writePolicy = args.runtime.strategy.resolveWritePolicy(args.writeStrategy)
        const optimisticState = applyOptimisticCommit({
            handle: args.handle,
            intents,
            writePolicy
        })

        const { runtime, handle, opContext } = args

        try {
            const plan = await this.writeOpsPlanner.buildWriteOps({
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

            const persistResult = await runtime.strategy.persist({
                storeName: String(handle.storeName),
                writeStrategy: args.writeStrategy,
                handle,
                opContext,
                writeOps
            })

            const primaryIntent = intents.length === 1 ? intents[0] : undefined
            const resolved = (persistResult.results && persistResult.results.length)
                ? await resolveWriteResultFromOperationResults<T>({
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
            rollbackOptimisticCommit({
                handle,
                optimisticState
            })
            throw error
        }
    }
}
