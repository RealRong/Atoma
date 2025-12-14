export function normalizeFindManyResult<T>(res: any): { data: T[]; pageInfo?: any; explain?: any } {
    if (res && typeof res === 'object' && !Array.isArray(res)) {
        if (Array.isArray((res as any).data)) {
            return { data: (res as any).data, pageInfo: (res as any).pageInfo, explain: (res as any).explain }
        }
    }
    if (Array.isArray(res)) return { data: res }
    return { data: [] }
}

