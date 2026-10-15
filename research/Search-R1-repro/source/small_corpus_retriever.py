#!/usr/bin/env python3
"""E5/FAISS adapter for a SMALL corpus, not the wiki-18 benchmark.

SPDX-License-Identifier: Apache-2.0
Adapted from PeterGriffinJin/Search-R1, commit
598e61bd1d36895726d28a8d06b3a15bed19f5d3,
search_r1/search/retrieval_server.py. Modified for small-corpus loading,
device selection, bounded requests and a loopback-only service.
See ../LICENSE-APACHE-2.0.txt and /THIRD_PARTY_NOTICES.md.

Uses Search-R1's original DenseRetriever and pooling, with process-local adapters
for device selection and small JSONL loading. Does not edit upstream files.
Example: python small_corpus_retriever.py --repo /path/Search-R1 \
  --model /path/e5-base-v2 --corpus /path/Search-R1/example/corpus.jsonl \
  --output /path/smoke-index --mode check
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--model", required=True)
    parser.add_argument("--corpus", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--mode", choices=["build", "check", "serve"], default="check")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--device", choices=["cpu", "cuda", "auto"], default="cpu")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--query", default="What is the topic of this passage?")
    args = parser.parse_args()
    if not 1 <= args.limit <= 10000 or not 1 <= args.batch_size <= 8:
        parser.error("Small-corpus validation allows limit 1..10000 and batch-size 1..8")

    import faiss
    import numpy as np
    import torch
    from transformers import AutoModel, AutoTokenizer

    torch.set_num_threads(1)
    faiss.omp_set_num_threads(1)
    device = "cuda" if args.device == "auto" and torch.cuda.is_available() else args.device
    if device == "auto":
        device = "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable. Use --device cpu for this small-corpus check")
    upstream_path = args.repo / "search_r1/search/retrieval_server.py"
    spec = importlib.util.spec_from_file_location("searchr1_upstream_retriever", upstream_path)
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)

    def device_load_model(model_path, use_fp16=False):
        model = AutoModel.from_pretrained(model_path, low_cpu_mem_usage=True,
                                          trust_remote_code=False).eval().to(device)
        model = model.half() if device == "cuda" else model.float()
        tokenizer = AutoTokenizer.from_pretrained(model_path, use_fast=True,
                                                 trust_remote_code=False)
        return model, tokenizer

    class DeviceE5Encoder(upstream.Encoder):
        @torch.inference_mode()
        def encode(self, query_list, is_query=True):
            if isinstance(query_list, str):
                query_list = [query_list]
            prefix = "query: " if is_query else "passage: "
            inputs = self.tokenizer([prefix + value for value in query_list],
                                    padding=True, truncation=True, max_length=256,
                                    return_tensors="pt").to(device)
            output = self.model(**inputs)
            embedding = upstream.pooling(None, output.last_hidden_state,
                                         inputs["attention_mask"], "mean")
            embedding = torch.nn.functional.normalize(embedding, dim=-1)
            return np.ascontiguousarray(embedding.cpu().numpy(), dtype=np.float32)

    def small_load_corpus(corpus_path):
        with open(corpus_path, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    # These changes affect only this process; upstream source remains untouched.
    upstream.load_model = device_load_model
    upstream.Encoder = DeviceE5Encoder
    upstream.load_corpus = small_load_corpus

    documents = []
    with args.corpus.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            if not isinstance(record.get("contents"), str):
                raise ValueError("Each corpus entry must contain string contents")
            record.setdefault("id", str(len(documents)))
            documents.append(record)
            if len(documents) == args.limit:
                break
    if not documents:
        raise ValueError("Corpus is empty")
    args.output.mkdir(parents=True, exist_ok=True)
    corpus_path = args.output / "small-corpus.jsonl"
    index_path = args.output / "e5-small-Flat.index"
    if corpus_path.resolve() == args.corpus.resolve():
        raise ValueError("Output corpus must differ from source corpus")

    encoder = DeviceE5Encoder("e5", args.model, "mean", 256, device == "cuda")
    index = None
    for start in range(0, len(documents), args.batch_size):
        vectors = encoder.encode([doc["contents"] for doc in
                                  documents[start:start + args.batch_size]], is_query=False)
        if index is None:
            index = faiss.IndexFlatIP(vectors.shape[1])
        index.add(vectors)
    faiss.write_index(index, str(index_path))
    with corpus_path.open("w", encoding="utf-8") as handle:
        for doc in documents:
            handle.write(json.dumps(doc, ensure_ascii=False) + "\n")
    report = {"scope": "small_corpus_validation_only", "documents": len(documents),
              "model": args.model, "source": str(args.corpus), "index": str(index_path),
              "device": device, "full_wikipedia_reproduction": False}
    (args.output / "manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    if args.mode == "build":
        print(json.dumps(report))
        return

    # Construct the upstream retriever without loading the same model twice.
    config = upstream.Config(retrieval_method="e5", retrieval_topk=min(3, len(documents)),
                             index_path=str(index_path), corpus_path=str(corpus_path),
                             retrieval_model_path=args.model, faiss_gpu=False,
                             retrieval_batch_size=args.batch_size, retrieval_use_fp16=False)
    retriever = upstream.DenseRetriever.__new__(upstream.DenseRetriever)
    upstream.BaseRetriever.__init__(retriever, config)
    retriever.index, retriever.corpus, retriever.encoder = index, documents, encoder
    retriever.batch_size = args.batch_size
    if args.mode == "check":
        results, scores = retriever.batch_search([args.query], return_score=True)
        assert len(results) == 1 and len(results[0]) > 0
        assert all(math.isfinite(score) for score in scores[0])
        report.update(status="PASS", query=args.query, first_result=results[0][0], scores=scores[0])
        print(json.dumps(report, ensure_ascii=False))
        return

    # Keep the original response contract; force scores internally to handle the
    # original endpoint's return_scores=False unpacking edge case correctly.
    from fastapi import FastAPI
    import uvicorn
    app = FastAPI(title="Search-R1 small-corpus adapter")

    @app.get("/health")
    def health():
        return report

    @app.post("/retrieve")
    def retrieve(request: upstream.QueryRequest):
        if not request.queries or len(request.queries) > 16:
            from fastapi import HTTPException
            raise HTTPException(400, "Supply 1..16 queries for small-corpus validation")
        topk = max(1, min(request.topk or 3, len(documents)))
        result, scores = retriever.batch_search(request.queries, num=topk, return_score=True)
        if request.return_scores:
            result = [[{"document": doc, "score": score} for doc, score in zip(docs, values)]
                      for docs, values in zip(result, scores)]
        return {"result": result}

    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
