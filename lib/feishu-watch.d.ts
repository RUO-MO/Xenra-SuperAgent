import { C as ZodOptional, D as $loose, E as output, O as $strict, S as ZodObject, T as ZodURL, _ as ZodArray, b as ZodEnum, g as Tally, h as SourceRegistry, k as $strip, n as SourceContext, t as SourceKind, v as ZodBoolean, w as ZodString, x as ZodNumber, y as ZodDefault } from "./kind-BrQBnRPl.js";
import { F as Thread, U as Trigger } from "./intake-JdfR0r-C.js";
import { Context } from "@deepseek-ai/cordis";
//#region src/sources/feishu-read.d.ts
/** Retained source message reference anchoring context reads; `at` is the timestamp around which `chatAround` queries. */
interface FeishuRef {
  triggerId: string;
  chatId: string;
  messageId: string;
  at?: string;
}
//#endregion
//#region src/sources/feishu-trigger.d.ts
declare const SOURCE = "feishu";
/** A message as the live event consumer prints it; the history and topic-page paths normalize what they read into this shape. */
declare const EventSchema: ZodObject<{
  message_id: ZodString;
  chat_id: ZodString;
  chat_type: ZodEnum<{
    p2p: "p2p";
    group: "group";
  }>;
  sender_id: ZodString;
  sender_type: ZodEnum<{
    user: "user";
    bot: "bot";
  }>;
  content: ZodString;
  create_time: ZodString;
  mentions: ZodDefault<ZodArray<ZodObject<{
    id: ZodString;
    key: ZodOptional<ZodString>;
    name: ZodOptional<ZodString>;
  }, $strip>>>;
  root_id: ZodOptional<ZodString>;
  parent_id: ZodOptional<ZodString>;
  thread_id: ZodOptional<ZodString>;
  message_app_link: ZodOptional<ZodURL>;
}, $strip>;
type FeishuEvent = output<typeof EventSchema>;
declare const feishuThreadId: (chatId: string, rootId: string | undefined, messageId: string) => string;
/** Deterministic trigger ID for a Feishu message; every read path for this message produces the same ID. */
declare const feishuTriggerId: (messageId: string) => string;
declare const withMentionNames: (text: string, mentions: {
  key?: string | undefined;
  name?: string | undefined;
}[]) => string;
/**
 * Parses a Feishu message timestamp into an ISO-8601 string: live events and the history API return epoch milliseconds as a
 * string, whereas topic/thread pages return a local timestamp string such as `2026-09-11 12:00`.
 */
declare function feishuTime(value: string): string;
/** Converts a normalized Feishu event into a Trigger, returning undefined for messages sent by the bot itself. */
declare function feishuTrigger(input: unknown, botId: string, botAppId: string): Trigger | undefined;
declare function feishuRef(trigger: Trigger): FeishuRef | undefined;
/** A message from the history API; a deleted message may have no body/content. */
declare const HistoricalMessageSchema: ZodObject<{
  message_id: ZodString;
  chat_id: ZodString;
  create_time: ZodString;
  root_id: ZodOptional<ZodString>;
  parent_id: ZodOptional<ZodString>;
  thread_id: ZodOptional<ZodString>;
  deleted: ZodOptional<ZodBoolean>;
  message_app_link: ZodOptional<ZodString>;
  sender: ZodObject<{
    id: ZodDefault<ZodString>;
    sender_type: ZodString;
  }, $loose>;
  body: ZodOptional<ZodObject<{
    content: ZodString;
  }, $loose>>;
  mentions: ZodOptional<ZodArray<ZodObject<{
    id: ZodString;
    key: ZodOptional<ZodString>;
    name: ZodOptional<ZodString>;
  }, $loose>>>;
}, $loose>;
type HistoricalMessage = output<typeof HistoricalMessageSchema>;
declare function historyEvent(message: HistoricalMessage, chatId: string, direct: boolean): unknown;
//#endregion
//#region src/sources/feishu-loops.d.ts
/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
declare const consumerRetry: (previous: number | undefined, ranMs: number) => number;
/** Refreshes the map of joined chats (`chat_id -> name`); throws on failure so the previously stored list remains intact. */
declare function refreshChatNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>>;
/**
 * Backfills chat messages and active topic replies between `since` and `until` before the caller advances the chat cursor.
 * Topics are stored as `{ id: lastSeenAt }`, and unsubscribed topics older than the polling horizon are pruned.
 */
declare function backfillChat(ctx: SourceContext, chatId: string, direct: boolean, since: string, until: string, signal: AbortSignal, tally?: Tally): Promise<void>;
/** Resolves the retained source message reference for polling a subscribed thread. */
declare function threadRef(ctx: SourceContext, thread: Thread): FeishuRef | undefined;
/** Polls subscribed Feishu threads within the polling horizon so replies missed by the live stream become triggers. */
declare function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally?: Tally): Promise<void>;
//#endregion
//#region src/sources/feishu.d.ts
declare const FeishuConfigSchema: ZodObject<{
  cli: ZodDefault<ZodString>;
  readPageSize: ZodDefault<ZodNumber>;
  linkTimeoutMs: ZodDefault<ZodNumber>;
  chats: ZodDefault<ZodArray<ZodObject<{
    chatId: ZodString;
    name: ZodOptional<ZodString>;
    listen: ZodEnum<{
      mentions: "mentions";
      all: "all";
    }>;
  }, $strict>>>;
  directMessages: ZodDefault<ZodBoolean>;
  otherChats: ZodDefault<ZodEnum<{
    mentions: "mentions";
    none: "none";
  }>>;
}, $strict>;
type FeishuConfig = output<typeof FeishuConfigSchema>;
declare const feishuKind: SourceKind<FeishuConfig>;
/** Returns the Feishu Source's settings, falling back to schema defaults while the Feishu plugin is disabled. */
declare const feishuSettings: (sources: SourceRegistry) => FeishuConfig;
declare const name = "xenra-superagent-feishu";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { FeishuConfig, type FeishuEvent, SOURCE, apply, backfillChat, consumerRetry, feishuKind, feishuRef, feishuSettings, feishuThreadId, feishuTime, feishuTrigger, feishuTriggerId, historyEvent, inject, name, pollThreads, refreshChatNames, threadRef, withMentionNames };