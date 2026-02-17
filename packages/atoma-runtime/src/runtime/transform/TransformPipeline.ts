import type {
    DataProcessorContext,
    DataProcessorMode,
    DataProcessorStage,
    DataProcessorStageFn,
    DataProcessorValidate,
    Entity,
    ActionContext,
    SchemaValidator,
    StoreDataProcessor
} from 'atoma-types/core'
import type { Runtime, StoreHandle } from 'atoma-types/runtime'

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

export class TransformPipeline {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    async process<T>(mode: DataProcessorMode, data: T, args: {
        storeName: string
        runtime: Runtime
        context?: ActionContext
        adapter?: unknown
        dataProcessor?: StoreDataProcessor<T>
    }): Promise<T | undefined> {
        const pipeline = args.dataProcessor
        if (!pipeline) return data

        let current: T | undefined = data
        for (const stage of STAGE_ORDER) {
            if (current === undefined) return undefined
            const handler = pipeline[stage]
            if (!handler) continue

            const stageContext: DataProcessorContext<T> = {
                storeName: args.storeName,
                runtime: args.runtime,
                context: args.context,
                adapter: args.adapter,
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
        context?: ActionContext
    ): Promise<T | undefined> {
        const runtime = this.runtime
        return this.process('inbound', data, {
            storeName: handle.storeName,
            runtime,
            context,
            dataProcessor: handle.config.dataProcessor
        })
    }

    async writeback<T extends Entity>(
        handle: StoreHandle<T>,
        data: T,
        context?: ActionContext
    ): Promise<T | undefined> {
        const runtime = this.runtime
        return this.process('writeback', data, {
            storeName: handle.storeName,
            runtime,
            context,
            dataProcessor: handle.config.dataProcessor
        })
    }

    async outbound<T extends Entity>(
        handle: StoreHandle<T>,
        data: T,
        context?: ActionContext
    ): Promise<T | undefined> {
        const runtime = this.runtime
        return this.process('outbound', data, {
            storeName: handle.storeName,
            runtime,
            context,
            dataProcessor: handle.config.dataProcessor
        })
    }
}
