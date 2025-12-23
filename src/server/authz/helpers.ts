import { throwError } from '../error'

export function allowOnlyFields(allowed: string[], changedFields: string[]) {
    const allow = new Set(allowed)
    for (const field of changedFields) {
        if (!allow.has(field)) {
            throwError('ACCESS_DENIED', `Field write not allowed: ${field}`, {
                kind: 'auth',
                field
            })
        }
    }
}
