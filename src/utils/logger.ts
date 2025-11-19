import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import * as path from "path";
import dayjs from "dayjs";
import util from "util";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARNING = 2,
  ERROR = 3,
  SILENT = 4,
}

interface LoggerConfig {
  level: LogLevel;
}

// ANSI 颜色代码
const COLORS = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
};

// ANSI 转义序列（用于去除颜色等控制符）
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

class Logger {
  private db: any = null;
  private level: LogLevel = LogLevel.INFO;
  private readonly DB_NAME = "logger";
  private context: Record<string, any> = {};

  private static originalDebug = console.debug;
  private static originalLog = console.log;
  private static originalInfo = console.info;
  private static originalWarn = console.warn;
  private static originalError = console.error;
  private static isOverridden = false;

  constructor(context: Record<string, any> = {}) {
    this.context = context;
    // 只有主 Logger 实例才需要覆写控制台和加载 DB
    if (Object.keys(context).length === 0) {
        this.overrideConsole();
        this.initDB().catch(console.error);
    }
  }

  // 创建带有特定上下文的子日志实例
  public child(context: Record<string, any>): Logger {
    const childLogger = new Logger({ ...this.context, ...context });
    // 子 Logger 共享主 Logger 的等级
    childLogger.level = this.level; 
    return childLogger;
  }

  private async initDB() {
    if (this.db) return;
    const dbPath = path.join(
      createDirectoryInAssets(this.DB_NAME),
      "config.json"
    );
    this.db = await JSONFilePreset<LoggerConfig>(dbPath, { level: LogLevel.INFO });
    this.level = this.db.data.level;
  }

  private formatLog(level: string, args: any[]): string {
    const timestamp = dayjs().format("YYYY-MM-DD HH:mm:ss.SSS");
    
    // 颜色映射
    let levelColor = COLORS.reset;
    let levelIcon = "";
    switch (level.trim()) {
      case "DEBUG": levelColor = COLORS.gray; levelIcon = "🐛"; break;
      case "INFO": levelColor = COLORS.green; levelIcon = "ℹ️"; break;
      case "WARN": levelColor = COLORS.yellow; levelIcon = "⚠️"; break;
      case "ERROR": levelColor = COLORS.red; levelIcon = "❌"; break;
    }

    // 处理上下文
    let contextStr = "";
    if (Object.keys(this.context).length > 0) {
      contextStr = ` ${COLORS.cyan}{${Object.entries(this.context).map(([k, v]) => `${k}=${v}`).join(' ')}}${COLORS.reset}`;
    }

    // 处理消息内容和错误对象（先保留原始字符串数组以便做GramJS匹配）
    const stringArgs: string[] = args
      .filter(a => typeof a === 'string')
      .map(a => a as string);

    let msgParts = args.map(arg => {
      if (arg instanceof Error) {
        return `${COLORS.red}${arg.stack || arg.message}${COLORS.reset}`;
      }
      if (typeof arg === 'object') {
        return util.inspect(arg, { colors: true, depth: null, breakLength: Infinity });
      }
      return String(arg);
    });
    
    // 尝试获取调用者信息
    let caller = "";
    const stack = new Error().stack?.split("\n");
    if (stack) {
        // 查找第一个非 Logger 类的调用帧
        for (let i = 3; i < stack.length; i++) {
            const line = stack[i];
            if (!line.includes("logger.ts") && !line.includes("node_modules") && !line.includes("node:internal") && !line.includes("internal/")) {
                const match = line.match(/\((.*):(\d+):(\d+)\)/) || line.match(/at (.*):(\d+):(\d+)/);
                if (match) {
                  const fileName = path.basename(match[1]);
                  caller = ` ${COLORS.gray}[${fileName}:${match[2]}]${COLORS.reset}`;
                }
                break;
            }
        }
    }

    // 专为 GramJS 日志做的清洗逻辑
    // GramJS 格式通常为: [YYYY-MM-DDTHH:mm:ss.SSS] [LEVEL] - Message
    // 这里不再锚定行首，避免我们自己的前缀导致匹配失败；锚定行尾获取完整消息
    const gramJsRegex = /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\]\s*\[(\w+)\]\s*-\s*(.*)$/;
    let gramMatched = false;
    // 先尝试将所有字符串参数拼接后匹配（应对分段输出如: 时间戳、等级、消息分开传参的情况）
    if (stringArgs.length > 0) {
      const joined = stringArgs.join(' ');
      const m = joined.replace(ANSI_REGEX, "").match(gramJsRegex);
      if (m) {
        const gramLevel = m[1].toUpperCase();
        const gramMsg = m[2];
        switch (gramLevel) {
          case "DEBUG": level = "DEBUG"; levelColor = COLORS.gray; levelIcon = "🐛"; break;
          case "INFO": level = "INFO "; levelColor = COLORS.green; levelIcon = "ℹ️"; break;
          case "WARN": level = "WARN "; levelColor = COLORS.yellow; levelIcon = "⚠️"; break;
          case "ERROR": level = "ERROR"; levelColor = COLORS.red; levelIcon = "❌"; break;
        }
        caller = "";
        msgParts = [gramMsg];
        gramMatched = true;
      }
    }
    // 如未匹配，再逐个参数回退匹配
    if (!gramMatched) {
      for (const s of stringArgs) {
        const m = s.replace(ANSI_REGEX, "").match(gramJsRegex);
        if (m) {
          const gramLevel = m[1].toUpperCase();
          const gramMsg = m[2];
          switch (gramLevel) {
            case "DEBUG": level = "DEBUG"; levelColor = COLORS.gray; levelIcon = "🐛"; break;
            case "INFO": level = "INFO "; levelColor = COLORS.green; levelIcon = "ℹ️"; break;
            case "WARN": level = "WARN "; levelColor = COLORS.yellow; levelIcon = "⚠️"; break;
            case "ERROR": level = "ERROR"; levelColor = COLORS.red; levelIcon = "❌"; break;
          }
          caller = "";
          msgParts = [gramMsg];
          gramMatched = true;
          break;
        }
      }
    }

    const levelLabel = `${levelColor}[${level}]${COLORS.reset}`;
    const timeLabel = `${COLORS.gray}[${timestamp}]${COLORS.reset}`;
    
    return `${timeLabel} ${levelLabel}${contextStr}${caller} ${msgParts.join(' ')}`;
  }

  // 从原始 console 参数中尝试推断 GramJS 的日志等级（若存在）
  private detectGramJsLevel(args: any[]): "DEBUG" | "INFO " | "WARN " | "ERROR" | null {
    const stringArgs: string[] = args
      .filter(a => typeof a === 'string')
      .map(a => (a as string).replace(ANSI_REGEX, ""));
    if (stringArgs.length === 0) return null;
    const joined = stringArgs.join(' ');
    const gramJsRegex = /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\]\s*\[(\w+)\]\s*-\s*(.*)$/;
    const m = joined.match(gramJsRegex);
    if (!m) return null;
    const gramLevel = m[1].toUpperCase();
    switch (gramLevel) {
      case "DEBUG": return "DEBUG";
      case "INFO": return "INFO ";
      case "WARN": return "WARN ";
      case "ERROR": return "ERROR";
    }
    return null;
  }

  private overrideConsole() {
    if (Logger.isOverridden) return;

    console.debug = (...args: any[]) => {
      if (this.level <= LogLevel.DEBUG) {
        Logger.originalDebug(this.formatLog("DEBUG", args));
      }
    };

    console.log = (...args: any[]) => {
      if (this.level <= LogLevel.INFO) {
        const derived = this.detectGramJsLevel(args);
        const lvl = derived ?? "INFO ";
        Logger.originalLog(this.formatLog(lvl, args));
      }
    };
    
    console.info = (...args: any[]) => {
      if (this.level <= LogLevel.INFO) {
        const derived = this.detectGramJsLevel(args);
        const lvl = derived ?? "INFO ";
        Logger.originalInfo(this.formatLog(lvl, args));
      }
    };

    console.warn = (...args: any[]) => {
      if (this.level <= LogLevel.WARNING) {
        Logger.originalWarn(this.formatLog("WARN ", args));
      }
    };

    console.error = (...args: any[]) => {
      if (this.level <= LogLevel.ERROR) {
        Logger.originalError(this.formatLog("ERROR", args));
      }
    };
    
    Logger.isOverridden = true;
  }

  public async setLevel(level: LogLevel) {
    await this.initDB();
    this.level = level;
    this.db.data.level = level;
    await this.db.write();
  }

  public getLevel(): LogLevel {
    return this.level;
  }
  
  public getLevelName(level: LogLevel = this.level): string {
    return LogLevel[level];
  }
  
  public getGramJSLogLevel(): "debug" | "info" | "warn" | "error" | "none" {
    switch (this.level) {
      case LogLevel.DEBUG: return "debug";
      case LogLevel.INFO: return "info";
      case LogLevel.WARNING: return "warn";
      case LogLevel.ERROR: return "error";
      case LogLevel.SILENT: return "none";
      default: return "info";
    }
  }
}

export const logger = new Logger();
