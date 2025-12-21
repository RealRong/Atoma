import * as vnextCompose from './compose'
import { parseEnvelope } from './parse'

export const vnext = {
    parse: {
        envelope: parseEnvelope
    },
    compose: {
        ok: vnextCompose.ok,
        error: vnextCompose.error
    }
} as const

export type { EntityId, Cursor, Version } from './scalars'
export type { Meta } from './meta'
export type { ErrorKind, StandardErrorDetails, StandardError } from './error'
export type { Envelope, EnvelopeOk, EnvelopeErr } from './envelope'
export type { JsonPatchOp, JsonPatch } from './jsonPatch'
export type { ChangeKind, Change, ChangeBatch } from './changes'
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
} from './ops'

