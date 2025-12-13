import type { BatchOp, BatchRequest, QueryParams } from '../types'
import { throwError } from '../error'

export type FieldListRule =
    | string[]
    | {
        allow?: string[]
        deny?: string[]
    }

export type FieldPolicy = {
    where?: FieldListRule
    orderBy?: FieldListRule
    select?: FieldListRule
}

export type FieldPolicyResolverArgs = {
    action: BatchOp['action']
    resource: string
    params?: QueryParams
    ctx?: any
    request?: BatchRequest
    queryIndex?: number
}

export type FieldPolicyInput =
    | FieldPolicy
    | ((args: FieldPolicyResolverArgs) => FieldPolicy | undefined)

type NormalizedRule = {
    allow?: Set<string>
    deny?: Set<string>
}

const SYSTEM_WHERE_FIELDS = new Set(['id'])

export function resolveFieldPolicy(input: FieldPolicyInput | undefined, args: FieldPolicyResolverArgs): FieldPolicy | undefined {
    if (!input) return undefined
    if (typeof input === 'function') return input(args)
    return input
}

export function enforceQueryFieldPolicy(
    resource: string,
    params: QueryParams,
    policy: FieldPolicy | undefined,
    meta?: { queryIndex?: number; traceId?: string; requestId?: string; opId?: string }
) {
    if (!policy) return

    const whereRule = normalizeRule(policy.where)
    const orderByRule = normalizeRule(policy.orderBy)
    const selectRule = normalizeRule(policy.select)

    if (params.where) {
        for (const field of Object.keys(params.where)) {
            if (SYSTEM_WHERE_FIELDS.has(field)) continue
            ensureAllowed(whereRule, field, { code: 'INVALID_QUERY', resource, part: 'where', ...meta })
        }
    }

    if (params.orderBy) {
        for (const rule of params.orderBy) {
            ensureAllowed(orderByRule, rule.field, { code: 'INVALID_ORDER_BY', resource, part: 'orderBy', ...meta })
        }
    }

    if (params.select) {
        for (const [field, enabled] of Object.entries(params.select)) {
            if (!enabled) continue
            ensureAllowed(selectRule, field, { code: 'INVALID_QUERY', resource, part: 'select', ...meta })
        }
    }
}

function ensureAllowed(
    rule: NormalizedRule | undefined,
    field: string,
    details: {
        code: string
        resource: string
        part: 'where' | 'orderBy' | 'select'
        queryIndex?: number
        traceId?: string
        requestId?: string
        opId?: string
    }
) {
    // 未配置该 part 的策略 → 放行
    if (!rule) return

    // deny 优先
    if (rule.deny?.has(field)) {
        throwError(details.code, `Field not allowed: ${field}`, { kind: 'field_policy', ...details, field })
    }

    if (rule.allow && !rule.allow.has(field)) {
        throwError(details.code, `Field not allowed: ${field}`, { kind: 'field_policy', ...details, field })
    }
}

function normalizeRule(rule: FieldListRule | undefined): NormalizedRule | undefined {
    if (!rule) return undefined
    if (Array.isArray(rule)) {
        return { allow: new Set(rule.filter(isString)) }
    }

    const allow = Array.isArray(rule.allow) ? new Set(rule.allow.filter(isString)) : undefined
    const deny = Array.isArray(rule.deny) ? new Set(rule.deny.filter(isString)) : undefined
    return (allow || deny) ? { allow, deny } : undefined
}

function isString(v: unknown): v is string {
    return typeof v === 'string'
}

// throwError imported from src/server/error.ts
