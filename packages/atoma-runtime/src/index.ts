import { enablePatches } from 'immer'

enablePatches()

export { Runtime } from './runtime/Runtime'
export type { Options } from './runtime/Runtime'
export { ExecutionKernel } from './execution/ExecutionKernel'
