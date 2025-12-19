import * as restParse from './parse'
import { queryParamsFromSearchParams } from './normalize'
import { restMapping } from './mapping'

export const rest = {
    parse: {
        request: restParse.parseHttp
    },
    mapping: {
        restMapping
    },
    normalize: {
        queryParamsFromSearchParams
    }
} as const

export type { IncomingHttp, ParseOptions, ParseOutcome, RestRoute } from './types'
