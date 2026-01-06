import { describe, expect, it } from 'vitest'
import { createLocalFirstClient, createClient } from '../../src'

describe('createClient/createLocalFirstClient guards', () => {
    it('throws when storage.localServer.url === sync.url (local-first)', () => {
        expect(() => createLocalFirstClient<{ posts: any }>({
            storage: { type: 'localServer', url: 'http://localhost:8787' },
            sync: { url: 'http://localhost:8787' }
        })).toThrow('localServer')
    })

    it('throws when store.localServer.url === sync.url (createClient)', () => {
        expect(() => createClient<{ posts: any }>({
            store: { type: 'localServer', url: 'http://localhost:8787' },
            sync: { url: 'http://localhost:8787' }
        })).toThrow('localServer')
    })
})
