'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  parseEther,
  parseUnits,
} from 'viem';
import type { Address, Hex } from 'viem';
import {
  useAccount,
  useBalance,
  useConnect,
  useConnectors,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useSendCalls,
  useWaitForCallsStatus,
} from 'wagmi';
import { Button } from '@/components/ui/button';

const WETH: Address = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14';
const USDC: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const SWAP_ROUTER02: Address = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E';
const POOL_500: Address = '0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1';
const ETHERSCAN = 'https://sepolia.etherscan.io';

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

const FEE_TIER = 500;
const SLIPPAGE_BPS = BigInt(100); // 1%

export default function UniswapSwapPage() {
  const { address, isConnected } = useAccount();
  const { connect, status: connectStatus, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const connectors = useConnectors();
  const portoConnector = connectors[0];

  const [amountEth, setAmountEth] = useState('0.001');
  const [bundleId, setBundleId] = useState<Hex | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const sendCalls = useSendCalls();
  const callsStatus = useWaitForCallsStatus({ id: bundleId ?? undefined });

  function log(line: string) {
    const stamp = new Date().toISOString().slice(11, 23);
    setLogs((prev) => [...prev, `[${stamp}] ${line}`]);
    console.log('[uniswap-swap]', line);
  }

  const ethBal = useBalance({ address, query: { enabled: !!address } });
  const usdcBal = useReadContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const poolReads = useReadContracts({
    contracts: [
      { address: POOL_500, abi: POOL_ABI, functionName: 'slot0' },
      { address: POOL_500, abi: POOL_ABI, functionName: 'token0' },
    ],
  });

  // Spot price ETH→USDC from sqrtPriceX96
  const priceUsdcPerEth = useMemo(() => {
    const slot0 = poolReads.data?.[0]?.result;
    const token0 = poolReads.data?.[1]?.result as Address | undefined;
    if (!slot0 || !token0) return null;
    const sqrtPriceX96 = (slot0 as readonly bigint[])[0] as bigint;
    // price (token1 in terms of token0) = (sqrtPriceX96 / 2^96)^2
    // adjust for token decimals + ordering
    const Q96 = BigInt(1) << BigInt(96);
    const numerator = sqrtPriceX96 * sqrtPriceX96;
    const denom = Q96 * Q96;
    // raw price = token1/token0 (raw units)
    // token0 = USDC (6 decimals) since 0x1c < 0xff (alphabetical < check)
    const isUsdcToken0 = token0.toLowerCase() === USDC.toLowerCase();
    if (isUsdcToken0) {
      // price_token1_per_token0 = WETH per USDC (raw) = sqrtPrice^2 / 2^192
      // 1 USDC (1e6 raw) = price * 1e6 raw WETH => to get USDC per ETH, invert
      // WETH per USDC = numerator / denom
      // Adjust: WETH (1e18 raw) per USDC (1e6 raw)
      // human WETH per USDC = (numerator * 1e6) / (denom * 1e18) ... compute as ratio
      // Easier: USDC per ETH = denom * 1e18 / (numerator * 1e6)
      const usdcPerEth = (denom * BigInt(10) ** BigInt(18)) / (numerator * BigInt(10) ** BigInt(6));
      return Number(usdcPerEth);
    }
    // token0 = WETH; price_token1_per_token0 = USDC per WETH (raw)
    // human USDC per ETH = numerator * 1e18 / (denom * 1e6)
    const usdcPerEth = (numerator * BigInt(10) ** BigInt(18)) / (denom * BigInt(10) ** BigInt(6));
    return Number(usdcPerEth);
  }, [poolReads.data]);

  function refetchAll() {
    ethBal.refetch();
    usdcBal.refetch();
    poolReads.refetch();
  }

  async function handleSwap() {
    if (!address) return;
    setLogs([]);
    log(`=== SWAP START ===`);
    log(`account=${address} pool=${POOL_500} fee=${FEE_TIER}`);

    let amountIn: bigint;
    try {
      amountIn = parseEther(amountEth);
    } catch {
      toast.error('Invalid ETH amount');
      return;
    }
    if (amountIn === BigInt(0)) {
      toast.error('Amount must be > 0');
      return;
    }
    if (ethBal.data && amountIn > ethBal.data.value) {
      toast.error('Insufficient ETH');
      return;
    }

    // Quote: use spot price for amountOutMinimum
    if (priceUsdcPerEth === null) {
      toast.error('Pool price unavailable');
      return;
    }
    const expectedOutHuman = (Number(amountEth) * priceUsdcPerEth);
    const minOut = parseUnits(
      ((expectedOutHuman * (1 - Number(SLIPPAGE_BPS) / 10000)).toFixed(6)),
      6
    );
    log(`amountIn=${amountIn} (${amountEth} ETH)`);
    log(`spot price: 1 ETH ≈ ${priceUsdcPerEth.toFixed(2)} USDC`);
    log(`amountOutMin (1% slippage): ${minOut} (${formatUnits(minOut, 6)} USDC)`);

    const callData = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: WETH,
          tokenOut: USDC,
          fee: FEE_TIER,
          recipient: address,
          amountIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: BigInt(0),
        },
      ],
    });
    log(`calldata: ${callData.slice(0, 80)}…`);

    try {
      const t0 = Date.now();
      const res = await sendCalls.mutateAsync({
        calls: [
          {
            to: SWAP_ROUTER02,
            data: callData,
            value: amountIn,
          },
        ],
      });
      log(`mutateAsync returned (${Date.now() - t0}ms): bundleId=${res.id}`);
      setBundleId(res.id as Hex);
      toast.success('Swap submitted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'swap failed';
      log(`mutateAsync ERROR: ${msg}`);
      toast.error(msg);
    }
  }

  useEffect(() => {
    if (callsStatus.data?.status !== 'success' || !bundleId) return;
    const data = callsStatus.data;
    const receipt = data.receipts?.[0];
    log(`bundle confirmed status=${data.status}`);
    if (receipt?.transactionHash) {
      log(`tx: ${ETHERSCAN}/tx/${receipt.transactionHash}`);
    }
    const usdcTransfer = receipt?.logs?.find(
      (l) =>
        l.address.toLowerCase() === USDC.toLowerCase() &&
        l.topics?.[0] ===
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
        l.topics?.[2]?.toLowerCase() ===
          `0x000000000000000000000000${address?.slice(2).toLowerCase()}`
    );
    const out = usdcTransfer ? BigInt(usdcTransfer.data ?? '0x0') : BigInt(0);
    log(`USDC received: ${formatUnits(out, 6)} USDC (raw=${out})`);
    refetchAll();
    setBundleId(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per swap
  }, [callsStatus.data?.status, bundleId]);

  if (!isConnected) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-semibold">Uniswap V3 — ETH → USDC (Sepolia)</h1>
          <p className="text-muted-foreground max-w-md text-center text-sm">
            Connect Porto, swap native ETH for USDC via Uniswap V3 on Sepolia (0.05% pool).
          </p>
          <Button
            onClick={() => portoConnector && connect({ connector: portoConnector })}
            disabled={!portoConnector || connectStatus === 'pending'}
          >
            {connectStatus === 'pending' ? 'Connecting…' : 'Continue with Porto'}
          </Button>
          {connectError && <p className="text-destructive text-sm">{connectError.message}</p>}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Uniswap V3 — ETH → USDC</h1>
        <p className="font-mono text-xs break-all">Account: {address}</p>
        <Button variant="outline" size="sm" className="self-start" onClick={() => disconnect()}>
          Sign out
        </Button>
      </header>

      <section className="grid grid-cols-2 gap-4 rounded-md border p-4 text-sm">
        <Stat
          label="ETH balance"
          value={ethBal.data ? `${formatEther(ethBal.data.value)} ETH` : '—'}
        />
        <Stat
          label="USDC balance"
          value={usdcBal.data !== undefined ? `${formatUnits(usdcBal.data, 6)} USDC` : '—'}
        />
        <Stat
          label="Spot 1 ETH ≈"
          value={priceUsdcPerEth !== null ? `${priceUsdcPerEth.toFixed(2)} USDC` : '—'}
        />
        <Stat label="Pool fee" value={`${FEE_TIER / 10000}%`} />
      </section>

      <section className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="text-lg font-medium">Swap</h2>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Amount (ETH)</span>
          <input
            type="text"
            value={amountEth}
            onChange={(e) => setAmountEth(e.target.value)}
            className="rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
            placeholder="0.001"
          />
        </label>
        <p className="text-muted-foreground text-xs">
          Slippage: {Number(SLIPPAGE_BPS) / 100}%. Native ETH auto-wrapped by SwapRouter02
          (msg.value).
        </p>
        <Button
          onClick={handleSwap}
          disabled={sendCalls.isPending || (!!bundleId && callsStatus.data?.status !== 'success')}
        >
          {sendCalls.isPending
            ? 'Signing…'
            : bundleId && callsStatus.data?.status !== 'success'
              ? 'Swapping…'
              : `Swap ${amountEth} ETH → USDC`}
        </Button>
        {sendCalls.error && (
          <p className="text-destructive text-xs break-all">{sendCalls.error.message}</p>
        )}
        {bundleId && (
          <p className="text-xs break-all">
            Bundle: <code className="font-mono">{bundleId}</code> · status:{' '}
            {callsStatus.data?.status ?? 'submitted'}
          </p>
        )}
      </section>

      {logs.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Diagnostics</h2>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(logs.join('\n'));
                  toast.success('Logs copied');
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="outline" onClick={() => setLogs([])}>
                Clear
              </Button>
            </div>
          </div>
          <pre className="max-h-96 overflow-auto rounded-md bg-black/80 p-3 font-mono text-[10px] text-green-300 whitespace-pre-wrap break-all">
            {logs.join('\n')}
          </pre>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs uppercase tracking-wider">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}
