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

let data = { links: { ...DEFAULT_LINKS }, customButtons: [], users: [], supportMap: [], stats: {}, offset: 0, startedAt: Date.now() };
function todayKey() { return new Date().toISOString().slice(0, 10); }
function ensureStats() {
  if (!data.stats || typeof data.stats !== "object") data.stats = {};
  const defaults = { day: todayKey(), todayNewUsers: 0, supportReceived: 0, supportForwarded: 0, supportForwardFailed: 0, adminRepliesSent: 0, adminRepliesFailed: 0, broadcasts: 0, broadcastSent: 0, broadcastFailed: 0 };
  for (const [key, value] of Object.entries(defaults)) if (!Number.isFinite(Number(data.stats[key]))) data.stats[key] = value;
  if (data.stats.day !== todayKey()) { data.stats.day = todayKey(); data.stats.todayNewUsers = 0; }
  return data.stats;
}
async function registerUser(userId) {
  if (data.users.includes(String(userId))) return false;
  data.users.push(String(userId));
  ensureStats().todayNewUsers++;
  await saveData();
  return true;
}
let polling = false;
let saveQueue = Promise.resolve();
const pendingLinkSetup = new Map();
const pendingBroadcast = new Set();
const pendingButtonSetup = new Map();

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
      customButtons: Array.isArray(parsed.customButtons) ? parsed.customButtons.filter(b => b && /^[a-zA-Z0-9_-]{1,16}$/.test(String(b.id)) && typeof b.label === "string" && typeof b.url === "string") : [],
      users: Array.isArray(parsed.users) ? [...new Set(parsed.users.map(value => String(value)).filter(id => /^\\d+$/.test(id)))] : [],
      supportMap: Array.isArray(parsed.supportMap) ? parsed.supportMap.filter(x => x && Number.isFinite(Number(x.adminChatId)) && Number.isFinite(Number(x.adminMessageId)) && Number.isFinite(Number(x.userChatId))) : [],
      stats: parsed.stats && typeof parsed.stats === "object" ? parsed.stats : {},
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
  let linkRow = [];
  const add = (label, url) => {
    if (!url || !validUrl(url)) return;
    linkRow.push({ text: label, url });
    if (linkRow.length === 2) {
      rows.push(linkRow);
      linkRow = [];
    }
  };
  add("📢 官方频道", data.links.main);
  add("🛟 备用频道", data.links.backup);
  add("👩‍💻 联系客服", data.links.contact);
  add("🔗 外部状态页", data.links.status);
  for (const button of (data.customButtons || [])) add(button.label, button.url);
  if (linkRow.length) rows.push(linkRow);
  return { inline_keyboard: rows };
}
function adminKeyboard() {
  return {
    keyboard: [
      [{ text: "⚙️ 设置" }, { text: "📊 数据统计" }, { text: "📣 广播" }, { text: "👩‍💻 客服" }]
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
  const action = String(query.data || "");

  if (!isAdmin(userId)) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "仅管理员可使用此设置菜单。", show_alert: true });
    return true;
  }
  await telegram("answerCallbackQuery", { callback_query_id: query.id });
  if (!chatId) return true;

  if (action === "buttons:manage") { await showButtonManager(chatId); return true; }
  if (action === "buttons:add") {
    pendingButtonSetup.set(userId, { phase: "label" });
    pendingLinkSetup.delete(userId); pendingBroadcast.delete(userId);
    await sendMessage(chatId, "请发送新按钮的名称（最多 32 个字符）。\n下一步再发送对应的网址。\n发送 /cancel 可取消。", { reply_markup: adminKeyboard() });
    return true;
  }
  if (action.startsWith("buttons:edit:")) {
    const id = action.slice("buttons:edit:".length);
    const button = (data.customButtons || []).find(b => b.id === id);
    if (!button) { await sendMessage(chatId, "找不到这个按钮，它可能已被删除。"); return true; }
    pendingButtonSetup.set(userId, { phase: "editLabel", id });
    pendingLinkSetup.delete(userId); pendingBroadcast.delete(userId);
    await sendMessage(chatId, `请发送按钮「${button.label}」的新名称。\n发送 /cancel 可取消。`, { reply_markup: adminKeyboard() });
    return true;
  }
  if (action.startsWith("buttons:delete:")) {
    const id = action.slice("buttons:delete:".length);
    const button = (data.customButtons || []).find(b => b.id === id);
    if (!button) { await sendMessage(chatId, "这个按钮已经不存在。"); return true; }
    data.customButtons = data.customButtons.filter(b => b.id !== id);
    await saveData();
    await sendMessage(chatId, `✅ 已删除按钮「${button.label}」。`, { reply_markup: adminKeyboard() });
    await showButtonManager(chatId);
    return true;
  }
  if (action === "settings:links") {
    pendingLinkSetup.delete(userId); pendingBroadcast.delete(userId); pendingButtonSetup.delete(userId);
    await sendMessage(chatId, "🔗 入口链接设置\\n请选择要修改的入口：", { reply_markup: { inline_keyboard: [
      [{ text: "📢 官方频道", callback_data: "setlink:main" }, { text: "🛟 备用频道", callback_data: "setlink:backup" }],
      [{ text: "👩‍💻 联系客服", callback_data: "setlink:contact" }, { text: "🔗 外部状态页", callback_data: "setlink:status" }]
    ] } });
    return true;
  }
  if (action.startsWith("setlink:")) {
    const key = action.slice("setlink:".length);
    if (!["main", "backup", "contact", "status"].includes(key)) return true;
    pendingBroadcast.delete(userId); pendingButtonSetup.delete(userId);
    pendingLinkSetup.set(userId, key);
    await sendMessage(chatId, `请发送「${linkLabel(key)}」的新链接。\n支持 https://、http:// 或 tg:// 链接。\n发送 /cancel 可取消本次设置。\n\n当前链接：${data.links[key] || "undefined"}`);
    return true;
  }
  if (action === "broadcast") {
    pendingLinkSetup.delete(userId); pendingButtonSetup.delete(userId);
    pendingBroadcast.add(userId);
    await sendMessage(chatId, "📣 请发送要广播的内容（文字、图片、视频、文件等均可）。机器人会先让你确认，不会立即群发。\\n发送 /cancel 取消。", { reply_markup: adminKeyboard() });
    return true;
  }
  if (action.startsWith("broadcast:confirm:")) {
    const parts = action.split(":");
    const sourceMessageId = Number(parts[2]);
    const intendedAdminId = String(parts[3] || "");
    if (intendedAdminId !== userId || !Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) {
      await sendMessage(chatId, "❌ 这条广播确认无效，请重新发起广播。");
      return true;
    }
    if (broadcastRunning) {
      await sendMessage(chatId, "⚠️ 当前已有广播任务正在运行，请等它完成后再试。");
      return true;
    }
    // Start in the background so polling, support replies, and settings stay responsive.
    broadcastAnnouncement(chatId, sourceMessageId).catch(e => {
      console.error("Broadcast task escaped error handling:", e.message);
    });
    return true;
  }
  if (action === "broadcast:cancel") {
    await sendMessage(chatId, "已取消本次广播，没有发送给用户。", { reply_markup: adminKeyboard() });
    return true;
  }
  if (action === "cancelsetup") {
    pendingLinkSetup.delete(userId); pendingBroadcast.delete(userId); pendingButtonSetup.delete(userId);
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

async function showButtonManager(chatId) {
  const rows = [[{ text: "➕ 添加按钮", callback_data: "buttons:add" }]];
  for (const button of (data.customButtons || [])) rows.push([
    { text: `✏️ ${button.label}`.slice(0, 60), callback_data: `buttons:edit:${button.id}` },
    { text: "🗑 删除", callback_data: `buttons:delete:${button.id}` }
  ]);
  await sendMessage(chatId,
    "🔘 自定义按钮管理\n\n添加：设置按钮名称和网址。\n修改：可以修改名称及网址。\n删除：立即从用户菜单移除。\n\n自定义按钮会显示在用户入口菜单中，重启后仍会保留。",
    { reply_markup: { inline_keyboard: rows } });
}

function sendMessage(chatId, text, extra = {}) {
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
let broadcastRunning = false;
async function broadcastAnnouncement(adminChatId, sourceMessageId) {
  if (broadcastRunning) {
    await sendMessage(adminChatId, "⚠️ 当前已有广播任务正在运行，请等它完成后再发起下一次广播。");
    return;
  }
  broadcastRunning = true;
  const stats = ensureStats();
  stats.broadcasts++;
  const recipients = [...new Set(data.users.map(String))];
  let sent = 0, failed = 0, blocked = 0;
  try {
    await sendMessage(adminChatId, `📣 已在后台开始广播，目标 ${recipients.length} 位用户。完成后会单独通知你统计结果。`);
    for (let index = 0; index < recipients.length; index++) {
      const recipient = recipients[index];
      let delivered = false;
      for (let attempt = 0; attempt < 2 && !delivered; attempt++) {
        try {
          const copyPayload = {
            chat_id: Number(recipient),
            from_chat_id: Number(adminChatId),
            message_id: Number(sourceMessageId)
          };
          const userMenu = keyboard();
          if (userMenu.inline_keyboard.length) copyPayload.reply_markup = userMenu;
          await telegram("copyMessage", copyPayload);
          sent++;
          stats.broadcastSent++;
          delivered = true;
        } catch (e) {
          if (e.retryAfter && attempt === 0) {
            await new Promise(resolve => setTimeout(resolve, (Number(e.retryAfter) + 1) * 1000));
            continue;
          }
          // Retry one transient network/server failure, but don't loop on permanent errors.
          if (attempt === 0 && (!e.code || Number(e.code) >= 500)) {
            await new Promise(resolve => setTimeout(resolve, 1200));
            continue;
          }
          failed++;
          stats.broadcastFailed++;
          if (Number(e.code) === 403) {
            blocked++;
            data.users = data.users.filter(id => String(id) !== recipient);
          }
          console.error("Broadcast delivery failed for user", recipient, ":", e.message);
        }
      }
      if ((index + 1) % 25 === 0) await saveData();
      // Stay below Telegram's global send rate.
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    await saveData();
    await sendMessage(adminChatId, `📣 广播任务结束\n目标：${recipients.length}\n成功：${sent}\n失败：${failed}\n已清理明确封锁机器人的用户：${blocked}`);
  } catch (e) {
    console.error("Broadcast task failed:", e.message);
    stats.broadcastFailed++;
    await saveData();
    try { await sendMessage(adminChatId, "❌ 广播任务异常：" + safeText(e.message, 250) + "\n已完成部分可能已送达，请查看统计后再决定是否重发。"); } catch {}
  } finally {
    broadcastRunning = false;
  }
}

async function forwardSupportMessage(msg, userId) {
  const userChatId = msg.chat.id;
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || "未设置";
  const username = msg.from.username ? "@" + msg.from.username : "无";
  const stats = ensureStats();
  stats.supportReceived++;
  let delivered = 0;
  for (const adminId of ADMIN_IDS) {
    try {
      const header = await sendMessage(adminId,
        "📩 用户客服消息\n" +
        "姓名：" + name + "\n" +
        "用户名：" + username + "\n" +
        "用户 ID：" + userId + "\n\n" +
        "请直接回复下面转发的用户消息，机器人会自动转回给用户。"
      );
      const forwarded = await telegram("forwardMessage", {
        chat_id: adminId,
        from_chat_id: userChatId,
        message_id: msg.message_id
      });
      data.supportMap.push(
        { adminChatId: String(adminId), adminMessageId: String(header.message_id), userChatId: String(userChatId) },
        { adminChatId: String(adminId), adminMessageId: String(forwarded.message_id), userChatId: String(userChatId) }
      );
      delivered++;
      stats.supportForwarded++;
    } catch (e) {
      stats.supportForwardFailed++;
      console.error("Support forwarding failed:", e.message);
    }
  }
  data.supportMap = data.supportMap.slice(-3000);
  await saveData();
  if (delivered) {
    await sendMessage(userChatId, "✅ 已将你的消息转给客服，请直接在这里继续发送消息，客服回复后会通过机器人发给你。");
  } else {
    await sendMessage(userChatId, "暂时无法联系到客服，请稍后再试。");
  }
}
async function handleAdminSupportReply(msg, userId) {
  if (!isAdmin(userId) || !msg.reply_to_message) return false;
  const target = data.supportMap.find(x =>
    String(x.adminChatId) === String(msg.chat.id) &&
    String(x.adminMessageId) === String(msg.reply_to_message.message_id)
  );
  if (!target) return false;

  // 只有 Telegram 确认 copyMessage 成功后，才发送成功回执。
  try {
    const delivered = await telegram("copyMessage", {
      chat_id: Number(target.userChatId),
      from_chat_id: msg.chat.id,
      message_id: msg.message_id
    });
    if (delivered?.message_id) {
      ensureStats().adminRepliesSent++;
      await saveData();
      await sendMessage(msg.chat.id, "✅ 回复成功：消息已发送给用户。");
    } else {
      ensureStats().adminRepliesFailed++;
      await saveData();
      await sendMessage(msg.chat.id, "❌ 回复结果未确认：Telegram 未返回成功消息编号，请检查用户对话。");
    }
  } catch (e) {
    ensureStats().adminRepliesFailed++;
    await saveData();
    try {
      await sendMessage(msg.chat.id, "❌ 回复失败：消息未能确认送达用户。原因：" + safeText(e.message, 250));
    } catch (notifyError) {
      console.error("Could not notify admin about support reply failure:", notifyError.message);
    }
  }
  return true;
}
async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallback(update);
    return;
  }
  const msg = update.message;
  if (!msg?.chat || !msg?.from) return;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = typeof msg.text === "string" ? msg.text.trim() : "";

  // 管理员直接回复机器人转发的用户消息，即可将回复原样发回用户（文字、图片、文件等均支持）。
  if (await handleAdminSupportReply(msg, userId)) return;

  // 用户私聊机器人时，普通消息自动转发给所有配置的管理员。
  if (msg.chat.type === "private" && !isAdmin(userId) && !text.startsWith("/")) {
    await registerUser(userId);
    await forwardSupportMessage(msg, userId);
    return;
  }
  // 广播待确认阶段支持文字和媒体；不直接群发，必须管理员点击确认。
  if (isAdmin(userId) && pendingBroadcast.has(userId) &&
      (typeof msg.text !== "string" || !["⚙️ 设置", "📣 广播", "👩‍💻 客服", "📊 数据统计"].includes(text))) {
    if (text.toLowerCase() === "/cancel") {
      pendingBroadcast.delete(userId);
      await sendMessage(chatId, "已取消广播，没有发送给用户。", { reply_markup: adminKeyboard() });
      return;
    }
    // Other slash commands cancel the draft mode and continue through normal command handling.
    if (text.startsWith("/")) {
      pendingBroadcast.delete(userId);
    } else {
      pendingBroadcast.delete(userId);
      await sendMessage(chatId,
      "请确认是否广播上面这条消息。确认后会在后台逐个发送，结束后通知你成功/失败数量。",
      { reply_markup: { inline_keyboard: [[
        { text: "✅ 确认广播", callback_data: "broadcast:confirm:" + msg.message_id + ":" + userId },
        { text: "❌ 取消广播", callback_data: "broadcast:cancel" }
      ]] } }
      );
      return;
    }
  }
  if (typeof msg.text !== "string") return;
  if (msg.chat.type === "private") await registerUser(userId);
  // 固定底部管理员键盘：先识别按钮，再处理正在等待的链接或公告。
  if (isAdmin(userId) && text === "⚙️ 设置") {
    pendingLinkSetup.delete(userId); pendingBroadcast.delete(userId); pendingButtonSetup.delete(userId);
    await sendMessage(chatId, "⚙️ 设置菜单\\n请选择要管理的项目：", { reply_markup: { inline_keyboard: [
      [{ text: "🔗 入口链接设置", callback_data: "settings:links" }, { text: "🔘 自定义按钮", callback_data: "buttons:manage" }],
      [{ text: "👁️ 预览用户菜单", callback_data: "preview" }]
    ] } });
    return;
  }
  if (isAdmin(userId) && text === "📊 数据统计") {
    const stats = ensureStats();
    const uptime = Math.floor(process.uptime());
    const duration = `${Math.floor(uptime / 86400)} 天 ${Math.floor((uptime % 86400) / 3600)} 小时 ${Math.floor((uptime % 3600) / 60)} 分钟`;
    const links = Object.values(data.links).filter(Boolean).length + (data.customButtons || []).length;
    await sendMessage(chatId, [
      "📊 防失联机器人数据统计", "",
      `👥 累计登记用户：${data.users.length}`,
      `🆕 今日新增用户：${stats.todayNewUsers}`,
      `🔗 当前入口/自定义按钮：${links}`,
      `📩 收到客服消息：${stats.supportReceived}`,
      `📨 转交管理员成功：${stats.supportForwarded}`,
      `⚠️ 转交管理员失败：${stats.supportForwardFailed}`,
      `↩️ 管理员回复成功：${stats.adminRepliesSent}`,
      `❌ 管理员回复失败：${stats.adminRepliesFailed}`,
      `📣 广播任务次数：${stats.broadcasts}`,
      `✅ 广播发送成功累计：${stats.broadcastSent}`,
      `❌ 广播发送失败累计：${stats.broadcastFailed}`,
      `⏱️ 本次进程运行：${duration}`,
      "", "统计数据保存在数据文件中，重启后继续累计。今日新增按 UTC 日期统计。"
    ].join("\n"), { reply_markup: adminKeyboard() });
    await saveData();
    return;
  }
  if (isAdmin(userId) && text === "👩‍💻 客服") {
    pendingLinkSetup.delete(userId); pendingBroadcast.delete(userId); pendingButtonSetup.delete(userId);
    const contact = data.links.contact;
    await sendMessage(chatId, "👩‍💻 客服设置\\n当前客服链接：" + (contact || "尚未设置") + "\\n\\n可以直接打开当前链接，或点击下方按钮修改。", {
      reply_markup: { inline_keyboard: [
        ...(contact && validUrl(contact) ? [[{ text: "打开客服入口", url: contact }]] : []),
        [{ text: "✏️ 设置客服链接", callback_data: "setlink:contact" }]
      ] }
    });
    return;
  }
  if (isAdmin(userId) && (text === "📣 广播" || text === "📣 发送广播公告")) {
    pendingLinkSetup.delete(userId); pendingButtonSetup.delete(userId); pendingBroadcast.delete(userId);
    pendingBroadcast.add(userId);
    await sendMessage(chatId, "📣 请直接发送要广播的公告内容，可以分多行。\n发送 /cancel 或点击「❌ 取消当前设置」可取消。\n\n公告会发送给已启动过机器人的用户。", { reply_markup: adminKeyboard() });
    return;
  }

  if (pendingButtonSetup.has(userId)) {
    const setup = pendingButtonSetup.get(userId);
    if (text.toLowerCase() === "/cancel") {
      pendingButtonSetup.delete(userId);
      await sendMessage(chatId, "已取消按钮设置。", { reply_markup: adminKeyboard() });
      return;
    }
    if (!isAdmin(userId)) { pendingButtonSetup.delete(userId); return; }
    if (setup.phase === "label" || setup.phase === "editLabel") {
      const label = text.trim();
      if (!label || label.startsWith("/") || label.length > 32) {
        await sendMessage(chatId, "按钮名称不能为空，且最多 32 个字符。请重新发送，或 /cancel 取消。");
        return;
      }
      setup.label = label;
      setup.phase = setup.phase === "editLabel" ? "editUrl" : "url";
      pendingButtonSetup.set(userId, setup);
      await sendMessage(chatId, "请发送这个按钮要打开的网址（https://、http:// 或 tg://）。");
      return;
    }
    if (setup.phase === "url" || setup.phase === "editUrl") {
      const url = text.trim();
      if (!validUrl(url)) {
        await sendMessage(chatId, "❌ 网址格式不正确。请发送完整网址（https://、http:// 或 tg://），或 /cancel 取消。");
        return;
      }
      if (setup.phase === "url") {
        const id = Date.now().toString(36);
        data.customButtons.push({ id, label: setup.label, url });
      } else {
        const button = data.customButtons.find(b => b.id === setup.id);
        if (button) { button.label = setup.label; button.url = url; }
      }
      pendingButtonSetup.delete(userId);
      await saveData();
      await sendMessage(chatId, "✅ 按钮已保存，用户菜单已更新。", { reply_markup: adminKeyboard() });
      await showButtonManager(chatId);
      return;
    }
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
    if (!isAdmin(userId)) { await sendMessage(chatId, "此命令仅供管理员使用。"); return; }
    const stats = ensureStats();
    await sendMessage(chatId, `📊 数据统计\n累计用户：${data.users.length}\n今日新增：${stats.todayNewUsers}\n客服消息：${stats.supportReceived}\n客服转发成功/失败：${stats.supportForwarded}/${stats.supportForwardFailed}\n管理员回复成功/失败：${stats.adminRepliesSent}/${stats.adminRepliesFailed}\n广播任务：${stats.broadcasts} 次\n广播发送成功/失败：${stats.broadcastSent}/${stats.broadcastFailed}\n入口及自定义按钮：${Object.values(data.links).filter(Boolean).length + (data.customButtons || []).length} 个`);
    return;
  }
  if (cmd === "/announce") {
    const announcement = rest.join(" ").trim();
    if (!announcement) {
      pendingBroadcast.add(userId);
      await sendMessage(chatId, "📣 请直接发送要广播的公告内容，可以分多行。发送 /cancel 取消。");
      return;
    }
    const draft = await sendMessage(chatId, announcement);
    await sendMessage(chatId, "请确认是否广播上面这条公告。", { reply_markup: { inline_keyboard: [[
      { text: "✅ 确认广播", callback_data: "broadcast:confirm:" + draft.message_id + ":" + userId },
      { text: "❌ 取消广播", callback_data: "broadcast:cancel" }
    ]] } });
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
