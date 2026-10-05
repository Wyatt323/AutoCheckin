# AutoCheckin

Telegram 多账号签到与消息自动化工具，提供本地 Web 管理界面。Node.js 负责配置管理、日志与任务调度，Python / Telethon 负责 Telegram 操作。

> **安全边界：管理页没有登录认证，默认只允许本机访问。不要直接暴露到公网。** `config.json`、Telegram Session 和备份均包含敏感数据，请妥善保存。

## 功能

- **多账号管理**：每个账号独立保存 API ID、API Hash、Session、签到 Bot 与对话分组。
- **Bot 签到**：支持按钮交互和自定义命令；结合 AI / OCR 处理脚本支持的验证码及交互场景。不同 Bot 的交互流程不保证全部兼容。
- **签到计划**：按账号配置每日或一次性任务，手动与定时签到串行执行。
- **定时消息**：按账号向指定会话发送纯文本消息。
- **监听转发**：监听群组或频道的新消息，转发至目标会话；不会重放历史消息或重新转发编辑消息。
- **配置与日志**：网页编辑配置、查看运行状态与最近日志；密钥不回显，留空保存时保留已有密钥。

## 快速开始：本机运行

需要 Node.js **22 或更新版本**、Python **3.10 或更新版本**。Node 服务只使用内置模块，无需 `npm install`。Python 依赖包含 OCR / 推理组件，安装体积较大，具体平台支持以依赖包为准。

```bash
git clone https://github.com/Wyatt323/AutoCheckin.git
cd AutoCheckin
python3 -m pip install -r requirements.txt
node server.js
```

如果系统禁止向全局 Python 安装依赖（PEP 668），使用虚拟环境：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
node server.js
```

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
node server.js
```

打开 **http://127.0.0.1:8765**（不要替换成 `localhost`，服务会校验 Host）。首次启动自动从 `config.example.json` 创建空配置，不包含真实账号或密钥。

Python 选择顺序：显式 `PYTHON_BIN` → 项目 `.venv` → 系统解释器。Windows 会优先尝试 `py -3`，Linux 优先 `python3`。

## 首次配置与登录

1. 在网页添加账号，填写名称、Session 名称、该账号的 API ID / API Hash。API 凭据可从 [my.telegram.org](https://my.telegram.org) 获取。
2. 添加该账号的签到 Bot，选择按钮方式或命令方式，例如 `/sign`；添加 AI 服务的兼容 API 地址、API Key 和模型名称，然后保存。
3. 在项目目录执行以下命令，按脚本提示扫码登录；启用两步验证的账号还需输入密码：

   ```bash
   python3 allinone.py --account Session名称
   # 使用虚拟环境时：.venv/bin/python allinone.py --account Session名称
   ```

4. 登录成功后刷新网页，确认 Session 就绪。此命令同时运行该账号的签到，不是仅登录命令。
5. 通过账号卡片的执行按钮手动签到，或添加定时计划。

Session 名称需与网页完全一致，只能包含字母、数字、下划线、点和连字符，不允许路径。**修改 Session 名称不会自动迁移原文件**。存在 Session 文件也不代表凭据仍有效，失效后需要重新登录。

## Docker Compose

仓库提供从源码构建的 Compose 配置：

```bash
mkdir -p data
# 容器以 node 用户（UID 1000）运行；Linux 上需确保挂载目录可写。
sudo chown 1000:1000 data
docker compose up -d --build
docker compose logs -f autocheckin
```

打开 **http://127.0.0.1:8765**。Compose 只向宿主机回环地址发布端口；启动前确保本机 Node 服务没有占用 8765。

配置保存后，在容器中完成账号登录 / 签到：

```bash
docker compose exec autocheckin python -u allinone.py --account Session名称
```

`./data` 挂载到 `/data`，保存配置、Session 与定时状态。重建镜像和 `docker compose down` 不会删除此目录。源码构建通过 `.dockerignore` 排除真实配置、Session、缓存和数据目录。

更新：

```bash
git pull --ff-only
docker compose up -d --build
```

迁移本机数据时，**先停止服务**，把 `config.json`、`*.session`、`.automation-state.json` 和 `.checkin-schedule-state.json` 放入 `data/`，再调整目录权限并启动。不要同时在多个实例中使用同一份 Session。

## 定时任务与转发规则

所有计划均按 **北京时间（UTC+8）** 计算，不随浏览器时区变化。

- **每日任务**：仅在指定分钟触发，停机错过后不补跑。
- **一次性任务**：仅在指定时间之后 5 分钟内触发，过期不补跑。
- **签到排队**：与手动签到互斥，已触发任务在忙碌时排队；持久化触发记录用于避免重启后再次触发。触发记录不等于 Telegram 签到成功。
- **消息自动化**：使用规则所属账号的 Session；批量签到期间暂停，结束后恢复。暂停期间的监听消息不保证补转发。
- **转发会话**：支持公开 `@用户名`、公开 `https://t.me/用户名` 或数字会话 ID（频道常见 `-100…`），不支持私有邀请链接。账号必须有读取来源、发送至目标的权限。
- **规则校验**：拒绝同源同目标与可检测的同账号转发循环。不同账号之间、或同一会话使用不同标识时的循环仍需自行避免。

成功发送记录写入 `.automation-state.json`，签到触发记录写入 `.checkin-schedule-state.json`。**这不是严格的 exactly-once 保证**：在 Telegram 操作与本地写盘之间发生崩溃时，仍可能遗漏或重复执行。

服务停止后所有自动任务停止；任务必须已有可用 Session，网页不会提供交互式 Telegram 登录。

## 环境变量

- `PORT`：监听端口，默认 `8765`。
- `AUTOCHECKIN_DATA_DIR`：配置、Session 和状态所在目录；本机默认项目目录，Compose 为 `/data`。
- `PYTHON_BIN`：Python 解释器路径，例如 `/usr/bin/python3`。
- `BIND_HOST`：监听地址，本机默认 `127.0.0.1`，容器使用 `0.0.0.0`。
- `PUBLIC_HOST`：允许的请求 Host 中的主机名，默认 `127.0.0.1`。它不是公网认证开关，也不是完整 URL。

Linux 指定端口示例：

```bash
PORT=9000 PYTHON_BIN=/usr/bin/python3 node server.js
```

此时访问 `http://127.0.0.1:9000`。远程管理建议通过 SSH 隧道：

```bash
ssh -N -L 8765:127.0.0.1:8765 user@服务器
```

不建议直接配置公网反向代理；目前 Host / Origin 校验不等同于用户认证，也不提供完整的 HTTPS 反代支持。

## 数据、安全与备份

- 账号密钥、AI Key 明文保存于数据目录，Session 相当于账号登录凭据。限制目录访问权限，不要分享这些文件。
- API Hash / API Key 输入框留空会保留该项已有密钥；要更换密钥需显式输入新值。
- 运行中的签到使用启动时读取的配置；启动及运行期间拒绝配置保存和自动化重启，避免争用 Session。
- 日志仅保存在 Node 进程内存，重启后清空。签到保留最近 800 行；自动化日志也有数量上限。
- 旧版顶层 `bots` / `bot_groups` / `bot_notes` 会作为账号初始配置读取，首次网页保存后迁移到账号独立配置。
- 备份前停止服务，再备份整个数据目录；恢复时保持 Session 名称、文件名和目录权限一致。
- `.gitignore` 排除真实配置、Session、虚拟环境与缓存，但不能撤销 Git 历史中的泄露；若曾提交真实凭据，应立即轮换密钥并撤销泄露的登录会话。

## 常见问题

**页面返回 403**：确认使用 `http://127.0.0.1:8765` 或与你设置的 `PUBLIC_HOST` / `PORT` 完全一致的地址。

**未找到 Python / 缺少依赖**：用服务实际选择的解释器安装 `requirements.txt`，必要时设置 `PYTHON_BIN`，重启服务。解释器探测有短时间缓存。

**Docker 提示 Permission denied**：检查 `data/` 是否允许 UID 1000 写入；不要用 `chmod 777` 代替权限管理。

**无法运行签到**：确认账号有 Bot、已完成登录、Session 文件位于数据目录；查看日志中的实际错误。

**某个 Bot 失败**：先确认命令和交互模式；验证码或界面变动可能需要适配。`MAX_FAILED_ROUNDS` 当前为 `0`，首轮失败后不进入额外重试轮次，但会继续后续账号。

**定时任务没有补跑**：检查北京时间、启用状态、服务运行状态和上述触发窗口；不要直接删除状态文件来“修复”，这可能导致重复执行。

## 开发与离线测试

```bash
python3 -m pip install -r requirements.txt
node tests/run-tests.js
```

测试使用隔离配置、模拟客户端与本地服务，不需要真实 Telegram / AI 凭据，不会执行真实签到或发送消息。GitHub Actions 会运行同一测试入口。

## 项目结构

```text
server.js               Web 服务、配置校验、签到进程管理
checkin_scheduler.js    按账号签到调度与持久化队列
automation.js           自动化子进程管理
automation_worker.py    定时消息与新消息转发
allinone.py             Telegram 登录及 Bot 签到
public/                 Web 界面
config.example.json     不含凭据的初始配置
tests/                  离线回归测试
```

仅用于你有权访问的账号和会话，请遵守 Telegram 与目标 Bot 的使用规则，避免高频自动操作及垃圾消息。
