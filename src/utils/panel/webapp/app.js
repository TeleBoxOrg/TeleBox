/**
 * TeleBox Panel — WebApp frontend.
 * Material Design 3 SPA, talks to the panel HTTP API.
 */
(function () {
  "use strict";

  /* ===== Config ===== */
  const API = window.location.origin + "/api";
  let TOKEN = "";

  /* ===== Telegram WebApp ===== */
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    if (tg.colorScheme === "dark") document.body.classList.add("tg-dark");
    tg.onEvent("themeChanged", () => {
      document.body.classList.toggle("tg-dark", tg.colorScheme === "dark");
    });
  }

  /* ===== DOM shortcuts ===== */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const show = (el) => el.classList.remove("hidden");
  const hide = (el) => el.classList.add("hidden");

  function view(id) {
    $("#view-boot").classList.remove("active");
    $("#view-main").classList.remove("active");
    $("#" + id).classList.add("active");
  }

  function page(name) {
    $$(".page").forEach((p) => p.classList.add("hidden"));
    const el = $(`.page[data-page="${name}"]`);
    if (el) el.classList.remove("hidden");
  }

  /* ===== HTTP ===== */
  async function api(method, path, body) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (TOKEN) opts.headers["Authorization"] = "Bearer " + TOKEN;
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const get = (p) => api("GET", p);
  const post = (p, b) => api("POST", p, b);
  const put = (p, b) => api("PUT", p, b);
  const del = (p) => api("DELETE", p);

  /* ===== Toast ===== */
  let toastTimer;

  function toast(msg, dur) {
    const el = $("#toast");
    el.textContent = msg;
    show(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(el), dur || 3000);
  }

  /* ===== Modal helper ===== */
  function modal(title, bodyHTML, actions) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHTML;
    const $actions = $("#modal-actions");
    $actions.innerHTML = "";
    (actions || [{ label: "关闭", primary: false }]).forEach((a) => {
      const btn = document.createElement("button");
      btn.className = "btn " + (a.primary ? "filled" : "text");
      btn.textContent = a.label;
      btn.onclick = () => {
        if (a.action) a.action();
        hide($("#modal"));
      };
      $actions.appendChild(btn);
    });
    show($("#modal"));
  }

  function escape(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function hideSettingsSave() {
    const btn = $("#settings-save");
    if (btn) btn.style.display = "none";
    const actions = btn?.closest(".form-actions");
    if (actions) actions.style.display = "none";
  }
  function showSettingsSave() {
    const btn = $("#settings-save");
    if (btn) btn.style.display = "";
    const actions = btn?.closest(".form-actions");
    if (actions) actions.style.display = "";
  }

  /* ===== Auth ===== */
  async function doAuth() {
    const msg = $("#boot-msg");
    const spinner = $("#boot-spinner");
    msg.textContent = "正在验证身份…";
    show(spinner);

    try {
      let initData = "";
      if (tg && tg.initData) {
        initData = tg.initData;
      } else {
        initData = new URLSearchParams(location.search).get("tgWebAppData") || "";
      }
      if (!initData) {
        msg.textContent = "请在 Telegram 小程序中打开";
        hide(spinner);
        show($("#btn-retry"));
        return;
      }
      const res = await post("/auth/telegram", { initData });
      if (!res.token) throw new Error("认证失败");
      TOKEN = res.token;
      localStorage.setItem("panel_token", res.token);
      msg.textContent = "登录成功！";
      hide(spinner);
      await initApp();
    } catch (e) {
      msg.textContent = "❌ " + (e.message || "认证失败");
      hide(spinner);
      show($("#btn-retry"));
    }
  }

  async function tryStoredToken() {
    try {
      const stored = localStorage.getItem("panel_token");
      if (!stored) return false;
      TOKEN = stored;
      const me = await get("/me");
      if (me.id) {
        await initApp();
        return true;
      }
      return false;
    } catch {
      localStorage.removeItem("panel_token");
      TOKEN = "";
      return false;
    }
  }

  /* ===== Navigation ===== */
  function navigate(pageName) {
    page(pageName);
    $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.go === pageName));
    switch (pageName) {
      case "home": loadHome(); break;
      case "tpm": loadTpm("remote"); break;
      case "plugins": loadPlugins(); break;
      case "settings": loadSettings(); break;
    }
  }

  /* ===== Home ===== */
  async function loadHome() {
    try {
      const [status, me, config] = await Promise.all([get("/status"), get("/me"), get("/config")]);
      const card = $("#home-status");
      const stats = [
        { label: "版本", value: escape(status.version || "-") },
        { label: "命令数", value: status.commandCount ?? "-" },
        { label: "插件数", value: status.pluginCount ?? "-" },
        { label: "管理员", value: status.adminCount ?? "-" },
        { label: "Owner", value: status.ownerId ? escape(String(status.ownerId)) : "未知" },
      ].map(s => `<div class="stat"><div class="label">${s.label}</div><div class="value">${s.value}</div></div>`).join("");

      // Merge Tunnel/Panel/Bot/HTTP into one "面板运行状态"
      let panelStatus = "❌ 关闭";
      if (status.enabled) {
        if (status.botRunning && status.httpRunning) panelStatus = "✅ 全部运行中";
        else if (status.botRunning) panelStatus = "⚠️ Bot运行 HTTP停止";
        else if (status.httpRunning) panelStatus = "⚠️ HTTP运行 Bot停止";
        else panelStatus = "❌ 面板开启但服务未跑";
      }
      const tunnelInfo = config.tunnelRunning ? ` 🌐 ${config.tunnelCurrentUrl || config.tunnelUrl}` : (config.tunnelMode === "cloudflare" ? " ⏳ 启动中" : (config.tunnelMode === "manual" ? " 🔧 手动模式" : " ❌ 关闭"));

      const detail = [
        `HTTP:  ${status.bind || "-"}`,
        `公网:  ${status.publicBaseUrl || "-"}`,
        `Bot:   ${status.botConfigured ? "已配置" : "未配置"} ${status.botRunning ? "运行中" : ""}`,
        `Tunnel: ${config.tunnelMode}${tunnelInfo}`,
        "",
        `用户:  @${me.username || "-"} (${me.id})`,
        me.isOwner ? "角色:  Owner" : "角色:  Admin",
      ].join("\n");

      card.innerHTML = `
        <div class="card-title">概览</div>
        <div class="stats">${stats}</div>
        <div class="card-title" style="margin-top:16px">面板运行状态: ${panelStatus}</div>
        <pre class="mono">${escape(detail)}</pre>
      `;

      $("#app-title").textContent = status.displayName || "TeleBox Panel";
      $("#app-sub").textContent = `v${status.version}`;
    } catch (e) {
      toast("加载首页失败: " + e.message);
    }
  }

  /* ===== TPM ===== */
  let tpmTab = "remote";

  async function loadTpm(tab) {
    tpmTab = tab || tpmTab;
    $$("[data-tpm-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tpmTab === tpmTab));
    const list = $("#tpm-list");
    const stats = $("#tpm-stats");
    try {
      if (tpmTab === "remote") {
        const q = $("#tpm-q").value.trim();
        const data = await get("/tpm/search?q=" + encodeURIComponent(q));
        stats.innerHTML = `共 ${data.total} 个插件 | ✅ ${data.installed} 已装 | 🔶 ${data.localOnly} 本地 | ❌ ${data.remoteOnly} 远端`;
        if (!data.items.length) {
          list.innerHTML = '<div class="empty">无结果</div>';
          return;
        }
        list.innerHTML = data.items.map((p) => {
          const statusBadge = p.status === "installed"
            ? '<span class="badge ok">已装</span>'
            : p.status === "local"
              ? '<span class="badge warn">本地</span>'
              : '<span class="badge err">未装</span>';
          return `<div class="list-item">
            <div class="leading">🔌</div>
            <div class="body">
              <div class="title">${escape(p.name)} ${statusBadge}</div>
              <div class="desc">${escape(p.desc)}</div>
            </div>
            <div class="trailing">
              ${p.status === "installed" ? `<button class="btn sm outlined" data-tpm-uninstall="${escape(p.name)}">卸载</button>` : `<button class="btn sm filled" data-tpm-install="${escape(p.name)}">安装</button>`}
            </div>
          </div>`;
        }).join("");
        // Wire install/uninstall
        $$("[data-tpm-install]").forEach((btn) => {
          btn.onclick = async () => {
            const name = btn.dataset.tpmInstall;
            btn.disabled = true;
            try {
              const r = await post("/tpm/install", { names: [name] });
              if (r.failed?.length) toast("❌ " + r.failed[0].error);
              else toast("✅ 已安装 " + name);
              loadTpm("remote");
            } catch (e) { toast("❌ " + e.message); }
          };
        });
        $$("[data-tpm-uninstall]").forEach((btn) => {
          btn.onclick = async () => {
            const name = btn.dataset.tpmUninstall;
            modal("卸载插件", `确定卸载 <b>${escape(name)}</b>？`, [
              { label: "取消", primary: false },
              { label: "卸载", primary: true, action: async () => {
                try {
                  const r = await post("/tpm/uninstall", { names: [name] });
                  if (r.ok?.length) toast("✅ 已卸载 " + name);
                  else toast("❌ " + (r.failed?.[0]?.error || "失败"));
                  loadTpm("remote");
                } catch (e) { toast("❌ " + e.message); }
              }},
            ]);
          };
        });
      } else {
        const data = await get("/tpm/installed?verbose=1");
        stats.innerHTML = `已安装 ${data.count} 个插件`;
        if (!data.items.length) {
          list.innerHTML = '<div class="empty">暂无已安装插件</div>';
          return;
        }
        list.innerHTML = data.items.map((p) => {
          const size = p.fileSize ? ` ${(p.fileSize / 1024).toFixed(1)}KB` : "";
          const installedAt = p.updatedAt ? new Date(p.updatedAt).toLocaleString("zh-CN") : "";
          return `<div class="list-item">
            <div class="leading">📦</div>
            <div class="body">
              <div class="title">${escape(p.name)}</div>
              <div class="desc">${p.desc ? escape(p.desc) : ""}${installedAt ? " · 安装于 " + installedAt : ""}</div>
            </div>
            <div class="trailing">
              <span class="badge">${size}</span>
              <button class="btn sm outlined" data-tpm-uninstall="${escape(p.name)}">卸载</button>
            </div>
          </div>`;
        }).join("");
        $$("[data-tpm-uninstall]").forEach((btn) => {
          btn.onclick = () => {
            const name = btn.dataset.tpmUninstall;
            modal("卸载插件", `确定卸载 <b>${escape(name)}</b>？`, [
              { label: "取消", primary: false },
              { label: "卸载", primary: true, action: async () => {
                await post("/tpm/uninstall", { names: [name] });
                toast("✅ 已卸载 " + name);
                loadTpm("installed");
              }},
            ]);
          };
        });
      }
    } catch (e) {
      list.innerHTML = `<div class="empty">❌ ${escape(e.message)}</div>`;
    }
  }

  /* ===== SSE-based TPM update all ===== */
  function startTpmUpdateStream() {
    const btn = $("#tpm-update-all");
    btn.disabled = true;

    // Build overlay
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal card elevation-3" style="max-height:80vh;display:flex;flex-direction:column">
      <div class="modal-title" style="flex-shrink:0">更新全部插件</div>
      <div class="modal-body" id="update-progress-body" style="flex:1;overflow:auto;white-space:pre-wrap;font-size:0.82rem;font-family:monospace;line-height:1.5">正在连接…</div>
      <div class="modal-actions" id="update-progress-actions" style="flex-shrink:0">
        <button class="btn text" id="update-progress-close">关闭</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    const setProgress = (msg) => {
      const el = document.getElementById("update-progress-body");
      if (el) el.textContent = msg;
    };
    const appendProgress = (line) => {
      const el = document.getElementById("update-progress-body");
      if (el) el.textContent = (el.textContent || "") + "\n" + line;
    };

    setProgress("正在连接更新服务…");

    // Connect via SSE
    const url = API + "/tpm/update/stream";
    const es = new EventSource(url + "?token=" + encodeURIComponent(TOKEN));

    // Since we need auth, send token as query param
    // Actually, EventSource doesn't support custom headers, so we need a different approach:
    // Use fetch with GET + Authorization header, then read the stream
    // Let's use fetch-based SSE reader instead

    // Close the EventSource experiment, use fetch
    es.close();

    // Use fetch-based SSE
    let lines = [];
    let currentEvent = "";

    fetch(url, {
      headers: { "Authorization": "Bearer " + TOKEN }
    }).then(async (response) => {
      if (!response.ok) {
        const err = await response.text();
        setProgress("❌ 连接失败: " + err);
        btn.disabled = false;
        document.getElementById("update-progress-close").onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop(); // keep incomplete last part

        for (const part of parts) {
          const lines = part.split("\n");
          let eventType = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (eventType === "progress" && data) {
            try {
              const ev = JSON.parse(data);
              switch (ev.type) {
                case "checking":
                  appendProgress(`⏳ 检查 ${ev.name} (${ev.total ? `${ev.total} 个中` : ""})`);
                  break;
                case "updated":
                  appendProgress(`✅ 已更新 ${ev.name}`);
                  break;
                case "unchanged":
                  appendProgress(`⏸ 未变 ${ev.name}`);
                  break;
                case "failed":
                  appendProgress(`❌ 失败 ${ev.name}: ${ev.error}`);
                  break;
                case "start":
                  setProgress(`开始检查 ${ev.total} 个插件…`);
                  break;
                case "end":
                  appendProgress("\n✅ 更新完成");
                  btn.disabled = false;
                  // Refresh list
                  if (tpmTab === "remote") loadTpm("remote");
                  else loadTpm("installed");
                  break;
                default:
                  appendProgress(`📋 ${ev.type}: ${ev.name || JSON.stringify(ev)}`);
              }
            } catch { /* ignore parse error */ }
          } else if (eventType === "done") {
            appendProgress("\n✅ 全部更新完成");
            btn.disabled = false;
            if (tpmTab === "remote") loadTpm("remote");
            else loadTpm("installed");
          } else if (eventType === "error") {
            try {
              const err = JSON.parse(data);
              appendProgress("❌ 错误: " + (err.error || "未知"));
            } catch {
              appendProgress("❌ 更新出错");
            }
            btn.disabled = false;
          }
        }
      }
    }).catch((err) => {
      setProgress("❌ 连接失败: " + err.message);
      btn.disabled = false;
    }).finally(() => {
      btn.disabled = false;
      document.getElementById("update-progress-close").onclick = () => overlay.remove();
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    });
  }

  /* ===== Help & Plugins (merged) ===== */
  let pluginsData = [];
  let helpCache = {};
  let modMapGlobal = {};

  async function loadPlugins() {
    try {
      const [helpData, pluginsResp, tpmData] = await Promise.all([get("/help"), get("/plugins"), get("/tpm/search?q=")]);
      pluginsData = pluginsResp.items || [];
      // 预览只用 plugins.json（TPM）简介；没有就空着。helptext 仅展开后加载
      const tpmDescMap = {};
      (tpmData.items || []).forEach((p) => { if (p.desc) tpmDescMap[p.name] = p.desc; });
      pluginsData.forEach((p) => {
        p.description = tpmDescMap[p.name] || "";
      });
      helpCache = helpData;
      // Build modMap for togglePlugin access
      const mods = helpCache.modules || [];
      modMapGlobal = {};
      mods.forEach((m) => { modMapGlobal[m.name] = m.commands; });

      const overview = $("#plugins-overview");
      overview.innerHTML = `<div class="plugins-overview">
        <div class="stat-row">
          <div class="stat-item"><div class="stat-label">版本</div><div class="stat-value">${escape(helpData.version)}</div></div>
          <div class="stat-item"><div class="stat-label">命令数</div><div class="stat-value">${helpData.commandCount}</div></div>
          <div class="stat-item"><div class="stat-label">插件数</div><div class="stat-value">${helpData.pluginCount}</div></div>
          <div class="stat-item"><div class="stat-label">前缀</div><div class="stat-value">${escape(helpData.prefixes.join(" "))}</div></div>
        </div>
      </div>`;

      renderPluginsList("");
    } catch (e) {
      $("#plugins-list").innerHTML = `<div class="empty">❌ ${escape(e.message)}</div>`;
    }
  }

  async function renderPluginsList(filter) {
    const list = $("#plugins-list");
    const kw = filter.trim().toLowerCase();

    let items = pluginsData;

    // Filter
    if (kw) {
      items = items.filter((p) => {
        return p.name.toLowerCase().includes(kw) ||
               (p.description && p.description.toLowerCase().includes(kw)) ||
               (p.commands || []).some((c) => c.toLowerCase().includes(kw));
      });
    }

    if (!items.length) {
      list.innerHTML = '<div class="empty">无匹配插件</div>';
      return;
    }

    // Build collapsible blocks
    list.innerHTML = items.map((p) => {
      const cmds = p.commands || [];
      const modCmds = modMapGlobal[p.name] || [];
      const allCmds = [...new Set([...modCmds, ...cmds])];

      // Build commands list
      const cmdStr = allCmds.length ? allCmds.map((c) => `<code>${escape(c)}</code>`).join(" ") : "";

      const badges = [];
      if (p.isSystem) badges.push('<span class="badge">系统</span>');
      else badges.push('<span class="badge warn">用户</span>');
      if (p.hasSettings) badges.push('<span class="badge ok">可设置</span>');
      if (p.hasCron) badges.push('<span class="badge">⏱</span>');

      return `<div class="plugin-card card elevation-1" data-plugin-name="${escape(p.name)}">
        <div class="plugin-header" onclick="togglePlugin(this)">
          <div class="plugin-title-row">
            <span class="plugin-icon">${p.isSystem ? "⚙️" : "🔌"}</span>
            <span class="plugin-name">${escape(p.name)}</span>
            ${badges.join(" ")}
            <span class="plugin-arrow material-icons-round">expand_more</span>
          </div>
          <div class="plugin-desc">${escape(p.description || "")}</div>
          <div class="plugin-cmds">${cmdStr}</div>
        </div>
        <div class="plugin-body hidden">
          <div class="plugin-helptext mono" id="helptext-${escape(p.name)}">点击展开加载帮助…</div>
        </div>
      </div>`;
    }).join("");
  }

  async function loadHelptext(pluginName, cmd) {
    const el = document.getElementById("helptext-" + escape(pluginName));
    if (!el) return;
    try {
      const detail = await get("/help/" + encodeURIComponent(cmd));
      const lines = [];
      if (detail.description) lines.push(detail.description);
      if (detail.handlers && detail.handlers.length > 1) {
        lines.push("命令: " + detail.handlers.map((h) => `.${h}`).join(" "));
      }
      if (detail.aliases && detail.aliases.length) {
        lines.push("别名: " + detail.aliases.join(", "));
      }
      el.textContent = lines.join("\n") || "暂无详细帮助";
    } catch {
      el.textContent = "暂无帮助信息，请使用 .help 命令查看";
    }
  }

  // Toggle function exposed globally
  window.togglePlugin = function(header) {
    const card = header.closest(".plugin-card");
    const body = card.querySelector(".plugin-body");
    const arrow = card.querySelector(".plugin-arrow");
    const isHidden = body.classList.contains("hidden");
    body.classList.toggle("hidden");
    arrow.textContent = body.classList.contains("hidden") ? "expand_more" : "expand_less";
    if (isHidden) {
      // First expand - load helptext
      const pluginName = card.dataset.pluginName;
      const helpEl = document.getElementById("helptext-" + pluginName);
      if (helpEl && helpEl.textContent.includes("点击展开")) {
        const cmds = [...new Set([...(pluginsData.find(p => p.name === pluginName)?.commands || []), ...(modMapGlobal[pluginName] || [])])];
        const firstCmd = cmds[0] || "";
        if (firstCmd) loadHelptext(pluginName, firstCmd);
        else helpEl.textContent = "无命令信息";
      }
    }
  };

  /* ===== Settings ===== */
  async function loadSettings() {
    try {
      const data = await get("/settings");
      const list = $("#settings-list");
      if (!data.items?.length) {
        list.innerHTML = '<div class="empty">暂无设置提供者</div>';
        return;
      }
      const groups = {};
      data.items.forEach((s) => {
        const cat = s.category || "其他";
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(s);
      });
      // 权限组末尾追加「管理员」入口（与 Sudo 同级）
      if (!groups["权限"]) groups["权限"] = [];
      if (!groups["权限"].some((s) => s.id === "__admins__")) {
        groups["权限"].push({
          id: "__admins__",
          title: "管理员",
          description: "管理 Panel 管理员名单",
          icon: "👑",
          category: "权限",
        });
      }
      // Sort categories: 系统 first, 插件配置 second, 权限 third, others after
      const catOrder = { "系统": 0, "插件配置": 1, "权限": 2 };
      const sortedCats = Object.keys(groups).sort((a, b) => (catOrder[a] ?? 99) - (catOrder[b] ?? 99));
      list.innerHTML = sortedCats.map((cat) => {
        const items = groups[cat];
        return `<div class="settings-group">
          <div class="settings-group-title">${escape(cat)}</div>
          ${items.map((s) => `<div class="list-item" style="cursor:pointer" data-settings-id="${escape(s.id)}">
            <div class="leading">${s.icon || "⚙️"}</div>
            <div class="body">
              <div class="title">${escape(s.title)}</div>
              <div class="desc">${escape(s.description || "")}</div>
            </div>
            <span class="material-icons-round" style="color:var(--md-sys-color-on-surface-variant)">chevron_right</span>
          </div>`).join("")}
        </div>`;
      }).join("");
      $$("[data-settings-id]").forEach((el) => {
        el.onclick = () => {
          if (el.dataset.settingsId === "__admins__") {
            page("settings-admin");
            loadAdminsTab();
            return;
          }
          loadSettingsDetail(el.dataset.settingsId);
        };
      });
    } catch (e) {
      $("#settings-list").innerHTML = `<div class="empty">❌ ${escape(e.message)}</div>`;
    }
    // 权限组下方不再内嵌管理员卡片
  }

  async function loadSettingsDetail(id) {
    page("settings-detail");
    try {
      const data = await get("/settings/" + encodeURIComponent(id));
      $("#settings-detail-title").textContent = data.title;
      $("#settings-detail-desc").textContent = data.description || "";

      const form = $("#settings-form");
      const schema = data.schema || [];
      const values = data.values || {};

      // Custom renderers for special setting types
      if (id === "alias") {
        form.innerHTML = renderAliasEditor(values);
        wireAliasEditor(id, form);
        hideSettingsSave();
        return;
      }
      if (id === "prefix") {
        form.innerHTML = renderPrefixEditor(values);
        wirePrefixEditor(id, form);
        hideSettingsSave();
        return;
      }
      if (id === "sudo") {
        form.innerHTML = renderSudoEditor(values);
        wireSudoEditor(id, form);
        hideSettingsSave();
        return;
      }
      if (id === "status") {
        form.innerHTML = renderStatusEditor(values);
        wireStatusEditor(id, form);
        hideSettingsSave();
        return;
      }

      // Generic renderer
      showSettingsSave();
      
      // Check for custom renderer types
      const hasCustomRenderer = schema.some((f) => 
        ["provider-list", "prompt-map", "tag-list"].includes(f.type)
      );
      if (hasCustomRenderer) {
        form.innerHTML = schema.map((f) => renderCustomField(f, values)).join("");
        wireCustomFields(id, schema, form);
        return;
      }
      
      form.innerHTML = schema.map((f) => {
        const val = values[f.key];
        let input = "";
        if (f.type === "boolean") {
          input = `<div class="switch"><span>${escape(f.label)}</span><input type="checkbox" name="${escape(f.key)}" ${val ? "checked" : ""} /></div>`;
        } else if (f.type === "select" && f.options?.length) {
          const opts = f.options.map((o) => `<option value="${escape(o.value)}"${String(val) === o.value ? " selected" : ""}>${escape(o.label)}</option>`).join("");
          input = `<select name="${escape(f.key)}">${opts}</select>`;
        } else if (f.type === "textarea") {
          input = `<textarea name="${escape(f.key)}" placeholder="${escape(f.placeholder || "")}">${val != null ? escape(String(val)) : ""}</textarea>`;
        } else {
          input = `<input type="${f.secret ? "password" : "text"}" name="${escape(f.key)}" value="${val != null ? escape(String(val)) : ""}" placeholder="${escape(f.placeholder || "")}" />`;
        }
        const hint = f.description ? `<div class="hint">${escape(f.description)}</div>` : "";
        return `<div class="field-group"><label>${escape(f.label)}</label>${input}${hint}</div>`;
      }).join("");
      $("#settings-save").onclick = async () => {
        const fd = new FormData(form);
        const patch = {};
        schema.forEach((f) => {
          const el = form.elements[f.key];
          if (!el) return;
          if (f.type === "boolean") patch[f.key] = el.checked;
          else if (f.type === "number") patch[f.key] = Number(el.value);
          else patch[f.key] = el.value;
        });
        try {
          await put("/settings/" + encodeURIComponent(id), patch);
          toast("✅ 已保存");
          loadSettingsDetail(id);
        } catch (e) { toast("❌ " + e.message); }
      };
    } catch (e) {
      $("#settings-form").innerHTML = `<div class="empty">❌ ${escape(e.message)}</div>`;
    }
  }

  /* ===== Custom editor renderers ===== */

  function renderAliasEditor(values) {
    const entries = (() => { try { return JSON.parse(values.entries || "{}"); } catch { return {}; } })();
    const keys = Object.keys(entries);
    if (!keys.length) {
      return `<div class="alias-editor" id="alias-editor">
        <div class="alias-empty">暂无别名，添加一个</div>
        <div class="alias-entry">
          <input type="text" placeholder="原命令" class="alias-from" />
          <span class="material-icons-round">arrow_forward</span>
          <input type="text" placeholder="目标命令" class="alias-to" />
          <button class="btn sm filled add-alias-row">+</button>
        </div>
        <div class="alias-actions">
          <button class="btn filled" id="alias-save-btn">保存</button>
        </div>
      </div>`;
    }
    let html = `<div class="alias-editor" id="alias-editor">`;
    keys.forEach((k) => {
      html += `<div class="alias-entry">
        <input type="text" value="${escape(k)}" class="alias-from" />
        <span class="material-icons-round">arrow_forward</span>
        <input type="text" value="${escape(entries[k])}" class="alias-to" />
        <button class="btn sm text remove-alias-row"><span class="material-icons-round">close</span></button>
      </div>`;
    });
    html += `<div class="alias-entry">
      <input type="text" placeholder="原命令" class="alias-from" />
      <span class="material-icons-round">arrow_forward</span>
      <input type="text" placeholder="目标命令" class="alias-to" />
      <button class="btn sm filled add-alias-row">+</button>
    </div>
    <div class="alias-actions">
      <button class="btn filled" id="alias-save-btn">保存</button>
    </div></div>`;
    return html;
  }

  function wireAliasEditor(id) {
    const container = $("#alias-editor");
    container.addEventListener("click", (e) => {
      const addBtn = e.target.closest(".add-alias-row");
      if (addBtn) {
        const entry = addBtn.closest(".alias-entry");
        const newEntry = entry.cloneNode(true);
        newEntry.querySelector(".alias-from").value = "";
        newEntry.querySelector(".alias-to").value = "";
        entry.after(newEntry);
        newEntry.querySelector(".alias-from").focus();
        return;
      }
      const rmBtn = e.target.closest(".remove-alias-row");
      if (rmBtn) {
        const entry = rmBtn.closest(".alias-entry");
        if (container.querySelectorAll(".alias-entry").length > 1) {
          entry.remove();
        }
        return;
      }
    });
    $("#alias-save-btn").onclick = async () => {
      const entries = {};
      container.querySelectorAll(".alias-entry").forEach((row) => {
        const from = row.querySelector(".alias-from").value.trim();
        const to = row.querySelector(".alias-to").value.trim();
        if (from && to) entries[from] = to;
      });
      try {
        await put("/settings/" + encodeURIComponent(id), { entries: JSON.stringify(entries) });
        toast("✅ 已保存");
        loadSettingsDetail(id);
      } catch (e) { toast("❌ " + e.message); }
    };
  }

  function renderPrefixEditor(values) {
    const prefixes = (values.prefixes || ". ！").split(/\s+/).filter(Boolean);
    let html = `<div class="prefix-editor" id="prefix-editor">`;
    html += `<div class="prefix-tags">`;
    prefixes.forEach((p) => {
      html += `<span class="prefix-tag"><span>${escape(p)}</span><span class="material-icons-round remove-prefix">close</span></span>`;
    });
    html += `</div>`;
    html += `<div class="prefix-input-row">
      <input type="text" id="prefix-new-input" placeholder="输入新前缀" maxlength="2" />
      <button class="btn sm filled" id="add-prefix-btn">添加</button>
    </div>`;
    html += `<div class="alias-actions"><button class="btn filled" id="prefix-save-btn">保存</button></div>`;
    html += `</div>`;
    return html;
  }

  function wirePrefixEditor(id) {
    const container = $("#prefix-editor");
    const tagContainer = container.querySelector(".prefix-tags");

    // Remove prefix tag
    container.addEventListener("click", (e) => {
      const rm = e.target.closest(".remove-prefix");
      if (rm) {
        rm.closest(".prefix-tag").remove();
      }
    });

    // Add prefix
    $("#add-prefix-btn").onclick = () => {
      const input = $("#prefix-new-input");
      const val = input.value.trim();
      if (!val) return;
      // Check duplicate
      const existing = [...tagContainer.querySelectorAll(".prefix-tag span:first-child")].map(s => s.textContent);
      if (existing.includes(val)) { toast("已存在"); return; }
      const tag = document.createElement("span");
      tag.className = "prefix-tag";
      tag.innerHTML = `<span>${escape(val)}</span><span class="material-icons-round remove-prefix">close</span>`;
      tagContainer.appendChild(tag);
      input.value = "";
      input.focus();
    };
    $("#prefix-new-input").onkeydown = (e) => { if (e.key === "Enter") $("#add-prefix-btn").click(); };

    // Save
    $("#prefix-save-btn").onclick = async () => {
      const prefixes = [...tagContainer.querySelectorAll(".prefix-tag")].map(t => t.querySelector("span").textContent).join(" ");
      try {
        await put("/settings/"+encodeURIComponent(id), { prefixes });
        toast("✅ 前缀已保存");
      } catch (e) { toast("❌ " + e.message); }
    };
  }

  function renderSudoEditor(values) {
    const users = (() => { try { return JSON.parse(values.users || "[]"); } catch { return []; } })();
    const chats = (() => { try { return JSON.parse(values.chats || "[]"); } catch { return []; } })();
    let html = `<div class="sudo-editor" id="sudo-editor">`;

    // Users
    html += `<div class="sudo-section"><div class="sudo-section-title">👤 Sudo 用户</div>`;
    if (!users.length) html += `<div class="sudo-empty">暂无 Sudo 用户</div>`;
    users.forEach((u) => {
      html += `<div class="sudo-entry"><input type="number" value="${u.uid}" class="sudo-uid" placeholder="UID" /><input type="text" value="${escape(u.username || "")}" class="sudo-name" placeholder="用户名" /><button class="btn sm text remove-sudo-user"><span class="material-icons-round">close</span></button></div>`;
    });
    html += `<div class="sudo-entry"><input type="number" class="sudo-uid" placeholder="Telegram UID" /><input type="text" class="sudo-name" placeholder="用户名" /><button class="btn sm filled add-sudo-user">+</button></div>`;
    html += `</div>`;

    // Chats
    html += `<div class="sudo-section"><div class="sudo-section-title">💬 对话白名单</div>`;
    if (!chats.length) html += `<div class="sudo-empty">暂无白名单对话</div>`;
    chats.forEach((c) => {
      html += `<div class="sudo-entry"><input type="number" value="${c.id}" class="sudo-chat-id" placeholder="Chat ID" /><input type="text" value="${escape(c.name || "")}" class="sudo-chat-name" placeholder="名称" /><button class="btn sm text remove-sudo-chat"><span class="material-icons-round">close</span></button></div>`;
    });
    html += `<div class="sudo-entry"><input type="number" class="sudo-chat-id" placeholder="Chat ID" /><input type="text" class="sudo-chat-name" placeholder="名称" /><button class="btn sm filled add-sudo-chat">+</button></div>`;
    html += `</div>`;

    html += `<div class="sudo-actions"><button class="btn filled" id="sudo-save-btn">保存</button></div>`;
    html += `</div>`;
    return html;
  }

  function wireSudoEditor(id) {
    const container = $("#sudo-editor");

    // Add user
    container.addEventListener("click", (e) => {
      const add = e.target.closest(".add-sudo-user");
      if (add) {
        const entry = add.closest(".sudo-entry");
        const clone = entry.cloneNode(true);
        clone.querySelector(".sudo-uid").value = "";
        clone.querySelector(".sudo-name").value = "";
        const btn = clone.querySelector(".add-sudo-user");
        btn.className = "btn sm text remove-sudo-user";
        btn.innerHTML = '<span class="material-icons-round">close</span>';
        entry.after(clone);
        clone.querySelector(".sudo-uid").focus();
        return;
      }
      const rm = e.target.closest(".remove-sudo-user");
      if (rm) {
        const section = rm.closest(".sudo-section");
        const entries = section.querySelectorAll(".sudo-entry");
        if (entries.length > 1) rm.closest(".sudo-entry").remove();
        return;
      }
      const addChat = e.target.closest(".add-sudo-chat");
      if (addChat) {
        const entry = addChat.closest(".sudo-entry");
        const clone = entry.cloneNode(true);
        clone.querySelector(".sudo-chat-id").value = "";
        clone.querySelector(".sudo-chat-name").value = "";
        const btn = clone.querySelector(".add-sudo-chat");
        btn.className = "btn sm text remove-sudo-chat";
        btn.innerHTML = '<span class="material-icons-round">close</span>';
        entry.after(clone);
        clone.querySelector(".sudo-chat-id").focus();
        return;
      }
      const rmChat = e.target.closest(".remove-sudo-chat");
      if (rmChat) {
        const section = rmChat.closest(".sudo-section");
        const entries = section.querySelectorAll(".sudo-entry");
        if (entries.length > 1) rmChat.closest(".sudo-entry").remove();
        return;
      }
    });

    // Save
    $("#sudo-save-btn").onclick = async () => {
      const users = [];
      container.querySelectorAll(".sudo-section:first-child .sudo-entry").forEach((row) => {
        const uid = parseInt(row.querySelector(".sudo-uid").value);
        const name = row.querySelector(".sudo-name").value.trim();
        if (uid) users.push({ uid, username: name });
      });
      const chats = [];
      const sections = container.querySelectorAll(".sudo-section");
      if (sections.length > 1) {
        sections[1].querySelectorAll(".sudo-entry").forEach((row) => {
          const id = parseInt(row.querySelector(".sudo-chat-id").value);
          const name = row.querySelector(".sudo-chat-name").value.trim();
          if (id) chats.push({ id, name });
        });
      }
      try {
        await put("/settings/" + encodeURIComponent(id), { users: JSON.stringify(users), chats: JSON.stringify(chats) });
        toast("✅ 已保存");
        loadSettingsDetail(id);
      } catch (e) { toast("❌ " + e.message); }
    };
  }

  function renderStatusEditor(values) {
    const tmpl = values.template || "";
    const tags = ["{cpu}", "{mem}", "{uptime}", "{telebox}", "{process}", "{node}", "{proxy}", "{platform}", "{os}", "{disk}", "{network}", "{plugins}", "{commands}", "{prefixes}", "{version}", "{session}", "{dc}", "{ping}"];
    let html = `<div class="field-group"><label>状态模板</label><textarea name="template" placeholder="输入模板文本">${escape(tmpl)}</textarea></div>`;
    html += `<div class="status-tags"><div class="status-tags-title">可用标签（点击复制）</div>`;
    tags.forEach((t) => { html += `<span class="status-tag" onclick="navigator.clipboard?.writeText('${t}'); toast('已复制 ${t}')">${escape(t)}</span>`; });
    html += `</div>`;
    html += `<div class="form-actions"><button class="btn filled" id="status-save-btn">保存</button></div>`;
    return html;
  }

  function wireStatusEditor(id) {
    $("#status-save-btn").onclick = async () => {
      const template = document.querySelector("#settings-form textarea[name='template']").value;
      try {
        await put("/settings/" + encodeURIComponent(id), { template });
        toast("✅ 已保存");
        loadSettingsDetail(id);
      } catch (e) { toast("❌ " + e.message); }
    };
  }

  async function loadAdminsTab() {
      try {
        const data = await get("/admins");
        const list = $("#admins-list");
        const items = data.admins || [];
        const rows = items.map((a) => `<div class="list-item">
          <div class="leading">👤</div>
          <div class="body">
            <div class="title">${escape(String(a.userId))}</div>
            <div class="desc">${a.note ? escape(a.note) : ""} · 添加于 ${new Date(a.addedAt).toLocaleString("zh-CN")}</div>
          </div>
          <div class="trailing">
            <button class="btn sm outlined" data-admin-del="${a.userId}">移除</button>
          </div>
        </div>`).join("");

        const ownerRow = `<div class="list-item" style="opacity:0.7">
          <div class="leading">👑</div>
          <div class="body">
            <div class="title">${escape(String(data.ownerId))}</div>
            <div class="desc">Owner · 始终允许</div>
          </div>
        </div>`;

        list.innerHTML = ownerRow + (items.length ? rows : '<div class="empty">暂无额外管理员</div>');

        $$("[data-admin-del]").forEach((btn) => {
          btn.onclick = async () => {
            const uid = btn.dataset.adminDel;
            modal("移除管理员", `确定移除 <b>${escape(uid)}</b>？`, [
              { label: "取消", primary: false },
              { label: "移除", primary: true, action: async () => {
                await del("/admins/" + encodeURIComponent(uid));
                toast("✅ 已移除");
                loadAdminsTab();
              }},
            ]);
          };
        });
      } catch (e) {
        $("#admins-list").innerHTML = `<div class="empty">❌ ${escape(e.message)}</div>`;
      }
    }

  // ============ Custom editor renderers for new field types ============

  function renderProviderListEditor(values, field) {
    const lines = (values[field.key] || "").split("\n").filter(l => l.trim());
    const columns = (field.providerColumns || "name|url|key|model|type").split("|");
    const headers = columns.map(c => c.charAt(0).toUpperCase() + c.slice(1).replace("_", " ")).join(" | ");
    
    let html = `<div class="provider-list-editor" data-field-key="${escape(field.key)}">`;
    html += `<div class="provider-list-header">${escape(headers)}</div>`;
    html += `<textarea class="provider-list-textarea" placeholder="每行一个供应商，用 | 分隔${field.description ? ` — ${escape(field.description)}` : ''}">${escape(values[field.key] || "")}</textarea>`;
    html += `<div class="provider-list-hint">列顺序: ${escape(field.providerColumns || "name|base_url|api_key|model|type")} | 留空 Key 保持原值</div>`;
    html += `</div>`;
    return html;
  }

  function wireProviderListEditor(form, field) {
    const textarea = form.querySelector(`.provider-list-textarea[data-field-key="${field.key}"]`);
    if (!textarea) return;
    // Real-time validation could be added here
  }

  function renderPromptMapEditor(values, field) {
    try {
      const obj = JSON.parse(values[field.key] || "{}");
      const entries = Object.entries(obj);
      let html = `<div class="prompt-map-editor" data-field-key="${escape(field.key)}">`;
      if (entries.length === 0) {
        html += `<div class="prompt-map-empty">暂无预设，添加一个</div>`;
      } else {
        entries.forEach(([k, v]) => {
          html += `<div class="prompt-map-entry"><input class="prompt-map-key" value="${escape(k)}" placeholder="${escape(field.promptKeyPlaceholder || "简写")}" /><span class="material-icons-round">arrow_forward</span><textarea class="prompt-map-value" placeholder="${escape(field.promptValuePlaceholder || "Prompt 文本")}">${escape(v)}</textarea><button class="btn sm text remove-prompt-map"><span class="material-icons-round">close</span></button></div>`;
        });
      }
      html += `<div class="prompt-map-entry"><input class="prompt-map-key" placeholder="${escape(field.promptKeyPlaceholder || "简写")}" /><span class="material-icons-round">arrow_forward</span><textarea class="prompt-map-value" placeholder="${escape(field.promptValuePlaceholder || "Prompt 文本")}"></textarea><button class="btn sm filled add-prompt-map">+</button></div>`;
      html += `</div>`;
      return html;
    } catch {
      return `<div class="prompt-map-editor" data-field-key="${escape(field.key)}"><textarea class="prompt-map-textarea" placeholder="JSON 格式: {\"简写\": \"prompt文本\"}">${escape(values[field.key] || "")}</textarea></div>`;
    }
  }

  function wirePromptMapEditor(form, field) {
    const container = form.querySelector(`.prompt-map-editor[data-field-key="${field.key}"]`);
    if (!container) return;
    container.addEventListener("click", (e) => {
      const addBtn = e.target.closest(".add-prompt-map");
      if (addBtn) {
        const entry = addBtn.closest(".prompt-map-entry");
        const newEntry = entry.cloneNode(true);
        newEntry.querySelector(".prompt-map-key").value = "";
        newEntry.querySelector(".prompt-map-value").value = "";
        const btn = newEntry.querySelector(".add-prompt-map");
        btn.className = "btn sm text remove-prompt-map";
        btn.innerHTML = '<span class="material-icons-round">close</span>';
        entry.after(newEntry);
        newEntry.querySelector(".prompt-map-key").focus();
        return;
      }
      const rmBtn = e.target.closest(".remove-prompt-map");
      if (rmBtn) {
        const entry = rmBtn.closest(".prompt-map-entry");
        if (container.querySelectorAll(".prompt-map-entry").length > 1) entry.remove();
        return;
      }
    });
  }

  function renderTagListEditor(values, field) {
    const tags = (values[field.key] || "").split(/\s+/).filter(Boolean);
    let html = `<div class="tag-list-editor" data-field-key="${escape(field.key)}">`;
    html += `<div class="tag-list-tags">`;
    tags.forEach(t => {
      html += `<span class="tag-item"><span>${escape(t)}</span><span class="material-icons-round remove-tag">close</span></span>`;
    });
    html += `</div>`;
    html += `<div class="tag-list-input-row"><input type="text" class="tag-list-input" placeholder="${escape(field.tagPlaceholder || "添加标签")}" maxlength="20" /><button class="btn sm filled add-tag">添加</button></div>`;
    html += `</div>`;
    return html;
  }

  function wireTagListEditor(form, field) {
    const container = form.querySelector(`.tag-list-editor[data-field-key="${field.key}"]`);
    if (!container) return;
    const input = container.querySelector(".tag-list-input");
    const tagContainer = container.querySelector(".tag-list-tags");
    
    container.addEventListener("click", (e) => {
      const rm = e.target.closest(".remove-tag");
      if (rm) {
        rm.closest(".tag-item").remove();
        return;
      }
      const add = e.target.closest(".add-tag");
      if (add) {
        const val = input.value.trim();
        if (!val) return;
        const existing = [...tagContainer.querySelectorAll(".tag-item span:first-child")].map(s => s.textContent);
        if (!field.tagAllowDuplicates && existing.includes(val)) { toast("已存在"); return; }
        const tag = document.createElement("span");
        tag.className = "tag-item";
        tag.innerHTML = `<span>${escape(val)}</span><span class="material-icons-round remove-tag">close</span>`;
        tagContainer.appendChild(tag);
        input.value = "";
        input.focus();
      }
    });
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); container.querySelector(".add-tag")?.click(); } };
  }

  /* ===== Generic custom field renderer ===== */
  
  function renderCustomField(field, values) {
    const val = values[field.key];
    let hint = field.description ? `<div class="hint">${escape(field.description)}</div>` : "";
    
    if (field.type === "provider-list") {
      return `<div class="field-group"><label>${escape(field.label)}</label>${renderProviderListEditor(values, field)}${hint}</div>`;
    }
    if (field.type === "prompt-map") {
      return `<div class="field-group"><label>${escape(field.label)}</label>${renderPromptMapEditor(values, field)}${hint}</div>`;
    }
    if (field.type === "tag-list") {
      return `<div class="field-group"><label>${escape(field.label)}</label>${renderTagListEditor(values, field)}${hint}</div>`;
    }
    // Fallback to generic
    let input = "";
    if (field.type === "boolean") {
      input = `<div class="switch"><span>${escape(field.label)}</span><input type="checkbox" name="${escape(field.key)}" ${val ? "checked" : ""} /></div>`;
    } else if (field.type === "select" && field.options?.length) {
      const opts = field.options.map((o) => `<option value="${escape(o.value)}"${String(val) === o.value ? " selected" : ""}>${escape(o.label)}</option>`).join("");
      input = `<select name="${escape(field.key)}">${opts}</select>`;
    } else if (field.type === "textarea") {
      input = `<textarea name="${escape(field.key)}" placeholder="${escape(field.placeholder || "")}">${val != null ? escape(String(val)) : ""}</textarea>`;
    } else {
      input = `<input type="${field.secret ? "password" : "text"}" name="${escape(field.key)}" value="${val != null ? escape(String(val)) : ""}" placeholder="${escape(field.placeholder || "")}" />`;
    }
    return `<div class="field-group"><label>${escape(field.label)}</label>${input}${hint}</div>`;
  }
  
  function wireCustomFields(id, schema, form) {
    schema.forEach((f) => {
      if (f.type === "provider-list") wireProviderListEditor(form, f);
      else if (f.type === "prompt-map") wirePromptMapEditor(form, f);
      else if (f.type === "tag-list") wireTagListEditor(form, f);
    });
    
    $("#settings-save").onclick = async () => {
      const patch = {};
      schema.forEach((f) => {
        const el = form.elements[f.key];
        if (!el) return;
        if (f.type === "provider-list") {
          const textarea = form.querySelector(`.provider-list-textarea[data-field-key="${f.key}"]`);
          if (textarea) patch[f.key] = textarea.value;
        } else if (f.type === "prompt-map") {
          const container = form.querySelector(`.prompt-map-editor[data-field-key="${f.key}"]`);
          if (container) {
            const obj = {};
            container.querySelectorAll(".prompt-map-entry").forEach((entry) => {
              const key = entry.querySelector(".prompt-map-key").value.trim();
              const val = entry.querySelector(".prompt-map-value").value.trim();
              if (key && val) obj[key] = val;
            });
            patch[f.key] = JSON.stringify(obj);
          }
        } else if (f.type === "tag-list") {
          const container = form.querySelector(`.tag-list-editor[data-field-key="${f.key}"]`);
          if (container) {
            const tags = [...container.querySelectorAll(".tag-item span:first-child")].map(s => s.textContent);
            patch[f.key] = tags.join(" ");
          }
        } else if (f.type === "boolean") {
          patch[f.key] = el.checked;
        } else if (f.type === "number") {
          patch[f.key] = Number(el.value);
        } else {
          patch[f.key] = el.value;
        }
      });
      try {
        await put("/settings/" + encodeURIComponent(id), patch);
        toast("✅ 已保存");
        loadSettingsDetail(id);
      } catch (e) { toast("❌ " + e.message); }
    };
  }

  /* ===== Wiring ===== */
  async function initApp() {
    view("view-main");
    page("home");
    navigate("home");

    // Nav
    $$(".nav-item").forEach((n) => {
      n.onclick = () => navigate(n.dataset.go);
    });

    // Chips
    $$("[data-go]").forEach((el) => {
      el.onclick = () => navigate(el.dataset.go);
    });

    // TPM tabs
    $("#tpm-tab-remote").onclick = () => loadTpm("remote");
    $("#tpm-tab-installed").onclick = () => loadTpm("installed");
    $("#tpm-search-btn").onclick = () => loadTpm("remote");
    $("#tpm-q").onkeydown = (e) => { if (e.key === "Enter") loadTpm("remote"); };

    // TPM update all — SSE streaming
    $("#tpm-update-all").onclick = startTpmUpdateStream;

    // TPM source
    $("#tpm-source-btn").onclick = async () => {
      try {
        const data = await get("/tpm/source");
        const custom = data.custom || "无";
        modal("插件源", `官方: ${escape(data.official)}\n\n自定义: ${escape(custom)}`, [
          { label: "关闭", primary: false },
          { label: "设置自定义源", primary: true, action: () => { navigate("settings"); loadSettingsDetail("tpm"); } },
        ]);
      } catch (e) { toast("❌ " + e.message); }
    };

    // Plugins search
    $("#plugins-search-btn").onclick = () => {
      const q = $("#plugins-q").value;
      renderPluginsList(q);
    };
    $("#plugins-q").onkeydown = (e) => {
      if (e.key === "Enter") {
        const q = $("#plugins-q").value;
        renderPluginsList(q);
      }
    };

    // Refresh
    $("#btn-refresh").onclick = () => {
      const active = $(".nav-item.active");
      if (active) navigate(active.dataset.go);
    };

    // Retry auth
    $("#btn-retry").onclick = doAuth;

    // Admins page (embedded in settings)
    $("#admin-add").onclick = async () => {
      const uid = $("#admin-uid").value.trim();
      const note = $("#admin-note").value.trim();
      if (!uid) { toast("请输入 userId"); return; }
      try {
        await post("/admins", { userId: Number(uid), note });
        toast("✅ 已添加");
        $("#admin-uid").value = "";
        $("#admin-note").value = "";
        loadAdminsTab();
      } catch (e) { toast("❌ " + e.message); }
    };
  }

  /* ===== Boot ===== */
  async function boot() {
    view("view-boot");
    if (await tryStoredToken()) return;
    doAuth();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();