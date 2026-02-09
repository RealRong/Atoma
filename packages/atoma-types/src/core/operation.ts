/**
 * OperationContext：一次写入/一次动作的上下文载体（面向上层语义）
 * - scope 用于分区（history/batch/devtools 等）
 * - origin 用于区分来源（决定是否进入 history）
 * - actionId 用于将多个写入聚合为一次“用户动作”（撤销单位）
 */
export type OperationOrigin = 'user' | 'history' | 'sync' | 'system'

export type OperationContext = Readonly<{
    scope: string
    actionId: string
    origin: OperationOrigin
    label?: string
    timestamp: number
}>
