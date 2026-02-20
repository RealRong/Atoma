import type { Engine } from './engine/api'
import type { Debug } from './debug'
import type { StoreEventRegistry } from './store/events'
import type { Read } from './read'
import type { StoreCatalog } from './store/catalog'
import type { ExecutionKernel } from './execution'
import type { Transform } from './transform'
import type { Write } from './write'

export type Runtime = Readonly<{
    id: string
    now: () => number
    stores: StoreCatalog
    events: StoreEventRegistry
    execution: ExecutionKernel
    read: Read
    write: Write
    transform: Transform
    engine: Engine
    debug: Debug
}>
