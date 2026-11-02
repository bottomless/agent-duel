import { SessionChildren } from "./children.js";
import { SessionTurns } from "./turns.js";
import { V2Timeline } from "./timeline.js";
import { waitForLocationReady, awaitPaseoPlugin } from "./readiness.js";

import type { ModelRef, SessionInfo, SessionMessageInfo } from "@opencode/client";

import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type {
  AgentMode,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "../../../agent-sdk-types.js";

import { toDiagnosticErrorMessage } from "../../diagnostic-utils.js";

import { runProviderTurn } from "../../provider-runner.js";

import { composeSystemPromptParts } from "../../../system-prompt.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";

import { type V2Connection } from "./runtime.js";
import { modelRef, modesFromV2 } from "./mapping.js";

import { V2_CAPABILITIES } from "./capabilities.js";
import {
  features,
  arenaModelRef,
  applySelection,
  type DeferredSelection,
} from "./configuration.js";
import { commands } from "./commands.js";
import { messages } from "./history.js";
import { SessionPermissions } from "./permissions.js";
import { SessionUsage } from "./usage.js";
import { createArenaSessionApi } from "./arena.js";
import { uploadDirectoriesForPrompt } from "../../opencode-agent.js";

/** The longest one agent, model, or variant write may hold the selection queue. */
export const SELECTION_TIMEOUT_MS = 60_000;
/** The longest the read-back after a timed-out write may take. */
const READ_BACK_TIMEOUT_MS = 10_000;
/** How many times `getRuntimeInfo` reads again when a selection write overlapped its read. */
const RUNTIME_READ_ATTEMPTS = 3;

/** A queued selection job: its abort signal, and `write` to wrap each engine write it sends. */
interface SelectionJob {
  signal: AbortSignal;
  write<T>(send: () => Promise<T>): Promise<T>;
  /** Throw when the job has settled or timed out; call it before any change a job makes. */
  assertOpen(): void;
}
/**
 * Runs after a job timed out, with the session as the engine now holds it. Return the job's
 * result when the engine holds what the job asked for, so a write that landed late still counts.
 */
type ConfirmSelection<T> = (engine: SessionInfo) => { value: T } | undefined;

function sameModel(a: ModelRef | undefined, b: ModelRef) {
  return a?.providerID === b.providerID && a.id === b.id && a.variant === b.variant;
}

class SelectionTimeoutError extends Error {
  override name = "SelectionTimeoutError";
}

/** The parts of `selection` that the session `engine` does not hold yet. */
function notHeldBy(engine: SessionInfo, selection: DeferredSelection): DeferredSelection {
  const { agent, model } = selection;
  return {
    ...(agent && engine.agent !== agent ? { agent } : {}),
    ...(model && !sameModel(engine.model, model) ? { model } : {}),
  };
}

/** Run `work` with a signal that aborts after `ms`. Settle then even if `work` ignores the signal. */
async function bounded<T>(
  parent: AbortSignal,
  ms: number,
  message: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new SelectionTimeoutError(message)), ms);
  const signal = AbortSignal.any([parent, timeout.signal]);
  let fail!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    fail = () => reject(signal.reason);
  });
  signal.addEventListener("abort", fail, { once: true });
  try {
    return await Promise.race([work(signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", fail);
  }
}

export class OpenCodeV2Session implements AgentSession {
  readOnly = false;
  readonly provider = "opencode";
  readonly capabilities = V2_CAPABILITIES;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private timeline = new V2Timeline();
  private replacingHistory = false;
  private readonly abort = new AbortController();
  private readonly permissions: SessionPermissions;
  private readonly turns: SessionTurns;
  private readonly children: SessionChildren;
  private readonly usage: SessionUsage;
  private stream: Promise<void> | null = null;
  private streamAbort = new AbortController();
  private exited = false;
  private reconnecting: Promise<void> | null = null;
  private launchEnv: Record<string, string> | undefined;
  private sync: Promise<void> = Promise.resolve();
  private dirty = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly arenaEnabled: boolean;
  private history: SessionMessageInfo[] = [];
  private modes: AgentMode[] = [];
  private deferred: DeferredSelection = {};
  private applyingDeferred: Promise<void> | null = null;
  private selectionQueue: Promise<unknown> = Promise.resolve();
  // Selection jobs that sent an engine write and have not settled, and a counter bumped when such
  // a job starts its first write and when it settles; see `readInfo`.
  private writesInFlight = 0;
  private writeEpoch = 0;
  private followUpRead = false;
  // The size held for the running turn; it is pending while `deferred.model` is this object.
  private heldModel: ModelRef | undefined;
  private readonly explicitChoices = { agent: 0, model: 0 };
  // The deferred part that an explicit choice dropped, kept until a choice for that part
  // succeeds, so the last of several refused choices can still restore it.
  private readonly droppedDeferral: DeferredSelection = {};
  constructor(
    private connection: V2Connection,
    private info: SessionInfo,
    private readonly config: AgentSessionConfig,
    private readonly logger: Logger,
    private readonly persist: boolean,
    private readonly requiresPaseoPlugin: boolean,
    private readonly arenaMode = false,
    private readonly unbind?: () => void,
    bindChild?: (id: string) => void,
    private readonly acquire?: () => Promise<V2Connection>,
    private readonly moved?: (connection: V2Connection) => void,
    private readonly uploadsRoot?: string,
  ) {
    this.arenaEnabled = Boolean(connection.arena);
    this.permissions = new SessionPermissions(
      () => this.client,
      info.id,
      config,
      (event) => this.emit(event),
    );
    this.children = new SessionChildren({
      client: () => this.client,
      id: info.id,
      emit: (event) => this.emit(event),
      reconcilePermissions: (id) => this.permissions.reconcile(id),
      bindChild,
    });
    this.turns = new SessionTurns({
      client: () => this.client,
      id: info.id,
      cwd: config.cwd,
      signal: this.abort.signal,
      emit: (event) => {
        this.emit(event);
        if (
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled"
        )
          this.applyHeldSelection();
      },
      reconcile: async () => {
        await this.reconcile();
        return { info: this.info, history: this.history };
      },
      reportReconciliationError: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode turn reconciliation failed; retrying",
        ),
      clearPermissions: async () => {
        for (const request of this.permissions.list())
          await this.permissions.respondToPermission(request.id, { behavior: "deny" });
      },
    });
    this.usage = new SessionUsage({
      client: () => this.client,
      cwd: config.cwd,
      info: () => this.info,
      emit: (event) => this.emit(event),
      reportError: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode context usage update failed",
        ),
    });
  }
  get id() {
    return this.info.id;
  }
  get arena(): AgentSession["arena"] {
    if (!this.arenaEnabled) return undefined;
    const api = () => {
      return createArenaSessionApi({
        connection: () => {
          const arena = this.connection.arena;
          if (!arena) throw new Error("OpenCode Arena runtime is unavailable");
          return arena;
        },
        ensureRuntime: () => this.reconnectIfExited(),
        directory: this.config.cwd,
        sessionId: this.id,
      });
    };
    return {
      get streamKey() {
        return api().streamKey;
      },
      stream: (target, signal, userId) => api().stream(target, signal, userId),
      resolve: (userId) => api().resolve(userId),
      singleAgentVote: (ratingId, vote, participantId) =>
        api().singleAgentVote(ratingId, vote, participantId),
      archive: () => api().archive(),
      snapshot: (chatId) => api().snapshot(chatId),
      turn: (turnId) => api().turn(turnId),
      start: (chatId, prompt, participantId, autoAccept, attachments) =>
        api().start(chatId, prompt, participantId, autoAccept, attachments),
      reply: (turnId, prompt, target, attachments) =>
        api().reply(turnId, prompt, target, attachments),
      interruptSteer: (runId, messageId) => api().interruptSteer(runId, messageId),
      discardSteer: (runId, messageIds) => api().discardSteer(runId, messageIds),
      retryRun: (runId) => api().retryRun(runId),
      resumeBattle: (turnId) => api().resumeBattle(turnId),
      vote: (turnId, vote, participantId) => api().vote(turnId, vote, participantId),
      recordReview: (turnId, events, participantId, ipAddress) =>
        api().recordReview(turnId, events, participantId, ipAddress),
      stop: (turnId) => api().stop(turnId),
      resolveStop: (turnId, resolution) => api().resolveStop(turnId, resolution),
      retryComparison: (turnId) => api().retryComparison(turnId),
      retryResolution: (turnId, mode, answers) => api().retryResolution(turnId, mode, answers),
      diff: (turnId) => api().diff(turnId),
      fileDiff: (turnId, file) => api().fileDiff(turnId, file),
      runPart: (runId, partId, location) => api().runPart(runId, partId, location),
      replyQuestion: (runId, requestId, answers) => api().replyQuestion(runId, requestId, answers),
      rejectQuestion: (runId, requestId) => api().rejectQuestion(runId, requestId),
      replyPermission: (runId, requestId, response) =>
        api().replyPermission(runId, requestId, response),
    };
  }
  get features() {
    return features(this.config);
  }
  private get client() {
    return this.connection.client;
  }
  async initialize(environment?: Record<string, string>) {
    // OpenCode replaces the whole local shell environment, rather than overlaying it.
    this.launchEnv = environment;
    this.watchExit(this.connection);
    await this.configureConnection();
    const location = { directory: this.config.cwd };
    this.modes = modesFromV2((await this.client.agent.list({ location })).data);
    this.timeline.messages(await messages(this.client, this.id));
    await this.startStream();
    await this.children.reconcile(this.id);
  }
  /** Load the transcript only: no plugins, modes, event stream, or location-scoped routes. */
  async initializeReadOnly() {
    this.readOnly = true;
    this.timeline.messages(await messages(this.client, this.id));
  }
  private watchExit(connection: V2Connection) {
    void connection.exited.then((error) => {
      if (this.closed || this.connection !== connection) return undefined;
      this.exited = true;
      this.streamAbort.abort(error);
      this.turns.fail(error);
      return undefined;
    });
  }
  private async configureConnection() {
    const location = { directory: this.config.cwd };
    if (!this.arenaMode)
      await waitForLocationReady({ client: this.client, location, signal: this.abort.signal });
    if (this.requiresPaseoPlugin)
      await awaitPaseoPlugin({ client: this.client, location, signal: this.abort.signal });
    for (const [server, config] of Object.entries(this.config.mcpServers ?? {})) {
      await this.client.mcp.add({
        server,
        location,
        config:
          config.type === "stdio"
            ? {
                type: "local",
                command: [config.command, ...(config.args ?? [])],
                environment: config.env,
                codemode: false,
              }
            : {
                type: "remote",
                url: config.url,
                headers: config.headers,
                oauth: false,
                codemode: false,
              },
      });
      await this.awaitMcp(server);
    }
    const system = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
    if (system)
      await this.client.session.instructions.entry.put({
        sessionID: this.id,
        key: "paseo",
        value: system,
      });
  }
  private async startStream() {
    let ready!: () => void;
    let fail!: (error: unknown) => void;
    const first = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    this.stream = this.consume(ready, fail);
    await raceProviderRefreshAbort(
      AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
      first,
    );
  }
  private async reconnectIfExited() {
    if (this.closed) throw new Error("OpenCode session is closed");
    if (!this.exited) return;
    this.reconnecting ??= this.reconnect().finally(() => {
      this.reconnecting = null;
    });
    await this.reconnecting;
  }
  private async reconnect() {
    if (!this.acquire) throw new Error("OpenCode helper server exited");
    await this.stream;
    await this.sync.catch(() => undefined);
    const next = await this.acquire();
    if (this.closed) {
      await next.release();
      throw new Error("OpenCode session is closed");
    }
    const old = this.connection;
    this.connection = next;
    this.streamAbort = new AbortController();
    this.exited = false;
    this.watchExit(next);
    try {
      await this.configureConnection();
      await this.startStream();
    } catch (error) {
      this.connection = old;
      this.exited = true;
      this.streamAbort.abort();
      await next.release();
      throw error;
    }
    this.moved?.(next);
    await old.release();
  }
  subscribe(callback: (event: AgentStreamEvent) => void) {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
  private async awaitMcp(server: string) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
    while (true) {
      const catalog = await this.client.mcp.list(
        { location: { directory: this.config.cwd } },
        { signal },
      );
      const entry = catalog.data.find((item) => item.name === server);
      if (entry?.status.status === "connected") return;
      if (entry && entry.status.status !== "pending") {
        const reason = entry.status.status === "failed" ? entry.status.error : entry.status.status;
        throw new Error(`OpenCode MCP server ${server} failed to connect: ${reason}`);
      }
      await delay(50, undefined, { signal });
    }
  }
  private emit(event: AgentStreamEvent) {
    for (const listener of this.listeners) listener(event);
  }
  private emitTimeline(event: AgentStreamEvent) {
    this.emit({ ...event, ...(this.turns.id ? { turnId: this.turns.id } : {}) });
  }
  async *streamHistory() {
    await this.reconnectIfExited();
    const history = new V2Timeline(false);
    yield* history.messages(await messages(this.client, this.id));
  }
  async replaceHistory(replace: (history: Iterable<AgentStreamEvent>) => Promise<void>) {
    await this.reconnectIfExited();
    this.sync = this.sync
      .catch(() => undefined)
      .then(async () => {
        this.replacingHistory = true;
        try {
          const snapshot = await messages(this.client, this.id);
          const live = new V2Timeline();
          live.messages(snapshot);
          await replace(new V2Timeline(false).messages(snapshot));
          this.timeline = live;
          this.history = snapshot;
          return undefined;
        } finally {
          this.replacingHistory = false;
          // Snapshot reconciliation recovers output received during the replacement.
          // Its volatile deltas have no offsets and cannot safely cross this boundary.
          this.scheduleReconcile();
        }
      });
    return this.sync;
  }
  async reloadProviderSubagents(): Promise<void> {
    await this.children.reload();
  }
  async getRuntimeInfo() {
    await this.reconnectIfExited();
    await this.readInfo(true);
    // During a hold, report the size the next turn runs: AgentManager stores this after a pick.
    const model = this.pendingHeldModel() ?? this.info.model;
    return {
      provider: "opencode",
      sessionId: this.id,
      model: model ? `${model.providerID}/${model.id}` : null,
      modeId: this.info.agent ?? null,
      thinkingOptionId: model?.variant ?? null,
    };
  }
  private pendingHeldModel() {
    return this.heldModel && this.deferred.model === this.heldModel ? this.heldModel : undefined;
  }
  /**
   * Read the session into the cached info. A read that a selection write overlapped can hold the
   * agent and model from before the write, so it keeps the cached agent and model; the job that
   * wrote sets them itself. Then `waitForWrites` reads again after the queue settles (up to
   * `RUNTIME_READ_ATTEMPTS` reads); without it a follow-up read is scheduled, so a change the
   * engine made by itself in that window still reaches the cache.
   */
  private async readInfo(waitForWrites: boolean, read?: () => Promise<SessionInfo>) {
    for (let attempt = 1; ; attempt += 1) {
      const clean = this.writesInFlight === 0;
      const epoch = this.writeEpoch;
      const info = await (read?.() ?? this.client.session.get({ sessionID: this.id }));
      if (clean && epoch === this.writeEpoch) {
        this.info = info;
        return;
      }
      this.info = { ...info, agent: this.info.agent, model: this.info.model };
      if (!waitForWrites || attempt >= RUNTIME_READ_ATTEMPTS) {
        this.scheduleFollowUpRead();
        return;
      }
      await this.selectionQueue;
    }
  }
  private scheduleFollowUpRead() {
    if (this.followUpRead || this.closed) return;
    this.followUpRead = true;
    void this.selectionQueue.then(() => {
      this.followUpRead = false;
      this.scheduleReconcile();
      return undefined;
    });
  }
  async getAvailableModes() {
    return this.modes;
  }
  /** Keep the agent and model a resume could not apply; see `DeferredSelection`. */
  defer(selection: DeferredSelection) {
    this.deferred = { ...selection };
  }
  // Runs before every action that depends on the session's agent or model, and after each turn.
  // While the battle is still unresolved Arena refuses again and the selection stays deferred.
  private async applyDeferred() {
    if (!this.deferred.agent && !this.deferred.model) return;
    let pending: DeferredSelection = {};
    this.applyingDeferred ??= this.serializeSelection(
      (job) => {
        pending = { ...this.deferred };
        return this.applyDeferredNow(job);
      },
      (engine) => this.confirmDeferred(pending, engine),
    ).finally(() => {
      this.applyingDeferred = null;
    });
    await this.applyingDeferred;
  }
  /** After a turn ends, apply a size that was held while it ran, so the session shows it. */
  private applyHeldSelection() {
    if (this.closed || this.exited || (!this.deferred.agent && !this.deferred.model)) return;
    void this.applyDeferred().catch((error: unknown) =>
      this.logger.warn(
        { sessionId: this.id, error: toDiagnosticErrorMessage(error) },
        "OpenCode could not apply the deferred agent and model after the turn",
      ),
    );
  }
  /** The deferred apply itself. Call it only from inside the selection queue. */
  private async applyDeferredNow(job: SelectionJob) {
    // Read inside the queue: an explicit choice that was called earlier has removed its part.
    const pending = { ...this.deferred };
    if (!pending.agent && !pending.model) return;
    // Never during a running Arena turn; it applies when the turn ends.
    if (this.arenaMode && this.turns.id !== undefined) return;
    // Skip a part the engine already holds, for example a size held during a turn that ran it.
    // A switch would only add a row (`agent-switched` even when nothing changes).
    const engine = await this.client.session.get({ sessionID: this.id }, { signal: job.signal });
    const send = notHeldBy(engine, pending);
    job.assertOpen();
    const remaining =
      send.agent || send.model
        ? await job.write(() =>
            applySelection(this.client, { ...this.info }, send, this.arenaMode, {
              signal: job.signal,
            }),
          )
        : {};
    // Set what landed on the current info: a read during the write can have replaced the object.
    if (pending.agent && !remaining.agent) this.info.agent = pending.agent;
    if (pending.model && !remaining.model) {
      this.info.model = pending.model;
      this.reportModel(pending.model);
    }
    // An explicit choice called meanwhile removed its part and runs after this one.
    this.deferred = {
      ...(remaining.agent && this.deferred.agent ? { agent: remaining.agent } : {}),
      ...(remaining.model && this.deferred.model ? { model: remaining.model } : {}),
    };
    if (pending.agent !== remaining.agent || pending.model !== remaining.model)
      this.logger.info(
        { sessionId: this.id, agent: this.info.agent, model: this.info.model },
        "Applied the deferred agent and model",
      );
  }
  /** Tell AgentManager the model and variant that now apply, so its record matches the session. */
  private reportModel(model: ModelRef) {
    this.config.thinkingOptionId = model.variant;
    this.emit({
      type: "thinking_option_changed",
      provider: "opencode",
      thinkingOptionId: model.variant ?? null,
    });
    this.emit({
      type: "model_changed",
      provider: "opencode",
      runtimeInfo: {
        provider: "opencode",
        sessionId: this.id,
        model: `${model.providerID}/${model.id}`,
        modeId: this.info.agent ?? null,
        thinkingOptionId: model.variant ?? null,
      },
    });
  }
  private confirmDeferred(pending: DeferredSelection, engine: SessionInfo) {
    if (pending.agent && engine.agent !== pending.agent) return undefined;
    if (pending.model && !sameModel(engine.model, pending.model)) return undefined;
    if (pending.agent) {
      this.info.agent = pending.agent;
      if (this.deferred.agent === pending.agent) delete this.deferred.agent;
    }
    if (pending.model) {
      this.info.model = pending.model;
      this.reportModel(pending.model);
      if (this.deferred.model === pending.model) delete this.deferred.model;
    }
    return { value: undefined };
  }
  /**
   * Agent, model, and variant writes run one at a time, in call order, so the last choice is the
   * one the session keeps (R19). Each job gets a signal that aborts its engine requests after
   * `SELECTION_TIMEOUT_MS`, and the queue moves on then too, so a hung write cannot hold later
   * writes, or a prompt that waits for a deferred apply, forever. When a job that sent a write
   * times out, it reads the session back, and `confirm` decides whether the write landed after all.
   */
  private serializeSelection<T>(
    run: (job: SelectionJob) => Promise<T>,
    confirm?: ConfirmSelection<T>,
  ): Promise<T> {
    const next = this.selectionQueue.then(async () => {
      let wrote = false;
      // A job that timed out can go on in the background, for example after a slow reconnect.
      // Once the job has settled, or its signal has aborted, it may not write or count a write.
      let open = true;
      let jobSignal: AbortSignal | undefined;
      const assertOpen = () => {
        if (!open || jobSignal?.aborted)
          throw jobSignal?.reason ?? new SelectionTimeoutError("The selection job already ended");
      };
      const write = async <R>(send: () => Promise<R>) => {
        assertOpen();
        if (!wrote) {
          wrote = true;
          this.writesInFlight += 1;
          this.writeEpoch += 1;
        }
        return send();
      };
      try {
        return await bounded(
          this.abort.signal,
          SELECTION_TIMEOUT_MS,
          "OpenCode did not apply the agent or model change in time",
          (signal) => {
            jobSignal = signal;
            return run({ signal, write, assertOpen });
          },
        );
      } catch (error) {
        open = false;
        // A write that timed out may still have landed: ask the engine before failing.
        const confirmed =
          wrote && error instanceof SelectionTimeoutError
            ? await this.readBack(confirm)
            : undefined;
        if (confirmed) return confirmed.value;
        throw error;
      } finally {
        open = false;
        if (wrote) {
          this.writesInFlight -= 1;
          this.writeEpoch += 1;
        }
      }
    });
    this.selectionQueue = next.catch(() => undefined);
    return next;
  }
  /** After a failed job, read what the engine holds and let `confirm` judge it. */
  private async readBack<T>(confirm: ConfirmSelection<T> | undefined) {
    if (!confirm) return undefined;
    try {
      const engine = await bounded(
        this.abort.signal,
        READ_BACK_TIMEOUT_MS,
        "OpenCode did not answer the read-back in time",
        (signal) => this.client.session.get({ sessionID: this.id }, { signal }),
      );
      return confirm(engine);
    } catch {
      return undefined;
    }
  }
  /**
   * Run an explicit agent or model choice. It drops the matching deferred part at once, before
   * any await, so a deferred apply that runs later cannot replace it. The dropped part stays in
   * `droppedDeferral` until a choice for that part succeeds. When the newest choice fails, the
   * deferred part comes back, also when an earlier choice that failed too had dropped it.
   */
  private async explicitChoice<T>(
    part: "agent" | "model",
    run: (job: SelectionJob) => Promise<T>,
    confirm?: ConfirmSelection<T>,
  ): Promise<T> {
    const choice = ++this.explicitChoices[part];
    const dropped = this.deferred[part];
    if (dropped) Object.assign(this.droppedDeferral, { [part]: dropped });
    delete this.deferred[part];
    try {
      const result = await this.serializeSelection(run, confirm);
      delete this.droppedDeferral[part];
      return result;
    } catch (error) {
      const restore = this.droppedDeferral[part];
      if (restore && this.explicitChoices[part] === choice && this.deferred[part] === undefined) {
        Object.assign(this.deferred, { [part]: restore });
        delete this.droppedDeferral[part];
      }
      throw error;
    }
  }
  async getCurrentMode() {
    return this.info.agent ?? null;
  }
  async setMode(modeId: string) {
    await this.explicitChoice(
      "agent",
      async (job) => {
        await this.reconnectIfExited();
        await job.write(() =>
          this.client.session.switchAgent(
            { sessionID: this.id, agent: modeId },
            { signal: job.signal },
          ),
        );
        this.info.agent = modeId;
      },
      (engine) => {
        if (engine.agent !== modeId) return undefined;
        this.info.agent = modeId;
        return { value: undefined };
      },
    );
    this.config.modeId = modeId;
    this.emit({
      type: "mode_changed",
      provider: "opencode",
      currentModeId: modeId,
      availableModes: this.modes,
    });
  }
  async setModel(model: string | null) {
    let sent: { model: ModelRef; finish: () => void } | undefined;
    await this.explicitChoice(
      "model",
      (job) =>
        this.switchModelExplicitly(model, job, (request) => {
          sent = request;
        }),
      (engine) => {
        if (!sent || !sameModel(engine.model, sent.model)) return undefined;
        sent.finish();
        return { value: undefined };
      },
    );
  }
  private async switchModelExplicitly(
    model: string | null,
    job: SelectionJob,
    sending: (request: { model: ModelRef; finish: () => void }) => void,
  ) {
    const { signal } = job;
    await this.reconnectIfExited();
    const location = { directory: this.config.cwd };
    const arenaSelection = this.arenaMode ? arenaModelRef(model) : undefined;
    const selected =
      arenaSelection ??
      (model ? modelRef(model) : (await this.client.model.default({ location }, { signal })).data);
    if (!selected) throw new Error("OpenCode has no default model");
    const catalog = this.arenaMode
      ? undefined
      : await this.client.model.list({ location }, { signal });
    const target = arenaSelection
      ? { variants: [{ id: arenaSelection.variant }] }
      : catalog?.data.find(
          (entry) =>
            entry.enabled && entry.providerID === selected.providerID && entry.id === selected.id,
        );
    if (!target)
      throw new Error(`OpenCode model unavailable: ${selected.providerID}/${selected.id}`);
    const retainedVariant = arenaSelection ? arenaSelection.variant : this.config.thinkingOptionId;
    const variant =
      retainedVariant !== "default" && target.variants.some((entry) => entry.id === retainedVariant)
        ? retainedVariant
        : undefined;
    const nextModel = {
      id: selected.id,
      providerID: selected.providerID,
      ...(variant ? { variant } : {}),
    };
    const finish = (applied = true) => {
      if (applied) this.info.model = nextModel;
      this.config.model = model ?? undefined;
      this.config.thinkingOptionId = variant;
      this.emit({
        type: "thinking_option_changed",
        provider: "opencode",
        thinkingOptionId: variant ?? null,
      });
      this.emit({
        type: "model_changed",
        provider: "opencode",
        runtimeInfo: {
          provider: "opencode",
          sessionId: this.id,
          model: `${selected.providerID}/${selected.id}`,
          modeId: this.info.agent ?? null,
          thinkingOptionId: variant ?? null,
        },
      });
    };
    // A running turn reads the session model at each step, and its Arena assignment is for the size
    // it started on: a new model mid-turn fails the next step. Hold the size until the turn ends.
    if (this.arenaMode && this.turns.id !== undefined) {
      // A pick that already failed for the user (a timeout in a slow reconnect) is not held.
      job.assertOpen();
      this.deferred.model = nextModel;
      this.heldModel = nextModel;
      this.logger.info(
        { sessionId: this.id, model: nextModel },
        "Holding the size change until the running turn ends",
      );
      finish(false);
      return;
    }
    sending({ model: nextModel, finish });
    await job.write(() =>
      this.client.session.switchModel({ sessionID: this.id, model: nextModel }, { signal }),
    );
    finish();
  }

  async setThinkingOption(variant: string | null) {
    // Queued with the agent and model writes. The app sends a size and its variant together, and
    // the variant must not write back the model of a size the user already left (R19).
    let sent: ModelRef | undefined;
    const thinkingOptionId = await this.serializeSelection(
      async (job) => {
        await this.reconnectIfExited();
        await this.applyDeferredNow(job);
        // In Arena the size fixes the variant: `setModel` writes it, and the engine sets it again
        // from the size at the start of each turn. A write here could only change the size.
        if (this.arenaMode) {
          const fixed = (this.deferred.model ?? this.info.model)?.variant ?? null;
          this.config.thinkingOptionId = fixed ?? undefined;
          return fixed;
        }
        // Read inside the queue, so the variant goes on the model the last write chose.
        const { signal } = job;
        const model = (await this.client.session.get({ sessionID: this.id }, { signal })).model;
        if (!model) throw new Error("Select an OpenCode model before changing its variant");
        const nextModel = {
          id: model.id,
          providerID: model.providerID,
          ...(variant ? { variant } : {}),
        };
        sent = nextModel;
        await job.write(() =>
          this.client.session.switchModel({ sessionID: this.id, model: nextModel }, { signal }),
        );
        this.info.model = nextModel;
        this.config.thinkingOptionId = variant ?? undefined;
        return variant;
      },
      (engine) => {
        if (!sent || !sameModel(engine.model, sent)) return undefined;
        this.info.model = sent;
        this.config.thinkingOptionId = variant ?? undefined;
        return { value: variant };
      },
    );
    this.emit({ type: "thinking_option_changed", provider: "opencode", thinkingOptionId });
  }
  async setFeature(id: string, value: unknown) {
    if (id !== "auto_accept" || typeof value !== "boolean")
      throw new Error("Unknown OpenCode feature");
    await this.reconnectIfExited();
    if (this.connection.arena) {
      const response = await fetch(
        new URL(
          `/arena/sessions/${encodeURIComponent(this.id)}/auto-accept`,
          `${this.connection.arena.serverUrl.replace(/\/$/, "")}/`,
        ),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-opencode-directory": this.config.cwd,
            "x-paseo-control-token": this.connection.arena.controlToken,
          },
          body: JSON.stringify({ enabled: value }),
        },
      );
      if (!response.ok) throw new Error(`Arena auto-accept update failed: ${response.status}`);
    }
    this.config.featureValues = { ...this.config.featureValues, [id]: value };
    if (value && !this.config.toolPolicy)
      for (const request of this.permissions.list())
        if (request.kind !== "question")
          await this.respondToPermission(request.id, { behavior: "allow" });
  }
  async listCommands() {
    await this.reconnectIfExited();
    return commands(this.client, this.config.cwd);
  }
  describePersistence(): AgentPersistenceHandle {
    return {
      provider: "opencode",
      sessionId: this.id,
      nativeHandle: this.id,
      metadata: { ...this.config },
    };
  }
  run(prompt: AgentPromptInput, options?: AgentRunOptions) {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: this.startTurn.bind(this),
      subscribe: this.subscribe.bind(this),
      getSessionId: () => this.id,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? current + item.text : current,
    });
  }
  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions) {
    await this.reconnectIfExited();
    await this.applyDeferred();
    await this.allowReadingUploads(prompt);
    return this.turns.startTurn(prompt, options);
  }
  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    await this.allowReadingUploads(prompt);
    return this.turns.steerActiveTurn(prompt, options);
  }
  private async allowReadingUploads(prompt: AgentPromptInput): Promise<void> {
    const directories = uploadDirectoriesForPrompt(prompt, this.uploadsRoot);
    if (directories.length === 0) return;
    try {
      const current = await this.client.session.get({ sessionID: this.id });
      const permissions = [...(current.permissions ?? [])];
      for (const directory of directories) {
        const resource = `${directory}/*`;
        if (
          permissions.some(
            (rule) =>
              rule.action === "external_directory" &&
              rule.resource === resource &&
              rule.effect === "allow",
          )
        )
          continue;
        permissions.push({ action: "external_directory", resource, effect: "allow" });
      }
      await this.client.session.update({ sessionID: this.id, permissions });
    } catch (error) {
      this.logger.warn(
        { error: toDiagnosticErrorMessage(error), sessionId: this.id },
        "OpenCode did not open uploaded files to the session",
      );
    }
  }
  interrupt() {
    return this.turns.interrupt();
  }
  async revertBoth(input: { messageId: string }) {
    await this.interrupt();
    await this.reconnectIfExited();
    await this.client.session.revert.stage({
      sessionID: this.id,
      messageID: input.messageId,
      files: true,
    });
    await this.client.session.revert.commit({ sessionID: this.id });
  }
  getPendingPermissions() {
    return [...this.permissions.list()];
  }
  async respondToPermission(requestId: string, response: AgentPermissionResponse) {
    await this.reconnectIfExited();
    const deniesOwnRequest =
      response.behavior === "deny" && this.permissions.isOwnedBy(requestId, this.id);
    await this.permissions.respondToPermission(requestId, response);
    if (deniesOwnRequest) this.turns.requestDenied();
  }
  private async reconcileSnapshot() {
    // Never wait for the selection queue here: a queued job can be the one that reconnects.
    let history: SessionMessageInfo[] = [];
    await this.readInfo(false, async () => {
      const [info, read] = await Promise.all([
        this.client.session.get({ sessionID: this.id }),
        messages(this.client, this.id),
      ]);
      history = read;
      return info;
    });
    this.history = history;
    for (const event of this.timeline.messages(history)) this.emitTimeline(event);
    await this.permissions.reconcile(this.id);
  }
  private async reconcile() {
    this.dirty = true;
    this.sync = this.sync.catch(() => undefined).then(() => this.drainReconciliation());
    return this.sync;
  }
  private async drainReconciliation() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      await this.reconcileSnapshot();
    }
  }
  private async reconcileConnection() {
    // Session environments are process-local. Reapply this agent's snapshot before
    // reconciling a new connection, including event-stream reconnections.
    if (this.launchEnv)
      await this.client.session.environment({ sessionID: this.id, variables: this.launchEnv });
    await this.reconcile();
    await this.children.reconcile(this.id);
    await this.turns.reconcile();
  }
  private scheduleReconcile() {
    if (this.refreshTimer || this.closed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.reconcile().catch((error: unknown) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode reconciliation failed",
        ),
      );
    }, 25);
  }
  private observeOwnEvent(event: import("@opencode/client").OpenCodeEvent) {
    if (event.type === "form.created" && event.data.form.sessionID === this.id) {
      this.scheduleReconcile();
      return;
    }
    if (!("sessionID" in event.data) || event.data.sessionID !== this.id) return;
    if (event.type === "session.text.started" || event.type === "session.reasoning.started") {
      if (this.replacingHistory) return;
      if (event.type === "session.text.started" && this.turns.hasStructuredOutput) return;
      this.timeline.startPart({
        ...event.data,
        type: event.type === "session.text.started" ? "text" : "reasoning",
      });
      return;
    }
    if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
      if (this.replacingHistory) return;
      const isText = event.type === "session.text.delta";
      // A structured-output turn supplies its answer through a tool, so streamed
      // prose is not part of the result and must not reach the timeline.
      if (isText && this.turns.hasStructuredOutput) return;
      const streamed = this.timeline.delta({
        assistantMessageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
        delta: event.data.delta,
        type: isText ? "text" : "reasoning",
      });
      if (streamed) this.emitTimeline(streamed);
      return;
    }
    this.permissions.observe(event);
    this.usage.observe(event);
    this.turns.observe(event);
    this.scheduleReconcile();
  }
  private async consume(ready: () => void, fail: (error: unknown) => void) {
    const signal = AbortSignal.any([this.abort.signal, this.streamAbort.signal]);
    let connected = false;
    while (!this.closed && !signal.aborted) {
      try {
        for await (const event of this.client.event.subscribe({ signal })) {
          if (this.closed || signal.aborted) return;
          if (event.type === "server.connected") {
            this.timeline.resetStreams();
            await this.reconcileConnection();
            connected = true;
            ready();
          }
          await this.children.observe(event);
          this.observeOwnEvent(event);
        }
        if (!connected) throw new Error("OpenCode event stream ended before connecting");
      } catch (error) {
        if (this.closed || signal.aborted) return;
        if (!connected) {
          fail(error);
          return;
        }
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode event stream interrupted; reconciling on reconnect",
        );
      }
      await delay(100, undefined, { signal }).catch(() => undefined);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.turns.close();
    this.streamAbort.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await this.stream;
    await this.reconnecting?.catch(() => undefined);
    await this.sync.catch(() => undefined);
    this.unbind?.();
    try {
      if (!this.persist) await this.client.session.remove({ sessionID: this.id });
    } finally {
      await this.connection.release();
    }
    this.listeners.clear();
  }
}
