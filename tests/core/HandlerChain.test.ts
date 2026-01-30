import { describe, expect, it } from 'vitest'
import { HandlerChain } from '../../packages/atoma/src/plugins/HandlerChain'
import { PluginRegistry } from '../../packages/atoma/src/plugins/PluginRegistry'

describe('HandlerChain', () => {
    it('按 priority + 注册顺序执行', async () => {
        const calls: string[] = []
        const registry = new PluginRegistry()

        registry.register('io', async (_req, _ctx, next) => {
            calls.push('a')
            return await next()
        })

        registry.register('io', async (_req, _ctx, next) => {
            calls.push('b')
            return await next()
        }, { priority: -10 })

        registry.register('io', async (_req, _ctx) => {
            calls.push('c')
            return { results: [] }
        }, { priority: 10 })

        const chain = new HandlerChain(registry.list('io'))
        const result = await chain.execute({}, {})

        expect(calls).toEqual(['b', 'a', 'c'])
        expect(result).toEqual({ results: [] })
    })

    it('缺少终结处理器时抛错', async () => {
        const registry = new PluginRegistry()
        registry.register('io', async (_req, _ctx, next) => {
            return await next()
        })

        const chain = new HandlerChain(registry.list('io'))
        await expect(chain.execute({}, {})).rejects.toThrow('missing terminal handler')
    })
})
