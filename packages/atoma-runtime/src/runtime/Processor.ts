import type {
    ProcessorContext,
    ProcessorMode,
    ProcessorHandler,
    Entity,
    ActionContext,
    StoreProcessor
} from 'atoma-types/core'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'

export class Processor {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    private async run<T extends Entity>(
        mode: ProcessorMode,
        handle: StoreHandle<T>,
        data: T,
        context?: ActionContext
    ): Promise<T | undefined> {
        const processor = handle.config.processor as StoreProcessor<T> | undefined
        if (!processor) return data

        const processorContext: ProcessorContext = {
            storeName: handle.storeName,
            runtime: this.runtime,
            context,
            mode
        }

        const modeHandler = processor[mode]
        let current: T | undefined = data
        if (modeHandler) {
            if (typeof modeHandler !== 'function') {
                throw new Error(`[Atoma] processor.${mode} must be a function`)
            }
            current = await modeHandler(current, processorContext)
        }
        if (current === undefined) return undefined
        if (!processor.validate) return current

        const validator = processor.validate as ProcessorHandler<T>
        if (typeof validator !== 'function') {
            throw new Error('[Atoma] processor.validate must be a function')
        }
        return await validator(current, processorContext)
    }

    async inbound<T extends Entity>(
        handle: StoreHandle<T>,
        data: T,
        context?: ActionContext
    ): Promise<T | undefined> {
        return this.run('inbound', handle, data, context)
    }

    async writeback<T extends Entity>(
        handle: StoreHandle<T>,
        data: T,
        context?: ActionContext
    ): Promise<T | undefined> {
        return this.run('writeback', handle, data, context)
    }

    async outbound<T extends Entity>(
        handle: StoreHandle<T>,
        data: T,
        context?: ActionContext
    ): Promise<T | undefined> {
        return this.run('outbound', handle, data, context)
    }
}
