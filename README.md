# AutoCheckin 管理页

一个运行在本机的 Telegram 批量签到管理页。支持账号、Bot、AI 服务配置，定时签到、定时消息、频道转发和实时日志。

## 启动

需要 Node.js 18 或更新版本。此管理页不需要安装 npm 包。

```powershell
node server.js
```

随后打开 [http://127.0.0.1:8765](http://127.0.0.1:8765)。服务只监听 `127.0.0.1`。如需换端口，可在启动前设置 `PORT` 环境变量。首次运行会从不含凭据的 `config.example.json` 生成本机 `config.json`。

运行签到和消息自动化还需要 Python 3 及脚本依赖。Windows 下推荐在项目目录创建独立环境：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

管理页优先使用项目内的 `.venv`，然后依次尝试 `py -3`、`python`、`python3`。若 Python 不在 PATH 中，可以设置 `PYTHON_BIN` 为解释器的完整路径，再启动 Node 服务。

## Docker Compose 部署

安装 Docker Desktop（或其他支持 Docker Compose 的环境）后，在项目目录运行：

```powershell
docker compose up -d --build
docker compose logs -f autocheckin
```

打开 [http://127.0.0.1:8765](http://127.0.0.1:8765)。Compose 只把管理页发布到宿主机的 `127.0.0.1:8765`。如果本机的 `node server.js` 已占用 8765 端口，先停止该进程，再启动容器。

容器把 `./data` 挂载到 `/data`，其中保存 `config.json`、Telegram 的 `.session` 文件和定时任务状态；重建容器不会清除这些数据。首次启动会自动生成不含密钥的初始配置，随后可在网页添加账号、Bot 和 AI 服务。如果要迁移已有本机数据，启动前把 `config.json`、`*.session` 和状态文件复制到 `data/`。

新账号先在网页保存 API ID、API Hash、至少一个 Bot 和 AI 服务，再运行以下命令扫码登录（把 `Session名称` 换成网页中填写的值）：

```powershell
docker compose exec autocheckin python -u allinone.py --account Session名称
```

登录生成的 Session 会留在 `data/`。查看运行记录用 `docker compose logs -f autocheckin`，停止服务用 `docker compose down`；`down` 不删除 `data/`。Docker 镜像构建时通过 `.dockerignore` 排除本机配置和 Session，凭据不会被复制进镜像。

## 消息自动化

在“账号管理”中点击对应账号，再进入“定时消息”或“监听转发”可以配置：

- 一次性或每日定时发送纯文本消息。时间统一按北京时间（UTC+8）计算；每日任务错过当分钟后不会补发，一次性任务最多允许延迟 5 分钟。
- 监听群组或频道的**新消息**，逐条转发到目标群组或频道。编辑已有消息不会再次转发。

规则使用当前账号的 Telegram Session。来源和目标可填写公开 `@用户名`、公开 `https://t.me/用户名` 链接或数字会话 ID（私有频道通常形如 `-100...`）。账号须已加入来源会话，并有向目标发消息或转发的权限。规则保存后由后台进程执行；服务停止后自动化停止。批量签到运行期间自动化暂停，结束后恢复。发送结果和错误显示在账号的“监听转发”页面，成功发送的一次性和每日记录写入 `.automation-state.json`，用于避免服务重启后重复发送。

## 初次登录

新 Telegram 账号须先在终端运行 `allinone.py`，按提示扫码登录并生成对应的 `.session` 文件。网页会显示 Session 是否就绪；配置了 Bot 的账号缺少 Session 时会阻止启动，以免网页登录流程停在需要输入密码的终端提示上。

## 按账号配置签到 Bot

在“账号管理”中，每个账号都可以单独配置 Bot、签到方式、命令、备注和 Telegram 对话分组。运行签到时只处理该账号的 Bot；一个账号的 Bot 签到失败不会阻止后续账号运行。没有配置 Bot 的账号会被跳过。

账号页以卡片展示登录状态和配置数量。点击卡片进入账号资料，或使用卡片下方入口直接打开 Bot、定时签到、定时消息、监听转发；“执行”按钮只运行该账号的签到。消息与转发规则在所属账号中编辑，保存时仍保留原有 `automations` 配置格式。

旧版顶层 `bots`、`bot_groups` 和 `bot_notes` 会在管理页中显示为各账号的初始 Bot 列表。首次保存后，配置会迁移到各账号的 `bot_groups` 和 `bot_notes`，不再依赖顶层 Bot 列表。

## 按账号定时签到

在每个账号卡片的“定时任务”中，可以添加每日或仅一次的签到计划、设置北京时间并启用或停用。保存后，后台会在指定时间运行该账号配置的全部签到 Bot；账号必须已有 Bot 和可用的 Session。仅一次的任务只在指定时间之后 5 分钟内触发，过期不补跑。每日任务只在指定分钟触发。

任务按顺序执行，不会与手动签到并行；忙碌时已触发的任务会排队。触发记录保存在 `.checkin-schedule-state.json`，服务重启后不会重复触发同一次任务。关闭 `node server.js` 后定时任务停止。也可在终端运行 `python allinone.py --account Session名称`，只签到指定账号。

## 配置与数据

- 网页读取并更新数据目录中的 `config.json`（本机默认为项目根目录，Docker 为 `data/`）。保存时会保留已有账号的 API Hash 和 AI 服务的 API Key，除非你填写新值。
- Bot 备注保存在账号的 `bot_notes` 字段中，仅供管理页展示，不影响 `allinone.py` 的签到流程。
- `config.json` 和 `.session` 都包含敏感凭据。管理页不会提供这些文件的下载入口，也不会把密钥回显到浏览器。
- 运行日志只保存在 Node 进程内存中，重启服务后清空；页面最多显示最近 800 行。
- 修改配置时，运行中的签到任务会继续使用启动时读取的配置。运行期间网页会拒绝保存新配置。

原脚本目前将 `MAX_FAILED_ROUNDS` 设为 `0`；某账号首轮有 Bot 失败时，该账号会结束本轮处理，随后继续下一个账号。相关重试策略仍由 `allinone.py` 控制。

## 上传 GitHub 前

只提交源码、`config.example.json`、Docker 文件和文档。真实的 `config.json`、`data/`、`*.session`、虚拟环境、缓存和运行状态均由 `.gitignore` 排除；不要使用 `git add -f` 强制提交这些文件，也不要通过网页直接拖入整个项目目录。若凭据曾被提交到历史记录，仅删除当前文件不足以撤销泄露，应轮换相应密钥和 Session。
