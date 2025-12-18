import type {
    BelongsToConfig,
    Entity,
    HasManyConfig,
    HasOneConfig,
    IAdapter,
    KeySelector,
    RelationIncludeOptions,
    RelationMap,
    InferIncludeType
} from '../core/types'
import { belongsTo as coreBelongsTo, hasMany as coreHasMany, hasOne as coreHasOne } from '../core/relations/builders'
import type { ReactStore, ReactStoreConfig } from './createReactStore'
import { createReactStore } from './createReactStore'
import type { AtomaClientContext, InferRelationsFromStoreOverride } from './createAtomaClient'

type IncludeForRelations<Relations> =
    Partial<{ [K in keyof Relations]: InferIncludeType<Relations[K]> }>

type TargetRelations<
    Entities extends Record<string, Entity>,
    Stores,
    TargetName extends keyof Entities & string
> = InferRelationsFromStoreOverride<Entities, Stores, TargetName>

export type BelongsToSchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'belongsTo'
    to: TargetName
    foreignKey: KeySelector<Entities[SourceName]>
    primaryKey?: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
}

export type HasManySchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'hasMany'
    to: TargetName
    primaryKey?: KeySelector<Entities[SourceName]>
    foreignKey: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
}

export type HasOneSchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'hasOne'
    to: TargetName
    primaryKey?: KeySelector<Entities[SourceName]>
    foreignKey: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
}

export type RelationSchemaItem<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string
> =
    | { [TargetName in keyof Entities & string]: BelongsToSchema<Entities, Stores, SourceName, TargetName> }[keyof Entities & string]
    | { [TargetName in keyof Entities & string]: HasManySchema<Entities, Stores, SourceName, TargetName> }[keyof Entities & string]
    | { [TargetName in keyof Entities & string]: HasOneSchema<Entities, Stores, SourceName, TargetName> }[keyof Entities & string]

export type RelationsSchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string
> = Readonly<Record<string, RelationSchemaItem<Entities, Stores, SourceName>>>

export type RelationMapFromSchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string,
    Schema extends RelationsSchema<Entities, Stores, SourceName>
> = {
    readonly [K in keyof Schema]:
    Schema[K] extends { type: 'belongsTo'; to: infer TargetName }
        ? (TargetName extends keyof Entities & string
            ? BelongsToConfig<Entities[SourceName], Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>
            : never)
        : Schema[K] extends { type: 'hasMany'; to: infer TargetName }
            ? (TargetName extends keyof Entities & string
                ? HasManyConfig<Entities[SourceName], Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>
                : never)
            : Schema[K] extends { type: 'hasOne'; to: infer TargetName }
                ? (TargetName extends keyof Entities & string
                    ? HasOneConfig<Entities[SourceName], Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>
                    : never)
                : never
}

export type RelationsDsl<
    Entities extends Record<string, Entity>,
    Stores,
    TSource extends Entity
> = {
    belongsTo: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            foreignKey: KeySelector<TSource>
            primaryKey?: keyof Entities[TargetName] & string
            options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
        }
    ) => BelongsToConfig<TSource, Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>

    hasMany: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            primaryKey?: KeySelector<TSource>
            foreignKey: keyof Entities[TargetName] & string
            options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
        }
    ) => HasManyConfig<TSource, Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>

    hasOne: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            primaryKey?: KeySelector<TSource>
            foreignKey: keyof Entities[TargetName] & string
            options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
        }
    ) => HasOneConfig<TSource, Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>
}

export type CreateAtomaStoreOptions<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores = {},
    Relations = {}
> = Omit<ReactStoreConfig<Entities[Name]>, 'name' | 'adapter' | 'relations'> & {
    name: Name
    adapter?: IAdapter<Entities[Name]>
    relations?: Relations
}

type CreateAtomaStoreOptionsFactory<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores,
    Relations extends RelationMap<Entities[Name]>
> = Omit<ReactStoreConfig<Entities[Name]>, 'name' | 'adapter' | 'relations'> & {
    name: Name
    adapter?: IAdapter<Entities[Name]>
    relations?: (dsl: RelationsDsl<Entities, Stores, Entities[Name]>) => Relations
}

type CreateAtomaStoreOptionsSchema<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores,
    Schema extends RelationsSchema<Entities, Stores, Name>
> = Omit<ReactStoreConfig<Entities[Name]>, 'name' | 'adapter' | 'relations'> & {
    name: Name
    adapter?: IAdapter<Entities[Name]>
    relations?: Schema
}

export function createAtomaStore<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores,
    const Schema extends RelationsSchema<Entities, Stores, Name> = {}
>(
    ctx: AtomaClientContext<Entities, Stores>,
    options: CreateAtomaStoreOptionsSchema<Entities, Name, Stores, Schema>
): ReactStore<Entities[Name], RelationMapFromSchema<Entities, Stores, Name, Schema>>

export function createAtomaStore<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores,
    const Relations extends RelationMap<Entities[Name]> = {}
>(
    ctx: AtomaClientContext<Entities, Stores>,
    options: CreateAtomaStoreOptionsFactory<Entities, Name, Stores, Relations>
): ReactStore<Entities[Name], Relations>

export function createAtomaStore<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores
>(
    ctx: AtomaClientContext<Entities, Stores>,
    options: CreateAtomaStoreOptions<Entities, Name, Stores, any>
): ReactStore<Entities[Name], any> {
    const adapter = (options.adapter ?? ctx.defaultAdapterFactory(options.name)) as IAdapter<Entities[Name]>

    const createFromDsl = (factory: any) =>
        factory({
            belongsTo: (name: any, config: any) => coreBelongsTo(ctx.getStoreRef(name), config),
            hasMany: (name: any, config: any) => coreHasMany(ctx.getStoreRef(name), config),
            hasOne: (name: any, config: any) => coreHasOne(ctx.getStoreRef(name), config)
        })

    const createFromSchema = (schema: any) => {
        const out: Record<string, any> = {}
        for (const k of Object.keys(schema || {})) {
            const def = schema[k]
            if (!def || typeof def !== 'object') continue
            if (def.type === 'belongsTo') {
                out[k] = coreBelongsTo(ctx.getStoreRef(def.to), {
                    foreignKey: def.foreignKey,
                    primaryKey: def.primaryKey,
                    options: def.options
                })
            } else if (def.type === 'hasMany') {
                out[k] = coreHasMany(ctx.getStoreRef(def.to), {
                    primaryKey: def.primaryKey,
                    foreignKey: def.foreignKey,
                    options: def.options
                })
            } else if (def.type === 'hasOne') {
                out[k] = coreHasOne(ctx.getStoreRef(def.to), {
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

    return createReactStore<Entities[Name], any>({
        ...(options as any),
        name: options.name,
        adapter,
        relations: relationsFactory as any
    })
}
