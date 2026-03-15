# Colab RL Training

This project can train the RL weights without starting `server.js`.

Use the standalone runner:

```bash
node scripts/colab-train.js --mode selfplay --difficulty expert --episodes 50000 --agents 4 --reset
```

## Typical Colab flow

1. Open a Python 3 Colab runtime.
2. Mount Google Drive if you want the weights to persist:

```python
from google.colab import drive
drive.mount('/content/drive')
```

3. Put this project in Colab, then install dependencies:

```bash
%cd /content
!git clone <YOUR_REPO_URL> mwcraft
%cd /content/mwcraft
!npm install
```

4. Run training and copy the final weights into Drive:

```bash
!node scripts/colab-train.js \
  --mode selfplay \
  --difficulty expert \
  --episodes 50000 \
  --agents 4 \
  --reset \
  --output-dir /content/drive/MyDrive/mwcraft-weights
```

## Useful options

- `--mode solo`
  Runs the simplified solo simulator instead of self-play.
- `--difficulty hard|expert`
  Chooses which weight file to train.
- `--episodes N`
  In solo mode this is the episode count. In self-play mode this is the match count.
- `--agents N`
  Number of self-play agents. Only used in `selfplay` mode.
- `--reset`
  Deletes the local `ai-weights-<difficulty>.json(.gz)` files before training.
- `--download-base`
  Downloads the external base weights if nothing is cached locally.
  This is not the same as restoring a weights file from Git history.
- `--output-dir PATH`
  Copies the final `.json.gz` and optional `.json` files to another directory.
- `--save-json`
  Keeps a plain JSON file in addition to the gzip file.
- `--recording-min-score N`
  Overrides the solo/self-play record cutoff.
- `--selfplay-min-reward N`
  Overrides the self-play winner reward cutoff.

## Notes

- The runner uses the same `TrainingSession` class as the in-game training UI.
- You do not need to start the web server for Colab training.
- Final weights are still written to the project root first:
  - `ai-weights-hard.json.gz`
  - `ai-weights-expert.json.gz`
- If you interrupt the process with `Ctrl+C`, the runner saves the current weights before exiting.

## Restore weights from Git history

The notebook can restore `ai-weights-<difficulty>.json.gz` from Git history before training.

- Set `GIT_WEIGHTS_REF = "auto"` to find the newest commit in the cloned repository history that still contains the weights file.
- Set `GIT_WEIGHTS_REF` to a specific branch/tag/commit if you want an exact revision.
- Leave `GIT_WEIGHTS_REF = ""` to skip Git restore.

The notebook now defaults to no reset and asks before deleting weights, so the normal Colab flow is:

1. Clone/pull the GitHub repo.
2. Restore the latest weights from Git history.
3. Optionally adjust the next run's episode count or runtime options in the notebook prompt cell.
4. Continue training in Colab. If you run the training cell again without resetting, it continues from the current local weights.
5. Download the result and commit/push the updated weights yourself if you want GitHub to become the new baseline.
