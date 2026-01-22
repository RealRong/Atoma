import { Shared } from '#shared'

export function getEchoEndpointError(args: { localServerUrl: string; syncUrl: string }): string | undefined {
    const a = Shared.url.normalizeBaseUrl(args.localServerUrl)
    const b = Shared.url.normalizeBaseUrl(args.syncUrl)
    if (!a || !b) return
    if (a !== b) return

    return (
        'storage.type="localServer" 不能与 sync.url 指向同一个 endpoint（会导致 Replicator apply->persistToLocal 回写远端，引发无限循环 / version 自增）；请改用 indexeddb 作为本地存储，或让 localServer 指向 localhost、sync 指向云端'
    )
}
