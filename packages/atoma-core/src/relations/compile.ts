import { belongsTo, hasMany, hasOne } from './builders'

export function compileRelationsMap(relationsRaw: unknown, storeName: string): Record<string, any> {
    const relations: Record<string, any> = {}
    const schema = relationsRaw as any
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return relations

    for (const k of Object.keys(schema)) {
        const def = schema[k]
        if (!def || typeof def !== 'object') continue

        const type = (def as any).type
        const to = (def as any).to

        if (type === 'belongsTo') {
            relations[k] = belongsTo(String(to), {
                foreignKey: (def as any).foreignKey,
                primaryKey: (def as any).primaryKey,
                options: (def as any).options
            })
            continue
        }

        if (type === 'hasMany') {
            relations[k] = hasMany(String(to), {
                primaryKey: (def as any).primaryKey,
                foreignKey: (def as any).foreignKey as any,
                options: (def as any).options
            })
            continue
        }

        if (type === 'hasOne') {
            relations[k] = hasOne(String(to), {
                primaryKey: (def as any).primaryKey,
                foreignKey: (def as any).foreignKey as any,
                options: (def as any).options
            })
            continue
        }

        throw new Error(`[Atoma] schema.${storeName}.relations.${String(k)}.type is invalid: ${String(type)}`)
    }

    return relations
}
