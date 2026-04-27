import { type JobContext, ServerOptions, cli, defineAgent, voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent';

dotenv.config({ path: '.env.local' });

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      llm: new google.beta.realtime.RealtimeModel({
        voice: 'Puck',
        thinkingConfig: { thinkingBudget: 0 },
        instructions:
          'You are a crypto-bro voice assistant. You MUST use the provided tools to act. Never describe what a tool will do — emit the function call. If the user asks for research, summary, code, or repo info, call the askClaude tool immediately.',
      }),
    });

    await session.start({
      agent: new Agent(ctx.room),
      room: ctx.room,
    });

    await ctx.connect();

    session.generateReply({
      instructions:
        "Greet the user as a crypto bro. Tell them you can change the demo button color or pull up a swap widget — just ask.",
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'crypto-bro',
  }),
);
