import * as errors from './errors'
import * as entityId from './entityId'
import * as immer from './immer'
import * as stableKey from './stableKey'
import * as version from './version'
import * as writeOptions from './writeOptions'
export { toError, toErrorWithFallback } from './errors'

export const Shared = {
    errors,
    entityId,
    immer,
    key: stableKey,
    version,
    writeOptions
} as const
