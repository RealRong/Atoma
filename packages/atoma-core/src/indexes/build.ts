import type { IndexDefinition } from 'atoma-types/core'
import { NumberDateIndex } from './impl/NumberDateIndex'
import { StringIndex } from './impl/StringIndex'
import { SubstringIndex } from './impl/SubstringIndex'
import { TextIndex } from './impl/TextIndex'
import type { IndexDriver } from './types'

function assertNever(type: never): never {
    throw new Error(`[Atoma Index] Unsupported index type "${String(type)}".`)
}

export function buildIndex<T>(definition: IndexDefinition<T>): IndexDriver<T> {
    const indexType = definition.type

    switch (indexType) {
        case 'number':
        case 'date':
            return new NumberDateIndex<T>(definition as IndexDefinition<T> & { type: 'number' | 'date' })
        case 'string':
            return new StringIndex<T>(definition)
        case 'substring':
            return new SubstringIndex<T>(definition)
        case 'text':
            return new TextIndex<T>(definition)
        default:
            return assertNever(indexType)
    }
}
