export type ProtocolVector =
    | {
        name: string
        pipeline: 'normalize'
        kind: 'rest'
        incoming: { method: string; url: string; body?: any }
        expect: { ok: true; request: any }
    }
    | {
        name: string
        pipeline: 'normalize'
        kind: 'batch'
        body: any
        expect: { ok: true; request: any }
    }
    | {
        name: string
        pipeline: 'normalize'
        kind: 'rest'
        incoming: { method: string; url: string; body?: any }
        expect: { ok: false; status: number; error: { code: string; details?: Record<string, any> } }
    }
    | {
        name: string
        pipeline: 'normalize'
        kind: 'batch'
        body: any
        expect: { ok: false; status: number; error: { code: string; details?: Record<string, any> } }
    }
    | {
        name: string
        pipeline: 'handler'
        incoming: { method: string; url: string; body?: any }
        handler?: {
            guardOptions?: any
        }
        adapter?: {
            isResourceAllowed?: boolean
            /** 每次 findMany 依次 shift；不够则用最后一个或默认空数组 */
            findMany?: Array<{ data?: any[]; pageInfo?: any; throws?: string }>
        }
        expect: {
            status: number
            error?: { code: string; message?: string; details?: Record<string, any> }
            /**
             * 仅在 adapter.findMany 会被调用时使用；用于断言“归一化后的 params”
             * 例如 where/op 类型转换、orderBy/fields/page 映射等。
             */
            findManyCalls?: Array<{ resource: string; params: any }>
            resultsErrorAtIndex?: Array<{ index: number; code: string }>
        }
    }

/**
 * 协议一致性测试向量（用于多语言后端对齐）。
 *
 * 关注点：
 * - REST querystring 的 bracket where 解析与类型转换
 * - orderBy/page/select(fields) 的标准化
 * - Batch 请求体的标准化与错误返回（422 + details.kind/path）
 * - HTTP status 与 error 承载位置（REST 顶层 / Batch results[i].error）
 */
export const PROTOCOL_VECTORS: ProtocolVector[] = [
    {
        name: 'REST: 默认 offset page（limit 默认 50，includeTotal 默认 true）',
        pipeline: 'normalize',
        kind: 'rest',
        incoming: { method: 'GET', url: 'http://localhost/post' },
        expect: {
            ok: true,
            request: {
                ops: [{
                    opId: 'rest:0',
                    action: 'query',
                    query: {
                        resource: 'post',
                        params: {
                            page: { mode: 'offset', limit: 50, includeTotal: true }
                        }
                    }
                }]
            }
        }
    },
    {
        name: 'REST: where primitive 类型转换（true/number/string）',
        pipeline: 'normalize',
        kind: 'rest',
        incoming: { method: 'GET', url: 'http://localhost/post?where[published]=true&where[postId]=1&where[tag]=x' },
        expect: {
            ok: true,
            request: {
                ops: [{
                    opId: 'rest:0',
                    action: 'query',
                    query: {
                        resource: 'post',
                        params: {
                            where: { published: true, postId: 1, tag: 'x' }
                        }
                    }
                }]
            }
        }
    },
    {
        name: 'REST: where in 数组 + op（gte）',
        pipeline: 'normalize',
        kind: 'rest',
        incoming: { method: 'GET', url: 'http://localhost/post?where[id][in][]=1&where[id][in][]=2&where[age][gte]=18' },
        expect: {
            ok: true,
            request: {
                ops: [{
                    opId: 'rest:0',
                    action: 'query',
                    query: {
                        resource: 'post',
                        params: {
                            where: { id: { in: [1, 2] }, age: { gte: 18 } }
                        }
                    }
                }]
            }
        }
    },
    {
        name: 'REST: orderBy 重复参数解析为数组，非法 direction 归一化为 desc',
        pipeline: 'normalize',
        kind: 'rest',
        incoming: { method: 'GET', url: 'http://localhost/post?orderBy=createdAt:asc&orderBy=id:wat' },
        expect: {
            ok: true,
            request: {
                ops: [{
                    opId: 'rest:0',
                    action: 'query',
                    query: {
                        resource: 'post',
                        params: {
                            orderBy: [
                                { field: 'createdAt', direction: 'asc' },
                                { field: 'id', direction: 'desc' }
                            ]
                        }
                    }
                }]
            }
        }
    },
    {
        name: 'REST: cursor 分页（after）映射为 page.cursor',
        pipeline: 'normalize',
        kind: 'rest',
        incoming: { method: 'GET', url: 'http://localhost/post?after=tok&limit=10' },
        expect: {
            ok: true,
            request: {
                ops: [{
                    opId: 'rest:0',
                    action: 'query',
                    query: {
                        resource: 'post',
                        params: {
                            page: { mode: 'cursor', limit: 10, after: 'tok' }
                        }
                    }
                }]
            }
        }
    },
    {
        name: 'REST: fields 映射为 select',
        pipeline: 'normalize',
        kind: 'rest',
        incoming: { method: 'GET', url: 'http://localhost/post?fields=id,title' },
        expect: {
            ok: true,
            request: {
                ops: [{
                    opId: 'rest:0',
                    action: 'query',
                    query: {
                        resource: 'post',
                        params: {
                            select: { id: true, title: true }
                        }
                    }
                }]
            }
        }
    },
    {
        name: 'REST: 未知 where op → 422 INVALID_QUERY + validation.path',
        pipeline: 'normalize',
        kind: 'rest',
        incoming: { method: 'GET', url: 'http://localhost/post?where[age][nope]=1' },
        expect: {
            ok: false,
            status: 422,
            error: { code: 'INVALID_QUERY', details: { kind: 'validation', path: 'where.age.nope' } }
        }
    },
    {
        name: 'Batch: params.page 必填（缺失 → 422 INVALID_QUERY + path=page）',
        pipeline: 'normalize',
        kind: 'batch',
        body: { ops: [{ opId: 'q1', action: 'query', query: { resource: 'post', params: {} } }] },
        expect: {
            ok: false,
            status: 422,
            error: { code: 'INVALID_QUERY', details: { kind: 'validation' } }
        }
    },
    {
        name: 'Batch: orderBy string 归一化为数组（非法 direction 归一化为 desc）',
        pipeline: 'normalize',
        kind: 'batch',
        body: {
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        orderBy: 'createdAt:wat',
                        page: { mode: 'offset', limit: 5, includeTotal: true }
                    }
                }
            }]
        },
        expect: {
            ok: true,
            request: {
                ops: [{
                    opId: 'q1',
                    action: 'query',
                    query: {
                        resource: 'post',
                        params: {
                            orderBy: [{ field: 'createdAt', direction: 'desc' }]
                        }
                    }
                }]
            }
        }
    },
    {
        name: 'Batch: fields 数组映射为 select，并移除 fields',
        pipeline: 'normalize',
        kind: 'batch',
        body: {
            ops: [{
                opId: 'q1',
                action: 'query',
                query: {
                    resource: 'post',
                    params: {
                        fields: ['id', 'title'],
                        page: { mode: 'offset', limit: 5, includeTotal: true }
                    }
                }
            }]
        },
        expect: {
            ok: true,
            request: {
                ops: [{
                    opId: 'q1',
                    action: 'query',
                    query: {
                        resource: 'post',
                        params: {
                            select: { id: true, title: true }
                        }
                    }
                }]
            }
        }
    }
]

export const HTTP_STATUS_VECTORS: ProtocolVector[] = [
    {
        name: 'REST: 未匹配路由 → 404 NOT_FOUND（No route matched）',
        pipeline: 'handler',
        incoming: { method: 'GET', url: 'http://localhost/' },
        expect: {
            status: 404,
            error: { code: 'NOT_FOUND', message: 'No route matched' }
        }
    },
    {
        name: 'REST: GET /:resource/:id 未命中 → 404 NOT_FOUND（Not found）',
        pipeline: 'handler',
        incoming: { method: 'GET', url: 'http://localhost/post/999' },
        adapter: { isResourceAllowed: true, findMany: [{ data: [] }] },
        expect: {
            status: 404,
            error: { code: 'NOT_FOUND', message: 'Not found' }
        }
    },
    {
        name: 'Batch: /batch body 非 object → 400 INVALID_BODY',
        pipeline: 'handler',
        incoming: { method: 'POST', url: 'http://localhost/batch', body: 'nope' },
        adapter: { isResourceAllowed: true, findMany: [{ data: [] }] },
        expect: {
            status: 400,
            error: { code: 'INVALID_BODY', details: { kind: 'validation' } }
        }
    },
    {
        name: 'Batch: 单个 query 执行失败 → HTTP 200 + results[i].error.code=QUERY_FAILED',
        pipeline: 'handler',
        incoming: {
            method: 'POST',
            url: 'http://localhost/batch',
            body: {
                ops: [
                    { opId: 'r1', action: 'query', query: { resource: 'post', params: { page: { mode: 'offset', limit: 1, includeTotal: true } } } },
                    { opId: 'r2', action: 'query', query: { resource: 'post', params: { page: { mode: 'offset', limit: 1, includeTotal: true } } } }
                ]
            }
        },
        adapter: {
            isResourceAllowed: true,
            findMany: [
                { data: [{ id: 1 }] },
                { throws: 'db down' }
            ]
        },
        expect: {
            status: 200,
            resultsErrorAtIndex: [{ index: 1, code: 'QUERY_FAILED' }]
        }
    },
    {
        name: 'Batch: UNSUPPORTED_ACTION → 422 UNSUPPORTED_ACTION（validation）',
        pipeline: 'handler',
        incoming: { method: 'POST', url: 'http://localhost/batch', body: { ops: [{ opId: 'x1', action: 'wat', resource: 'post', payload: [] }] } },
        adapter: { isResourceAllowed: true, findMany: [{ data: [] }] },
        expect: {
            status: 422,
            error: { code: 'UNSUPPORTED_ACTION', details: { kind: 'validation' } }
        }
    },
    {
        name: 'Write: ADAPTER_NOT_IMPLEMENTED → /batch 200 + results[i].error',
        pipeline: 'handler',
        incoming: {
            method: 'POST',
            url: 'http://localhost/batch',
            body: { ops: [{ opId: 'p1', action: 'bulkPatch', resource: 'post', payload: [{ id: 1, patches: [], baseVersion: 0 }] }] }
        },
        adapter: { isResourceAllowed: true, findMany: [{ data: [] }] },
        expect: {
            status: 200,
            resultsErrorAtIndex: [{ index: 0, code: 'ADAPTER_NOT_IMPLEMENTED' }]
        }
    },
    {
        name: 'Write: PAYLOAD_TOO_LARGE → 413 + limits.max/actual',
        pipeline: 'handler',
        incoming: {
            method: 'POST',
            url: 'http://localhost/batch',
            body: { ops: [{ opId: 'c1', action: 'bulkCreate', resource: 'post', payload: [{ data: { big: 'x'.repeat(200) } }] }] }
        },
        handler: { guardOptions: { maxPayloadBytes: 10 } },
        adapter: { isResourceAllowed: true, findMany: [{ data: [] }] },
        expect: {
            status: 413,
            error: { code: 'PAYLOAD_TOO_LARGE', details: { kind: 'limits', max: 10 } }
        }
    }
]
