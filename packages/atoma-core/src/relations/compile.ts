import type { Entity, KeySelector } from 'atoma-types/core'
import { belongsTo, hasMany, hasOne } from './builders'

type GenericRelationMap = Record<string, unknown>

function ensureRelationObject(def: unknown, path: string): Record<string, unknown> {
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
        throw new Error(`[Atoma] ${path} must be an object`)
    }
    return def as Record<string, unknown>
}

function ensureStoreToken(to: unknown, path: string): string {
    if (typeof to !== 'string' || !to.trim()) {
        throw new Error(`[Atoma] ${path}.to must be a non-empty string`)
    }
    return to
}

function ensureOptionalObject(value: unknown, path: string): Record<string, unknown> | undefined {
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`[Atoma] ${path} must be an object when provided`)
    }
    return value as Record<string, unknown>
}

function ensureBelongsToForeignKey(value: unknown, path: string): KeySelector<Record<string, unknown>> {
    const isString = typeof value === 'string' && value.length > 0
    if (isString || typeof value === 'function') {
        return value as KeySelector<Record<string, unknown>>
    }
    throw new Error(`[Atoma] ${path}.foreignKey must be a non-empty string or function`)
}

function ensureHasForeignKey(value: unknown, path: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`[Atoma] ${path}.foreignKey must be a non-empty string`)
    }
    return value
}

function ensureOptionalPrimaryKey(value: unknown, path: string): KeySelector<Record<string, unknown>> | undefined {
    if (value === undefined) return undefined
    const isString = typeof value === 'string' && value.length > 0
    if (isString || typeof value === 'function') {
        return value as KeySelector<Record<string, unknown>>
    }
    throw new Error(`[Atoma] ${path}.primaryKey must be a non-empty string or function`)
}

function ensureOptionalBelongsToPrimaryKey(value: unknown, path: string): keyof Entity & string | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`[Atoma] ${path}.primaryKey must be a non-empty string`)
    }
    return value as keyof Entity & string
}

export function compileRelationsMap(relationsRaw: unknown, storeName: string): GenericRelationMap {
    const relations: GenericRelationMap = {}
    if (!relationsRaw || typeof relationsRaw !== 'object' || Array.isArray(relationsRaw)) return relations

    const schema = relationsRaw as Record<string, unknown>

    for (const relationName of Object.keys(schema)) {
        const path = `schema.${storeName}.relations.${String(relationName)}`
        const def = ensureRelationObject(schema[relationName], path)

        const type = def.type
        const to = ensureStoreToken(def.to, path)
        const options = ensureOptionalObject(def.options, `${path}.options`)

        if (type === 'belongsTo') {
            relations[relationName] = belongsTo<Record<string, unknown>, Entity>(to, {
                foreignKey: ensureBelongsToForeignKey(def.foreignKey, path),
                primaryKey: ensureOptionalBelongsToPrimaryKey(def.primaryKey, path),
                options: options as never
            })
            continue
        }

        if (type === 'hasMany') {
            relations[relationName] = hasMany<Record<string, unknown>, Entity>(to, {
                primaryKey: ensureOptionalPrimaryKey(def.primaryKey, path),
                foreignKey: ensureHasForeignKey(def.foreignKey, path) as keyof Entity & string,
                options: options as never
            })
            continue
        }

        if (type === 'hasOne') {
            relations[relationName] = hasOne<Record<string, unknown>, Entity>(to, {
                primaryKey: ensureOptionalPrimaryKey(def.primaryKey, path),
                foreignKey: ensureHasForeignKey(def.foreignKey, path) as keyof Entity & string,
                options: options as never
            })
            continue
        }

        throw new Error(`[Atoma] ${path}.type is invalid: ${String(type)}`)
    }

    return relations
}
