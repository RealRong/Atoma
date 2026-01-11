export type StoreWriteConfig = Readonly<{
    persistMode: 'direct' | 'outbox'
    allowImplicitFetchForWrite: boolean
}>

