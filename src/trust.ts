import type { SenderType, Trust } from "./types.js";

export interface TrustPolicy {
  ownerId: string;
  trustedUsers: ReadonlySet<string>;
  allowedUsers: ReadonlySet<string>;
  trustedBots: ReadonlySet<string>;
}

/**
 * Trust is a function of the platform sender id and sender_type only.
 * Display names, mention text, and message bodies are not inputs.
 */
export function resolveTrust(sender: { id: string; type: SenderType }, policy: TrustPolicy): Trust {
  if (sender.type === "bot") {
    return policy.trustedBots.has(sender.id) ? "trusted_bot" : "unknown";
  }
  if (sender.id === policy.ownerId) return "owner";
  if (policy.trustedUsers.has(sender.id)) return "trusted_user";
  if (policy.allowedUsers.has(sender.id)) return "allowed_user";
  return "unknown";
}
