'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { encodeFunctionData, formatUnits, parseUnits } from 'viem';
import type { Address, Hex } from 'viem';
import {
  useAccount,
  useConnect,
  useConnectors,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useSendCalls,
  useWaitForCallsStatus,
} from 'wagmi';
import { Button } from '@/components/ui/button';

const USDC: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const COMET_USDC: Address = '0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e';
const COMET_REWARDS: Address = '0x8bF5b658bdF0388E8b482ED51B14aef58f90abfD';
const COMP: Address = '0xA6c8D1c55951e8AC44a0EaA959Be5Fd21cc07531';
const MAX_UINT256 = BigInt(
  '115792089237316195423570985008687907853269984665640564039457584007913129639935'
);
const ZERO = BigInt(0);
const ETHERSCAN = 'https://sepolia.etherscan.io';

const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const cometAbi = [
  {
    type: 'function',
    name: 'supply',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const cometRewardsAbi = [
  {
    type: 'function',
    name: 'getRewardOwed',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'comet', type: 'address' },
      { name: 'account', type: 'address' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'owed', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'comet', type: 'address' },
      { name: 'src', type: 'address' },
      { name: 'shouldAccrue', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

// Extended Comet ABI for client-side reward calculation
const cometAccrualAbi = [
  {
    type: 'function',
    name: 'userBasic',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'principal', type: 'int104' },
      { name: 'baseTrackingIndex', type: 'uint64' },
      { name: 'baseTrackingAccrued', type: 'uint64' },
      { name: 'assetsIn', type: 'uint16' },
      { name: '_reserved', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'totalsBasic',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'baseSupplyIndex', type: 'uint64' },
      { name: 'baseBorrowIndex', type: 'uint64' },
      { name: 'trackingSupplyIndex', type: 'uint64' },
      { name: 'trackingBorrowIndex', type: 'uint64' },
      { name: 'totalSupplyBase', type: 'uint104' },
      { name: 'totalBorrowBase', type: 'uint104' },
      { name: 'lastAccrualTime', type: 'uint40' },
      { name: 'pauseFlags', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'baseTrackingSupplySpeed',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'trackingIndexScale',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'baseIndexScale',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'baseScale',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export default function CompoundDepositPage() {
  const { address, isConnected } = useAccount();
  const { connect, status: connectStatus, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const connectors = useConnectors();
  const portoConnector = connectors[0];

  const [amount, setAmount] = useState('1');
  const [bundleId, setBundleId] = useState<Hex | null>(null);
  const [claimId, setClaimId] = useState<Hex | null>(null);
  const [claimLogs, setClaimLogs] = useState<string[]>([]);

  function logClaim(line: string) {
    const stamp = new Date().toISOString().slice(11, 23);
    const entry = `[${stamp}] ${line}`;
    console.log('[compound-deposit]', entry);
    setClaimLogs((prev) => [...prev, entry]);
  }

  const sendCalls = useSendCalls();
  const callsStatus = useWaitForCallsStatus({ id: bundleId ?? undefined });
  const claimCalls = useSendCalls();
  const claimStatus = useWaitForCallsStatus({ id: claimId ?? undefined });

  const usdcBal = useReadContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const allowance = useReadContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, COMET_USDC] : undefined,
    query: { enabled: !!address },
  });

  const supplied = useReadContract({
    address: COMET_USDC,
    abi: cometAbi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const compBal = useReadContract({
    address: COMP,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Batch-read all data needed for client-side reward accrual calculation.
  // getRewardOwed is nonpayable and eth_call skips accrue, returning 0 — so we compute manually.
  const accrualReads = useReadContracts({
    contracts: address
      ? [
          { address: COMET_USDC, abi: cometAccrualAbi, functionName: 'userBasic', args: [address] },
          { address: COMET_USDC, abi: cometAccrualAbi, functionName: 'totalsBasic' },
          { address: COMET_USDC, abi: cometAccrualAbi, functionName: 'baseTrackingSupplySpeed' },
          { address: COMET_USDC, abi: cometAccrualAbi, functionName: 'trackingIndexScale' },
          { address: COMET_USDC, abi: cometAccrualAbi, functionName: 'baseIndexScale' },
          { address: COMET_USDC, abi: cometAccrualAbi, functionName: 'baseScale' },
        ]
      : [],
    query: { enabled: !!address },
  });

  function refetchAll() {
    usdcBal.refetch();
    allowance.refetch();
    supplied.refetch();
    compBal.refetch();
    accrualReads.refetch();
  }

  async function handleSupply() {
    if (!address) return;
    let parsedAmount: bigint;
    try {
      parsedAmount = parseUnits(amount, 6);
    } catch {
      toast.error('Invalid amount');
      return;
    }
    if (parsedAmount === ZERO) {
      toast.error('Amount must be > 0');
      return;
    }
    if (usdcBal.data !== undefined && parsedAmount > usdcBal.data) {
      toast.error('Insufficient USDC balance');
      return;
    }
    const needsApprove = (allowance.data ?? ZERO) < parsedAmount;
    const calls: { to: Address; data: Hex }[] = [];
    if (needsApprove) {
      calls.push({
        to: USDC,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [COMET_USDC, MAX_UINT256],
        }),
      });
    }
    calls.push({
      to: COMET_USDC,
      data: encodeFunctionData({
        abi: cometAbi,
        functionName: 'supply',
        args: [USDC, parsedAmount],
      }),
    });

    try {
      const res = await sendCalls.mutateAsync({ calls });
      setBundleId(res.id as Hex);
      toast.success('Submitted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'send failed';
      toast.error(msg);
    }
  }

  async function handleClaim() {
    if (!address) return;
    setClaimLogs([]);
    logClaim(`=== CLAIM START ===`);
    logClaim(`account=${address} comet=${COMET_USDC} cometRewards=${COMET_REWARDS}`);
    logClaim(`PRE-claim displayed projection: ${rewardOwedDisplay} COMP`);
    logClaim(`PRE-claim onchain compBalance: ${formatUnits(compBal.data ?? ZERO, 18)} COMP`);

    const callData = encodeFunctionData({
      abi: cometRewardsAbi,
      functionName: 'claim',
      args: [COMET_USDC, address, true],
    });
    logClaim(`calldata: ${callData}`);

    try {
      const t0 = Date.now();
      const res = await claimCalls.mutateAsync({
        calls: [{ to: COMET_REWARDS, data: callData }],
      });
      logClaim(`mutateAsync returned (${Date.now() - t0}ms): bundleId=${res.id}`);
      setClaimId(res.id as Hex);
      toast.success('Claim submitted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'claim failed';
      const stack = err instanceof Error ? err.stack ?? '' : '';
      logClaim(`mutateAsync ERROR: ${msg}`);
      if (stack) logClaim(`stack: ${stack.slice(0, 1000)}`);
      toast.error(msg);
    }
  }

  // When bundle confirms, log full status (status code + receipts + tx hash + transferred logs).
  useEffect(() => {
    if (claimStatus.data?.status !== 'success' || !claimId) return;
    const data = claimStatus.data;
    const receipt = data.receipts?.[0];
    const txHash = receipt?.transactionHash;
    const compTransfer = receipt?.logs?.find(
      (l) =>
        l.address.toLowerCase() === COMP.toLowerCase() &&
        l.topics?.[0] ===
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
        l.topics?.[2]?.toLowerCase() ===
          `0x000000000000000000000000${address?.slice(2).toLowerCase()}`
    );
    const transferred = compTransfer ? BigInt(compTransfer.data ?? '0x0') : BigInt(0);
    logClaim(
      `bundle confirmed status=${data.status} statusCode=${(data as { statusCode?: number }).statusCode ?? '?'}`
    );
    if (txHash) logClaim(`tx: ${ETHERSCAN}/tx/${txHash}`);
    logClaim(
      `COMP Transfer to ${address}: ${formatUnits(transferred, 18)} COMP (raw=${transferred})`
    );
    if (transferred === BigInt(0)) {
      logClaim(
        `NOTE: Zero COMP transferred. CometRewards.claim was no-op (owed=0). Possible reasons: principal too small, already-claimed accrual, projection bug in UI.`
      );
    }
    refetchAll();
    setClaimId(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: claim diagnostics fire once per claim cycle
  }, [claimStatus.data?.status, claimId]);

  // Must be before any early return to satisfy Rules of Hooks
  const rewardOwedDisplay = useMemo(() => {
    const [userBasicRes, totalsRes, speedRes, trackScaleRes, baseIdxScaleRes, baseScaleRes] =
      accrualReads.data ?? [];
    if (
      !userBasicRes?.result ||
      !totalsRes?.result ||
      !speedRes?.result ||
      !trackScaleRes?.result ||
      !baseIdxScaleRes?.result ||
      !baseScaleRes?.result
    )
      return '0';

    // viem returns tuple arrays for multi-output functions
    const ubArr = userBasicRes.result as readonly (bigint | number)[];
    const tbArr = totalsRes.result as readonly (bigint | number)[];

    const supplySpeed = BigInt(speedRes.result as bigint | number);
    const trackingIndexScale = BigInt(trackScaleRes.result as bigint | number);
    const baseIndexScale = BigInt(baseIdxScaleRes.result as bigint | number);
    const baseScale = BigInt(baseScaleRes.result as bigint | number);
    // userBasic: [principal, baseTrackingIndex, baseTrackingAccrued, assetsIn, _reserved]
    const principal = BigInt(ubArr[0]);
    const baseTrackingIndex = BigInt(ubArr[1]);
    const baseTrackingAccrued = BigInt(ubArr[2]);
    // totalsBasic: [baseSupplyIndex, baseBorrowIndex, trackingSupplyIndex, trackingBorrowIndex, totalSupplyBase, totalBorrowBase, lastAccrualTime, pauseFlags]
    const baseSupplyIndex = BigInt(tbArr[0]);
    const trackingSupplyIndex = BigInt(tbArr[2]);
    const totalSupplyBase = BigInt(tbArr[4]);
    const lastAccrualTime = BigInt(tbArr[6]);

    if (principal <= BigInt(0) || totalSupplyBase === BigInt(0) || trackingIndexScale === BigInt(0))
      return '0';

    // Project trackingSupplyIndex forward to now. Comet.accrueInternal:
    //   trackingSupplyIndex += divBaseWei(baseTrackingSupplySpeed * timeElapsed, totalSupplyBase)
    //   divBaseWei(n, base) = n * baseScale / base
    // baseScale = 10^baseToken.decimals (1e6 for USDC), NOT baseIndexScale (1e15).
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const elapsed = nowSec > lastAccrualTime ? nowSec - lastAccrualTime : BigInt(0);
    const projectedTrackingIndex =
      trackingSupplyIndex + (supplySpeed * elapsed * baseScale) / totalSupplyBase;

    // Index delta since user last accrued
    const indexDelta =
      projectedTrackingIndex > baseTrackingIndex
        ? projectedTrackingIndex - baseTrackingIndex
        : BigInt(0);

    // Present value of principal (microUSDC). Uses baseIndexScale here (correct).
    const presentPrincipal = (principal * baseSupplyIndex) / baseIndexScale;

    // New baseTrackingAccrued units
    const newAccrued = (presentPrincipal * indexDelta) / trackingIndexScale;
    const totalAccrued = baseTrackingAccrued + newAccrued;

    // rescaleFactor = 1e12, shouldUpscale = true → multiply
    const owedWei = totalAccrued * BigInt('1000000000000');
    return formatUnits(owedWei, 18);
  }, [accrualReads.data]);

  if (callsStatus.data?.status === 'success' && bundleId) {
    setTimeout(() => {
      refetchAll();
      setBundleId(null);
    }, 0);
  }

  if (!isConnected) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-semibold">Compound V3 Deposit</h1>
          <p className="text-muted-foreground max-w-md text-center text-sm">
            Connect Porto on Sepolia, deposit USDC into cUSDCv3 to start earning COMP rewards.
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

  const usdcDisplay = usdcBal.data !== undefined ? formatUnits(usdcBal.data, 6) : '…';
  const suppliedDisplay = supplied.data !== undefined ? formatUnits(supplied.data, 6) : '…';
  const compDisplay = compBal.data !== undefined ? formatUnits(compBal.data, 18) : '…';

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Compound V3 Deposit</h1>
        <p className="font-mono text-xs break-all">Account: {address}</p>
        <Button variant="outline" size="sm" className="self-start" onClick={() => disconnect()}>
          Sign out
        </Button>
      </header>

      <section className="grid grid-cols-2 gap-3 rounded-md border p-4 text-sm md:grid-cols-4">
        <Stat label="USDC wallet" value={usdcDisplay} />
        <Stat label="USDC supplied" value={suppliedDisplay} />
        <Stat label="COMP wallet" value={compDisplay} />
        <Stat label="COMP owed" value={rewardOwedDisplay} />
      </section>

      <section className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="text-lg font-medium">Deposit USDC into cUSDCv3</h2>
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.000001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="flex-1 rounded-md border bg-transparent px-3 py-2 font-mono text-sm"
            placeholder="USDC amount"
          />
          <Button
            onClick={handleSupply}
            disabled={sendCalls.isPending || (!!bundleId && callsStatus.data?.status !== 'success')}
          >
            {sendCalls.isPending
              ? 'Signing…'
              : bundleId && callsStatus.data?.status !== 'success'
                ? 'Pending…'
                : 'Deposit'}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Bundles ERC-20 approve (if needed) + Comet.supply in a single Porto call.
        </p>
        {sendCalls.error && (
          <p className="text-destructive text-xs break-all">{sendCalls.error.message}</p>
        )}
        {bundleId && (
          <p className="text-xs break-all">
            Bundle:{' '}
            <a
              className="underline"
              href={`${ETHERSCAN}/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {bundleId}
            </a>{' '}
            · status: {callsStatus.data?.status ?? 'submitted'}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="text-lg font-medium">Position</h2>
        <Row label="Supplied USDC (cUSDCv3 base balance)" value={`${suppliedDisplay} USDC`} />
        <Row label="Pending COMP rewards" value={`${rewardOwedDisplay} COMP`} />
        <Row label="COMP in wallet" value={`${compDisplay} COMP`} />
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            onClick={handleClaim}
            disabled={claimCalls.isPending || (!!claimId && claimStatus.data?.status !== 'success')}
          >
            {claimCalls.isPending
              ? 'Signing…'
              : claimId && claimStatus.data?.status !== 'success'
                ? 'Claiming…'
                : 'Claim COMP'}
          </Button>
          <Button variant="outline" size="sm" onClick={refetchAll}>
            Refresh
          </Button>
        </div>
        {claimCalls.error && (
          <p className="text-destructive text-xs break-all">{claimCalls.error.message}</p>
        )}
        {claimId && claimStatus.data?.status !== 'success' && (
          <p className="text-xs break-all">Claim pending · {claimStatus.data?.status ?? 'submitted'}</p>
        )}
        <a
          className="text-xs underline"
          href={`${ETHERSCAN}/address/${address}#tokentxns`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View token transfers on Etherscan →
        </a>
      </section>

      {claimLogs.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-medium">Claim Diagnostics</h2>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(claimLogs.join('\n'));
                  toast.success('Logs copied');
                }}
              >
                Copy logs
              </Button>
              <Button size="sm" variant="outline" onClick={() => setClaimLogs([])}>
                Clear
              </Button>
            </div>
          </div>
          <pre className="max-h-96 overflow-auto rounded-md bg-black/80 p-3 font-mono text-[10px] text-green-300 whitespace-pre-wrap break-all">
            {claimLogs.join('\n')}
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b py-1 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}
