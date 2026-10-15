#!/usr/bin/env python3
"""Bounded Search-R1 inference adapted from the official infer.py.

SPDX-License-Identifier: Apache-2.0
Upstream: PeterGriffinJin/Search-R1, commit
598e61bd1d36895726d28a8d06b3a15bed19f5d3, infer.py.
Modified for local checkpoints, bounded generation, CLI arguments and JSON
verification reports. See ../LICENSE-APACHE-2.0.txt and /THIRD_PARTY_NOTICES.md.

Defaults to the author's 3B PPO v0.2 checkpoint; output is a functional witness,
not paper accuracy or a full Wikipedia benchmark. Requires a visible GPU.
Model must already be downloaded to a local path (no hidden large downloads).
"""
import argparse
import json
import re
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--question", required=True)
    parser.add_argument("--retriever-url", default="http://127.0.0.1:8000/retrieve")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-turns", type=int, default=4)
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--max-context", type=int, default=4096)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--temperature", type=float, default=0.0)
    args = parser.parse_args()
    if not args.model.is_dir():
        parser.error("Download the official checkpoint first, then pass its local directory")
    if not 1 <= args.max_turns <= 16 or not 1 <= args.max_new_tokens <= 2048:
        parser.error("max-turns must be 1..16 and max-new-tokens 1..2048")
    if args.max_context <= args.max_new_tokens or args.temperature < 0:
        parser.error("max-context must exceed max-new-tokens; temperature must be nonnegative")
    import requests
    import torch
    import transformers
    if not torch.cuda.is_available():
        raise SystemExit("BLOCKED_NO_GPU: this environment has no visible CUDA GPU; "
                         "dependencies can be validated, but 3B model inference was not run")
    transformers.set_seed(args.seed)
    tokenizer = transformers.AutoTokenizer.from_pretrained(str(args.model), local_files_only=True)
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    model = transformers.AutoModelForCausalLM.from_pretrained(
        str(args.model), local_files_only=True, torch_dtype=dtype, low_cpu_mem_usage=True,
        device_map={"": "cuda:0"}).eval()

    class StopAfterSearch(transformers.StoppingCriteria):
        def __init__(self):
            self.tails = [tokenizer.encode(tail, add_special_tokens=False) for tail in
                          ["</search>", " </search>", "</search>\n", " </search>\n",
                           "</search>\n\n", " </search>\n\n"]]

        def __call__(self, input_ids, scores, **kwargs):
            return any(len(tail) <= input_ids.shape[1] and
                       input_ids[0, -len(tail):].tolist() == tail for tail in self.tails)

    prompt = ("Answer the given question. You must conduct reasoning inside <think> and "
              "</think> first every time you get new information. After reasoning, if you "
              "find you lack some knowledge, you can call a search engine by <search> query "
              "</search> and it will return the top searched results between <information> "
              "and </information>. You can search as many times as your want. If you find "
              "no further external knowledge needed, you can directly provide the answer "
              "inside <answer> and </answer>, without detailed illustrations. For example, "
              "<answer> Beijing </answer>. Question: " + args.question.strip() + "\n")
    if tokenizer.chat_template:
        prompt = tokenizer.apply_chat_template([{"role": "user", "content": prompt}],
                                              add_generation_prompt=True, tokenize=False)
    report = {"scope": "official_checkpoint_small_corpus_functional_inference",
              "paper_accuracy_reproduced": False, "model_path": str(args.model),
              "seed": args.seed, "question": args.question, "turns": [],
              "status": "INCOMPLETE_MAX_TURNS", "answer": None}
    session = requests.Session()
    session.trust_env = False  # localhost retriever must not go through the proxy tunnel
    try:
        for turn in range(args.max_turns):
            input_ids = tokenizer.encode(prompt, return_tensors="pt").to("cuda:0")
            if input_ids.shape[1] + args.max_new_tokens > args.max_context:
                report["status"] = "INCOMPLETE_CONTEXT_LIMIT"
                break
            options = {"do_sample": args.temperature > 0}
            if args.temperature > 0:
                options["temperature"] = args.temperature
            with torch.inference_mode():
                outputs = model.generate(input_ids, attention_mask=torch.ones_like(input_ids),
                                         max_new_tokens=args.max_new_tokens,
                                         stopping_criteria=transformers.StoppingCriteriaList([StopAfterSearch()]),
                                         pad_token_id=tokenizer.eos_token_id, **options)
            generated = tokenizer.decode(outputs[0, input_ids.shape[1]:], skip_special_tokens=True)
            item = {"turn": turn + 1, "generated": generated}
            report["turns"].append(item)
            answers = re.findall(r"<answer>(.*?)</answer>", generated, re.DOTALL)
            if answers:
                report["answer"] = answers[-1].strip()
                report["status"] = "ANSWER_GENERATED_NOT_ACCURACY_VALIDATED"
                break
            queries = re.findall(r"<search>(.*?)</search>", generated, re.DOTALL)
            if not queries:
                report["status"] = "INCOMPLETE_NO_SEARCH_OR_ANSWER"
                break
            query = queries[-1].strip()
            response = session.post(args.retriever_url,
                                    json={"queries": [query], "topk": 3, "return_scores": True},
                                    timeout=120)
            response.raise_for_status()
            results = response.json()["result"][0]
            information = []
            for idx, value in enumerate(results):
                content = value["document"]["contents"]
                title, _, body = content.partition("\n")
                information.append(f"Doc {idx + 1}(Title: {title}) {body}\n")
            item.update(query=query, results=results)
            prompt += "\n\n" + generated + "<information>" + "".join(information) + "</information>\n\n"
    except Exception as exc:
        report.update(status="ERROR", error=f"{type(exc).__name__}: {exc}")
        raise
    finally:
        report["search_calls"] = sum("query" in item for item in report["turns"])
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in report.items() if key != "turns"}, ensure_ascii=False))
    return 0 if report["answer"] is not None else 2


if __name__ == "__main__":
    sys.exit(main())
