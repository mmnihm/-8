# Telegram 防失联机器人

独立 Telegram Bot，提供动态备用入口、管理员入口管理、用户公告广播和健康检查。使用 Node.js 20+，不依赖数据库或第三方 npm 包。

## 环境变量

- `BOT_TOKEN`：从 BotFather 获取的独立机器人 Token
- `ADMIN_IDS`：管理员 Telegram 数字 ID；多个 ID 用英文逗号分隔，例如 `123456789,987654321`
- `PORT`：可选，默认 `3000`
- `DATA_DIR`：可选，数据目录，默认 `./data`
- `MAIN_CHANNEL_URL`：可选，官方频道初始链接
- `BACKUP_CHANNEL_URL`：可选，备用频道初始链接
- `CONTACT_URL`：可选，客服入口初始链接
- `STATUS_URL`：可选，状态页初始链接

不要把 Token 写进代码或提交到 GitHub。

## 启动

```bash
npm start
```

健康检查：`/health`。

## 管理员命令

- `/links` 查看入口
- `/setlink main https://t.me/your_channel`
- `/setlink backup https://t.me/your_backup_channel`
- `/setlink contact https://t.me/your_support`
- `/setlink status https://example.com/status`
- `/setlink backup off` 清除某个入口
- `/announce 公告内容` 向已启动机器人的用户发送公告
- `/stats` 查看用户数与运行时间
- `/help` 查看命令

## 注意事项

1. 用户必须先私聊并启动机器人，机器人才能给该用户发送私聊通知。
2. 管理员必须在 `ADMIN_IDS` 中填写自己的 Telegram 数字 ID。
3. `data/data.json` 保存入口、用户 ID 和轮询偏移量。部署平台若使用临时磁盘，需挂载持久化磁盘或定期保存数据。
4. 本机器人应使用独立 Token 和独立进程；不要与其他机器人共用 Token。
5. PM2 示例：`pm2 start index.js --name anti-loss-bot`。
