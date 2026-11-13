/**
 * Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
 * Effects reschedules the row after the initial retry delay without incrementing its failure count, and DshExecutor throws it from launch and delivery handlers.
 */
export class Later extends Error {}
/** Consecutive failures before an effect kind reports an error, matching the Sources poll failure threshold. */
export const FAILURES_BEFORE_ERROR = 3
/**
 * Failures after which an effect is abandoned instead of retried.
 * A full disk, a revoked repository permission, or a malformed payload never heals by waiting, so an unbounded schedule would loop forever and hide the problem.
 */
export const MAX_ATTEMPTS = 8
/** How many abandoned effects the dead-letter record keeps, newest last, so an operator sees the recent ones without the record growing without bound. */
export const MAX_DEAD_LETTERS = 20
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { Logger } from '@deepseek-ai/cordis'
import { record } from '../kv.ts'
import type { Store } from './store.ts'

export interface EffectPayloads {
  /** Build an Eval's candidate card and relay it to the main Session; the key is the Eval ID. */
  assessment: { triggerId: string }
  /** Launch a pending Assignment; the key is the Assignment ID. */
  launch: { ticketId: string; assignmentId: string }
  /** Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket ID. */
  delivery: { ticketId: string }
  /** Steer a report or a candidate into the main Session; the key is the request ID. */
  relay: { text: string }
  /** Inject a notice into the main Session without waking it; the key names what it reports, such as `prompts`. */
  notice: { value: Record<string, unknown>; summary: string }
  /** Send a message for a Channel through its Source; the key is the message ID, whose receipt the Outbox keeps. */
  reply: Record<string, never>
}
export type EffectKind = keyof EffectPayloads
/** An effect Effects gave up on: `requestId` is the row's key, which names the request for relays and the message for replies. */
export interface DeadLetter { kind: EffectKind; requestId: string; error: string; attempts: number; at: string }
/**
 * KV key of the dead letters. It lives here rather than in `KV` because only Effects writes it, and it is one bounded record
 * instead of one key per letter so trimming it is one write and the queue can never grow it without limit.
 */
const DEAD_LETTERS = record<DeadLetter[]>('effect-dead-letters')
interface Handler<K extends EffectKind> {
  run: (payload: EffectPayloads[K], key: string) => Promise<void>
  /** How many may run at once now; 0 holds the kind, such as while processing is paused. */
  limit: () => number
  /** Initial and maximum retry backoff delays, in milliseconds. */
  retry: readonly [number, number]
  /** Effects run one at a time in queue order, and a failed one holds back later rows of the same kind. */
  ordered: boolean
  /** When true, repeated failures do not mark the effect kind's health entry as `error` (used when failures are already surfaced on a ticket). */
  quiet: boolean
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>
/** `seq` preserves the row's queue position; `generation` increments on payload updates so a running attempt does not delete a newer payload. */
interface Row { key: string; value: string; seq: number; generation: number; attempts: number; due: number }
type Task = { kind: EffectKind; key: string; done: Promise<void> }

/**
 * Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
 * Coordinates per-kind handlers, concurrency limits, exponential backoff, and health reporting for MasterAssessor, DshExecutor, Sessions, and Outbox.
 */
export class Effects {
  private readonly handlers = new Map<EffectKind, Handler<never>>()
  private readonly health = new Map<EffectKind, HealthEntry>()
  private readonly tasks = new Set<Task>()
  /** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
  private readonly broken = new Set<EffectKind>()
  private seq: number
  private scheduled = false
  /** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
  private started = false
  private stopped = false
  constructor(private readonly store: Store, private readonly board: Pick<HealthBoard, 'claim'>, private readonly now = () => Date.now(),
    /** Receives the one error per abandoned effect; optional so the queue works without a logger, as in unit tests. */
    private readonly logger?: Pick<Logger, 'error'>) {
    this.seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  }
  /** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString())
    // Queuing the request again (the upsert above resets `attempts`) starts a fresh failure cycle, so a dead letter of the same
    // request is no longer what happened to it: keeping it would report a loss the queue is about to retry.
    this.forgetDeadLetter(kind, key)
    this.kick()
  }
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options: Options<K> = {}): void {
    if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`)
    this.health.set(kind, this.board.claim(kind))
    const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet } as unknown as Handler<never>)
    this.report(kind)
    this.kick()
  }
  /** Whether an effect of `kind` (and `key`) still waits for a dispatch; an abandoned row is kept for its record but is no longer pending. */
  pending(kind: EffectKind, key?: string): boolean {
    const abandoned = 'attempts < ?'
    return key === undefined
      ? !!this.store.db.prepare(`SELECT 1 FROM effect WHERE kind = ? AND ${abandoned} LIMIT 1`).get(kind, MAX_ATTEMPTS)
      : !!this.store.db.prepare(`SELECT 1 FROM effect WHERE kind = ? AND key = ? AND ${abandoned} LIMIT 1`).get(kind, key, MAX_ATTEMPTS)
  }
  /** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
  cancel(kind: EffectKind, key: string): void {
    this.store.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key)
    this.store.afterCommit(() => { this.report(kind) })
  }
  /** The effects Effects gave up on, newest last, for an operator reading what failed for good; the queue also counts them in each kind's health. */
  deadLetters(): DeadLetter[] { return this.store.get(DEAD_LETTERS) ?? [] }
  /** Drops the dead letter of `kind` and `key`, if any, because the request was queued again for a fresh attempt cycle. */
  private forgetDeadLetter(kind: EffectKind, key: string): void {
    const letters = this.deadLetters()
    const kept = letters.filter(letter => letter.kind !== kind || letter.requestId !== key)
    // Only write when something changed: enqueue runs inside every command's transaction and most requests never died.
    if (kept.length !== letters.length) this.store.set(DEAD_LETTERS, kept)
  }
  start(): void { this.started = true; this.kick() }
  kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.dispatch() })
  }
  /** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done)
      if (!running.length) return
      await Promise.allSettled(running)
    }
  }
  /** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
  async drain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.tasks].map(task => task.done))
  }
  private dispatch(): void {
    if (!this.started || this.stopped) return
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key))
        // Abandoned rows keep their `attempts` at the maximum and are never dispatched again: a permanently failing effect must
        // not hold an ordered kind behind it forever, nor keep a worker slot's queue blocked, so they are skipped by query.
        // Ordered kinds block behind their oldest row even when it is not yet due; limit() is queried only after ready rows exist.
        const rows = (handler.ordered
          ? this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND attempts < ? ORDER BY seq LIMIT 1').all(kind, MAX_ATTEMPTS)
          : this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? AND attempts < ? ORDER BY seq LIMIT ?')
            .all(kind, this.now(), MAX_ATTEMPTS, 16 + running.size)) as unknown as Row[]
        const ready = handler.ordered && running.size ? [] : rows.filter(row => row.due <= this.now() && !running.has(row.key))
        let room = ready.length ? handler.limit() - running.size : 0
        for (const row of ready) {
          if (room-- <= 0) break
          this.run(kind, handler, row)
        }
        if (this.broken.delete(kind)) this.report(kind)
      } catch (error) { this.failed(kind, error) }
    }
  }
  private run(kind: EffectKind, handler: Handler<never>, row: Row): void {
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.failed(kind, error) })
      .finally(() => { this.tasks.delete(task); this.kick() })
    this.tasks.add(task)
  }
  private async attempt(kind: EffectKind, handler: Handler<never>, row: Row): Promise<void> {
    let failure: { error: unknown } | undefined
    try { await handler.run(JSON.parse(row.value) as never, row.key) } catch (error) { failure = { error } }
    // Match seq and generation so a row replaced or re-queued while running is not overwritten.
    const own = 'kind = ? AND key = ? AND seq = ? AND generation = ?', ownRow = [kind, row.key, row.seq, row.generation] as const
    if (!failure) this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow)
    // Leave running rows untouched on shutdown so they retry on the next start.
    else if (this.stopped) return
    else if (failure.error instanceof Later) {
      this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow)
    } else {
      // `row.attempts` counts the failures before this one, so this attempt is number `row.attempts + 1`.
      const attempts = row.attempts + 1
      // Give up once retrying cannot help: a full disk, a revoked permission, or a malformed payload never heals by waiting.
      if (attempts >= MAX_ATTEMPTS) this.abandon(kind, row, failure.error, attempts)
      else {
        const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16))
        this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`)
          .run(String(failure.error).slice(0, 1000), this.now() + delay, ...ownRow)
      }
    }
    if (!this.stopped) this.report(kind)
  }
  /**
   * Marks a permanently failed effect and records it as a dead letter, in one transaction.
   * The row stays (at `attempts = MAX_ATTEMPTS`, which no dispatch or `pending` query selects) rather than being deleted:
   * `Store.receipts.behind` reads a `reply` row's attempts to decide whether a conversation's later messages may go, and a
   * missing row would read as zero failures and hold them forever. `attempts` here is the number of failures that led here.
   */
  private abandon(kind: EffectKind, row: Row, error: unknown, attempts: number): void {
    const text = String(error).slice(0, 1000), at = new Date(this.now()).toISOString()
    this.store.atomic(() => {
      // Match seq and generation: a row re-queued while the attempt ran belongs to a new cycle and must keep running.
      this.store.db.prepare('UPDATE effect SET attempts = ?, error = ?, due = ? WHERE kind = ? AND key = ? AND seq = ? AND generation = ?')
        .run(attempts, text, this.now(), kind, row.key, row.seq, row.generation)
      const letter: DeadLetter = { kind, requestId: row.key, error: text, attempts, at }
      this.store.set(DEAD_LETTERS, [...this.deadLetters(), letter].slice(-MAX_DEAD_LETTERS))
    })
    // Once, at error level: the queue retries nothing now, so the log is the only place an operator learns of it promptly.
    this.logger?.error('xenra-superagent gave up on the %s effect %s after %d attempts: %s', kind, row.key, attempts, text)
  }
  private failed(kind: EffectKind, error: unknown): void {
    this.broken.add(kind)
    this.health.get(kind)?.set({ state: 'error', detail: `The effect queue failed: ${String(error)}`, at: new Date(this.now()).toISOString() })
  }
  private report(kind: EffectKind): void {
    // An abandoned row is no longer waiting: it stays only as the record of a failure, which the given-up count below reports,
    // so counting it here too would show one stuck effect as both waiting and given up on.
    const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 AND attempts < ? ORDER BY seq DESC LIMIT 1) AS error
      FROM effect WHERE kind = ? AND attempts < ?`).get(kind, MAX_ATTEMPTS, kind, MAX_ATTEMPTS)
    const abandoned = this.deadLetters().filter(letter => letter.kind === kind)
    const waiting = Number(row?.waiting ?? 0), quiet = !!this.handlers.get(kind)?.quiet
    // Giving up is a failure even when nothing waits any more, so the count keeps the kind from reading as ready; a quiet kind
    // (its failures are surfaced on a ticket) still reports the count in its detail without turning the entry into an error.
    const failing = !quiet && (abandoned.length > 0 || Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR)
    const detail = `${waiting ? `${waiting} waiting since ${String(row?.since)}` : 'Nothing waiting'}`
      + `${abandoned.length ? `; ${abandoned.length} given up on` : ''}`
    this.health.get(kind)?.set(failing
      ? { state: 'error', detail: `${detail}; the last failure: ${String(abandoned.at(-1)?.error ?? row?.error)}`, at: new Date(this.now()).toISOString() }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() })
  }
}
