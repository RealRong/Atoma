/**
 * Atoma（core package）
 *
 * 目标：让主包保持“本地状态库（core + protocol）”的最小心智负担。
 * - client（createClient）改为子入口：`atoma/client`
 * - react hooks 抽离为独立包：`atoma-react`
 */

export { Protocol } from './protocol'

export { Observability } from './observability'
