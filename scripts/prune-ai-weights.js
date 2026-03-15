#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function printUsage() {
  console.log('Usage: node scripts/prune-ai-weights.js [--difficulty hard,expert] [--min-abs-q 0.05] [--action-min-abs 0.01] [--round-decimals 3] [--no-backup] [--dry-run]');
}

function parseArgs(argv) {
  const options = {
    difficulties: ['hard', 'expert'],
    minAbsQ: 0.05,
    actionMinAbsQ: 0.01,
    roundDecimals: 3,
    backup: true,
    dryRun: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--difficulty' && argv[i + 1]) {
      options.difficulties = argv[++i].split(',').map((value) => value.trim()).filter(Boolean);
      continue;
    }
    if (arg === '--min-abs-q' && argv[i + 1]) {
      options.minAbsQ = Number(argv[++i]);
      continue;
    }
    if (arg === '--action-min-abs' && argv[i + 1]) {
      options.actionMinAbsQ = Number(argv[++i]);
      continue;
    }
    if (arg === '--round-decimals' && argv[i + 1]) {
      options.roundDecimals = Number(argv[++i]);
      continue;
    }
    if (arg === '--no-backup') {
      options.backup = false;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.minAbsQ) || options.minAbsQ < 0) {
    throw new Error('Expected --min-abs-q to be a non-negative number.');
  }
  if (!Number.isFinite(options.actionMinAbsQ) || options.actionMinAbsQ < 0) {
    throw new Error('Expected --action-min-abs to be a non-negative number.');
  }
  if (!Number.isFinite(options.roundDecimals) || options.roundDecimals < 0) {
    throw new Error('Expected --round-decimals to be a non-negative number.');
  }

  return options;
}

function copyIfExists(filePath, backupSuffix) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const backupPath = `${filePath}.${backupSuffix}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function formatBytes(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 1024) {
    return `${sizeBytes || 0} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = sizeBytes;
  let idx = -1;
  do {
    value /= 1024;
    idx++;
  } while (value >= 1024 && idx < units.length - 1);
  return `${value.toFixed(2)} ${units[idx]}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.env.MW_RL_PRUNE_MIN_ABS_Q = String(options.minAbsQ);
  process.env.MW_RL_PRUNE_ACTION_MIN_ABS_Q = String(options.actionMinAbsQ);
  process.env.MW_RL_WEIGHT_ROUND_DECIMALS = String(options.roundDecimals);

  const { TrainingSession } = require(path.join(__dirname, '..', 'ai-training'));
  const backupSuffix = new Date().toISOString().replace(/[:.]/g, '-');

  for (const difficulty of options.difficulties) {
    const session = new TrainingSession(difficulty);
    const compressedPath = session.compressedWeightsPath;
    const jsonPath = session.weightsPath;
    const beforePrune = { ...session.lastPruneStats };
    const beforeSize = fs.existsSync(compressedPath) ? fs.statSync(compressedPath).size : 0;

    let backupCompressedPath = null;
    let backupJsonPath = null;
    if (options.backup && !options.dryRun) {
      backupCompressedPath = copyIfExists(compressedPath, backupSuffix);
      backupJsonPath = copyIfExists(jsonPath, backupSuffix);
    }

    if (!options.dryRun) {
      session.saveWeights();
    }

    const afterStats = options.dryRun
      ? beforePrune
      : { ...session.lastPruneStats };
    const afterSize = !options.dryRun && fs.existsSync(compressedPath)
      ? fs.statSync(compressedPath).size
      : beforeSize;
    const effectivePruneStats = beforePrune.beforeStateCount > 0
      ? beforePrune
      : afterStats;

    console.log(
      [
        `[${difficulty}]`,
        `states ${effectivePruneStats.beforeStateCount || effectivePruneStats.afterStateCount || 0} -> ${effectivePruneStats.afterStateCount || 0}`,
        `pruned ${effectivePruneStats.prunedStates || 0}`,
        `zeroedActions ${effectivePruneStats.zeroedActions || 0}`,
        `gzip ${formatBytes(beforeSize)} -> ${formatBytes(afterSize)}`
      ].join(' | ')
    );

    if (backupCompressedPath) {
      console.log(`  backup: ${path.basename(backupCompressedPath)}`);
    }
    if (backupJsonPath) {
      console.log(`  backup: ${path.basename(backupJsonPath)}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
