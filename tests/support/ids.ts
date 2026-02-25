import { createId } from 'atoma-shared'

export function createTestId(prefix = 'test'): string {
    return `${prefix}-${createId()}`
}
