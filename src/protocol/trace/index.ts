import { REQUEST_ID_HEADER, TRACE_ID_HEADER } from './constants'
import type { HeadersLike } from './types'
import * as traceCompose from './compose'
import * as traceParse from './parse'

export const trace = {
    headers: {
        TRACE_ID_HEADER,
        REQUEST_ID_HEADER
    },
    parse: {
        getHeader: traceParse.getHeader,
        getTraceId: (headers: HeadersLike) => traceParse.getTraceId(headers, TRACE_ID_HEADER),
        getRequestId: (headers: HeadersLike) => traceParse.getRequestId(headers, REQUEST_ID_HEADER)
    },
    compose: {
        inject: (headers: Record<string, string> | undefined, args: { traceId?: string; requestId?: string }) => {
            return traceCompose.inject(headers, {
                traceIdHeader: TRACE_ID_HEADER,
                requestIdHeader: REQUEST_ID_HEADER,
                traceId: args.traceId,
                requestId: args.requestId
            })
        }
    }
} as const

export { TRACE_ID_HEADER, REQUEST_ID_HEADER } from './constants'
export type { HeadersLike } from './types'
