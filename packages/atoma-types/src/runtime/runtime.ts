import type { Engine } from './engine/api'
import type { Debug } from './debug'
import type { StoreEventBus } from './store/events'
import type { Read } from './read'
import type { StoreCatalog } from './store/catalog'
import type { ExecutionKernel } from './execution'
import type { Processor } from './processor'
import type { Write } from './write'

export type Runtime = Readonly<{
    id: string
    now: () => number
    stores: StoreCatalog
    events: StoreEventBus
    execution: ExecutionKernel
    read: Read
    write: Write
    processor: Processor
    engine: Engine
    debug: Debug
}>
