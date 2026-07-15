// ─────────────────────────── Generation Context ───────────────────────────
// 核心职责：reload/shutdown 时安全终止所有进行中的操作，防止内存泄漏。
//
// 工作原理：
// - AbortController → 统一取消信号，所有异步操作监听 signal.aborted
// - trackDisposable() → 注册清理回调（timer、interval、child_process、event listener）
// - trackTask()         → 追踪进行中的异步任务，drain() 等待它们全部完成
// - AsyncLocalStorage   → 隐式传递当前 generation，drain() 排除自身避免死锁
//
// 简化说明（vs 旧版约 550 行）：
// - 移除了 ResourceKind 统计框架（10 种资源类型 × 5 个计数器 = 50 个指标）——纯探测用，无业务价值
// - DrainResult 从 12 字段压缩到 5 字段
// - trackDisposable/trackTask 不再按 kind 分类，仅保留 label 用于错误日志

import type { ChildProcess } from "child_process";
import { AsyncLocalStorage } from "async_hooks";

export type GenerationLifecycleState = "active" | "aborting" | "draining" | "disposed";

export type Disposable = () => void | Promise<void>;

export interface TrackOptions {
  label?: string;
}

export interface DrainResult {
  completed: boolean;
  timedOut: boolean;
  errors: unknown[];
  pendingTasks: number;
  pendingDisposables: number;
}

interface DisposableEntry {
  dispose: Disposable;
  label: string;
}

interface TaskEntry {
  promise: Promise<unknown>;
  label: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Generation aborted");
}

function createTimeoutPromise(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

export class GenerationContext {
  readonly generation: number;
  readonly createdAt: number;
  private readonly abortController = new AbortController();
  private readonly disposables = new Set<DisposableEntry>();
  private readonly tasks = new Set<TaskEntry>();
  private readonly currentTaskStorage = new AsyncLocalStorage<TaskEntry>();
  private lifecycleState: GenerationLifecycleState = "active";
  private abortCause: unknown;

  constructor(generation: number) {
    this.generation = generation;
    this.createdAt = Date.now();
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

  /** Number of in-flight tracked tasks (excludes the current ALS task if any). */
  getTrackedTaskCount(): number {
    const selfEntry = this.currentTaskStorage.getStore();
    if (selfEntry && this.tasks.has(selfEntry)) {
      return Math.max(0, this.tasks.size - 1);
    }
    return this.tasks.size;
  }

  // ── 生命周期 ──

  abort(reason?: unknown): void {
    if (this.lifecycleState === "disposed") return;
    this.abortCause = reason;
    if (this.lifecycleState === "active") {
      this.lifecycleState = "aborting";
    }
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(reason);
    }
  }

  // ── 资源追踪 ──

  trackDisposable(dispose: Disposable, options?: TrackOptions): Disposable {
    const entry: DisposableEntry = {
      dispose,
      label: options?.label ?? "disposable",
    };

    if (this.lifecycleState === "disposed") {
      void Promise.resolve(dispose()).catch((error) => {
        console.error(`[GEN ${this.generation}] Late disposable "${entry.label}" cleanup failed:`, error);
      });
      return dispose;
    }

    this.disposables.add(entry);
    return async () => {
      if (!this.disposables.delete(entry)) return;
      try {
        await entry.dispose();
      } catch (error) {
        throw error;
      }
    };
  }

  trackTask<T>(task: Promise<T>, options?: TrackOptions): Promise<T> {
    const entry: TaskEntry = {
      promise: task,
      label: options?.label ?? "task",
    };

    this.tasks.add(entry);
    task.finally(() => {
      this.tasks.delete(entry);
    }).catch(() => undefined);

    return task;
  }

  runTask<T>(factory: (signal: AbortSignal) => Promise<T>, options?: TrackOptions): Promise<T> {
    if (this.signal.aborted) {
      return Promise.reject(toError(this.abortCause));
    }
    return this.trackTask(factory(this.signal), options);
  }

  // ── 定时器（自动清理） ──

  setTimeout(callback: () => void, ms: number, options?: TrackOptions): TimerHandle {
    const handle = setTimeout(() => {
      void dispose();
      if (!this.signal.aborted) callback();
    }, ms);

    const dispose = this.trackDisposable(() => clearTimeout(handle), {
      label: options?.label ?? "timeout",
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
      let disposeTimer: Disposable = () => undefined;

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", onAbort);
        void Promise.resolve(disposeTimer()).catch((error) => {
          console.error(`[GEN ${this.generation}] Delay cleanup failed:`, error);
        });
        callback();
      };

      const onAbort = (): void => {
        settle(() => reject(toError(this.abortCause)));
      };

      const handle = setTimeout(() => {
        settle(resolve);
      }, ms);

      disposeTimer = this.trackDisposable(() => clearTimeout(handle), { label });
      this.signal.addEventListener("abort", onAbort, { once: true });

      if (this.signal.aborted) onAbort();
    });

    return this.trackTask(task, { label });
  }

  setInterval(callback: () => void, ms: number, options?: TrackOptions): IntervalHandle {
    const handle = setInterval(() => {
      if (!this.signal.aborted) callback();
    }, ms);

    this.trackDisposable(() => clearInterval(handle), {
      label: options?.label ?? "interval",
    });
    return handle;
  }

  // ── Event Listener ──

  trackListener<TEvent>(
    add: (handler: (event: TEvent) => void | Promise<void>) => void,
    remove: (handler: (event: TEvent) => void | Promise<void>) => void,
    handler: (event: TEvent) => void | Promise<void>,
    options?: TrackOptions
  ): (event: TEvent) => void | Promise<void> {
    const label = options?.label ?? "listener";
    const trackedHandler = (event: TEvent): void | Promise<void> => {
      if (this.signal.aborted) return;

      const entry: TaskEntry = {
        promise: Promise.resolve(),
        label,
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
        .finally(() => { this.tasks.delete(entry); })
        .catch(() => undefined);
      wrapped.catch((error) => {
        console.error(`[GEN ${this.generation}] Listener task failed:`, error);
      });

      return syncResult;
    };

    add(trackedHandler);
    this.trackDisposable(() => remove(trackedHandler), { label });
    return trackedHandler;
  }

  // ── Child Process ──

  trackChildProcess(child: ChildProcess, options?: TrackOptions): ChildProcess {
    const label = options?.label ?? "child-process";

    const settle = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    this.trackTask(settle, { label });

    this.trackDisposable(() => {
      if (!child.killed && child.exitCode === null) {
        child.kill();
      }
    }, { label });

    return child;
  }

  // ── Drain / Dispose ──

  async drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<DrainResult> {
    if (this.lifecycleState === "disposed") {
      return { completed: true, timedOut: false, errors: [], pendingTasks: 0, pendingDisposables: 0 };
    }

    if (this.lifecycleState === "active") {
      this.abort("Generation draining");
    }
    this.lifecycleState = "draining";

    // 1. 执行所有 disposable
    const errors: unknown[] = [];
    const disposableEntries = [...this.disposables];
    this.disposables.clear();

    await Promise.all(
      disposableEntries.map(async (entry) => {
        try {
          await entry.dispose();
        } catch (error) {
          errors.push(error);
          console.error(`[GEN ${this.generation}] Disposable "${entry.label}" failed:`, error);
        }
      })
    );

    // 2. 等待所有 task 完成（排除当前 drain task 自身）
    const waitForTasks = async (): Promise<void> => {
      while (true) {
        const selfEntry = this.currentTaskStorage.getStore();
        const pending = [...this.tasks].filter((e) => e !== selfEntry);
        if (pending.length === 0) break;
        await Promise.allSettled(pending.map((e) => e.promise));
      }
    };

    const taskWait = waitForTasks();
    const raceResult = await Promise.race([taskWait, createTimeoutPromise(timeoutMs)]);
    const timedOut = raceResult === "timeout";

    if (!timedOut) {
      this.lifecycleState = "disposed";
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
    };
  }

  async dispose(timeoutMs?: number): Promise<DrainResult> {
    return await this.drain(timeoutMs);
  }
}

export function createGenerationContext(generation: number): GenerationContext {
  return new GenerationContext(generation);
}
