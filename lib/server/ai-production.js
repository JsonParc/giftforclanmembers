function createAiProductionHelpers({
  getGameState,
  unitDefinitions,
  getUnitDefinition
}) {
  function buildUnitForAI(userId, buildingId, unitType) {
    const gameState = getGameState();
    const building = gameState.buildings.get(buildingId);
    const player = gameState.players.get(userId);

    if (!building || building.userId !== userId || !player) return false;
    if (!Object.prototype.hasOwnProperty.call(unitDefinitions, unitType)) return false;
    if (building.buildProgress < 100) return false;

    if (unitType === 'worker' && building.type !== 'headquarters') return false;
    if ((unitType === 'destroyer' || unitType === 'cruiser' || unitType === 'frigate') && building.type !== 'shipyard') return false;
    if ((unitType === 'battleship' || unitType === 'carrier' || unitType === 'submarine' || unitType === 'assaultship') && building.type !== 'naval_academy') return false;
    if (unitType === 'missile_launcher' && building.type !== 'carbase') return false;

    if (!building.productionQueue) building.productionQueue = [];
    if (building.productionQueue.length >= 10) return false;

    const unitConfig = getUnitDefinition(unitType);
    if (player.resources >= unitConfig.cost && player.population + unitConfig.pop <= player.maxPopulation) {
      player.resources -= unitConfig.cost;
      player.population += unitConfig.pop;

      building.productionQueue.push({
        unitType,
        buildTime: unitConfig.buildTime,
        userId
      });

      if (!building.producing) {
        const next = building.productionQueue[0];
        building.producing = {
          unitType: next.unitType,
          startTime: Date.now(),
          buildTime: next.buildTime,
          userId: next.userId
        };
      }

      return true;
    }

    return false;
  }

  return {
    buildUnitForAI
  };
}

module.exports = {
  createAiProductionHelpers
};
