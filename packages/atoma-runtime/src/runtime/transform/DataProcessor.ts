import type {
    DataProcessorContext,
    DataProcessorMode,
    DataProcessorStage,
    DataProcessorStageFn,
    DataProcessorValidate,
    Entity,
    OperationContext,
    SchemaValidator,
    StoreDataProcessor
} from 'atoma-core'
import type { CoreRuntime, StoreHandle } from '../../types/runtimeTypes'

const STAGE_ORDER: DataProcessorStage[] = [
    'deserialize',
    'normalize',
    'transform',
    'validate',
    'sanitize',
    'serialize'
]

const hasValidatorShape = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    const v: any = value as any
    return typeof v.safeParse === 'function'
        || typeof v.parse === 'function'
        || typeof v.validateSync === 'function'
        || typeof v.validate === 'function'
}

async function applySchemaValidator<T>(item: T, schema: SchemaValidator<T>): Promise<T> {
    try {
        if ((schema as any).safeParse) {
            const result = (schema as any).safeParse(item)
            if (!result.success) {
                const error = (result.error || 'Schema validation failed') as any
                throw error instanceof Error ? error : new Error(String(error))
            }
            return result.data as T
        }

        if ((schema as any).parse) {
            return (schema as any).parse(item)
        }

        if ((schema as any).validateSync) {
            return (schema as any).validateSync(item)
        }

        if ((schema as any).validate) {
            return await (schema as any).validate(item)
        }

        if (typeof schema === 'function') {
            return await (schema as any)(item)
        }
    } catch (error) {
        throw error instanceof Error ? error : new Error(String(error))
    }

    return item
}

async function runValidateStage<T>(
    value: T,
    validator: DataProcessorValidate<T>,
    context: DataProcessorContext<T>
): Promise<T | undefined> {
    if (hasValidatorShape(validator)) {
        return await applySchemaValidator(value, validator as SchemaValidator<T>)
    }
    if (typeof validator === 'function') {
        return await (validator as DataProcessorStageFn<T>)(value, context)
    }
    throw new Error('[Atoma] dataProcessor.validate must be a function or schema validator')
}

async function runStage<T>(
    stage: DataProcessorStage,
    handler: DataProcessorStageFn<T>,
    value: T,
    context: DataProcessorContext<T>
): Promise<T | undefined> {
    if (typeof handler !== 'function') {
        throw new Error(`[Atoma] dataProcessor.${stage} must be a function`)
    }
    return await handler(value, context)
}

export class DataProcessor {
    private readonly getRuntime: () => CoreRuntime

    constructor(getRuntime: () => CoreRuntime) {
        this.getRuntime = getRuntime
    }

    async process<T>(mode: DataProcessorMode, data: T, context: {
        storeName: string
        runtime: CoreRuntime
        opContext?: OperationContext
        adapter?: unknown
        dataProcessor?: StoreDataProcessor<T>
    }): Promise<T | undefined> {
        const pipeline = context.dataProcessor
        if (!pipeline) return data

        let current: T | undefined = data
        for (const stage of STAGE_ORDER) {
            if (current === undefined) return undefined
            const handler = pipeline[stage]
            if (!handler) continue

            const stageContext: DataProcessorContext<T> = {
                storeName: context.storeName,
                runtime: context.runtime,
                opContext: context.opContext,
                adapter: context.adapter,
                mode,
                stage
            }

            current = stage === 'validate'
                ? await runValidateStage(current, handler as DataProcessorValidate<T>, stageContext)
                : await runStage(stage, handler as DataProcessorStageFn<T>, current, stageContext)
        }

        return current
    }

    async inbound<T extends Entity>(
        handle: StoreHandle<T>,
        data: T,
        opContext?: OperationContext
    ): Promise<T | undefined> {
        const runtime = this.getRuntime()
        return this.process('inbound', data, {
            storeName: handle.storeName,
            runtime,
            opContext,
            dataProcessor: handle.dataProcessor
        })
    }

    async writeback<T extends Entity>(
        handle: StoreHandle<T>,
        data: T,
        opContext?: OperationContext
    ): Promise<T | undefined> {
        const runtime = this.getRuntime()
        return this.process('writeback', data, {
            storeName: handle.storeName,
            runtime,
            opContext,
            dataProcessor: handle.dataProcessor
        })
    }

    async outbound<T extends Entity>(
        handle: StoreHandle<T>,
        data: T,
        opContext?: OperationContext
    ): Promise<T | undefined> {
        const runtime = this.getRuntime()
        return this.process('outbound', data, {
            storeName: handle.storeName,
            runtime,
            opContext,
            dataProcessor: handle.dataProcessor
        })
    }
}
