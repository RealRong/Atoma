import type {
    BelongsToConfig,
    Entity,
    HasManyConfig,
    HasOneConfig,
    KeySelector,
    RelationIncludeOptions,
} from '#core'
import type { AtomaSchema } from './schema'

export type InferRelationsFromSchema<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities>,
    Name extends keyof Entities & string
> = Schema[Name] extends { relations?: infer R }
    ? NonNullable<R> extends RelationsSchema<Entities, Name>
        ? RelationMapFromSchema<Entities, Name, NonNullable<R>>
        : {}
    : {}

export type BelongsToSchema<
    Entities extends Record<string, Entity>,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'belongsTo'
    to: TargetName
    foreignKey: KeySelector<Entities[SourceName]>
    primaryKey?: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], any>
}

export type HasManySchema<
    Entities extends Record<string, Entity>,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'hasMany'
    to: TargetName
    primaryKey?: KeySelector<Entities[SourceName]>
    foreignKey: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], any>
}

export type HasOneSchema<
    Entities extends Record<string, Entity>,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'hasOne'
    to: TargetName
    primaryKey?: KeySelector<Entities[SourceName]>
    foreignKey: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], any>
}

export type RelationSchemaItem<
    Entities extends Record<string, Entity>,
    SourceName extends keyof Entities & string
> =
    | { [TargetName in keyof Entities & string]: BelongsToSchema<Entities, SourceName, TargetName> }[keyof Entities & string]
    | { [TargetName in keyof Entities & string]: HasManySchema<Entities, SourceName, TargetName> }[keyof Entities & string]
    | { [TargetName in keyof Entities & string]: HasOneSchema<Entities, SourceName, TargetName> }[keyof Entities & string]

export type RelationsSchema<
    Entities extends Record<string, Entity>,
    SourceName extends keyof Entities & string
> = Readonly<Record<string, RelationSchemaItem<Entities, SourceName>>>

export type RelationMapFromSchema<
    Entities extends Record<string, Entity>,
    SourceName extends keyof Entities & string,
    Schema extends RelationsSchema<Entities, SourceName>
> = {
        readonly [K in keyof Schema]:
        Schema[K] extends { type: 'belongsTo'; to: infer TargetName }
        ? (TargetName extends keyof Entities & string
            ? BelongsToConfig<Entities[SourceName], Entities[TargetName], any>
            : never)
        : Schema[K] extends { type: 'hasMany'; to: infer TargetName }
        ? (TargetName extends keyof Entities & string
            ? HasManyConfig<Entities[SourceName], Entities[TargetName], any>
            : never)
        : Schema[K] extends { type: 'hasOne'; to: infer TargetName }
        ? (TargetName extends keyof Entities & string
            ? HasOneConfig<Entities[SourceName], Entities[TargetName], any>
            : never)
        : never
    }
