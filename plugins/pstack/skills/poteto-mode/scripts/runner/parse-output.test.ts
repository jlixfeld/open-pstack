import { describe, expect, it } from "bun:test";
import {
  parseClaudeSessionLimit,
  parseProviderOutput,
  reportedModelMatches,
} from "./parse-output.ts";

const OBSERVED_CLAUDE_SESSION_LIMIT = JSON.stringify({
  duration_api_ms: 65277,
  stop_reason: "stop_sequence",
  session_id: "098e45a4-671d-4f4e-aaaa-51abd7fbc8a3",
  total_cost_usd: 1.0764304999999998,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 80240,
    cache_read_input_tokens: 298407,
    output_tokens: 4932,
  },
  modelUsage: { "claude-opus-5": { inputTokens: 10 } },
  terminal_reason: "api_error",
  is_error: true,
  api_error_status: 429,
  result: "You've hit your session limit · resets 2:10pm (America/Toronto)",
  type: "result",
});

describe("parseProviderOutput", () => {
  it("recognizes the observed structured Claude session-limit envelope", () => {
    expect(
      parseClaudeSessionLimit(
        OBSERVED_CLAUDE_SESSION_LIMIT,
        "2026-09-04T18:00:00.000Z"
      )
    ).toMatchObject({
      kind: "claude-session-limit",
      terminalReason: "api_error",
      apiStatus: 429,
      observedAt: "2026-09-04T18:00:00.000Z",
      message: "You've hit your session limit · resets 2:10pm (America/Toronto)",
      resetEvidence: "You've hit your session limit · resets 2:10pm (America/Toronto)",
    });
  });

  it("extracts Claude text, model, usage, cost, and session", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        session_id: "claude-session",
        usage: { input_tokens: 10, output_tokens: 3 },
        total_cost_usd: 0.05,
        modelUsage: { "claude-fable-5-1": { inputTokens: 10 } },
      }),
      "",
      "claude-fable-5-1"
    );
    expect(parsed).toMatchObject({
      text: "CLAUDE_OK",
      reportedModel: "claude-fable-5-1",
      sessionId: "claude-session",
      usage: { inputTokens: 10, outputTokens: 3 },
      costUsd: 0.05,
    });
  });

  it("extracts Codex JSONL without inventing a provider-reported model", () => {
    const parsed = parseProviderOutput(
      "codex",
      [
        JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "CODEX_OK" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            cached_input_tokens: 4,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }),
      ].join("\n"),
      "model: gpt-5.6-sol\nreasoning effort: max\n",
      "gpt-5.6-sol"
    );
    expect(parsed).toMatchObject({
      text: "CODEX_OK",
      reportedModel: null,
      sessionId: "codex-session",
      usage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 5,
        reasoningTokens: 2,
      },
    });
  });

  it("accepts Grok's reported build suffix", () => {
    const parsed = parseProviderOutput(
      "grok",
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "progress" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "GROK_OK",
          session_id: "grok-session",
          usage: {
            input_tokens: 30,
            cache_read_input_tokens: 6,
            output_tokens: 7,
            reasoning_tokens: 3,
            total_tokens: 43,
          },
          total_cost_usd: 0.02,
          modelUsage: { "grok-4.6-build": {} },
        }),
      ].join("\n"),
      "",
      "grok-4.6"
    );
    expect(parsed.text).toBe("GROK_OK");
    expect(parsed.reportedModel).toBe("grok-4.6-build");
    expect(reportedModelMatches("grok-4.6", parsed.reportedModel)).toBe(
      true
    );
  });

  it("selects the requested Claude model when usage includes a side model", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        modelUsage: {
          "claude-haiku-4-5-20251001": {},
          "claude-fable-5-1": {},
        },
      }),
      "",
      "claude-fable-5-1"
    );
    expect(parsed.reportedModel).toBe("claude-fable-5-1");
  });

  it("rejects malformed or textless responses", () => {
    expect(() =>
      parseProviderOutput("claude", "not-json", "", "claude-fable-5-1")
    ).toThrow("valid JSON");
    expect(() =>
      parseProviderOutput(
        "codex",
        JSON.stringify({ type: "turn.completed" }),
        "",
        "gpt-5.6-sol"
      )
    ).toThrow("final agent message");
  });
});
