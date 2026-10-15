# AutoDL 本地 Codex 控制台

此工程是 Windows 上的 Codex 控制台，不是研究代码的本地副本。默认选择 **Windows Codex + 免密 SSH**：Codex 客户端、账号登录和模型请求留在 Windows 侧；研究文件、Python 环境、数据和实验运行在 AutoDL。模型计算由所使用的 Codex 服务提供。默认不在 AutoDL 安装 Codex；用户明确选择远端模式时，可使用下述远端 CLI 入口。

## 默认工作方式

- 研究代码的查看、搜索、修改、运行、测试和 Git 操作，默认全部通过 SSH 桥接脚本在 AutoDL 执行。不要把研究命令直接运行在本机 PowerShell，不要在这个控制台目录创建一份独立研究工程。
- 桥接入口是本工程上一级的 `scripts/Invoke-AutoDL.ps1`。按本文件所在 workspace 的上一级解析平台根目录，不固定盘符。
- 每次桥接操作附上 `-Label '简短操作目的'`，使研究台实时界面显示可理解的操作进度；标题不得含密码、密钥、令牌或认证内容。开始与结束状态自动记录于平台目录 `data/logs/activity.jsonl`，不在日志保存命令正文或输出。后台任务完成情况仍需读取该任务日志确认。
- 每次调用由脚本读取 `data/connection.json`，验证目标后自动进入其中的 `remotePath`。不要固化旧主机、端口或研究目录，不要重写 SSH 配置绕过桥接。
- 远端资源管理器、研究台“项目终端”和此 SSH 桥接共用已保存的 `remotePath`；研究文件只有远端这一份。操作文件后提醒用户保存或刷新编辑器中的相关内容。各命令是独立会话，不会继承用户终端临时的 `cd`、变量或激活环境；应显式指定项目环境，不声称已同步终端进程。
- 开始新的研究任务时，先用桥接执行 `pwd; hostname`，依据实际输出确认目标。实例不可达时如实说明；不得把本机输出当成远端结果。
- “远端编辑 / 调试”窗口仅作为可选文件查看、Python 调试与 Notebook 界面。本地 Codex 会话无需连接该窗口，也不要求在远端安装或登录 Codex。

## 调用方式

以下示例从本文件所在的 `workspace` 目录在 Windows PowerShell 中执行：

`& '..\scripts\Invoke-AutoDL.ps1' -Command 'pwd; hostname' -Label '确认远端项目目录和主机'`

`-Command` 接收 Bash 命令；使用 PowerShell 单引号以免变量先在本机展开。复杂或多行操作先把 UTF-8 Bash 脚本保存到平台的 data/temp 临时目录，再调用：

`& '..\scripts\Invoke-AutoDL.ps1' -ScriptPath '..\data\temp\research-task.sh'`

`-Command` 和 `-ScriptPath` 二选一。桥接通过 SSH 将脚本交给远端 Bash，不会在 Windows 执行该研究脚本。文件读写可通过远端 `cat`、`sed`、Python 或带有可靠引用的 heredoc 完成；检查现有文件后再修改，并在远端进行相关验证。

桥接默认等待命令结束。`-TimeoutSeconds` 仅限制本地 SSH 等待时间，不保证结束远端任务。长时间训练需要在用户授权范围内使用远端已有的持久会话工具，并保存日志和任务标识；不要把关闭 SSH 等同于停止实验。

## Search-R1 项目说明

当前已部署的 Search-R1 工程和独立 Conda 环境的操作文档为平台根目录 `SEARCH-R1-GUIDE.md`，服务器工程内也有 `repro/README.md`。处理该项目时先通过桥接核对当前服务器与目录，再按文档显式激活环境；不要使用 Windows Python 或服务器 base 环境运行研究代码。实际安装与验证记录位于服务器工程的 `repro/logs/` 和 `.aris/compute/autodl.md`。本次范围是环境与界面，尚未完成官方模型的 GPU 推理；不能把依赖检查称为论文复现。

## 可选远端 Codex CLI

用户主动选择远端模式时，运行本平台 scripts/Start-RemoteCodex.ps1：默认安装或复用远端 CLI、准备登录，然后在当前 connection.remotePath 交互启动。-InstallOnly 仅安装；-Update -InstallOnly 显式升级。平台根目录提供 Start-Remote-Codex.cmd 双击入口。

选择前先展示已保存的 host、port 和 remotePath。新服务器仍要先配置公钥、核对并保存主机指纹；一键入口不会自动信任未知主机，不会自动开机或购买算力。远端 Codex 使用独立 CODEX_HOME；退出终端不代表研究训练任务必然停止。

## 存储与权限

- 平台产生的本地脚本、配置、缓存、日志和下载只放在当前平台目录中。远端研究文件保存在配置的 Linux 研究目录。
- 只有用户明确要求修改本地平台或本地说明时，才编辑这个控制台及其上级平台文件。对研究代码的普通请求仍默认操作远端。
- 不读取、打印、复制或上传 SSH 私钥及其他未授权凭据。使用现有免密认证及已保存的主机指纹；主机指纹改变时先核实。
- 用户已授权：主动选择“安装并启动远端 Codex”或“Start-Remote-Codex.cmd”时，由 scripts/Start-RemoteCodex.ps1 检测并按需将本机 auth.json 通过 SSH 标准输入同步到当前目标服务器的独立 CODEX_HOME。远端已有可识别的登录状态时复用；没有本机可用来源才使用设备码登录。这个已授权流程无需再追加确认。
- 该流程可只读检测平台私有目录登录文件及原本 Windows CODEX_HOME/用户目录中的 auth.json（来源可能在 C 盘），但新增文件只能写入当前平台目录。不得把凭据内容打印到聊天、终端或日志，不得放进研究工程或缓存；远端目录和文件使用 700/600 权限。
- 除明确选择的远端 CLI 流程外，保持默认本地 Codex + SSH。不覆盖 Codex 扩展运行位置，不自动安装远端 IDE Codex 扩展。
- 不自动开机、关机、重建、释放实例，不购买 GPU、租用实例或触发付费资源变更。此类操作需要用户明确指示。
- 保持正常的 VS Code 工程信任、工具审批和 SSH 主机校验。不要为了执行命令关闭这些机制。
