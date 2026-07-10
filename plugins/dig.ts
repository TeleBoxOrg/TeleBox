import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { execFile } from "child_process";
import util from "util";
import axios from "axios";

const execFilePromise = util.promisify(execFile);

/**
 * Validate dig arguments to prevent shell injection.
 * Only allow: domain names, DNS record types, and common dig flags.
 * Reject any argument containing shell metacharacters.
 */
function sanitizeDigArgs(args: string[]): string[] | null {
  // Allow common dig flags starting with + or -, domain names, and DNS types
  for (const arg of args) {
    // Block shell metacharacters and path traversal
    if (/[;&|`$(){}!#<>'"\\]/.test(arg)) {
      return null;
    }
    // Block path traversal
    if (arg.includes("..") || arg.includes("/")) {
      return null;
    }
  }
  return args;
}

function htmlEscape(text: any): string {
  if (typeof text !== "string") {
    text = String(text);
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const COMMON_RECORD_TYPES = [
  "A",
  "AAAA",
  "MX",
  "CNAME",
  "TXT",
  "NS",
  "SOA",
  "PTR",
  "SRV",
  "CAA",
];

function extractDomainFromArgs(args: string[]): string | null {
  for (const arg of args) {
    if (
      !arg.startsWith("+") &&
      !arg.startsWith("-") &&
      !arg.startsWith("@") &&
      !arg.includes("/")
    ) {
      return arg;
    }
  }
  return null;
}

function isValidIPv4(ip: string): boolean {
  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipv4Regex.test(ip);
}

async function getIpLocation(ip: string): Promise<string> {
  try {
    const response = await axios.get(`https://api.ip.sb/geoip/${ip}`, {
      timeout: 3000,
      headers: {
        "User-Agent": "TeleBox-DNS-Plugin/1.0",
      },
    });

    if (response.status === 200 && response.data) {
      const data = response.data;
      const country = data.country || "";
      const region = data.region || "";
      const city = data.city || "";
      const asn = data.asn || "";

      let location = "";
      if (country) location += country;
      if (region && region !== country)
        location += (location ? "-" : "") + region;
      if (city && city !== region) location += (location ? "-" : "") + city;

      if (location && asn) {
        return `${location}-${asn}`;
      } else if (location) {
        return location;
      } else if (asn) {
        return asn;
      }

      return "未知";
    }
  } catch (error) {
    try {
      const response = await axios.get(`https://ipinfo.io/${ip}/json`, {
        timeout: 3000,
        headers: {
          "User-Agent": "TeleBox-DNS-Plugin/1.0",
        },
      });

      if (response.status === 200 && response.data && !response.data.bogon) {
        const data = response.data;
        const country = data.country || "";
        const region = data.region || "";
        const city = data.city || "";
        const org = data.org || "";

        let location = "";
        if (city) location += city;
        if (region && region !== city)
          location += (location ? "," : "") + region;
        if (country) location += (location ? "," : "") + country;

        let asn = "";
        if (org) {
          const asnMatch = org.match(/AS\d+/);
          if (asnMatch) {
            asn = asnMatch[0];
          }
        }

        if (location && asn) {
          return `${location}-${asn}`;
        } else if (location) {
          return location;
        } else if (asn) {
          return asn;
        } else if (org) {
          return org;
        }

        return "未知";
      }
    } catch (fallbackError) {
      console.error(
        "Both ip.sb and ipinfo.io APIs failed for IP location lookup"
      );
    }
  }

  return "";
}

async function executeDig(args: string[]): Promise<any> {
  try {
    const validatedArgs = sanitizeDigArgs(args);
    if (!validatedArgs) {
      throw new Error("查询参数包含非法字符，只允许域名、记录类型和 dig 标志");
    }

    const modifiedArgs = [...validatedArgs];
    const hasAnyPlusOption = modifiedArgs.some((arg) => arg.startsWith("+"));
    const isSimpleQuery =
      !hasAnyPlusOption && !modifiedArgs.some((arg) => arg.startsWith("-"));

    if (isSimpleQuery) {
      modifiedArgs.push("+short");
    }

    // Use execFile to pass args as array — no shell interpolation
    const { stdout, stderr } = await execFilePromise("dig", modifiedArgs, { timeout: 20000 });

    if (stderr && !stdout) {
      throw new Error(`dig 命令执行失败: ${stderr}`);
    }

    const hasShortOutput = modifiedArgs.includes("+short");

    return {
      success: true,
      output: stdout.trim(),
      isShortOutput: hasShortOutput,
    };
  } catch (error: any) {
    console.error("Dig execution error:", error);

    if (
      error.message?.includes("not found") ||
      error.message?.includes("not recognized")
    ) {
      throw new Error(
        "系统未安装 dig 工具。请安装 bind-utils (Linux) 或 dnsutils (Ubuntu/Debian) 包。"
      );
    }

    throw new Error(`DNS 查询失败: ${error.message || error}`);
  }
}

async function formatShortDnsResults(
  output: string,
  args: string[]
): Promise<string> {
  if (!output || output.trim() === "") {
    return `❌ <b>解析失败</b>

无记录或查询失败`;
  }

  const lines = output.split("\n").filter((line) => line.trim() !== "");

  const domain = extractDomainFromArgs(args);
  let resultText = `🔍 <b>DNS 解析</b>`;
  if (domain) {
    resultText += ` - <code>${htmlEscape(domain)}</code>`;
  }

  if (lines.length === 0) {
    resultText += "<br><br>❌ 无记录";
  } else {
    const displayLines = lines.slice(0, 3);
    const hasMore = lines.length > 3;

    resultText += "<br>";

    for (let i = 0; i < displayLines.length; i++) {
      const line = displayLines[i]?.trim() || "";

      if (isValidIPv4(line)) {
        const location = await getIpLocation(line);
        if (location) {
          resultText += `\n\n📍 <code>${htmlEscape(
            line
          )}</code>\n   <i>${htmlEscape(location)}</i>`;
        } else {
          resultText += `\n\n📍 <code>${htmlEscape(line)}</code>`;
        }
      } else {
        resultText += `\n\n🔗 <code>${htmlEscape(line)}</code>`;
      }
    }

    if (hasMore) {
      resultText += `\n\n<i>... 还有 ${lines.length - 3} 个结果未显示</i>`;
    }
  }

  return resultText;
}

function parseDnsRecord(
  line: string
): { domain: string; type: string; value: string; ttl?: string } | null {
  if (!line || typeof line !== "string") return null;

  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return null;

  const domain = parts[0]?.replace(/\.$/, "") || "";
  let ttl = "";
  let type = "";
  let value = "";

  const inIndex = parts.findIndex((p) => p === "IN");
  if (inIndex >= 0 && inIndex + 2 < parts.length) {
    if (inIndex > 1) ttl = parts[inIndex - 1] || "";
    type = parts[inIndex + 1] || "";
    value = parts.slice(inIndex + 2).join(" ");
  } else if (parts.length >= 4) {
    type = parts[parts.length - 2] || "";
    value = parts[parts.length - 1] || "";
  }

  return { domain, type, value, ttl };
}

async function formatDetailedDnsResults(
  output: string,
  args: string[]
): Promise<string> {
  if (!output || output.trim() === "") {
    return `❌ <b>解析失败</b>

无记录或查询失败`;
  }

  const lines = output.split("\n");

  let answerSection: string[] = [];
  let inAnswerSection = false;

  for (const line of lines) {
    if (line.includes(";; ANSWER SECTION:")) {
      inAnswerSection = true;
      continue;
    }
    if (inAnswerSection) {
      if (line.startsWith(";;") || line.trim() === "") {
        break;
      }
      if (line.trim() !== "" && !line.startsWith(";")) {
        answerSection.push(line.trim());
      }
    }
  }

  if (answerSection.length === 0) {
    const contentLines = lines.filter((line) => {
      const trimmed = line.trim();
      return (
        (trimmed !== "" &&
          !trimmed.startsWith(";;") &&
          !trimmed.startsWith(";") &&
          trimmed.includes("\t")) ||
        trimmed.split(/\s+/).length >= 4
      );
    });

    answerSection = contentLines;
  }

  const domain = extractDomainFromArgs(args);
  let resultText = `🔍 <b>DNS 解析</b>`;
  if (domain) {
    resultText += ` - <code>${htmlEscape(domain)}</code>`;
  }
  resultText += "<br>";

  if (answerSection.length === 0) {
    resultText += "<br><br>❌ 无记录";
    return resultText;
  }

  const displayLines = answerSection.slice(0, 3);
  const hasMore = answerSection.length > 3;

  for (let i = 0; i < displayLines.length; i++) {
    const line = displayLines[i] || "";
    const record = parseDnsRecord(line);

    if (record) {
      let icon = "📋";
      if (record.type === "A") icon = "📍";
      else if (record.type === "AAAA") icon = "📍";
      else if (record.type === "CNAME") icon = "🔗";
      else if (record.type === "MX") icon = "📧";
      else if (record.type === "NS") icon = "🌐";
      else if (record.type === "TXT") icon = "📝";

      resultText += `\n\n${icon} <b>${record.type}</b>: <code>${htmlEscape(
        record.value
      )}</code>`;

      if (record.domain && !record.domain.includes("$")) {
        resultText = resultText.replace(
          `${icon} <b>${record.type}</b>:`,
          `${icon} <b>${htmlEscape(record.domain)}</b> → <b>${record.type}</b>:`
        );
      }

      if (record.ttl && record.ttl !== "") {
        resultText += `\n   <i>TTL: ${record.ttl}s</i>`;
      }

      if (isValidIPv4(record.value)) {
        const location = await getIpLocation(record.value);
        if (location) {
          resultText += `\n   <i>${htmlEscape(location)}</i>`;
        }
      }
    } else {
      const parts = (line || "").split(/\s+/);
      const lastPart = parts[parts.length - 1] || "";

      if (isValidIPv4(lastPart)) {
        const location = await getIpLocation(lastPart);
        resultText += `\n\n📍 <code>${htmlEscape(lastPart)}</code>`;
        if (location) {
          resultText += `\n   <i>${htmlEscape(location)}</i>`;
        }
      } else {
        resultText += `\n\n🔗 <code>${htmlEscape(lastPart)}</code>`;
      }
    }
  }

  if (hasMore) {
    resultText += `\n\n<i>... 还有 ${
      answerSection.length - 3
    } 个结果未显示</i>`;
  }

  return resultText;
}

const dig = async (msg: Api.Message) => {
  try {
    const fullMessage = msg.message.slice(1);
    const args = fullMessage.split(" ").slice(1);

    if (args.length === 0) {
      await msg.edit({
        text: `❌ 未提供任何参数`,
        parseMode: "html",
      });
      return;
    }

    await msg.edit({
      text: `🔍 正在执行 DNS 查询...`,
      parseMode: "html",
    });

    const result = await executeDig(args);

    let resultText;
    if (result.isShortOutput) {
      resultText = await formatShortDnsResults(result.output, args);
    } else {
      resultText = await formatDetailedDnsResults(result.output, args);
    }

    await msg.edit({
      text: resultText,
      parseMode: "html",
      linkPreview: false,
    });
  } catch (error: any) {
    console.error("DNS query error:", error);

    let errorMessage = `❌ <b>DNS 查询失败</b>`;

    if (error.message) {
      errorMessage += `\n\n<b>错误详情:</b>\n<code>${htmlEscape(
        error.message
      )}</code>`;
    }

    if (error.message?.includes("未安装 dig 工具")) {
      errorMessage += `\n\n<b>解决方案:</b>
• Ubuntu/Debian: <code>sudo apt-get install dnsutils</code>
• RHEL/CentOS: <code>sudo yum install bind-utils</code>
• Fedora: <code>sudo dnf install bind-utils</code>`;
    }

    await msg.edit({
      text: errorMessage,
      parseMode: "html",
      linkPreview: false,
    });
  }
};

class DigPlugin extends Plugin {

  description: string = `调用系统 dig 命令进行查询并显示 IP 归属地及 ASN`;
  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    dig,
  };
}

export default new DigPlugin();
