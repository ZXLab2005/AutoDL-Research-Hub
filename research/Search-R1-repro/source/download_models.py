"""Download public, revision-pinned upstream weights; never run inference here."""
import argparse
import json
import os
import pathlib
import shutil
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--model', choices=['retriever', 'searchr1', 'all'], default='all')
args = parser.parse_args()
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
os.environ.setdefault('HF_HOME', '/root/autodl-tmp/research-hub/cache/huggingface')
from huggingface_hub import snapshot_download
root = pathlib.Path('/root/autodl-tmp/research-hub/models')
root.mkdir(parents=True, exist_ok=True)
choices = {
    'retriever': ('intfloat/e5-base-v2', 'f52bf8ec8c7124536f0efb74aca902b2995e5bcd', 'e5-base-v2'),
    'searchr1': ('PeterJinGo/SearchR1-nq_hotpotqa_train-qwen2.5-3b-em-ppo-v0.2',
                 '1f8407f4b3723c8934e6ef4df0d9dea5391b9d59', 'searchr1-3b-v02'),
}
for key in (choices if args.model == 'all' else [args.model]):
    repo, revision, name = choices[key]
    url = f'https://huggingface.co/api/models/{repo}/revision/{revision}?blobs=true'
    with urllib.request.urlopen(url, timeout=60) as response:
        meta = json.load(response)
    files = [item for item in meta['siblings'] if '/' not in item['rfilename'] and
             item['rfilename'].endswith(('.json', '.safetensors', '.txt', '.model'))]
    target = root / name
    remaining = sum(item['size'] for item in files
                    if not (target / item['rfilename']).is_file() or
                    (target / item['rfilename']).stat().st_size != item['size'])
    if shutil.disk_usage(root).free < remaining + 3 * 1024**3:
        raise RuntimeError(f'Insufficient free space for {name}; need {remaining} bytes plus 3 GiB reserve')
    print(f'Downloading {repo}@{revision} to {target}', flush=True)
    snapshot_download(repo_id=repo, revision=revision, local_dir=str(target),
                      allow_patterns=[item['rfilename'] for item in files], token=False,
                      max_workers=1)
    for item in files:
        assert (target / item['rfilename']).stat().st_size == item['size'], item['rfilename']
    record = {'repo': repo, 'revision': revision, 'path': str(target),
              'status': 'FILES_DOWNLOADED_MODEL_NOT_YET_RUN',
              'bytes': sum(item['size'] for item in files)}
    (target / 'download-record.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record), flush=True)
