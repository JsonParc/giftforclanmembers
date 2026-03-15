const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_MIN_ABS_Q = 0.05;
const DEFAULT_MIN_ACTION_ABS_Q = 0.01;
const DEFAULT_ROUND_DECIMALS = 3;
const DEFAULT_GZIP_LEVEL = 6;

function printHelp() {
  console.log(
    'Usage: node scripts/merge-ai-weights.js ' +
    '--base <path> --incoming <path> [--output <path>] [--incoming-weight <0..1>] [--no-backup]'
  );
}

function parseArgs(argv) {
  const options = {
    base: '',
    incoming: '',
    output: '',
    incomingWeight: 0.5,
    backup: true
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--base':
        options.base = String(argv[++i] || '');
        break;
      case '--incoming':
        options.incoming = String(argv[++i] || '');
        break;
      case '--output':
        options.output = String(argv[++i] || '');
        break;
      case '--incoming-weight':
        options.incomingWeight = Number(argv[++i]);
        break;
      case '--no-backup':
        options.backup = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    return options;
  }

  if (!options.base || !options.incoming) {
    throw new Error('Both --base and --incoming are required.');
  }
  if (!Number.isFinite(options.incomingWeight) || options.incomingWeight < 0 || options.incomingWeight > 1) {
    throw new Error('--incoming-weight must be between 0 and 1.');
  }
  if (!options.output) {
    options.output = options.base;
  }
  return options;
}

function readWeights(filePath) {
  const buffer = fs.readFileSync(filePath);
  const isGzip = filePath.endsWith('.gz');
  const raw = isGzip ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
  return JSON.parse(raw);
}

function writeWeights(filePath, data) {
  const json = JSON.stringify(data);
  if (filePath.endsWith('.gz')) {
    fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(json, 'utf8'), { level: DEFAULT_GZIP_LEVEL }));
    return;
  }
  fs.writeFileSync(filePath, json, 'utf8');
}

function normalizeActionRow(row, actionCount) {
  const normalized = new Array(actionCount).fill(0);
  let maxAbsQ = 0;
  let nonZeroActionCount = 0;
  const factor = Math.pow(10, DEFAULT_ROUND_DECIMALS);

  for (let i = 0; i < actionCount; i++) {
    const rawValue = Array.isArray(row) ? row[i] : undefined;
    let value = Number.isFinite(rawValue) ? rawValue : 0;
    value = Math.round(value * factor) / factor;
    if (Math.abs(value) < DEFAULT_MIN_ACTION_ABS_Q) {
      value = 0;
    }
    normalized[i] = value;
    const absValue = Math.abs(value);
    if (absValue > maxAbsQ) {
      maxAbsQ = absValue;
    }
    if (absValue > 0) {
      nonZeroActionCount++;
    }
  }

  return { row: normalized, maxAbsQ, nonZeroActionCount };
}

function pruneWeightTable(table, actionCount) {
  const nextTable = {};
  let prunedStates = 0;

  for (const [stateKey, row] of Object.entries(table || {})) {
    const normalized = normalizeActionRow(row, actionCount);
    if (normalized.maxAbsQ <= 0 || normalized.nonZeroActionCount <= 0 || normalized.maxAbsQ < DEFAULT_MIN_ABS_Q) {
      prunedStates++;
      continue;
    }
    nextTable[stateKey] = normalized.row;
  }

  return {
    table: nextTable,
    prunedStates
  };
}

function inferActionCount(...tables) {
  let actionCount = 0;
  for (const table of tables) {
    for (const row of Object.values(table || {})) {
      if (Array.isArray(row) && row.length > actionCount) {
        actionCount = row.length;
      }
    }
  }
  return actionCount;
}

function mergeRows(baseRow, incomingRow, baseWeight, incomingWeight, actionCount) {
  const merged = new Array(actionCount).fill(0);
  for (let i = 0; i < actionCount; i++) {
    const a = Number.isFinite(baseRow?.[i]) ? baseRow[i] : 0;
    const b = Number.isFinite(incomingRow?.[i]) ? incomingRow[i] : 0;
    merged[i] = (a * baseWeight) + (b * incomingWeight);
  }
  return merged;
}

function sumNumericLeaves(baseValue, incomingValue) {
  if (typeof baseValue === 'number' && typeof incomingValue === 'number') {
    return baseValue + incomingValue;
  }
  if (baseValue && incomingValue && typeof baseValue === 'object' && typeof incomingValue === 'object' && !Array.isArray(baseValue) && !Array.isArray(incomingValue)) {
    const next = { ...baseValue };
    for (const [key, value] of Object.entries(incomingValue)) {
      if (key in next) {
        next[key] = sumNumericLeaves(next[key], value);
      } else {
        next[key] = value;
      }
    }
    return next;
  }
  return incomingValue ?? baseValue;
}

function timestampLabel(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const basePath = path.resolve(options.base);
  const incomingPath = path.resolve(options.incoming);
  const outputPath = path.resolve(options.output);
  const baseData = readWeights(basePath);
  const incomingData = readWeights(incomingPath);

  const baseDifficulty = baseData.difficulty || null;
  const incomingDifficulty = incomingData.difficulty || null;
  if (baseDifficulty && incomingDifficulty && baseDifficulty !== incomingDifficulty) {
    throw new Error(`Difficulty mismatch: ${baseDifficulty} vs ${incomingDifficulty}`);
  }

  const actionCount = inferActionCount(baseData.table, incomingData.table);
  if (actionCount <= 0) {
    throw new Error('Could not infer action count from input files.');
  }

  const baseWeight = 1 - options.incomingWeight;
  const incomingWeight = options.incomingWeight;
  const mergedTable = {};
  const baseTable = baseData.table || {};
  const incomingTable = incomingData.table || {};
  const stateKeys = new Set([...Object.keys(baseTable), ...Object.keys(incomingTable)]);

  let overlapCount = 0;
  let baseOnlyCount = 0;
  let incomingOnlyCount = 0;

  for (const stateKey of stateKeys) {
    const baseRow = baseTable[stateKey];
    const incomingRow = incomingTable[stateKey];
    if (baseRow && incomingRow) {
      overlapCount++;
      mergedTable[stateKey] = mergeRows(baseRow, incomingRow, baseWeight, incomingWeight, actionCount);
    } else if (baseRow) {
      baseOnlyCount++;
      mergedTable[stateKey] = baseRow;
    } else {
      incomingOnlyCount++;
      mergedTable[stateKey] = incomingRow;
    }
  }

  const pruned = pruneWeightTable(mergedTable, actionCount);
  const savedAtBase = Date.parse(baseData.savedAt || '') || 0;
  const savedAtIncoming = Date.parse(incomingData.savedAt || '') || 0;
  const latestData = savedAtIncoming >= savedAtBase ? incomingData : baseData;
  const mergedRecentRewards = [
    ...(Array.isArray(baseData.recentRewards) ? baseData.recentRewards : []),
    ...(Array.isArray(incomingData.recentRewards) ? incomingData.recentRewards : [])
  ].slice(-100);

  const mergedData = {
    table: pruned.table,
    epsilon: Math.min(
      Number.isFinite(baseData.epsilon) ? baseData.epsilon : 0.3,
      Number.isFinite(incomingData.epsilon) ? incomingData.epsilon : 0.3
    ),
    totalEpisodes: (Number(baseData.totalEpisodes) || 0) + (Number(incomingData.totalEpisodes) || 0),
    totalReward: (Number(baseData.totalReward) || 0) + (Number(incomingData.totalReward) || 0),
    recentRewards: mergedRecentRewards,
    frozen: !!baseData.frozen && !!incomingData.frozen,
    difficulty: latestData.difficulty || baseDifficulty || incomingDifficulty,
    recordingPolicy: latestData.recordingPolicy || baseData.recordingPolicy || incomingData.recordingPolicy || null,
    recordingStats: sumNumericLeaves(baseData.recordingStats || {}, incomingData.recordingStats || {}),
    savedAt: new Date().toISOString(),
    stateCount: Object.keys(pruned.table).length,
    mergeInfo: {
      baseFile: path.basename(basePath),
      incomingFile: path.basename(incomingPath),
      incomingWeight,
      baseWeight,
      overlapStates: overlapCount,
      baseOnlyStates: baseOnlyCount,
      incomingOnlyStates: incomingOnlyCount,
      prunedStates: pruned.prunedStates
    }
  };

  if (options.backup && fs.existsSync(outputPath)) {
    const backupPath = `${outputPath}.backup-${timestampLabel()}`;
    fs.copyFileSync(outputPath, backupPath);
    console.log(`Backup created: ${path.basename(backupPath)}`);
  }

  writeWeights(outputPath, mergedData);

  console.log(`Merged output: ${path.basename(outputPath)}`);
  console.log(`States: ${mergedData.stateCount}`);
  console.log(`Episodes: ${mergedData.totalEpisodes}`);
  console.log(`Overlap/baseOnly/incomingOnly: ${overlapCount}/${baseOnlyCount}/${incomingOnlyCount}`);
  console.log(`Pruned states: ${pruned.prunedStates}`);
}

main();
