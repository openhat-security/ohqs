# Temporary: Unsloth companion repo plan

**Remove this file** when https://github.com/openhat/unsloth exists and this README can link there instead.

This document is the working plan for a **separate** OpenHat repository. That repo will hold Unsloth install notes, serve configs, and recommended open-weight models so `ohqs` can call `POST {base}/chat/completions` and draft **authorized engagement plans**.

`ohqs` itself stays a planner. The companion repo is infrastructure: run a model you control, then plug the OpenAI-compatible URL into this project.

## Why a companion repo

Hosted APIs (OpenAI, Anthropic, and similar) often refuse security-research **planning** prompts even when the operator has written authorization. A local or rented GPU running an open-weight model lets the user keep that work on hardware they control.

This is not a request to jailbreak hosted models, and it is not an exploit generator. `ohqs --llm` asks for detection, triage, and reporting steps that stay inside `--authorized` / `--scope`.

Placeholder home: **https://github.com/openhat/unsloth**

## What that repo should contain

```
unsloth/
  README.md                 # install, serve, point ohqs at the URL
  configs/
    serve-vllm.sh           # OpenAI-compatible serve
    serve-llamacpp.sh       # CPU / smaller GPU fallback
    unsloth-finetune.md     # optional LoRA notes for planning-style chat
  models.md                 # recommended open weights + VRAM
  runpod/
    README.md               # pod, volume, port, env
```

## Stack

1. **Unsloth** — install from https://github.com/unslothai/unsloth (upstream). Use it to load / optionally fine-tune open-weight chat models.
2. **Serve** — expose Chat Completions. Any of:
   - vLLM (`vllm serve … --port 8000`)
   - llama.cpp `llama-server` (`--port 8000`)
   - an Unsloth or Hugging Face text-generation server that speaks `/v1/chat/completions`
3. **ohqs** — in this repo:

```bash
export OHQS_OPENAI_BASE_URL=http://127.0.0.1:8000/v1
export OHQS_OPENAI_API_KEY=sk-local          # many local servers accept any string
export OHQS_OPENAI_MODEL=unsloth-plan        # whatever --served-model-name you set
./bin/ohqs recommend --authorized --scope "…" --situation "…" --llm
```

Or flags: `--openai-base-url`, `--openai-api-key`, `--openai-model`.

The UI checkbox uses the same env. Optional form fields override base URL and model. The API key stays on the server process (`OHQS_OPENAI_API_KEY`), not in the browser.

## Recommended open-weight models (planning backends)

These are general chat / instruction models that serve through an OpenAI-compatible API. Pick by VRAM, not by “uncensored” marketing. `ohqs` already constrains the task to authorized plans.

| Class | Example weights | Typical VRAM (Q4 / Q5) | Notes |
| --- | --- | --- | --- |
| Small / laptop | Qwen2.5-7B-Instruct, Llama-3.1-8B-Instruct, Mistral-7B-Instruct | 6–10 GB | Fine for short plans; keep retrieved catalog context small |
| Mid | Qwen2.5-14B-Instruct, Gemma-2-27B-it (quantized) | 12–24 GB | Better at following the JSON schema `ohqs` asks for |
| Large / rented GPU | Qwen2.5-32B-Instruct, Llama-3.1-70B-Instruct (quantized) | 24–48 GB+ | Use on Runpod when 7B drops fields or ignores tool ids |

Unsloth 4-bit / 16-bit loaders and official model cards belong in the companion repo (`models.md`), pinned to specific Hugging Face revisions so serve scripts stay reproducible.

Do **not** put jailbreak system prompts, “unrestricted exploit” recipes, or payload packs in that repo. Fine-tunes, if any, should be on **authorized playbook JSON** (situation + catalog tools → `planner.Plan` shape), using public write-ups and this repo’s playbook YAML as data — not exploit corpora.

## Example serve flags (to copy into the companion repo)

vLLM (OpenAI-compatible):

```bash
vllm serve Qwen/Qwen2.5-14B-Instruct \
  --host 0.0.0.0 \
  --port 8000 \
  --api-key sk-local \
  --served-model-name unsloth-plan \
  --max-model-len 8192
```

llama.cpp:

```bash
llama-server -m qwen2.5-14b-instruct-q4_k_m.gguf \
  --host 0.0.0.0 \
  --port 8000 \
  --alias unsloth-plan
```

Then:

```
OHQS_OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OHQS_OPENAI_API_KEY=sk-local
OHQS_OPENAI_MODEL=unsloth-plan
```

If the server already includes `/v1` in its listen path, do not double it. `ohqs` POSTs to `{base}/chat/completions`.

## Runpod

Goal: a GPU pod that speaks OpenAI Chat Completions, with a volume for weights, so a laptop running `ohqs` can set `OHQS_OPENAI_BASE_URL` to the pod URL.

1. Create a [Runpod](https://www.runpod.io/) account and add credits.
2. **GPU pod** — start with 24 GB (e.g. RTX 4090 / L4) for 14B Q4, or 48 GB+ for 32B/70B quantized. PyTorch + CUDA template is enough; you will install Unsloth and a server in the pod.
3. **Network volume** — attach it at `/workspace` (or similar) and download weights there so they survive pod stop/start.
4. **Expose a port** — HTTP on `8000` (or Runpod’s proxy port). Use a token / `--api-key`. Do not leave an open completion API on the public internet without auth.
5. On the pod:

```bash
# sketch — exact pins go in the companion repo
pip install unsloth vllm
# download the chosen instruct weights onto the volume
vllm serve /workspace/models/Qwen2.5-14B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --api-key "$POD_API_KEY" \
  --served-model-name unsloth-plan
```

6. On the machine that runs `ohqs`:

```bash
export OHQS_OPENAI_BASE_URL=https://<pod-id>-8000.proxy.runpod.net/v1
export OHQS_OPENAI_API_KEY=$POD_API_KEY
export OHQS_OPENAI_MODEL=unsloth-plan
./bin/ohqs configure    # prints url + model; does not print the key
./bin/ohqs recommend --authorized --scope "…" --situation "…" --llm
```

7. Stop the pod when idle. Keep the volume.

Runpod’s UI labels change; the companion README should screenshot current “TCP port / HTTP proxy / environment variables” steps rather than relying on this sketch.

## Optional Unsloth fine-tune (later)

If plans from a base instruct model miss catalog ids or ignore the JSON schema:

- Training data: `catalog/playbooks/*.yaml` plus exported `ohqs recommend` JSON from authorized lab situations (no customer secrets).
- Unsloth LoRA on the chosen instruct checkpoint, 1–2 epochs, short completions.
- Export merged or adapter weights; serve as above.
- Config files (`configs/unsloth-finetune.md`) should list rank, lr, seq len, and the exact base model — not a “remove refusals” recipe.

## Acceptance checklist for the companion repo

- [ ] README: install Unsloth, download one 7B and one 14B instruct model, serve `/v1/chat/completions`
- [ ] `models.md` with VRAM table and Hugging Face ids
- [ ] `runpod/README.md` with volume + port + `OHQS_OPENAI_*` example
- [ ] One scripted smoke test: `curl` chat/completions returns a JSON plan object
- [ ] This file deleted from `quick-start` and the README link updated to the live Unsloth repo
