# 便携打包与迁移

安全分享包流程是：**导出 ZIP → 在另一台 Windows 10/11 x64 电脑完整解压 → 双击 AutoDL研究台.exe**。本人要连同账号和配置迁移时，使用下方“自己搬迁原有完整工作区”方式。文件夹可以移动到其它本地盘符，启动器按自身位置定位程序和数据；无需逐项手改 JSON 中的盘符。

本机当前部署继续使用原 E 盘平台目录。本指南描述 Windows 10/11 x64 目标，不支持 ARM64、32 位 Windows 或 Linux/macOS；目标机器需要 Windows PowerShell 5.1，网络、账号授权与服务器资源仍需可用。

## 轻量分享包与本人迁移包

在平台根目录的 PowerShell 中执行：

```powershell
# 本人迁移：打包平台和已下载的运行组件，不作为公开发布包。
& '.\scripts\Export-Portable.ps1'

# 对外分享的轻量包：只携带平台源码、EXE、脚本和文档；首次运行再下载依赖。
& '.\scripts\Export-Portable.ps1' -NoRuntime
```

输出默认位于 `data/exports/`，名称带时间。也可用 `-OutputPath 'D:\Transfer\Research-Hub.zip'` 指定一个尚不存在的 ZIP 路径。脚本不会覆盖已有包。ZIP 顶层是单独的 `AutoDL-Research-Hub/` 文件夹；包内 `PORTABLE-MANIFEST.json` 记录已包含的运行组件与排除规则。

公开分发使用 `-NoRuntime`。本项目的开源许可不授予第三方运行组件的重分发权；完整运行组件包仅用于本人迁移，相关条款见 [第三方说明](THIRD_PARTY_NOTICES.md)。

默认只收集当前平台中的指定源码目录和本地运行组件。**不收集** `data/`、`.agent-sync/`、`.git/`、本机 `launch-config.json`、旧快捷方式、SSH 私钥、Codex/GitHub 登录、会话、运行日志、PDF 和其它 Agent 目录。运行组件内部的用户数据目录也排除，不跟随链接或 junction。

安全包不包含原使用者的账号和服务器配置。它不是整台电脑或云端实例备份。源码中若另行手写了自己的私密内容，应先移到平台私有数据目录；导出规则不会理解任意文件里的业务秘密。

## 在目标 Windows 电脑打开

1. 完整解压到自己可写的本地文件夹，避免 `Program Files`、网络映射目录及链接目录。
2. 双击文件夹内的 `AutoDL研究台.exe`。不要从 ZIP 内直接启动，也不要只复制 EXE。
3. 首次准备缺失运行组件时保持联网；依赖准备好后打开研究台。轻量包需要下载更多内容，包含运行组件的包仍可能需要获取扩展或访问账号服务。
4. 按编辑器流程信任项目，配置本机代理（如需）、服务器 SSH 地址和远端项目目录。
5. 新设备生成专用密钥并登记公钥，首次 SSH 连接核对主机指纹；在本地 Codex 侧栏登录自己的账号。
6. 需要 GitHub 自动上传时，再为新机器选择仓库并完成 GitHub CLI 授权。分享包不会自动连接原使用者的仓库。

本地运行组件使用 `app/node/node.exe`、`app/vscode/Code.exe`、`app/git/cmd/git.exe`、`app/gh/bin/gh.exe`，启动器生成当前路径配置。平台数据存入该文件夹的 `data/`，GitHub 同步的私有信息位于 `.agent-sync/`。Windows 自身和外部应用可能记录自己的系统信息，不属于平台可重定向的存储。

[launch-config.example.json](launch-config.example.json) 是相对目录布局的参考，不是需要手动复制的安装步骤。实际 `launch-config.json` 由启动器生成，移动后按新位置重建。EXE、`launcher/`、`scripts/` 和其它平台文件必须一起保留。

如果只需准备依赖而不打开研究台：

```powershell
& '.\scripts\Bootstrap-Hub.ps1' -Root (Get-Location).Path -PrepareOnly
```

## 自己搬迁原有完整工作区

导出脚本始终生成安全分享包，没有默认携带凭据的模式。若只为本人迁移并希望保留连接、密钥和登录，可以先关闭研究台与同步器，再用自己的安全备份工具压缩**整个原文件夹**并私下传输。完整备份可能包含 SSH 私钥和账号登录，不应发送给他人或上传 GitHub。

完整复制时，`data/connection.json`、`data/ssh/`、`data/codex/` 和 `.agent-sync/` 等私有目录随文件夹保留；其中可能包含 Codex `auth.json`、GitHub CLI 登录与 SSH 私钥。启动器调整平台内部路径，不清除这些认证文件。安全导出则明确排除这些目录；两种迁移方式的用途不同。

解压后仍从新位置的 EXE 启动。依赖系统加密或设备状态的登录可能需要重新授权；不要将“文件已复制”当作“账号一定已登录”。旧 `.lnk` 可能指向原路径，直接使用新位置 EXE。

服务器研究代码、Conda 环境、模型、数据集与实验结果不会因为复制 Windows 文件夹而迁移。继续使用同一服务器，或另外安排云端备份和环境恢复。

## GitHub 与分发包不同

GitHub 自动同步继续只发布本平台源码和文档，排除运行组件、导出 ZIP 与个人数据。导出 ZIP 是本机生成的分发文件，不会自动上传为 GitHub Release，也不会改变仓库可见性。[完整发布范围](github-sync/PUBLISH-SCOPE.md)
