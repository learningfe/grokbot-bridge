import type { Trust } from "./types.js";

export interface FilterInput {
  chatType: "p2p" | "group";
  chatId: string;
  senderId: string;
  selfBotId: string;
  trust: Trust;
  mentionedBot: boolean;
  repliesToBot: boolean;
  allowedChats: ReadonlySet<string>;
}

/**
 * DMs: owner, trusted users, allowed users, and trusted bots.
 * Groups: the chat must be allowlisted. Mention, reply-to-self, and
 * trusted-bot rules are applied separately by acceptInbound.
 * The bot's own echoed messages are not part of the conversation.
 */
export function inConversation(input: FilterInput): boolean {
  if (input.selfBotId !== "" && input.senderId === input.selfBotId) return false;
  if (input.chatType === "p2p") {
    return (
      input.trust === "owner" ||
      input.trust === "trusted_user" ||
      input.trust === "allowed_user" ||
      input.trust === "trusted_bot"
    );
  }
  return input.allowedChats.has(input.chatId);
}

/** Group messages also need an @, a reply to this bot, or a trusted bot. */
export function acceptInbound(input: FilterInput): boolean {
  if (!inConversation(input)) return false;
  if (input.chatType === "p2p") return true;
  return input.mentionedBot || input.repliesToBot || input.trust === "trusted_bot";
}
