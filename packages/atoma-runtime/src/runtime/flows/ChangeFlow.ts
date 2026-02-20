import { invertChanges } from 'atoma-core/store'
import type {
    Entity,
    StoreChange,
    StoreOperationOptions
} from 'atoma-types/core'
import type { Runtime, Changes, ChangeEventSource, StoreHandle } from 'atoma-types/runtime'

export class ChangeFlow implements Changes {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    private replay = async <T extends Entity>({
        handle,
        source,
        changes,
        options
    }: {
        handle: StoreHandle<T>
        source: ChangeEventSource
        changes: ReadonlyArray<StoreChange<T>>
        options?: StoreOperationOptions
    }): Promise<void> => {
        const context = this.runtime.engine.action.createContext(options?.context)
        const route = options?.route ?? handle.config.defaultRoute
        const storeName = handle.storeName

        this.runtime.events.emit.changeStart({
            storeName,
            context,
            source,
            route,
            changes
        })

        try {
            const replayChanges = source === 'apply'
                ? [...changes]
                : invertChanges([...changes].reverse())
            const delta = handle.state.apply(replayChanges)

            this.runtime.events.emit.changeCommitted({
                storeName,
                context,
                source,
                route,
                changes: delta?.changes ?? []
            })
        } catch (error) {
            this.runtime.events.emit.changeFailed({
                storeName,
                context,
                source,
                route,
                changes,
                error
            })
            throw error
        }
    }

    apply = async <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        options?: StoreOperationOptions
    ): Promise<void> => {
        await this.replay({
            handle,
            source: 'apply',
            changes,
            options
        })
    }

    revert = async <T extends Entity>(
        handle: StoreHandle<T>,
        changes: ReadonlyArray<StoreChange<T>>,
        options?: StoreOperationOptions
    ): Promise<void> => {
        await this.replay({
            handle,
            source: 'revert',
            changes,
            options
        })
    }
}
