'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Address } from 'viem';
import {
  useAccount,
  useConnect,
  useConnectors,
  useDisconnect,
  usePublicClient,
  useWalletClient,
} from 'wagmi';
import { Button } from '@/components/ui/button';
import {
  KEEPER_EOA,
  ROLE_KEY,
  type SafeRecord,
  appendDeployedSafe,
  configureRole,
  deployRolesModifier,
  deploySafeWithPortoOwner,
  getSafeNonce,
  loadDeployedSafes,
  runNoOpSafeTx,
  updateDeployedSafe,
  verifySafeOwners,
} from '@/lib/safe';

const ETHERSCAN = 'https://sepolia.etherscan.io';

export default function SafeSmokePage() {
  const { address, isConnected } = useAccount();
  const { connect, status: connectStatus, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const connectors = useConnectors();
  const portoConnector = connectors[0];

  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [deploying, setDeploying] = useState(false);
  const [records, setRecords] = useState<SafeRecord[]>([]);
  const [verifications, setVerifications] = useState<Record<string, string>>({});
  const [noopStatus, setNoopStatus] = useState<Record<string, string>>({});
  const [noopBusy, setNoopBusy] = useState<Record<string, boolean>>({});
  const [importAddr, setImportAddr] = useState('');
  const [nonces, setNonces] = useState<Record<string, bigint>>({});
  const [rolesBusy, setRolesBusy] = useState<Record<string, string>>({});
  const [rolesStatus, setRolesStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!address) {
      setRecords([]);
      return;
    }
    setRecords(loadDeployedSafes(address));
  }, [address]);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      for (const r of records) {
        try {
          const code = await publicClient.getCode({ address: r.address });
          if (cancelled) return;
          if (!code || code === '0x') {
            setNoopStatus((p) => ({
              ...p,
              [r.address]: 'no contract code at address',
            }));
            continue;
          }
          const n = await getSafeNonce(publicClient, r.address);
          if (cancelled) return;
          setNonces((p) => ({ ...p, [r.address]: n }));
        } catch (err) {
          if (cancelled) return;
          setNoopStatus((p) => ({
            ...p,
            [r.address]: `nonce read failed: ${err instanceof Error ? err.message : 'error'}`,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [records, publicClient]);

  async function handleDeploy() {
    if (!walletClient || !publicClient || !address) {
      toast.error('Wallet not ready');
      return;
    }
    setDeploying(true);
    try {
      const record = await deploySafeWithPortoOwner({
        walletClient,
        publicClient,
        ownerAddress: address,
      });
      appendDeployedSafe(address, record);
      setRecords((prev) => [record, ...prev]);
      toast.success(`Safe deployed: ${record.address.slice(0, 10)}…`);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  }

  function handleImport() {
    if (!address) return;
    const v = importAddr.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(v)) {
      toast.error('Invalid address');
      return;
    }
    const record: SafeRecord = {
      address: v as Address,
      txHash: '0x' as `0x${string}`,
      ownerAtDeploy: address,
      saltNonce: 'imported',
      deployedAt: Date.now(),
    };
    appendDeployedSafe(address, record);
    setRecords((prev) => [record, ...prev]);
    setImportAddr('');
  }

  async function handleNoOp(safeAddress: Address) {
    if (!walletClient || !publicClient || !address) {
      toast.error('Wallet not ready');
      return;
    }
    const cachedNonce = nonces[safeAddress];
    if (cachedNonce === undefined) {
      toast.error('Nonce not loaded yet — wait a moment');
      return;
    }
    setNoopBusy((p) => ({ ...p, [safeAddress]: true }));
    setNoopStatus((p) => ({ ...p, [safeAddress]: 'signing + sending…' }));
    try {
      const result = await runNoOpSafeTx({
        walletClient,
        publicClient,
        safeAddress,
        ownerAddress: address,
        safeNonce: cachedNonce,
      });
      setNoopStatus((p) => ({
        ...p,
        [safeAddress]: `ok · nonce ${result.safeNonce} · ${result.txHash}`,
      }));
      toast.success('No-op execTransaction mined');
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'failed';
      setNoopStatus((p) => ({ ...p, [safeAddress]: `error: ${msg}` }));
      toast.error(msg);
    } finally {
      setNoopBusy((p) => ({ ...p, [safeAddress]: false }));
    }
  }

  async function handleDeployModifier(safeAddress: Address) {
    if (!walletClient || !publicClient || !address) {
      toast.error('Wallet not ready');
      return;
    }
    setRolesBusy((p) => ({ ...p, [safeAddress]: 'deploying' }));
    setRolesStatus((p) => ({ ...p, [safeAddress]: 'deploying RolesModifier…' }));
    try {
      const { modifier, txHash } = await deployRolesModifier({
        walletClient,
        publicClient,
        safeAddress,
      });
      updateDeployedSafe(address, safeAddress, { rolesModifier: modifier });
      setRecords((prev) =>
        prev.map((r) =>
          r.address.toLowerCase() === safeAddress.toLowerCase()
            ? { ...r, rolesModifier: modifier }
            : r
        )
      );
      setRolesStatus((p) => ({
        ...p,
        [safeAddress]: `modifier ${modifier} · tx ${txHash}`,
      }));
      toast.success(`Modifier deployed: ${modifier.slice(0, 10)}…`);
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'failed';
      setRolesStatus((p) => ({ ...p, [safeAddress]: `error: ${msg}` }));
      toast.error(msg);
    } finally {
      setRolesBusy((p) => ({ ...p, [safeAddress]: '' }));
    }
  }

  async function handleConfigureRole(safeAddress: Address, modifier: Address) {
    if (!walletClient || !publicClient || !address) {
      toast.error('Wallet not ready');
      return;
    }
    setRolesBusy((p) => ({ ...p, [safeAddress]: 'configuring' }));
    setRolesStatus((p) => ({ ...p, [safeAddress]: 'configuring role…' }));
    try {
      const { txHash } = await configureRole({
        walletClient,
        publicClient,
        safeAddress,
        ownerAddress: address,
        modifierAddress: modifier,
      });
      updateDeployedSafe(address, safeAddress, { roleConfigured: true });
      setRecords((prev) =>
        prev.map((r) =>
          r.address.toLowerCase() === safeAddress.toLowerCase() ? { ...r, roleConfigured: true } : r
        )
      );
      setRolesStatus((p) => ({
        ...p,
        [safeAddress]: `role configured · tx ${txHash}`,
      }));
      toast.success('Role configured');
    } catch (err) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'failed';
      setRolesStatus((p) => ({ ...p, [safeAddress]: `error: ${msg}` }));
      toast.error(msg);
    } finally {
      setRolesBusy((p) => ({ ...p, [safeAddress]: '' }));
    }
  }

  async function handleVerify(safeAddress: Address) {
    if (!publicClient) return;
    setVerifications((p) => ({ ...p, [safeAddress]: 'checking…' }));
    try {
      const owners = await verifySafeOwners(publicClient, safeAddress);
      setVerifications((p) => ({ ...p, [safeAddress]: owners.join(', ') }));
    } catch (err) {
      setVerifications((p) => ({
        ...p,
        [safeAddress]: err instanceof Error ? `error: ${err.message}` : 'error',
      }));
    }
  }

  if (!isConnected) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="flex flex-col items-center gap-4">
          <h1 className="text-2xl font-semibold">Safe Smoke (ST-A)</h1>
          <p className="text-muted-foreground text-sm">
            Connect Porto on Sepolia to deploy a Safe.
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
        <h1 className="text-2xl font-semibold">Safe Smoke (ST-A)</h1>
        <p className="font-mono text-xs break-all">Owner: {address}</p>
        <div className="flex gap-2">
          <Button onClick={handleDeploy} disabled={deploying || !walletClient || !publicClient}>
            {deploying ? 'Deploying…' : 'Deploy new Safe'}
          </Button>
          <Button variant="outline" onClick={() => disconnect()}>
            Sign out
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Import existing Safe</h2>
        <div className="flex gap-2">
          <input
            value={importAddr}
            onChange={(e) => setImportAddr(e.target.value)}
            placeholder="0x… Safe address"
            className="flex-1 rounded-md border bg-transparent px-3 py-1 font-mono text-xs"
          />
          <Button size="sm" variant="outline" onClick={handleImport}>
            Add
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Deployed Safes ({records.length})</h2>
        {records.length === 0 ? (
          <p className="text-muted-foreground text-sm">None yet. Deploy one above.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {records.map((r) => (
              <li key={r.txHash} className="rounded-md border p-3 font-mono text-xs">
                <div className="flex flex-col gap-1">
                  <a
                    className="break-all underline"
                    href={`${ETHERSCAN}/address/${r.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.address}
                  </a>
                  <a
                    className="text-muted-foreground break-all underline"
                    href={`${ETHERSCAN}/tx/${r.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx: {r.txHash}
                  </a>
                  <span className="text-muted-foreground">
                    {new Date(r.deployedAt).toLocaleString()} · salt {r.saltNonce} · nonce{' '}
                    {nonces[r.address] !== undefined ? nonces[r.address].toString() : '…'}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => handleVerify(r.address)}>
                    Verify owners
                  </Button>
                  {verifications[r.address] && (
                    <span className="break-all">{verifications[r.address]}</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!noopBusy[r.address]}
                    onClick={() => handleNoOp(r.address)}
                  >
                    {noopBusy[r.address] ? 'Running…' : 'Run no-op execTransaction (EIP-1271)'}
                  </Button>
                  {noopStatus[r.address] && (
                    <span className="break-all">{noopStatus[r.address]}</span>
                  )}
                </div>
                <div className="mt-2 flex flex-col gap-1 border-t pt-2">
                  <span className="text-muted-foreground">
                    ST-B: keeper {KEEPER_EOA.slice(0, 10)}… · role {ROLE_KEY.slice(0, 10)}…
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!rolesBusy[r.address] || !!r.rolesModifier}
                      onClick={() => handleDeployModifier(r.address)}
                    >
                      {rolesBusy[r.address] === 'deploying'
                        ? 'Deploying…'
                        : r.rolesModifier
                          ? 'Modifier deployed'
                          : 'Deploy RolesModifier'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!r.rolesModifier || !!rolesBusy[r.address] || !!r.roleConfigured}
                      onClick={() =>
                        r.rolesModifier && handleConfigureRole(r.address, r.rolesModifier)
                      }
                    >
                      {rolesBusy[r.address] === 'configuring'
                        ? 'Configuring…'
                        : r.roleConfigured
                          ? 'Role configured'
                          : 'Configure role'}
                    </Button>
                  </div>
                  {r.rolesModifier && (
                    <span className="break-all">modifier: {r.rolesModifier}</span>
                  )}
                  {rolesStatus[r.address] && (
                    <span className="break-all">{rolesStatus[r.address]}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
