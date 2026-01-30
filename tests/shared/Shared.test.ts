import { describe, expect, it } from 'vitest'
import { stableStringify, entityId, immer, version, writeOptions } from 'atoma-shared'

describe('Shared', () => {
    it('stableStringify 对对象 key 做稳定排序', () => {
        expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
        expect(stableStringify([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]')
    })

    it('stableStringify 区分 undefined 与空对象', () => {
        expect(stableStringify(undefined)).toBe('')
        expect(stableStringify({} as any)).toBe('{}')
    })

    it('version 解析与断言符合预期', () => {
        expect(version.resolveFiniteVersion({ version: 0 })).toBe(0)
        expect(version.resolvePositiveVersion({ version: 0 })).toBe(undefined)
        expect(version.resolvePositiveVersion({ version: 2 })).toBe(2)
        expect(() => version.requireBaseVersion('id' as any, { version: 0 })).toThrow('write requires baseVersion')
    })

    it('entityId 判定与转换符合预期', () => {
        expect(entityId.isEntityId('x')).toBe(true)
        expect(entityId.isEntityId('')).toBe(false)
        expect(entityId.toEntityId('x')).toBe('x')
        expect(entityId.toEntityId('')).toBe(null)
    })

    it('writeOptions.upsertWriteOptionsFromDispatch 仅提取合法字段', () => {
        expect(writeOptions.upsertWriteOptionsFromDispatch({ type: 'noop' })).toBe(undefined)
        expect(writeOptions.upsertWriteOptionsFromDispatch({
            type: 'upsert',
            upsert: { mode: 'loose', merge: false }
        })).toEqual({ merge: false, upsert: { mode: 'loose' } })
    })

    it('immer.collectInverseRootAddsByEntityId 仅收集 root add', () => {
        const m = immer.collectInverseRootAddsByEntityId([
            { op: 'add', path: ['a'], value: { version: 1 } },
            { op: 'add', path: ['b', 'x'], value: { version: 2 } },
            { op: 'replace', path: ['c'], value: { version: 3 } }
        ] as any)

        expect(Array.from(m.entries())).toEqual([['a', { version: 1 }]])
    })
})
