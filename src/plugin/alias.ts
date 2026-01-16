import { Plugin } from "@utils/pluginBase";
import { AliasDB } from "@utils/aliasDB";
import { Api } from "telegram";
import { loadPlugins, getPrefixes, getPluginEntry } from "@utils/pluginManager";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];

async function setAlias(args: string[], msg: Api.Message) {
  const tokens = args.slice(1).filter(Boolean);

  if (tokens.length < 2) {
    await msg.edit({
      text: `参数不足，用法：${mainPrefix}alias set [别名...] [原命令...]`,
    });
    await msg.deleteWithDelay(5000);
    return;
  }

  let aliasTokens: string[] = [];
  let originalTokens: string[] = [];

  let splitIndex = -1;
  for (let i = 1; i < tokens.length; i++) {
    const entry = getPluginEntry(tokens[i]);
    if (entry && !entry.original) {
      splitIndex = i;
      break;
    }
  }

  if (splitIndex > 0) {
    aliasTokens = tokens.slice(0, splitIndex);
    originalTokens = tokens.slice(splitIndex);
  } else {
    aliasTokens = [tokens[0]];
    if (tokens[1]) originalTokens = [tokens[1]];
  }

  const final = aliasTokens.join(" ").trim();
  const original = originalTokens.join(" ").trim();

  if (!final || !original) {
    await msg.edit({
      text: `参数不足，用法：${mainPrefix}alias set [别名...] [原命令...]`,
    });
    await msg.deleteWithDelay(5000);
    return;
  }

  const [originalCmd] = original.split(/\s+/);
  const pluginEntry = getPluginEntry(originalCmd);

  if (!pluginEntry) {
    await msg.edit({ text: `没找到${originalCmd}该原始命令，不保存该重定向` });
    await msg.deleteWithDelay(5000);
    return;
  }

  if (pluginEntry.original) {
    await msg.edit({ text: "不应该对重定向的命令再次重定向" });
    await msg.deleteWithDelay(5000);
    return;
  }

  const db = new AliasDB();
  const list = db.list();
  for (const rec of list) {
    if (rec.final === original) {
      db.del(rec.original);
    }
  }

  db.set(final, original);
  db.close();

  await loadPlugins();

  await msg.edit({ text: `插件命令重命名成功，${final} -> ${original}` });
}

async function delAlias(args: string[], msg: Api.Message) {
  const alias = args.slice(1).join(" ").trim();
  if (!alias) {
    await msg.edit({
      text: `参数不足，用法：${mainPrefix}alias del [别名...]`,
    });
    await msg.deleteWithDelay(5000);
    return;
  }

  const db = new AliasDB();
  const ok = db.del(alias);
  db.close();

  if (ok) {
    await msg.edit({ text: `删除 ${alias} 重命名成功` });
    await loadPlugins();
  } else {
    await msg.edit({ text: `删除 ${alias} 重命名失败，请检查命令是否存在` });
  }
}

async function listAlias(args: string[], msg: Api.Message) {
  const db = new AliasDB();
  const list = db.list();
  db.close();

  if (!list.length) {
    await msg.edit({ text: "当前没有任何别名配置" });
    return;
  }

  const text = list.map((x) => `${x.original} -> ${x.final}`).join("\n");
  await msg.edit({ text: "重命名列表：\n" + text });
}

class AliasPlugin extends Plugin {
  description: string = `插件命名重命名
<code>${mainPrefix}alias set a b</code> - 使用别名 <code>a</code> 执行 <code>b</code>（同一原命令只保留一个别名，新设置会覆盖旧别名）
<code>${mainPrefix}alias del a</code> - 删除别名
<code>${mainPrefix}alias ls</code> - 查看所有别名`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    alias: async (msg) => {
      const [, ...args] = msg.message.split(" ").filter(Boolean);

      if (args.length === 0) {
        await msg.edit({ text: "不知道你要干什么！" });
        return;
      }

      const sub = args[0];
      if (sub === "set") return await setAlias(args, msg);
      if (sub === "del") return await delAlias(args, msg);
      if (sub === "ls" || sub === "list") return await listAlias(args, msg);

      await msg.edit({ text: `未知子命令: ${sub}` });
    },
  };
}

export default new AliasPlugin();
