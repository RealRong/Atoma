import { envelope } from '../core/envelope'
import { encodeWriteIntent } from './encodeWrite'
import { ensureWriteItemMeta, newWriteItemMeta } from './meta'
import { assertOpsRequestV1, assertOperationV1, assertOutgoingOpsV1 } from './validate'

export const ops = {
    parse: {
        envelope: envelope.parse.envelope
    },
    compose: {
        ok: envelope.compose.ok,
        error: envelope.compose.error
    },
    encodeWriteIntent,
    meta: {
        ensureWriteItemMeta,
        newWriteItemMeta
    },
    validate: {
        assertOpsRequestV1,
        assertOperationV1,
        assertOutgoingOpsV1
    }
} as const

export type {
    OperationKind,
    Operation,
    QueryOp,
    WriteOp,
    WriteAction,
    WriteItem,
    WriteItemMeta,
    WriteOptions,
    ChangesPullOp,
    OperationResult,
    OpsRequest,
    OpsResponseData,
    QueryResultData,
    WriteItemResult,
    WriteResultData,
    ChangesPullResultData
} from './types'

export type { WriteIntent } from './encodeWrite'
