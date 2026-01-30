import type { Endpoint } from './types'

export class EndpointRegistry {
    private readonly endpoints = new Map<string, Endpoint>()
    private readonly byRole = new Map<string, Endpoint[]>()

    register = (ep: Endpoint) => {
        const id = String(ep?.id ?? '').trim()
        const role = String(ep?.role ?? '').trim()
        if (!id) throw new Error('[Atoma] EndpointRegistry.register: id 必填')
        if (!role) throw new Error('[Atoma] EndpointRegistry.register: role 必填')

        if (this.endpoints.has(id)) {
            throw new Error(`[Atoma] EndpointRegistry.register: 重复的 endpoint id: ${id}`)
        }

        this.endpoints.set(id, ep)

        const list = this.byRole.get(role) ?? []
        list.push(ep)
        this.byRole.set(role, list)

        return () => {
            this.endpoints.delete(id)
            const current = this.byRole.get(role)
            if (!current) return
            const next = current.filter(item => item !== ep)
            if (!next.length) this.byRole.delete(role)
            else this.byRole.set(role, next)
        }
    }

    getById = (id: string) => {
        const key = String(id ?? '').trim()
        if (!key) return undefined
        return this.endpoints.get(key)
    }

    getByRole = (role: string) => {
        const key = String(role ?? '').trim()
        if (!key) return []
        const list = this.byRole.get(key)
        return list ? [...list] : []
    }

    list = () => {
        return Array.from(this.endpoints.values())
    }
}
