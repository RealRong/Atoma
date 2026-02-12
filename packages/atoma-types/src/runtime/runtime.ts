import type { StoreToken } from '../core'
import type { Engine } from './engine/api'
import type { Debug } from './debug'
import type { HookRegistry } from './hooks'
import type { Read } from './read'
import type { StoreCatalog } from './storeCatalog'
import type { StrategyRegistry } from './strategy'
import type { Transform } from './transform'
import type { Write } from './write'

export type Runtime = Readonly<{
    id: string
    now: () => number
    nextOpId: (storeName: StoreToken, prefix: 'q' | 'w') => string
    stores: StoreCatalog
    hooks: HookRegistry
    read: Read
    write: Write
    strategy: StrategyRegistry
    transform: Transform
    engine: Engine
    debug: Debug
}>
