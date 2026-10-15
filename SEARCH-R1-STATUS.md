# Search-R1 本次交付状态

2026-10-04：环境与实时研究界面已完成。GPU 推理按用户要求留待后续；没有下载官方模型权重，没有进行训练或论文准确率复现。

| 项目 | 实际结果 |
| --- | --- |
| 官方源码 | `PeterGriffinJin/Search-R1`，提交 `598e61bd1d36895726d28a8d06b3a15bed19f5d3`；上游已跟踪源码无修改 |
| 服务器工程 | `/root/autodl-tmp/research-hub/projects/Search-R1` |
| searchr1 环境 | Python 3.9.25、PyTorch 2.4.0+cu121、Transformers 4.46.3、vLLM 0.6.3、FlashAttention 2.7.4.post1 |
| retriever 环境 | Python 3.10.22、PyTorch 2.4.0+cu121、Transformers 4.46.3、FAISS CPU 1.8.0.post1、FastAPI 0.115.6 |
| 两环境位置 | `/root/autodl-tmp/research-hub/envs/searchr1`、`/root/autodl-tmp/research-hub/envs/retriever` |
| CPU 功能检查 | 两环境均返回 `CPU_CHECKS_PASSED`；pip check 无依赖冲突；包含实际 CPU 矩阵运算、微型随机 Qwen 前向、VERL 数据结构及 FAISS 搜索 |
| 独立复核 | 新代理按指南逐字顺序执行两段 CPU 检查，均退出 0；脚本与输出留在 E 盘 `data/temp/doc-check-*` |
| GPU 状态 | `cuda_available=false`；未执行 CUDA/FlashAttention GPU 内核、官方模型推理、真实 E5 语料检索或准确率评测 |
| 研究台界面 | 1.1.0 已安装并核对源文件；85 项测试通过，真实 SSH 文件新增/修改/删除联调通过 |
| 规范记录 | `repro/env-spec.json` 的 canonical JSON SHA256 前 8 位为 `230047fc`；远端 `.aris/compute/autodl.md` 记录验证范围 |

现在打开 [研究台入口](../打开AutoDL研究台.cmd)。已有的旧 VS Code 窗口请按 `Ctrl+Shift+P`，执行“开发人员: 重新加载窗口”，再打开“AutoDL：打开研究台”。新首页会显示最近操作与远端文件变化；此监视仅在页面可见时运行。原生窗口工具未能取得本次截图，因此没有把安装确认当作当前窗口外观已确认。

使用方法见 [Search-R1 环境指南](SEARCH-R1-GUIDE.md) 和 [实时界面说明](LIVE-UI-GUIDE.md)。研究台默认共享目录仍为 `projects`，在其中进入 `Search-R1`；每个独立终端按指南激活对应环境。

原始验证报告、精确 Conda 包列表、pip 冻结清单与环境记录已按 SHA256 核对并保存到本机 `data/search-r1-verification/`。这些是审计记录副本，研究代码和运行环境仍在服务器上。本地新增平台文件均位于 E 盘。

独立复核记录见 [文档执行复核](data/temp/doc-check-review.md)。vLLM 的提交元数据警告导致模块自报版本为 `dev`，但已核对安装分发版本与冻结清单均为 `0.6.3`；FAISS 模块自报 `1.8.0`，分发版本为 `1.8.0.post1`。两者均未影响本次 CPU 检查，GPU 能力仍待后续实测。

主要报告：

- [主环境 CPU 检查](data/search-r1-verification/repro/logs/searchr1-cpu-check.json)
- [检索环境 CPU 检查](data/search-r1-verification/repro/logs/retriever-cpu-check.json)
- [实际环境记录](data/search-r1-verification/.aris/compute/autodl.md)
- [实时监视真实联调](data/temp/live-integration-report.json)
