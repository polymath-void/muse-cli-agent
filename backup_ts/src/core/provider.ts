/**
 * src/core/provider.ts — Model/provider/gateway state + selection resolution.
 */
import { readLastModel, writeLastModel } from "./last-model.js";

export type GatewayId = "meta" | "echo" | "local" | "google" | "agy" | "opencode";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ProviderMode = GatewayId;

export const PERSISTABLE_GATEWAYS: GatewayId[] = ["meta", "google", "agy", "opencode"];
export const ALL_GATEWAYS: GatewayId[] = ["meta", "echo", "local", "google", "agy", "opencode"];
export const EFFORT_LEVELS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface ExplicitSelection {
  model?: string;
  provider?: GatewayId;
  effort?: ReasoningEffort;
}

export interface RememberedSelection {
  model?: string;
  gatewayId?: string;
  reasoningEffort?: string;
}

export interface ResolvedSelection {
  model: string;
  provider: GatewayId;
  effort: ReasoningEffort;
}


export function resolveModelAlias(model: string): string {
  // Pass-through exactly what the user provides, since they confirmed their backend supports these exact names.
  return model;
}

export function gatewayForModel(model: string): GatewayId {
  const m = model.toLowerCase();
  if (m.startsWith("gemini") || m.includes("google")) return "google";
  if (m.startsWith("claude") || m.includes("anthropic") || m.includes("agy")) return "agy";
  if (m.startsWith("opencode") || m.includes("/opencode") || m.includes("muse-spark")) return "opencode";
  if (m.startsWith("gpt") || m.includes("openai")) return "meta";
  return "opencode";
}

export function modelsForGateway(gw: string): string[] {
  const g = gw.toLowerCase();
  if (g === "google") {
    return ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-3.1-pro", "gemini-3.0-pro"];
  }
  if (g === "agy") {
    return ["claude-sonnet-4-5", "claude-sonnet-4-6", "claude-opus-4-1", "claude-4.5-sonnet", "claude-3.7-sonnet"];
  }
  if (g === "opencode") {
    return [
      "muse-spark-1.3-contributor-free",
      "opencode/grok-code",
      "opencode/qwen3-coder",
      "opencode/claude-sonnet-4.5",
      "opencode/kimi-k2",
      "opencode/deepseek-v3.1",
      "opencode/cursor-ide",
    ];
  }
  if (g === "meta") {
    return ["muse-spark-1.3", "gpt-4o", "gpt-4.1", "gpt-5", "gpt-5-mini"];
  }
  return [];
}

export function resolveInitialSelection(
  explicit: ExplicitSelection,
  remembered: RememberedSelection | null,
): ResolvedSelection {
  const model =
    explicit.model && resolveModelAlias(explicit.model.trim()).length > 0
      ? resolveModelAlias(explicit.model.trim())
      : remembered?.model && resolveModelAlias(remembered.model.trim()).length > 0
        ? resolveModelAlias(remembered.model.trim())
        : "muse-spark-1.3";

  let provider: GatewayId | undefined = explicit.provider;
  if (!provider) {
    const rgw = remembered?.gatewayId;
    if (rgw && (PERSISTABLE_GATEWAYS as string[]).includes(rgw)) {
      provider = rgw as GatewayId;
    }
  }
  if (!provider) {
    provider = gatewayForModel(model);
  }

  const effort =
    explicit.effort ??
    (remembered?.reasoningEffort && (EFFORT_LEVELS as string[]).includes(remembered.reasoningEffort)
      ? (remembered.reasoningEffort as ReasoningEffort)
      : "high");

  return { model, provider, effort };
}

export function persistSelection(workspace: string, sel: ResolvedSelection): void {
  writeLastModel(workspace, {
    model: sel.model,
    gatewayId: sel.provider,
    reasoningEffort: sel.effort,
  });
}

export function loadRememberedSelection(workspace: string): RememberedSelection | null {
  return readLastModel(workspace);
}
