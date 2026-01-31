import { belongsTo, hasMany, hasOne } from 'atoma-core'
import type { StoreDataProcessor } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { AtomaSchema } from '#client/types'
import type { ClientRuntimeInternal } from '#client/internal/types'

export class StoreConfigResolver {
    private readonly schema: AtomaSchema<any>
    private readonly clientRuntime: ClientRuntimeInternal
    private readonly defaults?: {
        idGenerator?: () => EntityId
    }
    private readonly dataProcessor?: StoreDataProcessor<any>

    constructor(args: {
        schema: AtomaSchema<any>
        clientRuntime: ClientRuntimeInternal
        defaults?: {
            idGenerator?: () => EntityId
        }
        dataProcessor?: StoreDataProcessor<any>
    }) {
        this.schema = args.schema
        this.clientRuntime = args.clientRuntime
        this.defaults = args.defaults
        this.dataProcessor = args.dataProcessor
    }

    resolve = (storeName: string) => {
        const storeSchema = (this.schema as any)?.[storeName] ?? {}

        const idGenerator = (storeSchema as any)?.idGenerator ?? this.defaults?.idGenerator
        const dataProcessor = this.mergeDataProcessor(this.dataProcessor, (storeSchema as any)?.dataProcessor)

        const relationsFactory = (storeSchema as any)?.relations
            ? () => this.compileRelationsMap((storeSchema as any).relations, storeName)
            : undefined

        return {
            ...(storeSchema as any),
            name: storeName,
            ...(idGenerator ? { idGenerator } : {}),
            ...(dataProcessor ? { dataProcessor } : {}),
            relations: relationsFactory as any,
            clientRuntime: this.clientRuntime
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

    private compileRelationsMap = (relationsRaw: unknown, storeName: string): Record<string, any> => {
        const relations: Record<string, any> = {}
        const schema = relationsRaw as any
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return relations

        for (const k of Object.keys(schema)) {
            const def = schema[k]
            if (!def || typeof def !== 'object') continue

            const type = (def as any).type
            const to = (def as any).to

            if (type === 'belongsTo') {
                relations[k] = belongsTo(String(to), {
                    foreignKey: (def as any).foreignKey,
                    primaryKey: (def as any).primaryKey,
                    options: (def as any).options
                })
                continue
            }

            if (type === 'hasMany') {
                relations[k] = hasMany(String(to), {
                    primaryKey: (def as any).primaryKey,
                    foreignKey: (def as any).foreignKey as any,
                    options: (def as any).options
                })
                continue
            }

            if (type === 'hasOne') {
                relations[k] = hasOne(String(to), {
                    primaryKey: (def as any).primaryKey,
                    foreignKey: (def as any).foreignKey as any,
                    options: (def as any).options
                })
                continue
            }

            throw new Error(`[Atoma] schema.${storeName}.relations.${String(k)}.type is invalid: ${String(type)}`)
        }

        return relations
    }
}
