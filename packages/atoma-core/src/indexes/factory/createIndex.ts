import type { IndexDefinition } from 'atoma-types/core'
import { zod } from 'atoma-shared'
import { IIndex } from '../base/IIndex'
import { NumberDateIndex } from '../implementations/NumberDateIndex'
import { StringIndex } from '../implementations/StringIndex'
import { SubstringIndex } from '../implementations/SubstringIndex'
import { TextIndex } from '../implementations/TextIndex'

const { parseOrThrow, z } = zod

const indexDefinitionSchema = z.object({
    field: z.string().trim().min(1),
    type: z.enum(['number', 'date', 'string', 'substring', 'text']),
    options: z.unknown().optional()
}).loose()

export function createIndex<T>(definition: IndexDefinition<T>): IIndex<T> {
    const parsed = parseOrThrow(indexDefinitionSchema, definition, { prefix: '[Atoma Index] ' }) as unknown as IndexDefinition<T>

    switch (parsed.type) {
        case 'number':
        case 'date':
            return new NumberDateIndex<T>(parsed as IndexDefinition<T> & { type: 'number' | 'date' })
        case 'string':
            return new StringIndex<T>(parsed)
        case 'substring':
            return new SubstringIndex<T>(parsed)
        case 'text':
            return new TextIndex<T>(parsed)
    }
}
