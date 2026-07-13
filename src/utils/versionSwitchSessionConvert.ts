/**
 * Thin launcher: session conversion always runs under the mtcute repo
 * (needs @mtcute/convert + @mtcute/node).
 *
 * Teleproto controller may re-exec this file; it delegates to mtcute via
 * process.execPath + scripts/run-tsx.cjs (never bare npx).
 */
import path from "path";
import {
  resolveRepoRoot,
  spawnTsxSync,
} from "./versionSwitchPaths";

const MTCUTE_ROOT = resolveRepoRoot("mtcute");
const SCRIPT = path.join(
  MTCUTE_ROOT,
  "src",
  "utils",
  "versionSwitchSessionConvert.ts",
);

const result = spawnTsxSync(MTCUTE_ROOT, SCRIPT, {
  cwd: MTCUTE_ROOT,
  stdio: "inherit",
  env: process.env,
  timeout: 120_000,
});

process.exit(result.status ?? 1);
