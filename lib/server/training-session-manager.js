function createTrainingSessionManager({
  aiTraining,
  enabled,
  benchmarkMode,
  preloadOnStart,
  allowWeightLoading,
  weightUpdatesEnabled,
  difficulties,
  emptyStats
}) {
  const trainingSessions = Object.fromEntries(difficulties.map((difficulty) => [difficulty, null]));
  const trainingSessionLoads = Object.fromEntries(difficulties.map((difficulty) => [difficulty, null]));
  let rlPreloadPromise = null;

  async function ensureTrainingSessionLoaded(difficulty) {
    if (!enabled || !difficulties.includes(difficulty) || benchmarkMode || !allowWeightLoading || !aiTraining) {
      return null;
    }
    if (trainingSessions[difficulty]) {
      return trainingSessions[difficulty];
    }
    if (!trainingSessionLoads[difficulty]) {
      trainingSessionLoads[difficulty] = (async () => {
        await aiTraining.ensureExternalWeightsCached(difficulty);
        let session = trainingSessions[difficulty];
        if (!session) {
          session = new aiTraining.TrainingSession(difficulty);
          if (!weightUpdatesEnabled) {
            session.frozen = true;
          }
          const stateCount = Number.isFinite(session.loadedStateCount)
            ? session.loadedStateCount
            : Object.keys(session.qTable.table || {}).length;
          if (!weightUpdatesEnabled && stateCount <= 0) {
            console.warn(`[AI-RL][${difficulty}] Loaded empty RL table; live AI will use fallback logic until retrained.`);
          }
          trainingSessions[difficulty] = session;
        }
        return session;
      })()
        .catch((error) => {
          console.error(`[AI-RL][${difficulty}] Failed to initialize training session:`, error.message);
          return null;
        })
        .finally(() => {
          trainingSessionLoads[difficulty] = null;
        });
    }
    return trainingSessionLoads[difficulty];
  }

  function preloadTrainingSessions() {
    if (!enabled || benchmarkMode || !preloadOnStart || !allowWeightLoading || !aiTraining) {
      return Promise.resolve([]);
    }
    if (!rlPreloadPromise) {
      rlPreloadPromise = Promise.all(
        difficulties.map(async (difficulty) => {
          const session = await ensureTrainingSessionLoaded(difficulty);
          if (!session) {
            console.warn(`[AI-RL][${difficulty}] Session preload failed or returned null.`);
            return null;
          }
          const stateCount = Object.keys(session.qTable.table || {}).length;
          console.log(`[AI-RL][${difficulty}] Session ready for live play (${stateCount} states).`);
          return session;
        })
      ).finally(() => {
        rlPreloadPromise = null;
      });
    }
    return rlPreloadPromise;
  }

  function getTrainingSession(difficulty, { create = false } = {}) {
    if (!enabled || !difficulties.includes(difficulty) || benchmarkMode || !allowWeightLoading || !aiTraining) {
      return null;
    }
    const session = trainingSessions[difficulty];
    if (!session && create && !trainingSessionLoads[difficulty]) {
      void ensureTrainingSessionLoaded(difficulty);
    }
    return session;
  }

  function getTrainingSessionStatusSummary(difficulty) {
    const session = getTrainingSession(difficulty);
    if (session) {
      return {
        ...session.getStatus(),
        unloaded: false
      };
    }
    return {
      difficulty,
      isTraining: false,
      frozen: !weightUpdatesEnabled,
      currentEpisode: 0,
      maxEpisodes: 0,
      episodeSteps: 0,
      stats: { ...emptyStats },
      log: [],
      unloaded: true,
      loading: !!trainingSessionLoads[difficulty]
    };
  }

  return {
    ensureTrainingSessionLoaded,
    preloadTrainingSessions,
    getTrainingSession,
    getTrainingSessionStatusSummary
  };
}

module.exports = {
  createTrainingSessionManager
};
