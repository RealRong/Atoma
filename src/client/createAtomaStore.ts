import type { CoreStore, StoreHandle } from '#core'
import { Core } from '#core'
import type { AtomaClientContext, AtomaSchema } from './types'

export const createAtomaStore = (ctx: any, options: any) => {
    const dataSource = options.dataSource ?? ctx.defaults.dataSourceFactory(options.name)
    const idGenerator = options.idGenerator ?? ctx.defaults.idGenerator

    const createFromSchema = (schema: any) => {
        const out: Record<string, any> = {}
        for (const k of Object.keys(schema || {})) {
            const def = schema[k]
            if (!def || typeof def !== 'object') continue
            if (def.type === 'belongsTo') {
                out[k] = Core.relations.belongsTo(def.to, {
                    foreignKey: def.foreignKey,
                    primaryKey: def.primaryKey,
                    options: def.options
                })
            } else if (def.type === 'hasMany') {
                out[k] = Core.relations.hasMany(def.to, {
                    primaryKey: def.primaryKey,
                    foreignKey: def.foreignKey,
                    options: def.options
                })
            } else if (def.type === 'hasOne') {
                out[k] = Core.relations.hasOne(def.to, {
                    primaryKey: def.primaryKey,
                    foreignKey: def.foreignKey,
                    options: def.options
                })
            }
        }
        return out
    }

    const relationsFactory = options.relations
        ? () => createFromSchema(options.relations)
        : undefined

    return Core.store.createStore<any, any>({
        ...(options as any),
        name: options.name,
        ...(idGenerator ? { idGenerator } : {}),
        store: ctx.jotaiStore as any,
        dataSource,
        relations: relationsFactory as any,
        resolveStore: ctx.resolveStore as any
    })
}

export function createStoreInstance(args: {
    name: string
    schema: AtomaSchema<any>
    ctx: AtomaClientContext<any, any>
}): { store: CoreStore<any, any>; handle: StoreHandle<any> | null } {
    const name = String(args.name)
    const storeSchema = (args.schema as any)?.[name] ?? {}

    const created = createAtomaStore(args.ctx, { ...(storeSchema as any), name })

    const handle = Core.store.getHandle(created)
    return {
        store: created,
        handle
    }
}
