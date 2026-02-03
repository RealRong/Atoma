import { envelope } from '../core/envelope'
import { buildChangesPullOp, buildQueryOp, buildRequestMeta, buildWriteOp, withTraceMeta } from './build'
import { ensureWriteItemMeta, newWriteItemMeta } from './meta'
import { assertMeta, assertOperation, assertOpsRequest, assertOutgoingOps, assertOperationResult, assertOperationResults, assertQueryResultData, assertWriteResultData, assertQuery, assertFilterExpr } from './validate'

export const ops = {
    parse: {
        envelope: envelope.parse.envelope
    },
    compose: {
        ok: envelope.compose.ok,
        error: envelope.compose.error
    },
    build: {
        buildRequestMeta,
        withTraceMeta,
        buildWriteOp,
        buildQueryOp,
        buildChangesPullOp
    },
    meta: {
        ensureWriteItemMeta,
        newWriteItemMeta
    },
    validate: {
        assertMeta,
        assertOpsRequest,
        assertOperation,
        assertOutgoingOps,
        assertOperationResult,
        assertOperationResults,
        assertQuery,
        assertFilterExpr,
        assertQueryResultData,
        assertWriteResultData
    }
} as const
