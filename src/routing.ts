export function scopeKey(input: {
  chatType: "p2p" | "group";
  senderId: string;
  chatId: string;
  threadId?: string;
}): string {
  if (input.chatType === "p2p") return `dm:${input.senderId}`;
  if (input.threadId) return `thread:${input.threadId}`;
  return `group:${input.chatId}`;
}

/**
 * Exact scope wins. A thread with no route of its own uses the parent
 * group's route, then the default bot.
 */
export function resolveBot(
  scope: string,
  chatId: string,
  routes: Readonly<Record<string, string>>,
  defaultBot: string,
): string {
  const direct = routes[scope];
  if (direct) return direct;
  if (scope.startsWith("thread:")) {
    const groupBot = routes[`group:${chatId}`];
    if (groupBot) return groupBot;
  }
  return defaultBot;
}
