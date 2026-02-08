type RelationLike = {
    type: 'belongsTo' | 'hasMany' | 'hasOne' | 'variants'
}

export function getRelationDefaultValue(config: RelationLike | undefined): null | [] {
    if (!config) return null
    if (config.type === 'hasMany') return []
    return null
}
