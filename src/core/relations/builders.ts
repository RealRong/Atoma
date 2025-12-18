import type { BelongsToConfig, Entity, HasManyConfig, HasOneConfig, IStore, KeySelector, RelationIncludeOptions, RelationMap, InferIncludeType, VariantsConfig, VariantBranch } from '../types'

type IncludeForRelations<Relations extends RelationMap<any>> =
    Partial<{ [K in keyof Relations]: InferIncludeType<Relations[K]> }>

export function belongsTo<TSource, TTarget extends Entity, TTargetRelations extends RelationMap<TTarget> = {}>(
    store: IStore<TTarget, TTargetRelations>,
    config: {
        foreignKey: KeySelector<TSource>
        primaryKey?: keyof TTarget & string
        options?: RelationIncludeOptions<TTarget, IncludeForRelations<TTargetRelations>>
    }
): BelongsToConfig<TSource, TTarget, TTargetRelations> {
    return {
        type: 'belongsTo',
        store,
        foreignKey: config.foreignKey,
        primaryKey: (config.primaryKey || 'id') as keyof TTarget & string,
        options: config.options
    }
}

export function hasMany<TSource, TTarget extends Entity, TTargetRelations extends RelationMap<TTarget> = {}>(
    store: IStore<TTarget, TTargetRelations>,
    config: {
        primaryKey?: KeySelector<TSource>
        foreignKey: keyof TTarget & string
        options?: RelationIncludeOptions<TTarget, IncludeForRelations<TTargetRelations>>
    }
): HasManyConfig<TSource, TTarget, TTargetRelations> {
    return {
        type: 'hasMany',
        store,
        primaryKey: config.primaryKey || 'id',
        foreignKey: config.foreignKey,
        options: config.options
    }
}

export function hasOne<TSource, TTarget extends Entity, TTargetRelations extends RelationMap<TTarget> = {}>(
    store: IStore<TTarget, TTargetRelations>,
    config: {
        primaryKey?: KeySelector<TSource>
        foreignKey: keyof TTarget & string
        options?: RelationIncludeOptions<TTarget, IncludeForRelations<TTargetRelations>>
    }
): HasOneConfig<TSource, TTarget, TTargetRelations> {
    return {
        type: 'hasOne',
        store,
        primaryKey: config.primaryKey || 'id',
        foreignKey: config.foreignKey,
        options: config.options
    }
}

export function variants<TSource>(branches: Array<VariantBranch<TSource, any>>): VariantsConfig<TSource> {
    return {
        type: 'variants',
        branches
    }
}
