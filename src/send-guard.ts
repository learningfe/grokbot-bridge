export interface SendPolicy {
  ownerId: string;
  users: ReadonlySet<string>;
  trustedUsers: ReadonlySet<string>;
  trustedBots: ReadonlySet<string>;
  chats: ReadonlySet<string>;
  wechat?: WechatSendPolicy;
}

export interface WechatSendPolicy {
  ownerId: string;
  users: ReadonlySet<string>;
  trustedUsers: ReadonlySet<string>;
  trustedBots: ReadonlySet<string>;
}

export type SendCheck =
  | { ok: true; receiveIdType: "open_id" | "chat_id" | "ilink_user" }
  | { ok: false; message: string };

/** iLink ids look like `name@im.wechat` (a person) or `name@im.bot`. */
export function isIlinkId(id: string): boolean {
  return /^[A-Za-z0-9._-]+@(im\.wechat|im\.bot)$/.test(id);
}

const REFUSED =
  "Refused: target is not on an allowlist. Ask the owner to allow this person or chat.";

/** Proactive send. Feishu open_id / chat_id, or an allowlisted iLink user id. Names are not targets. */
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
  if (isIlinkId(to)) {
    const wechat = policy.wechat;
    if (!wechat) return { ok: false, message: REFUSED };
    const allowed =
      to === wechat.ownerId ||
      wechat.users.has(to) ||
      wechat.trustedUsers.has(to) ||
      wechat.trustedBots.has(to);
    if (!allowed) return { ok: false, message: REFUSED };
    return { ok: true, receiveIdType: "ilink_user" };
  }
  return { ok: false, message: REFUSED };
}
