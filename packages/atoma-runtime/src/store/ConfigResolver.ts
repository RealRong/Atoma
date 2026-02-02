import { compileRelationsMap } from 'atoma-core'
import type { StoreDataProcessor } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { CoreRuntime } from '../types/runtimeTypes'
import type { RuntimeSchema } from 'atoma-core'

export class ConfigResolver {
    private readonly schema: RuntimeSchema
    private readonly runtime: CoreRuntime
    private readonly defaults?: {
        idGenerator?: () => EntityId
    }
    private readonly dataProcessor?: StoreDataProcessor<any>

    constructor(args: {
        schema: RuntimeSchema
        runtime: CoreRuntime
        defaults?: {
            idGenerator?: () => EntityId
        }
        dataProcessor?: StoreDataProcessor<any>
    }) {
        this.schema = args.schema
        this.runtime = args.runtime
        this.defaults = args.defaults
        this.dataProcessor = args.dataProcessor
    }

    resolve = (storeName: string) => {
        const storeSchema = (this.schema as any)?.[storeName] ?? {}

        const idGenerator = (storeSchema as any)?.idGenerator ?? this.defaults?.idGenerator
        const dataProcessor = this.mergeDataProcessor(this.dataProcessor, (storeSchema as any)?.dataProcessor)

        const relationsFactory = (storeSchema as any)?.relations
            ? () => compileRelationsMap((storeSchema as any).relations, storeName)
            : undefined

        return {
            ...(storeSchema as any),
            name: storeName,
            ...(idGenerator ? { idGenerator } : {}),
            ...(dataProcessor ? { dataProcessor } : {}),
            relations: relationsFactory as any,
            clientRuntime: this.runtime
        }
    }

    private mergeDataProcessor = <T>(
        base?: StoreDataProcessor<T>,
        override?: StoreDataProcessor<T>
    ): StoreDataProcessor<T> | undefined => {
        if (!base && !override) return undefined
        return {
            ...(base ?? {}),
            ...(override ?? {})
        } as StoreDataProcessor<T>
    }

}
