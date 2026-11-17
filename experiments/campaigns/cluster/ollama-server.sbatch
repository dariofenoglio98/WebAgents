#!/bin/bash
# The campaigns' local-rung model server on the piz cluster (PROTOCOL.md §2.2, U12; T32): one Ollama
# in one SLURM job, the same Ollama version as the development Mac, models from the same blobs (copied
# from the Mac, or pulled where the registry still serves the Mac's digest), reached from the Mac over
# an SSH tunnel. The drivers, the campaign stack and the oracle stay on the Mac; only inference runs here.
#
#   sbatch --container-mounts="$HOME/webagents-ollama/models:/models" \
#       --output="$HOME/webagents-ollama/logs/%j.log" [--partition=adula --gres=gpu:rtx_a6000:1] \
#       [--qos=filler] [--job-name=<name>] ollama-server.sbatch
#
# (#SBATCH lines expand no variable, so the two paths under the home directory are given when
# submitting.) The job writes ~/webagents-ollama/server-<jobid>.json (node, port, versions, digests)
# once the server answers; experiments/campaigns/README.md ("The local rungs on the piz cluster") has
# the drivers' route.
#SBATCH --job-name=webagents-ollama
#SBATCH --partition=blas
#SBATCH --gres=gpu:2g:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=40G
#SBATCH --time=2-00:00:00
#SBATCH --container-image=docker://ollama/ollama:0.40.8

set -euo pipefail
STATE=$HOME/webagents-ollama
# A continuation job reuses its campaign's port (the rung's route, recorded in the manifest, must not
# change across a --resume): `echo <port> > ~/webagents-ollama/port-<job name>` before submitting with the
# same --job-name (or sbatch --export=ALL,WEBAGENTS_PORT=<port>, which fails on adula: the node cannot
# fetch the user's environment).
PORT_FILE=${STATE}/port-${SLURM_JOB_NAME}
if [ -z "${WEBAGENTS_PORT:-}" ] && [ -f "${PORT_FILE}" ]; then WEBAGENTS_PORT=$(cat "${PORT_FILE}"); fi
PORT=${WEBAGENTS_PORT:-$((20000 + SLURM_JOB_ID % 10000))}
export OLLAMA_MODELS=/models
export OLLAMA_HOST=0.0.0.0:${PORT}
# §2.2: one model loaded at a time; the rung's context (32,768) as the server default (`FW` reaches
# Ollama through /v1, which takes no num_ctx); kept loaded; four slots (recorded in every manifest's
# `served` block through server-<jobid>.json; concurrent decoding can change a temperature-0 answer).
# A job may override the context and the slots with `~/webagents-ollama/env-<job name>` (shell lines,
# e.g. OLLAMA_CONTEXT_LENGTH=65536 and OLLAMA_NUM_PARALLEL=1 for Literature Review, whose `FW` side
# reaches /v1 and so gets the server's default context; T32, D-363).
ENV_FILE=${STATE}/env-${SLURM_JOB_NAME}
if [ -f "${ENV_FILE}" ]; then set -a; . "${ENV_FILE}"; set +a; fi
export OLLAMA_MAX_LOADED_MODELS=1
export OLLAMA_CONTEXT_LENGTH=${OLLAMA_CONTEXT_LENGTH:-32768}
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
