# RunAI: Jobs vs Workspaces — Command Reference

Reference for submitting and connecting to RunAI **jobs** (`runai training submit`, batch/
non-interactive) and **workspaces** (`runai workspace submit`, interactive/JupyterLab) using the
raw `runai` CLI directly — no wrapper script assumed. Replace `<...>` placeholders (image, mount
paths, project) with the values for your environment.

## 0. One-time setup

```console
runai login
runai whoami
runai project list
runai config project <your-project>
```

`runai project list` shows the projects available to you and their GPU quota, e.g.:

```
NAME             GPU Quota
only-cpu-nodes   0.00
aimet-systems    8.00
```

## 1. Batch jobs — `runai training submit`

Use for non-interactive, run-to-completion work (training, eval, batch scripts). The pod runs your
command and exits; RunAI marks the job Succeeded/Failed based on the command's exit code.

```console
runai training submit my-batch-job \
  --image <registry>/<namespace>/<image>:<tag> \
  -e USER=$USER \
  -e HOME=$HOME \
  --nfs path=$HOME,mountpath=$HOME,server=<nfs-server>,readwrite \
  --nfs path=/path/to/repo,mountpath=/path/to/repo,server=<nfs-server>,readwrite \
  --run-as-user \
  -g 1 \
  -- "cd /path/to/repo && python -m my_package.train configs/train.yaml"
```

Notes:
- `-g <n>` sets the GPU count.
- `--run-as-user` runs the container as your uid/gid instead of root, so files written to the NFS
  mounts come out owned by you.
- Wrap the trailing command in double quotes and use `&&`/`;` inside it, not single quotes — RunAI
  strips single quotes from the command string. If you need the exit code to survive a `| tee`,
  add `set -o pipefail;` before the piped command, e.g.:
  ```console
  -- "set -o pipefail; python -m my_package.train configs/train.yaml 2>&1 | tee -a /path/to/repo/logs/my-batch-job.log"
  ```
- To preview without submitting, most `runai` CLI versions support `--dry-run`; check
  `runai training submit --help` for your installed version.

**Manage a batch job:**

```console
runai training list
runai training describe my-batch-job
runai training logs my-batch-job
runai training delete my-batch-job
```

## 2. Interactive workspace (console) — `runai workspace submit`

Gives you a persistent shell on a GPU node instead of running one command to completion.

```console
runai workspace submit my-interactive-job \
  --image morpheus-docker.qualcomm.com/users/vinnkim/quant-sys:latest \
  -e USER=$USER \
  -e HOME=$HOME \
  --nfs path=$HOME,mountpath=$HOME,server=mudpie,readwrite \
  --nfs path=/prj/corp/airesearch/lasvegas/vol11-scratch,mountpath=/prj/corp/airesearch/lasvegas/vol11-scratch,server=redpill,readwrite \
  --run-as-user \
  --port service-type=NodePort,container=25000 \
  --stdin --tty \
  -g 1
```

Add `--preemptible` if this exceeds your project's GPU quota:

```console
runai workspace submit my-interactive-job \
  --image morpheus-docker.qualcomm.com/users/vinnkim/quant-sys:latest \
  -e USER=$USER \
  -e HOME=$HOME \
  --nfs path=$HOME,mountpath=$HOME,server=mudpie,readwrite \
  --nfs path=/prj/corp/airesearch/lasvegas/vol11-scratch,mountpath=/prj/corp/airesearch/lasvegas/vol11-scratch,server=redpill,readwrite \
  --run-as-user \
  --port service-type=NodePort,container=25000 \
  --stdin --tty \
  --preemptible \
  -g 1
```

Connect to the running workspace (either works — pick whichever your `runai` CLI version supports):

```console
runai workspace bash my-interactive-job
# or
runai attach my-interactive-job
```

You land in a shell inside the pod, with your NFS mounts already in place:

```
Connecting to pod my-interactive-job-0-0
<user>@<pod>:/path/to/repo$ python -m my_package.train configs/train.yaml
```

**Manage a workspace:**

```console
runai workspace list
runai workspace describe my-interactive-job
runai workspace delete my-interactive-job
```

## 3. Interactive workspace — SSH / VSCode Remote-SSH

Same submission as above, then look up the pod's `NodePort` address:

```console
runai workspace describe my-interactive-job
```

Find the `Networks` table in the output — the SSH endpoint is the `URL` column, e.g.:

```
Name: port   Connection Type: NodePort   URL: 10.81.114.51:30292
```

Requirements inside the mounted `$HOME`:
- `~/.ssh/authorized_keys` containing your public key
- `~/.ssh/ssh_host_rsa_key` (host key for the container's sshd)
- Permissions: `~/.ssh` `700`, `authorized_keys` `600`, `ssh_host_rsa_key` `600`

Then point VSCode's Remote-SSH extension (or plain `ssh`) at `<user>@<NodePort IP> -p <NodePort port>`.

## 4. JupyterLab workspace — `runai workspace submit`

```console
runai workspace submit my-jupyter-lab \
  --image <registry>/<namespace>/<image>:<tag> \
  -e JUPYTER_RUNTIME_DIR=/tmp/.jupyter/runtime \
  -e JUPYTER_DATA_DIR=/tmp/.jupyter/data \
  --nfs path=$HOME,mountpath=$HOME,server=<nfs-server>,readwrite \
  --nfs path=/path/to/repo,mountpath=/path/to/repo,server=<nfs-server>,readwrite \
  --run-as-user \
  --port service-type=NodePort,container=8888 \
  -g 1 \
  -- "jupyter lab --ip=0.0.0.0 --no-browser --NotebookApp.token='' --notebook-dir=/path/to/repo"
```

Get the browser URL the same way as the SSH case:

```console
runai workspace describe my-jupyter-lab
```

```
Name: port   Connection Type: NodePort   URL: 10.81.114.24:31047
```

Open `http://<that IP:port>` in a browser.

## 5. Common flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--image <image>` | both | Container image (`<registry>/<namespace>/<name>:<tag>`) |
| `-e KEY=VALUE` | both | Environment variable in the container |
| `--nfs path=<src>,mountpath=<dst>,server=<host>,readwrite` | both | NFS mount; repeat per mount |
| `-g <n>` / `--gpu <n>` | both | Number of GPUs |
| `--run-as-user` | both | Run container as your uid/gid, not root |
| `--preemptible` | both | Allow preemption (needed if over quota) |
| `--stdin --tty` | workspace | Keep an interactive TTY open (console workspaces) |
| `--port service-type=NodePort,container=<port>` | workspace | Expose a container port externally |
| `-- "<command>"` | training (required), workspace (optional) | Command to run in the container |

Exact flag availability depends on your `runai` CLI version — check `runai training submit --help`
and `runai workspace submit --help` for what's supported in your cluster.

## Links

- [Run:AI CLI setup docs](https://morpheus.gitlab-pages.qualcomm.com/model-pipelines/runai/documentation/runai.html#initial-setup-run-ai-cli)
- [Preemption docs](https://morpheus.gitlab-pages.qualcomm.com/model-pipelines/runai/documentation/preemption.html)
