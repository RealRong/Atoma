import * as entityId from './entityId'
import * as immer from './immer'
import * as stableKey from './stableKey'
import * as version from './version'
import * as writeOptions from './writeOptions'

export const Shared = {
    entityId,
    immer,
    key: stableKey,
    version,
    writeOptions
} as const

