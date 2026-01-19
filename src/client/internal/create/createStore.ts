import type { CoreStore, StoreDataProcessor } from '../../../core/types'
import { Core } from '#core'
import type { EntityId } from '#protocol'
import type { AtomaSchema, ClientRuntime } from '../../types'

const mergeDataProcessor = <T>(base?: StoreDataProcessor<T>, override?: StoreDataProcessor<T>): StoreDataProcessor<T> | undefined => {
    if (!base && !override) return undefined
    return {
        ...(base ?? {}),
        ...(override ?? {})
    } as StoreDataProcessor<T>
}

export const createStore = (
    clientRuntime: ClientRuntime,
    options: any,
    defaultIdGenerator?: () => EntityId,
    defaultDataProcessor?: StoreDataProcessor<any>
) => {
    const idGenerator = options.idGenerator ?? defaultIdGenerator
    const dataProcessor = mergeDataProcessor(defaultDataProcessor, options.dataProcessor)

    const createRelationsFromSchema = (schema: any) => {
        const relations: Record<string, any> = {}
        for (const k of Object.keys(schema || {})) {
            const def = schema[k]
            if (!def || typeof def !== 'object') continue
            if (def.type === 'belongsTo') {
                relations[k] = Core.relations.belongsTo(def.to, {
                    foreignKey: def.foreignKey,
                    primaryKey: def.primaryKey,
                    options: def.options
                })
            } else if (def.type === 'hasMany') {
                relations[k] = Core.relations.hasMany(def.to, {
                    primaryKey: def.primaryKey,
                    foreignKey: def.foreignKey,
                    options: def.options
                })
            } else if (def.type === 'hasOne') {
                relations[k] = Core.relations.hasOne(def.to, {
                    primaryKey: def.primaryKey,
                    foreignKey: def.foreignKey,
                    options: def.options
                })
            }
        }
        return relations
    }

    const relationsFactory = options.relations
        ? () => createRelationsFromSchema(options.relations)
        : undefined

    return Core.store.createStore<any, any>({
        ...(options as any),
        name: options.name,
        ...(idGenerator ? { idGenerator } : {}),
        ...(dataProcessor ? { dataProcessor } : {}),
        relations: relationsFactory as any,
        clientRuntime
    })
}

export function createStoreInstance(args: {
    name: string
    schema: AtomaSchema<any>
    clientRuntime: ClientRuntime
    defaultIdGenerator?: () => EntityId
    defaultDataProcessor?: StoreDataProcessor<any>
}): CoreStore<any, any> {
    const name = String(args.name)
    const storeSchema = (args.schema as any)?.[name] ?? {}

    const created = createStore(
        args.clientRuntime,
        { ...(storeSchema as any), name },
        args.defaultIdGenerator,
        args.defaultDataProcessor
    )
    return created
}
