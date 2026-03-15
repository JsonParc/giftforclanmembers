function createAiConfig(aiTraining) {
  return Object.freeze({
    count: 2,
    updateInterval: 1000,
    respawnDelayMs: 10000,
    scoutInterval: 8000,
    buildingPriority: ['power_plant', 'shipyard', 'naval_academy', 'missile_silo', 'defense_tower'],
    unitPriority: ['worker', 'cruiser', 'destroyer', 'submarine', 'carrier', 'battleship', 'assaultship', 'frigate'],
    attackerTrackingDuration: 8000,
    counterattackThreshold: 1,
    priorityTargetDuration: 90000,
    maxPriorityTargets: 20,
    combatPower: (aiTraining && aiTraining.COMBAT_POWER_MAP) || {
      frigate: 38,
      destroyer: 95,
      cruiser: 260,
      battleship: 780,
      carrier: 560,
      submarine: 420,
      assaultship: 260,
      missile_launcher: 520
    },
    expansionBuildingThreshold: 8
  });
}

const AI_STRATEGY_PROFILES = Object.freeze({
  balanced: Object.freeze({
    label: 'balanced',
    desiredWorkers: 5,
    earlyPowerPlants: 4,
    academyUnlockUnits: 2,
    siloUnlockUnits: 8,
    carbaseUnlockUnits: 10,
    shipyardWeights: Object.freeze({ frigate: 0.55, destroyer: 0.95, cruiser: 1.45 }),
    academyWeights: Object.freeze({ submarine: 0.95, carrier: 1.05, battleship: 1.15, assaultship: 0.72 }),
    siloBias: 0.6,
    carbaseBias: 0.3
  }),
  wolfpack: Object.freeze({
    label: 'wolfpack',
    desiredWorkers: 4,
    earlyPowerPlants: 4,
    academyUnlockUnits: 3,
    siloUnlockUnits: 8,
    carbaseUnlockUnits: 11,
    shipyardWeights: Object.freeze({ frigate: 0.45, destroyer: 0.95, cruiser: 1.05 }),
    academyWeights: Object.freeze({ submarine: 1.7, carrier: 0.75, battleship: 0.65, assaultship: 0.7 }),
    siloBias: 0.9,
    carbaseBias: 0.2
  }),
  carrier_strike: Object.freeze({
    label: 'carrier_strike',
    desiredWorkers: 5,
    earlyPowerPlants: 5,
    academyUnlockUnits: 2,
    siloUnlockUnits: 10,
    carbaseUnlockUnits: 13,
    shipyardWeights: Object.freeze({ frigate: 0.28, destroyer: 0.9, cruiser: 1.35 }),
    academyWeights: Object.freeze({ submarine: 0.7, carrier: 2.0, battleship: 1.05, assaultship: 0.38 }),
    siloBias: 0.2,
    carbaseBias: 0.15
  }),
  siege: Object.freeze({
    label: 'siege',
    desiredWorkers: 5,
    earlyPowerPlants: 5,
    academyUnlockUnits: 3,
    siloUnlockUnits: 7,
    carbaseUnlockUnits: 7,
    shipyardWeights: Object.freeze({ frigate: 0.2, destroyer: 0.75, cruiser: 1.8 }),
    academyWeights: Object.freeze({ submarine: 0.45, carrier: 0.7, battleship: 1.9, assaultship: 0.25 }),
    siloBias: 1.5,
    carbaseBias: 1.3
  }),
  raider: Object.freeze({
    label: 'raider',
    desiredWorkers: 4,
    earlyPowerPlants: 4,
    academyUnlockUnits: 3,
    siloUnlockUnits: 11,
    carbaseUnlockUnits: 10,
    shipyardWeights: Object.freeze({ frigate: 0.85, destroyer: 1.0, cruiser: 1.1 }),
    academyWeights: Object.freeze({ submarine: 0.9, carrier: 0.4, battleship: 0.8, assaultship: 1.45 }),
    siloBias: 0.15,
    carbaseBias: 0.45
  })
});

const AI_STRATEGY_IDS = Object.freeze(Object.keys(AI_STRATEGY_PROFILES));

function getAIUserId(aiIndex) {
  return -1000 - aiIndex;
}

function getAIIndexFromUserId(aiUserId) {
  if (aiUserId > -1000) return null;
  return -1000 - aiUserId;
}

function getAIName(aiIndex) {
  return `AI_Commander_${aiIndex + 1}`;
}

function createAiStrategyHelper(getGameState) {
  function chooseLeastUsedAIStrategyId() {
    const gameState = getGameState();
    const usage = Object.fromEntries(AI_STRATEGY_IDS.map((id) => [id, 0]));
    gameState.players.forEach((player) => {
      if (!player?.isAI || !player.aiStrategyId || usage[player.aiStrategyId] === undefined) return;
      usage[player.aiStrategyId]++;
    });
    const minUsage = Math.min(...AI_STRATEGY_IDS.map((id) => usage[id]));
    const candidates = AI_STRATEGY_IDS.filter((id) => usage[id] === minUsage);
    return candidates[Math.floor(Math.random() * candidates.length)] || 'balanced';
  }

  function ensureAIStrategyProfile(player) {
    if (player?.aiStrategyId && AI_STRATEGY_PROFILES[player.aiStrategyId]) {
      return AI_STRATEGY_PROFILES[player.aiStrategyId];
    }
    const strategyId = chooseLeastUsedAIStrategyId();
    player.aiStrategyId = strategyId;
    player.aiStrategyAssignedAt = Date.now();
    return AI_STRATEGY_PROFILES[strategyId];
  }

  return {
    ensureAIStrategyProfile
  };
}

module.exports = {
  createAiConfig,
  AI_STRATEGY_PROFILES,
  getAIUserId,
  getAIIndexFromUserId,
  getAIName,
  createAiStrategyHelper
};
