import type { CoreStore, StoreHandle } from '#core'
import { Core } from '#core'
import type { AtomaClientContext, CreateAtomaStore, StoresConstraint } from './types'

export const createAtomaStore = ((ctx: any, options: any) => {
    const adapter = options.adapter ?? ctx.defaultAdapterFactory(options.name)

    const createFromDsl = (factory: any) =>
        factory({
            belongsTo: (name: any, config: any) => Core.relations.belongsTo(name, config),
            hasMany: (name: any, config: any) => Core.relations.hasMany(name, config),
            hasOne: (name: any, config: any) => Core.relations.hasOne(name, config)
        })

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
        ? () => typeof options.relations === 'function'
            ? createFromDsl(options.relations)
            : createFromSchema(options.relations)
        : undefined

    return Core.store.createCoreStore<any, any>({
        ...(options as any),
        name: options.name,
        store: ctx.jotaiStore as any,
        adapter,
        relations: relationsFactory as any,
        resolveStore: ctx.resolveStore as any
    })
}) as CreateAtomaStore

export function createStoreInstance(args: {
    name: string
    stores: StoresConstraint<any>
    ctx: AtomaClientContext<any, any>
}): { store: CoreStore<any, any>; handle: StoreHandle<any> | null } {
    const name = String(args.name)
    const override = args.stores?.[name]

    const created = (() => {
        if (!override) return createAtomaStore(args.ctx, { name })
        if (typeof override === 'function') return override(args.ctx)
        if (typeof (override as any)?.name === 'string' && (override as any).name !== name) {
            throw new Error(`[Atoma] defineStores(...).defineClient: stores["${String(name)}"].name 不一致（收到 "${String((override as any).name)}"）`)
        }
        return createAtomaStore(args.ctx, { ...(override as any), name })
    })()

    const handle = Core.store.getHandle(created)
    return {
        store: created,
        handle
    }
}

export type {
    BelongsToSchema,
    CreateAtomaStoreOptions,
    HasManySchema,
    HasOneSchema,
    RelationMapFromSchema,
    RelationSchemaItem,
    RelationsDsl,
    RelationsSchema
} from './types'
