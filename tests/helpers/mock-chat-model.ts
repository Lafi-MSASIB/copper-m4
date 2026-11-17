// Helpers for scripting a fake model in tests: what it streams back, one model
// step at a time. No AI key needed, and nothing is spent.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: {
    total: 500,
    noCache: 500,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

export type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: undefined },
  usage,
});

/** The model says some words and stops. */
export const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  ...text.split(" ").map((word, i): StreamPart => ({
    type: "text-delta",
    id: "t1",
    delta: i === 0 ? word : ` ${word}`,
  })),
  { type: "text-end", id: "t1" },
  finish("stop"),
];

/** The model calls one tool (give each call its own id). */
export const calls = (
  toolName: string,
  input: unknown,
  id = "call-1",
): StreamPart[] => [
  { type: "tool-input-start", id, toolName },
  { type: "tool-input-delta", id, delta: JSON.stringify(input) },
  { type: "tool-input-end", id },
  {
    type: "tool-call",
    toolCallId: id,
    toolName,
    input: JSON.stringify(input),
  },
  finish("tool-calls"),
];

/** A fake model that streams each of `steps` in turn, one per model step. */
export function modelStreaming(...steps: StreamPart[][]) {
  let step = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(steps[step++] ?? says("")),
    }),
  });
}

/** The tool names a model call was offered, sorted. */
export function toolNamesOf(
  model: MockLanguageModelV4,
  callIndex: number,
): string[] {
  return (model.doStreamCalls[callIndex]?.tools ?? [])
    .map((tool) => tool.name)
    .sort();
}

/** The system prompt a model call was given. */
export function systemPromptOf(
  model: MockLanguageModelV4,
  callIndex: number,
): string {
  const system = model.doStreamCalls[callIndex]?.prompt.find(
    (message) => message.role === "system",
  );
  return typeof system?.content === "string" ? system.content : "";
}
