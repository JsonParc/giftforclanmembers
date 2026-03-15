function getDistinctCombatTypeCount(unitTypeCounts) {
  return ['frigate', 'destroyer', 'cruiser', 'submarine', 'carrier', 'battleship', 'assaultship', 'missile_launcher']
    .reduce((sum, unitType) => sum + ((unitTypeCounts[unitType] || 0) > 0 ? 1 : 0), 0);
}

function getDominantCombatType(unitTypeCounts) {
  let dominantType = null;
  let dominantCount = 0;
  for (const unitType of ['frigate', 'destroyer', 'cruiser', 'submarine', 'carrier', 'battleship', 'assaultship', 'missile_launcher']) {
    const count = unitTypeCounts[unitType] || 0;
    if (count > dominantCount) {
      dominantType = unitType;
      dominantCount = count;
    }
  }
  return dominantType;
}

function scoreShipyardUnitChoice(unitType, context) {
  const { strategy, counts, knownEnemyCount, hasNavalAcademy, powerPlantCount, shipyardCount } = context;
  const frigateCount = counts.frigate || 0;
  const destroyerCount = counts.destroyer || 0;
  const cruiserCount = counts.cruiser || 0;
  const submarineCount = counts.submarine || 0;
  const carrierCount = counts.carrier || 0;
  const diversity = getDistinctCombatTypeCount(counts);
  const dominantType = getDominantCombatType(counts);
  const totalShipyardUnits = frigateCount + destroyerCount + cruiserCount;
  const lightFleetRatio = totalShipyardUnits > 0 ? (frigateCount + destroyerCount) / totalShipyardUnits : 0;
  const lateTechPressure = hasNavalAcademy && powerPlantCount >= 4;
  let score = strategy.shipyardWeights[unitType] || 1;

  if (unitType === 'frigate') {
    score += frigateCount < 2 ? 0.7 : 0;
    score -= Math.max(0, frigateCount - 3) * 0.95;
    if (destroyerCount < Math.max(1, Math.ceil((frigateCount + submarineCount + carrierCount) / 2))) score -= 0.5;
    if (powerPlantCount >= 3) score -= 0.35;
    if (shipyardCount >= 2 || hasNavalAcademy) score -= 0.55;
    if (totalShipyardUnits >= 6) score -= 0.55;
    if (lateTechPressure) score -= 0.45;
    if (lightFleetRatio > 0.55 && totalShipyardUnits >= 5) score -= 0.38;
  } else if (unitType === 'destroyer') {
    score += destroyerCount < Math.max(2, Math.ceil((frigateCount + submarineCount + carrierCount) / 2)) ? 1.1 : 0.2;
    score += knownEnemyCount > 0 ? 0.2 : 0;
    if (powerPlantCount >= 3 && cruiserCount <= 0) score -= 0.2;
    if (shipyardCount >= 2 || hasNavalAcademy) score -= 0.35;
    if (cruiserCount <= 0 && totalShipyardUnits >= 4) score -= 0.15;
    if (lateTechPressure && cruiserCount <= Math.max(1, Math.floor(destroyerCount / 2))) score -= 0.42;
  } else if (unitType === 'cruiser') {
    score += totalShipyardUnits >= 2 ? 0.8 : 0.15;
    score += powerPlantCount >= 3 ? 0.85 : -0.1;
    score += shipyardCount >= 2 ? 0.75 : 0;
    score += hasNavalAcademy ? 0.32 : 0;
    if (lightFleetRatio > 0.6) score += 0.95;
    if (knownEnemyCount > 0) score += 0.2;
    if (lateTechPressure) score += 0.48;
  }

  if ((unitType === 'frigate' || unitType === 'destroyer') && lightFleetRatio > 0.62 && totalShipyardUnits >= 5) score -= 0.7;
  if ((unitType === 'frigate' || unitType === 'destroyer') && lateTechPressure && lightFleetRatio > 0.56) score -= 0.5;
  if (unitType === 'cruiser' && lateTechPressure && lightFleetRatio > 0.52) score += 0.62;
  if (dominantType === unitType && totalShipyardUnits >= 4) score -= unitType === 'cruiser' ? 0.45 : 1.15;
  if (diversity < 2 && dominantType && dominantType !== unitType) score += 0.5;
  return score;
}

function scoreAcademyUnitChoice(unitType, context) {
  const { strategy, counts, currentCombatPower, knownEnemyCount, missileSiloCount, powerPlantCount, shipyardCount, workerCount = 0 } = context;
  const submarineCount = counts.submarine || 0;
  const carrierCount = counts.carrier || 0;
  const battleshipCount = counts.battleship || 0;
  const assaultshipCount = counts.assaultship || 0;
  const destroyerCount = counts.destroyer || 0;
  const cruiserCount = counts.cruiser || 0;
  const launcherCount = counts.missile_launcher || 0;
  const lightFleetCount = (counts.frigate || 0) + (counts.destroyer || 0);
  const assaultCargoPool = launcherCount + Math.max(0, workerCount - 2);
  const diversity = getDistinctCombatTypeCount(counts);
  const dominantType = getDominantCombatType(counts);
  let score = strategy.academyWeights[unitType] || 1;

  if (unitType === 'submarine') {
    score += submarineCount < 2 ? 1.25 : 0.25;
    score += missileSiloCount > 0 ? 0.78 : 0.05;
    score += powerPlantCount >= 4 ? 0.28 : -0.18;
    if (missileSiloCount > 0 && powerPlantCount >= 4) score += 0.22;
    score += knownEnemyCount > 0 ? 0.18 : 0;
    if (lightFleetCount >= 5) score += 0.22;
  } else if (unitType === 'carrier') {
    score += carrierCount <= 0 ? 1.2 : -0.15;
    score += destroyerCount >= 1 ? 0.35 : -0.25;
    score += cruiserCount >= 1 ? 0.2 : 0;
    score += powerPlantCount >= 4 ? 1.2 : -0.45;
    score += currentCombatPower >= 380 ? 0.32 : 0;
    if (lightFleetCount >= 5) score += 0.28;
  } else if (unitType === 'battleship') {
    score += currentCombatPower >= 420 ? 1.2 : 0.22;
    score += cruiserCount >= 1 ? 0.55 : -0.08;
    score += shipyardCount >= 2 ? 0.3 : 0;
    score += powerPlantCount >= 4 ? 1.55 : -0.4;
    score += battleshipCount <= 0 ? 0.6 : 0.1;
    if (lightFleetCount >= 5) score += 0.32;
  } else if (unitType === 'assaultship') {
    score += assaultshipCount <= 0 ? 0.35 : -0.25;
    score += launcherCount > 0 ? (0.45 + Math.min(0.45, launcherCount * 0.1)) : -1.15;
    score += assaultCargoPool >= 2 ? 0.35 : -0.6;
    score += knownEnemyCount > 0 ? 0.12 : -0.08;
    score += powerPlantCount >= 4 ? 0.18 : -0.25;
    if (currentCombatPower < 520 && lightFleetCount < 4) score -= 0.45;
  }

  if (dominantType === unitType && diversity >= 3) score -= 0.8;
  if (diversity < 3 && dominantType && dominantType !== unitType) score += 0.5;
  return score;
}

module.exports = {
  scoreShipyardUnitChoice,
  scoreAcademyUnitChoice
};
