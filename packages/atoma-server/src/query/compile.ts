import type { FilterExpr } from 'atoma/protocol'

type SqlFilter = { sql: string; params: Record<string, any> }

type SqlCompileContext = {
    alias?: string
    nextParam: (hint: string) => string
}

export function compileFilterToSql(filter: FilterExpr | undefined, ctx: SqlCompileContext): SqlFilter | undefined {
    if (!filter) return undefined
    return compileSqlExpr(filter, ctx)
}

export function compileFilterToPrismaWhere(filter: FilterExpr | undefined): any | undefined {
    if (!filter) return undefined
    return compilePrismaExpr(filter)
}

function compileSqlExpr(expr: FilterExpr, ctx: SqlCompileContext): SqlFilter {
    switch (expr.op) {
        case 'and':
        case 'or': {
            const parts = (expr.args || []).map(arg => compileSqlExpr(arg, ctx))
            if (!parts.length) {
                return { sql: expr.op === 'and' ? '1=1' : '1=0', params: {} }
            }
            return joinSql(parts, expr.op === 'and' ? 'AND' : 'OR')
        }
        case 'not': {
            const inner = compileSqlExpr(expr.arg, ctx)
            return { sql: `NOT (${inner.sql})`, params: inner.params }
        }
        case 'eq': {
            const column = resolveColumn(ctx.alias, expr.field)
            if (expr.value === null) {
                return { sql: `${column} IS NULL`, params: {} }
            }
            const key = ctx.nextParam(`${expr.field}_eq`)
            return { sql: `${column} = :${key}`, params: { [key]: expr.value } }
        }
        case 'in': {
            const column = resolveColumn(ctx.alias, expr.field)
            const values = Array.isArray(expr.values) ? expr.values : []
            if (!values.length) {
                return { sql: '1=0', params: {} }
            }
            const key = ctx.nextParam(`${expr.field}_in`)
            return { sql: `${column} IN (:...${key})`, params: { [key]: values } }
        }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            const column = resolveColumn(ctx.alias, expr.field)
            const op = expr.op === 'gt'
                ? '>'
                : expr.op === 'gte'
                    ? '>='
                    : expr.op === 'lt'
                        ? '<'
                        : '<='
            const key = ctx.nextParam(`${expr.field}_${expr.op}`)
            return { sql: `${column} ${op} :${key}`, params: { [key]: expr.value } }
        }
        case 'startsWith':
        case 'endsWith':
        case 'contains': {
            const column = resolveColumn(ctx.alias, expr.field)
            const key = ctx.nextParam(`${expr.field}_${expr.op}`)
            const value = expr.op === 'startsWith'
                ? `${expr.value}%`
                : expr.op === 'endsWith'
                    ? `%${expr.value}`
                    : `%${expr.value}%`
            return { sql: `${column} LIKE :${key}`, params: { [key]: value } }
        }
        case 'isNull': {
            const column = resolveColumn(ctx.alias, expr.field)
            return { sql: `${column} IS NULL`, params: {} }
        }
        case 'exists': {
            const column = resolveColumn(ctx.alias, expr.field)
            return { sql: `${column} IS NOT NULL`, params: {} }
        }
        case 'text': {
            const column = resolveColumn(ctx.alias, expr.field)
            const key = ctx.nextParam(`${expr.field}_text`)
            return { sql: `${column} LIKE :${key}`, params: { [key]: `%${expr.query}%` } }
        }
    }
}

function joinSql(parts: SqlFilter[], joiner: 'AND' | 'OR'): SqlFilter {
    const sql = parts.map(p => `(${p.sql})`).join(` ${joiner} `)
    const params = parts.reduce((acc, part) => Object.assign(acc, part.params), {} as Record<string, any>)
    return { sql, params }
}

function resolveColumn(alias: string | undefined, field: string) {
    return alias ? `${alias}.${field}` : field
}

function compilePrismaExpr(expr: FilterExpr): any {
    switch (expr.op) {
        case 'and':
            return { AND: (expr.args || []).map(compilePrismaExpr) }
        case 'or':
            return { OR: (expr.args || []).map(compilePrismaExpr) }
        case 'not':
            return { NOT: compilePrismaExpr(expr.arg) }
        case 'eq':
            return { [expr.field]: expr.value }
        case 'in':
            return { [expr.field]: { in: expr.values } }
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            const op = expr.op === 'gt'
                ? 'gt'
                : expr.op === 'gte'
                    ? 'gte'
                    : expr.op === 'lt'
                        ? 'lt'
                        : 'lte'
            return { [expr.field]: { [op]: expr.value } }
        }
        case 'startsWith':
        case 'endsWith':
        case 'contains':
            return { [expr.field]: { [expr.op]: expr.value } }
        case 'isNull':
            return { [expr.field]: null }
        case 'exists':
            return { [expr.field]: { not: null } }
        case 'text':
            return { [expr.field]: { contains: expr.query } }
    }
}
