import { BatchEngine, type BatchEngineConfig } from './BatchEngine'

export const Batch: { create: (config: BatchEngineConfig) => BatchEngine } = {
    create: (config: BatchEngineConfig) => new BatchEngine(config)
}

export type { BatchEngine, BatchEngineConfig } from './BatchEngine'
