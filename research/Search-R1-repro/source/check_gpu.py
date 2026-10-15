"""A real GPU/FlashAttention dispatch witness, with no CPU fallback."""
import json
import pathlib
import sys
import torch

if not torch.cuda.is_available():
    print('GPU_REQUIRED: no CUDA GPU is visible; inference has not been validated.', file=sys.stderr)
    sys.exit(3)
from flash_attn import flash_attn_qkvpacked_func
torch.manual_seed(2026)
x = torch.randn(32, 32, device='cuda', dtype=torch.float16)
y = x @ x.T
qkv = torch.randn(1, 8, 3, 2, 32, device='cuda', dtype=torch.float16)
out = flash_attn_qkvpacked_func(qkv, dropout_p=0.0, causal=True)
torch.cuda.synchronize()
assert torch.isfinite(y).all() and torch.isfinite(out).all()
assert out.shape == (1, 8, 2, 32)
report = {'status': 'GPU_KERNELS_PASSED', 'device': torch.cuda.get_device_name(0),
          'torch': torch.__version__, 'cuda': torch.version.cuda,
          'flash_attention_shape': list(out.shape)}
pathlib.Path('repro/logs/gpu-check.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
