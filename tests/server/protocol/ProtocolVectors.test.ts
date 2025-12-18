import { describe, it, expect, vi } from 'vitest'
import { parseHttp } from '../../../src/server/parser/parseHttp'
import { validateAndNormalizeRequest } from '../../../src/server/validator/validator'
import { createAtomaServer } from '../../../src/server'
import type { IOrmAdapter, QueryResult } from '../../../src/server/types'
import { HTTP_STATUS_VECTORS, PROTOCOL_VECTORS } from './vectors'
import { createNoopSyncAdapter } from '../noopSyncAdapter'

const makeIncoming = (args: { method: string; url: string; body?: any }) => ({
    method: args.method,
    url: args.url,
    json: async () => args.body
})

function createPlannedAdapter(plan?: {
    findMany?: Array<{ data?: any[]; pageInfo?: any; throws?: string }>
}): IOrmAdapter {
    const queue = Array.isArray(plan?.findMany) ? [...plan!.findMany!] : []

    const findMany = vi.fn(async () => {
        const next = queue.length ? queue.shift() : undefined
        const last = queue.length ? queue[queue.length - 1] : undefined
        const step = next ?? last
        if (step?.throws) throw new Error(step.throws)
        return { data: step?.data ?? [], pageInfo: step?.pageInfo } satisfies QueryResult
    })

    return {
        findMany
    }
}

describe('协议一致性测试向量：parseHttp + validateAndNormalizeRequest', () => {
    for (const v of PROTOCOL_VECTORS) {
        it(v.name, async () => {
            if (v.pipeline !== 'normalize') throw new Error('invalid vector pipeline')

            const parsed = v.kind === 'rest'
                ? await parseHttp(makeIncoming(v.incoming), { enableRest: true })
                : await parseHttp(makeIncoming({ method: 'POST', url: 'http://localhost/batch', body: v.body }), { enableRest: true })

            if (parsed.ok === 'pass') throw new Error(`Vector produced pass (no route matched): ${v.name}`)

            if (parsed.ok === false) {
                expect(v.expect.ok).toBe(false)
                if (v.expect.ok !== false) return
                expect(parsed.httpStatus).toBe(v.expect.status)
                expect(parsed.error.code).toBe(v.expect.error.code)
                if (v.expect.error.details) {
                    expect(parsed.error.details).toMatchObject(v.expect.error.details)
                }
                return
            }

            try {
                const normalized = validateAndNormalizeRequest(parsed.request)
                if (v.expect.ok === false) {
                    throw new Error(`Expected error but got ok: ${v.name}`)
                }
                expect(normalized).toMatchObject(v.expect.request)
            } catch (err) {
                if (v.expect.ok === true) throw err
                // normalize vectors only cover validation-layer errors; status mapping is tested separately.
                const e = err as any
                expect(e?.code).toBe(v.expect.error.code)
            }
        })
    }
})

describe('协议一致性测试向量：createAtomaServer（HTTP status + 承载位置）', () => {
    const translateGuardOptions = (guardOptions: any) => {
        const out: any = {}

        if (guardOptions?.allowList) {
            out.authz = { ...(out.authz ?? {}), resources: { allow: guardOptions.allowList } }
        }
        if (guardOptions?.policy) {
            out.authz = { ...(out.authz ?? {}), fieldPolicy: guardOptions.policy }
        }

        if (guardOptions?.maxQueries || guardOptions?.maxLimit || guardOptions?.maxBatchSize || guardOptions?.maxPayloadBytes) {
            out.limits = { ...(out.limits ?? {}) }
        }
        if (guardOptions?.maxQueries || guardOptions?.maxLimit) {
            out.limits.query = { ...(out.limits.query ?? {}) }
            if (guardOptions.maxQueries) out.limits.query.maxQueries = guardOptions.maxQueries
            if (guardOptions.maxLimit) out.limits.query.maxLimit = guardOptions.maxLimit
        }
        if (guardOptions?.maxBatchSize || guardOptions?.maxPayloadBytes) {
            out.limits.write = { ...(out.limits.write ?? {}) }
            if (guardOptions.maxBatchSize) out.limits.write.maxBatchSize = guardOptions.maxBatchSize
            if (guardOptions.maxPayloadBytes) out.limits.write.maxPayloadBytes = guardOptions.maxPayloadBytes
        }

        return out
    }

    for (const v of HTTP_STATUS_VECTORS) {
        it(v.name, async () => {
            if (v.pipeline !== 'handler') throw new Error('invalid vector pipeline')

            const adapter = createPlannedAdapter(v.adapter)
            const handler = createAtomaServer({
                adapter: { orm: adapter, sync: createNoopSyncAdapter() },
                sync: { enabled: false },
                ...translateGuardOptions(v.handler?.guardOptions)
            })

            const res = await handler(makeIncoming(v.incoming))

            expect(res.status).toBe(v.expect.status)

            if (v.expect.error) {
                expect(res.body?.error?.code).toBe(v.expect.error.code)
                if (v.expect.error.message !== undefined) {
                    expect(res.body?.error?.message).toBe(v.expect.error.message)
                }
                if (v.expect.error.details) {
                    expect(res.body?.error?.details).toMatchObject(v.expect.error.details)
                }
            }

            if (v.expect.resultsErrorAtIndex) {
                const results = res.body?.results
                expect(Array.isArray(results)).toBe(true)
                v.expect.resultsErrorAtIndex.forEach(({ index, code }) => {
                    expect(results[index]?.error?.code).toBe(code)
                })
            }

            if (v.expect.findManyCalls) {
                const findMany = adapter.findMany as any
                expect(findMany).toHaveBeenCalledTimes(v.expect.findManyCalls.length)
                v.expect.findManyCalls.forEach((call, idx) => {
                    expect(findMany.mock.calls[idx][0]).toBe(call.resource)
                    expect(findMany.mock.calls[idx][1]).toMatchObject(call.params)
                })
            }
        })
    }
})
