const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const root = __dirname;
const node = process.execPath;
const runner = path.join(root, 'scripts/run-tsx.cjs');
const entry = path.join(root, 'src/index.ts');

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(filePath));
}

function pickDefinedEnv(source, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

function pickPrefixedEnv(source, prefixes) {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => {
      return value !== undefined && prefixes.some((prefix) => key.startsWith(prefix));
    }),
  );
}

function parseInstances(value) {
  if (value === 'max') {
    return 'max';
  }

  const parsed = Number.parseInt(value || '1', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

const baseEnvFile = readEnvFile(path.join(root, '.env'));
const runtimeEnv = process.env.NODE_ENV || baseEnvFile.NODE_ENV || 'production';
const modeEnvFile = readEnvFile(path.join(root, `.env.${runtimeEnv}`));
const fileEnv = {
  ...baseEnvFile,
  ...modeEnvFile,
};
const effectiveEnv = {
  ...fileEnv,
  ...process.env,
};
const logDir = effectiveEnv.PM2_LOG_DIR || path.join(root, 'logs');
const execMode = effectiveEnv.PM2_EXEC_MODE === 'cluster' ? 'cluster' : 'fork';
const instances = parseInstances(effectiveEnv.PM2_INSTANCES);

fs.mkdirSync(logDir, { recursive: true });

const sharedEnv = {
  ...pickDefinedEnv(effectiveEnv, ['PORT', 'HOST', 'LOG_LEVEL', 'TZ']),
  ...pickPrefixedEnv(effectiveEnv, ['TB_', 'TELEBOX_']),
};

module.exports = {
  apps: [
    {
      name: 'telebox',
      cwd: root,
      script: node,
      args: `${runner} ${entry}`,
      interpreter: 'none',
      exec_mode: execMode,
      instances,
      env: {
        ...sharedEnv,
        NODE_ENV: runtimeEnv,
      },
      env_production: {
        ...sharedEnv,
        NODE_ENV: 'production',
      },
      env_development: {
        ...sharedEnv,
        NODE_ENV: 'development',
      },
      out_file: path.join(logDir, 'telebox-out.log'),
      error_file: path.join(logDir, 'telebox-error.log'),
      log_file: path.join(logDir, 'telebox-combined.log'),
      merge_logs: true,
      combine_logs: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};

