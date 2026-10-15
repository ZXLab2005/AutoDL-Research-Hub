#!/usr/bin/env bash
# Source this file: source repro/activate.sh [searchr1|retriever]
_sr1_env=${1:-searchr1}
case "$_sr1_env" in searchr1|retriever) ;; *) printf 'Use searchr1 or retriever\n' >&2; return 2 ;; esac
export CONDA_ENVS_PATH=/root/autodl-tmp/research-hub/envs
export HF_HOME=/root/autodl-tmp/research-hub/cache/huggingface
export TMPDIR=/root/autodl-tmp/research-hub/tmp
export PIP_CACHE_DIR=/root/autodl-tmp/research-hub/cache/pip
export OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 MKL_NUM_THREADS=1
export WANDB_MODE=offline HF_HUB_DISABLE_TELEMETRY=1
export NO_PROXY=localhost,127.0.0.1,.tsinghua.edu.cn
export no_proxy="$NO_PROXY"
source /root/miniconda3/etc/profile.d/conda.sh || return $?
conda activate "$CONDA_ENVS_PATH/$_sr1_env" || return $?
cd /root/autodl-tmp/research-hub/projects/Search-R1 || return $?
unset _sr1_env
