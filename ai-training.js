/**
 * ai-training.js — Reinforcement Learning module for MW Craft AI
 *
 * Q-learning based system with:
 * - State discretization (resources, units, buildings, combat power ratio)
 * - Action space (build/produce/attack/defend/skill decisions)
 * - Experience replay + epsilon-greedy policy
 * - Training via accelerated headless game simulation
 * - Difficulty tiers (Easy/Normal/Hard/Expert)
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const { createWeightStorageHelpers } = require('./lib/ai-training/weight-storage');

const EXTERNAL_WEIGHTS_URLS = Object.freeze({
  hard: process.env.MW_RL_WEIGHTS_HARD_URL || 'https://drive.google.com/uc?export=download&id=19iFoCr5N69GBYFJR5RuRLJLr2lPQfTNt',
  expert: process.env.MW_RL_WEIGHTS_EXPERT_URL || 'https://drive.google.com/uc?export=download&id=1f38P1dYPT-F9MpGTPuqL2EgssWuasJkU'
});
const RL_WEIGHT_PRUNE_MIN_ABS_Q = Math.max(0, Number(process.env.MW_RL_PRUNE_MIN_ABS_Q || 0.05));
const RL_WEIGHT_PRUNE_ACTION_MIN_ABS_Q = Math.max(0, Number(process.env.MW_RL_PRUNE_ACTION_MIN_ABS_Q || 0.01));
const RL_WEIGHT_ROUND_DECIMALS = Math.max(0, Math.min(6, Number(process.env.MW_RL_WEIGHT_ROUND_DECIMALS || 3)));
const RL_WEIGHT_PRUNE_ON_LOAD = process.env.MW_RL_PRUNE_ON_LOAD !== '0';
const RL_WEIGHT_SAVE_PLAIN_JSON = process.env.MW_RL_SAVE_JSON === '1';
const RL_WEIGHT_GZIP_LEVEL = Math.max(1, Math.min(9, Number(process.env.MW_RL_GZIP_LEVEL || 6)));
const RL_TRAINING_MIN_RECORD_SCORE = (() => {
  const value = Number(process.env.MW_RL_MIN_RECORD_SCORE || 500);
  return Number.isFinite(value) ? Math.max(0, value) : 500;
})();
const RL_SELFPLAY_MIN_AGENT_REWARD = (() => {
  const value = Number(process.env.MW_RL_SELFPLAY_MIN_AGENT_REWARD || 0);
  return Number.isFinite(value) ? value : 0;
})();
const RL_FAILURE_REPLAY_ENABLED = process.env.MW_RL_LEARN_FROM_FAILURES !== '0';
const RL_FAILURE_REPLAY_LIMIT = (() => {
  const value = Number(process.env.MW_RL_FAILURE_REPLAY_LIMIT || 24);
  return Number.isFinite(value) ? Math.max(1, Math.min(200, Math.floor(value))) : 24;
})();
const RL_FAILURE_REPLAY_PENALTY_SCALE = (() => {
  const value = Number(process.env.MW_RL_FAILURE_REPLAY_PENALTY_SCALE || 1.15);
  return Number.isFinite(value) ? Math.max(0.1, Math.min(5, value)) : 1.15;
})();
const RL_FAILURE_REWARD_THRESHOLD = (() => {
  const value = Number(process.env.MW_RL_FAILURE_REWARD_THRESHOLD || 0);
  return Number.isFinite(value) ? value : 0;
})();

// ========== STATE ENCODING ==========

// Discretize a continuous value into buckets
function discretize(value, thresholds) {
  for (let i = 0; i < thresholds.length; i++) {
    if (value <= thresholds[i]) return i;
  }
  return thresholds.length;
}

/**
 * Encode the game state for a given AI player into a discrete state key.
 * Returns a bucketized abstract state string shared by live play and offline training.
 */
function encodeState(gameState, playerId) {
  const summary = summarizeLiveGameState(gameState, playerId);
  if (!summary) return 'dead';
  return encodeAbstractState(summary);
}

function isAuxiliaryAirUnitType(unitOrType) {
  const type = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
  return type === 'aircraft' || type === 'recon_aircraft';
}

const COMBAT_POWER_MAP = {
  slbm: 650,
  frigate: 38,
  destroyer: 95,
  cruiser: 260,
  battleship: 780,
  carrier: 560,
  submarine: 420,
  assaultship: 260,
  missile_launcher: 520
};

const COMBAT_UNIT_TYPES = Object.freeze([
  'frigate',
  'destroyer',
  'cruiser',
  'battleship',
  'carrier',
  'submarine',
  'assaultship',
  'missile_launcher'
]);

const SNAPSHOT_COMBAT_FIELD_MAP = Object.freeze([
  { type: 'frigate', ownField: 'frigateCount', enemyField: 'enemyFrigateCount' },
  { type: 'destroyer', ownField: 'destroyerCount', enemyField: 'enemyDestroyerCount' },
  { type: 'cruiser', ownField: 'cruiserCount', enemyField: 'enemyCruiserCount' },
  { type: 'battleship', ownField: 'battleshipCount', enemyField: 'enemyBattleshipCount' },
  { type: 'carrier', ownField: 'carrierCount', enemyField: 'enemyCarrierCount' },
  { type: 'submarine', ownField: 'submarineCount', enemyField: 'enemySubmarineCount' },
  { type: 'assaultship', ownField: 'assaultshipCount', enemyField: 'enemyAssaultshipCount' },
  { type: 'missile_launcher', ownField: 'launcherCount', enemyField: 'enemyLauncherCount' }
]);

const UNIT_KILL_SCORE_MAP = Object.freeze({
  frigate: 18,
  destroyer: 30,
  cruiser: 58,
  battleship: 118,
  carrier: 104,
  submarine: 82,
  assaultship: 66,
  missile_launcher: 92
});

const UNIT_LOSS_SCORE_MAP = Object.freeze({
  frigate: 24,
  destroyer: 40,
  cruiser: 76,
  battleship: 146,
  carrier: 126,
  submarine: 102,
  assaultship: 84,
  missile_launcher: 112
});

const BUILDING_RETENTION_SCORE_MAP = Object.freeze({
  power_plant: 10,
  shipyard: 16,
  naval_academy: 26,
  missile_silo: 36,
  defense_tower: 16,
  carbase: 24
});

const RL_HOME_THREAT_POINT_WINDOW_MS = 12000;
const RL_RECENT_BUILDING_DAMAGE_WINDOW_MS = 4500;
const RL_HOME_THREAT_RADIUS = 2200;
const RL_DEFENSE_RESPONSE_RADIUS = 2500;
const DEFENSE_RESPONSE_ACTION_WEIGHTS = Object.freeze({
  defend_base: 1.0,
  attack_nearest_enemy: 0.95,
  attack_strongest_enemy: 0.95,
  activate_aegis: 0.85,
  deploy_launchers: 0.8,
  use_slbm: 0.8,
  use_airstrike: 0.8,
  skill_search: 0.7,
  lay_mines: 0.55,
  build_defense_tower: 0.5,
  produce_missile_launcher: 0.45,
  produce_cruiser: 0.3,
  produce_battleship: 0.25,
  produce_carrier: 0.22,
  produce_submarine: 0.18
});

function getLightFleetRatio(source) {
  const frigateCount = Math.max(0, Math.floor(source?.frigateCount || 0));
  const destroyerCount = Math.max(0, Math.floor(source?.destroyerCount || 0));
  const cruiserCount = Math.max(0, Math.floor(source?.cruiserCount || 0));
  const battleshipCount = Math.max(0, Math.floor(source?.battleshipCount || 0));
  const carrierCount = Math.max(0, Math.floor(source?.carrierCount || 0));
  const submarineCount = Math.max(0, Math.floor(source?.submarineCount || 0));
  const assaultshipCount = Math.max(0, Math.floor(source?.assaultshipCount || 0));
  const launcherCount = Math.max(0, Math.floor(source?.launcherCount || 0))
    + Math.max(0, Math.floor(source?.deployedLauncherCount || 0));
  const totalCombatUnits = frigateCount
    + destroyerCount
    + cruiserCount
    + battleshipCount
    + carrierCount
    + submarineCount
    + assaultshipCount
    + launcherCount;
  if (totalCombatUnits <= 0) return 0;
  return (frigateCount + destroyerCount) / totalCombatUnits;
}

function getDefenseResponseActionWeight(actionRef) {
  const actionName = typeof actionRef === 'number' ? ACTIONS[actionRef] : actionRef;
  if (!actionName) return 0;
  return DEFENSE_RESPONSE_ACTION_WEIGHTS[actionName] || 0;
}

const BUILDING_LOSS_SCORE_MAP = Object.freeze({
  power_plant: 28,
  shipyard: 44,
  naval_academy: 64,
  missile_silo: 96,
  defense_tower: 30,
  carbase: 68
});

function getStrategicDefenseScore(source) {
  const towerCount = getBuildingCountFromSource(source, 'defense_tower');
  const siloCount = getBuildingCountFromSource(source, 'missile_silo');
  const carbaseCount = getBuildingCountFromSource(source, 'carbase');
  const launcherCount = Math.max(0, Math.floor(source?.launcherCount ?? 0));
  const deployedLauncherCount = Math.max(0, Math.floor(source?.deployedLauncherCount ?? 0));
  return (
    towerCount * 1.45
    + siloCount * 1.2
    + carbaseCount * 0.8
    + launcherCount * 1.15
    + deployedLauncherCount * 0.9
  );
}

function getEstimatedEnemyDefensePressure(source) {
  const enemyLauncherCount = Math.max(0, Math.floor(source?.enemyLauncherCount ?? 0));
  const enemyBuildingCount = Math.max(0, Math.floor(source?.enemyBuildingCount ?? 0));
  const enemyCombatPower = Math.max(0, Number(source?.enemyCombatPower || 0));
  const ownCombatPower = Math.max(0, Number(source?.combatPower || 0));
  const combatGapPressure = Math.max(0, (enemyCombatPower - (ownCombatPower * 0.9)) / 190);
  return (
    enemyLauncherCount * 1.35
    + Math.max(0, enemyBuildingCount - 1) * 0.42
    + combatGapPressure
  );
}

function getSoloSlbmStrikeOpportunity(source) {
  const enemyBuildingCount = Math.max(0, Math.floor(source?.enemyBuildingCount ?? 0));
  const enemyCombatPower = Math.max(0, Number(source?.enemyCombatPower || 0));
  const enemyDefensePressure = Math.max(0, getEstimatedEnemyDefensePressure(source));
  return (
    enemyBuildingCount * 1.7
    + enemyDefensePressure * 2.4
    + Math.min(8, enemyCombatPower / 260)
  );
}

function getSelfPlaySlbmTargetScore(enemy) {
  if (!enemy || !enemy.alive) return -Infinity;
  const buildingCount = Math.max(0, Math.floor(enemy.buildingCount || 0));
  const defenseScore = getStrategicDefenseScore(enemy);
  const techScore = getTechProgressScore(enemy);
  const combatPower = Math.max(0, Number(enemy.combatPower || 0));
  const capitalShips = Math.max(
    0,
    Math.floor(enemy.battleshipCount || 0)
      + Math.floor(enemy.carrierCount || 0)
      + Math.floor(enemy.submarineCount || 0)
  );
  return (
    buildingCount * 18
    + defenseScore * 24
    + techScore * 10
    + capitalShips * 28
    + Math.min(240, combatPower * 0.12)
  );
}

function pickBestSelfPlaySlbmTarget(enemies) {
  if (!Array.isArray(enemies) || enemies.length <= 0) return null;
  let bestEnemy = null;
  let bestScore = -Infinity;
  for (const enemy of enemies) {
    const score = getSelfPlaySlbmTargetScore(enemy);
    if (score > bestScore) {
      bestScore = score;
      bestEnemy = enemy;
    }
  }
  return bestEnemy;
}

function getBuildingCountFromSource(source, buildingType) {
  switch (buildingType) {
    case 'power_plant':
      return Math.max(0, Math.floor(source?.powerPlantCount ?? source?.completedBuildings?.power_plant ?? 0));
    case 'shipyard':
      return Math.max(0, Math.floor(source?.shipyardCount ?? source?.completedBuildings?.shipyard ?? 0));
    case 'naval_academy':
      return Math.max(0, Math.floor(source?.navalAcademyCount ?? source?.completedBuildings?.naval_academy ?? 0));
    case 'missile_silo':
      return Math.max(0, Math.floor(source?.siloCount ?? source?.completedBuildings?.missile_silo ?? 0));
    case 'defense_tower':
      return Math.max(0, Math.floor(source?.defenseTowerCount ?? source?.completedBuildings?.defense_tower ?? 0));
    case 'carbase':
      return Math.max(0, Math.floor(source?.carbaseCount ?? source?.completedBuildings?.carbase ?? 0));
    default:
      return 0;
  }
}

function getBuildingRetentionScore(source) {
  let total = 0;
  for (const [buildingType, score] of Object.entries(BUILDING_RETENTION_SCORE_MAP)) {
    total += getBuildingCountFromSource(source, buildingType) * score;
  }
  return total;
}

function getBuildingLossPenaltyScore(buildingType) {
  return BUILDING_LOSS_SCORE_MAP[buildingType] || 0;
}

function getSnapshotUnitDeltaScore(prevSnapshot, currentSnapshot, fieldKey, scoreMap) {
  let total = 0;
  for (const field of SNAPSHOT_COMBAT_FIELD_MAP) {
    const prevCount = Math.max(0, Math.floor(prevSnapshot?.[field[fieldKey]] || 0));
    const currentCount = Math.max(0, Math.floor(currentSnapshot?.[field[fieldKey]] || 0));
    const lostCount = Math.max(0, prevCount - currentCount);
    total += lostCount * (scoreMap[field.type] || 0);
  }
  return total;
}

function getLossPenaltyScoreFromSummary(summary) {
  let total = 0;
  for (const [unitType, count] of Object.entries(summary?.lostByType || {})) {
    total += Math.max(0, Math.floor(count || 0)) * (UNIT_LOSS_SCORE_MAP[unitType] || 0);
  }
  return total;
}

function getKillRewardScoreFromSummary(summary) {
  let total = 0;
  for (const [unitType, count] of Object.entries(summary?.lostByType || {})) {
    total += Math.max(0, Math.floor(count || 0)) * (UNIT_KILL_SCORE_MAP[unitType] || 0);
  }
  return total;
}

function getCombatUnitTypeCounts(source) {
  return {
    frigate: Math.max(0, Math.floor(source?.frigateCount || 0)),
    destroyer: Math.max(0, Math.floor(source?.destroyerCount || 0)),
    cruiser: Math.max(0, Math.floor(source?.cruiserCount || 0)),
    battleship: Math.max(0, Math.floor(source?.battleshipCount || 0)),
    carrier: Math.max(0, Math.floor(source?.carrierCount || 0)),
    submarine: Math.max(0, Math.floor(source?.submarineCount || 0)),
    assaultship: Math.max(0, Math.floor(source?.assaultshipCount || 0)),
    missile_launcher: Math.max(
      0,
      Math.floor(source?.launcherCount || 0) + Math.floor(source?.deployedLauncherCount || 0)
    )
  };
}

function getCombatUnitCount(source) {
  const counts = getCombatUnitTypeCounts(source);
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function getFleetDiversityScore(source) {
  const counts = getCombatUnitTypeCounts(source);
  return Object.values(counts).reduce((sum, count) => sum + (count > 0 ? 1 : 0), 0);
}

function getDominantCombatUnitType(source) {
  const counts = getCombatUnitTypeCounts(source);
  let dominantType = null;
  let dominantCount = 0;
  for (const [unitType, count] of Object.entries(counts)) {
    if (count > dominantCount) {
      dominantType = unitType;
      dominantCount = count;
    }
  }
  return dominantType;
}

function getFleetDominanceRatio(source) {
  const counts = getCombatUnitTypeCounts(source);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total <= 0) return 0;
  const dominant = Math.max(...Object.values(counts));
  return dominant / total;
}

function getTechProgressScore(source) {
  return (
    Math.max(0, Math.floor(source?.powerPlantCount || source?.completedBuildings?.power_plant || 0)) +
    Math.max(0, Math.floor(source?.shipyardCount || source?.completedBuildings?.shipyard || 0)) * 2 +
    Math.max(0, Math.floor(source?.navalAcademyCount || source?.completedBuildings?.naval_academy || 0)) * 4 +
    Math.max(0, Math.floor(source?.siloCount || source?.completedBuildings?.missile_silo || 0)) * 3 +
    Math.max(0, Math.floor(source?.carbaseCount || source?.completedBuildings?.carbase || 0)) * 2
  );
}

function getPreferredWorkerTarget(source) {
  const buildingCount = Math.max(1, Math.floor(source?.buildingCount || 0));
  const techScore = getTechProgressScore(source);
  if (techScore >= 10 || buildingCount >= 8) return 5;
  if (techScore >= 5 || buildingCount >= 4) return 4;
  return 3;
}

function getQueuedBuildingReward(state, buildingType) {
  const powerPlantCount = getCompletedBuildingCount(state, 'power_plant');
  const shipyardCount = getCompletedBuildingCount(state, 'shipyard');
  const academyCount = getCompletedBuildingCount(state, 'naval_academy');
  const towerCount = getCompletedBuildingCount(state, 'defense_tower');
  const energyIncome = getSimulationEnergyIncomePerSecond(state);
  const energySpend = getSimulationEnergySpendPerSecond(state);
  const spendPressure = energySpend - (energyIncome + SIM_BASE_PASSIVE_INCOME);
  const shipyardLoad = getSimulationProducerLoad(state, 'shipyard');
  const freePopulation = Math.max(0, Math.floor((state.maxPopulation || 0) - (state.population || 0)));
  const populationUtilization = getPopulationUtilization(state);
  const towerPressure = state.enemyCombatPower > Math.max(180, state.combatPower * 0.75);
  switch (buildingType) {
    case 'power_plant':
      if (powerPlantCount <= 1) return 1.35 + (freePopulation <= 4 ? 0.2 : 0);
      if (spendPressure > 4) return 1.05 + (populationUtilization >= 0.72 ? 0.18 : 0);
      return energyIncome < 15 ? 0.6 : 0.2;
    case 'shipyard':
      if (shipyardCount <= 0) return 1.4 + (populationUtilization >= 0.65 ? 0.18 : 0);
      if (energyIncome >= 12 && shipyardLoad >= Math.max(2, shipyardCount * 2)) return 0.95 + (freePopulation <= 6 ? 0.2 : 0);
      return 0.35;
    case 'naval_academy':
      if (shipyardCount <= 0) return 0.1;
      return academyCount <= 0 && energyIncome >= 8 && powerPlantCount >= 3
        ? 2.65 + (populationUtilization >= 0.68 ? 0.34 : 0) + (shipyardCount >= 2 ? 0.18 : 0)
        : 0.95 + (freePopulation <= 8 ? 0.2 : 0);
    case 'missile_silo':
      return academyCount > 0 && energyIncome >= 14
        ? 1.8
          + (towerCount > 0 ? 0.15 : 0)
          + (state.enemyBuildingCount >= 4 ? 0.2 : 0)
          + Math.min(0.35, getSoloSlbmStrikeOpportunity(state) * 0.04)
        : 0.24;
    case 'defense_tower':
      if (towerPressure) return towerCount <= 0 ? 2.6 : 1.9;
      return towerCount <= 0 ? 1.0 : 0.45;
    case 'carbase':
      return getCompletedBuildingCount(state, 'missile_silo') > 0 && energyIncome >= 16
        ? 1.55
          + (state.enemyCombatPower > Math.max(240, state.combatPower * 0.85) ? 0.2 : 0)
          + (state.enemyBuildingCount >= 4 ? 0.12 : 0)
        : 0.24;
    default:
      return 0.2;
  }
}

function getQueuedProductionReward(state, itemType) {
  if (itemType === 'worker') {
    return state.workerCount < getPreferredWorkerTarget(state) ? 0.85 : 0.12;
  }
  if (itemType === 'slbm') {
    const slbmOpportunity = getSoloSlbmStrikeOpportunity(state);
    return state.submarineCount > 0
      ? 1.0
        + Math.min(0.45, getCompletedBuildingCount(state, 'missile_silo') * 0.16)
        + (state.enemyBuildingCount >= 4 ? 0.24 : 0)
        + Math.min(0.45, slbmOpportunity * 0.035)
      : 0.12;
  }

  const diversity = getFleetDiversityScore(state);
  const dominantType = getDominantCombatUnitType(state);
  const dominance = getFleetDominanceRatio(state);
  const combatPopulation = getCombatPopulation(state);
  const populationUtilization = getPopulationUtilization(state);
  const techScore = getTechProgressScore(state);
  const powerPlantCount = getCompletedBuildingCount(state, 'power_plant');
  const navalAcademyCount = getCompletedBuildingCount(state, 'naval_academy');
  const lightFleetRatio = getLightFleetRatio(state);
  let reward = itemType === 'missile_launcher' && getCompletedBuildingCount(state, 'missile_silo') <= 0 ? 0.05 : 0.18;

  if (diversity < 3 && dominantType && dominantType !== itemType) reward += 0.08;
  if (dominantType === itemType && dominance > 0.68) reward -= 0.18;
  reward += Math.min(0.35, combatPopulation * 0.006);
  if (populationUtilization >= 0.55) reward += 0.08;
  if (populationUtilization >= 0.78) reward += 0.1;
  if (itemType === 'missile_launcher') {
    if (getCompletedBuildingCount(state, 'carbase') > 0) reward += 0.24;
    if (state.enemyCombatPower > Math.max(240, state.combatPower * 0.82)) reward += 0.22;
  }
  if (navalAcademyCount > 0 && techScore >= 8 && powerPlantCount >= 4) {
    if ((itemType === 'frigate' || itemType === 'destroyer') && lightFleetRatio > 0.52) reward -= 0.3;
    if ((itemType === 'cruiser' || itemType === 'missile_launcher' || itemType === 'battleship' || itemType === 'carrier' || itemType === 'submarine') && lightFleetRatio > 0.48) {
      reward += 0.12;
    }
  }
  if (itemType === 'submarine' && getCompletedBuildingCount(state, 'missile_silo') > 0) {
    reward += 0.24 + Math.min(0.24, getSoloSlbmStrikeOpportunity(state) * 0.02);
  }
  return reward;
}

function getCompletedBuildingReward(state, buildingType, baseReward) {
  let reward = baseReward;
  const powerPlantCount = getCompletedBuildingCount(state, 'power_plant');
  const shipyardCount = getCompletedBuildingCount(state, 'shipyard');
  const academyCount = getCompletedBuildingCount(state, 'naval_academy');
  const towerCount = getCompletedBuildingCount(state, 'defense_tower');
  const energyIncome = getSimulationEnergyIncomePerSecond(state);
  const energySpend = getSimulationEnergySpendPerSecond(state);
  const spendPressure = energySpend - (energyIncome + SIM_BASE_PASSIVE_INCOME);
  const freePopulation = Math.max(0, Math.floor((state.maxPopulation || 0) - (state.population || 0)));
  const populationUtilization = getPopulationUtilization(state);
  const towerPressure = state.enemyCombatPower > Math.max(180, state.combatPower * 0.75);
  switch (buildingType) {
    case 'power_plant':
      reward += powerPlantCount <= 2 ? 1.0 : (spendPressure > 4 ? 0.6 : 0.2);
      if (populationUtilization >= 0.7) reward += 0.2;
      break;
    case 'shipyard':
      reward += shipyardCount <= 1 ? 1.6 : 0.45;
      if (freePopulation <= 6) reward += 0.2;
      break;
    case 'naval_academy':
      reward += academyCount <= 1 ? 3.15 : 1.1;
      if (populationUtilization >= 0.7) reward += 0.25;
      break;
    case 'missile_silo':
      reward += academyCount > 0 && energyIncome >= 14
        ? 1.9 + (towerCount > 0 ? 0.2 : 0) + Math.min(0.45, getSoloSlbmStrikeOpportunity(state) * 0.035)
        : 0.55;
      break;
    case 'carbase':
      reward += getCompletedBuildingCount(state, 'missile_silo') > 0 && energyIncome >= 16
        ? 1.7 + (state.enemyCombatPower > Math.max(240, state.combatPower * 0.82) ? 0.2 : 0)
        : 0.45;
      break;
    case 'defense_tower':
      reward += towerPressure ? (towerCount <= 1 ? 2.25 : 1.35) : (towerCount <= 1 ? 0.95 : 0.45);
      break;
    default:
      break;
  }
  return reward;
}

function getCompletedProductionReward(state, itemType, baseReward) {
  let reward = baseReward;
  if (itemType === 'worker') {
    return reward + (state.workerCount <= getPreferredWorkerTarget(state) ? 0.7 : 0.08);
  }
  if (itemType === 'slbm') {
    return reward + (
      state.submarineCount > 0
        ? 1.35
          + (state.enemyBuildingCount >= 4 ? 0.28 : 0)
          + Math.min(0.5, getSoloSlbmStrikeOpportunity(state) * 0.04)
        : 0.24
    );
  }

  const diversity = getFleetDiversityScore(state);
  const dominantType = getDominantCombatUnitType(state);
  const dominance = getFleetDominanceRatio(state);
  const combatPopulation = getCombatPopulation(state);
  const populationUtilization = getPopulationUtilization(state);
  const techScore = getTechProgressScore(state);
  const powerPlantCount = getCompletedBuildingCount(state, 'power_plant');
  const navalAcademyCount = getCompletedBuildingCount(state, 'naval_academy');
  const lightFleetRatio = getLightFleetRatio(state);
  if (diversity >= 3) reward += 0.15;
  if (diversity < 3 && dominantType && dominantType !== itemType) reward += 0.12;
  if (dominantType === itemType && dominance > 0.68) reward -= 0.35;
  reward += Math.min(0.45, combatPopulation * 0.008);
  if (populationUtilization >= 0.6) reward += 0.1;
  if (populationUtilization >= 0.8) reward += 0.12;
  if ((itemType === 'battleship' || itemType === 'carrier' || itemType === 'submarine') && techScore >= 6 && powerPlantCount >= 4) {
    reward += 0.28;
  }
  if (itemType === 'submarine' && getCompletedBuildingCount(state, 'missile_silo') > 0) {
    reward += 0.32 + Math.min(0.28, getSoloSlbmStrikeOpportunity(state) * 0.024);
  }
  if ((itemType === 'frigate' || itemType === 'destroyer') && techScore >= 8 && dominance > 0.65) {
    reward -= 0.18;
  }
  if (navalAcademyCount > 0 && techScore >= 8 && powerPlantCount >= 4) {
    if ((itemType === 'frigate' || itemType === 'destroyer') && lightFleetRatio > 0.52) reward -= 0.42;
    if ((itemType === 'cruiser' || itemType === 'missile_launcher' || itemType === 'battleship' || itemType === 'carrier' || itemType === 'submarine') && lightFleetRatio > 0.48) {
      reward += 0.16;
    }
  }
  if (itemType === 'missile_launcher' && getCompletedBuildingCount(state, 'carbase') > 0) {
    reward += 0.3;
  }
  return reward;
}

// Unit range tiers (abstracted from actual game values)
// 0=melee/none, 1=short(~750), 2=mid(~1250-2000), 3=long(~2500+)
const UNIT_RANGE_TIER = {
  frigate: 1, destroyer: 2, cruiser: 2,
  battleship: 3, carrier: 3, submarine: 1,
  assaultship: 0, missile_launcher: 3  // launcher deployed = 2500 range
};

// Unit vision tiers (abstracted)
// 0=none, 1=short(~800-1000), 2=mid(~1200-2000), 3=long(~3200+)
const UNIT_VISION_TIER = {
  frigate: 1, destroyer: 1, cruiser: 2,
  battleship: 3, carrier: 3, submarine: 1,
  assaultship: 2, missile_launcher: 1
};

const SUBMARINE_SLBM_CAPACITY = 3;

// ========== ACTION SPACE ==========

const ACTIONS = [
  'build_power_plant',
  'build_shipyard',
  'build_naval_academy',
  'build_missile_silo',
  'build_defense_tower',
  'build_carbase',
  'produce_worker',
  'produce_frigate',
  'produce_destroyer',
  'produce_cruiser',
  'produce_battleship',
  'produce_carrier',
  'produce_submarine',
  'produce_assaultship',
  'produce_missile_launcher',
  'produce_slbm',
  'attack_nearest_enemy',
  'attack_strongest_enemy',
  'defend_base',
  'scout',
  'load_submarine_slbm',
  'use_slbm',
  'use_airstrike',
  'activate_aegis',
  'lay_mines',
  'lure_tactic',
  'expand',
  'save_resources',
  // Skill actions — unit-specific abilities with cooldowns/timing
  'skill_aimed_shot',       // Battleship: 2x damage next attack (16s cd)
  'skill_combat_stance',    // Battleship: +atk speed stacking, costs HP per attack
  'skill_engine_overdrive', // Frigate: +speed, evasion up to 80%, costs HP/tick
  'skill_search',           // Destroyer: 4800-range vision pulse, reveals subs (16s cd)
  'skill_stealth',          // Submarine: 15s invisibility (30s cd)
  // Strategic actions — deploy, transport, amphibious
  'deploy_launchers',       // Deploy mobile launchers (huge range, can't move)
  'undeploy_launchers',     // Undeploy → mobile again
  'load_assault_ship',      // Load missile launchers onto assault ship
  'amphibious_landing',     // Sail assault ship to enemy island, unload + deploy
];

const ACTION_COUNT = ACTIONS.length;
const {
  getWeightsPaths,
  getExternalWeightsUrl,
  getAvailableWeightSources,
  readWeightsSource,
  writeFileAtomic,
  removeFileIfExists,
  pruneWeightTable,
  ensureExternalWeightsCached
} = createWeightStorageHelpers({
  fs,
  http,
  https,
  path,
  zlib,
  rootDir: __dirname,
  actionCount: ACTION_COUNT,
  externalWeightsUrls: EXTERNAL_WEIGHTS_URLS,
  pruneMinAbsQ: RL_WEIGHT_PRUNE_MIN_ABS_Q,
  pruneActionMinAbsQ: RL_WEIGHT_PRUNE_ACTION_MIN_ABS_Q,
  roundDecimals: RL_WEIGHT_ROUND_DECIMALS
});

const SIM_TICK_MS = 1000;
const SIM_BASE_PASSIVE_INCOME = 0;
const SIM_BUILDING_BUILD_TIME_MS = 10000;
const SIM_MAX_QUEUE_PER_PRODUCER = 10;
const SIM_STARTING_RESOURCES = 1000;
const SIM_STARTING_WORKERS = 4;
const SIM_BASE_POPULATION_CAP = 10;
const SIM_HEADQUARTERS_POPULATION_BONUS = 20;
const SIM_MAX_POPULATION_CAP = 250;
const SIM_STARTING_MAX_POPULATION = Math.min(
  SIM_MAX_POPULATION_CAP,
  SIM_BASE_POPULATION_CAP + SIM_HEADQUARTERS_POPULATION_BONUS
);

const SIM_BUILDING_DEFS = Object.freeze({
  headquarters: { cost: 800, buildTime: 0, popBonus: SIM_HEADQUARTERS_POPULATION_BONUS, completionReward: 2, combatPower: 120 },
  power_plant: { cost: 150, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 3, completionReward: 1, combatPower: 120 },
  shipyard: { cost: 200, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 5, completionReward: 2, combatPower: 120 },
  naval_academy: { cost: 300, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 10, completionReward: 2.5, combatPower: 150 },
  missile_silo: { cost: 1600, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 0, completionReward: 4.2, combatPower: 150 },
  defense_tower: { cost: 250, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 0, completionReward: 2.2, combatPower: 150 },
  carbase: { cost: 350, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 0, completionReward: 3.2, combatPower: 150 }
});

const SIM_UNIT_DEFS = Object.freeze({
  worker: { cost: 50, pop: 1, buildTime: 3000, combatPower: 0, producer: 'headquarters', countField: 'workerCount', completionReward: 0.6 },
  frigate: { cost: 135, pop: 1, buildTime: 6000, combatPower: COMBAT_POWER_MAP.frigate, producer: 'shipyard', countField: 'frigateCount', completionReward: 1.0 },
  destroyer: { cost: 170, pop: 2, buildTime: 9000, combatPower: COMBAT_POWER_MAP.destroyer, producer: 'shipyard', countField: 'destroyerCount', completionReward: 1.0 },
  cruiser: { cost: 285, pop: 3, buildTime: 14000, combatPower: COMBAT_POWER_MAP.cruiser, producer: 'shipyard', countField: 'cruiserCount', completionReward: 1.0 },
  battleship: { cost: 2400, pop: 20, buildTime: 70000, combatPower: COMBAT_POWER_MAP.battleship, producer: 'naval_academy', countField: 'battleshipCount', completionReward: 1.0 },
  carrier: { cost: 1600, pop: 12, buildTime: 40000, combatPower: COMBAT_POWER_MAP.carrier, producer: 'naval_academy', countField: 'carrierCount', completionReward: 1.0 },
  assaultship: { cost: 1000, pop: 10, buildTime: 26000, combatPower: COMBAT_POWER_MAP.assaultship, producer: 'naval_academy', countField: 'assaultshipCount', completionReward: 1.0 },
  submarine: { cost: 1800, pop: 8, buildTime: 30000, combatPower: COMBAT_POWER_MAP.submarine, producer: 'naval_academy', countField: 'submarineCount', completionReward: 1.0 },
  missile_launcher: { cost: 2200, pop: 4, buildTime: 18000, combatPower: COMBAT_POWER_MAP.missile_launcher, producer: 'carbase', countField: 'launcherCount', completionReward: 1.35 },
  slbm: { cost: 1500, pop: 0, buildTime: 45000, combatPower: 0, producer: 'missile_silo', countField: null, completionReward: 1.2 }
});

const SIM_PRODUCER_TYPES = Object.freeze(['headquarters', 'shipyard', 'naval_academy', 'carbase', 'missile_silo']);
const SIM_BUILDING_TYPES = Object.freeze(['headquarters', 'power_plant', 'shipyard', 'naval_academy', 'missile_silo', 'defense_tower', 'carbase']);
const SIM_UNIT_COUNT_FIELDS = Object.freeze([
  'workerCount',
  'frigateCount',
  'destroyerCount',
  'cruiserCount',
  'battleshipCount',
  'carrierCount',
  'submarineCount',
  'assaultshipCount',
  'launcherCount',
  'deployedLauncherCount'
]);

function createEmptySimulationProduction() {
  return {
    headquarters: { active: [], queue: [] },
    shipyard: { active: [], queue: [] },
    naval_academy: { active: [], queue: [] },
    carbase: { active: [], queue: [] },
    missile_silo: { active: [], queue: [] }
  };
}

function cloneSimulationState(state) {
  return {
    ...state,
    completedBuildings: normalizeCompletedBuildings(state.completedBuildings),
    pendingBuildings: Array.isArray(state.pendingBuildings) ? state.pendingBuildings.map(item => ({ ...item })) : [],
    production: cloneSimulationProduction(state.production)
  };
}

function cloneSimulationProduction(production) {
  const base = createEmptySimulationProduction();
  if (!production) return base;
  SIM_PRODUCER_TYPES.forEach(type => {
    const line = production[type] || {};
    base[type] = {
      active: Array.isArray(line.active) ? line.active.map(item => ({ ...item })) : [],
      queue: Array.isArray(line.queue) ? line.queue.map(item => ({ ...item })) : []
    };
  });
  return base;
}

function normalizeCompletedBuildings(buildings) {
  const normalized = {};
  SIM_BUILDING_TYPES.forEach(type => {
    normalized[type] = Math.max(0, Math.floor(buildings?.[type] || 0));
  });
  return normalized;
}

function getCurrentLivePopulation(state) {
  return (
    (state.workerCount || 0) * (SIM_UNIT_DEFS.worker.pop || 0) +
    (state.frigateCount || 0) * SIM_UNIT_DEFS.frigate.pop +
    (state.destroyerCount || 0) * SIM_UNIT_DEFS.destroyer.pop +
    (state.cruiserCount || 0) * SIM_UNIT_DEFS.cruiser.pop +
    (state.battleshipCount || 0) * SIM_UNIT_DEFS.battleship.pop +
    (state.carrierCount || 0) * SIM_UNIT_DEFS.carrier.pop +
    (state.submarineCount || 0) * SIM_UNIT_DEFS.submarine.pop +
    (state.assaultshipCount || 0) * SIM_UNIT_DEFS.assaultship.pop +
    ((state.launcherCount || 0) + (state.deployedLauncherCount || 0)) * SIM_UNIT_DEFS.missile_launcher.pop
  );
}

function syncSimulationState(state) {
  state.completedBuildings = normalizeCompletedBuildings(state.completedBuildings);
  SIM_UNIT_COUNT_FIELDS.forEach(field => {
    state[field] = Math.max(0, Math.floor(state[field] || 0));
  });
  state.population = Math.max(0, Math.floor(state.population || 0));
  state.maxPopulation = Math.max(
    SIM_BASE_POPULATION_CAP,
    Math.min(SIM_MAX_POPULATION_CAP, Math.floor(state.maxPopulation || SIM_STARTING_MAX_POPULATION))
  );
  state.storedSlbmCount = Math.max(0, Math.floor(state.storedSlbmCount || 0));
  state.loadedSlbmCount = Math.max(0, Math.floor(state.loadedSlbmCount || 0));
  state.loadedSlbmCount = Math.min(state.loadedSlbmCount, state.submarineCount * SUBMARINE_SLBM_CAPACITY);
  state.pendingBuildings = Array.isArray(state.pendingBuildings) ? state.pendingBuildings.map(item => ({
    type: item.type,
    remainingMs: Math.max(0, Math.floor(item.remainingMs || 0))
  })) : [];
  state.production = cloneSimulationProduction(state.production);
  state.buildingCount = SIM_BUILDING_TYPES.reduce((sum, type) => sum + state.completedBuildings[type], 0);
  state.unitCount =
    (state.workerCount || 0) +
    (state.frigateCount || 0) +
    (state.destroyerCount || 0) +
    (state.cruiserCount || 0) +
    (state.battleshipCount || 0) +
    (state.carrierCount || 0) +
    (state.submarineCount || 0) +
    (state.assaultshipCount || 0) +
    (state.launcherCount || 0) +
    (state.deployedLauncherCount || 0);
  state.hasShipyard = state.completedBuildings.shipyard > 0;
  state.hasNavalAcademy = state.completedBuildings.naval_academy > 0;
  state.hasSilo = state.completedBuildings.missile_silo > 0;
  state.hasCarbase = state.completedBuildings.carbase > 0;
  return state;
}

function getInitialSimulationCombatPower(state) {
  const completedBuildings = normalizeCompletedBuildings(state.completedBuildings);
  let total = 0;
  SIM_BUILDING_TYPES.forEach(type => {
    total += completedBuildings[type] * (SIM_BUILDING_DEFS[type]?.combatPower || 0);
  });
  total += Math.max(0, Math.floor(state.frigateCount || 0)) * COMBAT_POWER_MAP.frigate;
  total += Math.max(0, Math.floor(state.destroyerCount || 0)) * COMBAT_POWER_MAP.destroyer;
  total += Math.max(0, Math.floor(state.cruiserCount || 0)) * COMBAT_POWER_MAP.cruiser;
  total += Math.max(0, Math.floor(state.battleshipCount || 0)) * COMBAT_POWER_MAP.battleship;
  total += Math.max(0, Math.floor(state.carrierCount || 0)) * COMBAT_POWER_MAP.carrier;
  total += Math.max(0, Math.floor(state.submarineCount || 0)) * COMBAT_POWER_MAP.submarine;
  total += Math.max(0, Math.floor(state.assaultshipCount || 0)) * COMBAT_POWER_MAP.assaultship;
  total += (
    Math.max(0, Math.floor(state.launcherCount || 0))
    + Math.max(0, Math.floor(state.deployedLauncherCount || 0))
  ) * COMBAT_POWER_MAP.missile_launcher;
  total += (
    Math.max(0, Math.floor(state.storedSlbmCount || 0))
    + Math.max(0, Math.floor(state.loadedSlbmCount || 0))
  ) * COMBAT_POWER_MAP.slbm;
  return total;
}

function createSimulationState(overrides = {}) {
  const state = {
    resources: SIM_STARTING_RESOURCES,
    population: SIM_STARTING_WORKERS,
    maxPopulation: SIM_STARTING_MAX_POPULATION,
    combatPower: 0,
    buildingCount: 1,
    unitCount: SIM_STARTING_WORKERS,
    workerCount: SIM_STARTING_WORKERS,
    enemyCombatPower: 100 + Math.floor(Math.random() * 200),
    enemyBuildingCount: 3 + Math.floor(Math.random() * 5),
    hasSilo: false,
    hasShipyard: false,
    hasNavalAcademy: false,
    hasCarbase: false,
    alive: true,
    kills: 0,
    combatUnitLosses: 0,
    workerLosses: 0,
    combatUnitValueLost: 0,
    combatUnitValueDestroyed: 0,
    tick: 0,
    fogLevel: 0,
    redZoneTimer: 0,
    inRedZoneDanger: false,
    frigateCount: 0,
    destroyerCount: 0,
    cruiserCount: 0,
    battleshipCount: 0,
    carrierCount: 0,
    submarineCount: 0,
    storedSlbmCount: 0,
    loadedSlbmCount: 0,
    aimedShotReady: false,
    aimedShotCooldown: 0,
    combatStanceActive: false,
    combatStanceStacks: 0,
    engineOverdriveActive: false,
    searchCooldown: 0,
    stealthActive: false,
    stealthCooldown: 0,
    stealthTimer: 0,
    aircraftCount: 0,
    inCombat: false,
    enemyDistance: 2,
    maxAttackRange: 0,
    totalVision: 0,
    assaultshipCount: 0,
    launcherCount: 0,
    deployedLauncherCount: 0,
    loadedAssaultShips: 0,
    hasLandAccess: false,
    completedBuildings: { headquarters: 1, power_plant: 0, shipyard: 0, naval_academy: 0, missile_silo: 0, defense_tower: 0, carbase: 0 },
    pendingBuildings: [],
    production: createEmptySimulationProduction(),
    ...overrides
  };
  state.completedBuildings = normalizeCompletedBuildings({
    headquarters: 1,
    power_plant: 0,
    shipyard: 0,
    naval_academy: 0,
    missile_silo: 0,
    defense_tower: 0,
    carbase: 0,
    ...(overrides.completedBuildings || {})
  });
  state.production = cloneSimulationProduction(overrides.production);
  state.pendingBuildings = Array.isArray(overrides.pendingBuildings) ? overrides.pendingBuildings.map(item => ({ ...item })) : [];
  if (!Number.isFinite(overrides.combatPower)) {
    state.combatPower = getInitialSimulationCombatPower(state);
  }
  return syncSimulationState(state);
}

function encodeAbstractState(summary) {
  const resourceBucket = discretize(summary.resources, [200, 500, 1000, 2000, 5000]);
  const populationBucket = discretize(summary.population, [6, 12, 20, 35, 55, 85, 120, 180]);
  const freePopBucket = discretize(summary.freePopulation, [0, 4, 10, 20, 40]);
  const populationUtilizationBucket = discretize(getPopulationUtilization(summary), [0.15, 0.3, 0.5, 0.7, 0.85, 0.95]);
  const workerBucket = discretize(summary.workerCount, [2, 4, 6, 10, 16]);
  const unitBucket = discretize(summary.unitCount, [4, 8, 15, 25, 40]);
  const buildingBucket = discretize(summary.buildingCount, [1, 3, 6, 10, 15, 25]);
  const combatBucket = discretize(summary.combatPower, [100, 300, 600, 1200, 2500, 5000]);
  const enemyBucket = discretize(summary.enemyPressure, [0, 2, 5, 8, 12]);
  const homeThreatBucket = discretize(summary.homeThreatLevel || 0, [0, 1, 2, 4, 7, 10]);
  const defenseGapBucket = discretize(summary.homeDefenseGap || 0, [0, 1, 2, 4, 7, 10]);
  const powerPlantBucket = discretize(summary.powerPlantCount, [0, 1, 2, 4, 6]);
  const shipyardBucket = discretize(summary.shipyardCount, [0, 1, 2, 4]);
  const academyBucket = discretize(summary.navalAcademyCount, [0, 1, 2, 3]);
  const siloBucket = discretize(summary.siloCount, [0, 1, 3, 5]);
  const carbaseBucket = discretize(summary.carbaseCount, [0, 1, 2]);
  const lightFleetBucket = discretize((summary.frigateCount || 0) + (summary.destroyerCount || 0), [0, 2, 5, 9, 14]);
  const supportFleetBucket = discretize((summary.cruiserCount || 0) + (summary.launcherCount || 0), [0, 1, 3, 6]);
  const capitalFleetBucket = discretize(
    (summary.battleshipCount || 0) + (summary.carrierCount || 0) + (summary.assaultshipCount || 0),
    [0, 1, 2, 4]
  );
  const subBucket = discretize(summary.submarineCount, [0, 1, 3, 6]);
  const diversityBucket = discretize(getFleetDiversityScore(summary), [1, 2, 3, 4, 6]);
  const dominanceBucket = discretize(getFleetDominanceRatio(summary), [0.4, 0.55, 0.7, 0.85]);
  const storedSlbmBucket = discretize(summary.storedSlbmCount, [0, 1, 3, 6]);
  const loadedSlbmBucket = discretize(summary.loadedSlbmCount, [0, 1, 3, 6]);
  const incomeBucket = discretize(summary.energyIncomePerSec, [0, 5, 10, 15, 25, 40]);
  const spendBucket = discretize(summary.energySpendPerSec, [0, 5, 10, 15, 25, 40]);
  const pendingBucket = discretize(summary.pendingBuildingCount, [0, 1, 3, 6]);
  const queueBucket = discretize(summary.productionLoad, [0, 1, 4, 10, 20]);
  const deployedBucket = discretize(summary.deployedLauncherCount, [0, 1, 3, 6]);
  return `${resourceBucket}-${populationBucket}-${freePopBucket}-${populationUtilizationBucket}-${workerBucket}-${unitBucket}-${buildingBucket}-${combatBucket}-${enemyBucket}-${homeThreatBucket}-${defenseGapBucket}-${powerPlantBucket}-${shipyardBucket}-${academyBucket}-${siloBucket}-${carbaseBucket}-${lightFleetBucket}-${supportFleetBucket}-${capitalFleetBucket}-${subBucket}-${diversityBucket}-${dominanceBucket}-${storedSlbmBucket}-${loadedSlbmBucket}-${incomeBucket}-${spendBucket}-${pendingBucket}-${queueBucket}-${deployedBucket}`;
}

function getPopulationUsage(source) {
  return Math.max(0, Math.floor(source?.population || 0));
}

function getPopulationCapacity(source) {
  return Math.max(0, Math.floor(source?.maxPopulation || 0));
}

function getPopulationUtilization(source) {
  const maxPopulation = getPopulationCapacity(source);
  if (maxPopulation <= 0) return 0;
  return Math.max(0, Math.min(1, getPopulationUsage(source) / maxPopulation));
}

function getCombatPopulation(source) {
  return Math.max(0, getPopulationUsage(source) - Math.max(0, Math.floor(source?.workerCount || 0)));
}

function getRaidFailurePenalty({
  initiatedAttack = false,
  inflictedPower = 0,
  ownLossPower = 0,
  structuralGainScore = 0,
  effectiveRatio = 1,
  fogLevel = 2,
  defensePressure = 0
} = {}) {
  if (!initiatedAttack) return 0;
  const structuralGain = Math.max(0, structuralGainScore) * 12;
  const tradeDeficit = Math.max(0, ownLossPower - (inflictedPower + structuralGain));
  if (tradeDeficit <= 0) return 0;

  let penalty = tradeDeficit * 0.038;
  if (effectiveRatio < 1) penalty += (1 - effectiveRatio) * 6;
  if (fogLevel <= 0) penalty += 2.5;
  else if (fogLevel === 1) penalty += 1.0;
  penalty += Math.min(6.5, Math.max(0, defensePressure) * 0.85);
  if (tradeDeficit >= Math.max(120, inflictedPower * 0.45)) penalty += Math.min(7, tradeDeficit / 170);
  if (inflictedPower <= ownLossPower * 0.6 && structuralGainScore <= 0) penalty += 3.2;
  return penalty;
}

function getEconomyTempoScore(source) {
  const energyIncomePerSec = Math.max(0, Number(source?.energyIncomePerSec || 0));
  const energySpendPerSec = Math.max(0, Number(source?.energySpendPerSec || 0));
  return Math.min(energyIncomePerSec + SIM_BASE_PASSIVE_INCOME, energySpendPerSec);
}

function getLiveBuildingEnergySpendPerSecond(buildingType) {
  const normalizedType = buildingType === 'research_lab' ? 'missile_silo' : buildingType;
  const def = SIM_BUILDING_DEFS[normalizedType];
  if (!def || !def.buildTime) return 0;
  return def.cost / Math.max(1, def.buildTime / 1000);
}

function getLiveUnitEnergySpendPerSecond(unitType) {
  const normalizedType = unitType === 'missile' ? 'slbm' : unitType;
  const def = SIM_UNIT_DEFS[normalizedType];
  if (!def || !def.buildTime) return 0;
  return def.cost / Math.max(1, def.buildTime / 1000);
}

function isNearAnyThreatPoint(x, y, threatPoints, radius) {
  const radiusSq = radius * radius;
  for (let i = 0; i < threatPoints.length; i++) {
    const point = threatPoints[i];
    const dx = x - point.x;
    const dy = y - point.y;
    if ((dx * dx) + (dy * dy) <= radiusSq) return true;
  }
  return false;
}

function pushThreatPoint(threatPoints, x, y, attackerId = null) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  for (let i = 0; i < threatPoints.length; i++) {
    const point = threatPoints[i];
    const dx = point.x - x;
    const dy = point.y - y;
    if ((dx * dx) + (dy * dy) <= 220 * 220) {
      if (attackerId != null && point.attackerIds) {
        point.attackerIds.add(attackerId);
      }
      return;
    }
  }
  threatPoints.push({
    x,
    y,
    attackerIds: attackerId != null ? new Set([attackerId]) : new Set()
  });
}

function getLiveHomeDefenseMetrics(gameState, playerId, now = Date.now()) {
  const player = gameState.players.get(playerId);
  if (!player || !player.hasBase) {
    return {
      recentAttackCount: 0,
      homeThreatPower: 0,
      localDefensePower: 0,
      defenseGapPower: 0,
      threatenedBuildingCount: 0
    };
  }

  const threatPoints = [];
  for (const location of player.recentAttackLocations || []) {
    if (!location || !Number.isFinite(location.x) || !Number.isFinite(location.y)) continue;
    if (location.timestamp && now - location.timestamp > RL_HOME_THREAT_POINT_WINDOW_MS) continue;
    pushThreatPoint(threatPoints, location.x, location.y, location.attackerId ?? null);
  }

  gameState.buildings.forEach(building => {
    if (building.userId !== playerId || (building.buildProgress || 0) < 100) return;
    if (!building.lastDamageTime || now - building.lastDamageTime > RL_RECENT_BUILDING_DAMAGE_WINDOW_MS) return;
    pushThreatPoint(threatPoints, building.x, building.y);
  });

  if (threatPoints.length <= 0) {
    return {
      recentAttackCount: 0,
      homeThreatPower: 0,
      localDefensePower: 0,
      defenseGapPower: 0,
      threatenedBuildingCount: 0
    };
  }

  let threatenedBuildingCount = 0;
  let homeThreatPower = 0;
  let localDefensePower = 0;

  gameState.buildings.forEach(building => {
    if ((building.buildProgress || 0) < 100) return;
    if (!isNearAnyThreatPoint(building.x, building.y, threatPoints, RL_HOME_THREAT_RADIUS)) return;

    if (building.userId === playerId) {
      threatenedBuildingCount++;
      if (building.type === 'defense_tower') localDefensePower += 240;
      else if (building.type === 'missile_silo') localDefensePower += 100;
    } else {
      const enemyPlayer = gameState.players.get(building.userId);
      if (!enemyPlayer || !enemyPlayer.hasBase) return;
      if (building.type === 'defense_tower') homeThreatPower += 240;
    }
  });

  gameState.units.forEach(unit => {
    if (isAuxiliaryAirUnitType(unit)) return;
    if (!isNearAnyThreatPoint(unit.x, unit.y, threatPoints, unit.userId === playerId ? RL_DEFENSE_RESPONSE_RADIUS : RL_HOME_THREAT_RADIUS)) {
      return;
    }
    if (unit.userId === playerId) {
      if (unit.type !== 'worker') localDefensePower += COMBAT_POWER_MAP[unit.type] || 0;
      return;
    }
    const enemyPlayer = gameState.players.get(unit.userId);
    if (!enemyPlayer || !enemyPlayer.hasBase || unit.type === 'worker') return;
    homeThreatPower += COMBAT_POWER_MAP[unit.type] || 0;
  });

  return {
    recentAttackCount: threatPoints.length,
    homeThreatPower: Math.max(0, Math.floor(homeThreatPower)),
    localDefensePower: Math.max(0, Math.floor(localDefensePower)),
    defenseGapPower: Math.max(0, Math.floor(homeThreatPower - localDefensePower)),
    threatenedBuildingCount
  };
}

function summarizeLiveGameState(gameState, playerId) {
  const player = gameState.players.get(playerId);
  if (!player || !player.hasBase) return null;

  let unitCount = 0;
  let workerCount = 0;
  let combatPower = 0;
  let buildingCount = 0;
  let powerPlantCount = 0;
  let shipyardCount = 0;
  let navalAcademyCount = 0;
  let siloCount = 0;
  let carbaseCount = 0;
  let defenseTowerCount = 0;
  let frigateCount = 0;
  let destroyerCount = 0;
  let cruiserCount = 0;
  let battleshipCount = 0;
  let carrierCount = 0;
  let submarineCount = 0;
  let assaultshipCount = 0;
  let launcherCount = 0;
  let storedSlbmCount = 0;
  let loadedSlbmCount = 0;
  let pendingBuildingCount = 0;
  let productionLoad = 0;
  let deployedLauncherCount = 0;
  let energySpendPerSec = 0;
  const homeDefenseMetrics = getLiveHomeDefenseMetrics(gameState, playerId);

  gameState.units.forEach(unit => {
    if (unit.userId !== playerId) return;
    if (isAuxiliaryAirUnitType(unit)) return;
    unitCount++;
    if (unit.type === 'worker') workerCount++;
    if (unit.type !== 'worker') combatPower += COMBAT_POWER_MAP[unit.type] || 0;
    if (unit.type === 'frigate') frigateCount++;
    if (unit.type === 'destroyer') destroyerCount++;
    if (unit.type === 'cruiser') cruiserCount++;
    if (unit.type === 'battleship') battleshipCount++;
    if (unit.type === 'carrier') carrierCount++;
    if (unit.type === 'submarine') submarineCount++;
    if (unit.type === 'assaultship') assaultshipCount++;
    if (unit.type === 'missile_launcher') launcherCount++;
    if (unit.type === 'missile_launcher' && unit.deployState === 'deployed') deployedLauncherCount++;
    loadedSlbmCount += Math.max(0, Math.floor(unit.loadedSlbms || 0));
  });

  gameState.buildings.forEach(building => {
    if (building.userId !== playerId) return;
    if ((building.buildProgress || 0) >= 100) {
      buildingCount++;
      if (building.type === 'power_plant') powerPlantCount++;
      if (building.type === 'shipyard') shipyardCount++;
      if (building.type === 'naval_academy') navalAcademyCount++;
      if (building.type === 'missile_silo') siloCount++;
      if (building.type === 'carbase') carbaseCount++;
      if (building.type === 'defense_tower') defenseTowerCount++;
      storedSlbmCount += Math.max(0, Math.floor(building.slbmCount || 0));
    } else {
      pendingBuildingCount++;
      energySpendPerSec += getLiveBuildingEnergySpendPerSecond(building.type);
    }
    if (building.producing?.type) energySpendPerSec += getLiveUnitEnergySpendPerSecond(building.producing.type);
    if (building.missileProducing?.type) energySpendPerSec += getLiveUnitEnergySpendPerSecond(building.missileProducing.type);
    productionLoad += (building.productionQueue?.length || 0)
      + (building.producing ? 1 : 0)
      + (building.missileQueue?.length || 0)
      + (building.missileProducing ? 1 : 0);
  });

  return {
    resources: Math.max(0, Math.floor(player.resources || 0)),
    population: Math.max(0, Math.floor(player.population || 0)),
    maxPopulation: Math.max(0, Math.floor(player.maxPopulation || 0)),
    freePopulation: Math.max(0, Math.floor((player.maxPopulation || 0) - (player.population || 0))),
    workerCount,
    unitCount,
    buildingCount,
    combatPower: Math.max(
      0,
      Math.floor(Number.isFinite(player.combatPower) ? player.combatPower : combatPower)
    ),
    enemyPressure: Math.min((player.knownEnemyPositions || []).length, 12),
    homeThreatLevel: Math.min(12, Math.max(0, Math.ceil((homeDefenseMetrics.homeThreatPower || 0) / 220))),
    homeDefenseGap: Math.min(12, Math.max(0, Math.ceil((homeDefenseMetrics.defenseGapPower || 0) / 220))),
    energyIncomePerSec: powerPlantCount * 5,
    energySpendPerSec,
    powerPlantCount,
    shipyardCount,
    navalAcademyCount,
    siloCount,
    defenseTowerCount,
    carbaseCount,
    frigateCount,
    destroyerCount,
    cruiserCount,
    battleshipCount,
    carrierCount,
    submarineCount,
    assaultshipCount,
    launcherCount,
    storedSlbmCount,
    loadedSlbmCount,
    pendingBuildingCount,
    productionLoad,
    deployedLauncherCount,
    recentAttackCount: homeDefenseMetrics.recentAttackCount,
    homeThreatPower: homeDefenseMetrics.homeThreatPower,
    localDefensePower: homeDefenseMetrics.localDefensePower,
    defenseGapPower: homeDefenseMetrics.defenseGapPower,
    threatenedBuildingCount: homeDefenseMetrics.threatenedBuildingCount
  };
}

function summarizeSimulationState(state) {
  syncSimulationState(state);
  const homeThreatPower = state.enemyDistance === 0
    ? Math.max(0, Math.floor((state.enemyCombatPower || 0) * 0.7))
    : (state.enemyDistance === 1 ? Math.max(0, Math.floor((state.enemyCombatPower || 0) * 0.28)) : 0);
  const localDefensePower = Math.max(
    0,
    Math.floor(getStrategicDefenseScore(state) * 90 + Math.max(0, state.combatPower || 0) * (state.enemyDistance === 0 ? 0.32 : 0.12))
  );
  const defenseGapPower = Math.max(0, homeThreatPower - localDefensePower);
  const threatenedBuildingCount = homeThreatPower > 120
    ? Math.min(Math.max(0, Math.floor(state.buildingCount || 0)), 1 + Math.floor(homeThreatPower / 500))
    : 0;
  return {
    resources: Math.max(0, Math.floor(state.resources || 0)),
    population: Math.max(0, Math.floor(state.population || 0)),
    maxPopulation: Math.max(0, Math.floor(state.maxPopulation || 0)),
    freePopulation: Math.max(0, state.maxPopulation - state.population),
    workerCount: Math.max(0, Math.floor(state.workerCount || 0)),
    unitCount: state.unitCount,
    buildingCount: state.buildingCount,
    combatPower: Math.max(0, Math.floor(state.combatPower || 0)),
    enemyPressure: Math.min(12, Math.max(0, Math.ceil((state.enemyCombatPower || 0) / 180))),
    homeThreatLevel: Math.min(12, Math.max(0, Math.ceil(homeThreatPower / 220))),
    homeDefenseGap: Math.min(12, Math.max(0, Math.ceil(defenseGapPower / 220))),
    energyIncomePerSec: getSimulationEnergyIncomePerSecond(state),
    energySpendPerSec: getSimulationEnergySpendPerSecond(state),
    powerPlantCount: state.completedBuildings.power_plant,
    shipyardCount: state.completedBuildings.shipyard,
    navalAcademyCount: state.completedBuildings.naval_academy,
    siloCount: state.completedBuildings.missile_silo,
    defenseTowerCount: state.completedBuildings.defense_tower,
    carbaseCount: state.completedBuildings.carbase,
    frigateCount: state.frigateCount,
    destroyerCount: state.destroyerCount,
    cruiserCount: state.cruiserCount,
    battleshipCount: state.battleshipCount,
    carrierCount: state.carrierCount,
    submarineCount: state.submarineCount,
    assaultshipCount: state.assaultshipCount,
    launcherCount: state.launcherCount + state.deployedLauncherCount,
    storedSlbmCount: state.storedSlbmCount,
    loadedSlbmCount: state.loadedSlbmCount,
    pendingBuildingCount: state.pendingBuildings.length,
    productionLoad: SIM_PRODUCER_TYPES.reduce((sum, producerType) => {
      const line = state.production[producerType];
      return sum + line.active.length + line.queue.length;
    }, 0),
    deployedLauncherCount: state.deployedLauncherCount,
    recentAttackCount: homeThreatPower > 0 ? 1 : 0,
    homeThreatPower,
    localDefensePower,
    defenseGapPower,
    threatenedBuildingCount
  };
}

function getCompletedBuildingCount(state, buildingType) {
  return Math.max(0, Math.floor(state.completedBuildings?.[buildingType] || 0));
}

function getSimulationProducerLoad(state, producerType) {
  const line = state.production?.[producerType];
  if (!line) return 0;
  return (line.active?.length || 0) + (line.queue?.length || 0);
}

function getSimulationEnergyIncomePerSecond(state) {
  return getCompletedBuildingCount(state, 'power_plant') * 5;
}

function getSimulationPassiveIncome(state) {
  return SIM_BASE_PASSIVE_INCOME + getSimulationEnergyIncomePerSecond(state);
}

function getSimulationEnergySpendPerSecond(state) {
  let spend = 0;
  for (const pending of state.pendingBuildings || []) {
    const def = SIM_BUILDING_DEFS[pending.type];
    if (!def || !def.buildTime) continue;
    spend += def.cost / Math.max(1, def.buildTime / 1000);
  }
  for (const producerType of SIM_PRODUCER_TYPES) {
    const line = state.production?.[producerType];
    if (!line) continue;
    for (const job of line.active || []) {
      const def = SIM_UNIT_DEFS[job.type];
      if (!def || !def.buildTime) continue;
      spend += def.cost / Math.max(1, def.buildTime / 1000);
    }
  }
  return spend;
}

function getSimulationProducerCapacity(state, producerType) {
  return Math.max(0, getCompletedBuildingCount(state, producerType));
}

function rebalanceSimulationProduction(state, producerType) {
  const line = state.production[producerType];
  if (!line) return;
  const capacity = getSimulationProducerCapacity(state, producerType);
  while (line.active.length > capacity) {
    line.active.pop();
  }
  const maxJobs = capacity * SIM_MAX_QUEUE_PER_PRODUCER;
  while (line.active.length + line.queue.length > maxJobs) {
    line.queue.pop();
  }
  while (line.active.length < capacity && line.queue.length > 0) {
    const next = line.queue.shift();
    line.active.push({
      type: next.type,
      remainingMs: Math.max(1, Math.floor(next.remainingMs || 1))
    });
  }
}

function enqueueSimulationBuilding(state, buildingType) {
  const def = SIM_BUILDING_DEFS[buildingType];
  if (!def || state.resources < def.cost || (state.workerCount || 0) <= 0) return false;
  if (buildingType === 'naval_academy' && getCompletedBuildingCount(state, 'shipyard') <= 0) return false;
  if (
    buildingType === 'carbase'
    && (
      getCompletedBuildingCount(state, 'power_plant') <= 0
      || getCompletedBuildingCount(state, 'shipyard') <= 0
      || getCompletedBuildingCount(state, 'defense_tower') <= 0
      || getCompletedBuildingCount(state, 'naval_academy') <= 0
      || getCompletedBuildingCount(state, 'missile_silo') < 2
    )
  ) return false;
  state.resources -= def.cost;
  state.pendingBuildings.push({ type: buildingType, remainingMs: def.buildTime });
  return true;
}

function enqueueSimulationProduction(state, itemType) {
  const def = SIM_UNIT_DEFS[itemType];
  if (!def) return false;
  const producerType = def.producer;
  const producerCount = getSimulationProducerCapacity(state, producerType);
  if (producerCount <= 0) return false;
  const line = state.production[producerType];
  const totalQueued = line.active.length + line.queue.length;
  if (totalQueued >= producerCount * SIM_MAX_QUEUE_PER_PRODUCER) return false;
  if (state.resources < def.cost) return false;
  if (def.pop > 0 && state.population + def.pop > state.maxPopulation) return false;
  state.resources -= def.cost;
  if (def.pop > 0) state.population += def.pop;
  line.queue.push({ type: itemType, remainingMs: def.buildTime });
  rebalanceSimulationProduction(state, producerType);
  return true;
}

function completeSimulationBuilding(state, buildingType) {
  const def = SIM_BUILDING_DEFS[buildingType];
  if (!def) return 0;
  state.completedBuildings[buildingType] = getCompletedBuildingCount(state, buildingType) + 1;
  if (def.popBonus > 0) {
    state.maxPopulation = Math.min(SIM_MAX_POPULATION_CAP, state.maxPopulation + def.popBonus);
  }
  if (def.combatPower) state.combatPower += def.combatPower;
  if (SIM_PRODUCER_TYPES.includes(buildingType)) rebalanceSimulationProduction(state, buildingType);
  syncSimulationState(state);
  return getCompletedBuildingReward(state, buildingType, def.completionReward || 0);
}

function completeSimulationProduction(state, itemType) {
  const def = SIM_UNIT_DEFS[itemType];
  if (!def) return 0;
  if (itemType === 'slbm') {
    state.storedSlbmCount++;
    state.combatPower += COMBAT_POWER_MAP.slbm;
    syncSimulationState(state);
    return getCompletedProductionReward(state, itemType, def.completionReward || 0);
  }
  const producedCount = 1;
  if (def.countField) state[def.countField] = Math.max(0, Math.floor(state[def.countField] || 0)) + producedCount;
  if (def.combatPower > 0) state.combatPower += def.combatPower * producedCount;
  if (itemType === 'battleship') state.aimedShotReady = true;
  syncSimulationState(state);
  return getCompletedProductionReward(state, itemType, def.completionReward || 0);
}

function advanceSimulationProgress(state, elapsedMs) {
  let reward = 0;
  const remainingBuildings = [];
  for (const pending of state.pendingBuildings) {
    const next = { ...pending, remainingMs: pending.remainingMs - elapsedMs };
    if (next.remainingMs <= 0) reward += completeSimulationBuilding(state, next.type);
    else remainingBuildings.push(next);
  }
  state.pendingBuildings = remainingBuildings;

  SIM_PRODUCER_TYPES.forEach(producerType => {
    rebalanceSimulationProduction(state, producerType);
    const line = state.production[producerType];
    const stillActive = [];
    line.active.forEach(job => {
      const next = { ...job, remainingMs: job.remainingMs - elapsedMs };
      if (next.remainingMs <= 0) reward += completeSimulationProduction(state, next.type);
      else stillActive.push(next);
    });
    line.active = stillActive;
    rebalanceSimulationProduction(state, producerType);
  });

  syncSimulationState(state);
  return reward;
}

function removeRandomUnitsFromSimulation(state, count, options = {}) {
  const allowWorkers = options.allowWorkers !== false;
  const summary = {
    totalUnitsLost: 0,
    combatUnitsLost: 0,
    workerLosses: 0,
    combatPowerLost: 0,
    populationLost: 0,
    lostByType: {}
  };
  for (let i = 0; i < count; i++) {
    const candidates = [];
    if (allowWorkers && state.workerCount > 0) candidates.push({ field: 'workerCount', pop: SIM_UNIT_DEFS.worker.pop, type: 'worker' });
    if (state.frigateCount > 0) candidates.push({ field: 'frigateCount', pop: SIM_UNIT_DEFS.frigate.pop, type: 'frigate' });
    if (state.destroyerCount > 0) candidates.push({ field: 'destroyerCount', pop: SIM_UNIT_DEFS.destroyer.pop, type: 'destroyer' });
    if (state.cruiserCount > 0) candidates.push({ field: 'cruiserCount', pop: SIM_UNIT_DEFS.cruiser.pop, type: 'cruiser' });
    if (state.battleshipCount > 0) candidates.push({ field: 'battleshipCount', pop: SIM_UNIT_DEFS.battleship.pop, type: 'battleship' });
    if (state.carrierCount > 0) candidates.push({ field: 'carrierCount', pop: SIM_UNIT_DEFS.carrier.pop, type: 'carrier' });
    if (state.submarineCount > 0) candidates.push({ field: 'submarineCount', pop: SIM_UNIT_DEFS.submarine.pop, type: 'submarine' });
    if (state.assaultshipCount > 0) candidates.push({ field: 'assaultshipCount', pop: SIM_UNIT_DEFS.assaultship.pop, type: 'assaultship' });
    if (state.launcherCount > 0) candidates.push({ field: 'launcherCount', pop: SIM_UNIT_DEFS.missile_launcher.pop, type: 'missile_launcher' });
    if (state.deployedLauncherCount > 0) candidates.push({ field: 'deployedLauncherCount', pop: SIM_UNIT_DEFS.missile_launcher.pop, type: 'missile_launcher' });
    if (candidates.length === 0) break;
    const lost = candidates[Math.floor(Math.random() * candidates.length)];
    const previousCount = Math.max(0, Math.floor(state[lost.field] || 0));
    state[lost.field] = Math.max(0, state[lost.field] - 1);
    state.population = Math.max(0, state.population - lost.pop);
    summary.totalUnitsLost++;
    summary.populationLost += lost.pop;
    summary.lostByType[lost.type] = (summary.lostByType[lost.type] || 0) + 1;
    if (lost.type === 'worker') {
      summary.workerLosses++;
    } else {
      summary.combatUnitsLost++;
      summary.combatPowerLost += COMBAT_POWER_MAP[lost.type] || 0;
    }
    if (lost.type === 'submarine') {
      if (previousCount > 0 && state.loadedSlbmCount > 0) {
        const lostLoadedSlbms = Math.min(
          SUBMARINE_SLBM_CAPACITY,
          Math.max(1, Math.ceil(state.loadedSlbmCount / previousCount))
        );
        state.loadedSlbmCount = Math.max(0, state.loadedSlbmCount - lostLoadedSlbms);
        state.combatPower = Math.max(0, state.combatPower - (lostLoadedSlbms * COMBAT_POWER_MAP.slbm));
        summary.combatPowerLost += lostLoadedSlbms * COMBAT_POWER_MAP.slbm;
      }
      state.loadedSlbmCount = Math.min(state.loadedSlbmCount, state.submarineCount * SUBMARINE_SLBM_CAPACITY);
      if (state.submarineCount <= 0) state.stealthActive = false;
    }
    if (lost.type === 'battleship' && state.battleshipCount <= 0) {
      state.combatStanceActive = false;
      state.aimedShotReady = false;
    }
  }
  syncSimulationState(state);
  return summary;
}

function destroyRandomCompletedBuilding(state) {
  const candidates = SIM_BUILDING_TYPES.filter(type => getCompletedBuildingCount(state, type) > 0);
  if (candidates.length === 0) return null;
  const buildingType = candidates[Math.floor(Math.random() * candidates.length)];
  const beforeSilos = getCompletedBuildingCount(state, 'missile_silo');
  const previousStoredSlbmCount = state.storedSlbmCount;
  state.completedBuildings[buildingType] = Math.max(0, getCompletedBuildingCount(state, buildingType) - 1);
  if (SIM_BUILDING_DEFS[buildingType]?.combatPower) {
    state.combatPower = Math.max(0, state.combatPower - (SIM_BUILDING_DEFS[buildingType].combatPower || 0));
  }
  if (buildingType === 'missile_silo' && beforeSilos > 0) {
    const afterSilos = getCompletedBuildingCount(state, 'missile_silo');
    state.storedSlbmCount = afterSilos <= 0
      ? 0
      : Math.floor(state.storedSlbmCount * (afterSilos / beforeSilos));
    const lostStoredSlbms = Math.max(0, previousStoredSlbmCount - state.storedSlbmCount);
    state.combatPower = Math.max(0, state.combatPower - (lostStoredSlbms * COMBAT_POWER_MAP.slbm));
  }
  if (SIM_PRODUCER_TYPES.includes(buildingType)) rebalanceSimulationProduction(state, buildingType);
  syncSimulationState(state);
  return buildingType;
}

// ========== Q-TABLE ==========

class QTable {
  constructor() {
    this.table = {};   // { stateKey: [q0, q1, ..., qN] }
    this.learningRate = 0.1;
    this.discountFactor = 0.95;
    this.epsilon = 0.3;       // Exploration rate
    this.minEpsilon = 0.05;
    this.epsilonDecay = 0.9995;
    this.totalEpisodes = 0;
    this.totalReward = 0;
    this.recentRewards = [];  // Last 100 episode rewards for tracking
  }

  ensureActionRow(state) {
    if (!this.table[state]) {
      this.table[state] = new Array(ACTION_COUNT).fill(0);
    } else if (this.table[state].length < ACTION_COUNT) {
      this.table[state].length = ACTION_COUNT;
      for (let i = 0; i < ACTION_COUNT; i++) {
        if (this.table[state][i] === undefined) this.table[state][i] = 0;
      }
    }
    return this.table[state];
  }

  getQ(state, action) {
    return this.ensureActionRow(state)[action];
  }

  setQ(state, action, value) {
    this.ensureActionRow(state)[action] = value;
  }

  getBestAction(state) {
    if (!this.table[state]) {
      return Math.floor(Math.random() * ACTION_COUNT);
    }
    const qValues = this.ensureActionRow(state);
    let bestAction = 0;
    let bestValue = qValues[0];
    for (let i = 1; i < qValues.length; i++) {
      if (qValues[i] > bestValue) {
        bestValue = qValues[i];
        bestAction = i;
      }
    }
    return bestAction;
  }

  chooseAction(state, epsilon) {
    const eps = epsilon !== undefined ? epsilon : this.epsilon;
    if (Math.random() < eps) {
      return Math.floor(Math.random() * ACTION_COUNT);
    }
    return this.getBestAction(state);
  }

  update(state, action, reward, nextState) {
    const currentQ = this.getQ(state, action);
    const nextRow = this.table[nextState];
    const bestNextQ = nextRow ? Math.max(...this.ensureActionRow(nextState)) : 0;
    const newQ = currentQ + this.learningRate * (reward + this.discountFactor * bestNextQ - currentQ);
    this.setQ(state, action, newQ);
  }

  decayEpsilon() {
    this.epsilon = Math.max(this.minEpsilon, this.epsilon * this.epsilonDecay);
  }

  getStats() {
    const stateCount = Object.keys(this.table).length;
    const avgReward = this.recentRewards.length > 0
      ? this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length
      : 0;
    return {
      episodes: this.totalEpisodes,
      states: stateCount,
      epsilon: Math.round(this.epsilon * 1000) / 1000,
      avgReward: Math.round(avgReward * 10) / 10,
      totalReward: Math.round(this.totalReward * 10) / 10
    };
  }
}

// ========== DIFFICULTY PRESETS ==========

const DIFFICULTY_PRESETS = {
  easy: {
    label: '쉬움',
    epsilon: 0.6,            // Very random (bad decisions)
    updateInterval: 4000,    // Slow decisions
    buildingMultiplier: 0.5, // Builds less buildings
    unitMultiplier: 0.5,     // Produces fewer units
    attackCooldown: 40000,   // Attacks less frequently
    counterattackThreshold: 5, // Slow to respond
    useSkills: false,
    useRL: false,            // Pure rule-based, weakened
    minPowerPlants: 2,
    minShipyards: 1,
    minSilos: 0,
    minTowers: 1,
    maxWorkers: 2,
  },
  normal: {
    label: '보통',
    epsilon: 0.3,
    updateInterval: 2000,
    buildingMultiplier: 1.0,
    unitMultiplier: 1.0,
    attackCooldown: 20000,
    counterattackThreshold: 2,
    useSkills: true,
    useRL: false,            // Rule-based (current AI)
    minPowerPlants: 3,
    minShipyards: 1,
    minSilos: 1,
    minTowers: 2,
    maxWorkers: 3,
  },
  hard: {
    label: '어려움',
    epsilon: 0.15,
    updateInterval: 1500,
    buildingMultiplier: 1.5,
    unitMultiplier: 1.5,
    attackCooldown: 10000,
    counterattackThreshold: 1,
    useSkills: true,
    useRL: true,             // RL-enhanced decisions
    minPowerPlants: 4,
    minShipyards: 2,
    minSilos: 1,
    minTowers: 3,
    maxWorkers: 4,
  },
  expert: {
    label: '전문가',
    epsilon: 0.05,
    updateInterval: 1000,
    buildingMultiplier: 2.0,
    unitMultiplier: 2.0,
    attackCooldown: 5000,
    counterattackThreshold: 1,
    useSkills: true,
    useRL: true,             // Full RL policy
    minPowerPlants: 5,
    minShipyards: 2,
    minSilos: 2,
    minTowers: 4,
    maxWorkers: 5,
  }
};

// ========== REWARD CALCULATION ==========

function calculateReward(prevSnapshot, currentSnapshot, previousAction = null) {
  let reward = 0;
  const defenseResponseWeight = getDefenseResponseActionWeight(previousAction);
  const prevBuildingRetentionScore = getBuildingRetentionScore(prevSnapshot);
  const currentBuildingRetentionScore = getBuildingRetentionScore(currentSnapshot);

  const workerLosses = Math.max(0, prevSnapshot.workerCount - currentSnapshot.workerCount);
  reward -= workerLosses * 2.5;

  // Reward exact ship trades by unit type instead of bribing specific production choices.
  const enemyKillScore = getSnapshotUnitDeltaScore(prevSnapshot, currentSnapshot, 'enemyField', UNIT_KILL_SCORE_MAP);
  const ownLossScore = getSnapshotUnitDeltaScore(prevSnapshot, currentSnapshot, 'ownField', UNIT_LOSS_SCORE_MAP);
  reward += enemyKillScore;
  reward -= ownLossScore;

  // Building progress
  const buildingDiff = currentSnapshot.buildingCount - prevSnapshot.buildingCount;
  reward += buildingDiff * 2.6;
  const buildingRetentionDiff = currentBuildingRetentionScore - prevBuildingRetentionScore;
  reward += buildingRetentionDiff * 0.45;
  reward += currentBuildingRetentionScore * 0.02;
  reward -= Math.max(0, prevBuildingRetentionScore - currentBuildingRetentionScore) * 0.35;
  const towerDiff = (currentSnapshot.defenseTowerCount || 0) - (prevSnapshot.defenseTowerCount || 0);
  const liveTowerPressure = currentSnapshot.enemyCombatPower > Math.max(200, currentSnapshot.combatPower * 0.8);
  if (towerDiff > 0) reward += towerDiff * (liveTowerPressure ? 1.6 : 0.8);
  if (liveTowerPressure) reward += Math.min(0.45, (currentSnapshot.defenseTowerCount || 0) * 0.12);
  if (liveTowerPressure && (currentSnapshot.defenseTowerCount || 0) <= 0) reward -= 0.8;
  const enemyBuildingLosses = Math.max(0, (prevSnapshot.enemyBuildingCount || 0) - (currentSnapshot.enemyBuildingCount || 0));
  reward += enemyBuildingLosses * 18;
  const defenseSetupDiff = getStrategicDefenseScore(currentSnapshot) - getStrategicDefenseScore(prevSnapshot);
  reward += defenseSetupDiff * 0.5;
  const enemyPowerLoss = prevSnapshot.enemyCombatPower - currentSnapshot.enemyCombatPower;
  const ownPowerLoss = Math.max(0, prevSnapshot.combatPower - currentSnapshot.combatPower);

  const prevHomeThreatPower = Math.max(0, prevSnapshot.homeThreatPower || 0);
  const currentHomeThreatPower = Math.max(0, currentSnapshot.homeThreatPower || 0);
  const prevDefenseGapPower = Math.max(0, prevSnapshot.defenseGapPower || 0);
  const currentDefenseGapPower = Math.max(0, currentSnapshot.defenseGapPower || 0);
  const prevThreatenedBuildingCount = Math.max(0, prevSnapshot.threatenedBuildingCount || 0);
  const wasHomeUnderAttack = prevThreatenedBuildingCount > 0 && prevHomeThreatPower >= 140;
  const threatPressureReduced = Math.max(0, prevHomeThreatPower - currentHomeThreatPower);
  const localDefenseGain = Math.max(0, (currentSnapshot.localDefensePower || 0) - (prevSnapshot.localDefensePower || 0));
  if (wasHomeUnderAttack) {
    reward -= Math.max(0, currentDefenseGapPower - prevDefenseGapPower) * 0.006;
    if (defenseResponseWeight < 0.35 && threatPressureReduced <= 24 && enemyKillScore <= 0 && enemyPowerLoss <= 0) {
      reward -= 1.15 + Math.min(1.6, prevThreatenedBuildingCount * 0.28 + (prevHomeThreatPower * 0.0018));
    } else if (defenseResponseWeight < 0.7 && currentDefenseGapPower > prevDefenseGapPower + 100 && enemyPowerLoss <= 0) {
      reward -= 0.55;
    }
    if (
      (defenseResponseWeight >= 0.35 || localDefenseGain >= 120)
      && (threatPressureReduced > 30 || enemyPowerLoss > 40 || enemyKillScore > 0)
      && currentBuildingRetentionScore >= prevBuildingRetentionScore - 8
    ) {
      reward += 0.45 + Math.min(1.1, threatPressureReduced * 0.0035 + enemyKillScore * 0.01);
    }
  }

  // Economy tempo: more income and more active spending should both matter.
  const incomeDiff = (currentSnapshot.energyIncomePerSec || 0) - (prevSnapshot.energyIncomePerSec || 0);
  const spendDiff = (currentSnapshot.energySpendPerSec || 0) - (prevSnapshot.energySpendPerSec || 0);
  const tempoDiff = getEconomyTempoScore(currentSnapshot) - getEconomyTempoScore(prevSnapshot);
  reward += incomeDiff * 0.8;
  reward += spendDiff * 0.35;
  reward += tempoDiff * 0.6;
  reward += Math.sqrt(Math.max(0, currentSnapshot.energyIncomePerSec || 0)) * 0.08;
  reward += Math.sqrt(Math.max(0, getEconomyTempoScore(currentSnapshot))) * 0.18;
  if ((currentSnapshot.powerPlantCount || 0) >= 3 && (currentSnapshot.energySpendPerSec || 0) >= 8) reward += 0.5;
  if ((currentSnapshot.energyIncomePerSec || 0) >= 15 && (currentSnapshot.energySpendPerSec || 0) >= 10) reward += 0.25;
  if (currentSnapshot.combatUnitCount >= 5 && (currentSnapshot.energyIncomePerSec || 0) < 10) reward -= 1.2;

  const combatPopulationDiff = (currentSnapshot.combatPopulation || 0) - (prevSnapshot.combatPopulation || 0);
  const maxPopulationDiff = (currentSnapshot.maxPopulation || 0) - (prevSnapshot.maxPopulation || 0);
  const populationUtilization = getPopulationUtilization(currentSnapshot);
  reward += combatPopulationDiff * 0.42;
  reward += Math.max(0, maxPopulationDiff) * 0.12;
  reward += Math.sqrt(Math.max(0, currentSnapshot.combatPopulation || 0)) * 0.1;
  reward += Math.max(0, populationUtilization - 0.35) * 0.9;
  if ((currentSnapshot.population || 0) >= 30) reward += 0.2;
  if ((currentSnapshot.population || 0) >= 60) reward += 0.24;
  if ((currentSnapshot.population || 0) >= 100) reward += 0.32;

  // Tech progression and fleet variety matter more than raw spam.
  const techDiff = currentSnapshot.techScore - prevSnapshot.techScore;
  reward += techDiff * 1.4;
  const academyReady = (currentSnapshot.powerPlantCount || 0) >= 3 && (currentSnapshot.shipyardCount || 0) >= 1;
  if (academyReady && (currentSnapshot.navalAcademyCount || 0) <= 0) reward -= 0.6;
  if (
    (currentSnapshot.navalAcademyCount || 0) > 0
    && (currentSnapshot.powerPlantCount || 0) >= 4
    && (currentSnapshot.siloCount || 0) <= 0
    && (currentSnapshot.enemyBuildingCount || 0) >= 4
  ) {
    reward -= 0.28;
  }
  const diversityDiff = currentSnapshot.fleetDiversity - prevSnapshot.fleetDiversity;
  reward += diversityDiff * 2.5;
  const currentLightFleetRatio = getLightFleetRatio(currentSnapshot);
  const lateTechFleet = (currentSnapshot.techScore || 0) >= 8
    && (currentSnapshot.navalAcademyCount || 0) > 0
    && (currentSnapshot.powerPlantCount || 0) >= 4;
  if (lateTechFleet) {
    reward -= Math.max(0, currentLightFleetRatio - 0.52) * 4.2;
  }

  // Resource efficiency (not too high, not too low)
  if (currentSnapshot.resources > 500 && currentSnapshot.resources < 3000) {
    reward += 0.5;
  }

  // Enemy damage dealt
  reward += enemyPowerLoss * 0.018;
  reward -= ownPowerLoss * 0.03;

  // Survival bonus
  if (currentSnapshot.alive) reward += 0.1;
  else reward -= 50;

  // Keep a small worker corps alive so the AI can transition into tech.
  if (currentSnapshot.workerCount >= 2 && currentSnapshot.workerCount <= 5) reward += 0.3;
  else if (currentSnapshot.workerCount === 1) reward -= 0.4;
  else if (currentSnapshot.workerCount <= 0) reward -= 3;

  // Penalize extreme mono-compositions once the fleet is established.
  if (currentSnapshot.unitCount >= 4) {
    reward -= Math.max(0, currentSnapshot.fleetDominance - 0.7) * 3;
  }

  // Win condition
  if (currentSnapshot.won) reward += 100;

  return reward;
}

function takeSnapshot(gameState, playerId) {
  const player = gameState.players.get(playerId);
  if (!player) {
    return {
      alive: false,
      won: false,
      combatPower: 0,
      buildingCount: 0,
      resources: 0,
      population: 0,
      maxPopulation: 0,
      combatPopulation: 0,
      kills: 0,
      enemyCombatPower: 0,
      workerCount: 0,
      unitCount: 0,
      combatUnitCount: 0,
      energyIncomePerSec: 0,
      energySpendPerSec: 0,
      powerPlantCount: 0,
      shipyardCount: 0,
      navalAcademyCount: 0,
      siloCount: 0,
      defenseTowerCount: 0,
      carbaseCount: 0,
      frigateCount: 0,
      destroyerCount: 0,
      cruiserCount: 0,
      battleshipCount: 0,
      carrierCount: 0,
      submarineCount: 0,
      assaultshipCount: 0,
      launcherCount: 0,
      enemyFrigateCount: 0,
      enemyDestroyerCount: 0,
      enemyCruiserCount: 0,
      enemyBattleshipCount: 0,
      enemyCarrierCount: 0,
      enemySubmarineCount: 0,
      enemyAssaultshipCount: 0,
      enemyLauncherCount: 0,
      fleetDiversity: 0,
      fleetDominance: 0,
      techScore: 0,
      recentAttackCount: 0,
      homeThreatPower: 0,
      localDefensePower: 0,
      defenseGapPower: 0,
      threatenedBuildingCount: 0
    };
  }

  let combatPower = 0, buildingCount = 0, kills = 0, workerCount = 0, unitCount = 0;
  let enemyCombatPower = 0;
  let powerPlantCount = 0;
  let shipyardCount = 0;
  let navalAcademyCount = 0;
  let siloCount = 0;
  let defenseTowerCount = 0;
  let carbaseCount = 0;
  let frigateCount = 0;
  let destroyerCount = 0;
  let cruiserCount = 0;
  let battleshipCount = 0;
  let carrierCount = 0;
  let submarineCount = 0;
  let assaultshipCount = 0;
  let launcherCount = 0;
  let enemyFrigateCount = 0;
  let enemyDestroyerCount = 0;
  let enemyCruiserCount = 0;
  let enemyBattleshipCount = 0;
  let enemyCarrierCount = 0;
  let enemySubmarineCount = 0;
  let enemyAssaultshipCount = 0;
  let enemyLauncherCount = 0;
  let energySpendPerSec = 0;
  const homeDefenseMetrics = getLiveHomeDefenseMetrics(gameState, playerId);

  gameState.units.forEach(u => {
    if (isAuxiliaryAirUnitType(u)) return;
    if (u.userId === playerId) {
      unitCount++;
      if (u.type === 'worker') {
        workerCount++;
      } else {
        combatPower += COMBAT_POWER_MAP[u.type] || 0;
      }
      if (u.type === 'frigate') frigateCount++;
      if (u.type === 'destroyer') destroyerCount++;
      if (u.type === 'cruiser') cruiserCount++;
      if (u.type === 'battleship') battleshipCount++;
      if (u.type === 'carrier') carrierCount++;
      if (u.type === 'submarine') submarineCount++;
      if (u.type === 'assaultship') assaultshipCount++;
      if (u.type === 'missile_launcher') launcherCount++;
      kills += u.kills || 0;
    } else {
      const enemyPlayer = gameState.players.get(u.userId);
      if (!enemyPlayer || !enemyPlayer.hasBase) return;
      if (u.type === 'frigate') enemyFrigateCount++;
      if (u.type === 'destroyer') enemyDestroyerCount++;
      if (u.type === 'cruiser') enemyCruiserCount++;
      if (u.type === 'battleship') enemyBattleshipCount++;
      if (u.type === 'carrier') enemyCarrierCount++;
      if (u.type === 'submarine') enemySubmarineCount++;
      if (u.type === 'assaultship') enemyAssaultshipCount++;
      if (u.type === 'missile_launcher') enemyLauncherCount++;
    }
  });

  gameState.buildings.forEach(b => {
    if (b.userId === playerId && b.buildProgress >= 100) {
      buildingCount++;
      if (b.type === 'power_plant') powerPlantCount++;
      if (b.type === 'shipyard') shipyardCount++;
      if (b.type === 'naval_academy') navalAcademyCount++;
      if (b.type === 'missile_silo') siloCount++;
      if (b.type === 'defense_tower') defenseTowerCount++;
      if (b.type === 'carbase') carbaseCount++;
    } else if (b.userId === playerId) {
      energySpendPerSec += getLiveBuildingEnergySpendPerSecond(b.type);
    }
    if (b.userId === playerId && b.producing?.type) energySpendPerSec += getLiveUnitEnergySpendPerSecond(b.producing.type);
    if (b.userId === playerId && b.missileProducing?.type) energySpendPerSec += getLiveUnitEnergySpendPerSecond(b.missileProducing.type);
  });

  // Check if all enemies eliminated
  let enemyAlive = false;
  gameState.players.forEach((p, id) => {
    if (id !== playerId && p.hasBase) {
      enemyAlive = true;
      enemyCombatPower += Math.max(0, Math.floor(p.combatPower || 0));
    }
  });

  const population = Math.max(0, Math.floor(player.population || 0));
  const maxPopulation = Math.max(0, Math.floor(player.maxPopulation || 0));

  return {
    alive: player.hasBase,
    won: !enemyAlive && player.hasBase,
    combatPower: Math.max(
      0,
      Math.floor(Number.isFinite(player.combatPower) ? player.combatPower : combatPower)
    ),
    buildingCount,
    resources: player.resources || 0,
    population,
    maxPopulation,
    combatPopulation: Math.max(0, population - workerCount),
    kills,
    enemyCombatPower,
    workerCount,
    unitCount,
    combatUnitCount: Math.max(0, unitCount - workerCount),
    energyIncomePerSec: powerPlantCount * 5,
    energySpendPerSec,
    powerPlantCount,
    shipyardCount,
    navalAcademyCount,
    siloCount,
    defenseTowerCount,
    carbaseCount,
    frigateCount,
    destroyerCount,
    cruiserCount,
    battleshipCount,
    carrierCount,
    submarineCount,
    assaultshipCount,
    launcherCount,
    enemyFrigateCount,
    enemyDestroyerCount,
    enemyCruiserCount,
    enemyBattleshipCount,
    enemyCarrierCount,
    enemySubmarineCount,
    enemyAssaultshipCount,
    enemyLauncherCount,
    fleetDiversity: getFleetDiversityScore({
      frigateCount,
      destroyerCount,
      cruiserCount,
      battleshipCount,
      carrierCount,
      submarineCount,
      assaultshipCount,
      launcherCount
    }),
    fleetDominance: getFleetDominanceRatio({
      frigateCount,
      destroyerCount,
      cruiserCount,
      battleshipCount,
      carrierCount,
      submarineCount,
      assaultshipCount,
      launcherCount
    }),
    techScore: getTechProgressScore({
      powerPlantCount,
      shipyardCount,
      navalAcademyCount,
      siloCount,
      carbaseCount
    }),
    recentAttackCount: homeDefenseMetrics.recentAttackCount,
    homeThreatPower: homeDefenseMetrics.homeThreatPower,
    localDefensePower: homeDefenseMetrics.localDefensePower,
    defenseGapPower: homeDefenseMetrics.defenseGapPower,
    threatenedBuildingCount: homeDefenseMetrics.threatenedBuildingCount
  };
}

// ========== TRAINING SESSION MANAGER ==========

class TrainingSession {
  constructor(difficulty) {
    this.difficulty = difficulty || 'default';
    this.qTable = new QTable();
    this.loadedStateCount = 0;
    this.isTraining = false;
    this.frozen = false;         // When frozen, no weight updates (online learning or training)
    this.trainingSpeed = 1;
    this.episodeCount = 0;
    this.maxEpisodes = 1000;
    this.currentEpisode = 0;
    this.episodeSteps = 0;
    this.maxStepsPerEpisode = 300;
    this.trainingLog = [];
    this.lastSaveTime = 0;
    this.autoSaveInterval = 60000;
    this.lastLoadedSource = null;
    this.lastSavedSource = null;
    this.lastPruneStats = {
      minAbsQ: RL_WEIGHT_PRUNE_MIN_ABS_Q,
      minActionAbsQ: RL_WEIGHT_PRUNE_ACTION_MIN_ABS_Q,
      roundDecimals: RL_WEIGHT_ROUND_DECIMALS,
      beforeStateCount: 0,
      afterStateCount: 0,
      prunedStates: 0,
      prunedZeroStates: 0,
      prunedLowSignalStates: 0,
      zeroedActions: 0,
      reason: 'init'
    };
    this.recordingPolicy = {
      minScore: RL_TRAINING_MIN_RECORD_SCORE,
      minSelfPlayReward: RL_SELFPLAY_MIN_AGENT_REWARD,
      learnFromFailures: RL_FAILURE_REPLAY_ENABLED,
      failureReplayLimit: RL_FAILURE_REPLAY_LIMIT,
      failurePenaltyScale: RL_FAILURE_REPLAY_PENALTY_SCALE,
      failureRewardThreshold: RL_FAILURE_REWARD_THRESHOLD
    };
    this.recordingStats = {
      solo: {
        attempted: 0,
        accepted: 0,
        discarded: 0,
        acceptedTransitions: 0,
        discardedTransitions: 0,
        failureReplays: 0,
        failureReplayTransitions: 0,
        lastAcceptedReward: null,
        lastDiscardedReward: null,
        lastFailureReplayReward: null
      },
      selfPlay: {
        attempted: 0,
        accepted: 0,
        discarded: 0,
        acceptedTransitions: 0,
        discardedTransitions: 0,
        failureReplays: 0,
        failureReplayTransitions: 0,
        lastAcceptedWinnerReward: null,
        lastAcceptedWinnerScore: null,
        lastAcceptedAgentCount: 0,
        lastDiscardedWinnerReward: null,
        lastDiscardedWinnerScore: null,
        lastDiscardedAgentCount: 0,
        lastFailureReplayAgentCount: 0
      }
    };
    this.currentTrainingMode = null;
    this.lastRewardMetricMode = null;
    this.recentModeRewards = {
      solo: [],
      selfplay: []
    };
    const weightPaths = getWeightsPaths(this.difficulty);
    this.weightsPath = weightPaths.jsonPath;
    this.compressedWeightsPath = weightPaths.gzipPath;

    // Migrate old single weights file if this is 'hard' and no per-difficulty file exists
    if (this.difficulty === 'hard') {
      const oldPath = path.join(__dirname, 'ai-weights.json');
      if (
        !getExternalWeightsUrl(this.difficulty) &&
        !fs.existsSync(this.weightsPath) &&
        !fs.existsSync(this.compressedWeightsPath) &&
        fs.existsSync(oldPath)
      ) {
        try { fs.copyFileSync(oldPath, this.weightsPath); console.log('[AI-RL] Migrated old weights to hard'); } catch(e) {}
      }
    }

    this.loadWeights();
  }

  loadWeights() {
    try {
      const source = getAvailableWeightSources(this.difficulty)[0];
      if (source) {
        const data = readWeightsSource(source);
        this.qTable.table = data.table || {};
        this.qTable.epsilon = data.epsilon || 0.3;
        this.qTable.totalEpisodes = data.totalEpisodes || 0;
        this.qTable.totalReward = data.totalReward || 0;
        this.qTable.recentRewards = data.recentRewards || [];
        this.frozen = !!data.frozen;
        if (data.recordingPolicy && typeof data.recordingPolicy === 'object') {
          this.setRecordingPolicy(data.recordingPolicy);
        }
        this.lastLoadedSource = {
          file: path.basename(source.path),
          format: source.format,
          sizeBytes: source.sizeBytes,
          mtimeMs: source.mtimeMs,
          savedAt: data.savedAt || null
        };
        if (RL_WEIGHT_PRUNE_ON_LOAD) {
          this.pruneWeights('load');
        } else {
          this.loadedStateCount = Object.keys(this.qTable.table).length;
        }
        console.log(
          `[AI-RL][${this.difficulty}] Loaded ${source.format} weights from ${path.basename(source.path)}: ` +
          `${this.loadedStateCount} states, ${this.qTable.totalEpisodes} episodes, frozen: ${this.frozen}`
        );
        return true;
      }
    } catch (e) {
      console.error(`[AI-RL][${this.difficulty}] Failed to load weights:`, e.message);
    }
    this.loadedStateCount = 0;
    return false;
  }

  pruneWeights(reason = 'save') {
    const result = pruneWeightTable(this.qTable.table, RL_WEIGHT_PRUNE_MIN_ABS_Q);
    this.qTable.table = result.table;
    this.loadedStateCount = result.stats.afterStateCount;
    this.lastPruneStats = {
      ...result.stats,
      reason
    };
    return this.lastPruneStats;
  }

  setRecordingPolicy(policy = {}) {
    if (policy.minScore !== undefined) {
      const minScore = Number(policy.minScore);
      if (Number.isFinite(minScore)) {
        this.recordingPolicy.minScore = Math.max(0, minScore);
      }
    }
    if (policy.minSelfPlayReward !== undefined) {
      const minSelfPlayReward = Number(policy.minSelfPlayReward);
      if (Number.isFinite(minSelfPlayReward)) {
        this.recordingPolicy.minSelfPlayReward = minSelfPlayReward;
      }
    }
    if (policy.learnFromFailures !== undefined) {
      this.recordingPolicy.learnFromFailures = !!policy.learnFromFailures;
    }
    if (policy.failureReplayLimit !== undefined) {
      const failureReplayLimit = Number(policy.failureReplayLimit);
      if (Number.isFinite(failureReplayLimit)) {
        this.recordingPolicy.failureReplayLimit = Math.max(1, Math.min(200, Math.floor(failureReplayLimit)));
      }
    }
    if (policy.failurePenaltyScale !== undefined) {
      const failurePenaltyScale = Number(policy.failurePenaltyScale);
      if (Number.isFinite(failurePenaltyScale)) {
        this.recordingPolicy.failurePenaltyScale = Math.max(0.1, Math.min(5, failurePenaltyScale));
      }
    }
    if (policy.failureRewardThreshold !== undefined) {
      const failureRewardThreshold = Number(policy.failureRewardThreshold);
      if (Number.isFinite(failureRewardThreshold)) {
        this.recordingPolicy.failureRewardThreshold = failureRewardThreshold;
      }
    }
    if (this.selfPlayArena) {
      this.selfPlayArena.minRecordScore = this.recordingPolicy.minScore;
      this.selfPlayArena.minAgentReward = this.recordingPolicy.minSelfPlayReward;
      this.selfPlayArena.learnFromFailures = this.recordingPolicy.learnFromFailures;
      this.selfPlayArena.failureReplayLimit = this.recordingPolicy.failureReplayLimit;
      this.selfPlayArena.failurePenaltyScale = this.recordingPolicy.failurePenaltyScale;
      this.selfPlayArena.failureRewardThreshold = this.recordingPolicy.failureRewardThreshold;
    }
    return { ...this.recordingPolicy };
  }

  saveWeights() {
    try {
      const pruneStats = this.pruneWeights('save');
      const data = {
        table: this.qTable.table,
        epsilon: this.qTable.epsilon,
        totalEpisodes: this.qTable.totalEpisodes,
        totalReward: this.qTable.totalReward,
        recentRewards: this.qTable.recentRewards.slice(-100),
        frozen: this.frozen,
        difficulty: this.difficulty,
        recordingPolicy: this.recordingPolicy,
        recordingStats: this.recordingStats,
        savedAt: new Date().toISOString(),
        stateCount: Object.keys(this.qTable.table).length
      };
      const payload = JSON.stringify(data);
      const compressedPayload = zlib.gzipSync(Buffer.from(payload, 'utf8'), { level: RL_WEIGHT_GZIP_LEVEL });
      writeFileAtomic(this.compressedWeightsPath, compressedPayload);
      if (RL_WEIGHT_SAVE_PLAIN_JSON) {
        writeFileAtomic(this.weightsPath, payload);
      } else {
        removeFileIfExists(this.weightsPath);
      }
      const savedStats = fs.statSync(this.compressedWeightsPath);
      this.lastSavedSource = {
        file: path.basename(this.compressedWeightsPath),
        format: 'gzip',
        sizeBytes: savedStats.size,
        mtimeMs: savedStats.mtimeMs
      };
      console.log(
        `[AI-RL][${this.difficulty}] Saved weights: ${data.stateCount} states, frozen: ${this.frozen}, ` +
        `pruned: ${pruneStats.prunedStates}, file: ${path.basename(this.compressedWeightsPath)}`
      );
      return true;
    } catch (e) {
      console.error(`[AI-RL][${this.difficulty}] Failed to save weights:`, e.message);
      return false;
    }
  }

  _pushModeReward(mode, reward) {
    if (!Number.isFinite(reward)) return;
    const bucket = this.recentModeRewards[mode];
    if (!Array.isArray(bucket)) return;
    bucket.push(reward);
    if (bucket.length > 100) bucket.shift();
    this.lastRewardMetricMode = mode;
  }

  _getAverageRecentModeReward(mode) {
    const bucket = this.recentModeRewards[mode];
    if (!Array.isArray(bucket) || bucket.length <= 0) return 0;
    const avg = bucket.reduce((sum, reward) => sum + reward, 0) / bucket.length;
    return Math.round(avg * 10) / 10;
  }

  _getRewardMetricStatus(stats) {
    const soloValue = this._getAverageRecentModeReward('solo');
    const selfPlayValue = this._getAverageRecentModeReward('selfplay');
    const mode = this.isTraining ? this.currentTrainingMode : (this.lastRewardMetricMode || null);

    if (mode === 'selfplay') {
      return {
        mode,
        label: '평균 승자 보상',
        hint: '셀프플레이는 기록된 매치의 승자 보상 평균입니다. 솔로 총 보상과 직접 비교하면 안 됩니다.',
        value: selfPlayValue,
        soloValue,
        selfPlayValue,
        overallValue: stats.avgReward
      };
    }

    if (mode === 'solo') {
      return {
        mode,
        label: '평균 보상',
        hint: '솔로는 기록된 에피소드 총 보상 평균입니다.',
        value: soloValue,
        soloValue,
        selfPlayValue,
        overallValue: stats.avgReward
      };
    }

    return {
      mode: null,
      label: '평균 보상',
      hint: '최근 100개 기록 결과 기준입니다.',
      value: stats.avgReward,
      soloValue,
      selfPlayValue,
      overallValue: stats.avgReward
    };
  }

  getStatus() {
    const stats = this.qTable.getStats();
    return {
      difficulty: this.difficulty,
      isTraining: this.isTraining,
      frozen: this.frozen,
      currentEpisode: this.currentEpisode,
      maxEpisodes: this.maxEpisodes,
      episodeSteps: this.episodeSteps,
      stats,
      rewardMetric: this._getRewardMetricStatus(stats),
      log: this.trainingLog.slice(-20),
      storage: {
        loadedFrom: this.lastLoadedSource,
        savedTo: this.lastSavedSource,
        prune: this.lastPruneStats,
        savePlainJson: RL_WEIGHT_SAVE_PLAIN_JSON
      },
      recording: {
        policy: { ...this.recordingPolicy },
        stats: this.recordingStats
      }
    };
  }

  /**
   * Called by the server during normal AI updates.
   * Returns the RL-chosen action index for a given state, or null if RL is not used.
   */
  getAction(gameState, playerId, difficulty) {
    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.normal;
    if (!preset.useRL) return null;

    const state = encodeState(gameState, playerId);
    if (state === 'dead') return null;
    if (!this.qTable.table[state]) return null;

    const liveEpsilon = this.frozen
      ? 0.01
      : Math.max(0.01, Math.min(0.04, preset.epsilon * 0.25));
    return this.qTable.chooseAction(state, liveEpsilon);
  }

  /**
   * Record a transition during live gameplay (online learning).
   * Skipped if frozen.
   */
  recordTransition(prevState, action, reward, nextState) {
    if (this.frozen) return;
    this.qTable.update(prevState, action, reward, nextState);
  }

  /**
   * Start training mode — runs accelerated AI-vs-AI episodes.
   * This is non-blocking; it runs step-by-step via setInterval.
   */
  startTraining(episodes, stepCallback) {
    if (this.isTraining) return false;
    if (this.frozen) {
      this.trainingLog.push('[오류] 이 난이도는 고정(잠금) 상태입니다. 해제 후 학습하세요.');
      return false;
    }
    this.isTraining = true;
    this.currentTrainingMode = 'solo';
    this.maxEpisodes = episodes || 1000;
    this.currentEpisode = 0;
    this.recordingStats.solo = {
      attempted: 0,
      accepted: 0,
      discarded: 0,
      acceptedTransitions: 0,
      discardedTransitions: 0,
      failureReplays: 0,
      failureReplayTransitions: 0,
      lastAcceptedReward: null,
      lastDiscardedReward: null,
      lastFailureReplayReward: null
    };
    this.trainingLog = [];
    this.trainingLog.push(`[Filter] record if score >= ${this.recordingPolicy.minScore}`);
    if (this.recordingPolicy.learnFromFailures) {
      this.trainingLog.push(
        `[Replay] learn from failures <= ${this.recordingPolicy.failureRewardThreshold}, limit: ${this.recordingPolicy.failureReplayLimit}`
      );
    }
    this.trainingLog.push(`[학습 시작] ${this.maxEpisodes} 에피소드`);
    console.log(`[AI-RL] Training started: ${this.maxEpisodes} episodes`);

    this._runTrainingStep(stepCallback);
    return true;
  }

  stopTraining() {
    this.isTraining = false;
    this.currentTrainingMode = null;
    if (this.selfPlayArena) this.selfPlayArena.isRunning = false;
    this.saveWeights();
    this.trainingLog.push('[학습 중단]');
    console.log('[AI-RL] Training stopped');
  }

  _runTrainingStep(stepCallback) {
    if (!this.isTraining || this.currentEpisode >= this.maxEpisodes) {
      this.isTraining = false;
      this.currentTrainingMode = null;
      this.saveWeights();
      this.trainingLog.push(`[학습 완료] ${this.currentEpisode} 에피소드, 평균 보상: ${this.qTable.getStats().avgReward}`);
      console.log(`[AI-RL] Training complete: ${this.currentEpisode} episodes`);
      if (stepCallback) stepCallback({ done: true, episode: this.currentEpisode });
      return;
    }

    // Run one episode as a simplified simulation
    const episodeResult = this._simulateEpisode();
    const episodeReward = episodeResult.totalReward;
    this.currentEpisode++;
    this.recordingStats.solo.attempted++;
    if (episodeResult.recorded) {
      this.qTable.totalEpisodes++;
      this.qTable.totalReward += episodeReward;
      this.qTable.recentRewards.push(episodeReward);
      if (this.qTable.recentRewards.length > 100) this.qTable.recentRewards.shift();
      this._pushModeReward('solo', episodeReward);
      this.recordingStats.solo.accepted++;
      this.recordingStats.solo.acceptedTransitions += episodeResult.transitionCount;
      this.recordingStats.solo.lastAcceptedReward = Math.round(episodeReward * 10) / 10;
    } else {
      this.recordingStats.solo.discarded++;
      this.recordingStats.solo.discardedTransitions += episodeResult.discardedTransitionCount;
      this.recordingStats.solo.lastDiscardedReward = Math.round(episodeReward * 10) / 10;
      if (episodeResult.failureReplayCount > 0) {
        this.recordingStats.solo.failureReplays++;
        this.recordingStats.solo.failureReplayTransitions += episodeResult.failureReplayCount;
        this.recordingStats.solo.lastFailureReplayReward = Math.round(episodeReward * 10) / 10;
      }
    }
    this.qTable.decayEpsilon();

    // Log every 50 episodes
    if (this.currentEpisode % 50 === 0) {
      const stats = this.qTable.getStats();
      const msg =
        `[Episode ${this.currentEpisode}/${this.maxEpisodes}] reward: ${Math.round(episodeReward)}, ` +
        `recorded: ${episodeResult.recorded ? 'yes' : 'no'}, ` +
        `kept: ${this.recordingStats.solo.accepted}/${this.recordingStats.solo.attempted}, ` +
        `mistakes: ${this.recordingStats.solo.failureReplays}, ` +
        `cutoff: ${this.recordingPolicy.minScore}, avg: ${stats.avgReward}, eps: ${stats.epsilon}, states: ${stats.states}`;
      this.trainingLog.push(msg);
      console.log(`[AI-RL] ${msg}`);
    }

    // Auto-save periodically
    const now = Date.now();
    if (now - this.lastSaveTime > this.autoSaveInterval) {
      this.saveWeights();
      this.lastSaveTime = now;
    }

    // Continue next episode asynchronously
    setImmediate(() => this._runTrainingStep(stepCallback));
  }

  /**
   * Simplified episode simulation using abstract state transitions.
   * Instead of running the full game engine, we simulate state changes
   * based on action effects with randomized outcomes.
   */
  _simulateEpisode() {
    let totalReward = 0;
    let state = this._randomInitialState();
    const maxSteps = this.maxStepsPerEpisode;
    const transitions = [];

    for (let step = 0; step < maxSteps; step++) {
      const stateKey = this._simStateToKey(state);
      const action = this.qTable.chooseAction(stateKey);
      const { nextState, reward, done } = this._simulateStep(state, action);

      const nextKey = this._simStateToKey(nextState);
      transitions.push({ stateKey, action, reward, nextKey });

      totalReward += reward;
      state = nextState;

      if (done) break;
    }

    const recorded = totalReward >= this.recordingPolicy.minScore;
    let failureReplayCount = 0;
    if (recorded) {
      for (const transition of transitions) {
        this.qTable.update(transition.stateKey, transition.action, transition.reward, transition.nextKey);
      }
    } else if (
      this.recordingPolicy.learnFromFailures &&
      totalReward <= this.recordingPolicy.failureRewardThreshold &&
      transitions.length > 0
    ) {
      const failureCandidates = transitions
        .map((transition, index) => ({ transition, index }))
        .filter(({ transition }) => transition.reward <= 0);
      const replayCandidates = (failureCandidates.length > 0
        ? failureCandidates
        : transitions.map((transition, index) => ({ transition, index })))
        .sort((a, b) => {
          if (a.transition.reward !== b.transition.reward) {
            return a.transition.reward - b.transition.reward;
          }
          return b.index - a.index;
        })
        .slice(0, Math.min(this.recordingPolicy.failureReplayLimit, transitions.length))
        .sort((a, b) => a.index - b.index);
      const averagePenalty =
        (totalReward / Math.max(1, transitions.length)) * this.recordingPolicy.failurePenaltyScale;
      for (const { transition } of replayCandidates) {
        const penaltyReward = Math.min(
          -0.05,
          averagePenalty,
          transition.reward * this.recordingPolicy.failurePenaltyScale
        );
        this.qTable.update(transition.stateKey, transition.action, penaltyReward, transition.nextKey);
        failureReplayCount++;
      }
    }

    return {
      totalReward,
      recorded,
      transitionCount: transitions.length,
      failureReplayCount,
      discardedTransitionCount: Math.max(0, transitions.length - (recorded ? transitions.length : failureReplayCount))
    };
  }

  _randomInitialState() {
    return createSimulationState({
      enemyCombatPower: 100 + Math.floor(Math.random() * 200),
      enemyBuildingCount: 3 + Math.floor(Math.random() * 5)
    });
  }

  _simStateToKey(s) {
    return encodeAbstractState(summarizeSimulationState(s));
  }

  _simulateStep(state, actionIdx) {
    const action = ACTIONS[actionIdx];
    const s = cloneSimulationState(state);
    s.tick = state.tick + 1;
    let reward = 0;

    // Passive income per tick
    syncSimulationState(s);
    s.resources += getSimulationPassiveIncome(s);

    // --- Recalculate range/vision from unit composition ---
    s.maxAttackRange = 0;
    s.totalVision = 0;
    const unitTypes = [
      ['frigate', s.frigateCount], ['destroyer', s.destroyerCount],
      ['cruiser', s.cruiserCount], ['battleship', s.battleshipCount], ['carrier', s.carrierCount],
      ['submarine', s.submarineCount], ['assaultship', s.assaultshipCount]
    ];
    for (const [type, count] of unitTypes) {
      if (count > 0) {
        s.maxAttackRange = Math.max(s.maxAttackRange, UNIT_RANGE_TIER[type] || 0);
        s.totalVision += count * (UNIT_VISION_TIER[type] || 0);
      }
    }
    // Deployed launchers have range 3 (2500)
    if (s.deployedLauncherCount > 0) {
      s.maxAttackRange = Math.max(s.maxAttackRange, 3);
      s.totalVision += s.deployedLauncherCount * 1;
    }

    // --- Fog of War simulation ---
    // Fog level driven by total vision score from units
    if (s.totalVision >= 10) s.fogLevel = 2;       // excellent vision coverage
    else if (s.totalVision >= 4) s.fogLevel = 1;   // moderate coverage
    else s.fogLevel = 0;                            // early game / few units = blind
    // Destroyer search overrides to full vision temporarily (handled in skill_search)

    // With poor vision, enemy attack estimation is less accurate (penalty for attacking blind)
    const visionPenalty = s.fogLevel === 0 ? 0.7 : (s.fogLevel === 1 ? 0.9 : 1.0);

    // --- Red Zone simulation ---
    // Red zones appear periodically (roughly every ~60 ticks like the 10-min real interval)
    if (s.redZoneTimer <= 0 && Math.random() < 0.015) {
      s.redZoneTimer = 5; // 5 ticks warning before strike
      s.inRedZoneDanger = Math.random() < 0.4; // 40% chance units are in danger zone
    }
    if (s.redZoneTimer > 0) {
      s.redZoneTimer--;
      if (s.redZoneTimer === 0 && s.inRedZoneDanger) {
        // Red zone strike hits units/buildings in the zone
        const dmg = 100 + Math.floor(Math.random() * 200);
        s.combatPower = Math.max(0, s.combatPower - dmg);
        const redZoneLosses = removeRandomUnitsFromSimulation(s, Math.ceil(dmg / 150));
        if (Math.random() < 0.25) {
          const destroyedBuildingType = destroyRandomCompletedBuilding(s);
          if (destroyedBuildingType) reward -= getBuildingLossPenaltyScore(destroyedBuildingType) * 0.22;
        }
        reward -= 8; // Penalty for not evacuating
        reward -= getLossPenaltyScoreFromSummary(redZoneLosses);
        reward -= redZoneLosses.workerLosses * 2.5;
        s.inRedZoneDanger = false;
      }
    }

    // Enemy grows slowly
    if (Math.random() < 0.3) {
      s.enemyCombatPower += 20;
      s.enemyBuildingCount += Math.random() < 0.2 ? 1 : 0;
    }

      // Action effects
      switch (action) {
      case 'build_power_plant':
        if (enqueueSimulationBuilding(s, 'power_plant')) reward += getQueuedBuildingReward(s, 'power_plant');
        else reward -= 1;
        break;
      case 'build_shipyard':
        if (enqueueSimulationBuilding(s, 'shipyard')) reward += getQueuedBuildingReward(s, 'shipyard');
        else reward -= 1;
        break;
      case 'build_naval_academy':
        if (enqueueSimulationBuilding(s, 'naval_academy')) reward += getQueuedBuildingReward(s, 'naval_academy');
        else reward -= 1;
        break;
      case 'build_missile_silo':
        if (enqueueSimulationBuilding(s, 'missile_silo')) reward += getQueuedBuildingReward(s, 'missile_silo');
        else reward -= 1;
        break;
      case 'build_defense_tower':
        if (enqueueSimulationBuilding(s, 'defense_tower')) reward += getQueuedBuildingReward(s, 'defense_tower');
        else reward -= 1;
        break;
      case 'build_carbase':
        if (enqueueSimulationBuilding(s, 'carbase')) reward += getQueuedBuildingReward(s, 'carbase');
        else reward -= 1;
        break;
      case 'produce_worker':
        if (enqueueSimulationProduction(s, 'worker')) {
          reward += getQueuedProductionReward(s, 'worker');
        } else reward -= 0.4;
        break;
      case 'produce_frigate':
        if (enqueueSimulationProduction(s, 'frigate')) reward += getQueuedProductionReward(s, 'frigate');
        else reward -= 0.5;
        break;
      case 'produce_destroyer':
        if (enqueueSimulationProduction(s, 'destroyer')) reward += getQueuedProductionReward(s, 'destroyer');
        else reward -= 0.5;
        break;
      case 'produce_cruiser':
        if (enqueueSimulationProduction(s, 'cruiser')) reward += getQueuedProductionReward(s, 'cruiser');
        else reward -= 0.5;
        break;
      case 'produce_battleship':
        if (enqueueSimulationProduction(s, 'battleship')) reward += getQueuedProductionReward(s, 'battleship');
        else reward -= 0.5;
        break;
      case 'produce_carrier':
        if (enqueueSimulationProduction(s, 'carrier')) reward += getQueuedProductionReward(s, 'carrier');
        else reward -= 0.5;
        break;
      case 'produce_submarine':
        if (enqueueSimulationProduction(s, 'submarine')) reward += getQueuedProductionReward(s, 'submarine');
        else reward -= 0.5;
        break;
      case 'produce_assaultship':
        if (enqueueSimulationProduction(s, 'assaultship')) reward += getQueuedProductionReward(s, 'assaultship');
        else reward -= 0.5;
        break;
      case 'produce_missile_launcher':
        if (enqueueSimulationProduction(s, 'missile_launcher')) reward += getQueuedProductionReward(s, 'missile_launcher');
        else reward -= 0.5;
        break;
      case 'produce_slbm': {
        const totalMissiles = s.storedSlbmCount + s.loadedSlbmCount;
        const desiredStock = Math.max(2, s.submarineCount * SUBMARINE_SLBM_CAPACITY);
        const slbmOpportunity = getSoloSlbmStrikeOpportunity(s);
        if (enqueueSimulationProduction(s, 'slbm')) {
          reward += getQueuedProductionReward(s, 'slbm');
          if (s.submarineCount > 0 && totalMissiles < desiredStock) reward += 1.4;
          else if (s.enemyCombatPower > 250) reward += 0.8;
          reward += Math.min(1.8, slbmOpportunity * 0.08);
        } else reward -= 1;
        break;
      }
      case 'attack_nearest_enemy':
      case 'attack_strongest_enemy': {
        if (s.combatPower <= 0) { reward -= 2; break; }
        const ownPowerBeforeRaid = s.combatPower;
        const enemyPowerBeforeRaid = s.enemyCombatPower;
        let structuralGainScore = 0;
        const enemyDefensePressure = getEstimatedEnemyDefensePressure(s);
        const powerRatio = s.combatPower / Math.max(1, s.enemyCombatPower);
        // Vision affects attack effectiveness: blind attacks are riskier
        const effectiveRatio = powerRatio * visionPenalty;
        // Range advantage: if our max range > enemy distance tier, first-strike bonus
        const rangeAdvantage = s.maxAttackRange >= 3 ? 1.3
          : (s.maxAttackRange >= 2 ? 1.1 : 1.0);
        // Deployed launchers add massive range firepower in defensive fights
        const launcherDps = s.deployedLauncherCount * 80;
        const totalPower = s.combatPower + launcherDps;
        const fortifiedEnemyPower = s.enemyCombatPower + (enemyDefensePressure * 42);
        const win = Math.random() < Math.min(0.85, (totalPower / Math.max(1, fortifiedEnemyPower)) * 0.5 * rangeAdvantage * visionPenalty);
        if (win) {
          const damage = Math.floor(totalPower * 0.2 * Math.random());
          const inflictedKills = Math.floor(damage / 100);
          s.enemyCombatPower = Math.max(0, s.enemyCombatPower - damage);
          s.kills += inflictedKills;
          reward += damage * 0.015;
          reward += inflictedKills * 4;
          if (Math.random() < 0.3) {
            const destroyedBuildings = s.enemyBuildingCount >= 5 && Math.random() < 0.28 ? 2 : 1;
            s.enemyBuildingCount = Math.max(0, s.enemyBuildingCount - destroyedBuildings);
            structuralGainScore += destroyedBuildings * 14;
            reward += destroyedBuildings * 9;
          }
        } else {
          // Fog makes losses worse when attacking blind
          const lossMul = s.fogLevel === 0 ? 1.4 : (s.fogLevel === 1 ? 1.1 : 1.0);
          const loss = Math.floor(s.combatPower * (0.15 + Math.min(0.12, enemyDefensePressure * 0.018)) * Math.random() * lossMul);
          s.combatPower = Math.max(0, s.combatPower - loss);
          const lossSummary = removeRandomUnitsFromSimulation(s, Math.ceil(loss / 100), { allowWorkers: false });
          reward -= loss * 0.025;
          reward -= getLossPenaltyScoreFromSummary(lossSummary);
          const inflictedPower = Math.max(0, enemyPowerBeforeRaid - s.enemyCombatPower);
          const ownLossPower = Math.max(0, ownPowerBeforeRaid - s.combatPower) + Math.max(0, lossSummary.combatPowerLost);
          reward -= getRaidFailurePenalty({
            initiatedAttack: true,
            inflictedPower,
            ownLossPower,
            structuralGainScore,
            effectiveRatio,
            fogLevel: s.fogLevel,
            defensePressure: enemyDefensePressure
          });
        }
        break;
      }
      case 'defend_base':
        s.combatPower += 20; // Defensive bonus
        // Defending also moves units away from red zone danger
        if (s.inRedZoneDanger && s.redZoneTimer > 0) { s.inRedZoneDanger = false; reward += 2; }
        reward += 0.3;
        break;
      case 'scout':
        // Scouting improves fog level and earns bonus if vision was poor
        if (s.fogLevel < 2) { s.fogLevel = Math.min(2, s.fogLevel + 1); reward += 1.5; }
        else reward += 0.2;
        // Scouting also detects red zone threats — move units out of danger
        if (s.inRedZoneDanger && s.redZoneTimer > 0) { s.inRedZoneDanger = false; reward += 3; }
        break;
      case 'load_submarine_slbm': {
        const freeSlots = Math.max(0, (s.submarineCount * SUBMARINE_SLBM_CAPACITY) - s.loadedSlbmCount);
        if (s.submarineCount > 0 && s.storedSlbmCount > 0 && freeSlots > 0) {
          const loadCount = Math.min(s.submarineCount, s.storedSlbmCount, freeSlots);
          s.storedSlbmCount -= loadCount;
          s.loadedSlbmCount += loadCount;
          if (s.enemyCombatPower > 0 || s.fogLevel >= 1) reward += loadCount * 1.5;
          else reward += loadCount * 0.8;
        } else if (s.submarineCount <= 0) {
          reward -= 1;
        } else if (s.storedSlbmCount <= 0) {
          reward -= 0.8;
        } else {
          reward -= 0.3;
        }
        break;
      }
      case 'use_slbm':
        if (s.submarineCount > 0 && s.loadedSlbmCount > 0) {
          s.loadedSlbmCount--;
          s.combatPower = Math.max(0, s.combatPower - COMBAT_POWER_MAP.slbm);
          const intelMultiplier = s.fogLevel >= 1 ? 1.0 : 0.65;
          const stealthMultiplier = s.stealthActive ? 1.1 : 1.0;
          const slbmOpportunity = getSoloSlbmStrikeOpportunity(s);
          const fortificationBonus = Math.min(0.42, getEstimatedEnemyDefensePressure(s) * 0.035 + slbmOpportunity * 0.012);
          const densityBonus = Math.min(1.72, 1 + (Math.max(0, s.enemyBuildingCount - 1) * 0.08) + Math.min(0.25, s.enemyCombatPower / 1800) + fortificationBonus);
          const dmg = Math.floor((220 + Math.random() * 260) * intelMultiplier * stealthMultiplier * densityBonus);
          s.enemyCombatPower = Math.max(0, s.enemyCombatPower - dmg);
          let destroyedBuildings = 0;
          const primaryBuildingHitChance = Math.min(0.92, (s.fogLevel >= 1 ? 0.7 : 0.35) + fortificationBonus * 0.35);
          const secondaryBuildingHitChance = Math.min(0.7, (s.enemyBuildingCount >= 4 ? (s.fogLevel >= 1 ? 0.4 : 0.18) : 0) + fortificationBonus * 0.28);
          if (Math.random() < primaryBuildingHitChance) {
            destroyedBuildings++;
          }
          if (s.enemyBuildingCount >= 4 && Math.random() < secondaryBuildingHitChance) {
            destroyedBuildings++;
          }
          if (destroyedBuildings > 0) {
            s.enemyBuildingCount = Math.max(0, s.enemyBuildingCount - destroyedBuildings);
          }
          reward += s.fogLevel >= 1 ? 7.8 : 4.8;
          reward += dmg * 0.02;
          reward += destroyedBuildings * (12 + Math.min(8, slbmOpportunity * 0.45));
          reward += Math.min(4.5, slbmOpportunity * 0.22);
          if (s.enemyCombatPower > 200) reward += 1.4;
        } else if (s.storedSlbmCount > 0) {
          reward -= 0.8; // Produced missiles exist, but firing without loading is invalid.
        } else {
          reward -= 1;
        }
        break;
      case 'use_airstrike':
        // Requires carrier with 10 aircraft, consumes all, 3 passes of 240 dmg
        if (s.carrierCount > 0 && s.aircraftCount >= 10) {
          s.aircraftCount = 0;
          const dmg = 720 * (s.enemyDistance <= 1 ? 1.0 : 0.5); // Range matters: far = half effect
          s.enemyCombatPower = Math.max(0, s.enemyCombatPower - dmg);
          if (Math.random() < 0.4) s.enemyBuildingCount = Math.max(0, s.enemyBuildingCount - 1);
          reward += 6;
        } else if (s.carrierCount > 0 && s.aircraftCount < 10) {
          reward -= 0.3; // Has carrier but not enough aircraft
        } else reward -= 0.5;
        break;
      case 'activate_aegis':
        if (s.combatPower >= 200) { s.combatPower += 30; reward += 1; }
        else reward -= 0.5;
        break;
      case 'lay_mines':
        if (s.destroyerCount > 0) {
          // Mines are most effective when enemy is approaching (mid distance)
          const mineBonus = s.enemyDistance === 1 ? 2.0 : 0.5;
          s.combatPower += 10;
          reward += mineBonus;
        } else reward -= 0.5;
        break;
      case 'lure_tactic':
        // Requires frigate + deployed launchers, best at mid range
        if (s.frigateCount > 0 && s.combatPower >= 300 && s.enemyCombatPower > 0) {
          const rangeBonus = s.enemyDistance === 1 ? 0.5 : 0.3;
          const trapped = Math.random() < (0.4 + rangeBonus);
          if (trapped) { s.enemyCombatPower = Math.max(0, s.enemyCombatPower - 100); reward += 4; }
          else reward += 0.5;
        } else reward -= 0.5;
        break;
      case 'expand':
        {
          const expandBuildingType = s.hasShipyard ? 'power_plant' : 'shipyard';
          if (enqueueSimulationBuilding(s, expandBuildingType)) reward += getQueuedBuildingReward(s, expandBuildingType);
          else reward -= 0.5;
        }
        break;
      case 'save_resources':
        reward += 0.1;
        break;

      // ========== SKILL ACTIONS ==========
      case 'skill_aimed_shot':
        // Battleship: next attack deals 2x damage. 16-tick cooldown.
        if (s.battleshipCount > 0 && s.aimedShotReady && s.aimedShotCooldown <= 0) {
          s.aimedShotReady = false;
          s.aimedShotCooldown = 5; // ~16s mapped to 5 ticks
          // Aimed shot is most valuable when in combat and enemy is in range
          if (s.inCombat && s.enemyDistance <= 1) {
            const aimDmg = Math.floor(s.battleshipCount * 200 * 0.5); // 2x on subset
            s.enemyCombatPower = Math.max(0, s.enemyCombatPower - aimDmg);
            reward += 4;
          } else if (s.inCombat) {
            // In combat but enemy far — wasted, but partial value
            reward += 1;
          } else {
            // Not in combat — wasted cooldown
            reward -= 1;
          }
        } else if (s.battleshipCount <= 0) {
          reward -= 1; // No battleship
        } else {
          reward -= 0.5; // On cooldown
        }
        break;

      case 'skill_combat_stance':
        // Battleship: +10% atk speed per stack, costs 10% HP per attack
        if (s.battleshipCount > 0) {
          if (!s.combatStanceActive) {
            s.combatStanceActive = true;
            s.combatStanceStacks = 1;
            // Good when in combat with HP advantage
            if (s.inCombat && s.combatPower > s.enemyCombatPower * 0.5) {
              reward += 2;
            } else if (s.inCombat) {
              reward += 0.5; // Risky — low HP but might help
            } else {
              reward += 0.3; // Preemptive activation, mild
            }
          } else {
            // Already active — stacking
            s.combatStanceStacks = Math.min(5, s.combatStanceStacks + 1);
            if (s.inCombat) reward += 0.5;
            else reward += 0.1;
          }
          // HP drain: combat stance costs HP over time
          const hpCost = s.battleshipCount * 20 * s.combatStanceStacks;
          s.combatPower = Math.max(0, s.combatPower - hpCost * 0.05);
        } else reward -= 1;
        break;

      case 'skill_engine_overdrive':
        // Frigate: +speed, evasion scales with missing HP, costs HP/tick
        if (s.frigateCount > 0) {
          if (!s.engineOverdriveActive) {
            s.engineOverdriveActive = true;
            // Overdrive is great for retreating or chasing
            if (s.inCombat) {
              // In combat: evasion helps survive, good timing
              reward += 2.5;
            } else if (s.inRedZoneDanger) {
              // Escaping red zone: speed helps
              reward += 2;
            } else {
              reward += 0.5; // Preemptive, less useful
            }
          } else {
            reward += 0.1; // Already active
          }
          // HP drain per tick while active
          if (s.engineOverdriveActive) {
            s.combatPower = Math.max(0, s.combatPower - s.frigateCount * 3);
          }
        } else reward -= 1;
        break;

      case 'skill_search':
        // Destroyer: massive vision pulse (4800 range), reveals subs. 16s cd.
        if (s.destroyerCount > 0 && s.searchCooldown <= 0) {
          s.searchCooldown = 5; // ~16s mapped to 5 ticks
          s.fogLevel = 2; // Full vision temporarily
          // Reveals hidden enemies — especially valuable when blind
          if (s.fogLevel < 2) {
            reward += 3;
          } else {
            reward += 1;
          }
          // Bonus if enemy has submarines (counter-play)
          if (s.enemyCombatPower > 200) reward += 1;
        } else if (s.destroyerCount <= 0) {
          reward -= 1;
        } else {
          reward -= 0.3; // On cooldown
        }
        break;

      case 'skill_stealth':
        // Submarine: 15s invisibility, 30s cooldown
        if (s.submarineCount > 0 && !s.stealthActive && s.stealthCooldown <= 0) {
          s.stealthActive = true;
          s.stealthTimer = 5; // ~15s mapped to 5 ticks
          s.stealthCooldown = 10; // ~30s mapped to 10 ticks
          // Stealth is best used right before attacking (ambush) or to survive
          if (s.inCombat && s.combatPower < s.enemyCombatPower) {
            // Losing fight — stealth to survive, great timing
            reward += 3;
          } else if (!s.inCombat && s.enemyDistance <= 1) {
            // Enemy approaching — preemptive ambush positioning
            reward += 2.5;
          } else {
            reward += 1; // General stealth
          }
        } else if (s.submarineCount <= 0) {
          reward -= 1;
        } else {
          reward -= 0.3; // Already active or on cooldown
        }
        break;

      // ========== STRATEGIC ACTIONS ==========
      case 'deploy_launchers':
        // Deploy mobile launchers → immobile but 2500 range
        if (s.launcherCount > 0) {
          // Best when enemy approaching and we need area denial
          const count = s.launcherCount;
          s.deployedLauncherCount += count;
          s.launcherCount = 0;
          // Range 2500 is massive — great for defense
          if (s.enemyDistance <= 1) {
            reward += count * 2.5; // Enemy in range, deploy now = excellent
          } else {
            reward += count * 1.0; // Preemptive, good but less urgent
          }
        } else {
          reward -= 0.5; // No launchers to deploy
        }
        break;

      case 'undeploy_launchers':
        // Undeploy → mobile again (for relocation)
        if (s.deployedLauncherCount > 0) {
          s.launcherCount += s.deployedLauncherCount;
          s.deployedLauncherCount = 0;
          // Only good if you need to reposition
          if (s.inRedZoneDanger) {
            reward += 2; // Evacuate from red zone
          } else if (s.enemyDistance === 2) {
            reward += 0.5; // Enemy far, ok to reposition
          } else {
            reward -= 1; // Undeploying during combat = bad
          }
        } else {
          reward -= 0.5;
        }
        break;

      case 'load_assault_ship':
        // Load mobile launchers onto assault ship for transport
        if (s.assaultshipCount > 0 && s.launcherCount > 0 && s.loadedAssaultShips < s.assaultshipCount) {
          const canLoad = Math.min(s.launcherCount, 10); // Max 10 per ship
          s.launcherCount -= canLoad;
          s.unitCount -= canLoad; // Launchers removed from field
          s.combatPower -= canLoad * 100; // Combat power decreases temporarily
          s.loadedAssaultShips++;
          // Good when planning amphibious assault
          if (s.enemyDistance <= 1 && s.fogLevel >= 1) {
            reward += 3; // Good intelligence + close enough to land
          } else {
            reward += 1; // Loading in preparation
          }
        } else if (s.assaultshipCount <= 0) {
          reward -= 1;
        } else {
          reward -= 0.5;
        }
        break;

      case 'amphibious_landing':
        // Sail loaded assault ship to enemy island, unload launchers, deploy them
        // This is the strategic combo: load → transport → unload → deploy
        if (s.loadedAssaultShips > 0) {
          // Unload launchers near enemy territory
          const unloadCount = Math.min(10, 3 + Math.floor(Math.random() * 8));
          s.deployedLauncherCount += unloadCount;
          s.unitCount += unloadCount; // Launchers back on field
          s.combatPower += unloadCount * 100;
          s.loadedAssaultShips--;
          s.hasLandAccess = true;

          // Deployed launchers at range 2500 near enemy = devastating
          // BUT risky if enemy has strong counter
          if (s.fogLevel >= 1 && s.enemyCombatPower < s.combatPower * 1.5) {
            // Good recon + manageable enemy = great landing
            const dps = unloadCount * 80;
            s.enemyCombatPower = Math.max(0, s.enemyCombatPower - Math.floor(dps * 0.3));
            reward += 8; // Huge reward for successful amphibious strategy
          } else if (s.fogLevel < 1) {
            // Blind landing — risky
            reward += 2;
            // 30% chance enemy discovers and destroys some launchers
            if (Math.random() < 0.3) {
              const lost = Math.ceil(unloadCount * 0.4);
              s.deployedLauncherCount = Math.max(0, s.deployedLauncherCount - lost);
              s.unitCount = Math.max(0, s.unitCount - lost);
              s.combatPower = Math.max(0, s.combatPower - lost * 100);
              reward -= 3;
            }
          } else {
            // Enemy too strong, landing under fire
            reward += 3;
            if (Math.random() < 0.2) {
              const lost = Math.ceil(unloadCount * 0.3);
              s.deployedLauncherCount = Math.max(0, s.deployedLauncherCount - lost);
              s.unitCount = Math.max(0, s.unitCount - lost);
              reward -= 2;
            }
          }
        } else {
          reward -= 1; // No loaded ships
        }
        break;
    }

    reward += advanceSimulationProgress(s, SIM_TICK_MS);

    const energyIncome = getSimulationEnergyIncomePerSecond(s);
    const energySpend = getSimulationEnergySpendPerSecond(s);
    const balancedThroughput = Math.min(energyIncome + SIM_BASE_PASSIVE_INCOME, energySpend);
    const buildingRetentionScore = getBuildingRetentionScore(s);
    reward += Math.sqrt(Math.max(0, energyIncome)) * 0.18;
    reward += Math.sqrt(Math.max(0, balancedThroughput)) * 0.26;
    reward += buildingRetentionScore * 0.016;
    if (energyIncome >= 10 && balancedThroughput >= 6) reward += 0.3;
    if (energyIncome >= 15 && balancedThroughput >= 10) reward += 0.28;
    const defenseTowerCount = getCompletedBuildingCount(s, 'defense_tower');
    const towerPressure = Math.max(0, (s.enemyCombatPower - Math.max(180, s.combatPower * 0.75)) / 220);
    const defenseSetupScore = getStrategicDefenseScore(s);
    reward += defenseTowerCount * Math.min(0.28, towerPressure * 0.12);
    reward += Math.min(0.42, defenseSetupScore * 0.045) * (towerPressure > 0.2 ? 1 : 0.45);
    if (towerPressure > 0.35 && defenseTowerCount <= 0) reward -= 0.9;
    const combatPopulation = getCombatPopulation(s);
    const populationUtilization = getPopulationUtilization(s);
    reward += Math.sqrt(Math.max(0, combatPopulation)) * 0.12;
    reward += Math.sqrt(Math.max(0, s.maxPopulation || 0)) * 0.03;
    reward += Math.max(0, populationUtilization - 0.35) * 0.55;
    if ((s.population || 0) >= 30) reward += 0.14;
    if ((s.population || 0) >= 60) reward += 0.18;
    if ((s.population || 0) >= 100) reward += 0.24;
    const combatUnitCount = Math.max(0, s.unitCount - s.workerCount);
    if (combatUnitCount >= 4 && getCompletedBuildingCount(s, 'power_plant') <= 1) reward -= 0.9;
    if (combatUnitCount >= 6 && getCompletedBuildingCount(s, 'shipyard') <= 1 && energyIncome >= 10) reward -= 0.45;

    // --- Skill cooldown/timer ticks ---
    if (s.aimedShotCooldown > 0) { s.aimedShotCooldown--; if (s.aimedShotCooldown <= 0) s.aimedShotReady = true; }
    if (s.searchCooldown > 0) s.searchCooldown--;
    if (s.stealthTimer > 0) {
      s.stealthTimer--;
      if (s.stealthTimer <= 0) { s.stealthActive = false; } // Stealth expired
    }
    if (s.stealthCooldown > 0) s.stealthCooldown--;
    // Engine overdrive ongoing HP drain
    if (s.engineOverdriveActive && s.frigateCount > 0) {
      s.combatPower = Math.max(0, s.combatPower - s.frigateCount * 2);
      // Frigates can die from overdrive drain
      if (s.combatPower <= 0 && s.frigateCount > 0) {
        removeRandomUnitsFromSimulation(s, 1, { allowWorkers: false });
        s.engineOverdriveActive = s.frigateCount > 0;
      }
    }
    // Carrier aircraft production (passive, 1 per 3 ticks if carrier exists)
    if (s.carrierCount > 0 && s.aircraftCount < 10 && s.tick % 3 === 0) {
      s.aircraftCount = Math.min(10, s.aircraftCount + s.carrierCount);
    }

    // --- Combat engagement simulation ---
    // Enemy distance changes over time: enemy approaches
    if (s.enemyCombatPower > 0 && Math.random() < 0.08) {
      s.enemyDistance = Math.max(0, s.enemyDistance - 1);
    }
    // Check if in combat (enemy close + both have power)
    s.inCombat = s.enemyDistance === 0 && s.combatPower > 0 && s.enemyCombatPower > 0;

    // Enemy attacks player when close
    if (s.inCombat || (Math.random() < 0.1 && s.enemyCombatPower > 0)) {
      let enemyDmg = Math.floor(s.enemyCombatPower * 0.1 * Math.random());
      // Stealth reduces incoming damage (enemies can't see submarines)
      if (s.stealthActive) enemyDmg = Math.floor(enemyDmg * 0.4);
      // Engine overdrive gives evasion
      if (s.engineOverdriveActive) enemyDmg = Math.floor(enemyDmg * 0.5);
      s.combatPower = Math.max(0, s.combatPower - enemyDmg);
      if (s.combatPower <= 0 && Math.random() < 0.3) {
        const destroyedBuildingType = destroyRandomCompletedBuilding(s);
        if (destroyedBuildingType) reward -= getBuildingLossPenaltyScore(destroyedBuildingType) * 0.22;
      }
      // Unit losses from combat
      if (enemyDmg > 100) {
        const lost = Math.ceil(enemyDmg / 200);
        const lossSummary = removeRandomUnitsFromSimulation(s, lost);
        reward -= enemyDmg * 0.02;
        reward -= lossSummary.combatUnitsLost * 6.5;
        reward -= lossSummary.workerLosses * 2.5;
      }
    }

    // Check end conditions
    let done = false;
    if (s.buildingCount <= 0) { s.alive = false; done = true; reward -= 50; }
    if (s.enemyBuildingCount <= 0 && s.enemyCombatPower <= 0) { done = true; reward += 100; }
    if (s.tick >= this.maxStepsPerEpisode) done = true;

    return { nextState: s, reward, done };
  }
}

// ========== SELF-PLAY ARENA ==========
// N agents compete in simulated matches. Victory margin determines reward.
// Uses the same Q-table but trains by having agents play against each other.

const SELF_PLAY_PROFILE_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'balanced',
    economy: 0.14,
    defense: 0.16,
    aggression: 0.04,
    tech: 0.16,
    scouting: 0.05,
    lightFleet: 0.0,
    heavyFleet: 0.14,
    missile: 0.05,
    carrier: 0.05,
    submarine: 0.05
  }),
  Object.freeze({
    id: 'macro',
    economy: 0.4,
    defense: 0.14,
    aggression: -0.08,
    tech: 0.34,
    scouting: 0.05,
    lightFleet: -0.12,
    heavyFleet: 0.2,
    missile: 0.05,
    carrier: 0.05,
    submarine: 0.02
  }),
  Object.freeze({
    id: 'fortress',
    economy: 0.22,
    defense: 0.42,
    aggression: -0.12,
    tech: 0.24,
    scouting: 0.02,
    lightFleet: -0.14,
    heavyFleet: 0.2,
    missile: 0.24,
    carrier: 0.02,
    submarine: 0.02
  }),
  Object.freeze({
    id: 'raider',
    economy: 0.02,
    defense: -0.06,
    aggression: 0.22,
    tech: 0.02,
    scouting: 0.18,
    lightFleet: 0.16,
    heavyFleet: -0.04,
    missile: -0.08,
    carrier: -0.1,
    submarine: 0.04
  }),
  Object.freeze({
    id: 'carrier',
    economy: 0.1,
    defense: 0.05,
    aggression: 0.05,
    tech: 0.28,
    scouting: 0.18,
    lightFleet: -0.08,
    heavyFleet: 0.08,
    missile: -0.06,
    carrier: 0.34,
    submarine: 0.02
  }),
  Object.freeze({
    id: 'wolfpack',
    economy: 0.04,
    defense: 0.02,
    aggression: 0.16,
    tech: 0.12,
    scouting: 0.12,
    lightFleet: 0.02,
    heavyFleet: 0.02,
    missile: 0.02,
    carrier: -0.08,
    submarine: 0.34
  }),
  Object.freeze({
    id: 'siege',
    economy: 0.08,
    defense: 0.18,
    aggression: 0.04,
    tech: 0.24,
    scouting: 0.02,
    lightFleet: -0.12,
    heavyFleet: 0.28,
    missile: 0.28,
    carrier: 0.02,
    submarine: 0.02
  })
]);

function clampSelfPlayBias(value) {
  return Math.max(-0.45, Math.min(0.45, value));
}

function createSelfPlayAgentProfile(template, agentIdx) {
  const jitter = () => (Math.random() - 0.5) * 0.12;
  return {
    id: `${template.id}_${agentIdx + 1}`,
    templateId: template.id,
    economy: clampSelfPlayBias(template.economy + jitter()),
    defense: clampSelfPlayBias(template.defense + jitter()),
    aggression: clampSelfPlayBias(template.aggression + jitter()),
    tech: clampSelfPlayBias(template.tech + jitter()),
    scouting: clampSelfPlayBias(template.scouting + jitter()),
    lightFleet: clampSelfPlayBias(template.lightFleet + jitter()),
    heavyFleet: clampSelfPlayBias(template.heavyFleet + jitter()),
    missile: clampSelfPlayBias(template.missile + jitter()),
    carrier: clampSelfPlayBias(template.carrier + jitter()),
    submarine: clampSelfPlayBias(template.submarine + jitter()),
    epsilonScale: Math.max(0.8, Math.min(1.2, 1 + jitter())),
    biasScale: 0.8 + Math.random() * 0.6
  };
}

class SelfPlayArena {
  constructor(difficulty, numAgents = 4) {
    this.difficulty = difficulty;
    this.numAgents = Math.max(2, Math.min(8, numAgents));
    this.qTable = null;         // Set externally from TrainingSession
    this.isRunning = false;
    this.currentMatch = 0;
    this.maxMatches = 100;
    this.maxStepsPerMatch = 500;
    this.matchLog = [];
    // ELO ratings per agent slot (reset each training run)
    this.eloRatings = new Array(this.numAgents).fill(1200);
    this.matchResults = [];     // { winner, scores[], margin }
    this.minRecordScore = RL_TRAINING_MIN_RECORD_SCORE;
    this.minAgentReward = RL_SELFPLAY_MIN_AGENT_REWARD;
    this.learnFromFailures = RL_FAILURE_REPLAY_ENABLED;
    this.failureReplayLimit = RL_FAILURE_REPLAY_LIMIT;
    this.failurePenaltyScale = RL_FAILURE_REPLAY_PENALTY_SCALE;
    this.failureRewardThreshold = RL_FAILURE_REWARD_THRESHOLD;
    this.currentMatchProfiles = [];
  }

  _createMatchProfiles() {
    const templates = SELF_PLAY_PROFILE_TEMPLATES.slice();
    for (let i = templates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [templates[i], templates[j]] = [templates[j], templates[i]];
    }
    const profiles = [];
    for (let i = 0; i < this.numAgents; i++) {
      profiles.push(createSelfPlayAgentProfile(templates[i % templates.length], i));
    }
    return profiles;
  }

  /**
   * Create initial state for one agent in a multi-agent match.
   * Each agent starts with slightly randomized conditions.
   */
  _createAgentState(agentIdx) {
    const selfPlayProfile = this.currentMatchProfiles[agentIdx] || createSelfPlayAgentProfile(SELF_PLAY_PROFILE_TEMPLATES[0], agentIdx);
    return createSimulationState({
      id: agentIdx,
      resources: SIM_STARTING_RESOURCES,
      enemyCombatPower: 0,
      enemyBuildingCount: 0,
      totalDamageDealt: 0,
      totalDamageTaken: 0,
      enemiesEliminated: 0,
      killEventScore: 0,
      lossEventScore: 0,
      failedRaidPenaltyScore: 0,
      structuralStrikeScore: 0,
      buildingLossScore: 0,
      selfPlayProfile,
      selfPlayProfileId: selfPlayProfile.templateId
    });
  }

  /**
   * Build a per-agent view: aggregate all other alive agents as "enemy".
   * This lets each agent see a combined enemy state for its Q-table lookup.
   */
  _buildAgentView(agent, allAgents) {
    let enemyCombat = 0, enemyBuildings = 0, closestDist = 2;
    for (const other of allAgents) {
      if (other.id === agent.id || !other.alive) continue;
      enemyCombat += other.combatPower;
      enemyBuildings += other.buildingCount;
      // Simplify distance: if any enemy is close, we're close
      closestDist = Math.min(closestDist, other.enemyDistance !== undefined ? 1 : 2);
    }
    // Write aggregated enemy view into agent's state for Q-table encoding
    const view = { ...agent };
    view.enemyCombatPower = enemyCombat;
    view.enemyBuildingCount = enemyBuildings;
    view.enemyDistance = closestDist;
    return view;
  }

  _getActionProfileBias(agent, action) {
    const profile = agent?.selfPlayProfile;
    if (!profile) return 0;
    const energyIncome = getSimulationEnergyIncomePerSecond(agent);
    const shipyardCount = getCompletedBuildingCount(agent, 'shipyard');
    const academyCount = getCompletedBuildingCount(agent, 'naval_academy');
    const powerPlantCount = getCompletedBuildingCount(agent, 'power_plant');
    const missileSiloCount = getCompletedBuildingCount(agent, 'missile_silo');
    const towerCount = getCompletedBuildingCount(agent, 'defense_tower');
    const lightFleetRatio = getLightFleetRatio(agent);
    const storedSlbmCount = Math.max(0, Math.floor(agent.storedSlbmCount || 0));
    const loadedSlbmCount = Math.max(0, Math.floor(agent.loadedSlbmCount || 0));
    const slbmOpportunity = getSoloSlbmStrikeOpportunity(agent);
    const lateTechPressure = academyCount > 0 && powerPlantCount >= 4;
    const homeThreatPressure = Math.max(
      0,
      (agent.enemyDistance === 0 ? (agent.enemyCombatPower || 0) * 0.6 : 0)
      - (getStrategicDefenseScore(agent) * 95 + Math.max(0, agent.combatPower || 0) * 0.16)
    );
    let bias = 0;

    switch (action) {
      case 'build_power_plant':
        bias += profile.economy * 1.1;
        if (energyIncome < 10) bias += profile.economy * 0.45;
        break;
      case 'build_shipyard':
        bias += profile.economy * 0.35 + profile.aggression * 0.18 + profile.heavyFleet * 0.12;
        break;
      case 'build_naval_academy':
        bias += profile.tech * 0.9 + profile.heavyFleet * 0.18 + profile.carrier * 0.12 + profile.submarine * 0.12;
        if (shipyardCount <= 0) bias -= 0.1;
        if (academyCount <= 0 && powerPlantCount >= 3 && shipyardCount >= 1) bias += 0.28;
        break;
      case 'build_missile_silo':
      case 'build_carbase':
        bias += profile.missile * 0.95 + profile.tech * 0.18 + profile.defense * 0.12;
        if (action === 'build_carbase' && missileSiloCount <= 0) bias -= 0.15;
        if (action === 'build_missile_silo' && academyCount > 0 && powerPlantCount >= 4) bias += 0.18 + Math.min(0.18, slbmOpportunity * 0.012);
        if (action === 'build_carbase' && missileSiloCount > 0 && powerPlantCount >= 4) bias += 0.14;
        break;
      case 'build_defense_tower':
        bias += profile.defense * 1.0 + profile.economy * 0.08;
        if (towerCount <= 0 && agent.enemyCombatPower > Math.max(180, agent.combatPower * 0.8)) bias += 0.28;
        if (towerCount < 2 && getCompletedBuildingCount(agent, 'power_plant') >= 2) bias += 0.12;
        if (homeThreatPressure > 120) bias += 0.32;
        break;
      case 'produce_worker':
        bias += profile.economy * 0.75;
        break;
      case 'produce_frigate':
        bias += profile.lightFleet * 0.9 + profile.aggression * 0.28 + profile.scouting * 0.12;
        if (lateTechPressure && lightFleetRatio > 0.52) bias -= 0.24;
        break;
      case 'produce_destroyer':
        bias += profile.lightFleet * 0.6 + profile.aggression * 0.34 + profile.defense * 0.08;
        if (lateTechPressure && lightFleetRatio > 0.52) bias -= 0.22;
        break;
      case 'produce_cruiser':
        bias += profile.heavyFleet * 0.52 + profile.defense * 0.18 + profile.tech * 0.15;
        if (shipyardCount >= 2 || academyCount > 0) bias += 0.05;
        if (lateTechPressure && lightFleetRatio > 0.48) bias += 0.16;
        break;
      case 'produce_battleship':
        bias += profile.heavyFleet * 0.95 + profile.tech * 0.22;
        if (lateTechPressure && lightFleetRatio > 0.48) bias += 0.18;
        break;
      case 'produce_carrier':
        bias += profile.carrier * 1.05 + profile.tech * 0.25 + profile.scouting * 0.12;
        if (lateTechPressure && lightFleetRatio > 0.48) bias += 0.14;
        break;
      case 'produce_submarine':
        bias += profile.submarine * 1.05 + profile.aggression * 0.12 + profile.tech * 0.15;
        if (lateTechPressure && lightFleetRatio > 0.48) bias += 0.14;
        if (missileSiloCount > 0) bias += 0.18 + Math.min(0.2, slbmOpportunity * 0.014);
        break;
      case 'produce_assaultship':
        bias += profile.heavyFleet * 0.3 + profile.missile * 0.2 + profile.aggression * 0.2;
        break;
      case 'produce_missile_launcher':
      case 'produce_slbm':
        bias += profile.missile * 0.95 + profile.defense * 0.18 + profile.tech * 0.08;
        if (lateTechPressure && lightFleetRatio > 0.48) bias += 0.18;
        break;
      case 'attack_nearest_enemy':
      case 'attack_strongest_enemy':
        bias += profile.aggression * 1.0 + profile.lightFleet * 0.08 + profile.heavyFleet * 0.12;
        if (homeThreatPressure > 120) bias -= 0.34;
        break;
      case 'defend_base':
        bias += profile.defense * 1.05;
        if (homeThreatPressure > 120) bias += 0.45;
        break;
      case 'scout':
        bias += profile.scouting * 1.1 + profile.carrier * 0.1 + profile.submarine * 0.08;
        if (homeThreatPressure > 120) bias -= 0.18;
        break;
      case 'expand':
        bias += profile.economy * 0.8 + profile.tech * 0.22;
        break;
      case 'save_resources':
        bias += profile.tech * 0.18 + profile.defense * 0.08;
        if (homeThreatPressure > 120) bias -= 0.22;
        break;
      case 'skill_search':
        bias += profile.scouting * 0.8 + profile.defense * 0.12;
        break;
      case 'skill_stealth':
        bias += profile.submarine * 0.85 + profile.aggression * 0.1;
        break;
      case 'skill_aimed_shot':
      case 'skill_combat_stance':
        bias += profile.heavyFleet * 0.5 + profile.aggression * 0.12;
        break;
      case 'load_submarine_slbm':
        bias += profile.missile * 0.82 + profile.tech * 0.12;
        if (agent.submarineCount > 0 && storedSlbmCount > 0 && loadedSlbmCount < (agent.submarineCount * SUBMARINE_SLBM_CAPACITY)) {
          bias += 0.3;
        }
        break;
      case 'use_slbm':
        bias += profile.missile * 0.98 + profile.defense * 0.08 + profile.tech * 0.12;
        if (loadedSlbmCount > 0) bias += 0.12 + Math.min(0.32, slbmOpportunity * 0.018);
        if ((agent.enemyBuildingCount || 0) >= 4) bias += 0.14;
        break;
      case 'deploy_launchers':
      case 'undeploy_launchers':
        bias += profile.missile * 0.75 + profile.defense * 0.08;
        break;
      case 'use_airstrike':
        bias += profile.carrier * 0.8 + profile.scouting * 0.12;
        break;
      case 'load_assault_ship':
      case 'amphibious_landing':
        bias += profile.heavyFleet * 0.2 + profile.aggression * 0.2 + profile.missile * 0.12;
        break;
      default:
        break;
    }

    return clampSelfPlayBias(bias);
  }

  _chooseAgentAction(agent, stateKey) {
    if (!this.qTable) {
      return Math.floor(Math.random() * ACTION_COUNT);
    }
    const qValues = this.qTable.ensureActionRow(stateKey);
    const profile = agent?.selfPlayProfile;
    const epsilonBase = Number.isFinite(this.qTable.epsilon) ? this.qTable.epsilon : 0.1;
    const minEpsilon = Number.isFinite(this.qTable.minEpsilon) ? this.qTable.minEpsilon : 0.05;
    const epsilonScale = profile?.epsilonScale || 1;
    const epsilon = Math.max(minEpsilon, Math.min(0.6, epsilonBase * epsilonScale));
    const maxAbsQ = qValues.reduce((maxValue, value) => Math.max(maxValue, Math.abs(Number(value) || 0)), 0);
    const biasMagnitude = Math.min(6, Math.max(0.75, maxAbsQ * 0.04)) * (profile?.biasScale || 1);

    if (Math.random() < epsilon) {
      const weights = ACTIONS.map((action) => 1 + Math.max(0, this._getActionProfileBias(agent, action) * 4));
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      let roll = Math.random() * totalWeight;
      for (let i = 0; i < weights.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return i;
      }
      return ACTION_COUNT - 1;
    }

    let bestAction = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < ACTION_COUNT; i++) {
      const score = (qValues[i] || 0) + (this._getActionProfileBias(agent, ACTIONS[i]) * biasMagnitude);
      if (score > bestScore) {
        bestScore = score;
        bestAction = i;
      }
    }
    return bestAction;
  }

  /**
   * Convert agent state to Q-table state key (reuses TrainingSession's key format).
   */
  _stateToKey(s) {
    return encodeAbstractState(summarizeSimulationState(s));
  }

  /**
   * Apply combat between two agents. Stronger side wins the exchange.
   */
  _resolveCombat(attacker, defender, options = {}) {
    if (attacker.combatPower <= 0 || defender.combatPower <= 0) return;

    const atkRange = attacker.maxAttackRange >= 3 ? 1.3 : (attacker.maxAttackRange >= 2 ? 1.1 : 1.0);
    const defRange = defender.maxAttackRange >= 3 ? 1.3 : (defender.maxAttackRange >= 2 ? 1.1 : 1.0);
    const atkVision = attacker.fogLevel === 0 ? 0.7 : (attacker.fogLevel === 1 ? 0.9 : 1.0);
    const defVision = defender.fogLevel === 0 ? 0.7 : (defender.fogLevel === 1 ? 0.9 : 1.0);

    // Attacker's effective power
    let atkPower = attacker.combatPower + attacker.deployedLauncherCount * 80;
    atkPower *= atkRange * atkVision;
    if (attacker.stealthActive) atkPower *= 1.2; // Ambush bonus
    if (attacker.engineOverdriveActive) atkPower *= 0.9; // Speed over firepower

    // Defender's effective power
    const defenderDefensePressure = getStrategicDefenseScore(defender);
    let defPower = defender.combatPower + defender.deployedLauncherCount * 80 + defenderDefensePressure * 38;
    defPower *= defRange * defVision;
    const attackerPowerBefore = attacker.combatPower;
    const defenderPowerBefore = defender.combatPower;
    let structuralGainScore = 0;

    const totalPower = atkPower + defPower;
    if (totalPower <= 0) return;

    // Proportional damage exchange
    const atkDmgFactor = 0.08 + Math.random() * 0.12; // 8-20% of power dealt as damage
    const atkDmg = Math.floor(atkPower * atkDmgFactor);
    const defDmg = Math.floor(defPower * atkDmgFactor * 0.7); // Defender deals less (attacker chose the fight)

    // Apply damage to defender
    defender.combatPower = Math.max(0, defender.combatPower - atkDmg);
    defender.totalDamageTaken += atkDmg;
    attacker.totalDamageDealt += atkDmg;
    const defLost = Math.ceil(atkDmg / 150);
    const defenderLosses = this._reduceUnitCounts(defender, defLost);
    if (atkDmg > 200 && Math.random() < 0.3) {
      const destroyedBuildingType = destroyRandomCompletedBuilding(defender);
      if (destroyedBuildingType) {
        const buildingStrikeScore = getBuildingLossPenaltyScore(destroyedBuildingType);
        structuralGainScore += buildingStrikeScore;
        defender.buildingLossScore = Math.max(0, Math.floor(defender.buildingLossScore || 0))
          + buildingStrikeScore;
        attacker.structuralStrikeScore = Math.max(0, Math.floor(attacker.structuralStrikeScore || 0))
          + buildingStrikeScore;
      }
    }
    attacker.kills += defenderLosses.combatUnitsLost;
    attacker.killEventScore = Math.max(0, Math.floor(attacker.killEventScore || 0))
      + getKillRewardScoreFromSummary(defenderLosses);
    attacker.combatUnitValueDestroyed = Math.max(0, Math.floor(attacker.combatUnitValueDestroyed || 0))
      + defenderLosses.combatPowerLost;

    // Apply damage to attacker
    let actualDefDmg = defDmg;
    if (attacker.stealthActive) actualDefDmg = Math.floor(actualDefDmg * 0.4);
    if (attacker.engineOverdriveActive) actualDefDmg = Math.floor(actualDefDmg * 0.5);
    attacker.combatPower = Math.max(0, attacker.combatPower - actualDefDmg);
    attacker.totalDamageTaken += actualDefDmg;
    defender.totalDamageDealt += actualDefDmg;
    const atkLost = Math.ceil(actualDefDmg / 150);
    const attackerLosses = this._reduceUnitCounts(attacker, atkLost);
    defender.kills += attackerLosses.combatUnitsLost;
    defender.killEventScore = Math.max(0, Math.floor(defender.killEventScore || 0))
      + getKillRewardScoreFromSummary(attackerLosses);
    defender.combatUnitValueDestroyed = Math.max(0, Math.floor(defender.combatUnitValueDestroyed || 0))
      + attackerLosses.combatPowerLost;

    if (options.initiatedByAction) {
      const inflictedPower = Math.max(0, defenderPowerBefore - defender.combatPower) + Math.max(0, defenderLosses.combatPowerLost);
      const ownLossPower = Math.max(0, attackerPowerBefore - attacker.combatPower) + Math.max(0, attackerLosses.combatPowerLost);
      attacker.failedRaidPenaltyScore = Math.max(0, Math.floor(attacker.failedRaidPenaltyScore || 0))
        + Math.round(getRaidFailurePenalty({
          initiatedAttack: true,
          inflictedPower,
          ownLossPower,
          structuralGainScore,
          effectiveRatio: atkPower / Math.max(1, defPower),
          fogLevel: attacker.fogLevel,
          defensePressure: defenderDefensePressure
        }) * 10);
    }

    // Match actual defeat flow more closely: elimination requires losing all buildings.
    if (this._checkElimination(defender)) {
      attacker.enemiesEliminated++;
    }
    this._checkElimination(attacker);
  }

  _checkElimination(agent) {
    const wasAlive = agent.alive !== false;
    if (agent.buildingCount <= 0) {
      agent.alive = false;
      return wasAlive;
    }
    return false;
  }

  _reduceUnitCounts(agent, lost) {
    const lossSummary = removeRandomUnitsFromSimulation(agent, lost, { allowWorkers: false });
    agent.combatUnitLosses = Math.max(0, Math.floor(agent.combatUnitLosses || 0)) + lossSummary.combatUnitsLost;
    agent.workerLosses = Math.max(0, Math.floor(agent.workerLosses || 0)) + lossSummary.workerLosses;
    agent.combatUnitValueLost = Math.max(0, Math.floor(agent.combatUnitValueLost || 0)) + lossSummary.combatPowerLost;
    agent.lossEventScore = Math.max(0, Math.floor(agent.lossEventScore || 0)) + getLossPenaltyScoreFromSummary(lossSummary);
    return lossSummary;
  }

  /**
   * Simulate one complete self-play match. Returns per-agent rewards.
   */
  _simulateMatch() {
    this.currentMatchProfiles = this._createMatchProfiles();
    const agents = [];
    for (let i = 0; i < this.numAgents; i++) {
      agents.push(this._createAgentState(i));
    }

    // Track transitions for Q-table updates
    const transitions = []; // { agentIdx, stateKey, action, nextStateKey }

    for (let step = 0; step < this.maxStepsPerMatch; step++) {
      const aliveAgents = agents.filter(a => a.alive);
      if (aliveAgents.length <= 1) break;

      // Each alive agent picks an action
      for (const agent of aliveAgents) {
        agent.tick = step;
        const view = this._buildAgentView(agent, agents);
        const stateKey = this._stateToKey(view);
        const actionIdx = this._chooseAgentAction(agent, stateKey);

        // Apply the action using the existing simulation logic
        this._applyAction(agent, actionIdx, agents);

        // Tick cooldowns/timers
        this._tickTimers(agent);
        advanceSimulationProgress(agent, SIM_TICK_MS);
        syncSimulationState(agent);

        const nextView = this._buildAgentView(agent, agents);
        const nextKey = this._stateToKey(nextView);
        transitions.push({ agentIdx: agent.id, stateKey, action: actionIdx, nextKey });
      }

      // --- Combat phase: battle royale style, escalating engagement ---
      // Combat probability increases over time: early=30%, mid=60%, late=90%+
      const combatChance = Math.min(0.95, 0.30 + step * 0.004);
      for (let i = 0; i < aliveAgents.length; i++) {
        for (let j = i + 1; j < aliveAgents.length; j++) {
          if (!aliveAgents[i].alive || !aliveAgents[j].alive) continue;
          if (Math.random() < combatChance) {
            const [atk, def] = aliveAgents[i].combatPower >= aliveAgents[j].combatPower
              ? [aliveAgents[i], aliveAgents[j]]
              : [aliveAgents[j], aliveAgents[i]];
            this._resolveCombat(atk, def);
          }
        }
      }

      // --- Red zone: escalating pressure (battle royale shrinking circle) ---
      // Phase 1 (step<100): mild, Phase 2 (100-250): moderate, Phase 3 (250+): deadly
      const rzChance = step < 100 ? 0.02 : (step < 250 ? 0.08 : 0.25);
      const rzDmgMul = step < 100 ? 1.0 : (step < 250 ? 2.0 : 5.0);
      if (Math.random() < rzChance) {
        for (const agent of aliveAgents) {
          if (!agent.alive) continue;
          const hitChance = step < 100 ? 0.3 : (step < 250 ? 0.5 : 0.8);
          if (Math.random() < hitChance) {
            const baseDmg = 100 + Math.floor(Math.random() * 200);
            const dmg = Math.floor(baseDmg * rzDmgMul);
            agent.combatPower = Math.max(0, agent.combatPower - dmg);
            const lost = Math.ceil(dmg / 120);
            this._reduceUnitCounts(agent, lost);
            // Building destruction increases over time
            const bldgDestroyChance = step < 100 ? 0.15 : (step < 250 ? 0.3 : 0.5);
            if (agent.buildingCount > 0 && Math.random() < bldgDestroyChance) {
              const destroyedBuildingType = destroyRandomCompletedBuilding(agent);
              if (destroyedBuildingType) {
                agent.buildingLossScore = Math.max(0, Math.floor(agent.buildingLossScore || 0))
                  + getBuildingLossPenaltyScore(destroyedBuildingType);
              }
            }
            this._checkElimination(agent);
          }
        }
      }

      // Passive income for all alive agents
      for (const agent of aliveAgents) {
        if (agent.alive) {
          agent.resources += getSimulationPassiveIncome(agent);
          // Aircraft production
          if (agent.carrierCount > 0 && agent.aircraftCount < 10 && step % 3 === 0) {
            agent.aircraftCount = Math.min(10, agent.aircraftCount + agent.carrierCount);
          }
        }
      }

      // --- Phase 4 (step 400+): Sudden death. Massive unavoidable damage every tick ---
      if (step >= 400) {
        for (const agent of agents.filter(a => a.alive)) {
          const sdDmg = 300 + (step - 400) * 50;
          agent.combatPower = Math.max(0, agent.combatPower - sdDmg);
          const lost = Math.ceil(sdDmg / 80);
          agent.unitCount = Math.max(0, agent.unitCount - lost);
          this._reduceUnitCounts(agent, lost);
          if (Math.random() < 0.6) agent.buildingCount = Math.max(0, agent.buildingCount - 1);
          this._checkElimination(agent);
        }
      }
    }

    // --- Force exactly 1 survivor: if multiple still alive, weakest die ---
    const finalAlive = agents.filter(a => a.alive);
    if (finalAlive.length > 1) {
      finalAlive.sort((a, b) => this._calculateScore(b) - this._calculateScore(a));
      for (let i = 1; i < finalAlive.length; i++) {
        finalAlive[i].alive = false;
        finalAlive[0].enemiesEliminated++;
      }
    }

    // === Score & Reward calculation ===
    const scores = agents.map(a => this._calculateScore(a));
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const scoreRange = Math.max(1, maxScore - minScore);

    // Rank agents by score
    const ranked = agents.map((a, i) => ({ idx: i, score: scores[i], alive: a.alive }))
      .sort((a, b) => b.score - a.score);

    // Assign rewards based on relative performance (margin of victory matters)
    const agentRewards = new Array(this.numAgents).fill(0);
    for (let rank = 0; rank < ranked.length; rank++) {
      const { idx, score } = ranked[rank];
      // Normalized score: how dominant was this agent? (0 to 1)
      const dominance = (score - minScore) / scoreRange;

      if (rank === 0) {
        // Winner: base reward + bonus for margin of victory
        const marginOverSecond = ranked.length > 1
          ? (score - ranked[1].score) / Math.max(1, scoreRange) : 1;
        agentRewards[idx] = 50 + 50 * marginOverSecond + 20 * dominance;
        if (agents[idx].alive) agentRewards[idx] += 20; // Survival bonus
      } else if (rank === ranked.length - 1) {
        // Last place: heavy penalty scaled by margin
        const marginFromFirst = (ranked[0].score - score) / Math.max(1, scoreRange);
        agentRewards[idx] = -30 - 40 * marginFromFirst;
        if (!agents[idx].alive) agentRewards[idx] -= 20;
      } else {
        // Middle ranks: scaled between +10 and -10 based on relative position
        const relativePos = 1 - (rank / (ranked.length - 1)); // 1=top, 0=bottom
        agentRewards[idx] = (relativePos - 0.5) * 40 + dominance * 10;
      }
    }

    const recordedAgents = [];
    for (let i = 0; i < this.numAgents; i++) {
      if (scores[i] >= this.minRecordScore && agentRewards[i] > this.minAgentReward) {
        recordedAgents.push(i);
      }
    }
    const recordedAgentSet = new Set(recordedAgents);

    let acceptedTransitionCount = 0;
    // Update Q-table only for agents that cleared the record threshold
    for (const t of transitions) {
      if (!recordedAgentSet.has(t.agentIdx)) continue;
      const reward = agentRewards[t.agentIdx] / this.maxStepsPerMatch; // Distribute over steps
      this.qTable.update(t.stateKey, t.action, reward, t.nextKey);
      acceptedTransitionCount++;
    }

    const failureReplayAgents = [];
    let failureReplayTransitionCount = 0;
    if (this.learnFromFailures) {
      for (let i = 0; i < this.numAgents; i++) {
        if (recordedAgentSet.has(i) || agentRewards[i] > this.failureRewardThreshold) continue;
        const agentTransitions = transitions.filter(t => t.agentIdx === i);
        if (agentTransitions.length <= 0) continue;
        const replayTransitions = agentTransitions.slice(-Math.min(this.failureReplayLimit, agentTransitions.length));
        const basePenalty = Math.min(
          -0.05,
          (agentRewards[i] / Math.max(1, replayTransitions.length)) * this.failurePenaltyScale
        );
        for (let idx = 0; idx < replayTransitions.length; idx++) {
          const transition = replayTransitions[idx];
          const recencyWeight = replayTransitions.length <= 1
            ? 1
            : 0.75 + (idx / (replayTransitions.length - 1)) * 0.5;
          this.qTable.update(transition.stateKey, transition.action, basePenalty * recencyWeight, transition.nextKey);
          failureReplayTransitionCount++;
        }
        failureReplayAgents.push(i);
      }
    }

    // Update ELO ratings
    this._updateElo(ranked);

    // Record result
    const winner = ranked[0];
    this.matchResults.push({
      winner: winner.idx,
      scores,
      margin: ranked.length > 1 ? winner.score - ranked[1].score : 0,
      aliveCount: agents.filter(a => a.alive).length,
      profiles: agents.map(agent => agent.selfPlayProfileId || 'balanced'),
      recorded: recordedAgents.length > 0,
      recordedAgents
    });

    return {
      winnerReward: agentRewards[ranked[0].idx],
      winnerScore: scores[ranked[0].idx],
      recorded: recordedAgents.length > 0,
      recordedAgentCount: recordedAgents.length,
      transitionCount: transitions.length,
      acceptedTransitionCount,
      failureReplayAgentCount: failureReplayAgents.length,
      failureReplayTransitionCount,
      discardedTransitionCount: Math.max(0, transitions.length - acceptedTransitionCount - failureReplayTransitionCount)
    };
  }

  _calculateScore(agent) {
    let score = 0;
    const workerLosses = Math.max(0, Math.floor(agent.workerLosses || 0));
    const combatUnitValueLost = Math.max(0, Math.floor(agent.combatUnitValueLost || 0));
    const combatUnitValueDestroyed = Math.max(0, Math.floor(agent.combatUnitValueDestroyed || 0));
    const killEventScore = Math.max(0, Math.floor(agent.killEventScore || 0));
    const lossEventScore = Math.max(0, Math.floor(agent.lossEventScore || 0));
    const failedRaidPenaltyScore = Math.max(0, Math.floor(agent.failedRaidPenaltyScore || 0));
    const structuralStrikeScore = Math.max(0, Math.floor(agent.structuralStrikeScore || 0));
    const buildingLossScore = Math.max(0, Math.floor(agent.buildingLossScore || 0));
    const techScore = getTechProgressScore(agent);
    const energyIncome = getSimulationEnergyIncomePerSecond(agent);
    const energySpend = getSimulationEnergySpendPerSecond(agent);
    const buildingRetentionScore = getBuildingRetentionScore(agent);
    const defenseSetupScore = getStrategicDefenseScore(agent);
    const fleetDiversity = getFleetDiversityScore(agent);
    const fleetDominance = getFleetDominanceRatio(agent);
    const lightFleetRatio = getLightFleetRatio(agent);
    const population = getPopulationUsage(agent);
    const maxPopulation = getPopulationCapacity(agent);
    const combatPopulation = getCombatPopulation(agent);
    const populationUtilization = getPopulationUtilization(agent);
    score += agent.combatPower * 0.35;
    score += agent.buildingCount * 35;
    score += buildingRetentionScore * 5;
    score += defenseSetupScore * 14;
    score += techScore * 22;
    score += energyIncome * 10;
    score += getEconomyTempoScore({ energyIncomePerSec: energyIncome, energySpendPerSec: energySpend }) * 8;
    score += population * 2.8;
    score += maxPopulation * 1.4;
    score += combatPopulation * 4.2;
    score += Math.max(0, populationUtilization - 0.35) * 180;
    score += fleetDiversity * 18;
    score -= Math.max(0, fleetDominance - 0.7) * 160;
    if (techScore >= 8 && getCompletedBuildingCount(agent, 'naval_academy') > 0 && energyIncome >= 18) {
      score -= Math.max(0, lightFleetRatio - 0.52) * 240;
    }
    score += killEventScore;
    score += structuralStrikeScore;
    score -= lossEventScore;
    score -= failedRaidPenaltyScore;
    score -= buildingLossScore;
    score -= workerLosses * 8;
    score += combatUnitValueDestroyed * 0.05;
    score -= combatUnitValueLost * 0.08;
    score += agent.totalDamageDealt * 0.04;
    score -= agent.totalDamageTaken * 0.08;
    score += agent.enemiesEliminated * 120;
    if (agent.alive) score += 200;
    score += Math.min(agent.resources, 3000) * 0.05;
    return Math.round(score);
  }

  _updateElo(ranked) {
    const K = 32;
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        const a = ranked[i].idx, b = ranked[j].idx;
        const ea = 1 / (1 + Math.pow(10, (this.eloRatings[b] - this.eloRatings[a]) / 400));
        const eb = 1 - ea;
        // i beat j (higher rank = better)
        this.eloRatings[a] += K * (1 - ea);
        this.eloRatings[b] += K * (0 - eb);
      }
    }
  }

  /**
   * Apply an action to an agent. Simplified version of _simulateStep.
   */
  _applyAction(agent, actionIdx, allAgents) {
    const action = ACTIONS[actionIdx];

    // Recalculate range/vision
    agent.maxAttackRange = 0;
    agent.totalVision = 0;
    const types = [
      ['frigate', agent.frigateCount], ['destroyer', agent.destroyerCount],
      ['cruiser', agent.cruiserCount], ['battleship', agent.battleshipCount], ['carrier', agent.carrierCount],
      ['submarine', agent.submarineCount], ['assaultship', agent.assaultshipCount]
    ];
    for (const [type, count] of types) {
      if (count > 0) {
        agent.maxAttackRange = Math.max(agent.maxAttackRange, UNIT_RANGE_TIER[type] || 0);
        agent.totalVision += count * (UNIT_VISION_TIER[type] || 0);
      }
    }
    if (agent.deployedLauncherCount > 0) {
      agent.maxAttackRange = Math.max(agent.maxAttackRange, 3);
      agent.totalVision += agent.deployedLauncherCount;
    }
    if (agent.totalVision >= 10) agent.fogLevel = 2;
    else if (agent.totalVision >= 4) agent.fogLevel = 1;
    else agent.fogLevel = 0;

    syncSimulationState(agent);

    // Find a random alive enemy for targeted attacks
    const enemies = allAgents.filter(a => a.id !== agent.id && a.alive);
    const targetEnemy = enemies.length > 0 ? enemies[Math.floor(Math.random() * enemies.length)] : null;
    const slbmTargetEnemy = pickBestSelfPlaySlbmTarget(enemies) || targetEnemy;

    switch (action) {
      case 'build_power_plant':
        enqueueSimulationBuilding(agent, 'power_plant');
        break;
      case 'build_shipyard':
        enqueueSimulationBuilding(agent, 'shipyard');
        break;
      case 'build_naval_academy':
        enqueueSimulationBuilding(agent, 'naval_academy');
        break;
      case 'build_missile_silo':
        enqueueSimulationBuilding(agent, 'missile_silo');
        break;
      case 'build_defense_tower':
        enqueueSimulationBuilding(agent, 'defense_tower');
        break;
      case 'build_carbase':
        enqueueSimulationBuilding(agent, 'carbase');
        break;
      case 'produce_worker':
        enqueueSimulationProduction(agent, 'worker');
        break;
      case 'produce_frigate':
        enqueueSimulationProduction(agent, 'frigate');
        break;
      case 'produce_destroyer':
        enqueueSimulationProduction(agent, 'destroyer');
        break;
      case 'produce_cruiser':
        enqueueSimulationProduction(agent, 'cruiser');
        break;
      case 'produce_battleship':
        enqueueSimulationProduction(agent, 'battleship');
        break;
      case 'produce_carrier':
        enqueueSimulationProduction(agent, 'carrier');
        break;
      case 'produce_submarine':
        enqueueSimulationProduction(agent, 'submarine');
        break;
      case 'produce_assaultship':
        enqueueSimulationProduction(agent, 'assaultship');
        break;
      case 'produce_missile_launcher':
        enqueueSimulationProduction(agent, 'missile_launcher');
        break;
      case 'produce_slbm':
        enqueueSimulationProduction(agent, 'slbm');
        break;
      case 'attack_nearest_enemy':
      case 'attack_strongest_enemy':
        if (targetEnemy && agent.combatPower > 0) {
          this._resolveCombat(agent, targetEnemy, { initiatedByAction: true });
        }
        break;
      case 'defend_base':
        agent.combatPower += 20;
        break;
      case 'scout':
        if (agent.fogLevel < 2) agent.fogLevel = Math.min(2, agent.fogLevel + 1);
        break;
      case 'load_submarine_slbm': {
        const free = Math.max(0, (agent.submarineCount * SUBMARINE_SLBM_CAPACITY) - agent.loadedSlbmCount);
        if (agent.submarineCount > 0 && agent.storedSlbmCount > 0 && free > 0) {
          const load = Math.min(agent.submarineCount, agent.storedSlbmCount, free);
          agent.storedSlbmCount -= load;
          agent.loadedSlbmCount += load;
        }
        break;
      }
      case 'use_slbm':
        if (slbmTargetEnemy && agent.submarineCount > 0 && agent.loadedSlbmCount > 0) {
          agent.loadedSlbmCount--;
          agent.combatPower = Math.max(0, agent.combatPower - COMBAT_POWER_MAP.slbm);
          const mul = agent.fogLevel >= 1 ? 1.0 : 0.65;
          const targetStrikeScore = getSelfPlaySlbmTargetScore(slbmTargetEnemy);
          const fortificationBonus = Math.min(0.45, Math.max(0, targetStrikeScore) / 1400);
          const densityBonus = Math.min(1.72, 1 + (Math.max(0, slbmTargetEnemy.buildingCount - 1) * 0.08) + Math.min(0.25, slbmTargetEnemy.combatPower / 1800) + fortificationBonus);
          const dmg = Math.floor((220 + Math.random() * 260) * mul * densityBonus);
          slbmTargetEnemy.combatPower = Math.max(0, slbmTargetEnemy.combatPower - dmg);
          slbmTargetEnemy.totalDamageTaken += dmg;
          agent.totalDamageDealt += dmg;
          let destroyedBuildings = 0;
          const primaryBuildingHitChance = slbmTargetEnemy.buildingCount >= 1
            ? Math.min(0.92, (agent.fogLevel >= 1 ? 0.7 : 0.35) + fortificationBonus * 0.34)
            : 0;
          const secondaryBuildingHitChance = slbmTargetEnemy.buildingCount >= 4
            ? Math.min(0.7, (agent.fogLevel >= 1 ? 0.4 : 0.18) + fortificationBonus * 0.3)
            : 0;
          if (Math.random() < primaryBuildingHitChance) {
            const destroyedBuildingType = destroyRandomCompletedBuilding(slbmTargetEnemy);
            if (destroyedBuildingType) {
              destroyedBuildings++;
              const buildingStrikeScore = getBuildingLossPenaltyScore(destroyedBuildingType);
              slbmTargetEnemy.buildingLossScore = Math.max(0, Math.floor(slbmTargetEnemy.buildingLossScore || 0))
                + buildingStrikeScore;
              agent.structuralStrikeScore = Math.max(0, Math.floor(agent.structuralStrikeScore || 0))
                + buildingStrikeScore;
            }
          }
          if (Math.random() < secondaryBuildingHitChance) {
            const destroyedBuildingType = destroyRandomCompletedBuilding(slbmTargetEnemy);
            if (destroyedBuildingType) {
              destroyedBuildings++;
              const buildingStrikeScore = getBuildingLossPenaltyScore(destroyedBuildingType);
              slbmTargetEnemy.buildingLossScore = Math.max(0, Math.floor(slbmTargetEnemy.buildingLossScore || 0))
                + buildingStrikeScore;
              agent.structuralStrikeScore = Math.max(0, Math.floor(agent.structuralStrikeScore || 0))
                + buildingStrikeScore;
            }
          }
          agent.structuralStrikeScore = Math.max(0, Math.floor(agent.structuralStrikeScore || 0))
            + Math.round(Math.min(28, fortificationBonus * 42));
          if (destroyedBuildings > 0 && this._checkElimination(slbmTargetEnemy)) {
            agent.enemiesEliminated++;
          }
        }
        break;
      case 'use_airstrike':
        if (targetEnemy && agent.carrierCount > 0 && agent.aircraftCount >= 10) {
          agent.aircraftCount = 0;
          const dmg = 720;
          targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
          targetEnemy.totalDamageTaken += dmg;
          agent.totalDamageDealt += dmg;
          if (Math.random() < 0.4) {
            const destroyedBuildingType = destroyRandomCompletedBuilding(targetEnemy);
            if (destroyedBuildingType) {
              targetEnemy.buildingLossScore = Math.max(0, Math.floor(targetEnemy.buildingLossScore || 0))
                + getBuildingLossPenaltyScore(destroyedBuildingType);
            }
            if (this._checkElimination(targetEnemy)) agent.enemiesEliminated++;
          }
        }
        break;
      case 'activate_aegis':
        if (agent.combatPower >= 200) agent.combatPower += 30;
        break;
      case 'lay_mines':
        if (agent.destroyerCount > 0) agent.combatPower += 10;
        break;
      case 'lure_tactic':
        if (targetEnemy && agent.frigateCount > 0 && agent.combatPower >= 300) {
          if (Math.random() < 0.4) {
            const dmg = 100;
            targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
            targetEnemy.totalDamageTaken += dmg;
            agent.totalDamageDealt += dmg;
          }
        }
        break;
      case 'expand':
        enqueueSimulationBuilding(agent, agent.hasShipyard ? 'power_plant' : 'shipyard');
        break;
      case 'save_resources':
        break;
      case 'skill_aimed_shot':
        if (targetEnemy && agent.battleshipCount > 0 && agent.aimedShotReady && agent.aimedShotCooldown <= 0) {
          agent.aimedShotReady = false;
          agent.aimedShotCooldown = 5;
          const dmg = Math.floor(agent.battleshipCount * 200 * 0.5);
          targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
          targetEnemy.totalDamageTaken += dmg;
          agent.totalDamageDealt += dmg;
        }
        break;
      case 'skill_combat_stance':
        if (agent.battleshipCount > 0) {
          if (!agent.combatStanceActive) { agent.combatStanceActive = true; agent.combatStanceStacks = 1; }
          else agent.combatStanceStacks = Math.min(5, agent.combatStanceStacks + 1);
          agent.combatPower = Math.max(0, agent.combatPower - agent.battleshipCount * 20 * agent.combatStanceStacks * 0.05);
        }
        break;
      case 'skill_engine_overdrive':
        if (agent.frigateCount > 0) {
          agent.engineOverdriveActive = true;
          agent.combatPower = Math.max(0, agent.combatPower - agent.frigateCount * 3);
        }
        break;
      case 'skill_search':
        if (agent.destroyerCount > 0 && agent.searchCooldown <= 0) {
          agent.searchCooldown = 5;
          agent.fogLevel = 2;
        }
        break;
      case 'skill_stealth':
        if (agent.submarineCount > 0 && !agent.stealthActive && agent.stealthCooldown <= 0) {
          agent.stealthActive = true;
          agent.stealthTimer = 5;
          agent.stealthCooldown = 10;
        }
        break;
      case 'deploy_launchers':
        if (agent.launcherCount > 0) {
          agent.deployedLauncherCount += agent.launcherCount;
          agent.launcherCount = 0;
        }
        break;
      case 'undeploy_launchers':
        if (agent.deployedLauncherCount > 0) {
          agent.launcherCount += agent.deployedLauncherCount;
          agent.deployedLauncherCount = 0;
        }
        break;
      case 'load_assault_ship':
        if (agent.assaultshipCount > 0 && agent.launcherCount > 0 && agent.loadedAssaultShips < agent.assaultshipCount) {
          const load = Math.min(agent.launcherCount, 10);
          agent.launcherCount -= load;
          agent.unitCount -= load;
          agent.combatPower -= load * 100;
          agent.loadedAssaultShips++;
        }
        break;
      case 'amphibious_landing':
        if (targetEnemy && agent.loadedAssaultShips > 0) {
          const unload = Math.min(10, 3 + Math.floor(Math.random() * 8));
          agent.deployedLauncherCount += unload;
          agent.unitCount += unload;
          agent.combatPower += unload * 100;
          agent.loadedAssaultShips--;
          agent.hasLandAccess = true;
          // Deployed launchers deal damage from landing
          const dps = unload * 80;
          const dmg = Math.floor(dps * 0.3);
          targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
          targetEnemy.totalDamageTaken += dmg;
          agent.totalDamageDealt += dmg;
        }
        break;
    }
    syncSimulationState(agent);
  }

  _tickTimers(agent) {
    if (agent.aimedShotCooldown > 0) { agent.aimedShotCooldown--; if (agent.aimedShotCooldown <= 0) agent.aimedShotReady = true; }
    if (agent.searchCooldown > 0) agent.searchCooldown--;
    if (agent.stealthTimer > 0) { agent.stealthTimer--; if (agent.stealthTimer <= 0) agent.stealthActive = false; }
    if (agent.stealthCooldown > 0) agent.stealthCooldown--;
    if (agent.engineOverdriveActive && agent.frigateCount > 0) {
      agent.combatPower = Math.max(0, agent.combatPower - agent.frigateCount * 2);
      if (agent.combatPower <= 0 && agent.frigateCount > 0) {
        removeRandomUnitsFromSimulation(agent, 1, { allowWorkers: false });
        agent.engineOverdriveActive = agent.frigateCount > 0;
      }
    }
    syncSimulationState(agent);
  }

  getStats() {
    const recent = this.matchResults.slice(-50);
    const lastMatch = this.matchResults.length > 0 ? this.matchResults[this.matchResults.length - 1] : null;
    const avgMargin = recent.length > 0
      ? Math.round(recent.reduce((s, m) => s + m.margin, 0) / recent.length)
      : 0;
    const avgAlive = recent.length > 0
      ? (recent.reduce((s, m) => s + m.aliveCount, 0) / recent.length).toFixed(1)
      : 0;
    return {
      matches: this.matchResults.length,
      numAgents: this.numAgents,
      eloRatings: this.eloRatings.map(r => Math.round(r)),
      avgVictoryMargin: avgMargin,
      avgSurvivors: avgAlive,
      lastProfiles: lastMatch?.profiles || []
    };
  }
}

// Add self-play training to TrainingSession
TrainingSession.prototype.startSelfPlayTraining = function(matches, numAgents, stepCallback) {
  if (this.isTraining) return false;
  if (this.frozen) {
    this.trainingLog.push('[오류] 이 난이도는 고정(잠금) 상태입니다. 해제 후 학습하세요.');
    return false;
  }
  this.isTraining = true;
  this.currentTrainingMode = 'selfplay';
  this.selfPlayArena = new SelfPlayArena(this.difficulty, numAgents);
  this.selfPlayArena.qTable = this.qTable;
  this.selfPlayArena.minRecordScore = this.recordingPolicy.minScore;
  this.selfPlayArena.minAgentReward = this.recordingPolicy.minSelfPlayReward;
  this.selfPlayArena.learnFromFailures = this.recordingPolicy.learnFromFailures;
  this.selfPlayArena.failureReplayLimit = this.recordingPolicy.failureReplayLimit;
  this.selfPlayArena.failurePenaltyScale = this.recordingPolicy.failurePenaltyScale;
  this.selfPlayArena.failureRewardThreshold = this.recordingPolicy.failureRewardThreshold;
  this.selfPlayArena.maxMatches = matches || 1000;
  this.selfPlayArena.isRunning = true;
  this.maxEpisodes = matches;
  this.currentEpisode = 0;
  this.recordingStats.selfPlay = {
    attempted: 0,
    accepted: 0,
    discarded: 0,
    acceptedTransitions: 0,
    discardedTransitions: 0,
    failureReplays: 0,
    failureReplayTransitions: 0,
    lastAcceptedWinnerReward: null,
    lastAcceptedWinnerScore: null,
    lastAcceptedAgentCount: 0,
    lastDiscardedWinnerReward: null,
    lastDiscardedWinnerScore: null,
    lastDiscardedAgentCount: 0,
    lastFailureReplayAgentCount: 0
  };
  this.trainingLog = [];
  this.trainingLog.push(`[Filter] record if score >= ${this.recordingPolicy.minScore}`);
  if (this.recordingPolicy.learnFromFailures) {
    this.trainingLog.push(
      `[Replay] learn from failures <= ${this.recordingPolicy.failureRewardThreshold}, limit: ${this.recordingPolicy.failureReplayLimit}`
    );
  }
  this.trainingLog.push(`[셀프플레이 시작] ${matches} 매치, ${numAgents}명 대전`);
  console.log(`[AI-RL][${this.difficulty}] Self-play started: ${matches} matches, ${numAgents} agents`);

  this._runSelfPlayStep(stepCallback);
  return true;
};

TrainingSession.prototype._runSelfPlayStep = function(stepCallback) {
  if (!this.isTraining || this.currentEpisode >= this.maxEpisodes) {
    this.isTraining = false;
    this.currentTrainingMode = null;
    if (this.selfPlayArena) this.selfPlayArena.isRunning = false;
    this.saveWeights();
    const stats = this.selfPlayArena ? this.selfPlayArena.getStats() : {};
    this.trainingLog.push(`[셀프플레이 완료] ${this.currentEpisode} 매치, 평균 승리마진: ${stats.avgVictoryMargin || 0}`);
    console.log(`[AI-RL][${this.difficulty}] Self-play complete: ${this.currentEpisode} matches`);
    if (stepCallback) stepCallback({ done: true, episode: this.currentEpisode });
    return;
  }

  // Run one match
  const matchResult = this.selfPlayArena._simulateMatch();
  this.currentEpisode++;
  this.selfPlayArena.currentMatch = this.currentEpisode;
  this.recordingStats.selfPlay.attempted++;
  if (matchResult.recorded) {
    this.qTable.totalEpisodes++;
    this.qTable.totalReward += matchResult.winnerReward;
    this.qTable.recentRewards.push(matchResult.winnerReward);
    if (this.qTable.recentRewards.length > 100) this.qTable.recentRewards.shift();
    this._pushModeReward('selfplay', matchResult.winnerReward);
    this.recordingStats.selfPlay.accepted++;
    this.recordingStats.selfPlay.acceptedTransitions += matchResult.acceptedTransitionCount;
    this.recordingStats.selfPlay.discardedTransitions += matchResult.discardedTransitionCount;
    this.recordingStats.selfPlay.lastAcceptedWinnerReward = Math.round(matchResult.winnerReward * 10) / 10;
    this.recordingStats.selfPlay.lastAcceptedWinnerScore = matchResult.winnerScore;
    this.recordingStats.selfPlay.lastAcceptedAgentCount = matchResult.recordedAgentCount;
  } else {
    this.recordingStats.selfPlay.discarded++;
    this.recordingStats.selfPlay.discardedTransitions += matchResult.discardedTransitionCount;
    this.recordingStats.selfPlay.lastDiscardedWinnerReward = Math.round(matchResult.winnerReward * 10) / 10;
    this.recordingStats.selfPlay.lastDiscardedWinnerScore = matchResult.winnerScore;
    this.recordingStats.selfPlay.lastDiscardedAgentCount = matchResult.recordedAgentCount;
  }
  if (matchResult.failureReplayTransitionCount > 0) {
    this.recordingStats.selfPlay.failureReplays++;
    this.recordingStats.selfPlay.failureReplayTransitions += matchResult.failureReplayTransitionCount;
    this.recordingStats.selfPlay.lastFailureReplayAgentCount = matchResult.failureReplayAgentCount;
  }
  this.qTable.decayEpsilon();

  // Log every 50 matches
  if (this.currentEpisode % 50 === 0) {
    const qStats = this.qTable.getStats();
    const arenaStats = this.selfPlayArena.getStats();
    const recent = this.selfPlayArena.matchResults.slice(-50);
    const avgMargin = recent.length > 0 ? Math.round(recent.reduce((s, m) => s + m.margin, 0) / recent.length) : 0;
    const msg =
      `[Match ${this.currentEpisode}/${this.maxEpisodes}] margin: ${avgMargin}, ` +
      `recorded: ${matchResult.recorded ? 'yes' : 'no'}, ` +
      `kept: ${this.recordingStats.selfPlay.accepted}/${this.recordingStats.selfPlay.attempted}, ` +
      `mistakes: ${this.recordingStats.selfPlay.failureReplays}, ` +
      `cutoff: ${this.recordingPolicy.minScore}, eps: ${qStats.epsilon}, states: ${qStats.states}, ` +
      `ELO: [${arenaStats.eloRatings.join(',')}]`;
    this.trainingLog.push(msg);
    console.log(`[AI-RL][${this.difficulty}] ${msg}`);
  }

  // Auto-save
  const now = Date.now();
  if (now - this.lastSaveTime > this.autoSaveInterval) {
    this.saveWeights();
    this.lastSaveTime = now;
  }

  setImmediate(() => this._runSelfPlayStep(stepCallback));
};

TrainingSession.prototype.getSelfPlayStatus = function() {
  if (!this.selfPlayArena) return null;
  return this.selfPlayArena.getStats();
};

// ========== EXPORTS ==========

module.exports = {
  TrainingSession,
  SelfPlayArena,
  QTable,
  ACTIONS,
  DIFFICULTY_PRESETS,
  ensureExternalWeightsCached,
  encodeState,
  calculateReward,
  takeSnapshot,
  discretize,
  COMBAT_POWER_MAP
};
