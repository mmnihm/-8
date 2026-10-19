import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "./data";
const DATA_FILE = path.join(DATA_DIR, "data.json");
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : "";

const DEFAULT_LINKS = {
  main: process.env.MAIN_CHANNEL_URL || "",
  backup: process.env.BACKUP_CHANNEL_URL || "",
  contact: process.env.CONTACT_URL || "",
  status: process.env.STATUS_URL || ""
};

let data = { links: { ...DEFAULT_LINKS }, users: [], offset: 0, startedAt: Date.now() };
let polling = false;
let saveQueue = Promise.resolve();
const pendingLinkSetup = new Map();
const pendingBroadcast = new Set();

function isAdmin(id) {
  return ADMIN_IDS.has(String(id));
}
function safeText(value, max = 3500) {
  return String(value ?? "").slice(0, max);
}
function validUrl(value) {
  try {
    const u = new URL(value);
    return ["https:", "http:", "tg:"].includes(u.protocol);
  } catch {
    return false;
  }
}
async function loadData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    data = {
      links: { ...DEFAULT_LINKS, ...(parsed.links || {}) },
      users: Array.isArray(parsed.users) ? parsed.users : [],
      offset: Number(parsed.offset || 0),
      startedAt: Number(parsed.startedAt || Date.now())
    };
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Data file could not be read:", e.message);
    await saveData();
  }
}
function saveData() {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, DATA_FILE);
  }).catch(e => console.error("Save failed:", e.message));
  return saveQueue;
}
async function telegram(method, payload = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    const error = new Error(result.description || `Telegram API HTTP ${response.status}`);
    error.code = result.error_code || response.status;
    error.retryAfter = result.parameters?.retry_after || 0;
    throw error;
  }
  return result.result;
}
function keyboard() {
  const rows = [];
  const add = (label, key) => {
    if (data.links[key] && validUrl(data.links[key])) rows.push([{ text: label, url: data.links[key] }]);
  };
  add("📢 官方频道", "main");
  add("🛟 备用频道", "backup");
  add("👩‍💻 联系客服", "contact");
  rows.push([{ text: "📡 服务器状态", callback_data: "serverstatus" }]);
  return { inline_keyboard: rows };
}
function adminKeyboard() {
  return {
    keyboard: [
      [{ text: "📢 设置官方频道" }, { text: "🛟 设置备用频道" }],
      [{ text: "👩‍💻 设置客服联系" }, { text: "📡 查看服务器状态" }],
      [{ text: "📣 发送广播公告" }, { text: "👁️ 预览用户菜单" }],
      [{ text: "▶️ 开始" }, { text: "❌ 取消当前设置" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    is_persistent: true
  };
}
async function serverStatusText() {
  const uptime = Math.floor(process.uptime());
  const fmtDuration = seconds => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${d} 天 ${h} 小时 ${m} 分钟`;
  };
  const total = os.totalmem();
  const free = os.freemem();
  const usedPct = total ? ((total - free) / total * 100).toFixed(1) : "未知";
  const load = os.loadavg();
  let diskLine = "数据盘空间：当前运行环境不支持读取";
  try {
    const stat = await fs.statfs(DATA_DIR);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const gb = n => (n / (1024 ** 3)).toFixed(2);
    const diskPct = totalBytes ? (usedBytes / totalBytes * 100).toFixed(1) : "未知";
    diskLine = `数据目录所在磁盘：已用 ${gb(usedBytes)} GB / ${gb(totalBytes)} GB（${diskPct}%），剩余 ${gb(freeBytes)} GB`;
  } catch {}
  const gb = n => (n / (1024 ** 3)).toFixed(2);
  return [
    "📡 服务器运行状态",
    "",
    "🟢 机器人进程：运行中",
    `⏱️ 机器人运行时间：${fmtDuration(uptime)}`,
    `🧠 系统内存：已用 ${gb(total - free)} GB / ${gb(total)} GB（${usedPct}%）`,
    `⚙️ CPU 负载（1/5/15 分钟）：${load.map(n => n.toFixed(2)).join(" / ")}（核心数 ${os.cpus().length}）`,
    diskLine,
    "",
    `🕒 更新时间：${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`,
    "",
    "说明：容器部署时，显示的是当前运行环境可读取的指标；磁盘为数据目录所在文件系统。"
  ].join("\n");
}
function linkLabel(key) {
  return ({ main: "官方频道", backup: "备用频道", contact: "客服联系", status: "服务状态" })[key] || key;
}
async function handleCallback(update) {
  const query = update.callback_query;
  if (!query) return false;
  const userId = String(query.from?.id || "");
  const chatId = query.message?.chat?.id;
  if (!isAdmin(userId)) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "仅管理员可使用此设置菜单。", show_alert: true });
    return true;
  }
  const action = String(query.data || "");
  if (action === "serverstatus") {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "正在读取服务器状态…" });
    if (chatId) await sendMessage(chatId, await serverStatusText(), { reply_markup: keyboard() });
    return true;
  }
  if (!isAdmin(userId)) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "仅管理员可使用此设置菜单。", show_alert: true });
    return true;
  }
  await telegram("answerCallbackQuery", { callback_query_id: query.id });
  if (!chatId) return true;
  if (action.startsWith("setlink:")) {
    const key = action.slice("setlink:".length);
    if (!["main", "backup", "contact", "status"].includes(key)) return true;
    pendingLinkSetup.set(userId, key);
    await sendMessage(chatId, `请发送「${linkLabel(key)}」的新链接。\n支持 https://、http:// 或 tg:// 链接。\n发送 /cancel 可取消本次设置。\n\n当前链接：${data.links[key] || "尚未设置"}`);
    return true;
  }
  if (action === "broadcast") {
    pendingBroadcast.add(userId);
    await sendMessage(chatId, "📣 请直接发送要广播的公告内容，可以分多行。\n发送 /cancel 取消。\n\n公告会发送给已启动过机器人的用户。");
    return true;
  }
  if (action === "cancelsetup") {
    pendingLinkSetup.delete(userId);
    pendingBroadcast.delete(userId);
    await sendMessage(chatId, "已取消当前设置。", { reply_markup: adminKeyboard() });
    return true;
  }
  if (action === "preview") {
    await sendMessage(chatId, "这是用户菜单预览：", { reply_markup: keyboard() });
    await sendMessage(chatId, "管理员设置菜单：", { reply_markup: adminKeyboard() });
    return true;
  }
  return true;
}
async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: safeText(text),
    disable_web_page_preview: true,
    ...extra
  });
}
function helpText() {
  return [
    "🛟 防失联服务中心",
    "",
    "如果原频道或机器人无法访问，请使用下方备用入口，或联系管理员。",
    "建议先加入备用频道，以便在入口变更时收到公告。",
    "",
    "需要帮助可点击「联系客服」。"
  ].join("\n");
}
function adminHelp() {
  return [
    "管理员设置：发送 /admin 打开按钮式管理菜单，点击对应入口后直接发送链接。",
    "",
    "管理员命令：",
    "/admin — 打开按钮式设置菜单",
    "/links — 查看当前入口",
    "/setlink main https://... — 设置官方频道",
    "/setlink backup https://... — 设置备用频道",
    "/setlink contact https://... — 设置客服入口",
    "/setlink status https://... — 设置状态页",
    "/setlink main off — 清除某个入口",
    "/announce 公告内容 — 通知已启动机器人的用户",
    "/stats — 查看用户数和运行时间",
    "/help — 查看命令"
  ].join("\n");
}
async function broadcastAnnouncement(chatId, announcement) {
  const recipients = [...data.users];
  let sent = 0, failed = 0, blocked = 0;
  await sendMessage(chatId, `📣 开始发送，目标 ${recipients.length} 位用户。发送期间请勿关闭机器人。`);
  for (const recipient of recipients) {
    try {
      await sendMessage(recipient, `📣 防失联公告\n\n${announcement}`, { reply_markup: keyboard() });
      sent++;
    } catch (e) {
      failed++;
      if ([403, 400].includes(Number(e.code))) {
        blocked++;
        data.users = data.users.filter(id => id !== recipient);
      }
      if (e.retryAfter) await new Promise(resolve => setTimeout(resolve, (e.retryAfter + 1) * 1000));
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  await saveData();
  await sendMessage(chatId, `✅ 广播任务结束\n成功：${sent}\n失败：${failed}\n已清理不可达用户：${blocked}`);
}
async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update);
    return;
  }
  const msg = update.message;
  if (!msg?.chat || !msg?.from || typeof msg.text !== "string") return;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  if (msg.chat.type === "private" && !data.users.includes(userId)) {
    data.users.push(userId);
    await saveData();
  }
  const text = msg.text.trim();

  if (isAdmin(userId) && text === "▶️ 开始") {
    pendingLinkSetup.delete(userId);
    pendingBroadcast.delete(userId);
    await sendMessage(chatId, helpText(), { reply_markup: adminKeyboard() });
    return;
  }

  // 固定底部管理员键盘：先识别按钮，再处理正在等待的链接或公告。
  const adminActions = {
    "📢 设置官方频道": "main",
    "🛟 设置备用频道": "backup",
    "👩‍💻 设置客服联系": "contact"
  };
  if (isAdmin(userId) && Object.prototype.hasOwnProperty.call(adminActions, text)) {
    pendingBroadcast.delete(userId);
    const key = adminActions[text];
    pendingLinkSetup.set(userId, key);
    await sendMessage(chatId, `请发送「${linkLabel(key)}」的新链接。\n支持 https://、http:// 或 tg:// 链接。\n发送 /cancel 或点击「❌ 取消当前设置」可取消。\n\n当前链接：${data.links[key] || "尚未设置"}`, { reply_markup: adminKeyboard() });
    return;
  }
  if (isAdmin(userId) && text === "📡 查看服务器状态") {
    pendingLinkSetup.delete(userId);
    pendingBroadcast.delete(userId);
    await sendMessage(chatId, await serverStatusText(), { reply_markup: adminKeyboard() });
    return;
  }
  if (isAdmin(userId) && text === "📣 发送广播公告") {
    pendingLinkSetup.delete(userId);
    pendingBroadcast.add(userId);
    await sendMessage(chatId, "📣 请直接发送要广播的公告内容，可以分多行。\n发送 /cancel 或点击「❌ 取消当前设置」可取消。\n\n公告会发送给已启动过机器人的用户。", { reply_markup: adminKeyboard() });
    return;
  }
  if (isAdmin(userId) && text === "👁️ 预览用户菜单") {
    pendingLinkSetup.delete(userId);
    pendingBroadcast.delete(userId);
    await sendMessage(chatId, "这是用户入口菜单预览：", { reply_markup: keyboard() });
    await sendMessage(chatId, "管理员操作按钮已固定在聊天底部。", { reply_markup: adminKeyboard() });
    return;
  }
  if (isAdmin(userId) && text === "❌ 取消当前设置") {
    pendingLinkSetup.delete(userId);
    pendingBroadcast.delete(userId);
    await sendMessage(chatId, "已取消当前操作。管理员按钮仍固定在聊天底部。", { reply_markup: adminKeyboard() });
    return;
  }

  if (pendingBroadcast.has(userId)) {
    if (text.toLowerCase() === "/cancel") {
      pendingBroadcast.delete(userId);
      await sendMessage(chatId, "已取消广播。", { reply_markup: adminKeyboard() });
      return;
    }
    if (!isAdmin(userId)) {
      pendingBroadcast.delete(userId);
      return;
    }
    pendingBroadcast.delete(userId);
    await broadcastAnnouncement(chatId, text);
    await sendMessage(chatId, "还可以继续管理入口或发送公告：", { reply_markup: adminKeyboard() });
    return;
  }
  if (pendingLinkSetup.has(userId)) {
    const key = pendingLinkSetup.get(userId);
    if (text.toLowerCase() === "/cancel") {
      pendingLinkSetup.delete(userId);
      await sendMessage(chatId, "已取消设置。", { reply_markup: adminKeyboard() });
      return;
    }
    if (text.startsWith("/")) {
      pendingLinkSetup.delete(userId);
    } else {
      if (!validUrl(text)) {
        await sendMessage(chatId, "❌ 链接格式不正确，请发送完整链接（https://、http:// 或 tg://），或发送 /cancel 取消。");
        return;
      }
      data.links[key] = text;
      pendingLinkSetup.delete(userId);
      await saveData();
      await sendMessage(chatId, `✅ 已保存「${linkLabel(key)}」链接。\n用户菜单已更新，重启后仍会保留。\n\n还可以继续设置其他入口：`, { reply_markup: adminKeyboard() });
      return;
    }
  }
  const [command = "", ...rest] = text.split(/\s+/);
  const cmd = command.split("@")[0].toLowerCase();

  if (cmd === "/start" || cmd === "/links") {
    await sendMessage(chatId, helpText(), { reply_markup: isAdmin(userId) && cmd === "/start" ? adminKeyboard() : keyboard() });
    return;
  }
  if (cmd === "/admin") {
    if (!isAdmin(userId)) {
      await sendMessage(chatId, "此设置菜单仅供管理员使用。");
      return;
    }
    await sendMessage(chatId, "⚙️ 防失联机器人管理菜单\n请使用聊天底部固定键盘操作；点击设置按钮后直接发送链接。", { reply_markup: adminKeyboard() });
    return;
  }
  if (cmd === "/help") {
    await sendMessage(chatId, isAdmin(userId) ? adminHelp() : helpText(), {
      reply_markup: isAdmin(userId) ? undefined : keyboard()
    });
    return;
  }
  if (!isAdmin(userId)) {
    if (cmd.startsWith("/")) await sendMessage(chatId, "此命令仅供管理员使用。", { reply_markup: keyboard() });
    return;
  }
  if (cmd === "/setlink") {
    const key = (rest[0] || "").toLowerCase();
    const value = rest.slice(1).join(" ").trim();
    if (!["main", "backup", "contact", "status"].includes(key) || !value) {
      await sendMessage(chatId, "用法：/setlink main|backup|contact|status https://...\n清除入口：/setlink backup off");
      return;
    }
    if (value.toLowerCase() === "off") data.links[key] = "";
    else if (validUrl(value)) data.links[key] = value;
    else {
      await sendMessage(chatId, "链接格式无效，请使用完整的 https://、http:// 或 tg:// 链接。");
      return;
    }
    await saveData();
    await sendMessage(chatId, `✅ 已更新 ${key} 入口。\n用户下次打开菜单即可看到最新链接。`, { reply_markup: keyboard() });
    return;
  }
  if (cmd === "/stats") {
    const uptime = Math.floor((Date.now() - data.startedAt) / 1000);
    await sendMessage(chatId, `📊 运行状态\n已登记用户：${data.users.length}\n运行时间：${Math.floor(uptime / 3600)} 小时 ${Math.floor((uptime % 3600) / 60)} 分钟\n入口：${Object.values(data.links).filter(Boolean).length} 个`);
    return;
  }
  if (cmd === "/announce") {
    const announcement = rest.join(" ").trim();
    if (!announcement) {
      pendingBroadcast.add(userId);
      await sendMessage(chatId, "📣 请直接发送要广播的公告内容，可以分多行。发送 /cancel 取消。");
      return;
    }
    await broadcastAnnouncement(chatId, announcement);
    return;
  }
  await sendMessage(chatId, adminHelp());
}
async function poll() {
  if (polling) return;
  polling = true;
  let delay = 1000;
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: data.offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"]
      });
      delay = 1000;
      for (const update of updates) {
        data.offset = update.update_id + 1;
        await saveData();
        try {
          await handleUpdate(update);
        } catch (e) {
          console.error("Update handling failed:", e.message);
        }
      }
    } catch (e) {
      console.error("Telegram polling failed:", e.message);
      if (e.retryAfter) delay = (e.retryAfter + 1) * 1000;
      else delay = Math.min(delay * 2, 30000);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "telegram-anti-loss-bot", uptimeSeconds: Math.floor(process.uptime()) }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`Health endpoint listening on port ${PORT}`);
  if (!TOKEN) {
    console.error("BOT_TOKEN is missing. Add it in the hosting environment variables.");
    return;
  }
  if (!ADMIN_IDS.size) console.warn("ADMIN_IDS is empty; admin commands are disabled until configured.");
  await loadData();
  try {
    const me = await telegram("getMe");
    console.log(`Bot connected: @${me.username}`);
  } catch (e) {
    console.error("Telegram token check failed:", e.message);
    process.exitCode = 1;
    return;
  }
  poll().catch(e => console.error("Polling stopped:", e.message));
});
process.on("unhandledRejection", e => console.error("Unhandled rejection:", e?.message || e));
