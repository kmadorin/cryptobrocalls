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
  }
  // skip 'result' — duplicates the assistant text content already streamed.
}

const CLAUDE_BIN =
  process.env.CLAUDE_BIN ?? `${process.env.HOME ?? ''}/.local/bin/claude`;

function startClaude(room: Room, prompt: string): void {
  if (currentClaude && !currentClaude.killed) {
    currentClaude.kill('SIGTERM');
    currentClaude = null;
  }

  const cwd = process.env.CLAUDE_WORKDIR ?? process.cwd();
  const model = process.env.CLAUDE_MODEL ?? 'haiku';
  const mcpConfig = process.env.CLAUDE_MCP_CONFIG ?? `${cwd}/mcp-config.json`;
  console.log(
    `[claude] spawn bin=${CLAUDE_BIN} cwd=${cwd} model=${model} mcp=${mcpConfig} prompt=${JSON.stringify(prompt)}`,
  );
  const proc = spawn(
    CLAUDE_BIN,
    [
      '-p',
      prompt,
      '--model',
      model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      mcpConfig,
      '--permission-mode',
      'bypassPermissions',
    ],
    { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  currentClaude = proc;

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
  proc.on('close', (code) => {
    console.log(`[claude] closed exitCode=${code}`);
    void rpc(room, 'claudeDone', { ok: code === 0, exitCode: code });
    if (currentClaude === proc) currentClaude = null;
  });
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
- User asks for research, summary, repo info, code investigation, "look this up", "explain this codebase", or any onchain question (wallets, transactions, tokens, balances, contracts, ENS, blocks on Ethereum/Base/Arbitrum/etc.) -> call askClaude with the user's prompt verbatim. Claude has the Blockscout MCP for live blockchain data. Do NOT answer yourself.

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

        askClaude: llm.tool({
          description:
            'Delegate a research, coding, or investigation task to Claude Code (headless). Returns immediately; Claude streams its progress live to the UI panel on the right. Use for any "look this up", "research", "summarize", "explain this repo", or coding-style ask.',
          parameters: z.object({
            prompt: z
              .string()
              .describe("The user's task, copied roughly verbatim, in a single sentence."),
          }),
          execute: async ({ prompt }) => {
            console.log(`[tool askClaude] firing prompt=${JSON.stringify(prompt)}`);
            const startResult = await rpc(room, 'claudeStart', { prompt });
            console.log(`[tool askClaude] claudeStart rpc -> ${startResult}`);
            startClaude(room, prompt);
            return `Delegated to Claude: "${prompt}". Working in the background.`;
          },
        }),
      },
    });
  }
}
