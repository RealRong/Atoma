import type { FilterExpr } from 'atoma-types/protocol'

export function compileFilterToPrismaWhere(filter: FilterExpr | undefined): any | undefined {
    if (!filter) return undefined
    return compilePrismaExpr(filter)
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
