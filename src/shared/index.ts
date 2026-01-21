import * as errors from './errors'
import * as entityId from './entityId'
import * as immer from './immer'
import * as stableKey from './stableKey'
import * as url from './url'
import * as version from './version'
import * as writeOptions from './writeOptions'
import * as zod from './zod'
export { toError, toErrorWithFallback } from './errors'

export const Shared = {
    errors,
    entityId,
    immer,
    key: stableKey,
    url,
    version,
    writeOptions,
    zod
} as const
