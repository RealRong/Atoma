import { ClientPlugin } from 'atoma-client'

class DisabledDevtoolsPlugin extends ClientPlugin {
    readonly id = 'devtools:disabled'

    setup(): void {
        throw new Error('[atoma-devtools] 已迁移到新的插件架构，此包尚未完成适配')
    }
}

export function devtoolsPlugin(): ClientPlugin {
    return new DisabledDevtoolsPlugin()
}
