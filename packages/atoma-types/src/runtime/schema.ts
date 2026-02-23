import type {
    Entity,
    KeySelector,
    RelationIncludeOptions,
    StoreProcessor,
    StoreConfig
} from '../core'
import type { EntityId } from '../shared'

type BelongsToSchema<T extends Entity = Entity> = Readonly<{
    type: 'belongsTo'
    to: string
    foreignKey: KeySelector<T>
    primaryKey?: string
    options?: RelationIncludeOptions<Entity, Record<string, unknown>>
}>

type HasManySchema<T extends Entity = Entity> = Readonly<{
    type: 'hasMany'
    to: string
    primaryKey?: KeySelector<T>
    foreignKey: string
    options?: RelationIncludeOptions<Entity, Record<string, unknown>>
}>

type HasOneSchema<T extends Entity = Entity> = Readonly<{
    type: 'hasOne'
    to: string
    primaryKey?: KeySelector<T>
    foreignKey: string
    options?: RelationIncludeOptions<Entity, Record<string, unknown>>
}>

type RelationSchema<T extends Entity = Entity> =
    | BelongsToSchema<T>
    | HasManySchema<T>
    | HasOneSchema<T>

export type StoreSchema<T extends Entity = Entity> = {
    relations?: Readonly<Record<string, RelationSchema<T>>>
    [key: string]: unknown
} & Partial<Pick<StoreConfig<T>, 'indexes' | 'createId' | 'processor'>>

export type Schema<
    Entities extends Record<string, Entity> = Record<string, Entity>
> = Readonly<Partial<{ [Name in keyof Entities & string]: StoreSchema<Entities[Name]> }>>

export type StoresConfig<
    Entities extends Record<string, Entity> = Record<string, Entity>,
    StoresSchema extends object = Schema<Entities>
> = Readonly<{
    schema?: StoresSchema
    createId?: () => EntityId
    processor?: StoreProcessor<Entity>
}>
