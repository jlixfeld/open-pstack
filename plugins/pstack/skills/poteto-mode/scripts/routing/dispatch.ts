import type { Provider } from "./manifest.ts";

export type Parent = "claude" | "codex";
export type Route = "native" | "external";

export function resolveRoute(parent: Parent, provider: Provider | "inherit-parent" | "auto"): Route {
  if (provider === "inherit-parent" || provider === "auto") return "native";
  if (provider === "grok") return "external";
  return parent === provider ? "native" : "external";
}
