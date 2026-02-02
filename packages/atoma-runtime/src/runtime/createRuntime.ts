import type { CoreRuntime } from '../types/runtimeTypes'
import { Runtime, type RuntimeConfig } from './Runtime'

export function createRuntime(config: RuntimeConfig): CoreRuntime {
    return new Runtime(config)
}
