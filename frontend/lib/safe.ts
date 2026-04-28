import {
  type Address,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
} from 'viem';
import Safe from '@safe-global/protocol-kit';

export const ZODIAC_MODULE_PROXY_FACTORY: Address = '0x000000000000aDdB49795b0f9bA5BC298cDda236';
export const ROLES_V2_MASTERCOPY: Address = '0x9646fDAD06d3e24444381f44362a3B0eB343D337';
export const MULTISEND_CALL_ONLY_V1_4_1: Address = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
export const ROLE_KEY: `0x${string}` =
  '0x0000000000000000000000000000000000000000000000000000000000000001';
export const KEEPER_EOA: Address = '0x2Ec8aCCA35f73E0D69818b4Bb33d50D15030643a';
export const USDC_SEPOLIA: Address = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

export type SafeRecord = {
  address: Address;
  txHash: `0x${string}`;
  ownerAtDeploy: Address;
  saltNonce: string;
  deployedAt: number;
  rolesModifier?: Address;
  roleConfigured?: boolean;
};

const STORAGE_PREFIX = 'safe-smoke:deployed:';

const SAFE_ABI_GET_OWNERS = [
  {
    type: 'function',
    name: 'getOwners',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
] as const;

function storageKey(owner: Address) {
  return `${STORAGE_PREFIX}${owner.toLowerCase()}`;
}

export function loadDeployedSafes(owner: Address): SafeRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(owner));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SafeRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendDeployedSafe(owner: Address, record: SafeRecord) {
  if (typeof window === 'undefined') return;
  const existing = loadDeployedSafes(owner);
  const next = [record, ...existing];
  window.localStorage.setItem(storageKey(owner), JSON.stringify(next));
}

export function updateDeployedSafe(
  owner: Address,
  safeAddress: Address,
  patch: Partial<SafeRecord>
) {
  if (typeof window === 'undefined') return;
  const existing = loadDeployedSafes(owner);
  const next = existing.map((r) =>
    r.address.toLowerCase() === safeAddress.toLowerCase() ? { ...r, ...patch } : r
  );
  window.localStorage.setItem(storageKey(owner), JSON.stringify(next));
}

export async function deploySafeWithPortoOwner(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  ownerAddress: Address;
}): Promise<SafeRecord> {
  const { walletClient, publicClient, ownerAddress } = params;
  const saltNonce = Date.now().toString();

  const kit = await Safe.init({
    provider: walletClient.transport,
    signer: ownerAddress,
    predictedSafe: {
      safeAccountConfig: {
        owners: [ownerAddress],
        threshold: 1,
      },
      safeDeploymentConfig: {
        saltNonce,
        safeVersion: '1.4.1',
      },
    },
  });

  const predicted = (await kit.getAddress()) as Address;
  const tx = await kit.createSafeDeploymentTransaction();

  const account = walletClient.account;
  if (!account) throw new Error('walletClient has no account');
  const chain = walletClient.chain;
  if (!chain) throw new Error('walletClient has no chain');

  const txValue = BigInt(tx.value ?? '0');
  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: tx.to as Address,
    data: tx.data as `0x${string}`,
    ...(txValue > BigInt(0) ? { value: txValue } : {}),
  });

  await publicClient.waitForTransactionReceipt({ hash });

  return {
    address: predicted,
    txHash: hash,
    ownerAtDeploy: ownerAddress,
    saltNonce,
    deployedAt: Date.now(),
  };
}

const SAFE_ABI_NOOP = [
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'execTransaction',
    stateMutability: 'payable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: 'signatures', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

function preValidatedSig(owner: Address): `0x${string}` {
  const r = owner.slice(2).toLowerCase().padStart(64, '0');
  const s = '0'.repeat(64);
  const v = '01';
  return `0x${r}${s}${v}` as `0x${string}`;
}

export type NoOpResult = {
  txHash: `0x${string}`;
  safeNonce: bigint;
};

export async function getSafeNonce(
  publicClient: PublicClient,
  safeAddress: Address
): Promise<bigint> {
  return (await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI_NOOP,
    functionName: 'nonce',
  })) as bigint;
}

export async function runNoOpSafeTx(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  safeAddress: Address;
  ownerAddress: Address;
  safeNonce: bigint;
}): Promise<NoOpResult> {
  const { walletClient, publicClient, safeAddress, ownerAddress, safeNonce } = params;

  const account = walletClient.account;
  if (!account) throw new Error('walletClient has no account');
  const chain = walletClient.chain;
  if (!chain) throw new Error('walletClient has no chain');

  void safeNonce; // pre-validated path doesn't need it (msg.sender == owner)

  const signatures = preValidatedSig(ownerAddress);

  const data = encodeFunctionData({
    abi: SAFE_ABI_NOOP,
    functionName: 'execTransaction',
    args: [
      safeAddress,
      BigInt(0),
      '0x',
      0,
      BigInt(0),
      BigInt(0),
      BigInt(0),
      ZERO_ADDRESS as Address,
      ZERO_ADDRESS as Address,
      signatures,
    ],
  });

  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: safeAddress,
    data,
  });

  await publicClient.waitForTransactionReceipt({ hash });

  return { txHash: hash, safeNonce };
}

const FACTORY_ABI = parseAbi([
  'function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)',
]);

const ROLES_SETUP_ABI = parseAbi(['function setUp(bytes initParams)']);

const SAFE_MODULE_ABI = parseAbi(['function enableModule(address module)']);

const ROLES_CONFIG_ABI = parseAbi([
  'function assignRoles(address member, bytes32[] roleKeys, bool[] memberOf)',
  'function scopeTarget(bytes32 roleKey, address targetAddress)',
  'function allowFunction(bytes32 roleKey, address targetAddress, bytes4 selector, uint8 options)',
]);

const MULTISEND_ABI = parseAbi(['function multiSend(bytes transactions) payable']);

export async function deployRolesModifier(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  safeAddress: Address;
}): Promise<{ modifier: Address; txHash: `0x${string}` }> {
  const { walletClient, publicClient, safeAddress } = params;

  const account = walletClient.account;
  if (!account) throw new Error('walletClient has no account');
  const chain = walletClient.chain;
  if (!chain) throw new Error('walletClient has no chain');

  const initParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [safeAddress, safeAddress, safeAddress]
  );
  const initializer = encodeFunctionData({
    abi: ROLES_SETUP_ABI,
    functionName: 'setUp',
    args: [initParams],
  });

  const saltNonce = BigInt(Date.now());
  const data = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: 'deployModule',
    args: [ROLES_V2_MASTERCOPY, initializer, saltNonce],
  });

  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: ZODIAC_MODULE_PROXY_FACTORY,
    data,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  let modifier: Address | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ZODIAC_MODULE_PROXY_FACTORY.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: FACTORY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'ModuleProxyCreation') {
        modifier = decoded.args.proxy as Address;
        break;
      }
    } catch {
      /* skip */
    }
  }
  if (!modifier) throw new Error('ModuleProxyCreation event not found');
  return { modifier, txHash: hash };
}

function packMultiSend(calls: { to: Address; data: `0x${string}` }[]): `0x${string}` {
  const parts = calls.map((c) => {
    const op = '00';
    const to = c.to.slice(2).toLowerCase().padStart(40, '0');
    const value = '0'.repeat(64);
    const dataHex = c.data.slice(2);
    const dataLen = (dataHex.length / 2).toString(16).padStart(64, '0');
    return op + to + value + dataLen + dataHex;
  });
  return `0x${parts.join('')}` as `0x${string}`;
}

export async function configureRole(params: {
  walletClient: WalletClient;
  publicClient: PublicClient;
  safeAddress: Address;
  ownerAddress: Address;
  modifierAddress: Address;
}): Promise<{ txHash: `0x${string}` }> {
  const { walletClient, publicClient, safeAddress, ownerAddress, modifierAddress } = params;

  const account = walletClient.account;
  if (!account) throw new Error('walletClient has no account');
  const chain = walletClient.chain;
  if (!chain) throw new Error('walletClient has no chain');

  const enableModuleData = encodeFunctionData({
    abi: SAFE_MODULE_ABI,
    functionName: 'enableModule',
    args: [modifierAddress],
  });
  const assignRolesData = encodeFunctionData({
    abi: ROLES_CONFIG_ABI,
    functionName: 'assignRoles',
    args: [KEEPER_EOA, [ROLE_KEY], [true]],
  });
  const scopeTargetData = encodeFunctionData({
    abi: ROLES_CONFIG_ABI,
    functionName: 'scopeTarget',
    args: [ROLE_KEY, USDC_SEPOLIA],
  });
  const approveSelector = toFunctionSelector('approve(address,uint256)');
  const allowFunctionData = encodeFunctionData({
    abi: ROLES_CONFIG_ABI,
    functionName: 'allowFunction',
    args: [ROLE_KEY, USDC_SEPOLIA, approveSelector, 0],
  });

  const packed = packMultiSend([
    { to: safeAddress, data: enableModuleData },
    { to: modifierAddress, data: assignRolesData },
    { to: modifierAddress, data: scopeTargetData },
    { to: modifierAddress, data: allowFunctionData },
  ]);

  const multiSendData = encodeFunctionData({
    abi: MULTISEND_ABI,
    functionName: 'multiSend',
    args: [packed],
  });

  const signatures = preValidatedSig(ownerAddress);

  const execData = encodeFunctionData({
    abi: SAFE_ABI_NOOP,
    functionName: 'execTransaction',
    args: [
      MULTISEND_CALL_ONLY_V1_4_1,
      BigInt(0),
      multiSendData,
      1, // delegatecall
      BigInt(0),
      BigInt(0),
      BigInt(0),
      ZERO_ADDRESS as Address,
      ZERO_ADDRESS as Address,
      signatures,
    ],
  });

  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: safeAddress,
    data: execData,
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return { txHash: hash };
}

export async function verifySafeOwners(
  publicClient: PublicClient,
  safeAddress: Address
): Promise<Address[]> {
  const owners = (await publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI_GET_OWNERS,
    functionName: 'getOwners',
  })) as Address[];
  return owners;
}
