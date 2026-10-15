# AutoDL 远端配置

默认方式已切换为 Windows 本地 Codex + 免密 SSH：在本地控制台通过 scripts/Invoke-AutoDL.ps1 操作 AutoDL，服务器无需安装或登录 Codex。请先按 README.md 使用。本文保留远端环境与可选远端 Codex 的参考说明；只有明确选择远端 Codex 模式时才进行其安装和登录步骤。研究代码、Python 和训练在 AutoDL，本地配置、扩展、密钥、缓存和临时文件放在平台目录。

当前实例已在 2026-10-02 完成免密认证和远端准备，下面“首次连接”用于新增或重建实例。已保存地址为 `root@your-ssh-host.example:YOUR_SSH_PORT`。日常默认回到本地 Codex 控制台，经 SSH 操作工程，无需重复登记公钥；需要远端下载或明确选择远端 Codex CLI 时，再按需启用代理隧道。

## 首次连接

1. 在 AutoDL 控制台开启已有实例，复制当前 SSH 登录命令。实例关机时无法完成 SSH 或免密登录验证。
2. 在平台保存 SSH 地址、端口、用户名。密码只在 SSH 的交互提示中输入，不放进连接配置或聊天。
3. 把平台生成的公钥添加到 AutoDL 的「设置 SSH 免密登录」，或者用首次密码登录将公钥追加到远端 `~/.ssh/authorized_keys`。公钥与私钥不同；私钥留在平台目录。
4. 首次连接核对服务器主机指纹后接受；平台的 `known_hosts` 保存在平台目录。重新安装或更换实例导致指纹变化时，先确认实例身份。

AutoDL 控制台配置了公钥不等于已经验证免密成功；需在开机后实际通过一次 SSH 登录。

## 准备远端目录

`remote/bootstrap.sh` 是供 AutoDL 上的 Bash 执行的脚本。它不会启动实例、安装软件或复制登录凭据。默认目录为当前远端用户的 `$HOME/autodl-tmp/research-hub`；root 用户对应 `/root/autodl-tmp/research-hub`。可用 `--root` 指定其他专用目录。

脚本会创建 `projects`、`outputs`、`tmp`、`cache`、`codex`、`vscode-server`，并写入专用 `env.sh`。为使远端扩展进程获得环境变量，它在远端 `~/.bashrc` 开头添加一条有标记的加载语句，保留原有内容并保存首次备份。重复运行不会重复添加语句。其他 shell、已有符号链接配置或其他平台占用的 `env.sh` 会使脚本停止，不覆盖原配置。

在平台根目录打开 PowerShell，使用当前目录生成配置路径。别名须与平台保存的连接一致：

```powershell
$hubRoot = (Get-Location).Path
$sshConfig = Join-Path $hubRoot 'data\ssh\config'
$hostAlias = 'autodl-research'
$bootstrapFile = Join-Path $hubRoot 'remote\bootstrap.sh'

# scp 按原始字节传输，避免 Windows PowerShell 5 文本管道的编码转换。
scp -F $sshConfig $bootstrapFile "${hostAlias}:autodl-research-hub-bootstrap.sh"
if ($LASTEXITCODE -ne 0) { throw '上传失败，尚未执行远端配置。' }
ssh -F $sshConfig $hostAlias 'bash ~/autodl-research-hub-bootstrap.sh'
if ($LASTEXITCODE -ne 0) { throw '远端配置失败，请查看 SSH 输出。' }
```

源脚本应保持 UTF-8 无 BOM、LF 换行。平台中直接运行 `ssh` 时，也可以用进程的标准输入按 UTF-8 字节传入 LF 脚本并执行 `bash -s --`；不要用 Windows PowerShell 5 的 `Get-Content | ssh` 文本管道传输脚本。

在本地 VS Code 用户设置中，服务器安装路径应按**准确的 SSH 别名**映射；以下以 root 用户为例；本机 `remote.SSH.configFile` 由启动器按当前平台目录自动生成，不需要填写固定盘符：

```json
{
  "remote.SSH.remotePlatform": { "autodl-research": "linux" },
  "remote.SSH.localServerDownload": "always",
  "remote.SSH.serverInstallPath": {
    "autodl-research": "/root/autodl-tmp/research-hub/vscode-server"
  }
}
```

改变环境变量之后，先保存文件、结束需要保留的交互式终端任务，再用 VS Code 的 `Remote-SSH: Kill VS Code Server on Host...` 停止该主机的服务并重新连接。这个动作会关闭该主机现有 VS Code 连接，长时间训练应先用 `tmux` 或任务调度器托管。

## 使用本机 Clash 代理

本机 Clash 地址为 `127.0.0.1:7897`。AutoDL 上的 `127.0.0.1` 指 AutoDL 本身，因此需要平台的独立反向隧道把远端回环端口转到本机 Clash：

```powershell
ssh -F $sshConfig -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:17897:127.0.0.1:7897 $hostAlias
```

保持这条连接运行。不要把相同 `RemoteForward` 写进所有 VS Code SSH 连接共用的主机配置，多个 SSH 进程会争用同一个远端端口。绑定地址使用 `127.0.0.1`，无需开启 Clash 的局域网访问。

需要代理时，用另一个终端重新运行配置：

```powershell
ssh -F $sshConfig $hostAlias 'bash ~/autodl-research-hub-bootstrap.sh --proxy-port 17897'
```

然后按上节重启远端 VS Code 服务。脚本为远端进程设置 `HTTP_PROXY`、`HTTPS_PROXY` 及对应的小写变量。隧道断开时，依赖此代理的请求会失败；重新开启隧道即可。再次运行脚本且不带 `--proxy-port` 会移除平台 env.sh 中的代理设置，现有进程仍需重启。

仅设置 `terminal.integrated.env.linux` 不足以配置 Codex 扩展进程的代理；终端环境和扩展主机环境是不同的。不要将 Clash 地址填作 OpenAI API 的 `base_url`，它是网络代理地址。

## 可选：远端 Codex CLI

默认仍在 Windows 本地控制台使用 Codex，通过 SSH 操作研究工程。只有主动选择远端模式时，才使用本节入口；这是 SSH 终端中的 CLI，不会自动安装远端 IDE Codex 扩展，也不会设置 `remote.extensionKind` 强制改变扩展运行位置。

1. 在本地研究台点击“安装并启动远端 Codex”，或双击平台内的 `Start-Remote-Codex.cmd`。入口显示已保存的主机、端口和工程目录，然后调用 `scripts/Start-RemoteCodex.ps1`。
2. 脚本安装或复用远端 CLI，工具位于所选 `RemoteRoot/tools/codex`。默认优先使用 AutoDL 的 `$HOME/autodl-tmp/research-hub`，其他 Linux 主机使用 `$HOME/.local/share/autodl-research-hub`。独立的 `CODEX_HOME` 为 `RemoteRoot/codex-remote`，与此前环境准备脚本的 `codex` 目录分开。
3. 按用户授权自动准备登录：远端已有可识别的登录状态时直接复用；否则检测平台私有目录、启动器保存的原始 `CODEX_HOME` / Windows 用户目录，以及实际 Windows 用户目录中的 `auth.json`。找到可用来源后，经 SSH 标准输入同步到远端独立 `CODEX_HOME`；远端目录权限 700、文件权限 600。原用户目录来源仅只读，新增平台文件写入当前平台目录。
4. 凭据内容不会显示在聊天、终端或日志中，不进入研究项目或缓存，也不复制其他凭据。没有可用本机登录来源时，才进入设备码登录。
5. 登录准备后，脚本验证并进入 `connection.remotePath`，成功才启动交互 CLI。首次任务让它执行 `pwd`、`hostname` 等，确认研究目标。退出 Codex 或 SSH 终端不保证终止已经独立运行的训练任务。

“更新远端 Codex”调用 `-Update -InstallOnly`，只显式更新工具。脚本支持：

- 默认：安装或复用、准备登录、进入研究目录并启动 CLI。
- `-InstallOnly`：仅安装。
- `-Update -InstallOnly`：显式更新。
- `-PrepareOnly`：安装和准备登录，不提示登录、不调用模型。
- `-RemoteRoot`：选择其他 Linux 独立安装目录。
- `-AuthFile`：显式选择只读本机登录文件；不要把该文件的内容粘贴到聊天中。

新服务器仍要先登记 SSH 公钥，核对并保存主机指纹。一键入口不会自动信任未知主机，不会自动开关机、租赁或购买算力。启用远端代理时，入口确保后台隧道就绪；Clash 与本机网络仍需可用。


## 配置依据

- [VS Code Portable 模式](https://code.visualstudio.com/docs/setup/portable)：ZIP 版的 `data` 存储编辑器状态与扩展，`data/tmp` 存储临时数据。
- [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh)：远端工作区、扩展位置、本地下载服务器和网络要求。
- [Remote SSH 代理环境](https://code.visualstudio.com/docs/remote/troubleshooting#_set-httpproxy--httpsproxy-on-the-remote-host)：通过远端 `.bashrc` 设置代理。
- [服务器安装目录配置](https://github.com/microsoft/vscode-docs/blob/main/remote-release-notes/v1_63.md)：`remote.SSH.serverInstallPath` 使用主机到绝对路径的映射。
- [Codex 环境变量](https://learn.chatgpt.com/docs/config-file/environment-variables)：`CODEX_HOME` 适用于 CLI、IDE 扩展与 app-server，目录需预先存在。
- [Codex 登录](https://learn.chatgpt.com/docs/auth)：远端设备码登录和凭据存储。
- [Codex IDE 扩展](https://learn.chatgpt.com/docs/codex/ide)：编辑器内使用 Codex。
- [OpenSSH 端口转发](https://man.openbsd.org/ssh)：`-R` 的反向转发与监听地址。

`~/.vscode-server/server-env-setup` 的官方文档适用于 WSL；本平台不把它作为 Remote SSH 的环境加载机制。

## 当前 AutoDL 的沙箱限制

已验证远端 Codex 的登录文件识别和一次真实模型调用，但这个 AutoDL 容器禁止创建 Linux namespace，直接沙箱命令返回 bwrap 权限错误。启动远端 CLI 时会进行沙箱自检并提示；平台不关闭沙箱、不修改内核或审批设置。

在远端交互模式中，如需运行受限命令，让 Codex 为具体命令申请一次批准；是否能够获准在沙箱外执行由当前权限策略决定。这一步尚未在当前实例中实际批准验证。默认 Windows Codex + SSH 的远端命令执行已验证通过，可继续使用。

参考：[官方沙箱与审批说明](https://learn.chatgpt.com/docs/agent-approvals-security)。
