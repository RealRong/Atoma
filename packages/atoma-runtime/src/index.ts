import { enablePatches } from 'immer'

enablePatches()

export { Runtime } from './runtime'
export type { Options } from './runtime'
export { ExecutionKernel } from './execution/kernel/ExecutionKernel'
