#!/usr/bin/env npx tsx
/**
 * Thin launcher: session conversion always runs under the mtcute repo
 * (needs @mtcute/convert + @mtcute/node).
 *
 * Teleproto controller/plugin spawn this file; it re-execs the mtcute
 * implementation with the same env.
 */
import { spawnSync } from "child_process";
import path from "path";

const MTCUTE_ROOT = "/root/telebox_mtcute";
const SCRIPT = path.join(
  MTCUTE_ROOT,
  "src",
  "utils",
  "versionSwitchSessionConvert.ts",
);

const result = spawnSync(
  "npx",
  ["tsx", SCRIPT],
  {
    cwd: MTCUTE_ROOT,
    stdio: "inherit",
    env: process.env,
    timeout: 120_000,
  },
);

process.exit(result.status ?? 1);
