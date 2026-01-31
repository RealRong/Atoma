import type { RuntimePersistence } from 'atoma-runtime'
import type { HandlerChain } from '../plugins/HandlerChain'
import type { PersistContext } from '../plugins/types'

export class RuntimePersistenceChain implements RuntimePersistence {
    private readonly chain: HandlerChain
    private readonly clientId: string

    constructor(args: { chain: HandlerChain; clientId: string }) {
        this.chain = args.chain
        this.clientId = args.clientId
    }

    register = () => {
        throw new Error('[Atoma] persistence.register is disabled (handler-chain mode)')
    }

    persist: RuntimePersistence['persist'] = async (req) => {
        const ctx: PersistContext = {
            clientId: this.clientId,
            store: String(req.storeName)
        }
        return await this.chain.execute(req, ctx)
    }
}
