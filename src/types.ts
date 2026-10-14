export type SenderType = "user" | "bot";

export type Trust = "owner" | "trusted_user" | "allowed_user" | "trusted_bot" | "unknown";

/** Display name is never an identity. Trust is resolved from id + type only. */
export interface Sender {
  id: string;
  type: SenderType;
  name?: string;
  trust: Trust;
}

export interface Mention {
  id: string;
  type: SenderType;
  name?: string;
  key?: string;
}

export interface Attachment {
  type: string;
  key?: string;
  name?: string;
}

/** Platform facts, before trust and routing. */
export interface InboundMessage {
  eventId: string;
  messageId: string;
  channel: "feishu";
  chatId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  sender: {
    id: string;
    type: SenderType;
    name?: string;
  };
  text: string;
  mentions: Mention[];
  /** True only when a mention open_id is this app's bot, or the mention is @_all. */
  mentionedBot: boolean;
  replyToMessageId?: string;
  attachments: Attachment[];
  messageType: string;
  timestamp: number;
}

export interface NormalizedEvent {
  id: string;
  messageId: string;
  channel: "feishu";
  scope: string;
  chatId: string;
  chatType: "p2p" | "group";
  threadId?: string;
  chatName?: string;
  sender: Sender;
  text: string;
  mentions: Mention[];
  replyToMessageId?: string;
  repliesToBot: boolean;
  attachments: Attachment[];
  messageType: string;
  timestamp: number;
}

export interface ContextLine {
  messageId: string;
  senderId?: string;
  senderType?: SenderType;
  text: string;
  timestamp?: number;
}

export interface WebhookContextLine extends ContextLine {
  trust: Trust;
}

export interface WebhookBody {
  scope: string;
  bot: string;
  events: NormalizedEvent[];
  recentContext: WebhookContextLine[];
}

export interface ChannelHandlers {
  onMessage: (message: InboundMessage) => void;
  onRecall: (messageId: string) => void;
}

export interface Channel {
  readonly name: "feishu";
  readonly botOpenId: string;
  start(handlers: ChannelHandlers): Promise<void>;
  stop(): Promise<void>;
  reply(input: {
    messageId: string;
    text: string;
    uuid: string;
    inThread: boolean;
  }): Promise<{ messageId: string }>;
  send(input: { to: string; text: string; uuid: string }): Promise<{ messageId: string }>;
  react(input: { messageId: string; emoji: string }): Promise<void>;
  isRecalled(messageId: string): Promise<boolean>;
  recentContext(input: {
    chatId: string;
    threadId?: string;
    limit: number;
    skipMessageIds: ReadonlySet<string>;
  }): Promise<ContextLine[]>;
  lookupChatName(chatId: string): Promise<string | undefined>;
}
