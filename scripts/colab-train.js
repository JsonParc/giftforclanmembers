#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULTS = {
  mode: 'selfplay',
  difficulty: 'expert',
  episodes: 50000,
  agents: 4,
  reset: false,
  downloadBase: false,
  saveJson: false,
  autoSaveMs: 60000,
  progressMs: 30000,
  outputDir: '',
  recordingMinScore: null,
  selfPlayMinReward: null
};

function printHelp() {
  console.log(`
MW Craft Colab Training Runner

Usage:
  node scripts/colab-train.js [options]

Options:
  --mode <solo|selfplay>           Training mode. Default: selfplay
  --difficulty <hard|expert>       Weight set to train. Default: expert
  --episodes <number>              Solo episodes or self-play matches. Default: 50000
  --matches <number>               Alias for --episodes in self-play mode
  --agents <number>                Self-play agent count. Default: 4
  --reset                          Delete local weight files before training
  --download-base                  Download the external base weights if nothing is cached
  --save-json                      Keep plain JSON weights in addition to .json.gz
  --autosave-ms <number>           Auto-save interval in ms. Default: 60000
  --progress-ms <number>           Progress log interval in ms. Default: 30000
  --output-dir <path>              Copy final weight files to this directory
  --recording-min-score <number>   Override recording cutoff score
  --selfplay-min-reward <number>   Override self-play winner reward cutoff
  --help                           Show this message

Examples:
  node scripts/colab-train.js --mode selfplay --difficulty expert --episodes 50000 --agents 4 --reset
  node scripts/colab-train.js --mode solo --difficulty hard --episodes 20000 --output-dir /content/drive/MyDrive/mwcraft-weights
`);
}

function parseInteger(name, value, minValue = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minValue) {
    throw new Error(`Invalid value for ${name}: ${value}`);
  }
  return parsed;
}

function parseNumber(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for ${name}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--mode':
        options.mode = String(argv[++i] || '').toLowerCase();
        break;
      case '--difficulty':
        options.difficulty = String(argv[++i] || '').toLowerCase();
        break;
      case '--episodes':
      case '--matches':
        options.episodes = parseInteger(arg, argv[++i], 1);
        break;
      case '--agents':
        options.agents = parseInteger(arg, argv[++i], 2);
        break;
      case '--autosave-ms':
        options.autoSaveMs = parseInteger(arg, argv[++i], 1000);
        break;
      case '--progress-ms':
        options.progressMs = parseInteger(arg, argv[++i], 1000);
        break;
      case '--output-dir':
        options.outputDir = String(argv[++i] || '');
        break;
      case '--recording-min-score':
        options.recordingMinScore = parseNumber(arg, argv[++i]);
        break;
      case '--selfplay-min-reward':
        options.selfPlayMinReward = parseNumber(arg, argv[++i]);
        break;
      case '--reset':
        options.reset = true;
        break;
      case '--download-base':
        options.downloadBase = true;
        break;
      case '--save-json':
        options.saveJson = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const validModes = new Set(['solo', 'selfplay']);
  const validDifficulties = new Set(['hard', 'expert']);

  if (!validModes.has(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  if (!validDifficulties.has(options.difficulty)) {
    throw new Error(`Unsupported difficulty: ${options.difficulty}`);
  }

  return options;
}

function getWeightPaths(difficulty) {
  const jsonPath = path.join(ROOT_DIR, `ai-weights-${difficulty}.json`);
  return {
    jsonPath,
    gzipPath: `${jsonPath}.gz`
  };
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function copyFinalWeights(session, outputDir) {
  if (!outputDir) return [];
  fs.mkdirSync(outputDir, { recursive: true });

  const copied = [];
  const sources = [session.compressedWeightsPath, session.weightsPath];
  for (const sourcePath of sources) {
    if (!fs.existsSync(sourcePath)) continue;
    const destinationPath = path.join(outputDir, path.basename(sourcePath));
    fs.copyFileSync(sourcePath, destinationPath);
    copied.push(destinationPath);
  }
  return copied;
}

function buildProgressLine(session, options, startedAt) {
  const status = session.getStatus();
  const stats = status.stats || {};
  const elapsed = formatDuration(Date.now() - startedAt);
  const rewardMetric = status.rewardMetric || {};
  let line =
    `[colab-train] ${status.currentEpisode}/${status.maxEpisodes}` +
    ` | elapsed=${elapsed}` +
    ` | states=${formatNumber(stats.states)}` +
    ` | eps=${stats.epsilon}` +
    ` | ${rewardMetric.mode === 'selfplay' ? 'avg-winner-reward' : 'avg-reward'}=${rewardMetric.value ?? stats.avgReward}`;

  if (options.mode === 'selfplay') {
    const arena = session.getSelfPlayStatus() || {};
    const eloRatings = Array.isArray(arena.eloRatings) ? arena.eloRatings.join(',') : '';
    line +=
      ` | avg-margin=${formatNumber(arena.avgVictoryMargin || 0)}` +
      ` | elo=[${eloRatings}]`;
  }

  return line;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.saveJson) {
    process.env.MW_RL_SAVE_JSON = '1';
  }

  const {
    TrainingSession,
    ensureExternalWeightsCached
  } = require(path.join(ROOT_DIR, 'ai-training.js'));

  const weightPaths = getWeightPaths(options.difficulty);
  if (options.reset) {
    removeIfExists(weightPaths.jsonPath);
    removeIfExists(weightPaths.gzipPath);
    console.log(`[colab-train] Reset weights for ${options.difficulty}`);
  }

  if (options.downloadBase) {
    const downloaded = await ensureExternalWeightsCached(options.difficulty);
    console.log(`[colab-train] Base weights ${downloaded ? 'ready' : 'not available'} for ${options.difficulty}`);
  }

  const session = new TrainingSession(options.difficulty);
  session.autoSaveInterval = options.autoSaveMs;

  if (options.recordingMinScore !== null || options.selfPlayMinReward !== null) {
    session.setRecordingPolicy({
      minScore: options.recordingMinScore !== null ? options.recordingMinScore : undefined,
      minSelfPlayReward: options.selfPlayMinReward !== null ? options.selfPlayMinReward : undefined
    });
  }

  console.log(
    `[colab-train] Starting ${options.mode} training` +
    ` | difficulty=${options.difficulty}` +
    ` | episodes=${options.episodes}` +
    ` | agents=${options.mode === 'selfplay' ? options.agents : 1}` +
    ` | autosave-ms=${options.autoSaveMs}`
  );

  const startedAt = Date.now();
  const progressTimer = setInterval(() => {
    console.log(buildProgressLine(session, options, startedAt));
  }, options.progressMs);

  const stopAndExit = () => {
    clearInterval(progressTimer);
    if (session.isTraining) {
      console.log('[colab-train] Interrupt received, saving current weights...');
      session.stopTraining();
    }
    process.exit(130);
  };

  process.on('SIGINT', stopAndExit);
  process.on('SIGTERM', stopAndExit);

  await new Promise((resolve, reject) => {
    const done = () => resolve();
    const started = options.mode === 'selfplay'
      ? session.startSelfPlayTraining(options.episodes, options.agents, done)
      : session.startTraining(options.episodes, done);

    if (!started) {
      reject(new Error('Training session failed to start. Check whether the weights are frozen or another training job is already running.'));
    }
  });

  clearInterval(progressTimer);
  session.saveWeights();

  const copiedFiles = copyFinalWeights(session, options.outputDir);
  const finalStatus = session.getStatus();
  const finalStats = finalStatus.stats || {};

  console.log(`[colab-train] Complete in ${formatDuration(Date.now() - startedAt)}`);
  console.log(
    `[colab-train] Final stats` +
    ` | states=${formatNumber(finalStats.states)}` +
    ` | epsilon=${finalStats.epsilon}` +
    ` | avgReward=${finalStats.avgReward}` +
    ` | totalEpisodes=${formatNumber(finalStats.totalEpisodes)}`
  );
  console.log(`[colab-train] Weights: ${session.compressedWeightsPath}`);
  if (fs.existsSync(session.weightsPath)) {
    console.log(`[colab-train] JSON weights: ${session.weightsPath}`);
  }
  if (copiedFiles.length > 0) {
    console.log(`[colab-train] Copied files:`);
    for (const copiedPath of copiedFiles) {
      console.log(`  - ${copiedPath}`);
    }
  }
}

main().catch((error) => {
  console.error(`[colab-train] ${error.message}`);
  process.exit(1);
});
