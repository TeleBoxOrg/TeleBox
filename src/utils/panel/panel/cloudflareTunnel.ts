/**
 * TeleBox Panel — Cloudflare Tunnel (cloudflared) manager.
 * Auto-starts cloudflared, captures the trycloudflare.com URL.
 * Auto-downloads cloudflared binary if not present.
 */

import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { logger } from "@utils/logger";

let tunnelProc: ChildProcess | null = null;
let capturedUrl: string | null = null;
let urlResolve: ((url: string) => void) | null = null;
let starting = false;

const ASSETS_DIR = path.join(process.cwd(), "assets", "panel", "cloudflared");
const BINARY_PATH = path.join(ASSETS_DIR, "cloudflared");
const VERSION_FILE = path.join(ASSETS_DIR, "version.txt");
const DOWNLOAD_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

function ensureAssetsDir(): void {
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }
}

async function downloadCloudflared(): Promise<string> {
  ensureAssetsDir();
  const tmpPath = BINARY_PATH + ".tmp";

  logger.info("[panel-tunnel] downloading cloudflared...");

  return new Promise((resolve, reject) => {
    const https = require("https");

    function doRequest(url: string, file: fs.WriteStream) {
      https.get(url, (res: any) => {
        // Follow redirects (301, 302, 303, 307, 308)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          logger.debug(`[panel-tunnel] redirect to: ${res.headers.location}`);
          file.close();
          // Create new file stream for the redirected request
          const newFile = fs.createWriteStream(tmpPath);
          doRequest(res.headers.location, newFile);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(tmpPath);
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let downloaded = 0;
        res.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
        });

        res.pipe(file);

        file.on("finish", () => {
          file.close();
          if (downloaded < 1_000_000) { // cloudflared should be ~8MB
            fs.unlinkSync(tmpPath);
            reject(new Error(`Downloaded file too small: ${downloaded} bytes`));
            return;
          }
          finishDownload(tmpPath, resolve, reject);
        });
      }).on("error", (e: Error) => {
        file.close();
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        reject(e);
      });
    }

    const file = fs.createWriteStream(tmpPath);
    doRequest(DOWNLOAD_URL, file);
  });
}

function finishDownload(tmpPath: string, resolve: (v: string) => void, reject: (e: Error) => void): void {
  fs.closeSync(fs.openSync(tmpPath, "r"));
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, BINARY_PATH);
  fs.writeFileSync(VERSION_FILE, new Date().toISOString());
  logger.info("[panel-tunnel] cloudflared downloaded and ready");
  resolve(BINARY_PATH);
}

function getCloudflaredPath(): string {
  // 1. Check local assets/panel/cloudflared/
  if (fs.existsSync(BINARY_PATH)) {
    try {
      const { execFileSync } = require("child_process");
      execFileSync(BINARY_PATH, ["version"], { stdio: "ignore" });
      return BINARY_PATH;
    } catch {
      // Binary corrupted, will re-download
    }
  }

  // 2. Check system PATH
  const candidates = [
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    "cloudflared",
  ];
  for (const c of candidates) {
    try {
      const { execFileSync } = require("child_process");
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      continue;
    }
  }

  // 3. Not found - will trigger auto-download
  return "";
}

async function ensureCloudflared(): Promise<string> {
  const existing = getCloudflaredPath();
  if (existing) return existing;

  logger.info("[panel-tunnel] cloudflared not found, auto-downloading...");
  return downloadCloudflared();
}

export async function startTunnel(port: number): Promise<string> {
  if (starting) {
    // Wait for existing start to complete
    return new Promise((resolve) => {
      const check = () => {
        if (capturedUrl) {
          resolve(capturedUrl);
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  // If already running with URL, return it
  if (capturedUrl && tunnelProc && !tunnelProc.killed) {
    return capturedUrl;
  }

  starting = true;
  stopTunnel(); // Clean up any old process

  const bin = await ensureCloudflared();
  logger.info(`[panel-tunnel] starting cloudflared on port ${port} via ${bin}`);

  // Try up to 3 times to get a URL
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      logger.info(`[panel-tunnel] retry attempt ${attempt}/3...`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
    try {
      const url = await startTunnelOnce(bin, port);
      if (url) {
        starting = false;
        return url;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[panel-tunnel] attempt ${attempt} failed: ${msg}`);
      if (attempt === 3) {
        starting = false;
        throw e;
      }
    }
  }

  starting = false;
  throw new Error("Failed to start tunnel after 3 attempts");
}

async function startTunnelOnce(bin: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlPromise = new Promise<string>((res) => {
      urlResolve = res;
    });

    let urlCaptured = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    try {
      // Use --loglevel info to get the URL in the info box output (stderr)
      // Debug level is too verbose and may not capture the URL box properly
      tunnelProc = spawn(bin, ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate", "--loglevel", "info"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      const checkAndCapture = (text: string, source: "stdout" | "stderr"): boolean => {
        // Multiple patterns to catch the URL
        const patterns = [
          /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,  // Standard
          /\|.*https:\/\/[a-z0-9-]+\.trycloudflare\.com.*\|/,  // Table format
          /https:\/\/[a-z0-9-]+\.trycloudflare\.com[^\s|]*/,  // With path
        ];
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match) {
            let url = match[0];
            // Clean up table format
            url = url.replace(/^.*\|\s*/, "").replace(/\s*\|.*$/, "");
            if (url.startsWith("https://")) {
              capturedUrl = url;
              logger.info(`[panel-tunnel] captured URL from ${source}: ${capturedUrl}`);
              return true;
            }
          }
        }
        return false;
      };

      tunnelProc.stdout?.on("data", (chunk) => {
        const text = chunk.toString();
        stdoutBuffer += text;
        logger.debug(`[panel-tunnel] stdout: ${text.trim()}`);
        if (!urlCaptured && checkAndCapture(text, "stdout")) {
          urlCaptured = true;
          if (urlResolve && capturedUrl) {
            urlResolve(capturedUrl);
            urlResolve = null;
          }
        }
      });

      tunnelProc.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        stderrBuffer += text;
        logger.debug(`[panel-tunnel] stderr: ${text.trim()}`);
        if (!urlCaptured && checkAndCapture(text, "stderr")) {
          urlCaptured = true;
          if (urlResolve && capturedUrl) {
            urlResolve(capturedUrl);
            urlResolve = null;
          }
        }
      });

      tunnelProc.on("error", (err) => {
        logger.error("[panel-tunnel] spawn error", err);
        if (urlResolve) {
          urlResolve = null;
          reject(err);
        }
      });

      tunnelProc.on("exit", (code, signal) => {
        logger.warn(`[panel-tunnel] process exited: code=${code} signal=${signal}`);
        // If process exited but we didn't get URL, check buffers one more time
        if (!urlCaptured) {
          logger.warn(`[panel-tunnel] URL not captured yet, scanning full buffers...`);
          logger.warn(`[panel-tunnel] === FULL STDOUT ===`);
          logger.warn(stdoutBuffer);
          logger.warn(`[panel-tunnel] === FULL STDERR ===`);
          logger.warn(stderrBuffer);
          checkAndCapture(stdoutBuffer, "stdout");
          checkAndCapture(stderrBuffer, "stderr");
        }
        tunnelProc = null;
        if (!capturedUrl && urlResolve) {
          urlResolve = null;
          reject(new Error(`cloudflared exited with code ${code}`));
        }
      });

      // Also handle the case where process stays alive but URL takes longer
      // Check buffers periodically while process is running
      let bufferCheckCount = 0;
      const bufferCheckInterval = setInterval(() => {
        if (tunnelProc && !tunnelProc.killed && !urlCaptured) {
          bufferCheckCount++;
          checkAndCapture(stdoutBuffer, "stdout");
          checkAndCapture(stderrBuffer, "stderr");
          if (urlCaptured) {
            clearInterval(bufferCheckInterval);
          } else if (bufferCheckCount > 10) { // Stop checking after ~10 seconds
            clearInterval(bufferCheckInterval);
          }
        } else {
          clearInterval(bufferCheckInterval);
        }
      }, 1000);

      // Timeout fallback
      setTimeout(() => {
        clearInterval(bufferCheckInterval);
        if (urlResolve) {
          // One final check on buffers
          if (!urlCaptured) {
            checkAndCapture(stdoutBuffer, "stdout");
            checkAndCapture(stderrBuffer, "stderr");
          }
          urlResolve = null;
          if (capturedUrl) {
            resolve(capturedUrl);
          } else if (tunnelProc && !tunnelProc.killed) {
            // Process still alive but no URL yet - wait more instead of rejecting
            logger.warn("[panel-tunnel] Process alive but no URL yet, extending wait...");
            // Don't reject, let the process continue running
          } else {
            reject(new Error("Timed out waiting for tunnel URL"));
          }
        }
        starting = false;
      }, 30000);

      urlPromise.then(resolve).catch(reject);
    } catch (e) {
      starting = false;
      reject(e);
    }
  });
}

export function stopTunnel(): void {
  if (tunnelProc && !tunnelProc.killed) {
    try {
      tunnelProc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    tunnelProc = null;
  }
  capturedUrl = null;
  starting = false;
}

export function getTunnelUrl(): string | null {
  return capturedUrl;
}

export function isTunnelRunning(): boolean {
  return !!tunnelProc && !tunnelProc.killed && !!capturedUrl;
}

export function getTunnelStatus(): { running: boolean; url: string | null } {
  return { running: isTunnelRunning(), url: capturedUrl };
}