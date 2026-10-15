# 第三方来源与许可

根目录 [MIT License](LICENSE) 适用于 AutoDL 研究台的自有代码与文档，以下第三方改编文件保留各自许可。本项目不是 AutoDL、Microsoft、OpenAI 或 Search-R1 的官方产品。

## Search-R1 辅助脚本

上游项目为 [PeterGriffinJin/Search-R1](https://github.com/PeterGriffinJin/Search-R1)，本项目参考的固定提交为 `598e61bd1d36895726d28a8d06b3a15bed19f5d3`。

以下文件采用 **Apache-2.0**，而非根目录 MIT 许可：

| 本仓库文件 | 上游来源 | 本项目修改 |
| --- | --- | --- |
| `research/Search-R1-repro/source/infer_small.py` | [`infer.py`](https://github.com/PeterGriffinJin/Search-R1/blob/598e61bd1d36895726d28a8d06b3a15bed19f5d3/infer.py) | 本地模型路径、命令行参数、回合与上下文上限、GPU 检查及 JSON 验证记录。 |
| `research/Search-R1-repro/source/small_corpus_retriever.py` | [`search_r1/search/retrieval_server.py`](https://github.com/PeterGriffinJin/Search-R1/blob/598e61bd1d36895726d28a8d06b3a15bed19f5d3/search_r1/search/retrieval_server.py) | 动态加载上游实现、CPU/GPU 选择、小语料加载、有界请求及本机回环服务。 |

随仓库保留上游的 [Apache-2.0 许可证全文](research/Search-R1-repro/LICENSE-APACHE-2.0.txt) 和 [版权通知](research/Search-R1-repro/NOTICE-Search-R1.txt)。改编文件已标注来源和修改说明；并未复制完整 Search-R1 工程、模型权重或数据集。

## 外部运行组件与服务

运行时可能从官方渠道获取 Node.js、Git、GitHub CLI、OpenSSH、Microsoft VS Code 及扩展。这些组件不包含在 GitHub 源码仓库中，分别适用其原有许可和服务条款。Codex 账号、模型服务及模型/数据集的使用权也不由本项目 MIT 许可授予。

公开分享使用源码或 `Export-Portable.ps1 -NoRuntime` 生成的轻量包。包含已下载运行组件的完整包仅用于本人迁移，不作为本项目公开发行内容。尤其 Microsoft 发行的 VS Code 与 Code - OSS 源码具有不同的许可范围，参见 [VS Code 产品条款](https://code.visualstudio.com/license)。
