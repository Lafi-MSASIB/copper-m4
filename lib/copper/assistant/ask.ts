"use server";

// The server action the Ask Copper chat calls. It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show the agent
// thinking and using its tools.
//
// Module 4: there are two agents, Copper and the Refund agent. The app owns the
// loop. The browser sends only a chat id; the server looks up which agent is
// active for that chat, runs it with its own instructions and tools (router.ts),
// and, when Copper hands the chat over, runs the Refund agent on the same
// message. The browser can never choose the agent or the customer.
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { COPPER_INSTRUCTIONS } from "@/lib/copper/assistant/instructions";
import type { Progress, ToolStep } from "@/lib/copper/assistant/progress";
import { copperTools } from "@/lib/copper/assistant/tools";
import { isStoreConfigured } from "@/lib/copper/refund/db";
import { harnessFor, type AgentId } from "@/lib/copper/refund/router";
import { getChatState } from "@/lib/copper/refund/store";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** Which conversation this is. Only an id: the server decides everything else. */
  chatId?: string;
};

export type AskCopperResult = { progress: Live<Progress> };

/** At most this many model steps (tool calls plus the reply) per question. */
const MAX_STEPS = 5;

/** A chat can hand over to the Refund agent once per message. */
const MAX_HANDOFFS = 1;

const CHAT_ID = /^[A-Za-z0-9-]{8,64}$/;

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/**
 * Google's free tier only allows a few questions a day. When that runs out no
 * retry helps, so say so plainly instead of "something went wrong".
 */
const OUT_OF_QUESTIONS =
  "Copper has used up today's free question limit from Google. Please try again tomorrow.";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** The shopper only sees a short message; this puts the real reason in the server log. */
function logFailure(error: unknown) {
  console.error(`[ask-copper] ${errorMessage(error)}`);
}

const isQuotaError = (error: unknown) =>
  /quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(errorMessage(error));

type Session = { chatId: string; customerId: string; agent: AgentId };

/** This chat's saved state, or null when there is no chat id or no database (then Copper runs alone). */
async function openSession(
  chatId: string | undefined,
): Promise<Session | null> {
  if (!chatId || !CHAT_ID.test(chatId) || !isStoreConfigured()) return null;
  try {
    const state = await getChatState(chatId);
    return {
      chatId,
      customerId: state.customerId,
      agent: state.activeAgent,
    };
  } catch (error) {
    logFailure(error);
    return null;
  }
}

export async function askCopper({
  messages,
  useTools,
  chatId,
}: AskCopperRequest): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const progress: Progress = { steps: [], reply: "", status: "working" };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep => step.type === "tool" && step.id === id,
    );

  // With tools off, nothing is routed: just the model, no instructions, no tools.
  const session = useTools ? await openSession(chatId) : null;
  if (session) progress.agent = session.agent;

  /** Runs one agent's turn and reads its stream into `progress`. */
  async function consume(result: ReturnType<typeof callStream>) {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta": {
          const last = progress.steps.at(-1);
          if (last?.type === "thinking") last.text += part.text;
          else progress.steps.push({ type: "thinking", text: part.text });
          break;
        }
        case "tool-input-start":
          progress.steps.push({
            type: "tool",
            id: part.id,
            name: part.toolName,
            state: "calling",
          });
          break;
        case "tool-call": {
          const step = toolStep(part.toolCallId);
          if (step) step.input = part.input;
          else
            progress.steps.push({
              type: "tool",
              id: part.toolCallId,
              name: part.toolName,
              state: "calling",
              input: part.input,
            });
          break;
        }
        case "tool-result": {
          const step = toolStep(part.toolCallId);
          if (step) Object.assign(step, { output: part.output, state: "done" });
          break;
        }
        case "tool-error": {
          const step = toolStep(part.toolCallId);
          const message = errorMessage(part.error);
          if (step) Object.assign(step, { output: message, state: "error" });
          break;
        }
        case "text-delta":
          progress.reply += part.text;
          break;
        case "error":
          throw part.error;
        default:
          continue;
      }
      update(snapshot());
    }
  }

  /** One agent's turn, with that agent's own instructions and tools. */
  function runAgent(agent: AgentId, active: Session) {
    const { instructions, tools } = harnessFor(agent, active);
    return callStream(
      agent === "refund"
        ? { module: 4, feature: "refund-agent" }
        : { module: 2, feature: "ask-copper" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions,
        tools,
        // Copper's turn ends the moment it hands over; the app then runs the Refund agent.
        stopWhen:
          agent === "copper"
            ? [stepCountIs(MAX_STEPS), hasToolCall("handoff_to_refund_agent")]
            : stepCountIs(MAX_STEPS),
      },
    );
  }

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    try {
      if (!session) {
        // Without tools, send no instructions either: "always use your tools"
        // with no tools makes the model answer with nothing.
        await consume(
          callStream(
            { module: 2, feature: "ask-copper" },
            {
              messages,
              providerOptions: THOUGHT_SUMMARIES,
              ...(useTools && {
                instructions: COPPER_INSTRUCTIONS,
                tools: copperTools,
                stopWhen: stepCountIs(MAX_STEPS),
              }),
            },
          ),
        );
      } else {
        let agent = session.agent;
        for (let handoffs = 0; ; handoffs++) {
          progress.agent = agent;
          await consume(runAgent(agent, session));
          // The server re-reads who is active: only a tool can change it.
          const now = (await getChatState(session.chatId)).activeAgent;
          if (
            agent === "copper" &&
            now === "refund" &&
            handoffs < MAX_HANDOFFS
          ) {
            // Copper handed the chat over, so the Refund agent answers this same message.
            progress.reply = "";
            agent = "refund";
            update(snapshot());
            continue;
          }
          progress.activeAfter = now;
          break;
        }
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch (error) {
      logFailure(error);
      progress.status = "error";
      if (!progress.reply.trim()) {
        progress.reply = isQuotaError(error) ? OUT_OF_QUESTIONS : SORRY;
      }
    }
    done(snapshot());
  })();

  return { progress: live };
}
