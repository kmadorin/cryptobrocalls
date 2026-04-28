'use client';

import { useGrantPermissions } from 'porto/wagmi/Hooks';
import { useState } from 'react';
import { toast } from 'sonner';
import { parseEther, parseUnits } from 'viem';
import type { Address, Hex } from 'viem';
import { useAccount, useConnect, useConnectors, useDisconnect } from 'wagmi';
import { Button } from '@/components/ui/button';

const SEPOLIA = 11_155_111;
const SEPOLIA_HEX = `0x${SEPOLIA.toString(16)}`; // 0xaa36a7
const PORTO_RPC = 'https://rpc.porto.sh';

const COMP: Address = '0xA6c8D1c55951e8AC44a0EaA959Be5Fd21cc07531';
const USDC: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const COMET_USDC: Address = '0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e';
const COMET_REWARDS: Address = '0x8bF5b658bdF0388E8b482ED51B14aef58f90abfD';
const SWAP_ROUTER02: Address = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E';

const WORKFLOW_ID = 'dtfc9u39mkgq0h3yy5apr';
const DEFAULT_KH_SIGNER =
  process.env.NEXT_PUBLIC_KH_SIGNER ?? '0x8aa4Cc3b82173C5Ed03597dBF6CbD1e7AB2fF7CE';

const ETHERSCAN = 'https://sepolia.etherscan.io';
const KH_BASE = process.env.NEXT_PUBLIC_KH_BASE_URL ?? 'http://localhost:5347';

function jsonStringify(obj: unknown): string {
  return JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

async function portoRpc(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(PORTO_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return r.json();
}

export default function DemoWorkflowPage() {
  const { address, isConnected } = useAccount();
  const { connect, status: connectStatus, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const connectors = useConnectors();
  const portoConnector = connectors[0];

  const [khSigner, setKhSigner] = useState(DEFAULT_KH_SIGNER);
  const [permissionsId, setPermissionsId] = useState<Hex | null>(null);
  const [grantedKey, setGrantedKey] = useState<Hex | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const grant = useGrantPermissions();

  function log(line: string) {
    const stamp = new Date().toISOString().slice(11, 23);
    const entry = `[${stamp}] ${line}`;
    console.log('[demo-workflow]', entry);
    setLogs((prev) => [...prev, entry]);
  }

  async function logRpc(label: string, method: string, params: unknown[]) {
    try {
      const t0 = Date.now();
      const res = await portoRpc(method, params);
      const dt = Date.now() - t0;
      log(`${label} ${method} (${dt}ms): ${jsonStringify(res)}`);
      return res;
    } catch (e) {
      log(`${label} ${method} ERROR: ${(e as Error).message}`);
      return null;
    }
  }

  async function handleGrant() {
    setGrantError(null);
    setPermissionsId(null);
    setGrantedKey(null);
    setLogs([]);

    if (!/^0x[0-9a-fA-F]{40}$/.test(khSigner)) {
      toast.error('Invalid KH signer address');
      return;
    }

    log(`=== grantPermissions START ===`);
    log(`userPorto=${address} chainId=${SEPOLIA} (${SEPOLIA_HEX})`);
    log(`khSigner=${khSigner}`);

    // Pre-grant snapshot
    log('--- PRE-GRANT state ---');
    await logRpc('PRE', 'wallet_getKeys', [
      { address: address as string, chainId: SEPOLIA_HEX },
    ]);
    await logRpc('PRE', 'wallet_getCallsHistory', [
      { address: address as string, limit: 3, sort: 'desc' },
    ]);

    const params = {
      chainId: SEPOLIA as 11155111,
      expiry: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      feeToken: { limit: '0.05' as const, symbol: 'ETH' },
      key: { type: 'secp256k1' as const, publicKey: khSigner.toLowerCase() as Hex },
      permissions: {
        calls: [
          { to: COMP, signature: 'approve(address,uint256)' },
          { to: USDC, signature: 'approve(address,uint256)' },
          { to: COMET_REWARDS, signature: 'claim(address,address,bool)' },
          {
            to: SWAP_ROUTER02,
            signature:
              'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
          },
          { to: COMET_USDC, signature: 'supply(address,uint256)' },
        ],
        spend: [
          { token: COMP, limit: parseEther('100'), period: 'day' as const },
          { token: USDC, limit: parseUnits('10000', 6), period: 'day' as const },
        ],
      },
    };
    log(`mutateAsync params: ${jsonStringify(params)}`);

    try {
      const t0 = Date.now();
      log('calling useGrantPermissions.mutateAsync — Porto dialog should open now');
      const result = await grant.mutateAsync(params);
      const dt = Date.now() - t0;
      log(`mutateAsync returned (${dt}ms): ${jsonStringify(result)}`);

      const id = (result as { id: Hex }).id;
      const key = (result as { key: { publicKey: string } }).key;
      setPermissionsId(id);
      setGrantedKey(key.publicKey as Hex);
      log(`permissionsId=${id}`);
      log(`granted key.publicKey=${key.publicKey}`);
      toast.success('Permission granted (relay-side)');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'grant failed';
      const stack = err instanceof Error ? err.stack ?? '' : '';
      log(`mutateAsync ERROR: ${msg}`);
      if (stack) log(`stack: ${stack.slice(0, 1500)}`);
      setGrantError(msg);
      toast.error(msg);
      return;
    }

    // Post-grant: re-query in case relay surfaces precall-staged keys
    log('--- POST-GRANT state (waiting 2s for relay propagation) ---');
    await new Promise((r) => setTimeout(r, 2000));
    await logRpc('POST', 'wallet_getKeys', [
      { address: address as string, chainId: SEPOLIA_HEX },
    ]);
    await logRpc('POST', 'wallet_getCallsHistory', [
      { address: address as string, limit: 3, sort: 'desc' },
    ]);

    log('=== END ===');
    log('NOTE: secp256k1 key may NOT appear in wallet_getKeys until first use.');
    log('Grant uses preCall=true. Precall is signed + stored at relay, included in next tx.');
    log('To force on-chain registration, run KH workflow once or trigger any session-key call.');
  }

  async function handleVerify() {
    if (!address) {
      toast.error('Not connected');
      return;
    }
    log('=== verify state ===');
    await logRpc('VERIFY', 'wallet_getKeys', [
      { address: address as string, chainId: SEPOLIA_HEX },
    ]);
    await logRpc('VERIFY', 'wallet_getCallsHistory', [
      { address: address as string, limit: 5, sort: 'desc' },
    ]);
  }

  async function handleCopy(value: string) {
    await navigator.clipboard.writeText(value);
    toast.success('Copied');
  }

  if (!isConnected) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-semibold">Demo: Auto-Compound COMP</h1>
          <p className="text-muted-foreground max-w-md text-center text-sm">
            Connect Porto on Sepolia, then grant a session-key permission to the KeeperHub signer.
            The KH workflow {WORKFLOW_ID} will auto-claim/swap/supply COMP rewards on your behalf.
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
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Demo: Auto-Compound COMP Rewards</h1>
        <p className="font-mono text-xs break-all">User Porto: {address}</p>
        <Button variant="outline" size="sm" className="self-start" onClick={() => disconnect()}>
          Sign out
        </Button>
      </header>

      <section className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="text-lg font-medium">1. KeeperHub signer (session key public key)</h2>
        <p className="text-muted-foreground text-xs">
          Turnkey EOA address used by KH workflow to sign Porto-relayed calls. Default from{' '}
          <code className="font-mono">NEXT_PUBLIC_KH_SIGNER</code>.
        </p>
        <input
          value={khSigner}
          onChange={(e) => setKhSigner(e.target.value)}
          className="rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
          placeholder="0x..."
        />
      </section>

      <section className="flex flex-col gap-3 rounded-md border p-4">
        <h2 className="text-lg font-medium">2. Grant permission</h2>
        <ul className="text-muted-foreground list-disc pl-5 text-xs">
          <li>30-day expiry, fee token: ETH (0.05 cap)</li>
          <li>
            calls: COMP/USDC.approve, CometRewards.claim, SwapRouter02.exactInputSingle,
            cUSDCv3.supply
          </li>
          <li>spend caps: 100 COMP/day, 10 000 USDC/day</li>
        </ul>
        <div className="flex gap-2">
          <Button onClick={handleGrant} disabled={grant.isPending}>
            {grant.isPending ? 'Check Porto dialog…' : 'Grant permission'}
          </Button>
          <Button variant="outline" onClick={handleVerify}>
            Re-query state
          </Button>
        </div>
        {grantError && <p className="text-destructive text-xs break-all">{grantError}</p>}
      </section>

      {logs.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <div className="flex items-center justify-between gap-2">
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
                Copy logs
              </Button>
              <Button size="sm" variant="outline" onClick={() => setLogs([])}>
                Clear
              </Button>
            </div>
          </div>
          <pre className="max-h-[32rem] overflow-auto rounded-md bg-black/80 p-3 font-mono text-[10px] text-green-300 whitespace-pre-wrap break-all">
            {logs.join('\n')}
          </pre>
        </section>
      )}

      {permissionsId && (
        <section className="flex flex-col gap-3 rounded-md border p-4">
          <h2 className="text-lg font-medium">3. Patch into workflow {WORKFLOW_ID}</h2>
          <p className="text-muted-foreground text-xs">
            Update placeholders in every <code className="font-mono">porto/execute-call</code> node
            (and user-address fields in owed/compBal/usdcBal/swap recipient).
          </p>
          <Field label="userPortoAddress" value={address ?? ''} onCopy={handleCopy} />
          <Field label="permissionsId" value={permissionsId} onCopy={handleCopy} />
          {grantedKey && (
            <Field label="grantedKey.publicKey" value={grantedKey} onCopy={handleCopy} />
          )}
          <a
            className="text-xs underline"
            href={`${KH_BASE}/workflows/${WORKFLOW_ID}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open workflow in KeeperHub →
          </a>
          <a
            className="text-xs underline"
            href={`${ETHERSCAN}/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Porto smart account on Etherscan →
          </a>
        </section>
      )}
    </main>
  );
}

function Field({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-40 shrink-0 text-xs">{label}</span>
      <code className="flex-1 rounded-md border px-2 py-1 font-mono text-xs break-all">
        {value}
      </code>
      <Button size="sm" variant="outline" onClick={() => onCopy(value)}>
        Copy
      </Button>
    </div>
  );
}
