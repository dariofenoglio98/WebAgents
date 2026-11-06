#!/bin/bash
# The campaigns' local-rung model server on the piz cluster (PROTOCOL.md §2.2, U12; T32): one Ollama
# in one SLURM job, the same Ollama version as the development Mac, models from the same blobs (copied
# from the Mac, or pulled where the registry still serves the Mac's digest), reached from the Mac over
# an SSH tunnel. The drivers, the campaign stack and the oracle stay on the Mac; only inference runs here.
#
#   sbatch experiments/campaigns/cluster/ollama-server.sbatch          # from a checkout on piz, or:
#   ssh piz 'sbatch -' < experiments/campaigns/cluster/ollama-server.sbatch
#
# The job writes ~/webagents-ollama/server-<jobid>.json (node, port, versions, digests) once the server
# answers; `cluster/README.md` has the tunnel and the campaign's --ollama-url.
#SBATCH --job-name=webagents-ollama
#SBATCH --partition=blas
#SBATCH --gres=gpu:2g:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=40G
#SBATCH --time=2-00:00:00
#SBATCH --container-image=docker://ollama/ollama:0.40.8
#SBATCH --container-mounts=/home/fenogd/webagents-ollama/models:/models
#SBATCH --output=/home/fenogd/webagents-ollama/logs/%j.log

set -euo pipefail
STATE=/home/fenogd/webagents-ollama
PORT=$((20000 + SLURM_JOB_ID % 10000))
export OLLAMA_MODELS=/models
export OLLAMA_HOST=0.0.0.0:${PORT}
# §2.2: one model loaded at a time; the rung's context (32,768) as the server default (`FW` reaches
# Ollama through /v1, which takes no num_ctx); kept loaded; four slots (recorded in every manifest's
# `served` block through server-<jobid>.json; concurrent decoding can change a temperature-0 answer).
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_CONTEXT_LENGTH=32768
export OLLAMA_KEEP_ALIVE=-1
export OLLAMA_NUM_PARALLEL=${OLLAMA_NUM_PARALLEL:-4}

ollama serve > "${STATE}/logs/${SLURM_JOB_ID}.serve.log" 2>&1 &
SERVER=$!
for _ in $(seq 1 120); do
  ollama list > /dev/null 2>&1 && break
  sleep 1
done

# qwen3:30b: the registry's manifest is byte-identical to the Mac's (sha256 ad815644…cb37226,
# checked 2026-11-06), so a pull yields the same model; the other two come from the Mac's blobs.
ollama list | grep -q '^qwen3:30b ' || ollama pull qwen3:30b

{
  printf '{"job": "%s", "node": "%s", "port": %s, "ollama_version": "%s",\n' \
    "${SLURM_JOB_ID}" "$(hostname -s)" "${PORT}" "$(ollama --version 2>&1 | tail -1)"
  printf ' "env": {"OLLAMA_NUM_PARALLEL": "%s", "OLLAMA_CONTEXT_LENGTH": "%s", "OLLAMA_MAX_LOADED_MODELS": "%s", "OLLAMA_KEEP_ALIVE": "%s"},\n' \
    "${OLLAMA_NUM_PARALLEL}" "${OLLAMA_CONTEXT_LENGTH}" "${OLLAMA_MAX_LOADED_MODELS}" "${OLLAMA_KEEP_ALIVE}"
  printf ' "gpu": "%s",\n' "$(nvidia-smi -L 2>/dev/null | tr '\n' ';' | sed 's/"/'"'"'/g')"
  printf ' "models": "%s"}\n' "$(ollama list | tail -n +2 | awk '{print $1"="$2}' | tr '\n' ' ')"
} > "${STATE}/server-${SLURM_JOB_ID}.json"

wait "${SERVER}"
