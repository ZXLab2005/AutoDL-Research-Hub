# Search-R1 部署记录与辅助脚本

这里保留 AutoDL 研究台此次部署的辅助脚本和验收记录，便于 GitHub 同步与后续复查。**这里不是官方 Search-R1 源码，也不包含模型权重、数据集、Conda 环境二进制或认证文件。**

官方项目：[PeterGriffinJin/Search-R1](https://github.com/PeterGriffinJin/Search-R1)，本次检出提交：`598e61bd1d36895726d28a8d06b3a15bed19f5d3`。

`source/infer_small.py` 和 `source/small_corpus_retriever.py` 保留 [Apache-2.0 许可](LICENSE-APACHE-2.0.txt) 与 [上游版权通知](NOTICE-Search-R1.txt)。具体改编范围见 [第三方说明](../../THIRD_PARTY_NOTICES.md)。许可证与通知独立于下方辅助文件数量。

- `source/`：7 个辅助脚本和使用指南，共 8 份正式文件；其中 `gpu_witness.py` 为旧候选脚本，不纳入。
- `verification/`：8 份已验收快照，保留原来的 `.aris/`、`repro/` 相对结构，包括环境规范、CPU 检查结果和 Conda/pip 版本清单。
- 原始文件仍保留在本机研究台的 `data/temp/search-r1-repro/` 与 `data/search-r1-verification/`；本目录是为可发布源码范围保全的副本。

## 使用与实际验证范围

请先获得官方仓库的上述提交，再将 `source/` 的文件复制到官方项目的 `repro/` 下，按 [使用指南](source/README.md) 配置实际服务器路径。需要比对或重建依赖时参考 [环境规范](verification/repro/env-spec.json) 和冻结清单。脚本包含本次 AutoDL 数据盘的默认路径，迁移服务器时需核对路径。

已验收：`searchr1` 与 `retriever` 环境的依赖和 CPU 功能检查。未验收：GPU 内核、官方模型检索推理、准确率评测和论文规模训练。两份 CPU JSON 是历史检查快照，不是实时健康状态；迁移后需重新执行验证命令。

复制时对 16 份来源文本做了常见认证令牌、私钥和 URL 内嵌凭据模式检查，未发现匹配项；最终发布仍以仓库的完整安全检查为准。
