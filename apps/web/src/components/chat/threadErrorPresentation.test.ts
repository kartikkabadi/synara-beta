import { describe, expect, it } from "vitest";
import { presentThreadError } from "./threadErrorPresentation";

describe("presentThreadError", () => {
  it("classifies the delivery quarantine and keeps its recovery action", () => {
    const raw =
      "Thread is blocked by an earlier provider failure: delivery d-1 was never acknowledged";
    const presentation = presentThreadError(raw);

    expect(presentation).toMatchObject({
      kind: "delivery-block",
      tone: "error",
      title: "Thread is blocked by an earlier provider failure",
      detail: "delivery d-1 was never acknowledged",
      retryable: false,
      canUnblock: true,
      raw,
    });
  });

  it("keeps the summary-only delivery quarantine readable", () => {
    const presentation = presentThreadError("Thread is blocked by an earlier provider failure");
    expect(presentation.kind).toBe("delivery-block");
    expect(presentation.canUnblock).toBe(true);
    expect(presentation.detail).toBeNull();
  });

  it("classifies upstream 429 JSON blobs as a transient rate limit", () => {
    const presentation = presentThreadError(
      'Error from provider (Console Go): Upstream request failed: {"code":"rate_limit_exceeded","type":"rate_limit_error","message":"OpenAI API error (429): Rate limit exceeded. Please retry after a brief wait."}',
    );

    expect(presentation.kind).toBe("rate-limit");
    expect(presentation.tone).toBe("warning");
    expect(presentation.title).toBe("Rate limit reached");
    expect(presentation.detail).toContain("Console Go");
    expect(presentation.retryable).toBe(true);
    expect(presentation.canUnblock).toBe(false);
  });

  it("classifies bare rate-limit text without a provider name", () => {
    const presentation = presentThreadError("429 Too Many Requests");

    expect(presentation.kind).toBe("rate-limit");
    expect(presentation.detail).toContain("The provider is throttling");
  });

  it("classifies socket-open timeouts as a transient connection failure", () => {
    const presentation = presentThreadError(
      'SocketOpenError: timeout waiting for "open" while connecting to wss://relay.example/ws',
    );

    expect(presentation).toMatchObject({
      kind: "connection",
      tone: "warning",
      retryable: true,
    });
  });

  it("classifies the Pi agent-busy rejection as transient", () => {
    const presentation = presentThreadError(
      "Agent is already processing a prompt. Specify streamingBehavior ('steer' or 'followUp') to control how new prompts are handled during agent processing.",
    );

    expect(presentation).toMatchObject({
      kind: "agent-busy",
      tone: "warning",
      title: "The agent is still working",
      retryable: true,
    });
  });

  it("classifies a Claude overload as a retryable transient failure", () => {
    const presentation = presentThreadError("Claude is temporarily overloaded. Retry in a moment.");

    expect(presentation).toMatchObject({
      kind: "transient",
      tone: "warning",
      title: "Temporary provider error",
      retryable: true,
      canUnblock: false,
    });
  });

  it("classifies provider server errors as transient", () => {
    const presentation = presentThreadError("Claude returned a server error. Retry in a moment.");

    expect(presentation.kind).toBe("transient");
    expect(presentation.retryable).toBe(true);
  });

  it("does not treat account failures ending in 'retry' as transient", () => {
    const presentation = presentThreadError(
      "Claude billing or subscription access failed. Check the active Claude account, then retry.",
    );

    expect(presentation.kind).not.toBe("transient");
  });

  it("classifies client-side action hints as guidance, not failures", () => {
    const presentation = presentThreadError(
      "Interrupt the current turn before reverting checkpoints.",
    );

    expect(presentation).toMatchObject({
      kind: "guidance",
      tone: "warning",
      retryable: false,
      canUnblock: false,
    });
  });

  it("keeps the first line of unrecognized errors as the title", () => {
    const raw = "Provider exploded\n  at someStackFrame (file.ts:1:1)";
    const presentation = presentThreadError(raw);

    expect(presentation).toMatchObject({
      kind: "generic",
      tone: "error",
      title: "Provider exploded",
      detail: null,
      retryable: false,
      canUnblock: false,
      raw,
    });
  });

  it("falls back to a fixed title when the raw error is a bare JSON blob", () => {
    const presentation = presentThreadError('{"code":"internal","message":"boom"}');

    expect(presentation.kind).toBe("generic");
    expect(presentation.title).toBe("Provider error");
    expect(presentation.raw).toBe('{"code":"internal","message":"boom"}');
  });

  it("truncates very long first lines", () => {
    const raw = "x".repeat(500);
    const presentation = presentThreadError(raw);

    expect(presentation.title.length).toBeLessThanOrEqual(160);
    expect(presentation.title.endsWith("…")).toBe(true);
  });
});
