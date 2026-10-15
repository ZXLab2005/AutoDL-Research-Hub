# AutoDL 研究台 GitHub 自动同步

同步根目录是此目录的上一级：**AutoDL-Research-Hub 项目本身**。根目录由当前平台位置解析；不会上传其父目录中的技能源、技能安装记录、学习资料或文献，也不会通过 SSH 自动备份服务器。

仓库目标由本机 `.agent-sync/config.json` 的 `repository` 指定，分支限定为 `main`。Git 的单一 fetch/push `origin` 地址必须与该配置一致，检查通过后才执行上传。[发布范围](PUBLISH-SCOPE.md) · [平台说明](../README.md)

## 日常控制

在平台根目录使用三个入口：

- [启动GitHub自动同步.cmd](../启动GitHub自动同步.cmd)：启动后台监视；已经运行时复用现有服务。
- [查看GitHub同步状态.cmd](../查看GitHub同步状态.cmd)：读取进程状态、最近同步结果和暂停原因。
- [停止GitHub自动同步.cmd](../停止GitHub自动同步.cmd)：停止监视与后续调度；允许已开始的安全检查、提交或推送正常结束。

正常打开研究台时，如果同步配置存在，也会启动同步器。关闭 VS Code 窗口不会自动停止同步。电脑关闭或进程退出后需重新启动；本工具没有安装系统开机服务。

后台启动后先检查一次。文件变化触发约 **30 秒**延迟检查，另有每 **60 秒**的补充检查和失败重试；同一时间只运行一轮同步。持续修改会重新计时，安全扫描、网络、认证与上传大小会影响完成时间，因此不是每次保存立即推送。

只有纳入 Git 范围的文件才同步。修改、新建和删除会形成提交；删除文件只改变远端仓库下一次提交中的内容，不表示程序另行清空本机目录。被排除的应用、认证、缓存和 PDF 不会上传。

## 同步时的检查

同步器核对本地平台目录、当前 Git 根、`main` 分支、origin 和远端提交关系。拟提交文件以及尚未推送的本地提交需要通过安全检查；检查包括不允许发布的路径、常见凭据模式和大文件等。

自动提交使用独立临时索引，并在关键阶段持有真实 Git 索引锁。已有人工暂存会暂停同步；不会将人工暂存混入自动提交。扫描期间可以继续编辑工作文件，尚未进入本次快照的改动留给后续同步。

推送锁定已经检查的提交，不使用 force，不自动拉取合并或解决分叉。若需要手工 Git 操作，可先停止同步，完成操作后再启动。短暂的网络故障会重试；远端冲突、人工暂存和内容检查失败，需要处理原因后才能继续。

## 状态含义

| 状态或原因 | 含义与处理 |
| --- | --- |
| `synced` | 本轮检查确认目标提交已推送或已与远端一致；不代表随后发生的编辑也已上传。 |
| `checking` / `committing` / `pushing` | 正在检查、记录变更或上传。 |
| `paused` + `GIT_OPERATION_FAILED` | 网络、认证或 Git 操作失败；查看 `operation`，恢复连接后后台重试。 |
| `USER_STAGED_CHANGES_NEED_REVIEW` | 有人工暂存。先完成或取消自己的暂存操作；程序不会自动替你处理。 |
| `USER_INDEX_CHANGED_DURING_REVIEW` | 检查期间发现索引变化，已停止本次操作以保留人工状态。 |
| `REMOTE_AHEAD_OR_DIVERGED` | 远端有本地没有的提交；需要人工审查并整合。 |
| `ORIGIN_DOES_NOT_MATCH_CONFIGURATION` | origin 与配置不一致；核对正确仓库后再同步。 |
| `STAGED_CONTENT_FAILED_SAFETY_CHECK` / `PENDING_COMMIT_FAILED_SAFETY_CHECK` | 拟上传文件或未推送提交没有通过检查；修正原因，不能跳过检查强行发布。 |
| `running: false` | 后台进程未运行，或已经退出；检查配置后重新启动。 |

`paused` 表示本轮没有继续上传，并不等于后台监视进程已关闭；需要真正停止时使用停止入口。状态文件为平台根目录下的 `.agent-sync/status.json`，摘要日志为 `.agent-sync/sync.log`，时间使用 UTC。不记录文件正文、命令正文或认证令牌。

## 换电脑或重新配置

`app/`、`data/` 和 `.agent-sync/` 都不随仓库发布。运行组件可由便携包携带或由根目录 EXE 自动准备；本机认证、仓库选择与运行状态在安全分享包中排除，需要新设备本人设置。

安全分享包不含 `.git` 历史，普通打开研究台不需要它。若要启用自动同步，应使用目标仓库的完整克隆，或先为本地平台初始化一个新的仓库并完成首次提交；不要把一份无历史的 ZIP 强推到已有仓库。以下步骤用于已具备 Git 历史的研究台。

1. 在 Windows 上完整解压便携包，双击根目录 `AutoDL研究台.exe` 完成本地组件准备。Git、Node.js 和 GitHub CLI 分别使用 `app/git/cmd/git.exe`、`app/node/node.exe`、`app/gh/bin/gh.exe`；隔离环境按平台当前位置自动解析，不需要手改工具盘符。
2. 安全分享包不携带仓库授权。首次启用同步时，将 [config.example.json](config.example.json) 作为 `.agent-sync/config.json` 的模板，选择自己的 `repository` 和代理。`gitExe`、`ghExe` 已使用平台内相对路径，不需要为换盘符修改。根目录和 `.agent-sync` 不得是 junction 或符号链接。选择仓库是首次启用这一可选功能的步骤，不影响双击打开研究台。
3. 从平台根目录打开 PowerShell，加载隔离环境，然后通过官方 GitHub CLI 完成网页授权：

```powershell
. '.\github-sync\environment.ps1'
& $syncGh auth login --hostname github.com --git-protocol https --web --insecure-storage
& $syncGh auth setup-git
```

`--insecure-storage` 将登录凭据明确保存为平台 `.agent-sync/private/gh` 下的本机文件，避免使用 Windows 默认凭据存储。新机器应核对 `.agent-sync/private` 的 NTFS 权限，仅授予本人和必要的系统账户访问；不要将认证目录加入 Git，也不需要向 Codex 发送密码或令牌。

4. 在同一隔离环境中，为本仓库设置自己的 Git 提交作者，核对 `main` 和 origin。示例中的值需由使用者填写：

```powershell
& $syncGit config user.name '你的提交名称'
& $syncGit config user.email '你的 Git 提交邮箱'
& $syncGit branch --show-current
& $syncGit remote -v
```

作者邮箱可使用本人 GitHub 提供的隐私邮箱。origin 必须是配置仓库对应的 HTTPS URL，不在地址内嵌入凭据。如果 Git 报目录归属不安全，先确认该本地平台目录确为自己审查过的项目，再仅添加这个精确路径：

```powershell
& $syncGit config --global --add safe.directory $syncRoot
```

这里的 `--global` 由已加载环境指向平台隔离配置，不使用原用户目录的默认 Git 配置；不要用 `safe.directory '*'`。

5. 从平台根目录执行一次同步并检查结果，再启动后台入口：

```powershell
& $syncNode '.\github-sync\sync.js' once
```

克隆仓库不会恢复原服务器环境、Codex 登录或 SSH 私钥。恢复平台本身还需按 [主说明](../README.md) 准备编辑器、扩展和连接。

## 开发测试

在平台根目录加载 `environment.ps1` 后运行：

```powershell
& $syncNode --test github-sync/safety.test.js github-sync/sync.test.js
```

测试在平台 `.agent-sync/temp/` 中使用隔离仓库并模拟网络，不向真实 GitHub 仓库推送。测试通过平台工具目录查找 Git。测试通过不能证明当前机器的 GitHub 认证或网络已经可用。

## 首次部署验证

2026-10-05 的首次部署通过了 18 项发布安全测试和 16 项同步行为测试。研究台首次上传后，本地提交与 GitHub `main` 的提交哈希已核对一致，仓库为私有。随后启动了后台文件监视；可通过本段所在的后续提交核对文档变化是否已自动送达 GitHub。这是本次机器与网络条件下的验证记录，后续运行状态请以状态入口为准。
