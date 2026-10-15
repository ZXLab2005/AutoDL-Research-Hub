# AutoDL Search-R1 环境记录

状态：依赖安装和 CPU 功能检查完成；GPU 内核、官方模型检索推理和准确率评测未验证。
本次用户范围：环境和界面；不下载模型权重，不切换或启动 GPU。
文档复核：新的独立代理已按 repro/README.md 的两段 CPU 命令逐字顺序执行，两次退出码均为 0，均返回 CPU_CHECKS_PASSED。

验证时间（UTC）：2026-10-04T15:39:12.476888+00:00
代码提交：598e61bd1d36895726d28a8d06b3a15bed19f5d3
规范：repro/env-spec.json；canonical JSON SHA256 前 8 位：230047fc

资源：AutoDL 无卡实例，CPU 配额 0.5 核、内存 2 GiB；不以宿主机可见资源替代容器配额。
缓存：/root/autodl-tmp/research-hub/cache；模型目录尚未填充。
代理注意：国内清华镜像同时设置 NO_PROXY 和 no_proxy=.tsinghua.edu.cn 等排除项；只设置大写会被继承的小写变量覆盖。
FlashAttention 使用官方 GitHub 预编译 cu12/torch2.4/ABI-FALSE/cp39 wheel，已核对官方大小和传输前后 SHA256；上游 API 未提供独立 digest。

## env: searchr1@230047fc

Conda prefix：/root/autodl-tmp/research-hub/envs/searchr1
Python：3.9.25；Torch：2.4.0+cu121；cuda_available：False
CPU 报告：repro/logs/searchr1-cpu-check.json；冻结清单：repro/searchr1-pip-freeze.txt
检查：依赖导入、固定版本断言、pip check、种子 2026 的 CPU 矩阵运算；随机微型 Qwen 前向与 VERL DataProto。

按文档在服务器运行：
```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh searchr1
python -B repro/check_env.py --env searchr1
```

## env: retriever@230047fc

Conda prefix：/root/autodl-tmp/research-hub/envs/retriever
Python：3.10.22；Torch：2.4.0+cu121；cuda_available：False
CPU 报告：repro/logs/retriever-cpu-check.json；冻结清单：repro/retriever-pip-freeze.txt
检查：依赖导入、固定版本断言、pip check、种子 2026 的 CPU 矩阵运算；三向量 FAISS 精确内积搜索。

按文档在服务器运行：
```bash
cd /root/autodl-tmp/research-hub/projects/Search-R1
source repro/activate.sh retriever
python -B repro/check_env.py --env retriever
```

## 后续 GPU 验证

GPU 可见后先按 repro/README.md 执行 python -B repro/check_gpu.py，只有实际 CUDA/FlashAttention 内核通过后才验证官方模型。
模型权重下载、E5 小语料服务与推理调用见 repro/README.md；下载成功、生成答案均不等于论文准确率复现。

精确 Conda 包列表：repro/searchr1-conda-explicit.txt、repro/retriever-conda-explicit.txt；与 pip freeze 配合留存。
