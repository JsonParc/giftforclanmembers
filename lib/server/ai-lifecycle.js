function createAiLifecycleHelpers(deps) {
  const {
    io,
    getGameState,
    getCurrentRoomId,
    getGameRooms,
    switchRoom,
    roomHasHumanPlayers,
    findStartPosition,
    isOnLand,
    findNearestLandPosition,
    findNearestValidBuildingPosition,
    spawnStartingWorkers,
    ensureAIStrategyProfile,
    getAIUserId,
    getAIIndexFromUserId,
    getAIName,
    STARTING_MAX_POPULATION,
    STARTING_WORKER_COUNT,
    ENABLE_SERVER_FOG_SNAPSHOTS,
    roomEmit,
    clearCurrentRoomTransientState,
    RED_ZONE_SELECTION_INTERVAL_MS,
    syncSlbmId,
    removePlayerFromCurrentRoom,
    emitSlbmDestroyedEvent,
    emitAirstrikeCancelledEvent,
    AI_CONFIG
  } = deps;

  function spawnAIPlayer(aiIndex) {
    const gameState = getGameState();
    const aiId = getAIUserId(aiIndex);
    if (gameState.players.has(aiId)) {
      return gameState.players.get(aiId);
    }

    const aiName = getAIName(aiIndex);
    const startPos = findStartPosition();
    if (!isOnLand(startPos.x, startPos.y)) {
      const landPos = findNearestLandPosition(startPos.x, startPos.y);
      startPos.x = landPos.x;
      startPos.y = landPos.y;
    }
    const resolvedStartPos = findNearestValidBuildingPosition('headquarters', startPos.x, startPos.y);
    if (resolvedStartPos) {
      startPos.x = resolvedStartPos.x;
      startPos.y = resolvedStartPos.y;
    }

    const aiPlayer = {
      userId: aiId,
      username: aiName,
      resources: 1000,
      population: 0,
      maxPopulation: STARTING_MAX_POPULATION,
      combatPower: 0,
      score: 0,
      scoreFromKills: 0,
      baseX: startPos.x,
      baseY: startPos.y,
      hasBase: true,
      researchedSLBM: false,
      missiles: 0,
      battleshipModeComboUnlocked: false,
      online: true,
      isAI: true,
      lastScoutTime: 0,
      lastAttackTime: 0,
      scoutTargets: [],
      knownEnemyBases: [],
      recentAttackLocations: [],
      priorityTargets: [],
      isCounterattacking: false,
      counterattackTarget: null,
      aiStrategyId: null,
      aiStrategyAssignedAt: 0
    };
    gameState.players.set(aiId, aiPlayer);
    if (ENABLE_SERVER_FOG_SNAPSHOTS) {
      gameState.fogOfWar.set(aiId, new Map());
    }

    const hqId = Date.now() * 1000 + Math.floor(Math.random() * 1000) + aiIndex * 100;
    gameState.buildings.set(hqId, {
      id: hqId,
      userId: aiId,
      type: 'headquarters',
      x: startPos.x,
      y: startPos.y,
      hp: 1500,
      maxHp: 1500,
      buildProgress: 100
    });

    spawnStartingWorkers(aiId, startPos.x, startPos.y, STARTING_WORKER_COUNT);
    aiPlayer.population = STARTING_WORKER_COUNT;
    const aiStrategy = ensureAIStrategyProfile(aiPlayer);

    console.log(`AI Player ${aiName} initialized at (${startPos.x.toFixed(0)}, ${startPos.y.toFixed(0)}) with strategy ${aiStrategy.label}`);
    return aiPlayer;
  }

  function clearAIRespawnTimer(aiUserId) {
    const gameState = getGameState();
    const existingTimer = gameState.aiRespawnTimers.get(aiUserId);
    if (!existingTimer) {
      return;
    }
    clearTimeout(existingTimer);
    gameState.aiRespawnTimers.delete(aiUserId);
  }

  function clearActiveWeaponsForUser(userId) {
    const gameState = getGameState();
    const slbmIdsToDelete = [];
    gameState.activeSlbms.forEach((slbm, slbmId) => {
      if (slbm.userId === userId) {
        slbmIdsToDelete.push(slbmId);
      }
    });
    slbmIdsToDelete.forEach((slbmId) => {
      const slbm = gameState.activeSlbms.get(slbmId);
      gameState.activeSlbms.delete(slbmId);
      emitSlbmDestroyedEvent({
        id: slbmId,
        x: slbm ? slbm.currentX : null,
        y: slbm ? slbm.currentY : null,
        userId: slbm ? slbm.userId : null
      });
    });

    if (!gameState.activeAirstrikes) {
      return;
    }

    const strikeIdsToDelete = [];
    gameState.activeAirstrikes.forEach((strike, strikeId) => {
      if (strike.userId === userId) {
        strikeIdsToDelete.push(strikeId);
      }
    });
    strikeIdsToDelete.forEach((strikeId) => {
      const strike = gameState.activeAirstrikes.get(strikeId);
      gameState.activeAirstrikes.delete(strikeId);
      emitAirstrikeCancelledEvent({
        id: strikeId,
        targetX: strike ? strike.targetX : null,
        targetY: strike ? strike.targetY : null,
        userId: strike ? strike.userId : null
      });
    });
  }

  function scheduleAIRespawn(aiUserId) {
    const roomId = getCurrentRoomId();
    const room = roomId ? getGameRooms().get(roomId) : null;
    const aiIndex = getAIIndexFromUserId(aiUserId);
    if (!room || aiIndex == null) {
      return;
    }

    const existingTimer = room.aiRespawnTimers.get(aiUserId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const targetRoom = getGameRooms().get(roomId);
      if (!targetRoom) return;
      targetRoom.aiRespawnTimers.delete(aiUserId);
      if (!roomHasHumanPlayers(roomId)) {
        return;
      }

      switchRoom(roomId);

      const aiPlayer = spawnAIPlayer(aiIndex);
      syncSlbmId();
      io.to(roomId).emit('playerJoined', aiPlayer);
      console.log(`AI ${aiPlayer.username} rejoined room ${roomId}`);
    }, AI_CONFIG.respawnDelayMs);

    room.aiRespawnTimers.set(aiUserId, timer);
  }

  function removeAllAiFactionsFromCurrentRoom(options = {}) {
    const gameState = getGameState();
    if (!gameState || AI_CONFIG.count <= 0) {
      return 0;
    }

    const { emitPlayerLeft = false } = options;
    let removedCount = 0;

    for (let aiIndex = 0; aiIndex < AI_CONFIG.count; aiIndex++) {
      const aiUserId = getAIUserId(aiIndex);
      clearAIRespawnTimer(aiUserId);
      clearActiveWeaponsForUser(aiUserId);

      if (gameState.players.has(aiUserId)) {
        removePlayerFromCurrentRoom(aiUserId, { emitPlayerLeft });
        removedCount++;
      } else {
        gameState.fogOfWar.delete(aiUserId);
      }
    }

    return removedCount;
  }

  function resetAllAiFactionsInCurrentRoom() {
    const gameState = getGameState();
    const currentRoomId = getCurrentRoomId();
    if (!gameState || !currentRoomId || AI_CONFIG.count <= 0) {
      return 0;
    }

    const roomId = currentRoomId;
    roomEmit('systemKillLog', { message: '(시스템에 의해 신속하게 처리되었습니다)' });
    removeAllAiFactionsFromCurrentRoom({ emitPlayerLeft: true });

    let respawnedCount = 0;
    for (let aiIndex = 0; aiIndex < AI_CONFIG.count; aiIndex++) {
      const aiPlayer = spawnAIPlayer(aiIndex);
      if (!aiPlayer) continue;
      respawnedCount++;
      io.to(roomId).emit('playerJoined', aiPlayer);
    }

    syncSlbmId();
    console.log(`Reset ${respawnedCount} AI faction(s) in room ${roomId}`);
    return respawnedCount;
  }

  function initializeAIPlayers() {
    const gameState = getGameState();
    let spawnedCount = 0;
    for (let i = 0; i < AI_CONFIG.count; i++) {
      if (gameState.players.has(getAIUserId(i))) {
        continue;
      }
      const aiPlayer = spawnAIPlayer(i);
      if (aiPlayer) {
        spawnedCount++;
      }
    }
    return spawnedCount;
  }

  return {
    spawnAIPlayer,
    scheduleAIRespawn,
    clearAIRespawnTimer,
    clearActiveWeaponsForUser,
    removeAllAiFactionsFromCurrentRoom,
    resetAllAiFactionsInCurrentRoom,
    initializeAIPlayers
  };
}

module.exports = {
  createAiLifecycleHelpers
};
