export class NetworkStateManager {
    public isOnline: boolean
    private onlineHandler?: () => void
    private offlineHandler?: () => void

    constructor(
        private onReconnect?: () => void,
        private onDisconnect?: () => void
    ) {
        this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
        this.setupListeners()
    }

    private setupListeners(): void {
        if (typeof window !== 'undefined') {
            this.onlineHandler = () => {
                this.isOnline = true
                this.onReconnect?.()
            }
            this.offlineHandler = () => {
                this.isOnline = false
                this.onDisconnect?.()
            }
            window.addEventListener('online', this.onlineHandler)
            window.addEventListener('offline', this.offlineHandler)
        }
    }

    dispose(): void {
        if (typeof window !== 'undefined') {
            if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler)
            if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler)
        }
    }

    isNetworkError(error: any): boolean {
        return (
            error?.message?.includes('fetch') ||
            error?.message?.includes('network') ||
            error?.code === 'ECONNREFUSED' ||
            !this.isOnline
        )
    }
}
