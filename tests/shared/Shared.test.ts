import { describe, expect, it } from 'vitest'
import { Shared } from '#shared'

describe('Shared', () => {
    it('key.stableStringifyForKey 对对象 key 做稳定排序', () => {
        expect(Shared.key.stableStringifyForKey({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
        expect(Shared.key.stableStringifyForKey([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]')
    })

    it('key.optionsKey 区分 undefined 与空对象', () => {
        expect(Shared.key.optionsKey(undefined)).toBe('')
        expect(Shared.key.optionsKey({} as any)).toBe('{}')
    })

    it('version 解析与断言符合预期', () => {
        expect(Shared.version.resolveFiniteVersion({ version: 0 })).toBe(0)
        expect(Shared.version.resolvePositiveVersion({ version: 0 })).toBe(undefined)
        expect(Shared.version.resolvePositiveVersion({ version: 2 })).toBe(2)
        expect(() => Shared.version.requireBaseVersion('id' as any, { version: 0 })).toThrow('write requires baseVersion')
    })

    it('entityId 判定与转换符合预期', () => {
        expect(Shared.entityId.isEntityId('x')).toBe(true)
        expect(Shared.entityId.isEntityId('')).toBe(false)
        expect(Shared.entityId.toEntityId('x')).toBe('x')
        expect(Shared.entityId.toEntityId('')).toBe(null)
    })

    it('writeOptions.upsertWriteOptionsFromDispatch 仅提取合法字段', () => {
        expect(Shared.writeOptions.upsertWriteOptionsFromDispatch({ type: 'noop' })).toBe(undefined)
        expect(Shared.writeOptions.upsertWriteOptionsFromDispatch({
            type: 'upsert',
            upsert: { mode: 'loose', merge: false }
        })).toEqual({ merge: false, upsert: { mode: 'loose' } })
    })

    it('immer.collectInverseRootAddsByEntityId 仅收集 root add', () => {
        const m = Shared.immer.collectInverseRootAddsByEntityId([
            { op: 'add', path: ['a'], value: { version: 1 } },
            { op: 'add', path: ['b', 'x'], value: { version: 2 } },
            { op: 'replace', path: ['c'], value: { version: 3 } }
        ] as any)

        expect(Array.from(m.entries())).toEqual([['a', { version: 1 }]])
    })
})

