import { WhereOperator, StoreKey } from '../types'

/**
 * 深合并 where 条件（AND 逻辑，简单覆盖同名操作符）
 */
export function deepMergeWhere<T>(
    base?: WhereOperator<T>,
    override?: WhereOperator<T>
): WhereOperator<T> | undefined {
    if (!base) return override
    if (!override) return base

    const result: any = { ...base }

    Object.entries(override).forEach(([key, value]) => {
        if (key in result && isPlainObject(result[key]) && isPlainObject(value)) {
            result[key] = { ...result[key], ...value }
        } else {
            result[key] = value
        }
    })

    return result
}

const isPlainObject = (val: any): val is Record<string, any> => {
    return val !== null && typeof val === 'object' && !Array.isArray(val)
}

/**
 * 从对象提取点路径字段值
 */
export function getValueByPath(obj: any, path: string): any {
    if (!path.includes('.')) return obj?.[path]
    return path.split('.').reduce((acc, key) => acc?.[key], obj)
}

/**
 * 将键标准化为字符串（用于 Map key）
 */
export function normalizeKey(key: StoreKey): string {
    return String(key)
}

