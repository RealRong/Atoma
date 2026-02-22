import { invertChanges } from 'atoma-core/store'
import type {
    Entity,
    StoreChange,
    StoreOperationOptions
} from 'atoma-types/core'
import type { Runtime, ChangeDirection, StoreHandle } from 'atoma-types/runtime'

export class ChangeFlow {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    private replay = async <T extends Entity>({
        handle,
        direction,
        changes,
        options
    }: {
        handle: StoreHandle<T>
        direction: ChangeDirection
        changes: ReadonlyArray<StoreChange<T>>
        options?: StoreOperationOptions
    }): Promise<void> => {
        const context = this.runtime.engine.action.createContext(options?.context)
        const storeName = handle.storeName

        this.runtime.events.emit('changeStart', {
            storeName,
            context,
            direction,
            changes
        })

        try {
            const replayChanges = direction === 'apply'
                ? [...changes]
                : invertChanges([...changes].reverse())
            const delta = handle.state.apply(replayChanges)

            this.runtime.events.emit('changeCommitted', {
                storeName,
                context,
                direction,
                changes: delta?.changes ?? []
            })
        } catch (error) {
            this.runtime.events.emit('changeFailed', {
                storeName,
                context,
                direction,
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
            direction: 'apply',
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
            direction: 'revert',
            changes,
            options
        })
    }
}
