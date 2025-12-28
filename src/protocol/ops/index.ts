import { envelope } from '../envelope'
import { encodeWriteIntent } from './encodeWrite'

export const ops = {
    parse: {
        envelope: envelope.parse.envelope
    },
    compose: {
        ok: envelope.compose.ok,
        error: envelope.compose.error
    },
    encodeWriteIntent
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

export { encodeWriteIntent }
