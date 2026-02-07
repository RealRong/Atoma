import type { Entity } from 'atoma-types/core'
import type { ExecuteWriteRequest } from './types'
import { OptimisticService } from './OptimisticService'
import { PersistCoordinator } from './PersistCoordinator'

export class WriteCommandService {
    private readonly persistCoordinator: PersistCoordinator
    private readonly optimisticService: OptimisticService

    constructor(args?: { persistCoordinator?: PersistCoordinator; optimisticService?: OptimisticService }) {
        this.optimisticService = args?.optimisticService ?? new OptimisticService()
        this.persistCoordinator = args?.persistCoordinator ?? new PersistCoordinator({ optimisticService: this.optimisticService })
    }

    execute = async <T extends Entity>(args: ExecuteWriteRequest<T>): Promise<T | void> => {
        const intents = args.intents ?? []
        const writePolicy = args.runtime.persistence.resolveWritePolicy(args.writeStrategy)
        const optimistic = this.optimisticService.apply({
            handle: args.handle,
            intents,
            writePolicy
        })

        return await this.persistCoordinator.execute({
            ...args,
            intents,
            ...optimistic
        })
    }
}
