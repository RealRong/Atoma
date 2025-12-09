import { BelongsToConfig, Entity, FindManyOptions, HasManyConfig, HasOneConfig, IStore, KeySelector, VariantsConfig, VariantBranch } from '../types'

export function belongsTo<TSource, TTarget extends Entity>(
    store: IStore<TTarget, any>,
    config: {
        foreignKey: KeySelector<TSource>
        primaryKey?: keyof TTarget & string
        options?: FindManyOptions<TTarget>
    }
): BelongsToConfig<TSource, TTarget> {
    return {
        type: 'belongsTo',
        store,
        foreignKey: config.foreignKey,
        primaryKey: (config.primaryKey || 'id') as keyof TTarget & string,
        options: config.options
    }
}

export function hasMany<TSource, TTarget extends Entity>(
    store: IStore<TTarget, any>,
    config: {
        primaryKey?: KeySelector<TSource>
        foreignKey: keyof TTarget & string
        options?: FindManyOptions<TTarget>
    }
): HasManyConfig<TSource, TTarget> {
    return {
        type: 'hasMany',
        store,
        primaryKey: config.primaryKey || 'id',
        foreignKey: config.foreignKey,
        options: config.options
    }
}

export function hasOne<TSource, TTarget extends Entity>(
    store: IStore<TTarget, any>,
    config: {
        primaryKey?: KeySelector<TSource>
        foreignKey: keyof TTarget & string
        options?: FindManyOptions<TTarget>
    }
): HasOneConfig<TSource, TTarget> {
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
