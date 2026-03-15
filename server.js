const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createTrainingSessionManager } = require('./lib/server/training-session-manager');
const { createAiConfig, createAiStrategyHelper, getAIUserId, getAIIndexFromUserId, getAIName } = require('./lib/server/ai-config');
const { createAiLifecycleHelpers } = require('./lib/server/ai-lifecycle');
const { createAiProductionHelpers } = require('./lib/server/ai-production');
const { scoreShipyardUnitChoice, scoreAcademyUnitChoice } = require('./lib/server/ai-unit-scoring');
const { createAiTargetingHelpers } = require('./lib/server/ai-targeting');

const ENABLE_AI_TRAINING = true;
const BENCHMARK_MODE = process.env.MW_BENCHMARK === '1';
const RL_WEIGHT_UPDATES_ENABLED = process.env.MW_ALLOW_RL_WEIGHT_UPDATES === '1';
const RL_PRELOAD_ON_START = process.env.MW_PRELOAD_RL_ON_START !== '0';
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const aiTraining = ENABLE_AI_TRAINING ? require('./ai-training') : null;
const RL_SESSION_DIFFICULTIES = Object.freeze(['hard', 'expert']);
const DEFAULT_AI_DIFFICULTY = 'normal';
const ALLOW_AI_DIFFICULTY_SELECTION = true;
const ALLOW_RL_WEIGHT_LOADING = true;
const EMPTY_TRAINING_STATS = Object.freeze({
  episodes: 0,
  states: 0,
  epsilon: 0,
  avgReward: 0,
  totalReward: 0
});
const {
  ensureTrainingSessionLoaded,
  preloadTrainingSessions,
  getTrainingSession,
  getTrainingSessionStatusSummary
} = createTrainingSessionManager({
  aiTraining,
  enabled: ENABLE_AI_TRAINING,
  benchmarkMode: BENCHMARK_MODE,
  preloadOnStart: RL_PRELOAD_ON_START,
  allowWeightLoading: ALLOW_RL_WEIGHT_LOADING,
  weightUpdatesEnabled: RL_WEIGHT_UPDATES_ENABLED,
  difficulties: RL_SESSION_DIFFICULTIES,
  emptyStats: EMPTY_TRAINING_STATS
});
const AI_CONFIG = createAiConfig(aiTraining);
const FALLBACK_DIFFICULTY_PRESETS = Object.freeze({
  easy: Object.freeze({
    label: '쉬움',
    epsilon: 0.6,
    updateInterval: 4000,
    buildingMultiplier: 0.5,
    unitMultiplier: 0.5,
    attackCooldown: 40000,
    counterattackThreshold: 5,
    useSkills: false,
    useRL: false,
    minPowerPlants: 2,
    minShipyards: 1,
    minSilos: 0,
    minTowers: 1,
    maxWorkers: 2
  }),
  normal: Object.freeze({
    label: '보통',
    epsilon: 0.3,
    updateInterval: 2000,
    buildingMultiplier: 1.0,
    unitMultiplier: 1.0,
    attackCooldown: 20000,
    counterattackThreshold: 2,
    useSkills: true,
    useRL: false,
    minPowerPlants: 3,
    minShipyards: 1,
    minSilos: 1,
    minTowers: 2,
    maxWorkers: 3
  }),
  hard: Object.freeze({
    label: '어려움',
    epsilon: 0.15,
    updateInterval: 1500,
    buildingMultiplier: 1.5,
    unitMultiplier: 1.5,
    attackCooldown: 10000,
    counterattackThreshold: 1,
    useSkills: true,
    useRL: ENABLE_AI_TRAINING,
    minPowerPlants: 4,
    minShipyards: 2,
    minSilos: 1,
    minTowers: 3,
    maxWorkers: 4
  }),
  expert: Object.freeze({
    label: '전문가',
    epsilon: 0.05,
    updateInterval: 1000,
    buildingMultiplier: 2.0,
    unitMultiplier: 2.0,
    attackCooldown: 5000,
    counterattackThreshold: 1,
    useSkills: true,
    useRL: ENABLE_AI_TRAINING,
    minPowerPlants: 5,
    minShipyards: 2,
    minSilos: 2,
    minTowers: 4,
    maxWorkers: 5
  })
});
const DIFFICULTY_PRESETS = (aiTraining && aiTraining.DIFFICULTY_PRESETS) || FALLBACK_DIFFICULTY_PRESETS;

function getEffectiveAIDifficulty(difficulty) {
  if (!ALLOW_AI_DIFFICULTY_SELECTION) return DEFAULT_AI_DIFFICULTY;
  return DIFFICULTY_PRESETS[difficulty] ? difficulty : DEFAULT_AI_DIFFICULTY;
}

const APP_NAME = 'MW Craft';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
const GAME_TICK_RATE = 30; // 30 ticks per second
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'game.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const COMBAT_SPATIAL_CELL_SIZE = 700;
const COLLISION_SPATIAL_CELL_SIZE = 400;
const NETWORK_UPDATE_BASE_MS = 100;
const NETWORK_VIEWPORT_MARGIN_WORLD = 2200;
const NETWORK_VIEWPORT_STATE_STALE_MS = 5000;
const PERF_DEBUG_ENABLED = BENCHMARK_MODE || process.env.MW_PERF_DEBUG === '1';
const PERF_LOG_INTERVAL_MS = Math.max(1000, Number(process.env.MW_PERF_LOG_INTERVAL_MS || 5000));
const PERF_LOG_TOP_N = Math.max(5, Number(process.env.MW_PERF_TOP_N || 12));
const PATH_CACHE_TTL_MS = 15000;
const PATH_CACHE_MAX_ENTRIES = 8000;
const SLBM_DAMAGE_RADIUS = 800;
const AIRSTRIKE_DAMAGE_RADIUS = 400;
const AIRSTRIKE_VISUAL_RADIUS = 400;
const AIRSTRIKE_PASS_COUNT = 3;
const AIRSTRIKE_TOTAL_DAMAGE = 720;
const AIRSTRIKE_DAMAGE_PER_PASS = AIRSTRIKE_TOTAL_DAMAGE / AIRSTRIKE_PASS_COUNT;
const AIRSTRIKE_PASS_INTERVAL_MS = 667;
const RECON_AIRCRAFT_MAX_PER_CARRIER = 3;
const RECON_AIRCRAFT_BUILD_TIME_MS = 27000;
const RECON_AIRCRAFT_LOITER_MS = 8000;
const RECON_AIRCRAFT_TARGET_THRESHOLD = 160;
const RECON_AIRCRAFT_DOCK_RADIUS = 90;
const RECON_AIRCRAFT_ORBIT_RADIUS = 260;
const RECON_AIRCRAFT_ORBIT_ANGULAR_SPEED = 1.6;
const RECON_AIRCRAFT_RETURN_ALIGN_THRESHOLD = 0.42;
const RED_ZONE_SELECTION_INTERVAL_MS = 10 * 60 * 1000;
const RED_ZONE_WARNING_DURATION_MS = 30 * 1000;
const RED_ZONE_COUNTDOWN_START_MS = 10 * 1000;
const RED_ZONE_POST_BLAST_VISUAL_MS = 5000;
const RED_ZONE_BLAST_DAMAGE = 999999;
const RED_ZONE_BLAST_RADIUS = SLBM_DAMAGE_RADIUS;
const RED_ZONE_ISLAND_COUNT = 5;
const RED_ZONE_MAX_OCCUPIED_ISLANDS = 3;
const RED_ZONE_MAX_BURSTS = 32;
const RED_ZONE_MIN_BURSTS = 10;
const RED_ZONE_BURST_DELAY_STEP_MS = 100;
const BUILDING_BASE_DISPLAY_HEIGHT = 60 * 6.6;
const COASTAL_BUILDING_SIZE_SCALE = 0.6;
const POWER_PLANT_SIZE_SCALE = COASTAL_BUILDING_SIZE_SCALE * 0.7;
const FIXED_BUILDING_IMAGE_MAX_DIMENSION = 200;
const HEADQUARTERS_BUILD_COST = 800;
const MISSILE_SILO_COST = 1600;
const CARBASE_BUILD_COST = 350;
const MISSILE_LAUNCHER_COST = 2200;
const MISSILE_LAUNCHER_BUILD_TIME_MS = 27000;
const MISSILE_LAUNCHER_DEPLOY_STAGE_MS = 1000;
const MISSILE_LAUNCHER_DEPLOYED_RANGE = 2500;
const BATTLESHIP_COST = 2400;
const CARRIER_COST = 1600;
const SUBMARINE_COST = 1800;
const ASSAULT_SHIP_COST = 1000;
const ASSAULT_SHIP_MAX_LAUNCHERS = 10;
const ASSAULT_SHIP_LOAD_RADIUS = 260;
const ASSAULT_SHIP_LAND_RADIUS = 260;
const SUBMARINE_SLBM_CAPACITY = 3;
const SUBMARINE_SLBM_RELOAD_MS = 30000;
const SUBMARINE_STEALTH_DURATION_MS = 15000;  // 은신 지속시간 15초
const SUBMARINE_STEALTH_COOLDOWN_MS = 30000;  // 은신 쿨타임 30초
const SUBMARINE_SLBM_LOAD_RANGE = 800;  // SLBM 적재 가능 거리 (사일로 기준)
const PLAYER_BASE_POPULATION_CAP = 10;
const HEADQUARTERS_POPULATION_BONUS = 20;
const PLAYER_MAX_POPULATION_CAP = 250;
const BUILDING_POPULATION_BONUSES = Object.freeze({
  headquarters: HEADQUARTERS_POPULATION_BONUS,
  naval_academy: 10,
  shipyard: 5,
  power_plant: 3
});
const STARTING_MAX_POPULATION = Math.min(
  PLAYER_MAX_POPULATION_CAP,
  PLAYER_BASE_POPULATION_CAP + HEADQUARTERS_POPULATION_BONUS
);
const STARTING_WORKER_COUNT = 4;
const LEGACY_WORKER_RESOURCE_GATHERING_ENABLED = false;
const UNIT_COMBAT_POWER_VALUES = Object.freeze({
  destroyer: 95,
  cruiser: 260,
  battleship: 780,
  carrier: 560,
  submarine: 420,
  frigate: 38,
  assaultship: 260,
  missile_launcher: 520,
  slbm: 650
});
const GENERAL_BUILDING_COMBAT_POWER = 120;
const ADVANCED_BUILDING_COMBAT_POWER = 150;
const GENERAL_BUILDING_TYPES = new Set(['headquarters', 'power_plant', 'shipyard']);
const ADVANCED_BUILDING_TYPES = new Set(['defense_tower', 'naval_academy', 'missile_silo', 'carbase', 'research_lab']);
const BATTLESHIP_AEGIS_TURRET_COUNT = 3;
const BATTLESHIP_AEGIS_DAMAGE = 7;
const BATTLESHIP_AEGIS_RANGE_MULTIPLIER = 1.5;
const BATTLESHIP_AEGIS_TAKEN_DAMAGE_MULTIPLIER = 1.40;
const BATTLESHIP_AEGIS_TURRET_COOLDOWN_MS = 480;
// Add more usernames here to allow default <-> yamato battleship skin switching.
const YAMATO_BATTLESHIP_SKIN_ALLOWED_USERNAMES = new Set(['JsonParc']);
// Human matches involving these accounts are excluded from live RL data collection.
const AI_TRAINING_DATA_EXCLUDED_USERNAMES = new Set(['JsonParc']);
const OBSERVER_LOGIN_USERNAME = 'observer';
const CARBASE_PREREQ_BUILDINGS = Object.freeze([
  'headquarters',
  'shipyard',
  'power_plant',
  'defense_tower',
  'naval_academy',
  'missile_silo'
]);

function isObserverUsername(username) {
  return typeof username === 'string' && username.trim().toLowerCase() === OBSERVER_LOGIN_USERNAME;
}

function isObserverPlayer(player) {
  return !!player?.isObserver;
}

const perfMetrics = new Map();
let perfWindowStartedAt = Date.now();
let perfLastFlushAt = Date.now();

function perfNowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function perfRecord(name, elapsedMs = 0, count = 1, detail = 0) {
  if (!PERF_DEBUG_ENABLED || !name) return;
  let metric = perfMetrics.get(name);
  if (!metric) {
    metric = { totalMs: 0, count: 0, maxMs: 0, detail: 0 };
    perfMetrics.set(name, metric);
  }
  metric.totalMs += elapsedMs;
  metric.count += count;
  metric.detail += detail;
  if (elapsedMs > metric.maxMs) {
    metric.maxMs = elapsedMs;
  }
}

function perfFlush(reason = 'runtime', force = false) {
  if (!PERF_DEBUG_ENABLED) return;
  const now = Date.now();
  if (!force && (now - perfLastFlushAt) < PERF_LOG_INTERVAL_MS) {
    return;
  }

  const windowMs = Math.max(1, now - perfWindowStartedAt);
  const metrics = [...perfMetrics.entries()]
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, PERF_LOG_TOP_N);

  console.log(`[PERF][${reason}] window=${windowMs}ms metrics=${metrics.length}`);
  metrics.forEach(([name, metric]) => {
    const avgMs = metric.count > 0 ? (metric.totalMs / metric.count) : 0;
    const extras = [];
    if (metric.detail > 0) extras.push(`detail=${metric.detail}`);
    console.log(
      `[PERF][${reason}] ${name} total=${metric.totalMs.toFixed(2)}ms count=${metric.count} avg=${avgMs.toFixed(3)}ms max=${metric.maxMs.toFixed(3)}ms${extras.length ? ` ${extras.join(' ')}` : ''}`
    );
  });

  perfMetrics.clear();
  perfWindowStartedAt = now;
  perfLastFlushAt = now;
}
const BUILDING_PLACEMENT_BUFFER = 50;
const BUILDING_PLACEMENT_SEARCH_RADIUS = 4000;
const SLBM_MAX_HP = 500;
const DEFENSE_TOWER_CANNON_START = Object.freeze({ x: 14, y: 8 });
const DEFENSE_TOWER_CANNON_MUZZLE = Object.freeze({ x: 14, y: 17 });
const DESTROYER_SEARCH_VISION_RADIUS = 4800;
const DESTROYER_MAX_MINES = 5;
const SEARCH_REVEAL_DURATION_MS = 10000;
const SHIP_HEIGHT_MULT = 6.6;
const SHIP_ASPECT_RATIO = 0.25;
const MISSILE_LAUNCHER_HEIGHT_MULT = 3.2;
const MISSILE_LAUNCHER_MOBILE_HEIGHT_MULT = 4.0;
const MISSILE_LAUNCHER_RENDER_SIZE = 36;
const BATTLESHIP_BASE_HEIGHT_MULTIPLIER = 2.2 * 3 * 1.2;
const UNIT_SELECTION_HITBOX_PADDING = 5;
const NAVAL_UNIT_TYPES = new Set(['destroyer', 'cruiser', 'battleship', 'carrier', 'submarine', 'frigate', 'assaultship']);
const ASSAULT_SHIP_LOADABLE_UNIT_TYPES = new Set(['worker', 'missile_launcher']);
const ROOM_ANNIHILATION_MESSAGE = '거대한 악의 세력이 설치한 핵폭탄에 의해 처치당했습니다';
const BATTLESHIP_COMBAT_STANCE_HP_COST_RATIO = 0.10;
const BATTLESHIP_COMBAT_STANCE_ATTACK_SPEED_MULTIPLIER = 1.10;
const BATTLESHIP_COMBAT_STANCE_MIN_ATTACK_COOLDOWN_MS = 150;
const BATTLESHIP_COMBAT_STANCE_DECAY_DELAY_MS = 10000;
const BATTLESHIP_COMBAT_STANCE_DECAY_INTERVAL_MS = 1000;
const FRIGATE_ENGINE_OVERDRIVE_HP_COST_RATIO = 0.10;
const FRIGATE_ENGINE_OVERDRIVE_SPEED_MULTIPLIER = 1.10;
const FRIGATE_ENGINE_OVERDRIVE_MAX_EVASION = 0.80;
const FRIGATE_ENGINE_OVERDRIVE_TICK_MS = 1000;
const NAVAL_COLLISION_WAKE_MS = 700;
const NAVAL_COLLISION_CLEARANCE_BUFFER = 18;
const NAVAL_REPATH_NO_PROGRESS_TICKS = 18;
const NAVAL_REPATH_COOLDOWN_MS = 1200;
const SQUAD_ROTATION_RATE = 0.045;
const SQUAD_UNIT_TURN_RATE = 0.08;
const SQUAD_CATCH_UP_SPEED_MULTIPLIER = 2.2;
const SQUAD_COMMAND_ANGLE_DEADZONE = 48;
const SQUAD_COMMAND_REISSUE_DISTANCE = 20;
const SQUAD_HEADING_HYSTERESIS = 0.10;
const SQUAD_HEADING_FORCE_DELTA = 0.32;
const SQUAD_HEADING_UPDATE_COOLDOWN_MS = 180;
const SQUAD_UNIT_FACING_HYSTERESIS = 0.12;
const SQUAD_FORMATION_RETARGET_INTERVAL_MS = 220;
const SQUAD_FORMATION_RETARGET_DISTANCE = 90;
const SQUAD_ANCHOR_WAYPOINT_REACHED_DISTANCE = 120;
const THREAT_SCAN_EXCLUDED_AIR_TYPES = new Set(['aircraft', 'recon_aircraft']);
const CARRIER_AIRCRAFT_RETURN_HP_RATIO = 0.5;
const CARRIER_AIRCRAFT_REPAIR_DOCK_MS = 2000;
const CARRIER_AIRCRAFT_REPAIR_HEAL_RATIO = 0.5;
const ENABLE_SERVER_FOG_SNAPSHOTS = false;
const DEFENSE_TOWER_CANNON_BASE_ANGLE = Math.PI / 2; // 6시 방향이 기본 총구 방향
let nextAirstrikeId = 1;

function readPngDimensions(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  } catch (error) {
    return { width: 56, height: 43 };
  }
}

function computeBuildingBaseCollisionSize() {
  const hqImagePath = path.join(__dirname, 'public', 'assets', 'images', 'buildings', 'hq.png');
  const dims = readPngDimensions(hqImagePath);
  const baseWidth = BUILDING_BASE_DISPLAY_HEIGHT * (dims.width / dims.height);
  return Math.round(Math.max(baseWidth, BUILDING_BASE_DISPLAY_HEIGHT));
}

const IMAGE_BUILDING_BASE_COLLISION_SIZE = computeBuildingBaseCollisionSize();

function computeFixedImageDisplayMetrics(filePath, maxDimension = FIXED_BUILDING_IMAGE_MAX_DIMENSION) {
  const dims = readPngDimensions(filePath);
  const safeWidth = Math.max(1, dims.width || 1);
  const safeHeight = Math.max(1, dims.height || 1);
  const scale = maxDimension / Math.max(safeWidth, safeHeight);
  return {
    originalWidth: safeWidth,
    originalHeight: safeHeight,
    scale,
    width: safeWidth * scale,
    height: safeHeight * scale
  };
}

const DEFENSE_TOWER_IMAGE_METRICS = computeFixedImageDisplayMetrics(
  path.join(__dirname, 'public', 'assets', 'images', 'buildings', 'turret.png')
);

function getDefenseTowerMuzzleWorldPosition(centerX, centerY, targetX, targetY) {
  const scale = DEFENSE_TOWER_IMAGE_METRICS.scale;
  const pivotX = centerX - (DEFENSE_TOWER_IMAGE_METRICS.width / 2) + (DEFENSE_TOWER_CANNON_START.x * scale);
  const pivotY = centerY - (DEFENSE_TOWER_IMAGE_METRICS.height / 2) + (DEFENSE_TOWER_CANNON_START.y * scale);
  const aimAngle = Math.atan2(targetY - pivotY, targetX - pivotX);
  const angle = aimAngle - DEFENSE_TOWER_CANNON_BASE_ANGLE;
  const muzzleLocalX = (DEFENSE_TOWER_CANNON_MUZZLE.x - DEFENSE_TOWER_CANNON_START.x) * scale;
  const muzzleLocalY = (DEFENSE_TOWER_CANNON_MUZZLE.y - DEFENSE_TOWER_CANNON_START.y) * scale;
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  return {
    angle,
    aimAngle,
    pivotX,
    pivotY,
    originX: pivotX + (muzzleLocalX * cosAngle) - (muzzleLocalY * sinAngle),
    originY: pivotY + (muzzleLocalX * sinAngle) + (muzzleLocalY * cosAngle)
  };
}

function getBuildingCollisionSize(type) {
  if (type === 'headquarters') return IMAGE_BUILDING_BASE_COLLISION_SIZE;
  if (type === 'power_plant') return Math.round(IMAGE_BUILDING_BASE_COLLISION_SIZE * POWER_PLANT_SIZE_SCALE);
  if (type === 'shipyard' || type === 'naval_academy' || type === 'carbase') return Math.round(IMAGE_BUILDING_BASE_COLLISION_SIZE * COASTAL_BUILDING_SIZE_SCALE);
  return 200;
}

function getUnitAreaHitRadius(unit) {
  if (!unit) return 0;
  if (unit.type === 'worker' || unit.type === 'mine') return 20;
  if (unit.type === 'missile_launcher') return (MISSILE_LAUNCHER_RENDER_SIZE * MISSILE_LAUNCHER_HEIGHT_MULT) / 2;
  const baseSize = unit.type === 'frigate'
    ? 35
    : (unit.type === 'recon_aircraft'
      ? 75
      : (unit.type === 'aircraft' ? 25 : 60));
  const heightMult = isAirUnitType(unit) ? 2.5 : SHIP_HEIGHT_MULT;
  return (baseSize * heightMult) / 2;
}

function getSelectionEllipseForUnit(unit) {
  if (!unit) return { semiMajor: 0, semiMinor: 0, angle: 0 };
  const unitDef = getUnitDefinition(unit.type);
  const baseSize = unitDef?.size ?? 40;

  if (unit.type === 'worker' || unit.type === 'mine') {
    const radius = baseSize + UNIT_SELECTION_HITBOX_PADDING;
    return { semiMajor: radius, semiMinor: radius, angle: 0 };
  }

  let heightMult = isAirUnitType(unit) ? 2.5 : SHIP_HEIGHT_MULT;
  let aspectRatio = SHIP_ASPECT_RATIO;

  if (unit.type === 'battleship') {
    heightMult = BATTLESHIP_BASE_HEIGHT_MULTIPLIER;
  } else if (unit.type === 'missile_launcher') {
    heightMult = (
      unit.deployState !== 'deployed'
      && unit.deployState !== 'deploying_stage2'
      && unit.deployState !== 'undeploying_stage2'
    )
      ? MISSILE_LAUNCHER_MOBILE_HEIGHT_MULT
      : MISSILE_LAUNCHER_HEIGHT_MULT;
    aspectRatio = 0.42;
  }

  const semiMajor = (baseSize * heightMult) / 2 + UNIT_SELECTION_HITBOX_PADDING;
  const semiMinor = (baseSize * heightMult * aspectRatio) / 2 + UNIT_SELECTION_HITBOX_PADDING;
  return { semiMajor, semiMinor, angle: unit.angle || 0 };
}

function pointInRotatedEllipse(px, py, semiMajor, semiMinor, angle) {
  const cosA = Math.cos(-angle);
  const sinA = Math.sin(-angle);
  const lx = px * cosA - py * sinA;
  const ly = px * sinA + py * cosA;
  return (lx * lx) / (semiMinor * semiMinor) + (ly * ly) / (semiMajor * semiMajor);
}

function doSelectionEllipsesOverlap(unitA, ax, ay, unitB, bx, by) {
  if (!unitA || !unitB || unitA.id === unitB.id) return false;
  const eA = getSelectionEllipseForUnit(unitA);
  const eB = getSelectionEllipseForUnit(unitB);
  const dx = bx - ax;
  const dy = by - ay;
  const maxRadA = Math.max(eA.semiMajor, eA.semiMinor);
  const maxRadB = Math.max(eB.semiMajor, eB.semiMinor);
  const distSq = (dx * dx) + (dy * dy);
  if (distSq > (maxRadA + maxRadB) * (maxRadA + maxRadB)) return false;

  const valA = pointInRotatedEllipse(
    dx,
    dy,
    eA.semiMajor + eB.semiMajor,
    eA.semiMinor + eB.semiMinor,
    eA.angle
  );
  const valB = pointInRotatedEllipse(
    -dx,
    -dy,
    eB.semiMajor + eA.semiMajor,
    eB.semiMinor + eA.semiMinor,
    eB.angle
  );
  return Math.min(valA, valB) < 1.0;
}

function doSelectionEllipsesOverlapWithPadding(unitA, ax, ay, unitB, bx, by, extraPadding = 0) {
  if (!unitA || !unitB || unitA.id === unitB.id) return false;
  const padding = Math.max(0, extraPadding);
  const eA = getSelectionEllipseForUnit(unitA);
  const eB = getSelectionEllipseForUnit(unitB);
  const dx = bx - ax;
  const dy = by - ay;
  const maxRadA = Math.max(eA.semiMajor, eA.semiMinor) + padding;
  const maxRadB = Math.max(eB.semiMajor, eB.semiMinor) + padding;
  const distSq = (dx * dx) + (dy * dy);
  if (distSq > (maxRadA + maxRadB) * (maxRadA + maxRadB)) return false;

  const valA = pointInRotatedEllipse(
    dx,
    dy,
    (eA.semiMajor + padding) + (eB.semiMajor + padding),
    (eA.semiMinor + padding) + (eB.semiMinor + padding),
    eA.angle
  );
  const valB = pointInRotatedEllipse(
    -dx,
    -dy,
    (eB.semiMajor + padding) + (eA.semiMajor + padding),
    (eB.semiMinor + padding) + (eA.semiMinor + padding),
    eB.angle
  );
  return Math.min(valA, valB) < 1.0;
}

function isAirUnitType(unitOrType) {
  const type = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
  return type === 'aircraft' || type === 'recon_aircraft';
}

function isLandCombatUnitType(unitOrType) {
  const type = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
  return type === 'missile_launcher';
}

function getStoredAssaultShipUnitType(storedUnit) {
  return (storedUnit && typeof storedUnit.type === 'string')
    ? storedUnit.type
    : 'missile_launcher';
}

function getLoadedAssaultShipCargo(unit) {
  return unit && unit.type === 'assaultship' && Array.isArray(unit.loadedMissileLaunchers)
    ? unit.loadedMissileLaunchers
    : [];
}

function getLoadedMissileLauncherCount(unit) {
  return getLoadedAssaultShipCargo(unit).length;
}

function getStoredAssaultShipUnitPopulationCost(storedUnit) {
  return getUnitDefinition(getStoredAssaultShipUnitType(storedUnit)).pop || 0;
}

function canUnitBoardAssaultShip(unit) {
  if (!unit || !ASSAULT_SHIP_LOADABLE_UNIT_TYPES.has(unit.type)) return false;
  if (unit.type === 'missile_launcher') {
    return unit.deployState === 'mobile';
  }
  return unit.type === 'worker';
}

function getUnitPopulationCost(unit) {
  if (!unit) return 0;
  const basePop = getUnitDefinition(unit.type).pop || 0;
  if (unit.type !== 'assaultship') {
    return basePop;
  }
  return basePop + getLoadedAssaultShipCargo(unit).reduce((sum, storedUnit) => (
    sum + getStoredAssaultShipUnitPopulationCost(storedUnit)
  ), 0);
}

function getAssaultShipCargoKillBonus(unit) {
  if (!unit || unit.type !== 'assaultship') {
    return { score: 0, killCount: 0 };
  }
  const cargo = getLoadedAssaultShipCargo(unit);
  const score = cargo.reduce((sum, storedUnit) => (
    sum + getUnitCombatPowerValue(getStoredAssaultShipUnitType(storedUnit))
  ), 0);
  return {
    score,
    killCount: cargo.length
  };
}

function clampPlayerMaxPopulation(value) {
  if (!Number.isFinite(value)) return PLAYER_BASE_POPULATION_CAP;
  return Math.max(PLAYER_BASE_POPULATION_CAP, Math.min(PLAYER_MAX_POPULATION_CAP, Math.floor(value)));
}

function getBuildingPopulationBonus(buildingType) {
  return BUILDING_POPULATION_BONUSES[buildingType] || 0;
}

function normalizeCombatPowerBuildingType(buildingType) {
  return buildingType === 'research_lab' ? 'missile_silo' : buildingType;
}

function getUnitCombatPowerValue(unitOrType) {
  const unitType = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
  return UNIT_COMBAT_POWER_VALUES[unitType] || 0;
}

function getBuildingCombatPowerValue(buildingOrType) {
  const buildingType = normalizeCombatPowerBuildingType(
    typeof buildingOrType === 'string' ? buildingOrType : buildingOrType?.type
  );
  if (GENERAL_BUILDING_TYPES.has(buildingType)) return GENERAL_BUILDING_COMBAT_POWER;
  if (ADVANCED_BUILDING_TYPES.has(buildingType)) return ADVANCED_BUILDING_COMBAT_POWER;
  return 0;
}

function getCombatPowerRewardForTarget(target, targetType) {
  if (targetType === 'slbm') return getUnitCombatPowerValue('slbm');
  if (targetType === 'building') return getBuildingCombatPowerValue(target);
  return getUnitCombatPowerValue(target);
}

function getPlayerScoreFromKills(player) {
  if (!player) return 0;
  return Number.isFinite(player.scoreFromKills) ? Math.max(0, Math.floor(player.scoreFromKills)) : 0;
}

function awardCombatScore(playerOrUserId, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const player = typeof playerOrUserId === 'object'
    ? playerOrUserId
    : gameState.players.get(playerOrUserId);
  if (!player) return;
  player.scoreFromKills = getPlayerScoreFromKills(player) + Math.floor(amount);
  player.score = calculatePlayerScore(player);
}

function recalculateAllPlayerCombatPowerAndScores() {
  const combatPowerByUserId = new Map();
  gameState.players.forEach((_, userId) => {
    combatPowerByUserId.set(userId, 0);
  });

  gameState.units.forEach(unit => {
    if (!unit || unit.hp <= 0) return;
    const userId = unit.userId;
    if (userId == null) return;
    combatPowerByUserId.set(
      userId,
      (combatPowerByUserId.get(userId) || 0) + getUnitCombatPowerValue(unit)
    );
  });

  gameState.buildings.forEach(building => {
    if (!building || building.hp <= 0 || building.buildProgress < 100) return;
    const userId = building.userId;
    if (userId == null) return;
    combatPowerByUserId.set(
      userId,
      (combatPowerByUserId.get(userId) || 0) + getBuildingCombatPowerValue(building)
    );
  });

  gameState.activeSlbms.forEach(slbm => {
    if (!slbm || slbm.userId == null) return;
    combatPowerByUserId.set(
      slbm.userId,
      (combatPowerByUserId.get(slbm.userId) || 0) + getUnitCombatPowerValue('slbm')
    );
  });

  gameState.players.forEach(player => {
    const missileCombatPower = Math.max(0, Math.floor(player.missiles || 0)) * getUnitCombatPowerValue('slbm');
    player.combatPower = (combatPowerByUserId.get(player.userId) || 0) + missileCombatPower;
    player.score = calculatePlayerScore(player);
  });
}

function getCompletedOwnedBuildingCount(userId, type) {
  let count = 0;
  gameState.buildings.forEach(building => {
    if (building.userId === userId && building.type === type && building.buildProgress >= 100) {
      count++;
    }
  });
  return count;
}

function canBuildCarbaseForUser(userId) {
  return CARBASE_PREREQ_BUILDINGS.every(type => getCompletedOwnedBuildingCount(userId, type) >= 2);
}

function canAcceptPlayerOrders(unit) {
  return !!unit && !isAirUnitType(unit);
}

function createAssaultShipCargoPayload(unit) {
  const unitType = unit?.type || 'missile_launcher';
  const unitDef = getUnitDefinition(unitType);
  return {
    type: unitType,
    hp: normalizeEntityHpValue(unit.hp || unitDef.hp, unit.maxHp || unitDef.hp, 1),
    maxHp: Math.max(1, Math.round(unit.maxHp || unitDef.hp)),
    kills: unit.kills || 0
  };
}

function createMissileLauncherUnit(userId, spawnPoint, overrides = {}) {
  const unitConfig = getUnitDefinition('missile_launcher');
  return {
    id: createUniqueEntityId(500),
    userId,
    type: 'missile_launcher',
    x: spawnPoint.x,
    y: spawnPoint.y,
    hp: overrides.hp ?? unitConfig.hp,
    maxHp: overrides.maxHp ?? unitConfig.hp,
    damage: unitConfig.damage,
    speed: unitConfig.speed,
    attackRange: unitConfig.attackRange,
    attackCooldownMs: unitConfig.attackCooldownMs,
    targetX: null,
    targetY: null,
    gatheringResourceId: null,
    buildingType: null,
    buildTargetX: null,
    buildTargetY: null,
    isDetected: false,
    kills: overrides.kills || 0,
    deployState: 'mobile',
    deployStateEndsAt: null
  };
}

function createAssaultShipCargoUnit(userId, spawnPoint, cargo = {}) {
  const unitType = getStoredAssaultShipUnitType(cargo);
  if (unitType === 'missile_launcher') {
    return createMissileLauncherUnit(userId, spawnPoint, cargo);
  }
  if (unitType === 'worker') {
    return createWorkerUnit(userId, spawnPoint, cargo);
  }
  return null;
}

function createWorkerUnit(userId, spawnPoint, overrides = {}) {
  const unitConfig = getUnitDefinition('worker');
  return {
    id: createUniqueEntityId(450),
    userId,
    type: 'worker',
    x: spawnPoint.x,
    y: spawnPoint.y,
    hp: overrides.hp ?? unitConfig.hp,
    maxHp: overrides.maxHp ?? unitConfig.hp,
    damage: unitConfig.damage,
    speed: unitConfig.speed,
    attackRange: unitConfig.attackRange,
    attackCooldownMs: unitConfig.attackCooldownMs,
    targetX: null,
    targetY: null,
    gatheringResourceId: null,
    buildingType: null,
    buildTargetX: null,
    buildTargetY: null,
    isDetected: false,
    kills: overrides.kills || 0
  };
}

function spawnStartingWorkers(userId, centerX, centerY, count = STARTING_WORKER_COUNT) {
  const spawnedWorkers = [];
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / Math.max(1, count);
    const distance = 150;
    const worker = createWorkerUnit(userId, {
      x: centerX + Math.cos(angle) * distance,
      y: centerY + Math.sin(angle) * distance
    });
    gameState.units.set(worker.id, worker);
    spawnedWorkers.push(worker);
  }
  return spawnedWorkers;
}

function getAssaultShipCargoSpawnSize(cargo) {
  const unitType = getStoredAssaultShipUnitType(cargo);
  return unitType === 'worker'
    ? (getUnitDefinition('worker').size || 40)
    : MISSILE_LAUNCHER_RENDER_SIZE;
}

function normalizeEntityHpValue(value, maxHp = Number.POSITIVE_INFINITY, minimumHp = 0) {
  if (!Number.isFinite(value)) return minimumHp;
  const roundedValue = value > minimumHp ? Math.ceil(value) : Math.floor(value);
  const normalizedMaxHp = Number.isFinite(maxHp)
    ? Math.max(minimumHp, Math.round(maxHp))
    : Number.POSITIVE_INFINITY;
  return Math.max(minimumHp, Math.min(normalizedMaxHp, roundedValue));
}

function normalizeIntegerDelta(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.round(value));
}

function applyDamageToEntity(target, damage, now = Date.now(), minimumHp = 0) {
  if (!target) return 0;
  const currentHp = normalizeEntityHpValue(target.hp, target.maxHp, 0);
  const appliedDamage = normalizeIntegerDelta(damage);
  const nextHp = appliedDamage > 0
    ? Math.max(minimumHp, currentHp - appliedDamage)
    : currentHp;
  target.hp = nextHp;
  target.lastDamageTime = now;
  return currentHp - nextHp;
}

function applyHealingToEntity(target, amount) {
  if (!target) return 0;
  const currentHp = normalizeEntityHpValue(target.hp, target.maxHp, 0);
  const healedAmount = normalizeIntegerDelta(amount);
  const maxHp = Number.isFinite(target.maxHp)
    ? Math.max(0, Math.round(target.maxHp))
    : currentHp;
  const nextHp = healedAmount > 0
    ? Math.min(maxHp, currentHp + healedAmount)
    : currentHp;
  target.hp = nextHp;
  return nextHp - currentHp;
}

function getAdjustedUnitDamage(target, damage) {
  let adjustedDamage = damage;
  if (!target) return normalizeIntegerDelta(adjustedDamage);
  if (target.type === 'assaultship') {
    adjustedDamage *= 0.8;
  }
  if (target.type === 'battleship' && target.battleshipAegisMode) {
    adjustedDamage *= BATTLESHIP_AEGIS_TAKEN_DAMAGE_MULTIPLIER;
  }
  return normalizeIntegerDelta(adjustedDamage);
}

function registerUnitKill(attacker) {
  if (!attacker) return;
  attacker.kills = Math.max(0, attacker.kills || 0) + 1;

  if (attacker.type === 'aircraft' && attacker.carrierId) {
    const carrier = gameState.units.get(attacker.carrierId);
    if (carrier && carrier.userId === attacker.userId && carrier.type === 'carrier') {
      carrier.kills = Math.max(0, carrier.kills || 0) + 1;
    }
  } else if (attacker.type === 'recon_aircraft' && attacker.sourceCarrierId) {
    const carrier = gameState.units.get(attacker.sourceCarrierId);
    if (carrier && carrier.userId === attacker.userId && carrier.type === 'carrier') {
      carrier.kills = Math.max(0, carrier.kills || 0) + 1;
    }
  }
}

function registerCarrierKill(carrierId, userId) {
  const carrier = gameState.units.get(carrierId);
  if (!carrier || carrier.type !== 'carrier' || carrier.userId !== userId) return;
  carrier.kills = Math.max(0, carrier.kills || 0) + 1;
}

function computePercentSelfDamage(value, ratio) {
  return Math.max(1, Math.ceil(Math.max(0, value) * ratio));
}

function computeCurrentHpSelfDamage(unit, ratio) {
  const currentHp = normalizeEntityHpValue(unit?.hp || 0, unit?.maxHp, 0);
  if (currentHp <= 1) return 0;
  return Math.min(computePercentSelfDamage(currentHp, ratio), currentHp - 1);
}

// Combat stance stops getting faster once the minimum attack cooldown is reached.
function getBattleshipCombatStanceMaxStacks(unit) {
  const baseCooldown = Math.max(
    BATTLESHIP_COMBAT_STANCE_MIN_ATTACK_COOLDOWN_MS,
    getUnitBaseAttackCooldown(unit)
  );
  if (baseCooldown <= BATTLESHIP_COMBAT_STANCE_MIN_ATTACK_COOLDOWN_MS) return 0;
  const rawStacks = Math.log(baseCooldown / BATTLESHIP_COMBAT_STANCE_MIN_ATTACK_COOLDOWN_MS)
    / Math.log(BATTLESHIP_COMBAT_STANCE_ATTACK_SPEED_MULTIPLIER);
  return Math.max(0, Math.ceil(rawStacks - 1e-9));
}

function clampBattleshipCombatStanceStacks(unit) {
  const clampedStacks = Math.min(
    getBattleshipCombatStanceMaxStacks(unit),
    Math.max(0, Math.floor(unit?.combatStanceStacks || 0))
  );
  if (unit && unit.type === 'battleship') {
    unit.combatStanceStacks = clampedStacks;
  }
  return clampedStacks;
}

function getUnitBaseAttackCooldown(unit) {
  return unit?.baseAttackCooldownMs ?? getUnitDefinition(unit?.type).attackCooldownMs ?? unit?.attackCooldownMs ?? 1000;
}

function getUnitBaseSpeed(unit) {
  return unit?.baseSpeed ?? getUnitDefinition(unit?.type).speed ?? unit?.speed ?? 0;
}

function getUnitBaseAttackRange(unit) {
  return unit?.baseAttackRange ?? getUnitDefinition(unit?.type).attackRange ?? unit?.attackRange ?? 0;
}

function normalizeStoredSlbmCount(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function getSubmarineLoadedSlbmCount(unit) {
  return unit && unit.type === 'submarine'
    ? normalizeStoredSlbmCount(unit.loadedSlbms)
    : 0;
}

function getStoredSlbmCountForBuilding(building) {
  return building && building.type === 'missile_silo'
    ? normalizeStoredSlbmCount(building.slbmCount)
    : 0;
}

function updatePlayerMissileStock(userId, delta) {
  const player = gameState.players.get(userId);
  if (!player || !Number.isFinite(delta) || delta === 0) return 0;
  player.missiles = Math.max(0, normalizeStoredSlbmCount(player.missiles) + Math.trunc(delta));
  return player.missiles;
}

function removeStoredSlbmsFromUnit(unit) {
  const storedCount = getSubmarineLoadedSlbmCount(unit);
  if (storedCount <= 0) return 0;
  unit.loadedSlbms = 0;
  updatePlayerMissileStock(unit.userId, -storedCount);
  return storedCount;
}

function removeStoredSlbmsFromBuilding(building) {
  const storedCount = getStoredSlbmCountForBuilding(building);
  if (storedCount <= 0) return 0;
  building.slbmCount = 0;
  updatePlayerMissileStock(building.userId, -storedCount);
  return storedCount;
}

function recalculatePlayerMissileStock(userId) {
  const player = gameState.players.get(userId);
  if (!player) return 0;
  let total = 0;
  gameState.units.forEach(unit => {
    if (unit.userId === userId && unit.type === 'submarine') {
      total += getSubmarineLoadedSlbmCount(unit);
    }
  });
  gameState.buildings.forEach(building => {
    if (building.userId === userId && building.type === 'missile_silo') {
      total += getStoredSlbmCountForBuilding(building);
    }
  });
  player.missiles = total;
  return total;
}

function canUnitUseBattleshipModeCombo(unit) {
  return !!(unit && unit.type === 'battleship' && unit.battleshipModeComboUnlocked);
}

function canUsernameUseYamatoBattleshipSkin(username) {
  return !!(username && YAMATO_BATTLESHIP_SKIN_ALLOWED_USERNAMES.has(username));
}

function canUserIdUseYamatoBattleshipSkin(userId) {
  if (userId == null) return false;
  const player = gameState.players.get(userId);
  return !!(player && canUsernameUseYamatoBattleshipSkin(player.username));
}

function isExcludedFromAITrainingDataCollection(player) {
  return !!(
    player &&
    !player.isAI &&
    player.online !== false &&
    AI_TRAINING_DATA_EXCLUDED_USERNAMES.has(player.username)
  );
}

function shouldCollectLiveAITrainingData(state = gameState) {
  if (!state || !state.players) return true;
  for (const player of state.players.values()) {
    if (isExcludedFromAITrainingDataCollection(player)) {
      return false;
    }
  }
  return true;
}

function resetPlayerRLTransitionMemory(player) {
  if (!player) return;
  delete player._prevRLState;
  delete player._prevRLAction;
  delete player._prevRLSnapshot;
}

function enforceBattleshipModeCompatibility(unit) {
  if (!unit || unit.type !== 'battleship') return;
  if (unit.combatStanceActive && unit.battleshipAegisMode && !canUnitUseBattleshipModeCombo(unit)) {
    unit.combatStanceActive = false;
    unit.combatStanceStacks = 0;
  }
}

function getFrigateEngineOverdriveEvasionChance(unit) {
  if (!unit || unit.type !== 'frigate' || !unit.engineOverdriveActive) return 0;
  const maxHp = Math.max(1, unit.maxHp || getUnitDefinition('frigate').hp);
  const missingRatio = Math.max(0, 1 - ((unit.hp || 0) / maxHp));
  return Math.min(FRIGATE_ENGINE_OVERDRIVE_MAX_EVASION, missingRatio);
}

function refreshBattleshipCombatStance(unit) {
  if (!unit || unit.type !== 'battleship') return;
  const baseCooldown = getUnitBaseAttackCooldown(unit);
  const stanceActive = !!unit.combatStanceActive;
  const stacks = stanceActive ? clampBattleshipCombatStanceStacks(unit) : 0;
  if (!stanceActive && unit.combatStanceStacks) {
    unit.combatStanceStacks = 0;
  }
  unit.attackCooldownMs = stanceActive
    ? Math.max(
      BATTLESHIP_COMBAT_STANCE_MIN_ATTACK_COOLDOWN_MS,
      Math.round(baseCooldown / Math.pow(BATTLESHIP_COMBAT_STANCE_ATTACK_SPEED_MULTIPLIER, stacks))
    )
    : baseCooldown;
}

function noteBattleshipCombatActivity(unit, now = Date.now()) {
  if (!unit || unit.type !== 'battleship') return;
  unit.lastBattleshipCombatAt = now;
  unit.lastCombatStanceDecayAt = now;
}

function updateBattleshipCombatStanceDecay(unit, now = Date.now(), inCombat = false) {
  if (!unit || unit.type !== 'battleship') return;
  if (!unit.combatStanceActive) {
    unit.lastCombatStanceDecayAt = 0;
    return;
  }
  if (inCombat) {
    noteBattleshipCombatActivity(unit, now);
    return;
  }

  const lastCombatAt = Number.isFinite(unit.lastBattleshipCombatAt) && unit.lastBattleshipCombatAt > 0
    ? unit.lastBattleshipCombatAt
    : (Number.isFinite(unit.lastAttackTime) ? unit.lastAttackTime : now);
  const decayWindowStartAt = lastCombatAt + BATTLESHIP_COMBAT_STANCE_DECAY_DELAY_MS;
  if (now < decayWindowStartAt) {
    return;
  }

  const currentStacks = clampBattleshipCombatStanceStacks(unit);
  if (currentStacks <= 0) {
    unit.combatStanceActive = false;
    unit.lastCombatStanceDecayAt = decayWindowStartAt;
    refreshBattleshipModeState(unit);
    return;
  }

  const lastDecayAt = Number.isFinite(unit.lastCombatStanceDecayAt) && unit.lastCombatStanceDecayAt >= decayWindowStartAt
    ? unit.lastCombatStanceDecayAt
    : decayWindowStartAt;
  const decaySteps = Math.floor((now - lastDecayAt) / BATTLESHIP_COMBAT_STANCE_DECAY_INTERVAL_MS);
  if (decaySteps <= 0) {
    return;
  }

  const nextStacks = Math.max(0, currentStacks - decaySteps);
  unit.combatStanceStacks = nextStacks;
  unit.lastCombatStanceDecayAt = lastDecayAt + (decaySteps * BATTLESHIP_COMBAT_STANCE_DECAY_INTERVAL_MS);
  if (nextStacks <= 0) {
    unit.combatStanceActive = false;
  }
  refreshBattleshipModeState(unit);
}

function refreshBattleshipAegisState(unit) {
  if (!unit || unit.type !== 'battleship') return;
  const baseRange = getUnitBaseAttackRange(unit);
  unit.attackRange = unit.battleshipAegisMode
    ? Math.round(baseRange * BATTLESHIP_AEGIS_RANGE_MULTIPLIER)
    : baseRange;
}

function refreshBattleshipModeState(unit) {
  if (!unit || unit.type !== 'battleship') return;
  enforceBattleshipModeCompatibility(unit);
  refreshBattleshipCombatStance(unit);
  refreshBattleshipAegisState(unit);
}

function refreshFrigateEngineOverdrive(unit) {
  if (!unit || unit.type !== 'frigate') return;
  const baseSpeed = getUnitBaseSpeed(unit);
  const boostedSpeed = unit.engineOverdriveActive
    ? (baseSpeed * FRIGATE_ENGINE_OVERDRIVE_SPEED_MULTIPLIER)
    : baseSpeed;
  const squad = getUnitSquad(unit);
  const squadSpeedCap = squad ? getSquadSlowestSpeed(squad) : null;
  unit.speed = Number.isFinite(squadSpeedCap)
    ? Math.min(boostedSpeed, squadSpeedCap)
    : boostedSpeed;
  unit.evasionChance = getFrigateEngineOverdriveEvasionChance(unit);
}

function getBattleshipAegisTurretCooldownMs(unit) {
  const baseAttackCooldown = Math.max(1, getUnitBaseAttackCooldown(unit));
  const currentAttackCooldown = Math.max(
    BATTLESHIP_COMBAT_STANCE_MIN_ATTACK_COOLDOWN_MS,
    Number.isFinite(unit?.attackCooldownMs) ? unit.attackCooldownMs : baseAttackCooldown
  );
  const minTurretCooldown = Math.max(
    1,
    Math.round(BATTLESHIP_AEGIS_TURRET_COOLDOWN_MS * (BATTLESHIP_COMBAT_STANCE_MIN_ATTACK_COOLDOWN_MS / baseAttackCooldown))
  );
  return Math.max(
    minTurretCooldown,
    Math.round(BATTLESHIP_AEGIS_TURRET_COOLDOWN_MS * (currentAttackCooldown / baseAttackCooldown))
  );
}

function applyBattleshipCombatStanceAttackCost(unit, now = Date.now()) {
  if (!unit || unit.type !== 'battleship' || !unit.combatStanceActive || !gameState.units.has(unit.id)) {
    return false;
  }
  const stanceDamage = computeCurrentHpSelfDamage(unit, BATTLESHIP_COMBAT_STANCE_HP_COST_RATIO);
  if (stanceDamage <= 0) {
    return false;
  }
  unit.combatStanceStacks = Math.min(
    getBattleshipCombatStanceMaxStacks(unit),
    clampBattleshipCombatStanceStacks(unit) + 1
  );
  noteBattleshipCombatActivity(unit, now);
  refreshBattleshipModeState(unit);
  return applyUnitSelfDamage(unit, stanceDamage, now);
}

function initializeUnitRuntimeState(unit) {
  if (!unit) return unit;
  const unitConfig = getUnitDefinition(unit.type);
  if (!Number.isFinite(unit.baseAttackCooldownMs)) {
    unit.baseAttackCooldownMs = unitConfig.attackCooldownMs;
  }
  if (!Number.isFinite(unit.baseSpeed)) {
    unit.baseSpeed = unitConfig.speed;
  }
  if (!Number.isFinite(unit.baseAttackRange)) {
    unit.baseAttackRange = unitConfig.attackRange;
  }
  if (usesNavalContactCollision(unit)) {
    unit.navalAvoidanceSideBias = unit.navalAvoidanceSideBias === -1 ? -1 : (unit.navalAvoidanceSideBias === 1 ? 1 : null);
    unit.navalBlockedTicks = Math.max(0, Math.floor(unit.navalBlockedTicks || 0));
    unit.navalNoProgressTicks = Math.max(0, Math.floor(unit.navalNoProgressTicks || 0));
    unit.navalLastRepathAt = Number.isFinite(unit.navalLastRepathAt) ? unit.navalLastRepathAt : 0;
  }
  if (unit.type === 'battleship') {
    if (unit.battleshipSkinVariant !== 'yamato' && unit.battleshipSkinVariant !== 'default') {
      unit.battleshipSkinVariant = canUserIdUseYamatoBattleshipSkin(unit.userId) ? 'yamato' : 'default';
    }
    unit.combatStanceActive = !!unit.combatStanceActive;
    unit.combatStanceStacks = clampBattleshipCombatStanceStacks(unit);
    unit.lastBattleshipCombatAt = Number.isFinite(unit.lastBattleshipCombatAt)
      ? unit.lastBattleshipCombatAt
      : (Number.isFinite(unit.lastAttackTime) ? unit.lastAttackTime : 0);
    unit.lastCombatStanceDecayAt = Number.isFinite(unit.lastCombatStanceDecayAt)
      ? unit.lastCombatStanceDecayAt
      : 0;
    unit.battleshipAegisMode = !!unit.battleshipAegisMode;
    unit.battleshipModeComboUnlocked = !!unit.battleshipModeComboUnlocked;
    if (!Array.isArray(unit.battleshipAegisTurretCooldowns) || unit.battleshipAegisTurretCooldowns.length !== BATTLESHIP_AEGIS_TURRET_COUNT) {
      unit.battleshipAegisTurretCooldowns = Array.from({ length: BATTLESHIP_AEGIS_TURRET_COUNT }, () => 0);
    } else {
      unit.battleshipAegisTurretCooldowns = unit.battleshipAegisTurretCooldowns.map(value => Number.isFinite(value) ? value : 0);
    }
    if (!Array.isArray(unit.battleshipAegisTurretTargetLocks) || unit.battleshipAegisTurretTargetLocks.length !== BATTLESHIP_AEGIS_TURRET_COUNT) {
      unit.battleshipAegisTurretTargetLocks = Array.from({ length: BATTLESHIP_AEGIS_TURRET_COUNT }, () => null);
    } else {
      unit.battleshipAegisTurretTargetLocks = unit.battleshipAegisTurretTargetLocks.map(lock => (
        lock && lock.targetId != null && (lock.targetType === 'unit' || lock.targetType === 'building')
          ? { targetId: lock.targetId, targetType: lock.targetType }
          : null
      ));
    }
    refreshBattleshipModeState(unit);
  }
  if (unit.type === 'frigate') {
    unit.engineOverdriveActive = !!unit.engineOverdriveActive;
    unit.engineOverdriveLastTickAt = Number.isFinite(unit.engineOverdriveLastTickAt) ? unit.engineOverdriveLastTickAt : null;
    if (!unit.squadId) {
      refreshFrigateEngineOverdrive(unit);
    }
  }
  if (unit.type === 'submarine') {
    unit.loadedSlbms = getSubmarineLoadedSlbmCount(unit);
    if (!unit.stealthActive) {
      unit.stealthActive = false;
      unit.isDetected = true;
    }
    if (!Number.isFinite(unit.stealthExpiresAt)) unit.stealthExpiresAt = 0;
    if (!Number.isFinite(unit.stealthCooldownUntil)) unit.stealthCooldownUntil = 0;
    unit.slbmReloadReadyAt = Number.isFinite(unit.slbmReloadReadyAt)
      ? Math.max(0, Math.floor(unit.slbmReloadReadyAt))
      : 0;
  }
  return unit;
}

function destroyUnitFromGame(unit) {
  if (!unit || !gameState.units.has(unit.id)) return false;
  removeStoredSlbmsFromUnit(unit);
  const targetOwner = gameState.players.get(unit.userId);
  if (targetOwner) {
    const popCost = getUnitPopulationCost(unit);
    targetOwner.population = Math.max(0, targetOwner.population - popCost);
  }
  if (isNavalUnitType(unit.type)) {
    emitUnitDestroyedEvent(unit);
  }
  gameState.units.delete(unit.id);
  return true;
}

function destroyBuildingFromGame(building, options = {}) {
  const {
    emitEvent = true,
    awardCombatScoreTo = null,
    attackerUserId = null
  } = options;
  if (!building || !gameState.buildings.has(building.id)) return false;
  removeStoredSlbmsFromBuilding(building);
  if (emitEvent) {
    emitBuildingDestroyedEvent(building);
  }
  gameState.buildings.delete(building.id);
  if (awardCombatScoreTo != null) {
    awardCombatScore(awardCombatScoreTo, getCombatPowerRewardForTarget(building, 'building'));
  }
  if (attackerUserId != null) {
    checkPlayerDefeat(building.userId, attackerUserId);
  }
  return true;
}

function applyUnitSelfDamage(unit, damage, now = Date.now()) {
  if (!unit || !gameState.units.has(unit.id)) return true;
  const currentHp = normalizeEntityHpValue(unit.hp || 0, unit.maxHp, 0);
  if (currentHp <= 0) {
    destroyUnitFromGame(unit);
    return true;
  }
  unit.hp = currentHp;
  const appliedDamage = normalizeIntegerDelta(damage);
  if (appliedDamage <= 0) {
    if (unit.type === 'frigate') {
      refreshFrigateEngineOverdrive(unit);
    }
    return false;
  }
  applyDamageToEntity(unit, appliedDamage, now, 1);
  if (unit.type === 'frigate') {
    refreshFrigateEngineOverdrive(unit);
  }
  return false;
}

function doesUnitEvadeDirectAttack(unit) {
  const chance = getFrigateEngineOverdriveEvasionChance(unit);
  if (unit && unit.type === 'frigate') {
    unit.evasionChance = chance;
  }
  return chance > 0 && Math.random() < chance;
}

function recordAiUnitAttackResponse(target, attackerUnit, now = Date.now()) {
  if (!target || !attackerUnit || target.userId >= 0) return;
  if (!target.recentAttackers) target.recentAttackers = [];
  target.recentAttackers.push({
    attackerId: attackerUnit.userId,
    attackerUnitId: attackerUnit.id,
    attackX: attackerUnit.x,
    attackY: attackerUnit.y,
    timestamp: now
  });
  const aiPlayer = gameState.players.get(target.userId);
  if (aiPlayer && aiPlayer.isAI) {
    if (!aiPlayer.recentAttackLocations) aiPlayer.recentAttackLocations = [];
    aiPlayer.recentAttackLocations.push({
      x: target.x,
      y: target.y,
      attackerId: attackerUnit.userId,
      timestamp: now
    });
  }
}

function destroyCombatTargetByUnit(attackerUnit, target, targetType) {
  const attacker = gameState.players.get(attackerUnit.userId);

  if (targetType === 'slbm') {
    emitSlbmDestroyedEvent({ id: target.id, x: target.currentX, y: target.currentY, userId: target.userId });
    gameState.activeSlbms.delete(target.id);
    awardCombatScore(attacker, getCombatPowerRewardForTarget(target, 'slbm'));
    registerUnitKill(attackerUnit);
    return;
  }

  if (targetType === 'unit') {
    const cargoBonus = getAssaultShipCargoKillBonus(target);
    destroyUnitFromGame(target);
    awardCombatScore(attacker, getCombatPowerRewardForTarget(target, 'unit') + cargoBonus.score);
    const totalKillCredit = 1 + cargoBonus.killCount;
    for (let i = 0; i < totalKillCredit; i++) {
      registerUnitKill(attackerUnit);
    }
    return;
  }

  emitBuildingDestroyedEvent(target);
  destroyBuildingFromGame(target, {
    emitEvent: false,
    awardCombatScoreTo: attacker,
    attackerUserId: attackerUnit.userId
  });
}

function collectBattleshipAegisTargets(unit, combatRange, primaryTarget, primaryTargetType, combatUnitSpatialIndex, combatBuildingSpatialIndex) {
  const candidates = [];
  const seen = new Set();
  const rangeSq = combatRange * combatRange;

  const pushCandidate = (entity, type, priority) => {
    if (!entity) return;
    if (type === 'unit') {
      if (!gameState.units.has(entity.id) || entity.id === unit.id || entity.userId === unit.userId) return;
      if ((entity.type === 'submarine' || entity.type === 'mine') && !entity.isDetected) return;
    } else if (type === 'building') {
      if (!gameState.buildings.has(entity.id) || entity.userId === unit.userId) return;
    } else {
      return;
    }

    const dx = entity.x - unit.x;
    const dy = entity.y - unit.y;
    const distSq = (dx * dx) + (dy * dy);
    if (distSq > rangeSq) return;

    const key = `${type}:${entity.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ entity, type, distSq, key, priority });
  };

  if (primaryTarget && primaryTargetType !== 'slbm') {
    pushCandidate(primaryTarget, primaryTargetType, 0);
  }

  forEachNearbyEntity(combatUnitSpatialIndex, unit.x, unit.y, combatRange, enemy => {
    pushCandidate(enemy, 'unit', 1);
  });

  forEachNearbyEntity(combatBuildingSpatialIndex, unit.x, unit.y, combatRange, enemy => {
    pushCandidate(enemy, 'building', 2);
  });

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.distSq !== b.distSq) return a.distSq - b.distSq;
    return a.entity.id - b.entity.id;
  });

  return candidates;
}

function pickBattleshipAegisTarget(unit, combatRange, primaryTarget, primaryTargetType, usedTargetKeys, combatUnitSpatialIndex, combatBuildingSpatialIndex) {
  const candidates = collectBattleshipAegisTargets(
    unit,
    combatRange,
    primaryTarget,
    primaryTargetType,
    combatUnitSpatialIndex,
    combatBuildingSpatialIndex
  );
  if (candidates.length <= 0) return null;
  const uniqueCandidate = candidates.find(candidate => !usedTargetKeys.has(candidate.key));
  return uniqueCandidate || candidates[0];
}

function getBattleshipAegisLockKey(lock) {
  if (!lock || lock.targetId == null || !lock.targetType) return null;
  return `${lock.targetType}:${lock.targetId}`;
}

function createBattleshipAegisTargetLock(target, targetType) {
  if (!target || target.id == null || !targetType) return null;
  return { targetId: target.id, targetType };
}

function selectBattleshipAegisTargetsForReadyTurrets(unit, candidates, readyTurretIndices, primaryTarget, primaryTargetType) {
  const assignments = new Map();
  if (!unit || candidates.length <= 0 || readyTurretIndices.length <= 0) return assignments;

  const candidateByKey = new Map(candidates.map(candidate => [candidate.key, candidate]));
  const remainingTurretIndices = readyTurretIndices.slice();
  const usedKeys = new Set();

  let anchorKey = null;
  if (primaryTarget && primaryTargetType && primaryTargetType !== 'slbm') {
    const primaryKey = `${primaryTargetType}:${primaryTarget.id}`;
    if (candidateByKey.has(primaryKey)) {
      anchorKey = primaryKey;
    }
  }
  if (!anchorKey) {
    const lockedAnchor = remainingTurretIndices
      .map(turretIndex => getBattleshipAegisLockKey(unit.battleshipAegisTurretTargetLocks[turretIndex]))
      .find(lockKey => lockKey && candidateByKey.has(lockKey));
    if (lockedAnchor) {
      anchorKey = lockedAnchor;
    }
  }
  if (!anchorKey) {
    anchorKey = candidates[0].key;
  }

  const assignTurret = (turretIndex, candidate) => {
    if (!candidate) return false;
    assignments.set(turretIndex, candidate);
    const remainingIndex = remainingTurretIndices.indexOf(turretIndex);
    if (remainingIndex >= 0) {
      remainingTurretIndices.splice(remainingIndex, 1);
    }
    usedKeys.add(candidate.key);
    return true;
  };

  const anchorCandidate = candidateByKey.get(anchorKey) || candidates[0];
  if (anchorCandidate) {
    const anchorTurretIndex = remainingTurretIndices.find(turretIndex => (
      getBattleshipAegisLockKey(unit.battleshipAegisTurretTargetLocks[turretIndex]) === anchorCandidate.key
    )) ?? remainingTurretIndices[0];
    assignTurret(anchorTurretIndex, anchorCandidate);
  }

  readyTurretIndices.forEach(turretIndex => {
    if (assignments.has(turretIndex)) return;
    const lockKey = getBattleshipAegisLockKey(unit.battleshipAegisTurretTargetLocks[turretIndex]);
    if (!lockKey || lockKey === anchorKey || usedKeys.has(lockKey)) return;
    const lockedCandidate = candidateByKey.get(lockKey);
    if (lockedCandidate) {
      assignTurret(turretIndex, lockedCandidate);
    }
  });

  readyTurretIndices.forEach(turretIndex => {
    if (assignments.has(turretIndex)) return;
    const uniqueCandidate = candidates.find(candidate => !usedKeys.has(candidate.key));
    if (uniqueCandidate) {
      assignTurret(turretIndex, uniqueCandidate);
    }
  });

  const fallbackCandidate = anchorCandidate || candidates[0];
  readyTurretIndices.forEach(turretIndex => {
    if (!assignments.has(turretIndex) && fallbackCandidate) {
      assignments.set(turretIndex, fallbackCandidate);
    }
  });

  return assignments;
}

function processBattleshipAegisAttacks(
  unit,
  primaryTarget,
  primaryTargetType,
  combatRange,
  combatUnitSpatialIndex,
  combatBuildingSpatialIndex,
  now = Date.now()
) {
  initializeUnitRuntimeState(unit);

  if (primaryTarget && (unit.attackTargetId || unit.attackMove) && !unit.holdPosition) {
    const primaryTargetX = primaryTargetType === 'slbm' ? primaryTarget.currentX : primaryTarget.x;
    const primaryTargetY = primaryTargetType === 'slbm' ? primaryTarget.currentY : primaryTarget.y;
    const dx = primaryTargetX - unit.x;
    const dy = primaryTargetY - unit.y;
    if (Math.sqrt((dx * dx) + (dy * dy)) > combatRange) {
      assignMoveTarget(unit, primaryTargetX, primaryTargetY);
    }
  }

  const turretCooldownMs = getBattleshipAegisTurretCooldownMs(unit);
  const readyTurretIndices = [];
  for (let turretIndex = 0; turretIndex < unit.battleshipAegisTurretCooldowns.length; turretIndex++) {
    const lastFireAt = unit.battleshipAegisTurretCooldowns[turretIndex];
    if (!lastFireAt || (now - lastFireAt) >= turretCooldownMs) {
      readyTurretIndices.push(turretIndex);
    }
  }
  if (readyTurretIndices.length <= 0) return;

  const candidates = collectBattleshipAegisTargets(
    unit,
    combatRange,
    primaryTarget,
    primaryTargetType,
    combatUnitSpatialIndex,
    combatBuildingSpatialIndex
  );
  if (candidates.length <= 0) return;

  const assignments = selectBattleshipAegisTargetsForReadyTurrets(
    unit,
    candidates,
    readyTurretIndices,
    primaryTarget,
    primaryTargetType
  );
  const shotPlans = [];
  for (let i = 0; i < readyTurretIndices.length; i++) {
    const turretIndex = readyTurretIndices[i];
    const selectedTarget = assignments.get(turretIndex);
    if (!selectedTarget) continue;

    const { entity: target, type: targetType, key: targetKey } = selectedTarget;
    shotPlans.push({
      turretIndex,
      target,
      targetType,
      targetKey,
      targetId: target.id,
      targetUserId: target.userId,
      targetX: target.x,
      targetY: target.y
    });
    unit.battleshipAegisTurretCooldowns[turretIndex] = now;
    unit.battleshipAegisTurretTargetLocks[turretIndex] = createBattleshipAegisTargetLock(target, targetType);
  }

  if (shotPlans.length <= 0) return;

  unit.lastAttackTime = now;
  emitBattleshipAegisProjectileBurst(unit, shotPlans, now);

  const damagePlans = new Map();
  for (let i = 0; i < shotPlans.length; i++) {
    const shotPlan = shotPlans[i];
    const { target, targetType, targetKey } = shotPlan;

    let targetEvaded = false;
    if (targetType === 'unit') {
      targetEvaded = doesUnitEvadeDirectAttack(target);
    }
    if (targetEvaded) continue;

    let damage = BATTLESHIP_AEGIS_DAMAGE;
    if (targetType === 'unit' && target.type === 'cruiser') {
      if (target.aegisMode) {
        damage *= 0.7;
      }
      if (target.isIsolated && !target.aegisMode) {
        damage *= 0.5;
      }
    }
    if (targetType === 'unit') {
      damage = getAdjustedUnitDamage(target, damage);
    }

    const existingPlan = damagePlans.get(targetKey);
    if (existingPlan) {
      existingPlan.damage += damage;
    } else {
      damagePlans.set(targetKey, {
        target,
        targetType,
        damage
      });
    }
  }

  for (const damagePlan of damagePlans.values()) {
    const { target, targetType, damage } = damagePlan;
      if (targetType === 'unit') {
        if (!gameState.units.has(target.id)) continue;
        applyDamageToEntity(target, damage, now);
        recordAiUnitAttackResponse(target, unit, now);
      } else {
        if (!gameState.buildings.has(target.id)) continue;
        applyDamageToEntity(target, damage, now);
        if (target.userId < 0) {
          recordAiUnitAttackResponse(target, unit, now);
        }
      }

    if (target.hp <= 0) {
      destroyCombatTargetByUnit(unit, target, targetType);
      if (!gameState.units.has(unit.id)) {
        return;
      }
    }
  }

  for (let i = 0; i < shotPlans.length; i++) {
    if (applyBattleshipCombatStanceAttackCost(unit, now)) {
      return;
    }
  }
}

function targetIntersectsDamageCircle(centerX, centerY, damageRadius, targetX, targetY, targetRadius) {
  const dx = targetX - centerX;
  const dy = targetY - centerY;
  const totalRadius = damageRadius + targetRadius;
  return (dx * dx) + (dy * dy) <= totalRadius * totalRadius;
}

function hasValidSlbmPosition(slbm) {
  return !!(slbm && Number.isFinite(slbm.currentX) && Number.isFinite(slbm.currentY));
}

function findNearestOwnedMissileSiloWithStock(userId, x, y, maxRange = Infinity) {
  let bestSilo = null;
  let bestDistanceSq = maxRange < Infinity ? maxRange * maxRange : Infinity;
  gameState.buildings.forEach(building => {
    if (!building || building.userId !== userId || building.type !== 'missile_silo') return;
    if ((building.buildProgress || 0) < 100) return;
    if (getStoredSlbmCountForBuilding(building) <= 0) return;
    const dx = building.x - x;
    const dy = building.y - y;
    const distanceSq = (dx * dx) + (dy * dy);
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestSilo = building;
    }
  });
  return bestSilo;
}

function createUniqueEntityId(offset = 0) {
  return (Date.now() * 1000) + Math.floor(Math.random() * 1000) + offset;
}

function normalizeAngle(angle) {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function getAngleDelta(a, b) {
  return normalizeAngle(a - b);
}

const UNIT_DEFINITIONS = {
  worker: {
    cost: 50,
    pop: 1,
    hp: 100,
    damage: 5,
    speed: 12,
    size: 40,
    attackRange: 80,
    attackCooldownMs: 1200,
    visionRadius: 1000,
    buildTime: 4500
  },
  destroyer: {
    cost: 170,
    pop: 2,
    hp: 320,
    damage: 25,
    speed: 15,
    size: 60,
    attackRange: 1250,
    attackCooldownMs: 1000,
    visionRadius: 1000,
    buildTime: 13500
  },
  cruiser: {
    cost: 285,
    pop: 3,
    hp: 560,
    damage: 52,
    speed: 12,
    size: 60,
    attackRange: 2000,
    attackCooldownMs: 1300,
    visionRadius: 1300,
    buildTime: 20500
  },
  battleship: {
    cost: 2400,
    pop: 20,
    hp: 2400,
    damage: 260,
    speed: 6,
    size: 60,
    attackRange: 2500,
    attackCooldownMs: 4800,
    visionRadius: 3200,
    buildTime: 105000
  },
  carrier: {
    cost: CARRIER_COST,
    pop: 12,
    hp: 900,
    damage: 0,
    speed: 8,
    size: 60,
    attackRange: 3750,
    attackCooldownMs: 99999,
    visionRadius: 4800,
    buildTime: 60000
  },
  assaultship: {
    cost: ASSAULT_SHIP_COST,
    pop: 10,
    hp: 2000,
    damage: 0,
    speed: 7,
    size: 60,
    attackRange: 0,
    attackCooldownMs: 99999,
    visionRadius: 1400,
    buildTime: 39000
  },
  submarine: {
    cost: SUBMARINE_COST,
    pop: 8,
    hp: 260,
    damage: 300,
    speed: 8,
    size: 60,
    attackRange: 360,
    attackCooldownMs: 7800,
    visionRadius: 800,
    buildTime: 45000
  },
  frigate: {
    cost: 135,
    pop: 1,
    hp: 85,
    damage: 72,
    speed: 17,
    size: 35,
    attackRange: 750,
    attackCooldownMs: 800,
    visionRadius: 900,
    buildTime: 9000
  },
  aircraft: {
    cost: 100,
    pop: 0,
    hp: 200,
    damage: 24,
    speed: 25,
    size: 25,
    attackRange: 160,
    attackCooldownMs: 250,
    visionRadius: 1000,
    buildTime: 0
  },
  recon_aircraft: {
    cost: 150,
    pop: 0,
    hp: 180,
    damage: 0,
    speed: 10,
    size: 75,
    attackRange: 0,
    attackCooldownMs: 99999,
    visionRadius: 2600,
    buildTime: RECON_AIRCRAFT_BUILD_TIME_MS
  },
  missile_launcher: {
    cost: MISSILE_LAUNCHER_COST,
    pop: 4,
    hp: 260,
    damage: 0,
    speed: 6,
    size: MISSILE_LAUNCHER_RENDER_SIZE,
    attackRange: 0,
    attackCooldownMs: 40000,
    visionRadius: 1100,
    buildTime: MISSILE_LAUNCHER_BUILD_TIME_MS
  },
  mine: {
    cost: 0,
    pop: 0,
    hp: 100,
    damage: 9999,
    speed: 0,
    size: 40,
    attackRange: 80,
    attackCooldownMs: 99999,
    visionRadius: 0,
    buildTime: 0
  }
};
const DEFAULT_UNIT_DEFINITION = {
  cost: 100,
  pop: 1,
  hp: 100,
  damage: 10,
  speed: 10,
  size: 60,
  attackRange: 220,
  attackCooldownMs: 1000,
  visionRadius: 1000
};

// HP Regeneration settings
const HP_REGEN_CONFIG = {
  delayMs: 8000,       // Time without damage before regen starts (8 seconds)
  regenPerSecond: 5,   // HP regenerated per second
  regenIntervalMs: 1000 // How often to regenerate (every 1 second)
};

function getUnitDefinition(unitType) {
  return UNIT_DEFINITIONS[unitType] || DEFAULT_UNIT_DEFINITION;
}

function isNavalUnitType(unitType) {
  return NAVAL_UNIT_TYPES.has(unitType);
}

function usesNavalContactCollision(unit) {
  return !!unit && isNavalUnitType(unit.type);
}

function addToSpatialMap(spatialMap, entity, cellSize = COMBAT_SPATIAL_CELL_SIZE) {
  const cellX = Math.floor(entity.x / cellSize);
  const cellY = Math.floor(entity.y / cellSize);
  const key = `${cellX}_${cellY}`;
  let bucket = spatialMap.get(key);
  if (!bucket) {
    bucket = [];
    spatialMap.set(key, bucket);
  }
  bucket.push(entity);
}

function removeFromSpatialMap(spatialMap, entity, x = entity?.x, y = entity?.y, cellSize = COMBAT_SPATIAL_CELL_SIZE) {
  if (!spatialMap || !entity) return;
  const cellX = Math.floor(x / cellSize);
  const cellY = Math.floor(y / cellSize);
  const key = `${cellX}_${cellY}`;
  const bucket = spatialMap.get(key);
  if (!bucket) return;
  const index = bucket.findIndex(candidate => candidate && candidate.id === entity.id);
  if (index >= 0) {
    bucket.splice(index, 1);
    if (bucket.length === 0) {
      spatialMap.delete(key);
    }
  }
}

function updateEntitySpatialMapPosition(spatialMap, entity, oldX, oldY, newX = entity?.x, newY = entity?.y, cellSize = COMBAT_SPATIAL_CELL_SIZE) {
  if (!spatialMap || !entity) return;
  const oldCellX = Math.floor(oldX / cellSize);
  const oldCellY = Math.floor(oldY / cellSize);
  const newCellX = Math.floor(newX / cellSize);
  const newCellY = Math.floor(newY / cellSize);
  if (oldCellX === newCellX && oldCellY === newCellY) return;
  removeFromSpatialMap(spatialMap, entity, oldX, oldY, cellSize);
  addToSpatialMap(spatialMap, entity, cellSize);
}

function forEachNearbyEntity(spatialMap, x, y, range, callback, cellSize = COMBAT_SPATIAL_CELL_SIZE) {
  const perfStart = PERF_DEBUG_ENABLED ? perfNowMs() : 0;
  const centerCellX = Math.floor(x / cellSize);
  const centerCellY = Math.floor(y / cellSize);
  const cellRadius = Math.ceil(range / cellSize);
  let visitedEntities = 0;

  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const key = `${centerCellX + dx}_${centerCellY + dy}`;
      const bucket = spatialMap.get(key);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        visitedEntities++;
        callback(bucket[i]);
      }
    }
  }

  if (PERF_DEBUG_ENABLED) {
    perfRecord('spatial.query', perfNowMs() - perfStart, 1, visitedEntities);
  }
}

function someNearbyEntity(spatialMap, x, y, range, predicate, cellSize = COMBAT_SPATIAL_CELL_SIZE) {
  if (!spatialMap) return false;
  const centerCellX = Math.floor(x / cellSize);
  const centerCellY = Math.floor(y / cellSize);
  const cellRadius = Math.ceil(range / cellSize);

  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const key = `${centerCellX + dx}_${centerCellY + dy}`;
      const bucket = spatialMap.get(key);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        if (predicate(bucket[i])) {
          return true;
        }
      }
    }
  }
  return false;
}

function hasNearbyEnemyPresence(
  ownerUserId,
  x,
  y,
  range,
  unitSpatialIndex,
  buildingSpatialIndex,
  options = {}
) {
  const rangeSq = range * range;
  const excludedUnitTypes = options.excludedUnitTypes || null;
  const includeBuildings = options.includeBuildings !== false;
  const ignoreUndetectedStealth = options.ignoreUndetectedStealth !== false;

  if (unitSpatialIndex && someNearbyEntity(unitSpatialIndex, x, y, range, enemy => {
    if (!enemy || enemy.userId === ownerUserId || enemy.hp <= 0) return false;
    if (excludedUnitTypes && excludedUnitTypes.has(enemy.type)) return false;
    if (ignoreUndetectedStealth && (enemy.type === 'submarine' || enemy.type === 'mine') && !enemy.isDetected) return false;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    return ((dx * dx) + (dy * dy)) <= rangeSq;
  })) {
    return true;
  }

  if (!includeBuildings || !buildingSpatialIndex) return false;
  return someNearbyEntity(buildingSpatialIndex, x, y, range, building => {
    if (!building || building.userId === ownerUserId || building.hp <= 0) return false;
    const dx = building.x - x;
    const dy = building.y - y;
    return ((dx * dx) + (dy * dy)) <= rangeSq;
  });
}

function hasNearbyAlliedPresence(userId, selfId, x, y, range, unitSpatialIndex, buildingSpatialIndex, options = {}) {
  const selfRadius = Math.max(0, Number(options.selfRadius || 0));
  const rangePadding = Math.max(0, Number(options.rangePadding || 0));

  if (unitSpatialIndex && someNearbyEntity(unitSpatialIndex, x, y, range, ally => {
    if (!ally || ally.id === selfId || ally.userId !== userId || ally.hp <= 0) return false;
    const dx = ally.x - x;
    const dy = ally.y - y;
    const allyRadius = Math.max(0, Number(ally.size || getUnitDefinition(ally.type).size || 0) * 0.5);
    const effectiveRange = range + selfRadius + allyRadius + rangePadding;
    return ((dx * dx) + (dy * dy)) <= (effectiveRange * effectiveRange);
  })) {
    return true;
  }

  if (!buildingSpatialIndex) return false;
  return someNearbyEntity(buildingSpatialIndex, x, y, range, building => {
    if (!building || building.userId !== userId || building.hp <= 0) return false;
    const dx = building.x - x;
    const dy = building.y - y;
    const buildingRadius = Math.max(0, getBuildingCollisionSize(building.type) * 0.5);
    const effectiveRange = range + selfRadius + buildingRadius + rangePadding;
    return ((dx * dx) + (dy * dy)) <= (effectiveRange * effectiveRange);
  });
}

// Load map configuration
let mapConfig = {
  mapSize: 4000,
  gridSize: 40,
  islands: { count: 12, minRadius: 2, maxRadius: 5 },
  resources: { perIsland: { min: 3, max: 6 }, radius: 60, amount: { min: 5000, max: 10000 } },
  spawnZones: { minDistanceFromEdge: 200, minDistanceFromOtherBases: 800 },
  vision: { workerVisionRadius: 150, unitVisionRadius: 200, buildingVisionRadius: 250, fogFadeTime: 30000 }
};

try {
  const configData = fs.readFileSync('mapConfig.json', 'utf8');
  mapConfig = JSON.parse(configData);
  console.log('Map configuration loaded from mapConfig.json');
} catch (error) {
  console.log('Using default map configuration');
}

const MAP_ASSETS_DIR = path.join(__dirname, 'public', 'assets', 'maps');
const TERRAIN_GRID_PATH = path.join(MAP_ASSETS_DIR, 'terrain-grid.json');
const LAND_CELLS_PATH = path.join(MAP_ASSETS_DIR, 'land-cells.json');
const DEFAULT_MAP_IMAGE_PATH = '/assets/maps/world-map.png';

function ensureMapAssetsDir() {
  try {
    fs.mkdirSync(MAP_ASSETS_DIR, { recursive: true });
  } catch (error) {
    console.warn('Could not create map assets directory:', error.message);
  }
}

function normalizeMapImagePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return DEFAULT_MAP_IMAGE_PATH;
  }
  if (rawPath.startsWith('/')) {
    return rawPath;
  }
  return `/${rawPath}`;
}

function generateTerrainGrid(gridSize) {
  const terrain = Array(gridSize).fill(null).map(() => Array(gridSize).fill(0));
  const numIslands = mapConfig.islands.count;

  for (let i = 0; i < numIslands; i++) {
    const centerX = Math.floor(Math.random() * gridSize);
    const centerY = Math.floor(Math.random() * gridSize);
    const radius = mapConfig.islands.minRadius + Math.floor(Math.random() * (mapConfig.islands.maxRadius - mapConfig.islands.minRadius + 1));

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (dx * dx + dy * dy <= radius * radius) {
          const x = centerX + dx;
          const y = centerY + dy;
          if (x >= 0 && x < gridSize && y >= 0 && y < gridSize) {
            terrain[y][x] = 1; // Land
          }
        }
      }
    }
  }

  return terrain;
}

function isValidTerrainGrid(terrain, gridSize) {
  if (!Array.isArray(terrain) || terrain.length !== gridSize) return false;
  for (let y = 0; y < gridSize; y++) {
    if (!Array.isArray(terrain[y]) || terrain[y].length !== gridSize) return false;
  }
  return true;
}

function loadTerrainGrid(gridSize) {
  try {
    if (!fs.existsSync(TERRAIN_GRID_PATH)) return null;
    const raw = fs.readFileSync(TERRAIN_GRID_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const terrain = parsed.terrain;
    if (!isValidTerrainGrid(terrain, gridSize)) {
      console.warn('terrain-grid.json exists but has invalid dimensions; regenerating terrain');
      return null;
    }
    return terrain;
  } catch (error) {
    console.warn('Failed to load terrain-grid.json; regenerating terrain:', error.message);
    return null;
  }
}

function saveTerrainGrid(terrain, mapWidth, mapHeight) {
  try {
    ensureMapAssetsDir();
    const payload = {
      generatedAt: new Date().toISOString(),
      mapWidth,
      mapHeight,
      gridSize: terrain.length,
      terrain
    };
    fs.writeFileSync(TERRAIN_GRID_PATH, JSON.stringify(payload), 'utf8');
  } catch (error) {
    console.warn('Failed to save terrain-grid.json:', error.message);
  }
}

function buildLandDataFromTerrain(terrain) {
  const gridSize = terrain.length;
  const landCells = [];
  const landCellSet = new Set();

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (terrain[y][x] === 1) {
        landCells.push([x, y]);
        landCellSet.add((y * gridSize) + x);
      }
    }
  }

  return { landCells, landCellSet };
}

function buildLandCellsSnapshot(map) {
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const landCells = Array.isArray(map.landCells) ? map.landCells.map(([x, y]) => [x, y]) : [];

  return {
    generatedAt: new Date().toISOString(),
    mapWidth: map.width,
    mapHeight: map.height,
    gridSize,
    cellSize,
    imagePath: map.imagePath,
    landCells
  };
}

function saveLandCellsSnapshot(snapshot) {
  try {
    ensureMapAssetsDir();
    fs.writeFileSync(LAND_CELLS_PATH, JSON.stringify(snapshot), 'utf8');
  } catch (error) {
    console.warn('Failed to save land-cells.json:', error.message);
  }
}

function buildClientMapPayload() {
  const map = gameState.map;
  if (!map) return null;

  return {
    width: map.width,
    height: map.height,
    imagePath: map.imagePath,
    gridSize: map.gridSize,
    cellSize: map.cellSize,
    landCells: map.landCells || [],
    resources: map.resources || [],
    obstacles: map.obstacles || [],
    hostileMobs: map.hostileMobs || []
  };
}

function buildClientPlayersPayload() {
  const players = [];
  gameState.players.forEach(player => {
    players.push({
      userId: player.userId,
      username: player.username,
      yamatoBattleshipSkinEligible: canUsernameUseYamatoBattleshipSkin(player.username),
      resources: player.resources,
      population: player.population,
      maxPopulation: player.maxPopulation,
      combatPower: player.combatPower,
      score: player.score,
      baseX: player.baseX,
      baseY: player.baseY,
      hasBase: !!player.hasBase,
      online: !!player.online,
      researchedSLBM: !!player.researchedSLBM,
      missiles: player.missiles || 0,
      battleshipModeComboUnlocked: !!player.battleshipModeComboUnlocked,
      isAI: !!player.isAI,
      isObserver: !!player.isObserver
    });
  });
  return players;
}

function buildClientUnitsPayload(filterFn = null) {
  const units = [];
  gameState.units.forEach(unit => {
    if (filterFn && !filterFn(unit)) return;
    initializeUnitRuntimeState(unit);
    // Core properties always sent (round coords to reduce JSON size)
    const u = {
      id: unit.id,
      userId: unit.userId,
      type: unit.type,
      x: Math.round(unit.x),
      y: Math.round(unit.y),
      hp: unit.hp,
      maxHp: unit.maxHp,
      speed: unit.speed,
      damage: unit.damage,
      attackRange: unit.attackRange,
      angle: unit.angle ?? 0
    };
    // Only include non-default properties to reduce payload size
    if (unit.targetX != null) { u.targetX = Math.round(unit.targetX); u.targetY = Math.round(unit.targetY); }
    if (unit.gatheringResourceId) u.gatheringResourceId = unit.gatheringResourceId;
    if (unit.buildingType) u.buildingType = unit.buildingType;
    if (unit.buildTargetX != null) { u.buildTargetX = unit.buildTargetX; u.buildTargetY = unit.buildTargetY; }
    if (unit.sourceDestroyerId) u.sourceDestroyerId = unit.sourceDestroyerId;
    if (unit.isDetected) u.isDetected = true;
    if (unit.kills) u.kills = unit.kills;
    if (unit.attackMove) u.attackMove = true;
    if (unit.attackTargetId) { u.attackTargetId = unit.attackTargetId; u.attackTargetType = unit.attackTargetType; }
    if (unit.holdPosition) u.holdPosition = true;
    u.isIsolated = !!unit.isIsolated;
    if (unit.squadId) { u.squadId = unit.squadId; u.formationType = gameState.squads.get(unit.squadId)?.formationType || 'trapezoid'; }
    // Type-specific properties
    const t = unit.type;
    if (t === 'battleship') {
      u.aimedShot = !!unit.aimedShot;
      u.aimedShotCooldownUntil = Number.isFinite(unit.aimedShotCooldownUntil) ? unit.aimedShotCooldownUntil : 0;
      u.combatStanceActive = !!unit.combatStanceActive;
      if (unit.combatStanceActive) u.combatStanceStacks = unit.combatStanceStacks ?? 0;
      u.battleshipAegisMode = !!unit.battleshipAegisMode;
      u.battleshipSkinVariant = unit.battleshipSkinVariant === 'yamato' ? 'yamato' : 'default';
      if (unit.battleshipModeComboUnlocked) u.battleshipModeComboUnlocked = true;
    }
    if (t === 'cruiser') {
      u.aegisMode = !!unit.aegisMode;
      if (unit.evasionChance) u.evasionChance = unit.evasionChance;
    }
    if (t === 'frigate') {
      u.engineOverdriveActive = !!unit.engineOverdriveActive;
      if (unit.evasionChance) u.evasionChance = unit.evasionChance;
    }
    if (t === 'carrier') {
      u.aircraft = unit.aircraft ?? null;
      u.aircraftDeployed = unit.aircraftDeployed ?? null;
      if (unit.aircraftQueue && unit.aircraftQueue.length) u.aircraftQueue = unit.aircraftQueue;
      if (unit.producingAircraft) u.producingAircraft = unit.producingAircraft;
      u.reconAircraft = unit.reconAircraft ?? null;
      u.reconAircraftDeployed = unit.reconAircraftDeployed ?? null;
      if (unit.reconAircraftQueue && unit.reconAircraftQueue.length) u.reconAircraftQueue = unit.reconAircraftQueue;
      if (unit.producingReconAircraft) u.producingReconAircraft = unit.producingReconAircraft;
      if (unit.airstrikeReady) u.airstrikeReady = true;
      if (unit.airstrikeCooldownUntil) u.airstrikeCooldownUntil = unit.airstrikeCooldownUntil;
    }
    if (t === 'submarine') {
      u.loadedSlbms = getSubmarineLoadedSlbmCount(unit);
      if (unit.stealthActive) u.stealthActive = true;
      if (unit.stealthExpiresAt) u.stealthExpiresAt = unit.stealthExpiresAt;
      if (unit.stealthCooldownUntil) u.stealthCooldownUntil = unit.stealthCooldownUntil;
    }
    if (t === 'destroyer') {
      if (unit.searchCooldownUntil) u.searchCooldownUntil = unit.searchCooldownUntil;
      if (unit.searchActiveUntil) u.searchActiveUntil = unit.searchActiveUntil;
    }
    if (t === 'missile_launcher') {
      if (unit.deployState) u.deployState = unit.deployState;
      if (unit.deployStateEndsAt) u.deployStateEndsAt = unit.deployStateEndsAt;
    }
    if (t === 'assault_ship') {
      if (unit.loadedMissileLaunchers && unit.loadedMissileLaunchers.length) u.loadedMissileLaunchers = unit.loadedMissileLaunchers;
    }
    if (t === 'mine') u.isMine = true;
    units.push(u);
  });
  return units;
}

function buildClientBuildingsPayload(filterFn = null) {
  const buildings = [];
  gameState.buildings.forEach(building => {
    if (filterFn && !filterFn(building)) return;
    buildings.push({
      id: building.id,
      userId: building.userId,
      type: building.type,
      x: building.x,
      y: building.y,
      hp: building.hp,
      maxHp: building.maxHp,
      buildProgress: building.buildProgress,
      slbmCount: building.slbmCount ?? 0,
      producing: building.producing ?? null,
      productionQueue: building.productionQueue ?? [],
      missileProducing: building.missileProducing ?? null,
      missileQueue: building.missileQueue ?? [],
      attackTargetId: building.attackTargetId ?? null,
      attackTargetType: building.attackTargetType ?? null,
      turretAngle: building.turretAngle ?? null,
      turretTargetX: building.turretTargetX ?? null,
      turretTargetY: building.turretTargetY ?? null,
      lastTurretTargetTime: building.lastTurretTargetTime ?? null
    });
  });
  return buildings;
}

function sanitizeViewportState(data, options = {}) {
  if (!data || typeof data !== 'object') return null;
  const centerX = Number(data.x);
  const centerY = Number(data.y);
  const zoom = Number(data.zoom);
  const width = Number(data.width);
  const height = Number(data.height);
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(zoom)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const minZoom = Number.isFinite(options.minZoom) ? options.minZoom : 0.3;
  const maxZoom = Number.isFinite(options.maxZoom) ? options.maxZoom : 2;

  return {
    x: centerX,
    y: centerY,
    zoom: Math.max(minZoom, Math.min(maxZoom, zoom)),
    width: Math.max(320, Math.min(4096, width)),
    height: Math.max(240, Math.min(2160, height)),
    revealAllBuildings: !!data.revealAllBuildings,
    updatedAt: Date.now()
  };
}

function getSocketInterestBounds(socket) {
  if (!socket || !socket.viewportState || !gameState || !gameState.map) return null;
  if ((Date.now() - socket.viewportState.updatedAt) > NETWORK_VIEWPORT_STATE_STALE_MS) return null;

  const { x, y, zoom, width, height } = socket.viewportState;
  const halfWorldWidth = (width / zoom) / 2 + NETWORK_VIEWPORT_MARGIN_WORLD;
  const halfWorldHeight = (height / zoom) / 2 + NETWORK_VIEWPORT_MARGIN_WORLD;

  return {
    left: x - halfWorldWidth,
    right: x + halfWorldWidth,
    top: y - halfWorldHeight,
    bottom: y + halfWorldHeight
  };
}

function isEntityRelevantToSocket(socket, entity, bounds) {
  if (!entity || !socket) return false;
  if (entity.userId === socket.userId) return true;
  if (!bounds) return true;
  return entity.x >= bounds.left
    && entity.x <= bounds.right
    && entity.y >= bounds.top
    && entity.y <= bounds.bottom;
}

function buildClientStatePayloadForSocket(socket, sharedPlayersPayload = null) {
  if (socket?.isObserver) {
    return {
      players: sharedPlayersPayload || buildClientPlayersPayload(),
      units: buildClientUnitsPayload(),
      buildings: buildClientBuildingsPayload()
    };
  }
  const bounds = getSocketInterestBounds(socket);
  const revealAllBuildings = !!socket?.viewportState?.revealAllBuildings;
  return {
    players: sharedPlayersPayload || buildClientPlayersPayload(),
    units: buildClientUnitsPayload(unit => isEntityRelevantToSocket(socket, unit, bounds)),
    buildings: buildClientBuildingsPayload(building => revealAllBuildings || isEntityRelevantToSocket(socket, building, bounds))
  };
}

function normalizeScopedUserIds(userIds) {
  if (userIds instanceof Set) return userIds;
  if (!Array.isArray(userIds)) return null;
  const normalized = userIds.filter(userId => userId != null);
  return normalized.length > 0 ? new Set(normalized) : null;
}

function createPointBounds(x, y, padding = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    left: x - padding,
    right: x + padding,
    top: y - padding,
    bottom: y + padding
  };
}

function createSegmentBounds(x1, y1, x2, y2, padding = 0) {
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) return null;
  return {
    left: Math.min(x1, x2) - padding,
    right: Math.max(x1, x2) + padding,
    top: Math.min(y1, y2) - padding,
    bottom: Math.max(y1, y2) + padding
  };
}

function createProjectilePayloadBounds(payload, padding = 0) {
  if (!payload) return null;
  const burstShots = Array.isArray(payload.shots) ? payload.shots : null;
  if (!burstShots || burstShots.length <= 0) {
    return createSegmentBounds(payload.fromX, payload.fromY, payload.targetX, payload.targetY, padding);
  }

  let left = Number.isFinite(payload.fromX) ? payload.fromX : Number.POSITIVE_INFINITY;
  let right = Number.isFinite(payload.fromX) ? payload.fromX : Number.NEGATIVE_INFINITY;
  let top = Number.isFinite(payload.fromY) ? payload.fromY : Number.POSITIVE_INFINITY;
  let bottom = Number.isFinite(payload.fromY) ? payload.fromY : Number.NEGATIVE_INFINITY;

  burstShots.forEach(shot => {
    const shotFromX = Number.isFinite(shot?.fromX) ? shot.fromX : payload.fromX;
    const shotFromY = Number.isFinite(shot?.fromY) ? shot.fromY : payload.fromY;
    const shotTargetX = Number.isFinite(shot?.targetX) ? shot.targetX : null;
    const shotTargetY = Number.isFinite(shot?.targetY) ? shot.targetY : null;

    if (Number.isFinite(shotFromX)) {
      left = Math.min(left, shotFromX);
      right = Math.max(right, shotFromX);
    }
    if (Number.isFinite(shotFromY)) {
      top = Math.min(top, shotFromY);
      bottom = Math.max(bottom, shotFromY);
    }
    if (Number.isFinite(shotTargetX)) {
      left = Math.min(left, shotTargetX);
      right = Math.max(right, shotTargetX);
    }
    if (Number.isFinite(shotTargetY)) {
      top = Math.min(top, shotTargetY);
      bottom = Math.max(bottom, shotTargetY);
    }
  });

  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) {
    return null;
  }

  return {
    left: left - padding,
    right: right + padding,
    top: top - padding,
    bottom: bottom + padding
  };
}

function doBoundsOverlap(a, b) {
  if (!a || !b) return true;
  return a.left <= b.right
    && a.right >= b.left
    && a.top <= b.bottom
    && a.bottom >= b.top;
}

function emitScopedRoomEvent(event, data, options = {}) {
  const roomId = options.roomId || currentRoomId;
  const bounds = options.bounds || null;
  const userIds = normalizeScopedUserIds(options.userIds);
  const volatile = !!options.volatile;

  if (!roomId) {
    io.emit(event, data);
    return;
  }

  const socketsInRoom = getConnectedSocketsForRoom(roomId);
  socketsInRoom.forEach(socket => {
    if (!socket) return;
    if (userIds && userIds.has(socket.userId)) {
      (volatile ? socket.volatile : socket).emit(event, data);
      return;
    }
    if (!bounds) {
      (volatile ? socket.volatile : socket).emit(event, data);
      return;
    }
    const interestBounds = getSocketInterestBounds(socket);
    if (!interestBounds || doBoundsOverlap(interestBounds, bounds)) {
      (volatile ? socket.volatile : socket).emit(event, data);
    }
  });
}

function emitUnitCreatedEvent(unit) {
  if (!unit) return;
  emitScopedRoomEvent('unitCreated', unit, {
    bounds: createPointBounds(unit.x, unit.y, 900),
    userIds: [unit.userId]
  });
}

function emitBuildingCreatedEvent(building) {
  if (!building) return;
  emitScopedRoomEvent('buildingCreated', building, {
    bounds: createPointBounds(building.x, building.y, 1200),
    userIds: [building.userId]
  });
}

function emitUnitDestroyedEvent(unit) {
  if (!unit) return;
  emitScopedRoomEvent('unitDestroyed', {
    id: unit.id,
    x: unit.x,
    y: unit.y,
    type: unit.type,
    userId: unit.userId,
    battleshipSkinVariant: unit.type === 'battleship'
      ? (unit.battleshipSkinVariant === 'yamato' ? 'yamato' : 'default')
      : undefined
  }, {
    bounds: createPointBounds(unit.x, unit.y, 1100),
    userIds: [unit.userId]
  });
}

function emitBuildingDestroyedEvent(building) {
  if (!building) return;
  emitScopedRoomEvent('buildingDestroyed', {
    id: building.id,
    x: building.x,
    y: building.y,
    type: building.type,
    userId: building.userId
  }, {
    bounds: createPointBounds(building.x, building.y, 1400),
    userIds: [building.userId]
  });
}

function emitAttackProjectileFiredEvent(payload, extraUserIds = []) {
  if (!payload) return;
  emitScopedRoomEvent('attackProjectileFired', payload, {
    bounds: createProjectilePayloadBounds(payload, 900),
    userIds: extraUserIds,
    volatile: true
  });
}

function emitSlbmFiredEvent(payload) {
  if (!payload) return;
  emitScopedRoomEvent('slbmFired', payload, {
    bounds: createSegmentBounds(payload.fromX, payload.fromY, payload.targetX, payload.targetY, 1400),
    userIds: [payload.userId],
    volatile: true
  });
}

function emitSlbmImpactEvent(payload) {
  if (!payload) return;
  emitScopedRoomEvent('slbmImpact', payload, {
    bounds: createPointBounds(payload.x, payload.y, SLBM_DAMAGE_RADIUS + 1200),
    userIds: [payload.userId]
  });
}

function emitSlbmDestroyedEvent(payload) {
  if (!payload) return;
  emitScopedRoomEvent('slbmDestroyed', payload, {
    bounds: createPointBounds(payload.x, payload.y, 1200),
    userIds: [payload.userId],
    volatile: true
  });
}

function emitSlbmDamagedEvent(payload) {
  if (!payload) return;
  emitScopedRoomEvent('slbmDamaged', payload, {
    bounds: createPointBounds(payload.x, payload.y, 1200),
    userIds: [payload.userId],
    volatile: true
  });
}

function emitSearchActivatedEvent(payload) {
  if (!payload) return;
  emitScopedRoomEvent('searchActivated', payload, {
    bounds: createPointBounds(payload.x, payload.y, (payload.radius || 0) + 600),
    userIds: [payload.userId],
    volatile: true
  });
}

function emitAirstrikeLaunchedEvent(payload) {
  if (!payload) return;
  emitScopedRoomEvent('airstrikeLaunched', payload, {
    bounds: createSegmentBounds(payload.fromX, payload.fromY, payload.exitX ?? payload.targetX, payload.exitY ?? payload.targetY, AIRSTRIKE_VISUAL_RADIUS + 1200),
    userIds: [payload.userId]
  });
}

function emitAirstrikePassEvent(payload) {
  if (!payload) return;
  emitScopedRoomEvent('airstrikePass', payload, {
    bounds: createPointBounds(payload.targetX, payload.targetY, (payload.radius || AIRSTRIKE_VISUAL_RADIUS) + 1200),
    userIds: [payload.userId],
    volatile: true
  });
}

function emitAirstrikeCancelledEvent(payload) {
  if (!payload) return;
  emitScopedRoomEvent('airstrikeCancelled', payload, {
    bounds: createPointBounds(payload.targetX, payload.targetY, AIRSTRIKE_VISUAL_RADIUS + 1200),
    userIds: [payload.userId]
  });
}

function buildClientRedZonePayload() {
  if (!gameState || !Array.isArray(gameState.activeRedZones)) return [];
  return gameState.activeRedZones.map(zone => ({
    id: zone.id,
    islandId: zone.islandId,
    centerX: zone.centerX,
    centerY: zone.centerY,
    landCells: zone.landCells,
    blastRadius: zone.blastRadius,
    selectedAt: zone.selectedAt,
    bombardmentAt: zone.bombardmentAt,
    detonatedAt: zone.detonatedAt ?? null,
    endsAt: zone.endsAt
  }));
}

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS player_data (
    user_id INTEGER PRIMARY KEY,
    resources INTEGER DEFAULT 1000,
    population INTEGER DEFAULT 0,
    max_population INTEGER DEFAULT 10,
    combat_power INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    base_x REAL DEFAULT 0,
    base_y REAL DEFAULT 0,
    has_base INTEGER DEFAULT 1,
    researched_slbm INTEGER DEFAULT 0,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    hp INTEGER NOT NULL,
    max_hp INTEGER NOT NULL,
    target_x REAL,
    target_y REAL,
    gathering_resource_id INTEGER,
    building_type TEXT,
    build_target_x REAL,
    build_target_y REAL,
    source_destroyer_id INTEGER,
    is_detected INTEGER DEFAULT 0,
    loaded_slbms INTEGER DEFAULT 0,
    stealth_active INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    hp INTEGER NOT NULL,
    max_hp INTEGER NOT NULL,
    build_progress INTEGER DEFAULT 100,
    slbm_count INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migration: add kills column if missing
try {
  db.prepare('SELECT kills FROM units LIMIT 1').get();
} catch (e) {
  db.prepare('ALTER TABLE units ADD COLUMN kills INTEGER DEFAULT 0').run();
  console.log('Migrated units table: added kills column');
}

// Migration: add source_destroyer_id column if missing
try {
  db.prepare('SELECT source_destroyer_id FROM units LIMIT 1').get();
} catch (e) {
  db.prepare('ALTER TABLE units ADD COLUMN source_destroyer_id INTEGER').run();
  console.log('Migrated units table: added source_destroyer_id column');
}

// Migration: add missiles column if missing
try {
  db.prepare('SELECT missiles FROM player_data LIMIT 1').get();
} catch (e) {
  db.prepare('ALTER TABLE player_data ADD COLUMN missiles INTEGER DEFAULT 0').run();
  console.log('Migrated player_data table: added missiles column');
}

// Migration: add loaded_slbms column if missing
try {
  db.prepare('SELECT loaded_slbms FROM units LIMIT 1').get();
} catch (e) {
  db.prepare('ALTER TABLE units ADD COLUMN loaded_slbms INTEGER DEFAULT 0').run();
  console.log('Migrated units table: added loaded_slbms column');
}

// Migration: add stealth_active column if missing
try {
  db.prepare('SELECT stealth_active FROM units LIMIT 1').get();
} catch (e) {
  db.prepare('ALTER TABLE units ADD COLUMN stealth_active INTEGER DEFAULT 0').run();
  console.log('Migrated units table: added stealth_active column');
}

app.use(express.json());

// Force no-cache on JS and CSS files to prevent stale script issues
app.use((req, res, next) => {
  if (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

function isLocalTrainingAccessRequest(req) {
  const host = String(req.hostname || req.get('host') || '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost')
  );
}

app.use((req, res, next) => {
  const pathName = String(req.path || '').toLowerCase();
  const isTrainingPath = (
    pathName === '/training' ||
    pathName === '/training.html' ||
    pathName.startsWith('/api/ai-training')
  );
  if (isTrainingPath && !ENABLE_AI_TRAINING) {
    return res.status(404).send('Not found');
  }
  if (!isTrainingPath || isLocalTrainingAccessRequest(req)) {
    return next();
  }
  return res.status(404).send('Not found');
});

app.use(express.static('public', { etag: false, maxAge: 0, lastModified: false }));

// AI Training standalone page
app.get('/training', (req, res) => {
  if (!ENABLE_AI_TRAINING) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'public', 'training.html'));
});

app.get(['/healthz', '/health'], (req, res) => {
  res.status(200).json({ ok: true, app: APP_NAME });
});

// Room configuration
const ROOM_CONFIG = [
  { id: 'server1', name: '\uC11C\uBC84 1', maxPlayers: 6 },
  { id: 'server2', name: '\uC11C\uBC84 2', maxPlayers: 6 }
];

// Room list API
app.get('/api/rooms', (req, res) => {
  const roomList = ROOM_CONFIG.map(rc => {
    const room = gameRooms.get(rc.id);
    const playerCount = room ? Array.from(room.players.values()).filter(p => p.online && !p.isAI).length : 0;
    const aiCount = room ? Array.from(room.players.values()).filter(p => p.isAI).length : 0;
    const aiDifficulty = room ? getEffectiveAIDifficulty(room.aiDifficulty) : DEFAULT_AI_DIFFICULTY;
    return { id: rc.id, name: rc.name, maxPlayers: rc.maxPlayers, playerCount, aiCount, aiDifficulty };
  });
  res.json(roomList);
});

function createRoomState() {
  return {
    players: new Map(),
    units: new Map(),
    buildings: new Map(),
    activeSlbms: new Map(),
    activeAirstrikes: new Map(),
    activeRedZones: [],
    nextSlbmId: 1,
    map: null,
    landCellsSnapshot: null,
    lastUpdate: Date.now(),
    fogOfWar: new Map(),
    aiRespawnTimers: new Map(),
    squads: new Map(),
    pathCache: new Map(),
    nextSquadId: 1,
    nextRedZoneId: 1,
    nextRedZoneRollAt: Date.now() + RED_ZONE_SELECTION_INTERVAL_MS,
    lastRedZoneCountdownSecond: null,
    aiDifficulty: DEFAULT_AI_DIFFICULTY
  };
}

// Game rooms storage
const gameRooms = new Map();

// Active room context (swapped before processing)
let gameState = null;
let currentRoomId = null;
let nextSlbmId = 1;
const { ensureAIStrategyProfile } = createAiStrategyHelper(() => gameState);
const {
  getKnownEnemyClusterContext,
  getSlbmTargetPriorityScore,
  selectBestKnownEnemyTarget,
  isWorthwhileAIAttack
} = createAiTargetingHelpers({
  getGameState: () => gameState,
  normalizeCombatPowerBuildingType,
  advancedBuildingTypes: ADVANCED_BUILDING_TYPES,
  getUnitCombatPowerValue
});
const {
  spawnAIPlayer,
  scheduleAIRespawn,
  clearAIRespawnTimer,
  clearActiveWeaponsForUser,
  removeAllAiFactionsFromCurrentRoom,
  resetAllAiFactionsInCurrentRoom,
  initializeAIPlayers
} = createAiLifecycleHelpers({
  io,
  getGameState: () => gameState,
  getCurrentRoomId: () => currentRoomId,
  getGameRooms: () => gameRooms,
  switchRoom: (roomId) => switchRoom(roomId),
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
});
const { buildUnitForAI } = createAiProductionHelpers({
  getGameState: () => gameState,
  unitDefinitions: UNIT_DEFINITIONS,
  getUnitDefinition
});

// Room-scoped emit helper
function roomEmit(event, data) {
  if (currentRoomId) {
    io.to(currentRoomId).emit(event, data);
  } else {
    io.emit(event, data);
  }
}

function collectNavalOverlapBlockers(unit, candidateX, candidateY, navalSpatialMap, ignoredIds = null) {
  const perfStart = PERF_DEBUG_ENABLED ? perfNowMs() : 0;
  const blockers = [];
  if (!usesNavalContactCollision(unit) || !navalSpatialMap) return blockers;

  const ownEllipse = getSelectionEllipseForUnit(unit);
  const probeRange = Math.max(320, Math.max(ownEllipse.semiMajor, ownEllipse.semiMinor) + 260);
  forEachNearbyEntity(navalSpatialMap, candidateX, candidateY, probeRange, other => {
    if (!other || other.id === unit.id || !gameState.units.has(other.id)) return;
    if (ignoredIds && ignoredIds.has(other.id)) return;
    if (!usesNavalContactCollision(other)) return;
    const clearancePadding = getNavalBlockerClearancePadding(unit, other, candidateX, candidateY);
    if (doSelectionEllipsesOverlapWithPadding(unit, candidateX, candidateY, other, other.x, other.y, clearancePadding)) {
      blockers.push(other);
    }
  }, COLLISION_SPATIAL_CELL_SIZE);
  if (PERF_DEBUG_ENABLED) {
    perfRecord('naval.collectBlockers', perfNowMs() - perfStart, 1, blockers.length);
  }
  return blockers;
}

function canNavalUnitOccupyPosition(unit, candidateX, candidateY, navalSpatialMap, options = {}) {
  if (!usesNavalContactCollision(unit) || !navalSpatialMap) return true;
  const ignoredIds = options.ignoredIds || null;
  return collectNavalOverlapBlockers(unit, candidateX, candidateY, navalSpatialMap, ignoredIds).length === 0;
}

function isNavalUnitStationary(unit) {
  return !!unit
    && usesNavalContactCollision(unit)
    && unit.targetX === null
    && unit.targetY === null
    && (!Array.isArray(unit.pathWaypoints) || unit.pathWaypoints.length === 0);
}

function getNavalMovementIntent(unit, overrideTargetX = null, overrideTargetY = null) {
  if (!usesNavalContactCollision(unit)) return null;
  const targetX = Number.isFinite(overrideTargetX) ? overrideTargetX : unit?.targetX;
  const targetY = Number.isFinite(overrideTargetY) ? overrideTargetY : unit?.targetY;
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) return null;
  const dx = targetX - unit.x;
  const dy = targetY - unit.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.01) return null;
  return { x: dx / length, y: dy / length };
}

function getNavalBlockerClearancePadding(unit, other, candidateX, candidateY) {
  if (isNavalUnitStationary(other)) {
    return Math.max(8, NAVAL_COLLISION_CLEARANCE_BUFFER * 0.5);
  }
  if (unit?.userId != null && unit.userId === other?.userId) {
    const unitIntent = getNavalMovementIntent(unit, candidateX, candidateY);
    const otherIntent = getNavalMovementIntent(other);
    if (unitIntent && otherIntent) {
      const dot = (unitIntent.x * otherIntent.x) + (unitIntent.y * otherIntent.y);
      if (dot > 0.65) {
        return Math.max(6, NAVAL_COLLISION_CLEARANCE_BUFFER * 0.35);
      }
    }
  }
  return NAVAL_COLLISION_CLEARANCE_BUFFER;
}

function getNavalRightOfWayFootprint(unit) {
  const ellipse = getSelectionEllipseForUnit(unit);
  return ellipse.semiMajor * ellipse.semiMinor;
}

function getNavalRightOfWayTieBreaker(unit) {
  const numericId = Number(unit?.id);
  if (Number.isFinite(numericId)) return numericId;
  const text = String(unit?.id ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 31) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function compareNavalRightOfWay(a, b) {
  if (!a || !b || a.id === b.id) return 0;

  const aStationary = isNavalUnitStationary(a);
  const bStationary = isNavalUnitStationary(b);
  if (aStationary !== bStationary) {
    return aStationary ? 1 : -1;
  }

  const aFootprint = getNavalRightOfWayFootprint(a);
  const bFootprint = getNavalRightOfWayFootprint(b);
  if (Math.abs(aFootprint - bFootprint) > 12) {
    return aFootprint > bFootprint ? 1 : -1;
  }

  const aDistanceToGoal = (Number.isFinite(a.targetX) && Number.isFinite(a.targetY))
    ? Math.hypot(a.targetX - a.x, a.targetY - a.y)
    : 0;
  const bDistanceToGoal = (Number.isFinite(b.targetX) && Number.isFinite(b.targetY))
    ? Math.hypot(b.targetX - b.x, b.targetY - b.y)
    : 0;
  if (Math.abs(aDistanceToGoal - bDistanceToGoal) > 80) {
    return aDistanceToGoal < bDistanceToGoal ? 1 : -1;
  }

  const aTieBreaker = getNavalRightOfWayTieBreaker(a);
  const bTieBreaker = getNavalRightOfWayTieBreaker(b);
  if (aTieBreaker !== bTieBreaker) {
    return aTieBreaker < bTieBreaker ? 1 : -1;
  }
  return 0;
}

function tryDisplaceStationaryNavalBlocker(movingUnit, blocker, desiredX, desiredY, navalSpatialMap) {
  if (!isNavalUnitStationary(blocker)) return false;

  const moveDx = desiredX - movingUnit.x;
  const moveDy = desiredY - movingUnit.y;
  const moveDistance = Math.hypot(moveDx, moveDy) || 1;
  const forwardX = moveDx / moveDistance;
  const forwardY = moveDy / moveDistance;
  const sideX = -forwardY;
  const sideY = forwardX;
  const awayDx = blocker.x - desiredX;
  const awayDy = blocker.y - desiredY;
  const awayDistance = Math.hypot(awayDx, awayDy) || 1;
  const awayX = awayDx / awayDistance;
  const awayY = awayDy / awayDistance;
  const movingEllipse = getSelectionEllipseForUnit(movingUnit);
  const blockerEllipse = getSelectionEllipseForUnit(blocker);
  const shoveDistance = Math.max(
    blockerEllipse.semiMinor + movingEllipse.semiMinor + 8,
    blockerEllipse.semiMajor * 0.35
  );

  const oldX = blocker.x;
  const oldY = blocker.y;
  const ignoredIds = new Set([movingUnit.id, blocker.id]);
  const candidateOffsets = [
    [sideX, sideY],
    [-sideX, -sideY],
    [awayX, awayY],
    [forwardX * 0.35 + sideX, forwardY * 0.35 + sideY],
    [forwardX * 0.35 - sideX, forwardY * 0.35 - sideY]
  ];

  for (let ring = 1; ring <= 3; ring++) {
    for (let i = 0; i < candidateOffsets.length; i++) {
      let [dirX, dirY] = candidateOffsets[i];
      const dirLength = Math.hypot(dirX, dirY) || 1;
      dirX /= dirLength;
      dirY /= dirLength;
      const sampleX = oldX + (dirX * shoveDistance * ring);
      const sampleY = oldY + (dirY * shoveDistance * ring);
      const candidate = normalizeFormationTargetForUnit(blocker, sampleX, sampleY);
      if (!candidate) continue;
      if (doSelectionEllipsesOverlap(blocker, candidate.x, candidate.y, movingUnit, desiredX, desiredY)) {
        continue;
      }
      if (!canNavalUnitOccupyPosition(blocker, candidate.x, candidate.y, navalSpatialMap, { ignoredIds })) {
        continue;
      }

      blocker.x = candidate.x;
      blocker.y = candidate.y;
      updateEntitySpatialMapPosition(
        navalSpatialMap,
        blocker,
        oldX,
        oldY,
        blocker.x,
        blocker.y,
        COLLISION_SPATIAL_CELL_SIZE
      );
      return true;
    }
  }

  return false;
}

function tryDisplaceStationaryNavalBlockers(movingUnit, desiredX, desiredY, navalSpatialMap, blockers) {
  if (!Array.isArray(blockers) || blockers.length <= 0) return true;
  for (let i = 0; i < blockers.length; i++) {
    if (!tryDisplaceStationaryNavalBlocker(movingUnit, blockers[i], desiredX, desiredY, navalSpatialMap)) {
      return false;
    }
  }
  return true;
}

function getDeterministicUnitDirectionSign(unit) {
  const numericId = Number(unit?.id);
  if (Number.isFinite(numericId)) {
    return Math.abs(Math.trunc(numericId)) % 2 === 0 ? 1 : -1;
  }
  const text = String(unit?.id ?? '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 31) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 2 === 0 ? 1 : -1;
}

function getNavalAvoidanceSidePreference(unit, desiredX, desiredY, blockers = null) {
  const moveDx = desiredX - unit.x;
  const moveDy = desiredY - unit.y;
  const moveDistance = Math.hypot(moveDx, moveDy);
  if (moveDistance <= 0.01) {
    return unit?.navalAvoidanceSideBias === -1 ? -1 : 1;
  }

  const sideX = -moveDy / moveDistance;
  const sideY = moveDx / moveDistance;
  let sidePressure = 0;
  if (Array.isArray(blockers)) {
    blockers.forEach(blocker => {
      if (!blocker) return;
      sidePressure += ((blocker.x - unit.x) * sideX) + ((blocker.y - unit.y) * sideY);
    });
  }

  if (Math.abs(sidePressure) > 4) {
    return sidePressure > 0 ? -1 : 1;
  }
  if (unit?.navalAvoidanceSideBias === 1 || unit?.navalAvoidanceSideBias === -1) {
    return unit.navalAvoidanceSideBias;
  }
  return getDeterministicUnitDirectionSign(unit);
}

function findNavalSteeringMovePosition(unit, desiredX, desiredY, navalSpatialMap, blockers) {
  if (!usesNavalContactCollision(unit) || !navalSpatialMap) return null;

  const moveDx = desiredX - unit.x;
  const moveDy = desiredY - unit.y;
  const moveDistance = Math.hypot(moveDx, moveDy);
  if (moveDistance <= 0.01) return null;

  const preferredSide = getNavalAvoidanceSidePreference(unit, desiredX, desiredY, blockers);
  const blockedTicks = Math.max(0, Math.floor(unit?.navalBlockedTicks || 0));
  const extraTurn = Math.min(0.6, blockedTicks * 0.05);
  const hasMovingBlocker = Array.isArray(blockers) && blockers.some(blocker => !isNavalUnitStationary(blocker));
  const heavilyBlocked = blockedTicks > 12;
  const turnAngles = hasMovingBlocker
    ? heavilyBlocked
      ? [
        0.8 + extraTurn,
        -(0.8 + extraTurn),
        1.2 + extraTurn,
        -(1.2 + extraTurn),
        1.6 + extraTurn,
        -(1.6 + extraTurn),
        2.0,
        -2.0,
        Math.PI * 0.8,
        -Math.PI * 0.8,
        0
      ]
      : [
        0.45 + extraTurn,
        -(0.45 + extraTurn),
        0.85 + extraTurn,
        -(0.85 + extraTurn),
        1.2 + extraTurn,
        -(1.2 + extraTurn),
        0,
        1.6,
        -1.6
      ]
    : heavilyBlocked
      ? [
        0,
        0.5 + extraTurn,
        -(0.5 + extraTurn),
        1.0 + extraTurn,
        -(1.0 + extraTurn),
        1.5 + extraTurn,
        -(1.5 + extraTurn),
        2.0,
        -2.0
      ]
      : [
        0,
        0.3 + extraTurn,
        -(0.3 + extraTurn),
        0.65 + extraTurn,
        -(0.65 + extraTurn),
        1.0 + extraTurn,
        -(1.0 + extraTurn)
      ];
  const orderedTurnAngles = turnAngles.map(angle => angle * preferredSide);
  const distanceFractions = hasMovingBlocker
    ? heavilyBlocked ? [1, 0.75, 0.55, 0.38, 0.22] : [1, 0.88, 0.72, 0.58, 0.42]
    : heavilyBlocked ? [1, 0.8, 0.6, 0.4, 0.25] : [1, 0.9, 0.75, 0.6, 0.45];
  const baseAngle = Math.atan2(moveDy, moveDx);

  for (let d = 0; d < distanceFractions.length; d++) {
    const step = moveDistance * distanceFractions[d];
    for (let t = 0; t < orderedTurnAngles.length; t++) {
      const heading = baseAngle + orderedTurnAngles[t];
      const candidate = clampToMapBounds(
        unit.x + (Math.cos(heading) * step),
        unit.y + (Math.sin(heading) * step)
      );
      if (isOnLand(candidate.x, candidate.y)) continue;
      if (((candidate.x - unit.x) * (candidate.x - unit.x)) + ((candidate.y - unit.y) * (candidate.y - unit.y)) < 0.25) {
        continue;
      }
      if (!canNavalUnitOccupyPosition(unit, candidate.x, candidate.y, navalSpatialMap)) continue;
      unit.navalAvoidanceSideBias = preferredSide;
      return candidate;
    }
  }

  return null;
}

function getSafeNavalMovePosition(unit, desiredX, desiredY, navalSpatialMap) {
  const perfStart = PERF_DEBUG_ENABLED ? perfNowMs() : 0;
  const finishMove = (result) => {
    if (PERF_DEBUG_ENABLED) {
      perfRecord('naval.safeMove', perfNowMs() - perfStart);
    }
    return result;
  };
  if (!usesNavalContactCollision(unit) || !navalSpatialMap) {
    return finishMove({ x: desiredX, y: desiredY });
  }
  let blockers = collectNavalOverlapBlockers(unit, desiredX, desiredY, navalSpatialMap);
  if (blockers.length > 0 && tryDisplaceStationaryNavalBlockers(unit, desiredX, desiredY, navalSpatialMap, blockers)) {
    blockers = collectNavalOverlapBlockers(unit, desiredX, desiredY, navalSpatialMap);
  }
  if (blockers.length === 0) {
    unit.navalBlockedTicks = 0;
    unit.navalAvoidanceSideBias = null;
    return finishMove({ x: desiredX, y: desiredY });
  }

  // When heavily blocked by moving units with higher priority, yield (stay put)
  const currentBlockedTicks = Math.max(0, unit.navalBlockedTicks || 0);
  if (currentBlockedTicks > 15) {
    const hasHigherPriorityMovingBlocker = blockers.some(blocker => {
      if (isNavalUnitStationary(blocker)) return false;
      return compareNavalRightOfWay(blocker, unit) > 0;
    });
    if (hasHigherPriorityMovingBlocker) {
      // Yield: stay put and let the higher-priority unit pass
      unit.navalBlockedTicks = Math.min(30, currentBlockedTicks + 2);
      return finishMove({ x: unit.x, y: unit.y });
    }
  }

  const steeringCandidate = findNavalSteeringMovePosition(unit, desiredX, desiredY, navalSpatialMap, blockers);
  if (steeringCandidate) {
    unit.navalBlockedTicks = Math.min(30, Math.max(0, unit.navalBlockedTicks || 0) + 1);
    return finishMove(steeringCandidate);
  }

  // When very heavily blocked and steering failed, try immediate repath
  if (currentBlockedTicks > 20) {
    unit.navalNoProgressTicks = Math.max(unit.navalNoProgressTicks || 0, NAVAL_REPATH_NO_PROGRESS_TICKS);
  }

  let bestX = unit.x;
  let bestY = unit.y;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (low + high) * 0.5;
    const testX = unit.x + ((desiredX - unit.x) * mid);
    const testY = unit.y + ((desiredY - unit.y) * mid);
    let midBlockers = collectNavalOverlapBlockers(unit, testX, testY, navalSpatialMap);
    if (midBlockers.length > 0 && tryDisplaceStationaryNavalBlockers(unit, testX, testY, navalSpatialMap, midBlockers)) {
      midBlockers = collectNavalOverlapBlockers(unit, testX, testY, navalSpatialMap);
    }
    if (midBlockers.length === 0) {
      bestX = testX;
      bestY = testY;
      low = mid;
    } else {
      high = mid;
    }
  }
  const movedDistSq = ((bestX - unit.x) * (bestX - unit.x)) + ((bestY - unit.y) * (bestY - unit.y));
  // If binary search found almost no movement, don't jitter - just stay put
  if (movedDistSq < 1.0) {
    unit.navalBlockedTicks = Math.min(30, currentBlockedTicks + 2);
    return finishMove({ x: unit.x, y: unit.y });
  }
  unit.navalBlockedTicks = Math.min(30, currentBlockedTicks + 1);
  return finishMove({ x: bestX, y: bestY });
}

function getUnitFinalMoveTarget(unit) {
  if (!unit) return null;
  if (Array.isArray(unit.pathWaypoints) && unit.pathWaypoints.length > 0) {
    return unit.pathWaypoints[unit.pathWaypoints.length - 1];
  }
  if (Number.isFinite(unit.targetX) && Number.isFinite(unit.targetY)) {
    return { x: unit.targetX, y: unit.targetY };
  }
  return null;
}

function shouldRefreshChasePath(unit, desiredX, desiredY, now, tolerance = 220, minIntervalMs = 600) {
  if (!unit || !Number.isFinite(desiredX) || !Number.isFinite(desiredY)) return false;
  if (!Number.isFinite(now)) return true;

  const finalTarget = getUnitFinalMoveTarget(unit);
  if (!finalTarget) return true;

  const dx = finalTarget.x - desiredX;
  const dy = finalTarget.y - desiredY;
  if (((dx * dx) + (dy * dy)) > (tolerance * tolerance)) {
    return true;
  }

  if (!Number.isFinite(unit.lastChaseRepathAt)) {
    return false;
  }

  if ((now - unit.lastChaseRepathAt) < minIntervalMs) {
    return false;
  }

  return (unit.navalNoProgressTicks || 0) >= NAVAL_REPATH_NO_PROGRESS_TICKS;
}

function tryRefreshNavalRoute(unit, now) {
  if (!usesNavalContactCollision(unit)) return false;
  if (!Number.isFinite(now)) return false;
  if ((unit.navalNoProgressTicks || 0) < NAVAL_REPATH_NO_PROGRESS_TICKS) return false;
  if ((now - (unit.navalLastRepathAt || 0)) < NAVAL_REPATH_COOLDOWN_MS) return false;

  const finalTarget = getUnitFinalMoveTarget(unit);
  if (!finalTarget) return false;

  const moveTarget = findNearestNavalPassableWaterPosition(unit, finalTarget.x, finalTarget.y, 360) || finalTarget;
  if (isStraightPathTerrainPassable(unit, unit.x, unit.y, moveTarget.x, moveTarget.y)) {
    unit.pathWaypoints = null;
    unit.targetX = moveTarget.x;
    unit.targetY = moveTarget.y;
    unit.navalLastRepathAt = now;
    unit.navalNoProgressTicks = 0;
    unit.navalBlockedTicks = 0;
    return true;
  }

  const blockedTicks = Math.max(0, unit.navalBlockedTicks || 0);
  if (blockedTicks > 4 && blockedTicks < 18) {
    unit.navalLastRepathAt = now;
    unit.navalAvoidanceSideBias = unit.navalAvoidanceSideBias === 1 ? -1 : 1;
    unit.navalNoProgressTicks = Math.max(0, NAVAL_REPATH_NO_PROGRESS_TICKS - 4);
    return false;
  }

  const repath = findPath(unit.x, unit.y, moveTarget.x, moveTarget.y, unit.type, 'naval.refresh');
  unit.navalLastRepathAt = now;

  if (repath && repath.length > 1) {
    unit.pathWaypoints = repath.slice(1);
    const next = unit.pathWaypoints.shift();
    unit.targetX = next.x;
    unit.targetY = next.y;
    if (unit.pathWaypoints.length === 0) unit.pathWaypoints = null;
    unit.navalNoProgressTicks = 0;
    unit.navalBlockedTicks = 0;
    return true;
  }

  unit.navalAvoidanceSideBias = unit.navalAvoidanceSideBias === 1 ? -1 : 1;
  unit.navalBlockedTicks = Math.max(0, (unit.navalBlockedTicks || 0) - 5);
  return false;
}

function getRoomHumanCount(roomId) {
  const room = gameRooms.get(roomId);
  if (!room) return 0;

  let humanCount = 0;
  room.players.forEach(player => {
    if (player && !player.isAI && player.online !== false) {
      humanCount++;
    }
  });
  return humanCount;
}

function roomHasHumanPlayers(roomId) {
  return getRoomHumanCount(roomId) > 0;
}

// Switch context to a specific room
function switchRoom(roomId) {
  const room = gameRooms.get(roomId);
  if (!room) return false;
  gameState = room;
  currentRoomId = roomId;
  nextSlbmId = room.nextSlbmId;
  return true;
}

function removePlayerEntities(userId) {
  const unitsToDelete = [];
  gameState.units.forEach((unit, unitId) => {
    if (unit.userId === userId) {
      unitsToDelete.push(unitId);
    }
  });
  unitsToDelete.forEach(unitId => gameState.units.delete(unitId));

  const buildingsToDelete = [];
  gameState.buildings.forEach((building, buildingId) => {
    if (building.userId === userId) {
      buildingsToDelete.push(buildingId);
    }
  });
  buildingsToDelete.forEach(buildingId => gameState.buildings.delete(buildingId));
}

function removePlayerFromCurrentRoom(userId, options = {}) {
  const { emitPlayerLeft = false } = options;
  removePlayerEntities(userId);
  gameState.players.delete(userId);
  gameState.fogOfWar.delete(userId);
  if (emitPlayerLeft && currentRoomId) {
    io.to(currentRoomId).emit('playerLeft', userId);
  }
}

// Save slbmId back to room
function syncSlbmId() {
  if (gameState) {
    gameState.nextSlbmId = nextSlbmId;
  }
}

function clearCurrentRoomTransientState() {
  if (!gameState) return;
  gameState.activeSlbms.clear();
  if (gameState.activeAirstrikes) {
    gameState.activeAirstrikes.clear();
  }
}

function getConnectedSocketsForRoom(roomId) {
  const socketsInRoom = [];
  io.of('/').sockets.forEach(socket => {
    if (socket.roomId === roomId) {
      socketsInRoom.push(socket);
    }
  });
  return socketsInRoom;
}

function annihilateRoom(roomId, message = ROOM_ANNIHILATION_MESSAGE) {
  const room = gameRooms.get(roomId);
  if (!room) {
    return null;
  }

  const previousRoomId = currentRoomId;
  switchRoom(roomId);

  const defeatedPlayers = Array.from(gameState.players.values());
  const humanCount = defeatedPlayers.filter(player => !player.isAI).length;
  const aiCount = defeatedPlayers.filter(player => player.isAI).length;
  const socketsInRoom = getConnectedSocketsForRoom(roomId);

  if (socketsInRoom.length > 0) {
    io.to(roomId).emit('serverAnnihilation', { message });
  }

  gameState.aiRespawnTimers.forEach(timer => clearTimeout(timer));
  gameState.aiRespawnTimers.clear();
  clearCurrentRoomTransientState();
  gameState.activeRedZones = [];
  gameState.lastRedZoneCountdownSecond = null;
  gameState.nextRedZoneRollAt = Date.now() + RED_ZONE_SELECTION_INTERVAL_MS;
  gameState.units.clear();
  gameState.buildings.clear();
  gameState.players.clear();
  gameState.fogOfWar.clear();
  if (gameState.pathCache) {
    gameState.pathCache.clear();
  }
  gameState.lastUpdate = Date.now();
  syncSlbmId();

  if (socketsInRoom.length > 0) {
    setTimeout(() => {
      socketsInRoom.forEach(socket => {
        try {
          socket.disconnect(true);
        } catch (error) {
          console.warn(`Failed to disconnect annihilated room socket ${socket.id}:`, error);
        }
      });
    }, 1700);
  }

  if (previousRoomId && gameRooms.has(previousRoomId)) {
    switchRoom(previousRoomId);
  }

  return {
    roomId,
    humanCount,
    aiCount,
    totalCount: defeatedPlayers.length
  };
}

function calculatePlayerScore(player) {
  if (!player) return 0;

  const combatPower = Number.isFinite(player.combatPower) ? player.combatPower : 0;
  const scoreFromKills = getPlayerScoreFromKills(player);

  return Math.floor(combatPower + scoreFromKills);
}

// Initialize map
function initializeMap() {
  const MAP_SIZE = mapConfig.mapSize;
  const gridSize = mapConfig.gridSize;
  const cellSize = MAP_SIZE / gridSize;
  const map = {
    width: MAP_SIZE,
    height: MAP_SIZE,
    gridSize,
    cellSize,
    terrain: [], // 0 = water, 1 = land
    imagePath: normalizeMapImagePath(mapConfig.images && mapConfig.images.map),
    landCells: [],
    landCellSet: new Set(),
    obstacles: [],
    resources: [],
    hostileMobs: []
  };

  const existingTerrain = loadTerrainGrid(gridSize);
  if (existingTerrain) {
    map.terrain = existingTerrain;
    console.log(`Loaded persisted terrain grid from ${TERRAIN_GRID_PATH}`);
  } else {
    map.terrain = generateTerrainGrid(gridSize);
    saveTerrainGrid(map.terrain, MAP_SIZE, MAP_SIZE);
    console.log(`Generated new terrain grid and saved to ${TERRAIN_GRID_PATH}`);
  }

  const landData = buildLandDataFromTerrain(map.terrain);
  map.landCells = landData.landCells;
  map.landCellSet = landData.landCellSet;

  // Add resources on land (with overlap prevention)
  for (const [x, y] of map.landCells) {
    if (Math.random() < 0.15) {
      const newX = x * cellSize + (cellSize / 2);
      const newY = y * cellSize + (cellSize / 2);

      // Check if too close to existing resources
      const minDistance = mapConfig.resources.radius * 2.5;
      let tooClose = false;
      for (const resource of map.resources) {
        const dx = newX - resource.x;
        const dy = newY - resource.y;
        if (Math.sqrt(dx * dx + dy * dy) < minDistance) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        const resourceId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
        map.resources.push({
          id: resourceId,
          x: newX,
          y: newY,
          amount: mapConfig.resources.amount.min + Math.floor(Math.random() * (mapConfig.resources.amount.max - mapConfig.resources.amount.min)),
          maxAmount: mapConfig.resources.amount.max,
          radius: mapConfig.resources.radius
        });
      }
    }
  }

  // AI players now replace hostile mobs
  // Hostile mobs array kept empty for compatibility
  map.hostileMobs = [];

  gameState.map = map;
  gameState.landCellsSnapshot = buildLandCellsSnapshot(map);
  saveLandCellsSnapshot(gameState.landCellsSnapshot);
  console.log(`Land cell snapshot saved to ${LAND_CELLS_PATH} (${gameState.landCellsSnapshot.landCells.length} cells)`);
}

// Initialize all game rooms
function initializeRooms() {
  // Create a temporary gameState for map initialization
  gameState = createRoomState();
  initializeMap();
  const sharedMap = gameState.map;
  const sharedLandCells = gameState.landCellsSnapshot;

  // Create each room with its own copy of the map (shared terrain, separate resources)
  ROOM_CONFIG.forEach(rc => {
    const room = createRoomState();
    // Deep copy map for each room (resources need to be independent)
    room.map = {
      ...sharedMap,
      resources: sharedMap.resources.map(r => ({ ...r })),
      landCells: sharedMap.landCells,
      landCellSet: sharedMap.landCellSet
    };
    room.landCellsSnapshot = sharedLandCells;
    gameRooms.set(rc.id, room);
    console.log(`Room '${rc.name}' (${rc.id}) initialized`);
  });
}

initializeRooms();

// Helper function to check if a position is on land
function isOnLand(x, y) {
  const map = gameState.map;
  if (!map || !map.landCellSet) return false;
  
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const gridX = Math.floor(x / cellSize);
  const gridY = Math.floor(y / cellSize);
  
  if (gridX < 0 || gridX >= gridSize || gridY < 0 || gridY >= gridSize) {
    return false;
  }
  
  return map.landCellSet.has((gridY * gridSize) + gridX);
}

function isWithinMapBounds(x, y) {
  const map = gameState.map;
  if (!map) return false;
  return x >= 0 && x <= map.width && y >= 0 && y <= map.height;
}

function clampToMapBounds(x, y) {
  const map = gameState.map;
  if (!map) return { x, y };
  return {
    x: Math.max(0, Math.min(map.width, x)),
    y: Math.max(0, Math.min(map.height, y))
  };
}

function revealFogCircleForPlayer(playerFog, worldX, worldY, radius, now) {
  if (!ENABLE_SERVER_FOG_SNAPSHOTS) return;
  const map = gameState.map;
  if (!map || !playerFog) return;

  const cellSize = map.cellSize || 50;
  const gridX = Math.floor(worldX / cellSize);
  const gridY = Math.floor(worldY / cellSize);
  const gridRadius = Math.ceil(radius / cellSize);

  for (let dx = -gridRadius; dx <= gridRadius; dx++) {
    for (let dy = -gridRadius; dy <= gridRadius; dy++) {
      if (dx * dx + dy * dy <= gridRadius * gridRadius) {
        const key = `${gridX + dx}_${gridY + dy}`;
        playerFog.set(key, { lastSeen: now, explored: true });
      }
    }
  }
}

function revealFogCircleForAllPlayers(worldX, worldY, radius, now) {
  if (!ENABLE_SERVER_FOG_SNAPSHOTS) return;
  gameState.players.forEach((player, playerId) => {
    if (!gameState.fogOfWar.has(playerId)) {
      gameState.fogOfWar.set(playerId, new Map());
    }
    revealFogCircleForPlayer(gameState.fogOfWar.get(playerId), worldX, worldY, radius, now);
  });
}

function hasAdjacentWaterTileForBuilding(x, y, size) {
  const map = gameState.map;
  if (!map || !map.landCellSet) return false;

  const cellSize = map.cellSize;
  const gridSize = map.gridSize;
  const halfSize = size / 2;
  const minGX = Math.max(0, Math.floor((x - halfSize) / cellSize));
  const maxGX = Math.min(gridSize - 1, Math.floor((x + halfSize) / cellSize));
  const minGY = Math.max(0, Math.floor((y - halfSize) / cellSize));
  const maxGY = Math.min(gridSize - 1, Math.floor((y + halfSize) / cellSize));
  const footprintCells = new Set();
  const cardinalOffsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let gy = minGY; gy <= maxGY; gy++) {
    for (let gx = minGX; gx <= maxGX; gx++) {
      footprintCells.add(`${gx}_${gy}`);
    }
  }

  for (let gy = minGY; gy <= maxGY; gy++) {
    for (let gx = minGX; gx <= maxGX; gx++) {
      for (const [dx, dy] of cardinalOffsets) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
        if (footprintCells.has(`${nx}_${ny}`)) continue;
        if (!map.landCellSet.has((ny * gridSize) + nx)) {
          return true;
        }
      }
    }
  }

  return false;
}

function findNearestCoastalBuildingPosition(x, y, size, maxSearchRadius = 2000) {
  const map = gameState.map;
  if (!map) return clampToMapBounds(x, y);

  const clamped = clampToMapBounds(x, y);
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const centerGridX = Math.floor(clamped.x / cellSize);
  const centerGridY = Math.floor(clamped.y / cellSize);
  const maxCellRadius = Math.ceil(maxSearchRadius / cellSize);

  function getCandidate(gridX, gridY) {
    if (gridX < 0 || gridX >= gridSize || gridY < 0 || gridY >= gridSize) return null;
    const pos = getCellCenter(gridX, gridY);
    if (!pos) return null;
    if (!isOnLand(pos.x, pos.y)) return null;
    if (!hasAdjacentWaterTileForBuilding(pos.x, pos.y, size)) return null;
    return pos;
  }

  const directCandidate = getCandidate(centerGridX, centerGridY);
  if (directCandidate) return directCandidate;

  for (let radius = 1; radius <= maxCellRadius; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;
        const candidate = getCandidate(gridX, gridY);
        if (candidate) return candidate;
      }
    }
  }

  return findNearestLandPosition(x, y);
}

function getCellCenter(gridX, gridY) {
  const map = gameState.map;
  if (!map) return null;
  return {
    x: (gridX * map.cellSize) + (map.cellSize / 2),
    y: (gridY * map.cellSize) + (map.cellSize / 2)
  };
}

// Find nearest land position from a given position
function findNearestLandPosition(x, y) {
  const clamped = clampToMapBounds(x, y);
  if (isOnLand(clamped.x, clamped.y)) return clamped;
  
  const map = gameState.map;
  if (!map) return clamped;
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const centerGridX = Math.floor(clamped.x / cellSize);
  const centerGridY = Math.floor(clamped.y / cellSize);
  
  // Search in expanding circles
  for (let radius = 1; radius < gridSize; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;
        if (!map.landCellSet.has((gridY * gridSize) + gridX)) continue;
        return getCellCenter(gridX, gridY);
      }
    }
  }
  
  // Fallback to findStartPosition
  return findStartPosition();
}

function isAssaultShipNearLand(ship) {
  if (!ship || ship.type !== 'assaultship') return false;
  for (let radius = 120; radius <= ASSAULT_SHIP_LAND_RADIUS; radius += 40) {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const sampleX = ship.x + Math.cos(angle) * radius;
      const sampleY = ship.y + Math.sin(angle) * radius;
      if (isOnLand(sampleX, sampleY)) {
        return true;
      }
    }
  }
  return false;
}

function findNonOverlappingLandPosition(x, y, size) {
  const clamped = clampToMapBounds(x, y);
  const base = isOnLand(clamped.x, clamped.y) ? clamped : findNearestLandPosition(clamped.x, clamped.y);
  if (!base || !isOnLand(base.x, base.y)) {
    return null;
  }

  const radius = size * 0.45;
  for (let attempt = 0; attempt < 24; attempt++) {
    const ring = attempt === 0 ? 0 : Math.ceil(attempt / 8);
    const angle = attempt === 0 ? 0 : ((attempt - 1) / 8) * Math.PI * 2;
    const candidate = clampToMapBounds(
      base.x + Math.cos(angle) * ring * size * 0.9,
      base.y + Math.sin(angle) * ring * size * 0.9
    );
    if (!isOnLand(candidate.x, candidate.y)) continue;

    let hasOverlap = false;
    gameState.units.forEach(unit => {
      const dx = unit.x - candidate.x;
      const dy = unit.y - candidate.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const unitRadius = getUnitAreaHitRadius(unit);
      if (dist < radius + unitRadius) {
        hasOverlap = true;
      }
    });
    if (!hasOverlap) {
      return candidate;
    }
  }

  return base;
}

function isCoastalBuildingType(type) {
  return type === 'shipyard' || type === 'naval_academy';
}

function getBuildingPlacementSearchRadius() {
  const map = gameState && gameState.map;
  if (!map) return BUILDING_PLACEMENT_SEARCH_RADIUS;
  return Math.max(BUILDING_PLACEMENT_SEARCH_RADIUS, map.width, map.height);
}

function isBuildingPlacementValid(type, x, y, options = {}) {
  if (!gameState || !gameState.map) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  const clamped = clampToMapBounds(x, y);
  if (Math.abs(clamped.x - x) > 0.5 || Math.abs(clamped.y - y) > 0.5) {
    return false;
  }

  const candidateSize = options.size || getBuildingCollisionSize(type);
  if (!isOnLand(x, y)) return false;
  if (isCoastalBuildingType(type) && !hasAdjacentWaterTileForBuilding(x, y, candidateSize)) {
    return false;
  }

  const ignoreBuildingIds = options.ignoreBuildingIds instanceof Set ? options.ignoreBuildingIds : null;
  const ignoreBuildingId = options.ignoreBuildingId ?? null;
  let blocked = false;

  gameState.buildings.forEach(building => {
    if (blocked || !building) return;
    if (building.id === ignoreBuildingId) return;
    if (ignoreBuildingIds && ignoreBuildingIds.has(building.id)) return;

    const dx = building.x - x;
    const dy = building.y - y;
    const existingBuildingSize = getBuildingCollisionSize(building.type);
    const minDistance = (candidateSize / 2) + (existingBuildingSize / 2) + BUILDING_PLACEMENT_BUFFER;

    if ((dx * dx) + (dy * dy) < minDistance * minDistance) {
      blocked = true;
    }
  });

  return !blocked;
}

function findNearestValidBuildingPosition(type, x, y, options = {}) {
  if (!gameState || !gameState.map) return null;

  const map = gameState.map;
  const clamped = clampToMapBounds(x, y);
  if (isBuildingPlacementValid(type, clamped.x, clamped.y, options)) {
    return clamped;
  }

  const cellSize = Math.max(1, map.cellSize || 50);
  const gridSize = map.gridSize;
  const centerGridX = Math.max(0, Math.min(gridSize - 1, Math.floor(clamped.x / cellSize)));
  const centerGridY = Math.max(0, Math.min(gridSize - 1, Math.floor(clamped.y / cellSize)));
  const centerCandidate = getCellCenter(centerGridX, centerGridY);
  if (centerCandidate && isBuildingPlacementValid(type, centerCandidate.x, centerCandidate.y, options)) {
    return centerCandidate;
  }

  const maxSearchRadius = options.maxSearchRadius ?? getBuildingPlacementSearchRadius();
  const maxCellRadius = Math.max(1, Math.ceil(maxSearchRadius / cellSize));

  for (let radius = 1; radius <= maxCellRadius; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);
    let bestCandidate = null;
    let bestDistanceSq = Infinity;

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;

        const candidate = getCellCenter(gridX, gridY);
        if (!candidate) continue;
        if (!isBuildingPlacementValid(type, candidate.x, candidate.y, options)) continue;

        const dx = candidate.x - clamped.x;
        const dy = candidate.y - clamped.y;
        const distanceSq = (dx * dx) + (dy * dy);
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestCandidate = candidate;
        }
      }
    }

    if (bestCandidate) {
      return bestCandidate;
    }
  }

  return null;
}

function findNearestWaterPosition(x, y, maxSearchRadius = 220) {
  const map = gameState.map;
  if (!map) return null;

  const clamped = clampToMapBounds(x, y);
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const centerGridX = Math.floor(clamped.x / cellSize);
  const centerGridY = Math.floor(clamped.y / cellSize);

  if (centerGridX >= 0 && centerGridX < gridSize && centerGridY >= 0 && centerGridY < gridSize) {
    if (!map.landCellSet.has((centerGridY * gridSize) + centerGridX)) {
      return getCellCenter(centerGridX, centerGridY);
    }
  }

  const clampedRadius = Math.max(1, Math.min(maxSearchRadius, gridSize));

  for (let radius = 1; radius <= clampedRadius; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;
        if (map.landCellSet.has((gridY * gridSize) + gridX)) continue;
        return getCellCenter(gridX, gridY);
      }
    }
  }

  return null;
}

function getNavalTerrainClearanceCells(unitOrType) {
  const type = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
  if (type === 'battleship' || type === 'carrier' || type === 'assaultship' || type === 'cruiser') {
    return 1;
  }
  return 0;
}

function isNavalPositionTerrainPassable(unitOrType, x, y) {
  const type = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
  if (!isNavalUnitType(type)) {
    return !isOnLand(x, y);
  }
  const map = gameState.map;
  if (!map || !map.landCellSet) return !isOnLand(x, y);

  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const centerGX = Math.floor(x / cellSize);
  const centerGY = Math.floor(y / cellSize);
  const clearanceCells = getNavalTerrainClearanceCells(type);

  if (centerGX < 0 || centerGX >= gridSize || centerGY < 0 || centerGY >= gridSize) {
    return false;
  }

  for (let gy = centerGY - clearanceCells; gy <= centerGY + clearanceCells; gy++) {
    for (let gx = centerGX - clearanceCells; gx <= centerGX + clearanceCells; gx++) {
      if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) {
        return false;
      }
      if (map.landCellSet.has((gy * gridSize) + gx)) {
        return false;
      }
    }
  }
  return true;
}

function findNearestNavalPassableWaterPosition(unitOrType, x, y, maxSearchRadius = 220) {
  const map = gameState.map;
  if (!map) return null;

  const clamped = clampToMapBounds(x, y);
  if (isNavalPositionTerrainPassable(unitOrType, clamped.x, clamped.y)) {
    return clamped;
  }

  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const centerGridX = Math.max(0, Math.min(gridSize - 1, Math.floor(clamped.x / cellSize)));
  const centerGridY = Math.max(0, Math.min(gridSize - 1, Math.floor(clamped.y / cellSize)));
  const maxCellRadius = Math.max(1, Math.ceil(maxSearchRadius / cellSize));

  for (let radius = 1; radius <= maxCellRadius; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);
    let bestCandidate = null;
    let bestDistanceSq = Infinity;

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;

        const candidate = getCellCenter(gridX, gridY);
        if (!candidate) continue;
        if (!isNavalPositionTerrainPassable(unitOrType, candidate.x, candidate.y)) continue;

        const dx = candidate.x - clamped.x;
        const dy = candidate.y - clamped.y;
        const distanceSq = (dx * dx) + (dy * dy);
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestCandidate = candidate;
        }
      }
    }

    if (bestCandidate) {
      return bestCandidate;
    }
  }

  return findNearestWaterPosition(clamped.x, clamped.y, maxSearchRadius);
}

function isStraightPathTerrainPassable(unitOrType, fromX, fromY, toX, toY) {
  const type = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
  if (type === 'worker' || isAirUnitType(type)) {
    return true;
  }
  const map = gameState.map;
  if (!map) return true;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy);
  if (distance <= 1) {
    if (isLandCombatUnitType(type)) return isOnLand(toX, toY);
    if (isNavalUnitType(type)) return isNavalPositionTerrainPassable(unitOrType, toX, toY);
    return true;
  }

  const sampleStep = Math.max(30, (map.cellSize || 50) * 0.6);
  const samples = Math.max(1, Math.ceil(distance / sampleStep));
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const sampleX = fromX + (dx * t);
    const sampleY = fromY + (dy * t);
    if (isLandCombatUnitType(type)) {
      if (!isOnLand(sampleX, sampleY)) return false;
    } else if (isNavalUnitType(type)) {
      if (!isNavalPositionTerrainPassable(unitOrType, sampleX, sampleY)) return false;
    }
  }
  return true;
}

function assignMoveTarget(unit, targetX, targetY) {
  if (!unit) return false;
  const clampedTarget = clampToMapBounds(targetX, targetY);

  if (unit.type === 'worker') {
    // Workers can move anywhere (land + water) and still use pathfinding.
    const path = findPath(unit.x, unit.y, clampedTarget.x, clampedTarget.y, 'worker', 'assign.worker');
    if (path && path.length > 1) {
      unit.pathWaypoints = path.slice(1); // skip current position
      const next = unit.pathWaypoints.shift();
      unit.targetX = next.x;
      unit.targetY = next.y;
    } else {
      unit.pathWaypoints = null;
      unit.targetX = clampedTarget.x;
      unit.targetY = clampedTarget.y;
    }
    return true;
  }

  if (isLandCombatUnitType(unit)) {
    const landTarget = isOnLand(clampedTarget.x, clampedTarget.y)
      ? clampedTarget
      : findNearestLandPosition(clampedTarget.x, clampedTarget.y);
    if (isStraightPathTerrainPassable('land', unit.x, unit.y, landTarget.x, landTarget.y)) {
      unit.pathWaypoints = null;
      unit.targetX = landTarget.x;
      unit.targetY = landTarget.y;
      return true;
    }
    const path = findPath(unit.x, unit.y, landTarget.x, landTarget.y, 'land', 'assign.land');
    if (path && path.length > 1) {
      unit.pathWaypoints = path.slice(1);
      const next = unit.pathWaypoints.shift();
      unit.targetX = next.x;
      unit.targetY = next.y;
    } else {
      unit.pathWaypoints = null;
      unit.targetX = landTarget.x;
      unit.targetY = landTarget.y;
    }
    return true;
  }

  if (isAirUnitType(unit)) {
    // Air units ignore terrain and collisions, so they move directly.
    unit.pathWaypoints = null;
    unit.targetX = clampedTarget.x;
    unit.targetY = clampedTarget.y;
    return true;
  }

  // Ships can only move on water.
  resetNavalAvoidanceState(unit);
  let moveTarget = clampedTarget;
  if (!isNavalPositionTerrainPassable(unit, clampedTarget.x, clampedTarget.y)) {
    const nearestWater = findNearestNavalPassableWaterPosition(unit, clampedTarget.x, clampedTarget.y, 320);
    if (!nearestWater) {
      return false;
    }
    moveTarget = nearestWater;
  }

  if (isStraightPathTerrainPassable(unit, unit.x, unit.y, moveTarget.x, moveTarget.y)) {
    unit.pathWaypoints = null;
    unit.targetX = moveTarget.x;
    unit.targetY = moveTarget.y;
    return true;
  }

  // Use A* pathfinding for ships to navigate around islands
  const path = findPath(unit.x, unit.y, moveTarget.x, moveTarget.y, unit.type, 'assign.naval');
  if (path && path.length > 1) {
    unit.pathWaypoints = path.slice(1);
    const next = unit.pathWaypoints.shift();
    unit.targetX = next.x;
    unit.targetY = next.y;
  } else {
    unit.pathWaypoints = null;
    unit.targetX = moveTarget.x;
    unit.targetY = moveTarget.y;
  }
  return true;
}

function getUnitFormationMetrics(unit) {
  if (!unit) {
    return { lateralSpacing: 160, forwardSpacing: 500, keepOutRadius: 60 };
  }
  if (!usesNavalContactCollision(unit)) {
    return { lateralSpacing: 120, forwardSpacing: 140, keepOutRadius: 0 };
  }
  const { longAxis, shortAxis } = getUnitFormationSize(unit);
  // Use visual-size-aware spacing: sprites render at size*heightMult (~6.6x)
  // so formation spacing must account for actual rendered dimensions
  return {
    lateralSpacing: Math.round(shortAxis * 5 + 30),
    forwardSpacing: Math.round(longAxis * 6 + 50),
    keepOutRadius: Math.round(shortAxis * 2.5)
  };
}

function normalizeFormationTargetForUnit(unit, x, y) {
  const clamped = clampToMapBounds(x, y);
  if (unit.type === 'worker' || isAirUnitType(unit)) {
    return clamped;
  }
  if (isLandCombatUnitType(unit)) {
    return isOnLand(clamped.x, clamped.y)
      ? clamped
      : findNearestLandPosition(clamped.x, clamped.y);
  }
  return isNavalPositionTerrainPassable(unit, clamped.x, clamped.y)
    ? clamped
    : findNearestNavalPassableWaterPosition(unit, clamped.x, clamped.y, 160);
}

function isFormationTargetReserved(candidate, keepOutRadius, reservedTargets) {
  return reservedTargets.some(entry => {
    const dx = candidate.x - entry.x;
    const dy = candidate.y - entry.y;
    const minDistance = keepOutRadius + entry.keepOutRadius;
    return ((dx * dx) + (dy * dy)) < (minDistance * minDistance);
  });
}

function findAvailableFormationTarget(unit, desiredX, desiredY, reservedTargets) {
  const baseCandidate = normalizeFormationTargetForUnit(unit, desiredX, desiredY);
  if (!baseCandidate) {
    return clampToMapBounds(desiredX, desiredY);
  }

  const { keepOutRadius } = getUnitFormationMetrics(unit);
  if (!isFormationTargetReserved(baseCandidate, keepOutRadius, reservedTargets)) {
    return baseCandidate;
  }

  const cellSize = gameState.map?.cellSize || 50;
  const step = Math.max(cellSize, Math.round(keepOutRadius * 0.75));
  let bestCandidate = null;
  let bestScore = Infinity;
  const seen = new Set();

  for (let ring = 1; ring <= 8; ring++) {
    const sampleCount = Math.max(8, ring * 10);
    for (let i = 0; i < sampleCount; i++) {
      const angle = (Math.PI * 2 * i) / sampleCount;
      const sampleX = desiredX + (Math.cos(angle) * step * ring);
      const sampleY = desiredY + (Math.sin(angle) * step * ring);
      const candidate = normalizeFormationTargetForUnit(unit, sampleX, sampleY);
      if (!candidate) continue;
      const key = `${Math.round(candidate.x)}_${Math.round(candidate.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isFormationTargetReserved(candidate, keepOutRadius, reservedTargets)) continue;
      const dx = candidate.x - desiredX;
      const dy = candidate.y - desiredY;
      const score = (dx * dx) + (dy * dy);
      if (score < bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }
    if (bestCandidate) {
      return bestCandidate;
    }
  }

  return baseCandidate;
}

function resetNavalAvoidanceState(unit) {
  if (!usesNavalContactCollision(unit)) return;
  unit.navalAvoidanceSideBias = null;
  unit.navalBlockedTicks = 0;
  unit.navalNoProgressTicks = 0;
}

function normalizeAngle(angle) {
  if (!Number.isFinite(angle)) return 0;
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function getAngleDelta(currentAngle, targetAngle) {
  return normalizeAngle(targetAngle - currentAngle);
}

function turnAngleToward(currentAngle, targetAngle, maxStep) {
  if (!Number.isFinite(targetAngle)) {
    return Number.isFinite(currentAngle) ? normalizeAngle(currentAngle) : 0;
  }
  if (!Number.isFinite(currentAngle)) {
    return normalizeAngle(targetAngle);
  }
  const delta = getAngleDelta(currentAngle, targetAngle);
  if (Math.abs(delta) <= maxStep) {
    return normalizeAngle(targetAngle);
  }
  return normalizeAngle(currentAngle + (Math.sign(delta) * maxStep));
}

function rotateSquadLocalOffset(forwardOffset, lateralOffset, angle) {
  const forwardX = Math.cos(angle);
  const forwardY = Math.sin(angle);
  const sideX = -forwardY;
  const sideY = forwardX;
  return {
    x: (forwardX * forwardOffset) + (sideX * lateralOffset),
    y: (forwardY * forwardOffset) + (sideY * lateralOffset)
  };
}

function updateUnitSquadFormationOffsets(unit, centerX, centerY, worldX, worldY, angle) {
  const forwardX = Math.cos(angle);
  const forwardY = Math.sin(angle);
  const sideX = -forwardY;
  const sideY = forwardX;
  const dx = worldX - centerX;
  const dy = worldY - centerY;
  unit.squadForwardOffset = (dx * forwardX) + (dy * forwardY);
  unit.squadLateralOffset = (dx * sideX) + (dy * sideY);
  unit.squadOffsetX = dx;
  unit.squadOffsetY = dy;
}

function getUnitSquadDesiredWorldPosition(unit, centerX, centerY, angle) {
  const forwardOffset = Number.isFinite(unit.squadForwardOffset) ? unit.squadForwardOffset : 0;
  const lateralOffset = Number.isFinite(unit.squadLateralOffset) ? unit.squadLateralOffset : 0;
  const rotatedOffset = rotateSquadLocalOffset(forwardOffset, lateralOffset, angle);
  return {
    x: centerX + rotatedOffset.x,
    y: centerY + rotatedOffset.y,
    offsetX: rotatedOffset.x,
    offsetY: rotatedOffset.y
  };
}

function getSquadFormationUnitTier(unit) {
  const unitType = unit?.type;
  if (unitType === 'assaultship' || unitType === 'submarine') return 0;
  if (unitType === 'frigate') return 1;
  if (unitType === 'destroyer' || unitType === 'cruiser') return 2;
  if (unitType === 'battleship' || unitType === 'carrier') return 3;
  return Math.floor((unit?.attackRange || 0) / 500);
}

function getSquadFormationAssignmentKey(unit) {
  return `${getSquadFormationUnitTier(unit)}:${unit?.type || 'unknown'}`;
}

function getFormationLocalCoordinates(x, y, centerX, centerY, angle) {
  const forwardX = Math.cos(angle);
  const forwardY = Math.sin(angle);
  const sideX = -forwardY;
  const sideY = forwardX;
  const dx = x - centerX;
  const dy = y - centerY;
  return {
    forward: (dx * forwardX) + (dy * forwardY),
    lateral: (dx * sideX) + (dy * sideY)
  };
}

function compareFormationLocalOrder(a, b) {
  if (Math.abs(a.forward - b.forward) > 0.001) {
    return b.forward - a.forward;
  }
  if (Math.abs(a.lateral - b.lateral) > 0.001) {
    return a.lateral - b.lateral;
  }
  if (a.tieBreaker < b.tieBreaker) return -1;
  if (a.tieBreaker > b.tieBreaker) return 1;
  return 0;
}

function assignUnitsToFormationSlots(units, slots, anchorX, anchorY, targetX, targetY, angle) {
  if (!Array.isArray(units) || !Array.isArray(slots) || units.length !== slots.length) {
    return [];
  }
  if (units.length === 0) {
    return [];
  }

  const orderedUnits = units
    .map((unit) => ({
      unit,
      ...getFormationLocalCoordinates(unit.x, unit.y, anchorX, anchorY, angle),
      tieBreaker: String(unit.id || '')
    }))
    .sort(compareFormationLocalOrder)
    .map((entry) => entry.unit);

  const orderedSlots = slots
    .map((slot, index) => ({
      slot,
      ...getFormationLocalCoordinates(slot.x, slot.y, targetX, targetY, angle),
      tieBreaker: `${index}:${slot.unit?.type || ''}`
    }))
    .sort(compareFormationLocalOrder);

  if (orderedUnits.length > 12) {
    return orderedUnits.map((unit, index) => ({
      unit,
      x: orderedSlots[index].slot.x,
      y: orderedSlots[index].slot.y
    }));
  }

  const unitLocal = orderedUnits.map((unit) => getFormationLocalCoordinates(unit.x, unit.y, anchorX, anchorY, angle));
  const slotLocal = orderedSlots.map((entry) => getFormationLocalCoordinates(entry.slot.x, entry.slot.y, targetX, targetY, angle));
  const costs = orderedUnits.map((unit, unitIndex) => orderedSlots.map((entry, slotIndex) => {
    const dx = unit.x - entry.slot.x;
    const dy = unit.y - entry.slot.y;
    const baseCost = (dx * dx) + (dy * dy);
    const lateralPenalty = Math.abs(unitLocal[unitIndex].lateral - slotLocal[slotIndex].lateral) * 10;
    const forwardPenalty = Math.abs(unitLocal[unitIndex].forward - slotLocal[slotIndex].forward) * 4;
    return baseCost + lateralPenalty + forwardPenalty;
  }));

  const memo = new Map();
  const fullMask = (1 << orderedSlots.length) - 1;
  function solve(unitIndex, usedMask) {
    if (unitIndex >= orderedUnits.length) {
      return { cost: 0, slots: [] };
    }
    const memoKey = `${unitIndex}:${usedMask}`;
    if (memo.has(memoKey)) {
      return memo.get(memoKey);
    }

    let best = null;
    for (let slotIndex = 0; slotIndex < orderedSlots.length; slotIndex++) {
      const slotBit = 1 << slotIndex;
      if (usedMask & slotBit) continue;
      const next = solve(unitIndex + 1, usedMask | slotBit);
      const candidate = {
        cost: costs[unitIndex][slotIndex] + next.cost,
        slots: [slotIndex, ...next.slots]
      };
      if (!best || candidate.cost < best.cost) {
        best = candidate;
      }
      if ((usedMask | slotBit) === fullMask && unitIndex === 0) {
        break;
      }
    }

    memo.set(memoKey, best);
    return best;
  }

  const solution = solve(0, 0);
  if (!solution || !Array.isArray(solution.slots) || solution.slots.length !== orderedUnits.length) {
    return orderedUnits.map((unit, index) => ({
      unit,
      x: orderedSlots[index].slot.x,
      y: orderedSlots[index].slot.y
    }));
  }

  return orderedUnits.map((unit, index) => ({
    unit,
    x: orderedSlots[solution.slots[index]].slot.x,
    y: orderedSlots[solution.slots[index]].slot.y
  }));
}

function remapSquadFormationPositions(squad, units, canonicalPositions, targetX, targetY, angle) {
  if (!Array.isArray(canonicalPositions) || canonicalPositions.length <= 1) {
    return canonicalPositions;
  }

  const anchor = getSquadAnchorPosition(squad, units);
  const slotsByKey = new Map();
  canonicalPositions.forEach((position) => {
    const key = getSquadFormationAssignmentKey(position.unit);
    if (!slotsByKey.has(key)) {
      slotsByKey.set(key, []);
    }
    slotsByKey.get(key).push(position);
  });

  const unitsByKey = new Map();
  units.forEach((unit) => {
    const key = getSquadFormationAssignmentKey(unit);
    if (!unitsByKey.has(key)) {
      unitsByKey.set(key, []);
    }
    unitsByKey.get(key).push(unit);
  });

  const remapped = [];
  const assignedUnits = new Set();
  slotsByKey.forEach((slots, key) => {
    const matchingUnits = unitsByKey.get(key) || [];
    const assignments = assignUnitsToFormationSlots(
      matchingUnits,
      slots,
      anchor.x,
      anchor.y,
      targetX,
      targetY,
      angle
    );
    if (assignments.length === matchingUnits.length) {
      assignments.forEach((assignment) => {
        remapped.push(assignment);
        assignedUnits.add(assignment.unit.id);
      });
      return;
    }
    slots.forEach((position) => {
      remapped.push(position);
      assignedUnits.add(position.unit.id);
    });
  });

  canonicalPositions.forEach((position) => {
    if (!assignedUnits.has(position.unit.id)) {
      remapped.push(position);
    }
  });

  return remapped;
}

function getSquadCommandAngle(squad, centerX, centerY, targetX, targetY) {
  const dx = targetX - centerX;
  const dy = targetY - centerY;
  const currentAngle = Number.isFinite(squad?.targetAngle)
    ? squad.targetAngle
    : (Number.isFinite(squad?.moveAngle) ? squad.moveAngle : 0);
  if (((dx * dx) + (dy * dy)) <= (SQUAD_COMMAND_ANGLE_DEADZONE * SQUAD_COMMAND_ANGLE_DEADZONE)) {
    return currentAngle;
  }
  return Math.atan2(dy, dx);
}

function applySquadFormationLayout(squad, units, centerX, centerY, angle) {
  const canonicalPositions = getSquadFormationPositions(units, centerX, centerY, angle, squad.formationType || 'trapezoid');
  const positions = remapSquadFormationPositions(squad, units, canonicalPositions, centerX, centerY, angle);
  let formationRadius = 0;
  positions.forEach(({ unit, x, y }) => {
    updateUnitSquadFormationOffsets(unit, centerX, centerY, x, y, angle);
    formationRadius = Math.max(
      formationRadius,
      Math.hypot(unit.squadForwardOffset || 0, unit.squadLateralOffset || 0)
    );
  });
  squad.formationRadius = formationRadius;
  return positions;
}

function getSquadAnchorPosition(squad, units) {
  if (Number.isFinite(squad?.centerX) && Number.isFinite(squad?.centerY)) {
    return { x: squad.centerX, y: squad.centerY };
  }
  if (!Array.isArray(units) || units.length === 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: units.reduce((sum, unit) => sum + unit.x, 0) / units.length,
    y: units.reduce((sum, unit) => sum + unit.y, 0) / units.length
  };
}

function getSquadActualCenter(units) {
  if (!Array.isArray(units) || units.length === 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: units.reduce((sum, unit) => sum + unit.x, 0) / units.length,
    y: units.reduce((sum, unit) => sum + unit.y, 0) / units.length
  };
}

function squadHasStableFormationSlots(units) {
  return Array.isArray(units) && units.every(unit => (
    Number.isFinite(unit.squadForwardOffset) &&
    Number.isFinite(unit.squadLateralOffset)
  ));
}

function ensureSquadFormationSlots(squad, units, centerX, centerY, angle) {
  if (!squadHasStableFormationSlots(units)) {
    applySquadFormationLayout(squad, units, centerX, centerY, angle);
  }
}

function shouldIgnoreSquadCommand(squad, targetX, targetY, attackMove) {
  if (!squad) return false;
  if (squad.attackMove !== attackMove) return false;
  if (!Number.isFinite(squad.targetX) || !Number.isFinite(squad.targetY)) return false;
  return Math.hypot(targetX - squad.targetX, targetY - squad.targetY) < SQUAD_COMMAND_REISSUE_DISTANCE;
}

function updateSquadHeadingTarget(squad, proposedAngle, now) {
  const currentTarget = Number.isFinite(squad?.targetAngle)
    ? squad.targetAngle
    : normalizeAngle(proposedAngle);
  if (!Number.isFinite(proposedAngle)) {
    return currentTarget;
  }
  if (!Number.isFinite(currentTarget)) {
    squad.targetAngle = normalizeAngle(proposedAngle);
    squad.lastHeadingUpdateAt = now;
    return squad.targetAngle;
  }
  const delta = Math.abs(getAngleDelta(currentTarget, proposedAngle));
  const lastUpdatedAt = Number.isFinite(squad.lastHeadingUpdateAt) ? squad.lastHeadingUpdateAt : 0;
  if (
    delta >= SQUAD_HEADING_FORCE_DELTA ||
    (delta >= SQUAD_HEADING_HYSTERESIS && (now - lastUpdatedAt) >= SQUAD_HEADING_UPDATE_COOLDOWN_MS)
  ) {
    squad.targetAngle = normalizeAngle(proposedAngle);
    squad.lastHeadingUpdateAt = now;
  }
  return Number.isFinite(squad.targetAngle) ? squad.targetAngle : currentTarget;
}

function updateUnitSquadFacingTarget(unit, formationAngle, slotAngle, dist, slotRadius, now) {
  const chaseDistance = Math.max(slotRadius * 8, 180);
  const releaseDistance = Math.max(slotRadius * 5, 90);
  const fallbackAngle = Number.isFinite(unit.squadDesiredAngle)
    ? unit.squadDesiredAngle
    : formationAngle;
  let desiredAngle = fallbackAngle;
  const slotDeltaFromFormation = Math.abs(getAngleDelta(formationAngle, slotAngle));

  if (dist >= chaseDistance && slotDeltaFromFormation >= 0.55) {
    desiredAngle = slotAngle;
  } else if (dist <= releaseDistance) {
    desiredAngle = formationAngle;
  }

  const currentTarget = Number.isFinite(unit.squadDesiredAngle)
    ? unit.squadDesiredAngle
    : formationAngle;
  const delta = Math.abs(getAngleDelta(currentTarget, desiredAngle));
  const lastUpdatedAt = Number.isFinite(unit.squadDesiredAngleUpdatedAt) ? unit.squadDesiredAngleUpdatedAt : 0;
  if (
    !Number.isFinite(unit.squadDesiredAngle) ||
    delta >= SQUAD_HEADING_FORCE_DELTA ||
    (delta >= SQUAD_UNIT_FACING_HYSTERESIS && (now - lastUpdatedAt) >= SQUAD_HEADING_UPDATE_COOLDOWN_MS)
  ) {
    unit.squadDesiredAngle = normalizeAngle(desiredAngle);
    unit.squadDesiredAngleUpdatedAt = now;
  }
  return Number.isFinite(unit.squadDesiredAngle) ? unit.squadDesiredAngle : formationAngle;
}

// ==================== SQUAD (부대지정) SYSTEM ====================

function getUnitSquad(unit) {
  if (!unit || !unit.squadId) return null;
  return gameState.squads.get(unit.squadId) || null;
}

function getSquadSlowestSpeed(squad) {
  let minSpeed = Infinity;
  for (const uid of squad.unitIds) {
    const u = gameState.units.get(uid);
    if (u) minSpeed = Math.min(minSpeed, getUnitBaseSpeed(u));
  }
  return minSpeed === Infinity ? 6 : minSpeed;
}

function getSquadAliveUnits(squad) {
  const alive = [];
  for (const uid of squad.unitIds) {
    const u = gameState.units.get(uid);
    if (u && u.hp > 0) alive.push(u);
  }
  return alive;
}

function cleanupSquad(squadId) {
  const squad = gameState.squads.get(squadId);
  if (!squad) return;
  const alive = getSquadAliveUnits(squad);
  // Remove dead units from squad
  squad.unitIds = alive.map(u => u.id || [...gameState.units.entries()].find(([, v]) => v === u)?.[0]).filter(Boolean);
  if (squad.unitIds.length <= 1) {
    disbandSquadInternal(squadId);
  }
}

function disbandSquadInternal(squadId) {
  const squad = gameState.squads.get(squadId);
  if (!squad) return;
  for (const uid of squad.unitIds) {
    const u = gameState.units.get(uid);
    if (u) {
      u.squadId = null;
      u.speed = getUnitBaseSpeed(u);
      u.formingUp = false;
      u.formingUpUntil = null;
      u.squadOffsetX = null;
      u.squadOffsetY = null;
      u.squadForwardOffset = null;
      u.squadLateralOffset = null;
      u.squadDesiredAngle = null;
      u.squadDesiredAngleUpdatedAt = null;
    }
  }
  gameState.squads.delete(squadId);
}

function getUnitFormationSize(unit) {
  if (!unit) {
    return { longAxis: 70, shortAxis: 22 };
  }
  switch (unit.type) {
    case 'frigate':
      return { longAxis: 56, shortAxis: 18 };
    case 'destroyer':
      return { longAxis: 66, shortAxis: 20 };
    case 'cruiser':
      return { longAxis: 72, shortAxis: 21 };
    case 'submarine':
      return { longAxis: 74, shortAxis: 18 };
    case 'battleship':
      return { longAxis: 84, shortAxis: 25 };
    case 'carrier':
      return { longAxis: 82, shortAxis: 27 };
    case 'assaultship':
      return { longAxis: 78, shortAxis: 24 };
    case 'missile_launcher':
      return { longAxis: 40, shortAxis: 18 };
    case 'worker':
    case 'mine':
      return { longAxis: 22, shortAxis: 22 };
    default:
      return { longAxis: 68, shortAxis: 21 };
  }
}

function getSquadTrapezoidRole(unit) {
  const unitType = unit?.type;
  if (unitType === 'battleship' || unitType === 'carrier') return 'core';
  if (unitType === 'submarine' || unitType === 'assaultship') return 'rear';
  if (unitType === 'frigate' || unitType === 'destroyer') return 'front';
  if (unitType === 'cruiser') return 'mid';

  const range = unit?.attackRange || 0;
  if (range <= 1000) return 'front';
  if (range >= 2600) return 'core';
  if (range >= 1800) return 'mid';
  return 'rear';
}

function buildCompactTrapezoidRowCounts(count) {
  if (count <= 0) return [];
  if (count <= 3) return [count];
  if (count === 4) return [2, 2];
  if (count === 5) return [2, 2, 1];
  if (count === 6) return [2, 3, 1];
  if (count === 7) return [2, 3, 2];
  if (count === 8) return [3, 3, 2];
  if (count === 9) return [3, 3, 3];
  if (count === 10) return [3, 4, 3];
  if (count === 11) return [4, 4, 3];
  if (count === 12) return [4, 4, 4];

  const rowCounts = [];
  let remaining = count;
  while (remaining > 0) {
    const rowSize = Math.min(4, remaining);
    rowCounts.push(rowSize);
    remaining -= rowSize;
  }
  return rowCounts;
}

function createCompactTrapezoidSlotTemplates(targetX, targetY, moveAngle, units) {
  const rowCounts = buildCompactTrapezoidRowCounts(units.length);
  const forwardX = Math.cos(moveAngle);
  const forwardY = Math.sin(moveAngle);
  const sideX = -forwardY;
  const sideY = forwardX;
  const metrics = units.map(u => getUnitFormationMetrics(u));
  const lateralStep = Math.max(70, ...metrics.map(m => m.lateralSpacing));
  const rowStep = Math.max(130, ...metrics.map(m => m.forwardSpacing));
  const totalDepth = rowStep * Math.max(0, rowCounts.length - 1);
  const slots = [];

  for (let rowIndex = 0; rowIndex < rowCounts.length; rowIndex++) {
    const rowCount = rowCounts[rowIndex];
    const rowOffset = (totalDepth / 2) - (rowIndex * rowStep);
    const centerIndex = (rowCount - 1) / 2;

    for (let colIndex = 0; colIndex < rowCount; colIndex++) {
      const lateralOffset = (colIndex - centerIndex) * lateralStep;
      const centerDistance = Math.abs(colIndex - centerIndex);
      let role = 'mid';

      if (rowCounts.length === 1) {
        role = centerDistance <= 0.6 ? 'core' : 'front';
      } else if (rowIndex === 0) {
        role = 'front';
      } else if (rowCounts.length === 2) {
        role = centerDistance <= 0.6 ? 'core' : 'rear';
      } else if (rowIndex === rowCounts.length - 1) {
        role = 'rear';
      } else if (centerDistance <= 0.6) {
        role = 'core';
      } else {
        role = 'mid';
      }

      slots.push({
        x: targetX + sideX * lateralOffset + forwardX * rowOffset,
        y: targetY + sideY * lateralOffset + forwardY * rowOffset,
        role,
        rowIndex,
        colIndex,
        centerDistance
      });
    }
  }

  return slots;
}

function sortSquadUnitsForRole(units, role) {
  const sorted = [...units];
  if (role === 'core') {
    sorted.sort((a, b) => {
      const aValue = (a.type === 'battleship' ? 3 : (a.type === 'carrier' ? 2 : 1));
      const bValue = (b.type === 'battleship' ? 3 : (b.type === 'carrier' ? 2 : 1));
      if (aValue !== bValue) return bValue - aValue;
      return (b.attackRange || 0) - (a.attackRange || 0);
    });
    return sorted;
  }
  if (role === 'front') {
    sorted.sort((a, b) => (a.attackRange || 0) - (b.attackRange || 0));
    return sorted;
  }
  if (role === 'rear') {
    sorted.sort((a, b) => {
      const aRear = a.type === 'submarine' ? 0 : (a.type === 'assaultship' ? 1 : 2);
      const bRear = b.type === 'submarine' ? 0 : (b.type === 'assaultship' ? 1 : 2);
      if (aRear !== bRear) return aRear - bRear;
      return (b.attackRange || 0) - (a.attackRange || 0);
    });
    return sorted;
  }
  sorted.sort((a, b) => (b.attackRange || 0) - (a.attackRange || 0));
  return sorted;
}

function takeNextUnitForSlot(groups, preferences) {
  for (const groupName of preferences) {
    const group = groups.get(groupName);
    if (group && group.length > 0) {
      return group.shift();
    }
  }

  for (const group of groups.values()) {
    if (group.length > 0) {
      return group.shift();
    }
  }
  return null;
}

function getSquadFormationPositions(units, targetX, targetY, moveAngle, formationType) {
  if (!formationType) formationType = 'trapezoid';
  const sorted = [...units].sort((a, b) => (a.attackRange || 0) - (b.attackRange || 0));
  const count = sorted.length;
  if (count === 0) return [];

  const forwardX = Math.cos(moveAngle);
  const forwardY = Math.sin(moveAngle);
  const sideX = -forwardY;
  const sideY = forwardX;
  const FORMATION_GAP = 18;
  const MAX_PER_ROW = 4;
  const FLANK_MAX_PER_ROW = 3;
  const positions = [];
  const NON_COMBAT_TYPES = new Set(['assaultship', 'submarine']);

  // Tier grouping: same tier units can share rows, but same type stays adjacent
  function getUnitTier(u) {
    return getSquadFormationUnitTier(u);
  }

  function getRowWidth(row) {
    const widths = row.map(u => getUnitFormationSize(u).shortAxis * 2);
    return widths.reduce((s, w) => s + w, 0) + FORMATION_GAP * Math.max(0, row.length - 1);
  }
  function getRowDepth(row) {
    return row.reduce((m, u) => Math.max(m, getUnitFormationSize(u).longAxis * 2), 40);
  }
  function placeRow(rowUnits, fwdOff, latOff) {
    const widths = rowUnits.map(u => getUnitFormationSize(u).shortAxis * 2);
    const total = widths.reduce((s, w) => s + w, 0) + FORMATION_GAP * Math.max(0, rowUnits.length - 1);
    let cursor = latOff - total / 2;
    rowUnits.forEach((u, i) => {
      const hW = widths[i] / 2;
      const lat = cursor + hW;
      positions.push({ unit: u, x: targetX + sideX * lat + forwardX * fwdOff, y: targetY + sideY * lat + forwardY * fwdOff });
      cursor += widths[i] + FORMATION_GAP;
    });
  }
  function makeRows(arr, maxPerRow) {
    if (arr.length === 0) return [];
    // Sort by tier, then by type (same type adjacent), then by range
    const s = [...arr].sort((a, b) => {
      const ta = getUnitTier(a), tb = getUnitTier(b);
      if (ta !== tb) return ta - tb;
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      return (a.attackRange || 0) - (b.attackRange || 0);
    });
    // Group by tier (units in same tier can share a row)
    const tierGroups = [];
    for (const u of s) {
      const tier = getUnitTier(u);
      if (tierGroups.length === 0 || tierGroups[tierGroups.length - 1].tier !== tier) {
        tierGroups.push({ tier, units: [u] });
      } else {
        tierGroups[tierGroups.length - 1].units.push(u);
      }
    }
    const result = [];
    for (const g of tierGroups) {
      for (let i = 0; i < g.units.length; i += maxPerRow) {
        result.push(g.units.slice(i, i + maxPerRow));
      }
    }
    return result;
  }

  if (formationType === 'diamond') {
    // DIAMOND: long range center, short range outer, non-combat behind
    const combatUnits = [], nonCombatUnits = [];
    for (const u of sorted) { if (NON_COMBAT_TYPES.has(u.type)) nonCombatUnits.push(u); else combatUnits.push(u); }
    // Sort by tier desc (highest tier = center), then same type adjacent
    const byTierDesc = [...combatUnits].sort((a, b) => {
      const ta = getUnitTier(a), tb = getUnitTier(b);
      if (ta !== tb) return tb - ta;
      if (a.type !== b.type) return a.type < b.type ? -1 : 1;
      return (b.attackRange || 0) - (a.attackRange || 0);
    });
    const rings = [];
    let placed = 0, ri = 0;
    while (placed < byTierDesc.length) {
      const cap = ri === 0 ? 1 : 4 * ri;
      rings.push(byTierDesc.slice(placed, placed + cap));
      placed += rings[rings.length - 1].length;
      ri++;
    }
    const avgSize = combatUnits.length > 0 ? combatUnits.reduce((s, u) => s + getUnitFormationSize(u).longAxis * 2, 0) / combatUnits.length : 40;
    const ringSpacing = avgSize + FORMATION_GAP + NAVAL_COLLISION_CLEARANCE_BUFFER;
    for (let r = 0; r < rings.length; r++) {
      const ru = rings[r];
      if (r === 0) {
        positions.push({ unit: ru[0], x: targetX, y: targetY });
      } else {
        const dist = r * ringSpacing;
        const n = ru.length;
        for (let i = 0; i < n; i++) {
          const t = i / n;
          let px, py;
          if (t < 0.25) { const s2 = t / 0.25; px = dist * s2; py = dist * (1 - s2); }
          else if (t < 0.5) { const s2 = (t - 0.25) / 0.25; px = dist * (1 - s2); py = -dist * s2; }
          else if (t < 0.75) { const s2 = (t - 0.5) / 0.25; px = -dist * s2; py = -dist * (1 - s2); }
          else { const s2 = (t - 0.75) / 0.25; px = -dist * (1 - s2); py = dist * s2; }
          positions.push({ unit: ru[i], x: targetX + sideX * px + forwardX * py, y: targetY + sideY * px + forwardY * py });
        }
      }
    }
    if (nonCombatUnits.length > 0) {
      const rearDist = rings.length * ringSpacing + FORMATION_GAP;
      const ncW = nonCombatUnits.reduce((s, u) => s + getUnitFormationSize(u).shortAxis * 2, 0) + FORMATION_GAP * Math.max(0, nonCombatUnits.length - 1);
      let cur = -ncW / 2;
      for (const u of nonCombatUnits) {
        const w = getUnitFormationSize(u).shortAxis * 2;
        positions.push({ unit: u, x: targetX + sideX * (cur + w / 2) - forwardX * rearDist, y: targetY + sideY * (cur + w / 2) - forwardY * rearDist });
        cur += w + FORMATION_GAP;
      }
    }
    return positions;
  }

  // ===== TRAPEZOID =====
  const slotTemplates = createCompactTrapezoidSlotTemplates(targetX, targetY, moveAngle, sorted);
  const groups = new Map([
    ['front', sortSquadUnitsForRole(sorted.filter(unit => getSquadTrapezoidRole(unit) === 'front'), 'front')],
    ['mid', sortSquadUnitsForRole(sorted.filter(unit => getSquadTrapezoidRole(unit) === 'mid'), 'mid')],
    ['core', sortSquadUnitsForRole(sorted.filter(unit => getSquadTrapezoidRole(unit) === 'core'), 'core')],
    ['rear', sortSquadUnitsForRole(sorted.filter(unit => getSquadTrapezoidRole(unit) === 'rear'), 'rear')]
  ]);

  const orderedSlots = [...slotTemplates].sort((a, b) => {
    if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
    if (a.role !== b.role) {
      const rolePriority = { core: 0, front: 1, mid: 2, rear: 3 };
      return (rolePriority[a.role] ?? 9) - (rolePriority[b.role] ?? 9);
    }
    if (a.centerDistance !== b.centerDistance) return a.centerDistance - b.centerDistance;
    return a.colIndex - b.colIndex;
  });

  orderedSlots.forEach((slot) => {
    const preferences = slot.role === 'core'
      ? ['core', 'mid', 'rear', 'front']
      : (slot.role === 'front'
        ? ['front', 'mid', 'core', 'rear']
        : (slot.role === 'rear'
          ? ['rear', 'core', 'mid', 'front']
          : ['mid', 'core', 'front', 'rear']));
    const unit = takeNextUnitForSlot(groups, preferences);
    if (unit) {
      positions.push({ unit, x: slot.x, y: slot.y });
    }
  });

  return positions;
}

function getSquadPathfindType(squad) {
  const units = getSquadAliveUnits(squad);
  // Use the largest naval unit for clearance; fall back to 'ship' for all-naval, 'land' for land
  let hasNaval = false, hasLand = false, largestNaval = null;
  for (const u of units) {
    if (isNavalUnitType(u.type)) {
      hasNaval = true;
      if (!largestNaval) largestNaval = u.type;
      else {
        const cur = getNavalTerrainClearanceCells(largestNaval);
        const nxt = getNavalTerrainClearanceCells(u.type);
        if (nxt > cur) largestNaval = u.type;
      }
    } else if (isLandCombatUnitType(u.type)) {
      hasLand = true;
    }
  }
  if (hasNaval) return largestNaval || 'ship';
  if (hasLand) return 'land';
  return 'worker';
}

function resolveSquadCenterWaypoints(squad, centerX, centerY, targetX, targetY, reason) {
  const pathType = getSquadPathfindType(squad);
  const centerPath = findPath(centerX, centerY, targetX, targetY, pathType, reason);
  if (centerPath && centerPath.length > 1) {
    return centerPath.slice(1);
  }
  return null;
}

function getSquadActiveAnchorTarget(squad) {
  if (squad?.centerWaypoints && squad.centerWaypoints.length > 0) {
    return squad.centerWaypoints[0];
  }
  if (Number.isFinite(squad?.targetX) && Number.isFinite(squad?.targetY)) {
    return { x: squad.targetX, y: squad.targetY };
  }
  return null;
}

function getUnitQueuedDestination(unit) {
  if (!unit) return null;
  if (Array.isArray(unit.pathWaypoints) && unit.pathWaypoints.length > 0) {
    return unit.pathWaypoints[unit.pathWaypoints.length - 1];
  }
  if (Number.isFinite(unit.targetX) && Number.isFinite(unit.targetY)) {
    return { x: unit.targetX, y: unit.targetY };
  }
  return null;
}

function shouldRefreshSquadUnitTarget(unit, desiredX, desiredY) {
  const currentDestination = getUnitQueuedDestination(unit);
  const size = getUnitFormationSize(unit);
  const threshold = Math.max(
    SQUAD_FORMATION_RETARGET_DISTANCE,
    Math.max(size.longAxis, size.shortAxis) * 1.2
  );
  if (!currentDestination) return true;
  return Math.hypot(currentDestination.x - desiredX, currentDestination.y - desiredY) > threshold;
}

function getOrderedSquadUnitsForRetarget(units) {
  return [...units].sort((a, b) => {
    const aForward = Number.isFinite(a.squadForwardOffset) ? a.squadForwardOffset : 0;
    const bForward = Number.isFinite(b.squadForwardOffset) ? b.squadForwardOffset : 0;
    if (Math.abs(aForward - bForward) > 1) return bForward - aForward;
    const aLateral = Number.isFinite(a.squadLateralOffset) ? a.squadLateralOffset : 0;
    const bLateral = Number.isFinite(b.squadLateralOffset) ? b.squadLateralOffset : 0;
    if (Math.abs(aLateral - bLateral) > 1) return aLateral - bLateral;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function advanceSquadAnchorWaypointIfNeeded(squad) {
  if (!squad?.centerWaypoints || squad.centerWaypoints.length <= 0) {
    return false;
  }
  const threshold = Math.max(
    SQUAD_ANCHOR_WAYPOINT_REACHED_DISTANCE,
    Math.min(260, (squad.formationRadius || 0) * 0.45)
  );
  let advanced = false;
  while (squad.centerWaypoints.length > 0) {
    const nextWaypoint = squad.centerWaypoints[0];
    if (!nextWaypoint) {
      squad.centerWaypoints.shift();
      advanced = true;
      continue;
    }
    const distance = Math.hypot((squad.centerX || 0) - nextWaypoint.x, (squad.centerY || 0) - nextWaypoint.y);
    if (distance > threshold) {
      break;
    }
    squad.centerWaypoints.shift();
    advanced = true;
  }
  if (squad.centerWaypoints.length === 0) {
    squad.centerWaypoints = null;
  }
  return advanced;
}

function advanceSquadAnchorTowardTarget(squad, deltaTime) {
  if (!squad || !Number.isFinite(squad.centerX) || !Number.isFinite(squad.centerY)) {
    return false;
  }

  let changed = advanceSquadAnchorWaypointIfNeeded(squad);
  const activeTarget = getSquadActiveAnchorTarget(squad);
  if (!activeTarget) {
    return changed;
  }

  const dx = activeTarget.x - squad.centerX;
  const dy = activeTarget.y - squad.centerY;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0.001) {
    return changed;
  }

  const desiredAngle = Math.atan2(dy, dx);
  squad.moveAngle = Number.isFinite(squad.moveAngle)
    ? turnAngleToward(squad.moveAngle, desiredAngle, SQUAD_ROTATION_RATE)
    : desiredAngle;

  const speed = Math.max(0, getSquadSlowestSpeed(squad));
  const moveStep = Math.min(distance, speed * deltaTime * 60);
  if (moveStep > 0) {
    squad.centerX += (dx / distance) * moveStep;
    squad.centerY += (dy / distance) * moveStep;
    changed = true;
  }

  if (Math.hypot(activeTarget.x - squad.centerX, activeTarget.y - squad.centerY) <= SQUAD_ANCHOR_WAYPOINT_REACHED_DISTANCE) {
    if (squad.centerWaypoints && squad.centerWaypoints.length > 0) {
      squad.centerWaypoints.shift();
      if (squad.centerWaypoints.length === 0) {
        squad.centerWaypoints = null;
      }
      changed = true;
    } else if (Number.isFinite(squad.targetX) && Number.isFinite(squad.targetY)) {
      squad.centerX = squad.targetX;
      squad.centerY = squad.targetY;
      changed = true;
    }
  }

  return changed;
}

function refreshSquadFormationMovementTargets(squad, units, now, force = false) {
  if (!squad || !Array.isArray(units) || units.length === 0) return;
  if (!Number.isFinite(squad.centerX) || !Number.isFinite(squad.centerY)) return;
  if (!force) {
    const lastRetargetAt = Number.isFinite(squad.lastFormationRetargetAt) ? squad.lastFormationRetargetAt : 0;
    if ((now - lastRetargetAt) < SQUAD_FORMATION_RETARGET_INTERVAL_MS) {
      return;
    }
  }

  const angle = Number.isFinite(squad.moveAngle)
    ? squad.moveAngle
    : (Number.isFinite(squad.targetAngle) ? squad.targetAngle : 0);
  const reservedTargets = [];
  const orderedUnits = getOrderedSquadUnitsForRetarget(units);

  orderedUnits.forEach((unit) => {
    if (squad.attackMove && unit.attackTargetId) {
      return;
    }
    const desired = getUnitSquadDesiredWorldPosition(unit, squad.centerX, squad.centerY, angle);
    const resolvedTarget = usesNavalContactCollision(unit)
      ? findAvailableFormationTarget(unit, desired.x, desired.y, reservedTargets)
      : normalizeFormationTargetForUnit(unit, desired.x, desired.y);
    if (!resolvedTarget) {
      return;
    }
    if (usesNavalContactCollision(unit)) {
      const metrics = getUnitFormationMetrics(unit);
      reservedTargets.push({
        x: resolvedTarget.x,
        y: resolvedTarget.y,
        keepOutRadius: metrics.keepOutRadius
      });
    }
    if (force || shouldRefreshSquadUnitTarget(unit, resolvedTarget.x, resolvedTarget.y)) {
      assignMoveTarget(unit, resolvedTarget.x, resolvedTarget.y);
    }
  });

  squad.lastFormationRetargetAt = now;
}

function issueSquadMoveOrder(squad, targetX, targetY) {
  const units = getSquadAliveUnits(squad);
  if (units.length === 0) return;
  if (shouldIgnoreSquadCommand(squad, targetX, targetY, false)) return;

  const anchor = getSquadAnchorPosition(squad, units);
  const centerX = anchor.x;
  const centerY = anchor.y;
  const targetAngle = getSquadCommandAngle(squad, centerX, centerY, targetX, targetY);
  const slowestSpeed = getSquadSlowestSpeed(squad);

  // Rebuild slots for the new heading around the CURRENT anchor.
  squad.targetAngle = targetAngle;
  squad.moveAngle = targetAngle;
  const positions = applySquadFormationLayout(squad, units, centerX, centerY, targetAngle);

  squad.centerX = centerX;
  squad.centerY = centerY;
  squad.actualCenterX = centerX;
  squad.actualCenterY = centerY;
  squad.targetX = targetX;
  squad.targetY = targetY;
  squad.moving = true;
  squad.attackMove = false;
  squad.centerWaypoints = resolveSquadCenterWaypoints(
    squad,
    centerX,
    centerY,
    targetX,
    targetY,
    'squad.move.center'
  );
  squad.lastFormationRetargetAt = 0;

  positions.forEach(({ unit }) => {
    unit.speed = slowestSpeed;
    unit.holdPosition = false;
    unit.attackMove = false;
    unit.attackTargetId = null;
    unit.attackTargetType = null;
    unit.angle = targetAngle;
    unit.formingUp = false;
    unit.formingUpUntil = null;
    unit.targetX = null;
    unit.targetY = null;
    unit.pathWaypoints = null;
    resetNavalAvoidanceState(unit);
  });
}

function issueSquadAttackTarget(squad, targetId, targetType) {
  const units = getSquadAliveUnits(squad);
  units.forEach(unit => {
    if (canAcceptPlayerOrders(unit)) {
      unit.attackTargetId = targetId;
      unit.attackTargetType = targetType;
    }
  });
}

function issueSquadAttackMove(squad, targetX, targetY) {
  const units = getSquadAliveUnits(squad);
  if (units.length === 0) return;
  if (shouldIgnoreSquadCommand(squad, targetX, targetY, true)) return;

  const anchor = getSquadAnchorPosition(squad, units);
  const centerX = anchor.x;
  const centerY = anchor.y;
  const targetAngle = getSquadCommandAngle(squad, centerX, centerY, targetX, targetY);
  const slowestSpeed = getSquadSlowestSpeed(squad);

  // Rebuild slots for the new heading around the CURRENT anchor.
  squad.targetAngle = targetAngle;
  squad.moveAngle = targetAngle;
  const positions = applySquadFormationLayout(squad, units, centerX, centerY, targetAngle);

  squad.centerX = centerX;
  squad.centerY = centerY;
  squad.actualCenterX = centerX;
  squad.actualCenterY = centerY;
  squad.targetX = targetX;
  squad.targetY = targetY;
  squad.moving = true;
  squad.attackMove = true;
  squad.centerWaypoints = resolveSquadCenterWaypoints(
    squad,
    centerX,
    centerY,
    targetX,
    targetY,
    'squad.attackMove.center'
  );
  squad.lastFormationRetargetAt = 0;

  positions.forEach(({ unit }) => {
    unit.speed = slowestSpeed;
    unit.holdPosition = false;
    unit.attackMove = true;
    unit.attackTargetId = null;
    unit.attackTargetType = null;
    unit.angle = targetAngle;
    unit.formingUp = false;
    unit.formingUpUntil = null;
    unit.targetX = null;
    unit.targetY = null;
    unit.pathWaypoints = null;
    resetNavalAvoidanceState(unit);
  });
}

function issueGroupedMoveOrder(units, targetX, targetY, options = {}) {
  const movableUnits = Array.isArray(units) ? units.filter(Boolean) : [];
  if (movableUnits.length <= 0) return;
  movableUnits.forEach(resetNavalAvoidanceState);

  const centerX = movableUnits.reduce((sum, unit) => sum + unit.x, 0) / movableUnits.length;
  const centerY = movableUnits.reduce((sum, unit) => sum + unit.y, 0) / movableUnits.length;
  const targetDx = targetX - centerX;
  const targetDy = targetY - centerY;
  const targetDist = Math.hypot(targetDx, targetDy);
  let forwardX = 0;
  let forwardY = -1;
  if (targetDist > 0.001) {
    forwardX = targetDx / targetDist;
    forwardY = targetDy / targetDist;
  } else {
    const headingX = movableUnits.reduce((sum, unit) => sum + Math.cos(unit.angle || 0), 0);
    const headingY = movableUnits.reduce((sum, unit) => sum + Math.sin(unit.angle || 0), 0);
    const headingLength = Math.hypot(headingX, headingY);
    if (headingLength > 0.001) {
      forwardX = headingX / headingLength;
      forwardY = headingY / headingLength;
    }
  }
  const sideX = -forwardY;
  const sideY = forwardX;
  const preserveCurrentNavalOffsets = movableUnits.length > 1
    && movableUnits.length <= 8
    && movableUnits.every(unit => usesNavalContactCollision(unit));
  const reservedTargets = [];

  if (preserveCurrentNavalOffsets) {
    const translatedFormation = movableUnits
      .map(unit => {
        const relX = unit.x - centerX;
        const relY = unit.y - centerY;
        return {
          unit,
          forwardOffset: (relX * forwardX) + (relY * forwardY),
          lateralOffset: (relX * sideX) + (relY * sideY)
        };
      })
      .sort((a, b) => {
        if (Math.abs(a.lateralOffset - b.lateralOffset) > 1) return a.lateralOffset - b.lateralOffset;
        return a.forwardOffset - b.forwardOffset;
      });

    translatedFormation.forEach(({ unit, forwardOffset, lateralOffset }) => {
      const desiredX = targetX + (sideX * lateralOffset) + (forwardX * forwardOffset);
      const desiredY = targetY + (sideY * lateralOffset) + (forwardY * forwardOffset);
      const resolvedTarget = findAvailableFormationTarget(unit, desiredX, desiredY, reservedTargets);
      if (resolvedTarget) {
        const metrics = getUnitFormationMetrics(unit);
        reservedTargets.push({
          x: resolvedTarget.x,
          y: resolvedTarget.y,
          keepOutRadius: metrics.keepOutRadius
        });
        assignMoveTarget(unit, resolvedTarget.x, resolvedTarget.y);
      } else {
        assignMoveTarget(unit, desiredX, desiredY);
      }
    });
    return;
  }

  const formationUnits = [...movableUnits].sort((a, b) => {
    const aSide = ((a.x - centerX) * sideX) + ((a.y - centerY) * sideY);
    const bSide = ((b.x - centerX) * sideX) + ((b.y - centerY) * sideY);
    if (Math.abs(aSide - bSide) > 1) return aSide - bSide;
    const aForward = ((a.x - centerX) * forwardX) + ((a.y - centerY) * forwardY);
    const bForward = ((b.x - centerX) * forwardX) + ((b.y - centerY) * forwardY);
    return aForward - bForward;
  });

  const columns = Math.max(1, Math.ceil(Math.sqrt(formationUnits.length)));
  const lateralSpacing = formationUnits.reduce((max, unit) => Math.max(max, getUnitFormationMetrics(unit).lateralSpacing), 120);
  const rowSpacing = formationUnits.reduce((max, unit) => Math.max(max, getUnitFormationMetrics(unit).forwardSpacing), 140);

  formationUnits.forEach((unit, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const lateralOffset = (column - ((columns - 1) / 2)) * lateralSpacing;
    const trailingOffset = row * rowSpacing;
    const desiredX = targetX + (sideX * lateralOffset) - (forwardX * trailingOffset);
    const desiredY = targetY + (sideY * lateralOffset) - (forwardY * trailingOffset);
    const shouldReserveSlot = usesNavalContactCollision(unit);
    const resolvedTarget = shouldReserveSlot
      ? findAvailableFormationTarget(unit, desiredX, desiredY, reservedTargets)
      : normalizeFormationTargetForUnit(unit, desiredX, desiredY);
    if (resolvedTarget) {
      if (shouldReserveSlot) {
        const metrics = getUnitFormationMetrics(unit);
        reservedTargets.push({
          x: resolvedTarget.x,
          y: resolvedTarget.y,
          keepOutRadius: metrics.keepOutRadius
        });
      }
      assignMoveTarget(unit, resolvedTarget.x, resolvedTarget.y);
    } else {
      assignMoveTarget(unit, desiredX, desiredY);
    }
  });
}

// ==================== A* PATHFINDING ====================
// Uses a coarse grid for performance on large 40000x40000 maps.
// STEP=2 means each path cell = 2x2 terrain cells (100x100 world units).

function findPath(fromX, fromY, toX, toY, unitKind, reason = 'generic') {
  const perfStart = PERF_DEBUG_ENABLED ? perfNowMs() : 0;
  let perfIterations = 0;
  const metricBaseName = `path.find.${reason}`;
  const finishPath = (result, metricName = metricBaseName) => {
    if (PERF_DEBUG_ENABLED) {
      perfRecord(metricName, perfNowMs() - perfStart, 1, perfIterations);
    }
    return result;
  };
  const map = gameState.map;
  if (!map) return finishPath(null);

  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const STEP = 2; // Finer grid for more accurate pathing
  const pathGridSize = Math.ceil(gridSize / STEP);
  const isWorkerPath = unitKind === 'worker';
  const isLandPath = unitKind === 'land';
  const isNavalPath = !isWorkerPath && !isLandPath && (unitKind === 'ship' || isNavalUnitType(unitKind));
  const navalClearanceCells = isNavalPath ? getNavalTerrainClearanceCells(unitKind === 'ship' ? null : unitKind) : 0;

  const startGX = Math.floor(fromX / cellSize / STEP);
  const startGY = Math.floor(fromY / cellSize / STEP);
  const endGX = Math.floor(toX / cellSize / STEP);
  const endGY = Math.floor(toY / cellSize / STEP);

  const clamp = (v, max) => Math.max(0, Math.min(max - 1, v));
  const sgx = clamp(startGX, pathGridSize);
  const sgy = clamp(startGY, pathGridSize);
  const egx = clamp(endGX, pathGridSize);
  const egy = clamp(endGY, pathGridSize);
  const pathCache = gameState?.pathCache || null;

  // Check if a coarse cell is passable by checking ALL terrain cells in it.
  // Ships require water, land vehicles require land, workers go anywhere.
  function isPassable(gx, gy) {
    if (isWorkerPath) return true;
    const requireLand = isLandPath;
    const minOffset = requireLand ? 0 : -navalClearanceCells;
    const maxOffset = requireLand ? (STEP - 1) : (STEP - 1 + navalClearanceCells);
    for (let dy = minOffset; dy <= maxOffset; dy++) {
      for (let dx = minOffset; dx <= maxOffset; dx++) {
        const cx = gx * STEP + dx;
        const cy = gy * STEP + dy;
        if (cx >= gridSize || cy >= gridSize) return false;
        if (cx < 0 || cy < 0) return false;
        const isLandCell = map.landCellSet.has(cy * gridSize + cx);
        if (requireLand ? !isLandCell : isLandCell) return false;
      }
    }
    return true;
  }

  // Pre-check: if destination not passable, find nearest passable cell
  let destGX = egx, destGY = egy;
  if (!isPassable(destGX, destGY)) {
    // Search expanding ring for nearest passable cell
    let found = false;
    for (let r = 1; r <= 20 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
          const nx = egx + dx, ny = egy + dy;
          if (nx >= 0 && nx < pathGridSize && ny >= 0 && ny < pathGridSize && isPassable(nx, ny)) {
            destGX = nx;
            destGY = ny;
            found = true;
          }
        }
      }
    }
    if (!found) return finishPath(null); // no reachable destination
  }

  if (sgx === destGX && sgy === destGY) return finishPath(null);

  const cacheKey = `${unitKind}:${sgx}:${sgy}:${destGX}:${destGY}`;
  if (pathCache) {
    const cached = pathCache.get(cacheKey);
    if (cached && (Date.now() - cached.createdAt) <= PATH_CACHE_TTL_MS) {
      return finishPath(cached.path, `path.findCached.${reason}`);
    }
  }

  // A* with binary heap for performance
  const keyOf = (x, y) => y * pathGridSize + x;
  const endKey = keyOf(destGX, destGY);

  function heuristic(ax, ay) {
    const dx = Math.abs(ax - destGX);
    const dy = Math.abs(ay - destGY);
    return (dx + dy) + (1.414 - 2) * Math.min(dx, dy); // octile distance
  }

  // Simple binary min-heap on f values
  const gScore = new Float32Array(pathGridSize * pathGridSize).fill(Infinity);
  const fScore = new Float32Array(pathGridSize * pathGridSize).fill(Infinity);
  const cameFrom = new Int32Array(pathGridSize * pathGridSize).fill(-1);
  const inClosed = new Uint8Array(pathGridSize * pathGridSize);

  const startKey = keyOf(sgx, sgy);
  gScore[startKey] = 0;
  fScore[startKey] = heuristic(sgx, sgy);

  // Open set as an array-based min-heap of keys
  const heap = [startKey];
  const inOpen = new Uint8Array(pathGridSize * pathGridSize);
  inOpen[startKey] = 1;

  function heapPush(key) {
    heap.push(key);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fScore[heap[parent]] <= fScore[heap[i]]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < heap.length && fScore[heap[l]] < fScore[heap[smallest]]) smallest = l;
        if (r < heap.length && fScore[heap[r]] < fScore[heap[smallest]]) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }

  const dirs = [[-1,0,1],[1,0,1],[0,-1,1],[0,1,1],[-1,-1,1.414],[-1,1,1.414],[1,-1,1.414],[1,1,1.414]];
  const MAX_ITERATIONS = 8000;
  let iterations = 0;

  while (heap.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    perfIterations = iterations;
    const currentKey = heapPop();
    inOpen[currentKey] = 0;

    if (currentKey === endKey) {
      // Reconstruct path
      const pathCells = [];
      let k = currentKey;
      while (k !== -1) {
        const py = Math.floor(k / pathGridSize);
        const px = k % pathGridSize;
        pathCells.unshift({ gx: px, gy: py });
        k = cameFrom[k];
      }
      // Convert to world coordinates (center of coarse cell)
      const halfStep = Math.floor(STEP / 2);
      const resolvedPath = pathCells.map(n => ({
        x: (n.gx * STEP + halfStep) * cellSize + cellSize / 2,
        y: (n.gy * STEP + halfStep) * cellSize + cellSize / 2
      }));
      if (pathCache) {
        pathCache.set(cacheKey, { createdAt: Date.now(), path: resolvedPath });
        if (pathCache.size > PATH_CACHE_MAX_ENTRIES) {
          const oldestKey = pathCache.keys().next().value;
          if (oldestKey !== undefined) {
            pathCache.delete(oldestKey);
          }
        }
      }
      return finishPath(resolvedPath);
    }

    inClosed[currentKey] = 1;
    const cy = Math.floor(currentKey / pathGridSize);
    const cx = currentKey % pathGridSize;

    for (const [ddx, ddy, cost] of dirs) {
      const nx = cx + ddx;
      const ny = cy + ddy;
      if (nx < 0 || nx >= pathGridSize || ny < 0 || ny >= pathGridSize) continue;
      const nKey = keyOf(nx, ny);
      if (inClosed[nKey]) continue;
      if (!isPassable(nx, ny)) continue;

      // For diagonal moves, both adjacent straight cells must be passable
      if (ddx !== 0 && ddy !== 0) {
        if (!isPassable(cx + ddx, cy) || !isPassable(cx, cy + ddy)) continue;
      }

      const tentativeG = gScore[currentKey] + cost;
      if (tentativeG >= gScore[nKey]) continue;

      cameFrom[nKey] = currentKey;
      gScore[nKey] = tentativeG;
      fScore[nKey] = tentativeG + heuristic(nx, ny);

      if (!inOpen[nKey]) {
        inOpen[nKey] = 1;
        heapPush(nKey);
      }
    }
  }

  // No path found
  return finishPath(null);
}
// ==================== END A* PATHFINDING ====================

function emitAttackProjectile(attacker, target, options = {}) {
  if (!attacker || !target) return;
  const turretIndices = Array.isArray(options.turretIndices)
    ? options.turretIndices.filter(index => Number.isInteger(index) && index >= 0)
    : null;

  const projectileId = (Date.now() * 1000) + Math.floor(Math.random() * 1000);
  const startTime = Date.now();
  let fromX = attacker.x;
  let fromY = attacker.y;
  let turretAngle = null;

  if (attacker.type === 'defense_tower') {
    const muzzle = getDefenseTowerMuzzleWorldPosition(attacker.x, attacker.y, target.x, target.y);
    fromX = muzzle.originX;
    fromY = muzzle.originY;
    turretAngle = muzzle.angle;
    attacker.turretAngle = muzzle.angle;
    attacker.turretTargetX = target.x;
    attacker.turretTargetY = target.y;
    attacker.lastTurretTargetTime = startTime;
  }

  const dx = target.x - fromX;
  const dy = target.y - fromY;
  const distance = Math.sqrt((dx * dx) + (dy * dy));
  const isSubmarineTorpedo = attacker.type === 'submarine';
  const projectileSpeed = attacker.type === 'missile_launcher'
    ? 1600
    : (isSubmarineTorpedo
      ? 900
      : ((attacker.type === 'battleship' || attacker.type === 'defense_tower') ? 3000 : 2300));
  const minFlightTime = attacker.type === 'missile_launcher'
    ? 350
    : (isSubmarineTorpedo ? 500 : 200);
  const maxFlightTime = attacker.type === 'missile_launcher'
    ? 3200
    : (isSubmarineTorpedo ? 3800 : 2200);
  const flightTimeMs = Math.max(minFlightTime, Math.min(maxFlightTime, Math.round((distance / projectileSpeed) * 1000)));

  emitAttackProjectileFiredEvent({
    id: projectileId,
    fromX,
    fromY,
    targetX: target.x,
    targetY: target.y,
    targetId: target.id,
    shooterId: attacker.id,
    shooterType: attacker.type,
    projectileKind: isSubmarineTorpedo ? 'torpedo' : 'shell',
    aimedShot: (attacker.type === 'battleship' && attacker.aimedShot && !attacker.battleshipAegisMode) ? true : false,
    turretAngle,
    turretIndices,
    startTime,
    flightTime: flightTimeMs
  }, [attacker.userId, target.userId]);
}

function emitBattleshipAegisProjectileBurst(attacker, shots, now = Date.now()) {
  if (!attacker || attacker.type !== 'battleship' || !Array.isArray(shots) || shots.length <= 0) return;

  const projectileId = (now * 1000) + Math.floor(Math.random() * 1000);
  const userIds = new Set([attacker.userId]);
  const normalizedShots = shots
    .map((shot, index) => {
      if (!shot || !Number.isInteger(shot.turretIndex) || !Number.isFinite(shot.targetX) || !Number.isFinite(shot.targetY)) {
        return null;
      }
      if (shot.targetUserId != null) {
        userIds.add(shot.targetUserId);
      }
      const dx = shot.targetX - attacker.x;
      const dy = shot.targetY - attacker.y;
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      const projectileSpeed = 3000;
      const flightTimeMs = Math.max(200, Math.min(2200, Math.round((distance / projectileSpeed) * 1000)));
      return {
        id: `${projectileId}-${index}`,
        turretIndex: shot.turretIndex,
        targetX: shot.targetX,
        targetY: shot.targetY,
        targetId: shot.targetId,
        targetType: shot.targetType,
        flightTime: flightTimeMs
      };
    })
    .filter(Boolean);

  if (normalizedShots.length <= 0) return;

  emitAttackProjectileFiredEvent({
    id: projectileId,
    fromX: attacker.x,
    fromY: attacker.y,
    shooterId: attacker.id,
    shooterType: attacker.type,
    aimedShot: false,
    startTime: now,
    shots: normalizedShots
  }, Array.from(userIds));
}

function findNonOverlappingPosition(x, y, size) {
  let bestX = x;
  let bestY = y;
  const radius = size * 0.45;
  
  for (let attempt = 0; attempt < 8; attempt++) {
    let hasOverlap = false;
    gameState.units.forEach(unit => {
      const dx = unit.x - bestX;
      const dy = unit.y - bestY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const unitRadius = (unit.type === 'worker' ? 40 : 60) * 0.45;
      if (dist < radius + unitRadius) {
        hasOverlap = true;
      }
    });
    if (!hasOverlap) break;
    const angle = (attempt / 8) * Math.PI * 2;
    bestX = x + Math.cos(angle) * size * (1 + attempt * 0.5);
    bestY = y + Math.sin(angle) * size * (1 + attempt * 0.5);
    const clamped = clampToMapBounds(bestX, bestY);
    bestX = clamped.x;
    bestY = clamped.y;
  }
  return { x: bestX, y: bestY };
}

// Export land-cell coordinates for manual map painting
app.get('/api/map/land-cells', (req, res) => {
  // Use first room's land cells (shared terrain)
  const firstRoom = gameRooms.get(ROOM_CONFIG[0].id);
  if (!firstRoom || !firstRoom.landCellsSnapshot) {
    return res.status(503).json({ error: 'Map is not initialized yet' });
  }
  res.json(firstRoom.landCellsSnapshot);
});

// Auth endpoints (simplified: no password, no registration)
let nextTempUserId = 10000;

app.post('/api/login', (req, res) => {
  const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const username = rawUsername;
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  // AIMANAGEMODE: return special response to open training panel (do NOT create player)
  // Use 403 so even old cached game.js (which checks res.ok) won't proceed to connectToGame
  if (username === 'AIMANAGEMODE') {
    if (!ENABLE_AI_TRAINING) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!isLocalTrainingAccessRequest(req)) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.status(403).json({ aiManageMode: true, error: 'AI Training Mode' });
  }

  if (isObserverUsername(username)) {
    const userId = nextTempUserId++;
    const token = jwt.sign({ userId, username: OBSERVER_LOGIN_USERNAME, isObserver: true }, JWT_SECRET, { expiresIn: '1d' });
    return res.json({ token, userId, username: OBSERVER_LOGIN_USERNAME, isObserver: true });
  }

  // Assign a temporary userId (no DB persistence)
  const userId = nextTempUserId++;
  const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1d' });
  
  res.json({ token, userId, username, isObserver: false });
});

// AI Training API endpoints
app.get('/api/ai-training/status', async (req, res) => {
  const diff = req.query.difficulty || 'hard';
  if (!RL_SESSION_DIFFICULTIES.includes(diff)) {
    return res.status(400).json({ error: 'Invalid difficulty. Use hard or expert.' });
  }
  const session = await ensureTrainingSessionLoaded(diff);
  const status = getTrainingSessionStatusSummary(diff);
  // Include self-play stats if available
  const selfPlay = session?.getSelfPlayStatus ? session.getSelfPlayStatus() : null;
  // Also include all difficulties summary
  const allStatus = {};
  for (const difficulty of RL_SESSION_DIFFICULTIES) {
    const summary = getTrainingSessionStatusSummary(difficulty);
    allStatus[difficulty] = {
      frozen: summary.frozen,
      isTraining: summary.isTraining,
      stats: summary.stats,
      unloaded: summary.unloaded
    };
  }
  res.json({ ...status, selfPlay, allDifficulties: allStatus });
});

app.post('/api/ai-training/start', async (req, res) => {
  const diff = req.body.difficulty || 'hard';
  if (!RL_SESSION_DIFFICULTIES.includes(diff)) return res.status(400).json({ error: 'Invalid difficulty' });
  const session = await ensureTrainingSessionLoaded(diff);
  if (!session) return res.status(503).json({ error: 'Training unavailable in benchmark mode' });
  const episodes = Math.min(Math.max(parseInt(req.body.episodes) || 500, 10), 999999);
  const continuous = !!req.body.continuous;
  const mode = req.body.mode || 'solo'; // 'solo' or 'selfplay'
  const numAgents = Math.min(Math.max(parseInt(req.body.numAgents) || 4, 2), 8);
  const requestedMinScore = Number(req.body.minScore);
  if (Number.isFinite(requestedMinScore) && session.setRecordingPolicy) {
    session.setRecordingPolicy({ minScore: requestedMinScore });
  }

  let ok;
  if (mode === 'selfplay') {
    ok = session.startSelfPlayTraining(episodes, numAgents, (result) => {
      console.log(`[AI-RL][${diff}] Self-play callback:`, result);
      if (result.done && session.continuousMode) {
        console.log(`[AI-RL][${diff}] Continuous mode: restarting self-play...`);
        setTimeout(() => {
          session.startSelfPlayTraining(session.lastEpisodeCount, numAgents, () => {});
        }, 1000);
      }
    });
  } else {
    ok = session.startTraining(episodes, (result) => {
      console.log(`[AI-RL][${diff}] Training callback:`, result);
      if (result.done && session.continuousMode) {
        console.log(`[AI-RL][${diff}] Continuous mode: restarting training...`);
        setTimeout(() => {
          session.startTraining(session.lastEpisodeCount, () => {});
        }, 1000);
      }
    });
  }
  session.continuousMode = continuous;
  session.lastEpisodeCount = episodes;
  res.json({
    started: ok,
    episodes,
    continuous,
    difficulty: diff,
    frozen: session.frozen,
    mode,
    numAgents,
    minScore: session.recordingPolicy?.minScore
  });
});

app.post('/api/ai-training/stop', async (req, res) => {
  const diff = req.body.difficulty || 'hard';
  if (!RL_SESSION_DIFFICULTIES.includes(diff)) return res.status(400).json({ error: 'Invalid difficulty' });
  const session = await ensureTrainingSessionLoaded(diff);
  if (!session) return res.status(503).json({ error: 'Training unavailable in benchmark mode' });
  session.continuousMode = false;
  session.stopTraining();
  res.json({ stopped: true, difficulty: diff });
});

app.post('/api/ai-training/reset', async (req, res) => {
  const diff = req.body.difficulty || 'hard';
  if (!RL_SESSION_DIFFICULTIES.includes(diff)) return res.status(400).json({ error: 'Invalid difficulty' });
  const session = await ensureTrainingSessionLoaded(diff);
  if (!session) return res.status(503).json({ error: 'Training unavailable in benchmark mode' });
  session.continuousMode = false;
  session.stopTraining();
  session.qTable.table = {};
  session.qTable.epsilon = 0.3;
  session.qTable.totalEpisodes = 0;
  session.qTable.totalReward = 0;
  session.qTable.recentRewards = [];
  session.saveWeights();
  console.log(`[AI-RL][${diff}] Weights reset`);
  res.json({ reset: true, difficulty: diff });
});

app.post('/api/ai-training/freeze', async (req, res) => {
  const diff = req.body.difficulty;
  const freeze = req.body.freeze;
  if (!RL_SESSION_DIFFICULTIES.includes(diff)) return res.status(400).json({ error: 'Invalid difficulty' });
  const session = await ensureTrainingSessionLoaded(diff);
  if (!session) return res.status(503).json({ error: 'Training unavailable in benchmark mode' });
  if (freeze && session.isTraining) {
    session.continuousMode = false;
    session.stopTraining();
  }
  session.frozen = !!freeze;
  session.saveWeights();
  console.log(`[AI-RL][${diff}] Frozen: ${session.frozen}`);
  res.json({ difficulty: diff, frozen: session.frozen });
});

app.get('/api/ai-training/weights', async (req, res) => {
  const diff = req.query.difficulty || 'hard';
  if (!RL_SESSION_DIFFICULTIES.includes(diff)) return res.status(400).json({ error: 'Invalid difficulty' });
  const session = await ensureTrainingSessionLoaded(diff);
  if (!session) return res.status(503).json({ error: 'Training unavailable in benchmark mode' });
  const stats = session.qTable.getStats();
  res.json({ ...stats, difficulty: diff, frozen: session.frozen, storage: session.getStatus().storage, recording: session.getStatus().recording });
});

// Reset player game data (keeps account, resets progress) - respawn at random location
app.post('/api/reset', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded?.isObserver) {
      return res.status(403).json({ error: 'Observer account cannot reset game state' });
    }
    const userId = decoded.userId;
    
    // Delete all units and buildings for this player (DB ops may fail for temp users, that's OK)
    try {
      db.prepare('DELETE FROM units WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM buildings WHERE user_id = ?').run(userId);
    } catch(e) { /* no-op for temp users */ }
    
    // Find a new random starting position
    const newStartPos = findStartPosition();
    // Ensure the new base is on land
    let finalX = newStartPos.x;
    let finalY = newStartPos.y;
    if (!isOnLand(finalX, finalY)) {
      const landPos = findNearestLandPosition(finalX, finalY);
      finalX = landPos.x;
      finalY = landPos.y;
    }
    
    // Also clear from all room game states and create new HQ
    let persistedBasePos = null;
    gameRooms.forEach((room, roomId) => {
      switchRoom(roomId);
      const gs = room;
      const unitsToDelete = [];
      gs.units.forEach((unit, unitId) => {
        if (unit.userId === userId) {
          unitsToDelete.push(unitId);
        }
      });
      unitsToDelete.forEach(id => gs.units.delete(id));
      
      const buildingsToDelete = [];
      gs.buildings.forEach((building, buildingId) => {
        if (building.userId === userId) {
          buildingsToDelete.push(buildingId);
        }
      });
      buildingsToDelete.forEach(id => gs.buildings.delete(id));

      const resolvedResetPos = findNearestValidBuildingPosition('headquarters', finalX, finalY);
      const roomFinalX = resolvedResetPos ? resolvedResetPos.x : finalX;
      const roomFinalY = resolvedResetPos ? resolvedResetPos.y : finalY;
      if (!persistedBasePos) {
        persistedBasePos = { x: roomFinalX, y: roomFinalY };
      }
      
      // Reset player in memory with new base position
      const player = gs.players.get(userId);
      if (player) {
        player.resources = 1000;
        player.population = 0;
        player.maxPopulation = STARTING_MAX_POPULATION;
        player.combatPower = 0;
        player.score = 0;
        player.scoreFromKills = 0;
        player.baseX = roomFinalX;
        player.baseY = roomFinalY;
        player.hasBase = true;
        player.researchedSLBM = false;
        player.missiles = 0;
      }
      
      // Create new headquarters for the player
      const hqId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      gs.buildings.set(hqId, {
        id: hqId,
        userId: userId,
        type: 'headquarters',
        x: roomFinalX,
        y: roomFinalY,
        hp: 1500,
        maxHp: 1500,
        buildProgress: 100
      });
      
      // Notify all clients about the reset
      io.to(roomId).emit('buildingPlaced', {
        id: hqId,
        userId: userId,
        type: 'headquarters',
        x: roomFinalX,
        y: roomFinalY,
        hp: 1500,
        maxHp: 1500,
        buildProgress: 100
      });
    });

    const basePosForPersistence = persistedBasePos || { x: finalX, y: finalY };
    try {
      db.prepare(`UPDATE player_data SET 
        resources = 1000, population = 0, max_population = ?,
        combat_power = 0, score = 0, base_x = ?, base_y = ?,
        has_base = 1, researched_slbm = 0, missiles = 0
        WHERE user_id = ?`).run(STARTING_MAX_POPULATION, basePosForPersistence.x, basePosForPersistence.y, userId);
    } catch(e) { /* no-op for temp users */ }
    
    console.log(`Reset game data for user ${userId} - new base at (${basePosForPersistence.x.toFixed(0)}, ${basePosForPersistence.y.toFixed(0)})`);
    res.json({ success: true, message: 'Game data reset successfully', baseX: basePosForPersistence.x, baseY: basePosForPersistence.y });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/annihilate-room', (req, res) => {
  const requestedRoomId = typeof req.body?.roomId === 'string' ? req.body.roomId : '';
  const roomConfig = ROOM_CONFIG.find(room => room.id === requestedRoomId);
  if (!roomConfig) {
    return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });
  }

  const result = annihilateRoom(roomConfig.id, ROOM_ANNIHILATION_MESSAGE);
  if (!result) {
    return res.status(500).json({ error: '서버 정리에 실패했습니다.' });
  }

  console.log(`Secret room annihilation executed for ${roomConfig.id}: humans=${result.humanCount}, ai=${result.aiCount}`);
  res.json({
    ok: true,
    roomId: roomConfig.id,
    roomLabel: roomConfig.name,
    humanCount: result.humanCount,
    aiCount: result.aiCount,
    totalCount: result.totalCount
  });
});

// Find starting position on land near resources
function findStartPosition() {
  const map = gameState.map;
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const minDistance = mapConfig.spawnZones.minDistanceFromEdge;
  const minBasePath = mapConfig.spawnZones.minDistanceFromOtherBases;
  const landCells = map.landCells || [];

  console.log(`findStartPosition: landCells.length=${landCells.length}, gridSize=${gridSize}, cellSize=${cellSize}`);
  
  // First pass: find land cell near resources, far from edges and other bases
  for (let attempts = 0; attempts < 200; attempts++) {
    if (landCells.length === 0) break;
    const [gridX, gridY] = landCells[Math.floor(Math.random() * landCells.length)];
    const worldX = gridX * cellSize + cellSize / 2;
    const worldY = gridY * cellSize + cellSize / 2;
    
    // Check distance from edges
    if (worldX < minDistance || worldX > map.width - minDistance ||
        worldY < minDistance || worldY > map.height - minDistance) {
      continue;
    }
    
    // Check distance from other bases
    let tooClose = false;
    gameState.buildings.forEach(building => {
      if (building.type === 'headquarters') {
        const dx = building.x - worldX;
        const dy = building.y - worldY;
        if (Math.sqrt(dx * dx + dy * dy) < minBasePath) {
          tooClose = true;
        }
      }
    });
    
    if (!tooClose) {
      // Verify this cell is ACTUALLY on land
      if (!isOnLand(worldX, worldY)) {
        console.warn(`findStartPosition: landCells entry [${gridX},${gridY}] returned NON-LAND world pos (${worldX}, ${worldY}). Skipping.`);
        continue;
      }
      
      // Also require enough surrounding land cells (at least 3x3 area of land)
      let surroundingLand = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const checkX = gridX + dx;
          const checkY = gridY + dy;
          if (checkX >= 0 && checkX < gridSize && checkY >= 0 && checkY < gridSize) {
            if (map.landCellSet.has(checkY * gridSize + checkX)) {
              surroundingLand++;
            }
          }
        }
      }
      if (surroundingLand < 5) {
        continue; // Skip edge-of-island cells
      }

      if (!isBuildingPlacementValid('headquarters', worldX, worldY)) {
        continue;
      }
      
      // Prefer near resources, but don't require it
      const nearResource = map.resources.some(resource => {
        const dx = resource.x - worldX;
        const dy = resource.y - worldY;
        return Math.sqrt(dx * dx + dy * dy) < 800;
      });
      
      if (nearResource || attempts > 100) {
        console.log(`findStartPosition: selected land at (${worldX}, ${worldY}), grid=[${gridX},${gridY}], isOnLand=${isOnLand(worldX, worldY)}, surroundingLand=${surroundingLand}`);
        return { x: worldX, y: worldY };
      }
    }
  }
  
  // Fallback: pick ANY land cell that is deep enough inland
  if (landCells.length > 0) {
    // Shuffle and find first cell with enough surrounding land
    for (let i = 0; i < Math.min(landCells.length, 500); i++) {
      const idx = Math.floor(Math.random() * landCells.length);
      const [gx, gy] = landCells[idx];
      const wx = gx * cellSize + cellSize / 2;
      const wy = gy * cellSize + cellSize / 2;
      if (!isOnLand(wx, wy)) continue;
      
      // Check it's not on the very edge of an island
      let landCount = 0;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const cx = gx + dx;
          const cy = gy + dy;
          if (cx >= 0 && cx < gridSize && cy >= 0 && cy < gridSize) {
            if (map.landCellSet.has(cy * gridSize + cx)) landCount++;
          }
        }
      }
      if (landCount >= 10) {
        if (!isBuildingPlacementValid('headquarters', wx, wy)) {
          continue;
        }
        console.log(`findStartPosition: fallback selected land at (${wx}, ${wy}), grid=[${gx},${gy}]`);
        return { x: wx, y: wy };
      }
    }
    
    // Last resort: any land cell
    const [fallbackGridX, fallbackGridY] = landCells[Math.floor(Math.random() * landCells.length)];
    const fx = (fallbackGridX * cellSize) + (cellSize / 2);
    const fy = (fallbackGridY * cellSize) + (cellSize / 2);
    const fallbackPos = findNearestValidBuildingPosition('headquarters', fx, fy);
    if (fallbackPos) {
      console.log(`findStartPosition: LAST RESORT relocated to (${fallbackPos.x}, ${fallbackPos.y}), grid=[${fallbackGridX},${fallbackGridY}], isOnLand=${isOnLand(fallbackPos.x, fallbackPos.y)}`);
      return fallbackPos;
    }
    console.log(`findStartPosition: LAST RESORT at (${fx}, ${fy}), grid=[${fallbackGridX},${fallbackGridY}], isOnLand=${isOnLand(fx, fy)}`);
    return { x: fx, y: fy };
  }

  console.error('findStartPosition: NO LAND CELLS AVAILABLE');
  return { x: map.width / 2, y: map.height / 2 };
}

// Spawn base with workers for a player
function spawnPlayerBase(userId) {
  removePlayerEntities(userId);
  
  // Find a good starting position
  const startPos = findStartPosition();
  
  // HARD GUARANTEE: verify position is on land, relocate if not
  if (!isOnLand(startPos.x, startPos.y)) {
    console.warn(`spawnPlayerBase: findStartPosition returned water pos (${startPos.x}, ${startPos.y}), relocating to nearest land`);
    const landPos = findNearestLandPosition(startPos.x, startPos.y);
    startPos.x = landPos.x;
    startPos.y = landPos.y;
    console.log(`spawnPlayerBase: relocated to (${startPos.x}, ${startPos.y}), isOnLand=${isOnLand(startPos.x, startPos.y)}`);
  }

  const resolvedStartPos = findNearestValidBuildingPosition('headquarters', startPos.x, startPos.y);
  if (resolvedStartPos) {
    startPos.x = resolvedStartPos.x;
    startPos.y = resolvedStartPos.y;
  }
  
  // Create headquarters
  const hqId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  gameState.buildings.set(hqId, {
    id: hqId,
    userId: userId,
    type: 'headquarters',
    x: startPos.x,
    y: startPos.y,
    hp: 1500,
    maxHp: 1500,
    buildProgress: 100
  });
  
  spawnStartingWorkers(userId, startPos.x, startPos.y, STARTING_WORKER_COUNT);
  
  // Update player data
  const player = gameState.players.get(userId);
  if (player) {
    player.baseX = startPos.x;
    player.baseY = startPos.y;
    player.hasBase = true;
    player.population = STARTING_WORKER_COUNT;
    player.maxPopulation = STARTING_MAX_POPULATION;
    player.scoreFromKills = getPlayerScoreFromKills(player);
  }
  
  // Update database (skip for AI players)
  const isAI = player && player.isAI;
  if (!isAI) {
    try {
      db.prepare('UPDATE player_data SET base_x = ?, base_y = ?, has_base = 1, population = ?, max_population = ? WHERE user_id = ?').run(startPos.x, startPos.y, STARTING_WORKER_COUNT, STARTING_MAX_POPULATION, userId);
    } catch(e) { /* no-op: temp user has no DB row */ }
  }
  
  return startPos;
}

// Admin spawn for "JsonParc" - all buildings + all units + 100k energy + 250 pop
function spawnAdminBase(userId) {
  // First do normal spawn to get base position
  const startPos = spawnPlayerBase(userId);
  const player = gameState.players.get(userId);
  if (!player) return;

  // Set admin resources
  player.resources = 100000;
  player.maxPopulation = PLAYER_MAX_POPULATION_CAP;
  player.researchedSLBM = true;
  player.missiles = 0;

  const baseX = startPos.x;
  const baseY = startPos.y;

  // Spawn all building types around HQ (skip headquarters - already placed)
  const adminBuildings = ['shipyard', 'power_plant', 'defense_tower', 'naval_academy', 'carbase', 'missile_silo'];
  const buildingTypes = {
    'shipyard': { hp: 800, size: getBuildingCollisionSize('shipyard') },
    'power_plant': { hp: 600, size: getBuildingCollisionSize('power_plant') },
    'defense_tower': { hp: 700, size: getBuildingCollisionSize('defense_tower') },
    'naval_academy': { hp: 700, size: getBuildingCollisionSize('naval_academy') },
    'carbase': { hp: 800, size: getBuildingCollisionSize('carbase') },
    'missile_silo': { hp: 1000, size: getBuildingCollisionSize('missile_silo') }
  };
  adminBuildings.forEach((type, i) => {
    const angle = (Math.PI * 2 * i) / adminBuildings.length;
    const dist = 500;
    const bx = baseX + Math.cos(angle) * dist;
    const by = baseY + Math.sin(angle) * dist;
    const cfg = buildingTypes[type];
    const resolvedPos = findNearestValidBuildingPosition(type, bx, by, { size: cfg.size });
    if (!resolvedPos) {
      console.warn(`Admin spawn skipped ${type}: no non-overlapping position near (${bx.toFixed(0)}, ${by.toFixed(0)})`);
      return;
    }
    const bid = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 100 + i;
    gameState.buildings.set(bid, {
      id: bid, userId, type, x: resolvedPos.x, y: resolvedPos.y,
      hp: cfg.hp, maxHp: cfg.hp, buildProgress: 100
    });
  });
  const adminSilo = [...gameState.buildings.values()].find(building => building.userId === userId && building.type === 'missile_silo');
  if (adminSilo) {
    adminSilo.slbmCount = 10;
  }
  recalculatePlayerMissileStock(userId);

  // Spawn one of each unit type near water
  const waterPos = findNearestNavalPassableWaterPosition('battleship', baseX, baseY, 2000);
  const spawnX = waterPos ? waterPos.x : baseX;
  const spawnY = waterPos ? waterPos.y : baseY;

  const adminUnits = ['destroyer', 'cruiser', 'battleship', 'carrier', 'submarine', 'frigate', 'assaultship'];
  let totalPop = player.population; // already 4 from workers
  adminUnits.forEach((type, i) => {
    const unitConfig = getUnitDefinition(type);
    const angle = (Math.PI * 2 * i) / adminUnits.length;
    const dist = 300;
    const ux = spawnX + Math.cos(angle) * dist;
    const uy = spawnY + Math.sin(angle) * dist;
    const uid = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 200 + i;
    gameState.units.set(uid, initializeUnitRuntimeState({
      id: uid, userId, type,
      x: ux, y: uy,
      hp: unitConfig.hp, maxHp: unitConfig.hp,
      damage: unitConfig.damage, speed: unitConfig.speed,
      attackRange: unitConfig.attackRange, attackCooldownMs: unitConfig.attackCooldownMs,
      targetX: null, targetY: null,
      gatheringResourceId: null, buildingType: null,
      buildTargetX: null, buildTargetY: null,
      kills: 0
    }));
    if (type === 'assaultship') {
      const assaultShip = gameState.units.get(uid);
      if (assaultShip) {
        assaultShip.loadedMissileLaunchers = [];
      }
    }
    totalPop += unitConfig.pop;
  });

  const launcherSpawn = findNearestLandPosition(baseX + 260, baseY + 260) || { x: baseX + 260, y: baseY + 260 };
  const adminLauncher = createMissileLauncherUnit(userId, launcherSpawn);
  gameState.units.set(adminLauncher.id, initializeUnitRuntimeState(adminLauncher));
  totalPop += getUnitDefinition('missile_launcher').pop;

  // Pre-fill carrier with 10 aircraft (ready for airstrike)
  const carrierUnit = [...gameState.units.values()].find(u => u.userId === userId && u.type === 'carrier');
  if (carrierUnit) {
    if (!carrierUnit.aircraft) carrierUnit.aircraft = [];
    if (!carrierUnit.aircraftDeployed) carrierUnit.aircraftDeployed = [];
    if (!carrierUnit.aircraftQueue) carrierUnit.aircraftQueue = [];
    if (!carrierUnit.reconAircraft) carrierUnit.reconAircraft = [];
    if (!carrierUnit.reconAircraftDeployed) carrierUnit.reconAircraftDeployed = [];
    if (!carrierUnit.reconAircraftQueue) carrierUnit.reconAircraftQueue = [];
    const acConfig = getUnitDefinition('aircraft');
    for (let i = 0; i < 10; i++) {
      carrierUnit.aircraft.push({ hp: acConfig.hp });
    }
    const reconConfig = getUnitDefinition('recon_aircraft');
    for (let i = 0; i < RECON_AIRCRAFT_MAX_PER_CARRIER; i++) {
      carrierUnit.reconAircraft.push({ hp: reconConfig.hp });
    }
    carrierUnit.airstrikeReady = true;
  }

  player.population = totalPop;
  console.log(`Admin spawn for JsonParc: ${player.resources} energy, ${player.maxPopulation} pop cap, all buildings+units`);
}

// Check for player defeat (all buildings destroyed)
function checkPlayerDefeat(userId, attackerId = null, attackerNameOverride = null, defeatReason = null) {
  let hasBuildings = false;
  gameState.buildings.forEach(building => {
    if (building.userId === userId) {
      hasBuildings = true;
    }
  });
  
  if (!hasBuildings) {
    // Get player and attacker names for kill log
    const defeatedPlayer = gameState.players.get(userId);
    if (!defeatedPlayer) {
      console.warn(`checkPlayerDefeat: player ${userId} missing in room ${currentRoomId}`);
      return;
    }
    if (defeatedPlayer.isObserver) {
      return;
    }
    const attackerPlayer = attackerId ? gameState.players.get(attackerId) : null;
    const defeatedName = defeatedPlayer ? defeatedPlayer.username : `Player ${userId}`;
    const attackerName = attackerPlayer
      ? attackerPlayer.username
      : (attackerNameOverride || '알 수 없음');

    if (defeatedPlayer.isAI) {
      roomEmit('playerDefeated', {
        userId,
        respawned: false,
        defeatedName,
        attackerName,
        attackerId: attackerId || null,
        isAI: true,
        defeatReason,
        respawnDelayMs: AI_CONFIG.respawnDelayMs
      });
      removePlayerFromCurrentRoom(userId, { emitPlayerLeft: true });
      scheduleAIRespawn(userId);
      console.log(`${defeatedName} was defeated by ${attackerName} and will respawn in ${AI_CONFIG.respawnDelayMs}ms`);
      return;
    }

    removePlayerEntities(userId);

    defeatedPlayer.hasBase = false;
    defeatedPlayer.population = 0;
    defeatedPlayer.resources = 1000;
    defeatedPlayer.combatPower = 0;
    defeatedPlayer.score = 0;
    defeatedPlayer.scoreFromKills = 0;
    defeatedPlayer.maxPopulation = STARTING_MAX_POPULATION;
    defeatedPlayer.researchedSLBM = false;
    defeatedPlayer.missiles = 0;

    try {
      db.prepare(`UPDATE player_data SET 
        has_base = 0, population = 0, resources = 1000, 
        combat_power = 0, score = 0, max_population = ?,
        researched_slbm = 0, missiles = 0
        WHERE user_id = ?`).run(STARTING_MAX_POPULATION, userId);
    } catch(e) { /* no-op for temp users */ }

    // Respawn base at new location (findStartPosition avoids existing bases)
    spawnPlayerBase(userId);

    // Emit defeat event with kill log info
    roomEmit('playerDefeated', { 
      userId, 
      respawned: true, 
      defeatedName, 
      attackerName,
      attackerId: attackerId || null,
      defeatReason
    });

    console.log(`${defeatedName} was defeated by ${attackerName} and respawned`);
  }
}

// Socket.io authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    socket.isObserver = !!decoded.isObserver;
    // Room selection from client (default: server1)
    socket.roomId = socket.handshake.auth.roomId || 'server1';
    if (!gameRooms.has(socket.roomId)) {
      socket.roomId = 'server1';
    }
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  const wasRoomIdle = !roomHasHumanPlayers(socket.roomId);
  socket.viewportState = null;

  // Join the selected room
  socket.join(socket.roomId);
  switchRoom(socket.roomId);
  
  console.log(`Player connected: ${socket.username} (${socket.userId}) to room ${socket.roomId}`);
  
  try {
    const mapCenterX = gameState?.map?.width ? Math.round(gameState.map.width / 2) : 10000;
    const mapCenterY = gameState?.map?.height ? Math.round(gameState.map.height / 2) : 10000;
    // Always fresh start: create player and spawn base
    gameState.players.set(socket.userId, {
      userId: socket.userId,
      username: socket.username,
      resources: socket.isObserver ? 0 : 1000,
      population: 0,
      maxPopulation: socket.isObserver ? 0 : STARTING_MAX_POPULATION,
      combatPower: 0,
      score: 0,
      scoreFromKills: 0,
      baseX: mapCenterX,
      baseY: mapCenterY,
      hasBase: false,
      researchedSLBM: false,
      missiles: 0,
      battleshipModeComboUnlocked: false,
      online: true,
      isObserver: !!socket.isObserver
    });
    if (ENABLE_SERVER_FOG_SNAPSHOTS && !gameState.fogOfWar.has(socket.userId) && !socket.isObserver) {
      gameState.fogOfWar.set(socket.userId, new Map());
    }

    // Check for admin mode (JsonParc)
    if (socket.isObserver) {
      // Observer joins the room without a base or controllable entities.
    } else if (socket.username === 'JsonParc') {
      spawnAdminBase(socket.userId);
    } else {
      spawnPlayerBase(socket.userId);
    }

    if (wasRoomIdle) {
      gameState.lastUpdate = Date.now();
      gameState.activeRedZones = [];
      gameState.lastRedZoneCountdownSecond = null;
      gameState.nextRedZoneRollAt = Date.now() + RED_ZONE_SELECTION_INTERVAL_MS;
      const spawnedAiCount = initializeAIPlayers();
      syncSlbmId();
      console.log(`Room ${socket.roomId} activated by ${socket.username}; spawned ${spawnedAiCount} AI player(s)`);
    }
    
    console.log(`Player ${socket.username} spawned fresh`);
    recalculateAllPlayerCombatPowerAndScores();
    
    // Send initial game state
    const player = gameState.players.get(socket.userId);
    const initialState = buildClientStatePayloadForSocket(socket);
    const initData = {
      userId: socket.userId,
      map: buildClientMapPayload(),
      players: initialState.players,
      units: initialState.units,
      buildings: initialState.buildings,
      missiles: player ? (player.missiles || 0) : 0,
      redZones: buildClientRedZonePayload(),
      aiDifficulty: getEffectiveAIDifficulty(gameState.aiDifficulty),
      observerMode: !!socket.isObserver
    };
    
    console.log(`Sending init data: ${initData.players.length} players, ${initData.units.length} units, ${initData.buildings.length} buildings`);
    
    socket.emit('init', initData);
    
    // Notify others in same room
    socket.to(socket.roomId).emit('playerJoined', gameState.players.get(socket.userId));
  } catch (error) {
    console.error('Error during connection:', error);
    socket.disconnect();
    return;
  }
  
  // Handle unit commands
  socket.on('viewportUpdate', (data) => {
    switchRoom(socket.roomId);
    const viewportState = sanitizeViewportState(data, {
      minZoom: socket.isObserver ? 0.05 : 0.3,
      maxZoom: socket.isObserver ? 2.4 : 2
    });
    if (viewportState) {
      socket.viewportState = viewportState;
    }
  });

  socket.on('moveUnits', (data) => {
    switchRoom(socket.roomId);
    const { unitIds, targetX, targetY } = data;
    const movableUnits = [];
    // Check if any selected unit belongs to a squad — move entire squad
    const squadsMoved = new Set();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.type === 'missile_launcher' && unit.deployState !== 'mobile') return;
      if (unit && unit.userId === socket.userId && canAcceptPlayerOrders(unit)) {
        if (unit.squadId && !squadsMoved.has(unit.squadId)) {
          const squad = gameState.squads.get(unit.squadId);
          if (squad) {
            squadsMoved.add(unit.squadId);
            issueSquadMoveOrder(squad, targetX, targetY);
          }
        } else if (!unit.squadId) {
          movableUnits.push(unit);
        }
      }
    });
    if (movableUnits.length > 0) {
      issueGroupedMoveOrder(movableUnits, targetX, targetY);
      movableUnits.forEach(unit => {
        unit.holdPosition = false;
        unit.attackMove = false;
        unit.attackTargetId = null;
        unit.attackTargetType = null;
      });
    }
  });
  
  socket.on('attackTarget', (data) => {
    switchRoom(socket.roomId);
    const { unitIds, targetId, targetType } = data;
    const targetUnit = targetType === 'unit' ? gameState.units.get(targetId) : null;
    if (targetUnit && isAirUnitType(targetUnit)) return;
    // Check if any selected unit belongs to a squad — attack with entire squad
    const squadsCommanded = new Set();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.type === 'missile_launcher') return;
      if (unit && unit.userId === socket.userId && canAcceptPlayerOrders(unit)) {
        if (unit.squadId && !squadsCommanded.has(unit.squadId)) {
          const squad = gameState.squads.get(unit.squadId);
          if (squad) {
            squadsCommanded.add(unit.squadId);
            issueSquadAttackTarget(squad, targetId, targetType);
          }
        } else if (!unit.squadId) {
          if (unit.type === 'battleship' && unit.battleshipAegisMode && targetType === 'slbm') {
            unit.attackTargetId = null;
            unit.attackTargetType = null;
            return;
          }
          unit.holdPosition = false;
          unit.attackMove = false;
          unit.attackTargetId = targetId;
          unit.attackTargetType = targetType;
        }
      }
    });
  });

  socket.on('createSquad', (data) => {
    console.log('[Squad] createSquad received from', socket.userId, 'data:', JSON.stringify(data));
    switchRoom(socket.roomId);
    const unitIds = Array.isArray(data?.unitIds) ? data.unitIds : [];
    const validUnits = [];
    unitIds.forEach(uid => {
      const unit = gameState.units.get(uid);
      if (unit && unit.userId === socket.userId && unit.hp > 0 && canAcceptPlayerOrders(unit)) {
        // Remove from any existing squad first
        if (unit.squadId) {
          const oldSquad = gameState.squads.get(unit.squadId);
          if (oldSquad) {
            oldSquad.unitIds = oldSquad.unitIds.filter(id => id !== uid);
            if (oldSquad.unitIds.length <= 1) disbandSquadInternal(unit.squadId);
          }
        }
        validUnits.push(uid);
      }
    });
    if (validUnits.length < 2) { console.log('[Squad] Not enough valid units:', validUnits.length); return; }
    const squadId = gameState.nextSquadId++;
    console.log('[Squad] Creating squad', squadId, 'with', validUnits.length, 'units');
    const squad = { unitIds: validUnits, ownerId: socket.userId, formationType: 'trapezoid' };
    gameState.squads.set(squadId, squad);
    const slowestSpeed = getSquadSlowestSpeed(squad);
    validUnits.forEach(uid => {
      const unit = gameState.units.get(uid);
      if (unit) {
        unit.squadId = squadId;
        unit.speed = slowestSpeed;
      }
    });
    // Immediately form up: move units into formation around their center
    // Temporarily ignore collision so units can quickly arrange
    const aliveUnits = getSquadAliveUnits(squad);
    if (aliveUnits.length >= 2) {
      const cx = aliveUnits.reduce((s, u) => s + u.x, 0) / aliveUnits.length;
      const cy = aliveUnits.reduce((s, u) => s + u.y, 0) / aliveUnits.length;
      let avgAngle = 0;
      const angles = aliveUnits.filter(u => u.angle !== undefined).map(u => u.angle);
      if (angles.length > 0) {
        const sx = angles.reduce((s, a) => s + Math.cos(a), 0);
        const sy = angles.reduce((s, a) => s + Math.sin(a), 0);
        avgAngle = Math.atan2(sy, sx);
      }
      // Store squad state
      squad.centerX = cx;
      squad.centerY = cy;
      squad.actualCenterX = cx;
      squad.actualCenterY = cy;
      squad.targetX = cx;
      squad.targetY = cy;
      squad.moveAngle = avgAngle;
      squad.targetAngle = avgAngle;
      squad.lastHeadingUpdateAt = Date.now();
      squad.moving = false;
      squad.centerWaypoints = null;

      const fPositions = applySquadFormationLayout(squad, aliveUnits, cx, cy, avgAngle);
      fPositions.forEach(({ unit }) => {
        unit.speed = slowestSpeed;
        unit.holdPosition = false;
        unit.attackMove = false;
        unit.attackTargetId = null;
        unit.attackTargetType = null;
        unit.angle = avgAngle;
        unit.formingUp = false;
        unit.formingUpUntil = null;
        unit.targetX = null;
        unit.targetY = null;
        unit.pathWaypoints = null;
        resetNavalAvoidanceState(unit);
      });
    }
    socket.emit('squadCreated', { squadId, unitIds: validUnits, formationType: squad.formationType });
  });

  socket.on('setFormationType', (data) => {
    switchRoom(socket.roomId);
    const sqId = data?.squadId;
    const fType = data?.formationType;
    if (!sqId || !fType || !['trapezoid', 'diamond'].includes(fType)) return;
    const sq = gameState.squads.get(sqId);
    if (!sq || sq.ownerId !== socket.userId) return;
    sq.formationType = fType;
    const sUnits = getSquadAliveUnits(sq);
    if (sUnits.length > 0) {
      const cx2 = Number.isFinite(sq.centerX)
        ? sq.centerX
        : (sUnits.reduce((s, u) => s + u.x, 0) / sUnits.length);
      const cy2 = Number.isFinite(sq.centerY)
        ? sq.centerY
        : (sUnits.reduce((s, u) => s + u.y, 0) / sUnits.length);
      const formationAngle = Number.isFinite(sq.targetAngle) ? sq.targetAngle : (sq.moveAngle || 0);
      const pos = applySquadFormationLayout(sq, sUnits, cx2, cy2, formationAngle);
      const spd = getSquadSlowestSpeed(sq);
      pos.forEach(({ unit }) => {
        unit.speed = spd;
        unit.angle = formationAngle;
        unit.formingUp = false;
        unit.formingUpUntil = null;
        unit.targetX = null;
        unit.targetY = null;
        unit.pathWaypoints = null;
      });
    }
    socket.emit('formationTypeChanged', { squadId: sqId, formationType: fType });
  });

  socket.on('disbandSquad', (data) => {
    switchRoom(socket.roomId);
    const squadId = data?.squadId;
    const squad = gameState.squads.get(squadId);
    if (!squad || squad.ownerId !== socket.userId) return;
    disbandSquadInternal(squadId);
    socket.emit('squadDisbanded', { squadId });
  });

  socket.on('attackMoveUnits', (data) => {
    switchRoom(socket.roomId);
    const { unitIds, targetX, targetY } = data;
    const movableUnits = [];
    const squadsMoved = new Set();
    (Array.isArray(unitIds) ? unitIds : []).forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.type === 'missile_launcher' && unit.deployState !== 'mobile') return;
      if (unit && unit.userId === socket.userId && canAcceptPlayerOrders(unit)) {
        if (unit.squadId && !squadsMoved.has(unit.squadId)) {
          const squad = gameState.squads.get(unit.squadId);
          if (squad) {
            squadsMoved.add(unit.squadId);
            issueSquadAttackMove(squad, targetX, targetY);
          }
        } else if (!unit.squadId) {
          movableUnits.push(unit);
        }
      }
    });
    if (movableUnits.length > 0) {
      issueGroupedMoveOrder(movableUnits, targetX, targetY);
      movableUnits.forEach(unit => {
        unit.holdPosition = false;
        unit.attackMove = true;
        unit.attackTargetId = null;
        unit.attackTargetType = null;
      });
    }
  });
  
  socket.on('buildUnit', (data) => {
    switchRoom(socket.roomId);
    const { buildingId, unitType } = data;
    buildUnit(socket.userId, buildingId, unitType);
  });
  
  socket.on('buildBuilding', (data) => {
    switchRoom(socket.roomId);
    const { type, x, y } = data;
    buildBuilding(socket.userId, type, x, y);
  });
  
  socket.on('workerGather', (data) => {
    switchRoom(socket.roomId);
    if (!LEGACY_WORKER_RESOURCE_GATHERING_ENABLED) {
      return;
    }
    const { workerId, resourceId } = data;
    const unit = gameState.units.get(workerId);
    const resource = gameState.map.resources.find(r => r.id === resourceId);
    
    if (unit && unit.userId === socket.userId && unit.type === 'worker' && resource) {
      unit.holdPosition = false;
      unit.gatheringResourceId = resourceId;
      unit.targetX = resource.x;
      unit.targetY = resource.y;
      unit.buildingType = null;
      unit.buildTargetX = null;
      unit.buildTargetY = null;
    }
  });
  
  socket.on('workerBuild', (data) => {
    switchRoom(socket.roomId);
    const { workerIds, buildingType, x, y } = data;
    if (!isOnLand(x, y)) {
      return;
    }
    workerIds.forEach(workerId => {
      const unit = gameState.units.get(workerId);
      if (unit && unit.userId === socket.userId && unit.type === 'worker') {
        unit.holdPosition = false;
        unit.buildingType = buildingType;
        unit.buildTargetX = x;
        unit.buildTargetY = y;
        unit.targetX = x;
        unit.targetY = y;
        unit.gatheringResourceId = null;
      }
    });
  });
  
  socket.on('submarineSLBM', (data) => {
    switchRoom(socket.roomId);
    const { submarineId, targetX, targetY } = data;
    const unit = gameState.units.get(submarineId);
    const player = gameState.players.get(socket.userId);
    const clampedTarget = clampToMapBounds(targetX, targetY);
    const firedAt = Date.now();
    if (unit) initializeUnitRuntimeState(unit);
    const slbmReady = unit && firedAt >= (unit.slbmReloadReadyAt || 0);
    
    if (unit && unit.userId === socket.userId && unit.type === 'submarine' && player && getSubmarineLoadedSlbmCount(unit) > 0 && slbmReady) {
      unit.loadedSlbms = Math.max(0, getSubmarineLoadedSlbmCount(unit) - 1);
      player.missiles = Math.max(0, normalizeStoredSlbmCount(player.missiles) - 1);
      unit.slbmReloadReadyAt = firedAt + SUBMARINE_SLBM_RELOAD_MS;
      // Fire SLBM - tracked entity
      unit.stealthCooldownUntil = firedAt + SUBMARINE_STEALTH_COOLDOWN_MS;
      unit.stealthActive = false;
      unit.isDetected = true; // Firing reveals submarine
      unit.lastAttackTime = firedAt;
      const slbmId = nextSlbmId++;
      const slbm = {
        id: slbmId,
        fromX: unit.x, fromY: unit.y,
        targetX: clampedTarget.x, targetY: clampedTarget.y,
        currentX: unit.x, currentY: unit.y,
        startTime: firedAt,
        flightTime: 5000,
        hp: SLBM_MAX_HP, maxHp: SLBM_MAX_HP,
        userId: socket.userId,
        firingSubId: submarineId
      };
      gameState.activeSlbms.set(slbmId, slbm);
      
      emitSlbmFiredEvent({
        id: slbmId,
        fromX: unit.x,
        fromY: unit.y,
        targetX: clampedTarget.x,
        targetY: clampedTarget.y,
        userId: socket.userId,
        firingSubId: submarineId
      });
    }
  });

  socket.on('loadSubmarineSlbm', (data) => {
    switchRoom(socket.roomId);
    const unitIds = Array.isArray(data?.unitIds) ? data.unitIds : [];
    if (unitIds.length <= 0) return;
    const updatedSiloIds = new Set();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId || unit.type !== 'submarine') return;
      initializeUnitRuntimeState(unit);
      if (getSubmarineLoadedSlbmCount(unit) >= SUBMARINE_SLBM_CAPACITY) return;
      const sourceSilo = findNearestOwnedMissileSiloWithStock(socket.userId, unit.x, unit.y, SUBMARINE_SLBM_LOAD_RANGE);
      if (!sourceSilo) return;
      sourceSilo.slbmCount = Math.max(0, getStoredSlbmCountForBuilding(sourceSilo) - 1);
      unit.loadedSlbms = getSubmarineLoadedSlbmCount(unit) + 1;
      updatedSiloIds.add(sourceSilo.id);
    });
    updatedSiloIds.forEach(buildingId => {
      const building = gameState.buildings.get(buildingId);
      if (!building) return;
      roomEmit('slbmProduced', {
        buildingId,
        count: getStoredSlbmCountForBuilding(building)
      });
    });
  });

  socket.on('toggleSubmarineStealth', (data) => {
    switchRoom(socket.roomId);
    const unitIds = Array.isArray(data?.unitIds) ? data.unitIds : [];
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId || unit.type !== 'submarine') return;
      initializeUnitRuntimeState(unit);
      const now = Date.now();
      if (unit.stealthActive) {
        unit.stealthActive = false;
        unit.isDetected = true;
        unit.stealthCooldownUntil = now + SUBMARINE_STEALTH_COOLDOWN_MS;
      } else {
        if (now < (unit.stealthCooldownUntil || 0)) return;
        unit.stealthActive = true;
        unit.isDetected = false;
        unit.stealthExpiresAt = now + SUBMARINE_STEALTH_DURATION_MS;
      }
    });
  });

  // Secret admin: dynamically add/remove AI players
  // AI Difficulty setting: first human player in room sets it
  socket.on('setAIDifficulty', (data) => {
    switchRoom(socket.roomId);
    if (!gameState) return;
    const difficulty = getEffectiveAIDifficulty(data && data.difficulty);
    gameState.aiDifficulty = difficulty;
    io.to(socket.roomId).emit('aiDifficultyChanged', { difficulty, label: DIFFICULTY_PRESETS[difficulty].label });
    console.log(`[AI] Room ${socket.roomId} difficulty set to ${difficulty} by ${socket.username}`);
  });

  socket.on('addAI', () => {
    switchRoom(socket.roomId);
    if (!gameState || !socket.isObserver) return;
    let newIndex = 0;
    while (gameState.players.has(getAIUserId(newIndex))) newIndex++;
    const aiPlayer = spawnAIPlayer(newIndex);
    if (aiPlayer) {
      io.to(socket.roomId).emit('playerJoined', aiPlayer);
      socket.emit('systemMessage', { text: 'AI 플레이어 추가됨: ' + aiPlayer.username });
    }
  });

  socket.on('removeAI', () => {
    switchRoom(socket.roomId);
    if (!gameState || !socket.isObserver) return;
    // Remove the AI with the highest index
    let lastAiId = null;
    gameState.players.forEach((player, userId) => {
      if (player.isAI) {
        if (lastAiId === null || userId > lastAiId) lastAiId = userId;
      }
    });
    if (lastAiId !== null) {
      const removedName = gameState.players.get(lastAiId)?.username || 'AI';
      clearActiveWeaponsForUser(lastAiId);
      removePlayerFromCurrentRoom(lastAiId, { emitPlayerLeft: true });
      socket.emit('systemMessage', { text: 'AI 플레이어 제거됨: ' + removedName });
    } else {
      socket.emit('systemMessage', { text: '제거할 AI 플레이어 없음' });
    }
  });

  socket.on('unlockBattleshipModeCombo', (data) => {
    switchRoom(socket.roomId);
    const unitId = Number(data?.unitId);
    if (!Number.isFinite(unitId)) return;
    const unit = gameState.units.get(unitId);
    if (!unit || unit.userId !== socket.userId || unit.type !== 'battleship') return;
    initializeUnitRuntimeState(unit);
    if (unit.battleshipModeComboUnlocked) {
      socket.emit('battleshipModeComboUnlocked', { unitId: unit.id, alreadyUnlocked: true });
      return;
    }
    unit.battleshipModeComboUnlocked = true;
    refreshBattleshipModeState(unit);
    socket.emit('battleshipModeComboUnlocked', { unitId: unit.id, alreadyUnlocked: false });
  });
  
  socket.on('researchSLBM', (data) => {
    switchRoom(socket.roomId);
    const { buildingId } = data;
    const building = gameState.buildings.get(buildingId);
    const player = gameState.players.get(socket.userId);
    
    if (
      building &&
      building.userId === socket.userId &&
      (building.type === 'missile_silo' || building.type === 'research_lab') &&
      player &&
      !player.researchedSLBM &&
      building.buildProgress >= 100
    ) {
      player.researchedSLBM = true;
      roomEmit('researchCompleted', { userId: socket.userId, research: 'SLBM' });
    }
  });
  
  // Produce missile (global player missiles) - queue-based
  socket.on('produceMissile', (data) => {
    switchRoom(socket.roomId);
    const { buildingId } = data;
    const building = gameState.buildings.get(buildingId);
    const player = gameState.players.get(socket.userId);
    
    if (building && building.userId === socket.userId && building.type === 'missile_silo' && player) {
      if (building.buildProgress < 100) return;
      if (!building.missileQueue) building.missileQueue = [];
      if (building.missileQueue.length >= 10) return;
      const missileCost = 1500;
      if (player.resources >= missileCost) {
        player.resources -= missileCost;
        building.missileQueue.push({
          type: 'missile',
          buildTime: 67500,
          userId: socket.userId,
          socketId: socket.id
        });
        if (!building.missileProducing) {
          const next = building.missileQueue[0];
          building.missileProducing = {
            type: next.type,
            startTime: Date.now(),
            buildTime: next.buildTime,
            userId: next.userId,
            socketId: next.socketId
          };
        }
      }
    }
  });
  
  // Carrier: produce aircraft (queue-based)
  socket.on('produceAircraft', (data) => {
    switchRoom(socket.roomId);
    const { unitId } = data;
    const carrier = gameState.units.get(unitId);
    const player = gameState.players.get(socket.userId);
    if (!carrier || carrier.userId !== socket.userId || carrier.type !== 'carrier' || !player) return;
    if (!carrier.aircraft) carrier.aircraft = [];
    if (!carrier.aircraftDeployed) carrier.aircraftDeployed = [];
    if (!carrier.aircraftQueue) carrier.aircraftQueue = [];
    const totalAircraft = carrier.aircraft.length + carrier.aircraftDeployed.length + carrier.aircraftQueue.length;
    if (totalAircraft >= 10) return; // Max 10 per carrier
    if (carrier.aircraftQueue.length >= 10) return;
    const acCost = 100;
    if (player.resources >= acCost) {
      player.resources -= acCost;
      carrier.aircraftQueue.push({
        type: 'aircraft',
        buildTime: 22500,
        userId: socket.userId
      });
      if (!carrier.producingAircraft) {
        const next = carrier.aircraftQueue[0];
        carrier.producingAircraft = {
          type: next.type,
          startTime: Date.now(),
          buildTime: next.buildTime,
          userId: next.userId
        };
      }
    }
  });

  socket.on('produceReconAircraft', (data) => {
    switchRoom(socket.roomId);
    const { unitId } = data;
    const carrier = gameState.units.get(unitId);
    const player = gameState.players.get(socket.userId);
    if (!carrier || carrier.userId !== socket.userId || carrier.type !== 'carrier' || !player) return;
    if (!carrier.reconAircraft) carrier.reconAircraft = [];
    if (!carrier.reconAircraftDeployed) carrier.reconAircraftDeployed = [];
    if (!carrier.reconAircraftQueue) carrier.reconAircraftQueue = [];
    const totalRecon = carrier.reconAircraft.length + carrier.reconAircraftDeployed.length + carrier.reconAircraftQueue.length;
    if (totalRecon >= RECON_AIRCRAFT_MAX_PER_CARRIER) return;
    if (carrier.reconAircraftQueue.length >= RECON_AIRCRAFT_MAX_PER_CARRIER) return;
    const reconConfig = getUnitDefinition('recon_aircraft');
    if (player.resources >= reconConfig.cost) {
      player.resources -= reconConfig.cost;
      carrier.reconAircraftQueue.push({
        type: 'recon_aircraft',
        buildTime: RECON_AIRCRAFT_BUILD_TIME_MS,
        userId: socket.userId
      });
      if (!carrier.producingReconAircraft) {
        const next = carrier.reconAircraftQueue[0];
        carrier.producingReconAircraft = {
          type: next.type,
          startTime: Date.now(),
          buildTime: next.buildTime,
          userId: next.userId
        };
      }
    }
  });

  function getReconAircraftLaunchTarget(targetX, targetY) {
    return clampToMapBounds(targetX, targetY);
  }

  function spawnReconAircraftFromCarrier(carrier, targetX, targetY, reconStock, launchIndex, now) {
    const reconConfig = getUnitDefinition('recon_aircraft');
    const reconId = createUniqueEntityId(700 + launchIndex);
    const assignedTarget = getReconAircraftLaunchTarget(targetX, targetY);
    const spawnPos = findNonOverlappingPosition(
      carrier.x + (Math.random() - 0.5) * 50,
      carrier.y + (Math.random() - 0.5) * 50,
      reconConfig.size
    );
    const reconAircraft = {
      id: reconId,
      userId: carrier.userId,
      type: 'recon_aircraft',
      x: spawnPos.x,
      y: spawnPos.y,
      hp: Math.max(1, Math.min(reconConfig.hp, reconStock?.hp ?? reconConfig.hp)),
      maxHp: reconConfig.hp,
      damage: 0,
      speed: reconConfig.speed,
      size: reconConfig.size,
      attackRange: 0,
      attackCooldownMs: reconConfig.attackCooldownMs,
      visionRadius: reconConfig.visionRadius,
      targetX: null,
      targetY: null,
      gatheringResourceId: null,
      buildingType: null,
      buildTargetX: null,
      buildTargetY: null,
      isDetected: true,
      kills: 0,
      sourceCarrierId: carrier.id,
      scoutTargetX: assignedTarget.x,
      scoutTargetY: assignedTarget.y,
      scoutBaseTargetX: targetX,
      scoutBaseTargetY: targetY,
      scoutState: 'outbound',
      scoutLoiterUntil: null,
      scoutOrbitAngle: null,
      scoutOrbitDirection: 1,
      scoutNextOrbitAt: now,
      holdPosition: true
    };
    assignMoveTarget(reconAircraft, assignedTarget.x, assignedTarget.y);
    gameState.units.set(reconId, reconAircraft);
    carrier.reconAircraftDeployed.push(reconId);
    emitUnitCreatedEvent(reconAircraft);
  }

  function launchCarrierAircraftFromStock(carrier, aircraftStock, now) {
    if (!carrier) return null;
    const unitConfig = getUnitDefinition('aircraft');
    const acId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const spawnPos = findNonOverlappingPosition(
      carrier.x + (Math.random() - 0.5) * 40,
      carrier.y + (Math.random() - 0.5) * 40,
      unitConfig.size
    );
    const aircraftUnit = {
      id: acId,
      userId: carrier.userId,
      type: 'aircraft',
      x: spawnPos.x,
      y: spawnPos.y,
      hp: Math.max(1, Math.min(unitConfig.hp, aircraftStock?.hp ?? unitConfig.hp)),
      maxHp: unitConfig.hp,
      damage: unitConfig.damage,
      speed: unitConfig.speed,
      attackRange: unitConfig.attackRange,
      attackCooldownMs: unitConfig.attackCooldownMs,
      targetX: null,
      targetY: null,
      gatheringResourceId: null,
      buildingType: null,
      buildTargetX: null,
      buildTargetY: null,
      isDetected: false,
      kills: 0,
      holdPosition: true,
      carrierId: carrier.id,
      carrierRange: carrier.attackRange || 800
    };
    gameState.units.set(acId, aircraftUnit);
    carrier.aircraftDeployed.push(acId);
    carrier.lastAircraftDeploy = now;
    emitUnitCreatedEvent(aircraftUnit);
    return aircraftUnit;
  }

  function queueCarrierAircraftForRepair(carrier, aircraft, now) {
    if (!carrier) return;
    if (!carrier.aircraftRepairQueue) carrier.aircraftRepairQueue = [];
    const unitConfig = getUnitDefinition('aircraft');
    carrier.aircraftRepairQueue.push({
      hp: Math.max(1, Math.min(unitConfig.hp, aircraft?.hp ?? unitConfig.hp)),
      readyAt: now + CARRIER_AIRCRAFT_REPAIR_DOCK_MS,
      autoLaunch: true
    });
  }

  socket.on('launchReconAircraft', (data) => {
    switchRoom(socket.roomId);
    const { unitId, targetX, targetY } = data;
    const carrier = gameState.units.get(unitId);
    if (!carrier || carrier.userId !== socket.userId || carrier.type !== 'carrier') return;
    if (!carrier.reconAircraft) carrier.reconAircraft = [];
    if (!carrier.reconAircraftDeployed) carrier.reconAircraftDeployed = [];
    if (carrier.reconAircraft.length <= 0) return;

    const clamped = clampToMapBounds(targetX, targetY);
    const now = Date.now();
    const reconStock = carrier.reconAircraft.pop();
    const deployedCount = carrier.reconAircraftDeployed.length;
    const launchIndex = deployedCount % RECON_AIRCRAFT_MAX_PER_CARRIER;
    spawnReconAircraftFromCarrier(carrier, clamped.x, clamped.y, reconStock, launchIndex, now);
  });
  
  // Carrier: deploy aircraft
  socket.on('deployAircraft', (data) => {
    switchRoom(socket.roomId);
    const { unitId } = data;
    const carrier = gameState.units.get(unitId);
    if (!carrier || carrier.userId !== socket.userId || carrier.type !== 'carrier') return;
    carrier.deployAircraft = true;
  });
  
  // Battleship: activate aimed shot (16s cooldown)
  socket.on('activateAimedShot', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!unitIds || !Array.isArray(unitIds)) return;
    const now = Date.now();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId && unit.type === 'battleship') {
        if (unit.battleshipAegisMode) return;
        // Check cooldown (16 seconds)
        if (unit.aimedShotCooldownUntil && now < unit.aimedShotCooldownUntil) return;
        unit.aimedShot = true;
      }
    });
  });

  socket.on('toggleCombatStance', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!Array.isArray(unitIds)) return;
    const now = Date.now();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId || unit.type !== 'battleship') return;
      initializeUnitRuntimeState(unit);
      const canCombine = canUnitUseBattleshipModeCombo(unit);
      if (unit.combatStanceActive) {
        unit.combatStanceActive = false;
        unit.combatStanceStacks = 0;
        unit.lastBattleshipCombatAt = 0;
        unit.lastCombatStanceDecayAt = 0;
        refreshBattleshipModeState(unit);
        applyUnitSelfDamage(unit, computeCurrentHpSelfDamage(unit, BATTLESHIP_COMBAT_STANCE_HP_COST_RATIO), now);
        return;
      }
      if (unit.battleshipAegisMode && !canCombine) {
        return;
      }
      unit.combatStanceActive = true;
      noteBattleshipCombatActivity(unit, now);
      refreshBattleshipModeState(unit);
    });
  });

  socket.on('toggleBattleshipAegisMode', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!Array.isArray(unitIds)) return;
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId || unit.type !== 'battleship') return;
      initializeUnitRuntimeState(unit);
      const canCombine = canUnitUseBattleshipModeCombo(unit);
      if (!unit.battleshipAegisMode && unit.combatStanceActive && !canCombine) {
        return;
      }
      unit.battleshipAegisMode = !unit.battleshipAegisMode;
      if (unit.battleshipAegisMode) {
        unit.aimedShot = false;
        unit.battleshipAegisTurretTargetLocks = Array.from({ length: BATTLESHIP_AEGIS_TURRET_COUNT }, () => null);
      }
      if (!unit.battleshipAegisMode) {
        unit.lastTurretTargetTime = Date.now();
        unit.battleshipAegisTurretTargetLocks = Array.from({ length: BATTLESHIP_AEGIS_TURRET_COUNT }, () => null);
      }
      refreshBattleshipModeState(unit);
    });
  });

  socket.on('setBattleshipSkinVariant', (data) => {
    switchRoom(socket.roomId);
    const { unitId, skinVariant } = data || {};
    const unit = gameState.units.get(unitId);
    if (!unit || unit.userId !== socket.userId || unit.type !== 'battleship') return;
    if (skinVariant !== 'yamato' && skinVariant !== 'default') return;
    if (skinVariant === 'yamato' && !canUsernameUseYamatoBattleshipSkin(socket.username)) return;
    initializeUnitRuntimeState(unit);
    unit.battleshipSkinVariant = skinVariant;
  });

  socket.on('toggleFrigateEngineOverdrive', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!Array.isArray(unitIds)) return;
    const now = Date.now();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId || unit.type !== 'frigate') return;
      initializeUnitRuntimeState(unit);
      unit.engineOverdriveActive = !unit.engineOverdriveActive;
      unit.engineOverdriveLastTickAt = unit.engineOverdriveActive ? now : null;
      refreshFrigateEngineOverdrive(unit);
    });
  });
  
  // Attack move command
  socket.on('attackMove', (data) => {
    switchRoom(socket.roomId);
    const { unitIds, targetX, targetY } = data;
    const movableUnits = [];
    const squadsMoved = new Set();
    (Array.isArray(unitIds) ? unitIds : []).forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.type === 'missile_launcher' && unit.deployState !== 'mobile') return;
      if (unit && unit.userId === socket.userId && canAcceptPlayerOrders(unit)) {
        if (unit.squadId && !squadsMoved.has(unit.squadId)) {
          const squad = gameState.squads.get(unit.squadId);
          if (squad) {
            squadsMoved.add(unit.squadId);
            issueSquadAttackMove(squad, targetX, targetY);
          }
        } else if (!unit.squadId) {
          movableUnits.push(unit);
        }
      }
    });
    if (movableUnits.length > 0) {
      issueGroupedMoveOrder(movableUnits, targetX, targetY);
      movableUnits.forEach(unit => {
        unit.holdPosition = false;
        unit.attackMove = true;
        unit.attackTargetId = null;
        unit.attackTargetType = null;
      });
    }
  });

  socket.on('holdPosition', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!Array.isArray(unitIds)) return;
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.type === 'missile_launcher') return;
      if (!unit || unit.userId !== socket.userId || !canAcceptPlayerOrders(unit)) return;
      unit.holdPosition = true;
      unit.attackMove = false;
      unit.attackTargetId = null;
      unit.attackTargetType = null;
      unit.targetX = null;
      unit.targetY = null;
      unit.pathWaypoints = null;
      unit.gatheringResourceId = null;
      unit.buildingType = null;
      unit.buildTargetX = null;
      unit.buildTargetY = null;
    });
  });

  socket.on('deployMissileLauncher', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!Array.isArray(unitIds)) return;
    const now = Date.now();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId || unit.type !== 'missile_launcher' || unit.deployState !== 'mobile') return;
      unit.deployState = 'deploying_stage1';
      unit.deployStateEndsAt = now + MISSILE_LAUNCHER_DEPLOY_STAGE_MS;
      unit.speed = 0;
      unit.attackRange = 0;
      unit.targetX = null;
      unit.targetY = null;
      unit.pathWaypoints = null;
      unit.holdPosition = false;
      unit.attackMove = false;
      unit.attackTargetId = null;
      unit.attackTargetType = null;
    });
  });

  socket.on('undeployMissileLauncher', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!Array.isArray(unitIds)) return;
    const now = Date.now();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId || unit.type !== 'missile_launcher' || unit.deployState !== 'deployed') return;
      unit.deployState = 'undeploying_stage2';
      unit.deployStateEndsAt = now + MISSILE_LAUNCHER_DEPLOY_STAGE_MS;
      unit.speed = 0;
      unit.attackRange = 0;
      unit.targetX = null;
      unit.targetY = null;
      unit.pathWaypoints = null;
      unit.holdPosition = false;
      unit.attackMove = false;
      unit.attackTargetId = null;
      unit.attackTargetType = null;
    });
  });

  const loadUnitsToAssaultShip = (data) => {
    switchRoom(socket.roomId);
    const { shipId, unitIds } = data;
    if (!Array.isArray(unitIds) || unitIds.length === 0) return;
    const ship = gameState.units.get(shipId);
    if (!ship || ship.userId !== socket.userId || ship.type !== 'assaultship') return;
    if (!ship.loadedMissileLaunchers) ship.loadedMissileLaunchers = [];
    let remainingCapacity = ASSAULT_SHIP_MAX_LAUNCHERS - ship.loadedMissileLaunchers.length;
    if (remainingCapacity <= 0) return;

    const uniqueIds = [...new Set(unitIds)];
    uniqueIds.forEach(unitId => {
      if (remainingCapacity <= 0) return;
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId || !canUnitBoardAssaultShip(unit)) return;
      const dx = unit.x - ship.x;
      const dy = unit.y - ship.y;
      if ((dx * dx) + (dy * dy) > ASSAULT_SHIP_LOAD_RADIUS * ASSAULT_SHIP_LOAD_RADIUS) return;
      unit.targetX = null;
      unit.targetY = null;
      unit.pathWaypoints = null;
      unit.holdPosition = false;
      unit.attackMove = false;
      unit.attackTargetId = null;
      unit.attackTargetType = null;
      ship.loadedMissileLaunchers.push(createAssaultShipCargoPayload(unit));
      gameState.units.delete(unit.id);
      remainingCapacity--;
    });
  };

  socket.on('loadUnitsToAssaultShip', loadUnitsToAssaultShip);
  socket.on('loadMissileLaunchersToAssaultShip', loadUnitsToAssaultShip);

  socket.on('unloadAssaultShipVehicles', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!Array.isArray(unitIds) || unitIds.length === 0) return;
    const uniqueIds = [...new Set(unitIds)];

    uniqueIds.forEach(unitId => {
      const ship = gameState.units.get(unitId);
      if (!ship || ship.userId !== socket.userId || ship.type !== 'assaultship') return;
      if (!Array.isArray(ship.loadedMissileLaunchers) || ship.loadedMissileLaunchers.length === 0) return;
      if (!isAssaultShipNearLand(ship)) return;

      const remainingCargo = [...ship.loadedMissileLaunchers];
      ship.loadedMissileLaunchers = [];
      for (let i = 0; i < remainingCargo.length; i++) {
        const angle = (i / Math.max(remainingCargo.length, 1)) * Math.PI * 2;
        const candidateX = ship.x + Math.cos(angle) * ASSAULT_SHIP_LAND_RADIUS;
        const candidateY = ship.y + Math.sin(angle) * ASSAULT_SHIP_LAND_RADIUS;
        const cargo = remainingCargo[i];
        const spawnPoint = findNonOverlappingLandPosition(candidateX, candidateY, getAssaultShipCargoSpawnSize(cargo));
        if (!spawnPoint) {
          ship.loadedMissileLaunchers.push(cargo);
          continue;
        }
        const createdUnit = createAssaultShipCargoUnit(ship.userId, spawnPoint, cargo);
        if (!createdUnit) {
          ship.loadedMissileLaunchers.push(cargo);
          continue;
        }
        gameState.units.set(createdUnit.id, createdUnit);
        emitUnitCreatedEvent(createdUnit);
      }
    });
  });

  // Cruiser: toggle Aegis mode
  socket.on('toggleAegisMode', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!unitIds || !Array.isArray(unitIds)) return;
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId && unit.type === 'cruiser') {
        unit.aegisMode = !unit.aegisMode;
        // Clear current attack target when toggling modes
        unit.attackTargetId = null;
        unit.attackTargetType = null;
      }
    });
  });

  // Destroyer: activate search (extends vision to a wide pulse for a short duration, 16s cooldown)
  socket.on('activateSearch', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!unitIds || !Array.isArray(unitIds)) return;
    const now = Date.now();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId && unit.type === 'destroyer') {
        if (unit.searchCooldownUntil && now < unit.searchCooldownUntil) return;
        unit.searchCooldownUntil = now + 16000;
        unit.searchActiveUntil = now + SEARCH_REVEAL_DURATION_MS;
        const vr = DESTROYER_SEARCH_VISION_RADIUS;
        if (ENABLE_SERVER_FOG_SNAPSHOTS) {
          if (!gameState.fogOfWar.has(unit.userId)) {
            gameState.fogOfWar.set(unit.userId, new Map());
          }
          revealFogCircleForPlayer(gameState.fogOfWar.get(unit.userId), unit.x, unit.y, vr, now);
        }
        emitSearchActivatedEvent({ unitId: unit.id, x: unit.x, y: unit.y, radius: vr, userId: unit.userId });
      }
    });
  });

  // Destroyer: lay mine at target location
  socket.on('layMine', (data) => {
    switchRoom(socket.roomId);
    const { unitId, targetX, targetY } = data;
    const unit = gameState.units.get(unitId);
    if (!unit || unit.userId !== socket.userId || unit.type !== 'destroyer') return;
    const clamped = clampToMapBounds(targetX, targetY);
    if (isOnLand(clamped.x, clamped.y)) return;
    const destroyerVisionRadius = unit.visionRadius || UNIT_DEFINITIONS.destroyer.visionRadius;
    const dx = clamped.x - unit.x;
    const dy = clamped.y - unit.y;
    if ((dx * dx) + (dy * dy) > destroyerVisionRadius * destroyerVisionRadius) return;
    let activeMineCount = 0;
    gameState.units.forEach(other => {
      if (other.type === 'mine' && other.userId === unit.userId && other.hp > 0 && (other.sourceDestroyerId == null || other.sourceDestroyerId === unit.id)) {
        activeMineCount++;
      }
    });
    if (activeMineCount >= DESTROYER_MAX_MINES) return;
    const mineId = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 500;
    const mineDef = getUnitDefinition('mine');
    const mine = {
      id: mineId,
      userId: unit.userId,
      type: 'mine',
      x: clamped.x,
      y: clamped.y,
      hp: mineDef.hp,
      maxHp: mineDef.hp,
      damage: mineDef.damage,
      speed: 0,
      size: mineDef.size,
      attackRange: mineDef.attackRange,
      attackCooldownMs: mineDef.attackCooldownMs,
      visionRadius: 0,
      targetX: null,
      targetY: null,
      isDetected: false, // Mines are hidden by default
      sourceDestroyerId: unit.id,
      kills: 0
    };
    gameState.units.set(mineId, mine);
    emitUnitCreatedEvent(mine);
  });

  // Carrier: launch airstrike (requires 10 aircraft, consumes all, 20s cooldown after refill)
  socket.on('launchAirstrike', (data) => {
    switchRoom(socket.roomId);
    const { unitId, targetX, targetY } = data;
    const carrier = gameState.units.get(unitId);
    if (!carrier || carrier.userId !== socket.userId || carrier.type !== 'carrier') return;
    const isAdmin = socket.username === 'JsonParc';
    const acCount = (carrier.aircraft || []).length;
    if (!isAdmin && acCount < 10) return;
    const now = Date.now();
    if (!isAdmin && carrier.airstrikeCooldownUntil && now < carrier.airstrikeCooldownUntil) return;
    
    // Consume all aircraft (admin keeps them)
    if (!isAdmin) {
      carrier.aircraft = [];
      carrier.airstrikeReady = false;
      carrier.pendingAirstrikeCooldown = true;
      carrier.airstrikeCooldownUntil = null;
    }
    
    const clamped = clampToMapBounds(targetX, targetY);
    const airstrikeSpeed = 6000; // 2x battleship projectile speed (3000)
    const baseAngle = Math.atan2(clamped.y - carrier.y, clamped.x - carrier.x);
    const mapW = gameState.map ? gameState.map.width : 20000;
    const mapH = gameState.map ? gameState.map.height : 20000;
    const margin = 500;
    if (!gameState.activeAirstrikes) gameState.activeAirstrikes = new Map();

    // Helper: compute entry→exit flight through target along a given angle
    function createAirstrikeEntry(entryX, entryY, angle, delayMs, passNumber) {
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      // Exit point: extend past target along flight angle to map edge + margin
      let maxT = 99999;
      if (cosA > 0.001) maxT = Math.min(maxT, (mapW + margin - entryX) / cosA);
      else if (cosA < -0.001) maxT = Math.min(maxT, (-margin - entryX) / cosA);
      if (sinA > 0.001) maxT = Math.min(maxT, (mapH + margin - entryY) / sinA);
      else if (sinA < -0.001) maxT = Math.min(maxT, (-margin - entryY) / sinA);
      maxT = Math.max(maxT, 500);
      const exitX = entryX + cosA * maxT;
      const exitY = entryY + sinA * maxT;
      const totalDist = Math.sqrt((exitX - entryX) ** 2 + (exitY - entryY) ** 2);
      const targetDist = Math.sqrt((clamped.x - entryX) ** 2 + (clamped.y - entryY) ** 2);
      const targetProgress = targetDist / totalDist;
      const flightTimeMs = Math.max(300, Math.round((totalDist / airstrikeSpeed) * 1000));
      const impactTime = now + delayMs + Math.round(flightTimeMs * targetProgress);

      const id = nextAirstrikeId++;
      const strike = {
        id, userId: carrier.userId, carrierId: unitId,
        fromX: entryX, fromY: entryY,
        exitX, exitY,
        targetX: clamped.x, targetY: clamped.y,
        targetProgress,
        currentX: entryX, currentY: entryY,
        startTime: now + delayMs,
        impactTime,
        flightTime: flightTimeMs,
        passNumber,
        damageApplied: false,
        damageRadius: AIRSTRIKE_DAMAGE_RADIUS,
        damagePerPass: AIRSTRIKE_DAMAGE_PER_PASS,
        visualRadius: AIRSTRIKE_VISUAL_RADIUS,
        explosionsPerPass: 30
      };
      gameState.activeAirstrikes.set(id, strike);
      emitAirstrikeLaunchedEvent({
        id, fromX: entryX, fromY: entryY,
        exitX, exitY,
        targetX: clamped.x, targetY: clamped.y,
        targetProgress,
        userId: carrier.userId,
        flightTime: flightTimeMs,
        startDelay: delayMs
      });
    }

    // Strike 1: from carrier direction
    createAirstrikeEntry(carrier.x, carrier.y, baseAngle, 0, 1);

    // Remaining passes: delayed follow-up flights from random directions
    for (let p = 1; p < AIRSTRIKE_PASS_COUNT; p++) {
      const randAngle = baseAngle + (Math.random() * Math.PI * 1.2 + Math.PI * 0.4) * (Math.random() < 0.5 ? 1 : -1);
      const entryDist = 1500 + Math.random() * 1000;
      const entryX = clamped.x - Math.cos(randAngle) * entryDist;
      const entryY = clamped.y - Math.sin(randAngle) * entryDist;
      createAirstrikeEntry(entryX, entryY, randAngle, p * AIRSTRIKE_PASS_INTERVAL_MS, p + 1);
    }
  });
  
  socket.on('resetAllAiFactions', () => {
    switchRoom(socket.roomId);
    if (socket.isObserver) return;
    resetAllAiFactionsInCurrentRoom();
  });

  socket.on('triggerRedZoneNow', () => {
    switchRoom(socket.roomId);
    if (!gameState || !gameState.map || socket.isObserver) return;
    rollNewRedZones(Date.now());
  });

  socket.on('disconnect', () => {
    switchRoom(socket.roomId);
    console.log(`Player disconnected: ${socket.username}`);
    try {
      removePlayerFromCurrentRoom(socket.userId, { emitPlayerLeft: true });
      if (!roomHasHumanPlayers(socket.roomId)) {
        const removedAiCount = removeAllAiFactionsFromCurrentRoom();
        clearCurrentRoomTransientState();
        gameState.lastUpdate = Date.now();
        syncSlbmId();
        console.log(`Room ${socket.roomId} is now idle; stopped simulation and removed ${removedAiCount} AI player(s)`);
      }
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Load player data from database
function loadPlayerData(userId) {
  try {
    const playerData = db.prepare('SELECT * FROM player_data WHERE user_id = ?').get(userId);
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    
    console.log(`Loading data for user ${userId}:`, playerData ? 'found' : 'not found');
    
    if (playerData && user) {
      gameState.players.set(userId, {
        userId: userId,
        username: user.username,
        resources: playerData.resources,
        population: playerData.population,
        maxPopulation: clampPlayerMaxPopulation(playerData.max_population),
        combatPower: 0,
        score: 0,
        scoreFromKills: Math.max(0, Math.floor(playerData.score || 0)),
        baseX: playerData.base_x,
        baseY: playerData.base_y,
        hasBase: playerData.has_base === 1,
        researchedSLBM: playerData.researched_slbm === 1,
        missiles: playerData.missiles || 0,
        battleshipModeComboUnlocked: false,
        online: true
      });
      
      // If player doesn't have a base, spawn one
      if (playerData.has_base === 0) {
        spawnPlayerBase(userId);
      }
    } else {
      console.error(`No data found for user ${userId}`);
    }
    
    // Initialize fog of war for player
    if (ENABLE_SERVER_FOG_SNAPSHOTS && !gameState.fogOfWar.has(userId)) {
      gameState.fogOfWar.set(userId, new Map());
    }
    
    // Load units
    const units = db.prepare('SELECT * FROM units WHERE user_id = ?').all(userId);
    console.log(`Loaded ${units.length} units for user ${userId}`);

    units.forEach(unit => {
      const unitConfig = getUnitDefinition(unit.type);

      // Validate/sanitize positions against the current map.
      let unitX = unit.x;
      let unitY = unit.y;
      if (!isWithinMapBounds(unitX, unitY)) {
        const clamped = clampToMapBounds(unitX, unitY);
        unitX = clamped.x;
        unitY = clamped.y;
      }

      // Ships should always be on water.
      if (isNavalUnitType(unit.type) && !isNavalPositionTerrainPassable(unit.type, unitX, unitY)) {
        const waterPos = findNearestNavalPassableWaterPosition(unit.type, unitX, unitY, 360);
        if (waterPos) {
          unitX = waterPos.x;
          unitY = waterPos.y;
          console.log(`Relocating naval unit ${unit.id} from land to water (${unitX}, ${unitY})`);
        } else {
          const fallback = clampToMapBounds(unitX, unitY);
          unitX = fallback.x;
          unitY = fallback.y;
        }
      }
      
      const hydratedUnit = initializeUnitRuntimeState({
        id: unit.id,
        userId: unit.user_id,
        type: unit.type,
        x: unitX,
        y: unitY,
        hp: unit.hp,
        maxHp: unit.max_hp,
        targetX: unit.target_x,
        targetY: unit.target_y,
        speed: unitConfig.speed,
        damage: unitConfig.damage,
        attackRange: unitConfig.attackRange,
        attackCooldownMs: unitConfig.attackCooldownMs,
        gatheringResourceId: unit.gathering_resource_id,
        buildingType: unit.building_type,
        buildTargetX: unit.build_target_x,
        buildTargetY: unit.build_target_y,
        sourceDestroyerId: unit.source_destroyer_id,
        isDetected: unit.is_detected === 1,
        loadedSlbms: unit.loaded_slbms || 0,
        stealthActive: false,
        kills: unit.kills || 0
      });

      if (hydratedUnit.targetX !== null && hydratedUnit.targetY !== null) {
        assignMoveTarget(hydratedUnit, hydratedUnit.targetX, hydratedUnit.targetY);
      }

      gameState.units.set(unit.id, hydratedUnit);
    });
    
    // Load buildings
    const buildings = db.prepare('SELECT * FROM buildings WHERE user_id = ?').all(userId);
    console.log(`Loaded ${buildings.length} buildings for user ${userId}`);
    
    let totalPopBonus = 0;
    let headquartersPos = null;
    let hasCompletedSilo = false;
    
    const sortedBuildings = [...buildings].sort((a, b) => {
      const aPriority = a.type === 'headquarters' ? 0 : 1;
      const bPriority = b.type === 'headquarters' ? 0 : 1;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return (b.build_progress || 0) - (a.build_progress || 0);
    });

    sortedBuildings.forEach(building => {
      const normalizedType = building.type === 'research_lab' ? 'missile_silo' : building.type;
      const isComplete = building.build_progress >= 100;
      const targetMaxHp = normalizedType === 'missile_silo' ? 1000 : building.max_hp;
      const hpRatio = building.max_hp > 0 ? (building.hp / building.max_hp) : 1;
      const targetHp = Math.max(1, Math.round(targetMaxHp * Math.max(0, Math.min(1, hpRatio))));
      
      // Validate building position - buildings should be on land
      let buildingX = building.x;
      let buildingY = building.y;
      if (!isOnLand(building.x, building.y)) {
        const landPos = findNearestLandPosition(building.x, building.y);
        buildingX = landPos.x;
        buildingY = landPos.y;
        console.log(`Relocating building ${building.id} from water to land (${buildingX}, ${buildingY})`);
      }

      const resolvedBuildingPos = findNearestValidBuildingPosition(normalizedType, buildingX, buildingY, {
        ignoreBuildingId: building.id
      });
      if (resolvedBuildingPos) {
        if (resolvedBuildingPos.x !== buildingX || resolvedBuildingPos.y !== buildingY) {
          console.log(`Relocating building ${building.id} to avoid overlap (${buildingX}, ${buildingY}) -> (${resolvedBuildingPos.x}, ${resolvedBuildingPos.y})`);
        }
        buildingX = resolvedBuildingPos.x;
        buildingY = resolvedBuildingPos.y;
      }
      
      gameState.buildings.set(building.id, {
        id: building.id,
        userId: building.user_id,
        type: normalizedType,
        x: buildingX,
        y: buildingY,
        hp: targetHp,
        maxHp: targetMaxHp,
        buildProgress: building.build_progress,
        slbmCount: building.slbm_count || 0,
        populationBonusApplied: isComplete // Mark as applied if already complete
      });
      
      // Track headquarters position
      if (normalizedType === 'headquarters') {
        headquartersPos = { x: buildingX, y: buildingY };
      }
      
      // Add population bonus for completed buildings
      if (isComplete) {
        totalPopBonus += getBuildingPopulationBonus(normalizedType);
      }
      if (isComplete && normalizedType === 'missile_silo') {
        hasCompletedSilo = true;
      }
    });
    
    // Apply total population bonus to player and fix baseX/baseY
    const player = gameState.players.get(userId);
    if (player) {
      player.maxPopulation = clampPlayerMaxPopulation(PLAYER_BASE_POPULATION_CAP + totalPopBonus);
      if (hasCompletedSilo) player.researchedSLBM = true;
      const storedMissiles = recalculatePlayerMissileStock(userId);
      const legacyMissiles = Math.max(0, Math.floor(playerData?.missiles || 0));
      if (legacyMissiles > storedMissiles) {
        const fallbackSilo = [...gameState.buildings.values()].find(building => (
          building.userId === userId && building.type === 'missile_silo' && building.buildProgress >= 100
        ));
        if (fallbackSilo) {
          fallbackSilo.slbmCount = getStoredSlbmCountForBuilding(fallbackSilo) + (legacyMissiles - storedMissiles);
          recalculatePlayerMissileStock(userId);
        }
      }
      console.log(`Player ${userId} maxPopulation set to ${player.maxPopulation}`);
      
      // Update baseX/baseY to headquarters position if available
      if (headquartersPos) {
        player.baseX = headquartersPos.x;
        player.baseY = headquartersPos.y;
        db.prepare('UPDATE player_data SET base_x = ?, base_y = ? WHERE user_id = ?')
          .run(headquartersPos.x, headquartersPos.y, userId);
      }
    }
    recalculateAllPlayerCombatPowerAndScores();
  } catch (error) {
    console.error('Error loading player data:', error);
    throw error;
  }
}

// Save player data to database
function savePlayerData(userId) {
  const player = gameState.players.get(userId);
  if (!player) return;
  recalculatePlayerMissileStock(userId);
  
  db.prepare(`UPDATE player_data SET 
    resources = ?, population = ?, max_population = ?, 
    combat_power = ?, score = ?, has_base = ?, researched_slbm = ?, 
    missiles = ?, last_active = CURRENT_TIMESTAMP 
    WHERE user_id = ?`).run(
    player.resources, player.population, player.maxPopulation,
    player.combatPower, getPlayerScoreFromKills(player), player.hasBase ? 1 : 0, 
    player.researchedSLBM ? 1 : 0, player.missiles || 0, userId
  );
  
  // Save units
  db.prepare('DELETE FROM units WHERE user_id = ?').run(userId);
  const unitInsert = db.prepare(`INSERT INTO units 
    (id, user_id, type, x, y, hp, max_hp, target_x, target_y, 
     gathering_resource_id, building_type, build_target_x, build_target_y, source_destroyer_id, is_detected, loaded_slbms, stealth_active, kills) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`); 
  gameState.units.forEach(unit => {
    if (unit.userId === userId) {
      unitInsert.run(unit.id, unit.userId, unit.type, unit.x, unit.y, unit.hp, unit.maxHp, 
        unit.targetX, unit.targetY, unit.gatheringResourceId, unit.buildingType, 
        unit.buildTargetX, unit.buildTargetY, unit.sourceDestroyerId ?? null, unit.isDetected ? 1 : 0,
        getSubmarineLoadedSlbmCount(unit), unit.stealthActive ? 1 : 0, unit.kills || 0);
    }
  });

  db.prepare('DELETE FROM buildings WHERE user_id = ?').run(userId);
  const buildingInsert = db.prepare(`INSERT INTO buildings 
    (id, user_id, type, x, y, hp, max_hp, build_progress, slbm_count) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  gameState.buildings.forEach(building => {
    if (building.userId === userId) {
      buildingInsert.run(building.id, building.userId, building.type, building.x, building.y, 
        building.hp, building.maxHp, building.buildProgress, building.slbmCount || 0);
    }
  });
}

// Build unit
function buildUnit(userId, buildingId, unitType) {
  const building = gameState.buildings.get(buildingId);
  const player = gameState.players.get(userId);
  
  if (!building || building.userId !== userId || !player) return;
  if (!Object.prototype.hasOwnProperty.call(UNIT_DEFINITIONS, unitType)) return;
  if (unitType === 'aircraft') return; // Aircraft can't be built directly
  
  const unitConfig = getUnitDefinition(unitType);
  
  // Check building type restrictions
  if (unitType === 'worker' && building.type !== 'headquarters') return;
  if (['destroyer', 'cruiser', 'frigate'].includes(unitType) && building.type !== 'shipyard') return;
  if (['battleship', 'carrier', 'submarine', 'assaultship'].includes(unitType) && building.type !== 'naval_academy') return;
  if (unitType === 'missile_launcher' && building.type !== 'carbase') return;
  
  // Building must be complete
  if (building.buildProgress < 100) return;
  
  // Initialize production queue if needed
  if (!building.productionQueue) building.productionQueue = [];
  
  // Max 10 items in queue
  if (building.productionQueue.length >= 10) return;
  
  if (player.resources >= unitConfig.cost && player.population + unitConfig.pop <= player.maxPopulation) {
    player.resources -= unitConfig.cost;
    player.population += unitConfig.pop;
    
    // Add to production queue
    building.productionQueue.push({
      unitType: unitType,
      buildTime: unitConfig.buildTime || 10000,
      userId: userId
    });
    
    // If nothing currently producing, start it
    if (!building.producing) {
      const next = building.productionQueue[0];
      building.producing = {
        unitType: next.unitType,
        startTime: Date.now(),
        buildTime: next.buildTime,
        userId: next.userId
      };
    }
  }
}

// Build building
function buildBuilding(userId, type, x, y) {
  const player = gameState.players.get(userId);
  if (!player) return;
  
  const buildingTypes = {
    'headquarters': { cost: HEADQUARTERS_BUILD_COST, hp: 1500, size: getBuildingCollisionSize('headquarters') },
    'shipyard': { cost: 200, hp: 800, size: getBuildingCollisionSize('shipyard'), popBonus: 5 },
    'power_plant': { cost: 150, hp: 600, size: getBuildingCollisionSize('power_plant'), popBonus: 3 },
    'defense_tower': { cost: 250, hp: 700, size: getBuildingCollisionSize('defense_tower') },
    'naval_academy': { cost: 300, hp: 700, size: getBuildingCollisionSize('naval_academy'), popBonus: 10 },
    'carbase': { cost: CARBASE_BUILD_COST, hp: 800, size: getBuildingCollisionSize('carbase') },
    'missile_silo': { cost: MISSILE_SILO_COST, hp: 1000, size: getBuildingCollisionSize('missile_silo') }
  };
  
  const buildingConfig = buildingTypes[type];
  if (!buildingConfig) return;

  const clampedBuildPos = clampToMapBounds(x, y);
  x = clampedBuildPos.x;
  y = clampedBuildPos.y;

  // Check if a worker is nearby (within 500 units)
  let workerNearby = false;
  gameState.units.forEach(unit => {
    if (unit.userId === userId && unit.type === 'worker') {
      const dx = unit.x - x;
      const dy = unit.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < 500) {
        workerNearby = true;
      }
    }
  });

  if (!workerNearby) {
    return; // Workers must be nearby to build
  }

  if (type === 'carbase' && !canBuildCarbaseForUser(userId)) {
    return;
  }
  
  if (!isBuildingPlacementValid(type, x, y, { size: buildingConfig.size })) {
    return;
  }
  
  // No additional tech prerequisite for missile silo.
  
  if (player.resources >= buildingConfig.cost) {
    player.resources -= buildingConfig.cost;
    
    const buildingId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    gameState.buildings.set(buildingId, {
      id: buildingId,
      userId: userId,
      type: type,
      x: x,
      y: y,
      hp: buildingConfig.hp,
      maxHp: buildingConfig.hp,
      buildProgress: 0,
      slbmCount: 0
    });
    
    emitBuildingCreatedEvent(gameState.buildings.get(buildingId));
  }
}

if (!BENCHMARK_MODE) {
  // Game loop - iterates all rooms
  setInterval(() => {
    const now = Date.now();
    gameRooms.forEach((room, roomId) => {
      if (!roomHasHumanPlayers(roomId)) {
        room.lastUpdate = now;
        return;
      }
      switchRoom(roomId);
      const deltaTime = (now - gameState.lastUpdate) / 1000;
      gameState.lastUpdate = now;
      updateGame(deltaTime);
      syncSlbmId();
    });
    perfFlush('runtime');
  }, 1000 / GAME_TICK_RATE);

  // Separate fog of war update (less frequent) - all rooms
  setInterval(() => {
    if (!ENABLE_SERVER_FOG_SNAPSHOTS) return;
    gameRooms.forEach((room, roomId) => {
      if (!roomHasHumanPlayers(roomId)) return;
      switchRoom(roomId);
      updateFogOfWar();
    });
  }, 2000);

  // Broadcast game state updates (optimized) - per room
  let updateCounter = 0;
  setInterval(() => {
    updateCounter++;
    gameRooms.forEach((room, roomId) => {
      if (!roomHasHumanPlayers(roomId)) return;

      switchRoom(roomId);
      const entityCount = gameState.units.size + gameState.buildings.size;
      const humanCount = getRoomHumanCount(roomId);
      let stride = 1;
      if (entityCount > 600) stride = 4;
      else if (entityCount > 400) stride = 3;
      else if (entityCount > 200) stride = 2;
      if (humanCount >= 4) stride = Math.max(stride, 3);
      else if (humanCount >= 2) stride = Math.max(stride, 2);

      if (updateCounter % stride !== 0) return;
      const socketsInRoom = getConnectedSocketsForRoom(roomId);
      if (socketsInRoom.length === 0) return;
      const playersPayload = buildClientPlayersPayload();
      socketsInRoom.forEach(socket => {
        socket.volatile.emit('gameUpdate', buildClientStatePayloadForSocket(socket, playersPayload));
      });
    });
  }, NETWORK_UPDATE_BASE_MS);
}

// Separate fog of war update function
function updateFogOfWar() {
  if (!ENABLE_SERVER_FOG_SNAPSHOTS) return;
  const now = Date.now();
  const cellSize = gameState.map ? (gameState.map.cellSize || 50) : 50;
  
  gameState.players.forEach((player, playerId) => {
    if (!player || player.isAI || player.online === false) return;
    if (!gameState.fogOfWar.has(playerId)) {
      gameState.fogOfWar.set(playerId, new Map());
    }
    const playerFog = gameState.fogOfWar.get(playerId);
    // Reusable fog value to avoid creating a new object for every cell
    const fogValue = { lastSeen: now, explored: true };
    
    // Reveal fog based on unit positions
      gameState.units.forEach(unit => {
        if (unit.userId !== playerId) return;
          const unitDef = getUnitDefinition(unit.type);
          let visionRadius = unitDef.visionRadius || mapConfig.vision.unitVisionRadius;
          if (unit.type === 'battleship' && unit.aimedShot && !unit.battleshipAegisMode) {
            visionRadius *= 2;
          }
          if (unit.type === 'destroyer' && unit.searchActiveUntil && now < unit.searchActiveUntil) {
            visionRadius = Math.max(visionRadius, DESTROYER_SEARCH_VISION_RADIUS);
          }
          const gridX = Math.floor(unit.x / cellSize);
          const gridY = Math.floor(unit.y / cellSize);
          const gridRadius = Math.ceil(visionRadius / cellSize);
          const gridRadiusSq = gridRadius * gridRadius;
        
        for (let dx = -gridRadius; dx <= gridRadius; dx++) {
          for (let dy = -gridRadius; dy <= gridRadius; dy++) {
            if (dx * dx + dy * dy <= gridRadiusSq) {
              const key = `${gridX + dx}_${gridY + dy}`;
              const existing = playerFog.get(key);
              if (existing) {
                existing.lastSeen = now;
              } else {
                playerFog.set(key, { lastSeen: now, explored: true });
              }
            }
          }
        }
    });
    
    // Reveal fog based on building positions
    gameState.buildings.forEach(building => {
      if (building.userId !== playerId || building.buildProgress < 100) return;
        const visionRadius = mapConfig.vision.buildingVisionRadius;
        const gridX = Math.floor(building.x / cellSize);
        const gridY = Math.floor(building.y / cellSize);
        const gridRadius = Math.ceil(visionRadius / cellSize);
        const gridRadiusSq = gridRadius * gridRadius;
        
        for (let dx = -gridRadius; dx <= gridRadius; dx++) {
          for (let dy = -gridRadius; dy <= gridRadius; dy++) {
            if (dx * dx + dy * dy <= gridRadiusSq) {
              const key = `${gridX + dx}_${gridY + dy}`;
              const existing = playerFog.get(key);
              if (existing) {
                existing.lastSeen = now;
              } else {
                playerFog.set(key, { lastSeen: now, explored: true });
              }
            }
          }
        }
    });

    gameState.units.forEach(unit => {
      if ((unit.type === 'submarine' || unit.type === 'mine') && unit.isDetected && unit.searchRevealedUntil && now < unit.searchRevealedUntil) {
        revealFogCircleForPlayer(playerFog, unit.x, unit.y, Math.max(250, getUnitAreaHitRadius(unit) + 40), now);
      }
    });
    
  });
}

// Apply SLBM impact damage
function applySlbmDamage(slbm, now = Date.now()) {
  const damageRadius = SLBM_DAMAGE_RADIUS;
  const firingPlayer = gameState.players.get(slbm.userId);
  const firingSub = gameState.units.get(slbm.firingSubId);

  gameState.units.forEach(target => {
    const targetRadius = getUnitAreaHitRadius(target);
    if (!targetIntersectsDamageCircle(slbm.targetX, slbm.targetY, damageRadius, target.x, target.y, targetRadius)) {
      return;
    }
    applyDamageToEntity(target, getAdjustedUnitDamage(target, 500), now);
    if (target.hp <= 0) {
      if (target.type === 'mine') {
        emitUnitDestroyedEvent(target);
        gameState.units.delete(target.id);
      } else {
        destroyUnitFromGame(target);
      }
      if (firingSub) registerUnitKill(firingSub);
      awardCombatScore(firingPlayer, getCombatPowerRewardForTarget(target, 'unit'));
    }
  });

  gameState.buildings.forEach(target => {
    const targetRadius = getBuildingCollisionSize(target.type) / 2;
    if (!targetIntersectsDamageCircle(slbm.targetX, slbm.targetY, damageRadius, target.x, target.y, targetRadius)) {
      return;
    }
    applyDamageToEntity(target, 800, now);
    if (target.hp <= 0) {
      destroyBuildingFromGame(target, {
        awardCombatScoreTo: firingPlayer,
        attackerUserId: slbm.userId
      });
    }
  });
}

function resolveActiveSlbmImpacts(now) {
  gameState.activeSlbms.forEach((slbm, slbmId) => {
    if (slbm.hp <= 0) {
      emitSlbmDestroyedEvent({ id: slbm.id, x: slbm.currentX, y: slbm.currentY, userId: slbm.userId });
      gameState.activeSlbms.delete(slbmId);
      return;
    }
    if (!slbm.hasReachedTarget) return;

    applySlbmDamage(slbm, now);
    emitSlbmImpactEvent({ id: slbmId, x: slbm.targetX, y: slbm.targetY, userId: slbm.userId });

    if (ENABLE_SERVER_FOG_SNAPSHOTS) {
      const cellSize = gameState.map ? (gameState.map.cellSize || 50) : 50;
      const impactVisionRadius = 2000;
      const gridX = Math.floor(slbm.targetX / cellSize);
      const gridY = Math.floor(slbm.targetY / cellSize);
      const gridRadius = Math.ceil(impactVisionRadius / cellSize);
      gameState.players.forEach((player, playerId) => {
        const playerFog = gameState.fogOfWar.get(playerId);
        if (!playerFog) return;
        for (let dx = -gridRadius; dx <= gridRadius; dx++) {
          for (let dy = -gridRadius; dy <= gridRadius; dy++) {
            if (dx * dx + dy * dy <= gridRadius * gridRadius) {
              const key = `${gridX + dx}_${gridY + dy}`;
              playerFog.set(key, { lastSeen: now, explored: true });
            }
          }
        }
      });
    }

    gameState.activeSlbms.delete(slbmId);
  });
}

function launchCarrierAircraftFromStock(carrier, aircraftStock, now) {
  if (!carrier) return null;
  const unitConfig = getUnitDefinition('aircraft');
  const acId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const spawnPos = findNonOverlappingPosition(
    carrier.x + (Math.random() - 0.5) * 40,
    carrier.y + (Math.random() - 0.5) * 40,
    unitConfig.size
  );
  const aircraftUnit = {
    id: acId,
    userId: carrier.userId,
    type: 'aircraft',
    x: spawnPos.x,
    y: spawnPos.y,
    hp: Math.max(1, Math.min(unitConfig.hp, aircraftStock?.hp ?? unitConfig.hp)),
    maxHp: unitConfig.hp,
    damage: unitConfig.damage,
    speed: unitConfig.speed,
    attackRange: unitConfig.attackRange,
    attackCooldownMs: unitConfig.attackCooldownMs,
    targetX: null,
    targetY: null,
    gatheringResourceId: null,
    buildingType: null,
    buildTargetX: null,
    buildTargetY: null,
    isDetected: false,
    kills: 0,
    holdPosition: true,
    carrierId: carrier.id,
    carrierRange: carrier.attackRange || 800
  };
  gameState.units.set(acId, aircraftUnit);
  carrier.aircraftDeployed.push(acId);
  carrier.lastAircraftDeploy = now;
  emitUnitCreatedEvent(aircraftUnit);
  return aircraftUnit;
}

function queueCarrierAircraftForRepair(carrier, aircraft, now) {
  if (!carrier) return;
  if (!carrier.aircraftRepairQueue) carrier.aircraftRepairQueue = [];
  const unitConfig = getUnitDefinition('aircraft');
  carrier.aircraftRepairQueue.push({
    hp: Math.max(1, Math.min(unitConfig.hp, aircraft?.hp ?? unitConfig.hp)),
    readyAt: now + CARRIER_AIRCRAFT_REPAIR_DOCK_MS,
    autoLaunch: true
  });
}

function updateGame(deltaTime) {
  const perfStart = PERF_DEBUG_ENABLED ? perfNowMs() : 0;
  const now = Date.now();

  // Squad maintenance: remove dead units, disband small squads
  gameState.squads.forEach((squad, squadId) => {
    cleanupSquad(squadId);
  });

  // Per-tick squad formation: direct position interpolation (center + offset)
  gameState.squads.forEach((squad, squadId) => {
    if (!squad) return;
    const units = getSquadAliveUnits(squad);
    if (units.length < 2) return;

    const slowestSpeed = getSquadSlowestSpeed(squad);
    units.forEach(u => { u.speed = slowestSpeed; });

    // Initialize centerX/Y if missing
    if (!Number.isFinite(squad.centerX) || !Number.isFinite(squad.centerY)) {
      squad.centerX = units.reduce((s, u) => s + u.x, 0) / units.length;
      squad.centerY = units.reduce((s, u) => s + u.y, 0) / units.length;
    }

    // Move virtual center along waypoints or straight to target
    if (squad.moving && Number.isFinite(squad.targetX) && Number.isFinite(squad.targetY)) {
      const centerStep = slowestSpeed * deltaTime * 60;

      // Follow waypoints if available
      if (squad.centerWaypoints && squad.centerWaypoints.length > 0) {
        const wp = squad.centerWaypoints[0];
        const wdx = wp.x - squad.centerX;
        const wdy = wp.y - squad.centerY;
        const wDist = Math.hypot(wdx, wdy);
        // Update moveAngle to face current waypoint direction
        if (wDist > 1) squad.moveAngle = Math.atan2(wdy, wdx);
        if (wDist < centerStep + 5) {
          squad.centerX = wp.x;
          squad.centerY = wp.y;
          squad.centerWaypoints.shift();
          if (squad.centerWaypoints.length === 0) squad.centerWaypoints = null;
        } else {
          squad.centerX += (wdx / wDist) * centerStep;
          squad.centerY += (wdy / wDist) * centerStep;
        }
      } else {
        // Move straight to target
        const tdx = squad.targetX - squad.centerX;
        const tdy = squad.targetY - squad.centerY;
        const tDist = Math.hypot(tdx, tdy);
        if (tDist < 10) {
          squad.centerX = squad.targetX;
          squad.centerY = squad.targetY;
          squad.moving = false;
        } else {
          const step = Math.min(tDist, centerStep);
          squad.centerX += (tdx / tDist) * step;
          squad.centerY += (tdy / tDist) * step;
        }
      }

      // Check final arrival
      const finalDx = squad.targetX - squad.centerX;
      const finalDy = squad.targetY - squad.centerY;
      if (Math.hypot(finalDx, finalDy) < 10) {
        squad.centerX = squad.targetX;
        squad.centerY = squad.targetY;
        squad.moving = false;
        squad.centerWaypoints = null;
      }
    }

    // Smooth-move each unit toward center + rotated offset (no individual pathfinding)
    const cx = squad.centerX;
    const cy = squad.centerY;
    const catchUpSpeed = slowestSpeed * deltaTime * 60 * 2.5;
    const moveAngle = Number.isFinite(squad.moveAngle) ? squad.moveAngle : 0;

    units.forEach(u => {
      // Calculate desired position from forward/lateral offsets rotated by current moveAngle
      const fwd = Number.isFinite(u.squadForwardOffset) ? u.squadForwardOffset : 0;
      const lat = Number.isFinite(u.squadLateralOffset) ? u.squadLateralOffset : 0;
      const rotated = rotateSquadLocalOffset(fwd, lat, moveAngle);
      const desiredX = cx + rotated.x;
      const desiredY = cy + rotated.y;

      const dx = desiredX - u.x;
      const dy = desiredY - u.y;
      const dist = Math.hypot(dx, dy);

      if (dist < 1) {
        u.x = desiredX;
        u.y = desiredY;
      } else {
        const step = Math.min(dist, catchUpSpeed);
        const nx = u.x + (dx / dist) * step;
        const ny = u.y + (dy / dist) * step;

        // Terrain handling with sliding
        if (u.type === 'worker' || isAirUnitType(u)) {
          const clamped = clampToMapBounds(nx, ny);
          u.x = clamped.x;
          u.y = clamped.y;
        } else if (isLandCombatUnitType(u)) {
          const clampedNext = clampToMapBounds(nx, ny);
          if (isOnLand(clampedNext.x, clampedNext.y)) {
            u.x = clampedNext.x;
            u.y = clampedNext.y;
          } else {
            const slideX = clampToMapBounds(nx, u.y);
            const slideY = clampToMapBounds(u.x, ny);
            const canSlideX = isOnLand(slideX.x, slideX.y);
            const canSlideY = isOnLand(slideY.x, slideY.y);
            if (canSlideX && canSlideY) {
              if (Math.abs(dx) >= Math.abs(dy)) { u.x = slideX.x; u.y = slideX.y; }
              else { u.x = slideY.x; u.y = slideY.y; }
            } else if (canSlideX) { u.x = slideX.x; u.y = slideX.y; }
            else if (canSlideY) { u.x = slideY.x; u.y = slideY.y; }
          }
        } else {
          // Naval: terrain sliding
          const clampedNext = clampToMapBounds(nx, ny);
          if (isNavalPositionTerrainPassable(u, clampedNext.x, clampedNext.y)) {
            u.x = clampedNext.x;
            u.y = clampedNext.y;
          } else {
            const slideX = clampToMapBounds(nx, u.y);
            const slideY = clampToMapBounds(u.x, ny);
            const canSlideX = isNavalPositionTerrainPassable(u, slideX.x, slideX.y);
            const canSlideY = isNavalPositionTerrainPassable(u, slideY.x, slideY.y);
            if (canSlideX && canSlideY) {
              if (Math.abs(dx) >= Math.abs(dy)) { u.x = slideX.x; u.y = slideX.y; }
              else { u.x = slideY.x; u.y = slideY.y; }
            } else if (canSlideX) { u.x = slideX.x; u.y = slideX.y; }
            else if (canSlideY) { u.x = slideY.x; u.y = slideY.y; }
          }
        }
      }

      // Squad controls positioning; clear individual movement
      u.targetX = null;
      u.targetY = null;
      u.pathWaypoints = null;
      u.angle = moveAngle;
      u.collisionWakeUntil = null;
      u.formingUp = false;
      u.formingUpUntil = null;

      if (squad.attackMove) {
        u.attackMove = true;
      }
    });


    // Collision separation: push overlapping squad-mates apart (always active)
    for (let i = 0; i < units.length; i++) {
      const ui = units[i];
      for (let j = i + 1; j < units.length; j++) {
        const uj = units[j];
        if (doSelectionEllipsesOverlapWithPadding(ui, ui.x, ui.y, uj, uj.x, uj.y, NAVAL_COLLISION_CLEARANCE_BUFFER)) {
          const sdx = uj.x - ui.x;
          const sdy = uj.y - ui.y;
          const sDist = Math.hypot(sdx, sdy);
          if (sDist < 0.1) continue;
          const pushStr = 2.5 * deltaTime * 60;
          const pnx = sdx / sDist;
          const pny = sdy / sDist;
          ui.x -= pnx * pushStr;
          ui.y -= pny * pushStr;
          uj.x += pnx * pushStr;
          uj.y += pny * pushStr;
        }
      }
    }
  });

  const navalMovementSpatialIndex = new Map();
  gameState.units.forEach(unit => {
    if (usesNavalContactCollision(unit) && gameState.units.has(unit.id)) {
      addToSpatialMap(navalMovementSpatialIndex, unit, COLLISION_SPATIAL_CELL_SIZE);
    }
  });
  
  // Update units
  gameState.units.forEach((unit, unitId) => {
    initializeUnitRuntimeState(unit);
    const prevNavalX = unit.x;
    const prevNavalY = unit.y;
    if (isNavalUnitType(unit.type) && !isNavalPositionTerrainPassable(unit, unit.x, unit.y)) {
      const waterPos = findNearestNavalPassableWaterPosition(unit, unit.x, unit.y, 360);
      if (waterPos) {
        unit.x = waterPos.x;
        unit.y = waterPos.y;
      }
    }
    if (isLandCombatUnitType(unit.type) && !isOnLand(unit.x, unit.y)) {
      const landPos = findNearestLandPosition(unit.x, unit.y);
      if (landPos) {
        unit.x = landPos.x;
        unit.y = landPos.y;
      }
    }
    if (usesNavalContactCollision(unit)) {
      updateEntitySpatialMapPosition(
        navalMovementSpatialIndex,
        unit,
        prevNavalX,
        prevNavalY,
        unit.x,
        unit.y,
        COLLISION_SPATIAL_CELL_SIZE
      );
    }

    if (unit.type === 'missile_launcher') {
      if (!unit.deployState) unit.deployState = 'mobile';
      if (unit.deployState === 'mobile') {
        const launcherDef = getUnitDefinition('missile_launcher');
        unit.speed = launcherDef.speed;
        unit.attackRange = 0;
      } else if (unit.deployState === 'deploying_stage1' && now >= (unit.deployStateEndsAt || 0)) {
        unit.deployState = 'deploying_stage2';
        unit.deployStateEndsAt = now + MISSILE_LAUNCHER_DEPLOY_STAGE_MS;
      } else if (unit.deployState === 'deploying_stage2' && now >= (unit.deployStateEndsAt || 0)) {
        unit.deployState = 'deployed';
        unit.deployStateEndsAt = null;
        unit.speed = 0;
        unit.attackRange = MISSILE_LAUNCHER_DEPLOYED_RANGE;
      } else if (unit.deployState === 'undeploying_stage2' && now >= (unit.deployStateEndsAt || 0)) {
        unit.deployState = 'undeploying_stage1';
        unit.deployStateEndsAt = now + MISSILE_LAUNCHER_DEPLOY_STAGE_MS;
      } else if (unit.deployState === 'undeploying_stage1' && now >= (unit.deployStateEndsAt || 0)) {
        const launcherDef = getUnitDefinition('missile_launcher');
        unit.deployState = 'mobile';
        unit.deployStateEndsAt = null;
        unit.speed = launcherDef.speed;
        unit.attackRange = 0;
      }
    }

    if (unit.type === 'frigate') {
      if (unit.engineOverdriveActive) {
        if (!Number.isFinite(unit.engineOverdriveLastTickAt)) {
          unit.engineOverdriveLastTickAt = now;
        }
        while (now - unit.engineOverdriveLastTickAt >= FRIGATE_ENGINE_OVERDRIVE_TICK_MS) {
          unit.engineOverdriveLastTickAt += FRIGATE_ENGINE_OVERDRIVE_TICK_MS;
          const upkeepDamage = computeCurrentHpSelfDamage(unit, FRIGATE_ENGINE_OVERDRIVE_HP_COST_RATIO);
          if (applyUnitSelfDamage(unit, upkeepDamage, now)) {
            return;
          }
        }
      } else {
        unit.engineOverdriveLastTickAt = null;
      }
      refreshFrigateEngineOverdrive(unit);
    }

    // HP Regeneration: heal if not damaged recently
    if (unit.hp < unit.maxHp) {
      const timeSinceLastDamage = unit.lastDamageTime ? (now - unit.lastDamageTime) : Infinity;
      if (timeSinceLastDamage >= HP_REGEN_CONFIG.delayMs) {
        // Check if it's time to regen
        const lastRegenTime = unit.lastRegenTime || 0;
        if (now - lastRegenTime >= HP_REGEN_CONFIG.regenIntervalMs) {
          unit.lastRegenTime = now;
          applyHealingToEntity(unit, HP_REGEN_CONFIG.regenPerSecond);
        }
      }
    }

    // Movement - skip units controlled by squad (positioned directly by squad loop above)
    if (unit.squadId) {
      // Squad units are positioned by the per-tick squad formation loop
      // Do nothing here — skip all individual movement/pathfinding
    } else if (unit.targetX !== null && unit.targetY !== null) {
      const moveStartX = unit.x;
      const moveStartY = unit.y;
      const dx = unit.targetX - unit.x;
      const dy = unit.targetY - unit.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Clear formingUp flag based on timeout
      if (unit.formingUp && (!unit.formingUpUntil || Date.now() >= unit.formingUpUntil)) {
        unit.formingUp = false;
        unit.formingUpUntil = null;
      }
      if (distance > 5) {
        unit.angle = Math.atan2(dy, dx);
        let moveStep = Math.min(distance, unit.speed * deltaTime * 60);
        // Slow down when heavily blocked to reduce collision oscillation
        if (usesNavalContactCollision(unit)) {
          const blockedTicks = unit.navalBlockedTicks || 0;
          if (blockedTicks > 20) {
            moveStep *= 0.3;
          } else if (blockedTicks > 12) {
            moveStep *= 0.6;
          }
        }
        const nextX = unit.x + ((dx / distance) * moveStep);
        const nextY = unit.y + ((dy / distance) * moveStep);
        const clampedNext = clampToMapBounds(nextX, nextY);

        if (unit.type === 'worker' || isAirUnitType(unit)) {
          // Workers and aircraft can fly over any terrain
          unit.x = clampedNext.x;
          unit.y = clampedNext.y;
        } else if (isLandCombatUnitType(unit)) {
          if (isOnLand(clampedNext.x, clampedNext.y)) {
            unit.x = clampedNext.x;
            unit.y = clampedNext.y;
          } else {
            const slideX = clampToMapBounds(clampedNext.x, unit.y);
            const slideY = clampToMapBounds(unit.x, clampedNext.y);
            const canSlideX = isOnLand(slideX.x, slideX.y);
            const canSlideY = isOnLand(slideY.x, slideY.y);

            if (canSlideX && canSlideY) {
              const targetDx = unit.targetX - unit.x;
              const targetDy = unit.targetY - unit.y;
              if (Math.abs(targetDx) >= Math.abs(targetDy)) {
                unit.x = slideX.x;
                unit.y = slideX.y;
              } else {
                unit.x = slideY.x;
                unit.y = slideY.y;
              }
            } else if (canSlideX) {
              unit.x = slideX.x;
              unit.y = slideX.y;
            } else if (canSlideY) {
              unit.x = slideY.x;
              unit.y = slideY.y;
            } else {
              const finalTarget = (unit.pathWaypoints && unit.pathWaypoints.length > 0)
                ? unit.pathWaypoints[unit.pathWaypoints.length - 1]
                : { x: unit.targetX, y: unit.targetY };
              const repath = findPath(unit.x, unit.y, finalTarget.x, finalTarget.y, 'land', 'movement.landTerrainBlocked');
              if (repath && repath.length > 1) {
                unit.pathWaypoints = repath.slice(1);
                const next = unit.pathWaypoints.shift();
                unit.targetX = next.x;
                unit.targetY = next.y;
                if (unit.pathWaypoints.length === 0) unit.pathWaypoints = null;
              } else {
                unit.targetX = null;
                unit.targetY = null;
                unit.pathWaypoints = null;
              }
            }
          }
        } else {
          // Ships are restricted to water cells.
          if (isNavalPositionTerrainPassable(unit, clampedNext.x, clampedNext.y)) {
            const safeNavalPos = getSafeNavalMovePosition(unit, clampedNext.x, clampedNext.y, navalMovementSpatialIndex);
            unit.x = safeNavalPos.x;
            unit.y = safeNavalPos.y;
          } else {
            const slideX = clampToMapBounds(clampedNext.x, unit.y);
            const slideY = clampToMapBounds(unit.x, clampedNext.y);
            const canSlideX = isNavalPositionTerrainPassable(unit, slideX.x, slideX.y);
            const canSlideY = isNavalPositionTerrainPassable(unit, slideY.x, slideY.y);

            if (canSlideX && canSlideY) {
              const targetDx = unit.targetX - unit.x;
              const targetDy = unit.targetY - unit.y;
              if (Math.abs(targetDx) >= Math.abs(targetDy)) {
                const safeNavalPos = getSafeNavalMovePosition(unit, slideX.x, slideX.y, navalMovementSpatialIndex);
                unit.x = safeNavalPos.x;
                unit.y = safeNavalPos.y;
              } else {
                const safeNavalPos = getSafeNavalMovePosition(unit, slideY.x, slideY.y, navalMovementSpatialIndex);
                unit.x = safeNavalPos.x;
                unit.y = safeNavalPos.y;
              }
            } else if (canSlideX) {
              const safeNavalPos = getSafeNavalMovePosition(unit, slideX.x, slideX.y, navalMovementSpatialIndex);
              unit.x = safeNavalPos.x;
              unit.y = safeNavalPos.y;
            } else if (canSlideY) {
              const safeNavalPos = getSafeNavalMovePosition(unit, slideY.x, slideY.y, navalMovementSpatialIndex);
              unit.x = safeNavalPos.x;
              unit.y = safeNavalPos.y;
            } else {
              // Completely stuck - try to re-route with A* from current position
              const finalTarget = (unit.pathWaypoints && unit.pathWaypoints.length > 0)
                ? unit.pathWaypoints[unit.pathWaypoints.length - 1]
                : { x: unit.targetX, y: unit.targetY };
               
              const repath = findPath(unit.x, unit.y, finalTarget.x, finalTarget.y, unit.type, 'movement.navalTerrainBlocked');
              if (repath && repath.length > 1) {
                unit.pathWaypoints = repath.slice(1);
                const next = unit.pathWaypoints.shift();
                unit.targetX = next.x;
                unit.targetY = next.y;
                if (unit.pathWaypoints.length === 0) unit.pathWaypoints = null;
              } else {
                // Truly unreachable, stop
                unit.targetX = null;
                unit.targetY = null;
                unit.pathWaypoints = null;
              }
            }
          }
        }
        if (usesNavalContactCollision(unit)) {
          const movedDistSq = ((unit.x - moveStartX) * (unit.x - moveStartX)) + ((unit.y - moveStartY) * (unit.y - moveStartY));
          if (unit.targetX !== null && unit.targetY !== null) {
            unit.navalNoProgressTicks = movedDistSq > 1
              ? 0
              : Math.min(60, Math.max(0, unit.navalNoProgressTicks || 0) + 1);
            tryRefreshNavalRoute(unit, now);
          } else {
            unit.navalNoProgressTicks = 0;
          }
          updateEntitySpatialMapPosition(
            navalMovementSpatialIndex,
            unit,
            moveStartX,
            moveStartY,
            unit.x,
            unit.y,
            COLLISION_SPATIAL_CELL_SIZE
          );
          if (
            unit.targetX !== null ||
            unit.targetY !== null ||
            movedDistSq > 0.0001
          ) {
            unit.collisionWakeUntil = now + NAVAL_COLLISION_WAKE_MS;
          }
        }
      } else {
        // Arrived at current waypoint target
        const moveStartX = unit.x;
        const moveStartY = unit.y;
        // For ships, snap to target only if it's on water
        if ((isNavalUnitType(unit.type) && !isNavalPositionTerrainPassable(unit, unit.targetX, unit.targetY))
          || (isLandCombatUnitType(unit.type) && !isOnLand(unit.targetX, unit.targetY))) {
          // Don't move to a land waypoint, skip it
        } else {
          unit.x = unit.targetX;
          unit.y = unit.targetY;
        }
        unit.targetX = null;
        unit.targetY = null;
        
        // Follow waypoints if available
        if (unit.pathWaypoints && unit.pathWaypoints.length > 0) {
          const next = unit.pathWaypoints.shift();
          // For ships, skip land waypoints
          if ((isNavalUnitType(unit.type) && !isNavalPositionTerrainPassable(unit, next.x, next.y))
            || (isLandCombatUnitType(unit.type) && !isOnLand(next.x, next.y))) {
            // Re-route to final destination
            const finalTarget = (unit.pathWaypoints.length > 0)
              ? unit.pathWaypoints[unit.pathWaypoints.length - 1]
              : next;
            const repath = findPath(
              unit.x,
              unit.y,
              finalTarget.x,
              finalTarget.y,
              isLandCombatUnitType(unit.type) ? 'land' : unit.type,
              'movement.invalidWaypoint'
            );
            if (repath && repath.length > 1) {
              unit.pathWaypoints = repath.slice(1);
              const wp = unit.pathWaypoints.shift();
              unit.targetX = wp.x;
              unit.targetY = wp.y;
              if (unit.pathWaypoints.length === 0) unit.pathWaypoints = null;
            } else {
              unit.pathWaypoints = null;
            }
          } else {
            unit.targetX = next.x;
            unit.targetY = next.y;
          }
          if (unit.pathWaypoints && unit.pathWaypoints.length === 0) {
            unit.pathWaypoints = null;
          }
        } else {
          unit.pathWaypoints = null;
        }
        // Clear formingUp when unit has finished all movement
        if (unit.formingUp && unit.targetX === null && unit.targetY === null && !unit.pathWaypoints) {
          unit.formingUp = false;
          unit.formingUpUntil = null;
        }
        if (usesNavalContactCollision(unit) && unit.targetX === null && unit.targetY === null && !unit.pathWaypoints) {
          unit.navalAvoidanceSideBias = null;
          unit.navalBlockedTicks = 0;
          unit.navalNoProgressTicks = 0;
        }
        if (usesNavalContactCollision(unit)) {
          updateEntitySpatialMapPosition(
            navalMovementSpatialIndex,
            unit,
            moveStartX,
            moveStartY,
            unit.x,
            unit.y,
            COLLISION_SPATIAL_CELL_SIZE
          );
          if (
            unit.targetX !== null ||
            unit.targetY !== null ||
            Math.abs(unit.x - moveStartX) > 0.01 ||
            Math.abs(unit.y - moveStartY) > 0.01
          ) {
            unit.collisionWakeUntil = now + NAVAL_COLLISION_WAKE_MS;
          }
        }
        
        // Worker reached final destination (no more waypoints)
        if (unit.type === 'worker' && unit.targetX === null) {
          // Check if gathering resource
          if (LEGACY_WORKER_RESOURCE_GATHERING_ENABLED && unit.gatheringResourceId) {
            const resource = gameState.map.resources.find(r => r.id === unit.gatheringResourceId);
            if (resource && resource.amount > 0) {
              const gatherAmount = Math.min(10, resource.amount);
              resource.amount -= gatherAmount;
              const player = gameState.players.get(unit.userId);
              if (player) {
                player.resources += gatherAmount;
              }
              // Return to gather more (simplified)
              if (resource.amount > 0) {
                unit.targetX = resource.x;
                unit.targetY = resource.y;
              } else {
                unit.gatheringResourceId = null;
              }
            }
          }
          
          // Check if building
          if (unit.buildingType && unit.buildTargetX !== null && unit.buildTargetY !== null) {
            const player = gameState.players.get(unit.userId);
            if (player) {
              // Check if there's already a building being constructed here
              let existingConstruction = null;
              gameState.buildings.forEach(b => {
                const dx = b.x - unit.buildTargetX;
                const dy = b.y - unit.buildTargetY;
                if (Math.sqrt(dx * dx + dy * dy) < 50 && b.buildProgress < 100) {
                  existingConstruction = b;
                }
              });
              
              if (!existingConstruction) {
                // Start new building construction
                buildBuilding(unit.userId, unit.buildingType, unit.buildTargetX, unit.buildTargetY);
                unit.buildingType = null;
                unit.buildTargetX = null;
                unit.buildTargetY = null;
              } else {
                // Help construct existing building
                existingConstruction.buildProgress += deltaTime * 5;
                if (existingConstruction.buildProgress >= 100) {
                  existingConstruction.buildProgress = 100;
                  unit.buildingType = null;
                  unit.buildTargetX = null;
                  unit.buildTargetY = null;
                }
              }
            }
          }
        }
      }
    }
    
  });

  // Update buildings construction
  gameState.buildings.forEach(building => {
    if (building.buildProgress >= 100 && building.hp < building.maxHp) {
      const timeSinceLastDamage = building.lastDamageTime ? (now - building.lastDamageTime) : Infinity;
      if (timeSinceLastDamage >= HP_REGEN_CONFIG.delayMs) {
        const lastRegenTime = building.lastRegenTime || 0;
        if (now - lastRegenTime >= HP_REGEN_CONFIG.regenIntervalMs) {
          building.lastRegenTime = now;
          applyHealingToEntity(building, HP_REGEN_CONFIG.regenPerSecond);
        }
      }
    }

    if (building.buildProgress < 100) {
      const prevProgress = building.buildProgress;
      building.buildProgress += deltaTime * 10;
      if (building.buildProgress >= 100) {
        building.buildProgress = 100;
        
        // Increase population limit when certain buildings are completed
        const player = gameState.players.get(building.userId);
        if (player && !building.populationBonusApplied) {
          const bonus = getBuildingPopulationBonus(building.type);
          if (bonus > 0) {
            player.maxPopulation = clampPlayerMaxPopulation(player.maxPopulation + bonus);
            building.populationBonusApplied = true;
          }
          if (building.type === 'missile_silo' && !player.researchedSLBM) {
            player.researchedSLBM = true;
            roomEmit('researchCompleted', { userId: building.userId, research: 'SLBM' });
          }
        }
      }
    }
  });
  
  // Energy generation from power plants (every 10 seconds, 10x the per-second amount = 50 energy)
  gameState.buildings.forEach(building => {
    if (building.type === 'power_plant' && building.buildProgress >= 100) {
      if (!building.lastEnergyTime) building.lastEnergyTime = now;
      if (now - building.lastEnergyTime >= 10000) {
        const player = gameState.players.get(building.userId);
        if (player) {
          player.resources += 50; // 5 per second * 10 seconds
        }
        building.lastEnergyTime = now;
      }
    }
  });
  
  // Process building production queues
  gameState.buildings.forEach(building => {
    if (building.producing) {
      const elapsed = now - building.producing.startTime;
      if (elapsed >= building.producing.buildTime) {
        // Production complete - spawn unit
        const unitType = building.producing.unitType;
        const unitConfig = getUnitDefinition(unitType);
        const userId = building.producing.userId;
        
        let spawnPoint = clampToMapBounds(building.x + 50, building.y + 50);
        if (isNavalUnitType(unitType)) {
          const nearestWater = findNearestWaterPosition(building.x, building.y);
          if (!nearestWater) {
            const player = gameState.players.get(userId);
            if (player) {
              player.resources += unitConfig.cost;
              player.population -= unitConfig.pop;
            }
            building.producing = null;
            if (building.productionQueue) building.productionQueue.shift();
            // Start next in queue
            if (building.productionQueue && building.productionQueue.length > 0) {
              const next = building.productionQueue[0];
              building.producing = { unitType: next.unitType, startTime: Date.now(), buildTime: next.buildTime, userId: next.userId };
            }
            return;
          }
          spawnPoint = nearestWater;
        }
        
        // Find non-overlapping spawn position
        spawnPoint = findNonOverlappingPosition(spawnPoint.x, spawnPoint.y, unitConfig.size || 60);
        
        const unitId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
        const createdUnit = initializeUnitRuntimeState({
          id: unitId,
          userId: userId,
          type: unitType,
          x: spawnPoint.x,
          y: spawnPoint.y,
          hp: unitConfig.hp,
          maxHp: unitConfig.hp,
          damage: unitConfig.damage,
          speed: unitConfig.speed,
          attackRange: unitConfig.attackRange,
          attackCooldownMs: unitConfig.attackCooldownMs,
          targetX: null,
          targetY: null,
          gatheringResourceId: null,
          buildingType: null,
          buildTargetX: null,
          buildTargetY: null,
          isDetected: false,
          kills: 0
        });

        if (unitType === 'missile_launcher') {
          createdUnit.deployState = 'mobile';
          createdUnit.deployStateEndsAt = null;
        } else if (unitType === 'assaultship') {
          createdUnit.loadedMissileLaunchers = [];
        }

        gameState.units.set(unitId, createdUnit);
        emitUnitCreatedEvent(createdUnit);
        
        // Frigate spawns 2 units at once
        if (unitType === 'frigate') {
          const spawnPoint2 = findNonOverlappingPosition(spawnPoint.x + 40, spawnPoint.y + 40, unitConfig.size || 60);
          const unitId2 = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 1;
          const createdUnit2 = initializeUnitRuntimeState({ ...createdUnit, id: unitId2, x: spawnPoint2.x, y: spawnPoint2.y });
          gameState.units.set(unitId2, createdUnit2);
          emitUnitCreatedEvent(createdUnit2);
        }
        
        building.producing = null;
        
        // Remove completed item from queue, start next
        if (building.productionQueue) building.productionQueue.shift();
        if (building.productionQueue && building.productionQueue.length > 0) {
          const next = building.productionQueue[0];
          building.producing = { unitType: next.unitType, startTime: Date.now(), buildTime: next.buildTime, userId: next.userId };
        }
      }
    }
  });

  // Missile production processing (queue-based) for missile_silo
  gameState.buildings.forEach(building => {
    if (building.type !== 'missile_silo' || building.buildProgress < 100) return;
    if (!building.missileQueue) building.missileQueue = [];
    if (building.missileProducing) {
      const elapsed = now - building.missileProducing.startTime;
      if (elapsed >= building.missileProducing.buildTime) {
        const player = gameState.players.get(building.missileProducing.userId);
        if (player && building.missileProducing.type === 'missile') {
          building.slbmCount = getStoredSlbmCountForBuilding(building) + 1;
          player.missiles = normalizeStoredSlbmCount(player.missiles) + 1;
          if (building.missileProducing.socketId) {
            io.to(building.missileProducing.socketId).emit('missileProduced', { userId: player.userId, count: player.missiles });
          }
          roomEmit('slbmProduced', { buildingId: building.id, count: building.slbmCount });
        }
        // Dequeue and start next
        building.missileQueue.shift();
        building.missileProducing = null;
        if (building.missileQueue.length > 0) {
          const next = building.missileQueue[0];
          building.missileProducing = {
            type: next.type,
            startTime: Date.now(),
            buildTime: next.buildTime,
            userId: next.userId,
            socketId: next.socketId
          };
        }
      }
    }
  });

  // Update active SLBM missiles - position and arrival
  gameState.activeSlbms.forEach((slbm, slbmId) => {
    const elapsed = now - slbm.startTime;
    const progress = Math.min(1, elapsed / slbm.flightTime);
    
    // Update current position
    slbm.currentX = slbm.fromX + (slbm.targetX - slbm.fromX) * progress;
    slbm.currentY = slbm.fromY + (slbm.targetY - slbm.fromY) * progress;
    slbm.hasReachedTarget = progress >= 1;
  });

  // Mine detonation processing
  gameState.units.forEach((mine, mineId) => {
    if (mine.type !== 'mine' || mine.hp <= 0) return;
    const mineRange = mine.attackRange || 80; // Blast radius = 2x visual radius (visual radius = size/2 = 20, range = 80)
    gameState.units.forEach((target, targetId) => {
      if (target.userId === mine.userId || target.type === 'mine' || isAirUnitType(target) || target.hp <= 0) return;
      const dx = target.x - mine.x;
      const dy = target.y - mine.y;
      if (Math.sqrt(dx * dx + dy * dy) <= mineRange) {
        // Instant kill regardless of stealth, vision etc.
        target.hp = 0;
        const mineOwner = gameState.players.get(mine.userId);
        awardCombatScore(mineOwner, getCombatPowerRewardForTarget(target, 'unit'));
        destroyUnitFromGame(target);
        // Mine also consumed
        emitUnitDestroyedEvent(mine);
        mine.hp = 0;
        gameState.units.delete(mineId);
      }
    });
  });

  // Airstrike processing - 3 separate flights, each bombs once when reaching target
  if (!gameState.activeAirstrikes) gameState.activeAirstrikes = new Map();
  gameState.activeAirstrikes.forEach((strike, strikeId) => {
    // Skip strikes that haven't started yet (delayed 2nd/3rd flights)
    if (now < strike.startTime) return;
    const elapsed = now - strike.startTime;
    const progress = Math.min(1, elapsed / strike.flightTime);
    strike.currentX = strike.fromX + (strike.exitX - strike.fromX) * progress;
    strike.currentY = strike.fromY + (strike.exitY - strike.fromY) * progress;

    if (now >= strike.impactTime && progress < 1) {
      revealFogCircleForAllPlayers(strike.targetX, strike.targetY, strike.damageRadius, now);
    }
    
    // Single bombing when this pass reaches the target point
    if (!strike.damageApplied && now >= strike.impactTime) {
      const damageRadius = strike.damageRadius;

      gameState.units.forEach(target => {
        const targetRadius = getUnitAreaHitRadius(target);
        if (targetIntersectsDamageCircle(strike.targetX, strike.targetY, damageRadius, target.x, target.y, targetRadius)) {
          applyDamageToEntity(target, getAdjustedUnitDamage(target, strike.damagePerPass), now);
          if (target.hp <= 0) {
            if (target.type === 'mine') {
              emitUnitDestroyedEvent(target);
              gameState.units.delete(target.id);
            } else {
              destroyUnitFromGame(target);
            }
            const strikeOwner = gameState.players.get(strike.userId);
            awardCombatScore(strikeOwner, getCombatPowerRewardForTarget(target, 'unit'));
            registerCarrierKill(strike.carrierId, strike.userId);
          }
        }
      });

      gameState.buildings.forEach(target => {
        const targetRadius = getBuildingCollisionSize(target.type) / 2;
        if (targetIntersectsDamageCircle(strike.targetX, strike.targetY, damageRadius, target.x, target.y, targetRadius)) {
          applyDamageToEntity(target, strike.damagePerPass, now);
          if (target.hp <= 0) {
            destroyBuildingFromGame(target, {
              awardCombatScoreTo: strike.userId,
              attackerUserId: strike.userId
            });
          }
        }
      });
      strike.damageApplied = true;
      
      emitAirstrikePassEvent({
        id: strikeId,
        passNum: strike.passNumber || 1,
        targetX: strike.targetX,
        targetY: strike.targetY,
        radius: strike.visualRadius,
        explosionsPerPass: strike.explosionsPerPass,
        userId: strike.userId
      });
    }
    
    // Remove when flight reaches map edge
    if (progress >= 1) {
      gameState.activeAirstrikes.delete(strikeId);
    }
  });

  updateRedZones(now);

  // Carrier airstrike readiness tracking
  gameState.units.forEach(unit => {
    if (unit.type !== 'carrier') return;
    const acCount = (unit.aircraft || []).length;
    if (acCount >= 10) {
      if (unit.pendingAirstrikeCooldown) {
        // Aircraft just reached 10 after an airstrike - start 20s cooldown
        unit.airstrikeCooldownUntil = now + 20000;
        unit.pendingAirstrikeCooldown = false;
      }
      if (!unit.airstrikeCooldownUntil || now >= unit.airstrikeCooldownUntil) {
        unit.airstrikeReady = true;
      }
    } else {
      unit.airstrikeReady = false;
    }
  });

  // Destroyers always reveal submarines and mines inside current vision.
  const destroyerSensors = [];
  gameState.units.forEach(unit => {
    if (unit.type !== 'destroyer' || unit.hp <= 0) return;
    const baseVision = unit.visionRadius || UNIT_DEFINITIONS.destroyer.visionRadius;
    const detectionRadius = (unit.searchActiveUntil && now < unit.searchActiveUntil)
      ? DESTROYER_SEARCH_VISION_RADIUS
      : baseVision;
    destroyerSensors.push({
      userId: unit.userId,
      x: unit.x,
      y: unit.y,
      radiusSq: detectionRadius * detectionRadius
    });
    if (unit.searchActiveUntil && now >= unit.searchActiveUntil) {
      unit.searchActiveUntil = null;
    }
  });

  gameState.units.forEach(unit => {
    if (unit.type !== 'submarine' && unit.type !== 'mine') return;

    // 은신 만료 처리
    if (unit.type === 'submarine' && unit.stealthActive && unit.stealthExpiresAt && now >= unit.stealthExpiresAt) {
      unit.stealthActive = false;
      unit.stealthCooldownUntil = unit.stealthExpiresAt + SUBMARINE_STEALTH_COOLDOWN_MS;
    }
    const stealthOn = unit.type === 'submarine' && unit.stealthActive && unit.stealthExpiresAt && now < unit.stealthExpiresAt;
    let detected = unit.type === 'submarine' ? !stealthOn : false;
    if (!detected && unit.type === 'submarine' && unit.lastAttackTime && now - unit.lastAttackTime <= 10000) {
      detected = true;
    }
    if (!detected && unit.searchRevealedUntil && now < unit.searchRevealedUntil) {
      detected = true;
    }
    if (!detected) {
      for (let i = 0; i < destroyerSensors.length; i++) {
        const sensor = destroyerSensors[i];
        if (sensor.userId === unit.userId) continue;
        const dx = unit.x - sensor.x;
        const dy = unit.y - sensor.y;
        if ((dx * dx) + (dy * dy) <= sensor.radiusSq) {
          detected = true;
          break;
        }
      }
    }

    unit.isDetected = detected;
    if (unit.searchRevealedUntil && now >= unit.searchRevealedUntil) {
      unit.searchRevealedUntil = null;
    }
  });

  const threatUnitSpatialIndex = new Map();
  const threatBuildingSpatialIndex = new Map();
  gameState.units.forEach(unit => {
    if (unit.hp > 0) addToSpatialMap(threatUnitSpatialIndex, unit);
  });
  gameState.buildings.forEach(building => {
    if (building.hp > 0) addToSpatialMap(threatBuildingSpatialIndex, building);
  });

  // Carrier aircraft system processing
  gameState.units.forEach((unit, unitId) => {
    if (unit.type !== 'carrier') return;
    if (!unit.aircraft) unit.aircraft = [];
    if (!unit.aircraftDeployed) unit.aircraftDeployed = [];
    if (!unit.aircraftQueue) unit.aircraftQueue = [];
    if (!unit.aircraftRepairQueue) unit.aircraftRepairQueue = [];
    if (!unit.reconAircraft) unit.reconAircraft = [];
    if (!unit.reconAircraftDeployed) unit.reconAircraftDeployed = [];
    if (!unit.reconAircraftQueue) unit.reconAircraftQueue = [];
    
    // Aircraft production queue processing
    if (unit.producingAircraft) {
      const elapsed = now - unit.producingAircraft.startTime;
      if (elapsed >= unit.producingAircraft.buildTime) {
        // Production complete - add aircraft
        unit.aircraft.push({ hp: getUnitDefinition('aircraft').hp });
        unit.aircraftQueue.shift();
        unit.producingAircraft = null;
        if (unit.aircraftQueue.length > 0) {
          const next = unit.aircraftQueue[0];
          unit.producingAircraft = {
            type: next.type,
            startTime: Date.now(),
            buildTime: next.buildTime,
            userId: next.userId
          };
        }
      }
    }

    if (unit.producingReconAircraft) {
      const elapsed = now - unit.producingReconAircraft.startTime;
      if (elapsed >= unit.producingReconAircraft.buildTime) {
        unit.reconAircraft.push({ hp: getUnitDefinition('recon_aircraft').hp });
        unit.reconAircraftQueue.shift();
        unit.producingReconAircraft = null;
        if (unit.reconAircraftQueue.length > 0) {
          const next = unit.reconAircraftQueue[0];
          unit.producingReconAircraft = {
            type: next.type,
            startTime: Date.now(),
            buildTime: next.buildTime,
            userId: next.userId
          };
        }
      }
    }

    if (unit.aircraftRepairQueue.length > 0) {
      const repairedAircraft = [];
      unit.aircraftRepairQueue = unit.aircraftRepairQueue.filter(entry => {
        if ((entry.readyAt || 0) > now) return true;
        const unitConfig = getUnitDefinition('aircraft');
        const healedHp = Math.min(
          unitConfig.hp,
          Math.max(1, Math.round(entry.hp || 1)) + Math.ceil(unitConfig.hp * CARRIER_AIRCRAFT_REPAIR_HEAL_RATIO)
        );
        repairedAircraft.push({ hp: healedHp, autoLaunch: !!entry.autoLaunch });
        return false;
      });
      if (repairedAircraft.length > 0) {
        repairedAircraft.forEach(entry => {
          unit.aircraft.push({ hp: entry.hp });
        });
        if (repairedAircraft.some(entry => entry.autoLaunch)) {
          unit.deployAircraft = true;
        }
      }
    }
     
    // Auto-deploy aircraft when enemies are nearby
    const enemyNearCarrier = hasNearbyEnemyPresence(
      unit.userId,
      unit.x,
      unit.y,
      (unit.attackRange || 800) + 200,
      threatUnitSpatialIndex,
      threatBuildingSpatialIndex,
      { excludedUnitTypes: THREAT_SCAN_EXCLUDED_AIR_TYPES }
    );
    
    // If carrier has attack target, deploy command, or enemies nearby, deploy aircraft
    if (unit.attackTargetId || unit.deployAircraft || enemyNearCarrier) {
      if (!unit.lastAircraftDeploy || now - unit.lastAircraftDeploy >= 500) {
        if (unit.aircraft.length > 0) {
          const aircraftData = unit.aircraft.pop();
          launchCarrierAircraftFromStock(unit, aircraftData, now);
        }
      }
      unit.deployAircraft = false;
    }
    
    // Clean up destroyed carrier aircraft references
    unit.aircraftDeployed = unit.aircraftDeployed.filter(id => gameState.units.has(id));
    unit.reconAircraftDeployed = unit.reconAircraftDeployed.filter(id => gameState.units.has(id));
  });
  
  // Aircraft behavior - patrol near carrier, attack enemies, return when no enemies
  gameState.units.forEach((ac) => {
    if (ac.type !== 'aircraft' || !ac.carrierId) return;
    const carrier = gameState.units.get(ac.carrierId);
    if (!carrier) {
      // Carrier destroyed - aircraft is also destroyed
      emitUnitDestroyedEvent(ac);
      gameState.units.delete(ac.id);
      return;
    }
    
    const dx = ac.x - carrier.x;
    const dy = ac.y - carrier.y;
    const distToCarrier = Math.sqrt(dx * dx + dy * dy);
    const maxRange = ac.carrierRange || 800;
    const repairThresholdHp = Math.ceil((ac.maxHp || getUnitDefinition('aircraft').hp) * CARRIER_AIRCRAFT_RETURN_HP_RATIO);

    if (ac.hp <= repairThresholdHp) {
      ac.returningToCarrierForRepair = true;
      ac.attackTargetId = null;
      ac.attackTargetType = null;
      ac.attackMove = false;
      ac.holdPosition = true;
    }

    if (ac.returningToCarrierForRepair) {
      if (distToCarrier > 80) {
        assignMoveTarget(ac, carrier.x + (Math.random() - 0.5) * 50, carrier.y + (Math.random() - 0.5) * 50);
      } else {
        gameState.units.delete(ac.id);
        carrier.aircraftDeployed = carrier.aircraftDeployed.filter(id => id !== ac.id);
        queueCarrierAircraftForRepair(carrier, ac, now);
      }
      return;
    }
    
    // Check if there's an enemy in carrier range
    const hasEnemyNearby = hasNearbyEnemyPresence(
      ac.userId,
      carrier.x,
      carrier.y,
      maxRange + 200,
      threatUnitSpatialIndex,
      null,
      {
        excludedUnitTypes: THREAT_SCAN_EXCLUDED_AIR_TYPES,
        includeBuildings: false
      }
    );
    
    if (!hasEnemyNearby && !ac.attackTargetId) {
      // No enemies - return to carrier
      if (distToCarrier > 80) {
        assignMoveTarget(ac, carrier.x + (Math.random() - 0.5) * 60, carrier.y + (Math.random() - 0.5) * 60);
      } else if (distToCarrier <= 80) {
        // Close enough to carrier, dock
        gameState.units.delete(ac.id);
        carrier.aircraftDeployed = carrier.aircraftDeployed.filter(id => id !== ac.id);
        carrier.aircraft.push({ hp: ac.hp });
        return;
      }
    } else if (ac.targetX === null && !ac.attackTargetId) {
      // Patrol randomly near carrier
      const angle = Math.random() * Math.PI * 2;
      const dist = 100 + Math.random() * (maxRange * 0.6);
      const px = carrier.x + Math.cos(angle) * dist;
      const py = carrier.y + Math.sin(angle) * dist;
      assignMoveTarget(ac, px, py);
    }
    
    // If aircraft is too far from carrier and has no player-assigned target, bring it back
    if (distToCarrier > maxRange + 100 && !ac.attackTargetId) {
      assignMoveTarget(ac, carrier.x + (Math.random() - 0.5) * 100, carrier.y + (Math.random() - 0.5) * 100);
    }
  });

  gameState.units.forEach((recon) => {
    if (recon.type !== 'recon_aircraft' || !recon.sourceCarrierId) return;

    const carrier = gameState.units.get(recon.sourceCarrierId);
    if (!carrier || carrier.type !== 'carrier') {
      gameState.units.delete(recon.id);
      return;
    }

    const baseTargetX = Number.isFinite(recon.scoutBaseTargetX) ? recon.scoutBaseTargetX : recon.scoutTargetX;
    const baseTargetY = Number.isFinite(recon.scoutBaseTargetY) ? recon.scoutBaseTargetY : recon.scoutTargetY;
    const targetDx = (recon.scoutTargetX ?? baseTargetX) - recon.x;
    const targetDy = (recon.scoutTargetY ?? baseTargetY) - recon.y;
    const distToAssignedTarget = Math.sqrt((targetDx * targetDx) + (targetDy * targetDy));
    const baseTargetDx = baseTargetX - recon.x;
    const baseTargetDy = baseTargetY - recon.y;
    const distToBaseTarget = Math.sqrt((baseTargetDx * baseTargetDx) + (baseTargetDy * baseTargetDy));
    const carrierDx = carrier.x - recon.x;
    const carrierDy = carrier.y - recon.y;
    const distToCarrier = Math.sqrt((carrierDx * carrierDx) + (carrierDy * carrierDy));

    if (!recon.scoutState) {
      recon.scoutState = 'outbound';
    }

    if (recon.scoutState === 'outbound') {
      if (!Number.isFinite(recon.targetX) || !Number.isFinite(recon.targetY)) {
        assignMoveTarget(recon, baseTargetX, baseTargetY);
      }
      if (distToBaseTarget <= RECON_AIRCRAFT_TARGET_THRESHOLD) {
        const radialAngle = Math.atan2(recon.y - baseTargetY, recon.x - baseTargetX);
        const tangentClockwise = normalizeAngle(radialAngle - (Math.PI / 2));
        const tangentCounterClockwise = normalizeAngle(radialAngle + (Math.PI / 2));
        const angleToCarrier = Math.atan2(carrier.y - recon.y, carrier.x - recon.x);
        const clockwiseDelta = Math.abs(getAngleDelta(tangentClockwise, angleToCarrier));
        const counterClockwiseDelta = Math.abs(getAngleDelta(tangentCounterClockwise, angleToCarrier));
        recon.scoutState = 'orbit';
        recon.scoutLoiterUntil = now + RECON_AIRCRAFT_LOITER_MS;
        recon.scoutOrbitAngle = radialAngle;
        recon.scoutOrbitDirection = counterClockwiseDelta <= clockwiseDelta ? 1 : -1;
      }
      return;
    }

    if (recon.scoutState === 'orbit') {
      if (!Number.isFinite(recon.scoutOrbitAngle)) {
        recon.scoutOrbitAngle = Math.atan2(recon.y - baseTargetY, recon.x - baseTargetX);
      }

      recon.scoutOrbitAngle = normalizeAngle(
        recon.scoutOrbitAngle + (recon.scoutOrbitDirection || 1) * RECON_AIRCRAFT_ORBIT_ANGULAR_SPEED * deltaTime
      );

      const orbitTarget = clampToMapBounds(
        baseTargetX + Math.cos(recon.scoutOrbitAngle) * RECON_AIRCRAFT_ORBIT_RADIUS,
        baseTargetY + Math.sin(recon.scoutOrbitAngle) * RECON_AIRCRAFT_ORBIT_RADIUS
      );
      recon.scoutTargetX = orbitTarget.x;
      recon.scoutTargetY = orbitTarget.y;
      assignMoveTarget(recon, orbitTarget.x, orbitTarget.y);

      if (!Number.isFinite(recon.scoutLoiterUntil) || now >= recon.scoutLoiterUntil) {
        const tangentAngle = normalizeAngle(
          recon.scoutOrbitAngle + ((recon.scoutOrbitDirection || 1) > 0 ? (Math.PI / 2) : -(Math.PI / 2))
        );
        const angleToCarrier = Math.atan2(carrier.y - recon.y, carrier.x - recon.x);
        const alignDelta = Math.abs(getAngleDelta(tangentAngle, angleToCarrier));
        if (alignDelta <= RECON_AIRCRAFT_RETURN_ALIGN_THRESHOLD || now >= recon.scoutLoiterUntil + 2500) {
          recon.scoutState = 'returning';
          recon.scoutNextOrbitAt = now;
          assignMoveTarget(recon, carrier.x, carrier.y);
        }
      }
      return;
    }

    if (recon.scoutState === 'returning') {
      if (distToCarrier <= RECON_AIRCRAFT_DOCK_RADIUS) {
        gameState.units.delete(recon.id);
        carrier.reconAircraftDeployed = carrier.reconAircraftDeployed.filter(id => id !== recon.id);
        carrier.reconAircraft.push({ hp: Math.max(1, Math.min(recon.maxHp || getUnitDefinition('recon_aircraft').hp, recon.hp)) });
        return;
      }

      if (
        !Number.isFinite(recon.targetX) ||
        !Number.isFinite(recon.targetY) ||
        now >= (recon.scoutNextOrbitAt || 0)
      ) {
        recon.scoutNextOrbitAt = now + 600;
        assignMoveTarget(recon, carrier.x, carrier.y);
      }
    }
  });

  // Spatial index for tower target search (avoids full unit scan per tower).
  const towerTargetSpatialIndex = new Map();
  gameState.units.forEach(unit => {
    if (unit.hp > 0) {
      addToSpatialMap(towerTargetSpatialIndex, unit);
    }
  });
  
  // Defense tower combat
  gameState.buildings.forEach(building => {
    if (building.type !== 'defense_tower' || building.buildProgress < 100) return;
    
    const towerRange = 2500; // Same as battleship
    const towerDamage = 26;  // 1/10 of battleship
    const towerCooldownMs = 480; // 10x faster than battleship
    let towerTrackedTarget = false;
    
    // Find nearest enemy unit
    let nearestTarget = null;
    let nearestDistSq = towerRange * towerRange;

    forEachNearbyEntity(towerTargetSpatialIndex, building.x, building.y, towerRange, (enemy) => {
      if (!enemy || !gameState.units.has(enemy.id)) return;
      if (enemy.userId === building.userId) return;
      if ((enemy.type === 'submarine' || enemy.type === 'mine') && !enemy.isDetected) return;

      const dx = enemy.x - building.x;
      const dy = enemy.y - building.y;
      const distSq = (dx * dx) + (dy * dy);
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestTarget = enemy;
      }
    });
    
    if (nearestTarget) {
      const aimState = getDefenseTowerMuzzleWorldPosition(building.x, building.y, nearestTarget.x, nearestTarget.y);
      building.attackTargetId = nearestTarget.id;
      building.attackTargetType = 'unit';
      building.turretAngle = aimState.angle;
      building.turretTargetX = nearestTarget.x;
      building.turretTargetY = nearestTarget.y;
      building.lastTurretTargetTime = now;
      towerTrackedTarget = true;

      if (!building.lastAttackTime || now - building.lastAttackTime >= towerCooldownMs) {
        building.lastAttackTime = now;
        emitAttackProjectile(building, nearestTarget);
        const targetEvaded = doesUnitEvadeDirectAttack(nearestTarget);
        if (!targetEvaded) {
          applyDamageToEntity(nearestTarget, getAdjustedUnitDamage(nearestTarget, towerDamage), now);
          
          // Track attackers for AI counterattack response (defense tower attacks)
          if (nearestTarget.userId < 0) {
            // Target belongs to AI - record attacker info
            if (!nearestTarget.recentAttackers) nearestTarget.recentAttackers = [];
            nearestTarget.recentAttackers.push({
              attackerId: building.userId,
              attackerBuildingId: building.id,
              attackX: building.x,
              attackY: building.y,
              timestamp: now
            });
            // Also mark the attack location on the AI player
            const aiPlayer = gameState.players.get(nearestTarget.userId);
            if (aiPlayer && aiPlayer.isAI) {
              if (!aiPlayer.recentAttackLocations) aiPlayer.recentAttackLocations = [];
              aiPlayer.recentAttackLocations.push({
                x: nearestTarget.x,
                y: nearestTarget.y,
                attackerId: building.userId,
                timestamp: now
              });
            }
          }

          if (nearestTarget.hp <= 0) {
            const attacker = gameState.players.get(building.userId);
            const targetOwner = gameState.players.get(nearestTarget.userId);
            if (targetOwner) {
              const popCost = getUnitPopulationCost(nearestTarget);
              targetOwner.population = Math.max(0, targetOwner.population - popCost);
            }
            // Emit death effect for ships
            if (isNavalUnitType(nearestTarget.type)) {
              emitUnitDestroyedEvent(nearestTarget);
            }
            removeStoredSlbmsFromUnit(nearestTarget);
            gameState.units.delete(nearestTarget.id);
            building.attackTargetId = null;
            building.attackTargetType = null;
            awardCombatScore(attacker, getCombatPowerRewardForTarget(nearestTarget, 'unit'));
          }
        }
      }
    }
    
    // Defense tower SLBM interception
    gameState.activeSlbms.forEach(slbm => {
      if (slbm.userId === building.userId) return;
      if (!hasValidSlbmPosition(slbm)) return;
      const dx = slbm.currentX - building.x;
      const dy = slbm.currentY - building.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= towerRange) {
        // Tower fires at SLBM (using same cooldown as unit attack)
        if (!building.lastSlbmAttackTime || now - building.lastSlbmAttackTime >= towerCooldownMs) {
          const aimState = getDefenseTowerMuzzleWorldPosition(building.x, building.y, slbm.currentX, slbm.currentY);
          building.attackTargetId = slbm.id ?? null;
          building.attackTargetType = 'slbm';
          building.turretAngle = aimState.angle;
          building.turretTargetX = slbm.currentX;
          building.turretTargetY = slbm.currentY;
          building.lastTurretTargetTime = now;
          towerTrackedTarget = true;
          building.lastSlbmAttackTime = now;
          emitAttackProjectile(building, { id: slbm.id, x: slbm.currentX, y: slbm.currentY });
          applyDamageToEntity(slbm, towerDamage, now);
          emitSlbmDamagedEvent({ id: slbm.id, hp: slbm.hp, maxHp: slbm.maxHp, x: slbm.currentX, y: slbm.currentY, userId: slbm.userId });
          if (slbm.hp <= 0) {
            emitSlbmDestroyedEvent({ id: slbm.id, x: slbm.currentX, y: slbm.currentY, userId: slbm.userId });
            awardCombatScore(building.userId, getCombatPowerRewardForTarget(slbm, 'slbm'));
            gameState.activeSlbms.delete(slbm.id);
          }
        }
      }
    });

    if (!towerTrackedTarget && building.lastTurretTargetTime && now - building.lastTurretTargetTime > 1200) {
      building.attackTargetId = null;
      building.attackTargetType = null;
      building.turretTargetX = null;
      building.turretTargetY = null;
    }
  });
  
  // Unit collision separation (ellipse-based for naval units)
  const unitArray = Array.from(gameState.units.values());

  function getUnitEllipse(unit) {
    return getSelectionEllipseForUnit(unit);
  }

  // Check if point (px,py) is inside ellipse centered at origin with given semi-axes and rotation
  const collisionSpatialMap = new Map();
  for (let i = 0; i < unitArray.length; i++) {
    const unit = unitArray[i];
    if (!usesNavalContactCollision(unit)) continue;
    const cellX = Math.floor(unit.x / COLLISION_SPATIAL_CELL_SIZE);
    const cellY = Math.floor(unit.y / COLLISION_SPATIAL_CELL_SIZE);
    const key = `${cellX}_${cellY}`;
    let bucket = collisionSpatialMap.get(key);
    if (!bucket) {
      bucket = [];
      collisionSpatialMap.set(key, bucket);
    }
    bucket.push(i);
  }

  for (let i = 0; i < unitArray.length; i++) {
    const a = unitArray[i];
    if (!usesNavalContactCollision(a)) continue;
    const aCollisionActive =
      a.targetX !== null
      || a.targetY !== null
      || (Number.isFinite(a.collisionWakeUntil) && now < a.collisionWakeUntil);
    if (!aCollisionActive) continue;
    const cellX = Math.floor(a.x / COLLISION_SPATIAL_CELL_SIZE);
    const cellY = Math.floor(a.y / COLLISION_SPATIAL_CELL_SIZE);

    for (let dyCell = -1; dyCell <= 1; dyCell++) {
      for (let dxCell = -1; dxCell <= 1; dxCell++) {
        const neighborKey = `${cellX + dxCell}_${cellY + dyCell}`;
        const bucket = collisionSpatialMap.get(neighborKey);
        if (!bucket) continue;

        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          if (j <= i) continue;
          const b = unitArray[j];
          if (!usesNavalContactCollision(b)) continue;
          // Skip collision between same-squad units (handled by squad formation system)
          if (a.squadId && a.squadId === b.squadId) continue;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distSq = (dx * dx) + (dy * dy);
          if (distSq < 0.01) {
            const angle = (((i + 1) * 92821) + ((j + 1) * 68917)) % 360;
            const radians = angle * (Math.PI / 180);
            dx = Math.cos(radians);
            dy = Math.sin(radians);
            distSq = 1;
          }

          const eA = getUnitEllipse(a);
          const eB = getUnitEllipse(b);

          // Quick distance check (max possible radius)
          const maxRadA = Math.max(eA.semiMajor, eA.semiMinor);
          const maxRadB = Math.max(eB.semiMajor, eB.semiMinor);
          if (distSq > (maxRadA + maxRadB) * (maxRadA + maxRadB)) continue;

          // Check overlap against the sum of both selection ellipses.
          const valA = pointInRotatedEllipse(
            dx,
            dy,
            eA.semiMajor + eB.semiMajor,
            eA.semiMinor + eB.semiMinor,
            eA.angle
          );
          const valB = pointInRotatedEllipse(
            -dx,
            -dy,
            eB.semiMajor + eA.semiMajor,
            eB.semiMinor + eA.semiMinor,
            eB.angle
          );

          // Push only when the two selection ellipses actually overlap.
          const overlapVal = Math.min(valA, valB);
          if (overlapVal < 1.0) {
            const dist = Math.sqrt(distSq);
            const nx = dx / dist;
            const ny = dy / dist;
            const pushForce = Math.min(2.5, Math.max(0.1, (1.0 - overlapVal) * Math.max(eA.semiMinor + eB.semiMinor, 8) * 0.35));
            const pushX = nx * pushForce;
            const pushY = ny * pushForce;
            const rightOfWay = compareNavalRightOfWay(a, b);
            let aPushFactor = 1;
            let bPushFactor = 1;
            if (rightOfWay > 0) {
              aPushFactor = 0.35;
              bPushFactor = 1.65;
              if (Number.isFinite(b.targetX) && Number.isFinite(b.targetY)) {
                b.navalAvoidanceSideBias = getNavalAvoidanceSidePreference(b, b.targetX, b.targetY, [a]);
                b.navalBlockedTicks = Math.min(30, Math.max(0, b.navalBlockedTicks || 0) + 1);
              }
            } else if (rightOfWay < 0) {
              aPushFactor = 1.65;
              bPushFactor = 0.35;
              if (Number.isFinite(a.targetX) && Number.isFinite(a.targetY)) {
                a.navalAvoidanceSideBias = getNavalAvoidanceSidePreference(a, a.targetX, a.targetY, [b]);
                a.navalBlockedTicks = Math.min(30, Math.max(0, a.navalBlockedTicks || 0) + 1);
              }
            }

            a.x -= pushX * aPushFactor;
            a.y -= pushY * aPushFactor;
            b.x += pushX * bPushFactor;
            b.y += pushY * bPushFactor;
            a.collisionWakeUntil = now + NAVAL_COLLISION_WAKE_MS;
            b.collisionWakeUntil = now + NAVAL_COLLISION_WAKE_MS;
          }
        }
      }
    }
  }

  // Spatial indexes for combat target search.
  const combatUnitSpatialIndex = new Map();
  const combatBuildingSpatialIndex = new Map();
  gameState.units.forEach(unit => {
    if (unit.hp > 0) addToSpatialMap(combatUnitSpatialIndex, unit);
  });
  gameState.buildings.forEach(building => {
    if (building.hp > 0) addToSpatialMap(combatBuildingSpatialIndex, building);
  });

  // === Cruiser Lone Wolf passive: check isolation ===
  gameState.units.forEach((unit) => {
    if (unit.type !== 'cruiser' || unit.hp <= 0) return;
    const cruiserDef = getUnitDefinition(unit.type);
    const supportRange = Math.max(1200, cruiserDef.visionRadius || 0);
    unit.isIsolated = !hasNearbyAlliedPresence(
      unit.userId,
      unit.id,
      unit.x,
      unit.y,
      supportRange,
      combatUnitSpatialIndex,
      combatBuildingSpatialIndex,
      {
        selfRadius: Math.max(0, Number(unit.size || cruiserDef.size || 0) * 0.5),
        rangePadding: 80
      }
    );
  });
  
  // Combat processing for all units
  gameState.units.forEach((unit, unitId) => {
    // Skip workers for auto-attack
    if (unit.type === 'worker') return;
    if (unit.type === 'recon_aircraft') return;
    // Carrier and assault ship have no direct attack
    if (unit.type === 'carrier' || unit.type === 'assaultship') return;
    // Mines don't auto-attack (they detonate on proximity, handled separately)
    if (unit.type === 'mine') return;
    if (unit.type === 'missile_launcher' && unit.deployState !== 'deployed') return;

    const unitStats = getUnitDefinition(unit.type);
    const baseCombatRange = unit.attackRange || unitStats.attackRange || 200;
    let combatRange = (unit.type === 'battleship' && unit.aimedShot && !unit.battleshipAegisMode) ? baseCombatRange * 2 : baseCombatRange;
    // Aegis mode: 60% range reduction
    if (unit.type === 'cruiser' && unit.aegisMode) {
      combatRange = baseCombatRange * 0.4;
    }
    const attackCooldownMs = unit.attackCooldownMs || unitStats.attackCooldownMs || 1000;
    
    let target = null;
    
    // 1) Check if unit has a specific attack target
    if (unit.attackTargetId) {
      if (unit.attackTargetType === 'unit') {
        target = gameState.units.get(unit.attackTargetId);
        // Can't attack undetected submarines or mines
        if (target && (target.type === 'submarine' || target.type === 'mine') && !target.isDetected) {
          target = null;
          unit.attackTargetId = null;
          unit.attackTargetType = null;
        }
        if (target && unit.type === 'missile_launcher' && !isNavalUnitType(target.type)) {
          target = null;
          unit.attackTargetId = null;
          unit.attackTargetType = null;
        }
      } else if (unit.attackTargetType === 'building') {
        if (unit.type === 'missile_launcher') {
          target = null;
          unit.attackTargetId = null;
          unit.attackTargetType = null;
        } else {
        target = gameState.buildings.get(unit.attackTargetId);
        }
      }
      // If target was destroyed, clear it
      if (!target) {
        unit.attackTargetId = null;
        unit.attackTargetType = null;
      }
    }
    
    // 2) If no specific target, auto-detect nearest enemy within range
    //    Submarines do NOT auto-attack unless on attack-move ('A' key)
    if (!target && (unit.type !== 'submarine' || unit.attackMove || unit.holdPosition)) {
      let nearestDistSq = combatRange * combatRange;

      // Check enemy units (spatial query)
      forEachNearbyEntity(combatUnitSpatialIndex, unit.x, unit.y, combatRange, (enemy) => {
        if (!enemy || enemy.id === unit.id) return;
        if (!gameState.units.has(enemy.id)) return;
        if (enemy.userId === unit.userId) return;
        if (unit.type === 'missile_launcher' && !isNavalUnitType(enemy.type)) return;
        // Don't attack undetected submarines or mines
        if ((enemy.type === 'submarine' || enemy.type === 'mine') && !enemy.isDetected) return;

        const dx = enemy.x - unit.x;
        const dy = enemy.y - unit.y;
        const distSq = (dx * dx) + (dy * dy);
        if (distSq < nearestDistSq) {
          nearestDistSq = distSq;
          target = enemy;
          unit.attackTargetType = 'unit';
        }
      });

      if (unit.type !== 'missile_launcher') {
        // Check enemy buildings (spatial query)
        forEachNearbyEntity(combatBuildingSpatialIndex, unit.x, unit.y, combatRange, (enemy) => {
          if (!enemy || !gameState.buildings.has(enemy.id)) return;
          if (enemy.userId === unit.userId) return;

          const dx = enemy.x - unit.x;
          const dy = enemy.y - unit.y;
          const distSq = (dx * dx) + (dy * dy);
          if (distSq < nearestDistSq) {
            nearestDistSq = distSq;
            target = enemy;
            unit.attackTargetType = 'building';
          }
        });
      }
      
      // Check enemy SLBMs - aegis cruisers and deployed missile launchers can intercept them.
      if ((unit.type === 'cruiser' && unit.aegisMode) || unit.type === 'missile_launcher') {
        let nearestSlbm = null;
        const slbmRange = (unit.type === 'cruiser' && unit.aegisMode) ? baseCombatRange : combatRange;
        let nearestSlbmDistSq = slbmRange * slbmRange;
        gameState.activeSlbms.forEach(slbm => {
          if (slbm.userId === unit.userId) return;
          if (!hasValidSlbmPosition(slbm)) return;
          const dx = slbm.currentX - unit.x;
          const dy = slbm.currentY - unit.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < nearestSlbmDistSq) {
            nearestSlbmDistSq = distSq;
            nearestSlbm = slbm;
          }
        });
        if (nearestSlbm) {
          nearestDistSq = nearestSlbmDistSq;
          target = nearestSlbm;
          unit.attackTargetType = 'slbm';
        }
      }
    }

    if (unit.type === 'battleship' && unit.battleshipAegisMode) {
      updateBattleshipCombatStanceDecay(unit, now, !!target);
      if (unit.attackTargetType === 'slbm') {
        unit.attackTargetId = null;
        unit.attackTargetType = null;
        target = null;
      }
      processBattleshipAegisAttacks(
        unit,
        target,
        unit.attackTargetType,
        combatRange,
        combatUnitSpatialIndex,
        combatBuildingSpatialIndex,
        now
      );
      return;
    }

    if (unit.type === 'battleship') {
      updateBattleshipCombatStanceDecay(unit, now, !!target);
    }

    // 3) Process attack on target
    if (target) {
      // SLBM targets use currentX/currentY instead of x/y
      const targetX = (unit.attackTargetType === 'slbm') ? target.currentX : target.x;
      const targetY = (unit.attackTargetType === 'slbm') ? target.currentY : target.y;
      const dx = targetX - unit.x;
      const dy = targetY - unit.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Aegis mode cruiser uses full base range for SLBM targeting
      const effectiveRange = (unit.type === 'cruiser' && unit.aegisMode && unit.attackTargetType === 'slbm') ? baseCombatRange : combatRange;
      
      if (dist <= effectiveRange) {
        // In range - STOP moving and attack
        if (unit.targetX !== null && !unit.attackMove) {
          // Only stop if not on a deliberate attack-move
        }
        
        // Fire if cooldown ready
        if (!unit.lastAttackTime || now - unit.lastAttackTime >= attackCooldownMs) {
          unit.lastAttackTime = now;
          
          // For SLBM targets, create a temporary position object for projectile
          if (unit.attackTargetType === 'slbm') {
            emitAttackProjectile(unit, { x: target.currentX, y: target.currentY });
          } else {
            emitAttackProjectile(unit, target);
          }
          
          // Calculate damage with modifiers
          let dmg = unit.damage;

          if (unit.type === 'missile_launcher' && unit.attackTargetType === 'unit' && isNavalUnitType(target.type)) {
            dmg = Math.max(1, Math.ceil(target.hp * 0.5));
          } else if (unit.type === 'missile_launcher' && unit.attackTargetType === 'slbm') {
            dmg = Math.max(1, Math.ceil(target.hp * 0.5));
          }
          
          // Aegis mode: fixed damage, with bonus interception damage versus SLBMs.
          if (unit.type === 'cruiser' && unit.aegisMode) {
            dmg = unit.attackTargetType === 'slbm' ? 50 : 25;
          }
          
          // Aimed shot: 2x damage
          if (unit.type === 'battleship' && unit.aimedShot) {
            dmg *= 2;
          }
          
          // Lone Wolf passive: +100% damage when isolated
          if (unit.type === 'cruiser' && unit.isIsolated && !unit.aegisMode) {
            dmg *= 2;
          }

          // Apply damage reduction on target (Lone Wolf: 50% reduction, Aegis: 30% reduction)
          if (unit.type !== 'missile_launcher' && unit.attackTargetType === 'unit' && target.type === 'cruiser') {
            if (target.aegisMode) {
              dmg *= 0.7; // 30% damage reduction
            }
            if (target.isIsolated && !target.aegisMode) {
              dmg *= 0.5; // 50% damage reduction
            }
          }

          if (unit.attackTargetType === 'unit') {
            dmg = getAdjustedUnitDamage(target, dmg);
          }
          const targetEvaded = unit.attackTargetType === 'unit' && doesUnitEvadeDirectAttack(target);
          
          // SLBMs take direct damage like other targets.
          if (unit.attackTargetType === 'slbm') {
            applyDamageToEntity(target, dmg, now);
          } else if (!targetEvaded) {
            applyDamageToEntity(target, dmg, now);
          }
          
          // Track attackers for AI counterattack response (units and buildings)
          if (!targetEvaded && (unit.attackTargetType === 'unit' || unit.attackTargetType === 'building') && target.userId < 0) {
            recordAiUnitAttackResponse(target, unit, now);
          }
          
          // Broadcast SLBM HP update to clients
          if (unit.attackTargetType === 'slbm') {
            emitSlbmDamagedEvent({ id: target.id, hp: target.hp, maxHp: target.maxHp, x: target.currentX, y: target.currentY, userId: target.userId });
          }
          
          // Consume aimed shot after firing and start 16s cooldown
          if (unit.type === 'battleship' && unit.aimedShot) {
            unit.aimedShot = false;
            unit.aimedShotCooldownUntil = now + 16000;
          }
          
          // Submarine breaks stealth when attacking
          if (unit.type === 'submarine' && unit.stealthActive) {
            unit.stealthActive = false;
            unit.isDetected = true;
            unit.stealthCooldownUntil = now + SUBMARINE_STEALTH_COOLDOWN_MS;
          }
          
          // Check if target destroyed
          if (!targetEvaded && target.hp <= 0) {
            destroyCombatTargetByUnit(unit, target, unit.attackTargetType);
            unit.attackTargetId = null;
            unit.attackTargetType = null;
          }

          if (applyBattleshipCombatStanceAttackCost(unit, now)) {
            return;
          }
        }
      } else if (unit.type !== 'missile_launcher' && (unit.attackTargetId || unit.attackMove) && !unit.holdPosition) {
        // Out of range but has explicit attack command - move towards target
        const moveToX = (unit.attackTargetType === 'slbm') ? target.currentX : target.x;
        const moveToY = (unit.attackTargetType === 'slbm') ? target.currentY : target.y;
        const chaseTolerance = unit.attackTargetType === 'slbm' ? 120 : 220;
        const chaseRefreshIntervalMs = unit.attackTargetType === 'slbm' ? 250 : 700;
        if (shouldRefreshChasePath(unit, moveToX, moveToY, now, chaseTolerance, chaseRefreshIntervalMs)) {
          if (assignMoveTarget(unit, moveToX, moveToY)) {
            unit.lastChaseRepathAt = now;
          }
        }
      }
      // If auto-detected but out of range and no attack command, don't chase
    } else if (unit.attackMove) {
      // Attack-move with no target found - DON'T clear attackMove, keep scanning
      // attackMove naturally clears when unit reaches its move target
    }
  });

  resolveActiveSlbmImpacts(now);
  recalculateAllPlayerCombatPowerAndScores();
  if (PERF_DEBUG_ENABLED) {
    perfRecord('tick.updateGame', perfNowMs() - perfStart);
  }
}

// Ranking endpoint
app.get('/api/rankings', (req, res) => {
  // Rankings panel is room-local. Never merge same-named AI players across rooms.
  const requestedRoomId = typeof req.query.roomId === 'string' ? req.query.roomId : null;
  const requestedUserId = typeof req.query.userId === 'string' ? req.query.userId : null;
  const room =
    (requestedRoomId && gameRooms.get(requestedRoomId)) ||
    gameRooms.get('server1') ||
    [...gameRooms.values()][0];

  if (!room) {
    res.json([]);
    return;
  }

  const scoredPlayers = [...room.players.values()]
    .filter(player => player && (player.isAI || player.online))
    .map((player) => ({
      userId: String(player.userId),
      username: player.username,
      resources: Math.floor(player.resources || 0),
      population: player.population || 0,
      combat_power: player.combatPower || 0,
      score: calculatePlayerScore(player)
    }))
    .filter(player => player.score > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const rankings = scoredPlayers
    .slice(0, 5)
    .map(player => ({
      ...player,
      isSelf: requestedUserId != null && player.userId === requestedUserId
    }));

  if (requestedUserId != null && !rankings.some(player => player.userId === requestedUserId)) {
    const ownPlayer = scoredPlayers.find(player => player.userId === requestedUserId);
    if (ownPlayer) {
      rankings.push({
        ...ownPlayer,
        isSelf: true
      });
    }
  }

  res.json(rankings);
});

// Auto-save disabled (no persistence)
// State is cleared on disconnect

// ==================== AI PLAYER SYSTEM ====================

// AI decision making
function updateAI() {
  const perfStart = PERF_DEBUG_ENABLED ? perfNowMs() : 0;
  const now = Date.now();
  
  gameState.players.forEach((player, playerId) => {
    if (!player.isAI || !player.hasBase) return;

    const roomDifficulty = gameState.aiDifficulty || DEFAULT_AI_DIFFICULTY;
    const effectiveDifficulty = getEffectiveAIDifficulty(roomDifficulty);
    if (gameState.aiDifficulty !== effectiveDifficulty) {
      gameState.aiDifficulty = effectiveDifficulty;
    }
    const diffPreset = DIFFICULTY_PRESETS[effectiveDifficulty] || DIFFICULTY_PRESETS[DEFAULT_AI_DIFFICULTY];
    if (player.lastAIThinkAt && now - player.lastAIThinkAt < (diffPreset.updateInterval || AI_CONFIG.updateInterval)) {
      return;
    }
    let activeSession = null;
    if (diffPreset.useRL && RL_SESSION_DIFFICULTIES.includes(effectiveDifficulty) && !BENCHMARK_MODE) {
      activeSession = getTrainingSession(effectiveDifficulty, { create: true });
      if (!activeSession) {
        if (!player._rlSessionWaitLoggedAt || now - player._rlSessionWaitLoggedAt > 15000) {
          console.warn(`[AI-RL][${effectiveDifficulty}] Waiting for session load before AI think (player ${playerId}).`);
          player._rlSessionWaitLoggedAt = now;
        }
        return;
      }
    }
    player.lastAIThinkAt = now;
    
    // Count AI's units and buildings
    const aiUnits = [];
    const aiWorkers = [];
    const aiCombatUnits = [];
    const aiBuildings = [];
    let hasShipyard = false;
    let hasNavalAcademy = false;
    let hasPowerPlant = false;
    let hasMissileSilo = false;
    let headquartersId = null;
    let shipyardId = null;
    let navalAcademyId = null;
    let missileSiloId = null;
    let powerPlantCount = 0;
    let shipyardCount = 0;
    let defenseCount = 0;
    let missileSiloCount = 0;
    let pendingStructureCount = 0;
    
    gameState.units.forEach(unit => {
      if (unit.userId === playerId) {
        if (!LEGACY_WORKER_RESOURCE_GATHERING_ENABLED && unit.type === 'worker' && unit.gatheringResourceId) {
          unit.gatheringResourceId = null;
          if (!unit.buildingType) {
            unit.targetX = null;
            unit.targetY = null;
          }
        }
        aiUnits.push(unit);
        if (unit.type === 'worker') {
          aiWorkers.push(unit);
        } else {
          aiCombatUnits.push(unit);
        }
      }
    });
    
    gameState.buildings.forEach(building => {
      if (building.userId !== playerId) return;
      if (building.buildProgress >= 100) {
        aiBuildings.push(building);
        if (building.type === 'shipyard') {
          hasShipyard = true;
          shipyardId = building.id;
          shipyardCount++;
        }
        if (building.type === 'naval_academy') {
          hasNavalAcademy = true;
          navalAcademyId = building.id;
        }
        if (building.type === 'power_plant') {
          hasPowerPlant = true;
          powerPlantCount++;
        }
        if (building.type === 'headquarters') headquartersId = building.id;
        if (building.type === 'missile_silo') {
          hasMissileSilo = true;
          missileSiloId = building.id;
          missileSiloCount++;
        }
        if (building.type === 'defense_tower') defenseCount++;
      } else {
        pendingStructureCount++;
      }
    });
    
    // Calculate current combat power
    let currentCombatPower = 0;
    aiCombatUnits.forEach(u => {
      currentCombatPower += (AI_CONFIG.combatPower[u.type] || 0);
    });
    const unitTypeCounts = aiCombatUnits.reduce((acc, unit) => {
      acc[unit.type] = (acc[unit.type] || 0) + 1;
      return acc;
    }, {});
    const frigateCount = unitTypeCounts.frigate || 0;
    const destroyerCount = unitTypeCounts.destroyer || 0;
    const cruiserCount = unitTypeCounts.cruiser || 0;
    const battleshipCount = unitTypeCounts.battleship || 0;
    const carrierCount = unitTypeCounts.carrier || 0;
    const submarineCount = unitTypeCounts.submarine || 0;
    const assaultShipCount = unitTypeCounts.assaultship || 0;
    const missileLauncherCount = unitTypeCounts.missile_launcher || 0;
    const aiStrategy = ensureAIStrategyProfile(player);
    const knownEnemyCount = (player.knownEnemyPositions && player.knownEnemyPositions.length) || 0;
    const desiredWorkerCount = Math.max(
      2,
      Math.min(diffPreset.maxWorkers || 3, aiStrategy.desiredWorkers + Math.floor(aiBuildings.length / 6))
    );
    const projectedUnitCounts = { ...unitTypeCounts };
    let projectedResources = player.resources;
    let projectedPopulation = player.population;
    let projectedCombatPower = currentCombatPower;
    const canAffordProjectedUnit = (unitType) => {
      const unitDef = getUnitDefinition(unitType);
      return !!unitDef && projectedResources >= unitDef.cost && projectedPopulation + (unitDef.pop || 0) <= player.maxPopulation;
    };
    const registerProjectedUnit = (unitType) => {
      const unitDef = getUnitDefinition(unitType);
      if (!unitDef) return;
      projectedResources = Math.max(0, projectedResources - unitDef.cost);
      projectedPopulation += unitDef.pop || 0;
      projectedUnitCounts[unitType] = (projectedUnitCounts[unitType] || 0) + 1;
      projectedCombatPower += AI_CONFIG.combatPower[unitType] || 0;
    };
    const getProjectedChoiceContext = () => ({
      strategy: aiStrategy,
      counts: projectedUnitCounts,
      currentCombatPower: projectedCombatPower,
      knownEnemyCount,
      hasNavalAcademy,
      missileSiloCount,
      powerPlantCount,
      shipyardCount
    });
    const selectBestUnitType = (candidateTypes, scoreFn) => {
      const scored = candidateTypes
        .filter((unitType) => canAffordProjectedUnit(unitType))
        .map((unitType) => ({ unitType, score: scoreFn(unitType) }))
        .sort((a, b) => b.score - a.score);
      if (scored.length <= 0) return null;
      return scored[0].score > 0.05 ? scored[0].unitType : null;
    };
    
    // Set target combat power if not set
    if (!player.targetCombatPower) {
      const strategyBias = aiStrategy.label === 'raider' ? 0.9 : (aiStrategy.label === 'siege' ? 1.2 : 1.0);
      player.targetCombatPower = Math.round((420 + Math.floor(Math.random() * 361)) * strategyBias);
    }

    // --- RL Integration ---
    const rlActionIdx = (ENABLE_AI_TRAINING && activeSession)
      ? activeSession.getAction(gameState, playerId, effectiveDifficulty)
      : null;
    const rlAction = (ENABLE_AI_TRAINING && rlActionIdx !== null && aiTraining)
      ? aiTraining.ACTIONS[rlActionIdx]
      : null;

    // Online learning: record state/reward transitions unless the room contains excluded accounts.
    if (ENABLE_AI_TRAINING && aiTraining) {
      if (shouldCollectLiveAITrainingData(gameState)) {
        const currentState = aiTraining.encodeState(gameState, playerId);
        if (activeSession && player._prevRLState && player._prevRLAction !== undefined) {
          const snapshot = aiTraining.takeSnapshot(gameState, playerId);
          const prevSnapshot = player._prevRLSnapshot || snapshot;
          const reward = aiTraining.calculateReward(prevSnapshot, snapshot, player._prevRLAction);
          activeSession.recordTransition(player._prevRLState, player._prevRLAction, reward, currentState);
        }
        if (rlActionIdx !== null) {
          player._prevRLState = currentState;
          player._prevRLAction = rlActionIdx;
          player._prevRLSnapshot = aiTraining.takeSnapshot(gameState, playerId);
        }
      } else {
        resetPlayerRLTransitionMemory(player);
      }
    }

    // --- DEVELOPMENT: Build structures ---
    // Count shipyard/naval_academy multiples
    let navalAcademyCount = 0;
    let carbaseCount = 0;
    gameState.buildings.forEach(b => {
      if (b.userId === playerId && b.buildProgress >= 100) {
        if (b.type === 'naval_academy') navalAcademyCount++;
        if (b.type === 'carbase') carbaseCount++;
      }
    });

    const getIdleWorkers = () => aiWorkers.filter(worker => !worker.buildingType && !worker.targetX);
    const queueWorkerForConstruction = (worker, type, cost) => {
      if (!worker || player.resources < cost) return false;
      let pos = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 150 + Math.random() * 400;
        const bx = player.baseX + Math.cos(angle) * dist;
        const by = player.baseY + Math.sin(angle) * dist;
        pos = findNearestValidBuildingPosition(type, bx, by, { maxSearchRadius: 600 });
        if (pos) break;
      }
      if (!pos) {
        if (!player.buildFailCount) player.buildFailCount = 0;
        player.buildFailCount++;
        return false;
      }
      worker.buildingType = type;
      worker.buildTargetX = pos.x;
      worker.buildTargetY = pos.y;
      worker.targetX = pos.x;
      worker.targetY = pos.y;
      worker.gatheringResourceId = null;
      return true;
    };
    const tryBuildWithAnyWorker = (type, cost) => {
      const idleWorker = getIdleWorkers()[0];
      return queueWorkerForConstruction(idleWorker, type, cost);
    };
    const tryProduceUnit = (producerTypes, unitType, cost) => {
      const allowedTypes = Array.isArray(producerTypes) ? producerTypes : [producerTypes];
      const unitDef = getUnitDefinition(unitType);
      if (!unitDef) return false;
      if (player.resources < cost || player.population + (unitDef.pop || 0) > player.maxPopulation) return false;

      let built = false;
      gameState.buildings.forEach(building => {
        if (built) return;
        if (
          building.userId !== playerId ||
          !allowedTypes.includes(building.type) ||
          building.buildProgress < 100 ||
          (building.productionQueue?.length || 0) >= 2
        ) {
          return;
        }
        built = buildUnitForAI(playerId, building.id, unitType);
      });
      return built;
    };
    const tryQueueSlbm = () => {
      if (!hasMissileSilo || player.resources < 1500) return false;
      const silo = gameState.buildings.get(missileSiloId);
      if (!silo) return false;
      if (!silo.missileQueue) silo.missileQueue = [];
      if (silo.missileQueue.length >= 4) return false;
      player.resources -= 1500;
      silo.missileQueue.push({ type: 'missile', buildTime: 67500, userId: playerId, socketId: null });
      if (!silo.missileProducing) {
        silo.missileProducing = { type: 'missile', startTime: now, buildTime: 67500, userId: playerId, socketId: null };
      }
      return true;
    };
    const tryLoadAiSubmarineSlbms = (maxLoads = Number.POSITIVE_INFINITY) => {
      let remainingLoads = Number.isFinite(maxLoads)
        ? Math.max(0, Math.floor(maxLoads))
        : Number.POSITIVE_INFINITY;
      let loadedAny = false;
      aiSubs.forEach(sub => {
        if (remainingLoads <= 0) return;
        initializeUnitRuntimeState(sub);
        if (getSubmarineLoadedSlbmCount(sub) >= SUBMARINE_SLBM_CAPACITY) return;
        const silo = findNearestOwnedMissileSiloWithStock(playerId, sub.x, sub.y);
        if (!silo) return;
        silo.slbmCount = Math.max(0, getStoredSlbmCountForBuilding(silo) - 1);
        sub.loadedSlbms = getSubmarineLoadedSlbmCount(sub) + 1;
        roomEmit('slbmProduced', { buildingId: silo.id, count: silo.slbmCount });
        loadedAny = true;
        if (Number.isFinite(remainingLoads)) remainingLoads--;
      });
      return loadedAny;
    };
    const getAiSlbmFireChance = (targetContext, priorityScore, rlInitiated = false) => {
      if (!targetContext) return 0;
      let fireChance;
      if (priorityScore >= 900) fireChance = 0.96;
      else if (priorityScore >= 700) fireChance = 0.88;
      else if (priorityScore >= 520) fireChance = 0.78;
      else if (priorityScore >= 360) fireChance = 0.66;
      else if (priorityScore >= 240) fireChance = 0.52;
      else fireChance = 0.34;
      if (targetContext.defenseTowers > 0) fireChance += 0.06;
      if (targetContext.launcherCount > 0 || targetContext.missileSilos > 0) fireChance += 0.08;
      if (targetContext.advancedBuildings > 0) fireChance += 0.05;
      if (targetContext.density >= 4.5) fireChance += 0.05;
      if (rlInitiated) fireChance = Math.max(fireChance, 0.72);
      return Math.min(0.98, fireChance);
    };
    const tryFireAiSlbm = ({ rlInitiated = false } = {}) => {
      if (!player.knownEnemyPositions || player.knownEnemyPositions.length <= 0) return false;
      const loadedSubs = aiSubs.filter(sub => (
        getSubmarineLoadedSlbmCount(sub) > 0
        && now >= (sub.slbmReloadReadyAt || 0)
      ));
      if (loadedSubs.length <= 0) return false;
      const targetContext = selectBestKnownEnemyTarget(player, { purpose: 'slbm', now });
      if (!targetContext) return false;
      const priorityScore = getSlbmTargetPriorityScore(targetContext);
      const sparseTarget = targetContext.density < 2.2
        && targetContext.advancedBuildings <= 0
        && targetContext.defenseTowers <= 0
        && targetContext.launcherCount <= 0
        && targetContext.missileSilos <= 0;
      if (!rlInitiated && priorityScore < 170 && sparseTarget) return false;
      if (Math.random() >= getAiSlbmFireChance(targetContext, priorityScore, rlInitiated)) return false;

      loadedSubs.sort((a, b) => getSubmarineLoadedSlbmCount(b) - getSubmarineLoadedSlbmCount(a));
      const sub = loadedSubs[0];
      const target = targetContext.target || player.knownEnemyPositions[0];
      sub.loadedSlbms = Math.max(0, getSubmarineLoadedSlbmCount(sub) - 1);
      player.missiles = Math.max(0, normalizeStoredSlbmCount(player.missiles) - 1);
      sub.slbmReloadReadyAt = now + SUBMARINE_SLBM_RELOAD_MS;
      sub.lastAttackTime = now;
      sub.stealthCooldownUntil = now + SUBMARINE_STEALTH_COOLDOWN_MS;
      sub.stealthActive = false;
      sub.isDetected = true;
      const clampedTarget = clampToMapBounds(target.x, target.y);

      const slbmId = nextSlbmId++;
      const slbm = {
        id: slbmId,
        fromX: sub.x, fromY: sub.y,
        targetX: clampedTarget.x, targetY: clampedTarget.y,
        currentX: sub.x, currentY: sub.y,
        startTime: now,
        flightTime: 5000,
        hp: SLBM_MAX_HP, maxHp: SLBM_MAX_HP,
        userId: playerId,
        firingSubId: sub.id
      };
      gameState.activeSlbms.set(slbmId, slbm);

      emitSlbmFiredEvent({
        id: slbmId,
        fromX: sub.x, fromY: sub.y,
        targetX: clampedTarget.x, targetY: clampedTarget.y,
        userId: playerId,
        firingSubId: sub.id
      });
      console.log(`AI ${player.username} fired SLBM at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}) [priority=${priorityScore.toFixed(1)}]`);
      return true;
    };

    // --- RL ACTION EXECUTION (hard/expert only) ---
    // RL can bias a build/production choice, but failed or non-economic actions no longer suppress the rule-based fallback.
    let rlHandledBuild = false;
    let rlHandledUnit = false;
    const rlIsActive = rlAction && diffPreset.useRL;
    if (rlIsActive) {
      switch (rlAction) {
        case 'build_power_plant':
          rlHandledBuild = tryBuildWithAnyWorker('power_plant', 150);
          break;
        case 'build_shipyard':
          rlHandledBuild = tryBuildWithAnyWorker('shipyard', 200);
          break;
        case 'build_naval_academy':
          rlHandledBuild = hasShipyard && tryBuildWithAnyWorker('naval_academy', 300);
          break;
        case 'build_missile_silo':
          rlHandledBuild = tryBuildWithAnyWorker('missile_silo', MISSILE_SILO_COST);
          break;
        case 'build_defense_tower':
          rlHandledBuild = tryBuildWithAnyWorker('defense_tower', 250);
          break;
        case 'build_carbase':
          rlHandledBuild = hasMissileSilo && tryBuildWithAnyWorker('carbase', CARBASE_BUILD_COST);
          break;
        case 'produce_worker':
          rlHandledUnit = (headquartersId && aiWorkers.length < desiredWorkerCount)
            ? tryProduceUnit('headquarters', 'worker', 50)
            : false;
          break;
        case 'produce_frigate':
          rlHandledUnit = tryProduceUnit('shipyard', 'frigate', 120);
          break;
        case 'produce_destroyer':
          rlHandledUnit = tryProduceUnit('shipyard', 'destroyer', 150);
          break;
        case 'produce_cruiser':
          rlHandledUnit = tryProduceUnit('shipyard', 'cruiser', 300);
          break;
        case 'produce_battleship':
          rlHandledUnit = tryProduceUnit('naval_academy', 'battleship', BATTLESHIP_COST);
          break;
        case 'produce_carrier':
          rlHandledUnit = tryProduceUnit('naval_academy', 'carrier', CARRIER_COST);
          break;
        case 'produce_submarine':
          rlHandledUnit = tryProduceUnit('naval_academy', 'submarine', SUBMARINE_COST);
          break;
        case 'produce_assaultship':
          rlHandledUnit = tryProduceUnit('naval_academy', 'assaultship', ASSAULT_SHIP_COST);
          break;
        case 'produce_missile_launcher':
          rlHandledUnit = tryProduceUnit('carbase', 'missile_launcher', MISSILE_LAUNCHER_COST);
          break;
        case 'produce_slbm':
          rlHandledUnit = tryQueueSlbm();
          break;
        case 'load_submarine_slbm':
          rlHandledUnit = tryLoadAiSubmarineSlbms(1);
          break;
        case 'use_slbm':
          if (!aiSubs.some(sub => getSubmarineLoadedSlbmCount(sub) > 0)) {
            tryLoadAiSubmarineSlbms(1);
          }
          rlHandledUnit = tryFireAiSlbm({ rlInitiated: true });
          break;
        case 'attack_nearest_enemy':
        case 'attack_strongest_enemy':
          if (player.knownEnemyPositions && player.knownEnemyPositions.length > 0) {
            const targetContext = selectBestKnownEnemyTarget(player, {
              mode: rlAction === 'attack_strongest_enemy' ? 'strongest' : 'nearest',
              purpose: 'attack',
              now
            });
            if (targetContext) {
              player.targetCombatPower = Math.max(
                player.targetCombatPower || 0,
                Math.round(targetContext.resistance * 1.08)
              );
            }
            if (targetContext && isWorthwhileAIAttack(currentCombatPower, targetContext)) {
              const target = targetContext.target;
              aiCombatUnits.forEach(unit => {
                if (!unit.attackTargetId) assignMoveTarget(unit, target.x, target.y);
              });
            }
          }
          break;
        case 'defend_base':
          aiCombatUnits.forEach(unit => {
            if (!unit.attackTargetId && unit.type !== 'missile_launcher') {
              assignMoveTarget(unit, player.baseX + (Math.random() - 0.5) * 300, player.baseY + (Math.random() - 0.5) * 300);
            }
          });
          break;
        case 'expand':
          rlHandledBuild = tryBuildWithAnyWorker(hasShipyard ? 'power_plant' : 'shipyard', hasShipyard ? 150 : 200);
          break;
        case 'scout':
          player.lastScoutTime = 0;
          break;
        default:
          break;
      }
    }

    if (aiWorkers.length > 0) {
      const idleWorkers = getIdleWorkers();
      const earlyFleetPhase = aiCombatUnits.length < Math.max(3, aiStrategy.academyUnlockUnits);
      const academyTimingReady = aiCombatUnits.length >= aiStrategy.academyUnlockUnits
        || (powerPlantCount >= 3 && shipyardCount >= 1);
      const desiredPowerPlants = earlyFleetPhase
        ? Math.max(2, Math.min(diffPreset.minPowerPlants || 2, aiStrategy.earlyPowerPlants))
        : Math.min(
          (diffPreset.minPowerPlants || 3)
            + 1
            + (aiStrategy.earlyPowerPlants >= 4 ? 1 : 0)
            + (navalAcademyCount > 0 ? 1 : 0),
          5 + Math.floor(aiBuildings.length / 4)
        );
      const desiredShipyards = hasNavalAcademy
        ? Math.min((diffPreset.minShipyards || 2) + (player.aiStrategyId === 'raider' ? 1 : 0), 3)
        : (powerPlantCount >= Math.max(2, aiStrategy.earlyPowerPlants - 1) ? 2 : 1);
      const desiredNavalAcademies = (academyTimingReady || powerPlantCount >= 3 || shipyardCount >= 2)
        ? Math.min(3, Math.max(1, 1 + Math.floor(aiCombatUnits.length / 9) + (powerPlantCount >= 5 ? 1 : 0)))
        : 0;
      const desiredSilos = aiCombatUnits.length >= aiStrategy.siloUnlockUnits
        ? Math.min(3, Math.max(0, (diffPreset.minSilos || 0) + (aiStrategy.siloBias > 1 ? 1 : 0) + (knownEnemyCount > 0 ? 1 : 0)))
        : 0;
      const desiredTowers = aiBuildings.length >= 2
        ? Math.min(
          (diffPreset.minTowers || 2)
            + (player.aiStrategyId === 'siege' ? 2 : 0)
            + (knownEnemyCount > 0 ? 2 : 0)
            + (currentCombatPower >= 500 ? 1 : 0)
            + (powerPlantCount >= 4 ? 1 : 0)
            + (navalAcademyCount > 0 ? 1 : 0),
          5 + Math.floor(aiBuildings.length / 3)
        )
        : (powerPlantCount >= 2 ? (knownEnemyCount > 0 ? 2 : 1) : 0);
      const desiredCarbases = missileSiloCount >= 1 && aiCombatUnits.length >= aiStrategy.carbaseUnlockUnits
        ? Math.min(3, 1 + (aiStrategy.carbaseBias > 1 ? 1 : 0) + (knownEnemyCount > 0 ? 1 : 0))
        : 0;
      const maxConcurrentBuilds = Math.max(1, Math.min(3, Math.ceil(aiWorkers.length / 2) || 1));
      const canStartAnotherStructure = pendingStructureCount < maxConcurrentBuilds;

      if (!rlHandledBuild && canStartAnotherStructure && idleWorkers.length > 0) {
        const reserveForUnits = hasNavalAcademy ? 350 : (hasShipyard ? 120 : 0);
        let buildType = null;
        let buildCost = 0;

        if (!hasPowerPlant && player.resources >= 150) {
          buildType = 'power_plant';
          buildCost = 150;
        } else if (!hasShipyard && player.resources >= 200) {
          buildType = 'shipyard';
          buildCost = 200;
        } else if (!hasNavalAcademy && academyTimingReady && player.resources - 300 >= 120) {
          buildType = 'naval_academy';
          buildCost = 300;
        } else if (earlyFleetPhase) {
          if (powerPlantCount < desiredPowerPlants && player.resources - 150 >= 120) {
            buildType = 'power_plant';
            buildCost = 150;
          } else if (
            defenseCount < Math.min(2, desiredTowers)
            && powerPlantCount >= 2
            && (knownEnemyCount > 0 || aiCombatUnits.length >= 2)
            && player.resources - 250 >= 120
          ) {
            buildType = 'defense_tower';
            buildCost = 250;
          } else if (shipyardCount < desiredShipyards && powerPlantCount >= 2 && player.resources - 200 >= 120) {
            buildType = 'shipyard';
            buildCost = 200;
          } else if (defenseCount < 1 && aiCombatUnits.length >= 1 && player.resources - 250 >= 120) {
            buildType = 'defense_tower';
            buildCost = 250;
          }
        } else if (!hasNavalAcademy && powerPlantCount >= 3 && player.resources - 300 >= 150) {
          buildType = 'naval_academy';
          buildCost = 300;
        } else if (powerPlantCount < desiredPowerPlants && player.resources - 150 >= reserveForUnits) {
          buildType = 'power_plant';
          buildCost = 150;
        } else if (shipyardCount < desiredShipyards && player.resources - 200 >= reserveForUnits) {
          buildType = 'shipyard';
          buildCost = 200;
        } else if (navalAcademyCount < desiredNavalAcademies && player.resources - 300 >= 300) {
          buildType = 'naval_academy';
          buildCost = 300;
        } else if (missileSiloCount < desiredSilos && player.resources - MISSILE_SILO_COST >= 300) {
          buildType = 'missile_silo';
          buildCost = MISSILE_SILO_COST;
        } else if (defenseCount < desiredTowers && player.resources - 250 >= reserveForUnits) {
          buildType = 'defense_tower';
          buildCost = 250;
        } else if (carbaseCount < desiredCarbases && player.resources - CARBASE_BUILD_COST >= MISSILE_LAUNCHER_COST) {
          buildType = 'carbase';
          buildCost = CARBASE_BUILD_COST;
        }

        if (buildType && player.resources >= buildCost) {
          rlHandledBuild = queueWorkerForConstruction(idleWorkers[0], buildType, buildCost);
        }
      }
    }
    
    // --- DEVELOPMENT: Build units ---
    // Keep a small worker corps alive so AI can tech and recover.
    if (
      aiWorkers.length < desiredWorkerCount &&
      headquartersId &&
      player.resources >= 50 &&
      player.population < player.maxPopulation
    ) {
      buildUnitForAI(playerId, headquartersId, 'worker');
    }
    
    // --- ARMY COMPOSITION: Build combat units (rule-based fallback when RL didn't handle) ---
    if (!rlHandledUnit) {
      // Build from all available shipyards
      if (hasShipyard) {
        gameState.buildings.forEach(b => {
          if (
            b.userId !== playerId ||
            b.type !== 'shipyard' ||
            b.buildProgress < 100 ||
            (b.productionQueue?.length || 0) >= 2
          ) {
            return;
          }
          const choice = selectBestUnitType(
            ['frigate', 'destroyer', 'cruiser'],
            (unitType) => scoreShipyardUnitChoice(unitType, getProjectedChoiceContext())
          );
          if (choice && buildUnitForAI(playerId, b.id, choice)) {
            registerProjectedUnit(choice);
          }
        });
      }
      
      // Build from all available naval academies
      if (hasNavalAcademy) {
        gameState.buildings.forEach(b => {
          if (
            b.userId !== playerId ||
            b.type !== 'naval_academy' ||
            b.buildProgress < 100 ||
            (b.productionQueue?.length || 0) >= 1
          ) {
            return;
          }
          const choice = selectBestUnitType(
            ['submarine', 'carrier', 'assaultship', 'battleship'],
            (unitType) => scoreAcademyUnitChoice(unitType, getProjectedChoiceContext())
          );
          if (choice && buildUnitForAI(playerId, b.id, choice)) {
            registerProjectedUnit(choice);
          }
        });
      }
      
      // --- AI CARBASE: Produce missile launchers ---
      const desiredLaunchers = Math.max(
        missileSiloCount + (knownEnemyCount > 0 ? 1 : 0),
        player.aiStrategyId === 'siege' ? 3 : 2
      );
      if (carbaseCount > 0 && (projectedUnitCounts.missile_launcher || 0) < desiredLaunchers) {
        gameState.buildings.forEach(b => {
          if (
            b.userId !== playerId ||
            b.type !== 'carbase' ||
            b.buildProgress < 100 ||
            (b.productionQueue?.length || 0) >= 1
          ) {
            return;
          }
          if (canAffordProjectedUnit('missile_launcher') && player.resources >= MISSILE_LAUNCHER_COST) {
            const built = buildUnitForAI(playerId, b.id, 'missile_launcher');
            if (built) {
              registerProjectedUnit('missile_launcher');
            }
          }
        });
      }
    } // end !rlHandledUnit

    // --- AI MISSILE LAUNCHER: Move mobile launchers to defensive positions, then deploy ---
    const aiMobileLaunchers = aiCombatUnits.filter(u => u.type === 'missile_launcher' && (!u.deployState || u.deployState === 'mobile'));
    aiMobileLaunchers.forEach(launcher => {
      if (!launcher.deployState) launcher.deployState = 'mobile';
      if (!launcher.targetX) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 350 + Math.random() * 400;
        const deployX = player.baseX + Math.cos(angle) * dist;
        const deployY = player.baseY + Math.sin(angle) * dist;
        if (isOnLand(deployX, deployY)) {
          launcher.targetX = deployX;
          launcher.targetY = deployY;
        }
      }
    });
    // Deploy launchers that have arrived (no targetX = at position)
    aiCombatUnits.filter(u =>
      u.type === 'missile_launcher' && u.deployState === 'mobile' && !u.targetX
    ).forEach(launcher => {
      launcher.deployState = 'deploying_stage1';
      launcher.deployStateEndsAt = now + MISSILE_LAUNCHER_DEPLOY_STAGE_MS;
    });

    // --- AI LURE TACTIC: Send a frigate toward enemy, draw them into launcher/aegis kill zone ---
    if (!player.lureCooldownUntil) player.lureCooldownUntil = 0;
    const deployedLaunchers = aiCombatUnits.filter(u => u.type === 'missile_launcher' && u.deployState === 'deployed');
    const hasAegisBs = aiCombatUnits.some(u => u.type === 'battleship' && u.battleshipAegisMode);
    if (
      now > player.lureCooldownUntil &&
      deployedLaunchers.length >= 2 &&
      hasAegisBs &&
      player.knownEnemyPositions &&
      player.knownEnemyPositions.length > 0
    ) {
      const lureUnit = aiCombatUnits.find(u => u.type === 'frigate' && !u.attackTargetId && !u.isLuring);
      if (lureUnit) {
        const enemyPos = player.knownEnemyPositions[Math.floor(Math.random() * player.knownEnemyPositions.length)];
        const dx = enemyPos.x - player.baseX;
        const dy = enemyPos.y - player.baseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const midX = player.baseX + (dx / dist) * Math.min(dist * 0.4, 1500);
        const midY = player.baseY + (dy / dist) * Math.min(dist * 0.4, 1500);
        assignMoveTarget(lureUnit, midX, midY);
        lureUnit.isLuring = true;
        lureUnit.lureReturnAt = now + 15000;
        player.lureCooldownUntil = now + 45000;
      }
    }
    // Recall luring frigates after lure window
    aiCombatUnits.filter(u => u.isLuring && now >= (u.lureReturnAt || 0)).forEach(u => {
      assignMoveTarget(u, player.baseX, player.baseY);
      u.isLuring = false;
    });

    // --- AI MINE LAYING: Lay mines on enemy approach path to AI base ---
    if (!player.mineLayCooldownUntil) player.mineLayCooldownUntil = 0;
    if (now > player.mineLayCooldownUntil && player.knownEnemyPositions && player.knownEnemyPositions.length > 0) {
      const mineDestroyers = aiCombatUnits.filter(u => u.type === 'destroyer');
      if (mineDestroyers.length > 0) {
        const destroyer = mineDestroyers[0];
        let activeMines = 0;
        gameState.units.forEach(u => {
          if (u.type === 'mine' && u.userId === playerId && u.hp > 0) activeMines++;
        });
        if (activeMines < DESTROYER_MAX_MINES) {
          const enemyPos = player.knownEnemyPositions[0];
          const dx = enemyPos.x - player.baseX;
          const dy = enemyPos.y - player.baseY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0) {
            const approachX = player.baseX + (dx / dist) * Math.min(dist * 0.3, 1000);
            const approachY = player.baseY + (dy / dist) * Math.min(dist * 0.3, 1000);
            if (!isOnLand(approachX, approachY)) {
              const mineId = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 700;
              const mineDef = getUnitDefinition('mine');
              const mine = {
                id: mineId,
                userId: playerId,
                type: 'mine',
                x: approachX + (Math.random() - 0.5) * 200,
                y: approachY + (Math.random() - 0.5) * 200,
                hp: mineDef.hp,
                maxHp: mineDef.hp,
                damage: mineDef.damage,
                speed: 0,
                size: mineDef.size,
                attackRange: mineDef.attackRange,
                attackCooldownMs: mineDef.attackCooldownMs,
                visionRadius: 0,
                targetX: null,
                targetY: null,
                isDetected: false,
                sourceDestroyerId: destroyer.id,
                kills: 0
              };
              gameState.units.set(mine.id, mine);
              emitUnitCreatedEvent(mine);
              player.mineLayCooldownUntil = now + 30000;
            }
          }
        }
      }
    }

    // Always update targetCombatPower dynamically
    if (!player.targetCombatPower || currentCombatPower >= player.targetCombatPower) {
      const macroReserve = (powerPlantCount * 28)
        + (navalAcademyCount * 70)
        + (defenseCount * 20)
        + (carbaseCount * 30)
        + (missileSiloCount * 24);
      player.targetCombatPower = Math.max(220, currentCombatPower + 160 + Math.floor(Math.random() * 220) + Math.floor(macroReserve * 0.2));
    }
    
    // --- AI SLBM ---
    const aiSubs = aiCombatUnits.filter(u => u.type === 'submarine');
    const desiredStoredMissiles = Math.max(3, (aiSubs.length * 2) + (knownEnemyCount > 0 ? 1 : 0));
    if (hasMissileSilo && player.resources >= 1500 && (!player.missiles || player.missiles < desiredStoredMissiles)) {
      const silo = gameState.buildings.get(missileSiloId);
      if (silo) {
        if (!silo.missileQueue) silo.missileQueue = [];
        if (silo.missileQueue.length < 10) {
          player.resources -= 1500;
          silo.missileQueue.push({
            type: 'missile',
            buildTime: 67500,
            userId: playerId,
            socketId: null
          });
          if (!silo.missileProducing) {
            const next = silo.missileQueue[0];
            silo.missileProducing = {
              type: next.type,
              startTime: now,
              buildTime: next.buildTime,
              userId: next.userId,
              socketId: next.socketId
            };
          }
        }
      }
    }
    
    // AI keeps submarines loaded and fires aggressively into dense or fortified enemy clusters.
    tryLoadAiSubmarineSlbms();
    tryFireAiSlbm();
    
    // --- AI CARRIER: Produce and deploy aircraft ---
    const aiCarriers = aiCombatUnits.filter(u => u.type === 'carrier');
    aiCarriers.forEach(carrier => {
      if (!carrier.aircraft) carrier.aircraft = [];
      if (!carrier.aircraftDeployed) carrier.aircraftDeployed = [];
      const totalAc = carrier.aircraft.length + carrier.aircraftDeployed.length;
      if (totalAc < 10 && player.resources >= 100) {
        player.resources -= 100;
        carrier.aircraft.push({ hp: getUnitDefinition('aircraft').hp });
      }
    });
    
    // --- AI SKILLS: Use all available skills (gated by difficulty) ---
    if (!diffPreset.useSkills) { /* skip skills for easy difficulty */ }
    else {
    const aiBattleships = aiCombatUnits.filter(u => u.type === 'battleship');
    aiBattleships.forEach((bs, idx) => {
      initializeUnitRuntimeState(bs);
      // Aimed shot when off cooldown and has a target
      if (!bs.aimedShot && (!bs.aimedShotCooldownUntil || now >= bs.aimedShotCooldownUntil)) {
        if (bs.attackTargetId && !bs.battleshipAegisMode) {
          bs.aimedShot = true;
        }
      }
      // Combat stance: activate on battleships that are actively attacking
      if (!bs.combatStanceActive && bs.attackTargetId && bs.hp > bs.maxHp * 0.4) {
        bs.combatStanceActive = true;
        refreshBattleshipModeState(bs);
      }
      // Aegis mode: put some battleships in aegis mode for area-denial defense
      // First battleship used as defender (aegis), rest as attackers (combat stance)
      if (idx === 0 && !bs.battleshipAegisMode && aiCombatUnits.length >= 4) {
        bs.battleshipAegisMode = true;
        bs.aimedShot = false;
        bs.combatStanceActive = false;
        bs.battleshipAegisTurretTargetLocks = Array.from({ length: BATTLESHIP_AEGIS_TURRET_COUNT }, () => null);
        refreshBattleshipModeState(bs);
      }
    });
    
    // AI Cruisers: use aegis mode for defense
    const aiCruisers = aiCombatUnits.filter(u => u.type === 'cruiser');
    aiCruisers.forEach((cr, idx) => {
      if (idx === 0 && !cr.aegisMode && aiCombatUnits.length >= 5) {
        cr.aegisMode = true;
      }
    });

    // AI Frigates: engine overdrive when in combat and HP > 40%
    const aiFrigates = aiCombatUnits.filter(u => u.type === 'frigate');
    aiFrigates.forEach(fg => {
      if (fg.attackTargetId && !fg.engineOverdriveActive && fg.hp > (fg.maxHp || 100) * 0.4) {
        fg.engineOverdriveActive = true;
        fg.engineOverdriveStartedAt = now;
      }
    });

    // AI Destroyers: use search skill when enemies are nearby
    const aiDestroyers = aiCombatUnits.filter(u => u.type === 'destroyer');
    aiDestroyers.forEach(dd => {
      if (!dd.searchCooldownUntil || now >= dd.searchCooldownUntil) {
        if (player.knownEnemyPositions && player.knownEnemyPositions.length > 0) {
          dd.searchActiveUntil = now + SEARCH_REVEAL_DURATION_MS;
          dd.searchCooldownUntil = now + 16000;
        }
      }
    });

    // AI Submarines: activate stealth before approaching enemy
    aiSubs.forEach(sub => {
      if (!sub.stealthActive && (!sub.stealthCooldownUntil || now >= sub.stealthCooldownUntil)) {
        if (player.knownEnemyPositions && player.knownEnemyPositions.length > 0) {
          sub.stealthActive = true;
          sub.isDetected = false;
          sub.stealthExpiresAt = now + SUBMARINE_STEALTH_DURATION_MS;
        }
      }
    });

    // AI Carriers: launch airstrike when 10 aircraft ready and enemy known
    aiCarriers.forEach(carrier => {
      if (!carrier.aircraft) carrier.aircraft = [];
      if (!carrier.aircraftDeployed) carrier.aircraftDeployed = [];
      if (carrier.aircraft.length >= 10 && player.knownEnemyPositions && player.knownEnemyPositions.length > 0
          && (!carrier.airstrikeCooldownUntil || now >= carrier.airstrikeCooldownUntil)) {
        const target = player.knownEnemyPositions[0];
        carrier.aircraft = []; // Consume all aircraft
        carrier.airstrikeCooldownUntil = now + 20000;
        // Create airstrike effect at target
        const strikeId = Date.now() * 1000 + Math.floor(Math.random() * 999) + 500;
        const strike = {
          id: strikeId, carrierId: carrier.id, userId: playerId,
          targetX: target.x, targetY: target.y,
          startTime: now, passCount: AIRSTRIKE_PASS_COUNT,
          passInterval: 667, damagePerPass: 240,
          radius: AIRSTRIKE_DAMAGE_RADIUS, currentPass: 0,
          nextPassAt: now + 1000
        };
        if (!gameState.activeAirstrikes) gameState.activeAirstrikes = new Map();
        gameState.activeAirstrikes.set(strikeId, strike);
        roomEmit('airstrikeLaunched', { id: strikeId, carrierId: carrier.id, userId: playerId, targetX: target.x, targetY: target.y });
      }
    });
    } // end useSkills gate
    
    // --- SCOUTING: Send workers to scout all islands ---
    if (!player.scoutedIslands) player.scoutedIslands = new Set();
    if (!player.knownEnemyPositions) player.knownEnemyPositions = [];
    if (!player.lastScoutTime) player.lastScoutTime = 0;
    
    if (now - player.lastScoutTime > AI_CONFIG.scoutInterval) {
      player.lastScoutTime = now;
      
      // Get all island centers by analyzing landCells clusters
      const islandCenters = getIslandCenters();
      
      // Send idle workers to unscouted islands
      const unscoutedIslands = islandCenters.filter((_, idx) => !player.scoutedIslands.has(idx));
      
      if (unscoutedIslands.length > 0 && aiWorkers.length > 1) {
        // Find an idle worker (not building, not gathering)
        const scoutWorker = aiWorkers.find(w => !w.buildingType && !w.gatheringResourceId && !w.targetX);
        if (scoutWorker) {
          const targetIsland = unscoutedIslands[Math.floor(Math.random() * unscoutedIslands.length)];
          assignMoveTarget(scoutWorker, targetIsland.x, targetIsland.y);
          // Mark as scouted
          const idx = islandCenters.indexOf(targetIsland);
          if (idx >= 0) player.scoutedIslands.add(idx);
        }
      }
      
      // Also send idle combat units to scout
      const scoutCombat = aiCombatUnits.find(u => !u.targetX && !u.attackTargetId);
      if (scoutCombat && unscoutedIslands.length > 0) {
        const targetIsland = unscoutedIslands[Math.floor(Math.random() * unscoutedIslands.length)];
        assignMoveTarget(scoutCombat, targetIsland.x, targetIsland.y);
        const idx = islandCenters.indexOf(targetIsland);
        if (idx >= 0) player.scoutedIslands.add(idx);
      }
      
      // Discover enemies: check if any AI unit sees enemy units/buildings
      gameState.players.forEach((otherPlayer, otherId) => {
        if (otherId === playerId) return;
        
        // Check enemy buildings
        gameState.buildings.forEach(building => {
          if (building.userId === otherId) {
            aiUnits.forEach(unit => {
              const dx = building.x - unit.x;
              const dy = building.y - unit.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 1200) {
                // Found enemy! Record position
                const existing = player.knownEnemyPositions.find(p => {
                  const edx = p.x - building.x;
                  const edy = p.y - building.y;
                  return Math.sqrt(edx * edx + edy * edy) < 500;
                });
                if (!existing) {
                  let localStrength = 0;
                  gameState.units.forEach(eu => {
                    if (eu.userId === otherId) {
                      const ddx = eu.x - building.x; const ddy = eu.y - building.y;
                      if (ddx * ddx + ddy * ddy < 800 * 800) localStrength++;
                    }
                  });
                  player.knownEnemyPositions.push({ x: building.x, y: building.y, playerId: otherId, discoveredAt: now, lastSeenStrength: localStrength });
                  console.log(`AI ${player.username} discovered enemy ${otherPlayer.username || otherId} at (${building.x.toFixed(0)}, ${building.y.toFixed(0)})`);
                }
                // Also update knownEnemyBases for SLBM targeting
                if (!player.knownEnemyBases) player.knownEnemyBases = [];
                if (!player.knownEnemyBases.includes(otherId)) {
                  player.knownEnemyBases.push(otherId);
                }
              }
            });
          }
        });
        
        // Check enemy units
        gameState.units.forEach(enemyUnit => {
          if (enemyUnit.userId === otherId) {
            aiUnits.forEach(unit => {
              const dx = enemyUnit.x - unit.x;
              const dy = enemyUnit.y - unit.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 1000) {
                const existing = player.knownEnemyPositions.find(p => {
                  const edx = p.x - enemyUnit.x;
                  const edy = p.y - enemyUnit.y;
                  return Math.sqrt(edx * edx + edy * edy) < 500;
                });
                if (!existing) {
                  player.knownEnemyPositions.push({ x: enemyUnit.x, y: enemyUnit.y, playerId: otherId, discoveredAt: now });
                }
              }
            });
          }
        });
      });
      
      // Clean up old enemy positions (older than 120 seconds)
      player.knownEnemyPositions = player.knownEnemyPositions.filter(p => now - p.discoveredAt < 120000);
    }
    
    // --- COUNTERATTACK DETECTION: Check if AI units were attacked by 3+ enemies ---
    if (!player.recentAttackLocations) player.recentAttackLocations = [];
    if (!player.priorityTargets) player.priorityTargets = [];

    player.priorityTargets = player.priorityTargets
      .filter(target =>
        target &&
        Number.isFinite(target.x) &&
        Number.isFinite(target.y) &&
        (now - (target.discoveredAt || now)) < AI_CONFIG.priorityTargetDuration
      )
      .sort((a, b) => (a.priority || 0) - (b.priority || 0))
      .slice(0, AI_CONFIG.maxPriorityTargets)
      .map((target, index) => ({
        ...target,
        discoveredAt: Number.isFinite(target.discoveredAt) ? target.discoveredAt : now,
        priority: index
      }));
    
    // Clean up old attack locations
    player.recentAttackLocations = player.recentAttackLocations.filter(
      loc => now - loc.timestamp < AI_CONFIG.attackerTrackingDuration
    );
    
    // Also clean up recentAttackers on AI units
    aiUnits.forEach(unit => {
      if (unit.recentAttackers) {
        unit.recentAttackers = unit.recentAttackers.filter(
          att => now - att.timestamp < AI_CONFIG.attackerTrackingDuration
        );
      }
    });
    
    // Count unique attackers across all AI units
    const recentAttackerSet = new Set();
    let attackCenterX = 0, attackCenterY = 0, attackCount = 0;
    
    aiUnits.forEach(unit => {
      if (unit.recentAttackers && unit.recentAttackers.length > 0) {
        unit.recentAttackers.forEach(att => {
          if (!recentAttackerSet.has(att.attackerId)) {
            recentAttackerSet.add(att.attackerId);
            attackCenterX += att.attackX;
            attackCenterY += att.attackY;
            attackCount++;
          }
        });
      }
    });
    
    // Trigger counterattack response if 3+ unique attackers detected
    if (recentAttackerSet.size >= AI_CONFIG.counterattackThreshold && !player.isCounterattacking) {
      attackCenterX /= attackCount;
      attackCenterY /= attackCount;
      
      console.log(`AI ${player.username} detected ${recentAttackerSet.size} attackers at (${attackCenterX.toFixed(0)}, ${attackCenterY.toFixed(0)}) - initiating counterattack!`);
      
      // Find the closest island from the attack location
      const islandCenters = getIslandCenters();
      let closestIsland = null;
      let closestIslandDist = Infinity;
      let closestIslandIdx = -1;
      
      islandCenters.forEach((island, idx) => {
        const dx = island.x - attackCenterX;
        const dy = island.y - attackCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestIslandDist) {
          closestIslandDist = dist;
          closestIsland = island;
          closestIslandIdx = idx;
        }
      });
      
      if (closestIsland) {
        // Check if there's enemy presence on this island
        let hasEnemyPresence = false;
        let enemyOnIsland = null;
        
        // Check for enemy buildings near this island
        gameState.buildings.forEach(building => {
          if (building.userId !== playerId && !gameState.players.get(building.userId)?.isAI || 
              (gameState.players.get(building.userId)?.isAI && building.userId !== playerId)) {
            const dx = building.x - closestIsland.x;
            const dy = building.y - closestIsland.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1500) {
              hasEnemyPresence = true;
              enemyOnIsland = { x: building.x, y: building.y, playerId: building.userId };
            }
          }
        });
        
        // Check for enemy units near this island
        if (!hasEnemyPresence) {
          gameState.units.forEach(unit => {
            if (unit.userId !== playerId) {
              const dx = unit.x - closestIsland.x;
              const dy = unit.y - closestIsland.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 1500) {
                hasEnemyPresence = true;
                enemyOnIsland = { x: unit.x, y: unit.y, playerId: unit.userId };
              }
            }
          });
        }
        
        if (hasEnemyPresence) {
          // Found enemy on closest island - add to priority targets
          const existingTarget = player.priorityTargets.find(t => {
            const dx = t.x - enemyOnIsland.x;
            const dy = t.y - enemyOnIsland.y;
            return Math.sqrt(dx * dx + dy * dy) < 500;
          });
          
          if (!existingTarget) {
            player.priorityTargets.push({
              x: enemyOnIsland.x,
              y: enemyOnIsland.y,
              playerId: enemyOnIsland.playerId,
              discoveredAt: now,
              priority: player.priorityTargets.length // First discovered = highest priority
            });
            console.log(`AI ${player.username} added priority target at (${enemyOnIsland.x.toFixed(0)}, ${enemyOnIsland.y.toFixed(0)})`);
          }
          
          player.isCounterattacking = true;
          player.counterattackTarget = { x: enemyOnIsland.x, y: enemyOnIsland.y, playerId: enemyOnIsland.playerId };
        } else {
          // No enemy on closest island - search next closest islands
          console.log(`AI ${player.username} found no enemies on closest island, searching nearby...`);
          
          // Sort islands by distance and find one with enemy presence
          const sortedIslands = islandCenters
            .map((island, idx) => {
              const dx = island.x - attackCenterX;
              const dy = island.y - attackCenterY;
              return { ...island, idx, dist: Math.sqrt(dx * dx + dy * dy) };
            })
            .sort((a, b) => a.dist - b.dist);
          
          for (const island of sortedIslands) {
            if (island.idx === closestIslandIdx) continue; // Skip already checked
            
            let foundEnemy = null;
            
            // Check buildings
            gameState.buildings.forEach(building => {
              if (building.userId !== playerId) {
                const dx = building.x - island.x;
                const dy = building.y - island.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 1500 && !foundEnemy) {
                  foundEnemy = { x: building.x, y: building.y, playerId: building.userId };
                }
              }
            });
            
            // Check units
            if (!foundEnemy) {
              gameState.units.forEach(unit => {
                if (unit.userId !== playerId) {
                  const dx = unit.x - island.x;
                  const dy = unit.y - island.y;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  if (dist < 1500 && !foundEnemy) {
                    foundEnemy = { x: unit.x, y: unit.y, playerId: unit.userId };
                  }
                }
              });
            }
            
            if (foundEnemy) {
              // Found enemy on this island
              const existingTarget = player.priorityTargets.find(t => {
                const dx = t.x - foundEnemy.x;
                const dy = t.y - foundEnemy.y;
                return Math.sqrt(dx * dx + dy * dy) < 500;
              });
              
              if (!existingTarget) {
                player.priorityTargets.push({
                  x: foundEnemy.x,
                  y: foundEnemy.y,
                  playerId: foundEnemy.playerId,
                  discoveredAt: now,
                  priority: player.priorityTargets.length
                });
                console.log(`AI ${player.username} added priority target at (${foundEnemy.x.toFixed(0)}, ${foundEnemy.y.toFixed(0)}) (re-search)`);
              }
              
              player.isCounterattacking = true;
              player.counterattackTarget = { x: foundEnemy.x, y: foundEnemy.y, playerId: foundEnemy.playerId };
              break;
            }
          }
        }
      }
    }
    
    // --- PRIORITY TARGET ATTACK: Continue raiding priority targets ---
    // Check if current counterattack target is eliminated
    if (player.isCounterattacking && player.counterattackTarget) {
      const targetPlayerId = player.counterattackTarget.playerId;
      const targetX = player.counterattackTarget.x;
      const targetY = player.counterattackTarget.y;
      
      // Check if target area still has enemy presence
      let targetStillExists = false;
      
      gameState.buildings.forEach(building => {
        if (building.userId === targetPlayerId) {
          const dx = building.x - targetX;
          const dy = building.y - targetY;
          if (Math.sqrt(dx * dx + dy * dy) < 1500) {
            targetStillExists = true;
          }
        }
      });
      
      if (!targetStillExists) {
        gameState.units.forEach(unit => {
          if (unit.userId === targetPlayerId) {
            const dx = unit.x - targetX;
            const dy = unit.y - targetY;
            if (Math.sqrt(dx * dx + dy * dy) < 1500) {
              targetStillExists = true;
            }
          }
        });
      }
      
      if (!targetStillExists) {
        console.log(`AI ${player.username} eliminated target at (${targetX.toFixed(0)}, ${targetY.toFixed(0)})`);
        
        // Remove from priority targets
        player.priorityTargets = player.priorityTargets.filter(t => {
          const dx = t.x - targetX;
          const dy = t.y - targetY;
          return Math.sqrt(dx * dx + dy * dy) >= 500;
        });
        
        // Move to next priority target if available
        if (player.priorityTargets.length > 0) {
          // Sort by priority (lowest = highest priority)
          player.priorityTargets.sort((a, b) => a.priority - b.priority);
          const nextTarget = player.priorityTargets[0];
          player.counterattackTarget = { x: nextTarget.x, y: nextTarget.y, playerId: nextTarget.playerId };
          console.log(`AI ${player.username} moving to next priority target at (${nextTarget.x.toFixed(0)}, ${nextTarget.y.toFixed(0)})`);
        } else {
          player.isCounterattacking = false;
          player.counterattackTarget = null;
          console.log(`AI ${player.username} counterattack completed - all priority targets eliminated`);
        }
      }
    }
    
    // --- Discovery during combat: Add newly found buildings to priority targets ---
    aiUnits.forEach(unit => {
      gameState.buildings.forEach(building => {
        if (building.userId !== playerId && building.userId > 0) { // Enemy player building (not AI)
          const dx = building.x - unit.x;
          const dy = building.y - unit.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist < 1200) {
            // Check if already in priority targets
            const existing = player.priorityTargets.find(t => {
              const edx = t.x - building.x;
              const edy = t.y - building.y;
              return Math.sqrt(edx * edx + edy * edy) < 500;
            });
            
            if (!existing) {
              player.priorityTargets.push({
                x: building.x,
                y: building.y,
                playerId: building.userId,
                discoveredAt: now,
                priority: player.priorityTargets.length
              });
              console.log(`AI ${player.username} discovered enemy building at (${building.x.toFixed(0)}, ${building.y.toFixed(0)}) - added to priority targets`);
              
              // If not already counterattacking, start
              if (!player.isCounterattacking) {
                player.isCounterattacking = true;
                player.counterattackTarget = { x: building.x, y: building.y, playerId: building.userId };
              }
            }
          }
        }
      });
    });
    
    // --- ATTACK: Send army when we have enough combat power ---
    // Priority targets take precedence over regular attacks
    if (!player.lastAttackTime) player.lastAttackTime = 0;
    
    const plannedAttackTarget = !player.isCounterattacking
      ? selectBestKnownEnemyTarget(player, { purpose: 'attack', mode: 'balanced', now })
      : null;
    const fortifiedTargetRatio = plannedAttackTarget
      ? (1.08
        + (plannedAttackTarget.defenseTowers > 0 ? 0.08 : 0)
        + (plannedAttackTarget.launcherCount > 0 ? 0.1 : 0)
        + (plannedAttackTarget.capitalShips > 0 ? 0.05 : 0))
      : 1.0;
    const canAttack = currentCombatPower >= Math.max(
      player.targetCombatPower * 0.82,
      defenseCount <= 0 ? 360 : 300,
      plannedAttackTarget ? (plannedAttackTarget.resistance * fortifiedTargetRatio) : 0
    );
    const hasPriorityTargets = player.priorityTargets && player.priorityTargets.length > 0;
    const hasTargets = (player.knownEnemyPositions && player.knownEnemyPositions.length > 0) || hasPriorityTargets;
    const attackCooldown = now - player.lastAttackTime > 10000;
    const counterattackCooldown = now - player.lastAttackTime > 2000; // near-instant counterattack
    
    // Counterattack with priority targets (immediate, less strict requirements)
    if (player.isCounterattacking && player.counterattackTarget && counterattackCooldown && aiCombatUnits.length >= 1) {
      player.lastAttackTime = now;
      const target = player.counterattackTarget;
      const counterattackContext = getKnownEnemyClusterContext(target) || {
        target,
        resistance: Math.max(220, currentCombatPower * 0.85),
        value: 180
      };
      if (!isWorthwhileAIAttack(currentCombatPower, counterattackContext, { counterattack: true })) {
        aiCombatUnits.forEach(unit => {
          if (!unit.attackTargetId) {
            assignMoveTarget(unit, player.baseX + (Math.random() - 0.5) * 260, player.baseY + (Math.random() - 0.5) * 260);
          }
        });
        player.isCounterattacking = false;
        player.counterattackTarget = null;
      } else {
      
      console.log(`AI ${player.username} counterattacking at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}) with ${aiCombatUnits.length} units (COUNTERATTACK)`);
      
      // Send ALL combat units to counterattack position
      aiCombatUnits.forEach(unit => {
        assignMoveTarget(unit, target.x, target.y);
        unit.attackMove = true;
        
        // Find nearest enemy entity at target area to focus fire
        let nearestTarget = null;
        let nearestDist = Infinity;
        
        gameState.buildings.forEach(building => {
          if (building.userId === target.playerId) {
            const dx = building.x - target.x;
            const dy = building.y - target.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 2000 && dist < nearestDist) {
              nearestDist = dist;
              nearestTarget = { id: building.id, type: 'building' };
            }
          }
        });
        
        if (!nearestTarget) {
          gameState.units.forEach(enemyUnit => {
            if (enemyUnit.userId === target.playerId) {
              const dx = enemyUnit.x - target.x;
              const dy = enemyUnit.y - target.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 2000 && dist < nearestDist) {
                nearestDist = dist;
                nearestTarget = { id: enemyUnit.id, type: 'unit' };
              }
            }
          });
        }
        
        if (nearestTarget) {
          unit.attackTargetId = nearestTarget.id;
          unit.attackTargetType = nearestTarget.type;
        }
      });
      }
    } else if (canAttack && hasTargets && attackCooldown && aiCombatUnits.length >= 1 && !player.isCounterattacking) {
      // Normal attack behavior (when not counterattacking)
      const targetContext = plannedAttackTarget || selectBestKnownEnemyTarget(player, { purpose: 'attack', mode: 'balanced', now });
      const target = targetContext?.target;
      if (!target) {
        player.lastAttackTime = 0;
      } else {
        player.lastAttackTime = now;
      
        console.log(`AI ${player.username} attacking at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}) with ${aiCombatUnits.length} units (power: ${currentCombatPower})`);
      
        // Send ALL idle combat units to the attack position
        aiCombatUnits.forEach(unit => {
          // Send to attack position with attack-move
          assignMoveTarget(unit, target.x, target.y);
          unit.attackMove = true;
        
          // Find nearest enemy entity at target area to focus fire
          let nearestTarget = null;
          let nearestDist = Infinity;
        
          gameState.buildings.forEach(building => {
            if (building.userId === target.playerId) {
              const dx = building.x - target.x;
              const dy = building.y - target.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 2000 && dist < nearestDist) {
                nearestDist = dist;
                nearestTarget = { id: building.id, type: 'building' };
              }
            }
          });
        
          if (!nearestTarget) {
            gameState.units.forEach(enemyUnit => {
              if (enemyUnit.userId === target.playerId) {
                const dx = enemyUnit.x - target.x;
                const dy = enemyUnit.y - target.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 2000 && dist < nearestDist) {
                  nearestDist = dist;
                  nearestTarget = { id: enemyUnit.id, type: 'unit' };
                }
              }
            });
          }
        
          if (nearestTarget) {
            unit.attackTargetId = nearestTarget.id;
            unit.attackTargetType = nearestTarget.type;
          }
        });
      }
    }
    
    // --- BASE EXPANSION: when 8+ buildings on main island OR no space left, expand ---
    // Track build failures to detect space shortage
    if (!player.buildFailCount) player.buildFailCount = 0;
    if (!player.lastBuildFailReset) player.lastBuildFailReset = now;
    // Reset fail count every 30 seconds
    if (now - player.lastBuildFailReset > 30000) {
      player.buildFailCount = 0;
      player.lastBuildFailReset = now;
    }

    const shouldExpand = (aiBuildings.length >= AI_CONFIG.expansionBuildingThreshold || player.buildFailCount >= 3) && !player.isExpanding;
    if (shouldExpand) {
      const islandCenters = getIslandCenters();
      
      // Find closest island that we don't have buildings on
      const ownBuildingPositions = aiBuildings.map(b => ({ x: b.x, y: b.y }));
      
      // Track islands to avoid (previously attacked during expansion)
      if (!player.avoidIslands) player.avoidIslands = new Map(); // islandIdx -> avoidUntil timestamp
      
      let bestIsland = null;
      let bestDist = Infinity;
      let bestIslandIdx = -1;
      
      islandCenters.forEach((island, idx) => {
        // Skip islands we're avoiding (attacked there recently)
        if (player.avoidIslands.has(idx) && now < player.avoidIslands.get(idx)) return;
        
        // Check if we already have buildings on this island (within 1500 units)
        const hasBuilding = ownBuildingPositions.some(bp => {
          const dx = bp.x - island.x;
          const dy = bp.y - island.y;
          return Math.sqrt(dx * dx + dy * dy) < 1500;
        });
        
        if (!hasBuilding) {
          const dx = player.baseX - island.x;
          const dy = player.baseY - island.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestIsland = island;
            bestIslandIdx = idx;
          }
        }
      });
      
      if (bestIsland) {
        player.isExpanding = true;
        player.expansionTarget = { x: bestIsland.x, y: bestIsland.y, islandIdx: bestIslandIdx };
        player.expansionBuilt = [];
        player.expansionEscortSent = false;
        player.expansionWorkerIds = [];
        player.buildFailCount = 0;
        console.log(`AI ${player.username} expanding to island at (${bestIsland.x.toFixed(0)}, ${bestIsland.y.toFixed(0)})`);
      }
    }
    
    // Process expansion: send workers + escort to build on the new island
    if (player.isExpanding && player.expansionTarget) {
      const expansionBuildings = ['power_plant', 'shipyard', 'naval_academy', 'missile_silo', 'defense_tower'];
      if (!player.expansionBuilt) player.expansionBuilt = [];
      
      // --- Send escort with expansion (once) ---
      if (!player.expansionEscortSent && aiCombatUnits.length >= 2) {
        const escortCount = Math.min(Math.ceil(aiCombatUnits.length * 0.3), 5);
        const idleUnits = aiCombatUnits.filter(u => !u.attackTargetId);
        const escorts = idleUnits.slice(0, escortCount);
        escorts.forEach(u => {
          assignMoveTarget(u, player.expansionTarget.x, player.expansionTarget.y);
          u.attackMove = true;
          u._isExpansionEscort = true;
        });
        player.expansionEscortSent = true;
        if (escorts.length > 0) {
          console.log(`AI ${player.username} sending ${escorts.length} escorts to expansion island`);
        }
      }
      
      // --- Check if expansion workers are under attack → reroute ---
      if (player.expansionWorkerIds && player.expansionWorkerIds.length > 0) {
        let workerUnderAttack = false;
        for (const wid of player.expansionWorkerIds) {
          let found = false;
          gameState.units.forEach(u => {
            if (u.id === wid && u.userId === playerId) {
              found = true;
              // Check if any enemy unit is within 400 of this worker
              gameState.units.forEach(eu => {
                if (eu.userId !== playerId && eu.type !== 'worker') {
                  const dx = eu.x - u.x;
                  const dy = eu.y - u.y;
                  if (dx * dx + dy * dy < 400 * 400) {
                    workerUnderAttack = true;
                  }
                }
              });
              // Also check enemy buildings (defense towers)
              gameState.buildings.forEach(eb => {
                if (eb.userId !== playerId && eb.type === 'defense_tower' && eb.buildProgress >= 100) {
                  const dx = eb.x - u.x;
                  const dy = eb.y - u.y;
                  if (dx * dx + dy * dy < 600 * 600) {
                    workerUnderAttack = true;
                  }
                }
              });
            }
          });
          if (!found) workerUnderAttack = true; // Worker died
        }
        
        if (workerUnderAttack) {
          console.log(`AI ${player.username} expansion worker under attack! Rerouting...`);
          // Save target before clearing
          const threatArea = { x: player.expansionTarget.x, y: player.expansionTarget.y };
          // Mark this island as avoid for 120 seconds
          if (!player.avoidIslands) player.avoidIslands = new Map();
          if (player.expansionTarget.islandIdx !== undefined) {
            player.avoidIslands.set(player.expansionTarget.islandIdx, now + 120000);
          }
          // Cancel current expansion
          player.isExpanding = false;
          player.expansionTarget = null;
          player.expansionBuilt = [];
          player.expansionWorkerIds = [];
          player.expansionEscortSent = false;
          // Send nearby combat units to attack the threat area
          const nearbyUnits = aiCombatUnits.filter(u => {
            const dx = u.x - threatArea.x;
            const dy = u.y - threatArea.y;
            return dx * dx + dy * dy < 2000 * 2000;
          });
          nearbyUnits.forEach(u => {
            assignMoveTarget(u, threatArea.x, threatArea.y);
            u.attackMove = true;
          });
          // Will retry expansion next tick (picks different island due to avoidIslands)
        }
      }
      
      // --- Build next expansion building ---
      if (player.isExpanding) {
        const nextBuild = expansionBuildings.find(bt => !player.expansionBuilt.includes(bt));
      
        if (nextBuild) {
          // Find an idle worker
          const expandWorker = aiWorkers.find(w => !w.buildingType && !w.targetX);
          if (expandWorker) {
            const costs = { power_plant: 150, shipyard: 200, naval_academy: 300, missile_silo: MISSILE_SILO_COST, defense_tower: 250 };
            const cost = costs[nextBuild] || 200;
          
            if (player.resources >= cost) {
              let pos = null;
              for (let attempt = 0; attempt < 8; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const distance = 100 + Math.random() * 200;
                const bx = player.expansionTarget.x + Math.cos(angle) * distance;
                const by = player.expansionTarget.y + Math.sin(angle) * distance;
                pos = findNearestValidBuildingPosition(nextBuild, bx, by, { maxSearchRadius: 600 });
                if (pos) break;
              }
            
              if (pos) {
                expandWorker.buildingType = nextBuild;
                expandWorker.buildTargetX = pos.x;
                expandWorker.buildTargetY = pos.y;
                expandWorker.targetX = pos.x;
                expandWorker.targetY = pos.y;
                expandWorker.gatheringResourceId = null;
                player.expansionBuilt.push(nextBuild);
                // Track this worker for attack detection
                if (!player.expansionWorkerIds) player.expansionWorkerIds = [];
                player.expansionWorkerIds.push(expandWorker.id);
              }
            }
          }
        } else {
          // All expansion buildings queued
          player.isExpanding = false;
          player.expansionTarget = null;
          player.expansionWorkerIds = [];
          player.expansionEscortSent = false;
          console.log(`AI ${player.username} expansion complete`);
        }
      }
    }
    
    // Combat is processed in the global updateGame() loop for all players (including AI).
  });
  if (PERF_DEBUG_ENABLED) {
    perfRecord('tick.updateAI', perfNowMs() - perfStart);
  }
}

function createBenchmarkPlayer(userId, username, baseX, baseY, isAI = false) {
  const player = {
    userId,
    username,
    resources: 50000,
    population: 0,
    maxPopulation: PLAYER_MAX_POPULATION_CAP,
    combatPower: 0,
    score: 0,
    scoreFromKills: 0,
    baseX,
    baseY,
    hasBase: true,
    researchedSLBM: false,
    missiles: 0,
    battleshipModeComboUnlocked: false,
    online: true,
    isAI,
    lastScoutTime: 0,
    lastAttackTime: 0,
    scoutTargets: [],
    knownEnemyBases: [],
    knownEnemyPositions: [],
    recentAttackLocations: [],
    priorityTargets: [],
    isCounterattacking: false,
    counterattackTarget: null,
    targetCombatPower: 60
  };
  gameState.players.set(userId, player);
  if (ENABLE_SERVER_FOG_SNAPSHOTS) {
    gameState.fogOfWar.set(userId, new Map());
  }
  return player;
}

function createBenchmarkBuilding(userId, type, x, y, buildProgress = 100) {
  const hpByType = {
    headquarters: 1500,
    shipyard: 800,
    power_plant: 600,
    defense_tower: 700,
    naval_academy: 700,
    carbase: 800,
    missile_silo: 1000
  };
  const building = {
    id: createUniqueEntityId(900),
    userId,
    type,
    x,
    y,
    hp: hpByType[type] || 700,
    maxHp: hpByType[type] || 700,
    buildProgress,
    slbmCount: 0,
    productionQueue: []
  };
  gameState.buildings.set(building.id, building);
  return building;
}

function findBenchmarkLandPosition(x, y) {
  const clamped = clampToMapBounds(x, y);
  return findNearestLandPosition(clamped.x, clamped.y) || clamped;
}

function findBenchmarkWaterPosition(unitType, x, y) {
  const clamped = clampToMapBounds(x, y);
  const radii = [220, 420, 700, 1100, 1600];
  for (let i = 0; i < radii.length; i++) {
    const pos = findNearestNavalPassableWaterPosition(unitType, clamped.x, clamped.y, radii[i]);
    if (pos) return pos;
  }
  return clamped;
}

function createBenchmarkCombatUnit(userId, unitType, x, y) {
  const unitDef = getUnitDefinition(unitType);
  const unit = {
    id: createUniqueEntityId(950),
    userId,
    type: unitType,
    x,
    y,
    hp: unitDef.hp,
    maxHp: unitDef.hp,
    damage: unitDef.damage,
    speed: unitDef.speed,
    attackRange: unitDef.attackRange,
    attackCooldownMs: unitDef.attackCooldownMs,
    targetX: null,
    targetY: null,
    gatheringResourceId: null,
    buildingType: null,
    buildTargetX: null,
    buildTargetY: null,
    isDetected: unitType !== 'submarine' && unitType !== 'mine',
    kills: 0
  };
  if (unitType === 'missile_launcher') {
    unit.deployState = 'deployed';
    unit.deployStateEndsAt = null;
    unit.speed = 0;
    unit.attackRange = MISSILE_LAUNCHER_DEPLOYED_RANGE;
  }
  initializeUnitRuntimeState(unit);
  gameState.units.set(unit.id, unit);
  const owner = gameState.players.get(userId);
  if (owner) {
    owner.population += getUnitPopulationCost(unit);
  }
  return unit;
}

function seedBenchmarkRoom(unitsPerPlayer = 50) {
  switchRoom('server1');
  clearCurrentRoomTransientState();
  gameState.aiRespawnTimers.forEach(timer => clearTimeout(timer));
  gameState.aiRespawnTimers.clear();
  gameState.units.clear();
  gameState.buildings.clear();
  gameState.players.clear();
  gameState.fogOfWar.clear();
  gameState.squads.clear();
  if (gameState.pathCache) {
    gameState.pathCache.clear();
  }
  gameState.activeRedZones = [];
  gameState.lastUpdate = Date.now();

  const map = gameState.map;
  const corners = [
    { land: findBenchmarkLandPosition(420, 420), water: findBenchmarkWaterPosition('destroyer', 760, 760) },
    { land: findBenchmarkLandPosition(map.width - 420, 420), water: findBenchmarkWaterPosition('destroyer', map.width - 760, 760) },
    { land: findBenchmarkLandPosition(420, map.height - 420), water: findBenchmarkWaterPosition('destroyer', 760, map.height - 760) },
    { land: findBenchmarkLandPosition(map.width - 420, map.height - 420), water: findBenchmarkWaterPosition('destroyer', map.width - 760, map.height - 760) }
  ];
  const players = [
    createBenchmarkPlayer(1, 'Bench_Human', corners[0].land.x, corners[0].land.y, false),
    createBenchmarkPlayer(-1000, 'Bench_AI_1', corners[1].land.x, corners[1].land.y, true),
    createBenchmarkPlayer(-1001, 'Bench_AI_2', corners[2].land.x, corners[2].land.y, true),
    createBenchmarkPlayer(-1002, 'Bench_AI_3', corners[3].land.x, corners[3].land.y, true)
  ];

  players.forEach((player, index) => {
    const land = corners[index].land;
    createBenchmarkBuilding(player.userId, 'headquarters', land.x, land.y, 100);
    createBenchmarkBuilding(player.userId, 'power_plant', land.x + 120, land.y + 80, 100);
    createBenchmarkBuilding(player.userId, 'shipyard', land.x + 180, land.y + 140, 100);
    createBenchmarkBuilding(player.userId, 'naval_academy', land.x + 240, land.y + 200, 100);
    createBenchmarkBuilding(player.userId, 'defense_tower', land.x - 120, land.y - 80, 100);
    const workers = spawnStartingWorkers(player.userId, land.x, land.y, STARTING_WORKER_COUNT);
    player.population += workers.length;
  });

  const center = { x: map.width / 2, y: map.height / 2 };
  const unitPattern = ['destroyer', 'frigate', 'cruiser', 'destroyer', 'submarine', 'battleship'];
  players.forEach((player, index) => {
    const waterBase = corners[index].water;
    const target = center;
    for (let i = 0; i < unitsPerPlayer; i++) {
      const unitType = unitPattern[i % unitPattern.length];
      const col = i % 10;
      const row = Math.floor(i / 10);
      const offsetX = (col - 4.5) * 90;
      const offsetY = (row - Math.floor(unitsPerPlayer / 20)) * 140;
      const spawnPos = findBenchmarkWaterPosition(unitType, waterBase.x + offsetX, waterBase.y + offsetY);
      const unit = createBenchmarkCombatUnit(player.userId, unitType, spawnPos.x, spawnPos.y);
      unit.attackMove = true;
      assignMoveTarget(unit, target.x + ((index % 2 === 0) ? 260 : -260), target.y + (index < 2 ? 160 : -160));
    }
  });

  players.forEach(player => {
    if (!player.isAI) return;
    player.knownEnemyPositions = [{
      x: players[0].baseX,
      y: players[0].baseY,
      playerId: players[0].userId,
      discoveredAt: Date.now(),
      lastSeenStrength: 500
    }];
  });

  recalculateAllPlayerCombatPowerAndScores();
}

function runPerformanceBenchmark() {
  const unitsPerPlayer = Math.max(10, Number(process.env.MW_BENCH_UNITS_PER_PLAYER || 50));
  const warmupTicks = Math.max(0, Number(process.env.MW_BENCH_WARMUP_TICKS || 20));
  const benchmarkTicks = Math.max(10, Number(process.env.MW_BENCH_TICKS || 90));
  const aiTickStride = Math.max(1, Math.round((AI_CONFIG.updateInterval || 1000) / (1000 / GAME_TICK_RATE)));

  seedBenchmarkRoom(unitsPerPlayer);
  console.log(`[PERF] Benchmark room seeded: players=${gameState.players.size} units=${gameState.units.size} buildings=${gameState.buildings.size}`);

  const deltaTime = 1 / GAME_TICK_RATE;
  for (let tick = 0; tick < warmupTicks; tick++) {
    updateGame(deltaTime);
    if (tick % aiTickStride === 0) {
      updateAI();
    }
  }

  perfMetrics.clear();
  perfWindowStartedAt = Date.now();
  perfLastFlushAt = Date.now();

  const startMs = perfNowMs();
  for (let tick = 0; tick < benchmarkTicks; tick++) {
    updateGame(deltaTime);
    if (tick % aiTickStride === 0) {
      updateAI();
    }
  }
  const elapsedMs = perfNowMs() - startMs;

  console.log(`[PERF] Benchmark complete: ticks=${benchmarkTicks} elapsed=${elapsedMs.toFixed(2)}ms avgTick=${(elapsedMs / benchmarkTicks).toFixed(2)}ms`);
  perfRecord('benchmark.total', elapsedMs);
  perfFlush('benchmark', true);
  process.exit(0);
}

function emitRedZoneSync() {
  roomEmit('redZoneSync', {
    redZones: buildClientRedZonePayload()
  });
}

function getWorldCellCenter(gridX, gridY, cellSize = (gameState && gameState.map ? (gameState.map.cellSize || 50) : 50)) {
  return {
    x: gridX * cellSize + (cellSize / 2),
    y: gridY * cellSize + (cellSize / 2)
  };
}

function islandContainsWorldPoint(island, x, y) {
  if (!gameState || !gameState.map || !island || !island.cellKeys) return false;
  const cellSize = gameState.map.cellSize || 50;
  const gridSize = gameState.map.gridSize || 0;
  const gridX = Math.floor(x / cellSize);
  const gridY = Math.floor(y / cellSize);
  if (gridX < 0 || gridY < 0 || gridX >= gridSize || gridY >= gridSize) return false;
  return island.cellKeys.has((gridY * gridSize) + gridX);
}

function buildIslandBurstPoints(island) {
  if (!gameState || !gameState.map || !island || !Array.isArray(island.landCells) || island.landCells.length === 0) {
    return [{ x: island?.x || 0, y: island?.y || 0, delayMs: 0 }];
  }

  const cellSize = gameState.map.cellSize || 50;
  const sourceCells = island.landCells;
  const sampleStep = sourceCells.length > 1600 ? Math.ceil(sourceCells.length / 1600) : 1;
  const candidates = [];
  for (let i = 0; i < sourceCells.length; i += sampleStep) {
    const [gx, gy] = sourceCells[i];
    candidates.push(getWorldCellCenter(gx, gy, cellSize));
  }
  if (candidates.length === 0) {
    candidates.push({ x: island.x, y: island.y });
  }

  const desiredCount = Math.max(
    RED_ZONE_MIN_BURSTS,
    Math.min(RED_ZONE_MAX_BURSTS, Math.round(island.size / 100))
  );

  let centerIndex = 0;
  let centerDistSq = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const dx = candidates[i].x - island.x;
    const dy = candidates[i].y - island.y;
    const distSq = (dx * dx) + (dy * dy);
    if (distSq < centerDistSq) {
      centerDistSq = distSq;
      centerIndex = i;
    }
  }

  const selected = [candidates.splice(centerIndex, 1)[0]];
  while (selected.length < desiredCount && candidates.length > 0) {
    let bestIndex = 0;
    let bestScore = -1;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      let nearestSelectedSq = Infinity;
      for (let j = 0; j < selected.length; j++) {
        const dx = candidate.x - selected[j].x;
        const dy = candidate.y - selected[j].y;
        const distSq = (dx * dx) + (dy * dy);
        if (distSq < nearestSelectedSq) {
          nearestSelectedSq = distSq;
        }
      }
      if (nearestSelectedSq > bestScore) {
        bestScore = nearestSelectedSq;
        bestIndex = i;
      }
    }
    selected.push(candidates.splice(bestIndex, 1)[0]);
  }

  return selected.map((point, index) => ({
    x: point.x,
    y: point.y,
    delayMs: index * RED_ZONE_BURST_DELAY_STEP_MS
  }));
}

function getHumanUsersOnRedZoneIslands(zones) {
  const affected = new Map();
  if (!Array.isArray(zones) || zones.length === 0) return affected;

  zones.forEach(zone => {
    const zoneUsers = new Set();
    gameState.buildings.forEach(building => {
      if (zoneUsers.has(building.userId)) return;
      const owner = gameState.players.get(building.userId);
      if (!owner || owner.isAI || owner.isObserver || owner.online === false) return;
      if (!islandContainsWorldPoint(zone, building.x, building.y)) return;
      zoneUsers.add(building.userId);
    });
    gameState.units.forEach(unit => {
      if (zoneUsers.has(unit.userId)) return;
      const owner = gameState.players.get(unit.userId);
      if (!owner || owner.isAI || owner.isObserver || owner.online === false) return;
      if (!islandContainsWorldPoint(zone, unit.x, unit.y)) return;
      zoneUsers.add(unit.userId);
    });
    zoneUsers.forEach(userId => {
      affected.set(userId, (affected.get(userId) || 0) + 1);
    });
  });

  return affected;
}

function buildRedZoneAlertMessage(zoneCount, secondsLeft) {
  const zoneText = zoneCount > 1
    ? `회색 표시된 ${zoneCount}개 섬이`
    : '회색 표시된 섬이';
  return `레드존 경보: ${zoneText} ${secondsLeft}초 후 폭격`;
}

function emitRedZoneActivationAlert() {
  roomEmit('systemKillLog', {
    message: '레드존 활성화까지 30초 남았습니다',
    variant: 'red-zone'
  });
}

function emitRedZoneCountdownAlerts(affectedUsers, secondsLeft) {
  affectedUsers.forEach((zoneCount, userId) => {
    roomEmit('redZoneAlert', {
      targetUserId: userId,
      zoneCount,
      secondsLeft,
      message: buildRedZoneAlertMessage(zoneCount, secondsLeft)
    });
  });
}

function createRedZoneEntry(island, now) {
  return {
    id: `rz-${gameState.nextRedZoneId++}`,
    islandId: island.id,
    centerX: island.x,
    centerY: island.y,
    landCells: island.landCells,
    cellKeys: island.cellKeys,
    burstPoints: island.burstPoints || buildIslandBurstPoints(island),
    blastRadius: RED_ZONE_BLAST_RADIUS,
    selectedAt: now,
    bombardmentAt: now + RED_ZONE_WARNING_DURATION_MS,
    detonatedAt: null,
    endsAt: now + RED_ZONE_WARNING_DURATION_MS + RED_ZONE_POST_BLAST_VISUAL_MS
  };
}

function getNearestIslandForPoint(islands, x, y, maxDistSq = 2500 * 2500) {
  let bestDist = Infinity;
  let bestIsland = null;
  islands.forEach(island => {
    const dx = x - island.x;
    const dy = y - island.y;
    const distSq = (dx * dx) + (dy * dy);
    if (distSq < bestDist) {
      bestDist = distSq;
      bestIsland = island;
    }
  });
  if (!bestIsland || bestDist > maxDistSq) return null;
  return bestIsland;
}

function buildRedZoneIslandOccupantMap(islands) {
  const islandOccupants = new Map();
  gameState.buildings.forEach(building => {
    const owner = gameState.players.get(building.userId);
    if (!owner || owner.online === false || owner.isObserver) return;
    const island = getNearestIslandForPoint(islands, building.x, building.y);
    if (!island) return;
    if (!islandOccupants.has(island.id)) islandOccupants.set(island.id, new Set());
    islandOccupants.get(island.id).add(building.userId);
  });
  return islandOccupants;
}

function selectBalancedOccupiedRedZoneIslands(occupiedCandidates, islandOccupants, desiredCount) {
  const pool = occupiedCandidates.slice();
  const selected = [];
  const ownerCounts = new Map();

  while (selected.length < desiredCount && pool.length > 0) {
    let bestLoad = Infinity;
    const scored = pool.map(island => {
      const owners = [...(islandOccupants.get(island.id) || [])];
      const load = owners.reduce((minLoad, userId) => (
        Math.min(minLoad, ownerCounts.get(userId) || 0)
      ), Infinity);
      if (load < bestLoad) bestLoad = load;
      return { island, owners, load };
    });

    const eligible = scored.filter(entry => entry.load === bestLoad);
    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    const candidateOwners = picked.owners.filter(userId => (ownerCounts.get(userId) || 0) === picked.load);
    const assignedOwner = candidateOwners[Math.floor(Math.random() * candidateOwners.length)];
    ownerCounts.set(assignedOwner, (ownerCounts.get(assignedOwner) || 0) + 1);
    selected.push(picked.island);
    pool.splice(pool.indexOf(picked.island), 1);
  }

  return selected;
}

function rollNewRedZones(now) {
  const islands = getIslandCenters();
  // Dynamic interval: more entities alive → faster red zone cycles (min 60s, default 600s)
  const totalEntities = gameState.buildings.size + gameState.units.size;
  const dynamicInterval = Math.max(60000, RED_ZONE_SELECTION_INTERVAL_MS - Math.floor(totalEntities / 10) * 30000);
  gameState.nextRedZoneRollAt = now + dynamicInterval;
  gameState.lastRedZoneCountdownSecond = null;

  if (!Array.isArray(islands) || islands.length === 0) {
    gameState.activeRedZones = [];
    emitRedZoneSync();
    return;
  }

  const shuffled = islands.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[swapIndex];
    shuffled[swapIndex] = temp;
  }

  const islandOccupants = buildRedZoneIslandOccupantMap(islands);
  const occupiedIslands = shuffled.filter(island => (islandOccupants.get(island.id)?.size || 0) > 0);
  const unoccupiedIslands = shuffled.filter(island => (islandOccupants.get(island.id)?.size || 0) <= 0);

  const maxSelectionCount = Math.min(RED_ZONE_ISLAND_COUNT, islands.length);
  const maxOccupiedCount = Math.min(RED_ZONE_MAX_OCCUPIED_ISLANDS, maxSelectionCount, occupiedIslands.length);
  const desiredOccupiedCount = maxOccupiedCount > 0
    ? (1 + Math.floor(Math.random() * maxOccupiedCount))
    : 0;
  const selected = [];
  const selectedIds = new Set();

  if (desiredOccupiedCount > 0) {
    const occupiedPool = occupiedIslands.filter(island => !selectedIds.has(island.id));
    const balancedOccupied = selectBalancedOccupiedRedZoneIslands(occupiedPool, islandOccupants, desiredOccupiedCount);
    balancedOccupied.forEach(island => {
      selected.push(island);
      selectedIds.add(island.id);
    });
  }

  const fillPool = [...unoccupiedIslands, ...occupiedIslands.filter(island => !selectedIds.has(island.id))];
  for (let i = 0; i < fillPool.length && selected.length < maxSelectionCount; i++) {
    selected.push(fillPool[i]);
    selectedIds.add(fillPool[i].id);
  }

  gameState.activeRedZones = selected.map(island => createRedZoneEntry(island, now));
  emitRedZoneSync();
  emitRedZoneActivationAlert();
}

function isEntityHitByRedZone(zone, x, y, targetRadius = 0) {
  if (islandContainsWorldPoint(zone, x, y)) return true;
  const burstPoints = Array.isArray(zone.burstPoints) ? zone.burstPoints : [];
  for (let i = 0; i < burstPoints.length; i++) {
    const burst = burstPoints[i];
    if (targetIntersectsDamageCircle(burst.x, burst.y, zone.blastRadius, x, y, targetRadius)) {
      return true;
    }
  }
  return false;
}

function applyRedZoneBombardment(zone, now) {
  const destroyedUnits = [];
  const destroyedBuildings = [];
  const ownersToCheck = new Set();

  gameState.units.forEach(target => {
    const targetRadius = getUnitAreaHitRadius(target);
    if (!isEntityHitByRedZone(zone, target.x, target.y, targetRadius)) return;
    applyDamageToEntity(target, getAdjustedUnitDamage(target, RED_ZONE_BLAST_DAMAGE), now);
    if (target.hp <= 0) {
      destroyedUnits.push(target);
    }
  });

  destroyedUnits.forEach(target => {
    if (target.type === 'mine') {
      emitUnitDestroyedEvent(target);
      gameState.units.delete(target.id);
      return;
    }
    destroyUnitFromGame(target);
  });

  gameState.buildings.forEach(target => {
    const targetRadius = getBuildingCollisionSize(target.type) / 2;
    if (!isEntityHitByRedZone(zone, target.x, target.y, targetRadius)) return;
    applyDamageToEntity(target, RED_ZONE_BLAST_DAMAGE, now);
    if (target.hp <= 0) {
      destroyedBuildings.push(target);
    }
  });

  destroyedBuildings.forEach(target => {
    destroyBuildingFromGame(target);
    ownersToCheck.add(target.userId);
  });

  ownersToCheck.forEach(userId => checkPlayerDefeat(userId, null, '레드존', 'red_zone'));

  roomEmit('redZoneDetonation', {
    id: zone.id,
    islandId: zone.islandId,
    centerX: zone.centerX,
    centerY: zone.centerY,
    blastRadius: zone.blastRadius,
    burstPoints: zone.burstPoints || []
  });

  zone.detonatedAt = now;
  zone.endsAt = Math.max(zone.endsAt, now + RED_ZONE_POST_BLAST_VISUAL_MS);
}

function updateRedZones(now) {
  if (!Array.isArray(gameState.activeRedZones)) {
    gameState.activeRedZones = [];
  }
  if (!Number.isFinite(gameState.nextRedZoneRollAt)) {
    gameState.nextRedZoneRollAt = now + RED_ZONE_SELECTION_INTERVAL_MS;
  }

  if (now >= gameState.nextRedZoneRollAt) {
    rollNewRedZones(now);
  }

  const pendingZones = gameState.activeRedZones.filter(zone => !zone.detonatedAt);
  if (pendingZones.length === 0) {
    gameState.lastRedZoneCountdownSecond = null;
  } else {
    const msUntilBombardment = Math.min(...pendingZones.map(zone => zone.bombardmentAt - now));
    if (msUntilBombardment > 0 && msUntilBombardment <= RED_ZONE_COUNTDOWN_START_MS) {
      const secondsLeft = Math.max(1, Math.ceil(msUntilBombardment / 1000));
      if (secondsLeft !== gameState.lastRedZoneCountdownSecond) {
        emitRedZoneCountdownAlerts(getHumanUsersOnRedZoneIslands(pendingZones), secondsLeft);
        gameState.lastRedZoneCountdownSecond = secondsLeft;
      }
    }
  }

  let syncNeeded = false;
  pendingZones.forEach(zone => {
    if (now < zone.bombardmentAt) return;
    applyRedZoneBombardment(zone, now);
    syncNeeded = true;
  });

  const activeZonesBeforeCleanup = gameState.activeRedZones.length;
  gameState.activeRedZones = gameState.activeRedZones.filter(zone => now < zone.endsAt);
  if (gameState.activeRedZones.length !== activeZonesBeforeCleanup) {
    syncNeeded = true;
  }

  if (syncNeeded) {
    emitRedZoneSync();
  }
}

// Get island centers by clustering land cells
function getIslandCenters() {
  if (!gameState || !gameState.map || !gameState.map.landCells) return [];
  
  // Cache island centers per room
  if (gameState._islandCenters) return gameState._islandCenters;
  
  const map = gameState.map;
  const cellSize = map.cellSize;
  const gridSize = map.gridSize;
  const visited = new Set();
  const islands = [];
  
  // BFS to find connected components (islands)
  for (const [gx, gy] of map.landCells) {
    const key = gy * gridSize + gx;
    if (visited.has(key)) continue;
    
    const islandCells = [];
    const islandKeys = new Set();
    const queue = [[gx, gy]];
    visited.add(key);
    
    while (queue.length > 0) {
      const [cx, cy] = queue.shift();
      const cellKey = cy * gridSize + cx;
      islandCells.push([cx, cy]);
      islandKeys.add(cellKey);
      
      // Check 4-connected neighbors
      const neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
      for (const [nx, ny] of neighbors) {
        if (nx >= 0 && nx < gridSize && ny >= 0 && ny < gridSize) {
          const nkey = ny * gridSize + nx;
          if (!visited.has(nkey) && map.landCellSet.has(nkey)) {
            visited.add(nkey);
            queue.push([nx, ny]);
          }
        }
      }
    }
    
    if (islandCells.length > 10) {
      let sumX = 0;
      let sumY = 0;
      islandCells.forEach(([ix, iy]) => {
        sumX += ix * cellSize + cellSize / 2;
        sumY += iy * cellSize + cellSize / 2;
      });
      const island = {
        id: islands.length,
        x: sumX / islandCells.length,
        y: sumY / islandCells.length,
        size: islandCells.length,
        landCells: islandCells,
        cellKeys: islandKeys
      };
      island.burstPoints = buildIslandBurstPoints(island);
      islands.push(island);
    }
  }
  
  gameState._islandCenters = islands;
  return islands;
}

if (!BENCHMARK_MODE) {
  // Run AI update loop - only for rooms with connected humans
  setInterval(() => {
    gameRooms.forEach((room, roomId) => {
      if (!roomHasHumanPlayers(roomId)) return;
      switchRoom(roomId);
      updateAI();
      syncSlbmId();
    });
  }, AI_CONFIG.updateInterval);
}

// ==================== END AI PLAYER SYSTEM ====================

if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET is not set. Using insecure fallback secret.');
}

const PORT = process.env.PORT || 3000;
if (BENCHMARK_MODE) {
  runPerformanceBenchmark();
} else {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`${APP_NAME} server running on port ${PORT}`);
    void preloadTrainingSessions();
  });
}
