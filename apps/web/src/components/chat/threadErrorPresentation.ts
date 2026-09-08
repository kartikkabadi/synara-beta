// FILE: threadErrorPresentation.ts
// Purpose: Classify raw thread-level errors into the inline transcript card's copy and tone.
// Layer: Chat status presentation
// Exports: ThreadErrorKind, ThreadErrorPresentation, presentThreadError
//
// `thread.error` arrives as a raw provider string — JSON error blobs, SDK jargon,
// stack-y one-liners. The transcript card needs a short title, a plain-English
// detail line, and a tone that says whether the failure is transient.

import {
  isProviderDeliveryBlockDetail,
  PROVIDER_DELIVERY_BLOCK_SUMMARY,
} from "@synara/shared/providerDeliveryBlock";

export type ThreadErrorKind =
  | "delivery-block"
  | "rate-limit"
  | "connection"
  | "agent-busy"
  | "transient"
  | "guidance"
  | "generic";

export interface ThreadErrorPresentation {
  readonly kind: ThreadErrorKind;
  readonly tone: "error" | "warning";
  readonly title: string;
  readonly detail: string | null;
  /** The card offers "Try again", which resends through the normal send path. */
  readonly retryable: boolean;
  /** The card offers "Unblock thread" for the delivery-quarantine recovery. */
  readonly canUnblock: boolean;
  readonly raw: string;
}

const RATE_LIMIT_PATTERN =
  /rate[_ -]?limit|\b429\b|too many requests|quota exceeded|usage limit|insufficient.?quota/i;

const CONNECTION_PATTERN =
  /socket ?(?:open|hang ?up)|timeout waiting for|timed? ?out|econn\w*|etimedout|enetunreach|ehostunreach|(?:fetch|network)\s*(?:failed|error)|web ?socket/i;

const AGENT_BUSY_PATTERN =
  /already (?:processing|running|busy)|streamingbehavior|still processing/i;

// Provider-side transient failures — overloads and 5xx responses the adapter
// itself tells the user to retry ("Claude is temporarily overloaded. Retry in a
// moment.", "Claude returned a server error. Retry in a moment."). Deliberately
// does not match a bare "retry": account/billing failures end with the same
// instruction but need user action first.
const TRANSIENT_PATTERN =
  /overload|(?:internal )?server error|service unavailable|bad gateway|temporarily unavailable|\b5[0-9]{2}\b/i;

// Client-side guidance errors ("Interrupt the current turn before reverting
// checkpoints", "Only the latest rollbackable user message can be edited.") are
// action hints, not failures — warning tone, no retry.
const GUIDANCE_PATTERN = /^(interrupt the current turn|only the latest|wait for the current send)/i;

const PROVIDER_NAME_PATTERN = /error from provider \(([^)]+)\)/i;

const MAX_TITLE_LENGTH = 160;

// Keep the first line of the raw error as the generic title: for unrecognized
// failures the message itself is the only information we have.
function condensedFirstLine(raw: string): string {
  const firstLine = (raw.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function deliveryBlockDetail(raw: string): string | null {
  const detail = raw.trim().slice(PROVIDER_DELIVERY_BLOCK_SUMMARY.length).replace(/^:\s*/, "");
  return detail.length > 0 ? detail : null;
}

export function presentThreadError(raw: string): ThreadErrorPresentation {
  if (isProviderDeliveryBlockDetail(raw)) {
    return {
      kind: "delivery-block",
      tone: "error",
      title: PROVIDER_DELIVERY_BLOCK_SUMMARY,
      detail: deliveryBlockDetail(raw),
      retryable: false,
      canUnblock: true,
      raw,
    };
  }
  if (RATE_LIMIT_PATTERN.test(raw)) {
    const providerName = PROVIDER_NAME_PATTERN.exec(raw)?.[1];
    return {
      kind: "rate-limit",
      tone: "warning",
      title: "Rate limit reached",
      detail: providerName
        ? `${providerName} is throttling requests right now. Wait a moment, then try again.`
        : "The provider is throttling requests right now. Wait a moment, then try again.",
      retryable: true,
      canUnblock: false,
      raw,
    };
  }
  if (AGENT_BUSY_PATTERN.test(raw)) {
    return {
      kind: "agent-busy",
      tone: "warning",
      title: "The agent is still working",
      detail:
        "The previous turn was still running when your message was sent. Try again to resend it.",
      retryable: true,
      canUnblock: false,
      raw,
    };
  }
  if (CONNECTION_PATTERN.test(raw)) {
    return {
      kind: "connection",
      tone: "warning",
      title: "Connection interrupted",
      detail: "Could not reach the service in time. Check the network, then try again.",
      retryable: true,
      canUnblock: false,
      raw,
    };
  }
  const firstLine = condensedFirstLine(raw);
  const title = firstLine.length > 0 && !firstLine.startsWith("{") ? firstLine : "Provider error";
  if (TRANSIENT_PATTERN.test(raw)) {
    return {
      kind: "transient",
      tone: "warning",
      title: "Temporary provider error",
      detail: "The provider hit a temporary error. Wait a moment, then try again.",
      retryable: true,
      canUnblock: false,
      raw,
    };
  }
  if (GUIDANCE_PATTERN.test(firstLine)) {
    return {
      kind: "guidance",
      tone: "warning",
      title,
      detail: null,
      retryable: false,
      canUnblock: false,
      raw,
    };
  }
  return {
    kind: "generic",
    tone: "error",
    title,
    detail: null,
    retryable: false,
    canUnblock: false,
    raw,
  };
}
