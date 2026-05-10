import { CronJob, validateCronExpression } from "cron";
import type { GenerationContext } from "./generationContext";

type CronHandler = () => void | Promise<void>;

interface CronTask {
  cron: string;
  description?: string;
  job: CronJob | null;
  running: number;
  executionsStarted: number;
  executionsFinished: number;
}

class CronManager {
  private tasks: Map<string, CronTask> = new Map();

  set(
    name: string,
    cron: string,
    handler: CronHandler,
    context?: GenerationContext
  ): () => void {
    if (this.tasks.has(name)) {
      throw new Error(`Cron task "${name}" already exists.`);
    }

    const validate = validateCronExpression(cron)
    if (!validate.valid) {
      console.log(`CronManager set new cronJob ${name} error while invalid cron`, validate.error);
      return () => undefined;
    }

    let job: CronJob;
    const taskState: CronTask = {
      cron,
      job: null,
      running: 0,
      executionsStarted: 0,
      executionsFinished: 0,
    };

    job = new CronJob(cron, () => {
      if (context?.signal.aborted) return;
      taskState.running += 1;
      taskState.executionsStarted += 1;
      const task = Promise.resolve(handler()).finally(() => {
        taskState.running = Math.max(0, taskState.running - 1);
        taskState.executionsFinished += 1;
      });
      if (context) {
        context.trackTask(task, { label: `cron:${name}:execution`, kind: "cron-execution" });
        task.catch(console.error);
      } else {
        task.catch(console.error);
      }
    });

    taskState.job = job;
    job.start();
    this.tasks.set(name, taskState);
    const stopCronTask = (): void => {
      this.del(name);
    };
    const dispose = context?.trackDisposable(stopCronTask, {
      label: `cron:${name}:job`,
      kind: "cron-job",
    }) ?? stopCronTask;
    return dispose;
  }

  del(name: string): boolean {
    const task = this.tasks.get(name);
    if (!task) return false;
    if (task.job) {
      task.job.stop();
    }
    this.tasks.delete(name);
    return true;
  }

  ls(raw?: boolean): string[] | Map<string, CronTask> {
    if (raw) {
      return this.tasks;
    }
    return Array.from(this.tasks.keys());
  }

  clear(): void {
    for (const task of this.tasks.values()) {
      if (task.job) {
        task.job.stop();
      }
    }
    this.tasks.clear();
  }

  has(name: string): boolean {
    return this.tasks.has(name);
  }
}

const cronManager = new CronManager();

export { cronManager };
