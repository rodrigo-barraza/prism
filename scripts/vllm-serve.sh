#!/usr/bin/env bash
# ============================================================
# vLLM Serve — Launch vLLM with Function Calling Support
# ============================================================
# This script starts vLLM's OpenAI-compatible server with the
# required flags for tool/function calling to work with Prism's
# AgenticLoopService.
#
# Required flags:
#   --enable-auto-tool-choice   Allows the model to autonomously
#                               decide when to call tools
#   --tool-call-parser          Must match the model's chat template
#
# Supported parsers (match to model family) — vLLM v0.19.0:
#   hermes        — NousResearch Hermes, Qwen 3 models
#   llama3_json   — Llama 3 Instruct models
#   llama4_json   — Llama 4 Instruct models
#   mistral       — Mistral/Mixtral models
#   internlm      — InternLM models
#   jamba         — Jamba models
#   gemma4        — Gemma 4 models
#   deepseek_v3   — DeepSeek V3
#   deepseek_v31  — DeepSeek V3.1
#   deepseek_v32  — DeepSeek V3.2
#   functiongemma — Gemma function calling fine-tunes
#   qwen3_coder   — Qwen 3 Coder models
#   qwen3_xml     — Qwen 3 XML format
#   granite       — IBM Granite models
#   xlam          — xLAM models
#
# Usage:
#   ./scripts/vllm-serve.sh <model_path_or_id> [parser] [port]
#
# Examples:
#   ./scripts/vllm-serve.sh meta-llama/Llama-4-Scout-17B-16E-Instruct llama3_json 8000
#   ./scripts/vllm-serve.sh Qwen/Qwen3-8B qwen25 8000
#   ./scripts/vllm-serve.sh google/gemma-3-27b-it hermes 8000
# ============================================================

set -euo pipefail

MODEL="${1:?Usage: $0 <model> [parser] [port]}"
PARSER="${2:-hermes}"
PORT="${3:-8000}"

echo "═══════════════════════════════════════════════════════════"
echo "  🚀 vLLM — Starting with Function Calling"
echo "  Model:  ${MODEL}"
echo "  Parser: ${PARSER}"
echo "  Port:   ${PORT}"
echo "═══════════════════════════════════════════════════════════"

vllm serve "${MODEL}" \
  --port "${PORT}" \
  --enable-auto-tool-choice \
  --tool-call-parser "${PARSER}" \
  "${@:4}"
