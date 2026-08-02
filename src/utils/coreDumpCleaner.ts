import fs from "fs";
import path from "path";

/**
 * 启动时自动清理工作目录下的 core dump 文件。
 *
 * Linux core dump 文件命名模式：
 *   - `core`              (core_pattern = core)
 *   - `core.<PID>`        (core_pattern = core.%p)
 *   - `core.<PID>.<UID>`  等
 *
 * 这些文件通常体积巨大且无保留价值，堆积会浪费磁盘空间。
 * 每次 TeleBox 启动时自动扫描并删除，保持目录整洁。
 */

/** 匹配 core dump 文件名：core 或 core.<数字...> */
const CORE_DUMP_PATTERN = /^core(?:\.\d+)*$/;

/**
 * 扫指定目录（非递归）下的 core dump 文件并删除。
 * @param dir 要扫描的目录（默认 process.cwd()）
 * @returns 删除的文件数
 */
export function cleanCoreDumps(dir: string = process.cwd()): number {
  let removed = 0;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!CORE_DUMP_PATTERN.test(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        // core dump 文件至少 > 0 字节才值得删；空文件也顺手清掉
        fs.unlinkSync(fullPath);
        removed++;
        const sizeKB = (stat.size / 1024).toFixed(0);
        console.log(`[coreDump] 已删除 ${entry.name} (${sizeKB} KB)`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[coreDump] 删除 ${entry.name} 失败: ${msg}`);
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[coreDump] 扫描目录 ${dir} 失败: ${msg}`);
  }

  if (removed > 0) {
    console.log(`[coreDump] 启动清理完成，共删除 ${removed} 个 core dump 文件`);
  }

  return removed;
}
