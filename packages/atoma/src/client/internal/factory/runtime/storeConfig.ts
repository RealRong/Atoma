import type { StoreDataProcessor } from '#core'
import { Core } from '#core'
import type { EntityId } from '#protocol'
import type { AtomaSchema } from '#client/types'
import type { ClientRuntimeInternal } from '#client/internal/types'

const mergeDataProcessor = <T>(base?: StoreDataProcessor<T>, override?: StoreDataProcessor<T>): StoreDataProcessor<T> | undefined => {
    if (!base && !override) return undefined
    return {
        ...(base ?? {}),
        ...(override ?? {})
    } as StoreDataProcessor<T>
}

function compileRelationsMap(relationsRaw: unknown, storeName: string): Record<string, any> {
    const relations: Record<string, any> = {}
    const schema = relationsRaw as any
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return relations

    for (const k of Object.keys(schema)) {
        const def = schema[k]
        if (!def || typeof def !== 'object') continue

        const type = (def as any).type
        const to = (def as any).to

        if (type === 'belongsTo') {
            relations[k] = Core.relations.belongsTo(String(to), {
                foreignKey: (def as any).foreignKey,
                primaryKey: (def as any).primaryKey,
                options: (def as any).options
            })
            continue
        }

        if (type === 'hasMany') {
            relations[k] = Core.relations.hasMany(String(to), {
                primaryKey: (def as any).primaryKey,
                foreignKey: (def as any).foreignKey as any,
                options: (def as any).options
            })
            continue
        }

        if (type === 'hasOne') {
            relations[k] = Core.relations.hasOne(String(to), {
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

export function resolveStoreCreateOptions(args: {
    storeName: string
    schema: AtomaSchema<any>
    clientRuntime: ClientRuntimeInternal
    defaults?: {
        idGenerator?: () => EntityId
    }
    dataProcessor?: StoreDataProcessor<any>
}) {
    const storeSchema = (args.schema as any)?.[args.storeName] ?? {}

    const idGenerator = (storeSchema as any)?.idGenerator ?? args.defaults?.idGenerator
    const dataProcessor = mergeDataProcessor(args.dataProcessor, (storeSchema as any)?.dataProcessor)

    const relationsFactory = (storeSchema as any)?.relations
        ? () => compileRelationsMap((storeSchema as any).relations, args.storeName)
        : undefined

    return {
        ...(storeSchema as any),
        name: args.storeName,
        ...(idGenerator ? { idGenerator } : {}),
        ...(dataProcessor ? { dataProcessor } : {}),
        relations: relationsFactory as any,
        clientRuntime: args.clientRuntime
    }
}
