import { createId } from '@atoma-js/shared'

export function createTestId(prefix = 'test'): string {
    return `${prefix}-${createId()}`
}
