import { belongsTo, hasMany, hasOne } from 'atoma-core/relations'
import { isRecord } from 'atoma-shared'
import type { Entity, KeySelector, RelationMap } from 'atoma-types/core'

type RelationType = 'belongsTo' | 'hasMany' | 'hasOne'
type SourceShape = Record<string, unknown>

function ensureRecord(value: unknown, path: string, message = 'must be an object'): Record<string, unknown> {
    if (!isRecord(value)) {
        throw new Error(`[Atoma] ${path} ${message}`)
    }
    return value
}

function ensureType(value: unknown, path: string): RelationType {
    if (value === 'belongsTo' || value === 'hasMany' || value === 'hasOne') {
        return value
    }
    throw new Error(`[Atoma] ${path}.type is invalid: ${String(value)}`)
}

function ensureStore(value: unknown, path: string): string {
    if (typeof value === 'string' && value.trim()) {
        return value
    }
    throw new Error(`[Atoma] ${path}.to must be a non-empty string`)
}

function ensureOptions(value: unknown, path: string): Record<string, unknown> | undefined {
    if (value === undefined) return undefined
    return ensureRecord(value, path, 'must be an object when provided')
}

function ensureSelector(
    value: unknown,
    path: string,
    field: 'foreignKey' | 'primaryKey'
): KeySelector<SourceShape> {
    if (typeof value === 'function') {
        return value as KeySelector<SourceShape>
    }
    if (typeof value === 'string' && value.trim()) {
        return value
    }
    throw new Error(`[Atoma] ${path}.${field} must be a non-empty string or function`)
}

function ensureField(
    value: unknown,
    path: string,
    field: 'foreignKey' | 'primaryKey'
): keyof Entity & string {
    if (typeof value === 'string' && value.trim()) {
        return value as keyof Entity & string
    }
    throw new Error(`[Atoma] ${path}.${field} must be a non-empty string`)
}

export function compile<T extends Entity = Entity>(relationsRaw: unknown, storeName: string): RelationMap<T> {
    if (relationsRaw === undefined || relationsRaw === null) {
        return {} as RelationMap<T>
    }

    const schema = ensureRecord(relationsRaw, `schema.${storeName}.relations`)
    const relations: Record<string, unknown> = {}

    Object.entries(schema).forEach(([relationName, raw]) => {
        const path = `schema.${storeName}.relations.${relationName}`
        const def = ensureRecord(raw, path)
        const type = ensureType(def.type, path)
        const to = ensureStore(def.to, path)
        const options = ensureOptions(def.options, `${path}.options`)

        if (type === 'belongsTo') {
            relations[relationName] = belongsTo<SourceShape, Entity>(to, {
                foreignKey: ensureSelector(def.foreignKey, path, 'foreignKey'),
                primaryKey: def.primaryKey === undefined
                    ? undefined
                    : ensureField(def.primaryKey, path, 'primaryKey'),
                options: options as never
            })
            return
        }

        const primaryKey = def.primaryKey === undefined
            ? undefined
            : ensureSelector(def.primaryKey, path, 'primaryKey')
        const foreignKey = ensureField(def.foreignKey, path, 'foreignKey')

        relations[relationName] = type === 'hasMany'
            ? hasMany<SourceShape, Entity>(to, {
                primaryKey,
                foreignKey,
                options: options as never
            })
            : hasOne<SourceShape, Entity>(to, {
                primaryKey,
                foreignKey,
                options: options as never
            })
    })

    return relations as RelationMap<T>
}
