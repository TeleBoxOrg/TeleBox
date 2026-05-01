import { execSync } from "child_process";
import fs from "fs";
import path from "path";

function readVersion(): string {
  try {
    const packagePath = path.join(process.cwd(), "package.json");
    const packageJson = fs.readFileSync(packagePath, "utf-8");
    const packageData = JSON.parse(packageJson);
    return packageData.version || "未知版本";
  } catch (error) {
    console.error("Failed to read version:", error);
    return "未知版本";
  }
}

function readDisplayVersion(): string {
  const version = readVersion();

  try {
    const commit = execSync("git rev-parse --short HEAD", {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!commit) {
      return version;
    }

    return `${version}(${commit})`;
  } catch {
    return version;
  }
}

function readAppName(): string {
  try {
    const userConfig = path.join(process.cwd(), "config.json");
    const rawJson = fs.readFileSync(userConfig, "utf-8");
    const name = JSON.parse(rawJson);
    return name.app_name || `TeleBox ${readVersion()}`;
  } catch (error) {
    console.error("无法读取config.json,", error);
    return `TeleBox ${readVersion()}`;
  }
}

export { readVersion, readDisplayVersion, readAppName };
