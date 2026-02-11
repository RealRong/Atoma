import type { ResourceToken } from './scalars'

export type NotifyMessage = {
    resources?: ResourceToken[]
    traceId?: string
}
