"""CPU witnesses for installed dependencies; does NOT claim model/GPU reproduction."""
import argparse
import importlib
import importlib.metadata
import json
import pathlib
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--env', choices=['searchr1', 'retriever'], required=True)
args = parser.parse_args()
expected_prefix = pathlib.Path('/root/autodl-tmp/research-hub/envs') / args.env
assert pathlib.Path(sys.prefix).resolve() == expected_prefix.resolve(), 'Activate the documented environment first'
assert sys.version_info[:2] == ((3, 9) if args.env == 'searchr1' else (3, 10))
path = pathlib.Path('repro/logs') / f'{args.env}-cpu-check.json'
path.unlink(missing_ok=True)
pins = {'torch': '2.4.0', 'transformers': '4.46.3', 'datasets': '2.21.0', 'numpy': '1.26.4', 'accelerate': '1.1.1'}
pins.update({'vllm': '0.6.3', 'flash-attn': '2.7.4.post1', 'tensordict': '0.5.0', 'ray': '2.40.0'}
            if args.env == 'searchr1' else {'faiss-cpu': '1.8.0.post1', 'fastapi': '0.115.6', 'uvicorn': '0.32.1'})
for package, version in pins.items():
    assert importlib.metadata.version(package).split('+')[0] == version, f'Version mismatch: {package}'
import torch
torch.set_num_threads(1)
torch.manual_seed(2026)
x = torch.randn(8, 8)
y = x @ x.T
assert y.shape == (8, 8) and torch.isfinite(y).all()
report = {'environment': args.env, 'python': sys.version.split()[0],
          'executable': sys.executable, 'torch': torch.__version__,
          'cuda_available': torch.cuda.is_available(),
          'cpu_matmul': {'shape': list(y.shape), 'trace': y.trace().item()},
          'scope': 'dependency and CPU kernel checks only', 'packages': {},
          'installed_versions': {name: importlib.metadata.version(name) for name in pins}}
modules = ['transformers', 'datasets', 'accelerate']
if args.env == 'searchr1':
    modules += ['vllm', 'flash_attn', 'tensordict', 'ray', 'hydra', 'wandb', 'peft', 'verl']
else:
    modules += ['faiss', 'fastapi', 'uvicorn']
for name in modules:
    module = importlib.import_module(name)
    report['packages'][name] = str(getattr(module, '__version__', 'imported'))
if args.env == 'searchr1':
    from transformers import Qwen2Config, Qwen2ForCausalLM
    model = Qwen2ForCausalLM(Qwen2Config(vocab_size=32, hidden_size=32,
        intermediate_size=64, num_hidden_layers=1, num_attention_heads=2,
        num_key_value_heads=2, max_position_embeddings=32))
    with torch.no_grad():
        logits = model(torch.tensor([[1, 2, 3, 4]])).logits
    assert logits.shape == (1, 4, 32) and torch.isfinite(logits).all()
    report['random_tiny_qwen_kernel'] = list(logits.shape)
    from tensordict import TensorDict
    batch = TensorDict({'tokens': torch.tensor([[1, 2], [3, 4]])}, batch_size=[2])
    from verl import DataProto
    assert DataProto(batch=batch).batch['tokens'].shape == (2, 2)
    report['verl_dataproto'] = 'passed'
else:
    import faiss
    import numpy as np
    index = faiss.IndexFlatIP(2)
    index.add(np.array([[1, 0], [0, 1], [-1, 0]], dtype=np.float32))
    distances, ids = index.search(np.array([[1, 0]], dtype=np.float32), 1)
    assert ids[0, 0] == 0 and distances[0, 0] == 1
    report['faiss_exact_search'] = 'passed'
subprocess.run([sys.executable, '-m', 'pip', 'check'], check=True)
report['status'] = 'CPU_CHECKS_PASSED'
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
