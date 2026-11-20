#!/bin/bash
# The campaign's shards next to the Ollama server (T32, D-363), as a step of the server job:
#
#   srun --jobid=<job> --overlap -n1 bash ~/webagents-campaign/run-shards.sh <port> <server-json> \
#       <shards> <name> --preset qualification --rungs L9 [more campaign arguments]
#
# Runs <shards> processes of `campaigns.driver.campaign ... --shard i/<shards>` from the node-local
# repository (setup-node-local.sh) against Ollama on 127.0.0.1:<port>, writing
# experiments/injection_campaign/results/<name>; every 10 minutes, and once at the end, the directory
# is copied to ~/webagents-campaign/results/<name> on the NFS home (a lost node loses no run; the Mac
# copies from there). A second start resumes (`--resume` semantics through --shard).
set -uo pipefail
PORT=$1
SERVER=$2
SHARDS=$3
NAME=$4
shift 4
ROOT=${WEBAGENTS_ROOT:-/tmp/${USER}-webagents}
export PATH=$ROOT/node/bin:$PATH
cd "$ROOT/repo/experiments"
OUT=injection_campaign/results/$NAME
SAFE=$HOME/webagents-campaign/results/$NAME
mkdir -p "$SAFE" "$ROOT/logs"  # logs outside the repository: untracked files there would make the tree dirty
pids=()
for i in $(seq 0 $((SHARDS - 1))); do
  # One shard runs unsharded (TS-L must: Crossref's lane is one per process), resuming if it ran before.
  if [ "$SHARDS" = 1 ]; then
    part=(); [ -f "$OUT/manifest.json" ] && part=(--resume)
  else
    part=(--shard "$i/$SHARDS")
  fi
  ../agentpkg/.venv/bin/python -m campaigns.driver.campaign "$@" \
    --ollama-url "http://127.0.0.1:${PORT}" --server-info "$SERVER" --out "$OUT" \
    "${part[@]}" > "$ROOT/logs/${NAME}-shard-$i.log" 2>&1 &
  pids+=($!)
  sleep 3  # the first shard writes the manifest
done
alive() {
  for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && return 0; done
  return 1
}
while alive; do
  sleep 600
  rsync -a "$OUT/" "$SAFE/"
done
# Each shard's own exit status (T32 review 2, nit 11): a bare `wait` returned 0 whatever they did.
failed=0
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || { status=$?; echo "shard $i exited $status (see $ROOT/logs/${NAME}-shard-$i.log)"; failed=1; }
done
rsync -a "$OUT/" "$SAFE/"
cp "$ROOT/logs/${NAME}"-shard-*.log "$SAFE/../" 2>/dev/null || true
if [ "$failed" = 1 ]; then echo "failed: $NAME"; exit 1; fi
echo "done: $NAME"
