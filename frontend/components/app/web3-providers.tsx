'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { config } from '@/lib/wagmi'

// biome-ignore lint/suspicious/noExplicitAny: standard bigint JSON polyfill
const _bigIntProto = BigInt.prototype as any
if (typeof _bigIntProto.toJSON !== 'function') {
  _bigIntProto.toJSON = function () {
    return this.toString()
  }
}

const queryClient = new QueryClient()

export function Web3Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
