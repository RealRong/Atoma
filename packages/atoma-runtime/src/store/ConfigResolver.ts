import { Relations } from 'atoma-core'
import type * as Types from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'
import type { CoreRuntime, RuntimeSchema } from 'atoma-types/runtime'

export class ConfigResolver {
    private readonly schema: RuntimeSchema
    private readonly runtime: CoreRuntime
    private readonly defaults?: {
        idGenerator?: () => EntityId
    }
    private readonly dataProcessor?: Types.StoreDataProcessor<any>

    constructor(args: {
        schema: RuntimeSchema
        runtime: CoreRuntime
        defaults?: {
            idGenerator?: () => EntityId
        }
        dataProcessor?: Types.StoreDataProcessor<any>
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
            ? () => Relations.compileRelationsMap((storeSchema as any).relations, storeName)
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
        base?: Types.StoreDataProcessor<T>,
        override?: Types.StoreDataProcessor<T>
    ): Types.StoreDataProcessor<T> | undefined => {
        if (!base && !override) return undefined
        return {
            ...(base ?? {}),
            ...(override ?? {})
        } as Types.StoreDataProcessor<T>
    }

}
