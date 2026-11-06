#!/bin/bash
# The campaign drivers' runtime on the server job's node-local disk (T32, D-363): the piz home is NFS,
# too slow for tens of thousands of small files (a Python venv, node_modules), so the repository, Python
# 3.13, Node and the dependencies live under $ROOT on the compute node, and the drivers run there, next
# to Ollama, as a step of the server job. Run as a step of that job:
#
#   srun --jobid=<job> --overlap -n1 bash ~/webagents-campaign/setup-node-local.sh <bundle> <commit>
#
# <bundle> is a `git bundle` of the task branch copied to piz; <commit> the campaign's commit. The
# result: $ROOT/repo at <commit> with agentpkg/.venv (Python 3.13, agentpkg[dev,compute] and the
# campaign requirements) and chrome-agent-browser/node_modules. Idempotent.
set -euo pipefail
BUNDLE=$1
COMMIT=$2
ROOT=${WEBAGENTS_ROOT:-/tmp/${USER}-webagents}
mkdir -p "$ROOT/bin"
cd "$ROOT"
export UV_PYTHON_INSTALL_DIR=$ROOT/python UV_CACHE_DIR=$ROOT/uv-cache UV_NO_MODIFY_PATH=1
if [ ! -x bin/uv ]; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$ROOT/bin" INSTALLER_NO_MODIFY_PATH=1 sh
fi
bin/uv python install 3.13 --no-bin
if [ ! -x node/bin/node ]; then
  curl -fsSL -o node.tar.xz https://nodejs.org/dist/v26.9.0/node-v26.9.0-linux-x64.tar.xz
  tar -xJf node.tar.xz && mv node-v26.9.0-linux-x64 node && rm node.tar.xz
fi
export PATH=$ROOT/node/bin:$PATH
if [ ! -d repo ]; then git clone -q "$BUNDLE" repo; fi
cd repo
git fetch -q "$BUNDLE" "+refs/heads/*:refs/remotes/bundle/*"
git checkout -q --detach "$COMMIT"
PY=$("$ROOT/bin/uv" python find 3.13)
[ -x agentpkg/.venv/bin/python ] || "$PY" -m venv agentpkg/.venv
agentpkg/.venv/bin/python -m pip install -q --upgrade pip
agentpkg/.venv/bin/python -m pip install -q -e './agentpkg[dev,compute]' -r experiments/campaigns/requirements.txt
(cd chrome-agent-browser && npm ci --silent --no-audit --no-fund)
echo "ready: $(git rev-parse HEAD) python $(agentpkg/.venv/bin/python --version) node $(node --version)"
