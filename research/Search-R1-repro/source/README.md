> 此目录保存本项目的部署记录与复现实验辅助脚本，不是官方 Search-R1 源码。请配合 [官方仓库](https://github.com/PeterGriffinJin/Search-R1) 的提交 `598e61bd1d36895726d28a8d06b3a15bed19f5d3` 使用，将本目录中的脚本放到官方项目的 `repro/` 下再执行。验收快照保存在旁边的 `../verification/`；历史 CPU 检查通过不等于当前主机、GPU 推理或论文结果已通过。

# Search-R1 环境与小规模验证指南

本次交付范围是独立 Conda 环境、依赖检查和研究台界面。GPU 模型推理、正式准确率评测与训练留待后续。以下命令中的成功状态是检查程序的判定条件，实际结果以 `repro/logs/` 中最近一次运行记录为准；此文档本身不代表检查已通过。

项目来自 [Search-R1 官方仓库](https://github.com/PeterGriffinJin/Search-R1)，检出提交 `598e61bd1d36895726d28a8d06b3a15bed19f5d3`。辅助脚本放在 `repro/`，用于资源受限时的依赖验证和后续小语料检索推理。它们不等于论文的完整训练或完整 Wikipedia 检索评测。

## 路径与环境

| 内容 | 服务器位置 |
| --- | --- |
| 项目代码 | `/root/autodl-tmp/research-hub/projects/Search-R1` |
| 推理与研究环境 | `/root/autodl-tmp/research-hub/envs/searchr1`，Python 3.9 |
| 检索服务环境 | `/root/autodl-tmp/research-hub/envs/retriever`，Python 3.10 |
| Conda、pip、Hugging Face 缓存 | `/root/autodl-tmp/research-hub/cache/` |
| 临时文件 | `/root/autodl-tmp/research-hub/tmp/` |
| 后续模型文件 | `/root/autodl-tmp/research-hub/models/` |
| 安装与验证记录 | 项目内 `repro/logs/` |

本机平台位于你解压的 `AutoDL-Research-Hub` 文件夹，平台相关配置、扩展、SSH 文件和日志集中在该文件夹内。研究代码与 Conda 环境在 AutoDL 上，两者不需要复制成两份才能一起使用。

关键版本目标包括 PyTorch 2.4.0、Transformers 4.46.3、vLLM 0.6.3、FlashAttention 2.7.4.post1，以及检索环境中的 FAISS CPU 1.8.0.post1。完整安装目标查看 `repro/env-spec.json`，实际安装版本查看依赖检查报告及安装生成的冻结清单。

## 打开项目与终端

先保证 AutoDL 实例已运行，然后双击平台根目录内的 `AutoDL研究台.exe` 打开研究台（也可运行 `Start-Research-Hub.cmd`）。连接远端研究目录，在资源管理器中打开 `Search-R1` 文件夹。使用研究台“项目终端”或连接成功后的远端 Bash 终端执行下列命令。

所有 Bash 示例都在服务器执行。若终端标注“install－本地”或提示 shell 正在本地运行，应先完成 Remote SSH 连接，再创建远端项目终端。

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh searchr1
pwd
python --version
```

`pwd` 应为上述项目目录。激活脚本会选择完整路径的 Conda 环境，设置数据盘缓存、单线程计算参数和离线 W&B 模式，不会激活基础环境来安装研究依赖。

## 不需要 GPU 的依赖检查

按顺序执行，避免在低内存实例上同时运行两份检查。

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh searchr1
python -B repro/check_env.py --env searchr1
```

成功时会打印 JSON，其中 `status` 为 `CPU_CHECKS_PASSED`，`environment` 为 `searchr1`，并写入 `repro/logs/searchr1-cpu-check.json`。检查内容包括依赖导入、`pip check`、CPU 矩阵运算、随机初始化的微型 Qwen 前向计算和 VERL 数据结构；没有加载官方模型权重。

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh retriever
python -B repro/check_env.py --env retriever
```

成功时 `status` 为 `CPU_CHECKS_PASSED`，`environment` 为 `retriever`，报告保存在 `repro/logs/retriever-cpu-check.json`。它检查依赖、CPU 运算和三条人工向量的 FAISS 精确搜索，不代表 E5 编码或真实语料检索已经跑通。

无卡模式下 `cuda_available: false` 是预期结果。若命令失败，先看当前终端异常和 `repro/logs/install.log`；不要把以前遗留的成功 JSON 当成这次运行结果。

## 后续：下载官方模型

这次暂不下载模型权重、不启动 GPU 推理。准备实际验证时再运行本节。下载脚本固定公开模型的版本，只下载所需根目录权重与配置，完成后记录文件大小校验结果；下载成功不代表模型已运行。

若服务器访问 Hugging Face 需要本机代理，先在研究台启动代理隧道，并在这个远端终端设置：

```bash
export HTTP_PROXY=http://127.0.0.1:17897
export HTTPS_PROXY=http://127.0.0.1:17897
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
```

该地址是服务器上的 SSH 转发端口。它要求本机代理与隧道仍在运行。

只准备 CPU 小语料检索时，可先下载约 438 MB 的 E5 权重：

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh retriever
python -B repro/download_models.py --model retriever
```

后续准备 GPU 推理时，再下载作者发布的模型：

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh searchr1
python -B repro/download_models.py --model searchr1
```

也可使用 `--model all` 下载两者。作者模型仓库中的权重文件合计约 13.6 GB；不能按运行时 BF16 占用估算下载空间。脚本会检查剩余磁盘空间并保留至少 3 GiB 余量。

| 参数 | 固定来源 | 下载目录 |
| --- | --- | --- |
| `retriever` | `intfloat/e5-base-v2`，版本 `f52bf8ec8c7124536f0efb74aca902b2995e5bcd` | `/root/autodl-tmp/research-hub/models/e5-base-v2` |
| `searchr1` | `PeterJinGo/SearchR1-nq_hotpotqa_train-qwen2.5-3b-em-ppo-v0.2`，版本 `1f8407f4b3723c8934e6ef4df0d9dea5391b9d59` | `/root/autodl-tmp/research-hub/models/searchr1-3b-v02` |

成功时模型目录中的 `download-record.json` 会记录 `FILES_DOWNLOADED_MODEL_NOT_YET_RUN`。

## 后续：CPU 小语料检索

`small_corpus_retriever.py` 复用上游检索器和池化逻辑，通过适配器支持 CPU 编码与小型 JSONL 语料。默认单线程、批量 2，适用于小资源环境中的小规模尝试；E5 模型尚需先按上节下载。内存不足时可把 `--batch-size` 改成 `1`。

建立最多 100 条语料的索引：

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh retriever
python -B repro/small_corpus_retriever.py \
  --repo /root/autodl-tmp/research-hub/projects/Search-R1 \
  --model /root/autodl-tmp/research-hub/models/e5-base-v2 \
  --corpus example/corpus.jsonl \
  --output repro/small-index \
  --mode build --device cpu --limit 100 --batch-size 2
```

用相同参数将 `--mode build` 换成 `--mode check`，并添加 `--query 'What is the topic of this passage?'`，即可做一次真实 E5 检索功能检查。成功会打印 `status: PASS`、检索结果与分数；这不是准确率评测。

启动提供给 Search-R1 的检索服务：

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh retriever
python -B repro/small_corpus_retriever.py \
  --repo /root/autodl-tmp/research-hub/projects/Search-R1 \
  --model /root/autodl-tmp/research-hub/models/e5-base-v2 \
  --corpus example/corpus.jsonl \
  --output repro/small-index \
  --mode serve --device cpu --limit 100 --batch-size 2 --port 8000
```

保持该终端运行。服务仅监听服务器的 `127.0.0.1:8000`，提供 `GET /health` 和 `POST /retrieve`；本机浏览器不能直接用该地址访问远端服务。当前适配器在 `build`、`check`、`serve` 三种模式下都会重新编码所选的小语料并写入索引，因此不必先单独执行 `build` 才能 `serve`。按 `Ctrl+C` 结束服务。

## 后续：GPU 检查与一次检索推理

需要你后续提供可见 CUDA GPU，再执行以下命令；本次不自动切换实例或购买 GPU。

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh searchr1
python -B repro/check_gpu.py
```

该程序实际执行 CUDA 矩阵运算和 FlashAttention 内核。无 GPU 时退出码为 `3`，提示 `GPU_REQUIRED`；只有真实执行成功才打印 `GPU_KERNELS_PASSED`，并写入 `repro/logs/gpu-check.json`。

保持上节检索服务运行，在另一个远端终端执行：

```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh searchr1
python -B repro/infer_small.py \
  --model /root/autodl-tmp/research-hub/models/searchr1-3b-v02 \
  --question 'What is the capital of France?' \
  --retriever-url http://127.0.0.1:8000/retrieve \
  --output repro/logs/inference-small.json \
  --max-turns 4 --max-new-tokens 512 --max-context 4096 \
  --seed 42 --temperature 0
```

可将问题换成示例语料中能找到答案的问题。该脚本只读本地模型目录，不会偷偷下载权重，也不会在无 GPU 时转为 CPU 推理。结果记录生成文本、检索调用、返回文档与答案。`ANSWER_GENERATED_NOT_ACCURACY_VALIDATED` 仅表示生成了答案；是否调用检索看 `search_calls`。未完成、上下文达到上限或没有生成答案时会记录对应状态，不能据此宣称论文结果已复现。

## 在实时研究台查看操作

Windows Codex 通过本平台 `scripts/Invoke-AutoDL.ps1` 运行的 SSH 调用会进入操作列表。服务器文件变动可在研究台“LIVE / 实时研究动态”查看。详细说明在平台根目录下的 `LIVE-UI-GUIDE.md`。

安装使用后台任务时，某次 SSH 调用成功只说明命令已返回；安装是否结束仍需检查 `repro/logs/install.stage`、`repro/logs/install.exit` 和 `repro/logs/install.log`。
