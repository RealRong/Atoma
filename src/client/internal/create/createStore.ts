import type { CoreStore, StoreHandle } from '#core'
import { Core } from '#core'
import type { AtomaClientContext, AtomaSchema } from '../../types'

export const createStore = (ctx: any, options: any) => {
    const dataSource = options.dataSource ?? ctx.defaults.dataSourceFactory(options.name)
    const idGenerator = options.idGenerator ?? ctx.defaults.idGenerator

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
        store: ctx.jotaiStore as any,
        dataSource,
        relations: relationsFactory as any,
        services: ctx.services
    })
}

export function createStoreInstance(args: {
    name: string
    schema: AtomaSchema<any>
    ctx: AtomaClientContext<any, any>
}): { store: CoreStore<any, any>; handle: StoreHandle<any> | null } {
    const name = String(args.name)
    const storeSchema = (args.schema as any)?.[name] ?? {}

    const created = createStore(args.ctx, { ...(storeSchema as any), name })

    const handle = Core.store.getHandle(created)
    return {
        store: created,
        handle
    }
}
