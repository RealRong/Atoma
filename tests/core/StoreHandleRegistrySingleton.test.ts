import { describe, expect, it } from 'vitest'

describe('storeHandleRegistry', () => {
    it('shares registry across duplicated module instances', async () => {
        const baseUrl = new URL('../../src/core/storeHandleRegistry.ts', import.meta.url).href
        const m1 = await import(`${baseUrl}?v=1`)
        const m2 = await import(`${baseUrl}?v=2`)

        const store = {} as any
        const handle = { atom: {} } as any

        m1.registerStoreHandle(store, handle)
        expect(m2.getStoreHandle(store)).toBe(handle)
    })
})

