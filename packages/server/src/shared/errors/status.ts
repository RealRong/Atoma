import type { StandardError } from 'atoma-types/protocol'

export function errorStatus(error: Pick<StandardError, 'code'>) {
    if (error.code.startsWith('INVALID_') || error.code.startsWith('PROTOCOL_')) {
        return 422
    }

    switch (error.code) {
        case 'METHOD_NOT_ALLOWED':
            return 405
        case 'NOT_FOUND':
            return 404
        case 'BAD_REQUEST':
            return 400
        case 'ACCESS_DENIED':
        case 'RESOURCE_NOT_ALLOWED':
            return 403
        case 'CONFLICT':
            return 409
        case 'ADAPTER_NOT_IMPLEMENTED':
            return 501
        case 'TOO_MANY_QUERIES':
        case 'TOO_MANY_ITEMS':
        case 'INVALID_REQUEST':
        case 'INVALID_QUERY':
        case 'INVALID_WRITE':
        case 'INVALID_PAYLOAD':
        case 'INVALID_ORDER_BY':
        case 'UNSUPPORTED_ACTION':
            return 422
        case 'PAYLOAD_TOO_LARGE':
            return 413
        default:
            return 500
    }
}
