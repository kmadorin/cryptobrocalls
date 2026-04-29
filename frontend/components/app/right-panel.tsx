'use client';

import { useEffect, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Streamdown } from 'streamdown';
import { useRoomContext } from '@livekit/components-react';
import {
  JSONUIProvider,
  Renderer,
  type ComponentRegistry,
  type ComponentRenderer,
  type Spec,
  createStateStore,
  useStateValue,
} from '@json-render/react';

const INITIAL_COLOR = '#3b82f6';

type ViewName = 'button' | 'swap' | 'claude';

const initialState = {
  view: 'button' as ViewName,
  buttonColor: INITIAL_COLOR,
  swap: { fromToken: 'ETH', toToken: 'USDC', amount: 1 },
  claude: { prompt: '', output: '', status: 'idle' as 'idle' | 'running' | 'done' | 'error' },
};

function ColorButtonView() {
  const color = useStateValue<string>('/buttonColor') ?? INITIAL_COLOR;
  return (
    <div className="flex h-full w-full items-center justify-center">
      <button
        type="button"
        style={{
          backgroundColor: color,
          color: '#fff',
          padding: '20px 40px',
          borderRadius: 12,
          border: 'none',
          fontWeight: 700,
          fontSize: 22,
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
          transition: 'background-color 250ms ease',
        }}
      >
        Hello
      </button>
    </div>
  );
}

const TOKEN_PRICES_USD: Record<string, number> = {
  ETH: 3500,
  USDC: 1,
  USDT: 1,
  DAI: 1,
  BTC: 65000,
  WBTC: 65000,
  SOL: 180,
  ARB: 1.2,
  OP: 2.5,
  MATIC: 0.7,
  LINK: 18,
  UNI: 12,
};

function estimateOut(from: string, to: string, amount: number): number {
  const fromUsd = TOKEN_PRICES_USD[from.toUpperCase()] ?? 1;
  const toUsd = TOKEN_PRICES_USD[to.toUpperCase()] ?? 1;
  const out = (amount * fromUsd) / toUsd;
  return Number.isFinite(out) ? out : 0;
}

function TokenRow({ label, token, value }: { label: string; token: string; value: string }) {
  return (
    <div className="rounded-2xl bg-neutral-900/80 p-4 ring-1 ring-white/5">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="mt-2 flex items-center justify-between gap-3">
        <input
          readOnly
          value={value}
          className="w-0 flex-1 bg-transparent text-3xl font-semibold text-white outline-none"
        />
        <div className="flex items-center gap-2 rounded-full bg-neutral-800 px-3 py-1.5">
          <div className="h-6 w-6 rounded-full bg-pink-500/80" />
          <span className="text-sm font-medium text-white">{token}</span>
        </div>
      </div>
    </div>
  );
}

function SwapWidgetView() {
  const fromToken = useStateValue<string>('/swap/fromToken') ?? 'ETH';
  const toToken = useStateValue<string>('/swap/toToken') ?? 'USDC';
  const amount = useStateValue<number>('/swap/amount') ?? 1;
  const out = estimateOut(fromToken, toToken, amount);
  const outDisplay = out >= 1 ? out.toFixed(2) : out.toPrecision(4);

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <motion.div
        className="w-full max-w-md rounded-3xl bg-neutral-950 p-4 shadow-2xl ring-1 ring-white/10"
        initial="hidden"
        animate="visible"
        variants={{
          hidden: {},
          visible: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
        }}
      >
        <motion.div
          className="mb-3 flex items-center justify-between px-2"
          variants={ROW_VARIANTS}
        >
          <h2 className="text-base font-semibold text-white">Swap</h2>
          <div className="text-xs text-neutral-500">Uniswap-style</div>
        </motion.div>
        <div className="space-y-1">
          <motion.div variants={ROW_VARIANTS}>
            <TokenRow label="Sell" token={fromToken} value={String(amount)} />
          </motion.div>
          <motion.div className="-my-3 flex justify-center" variants={ROW_VARIANTS}>
            <motion.div
              className="rounded-xl bg-neutral-800 p-2 text-white ring-4 ring-neutral-950"
              animate={{ rotate: [0, 180, 360] }}
              transition={{ duration: 0.6, ease: 'easeInOut' }}
            >
              ↓
            </motion.div>
          </motion.div>
          <motion.div variants={ROW_VARIANTS}>
            <TokenRow label="Buy" token={toToken} value={outDisplay} />
          </motion.div>
        </div>
        <motion.button
          type="button"
          className="mt-4 w-full rounded-2xl bg-pink-500 py-4 text-base font-semibold text-white transition hover:bg-pink-400"
          variants={ROW_VARIANTS}
          whileTap={{ scale: 0.97 }}
        >
          Swap
        </motion.button>
        <motion.div
          className="mt-2 text-center text-xs text-neutral-500"
          variants={ROW_VARIANTS}
        >
          Demo · no real trade
        </motion.div>
      </motion.div>
    </div>
  );
}

const ROW_VARIANTS = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 380, damping: 30 } },
};

const VIEW_MOTION = {
  initial: { opacity: 0, y: 24, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -16, scale: 0.98 },
  transition: { type: 'spring' as const, stiffness: 320, damping: 28, mass: 0.7 },
};

function ClaudeView() {
  const prompt = useStateValue<string>('/claude/prompt') ?? '';
  const output = useStateValue<string>('/claude/output') ?? '';
  const status = useStateValue<'idle' | 'running' | 'done' | 'error'>('/claude/status') ?? 'idle';
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [output]);

  return (
    <div className="flex h-full w-full flex-col gap-3 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className={
              status === 'running'
                ? 'h-2 w-2 animate-pulse rounded-full bg-emerald-400'
                : status === 'error'
                  ? 'h-2 w-2 rounded-full bg-red-400'
                  : 'h-2 w-2 rounded-full bg-neutral-500'
            }
          />
          <span className="text-xs uppercase tracking-wide text-neutral-400">
            Claude Code · {status}
          </span>
        </div>
      </div>
      <div className="rounded-2xl bg-neutral-900/80 p-4 ring-1 ring-white/5">
        <div className="mb-1 text-xs text-neutral-400">Prompt</div>
        <div className="text-sm text-white">{prompt || '—'}</div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-2xl bg-neutral-950 p-4 ring-1 ring-white/10"
      >
        {output ? (
          <div className="prose prose-sm prose-invert max-w-none prose-code:rounded prose-code:bg-neutral-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-amber-200 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-neutral-900 prose-pre:text-neutral-100">
            <Streamdown>{output}</Streamdown>
          </div>
        ) : (
          <div className="text-sm text-neutral-500">Waiting for Claude…</div>
        )}
      </div>
    </div>
  );
}

const ViewSwitcher: ComponentRenderer = () => {
  const view = useStateValue<ViewName>('/view') ?? 'button';
  return (
    <AnimatePresence mode="wait">
      <motion.div key={view} className="h-full w-full" {...VIEW_MOTION}>
        {view === 'swap' ? (
          <SwapWidgetView />
        ) : view === 'claude' ? (
          <ClaudeView />
        ) : (
          <ColorButtonView />
        )}
      </motion.div>
    </AnimatePresence>
  );
};

const registry: ComponentRegistry = {
  ViewSwitcher,
};

const spec: Spec = {
  root: 'root',
  elements: {
    root: { type: 'ViewSwitcher', props: {} },
  },
  state: initialState,
};

export function RightPanel() {
  const store = useMemo(() => createStateStore(initialState), []);
  const room = useRoomContext();

  useEffect(() => {
    if (!room) return;
    room.registerRpcMethod('setButtonColor', async ({ payload }) => {
      try {
        const { color } = JSON.parse(payload) as { color: string };
        store.set('/buttonColor', color);
        store.set('/view', 'button');
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    });
    room.registerRpcMethod('showSwapWidget', async ({ payload }) => {
      try {
        const { fromToken, toToken, amount } = JSON.parse(payload) as {
          fromToken: string;
          toToken: string;
          amount: number;
        };
        store.set('/swap/fromToken', fromToken);
        store.set('/swap/toToken', toToken);
        store.set('/swap/amount', amount);
        store.set('/view', 'swap');
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    });
    room.registerRpcMethod('claudeStart', async ({ payload }) => {
      try {
        const { prompt } = JSON.parse(payload) as { prompt: string };
        store.set('/claude/prompt', prompt);
        store.set('/claude/output', '');
        store.set('/claude/status', 'running');
        store.set('/view', 'claude');
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    });
    room.registerRpcMethod('claudeAppend', async ({ payload }) => {
      try {
        const { text } = JSON.parse(payload) as { text: string };
        const current = (store.get('/claude/output') as string | undefined) ?? '';
        store.set('/claude/output', current + text);
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    });
    room.registerRpcMethod('claudeReset', async () => {
      try {
        store.set('/claude/prompt', '');
        store.set('/claude/output', '');
        store.set('/claude/status', 'idle');
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    });
    room.registerRpcMethod('claudeDone', async ({ payload }) => {
      try {
        const { ok } = JSON.parse(payload) as { ok?: boolean };
        store.set('/claude/status', ok === false ? 'error' : 'done');
        return JSON.stringify({ ok: true });
      } catch (err) {
        return JSON.stringify({ ok: false, error: String(err) });
      }
    });
    return () => {
      room.unregisterRpcMethod('setButtonColor');
      room.unregisterRpcMethod('showSwapWidget');
      room.unregisterRpcMethod('claudeStart');
      room.unregisterRpcMethod('claudeAppend');
      room.unregisterRpcMethod('claudeReset');
      room.unregisterRpcMethod('claudeDone');
    };
  }, [room, store]);

  return (
    <div className="pointer-events-auto fixed inset-y-0 right-0 z-40 flex w-1/2 items-center justify-center border-l border-white/10 bg-background">
      <JSONUIProvider store={store} registry={registry}>
        <Renderer spec={spec} registry={registry} />
      </JSONUIProvider>
    </div>
  );
}
