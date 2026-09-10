// FILE: diagnosticsProvider.ts
// Purpose: Maps the app's ProviderKind onto the diagnostics provider enum.
// Layer: web support

import type { DiagnosticsProvider, ProviderKind } from "@synara/contracts";

const PROVIDER_TO_DIAGNOSTICS = {
  codex: "codex",
  claudeAgent: "claude",
  cursor: "cursor",
  antigravity: "antigravity",
  grok: "grok",
  droid: "droid",
  opencode: "opencode",
  pi: "other",
  devin: "devin",
} as const satisfies Readonly<Record<ProviderKind, DiagnosticsProvider>>;

export function toDiagnosticsProvider(provider: ProviderKind): DiagnosticsProvider {
  return PROVIDER_TO_DIAGNOSTICS[provider];
}
