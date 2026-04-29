import { llm, voice } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { type ChildProcess, spawn } from 'node:child_process';
import { z } from 'zod';

async function rpc(room: Room, method: string, payload: unknown): Promise<string> {
  const remote = Array.from(room.remoteParticipants.values())[0];
  if (!remote) {
    console.warn(`[rpc] no remote participant for method=${method}`);
    return 'No frontend connected.';
  }
  try {
    await room.localParticipant!.performRpc({
      destinationIdentity: remote.identity,
      method,
      payload: JSON.stringify(payload),
    });
    return 'ok';
  } catch (err) {
    console.error(`[rpc] ${method} failed:`, err);
    return `rpc-error: ${String(err)}`;
  }
}

let currentClaude: ChildProcess | null = null;

interface ClaudeStreamMessage {
  type: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string }> };
  result?: string;
  subtype?: string;
}

function handleClaudeLine(room: Room, line: string): void {
  let msg: ClaudeStreamMessage;
  try {
    msg = JSON.parse(line) as ClaudeStreamMessage;
  } catch {
    return;
  }

  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        void rpc(room, 'claudeAppend', { text: block.text });
      } else if (block.type === 'tool_use' && block.name) {
        void rpc(room, 'claudeAppend', {
          text: `\n\n> 🔧 _calling \`${block.name}\`_\n\n`,
        });
      }
    }
  } else if (msg.type === 'result') {
    void rpc(room, 'claudeAppend', {
      text: `\n\n---\n_turn complete (${msg.subtype ?? 'unknown'}). Reply via voice to continue._\n\n`,
    });
  }
}

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ?? `${process.env.HOME ?? ''}/.local/bin/claude`;

function writeUserTurn(proc: ChildProcess, text: string): boolean {
  if (!proc.stdin || proc.stdin.destroyed || proc.killed) return false;
  const line =
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
    }) + '\n';
  return proc.stdin.write(line);
}

function spawnClaude(room: Room): ChildProcess {
  const cwd = process.env.CLAUDE_WORKDIR ?? process.cwd();
  const model = process.env.CLAUDE_MODEL ?? 'haiku';
  const mcpConfig = process.env.CLAUDE_MCP_CONFIG ?? `${cwd}/mcp-config.json`;
  console.log(
    `[claude] spawn bin=${CLAUDE_BIN} cwd=${cwd} model=${model} mcp=${mcpConfig} (streaming)`,
  );
  const proc = spawn(
    CLAUDE_BIN,
    [
      '-p',
      '--model',
      model,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      mcpConfig,
      '--permission-mode',
      'bypassPermissions',
    ],
    {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  );
  console.log(`[claude] spawned pid=${proc.pid}`);

  let buffer = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleClaudeLine(room, line);
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    console.error('[claude stderr]', chunk.toString('utf8'));
  });
  proc.on('error', (err) => {
    console.error('[claude spawn error]', err);
    void rpc(room, 'claudeAppend', { text: `\n\n**spawn error**: ${String(err)}\n` });
    void rpc(room, 'claudeDone', { ok: false, error: String(err) });
    if (currentClaude === proc) currentClaude = null;
  });
  proc.on('close', (code, signal) => {
    console.log(`[claude] closed pid=${proc.pid} exitCode=${code} signal=${signal}`);
    void rpc(room, 'claudeDone', { ok: code === 0, exitCode: code });
    if (currentClaude === proc) currentClaude = null;
  });
  return proc;
}

function killClaude(proc: ChildProcess): void {
  try {
    proc.stdin?.end();
  } catch {
    /* ignore */
  }
  if (proc.pid && !proc.killed) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
}

function talkClaude(room: Room, text: string): { spawned: boolean } {
  let spawned = false;
  if (!currentClaude || currentClaude.killed || currentClaude.exitCode !== null) {
    currentClaude = spawnClaude(room);
    spawned = true;
  }
  writeUserTurn(currentClaude, text);
  return { spawned };
}

function resetClaude(): boolean {
  if (!currentClaude || currentClaude.killed) return false;
  killClaude(currentClaude);
  currentClaude = null;
  return true;
}

export class Agent extends voice.Agent {
  constructor(room: Room) {
    super({
      instructions: `You are a crypto-bro voice assistant controlling a small UI on the right side of the screen.

CRITICAL TOOL POLICY — read carefully:
- You MUST emit a function call (not narrate) for every actionable request.
- Never write sentences like "I will call X" or "I'm delegating that to Claude". Just CALL the tool, then speak a short confirmation AFTER the tool returns.
- If you say a tool will be used but emit no function call, you have failed.

Rules:
- User asks to change the demo button color -> call setButtonColor with a CSS color (hex or named).
- User wants to swap/trade/exchange tokens (e.g. "swap 1 ETH to USDC") -> call showSwapWidget. Default fromToken="ETH", toToken="USDC", amount=1.
- User asks for research, summary, repo info, code investigation, "look this up", "explain this codebase", any onchain request (read or write: wallets, transactions, tokens, balances, contracts, ENS, blocks, deposits, swaps, transfers, etc. on any chain or testnet), OR is replying to a clarifying question Claude asked -> call talkToClaude. There is ONE persistent Claude session per call; every utterance routes there as a new user turn. No separate "new task" tool. Pass the user's utterance EXACTLY: same language, wording, imperative mood, named entities (chain, testnet, protocol, tool, token), amounts, modifiers. Do NOT translate, paraphrase, summarize, or rephrase. Do NOT answer yourself.
- User explicitly says "reset Claude", "start over", "new Claude session", "forget all that" -> call resetClaude (kills the live session; next talkToClaude spawns fresh).

Keep spoken replies short and crypto-bro energetic AFTER tool calls. Speak in English unless user speaks another language.`,

      tools: {
        setButtonColor: llm.tool({
          description:
            'Show the demo button view and set its background color. Pass a CSS color string (hex like #ff0000 or named color like "red").',
          parameters: z.object({
            color: z.string().describe('CSS color value (hex or named)'),
          }),
          execute: async ({ color }) => {
            await rpc(room, 'setButtonColor', { color });
            return `Set button color to ${color}.`;
          },
        }),

        showSwapWidget: llm.tool({
          description:
            'Show the Uniswap-style token swap widget. Use whenever the user wants to swap, trade, or exchange tokens.',
          parameters: z.object({
            fromToken: z.string().describe('Symbol of the token being sold (e.g. "ETH").'),
            toToken: z.string().describe('Symbol of the token being bought (e.g. "USDC").'),
            amount: z.number().describe('Amount of fromToken to swap. Use 1 if unspecified.'),
          }),
          execute: async ({ fromToken, toToken, amount }) => {
            await rpc(room, 'showSwapWidget', {
              fromToken: fromToken.toUpperCase(),
              toToken: toToken.toUpperCase(),
              amount,
            });
            return `Showing swap widget: ${amount} ${fromToken} -> ${toToken}.`;
          },
        }),

        talkToClaude: llm.tool({
          description:
            'Send a user turn to the persistent Claude Code session. Lazy-spawns the session on first call, then reuses it for every subsequent turn (research, follow-ups, clarifications). Streams progress live to the UI panel on the right.',
          parameters: z.object({
            message: z
              .string()
              .describe(
                "The user's utterance copied EXACTLY. Preserve language, wording, imperative mood, named entities (chains, protocols, tools, tokens), amounts, modifiers. Do NOT translate, paraphrase, summarize, or rephrase.",
              ),
          }),
          execute: async ({ message }) => {
            console.log(`[tool talkToClaude] message=${JSON.stringify(message)}`);
            const { spawned } = talkClaude(room, message);
            if (spawned) {
              const startResult = await rpc(room, 'claudeStart', { prompt: message });
              console.log(`[tool talkToClaude] claudeStart rpc -> ${startResult}`);
            } else {
              await rpc(room, 'claudeAppend', { text: `\n\n> 💬 _user: ${message}_\n\n` });
            }
            return `Sent to Claude: "${message}". Working in the background.`;
          },
        }),

        resetClaude: llm.tool({
          description:
            'Kill the current Claude Code session so the next talkToClaude starts a fresh one. Only use when the user explicitly asks to reset, start over, or wipe context.',
          parameters: z.object({}),
          execute: async () => {
            const killed = resetClaude();
            await rpc(room, 'claudeReset', {});
            return killed ? 'Claude session reset.' : 'No active Claude session to reset.';
          },
        }),
      },
    });
  }
}
