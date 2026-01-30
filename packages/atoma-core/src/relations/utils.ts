import type { EntityId } from 'atoma-protocol'

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
export function normalizeKey(key: EntityId): string {
    return key
}
