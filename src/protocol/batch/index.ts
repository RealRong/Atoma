import * as batchCompose from './compose'
import * as batchNormalize from './normalize'
import * as batchResult from './result'
import * as batchValidate from './validate'

export const batch = {
    compose: {
        request: batchCompose.request,
        meta: batchCompose.meta,
        withMeta: batchCompose.withMeta,
        op: batchCompose.op
    },
    validate: {
        request: batchValidate.validateBatchRequest,
        op: batchValidate.validateBatchOp
    },
    normalize: {
        request: batchNormalize.request,
        queryParams: batchNormalize.queryParams
    },
    result: {
        mapResults: batchResult.mapResults
    }
} as const

export type {
    Action,
    WriteOptions,
    WriteItemMeta,
    BulkCreateItem,
    BulkUpdateItem,
    BulkPatchItem,
    BulkDeleteItem,
    BatchOp,
    BatchRequest,
    BatchResult,
    BatchResponse
} from './types'

export type { PageInfo } from './pagination'

export type {
    OrderByRule,
    CursorToken,
    Page,
    QueryParams
} from './query'
