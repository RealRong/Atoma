import type { Entity, KeySelector } from './entity'
import type { Query } from './query'
import type { StoreToken } from './store'

export type RelationType = 'belongsTo' | 'hasMany' | 'hasOne' | 'variants'

export type RelationIncludePage = {
    limit?: number
}

// Relations include 专用（仅支持 Top-N 预览，不含 offset/cursor 分页）
export type RelationIncludeOptions<T, Include extends Record<string, unknown> = Record<string, unknown>> = Pick<Query<T>, 'filter' | 'sort'> & {
    page?: RelationIncludePage
    include?: Include
    /** live=true 订阅子 store 实时变化；false 则使用快照（默认 true） */
    live?: boolean
    /** 关系预取策略（默认：belongsTo/hasOne 为 on-change，hasMany 为 on-mount） */
    prefetch?: 'on-mount' | 'on-change' | 'manual'
}

export interface BelongsToConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'belongsTo'
    store: StoreToken
    foreignKey: KeySelector<TSource>
    primaryKey?: keyof TTarget & string
    options?: RelationIncludeOptions<TTarget, Partial<{ [K in keyof TTargetRelations]: InferIncludeType<TTargetRelations[K]> }>>
}

export interface HasManyConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'hasMany'
    store: StoreToken
    primaryKey?: KeySelector<TSource>
    foreignKey: keyof TTarget & string
    options?: RelationIncludeOptions<TTarget, Partial<{ [K in keyof TTargetRelations]: InferIncludeType<TTargetRelations[K]> }>>
}

export interface HasOneConfig<TSource, TTarget extends Entity, TTargetRelations = {}> {
    type: 'hasOne'
    store: StoreToken
    primaryKey?: KeySelector<TSource>
    foreignKey: keyof TTarget & string
    options?: RelationIncludeOptions<TTarget, Partial<{ [K in keyof TTargetRelations]: InferIncludeType<TTargetRelations[K]> }>>
}

export interface VariantsConfig<TSource> {
    type: 'variants'
    branches: Array<VariantBranch<TSource, Entity>>
}

export interface VariantBranch<TSource, TTarget extends Entity> {
    when: (item: TSource) => boolean
    relation: BelongsToConfig<TSource, TTarget> | HasManyConfig<TSource, TTarget> | HasOneConfig<TSource, TTarget>
}

export type RelationConfig<TSource, TTarget extends Entity = Entity> =
    | BelongsToConfig<TSource, TTarget>
    | HasManyConfig<TSource, TTarget>
    | HasOneConfig<TSource, TTarget>
    | VariantsConfig<TSource>

export type RelationMap<T> = Readonly<Record<string, RelationConfig<T, Entity>>>

// 根据关系类型推导 include 的取值类型
export type InferIncludeType<R> =
    R extends BelongsToConfig<unknown, infer TTarget, infer TR> ? boolean | RelationIncludeOptions<TTarget, Partial<{ [K in keyof TR]: InferIncludeType<TR[K]> }>>
    : R extends HasManyConfig<unknown, infer TTarget, infer TR> ? boolean | RelationIncludeOptions<TTarget, Partial<{ [K in keyof TR]: InferIncludeType<TR[K]> }>>
    : R extends HasOneConfig<unknown, infer TTarget, infer TR> ? boolean | RelationIncludeOptions<TTarget, Partial<{ [K in keyof TR]: InferIncludeType<TR[K]> }>>
    : never

export type WithRelations<
    T,
    Relations,
    Include extends Record<string, unknown>
> = T & {
    [K in keyof Include as Include[K] extends false | undefined ? never : K]: K extends keyof Relations
    ? Include[K] extends true | object
    ? InferRelationResultType<Relations[K], Include[K]>
    : never
    : unknown
}

export type RelationIncludeInput<Relations> =
    keyof Relations extends never
    ? Partial<Record<string, boolean | RelationIncludeOptions<Entity, Record<string, unknown>>>>
    : string extends keyof Relations
    ? Partial<Record<string, boolean | RelationIncludeOptions<Entity, Record<string, unknown>>>>
    : Partial<{ [K in keyof Relations]: InferIncludeType<Relations[K]> }>

type InferStoreRelations<R> =
    R extends BelongsToConfig<unknown, Entity, infer TR> ? TR
    : R extends HasManyConfig<unknown, Entity, infer TR> ? TR
    : R extends HasOneConfig<unknown, Entity, infer TR> ? TR
    : {}

type InferIncludeForRelations<Relations> =
    Partial<{ [K in keyof Relations]: InferIncludeType<Relations[K]> }>

type ApplyIncludeToTarget<
    TTarget,
    TTargetRelations,
    Opt
> = Opt extends { include?: infer Nested }
    ? Nested extends InferIncludeForRelations<TTargetRelations>
    ? WithRelations<TTarget, TTargetRelations, Nested>
    : WithRelations<TTarget, TTargetRelations, InferIncludeForRelations<TTargetRelations>>
    : TTarget

type InferRelationResultType<R, Opt> =
    0 extends (1 & R) ? unknown :
    R extends HasManyConfig<unknown, infer TTarget, unknown>
    ? ApplyIncludeToTarget<TTarget, InferStoreRelations<R>, Opt>[]
    : R extends BelongsToConfig<unknown, infer TTarget, unknown>
    ? ApplyIncludeToTarget<TTarget, InferStoreRelations<R>, Opt> | null
    : R extends HasOneConfig<unknown, infer TTarget, unknown>
    ? ApplyIncludeToTarget<TTarget, InferStoreRelations<R>, Opt> | null
    : R extends VariantsConfig<unknown> ? unknown | null
    : never
