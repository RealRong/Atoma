import type {
    BelongsToConfig,
    Entity,
    HasManyConfig,
    HasOneConfig,
    InferIncludeType,
    IStore,
    KeySelector,
    RelationIncludeOptions,
    RelationMap,
    StoreConfig
} from '#core'

type IncludeForRelations<Relations> =
    Partial<{ [K in keyof Relations]: InferIncludeType<Relations[K]> }>

export type InferRelationsFromStoreOverride<
    Entities extends Record<string, Entity>,
    Stores,
    Name extends keyof Entities & string
> = Name extends keyof Stores
    ? Stores[Name] extends (ctx: any) => infer R
        ? R extends IStore<Entities[Name], infer Relations>
            ? Relations
            : {}
        : Stores[Name] extends { relations?: infer Relations }
            ? Relations extends (...args: any[]) => infer R2
                ? (R2 extends RelationMap<Entities[Name]> ? R2 : {})
                : Relations extends RelationsSchema<Entities, Stores, Name>
                    ? RelationMapFromSchema<Entities, Stores, Name, Relations>
                    : Relations extends RelationMap<Entities[Name]>
                        ? Relations
                        : {}
            : {}
    : {}

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

export type RelationsDslForConstraint<
    Entities extends Record<string, Entity>,
    TSource extends Entity
> = {
    belongsTo: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            foreignKey: KeySelector<TSource>
            primaryKey?: keyof Entities[TargetName] & string
            options?: any
        }
    ) => BelongsToConfig<TSource, Entities[TargetName], any>

    hasMany: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            primaryKey?: KeySelector<TSource>
            foreignKey: keyof Entities[TargetName] & string
            options?: any
        }
    ) => HasManyConfig<TSource, Entities[TargetName], any>

    hasOne: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            primaryKey?: KeySelector<TSource>
            foreignKey: keyof Entities[TargetName] & string
            options?: any
        }
    ) => HasOneConfig<TSource, Entities[TargetName], any>
}

export type StoreOverrideConstraint<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string
> =
    | ((ctx: any) => any)
    | (Partial<StoreConfig<Entities[Name]>> & {
        relations?: unknown | ((dsl: RelationsDslForConstraint<Entities, Entities[Name]>) => unknown)
    })

