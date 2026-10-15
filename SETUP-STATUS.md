# 安装与验证记录

> 这是历史部署验证记录，账号、主机、端口和密钥指纹已替换为占位值。实际连接设置仅保存在本机 data/ 中；历史通过不代表服务器当前在线。

当前默认：**Windows 本地 Codex + 免密 SSH**。本地控制台由 Research.code-workspace 打开，研究文件和命令通过 scripts/Invoke-AutoDL.ps1 在服务器执行。

## 已完成的真实验证

- 平台本地文件集中在研究台根目录；SSH 配置、密钥、known_hosts、扩展、缓存、日志、临时文件均使用该目录内的专用子目录。
- 独立微软官方 ZIP 版 VS Code 1.140.0 已安装，Code.exe 的 Microsoft Corporation 签名验证有效。Remote SSH、本地 Codex 和中文扩展已安装并有真实激活记录。
- 当前已保存地址：root@your-ssh-host.example:YOUR_SSH_PORT。SSH 仅使用公钥登录，无需反复输入服务器密码。
- SSH 入口真实返回主机 YOUR_AUTODL_CONTAINER、目录 /root/autodl-tmp/research-hub/projects、Python 3.12.3。
- 已通过 UTF-8 脚本在远端专属测试临时目录创建、读取含中文和引号的文件，内容核对成功并自动清理测试目录。
- 远端退出码 37 正确传回 PowerShell 的 LASTEXITCODE；本地进程需要保留具体退出码时使用 exit $LASTEXITCODE。
- 后台反向代理隧道已完成实际启动、重复启动复用、安全停止、重新建立测试；父启动进程退出后隧道仍存活。远端经该隧道访问官方 Codex 文档返回 HTTP 200。
- VS Code 远端服务已安装并成功握手；Python、Pylance、debugpy、Jupyter 及相关扩展已由远端扩展列表确认。
- 默认远端扩展列表不再包含 Codex。本地 Codex 使用 SSH 操作服务器，无需远端 Codex；另有用户要求新增的可选远端 CLI 模式，最终安装验证将在下节记录。

## 公钥与首次测试历史

- AutoDL 账号 YOUR_AUTODL_ACCOUNT 已登记平台公钥，备注 E盘研究台-Codex-20261002。
- 公钥指纹 SHA256:YOUR_PUBLIC_KEY_FINGERPRINT。私钥权限仅限当前本机用户，不读取或打印私钥。
- 首次主机指纹以首次使用信任方式保存于 E 盘 known_hosts，未独立取得控制台主机指纹比对；后续连接严格检查已有指纹。
- 2026-10-02 约22:35至22:51的临时无卡测试已按约关闭实例，估算费用低于用户当次1元上限，停机截图已保存。之后用户自行重新启动实例，当前为用户继续使用期间，本平台不自动开关机。
- 原远端 .bashrc 保留首次备份；环境目录为 /root/autodl-tmp/research-hub。已验证 PyTorch 2.3.0+cu121；无卡模式不提供 GPU。

## 使用边界

- SSH 免密成功、端口可达、保存的 Codex 登录状态和模型请求成功是不同验证结果，分别报告。
- 启动研究台不会自动启动或停止云实例；新服务器先配置 SSH 地址、公钥和可信主机指纹。
- 本地 Codex 正常使用 SSH 入口不会自动依赖代理隧道；远端包下载、联网或可选远端 Codex 可能需要代理隧道。
- Windows 与原有应用自身的系统记录不属于平台控制范围；平台新增文件仅写 E 盘，远端安装写入目标 Linux 服务器。

## 可选远端 Codex：2026-10-03 实测

- Codex CLI 0.160.0 已通过官方完整 Linux x64 安装包安装；E盘缓存包SHA256与官方发布记录一致，上传后再次校验并检查可运行版本。
- 用户明确授权的自动认证迁移已完成：从平台 E盘 auth.json 经SSH stdin同步到 /root/autodl-tmp/research-hub/codex-remote/auth.json。未将认证内容输出到聊天、日志、参数或缓存。
- 权限实测：CODEX_HOME 700、auth.json 600。重复执行PrepareOnly复用已有程序与登录状态，未重新下载或覆盖认证。
- 已在服务器真实调用Codex，模型gpt-6.1-sol返回 CODEX_REMOTE_READY，退出码0。该检查使用read-only和ephemeral，不读写研究代码。首次模型列表刷新曾超时，随后实际请求成功。
- 当前AutoDL不允许创建sandbox namespace，bwrap自检失败；未关闭沙箱或改内核。正常交互模式中针对具体命令的单次审批路径由官方支持，但尚未在当前实例批准实测；默认本地Codex+SSH桥接已真实验证远端命令与文件读写。
- 最终49项组合测试全部通过，包括配置路径、隧道生命周期、SSH编码与退出码、缓存校验、按需认证迁移。
- 新版研究台已同步至E盘并调用工作区启动器。首次工程信任仍由用户通过VSCode正常界面确认。

## 可视化首页恢复：2026-10-03

- 修复本地控制工作区首次处于受限模式时研究台扩展被禁用、仅恢复AGENTS.md和内置聊天栏的问题。1.0.1支持受限模式下显示卡片首页；执行操作仍等待用户通过VS Code正常流程信任工程。
- 已生成E盘VSIX并通过官方VS Code CLI安装1.0.1，扩展注册版本已核对。重新打开工作区后，2026-10-03 06:27:55（北京时间）日志记录dashboard webview ready；未通过原生窗口截图确认外观。
- 配置与信任行为共19项测试通过；信任前不读连接或凭据、不启动SSH和后台轮询，信任后恢复按钮并调用Codex侧栏。
- 保留原有SSH、本地Codex和可选远端Codex配置，未更改工程信任存储，也未操作云实例电源。

## 文件与项目终端统一：2026-10-04

- 用户截图对应22:21的Remote SSH日志显示连接超时、远端文件服务未建立；标题中的SSH目标和install－本地终端不能证明连接成功。随后普通免密SSH真实连接成功，确认当前projects目录为空。
- 研究台升级至1.0.2，安装注册版本已核对。本地“项目终端”进入当前配置的remotePath，目录不存在就退出；远端窗口仅在工作区URI与保存路径匹配、文件服务已验证且工程受信任后创建真正的远端终端，不设置Windows shell或本地环境。
- 文件浏览、项目终端、Codex桥接使用同一远端项目目录。未创建本机副本、未启用双向同步，也不共享不同Shell的临时状态。研究台显示共用目录及这一行为说明。
- Remote SSH连接等待设为45秒，默认隐藏连接安装终端，详细错误仍在Remote - SSH输出中。
- 相关35项测试全部通过。新的项目终端SSH命令真实返回主机YOUR_AUTODL_CONTAINER、目录/root/autodl-tmp/research-hub/projects，退出码0。
- 旧的失败远端窗口仍需正常重新加载；CLI再次打开同一目录复用了旧窗口，未得到新版远端文件服务或原生终端启动日志，不将命令行验证当作远端界面已恢复。

## 实时操作和目录监视：2026-10-04

- 研究台 1.1.0 已打包并通过官方 VS Code CLI 安装，扩展注册版本已核对。新增操作列表、调用状态、耗时与退出码，以及远端文件增删改列表。保持原卡片首页和 Codex 侧栏入口。
- SSH 桥接 `-Label` 提供操作标题，日志仅保存必要状态，不保存命令正文、输出或凭据。后台任务完成情况需另外检查任务日志。
- 远端监视每 3 秒读取文件元数据，页面隐藏/关闭即停止，支持手动暂停、断线重连和同一目标跨窗口互斥。排除缓存和环境目录，不读文件正文，不建立本地镜像。
- 全部 85 项平台测试通过。真实 SSH 联调扫描 260 个文件/59 个目录，成功捕获独立探针的新增、修改、删除；对应三次操作各有开始/结束记录、退出码 0。探针已清理，测试监视进程已停止。报告保存在 E 盘 data/temp/live-integration-report.json。
- 当前旧窗口可能仍运行升级前代码，需执行“开发人员: 重新加载窗口”。原生窗口检查工具两次返回 `window id 67498 no longer belongs to Microsoft.VisualStudioCode; current owner is Microsoft.VisualStudioCode`，未得到窗口截图，因此不声称已视觉确认当前窗口显示新版。

## Search-R1 环境：2026-10-04

- 官方源码已固定在提交 598e61bd1d36895726d28a8d06b3a15bed19f5d3，服务器工程为 /root/autodl-tmp/research-hub/projects/Search-R1。原有上游源码未修改，辅助脚本在 repro/，编辑器配置在 .vscode/。
- 独立 searchr1（Python 3.9.25）与 retriever（Python 3.10.22）Conda 环境已安装。PyTorch 2.4.0+cu121、Transformers 4.46.3；主环境另含 vLLM 0.6.3、FlashAttention 2.7.4.post1，检索环境使用 FAISS CPU 1.8.0.post1。
- 两环境 pip check 与实际 CPU 功能检查均通过。独立代理按文档逐字顺序执行两次检查也返回 0 和 CPU_CHECKS_PASSED；GPU 不可见，GPU 内核、官方模型检索推理及准确率未验证。
- 用户将 GPU 推理留待后续，本次没有下载官方模型权重。辅助下载与小语料推理脚本、精确包清单、环境记录已保留。详细交付结果见 SEARCH-R1-STATUS.md，操作说明见 SEARCH-R1-GUIDE.md。
