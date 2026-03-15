function createAiTargetingHelpers({
  getGameState,
  normalizeCombatPowerBuildingType,
  advancedBuildingTypes,
  getUnitCombatPowerValue
}) {
  function getAIBuildingStrikeValue(buildingType) {
    switch (normalizeCombatPowerBuildingType(buildingType)) {
      case 'headquarters':
        return 220;
      case 'missile_silo':
        return 260;
      case 'carbase':
        return 180;
      case 'naval_academy':
        return 170;
      case 'shipyard':
        return 135;
      case 'defense_tower':
        return 120;
      case 'power_plant':
        return 95;
      default:
        return 70;
    }
  }

  function getKnownEnemyClusterContext(target, radius = 1200) {
    if (!target || target.playerId == null) return null;
    const gameState = getGameState();
    if (!gameState) return null;
    const ownerId = target.playerId;
    const radiusSq = radius * radius;
    let buildingCount = 0;
    let advancedBuildings = 0;
    let defenseTowers = 0;
    let missileSilos = 0;
    let carbases = 0;
    let launcherCount = 0;
    let unitCount = 0;
    let capitalShips = 0;
    let buildingValue = 0;
    let unitThreat = 0;
    let defenseThreat = 0;

    gameState.buildings.forEach((building) => {
      if (!building || building.userId !== ownerId || building.hp <= 0 || building.buildProgress < 100) return;
      const dx = building.x - target.x;
      const dy = building.y - target.y;
      if ((dx * dx) + (dy * dy) > radiusSq) return;
      buildingCount++;
      const normalizedType = normalizeCombatPowerBuildingType(building.type);
      buildingValue += getAIBuildingStrikeValue(normalizedType);
      if (advancedBuildingTypes.has(normalizedType)) advancedBuildings++;
      if (normalizedType === 'defense_tower') {
        defenseTowers++;
        defenseThreat += 250;
      } else if (normalizedType === 'missile_silo') {
        missileSilos++;
        defenseThreat += 140;
      } else if (normalizedType === 'carbase') {
        carbases++;
        defenseThreat += 120;
      } else if (normalizedType === 'naval_academy') {
        defenseThreat += 75;
      } else if (normalizedType === 'shipyard') {
        defenseThreat += 45;
      }
    });

    gameState.units.forEach((unit) => {
      if (!unit || unit.userId !== ownerId || unit.hp <= 0) return;
      if (unit.type === 'worker' || unit.type === 'aircraft' || unit.type === 'recon_aircraft' || unit.type === 'mine') return;
      const dx = unit.x - target.x;
      const dy = unit.y - target.y;
      if ((dx * dx) + (dy * dy) > radiusSq) return;
      unitCount++;
      const combatValue = getUnitCombatPowerValue(unit);
      unitThreat += combatValue;
      if (unit.type === 'missile_launcher') {
        launcherCount++;
        defenseThreat += 360;
        buildingValue += combatValue * 0.34;
      } else if (unit.type === 'battleship' || unit.type === 'carrier' || unit.type === 'submarine') {
        capitalShips++;
        buildingValue += combatValue * 0.22;
      } else {
        buildingValue += combatValue * 0.12;
      }
    });

    const scoutThreat = Math.max(0, Number(target.lastSeenStrength || 0)) * 30;
    const resistance = Math.max(80, (unitThreat * 0.82) + defenseThreat + scoutThreat);
    const value = Math.max(60, buildingValue + scoutThreat * 0.4);
    const density = buildingCount + (unitCount * 0.45) + (defenseTowers * 0.8) + (launcherCount * 0.9);

    return {
      target,
      ownerId,
      value,
      resistance,
      density,
      buildingCount,
      advancedBuildings,
      defenseTowers,
      missileSilos,
      carbases,
      launcherCount,
      capitalShips,
      unitCount
    };
  }

  function getSlbmTargetPriorityScore(targetContext) {
    if (!targetContext) return 0;
    const value = Math.max(0, Number(targetContext.value || 0));
    const density = Math.max(0, Number(targetContext.density || 0));
    const advancedBuildings = Math.max(0, Math.floor(targetContext.advancedBuildings || 0));
    const defenseTowers = Math.max(0, Math.floor(targetContext.defenseTowers || 0));
    const missileSilos = Math.max(0, Math.floor(targetContext.missileSilos || 0));
    const carbases = Math.max(0, Math.floor(targetContext.carbases || 0));
    const launcherCount = Math.max(0, Math.floor(targetContext.launcherCount || 0));
    const capitalShips = Math.max(0, Math.floor(targetContext.capitalShips || 0));
    const buildingCount = Math.max(0, Math.floor(targetContext.buildingCount || 0));
    const unitCount = Math.max(0, Math.floor(targetContext.unitCount || 0));
    const resistance = Math.max(0, Number(targetContext.resistance || 0));

    return (
      (value * 1.18)
      + (density * 56)
      + (advancedBuildings * 74)
      + (defenseTowers * 130)
      + (missileSilos * 150)
      + (carbases * 92)
      + (launcherCount * 118)
      + (capitalShips * 56)
      + (buildingCount * 16)
      + (unitCount * 12)
      - (resistance * 0.08)
    );
  }

  function selectBestKnownEnemyTarget(player, options = {}) {
    const mode = options.mode || 'balanced';
    const purpose = options.purpose || 'attack';
    const now = options.now || Date.now();
    const candidates = (player?.knownEnemyPositions || [])
      .map((target) => getKnownEnemyClusterContext(target))
      .filter(Boolean);
    if (candidates.length <= 0) return null;

    candidates.sort((a, b) => {
      const aAge = Math.max(0, now - (a.target.discoveredAt || now));
      const bAge = Math.max(0, now - (b.target.discoveredAt || now));
      const aRecency = Math.max(0, 1 - (aAge / 120000));
      const bRecency = Math.max(0, 1 - (bAge / 120000));
      const aDistance = Math.hypot((a.target.x || 0) - (player.baseX || 0), (a.target.y || 0) - (player.baseY || 0));
      const bDistance = Math.hypot((b.target.x || 0) - (player.baseX || 0), (b.target.y || 0) - (player.baseY || 0));

      let aScore;
      let bScore;
      if (purpose === 'slbm') {
        aScore = getSlbmTargetPriorityScore(a) + (aRecency * 36);
        bScore = getSlbmTargetPriorityScore(b) + (bRecency * 36);
      } else {
        aScore = a.value - (a.resistance * 0.58) + (aRecency * 32);
        bScore = b.value - (b.resistance * 0.58) + (bRecency * 32);
        if (mode === 'nearest') {
          aScore += Math.max(0, 2600 - aDistance) / 320;
          bScore += Math.max(0, 2600 - bDistance) / 320;
        } else if (mode === 'strongest') {
          aScore += (a.capitalShips * 28) + (a.launcherCount * 18);
          bScore += (b.capitalShips * 28) + (b.launcherCount * 18);
        }
      }
      return bScore - aScore;
    });

    return candidates[0];
  }

  function isWorthwhileAIAttack(currentCombatPower, targetContext, options = {}) {
    if (!targetContext) return currentCombatPower >= 320;
    const counterattack = !!options.counterattack;
    const fortificationPressure = (targetContext.defenseTowers * 0.08)
      + (targetContext.launcherCount * 0.1)
      + (targetContext.capitalShips * 0.035)
      + (targetContext.missileSilos * 0.03);
    const requiredRatio = counterattack
      ? Math.min(1.18, 0.92 + (fortificationPressure * 0.22))
      : Math.min(1.38, 1.12 + fortificationPressure);
    const valueOffset = Math.min(
      counterattack ? 120 : 150,
      targetContext.value * (counterattack ? 0.13 : 0.11)
    );
    const fortificationFloor = (targetContext.defenseTowers * 70)
      + (targetContext.launcherCount * 90)
      + (targetContext.capitalShips * 35);
    const minimumPower = Math.max(counterattack ? 220 : 320, (targetContext.resistance * requiredRatio) - valueOffset);
    return currentCombatPower >= (minimumPower + fortificationFloor);
  }

  return {
    getAIBuildingStrikeValue,
    getKnownEnemyClusterContext,
    getSlbmTargetPriorityScore,
    selectBestKnownEnemyTarget,
    isWorthwhileAIAttack
  };
}

module.exports = {
  createAiTargetingHelpers
};
