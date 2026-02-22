import { toErrorWithFallback } from 'atoma-shared'
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
    const v = value as {
        safeParse?: unknown
        parse?: unknown
        validateSync?: unknown
        validate?: unknown
    }
    return typeof v.safeParse === 'function'
        || typeof v.parse === 'function'
        || typeof v.validateSync === 'function'
        || typeof v.validate === 'function'
}

async function applySchemaValidator<T>(item: T, schema: SchemaValidator<T>): Promise<T> {
    const validator = schema as {
        safeParse?: (input: T) => { success: boolean; data: T; error?: unknown }
        parse?: (input: T) => T
        validateSync?: (input: T) => T
        validate?: (input: T) => Promise<T> | T
    }

    try {
        if (validator.safeParse) {
            const result = validator.safeParse(item)
            if (!result.success) {
                throw toErrorWithFallback(result.error, 'Schema validation failed')
            }
            return result.data as T
        }

        if (validator.parse) {
            return validator.parse(item)
        }

        if (validator.validateSync) {
            return validator.validateSync(item)
        }

        if (validator.validate) {
            return await validator.validate(item)
        }

        if (typeof schema === 'function') {
            return await schema(item)
        }
    } catch (error) {
        throw toErrorWithFallback(error, 'Schema validation failed')
    }

    return item
}

async function runValidateStage<T>(
    value: T,
    validator: DataProcessorValidate<T>,
    context: DataProcessorContext<T>
): Promise<T | undefined> {
    if (typeof validator === 'function') {
        return await (validator as DataProcessorStageFn<T>)(value, context)
    }
    if (hasValidatorShape(validator)) {
        return await applySchemaValidator(value, validator as SchemaValidator<T>)
    }
    throw new Error('[Atoma] dataProcessor.validate must be a function or schema validator')
}

export class TransformPipeline {
    private readonly runtime: Runtime

    constructor(runtime: Runtime) {
        this.runtime = runtime
    }

    private run<T extends Entity>(
        mode: DataProcessorMode,
        handle: StoreHandle<T>,
        data: T,
        context?: ActionContext
    ): Promise<T | undefined> {
        return this.process(mode, data, {
            storeName: handle.storeName,
            runtime: this.runtime,
            context,
            dataProcessor: handle.config.dataProcessor
        })
    }

    async process<T>(
        mode: DataProcessorMode,
        data: T,
        {
            storeName,
            runtime,
            context,
            adapter,
            dataProcessor
        }: {
            storeName: string
            runtime: Runtime
            context?: ActionContext
            adapter?: unknown
            dataProcessor?: StoreDataProcessor<T>
        }
    ): Promise<T | undefined> {
        const pipeline = dataProcessor
        if (!pipeline) return data

        let current: T | undefined = data
        for (const stage of STAGE_ORDER) {
            if (current === undefined) return undefined
            const handler = pipeline[stage]
            if (!handler) continue

            const stageContext: DataProcessorContext<T> = {
                storeName,
                runtime,
                context,
                adapter,
                mode,
                stage
            }

            if (stage === 'validate') {
                current = await runValidateStage(current, handler as DataProcessorValidate<T>, stageContext)
                continue
            }
            if (typeof handler !== 'function') {
                throw new Error(`[Atoma] dataProcessor.${stage} must be a function`)
            }

            current = await (handler as DataProcessorStageFn<T>)(current, stageContext)
        }

        return current
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
