import type { Query } from '../../types'

/**
 * 保留空壳以避免旧路径引用报错。
 * 新查询协议直接使用 Query 结构。
 */
export function normalizeAtomaServerQueryParams<T>(input: Query<T> | undefined): Query | undefined {
    return input
}
