import type { ChildProcess } from "child_process";
import { AsyncLocalStorage } from "async_hooks";

export type GenerationLifecycleState =
  | "active"
  | "aborting"
  | "draining"
  | "disposed";

export type GenerationResourceKind =
  | "abort-token"
  | "child-process"
  | "conversation"
  | "cron-execution"
  | "cron-job"
  | "handler"
  | "interval"
  | "promise"
  | "task"
  | "timeout";

export type Disposable = () => void | Promise<void>;

export interface ResourceStats {
  active: number;
  created: number;
  completed: number;
  canceled: number;
  timedOut: number;
}

export type GenerationResourceStats = Record<GenerationResourceKind, ResourceStats>;

export interface ResourceResidual {
  id: number;
  kind: GenerationResourceKind;
  label: string;
  ageMs: number;
  state: "active" | "disposing" | "timed-out";
}

export interface DrainResult {
  completed: boolean;
  timedOut: boolean;
  errors: unknown[];
  pendingTasks: number;
  pendingDisposables: number;
  canceledResources: number;
  drainedResources: number;
  timedOutResources: number;
  residualResources: ResourceResidual[];
  stats: GenerationResourceStats;
}

export interface GenerationContextSnapshot {
  generation: number;
  state: GenerationLifecycleState;
  abortReason?: unknown;
  trackedTasks: number;
  trackedDisposables: number;
  stats: GenerationResourceStats;
  residualResources: ResourceResidual[];
}

export interface TrackOptions {
  label?: string;
  kind?: GenerationResourceKind;
}

interface ResourceEntry {
  id: number;
  kind: GenerationResourceKind;
  label: string;
  createdAt: number;
  state: "active" | "disposing" | "timed-out";
}

interface DisposableEntry {
  resource: ResourceEntry;
  dispose: Disposable;
}

interface TaskEntry {
  resource: ResourceEntry;
  promise: Promise<unknown>;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
const RESOURCE_KINDS: GenerationResourceKind[] = [
  "abort-token",
  "child-process",
  "conversation",
  "cron-execution",
  "cron-job",
  "handler",
  "interval",
  "promise",
  "task",
  "timeout",
];

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Generation aborted");
}

function createTimeoutPromise(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("timeout"), ms);
    if (typeof timeout.unref === "function") {
      timeout.unref();
    }
  });
}

function createEmptyStats(): GenerationResourceStats {
  const stats = {} as GenerationResourceStats;
  for (const kind of RESOURCE_KINDS) {
    stats[kind] = {
      active: 0,
      created: 0,
      completed: 0,
      canceled: 0,
      timedOut: 0,
    };
  }
  return stats;
}

function cloneStats(stats: GenerationResourceStats): GenerationResourceStats {
  const cloned = {} as GenerationResourceStats;
  for (const kind of RESOURCE_KINDS) {
    cloned[kind] = { ...stats[kind] };
  }
  return cloned;
}

function classifyKind(options: TrackOptions | undefined, fallback: GenerationResourceKind): GenerationResourceKind {
  return options?.kind ?? fallback;
}

export class GenerationContext {
  readonly generation: number;
  readonly createdAt: number;
  private readonly abortController = new AbortController();
  private readonly disposables = new Set<DisposableEntry>();
  private readonly tasks = new Set<TaskEntry>();
  private readonly resources = new Map<number, ResourceEntry>();
  private readonly stats = createEmptyStats();
  private readonly currentTaskStorage = new AsyncLocalStorage<TaskEntry>();
  private lifecycleState: GenerationLifecycleState = "active";
  private abortCause: unknown;
  private nextResourceId = 1;

  constructor(generation: number) {
    this.generation = generation;
    this.createdAt = Date.now();
    this.createResource("abort-token", "generation-abort-signal");
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get state(): GenerationLifecycleState {
    return this.lifecycleState;
  }

  get abortReason(): unknown {
    return this.abortCause;
  }

  snapshot(): GenerationContextSnapshot {
    return {
      generation: this.generation,
      state: this.lifecycleState,
      abortReason: this.abortCause,
      trackedTasks: this.tasks.size,
      trackedDisposables: this.disposables.size,
      stats: cloneStats(this.stats),
      residualResources: this.getResidualResources(),
    };
  }

  abort(reason?: unknown): void {
    if (this.lifecycleState === "disposed") return;
    this.abortCause = reason;
    if (this.lifecycleState === "active") {
      this.lifecycleState = "aborting";
    }
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason);
      this.markResourcesCanceled();
    }
  }

  trackDisposable(dispose: Disposable, options?: TrackOptions): Disposable {
    const resource = this.createResource(
      classifyKind(options, "task"),
      options?.label ?? "disposable"
    );
    const entry: DisposableEntry = {
      resource,
      dispose,
    };

    if (this.lifecycleState === "disposed") {
      void Promise.resolve(dispose()).catch((error) => {
        console.error(`[GENERATION ${this.generation}] Late disposable cleanup failed:`, error);
      });
      this.completeResource(resource, "completed");
      return dispose;
    }

    this.disposables.add(entry);
    return async () => {
      if (!this.disposables.delete(entry)) return;
      resource.state = "disposing";
      try {
        await entry.dispose();
        this.completeResource(resource, "completed");
      } catch (error) {
        this.completeResource(resource, "completed");
        throw error;
      }
    };
  }

  trackTask<T>(task: Promise<T>, options?: TrackOptions): Promise<T> {
    const resource = this.createResource(
      classifyKind(options, "task"),
      options?.label ?? "task"
    );
    const entry: TaskEntry = {
      resource,
      promise: task,
    };

    this.tasks.add(entry);
    task.finally(() => {
      this.tasks.delete(entry);
      this.completeResource(resource, "completed");
    }).catch(() => undefined);

    return task;
  }

  runTask<T>(factory: (signal: AbortSignal) => Promise<T>, options?: TrackOptions): Promise<T> {
    if (this.signal.aborted) {
      return Promise.reject(toError(this.abortCause));
    }
    return this.trackTask(factory(this.signal), options);
  }

  setTimeout(callback: () => void, ms: number, options?: TrackOptions): TimerHandle {
    const handle = setTimeout(() => {
      void dispose();
      if (!this.signal.aborted) {
        callback();
      }
    }, ms);

    const dispose = this.trackDisposable(() => clearTimeout(handle), {
      label: options?.label ?? "timeout",
      kind: classifyKind(options, "timeout"),
    });
    return handle;
  }

  delay(ms: number, options?: TrackOptions): Promise<void> {
    if (this.signal.aborted) {
      return Promise.reject(toError(this.abortCause));
    }

    const label = options?.label ?? "delay";
    const task = new Promise<void>((resolve, reject) => {
      let settled = false;
      let dispose: Disposable = () => undefined;

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", onAbort);
        void Promise.resolve(dispose()).catch((error) => {
          console.error(`[GENERATION ${this.generation}] Delay cleanup failed:`, error);
        });
        callback();
      };

      const onAbort = (): void => {
        settle(() => reject(toError(this.abortCause)));
      };

      const handle = setTimeout(() => {
        settle(resolve);
      }, ms);

      dispose = this.trackDisposable(() => clearTimeout(handle), { label, kind: "timeout" });
      this.signal.addEventListener("abort", onAbort, { once: true });

      if (this.signal.aborted) {
        onAbort();
      }
    });

    return this.trackTask(task, { label, kind: classifyKind(options, "promise") });
  }

  setInterval(callback: () => void, ms: number, options?: TrackOptions): IntervalHandle {
    const handle = setInterval(() => {
      if (!this.signal.aborted) {
        callback();
      }
    }, ms);

    this.trackDisposable(() => clearInterval(handle), {
      label: options?.label ?? "interval",
      kind: classifyKind(options, "interval"),
    });
    return handle;
  }

  trackListener<TEvent>(
    add: (handler: (event: TEvent) => void | Promise<void>) => void,
    remove: (handler: (event: TEvent) => void | Promise<void>) => void,
    handler: (event: TEvent) => void | Promise<void>,
    options?: TrackOptions
  ): (event: TEvent) => void | Promise<void> {
    const label = options?.label ?? "listener";
    const taskKind = classifyKind(options, "promise");
    const trackedHandler = (event: TEvent): void | Promise<void> => {
      if (this.signal.aborted) return;

      const resource = this.createResource(taskKind, label);
      const entry: TaskEntry = {
        resource,
        promise: Promise.resolve(),
      };
      this.tasks.add(entry);

      let syncResult: void | Promise<void> = undefined;
      const wrapped = new Promise<unknown>((resolve, reject) => {
        this.currentTaskStorage.run(entry, () => {
          try {
            const result = handler(event);
            syncResult = result;
            if (result && typeof (result as Promise<void>).then === "function") {
              (result as Promise<void>).then(resolve, reject);
            } else {
              resolve(result);
            }
          } catch (error) {
            reject(error);
          }
        });
      });
      entry.promise = wrapped;
      wrapped
        .finally(() => {
          this.tasks.delete(entry);
          this.completeResource(resource, "completed");
        })
        .catch(() => undefined);
      wrapped.catch((error) => {
        console.error(`[GENERATION ${this.generation}] Listener task failed:`, error);
      });

      return syncResult;
    };

    add(trackedHandler);
    this.trackDisposable(() => remove(trackedHandler), {
      label: options?.label ?? "listener",
      kind: classifyKind(options, "handler"),
    });
    return trackedHandler;
  }

  trackChildProcess(child: ChildProcess, options?: TrackOptions): ChildProcess {
    const label = options?.label ?? "child-process";

    const settle = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    this.trackTask(settle, { label, kind: "child-process" });

    this.trackDisposable(() => {
      if (!child.killed && child.exitCode === null) {
        child.kill();
      }
    }, { label, kind: "child-process" });

    return child;
  }

  async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<DrainResult> {
    if (this.lifecycleState === "disposed") {
      return {
        completed: true,
        timedOut: false,
        errors: [],
        pendingTasks: 0,
        pendingDisposables: 0,
        canceledResources: this.sumStats("canceled"),
        drainedResources: this.sumStats("completed"),
        timedOutResources: this.sumStats("timedOut"),
        residualResources: [],
        stats: cloneStats(this.stats),
      };
    }

    if (this.lifecycleState === "active") {
      this.abort("Generation draining");
    }
    this.lifecycleState = "draining";

    const errors: unknown[] = [];
    const disposableEntries = [...this.disposables];
    this.disposables.clear();

    await Promise.all(
      disposableEntries.map(async (entry) => {
        entry.resource.state = "disposing";
        try {
          await entry.dispose();
          this.completeResource(entry.resource, "completed");
        } catch (error) {
          this.completeResource(entry.resource, "completed");
          errors.push(error);
          console.error(`[GENERATION ${this.generation}] Disposable "${entry.resource.label}" failed:`, error);
        }
      })
    );

    const waitForTasks = async (): Promise<void> => {
      while (true) {
        const selfEntry = this.currentTaskStorage.getStore();
        const pending = [...this.tasks].filter((entry) => entry !== selfEntry);
        if (pending.length === 0) break;
        await Promise.allSettled(pending.map((entry) => entry.promise));
      }
    };

    const taskWait = waitForTasks();
    const result = await Promise.race([taskWait, createTimeoutPromise(timeoutMs)]);
    const timedOut = result === "timeout";

    if (timedOut) {
      const selfEntry = this.currentTaskStorage.getStore();
      for (const entry of this.tasks) {
        if (entry === selfEntry) continue;
        this.markResourceTimedOut(entry.resource);
      }
    } else {
      this.lifecycleState = "disposed";
      this.completeAbortToken();
    }

    const selfEntry = this.currentTaskStorage.getStore();
    const pendingTaskCount = selfEntry && this.tasks.has(selfEntry)
      ? Math.max(0, this.tasks.size - 1)
      : this.tasks.size;

    return {
      completed: !timedOut && errors.length === 0,
      timedOut,
      errors,
      pendingTasks: pendingTaskCount,
      pendingDisposables: this.disposables.size,
      canceledResources: this.sumStats("canceled"),
      drainedResources: this.sumStats("completed"),
      timedOutResources: this.sumStats("timedOut"),
      residualResources: this.getResidualResources(),
      stats: cloneStats(this.stats),
    };
  }

  async dispose(timeoutMs?: number): Promise<DrainResult> {
    return await this.drain(timeoutMs);
  }

  private createResource(kind: GenerationResourceKind, label: string): ResourceEntry {
    const resource: ResourceEntry = {
      id: this.nextResourceId++,
      kind,
      label,
      createdAt: Date.now(),
      state: "active",
    };
    this.resources.set(resource.id, resource);
    this.stats[kind].created += 1;
    this.stats[kind].active += 1;
    return resource;
  }

  private completeResource(resource: ResourceEntry, outcome: "completed" | "canceled"): void {
    if (!this.resources.delete(resource.id)) return;
    const stat = this.stats[resource.kind];
    stat.active = Math.max(0, stat.active - 1);
    if (outcome === "canceled") {
      stat.canceled += 1;
    } else {
      stat.completed += 1;
    }
  }

  private markResourceTimedOut(resource: ResourceEntry): void {
    if (resource.state === "timed-out") return;
    resource.state = "timed-out";
    this.stats[resource.kind].timedOut += 1;
  }

  private markResourcesCanceled(): void {
    for (const resource of this.resources.values()) {
      if (resource.kind === "abort-token") continue;
      this.stats[resource.kind].canceled += 1;
    }
  }

  private completeAbortToken(): void {
    const abortToken = [...this.resources.values()].find((resource) => resource.kind === "abort-token");
    if (abortToken) {
      this.completeResource(abortToken, "completed");
    }
  }

  private getResidualResources(): ResourceResidual[] {
    const now = Date.now();
    return [...this.resources.values()].map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      label: resource.label,
      ageMs: now - resource.createdAt,
      state: resource.state,
    }));
  }

  private sumStats(key: keyof Pick<ResourceStats, "canceled" | "completed" | "timedOut">): number {
    return RESOURCE_KINDS.reduce((sum, kind) => sum + this.stats[kind][key], 0);
  }
}

export function createGenerationContext(generation: number): GenerationContext {
  return new GenerationContext(generation);
}
