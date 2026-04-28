'use client'

import { erc20Abi, formatUnits } from 'viem'
import {
  useAccount,
  useBalance,
  useConnect,
  useConnectors,
  useDisconnect,
  useReadContract,
} from 'wagmi'
import { Button } from '@/components/ui/button'

const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as const

function trim(value: string, decimals = 4) {
  const [whole, frac = ''] = value.split('.')
  return frac ? `${whole}.${frac.slice(0, decimals)}` : whole
}

export default function LoginPage() {
  const { address, isConnected } = useAccount()
  const { connect, status, error } = useConnect()
  const { disconnect } = useDisconnect()
  const connectors = useConnectors()
  const portoConnector = connectors[0]

  const { data: ethBalance } = useBalance({
    address,
    query: { enabled: !!address, refetchInterval: 5_000 },
  })

  const { data: usdcRaw } = useReadContract({
    address: USDC_SEPOLIA,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 5_000 },
  })

  const ethDisplay = ethBalance
    ? `${trim(formatUnits(ethBalance.value, ethBalance.decimals))} ${ethBalance.symbol}`
    : '—'
  const usdcDisplay =
    usdcRaw !== undefined ? `${trim(formatUnits(usdcRaw, 6), 2)} USDC` : '—'

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="flex flex-col items-center gap-4">
        {isConnected ? (
          <>
            <p className="break-all text-center font-mono text-lg">{address}</p>
            <div className="flex flex-col items-center gap-1 font-mono text-sm">
              <span>ETH: {ethDisplay}</span>
              <span>USDC: {usdcDisplay}</span>
            </div>
            <Button variant="outline" onClick={() => disconnect()}>
              Sign out
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">Sign in</h1>
            <Button
              onClick={() => portoConnector && connect({ connector: portoConnector })}
              disabled={!portoConnector || status === 'pending'}
            >
              {status === 'pending' ? 'Connecting…' : 'Continue with Porto'}
            </Button>
            {error && <p className="text-destructive text-sm">{error.message}</p>}
          </>
        )}
      </div>
    </main>
  )
}
