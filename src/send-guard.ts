export interface SendPolicy {
  ownerId: string;
  users: ReadonlySet<string>;
  trustedUsers: ReadonlySet<string>;
  trustedBots: ReadonlySet<string>;
  chats: ReadonlySet<string>;
}

export type SendCheck =
  { ok: true; receiveIdType: "open_id" | "chat_id" } | { ok: false; message: string };

const REFUSED =
  "Refused: target is not on an allowlist. Ask the owner to allow this person or chat.";

/** Proactive send. open_id (ou_) and chat_id (oc_) only; names are not targets. */
export function checkSendTarget(to: string, policy: SendPolicy): SendCheck {
  if (to.startsWith("ou_")) {
    const allowed =
      to === policy.ownerId ||
      policy.users.has(to) ||
      policy.trustedUsers.has(to) ||
      policy.trustedBots.has(to);
    if (!allowed) return { ok: false, message: REFUSED };
    return { ok: true, receiveIdType: "open_id" };
  }
  if (to.startsWith("oc_")) {
    if (!policy.chats.has(to)) return { ok: false, message: REFUSED };
    return { ok: true, receiveIdType: "chat_id" };
  }
  return { ok: false, message: REFUSED };
}
