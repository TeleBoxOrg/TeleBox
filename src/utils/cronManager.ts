import { CronJob, validateCronExpression } from "cron";

type CronHandler = () => void | Promise<void>;

interface CronTask {
  cron: string;
  description?: string;
  job: CronJob;
  pluginName?: string; // 插件名称，便于清理
  registeredAt?: number; // 注册时间
}

class CronManager {
  private tasks: Map<string, CronTask> = new Map();
  private taskRegistry: Map<string, string> = new Map(); // 任务ID -> 插件名称映射

  /**
   * 设置/添加一个 cron 任务
   * @param name 任务唯一标识
   * @param cron cron 表达式
   * @param handler 执行函数
   * @param pluginName 可选的插件名称
   */
  set(name: string, cron: string, handler: CronHandler, pluginName?: string): void {
    if (this.tasks.has(name)) {
      console.warn(`Cron task "${name}" already exists. Stopping old task.`);
      this.del(name);
    }

    const validate = validateCronExpression(cron);
    if (!validate.valid) {
      console.error(`CronManager set new cronJob ${name} error while invalid cron`, validate.error);
      return;
    }

    try {
      const job = new CronJob(cron, () => {
        try {
          Promise.resolve(handler()).catch(console.error);
        } catch (error) {
          console.error(`[Cron ${name}] Error in job execution:`, error);
        }
      });

      job.start();
      
      const task: CronTask = { 
        cron, 
        job,
        pluginName,
        registeredAt: Date.now()
      };
      
      this.tasks.set(name, task);
      
      if (pluginName) {
        this.taskRegistry.set(name, pluginName);
      }
      
      console.log(`[CronManager] Registered task: ${name} for plugin: ${pluginName || 'unknown'}`);
    } catch (error) {
      console.error(`[CronManager] Failed to create cron job "${name}":`, error);
    }
  }

  /**
   * 删除一个任务
   * @param name 任务名称
   * @returns {boolean} 是否成功删除
   */
  del(name: string): boolean {
    const task = this.tasks.get(name);
    if (!task) return false;
    
    try {
      task.job.stop();
      this.tasks.delete(name);
      
      // 从注册表中移除
      this.taskRegistry.delete(name);
      
      console.log(`[CronManager] Removed task: ${name}`);
      return true;
    } catch (error) {
      console.error(`[CronManager] Error removing cron task "${name}":`, error);
      return false;
    }
  }

  /**
   * 按插件名称删除所有相关任务
   * @param pluginName 插件名称
   * @returns {number} 删除的任务数量
   */
  delByPlugin(pluginName: string): number {
    let removedCount = 0;
    const taskNames = Array.from(this.taskRegistry.entries())
      .filter(([_, name]) => name === pluginName)
      .map(([taskName]) => taskName);
    
    for (const taskName of taskNames) {
      if (this.del(taskName)) {
        removedCount++;
      }
    }
    
    console.log(`[CronManager] Removed ${removedCount} tasks for plugin ${pluginName}`);
    return removedCount;
  }

  /**
   * 列出所有任务
   * @param raw 是否返回原始数据
   * @returns {string[] | Map<string, CronTask>} 任务列表
   */
  ls(raw?: boolean): string[] | Map<string, CronTask> {
    if (raw) {
      return this.tasks;
    }
    return Array.from(this.tasks.keys());
  }

  /**
   * 清空所有任务
   * @returns {number} 删除的任务数量
   */
  clear(): number {
    console.log(`[CronManager] Clearing all cron tasks...`);
    const taskCount = this.tasks.size;
    
    for (const [name, task] of this.tasks.entries()) {
      try {
        task.job.stop();
        console.log(`[CronManager] Stopped task: ${name}`);
      } catch (error) {
        console.error(`[CronManager] Error stopping task "${name}":`, error);
      }
    }
    
    this.tasks.clear();
    this.taskRegistry.clear();
    
    console.log(`[CronManager] Cleared ${taskCount} cron tasks`);
    return taskCount;
  }

  /**
   * 检查任务是否存在
   * @param name 任务名称
   * @returns {boolean} 任务是否存在
   */
  has(name: string): boolean {
    return this.tasks.has(name);
  }
  
  /**
   * 获取任务统计信息
   * @returns {Object} 任务统计信息
   */
  getStats() {
    return {
      totalTasks: this.tasks.size,
      tasksByPlugin: Array.from(this.taskRegistry.entries()).reduce((acc, [taskName, pluginName]) => {
        acc[pluginName] = (acc[pluginName] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    };
  }
}

const cronManager = new CronManager();
export { cronManager };