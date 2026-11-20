#!/bin/bash
# The reverse tunnel from the server job to the piz login node (T32, D-363). The cluster refuses
# inbound connections to compute nodes (the login node cannot reach the job's port, SSH to a compute
# node is closed), but a job may dial out to the login node's SSH; so a step of the server job keeps
# `ssh -R` open, with a key that may only listen on 127.0.0.1:<port> (its authorized_keys line:
# restrict,port-forwarding,permitlisten="127.0.0.1:<port>",command="/bin/false" <key>).
#
#   setsid nohup srun --jobid=<job> --overlap -n1 ~/webagents-ollama/tunnel.sh <port> \
#       > ~/webagents-ollama/logs/<job>.tunnel.log 2>&1 < /dev/null &        # on the login node
#   ssh -f -N -L 11500:127.0.0.1:<port> piz                                      # on the Mac
PORT=$1
LOGIN=${WEBAGENTS_LOGIN_HOST:?set WEBAGENTS_LOGIN_HOST to the cluster login node}
while true; do
  ssh -i ~/.ssh/webagents_tunnel -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=accept-new \
      -R 127.0.0.1:${PORT}:127.0.0.1:${PORT} "${LOGIN}"
  sleep 10
done
