console.log('[MW Craft] game.js v20260309f loaded');
// Game state
let socket = null;
let rankingInterval = null;
let slbmTargetingMode = false;
let mineTargetingMode = false;
let airstrikeTargetingMode = false;
let reconTargetingMode = false;
let attackMode = false;
let assaultShipLoadMode = null; // 'ship-target' or 'cargo-target'
let slbmMissiles = []; // Active SLBM missiles for visualization

function updateActionModeIndicator() {
    const indicator = document.getElementById('modeIndicator');
    if (!indicator) return;
    if (attackMode) {
        indicator.textContent = '공격 모드 (좌클릭으로 목표 지정)';
        indicator.style.color = '#ff4444';
        indicator.style.display = 'inline';
        canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'32\'%3E%3Ccircle cx=\'16\' cy=\'16\' r=\'14\' fill=\'none\' stroke=\'red\' stroke-width=\'2\'/%3E%3Cline x1=\'16\' y1=\'4\' x2=\'16\' y2=\'28\' stroke=\'red\' stroke-width=\'2\'/%3E%3Cline x1=\'4\' y1=\'16\' x2=\'28\' y2=\'16\' stroke=\'red\' stroke-width=\'2\'/%3E%3C/svg%3E") 16 16, crosshair';
        return;
    }
    if (assaultShipLoadMode === 'ship-target') {
        indicator.textContent = '탑승 모드 (강습상륙함 클릭)';
        indicator.style.color = '#ffb347';
        indicator.style.display = 'inline';
        canvas.style.cursor = 'pointer';
        return;
    }
    if (assaultShipLoadMode === 'cargo-target') {
        indicator.textContent = '탑승 모드 (유닛 클릭)';
        indicator.style.color = '#ffb347';
        indicator.style.display = 'inline';
        canvas.style.cursor = 'pointer';
        return;
    }
    indicator.style.display = 'none';
    canvas.style.cursor = 'crosshair';
}

function setAttackMode(on) {
    attackMode = on;
    if (on) {
        assaultShipLoadMode = null;
    }
    updateActionModeIndicator();
}

function setAssaultShipLoadMode(mode) {
    assaultShipLoadMode = mode;
    if (mode) {
        attackMode = false;
    }
    updateActionModeIndicator();
}
let attackProjectiles = []; // Active naval attack projectiles for world rendering
let slbmContrails = []; // SLBM vapor trails
let explosionEffects = []; // Ship death explosion/debris effects
let yamatoExhaustParticles = []; // Exhaust smoke for Yamato battleships while moving
const yamatoExhaustState = new Map();
let animationFrameId = null;
let fogIntervalId = null;
let minimapIntervalId = null;
let viewportIntervalId = null;
let fogDirty = true;
let minimapDirty = true;
let interpolationDurationMs = 100;
let lastServerUpdateTime = 0;
let serverTickAvgMs = 100;
let lastMinimapInvalidateTime = 0;
let lastMinimapRenderAt = 0;
let lastViewportEmitAt = 0;
let lastViewportSignature = '';
let isPointerInCanvas = false;
let attackTarget = null; // { id, type, name, x, y } - currently designated attack target for HUD display
let commandGroup = new Set(); // Units that have been given commands and should NOT be deselected by panel clicks
const APP_NAME = 'MW Craft';
const CAMERA_EDGE_PAN_SPEED = 3800;
const FOG_UPDATE_INTERVAL = 650;
const FOG_VISIBLE_WINDOW_MS = 1000;
const FOG_BASE_FILL_STYLE = 'rgba(0,0,0,0.5)';
const MINIMAP_UPDATE_INTERVAL = 500;
const VIEWPORT_UPDATE_INTERVAL_MS = 120;
const VIEWPORT_UPDATE_HEARTBEAT_MS = 1000;
const HIGH_CLIENT_LOAD_SCORE = 220;
const EXTREME_CLIENT_LOAD_SCORE = 380;
const SECRET_CLICK_STREAK_RESET_MS = 900;
const SECRET_RANKING_CLICK_TARGET = 10;
const SECRET_MINIMAP_CLICK_TARGET = 22;
const SECRET_LOGIN_PANEL_CLICK_TARGET = 22;
const SECRET_WORKER_PORTRAIT_CLICK_TARGET = 29;
const SECRET_WORKER_PORTRAIT_CLICK_RESET_MS = 2500;
const SECRET_BATTLESHIP_PORTRAIT_CLICK_TARGET = 22;
const SECRET_BATTLESHIP_PORTRAIT_CLICK_RESET_MS = 1500;
const TEMPORARY_FULL_MAP_REVEAL_MS = 30000;
const fogCircleOffsetsCache = new Map();
const CLIENT_LOAD_SETTINGS = {
    normal: {
        minimapMinIntervalMs: MINIMAP_UPDATE_INTERVAL,
        maxVisionCircles: Number.POSITIVE_INFINITY,
        drawVisibleLandMask: true,
        detailedMinimapMissiles: true,
        projectileTrailSegments: 8,
        detailedProjectiles: true,
        detailedExplosions: true,
        contrailStride: 1
    },
    high: {
        minimapMinIntervalMs: 700,
        maxVisionCircles: 120,
        drawVisibleLandMask: false,
        detailedMinimapMissiles: false,
        projectileTrailSegments: 5,
        detailedProjectiles: false,
        detailedExplosions: true,
        contrailStride: 2
    },
    extreme: {
        minimapMinIntervalMs: 1000,
        maxVisionCircles: 64,
        drawVisibleLandMask: false,
        detailedMinimapMissiles: false,
        projectileTrailSegments: 3,
        detailedProjectiles: false,
        detailedExplosions: false,
        contrailStride: 3
    }
};
const rankingPanelSecretClicks = { count: 0, lastAt: 0 };
const minimapSecretClicks = { count: 0, lastAt: 0 };
const loginPanelSecretClicks = { count: 0, lastAt: 0 };
const workerPortraitSecretClicks = { count: 0, lastAt: 0 };
const battleshipPortraitSecretClicks = { count: 0, lastAt: 0 };
let fullMapRevealUntil = 0;
let fullMapRevealTimeoutId = null;
let lastSeenRedZoneActivationAt = 0;
let roomAnnihilationLogoutTimeoutId = null;

// --- Fog Offscreen Canvas ---
// fogLayerCanvas is a gridSize횞gridSize pixel canvas drawn once per fog update
// and composited into the scene with a single drawImage, eliminating the
// per-frame viewport loop + template-string GC pressure.
let fogLayerCanvas = null;
let fogLayerCtx   = null;
let fogLayerGridSize = 0;

// Reusable array for own-units iteration inside updateFogOfWar (avoids new [] each tick).
const _ownUnitsTemp = [];

const DEFAULT_MAP_IMAGE_PATH = '/assets/maps/world-map_upscaled.png';
let mapImage = null;
let mapImagePath = null;
let mapImageLoaded = false;
let mapImageLoadFailed = false;
let landMaskCanvas = null;
let landMaskCacheKey = null;
const IMAGE_LAND_MASK_ALPHA = 0.18;
const MINIMAP_VISIBLE_LAND_COLOR = 'rgba(46, 158, 63, 0.9)';

// Battleship images
let battleshipBaseImage = null;
let battleshipBaseLoaded = false;
let battleshipAegisBaseImage = null;
let battleshipAegisBaseLoaded = false;
let ymtBattleshipBaseImage = null;
let ymtBattleshipBaseLoaded = false;
let mainCannonImage = null;
let mainCannonLoaded = false;
let ymtMainCannonImage = null;
let ymtMainCannonLoaded = false;

// Submarine image
let submarineImage = null;
let submarineImageLoaded = false;

// Cruiser image
let cruiserImage = null;
let cruiserImageLoaded = false;

// Carrier image
let carrierImage = null;
let carrierImageLoaded = false;

// Assault ship image
let assaultShipImage = null;
let assaultShipImageLoaded = false;

// Frigate image
let frigateImage = null;
let frigateImageLoaded = false;

// Fighter image
let fighterImage = null;
let fighterImageLoaded = false;

// Recon aircraft image
let reconAircraftImage = null;
let reconAircraftImageLoaded = false;

// Missile launcher images
let thaadImage = null;
let thaadImageLoaded = false;
let thaadStage1Image = null;
let thaadStage1ImageLoaded = false;
let thaadStage2Image = null;
let thaadStage2ImageLoaded = false;

// Cruiser Aegis image
let cruiserAegisImage = null;
let cruiserAegisImageLoaded = false;

// Destroyer image
let destroyerImage = null;
let destroyerImageLoaded = false;

// Airstrike image
let airstrikeImage = null;
let airstrikeImageLoaded = false;

// Building images - HQ
let hqImage = null;
let hqImageLoaded = false;

// Building images - Power Plant (bjs, bjs1, bjs2)
let bjsImages = [null, null, null]; // [bjs, bjs1, bjs2]
let bjsImagesLoaded = [false, false, false];

// Building images - Shipyard (jss, jss1, jss2, jss3)
let jssImages = [null, null, null, null];
let jssImagesLoaded = [false, false, false, false];

// Building images - Naval Academy (djss ~ djss9)
let djssImages = Array(10).fill(null);
let djssImagesLoaded = Array(10).fill(false);

// Building images - Defense Tower / Missile Silo
let defenseTowerBaseImage = null;
let defenseTowerBaseLoaded = false;
let defenseTowerCannonImage = null;
let defenseTowerCannonLoaded = false;
let missileSiloImage = null;
let missileSiloLoaded = false;
let carbaseBuildingImage = null;
let carbaseBuildingImageLoaded = false;

// Building animation state
let buildingAnimationTimers = {}; // buildingId -> animation state

// Power plant animation: bjs2(4s) -> bjs1(3s) -> bjs(3s), cycle = 10s
const POWER_PLANT_CYCLE_MS = 10000;
const COASTAL_BUILDING_SIZE_SCALE = 0.6;
const POWER_PLANT_SIZE_SCALE = COASTAL_BUILDING_SIZE_SCALE * 0.7;
const FIXED_BUILDING_IMAGE_MAX_DIMENSION = 200;
const DEFENSE_TOWER_CANNON_START = Object.freeze({ x: 14, y: 8 });
const DEFENSE_TOWER_CANNON_MUZZLE = Object.freeze({ x: 14, y: 17 });
// turretcannon.png(17x9) 이미지에서의 회전 중심 좌표
const DEFENSE_TOWER_CANNON_PIVOT = Object.freeze({ x: 8, y: -2 });
const DEFENSE_TOWER_CANNON_BASE_ANGLE = Math.PI / 2; // 6시 방향이 기본 총구 방향
const AIRSTRIKE_TARGET_RADIUS = 400;
const RECON_AIRCRAFT_COST = 150;
const RECON_AIRCRAFT_BUILD_TIME_MS = 18000;
const RECON_AIRCRAFT_MAX_PER_CARRIER = 3;
const RECON_AIRCRAFT_VISION_RADIUS = 2600;
const CARBASE_BUILD_COST = 350;
const BATTLESHIP_COST = 2400;
const MISSILE_LAUNCHER_COST = 2200;
const MISSILE_LAUNCHER_BUILD_TIME_MS = 18000;
const MISSILE_LAUNCHER_DEPLOY_STAGE_MS = 1000;
const MISSILE_LAUNCHER_RANGE = 2500;
const MISSILE_LAUNCHER_SELECTION_SIZE = 36;
const MISSILE_LAUNCHER_HEIGHT_MULTIPLIER = 3.2;
const MISSILE_LAUNCHER_MOBILE_HEIGHT_MULTIPLIER = 4.0;
const ASSAULT_SHIP_COST = 500;
const ASSAULT_SHIP_MAX_LAUNCHERS = 10;
const ASSAULT_SHIP_LOAD_RADIUS = 260;
const ASSAULT_SHIP_LAND_RADIUS = 260;
const CARBASE_PREREQ_BUILDINGS = Object.freeze([
    'headquarters',
    'shipyard',
    'power_plant',
    'defense_tower',
    'naval_academy',
    'missile_silo'
]);
const RED_ZONE_MINIMAP_PENDING_COLOR = 'rgba(124, 124, 124, 0.68)';
const RED_ZONE_MINIMAP_AFTERSHOCK_COLOR = 'rgba(96, 96, 96, 0.48)';
const RED_ZONE_MINIMAP_BUILDING_WARNING_COLOR = '#8c8c8c';
const RED_ZONE_MINIMAP_BUILDING_BLINK_MS = 500;
const DESTROYER_VISION_RADIUS = 1000;
const DESTROYER_SEARCH_VISION_RADIUS = 4800;
const DESTROYER_MAX_MINES = 5;
const SLBM_OWNER_VISION_RADIUS = 1200;
const BATTLESHIP_COMBAT_STANCE_ATTACK_SPEED_MULTIPLIER = 1.10;
const BATTLESHIP_AEGIS_RANGE_MULTIPLIER = 1.5;
const FRIGATE_ENGINE_OVERDRIVE_MAX_EVASION = 0.80;
const UNIT_SELECTION_PRIORITY = Object.freeze({
    battleship: 900,
    submarine: 800,
    carrier: 700,
    assaultship: 600,
    cruiser: 500,
    destroyer: 400,
    frigate: 300,
    missile_launcher: 200,
    worker: 200,
    recon_aircraft: 100,
    aircraft: 90,
    mine: 80
});
const WORKER_FILL_COLOR = 0x8f99a3;
const WORKER_OUTLINE_COLOR = 0xe4e8eb;
const QUEUE_HIGHLIGHT_BG = 'rgba(143,153,163,0.28)';
const QUEUE_HIGHLIGHT_BORDER = '#b8c0c7';
const WORKER_BUILD_CATEGORIES = Object.freeze({
    general: Object.freeze({
        label: '일반 건축물',
        items: Object.freeze([
            { type: 'headquarters', name: '본부 건물', cost: 800, desc: '일꾼 생산' },
            { type: 'power_plant', name: '발전소', cost: 150, desc: '인구+3' },
            { type: 'shipyard', name: '조선소', cost: 200, desc: '인구+5' }
        ])
    }),
    advanced: Object.freeze({
        label: '고급 건축물',
        items: Object.freeze([
            { type: 'defense_tower', name: '방어 타워', cost: 250, desc: '' },
            { type: 'naval_academy', name: '대형조선소', cost: 300, desc: '인구+10' },
            { type: 'missile_silo', name: '미사일 사일로', cost: 1600, desc: '' },
            { type: 'carbase', name: '차량기지', cost: CARBASE_BUILD_COST, desc: '모든 건물 2개 이상 필요' }
        ])
    })
});

// Building display size (derived from image scaling, same ratio as ships)
let buildingDisplaySize = { width: 200, height: 200 }; // updated on image load
let buildingSizeInitialized = false;

// Load battleship images
function loadBattleshipImages() {
    if (!battleshipBaseImage) {
        battleshipBaseImage = new Image();
        battleshipBaseImage.onload = () => {
            battleshipBaseLoaded = true;
            console.log('Battleship base image loaded');
        };
        battleshipBaseImage.onerror = () => {
            console.warn('Failed to load battleshipbase.png');
        };
        battleshipBaseImage.src = '/assets/images/units/battleshipbase.png';
    }

    if (!ymtBattleshipBaseImage) {
        ymtBattleshipBaseImage = new Image();
        ymtBattleshipBaseImage.onload = () => {
            ymtBattleshipBaseLoaded = true;
            console.log('Yamato battleship base image loaded');
        };
        ymtBattleshipBaseImage.onerror = () => {
            console.warn('Failed to load ymtbattleshipbase.png');
        };
        ymtBattleshipBaseImage.src = '/assets/images/units/ymtbattleshipbase.png';
    }

    if (!battleshipAegisBaseImage) {
        battleshipAegisBaseImage = new Image();
        battleshipAegisBaseImage.onload = () => {
            battleshipAegisBaseLoaded = true;
            console.log('Battleship aegis base image loaded');
        };
        battleshipAegisBaseImage.onerror = () => {
            console.warn('Failed to load battleshipaegisbase.png');
        };
        battleshipAegisBaseImage.src = '/assets/images/units/battleshipaegisbase.png';
    }
    
    if (!mainCannonImage) {
        mainCannonImage = new Image();
        mainCannonImage.onload = () => {
            mainCannonLoaded = true;
            console.log('Main cannon image loaded');
        };
        mainCannonImage.onerror = () => {
            console.warn('Failed to load maincannon.png');
        };
        mainCannonImage.src = '/assets/images/units/maincannon.png';
    }

    if (!ymtMainCannonImage) {
        ymtMainCannonImage = new Image();
        ymtMainCannonImage.onload = () => {
            ymtMainCannonLoaded = true;
            console.log('Yamato main cannon image loaded');
        };
        ymtMainCannonImage.onerror = () => {
            console.warn('Failed to load ymtmaincannon.png');
        };
        ymtMainCannonImage.src = '/assets/images/units/ymtmaincannon.png';
    }
}

function loadSubmarineImage() {
    if (!submarineImage) {
        submarineImage = new Image();
        submarineImage.onload = () => {
            submarineImageLoaded = true;
            console.log('Submarine image loaded');
        };
        submarineImage.onerror = () => {
            console.warn('Failed to load submarine.png');
        };
        submarineImage.src = '/assets/images/units/submarine.png';
    }
}

function loadCruiserImage() {
    if (!cruiserImage) {
        cruiserImage = new Image();
        cruiserImage.onload = () => {
            cruiserImageLoaded = true;
            console.log('Cruiser image loaded');
        };
        cruiserImage.onerror = () => {
            console.warn('Failed to load cruiser.png');
        };
        cruiserImage.src = '/assets/images/units/cruiser.png';
    }
}

function loadCarrierImage() {
    if (!carrierImage) {
        carrierImage = new Image();
        carrierImage.onload = () => {
            carrierImageLoaded = true;
            console.log('Carrier image loaded');
        };
        carrierImage.onerror = () => {
            console.warn('Failed to load carrier.png');
        };
        carrierImage.src = '/assets/images/units/carrier.png';
    }
}

function loadFrigateImage() {
    if (!frigateImage) {
        frigateImage = new Image();
        frigateImage.onload = () => {
            frigateImageLoaded = true;
            console.log('Frigate image loaded');
        };
        frigateImage.onerror = () => {
            console.warn('Failed to load frigate.png');
        };
        frigateImage.src = '/assets/images/units/frigate.png';
    }
}

function loadFighterImage() {
    if (!fighterImage) {
        fighterImage = new Image();
        fighterImage.onload = () => {
            fighterImageLoaded = true;
            console.log('Fighter image loaded');
        };
        fighterImage.onerror = () => {
            console.warn('Failed to load fighter.png');
        };
        fighterImage.src = '/assets/images/units/fighter.png';
    }
}

function loadAssaultShipImage() {
    if (!assaultShipImage) {
        assaultShipImage = new Image();
        assaultShipImage.onload = () => {
            assaultShipImageLoaded = true;
            console.log('Assault ship image loaded');
        };
        assaultShipImage.onerror = () => {
            console.warn('Failed to load assaultship.png');
        };
        assaultShipImage.src = '/assets/images/units/assaultship.png';
    }
}

function loadReconAircraftImage() {
    if (!reconAircraftImage) {
        reconAircraftImage = new Image();
        reconAircraftImage.onload = () => {
            reconAircraftImageLoaded = true;
            console.log('Recon aircraft image loaded');
        };
        reconAircraftImage.onerror = () => {
            console.warn('Failed to load jcg.png');
        };
        reconAircraftImage.src = '/assets/images/units/jcg.png';
    }
}

function loadMissileLauncherImages() {
    if (!thaadImage) {
        thaadImage = new Image();
        thaadImage.onload = () => {
            thaadImageLoaded = true;
            console.log('thaad.png image loaded');
        };
        thaadImage.onerror = () => {
            console.warn('Failed to load thaad.png');
        };
        thaadImage.src = '/assets/images/units/thaad.png';
    }

    if (!thaadStage1Image) {
        thaadStage1Image = new Image();
        thaadStage1Image.onload = () => {
            thaadStage1ImageLoaded = true;
            console.log('thaad1.png image loaded');
        };
        thaadStage1Image.onerror = () => {
            console.warn('Failed to load thaad1.png');
        };
        thaadStage1Image.src = '/assets/images/units/thaad1.png';
    }

    if (!thaadStage2Image) {
        thaadStage2Image = new Image();
        thaadStage2Image.onload = () => {
            thaadStage2ImageLoaded = true;
            console.log('thaad2.png image loaded');
        };
        thaadStage2Image.onerror = () => {
            console.warn('Failed to load thaad2.png');
        };
        thaadStage2Image.src = '/assets/images/units/thaad2.png';
    }
}

function loadCruiserAegisImage() {
    if (!cruiserAegisImage) {
        cruiserAegisImage = new Image();
        cruiserAegisImage.onload = () => {
            cruiserAegisImageLoaded = true;
            console.log('Cruiser Aegis image loaded');
        };
        cruiserAegisImage.onerror = () => {
            console.warn('Failed to load cruiseraegis.png');
        };
        cruiserAegisImage.src = '/assets/images/units/cruiseraegis.png';
    }
}

function loadDestroyerImage() {
    if (!destroyerImage) {
        destroyerImage = new Image();
        destroyerImage.onload = () => {
            destroyerImageLoaded = true;
            console.log('Destroyer image loaded');
        };
        destroyerImage.onerror = () => {
            console.warn('Failed to load destroyer.png');
        };
        destroyerImage.src = '/assets/images/units/destroyer.png';
    }
}

function loadAirstrikeImage() {
    if (!airstrikeImage) {
        airstrikeImage = new Image();
        airstrikeImage.onload = () => {
            airstrikeImageLoaded = true;
            console.log('Airstrike image loaded');
        };
        airstrikeImage.onerror = () => {
            console.warn('Failed to load airstrike.png');
        };
        airstrikeImage.src = '/assets/images/units/airstrike.png';
    }
}

// Initialize all ship images on load
loadBattleshipImages();
loadSubmarineImage();
loadCruiserImage();
loadCarrierImage();
loadAssaultShipImage();
loadFrigateImage();
loadFighterImage();
loadReconAircraftImage();
loadMissileLauncherImages();
loadCruiserAegisImage();
loadDestroyerImage();
loadAirstrikeImage();

// Load building images
function loadBuildingImages() {
    hqImage = new Image();
    hqImage.onload = () => {
        hqImageLoaded = true;
        console.log('hq.png image loaded');
        if (!buildingSizeInitialized) {
            const origH = hqImage.height;
            const origW = hqImage.width;
            const heightMult = 6.6; // same as ships
            const baseSize = 60;    // same as ships
            const displayHeight = baseSize * heightMult;
            const displayWidth = displayHeight * (origW / origH);
            buildingDisplaySize = { width: displayWidth, height: displayHeight };
            buildingSizeInitialized = true;
            console.log(`Building display size set to ${displayWidth.toFixed(0)}x${displayHeight.toFixed(0)}`);
        }
    };
    hqImage.onerror = () => console.warn('Failed to load hq.png');
    hqImage.src = '/assets/images/buildings/hq.png';

    // Power plant images: bjs, bjs1, bjs2
    const bjsNames = ['bjs', 'bjs1', 'bjs2'];
    for (let i = 0; i < 3; i++) {
        const idx = i;
        bjsImages[idx] = new Image();
        bjsImages[idx].onload = () => {
            bjsImagesLoaded[idx] = true;
            console.log(`${bjsNames[idx]} image loaded`);
        };
        bjsImages[idx].onerror = () => console.warn(`Failed to load ${bjsNames[idx]}.png`);
        bjsImages[idx].src = `/assets/images/buildings/${bjsNames[idx]}.png`;
    }

    // Shipyard images: jss, jss1, jss2, jss3
    const jssNames = ['jss', 'jss1', 'jss2', 'jss3'];
    for (let i = 0; i < jssNames.length; i++) {
        const idx = i;
        jssImages[idx] = new Image();
        jssImages[idx].onload = () => {
            jssImagesLoaded[idx] = true;
            console.log(`${jssNames[idx]} image loaded`);
        };
        jssImages[idx].onerror = () => console.warn(`Failed to load ${jssNames[idx]}.png`);
        jssImages[idx].src = `/assets/images/buildings/${jssNames[idx]}.png`;
    }

    // Naval academy images: djss, djss1 ... djss9
    const djssNames = ['djss', 'djss1', 'djss2', 'djss3', 'djss4', 'djss5', 'djss6', 'djss7', 'djss8', 'djss9'];
    for (let i = 0; i < djssNames.length; i++) {
        const idx = i;
        djssImages[idx] = new Image();
        djssImages[idx].onload = () => {
            djssImagesLoaded[idx] = true;
            console.log(`${djssNames[idx]} image loaded`);
        };
        djssImages[idx].onerror = () => console.warn(`Failed to load ${djssNames[idx]}.png`);
        djssImages[idx].src = `/assets/images/buildings/${djssNames[idx]}.png`;
    }

    defenseTowerBaseImage = new Image();
    defenseTowerBaseImage.onload = () => {
        defenseTowerBaseLoaded = true;
        console.log('turret.png image loaded');
    };
    defenseTowerBaseImage.onerror = () => console.warn('Failed to load turret.png');
    defenseTowerBaseImage.src = '/assets/images/buildings/turret.png';

    defenseTowerCannonImage = new Image();
    defenseTowerCannonImage.onload = () => {
        defenseTowerCannonLoaded = true;
        console.log('turretcannon.png image loaded');
    };
    defenseTowerCannonImage.onerror = () => console.warn('Failed to load turretcannon.png');
    defenseTowerCannonImage.src = '/assets/images/buildings/turretcannon.png';

    missileSiloImage = new Image();
    missileSiloImage.onload = () => {
        missileSiloLoaded = true;
        console.log('silo.png image loaded');
    };
    missileSiloImage.onerror = () => console.warn('Failed to load silo.png');
    missileSiloImage.src = '/assets/images/buildings/silo.png';

    carbaseBuildingImage = new Image();
    carbaseBuildingImage.onload = () => {
        carbaseBuildingImageLoaded = true;
        console.log('carbase.png image loaded');
    };
    carbaseBuildingImage.onerror = () => console.warn('Failed to load carbase.png');
    carbaseBuildingImage.src = '/assets/images/buildings/carbase.png';
}
loadBuildingImages();

// Get current power plant image index based on 10-second cycle
// bjs2(4s) -> bjs1(3s) -> bjs(3s)
function getPowerPlantImageIndex() {
    const elapsed = Date.now() % POWER_PLANT_CYCLE_MS;
    if (elapsed < 4000) return 2;       // bjs2 (0-4s)
    else if (elapsed < 7000) return 1;  // bjs1 (4-7s)
    else return 0;                       // bjs  (7-10s)
}

function getBuildingProductionProgress(building) {
    if (!building || !building.producing || !building.producing.buildTime) return 0;
    const elapsed = Date.now() - building.producing.startTime;
    return Math.max(0, Math.min(1, elapsed / building.producing.buildTime));
}

function getShipyardImageIndex(building) {
    const progress = getBuildingProductionProgress(building);
    if (progress < 0.25) return 0;  // jss
    if (progress < 0.50) return 1;  // jss1
    if (progress < 0.75) return 2;  // jss2
    return 3;                       // jss3
}

function getNavalAcademyImageIndex(building) {
    const progress = getBuildingProductionProgress(building);
    return Math.min(djssImages.length - 1, Math.floor(progress * djssImages.length));
}

function getFixedImageDisplaySize(image, maxDimension = FIXED_BUILDING_IMAGE_MAX_DIMENSION) {
    const safeWidth = Math.max(1, (image && image.width) ? image.width : 29);
    const safeHeight = Math.max(1, (image && image.height) ? image.height : 24);
    const scale = maxDimension / Math.max(safeWidth, safeHeight);
    return {
        width: safeWidth * scale,
        height: safeHeight * scale,
        scale
    };
}

function getDefenseTowerVisualMetrics() {
    const baseImage = defenseTowerBaseLoaded ? defenseTowerBaseImage : null;
    const cannonImage = defenseTowerCannonLoaded ? defenseTowerCannonImage : null;
    const baseSize = getFixedImageDisplaySize(baseImage, FIXED_BUILDING_IMAGE_MAX_DIMENSION);
    const baseOriginalWidth = Math.max(1, (baseImage && baseImage.width) ? baseImage.width : 29);
    const baseOriginalHeight = Math.max(1, (baseImage && baseImage.height) ? baseImage.height : 24);
    const cannonOriginalWidth = Math.max(1, (cannonImage && cannonImage.width) ? cannonImage.width : 29);
    const cannonOriginalHeight = Math.max(1, (cannonImage && cannonImage.height) ? cannonImage.height : 24);
    const scaleX = baseSize.width / baseOriginalWidth;
    const scaleY = baseSize.height / baseOriginalHeight;
    return {
        baseWidth: baseSize.width,
        baseHeight: baseSize.height,
        cannonWidth: cannonOriginalWidth * scaleX,
        cannonHeight: cannonOriginalHeight * scaleY,
        cannonPivotLocalX: -(baseSize.width / 2) + (DEFENSE_TOWER_CANNON_START.x * scaleX),
        cannonPivotLocalY: -(baseSize.height / 2) + (DEFENSE_TOWER_CANNON_START.y * scaleY),
        cannonAnchorX: DEFENSE_TOWER_CANNON_PIVOT.x / cannonOriginalWidth,
        cannonAnchorY: DEFENSE_TOWER_CANNON_PIVOT.y / cannonOriginalHeight,
        cannonBaseAngle: DEFENSE_TOWER_CANNON_BASE_ANGLE
    };
}

const DEFAULT_BATTLESHIP_BASE_WIDTH = 19;
const DEFAULT_BATTLESHIP_BASE_HEIGHT = 100;
const DEFAULT_MAIN_CANNON_WIDTH = 11;
const DEFAULT_MAIN_CANNON_HEIGHT = 9;
const BATTLESHIP_BASE_HEIGHT_MULTIPLIER = 2.2 * 3 * 1.2;
const BATTLESHIP_TURRET_IMAGE_COORDS = Object.freeze([
    { x: 0.5, y: 15 },
    { x: 0.5, y: 60 },
    { x: 0.5, y: 70 }
]);
const YAMATO_ENTITY_NAME = 'yamato';
const YAMATO_BATTLESHIP_EXHAUST_IMAGE_COORD = Object.freeze({ x: 9, y: 33 });
const BATTLESHIP_DEFAULT_ATTACK_COOLDOWN_MS = 4800;
const BATTLESHIP_MUZZLE_DIRECTION_SIGN = 1;
const YAMATO_BATTLESHIP_EXHAUST_SAMPLE_MS = 55;
const YAMATO_BATTLESHIP_EXHAUST_LIFETIME_MS = 1450;
const YAMATO_BATTLESHIP_EXHAUST_MIN_MOVE_SQ = 0.12;
const YAMATO_BATTLESHIP_EXHAUST_VIEWPORT_MARGIN = 140;
const YAMATO_BATTLESHIP_EXHAUST_COLORS = Object.freeze([
    0x101010,
    0x242424,
    0x3c3c3c,
    0x5a5a5a
]);

function getBattleshipTargetHoldMs(unit) {
    const cooldown = (unit && Number.isFinite(unit.attackCooldownMs) && unit.attackCooldownMs > 0)
        ? unit.attackCooldownMs
        : BATTLESHIP_DEFAULT_ATTACK_COOLDOWN_MS;
    // Keep turret on last fired target for roughly one firing cycle + small network/render slack.
    return Math.min(7000, Math.max(1200, cooldown + 600));
}

function isYamatoBattleshipOwner(userId) {
    if (userId == null) return false;
    if (userId === gameState.userId) {
        return gameState.username === 'JsonParc';
    }
    const player = gameState.players.get(userId);
    return !!(player && player.username === 'JsonParc');
}

function isYamatoBattleshipUnit(unit) {
    return !!(unit && unit.type === 'battleship' && isYamatoBattleshipOwner(unit.userId));
}

function getBattleshipBodyImage(unitOrType = null) {
    const unit = typeof unitOrType === 'object' ? unitOrType : null;
    if (unit && isYamatoBattleshipUnit(unit) && ymtBattleshipBaseLoaded && ymtBattleshipBaseImage) {
        return ymtBattleshipBaseImage;
    }
    if (unit?.battleshipAegisMode && battleshipAegisBaseLoaded && battleshipAegisBaseImage) {
        return battleshipAegisBaseImage;
    }
    return (battleshipBaseLoaded && battleshipBaseImage) ? battleshipBaseImage : null;
}

function getBattleshipCannonImage(unitOrType = null) {
    const unit = typeof unitOrType === 'object' ? unitOrType : null;
    if (unit && isYamatoBattleshipUnit(unit) && ymtMainCannonLoaded && ymtMainCannonImage) {
        return ymtMainCannonImage;
    }
    return (mainCannonLoaded && mainCannonImage) ? mainCannonImage : null;
}

function getBattleshipVisualMetrics(size = 60, unitOrType = null) {
    const bodyImage = getBattleshipBodyImage(unitOrType);
    const cannonImage = getBattleshipCannonImage(unitOrType);
    const originalWidth = bodyImage
        ? bodyImage.width
        : DEFAULT_BATTLESHIP_BASE_WIDTH;
    const originalHeight = bodyImage
        ? bodyImage.height
        : DEFAULT_BATTLESHIP_BASE_HEIGHT;
    const aspectRatio = originalWidth / originalHeight;
    const baseHeight = size * BATTLESHIP_BASE_HEIGHT_MULTIPLIER;
    const baseWidth = baseHeight * aspectRatio;
    const imageScaleX = baseWidth / originalWidth;
    const imageScaleY = baseHeight / originalHeight;
    const centerX = originalWidth / 2;
    const centerY = originalHeight / 2;

    const turretInner = BATTLESHIP_TURRET_IMAGE_COORDS.map(pos => ({
        x: (pos.x * originalWidth - centerX) * imageScaleX,
        y: (pos.y - centerY) * imageScaleY
    }));

    const cannonOriginalWidth = cannonImage
        ? cannonImage.width
        : DEFAULT_MAIN_CANNON_WIDTH;
    const cannonOriginalHeight = cannonImage
        ? cannonImage.height
        : DEFAULT_MAIN_CANNON_HEIGHT;
    const turretWidth = cannonOriginalWidth * imageScaleX;
    const turretHeight = cannonOriginalHeight * imageScaleY;

    // Cannon sprite points down (+Y). Use the bottom-most opaque pixel row as muzzle direction.
    const muzzleForwardOffset = Math.max(
        imageScaleY,
        ((cannonOriginalHeight - 1) - (cannonOriginalHeight / 2)) * imageScaleY + imageScaleY * 0.35
    );

    return {
        originalWidth,
        originalHeight,
        baseWidth,
        baseHeight,
        imageScaleX,
        imageScaleY,
        turretInner,
        turretWidth,
        turretHeight,
        muzzleForwardOffset
    };
}

function getBattleshipTurretWorldStates(shipX, shipY, shipAngle, size = 60, turretAngles = null, unitOrType = null) {
    const metrics = getBattleshipVisualMetrics(size, unitOrType);
    const shipRotAngle = shipAngle - Math.PI / 2;
    const cosShip = Math.cos(shipRotAngle);
    const sinShip = Math.sin(shipRotAngle);

    return metrics.turretInner.map((tp, index) => {
        const worldOffX = tp.x * cosShip - tp.y * sinShip;
        const worldOffY = tp.x * sinShip + tp.y * cosShip;
        const centerX = shipX + worldOffX;
        const centerY = shipY + worldOffY;
        const angle = (turretAngles && turretAngles[index] !== undefined)
            ? turretAngles[index]
            : shipAngle;
        const muzzleX = centerX + Math.cos(angle) * metrics.muzzleForwardOffset * BATTLESHIP_MUZZLE_DIRECTION_SIGN;
        const muzzleY = centerY + Math.sin(angle) * metrics.muzzleForwardOffset * BATTLESHIP_MUZZLE_DIRECTION_SIGN;
        return { centerX, centerY, muzzleX, muzzleY, angle };
    });
}

function getBattleshipImageWorldPoint(shipX, shipY, shipAngle, imagePoint, size = 60, unitOrType = null) {
    const metrics = getBattleshipVisualMetrics(size, unitOrType);
    const shipRotAngle = shipAngle - Math.PI / 2;
    const cosShip = Math.cos(shipRotAngle);
    const sinShip = Math.sin(shipRotAngle);
    const localX = (imagePoint.x - metrics.originalWidth / 2) * metrics.imageScaleX;
    const localY = (imagePoint.y - metrics.originalHeight / 2) * metrics.imageScaleY;

    return {
        x: shipX + localX * cosShip - localY * sinShip,
        y: shipY + localX * sinShip + localY * cosShip,
        metrics
    };
}

function spawnYamatoExhaustParticle(emitterX, emitterY, moveDx, moveDy, metrics, now) {
    const moveLength = Math.hypot(moveDx, moveDy);
    if (moveLength <= 0) return;

    const moveNormX = moveDx / moveLength;
    const moveNormY = moveDy / moveLength;
    const speedFactor = Math.min(1.85, Math.max(0.9, moveLength / Math.max(0.001, metrics.imageScaleY * 0.45)));
    const lateralX = -moveNormY;
    const lateralY = moveNormX;
    const lateralJitter = metrics.imageScaleX * (Math.random() - 0.5) * (2 + speedFactor * 0.9);
    const backwardOffset = metrics.imageScaleY * (0.55 + Math.random() * (0.95 + speedFactor * 0.3));
    const startX = emitterX + lateralX * lateralJitter - moveNormX * backwardOffset;
    const startY = emitterY + lateralY * lateralJitter - moveNormY * backwardOffset;
    const colorIndex = Math.floor(Math.random() * YAMATO_BATTLESHIP_EXHAUST_COLORS.length);
    const coreColor = YAMATO_BATTLESHIP_EXHAUST_COLORS[colorIndex];
    const hazeColor = YAMATO_BATTLESHIP_EXHAUST_COLORS[Math.min(
        YAMATO_BATTLESHIP_EXHAUST_COLORS.length - 1,
        colorIndex + 1
    )];

    yamatoExhaustParticles.push({
        x: startX,
        y: startY,
        time: now,
        driftX: -moveNormX * metrics.imageScaleY * (0.016 + Math.random() * 0.009) * speedFactor + lateralX * metrics.imageScaleX * ((Math.random() - 0.5) * 0.014),
        driftY: -moveNormY * metrics.imageScaleY * (0.016 + Math.random() * 0.009) * speedFactor + lateralY * metrics.imageScaleX * ((Math.random() - 0.5) * 0.014),
        swirlX: lateralX * metrics.imageScaleX * ((Math.random() - 0.5) * (1.35 + speedFactor * 0.35)),
        swirlY: lateralY * metrics.imageScaleX * ((Math.random() - 0.5) * (1.35 + speedFactor * 0.35)),
        startRadius: metrics.imageScaleY * (1.15 + Math.random() * 0.65),
        endRadius: metrics.imageScaleY * (4.2 + Math.random() * 1.9) * speedFactor,
        alpha: Math.min(0.36, 0.21 + Math.random() * 0.1 + (speedFactor - 0.9) * 0.045),
        denseAlpha: Math.min(0.42, 0.12 + Math.random() * 0.08 + (speedFactor - 0.9) * 0.035),
        stretch: 0.8 + Math.random() * 0.8 + speedFactor * 0.45,
        speedFactor,
        coreColor,
        hazeColor
    });
}

function syncYamatoExhaust(now, viewport, loadSettings) {
    const activeIds = new Set();
    const viewportMargin = YAMATO_BATTLESHIP_EXHAUST_VIEWPORT_MARGIN;
    const emissionInterval = loadSettings.detailedProjectiles
        ? YAMATO_BATTLESHIP_EXHAUST_SAMPLE_MS
        : YAMATO_BATTLESHIP_EXHAUST_SAMPLE_MS + 40;

    gameState.units.forEach((unit, unitId) => {
        if (!isYamatoBattleshipUnit(unit)) return;

        const { x: shipX, y: shipY } = getUnitDisplayPosition(unit);
        const state = yamatoExhaustState.get(unitId) || {
            lastShipX: shipX,
            lastShipY: shipY,
            lastEmitTime: now - emissionInterval
        };
        const moveDx = shipX - state.lastShipX;
        const moveDy = shipY - state.lastShipY;
        const moveDistSq = moveDx * moveDx + moveDy * moveDy;
        const shipVisible = isUnitVisibleToPlayer(unit);
        const inViewport = (
            shipX >= viewport.left - viewportMargin &&
            shipX <= viewport.right + viewportMargin &&
            shipY >= viewport.top - viewportMargin &&
            shipY <= viewport.bottom + viewportMargin
        );

        if (shipVisible && inViewport) {
            activeIds.add(unitId);
            if (moveDistSq > YAMATO_BATTLESHIP_EXHAUST_MIN_MOVE_SQ && now - state.lastEmitTime >= emissionInterval) {
                const shipAngle = unit.displayAngle !== undefined
                    ? unit.displayAngle
                    : (unit.commandAngle !== undefined ? unit.commandAngle : 0);
                const size = getUnitSelectionBaseSize(unit);
                const exhaustPoint = getBattleshipImageWorldPoint(
                    shipX,
                    shipY,
                    shipAngle,
                    YAMATO_BATTLESHIP_EXHAUST_IMAGE_COORD,
                    size,
                    unit
                );
                const moveLength = Math.sqrt(moveDistSq);
                const speedFactor = Math.min(
                    1.8,
                    Math.max(0.85, moveLength / Math.max(0.001, exhaustPoint.metrics.imageScaleY * 0.45))
                );
                const particleCount = loadSettings.detailedProjectiles
                    ? Math.max(3, Math.min(5, Math.round(2 + speedFactor * 1.6)))
                    : Math.max(2, Math.min(3, Math.round(1 + speedFactor)));
                for (let i = 0; i < particleCount; i++) {
                    spawnYamatoExhaustParticle(
                        exhaustPoint.x,
                        exhaustPoint.y,
                        moveDx,
                        moveDy,
                        exhaustPoint.metrics,
                        now - (particleCount - 1 - i) * 12
                    );
                }
                state.lastEmitTime = now;
            }
        }

        state.lastShipX = shipX;
        state.lastShipY = shipY;
        yamatoExhaustState.set(unitId, state);
    });

    yamatoExhaustParticles = yamatoExhaustParticles.filter(
        particle => now - particle.time < YAMATO_BATTLESHIP_EXHAUST_LIFETIME_MS
    );

    const staleIds = [];
    yamatoExhaustState.forEach((state, unitId) => {
        if (!activeIds.has(unitId) && !gameState.units.has(unitId)) {
            staleIds.push(unitId);
        }
    });
    staleIds.forEach(unitId => yamatoExhaustState.delete(unitId));
}

function drawYamatoExhaust(gfx, now, viewport) {
    const viewportMargin = YAMATO_BATTLESHIP_EXHAUST_VIEWPORT_MARGIN;

    yamatoExhaustParticles.forEach(particle => {
        const age = now - particle.time;
        const progress = age / YAMATO_BATTLESHIP_EXHAUST_LIFETIME_MS;
        if (progress <= 0 || progress >= 1) return;

        const driftX = particle.driftX * age + particle.swirlX * progress;
        const driftY = particle.driftY * age + particle.swirlY * progress;
        const drawX = particle.x + driftX;
        const drawY = particle.y + driftY;
        if (
            drawX < viewport.left - viewportMargin ||
            drawX > viewport.right + viewportMargin ||
            drawY < viewport.top - viewportMargin ||
            drawY > viewport.bottom + viewportMargin
        ) {
            return;
        }

        const radius = particle.startRadius + (particle.endRadius - particle.startRadius) * progress;
        const alpha = particle.alpha * (1 - progress * 0.78);
        const hazeAlpha = alpha * 0.72;
        const denseAlpha = particle.denseAlpha * (1 - progress * 0.92);
        const stretchX = particle.swirlX * 0.08 * particle.stretch;
        const stretchY = particle.swirlY * 0.08 * particle.stretch;

        gfx.beginFill(particle.hazeColor, hazeAlpha);
        gfx.drawCircle(drawX, drawY, radius * 1.45);
        gfx.endFill();

        gfx.beginFill(particle.coreColor, alpha);
        gfx.drawCircle(
            drawX - stretchX * progress,
            drawY - stretchY * progress,
            radius * 1.12
        );
        gfx.endFill();

        gfx.beginFill(0x050505, denseAlpha);
        gfx.drawCircle(
            drawX + stretchX * 0.35 * (1 - progress),
            drawY + stretchY * 0.35 * (1 - progress),
            Math.max(radius * 0.62, particle.startRadius * 0.9)
        );
        gfx.endFill();
    });
}

function getBattleshipAimTarget(unit) {
    if (!unit) return null;

    if (unit.attackTargetId) {
        let attackTargetObj = null;
        if (unit.attackTargetType === 'unit') {
            attackTargetObj = gameState.units.get(unit.attackTargetId);
        } else if (unit.attackTargetType === 'building') {
            attackTargetObj = gameState.buildings.get(unit.attackTargetId);
        }
        if (attackTargetObj) {
            const x = (attackTargetObj.interpDisplayX !== undefined) ? attackTargetObj.interpDisplayX : attackTargetObj.x;
            const y = (attackTargetObj.interpDisplayY !== undefined) ? attackTargetObj.interpDisplayY : attackTargetObj.y;
            return { x, y };
        }
    }

    if (
        Number.isFinite(unit.lastTurretTargetX) &&
        Number.isFinite(unit.lastTurretTargetY) &&
        Number.isFinite(unit.lastTurretTargetTime) &&
        (Date.now() - unit.lastTurretTargetTime) <= getBattleshipTargetHoldMs(unit)
    ) {
        return { x: unit.lastTurretTargetX, y: unit.lastTurretTargetY };
    }

    return null;
}

function getSlbmWorldPosition(missile, nowMs = Date.now()) {
    if (!missile || missile.impacted) return null;
    const progress = Math.max(0, Math.min(1, (nowMs - missile.startTime) / missile.flightTime));
    return {
        x: missile.fromX + (missile.targetX - missile.fromX) * progress,
        y: missile.fromY + (missile.targetY - missile.fromY) * progress
    };
}

function isSlbmVisibleToPlayer(missile, nowMs = Date.now()) {
    if (!missile) return false;
    if (missile.userId === gameState.userId || hasTemporaryFullMapReveal()) return true;
    const position = getSlbmWorldPosition(missile, nowMs);
    return !!position && isPositionVisible(position.x, position.y);
}

function isSlbmImpactVisibleToPlayer(missile) {
    if (!missile) return false;
    if (missile.userId === gameState.userId || hasTemporaryFullMapReveal()) return true;
    return isPositionVisible(missile.targetX, missile.targetY);
}

function syncBattleshipProjectileSounds() {
}

function getDefenseTowerAimTarget(building) {
    if (!building) return null;

    if (building.attackTargetId) {
        if (building.attackTargetType === 'unit') {
            const targetUnit = gameState.units.get(building.attackTargetId);
            if (targetUnit) {
                return {
                    x: targetUnit.interpDisplayX !== undefined ? targetUnit.interpDisplayX : targetUnit.x,
                    y: targetUnit.interpDisplayY !== undefined ? targetUnit.interpDisplayY : targetUnit.y
                };
            }
        } else if (building.attackTargetType === 'slbm') {
            const targetMissile = slbmMissiles.find(missile => missile.id === building.attackTargetId);
            const missilePos = getSlbmWorldPosition(targetMissile);
            if (missilePos) return missilePos;
        }
    }

    if (
        Number.isFinite(building.turretTargetX) &&
        Number.isFinite(building.turretTargetY) &&
        Number.isFinite(building.lastTurretTargetTime) &&
        (Date.now() - building.lastTurretTargetTime) <= 1200
    ) {
        return { x: building.turretTargetX, y: building.turretTargetY };
    }

    return null;
}

function normalizeBuildingPayload(building) {
    if (!building) return building;
    if (building.type === 'research_lab') {
        return { ...building, type: 'missile_silo' };
    }
    return building;
}

function mergeUnitState(existingUnit, nextUnit, nowMs) {
    if (!existingUnit) {
        nextUnit.interpDisplayX = nextUnit.x;
        nextUnit.interpDisplayY = nextUnit.y;
        return nextUnit;
    }

    // Save interpolation display position BEFORE overwrite
    const prevDispX = existingUnit.interpDisplayX !== undefined ? existingUnit.interpDisplayX : existingUnit.x;
    const prevDispY = existingUnit.interpDisplayY !== undefined ? existingUnit.interpDisplayY : existingUnit.y;
    // Save turret target state before overwrite
    const savedTurretTargetX = existingUnit.lastTurretTargetX;
    const savedTurretTargetY = existingUnit.lastTurretTargetY;
    const savedTurretTargetTime = existingUnit.lastTurretTargetTime;

    // Mutate existing unit in-place to avoid GC from spread operator
    const keys = Object.keys(nextUnit);
    for (let i = 0; i < keys.length; i++) {
        existingUnit[keys[i]] = nextUnit[keys[i]];
    }

    existingUnit.interpPrevX = prevDispX;
    existingUnit.interpPrevY = prevDispY;
    existingUnit.interpTargetX = existingUnit.x;
    existingUnit.interpTargetY = existingUnit.y;
    existingUnit.interpDisplayX = prevDispX;
    existingUnit.interpDisplayY = prevDispY;
    existingUnit.interpStartTime = nowMs;
    existingUnit.interpDone = false;

    const incomingTargetTime = Number.isFinite(nextUnit.lastTurretTargetTime) ? nextUnit.lastTurretTargetTime : -Infinity;
    const existingTargetTime = Number.isFinite(savedTurretTargetTime) ? savedTurretTargetTime : -Infinity;
    if (existingTargetTime > incomingTargetTime) {
        existingUnit.lastTurretTargetX = savedTurretTargetX;
        existingUnit.lastTurretTargetY = savedTurretTargetY;
        existingUnit.lastTurretTargetTime = savedTurretTargetTime;
    }

    return existingUnit;
}

function mergeBuildingVisualState(existingBuilding, nextBuilding) {
    const normalizedBuilding = normalizeBuildingPayload(nextBuilding);
    if (!existingBuilding) return normalizedBuilding;

    // Save turret state before overwrite
    const savedTurretAngle = existingBuilding.turretAngle;
    const savedTurretTargetX = existingBuilding.turretTargetX;
    const savedTurretTargetY = existingBuilding.turretTargetY;
    const savedTurretTargetTime = existingBuilding.lastTurretTargetTime;
    const savedAttackTargetId = existingBuilding.attackTargetId;
    const savedAttackTargetType = existingBuilding.attackTargetType;

    // Mutate in-place to avoid GC from spread operator
    const keys = Object.keys(normalizedBuilding);
    for (let i = 0; i < keys.length; i++) {
        existingBuilding[keys[i]] = normalizedBuilding[keys[i]];
    }

    if (!Number.isFinite(existingBuilding.turretAngle) && Number.isFinite(savedTurretAngle)) {
        existingBuilding.turretAngle = savedTurretAngle;
    }

    const incomingTargetTime = Number.isFinite(normalizedBuilding.lastTurretTargetTime) ? normalizedBuilding.lastTurretTargetTime : -Infinity;
    const existingTargetTime = Number.isFinite(savedTurretTargetTime) ? savedTurretTargetTime : -Infinity;
    if (existingTargetTime > incomingTargetTime) {
        existingBuilding.turretTargetX = savedTurretTargetX;
        existingBuilding.turretTargetY = savedTurretTargetY;
        existingBuilding.lastTurretTargetTime = savedTurretTargetTime;
        if (!existingBuilding.attackTargetId) existingBuilding.attackTargetId = savedAttackTargetId;
        if (!existingBuilding.attackTargetType) existingBuilding.attackTargetType = savedAttackTargetType;
        if (!Number.isFinite(existingBuilding.turretAngle) && Number.isFinite(savedTurretAngle)) {
            existingBuilding.turretAngle = savedTurretAngle;
        }
    }

    return existingBuilding;
}

let gameState = {
    userId: null,
    token: null,
    map: null,
    players: new Map(),
    units: new Map(),
    buildings: new Map(),
    redZones: [],
    fogOfWar: new Map(), // gridKey -> {lastSeen, explored}
    camera: { x: 0, y: 0, zoom: 1 },
    selection: new Set(),
    squads: new Map(),
    inspectedUnitId: null,
    selectionBox: null,
    buildMode: null,
    workerBuildCategory: 'general',
    workerMode: null, // 'gather' or 'build'
    missiles: 0 // Player's missile count
};
let selectionInfoSuspendUntil = 0;
let skillFocusType = null; // When hovering a unit type in squad, override skill display

function suspendSelectionInfoRefresh(durationMs = 250) {
    selectionInfoSuspendUntil = Math.max(selectionInfoSuspendUntil, Date.now() + durationMs);
}

function getClosestProductionButton(target) {
    const elementTarget = target instanceof Element
        ? target
        : (target && target.parentElement ? target.parentElement : null);
    return elementTarget ? elementTarget.closest('.prod-btn') : null;
}

function getProductionButtonBuildingId(btn) {
    if (!btn) return null;
    if (btn._buildingId !== undefined) return btn._buildingId;
    const raw = btn.getAttribute('data-building');
    if (raw == null) return null;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : raw;
}

function resetSecretClickStreak(streak) {
    streak.count = 0;
    streak.lastAt = 0;
}

function registerSecretRapidClick(streak, requiredClicks, now = Date.now(), resetMs = SECRET_CLICK_STREAK_RESET_MS) {
    if ((now - streak.lastAt) > resetMs) {
        streak.count = 0;
    }
    streak.lastAt = now;
    streak.count += 1;
    if (streak.count === requiredClicks) {
        resetSecretClickStreak(streak);
        return true;
    }
    return false;
}

function invalidateFogAndMinimap() {
    fogDirty = true;
    minimapDirty = true;
}

function applyRedZoneSync(redZones) {
    gameState.redZones = Array.isArray(redZones)
        ? redZones.map(zone => ({
            ...zone,
            landCells: Array.isArray(zone.landCells) ? zone.landCells : [],
            landCellKeys: new Set(
                (Array.isArray(zone.landCells) ? zone.landCells : [])
                    .filter(cell => Array.isArray(cell) && cell.length >= 2)
                    .map(cell => `${cell[0]}:${cell[1]}`)
            )
        }))
        : [];
    const pendingActivationAt = gameState.redZones
        .filter(zone => !zone.detonatedAt && Number.isFinite(zone.selectedAt))
        .reduce((latest, zone) => Math.max(latest, zone.selectedAt), 0);
    if (pendingActivationAt > lastSeenRedZoneActivationAt) {
        lastSeenRedZoneActivationAt = pendingActivationAt;
        showKillLogMessage('레드존 활성화까지 30초 남았습니다', 'red-zone');
    }
    minimapDirty = true;
}

function isWorldPointInsideRedZone(zone, x, y) {
    if (!gameState.map || !zone || !(zone.landCellKeys instanceof Set) || zone.landCellKeys.size === 0) return false;
    const cellSize = gameState.map.cellSize || 50;
    const gridX = Math.floor(x / cellSize);
    const gridY = Math.floor(y / cellSize);
    return zone.landCellKeys.has(`${gridX}:${gridY}`);
}

function isOwnBuildingInPendingRedZone(building) {
    if (!building || building.userId !== gameState.userId || !Array.isArray(gameState.redZones)) return false;
    return gameState.redZones.some(zone => !zone.detonatedAt && isWorldPointInsideRedZone(zone, building.x, building.y));
}

function hasBlinkingRedZoneBuildings() {
    if (!Array.isArray(gameState.redZones) || !gameState.redZones.some(zone => !zone.detonatedAt)) return false;
    for (const building of gameState.buildings.values()) {
        if (isOwnBuildingInPendingRedZone(building)) {
            return true;
        }
    }
    return false;
}

function hasTemporaryFullMapReveal() {
    return fullMapRevealUntil > Date.now();
}

function clearTemporaryFullMapReveal() {
    fullMapRevealUntil = 0;
    if (fullMapRevealTimeoutId) {
        clearTimeout(fullMapRevealTimeoutId);
        fullMapRevealTimeoutId = null;
    }
    invalidateFogAndMinimap();
    emitViewportUpdate(true);
}

function activateTemporaryFullMapReveal(durationMs = TEMPORARY_FULL_MAP_REVEAL_MS) {
    fullMapRevealUntil = Date.now() + durationMs;
    if (fullMapRevealTimeoutId) {
        clearTimeout(fullMapRevealTimeoutId);
    }
    invalidateFogAndMinimap();
    if (gameState.map) {
        updateFogOfWar(true);
        renderMinimap();
    }
    emitViewportUpdate(true);
    fullMapRevealTimeoutId = setTimeout(() => {
        fullMapRevealUntil = 0;
        fullMapRevealTimeoutId = null;
        invalidateFogAndMinimap();
        if (gameState.map) {
            updateFogOfWar(true);
        }
        emitViewportUpdate(true);
    }, durationMs);
}

// ==================== SOUND EFFECTS SYSTEM (MP3 Files) ====================
function createSound(src, options = {}) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    audio.volume = options.volume ?? 1;
    audio.loop = !!options.loop;
    audio.addEventListener('error', () => {
        console.warn(`Failed to load sound: ${src}`);
    });
    return audio;
}

const soundLaunch = createSound('/launchsound.mp3', { volume: 0.5 });
const soundBomb = createSound('/bombsound.mp3', { volume: 0.6 });
const soundCannon = createSound('/cannonsound.mp3', { volume: 0.4 });
const managedBattleSounds = new Set();

function getLoadedSoundDuration(soundTemplate) {
    return Number.isFinite(soundTemplate?.duration) && soundTemplate.duration > 0
        ? soundTemplate.duration
        : null;
}

function playOneShot(soundTemplate, options = {}) {
    const { startTimeSec = 0 } = options;
    try {
        const durationSec = getLoadedSoundDuration(soundTemplate);
        if (durationSec !== null && startTimeSec >= durationSec) return null;
        const sound = soundTemplate.cloneNode();
        sound.volume = soundTemplate.volume;
        if (startTimeSec > 0) {
            const seekTime = durationSec !== null
                ? Math.min(startTimeSec, Math.max(0, durationSec - 0.05))
                : startTimeSec;
            try {
                sound.currentTime = seekTime;
            } catch(e) {}
        }
        sound.play().catch(() => {});
        return sound;
    } catch(e) {}
    return null;
}

function stopManagedBattleSound(instance) {
    if (!instance) return null;
    try {
        instance.pause();
        instance.currentTime = 0;
    } catch(e) {}
    managedBattleSounds.delete(instance);
    return null;
}

function stopAllManagedBattleSounds() {
    managedBattleSounds.forEach(instance => {
        try {
            instance.pause();
            instance.currentTime = 0;
        } catch(e) {}
    });
    managedBattleSounds.clear();
}

function syncTimedManagedSound(instance, soundTemplate, elapsedMs, options = {}) {
    const { toleranceSec = 0.3 } = options;
    const durationSec = getLoadedSoundDuration(soundTemplate);
    const elapsedSec = Math.max(0, elapsedMs / 1000);
    if (durationSec !== null && elapsedSec >= durationSec) {
        return stopManagedBattleSound(instance);
    }

    try {
        let nextInstance = instance;
        const targetTimeSec = durationSec !== null
            ? Math.min(elapsedSec, Math.max(0, durationSec - 0.05))
            : elapsedSec;

        if (!nextInstance) {
            nextInstance = soundTemplate.cloneNode();
            nextInstance.volume = soundTemplate.volume;
            nextInstance.loop = false;
            nextInstance.addEventListener('ended', () => managedBattleSounds.delete(nextInstance), { once: true });
            managedBattleSounds.add(nextInstance);
        }

        const currentTime = Number.isFinite(nextInstance.currentTime) ? nextInstance.currentTime : 0;
        if (Math.abs(currentTime - targetTimeSec) > toleranceSec) {
            try {
                nextInstance.currentTime = targetTimeSec;
            } catch(e) {}
        }

        if (nextInstance.paused) {
            nextInstance.play().catch(() => {});
        }
        return nextInstance;
    } catch(e) {}
    return instance;
}

function syncSlbmFlightSounds(now = Date.now()) {
    slbmMissiles.forEach(missile => {
        if (missile.impacted) {
            missile.flightSoundInstance = stopManagedBattleSound(missile.flightSoundInstance);
            return;
        }
        if (!isSlbmVisibleToPlayer(missile, now)) {
            missile.flightSoundInstance = stopManagedBattleSound(missile.flightSoundInstance);
            return;
        }
        missile.flightSoundInstance = syncTimedManagedSound(
            missile.flightSoundInstance,
            soundLaunch,
            now - missile.startTime,
            { toleranceSec: 0.2 }
        );
    });
}

function stopSlbmFlightSound(force = false) {
    if (!force && slbmMissiles.some(missile => !missile.impacted)) return;
    slbmMissiles.forEach(missile => {
        missile.flightSoundInstance = stopManagedBattleSound(missile.flightSoundInstance);
    });
}

function playSoundBomb() {
    playOneShot(soundBomb);
}

function playSoundCannon() {
    playOneShot(soundCannon);
}
// ==================== END SOUND EFFECTS ====================

// Canvas setup - PixiJS WebGL Renderer will use this canvas element    
const canvas = document.getElementById('gameCanvas');
const minimap = document.getElementById('minimap');
const minimapCtx = minimap.getContext('2d');

function getReconInstructionsElement() {
    let element = document.getElementById('reconInstructions');
    if (element) return element;

    element = document.createElement('div');
    element.id = 'reconInstructions';
    element.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%, -50%);background:rgba(120,135,148,0.92);padding:20px;border-radius:10px;color:white;display:none;font-size:18px;text-align:center;z-index:20;';
    element.innerHTML = '<strong>정찰기 출격 위치 지정</strong><br>클릭하여 정찰 목적지 설정<br><small>ESC로 취소</small>';
    const parent = canvas.parentElement || document.body;
    parent.appendChild(element);
    return element;
}

// PixiJS Application & Layer System
let pixiApp = null;
let worldContainer = null;
let mapLayer = null;
let landMaskLayer = null;
let buildingGfx = null;
let buildingSpriteLayer = null;
let unitLayer = null;
let effectsGfx = null;
let airstrikeLayer = null;
let fogLayer = null;
let overlayGfx = null;

// Sprite pool maps
const unitSpriteMap = new Map();   // unitId -> { container, mainGfx, hpBg, hpFg, labelGfx, selGfx, type, ... }
const texCache = new Map();        // src -> PIXI.Texture
let fogTexture = null;
let mapTexture = null;
let landMaskTexture = null;

function attachUnitSpriteEntry(entry) {
    if (!entry || !unitLayer || entry.container.parent === unitLayer) return;
    unitLayer.addChild(entry.container);
}

function detachUnitSpriteEntry(entry) {
    if (!entry || !entry.container.parent) return;
    entry.container.parent.removeChild(entry.container);
}

function destroyUnitSpriteEntry(entry) {
    if (!entry) return;
    detachUnitSpriteEntry(entry);
    entry.container.destroy({ children: true });
}

function getOrCreateTexture(image) {
    if (!image || !image.complete || !image.naturalWidth) return null;
    let tex = texCache.get(image.src);
    if (!tex) {
        tex = PIXI.Texture.from(image);
        texCache.set(image.src, tex);
    }
    return tex;
}

function getUnitImage(unitOrType) {
    const type = (typeof unitOrType === 'string') ? unitOrType : unitOrType.type;
    const unit = (typeof unitOrType === 'object') ? unitOrType : null;
    switch (type) {
        case 'battleship': return getBattleshipBodyImage(unit);
        case 'submarine': return submarineImageLoaded ? submarineImage : null;
        case 'cruiser':
            if (unit && unit.aegisMode && cruiserAegisImageLoaded) return cruiserAegisImage;
            return cruiserImageLoaded ? cruiserImage : null;
        case 'carrier': return carrierImageLoaded ? carrierImage : null;
        case 'assaultship': return assaultShipImageLoaded ? assaultShipImage : null;
        case 'frigate': return frigateImageLoaded ? frigateImage : null;
        case 'aircraft': return fighterImageLoaded ? fighterImage : null;
        case 'recon_aircraft': return reconAircraftImageLoaded ? reconAircraftImage : null;
        case 'destroyer': return destroyerImageLoaded ? destroyerImage : null;
        case 'missile_launcher':
            if (unit && unit.deployState === 'deployed') return thaadStage2ImageLoaded ? thaadStage2Image : null;
            if (unit && unit.deployState === 'deploying_stage2') return thaadStage2ImageLoaded ? thaadStage2Image : null;
            if (unit && unit.deployState === 'deploying_stage1') return thaadStage1ImageLoaded ? thaadStage1Image : null;
            if (unit && unit.deployState === 'undeploying_stage2') return thaadStage2ImageLoaded ? thaadStage2Image : null;
            if (unit && unit.deployState === 'undeploying_stage1') return thaadStage1ImageLoaded ? thaadStage1Image : null;
            return thaadImageLoaded ? thaadImage : null;
        default: return null;
    }
}

function getUnitRenderHeightMultiplier(unitOrType) {
    const type = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
    const unit = typeof unitOrType === 'object' ? unitOrType : null;
    if (type === 'aircraft' || type === 'recon_aircraft') return 2.5;
    if (type === 'missile_launcher') {
        const usesStage2 = unit && (unit.deployState === 'deployed'
            || unit.deployState === 'deploying_stage2'
            || unit.deployState === 'undeploying_stage2');
        if (!usesStage2) {
            return MISSILE_LAUNCHER_MOBILE_HEIGHT_MULTIPLIER;
        }
        // thaad2(7x23)가 thaad(7x16)보다 세로가 긴 만큼 heightMult를 키워서
        // 렌더링된 가로 너비가 이동 상태와 동일하게 보이도록 보정
        if (thaadImageLoaded && thaadStage2ImageLoaded
            && thaadImage.height > 0 && thaadStage2Image.height > 0) {
            return MISSILE_LAUNCHER_MOBILE_HEIGHT_MULTIPLIER * (thaadStage2Image.height / thaadImage.height);
        }
        return MISSILE_LAUNCHER_HEIGHT_MULTIPLIER;
    }
    return type === 'battleship' ? BATTLESHIP_BASE_HEIGHT_MULTIPLIER : 6.6;
}

function getUnitRenderAspectRatio(unitOrType, imageOverride = null) {
    const image = imageOverride || getUnitImage(unitOrType);
    const imageAspect = (image && image.width && image.height) ? (image.width / image.height) : null;
    return Number.isFinite(imageAspect) ? imageAspect : 0.25;
}

function getMissileLauncherStateLabel(unit) {
    if (!unit || unit.type !== 'missile_launcher') return '';
    if (unit.deployState === 'deployed') return '배치 완료';
    if (unit.deployState === 'undeploying_stage1' || unit.deployState === 'undeploying_stage2') return '배치 해제 중';
    if (unit.deployState === 'deploying_stage1' || unit.deployState === 'deploying_stage2') return '배치 중';
    return '이동식';
}

function syncImageUnitSprite(entry, unit, size) {
    if (!entry || !entry.mainSprite) return;
    const img = getUnitImage(unit);
    if (!img) return;
    const tex = getOrCreateTexture(img);
    if (!tex) return;
    if (entry.lastImageSrc !== img.src) {
        entry.mainSprite.texture = tex;
        entry.lastImageSrc = img.src;
    }
    const aspectRatio = getUnitRenderAspectRatio(unit, img);
    const baseHeight = size * getUnitRenderHeightMultiplier(unit);
    entry.mainSprite.width = baseHeight * aspectRatio;
    entry.mainSprite.height = baseHeight;
    entry.mainSprite.rotation = -Math.PI / 2;
}

function initPixiApp() {
    pixiApp = new PIXI.Application({
        view: canvas,
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: 0x1a3a5c,
        antialias: false,
        resolution: 1,
        autoDensity: false,
        powerPreference: 'high-performance',
    });
    pixiApp.ticker.stop(); // We manage our own render loop

    worldContainer = new PIXI.Container();
    pixiApp.stage.addChild(worldContainer);

    // Layers in draw order
    mapLayer = new PIXI.Sprite();
    mapLayer.visible = false;
    worldContainer.addChild(mapLayer);

    landMaskLayer = new PIXI.Sprite();
    landMaskLayer.alpha = IMAGE_LAND_MASK_ALPHA;
    landMaskLayer.visible = false;
    worldContainer.addChild(landMaskLayer);

    buildingGfx = new PIXI.Graphics();
    worldContainer.addChild(buildingGfx);

    buildingSpriteLayer = new PIXI.Container();
    worldContainer.addChild(buildingSpriteLayer);

    unitLayer = new PIXI.Container();
    unitLayer.sortableChildren = false;
    worldContainer.addChild(unitLayer);

    effectsGfx = new PIXI.Graphics();
    worldContainer.addChild(effectsGfx);

    airstrikeLayer = new PIXI.Container();
    worldContainer.addChild(airstrikeLayer);

    fogLayer = new PIXI.Sprite();
    fogLayer.visible = false;
    worldContainer.addChild(fogLayer);

    overlayGfx = new PIXI.Graphics();
    worldContainer.addChild(overlayGfx);
}

initPixiApp();

function resizeCanvas() {
    if (pixiApp) {
        pixiApp.renderer.resize(window.innerWidth, window.innerHeight);
    }
    minimap.width = 240;
    minimap.height = 240;
    clampCameraToMapBounds();
    minimapDirty = true;
    emitViewportUpdate(true);
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function getCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: clientX - rect.left,
        y: clientY - rect.top
    };
}

function canvasToWorld(canvasX, canvasY) {
    return {
        x: (canvasX - canvas.width / 2) / gameState.camera.zoom + gameState.camera.x,
        y: (canvasY - canvas.height / 2) / gameState.camera.zoom + gameState.camera.y
    };
}

function clampWorldPointToMap(x, y) {
    const map = gameState.map;
    if (!map) {
        return { x, y };
    }
    return {
        x: Math.max(0, Math.min(map.width, x)),
        y: Math.max(0, Math.min(map.height, y))
    };
}

function clampCameraToMapBounds() {
    const map = gameState.map;
    if (!map) return;

    const halfViewWidth = (canvas.width / gameState.camera.zoom) / 2;
    const halfViewHeight = (canvas.height / gameState.camera.zoom) / 2;

    let minX = halfViewWidth;
    let maxX = map.width - halfViewWidth;
    let minY = halfViewHeight;
    let maxY = map.height - halfViewHeight;

    if (minX > maxX) {
        minX = map.width / 2;
        maxX = map.width / 2;
    }
    if (minY > maxY) {
        minY = map.height / 2;
        maxY = map.height / 2;
    }

    gameState.camera.x = Math.max(minX, Math.min(maxX, gameState.camera.x));
    gameState.camera.y = Math.max(minY, Math.min(maxY, gameState.camera.y));
}

function getClientLoadScore() {
    const activeAirstrikes = Array.isArray(gameState.activeAirstrikes) ? gameState.activeAirstrikes.length : 0;
    return gameState.units.size
        + gameState.buildings.size
        + attackProjectiles.length
        + slbmMissiles.length
        + explosionEffects.length
        + (activeAirstrikes * 2);
}

function getClientLoadLevel() {
    const score = getClientLoadScore();
    if (score >= EXTREME_CLIENT_LOAD_SCORE) return 'extreme';
    if (score >= HIGH_CLIENT_LOAD_SCORE) return 'high';
    return 'normal';
}

function getClientLoadSettings() {
    return CLIENT_LOAD_SETTINGS[getClientLoadLevel()] || CLIENT_LOAD_SETTINGS.normal;
}

function getSampleStride(totalCount, maxSamples) {
    if (!Number.isFinite(maxSamples) || maxSamples <= 0 || totalCount <= maxSamples) {
        return 1;
    }
    return Math.max(1, Math.ceil(totalCount / maxSamples));
}

function emitViewportUpdate(force = false) {
    if (!socket || !gameState.map) return;

    const renderer = pixiApp ? pixiApp.renderer : null;
    const width = renderer ? renderer.width : (canvas.width || window.innerWidth);
    const height = renderer ? renderer.height : (canvas.height || window.innerHeight);
    if (!width || !height || !Number.isFinite(gameState.camera.x) || !Number.isFinite(gameState.camera.y)) {
        return;
    }
    if (!Number.isFinite(gameState.camera.zoom) || gameState.camera.zoom <= 0) {
        return;
    }

    const payload = {
        x: Math.round(gameState.camera.x * 10) / 10,
        y: Math.round(gameState.camera.y * 10) / 10,
        zoom: Math.round(gameState.camera.zoom * 1000) / 1000,
        width: Math.round(width),
        height: Math.round(height),
        revealAllBuildings: hasTemporaryFullMapReveal()
    };
    const signature = `${payload.x}:${payload.y}:${payload.zoom}:${payload.width}:${payload.height}:${payload.revealAllBuildings ? 1 : 0}`;
    const now = Date.now();

    if (!force) {
        if (signature === lastViewportSignature && (now - lastViewportEmitAt) < VIEWPORT_UPDATE_HEARTBEAT_MS) {
            return;
        }
        if (signature !== lastViewportSignature && (now - lastViewportEmitAt) < VIEWPORT_UPDATE_INTERVAL_MS) {
            return;
        }
    }

    socket.emit('viewportUpdate', payload);
    lastViewportEmitAt = now;
    lastViewportSignature = signature;
}

function getMapGridSize(map) {
    if (!map) return 0;
    if (Number.isInteger(map.gridSize) && map.gridSize > 0) {
        return map.gridSize;
    }
    if (Array.isArray(map.terrain)) {
        return map.terrain.length;
    }
    return 0;
}

function getMapCellSize(map) {
    if (!map) return 0;
    if (typeof map.cellSize === 'number' && map.cellSize > 0) {
        return map.cellSize;
    }
    const gridSize = getMapGridSize(map);
    if (!gridSize) return 0;
    return map.width / gridSize;
}

function hydrateClientMap(rawMap) {
    if (!rawMap) return null;
    const map = rawMap;

    map.gridSize = getMapGridSize(map);
    map.cellSize = getMapCellSize(map);

    const landCells = Array.isArray(map.landCells) ? map.landCells : [];
    map.landCells = landCells;
    map.landCellSet = new Set();

    if (map.gridSize > 0) {
        for (let i = 0; i < landCells.length; i++) {
            const cell = landCells[i];
            if (!Array.isArray(cell) || cell.length < 2) continue;
            const x = cell[0];
            const y = cell[1];
            if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
            if (x < 0 || y < 0 || x >= map.gridSize || y >= map.gridSize) continue;
            map.landCellSet.add(getFogKey(x, y, map.gridSize));
        }
    }

    return map;
}

function resetMapImageState() {
    mapImage = null;
    mapImagePath = null;
    mapImageLoaded = false;
    mapImageLoadFailed = false;
    landMaskCanvas = null;
    landMaskCacheKey = null;
}

function ensureMapImageLoaded() {
    if (!gameState.map) return;

    const desiredPath = gameState.map.imagePath || DEFAULT_MAP_IMAGE_PATH;
    if (mapImagePath === desiredPath && (mapImageLoaded || mapImageLoadFailed)) {
        return;
    }
    if (mapImagePath === desiredPath && mapImage && !mapImageLoaded && !mapImageLoadFailed) {
        return;
    }

    mapImagePath = desiredPath;
    mapImageLoaded = false;
    mapImageLoadFailed = false;
    mapImage = new Image();
    mapImage.decoding = 'async';
    mapImage.onload = () => {
        mapImageLoaded = true;
        minimapDirty = true;
    };
    mapImage.onerror = () => {
        mapImageLoadFailed = true;
        console.warn(`Map image load failed: ${desiredPath}. Falling back to plain water background.`);
    };
    mapImage.src = desiredPath;
}

function ensureLandMaskLoaded() {
    const map = gameState.map;
    if (!map) return;

    const gridSize = getMapGridSize(map);
    const landCells = Array.isArray(map.landCells) ? map.landCells : [];
    if (!gridSize || landCells.length === 0) return;

    const cacheKey = `${map.width}:${map.height}:${gridSize}:${landCells.length}`;
    if (landMaskCanvas && landMaskCacheKey === cacheKey) {
        return;
    }

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = gridSize;
    maskCanvas.height = gridSize;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.clearRect(0, 0, gridSize, gridSize);
    maskCtx.fillStyle = '#3d5a3d';

    for (let i = 0; i < landCells.length; i++) {
        const cell = landCells[i];
        if (!Array.isArray(cell) || cell.length < 2) continue;
        maskCtx.fillRect(cell[0], cell[1], 1, 1);
    }

    landMaskCanvas = maskCanvas;
    landMaskCacheKey = cacheKey;
}

function buildLandCellSnapshotFromMap(map) {
    if (!map) return null;

    const gridSize = getMapGridSize(map);
    const cellSize = getMapCellSize(map);
    if (!gridSize || !cellSize) return null;

    let landCells = Array.isArray(map.landCells) ? map.landCells : [];
    if (!landCells.length && Array.isArray(map.terrain)) {
        landCells = [];
        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                if (map.terrain[y][x] === 1) {
                    landCells.push([x, y]);
                }
            }
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        mapWidth: map.width,
        mapHeight: map.height,
        gridSize,
        cellSize,
        imagePath: map.imagePath || DEFAULT_MAP_IMAGE_PATH,
        landCells
    };
}

// Helper: get Korean name for unit type
function getUnitTypeName(typeOrUnit) {
    const unit = (typeOrUnit && typeof typeOrUnit === 'object') ? typeOrUnit : null;
    const type = unit ? unit.type : typeOrUnit;
    if (unit && isYamatoBattleshipUnit(unit)) {
        return YAMATO_ENTITY_NAME;
    }
    const names = {
        'worker': '일꾼',
        'destroyer': '구축함',
        'cruiser': '순양함',
        'battleship': '전함',
        'carrier': '항공모함',
        'assaultship': '강습상륙함',
        'submarine': '잠수함',
        'aircraft': '함재기',
        'recon_aircraft': '정찰기',
        'missile_launcher': '발사차량',
        'frigate': '호위함'
    };
    return names[type] || type;
}

function getUnitSelectionGroupName(type, units = []) {
    if (
        type === 'battleship'
        && Array.isArray(units)
        && units.length > 0
        && units.every(unit => isYamatoBattleshipUnit(unit))
    ) {
        return YAMATO_ENTITY_NAME;
    }
    return getUnitTypeName(type);
}

// Helper: get Korean name for building type
// Helper: get Korean name for building type
function getBuildingTypeName(type) {
    const names = {
        'headquarters': '사령부',
        'shipyard': '조선소',
        'naval_academy': '대형조선소',
        'carbase': '차량기지',
        'power_plant': '발전소',
        'missile_silo': '미사일 사일로',
        'defense_tower': '방어 타워'
    };
    return names[type] || type;
}

async function downloadLandCells() {
    let payload = null;

    try {
        const res = await fetch('/api/map/land-cells');
        if (res.ok) {
            payload = await res.json();
        }
    } catch (error) {
        console.warn('Failed to fetch /api/map/land-cells:', error);
    }

    if (!payload) {
        payload = buildLandCellSnapshotFromMap(gameState.map);
    }

    if (!payload) {
        alert('맵 데이터가 아직 없어 땅 좌표를 내보낼 수 없습니다.');
        return;
    }

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'land-cells.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

window.downloadLandCells = downloadLandCells;

// Mouse state
const mouse = {
    x: 0,
    y: 0,
    worldX: 0,
    worldY: 0,
    down: false,
    button: 0,
    startX: 0,
    startY: 0
};

// Input handling
canvas.addEventListener('mousedown', (e) => {
    isPointerInCanvas = true;
    const canvasPoint = getCanvasPoint(e.clientX, e.clientY);
    const worldPoint = canvasToWorld(canvasPoint.x, canvasPoint.y);

    mouse.down = true;
    mouse.button = e.button;
    mouse.startX = canvasPoint.x;
    mouse.startY = canvasPoint.y;
    
    if (e.button === 0) { // Left click
        const worldX = worldPoint.x;
        const worldY = worldPoint.y;
        
        if (assaultShipLoadMode === 'ship-target') {
            if (tryLoadSelectedUnitsIntoAssaultShip(worldX, worldY)) {
                setAssaultShipLoadMode(null);
            }
        } else if (assaultShipLoadMode === 'cargo-target') {
            if (tryLoadClickedUnitIntoSelectedAssaultShip(worldX, worldY)) {
                setAssaultShipLoadMode(null);
            }
        } else if (attackMode) {
            // In attack mode, left-click does attack-move to position
            const selectedUnits = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(canReceiveManualAttackOrders);
            
            if (selectedUnits.length > 0) {
                // Find target at click position (enemy unit or building)
                let targetId = null;
                let targetType = null;
                let targetName = '';
                
                gameState.units.forEach(unit => {
                    if (unit.userId !== gameState.userId) {
                        const dx = unit.x - worldX;
                        const dy = unit.y - worldY;
                        if (Math.sqrt(dx * dx + dy * dy) < 50) {
                            targetId = unit.id;
                            targetType = 'unit';
                            targetName = getUnitTypeName(unit);
                        }
                    }
                });
                
                if (!targetId) {
                    gameState.buildings.forEach(building => {
                        if (building.userId !== gameState.userId) {
                            const dx = building.x - worldX;
                            const dy = building.y - worldY;
                            const hitRadius = getBuildingHitboxHalfSize(building);
                            if (Math.sqrt(dx * dx + dy * dy) < hitRadius) {
                                targetId = building.id;
                                targetType = 'building';
                                targetName = getBuildingTypeName(building.type);
                            }
                        }
                    });
                }
                
                const unitIds = selectedUnits.map(u => u.id);
                // Lock these units into a command group
                unitIds.forEach(id => commandGroup.add(id));
                
                if (targetId) {
                    // Face units toward the attacked target
                    let tgtX = worldX, tgtY = worldY;
                    if (targetType === 'unit')     { const tu = gameState.units.get(targetId);    if (tu) { tgtX = tu.x; tgtY = tu.y; } }
                    else if (targetType === 'building') { const tb = gameState.buildings.get(targetId); if (tb) { tgtX = tb.x; tgtY = tb.y; } }
                    socket.emit('attackTarget', {
                        unitIds: unitIds,
                        targetId: targetId,
                        targetType: targetType
                    });
                    selectedUnits.forEach(u => { u.commandAngle = Math.atan2(tgtY - u.y, tgtX - u.x); });
                    attackTarget = { id: targetId, type: targetType, name: targetName };
                } else {
                    // Attack-move to position
                    socket.emit('attackMove', {
                        unitIds: unitIds,
                        targetX: worldX,
                        targetY: worldY
                    });
                    selectedUnits.forEach(u => { u.commandAngle = Math.atan2(worldY - u.y, worldX - u.x); });
                    attackTarget = null;
                }
            }
            
            setAttackMode(false);
        } else if (slbmTargetingMode) {
            const targetPoint = clampWorldPointToMap(worldX, worldY);
            const selectedSubs = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type === 'submarine');

            for (const sub of selectedSubs) {
                if (gameState.missiles > 0) {
                    socket.emit('submarineSLBM', {
                        submarineId: sub.id,
                        targetX: targetPoint.x,
                        targetY: targetPoint.y
                    });
                } else break;
            }
            slbmTargetingMode = false;
            canvas.style.cursor = 'crosshair';
            document.getElementById('slbmInstructions').style.display = 'none';
        } else if (airstrikeTargetingMode) {
            const targetPoint = clampWorldPointToMap(worldX, worldY);
            const selectedCarriers = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type === 'carrier' && (u.airstrikeReady || gameState.username === 'JsonParc'));
            
            if (selectedCarriers.length > 0 && socket) {
                socket.emit('launchAirstrike', {
                    unitId: selectedCarriers[0].id,
                    targetX: targetPoint.x,
                    targetY: targetPoint.y
                });
            }
            airstrikeTargetingMode = false;
            canvas.style.cursor = 'crosshair';
            document.getElementById('airstrikeInstructions').style.display = 'none';
        } else if (reconTargetingMode) {
            const targetPoint = clampWorldPointToMap(worldX, worldY);
            launchSelectedReconAircraft(targetPoint);
            reconTargetingMode = false;
            canvas.style.cursor = 'crosshair';
            const reconInstructions = document.getElementById('reconInstructions');
            if (reconInstructions) reconInstructions.style.display = 'none';
        } else if (mineTargetingMode) {
            const targetPoint = clampWorldPointToMap(worldX, worldY);
            const selectedDestroyers = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type === 'destroyer');
            
            if (selectedDestroyers.length > 0 && socket && canLayMineAtTarget(selectedDestroyers[0], targetPoint.x, targetPoint.y)) {
                socket.emit('layMine', {
                    unitId: selectedDestroyers[0].id,
                    targetX: targetPoint.x,
                    targetY: targetPoint.y
                });
            }
            mineTargetingMode = false;
            canvas.style.cursor = 'crosshair';
            document.getElementById('mineInstructions').style.display = 'none';
        } else if (gameState.buildMode) {
            // Check if workers are selected - workers build directly
            const selectedWorkers = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type === 'worker');
            
            if (selectedWorkers.length > 0) {
                // Workers place and build the building
                socket.emit('workerBuild', {
                    workerIds: selectedWorkers.map(w => w.id),
                    buildingType: gameState.buildMode,
                    x: worldX,
                    y: worldY
                });
            } else {
                // Direct building placement (for non-workers or future features)
                socket.emit('buildBuilding', {
                    type: gameState.buildMode,
                    x: worldX,
                    y: worldY
                });
            }
            
            gameState.buildMode = null;
            canvas.style.cursor = 'crosshair';
        } else {
            // Start selection box
            gameState.selectionBox = { startX: worldX, startY: worldY, endX: worldX, endY: worldY };
        }
    }
});

canvas.addEventListener('mousemove', (e) => {
    const canvasPoint = getCanvasPoint(e.clientX, e.clientY);
    const worldPoint = canvasToWorld(canvasPoint.x, canvasPoint.y);
    mouse.x = canvasPoint.x;
    mouse.y = canvasPoint.y;
    mouse.worldX = worldPoint.x;
    mouse.worldY = worldPoint.y;
    
    if (mouse.down && mouse.button === 0 && gameState.selectionBox) {
        gameState.selectionBox.endX = mouse.worldX;
        gameState.selectionBox.endY = mouse.worldY;
    }
    
    // Pan with middle mouse
    if (mouse.down && mouse.button === 1) {
        const dx = e.movementX / gameState.camera.zoom;
        const dy = e.movementY / gameState.camera.zoom;
        gameState.camera.x -= dx;
        gameState.camera.y -= dy;
        clampCameraToMapBounds();
        minimapDirty = true;
        emitViewportUpdate(false);
    }
});

canvas.addEventListener('mouseup', (e) => {
    if (e.button === 0 && gameState.selectionBox) {
        // Complete selection
        selectUnits();
        gameState.selectionBox = null;
    } else if (e.button === 2) { // Right click - move or attack-target
        e.preventDefault();
        if (assaultShipLoadMode) {
            setAssaultShipLoadMode(null);
            return;
        }
        const canvasPoint = getCanvasPoint(e.clientX, e.clientY);
        const worldPoint = canvasToWorld(canvasPoint.x, canvasPoint.y);
        const worldX = worldPoint.x;
        const worldY = worldPoint.y;
        
        if (gameState.selection.size > 0) {
            const selectedUnits = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(canReceiveManualOrders);
            
            if (selectedUnits.length > 0) {
                const unitIds = selectedUnits.map(u => u.id);
                
                if (attackMode) {
                    // Attack mode + right-click: find target at click or attack-move
                    let targetId = null;
                    let targetType = null;
                    let targetName = '';
                    
                    gameState.units.forEach(unit => {
                        if (unit.userId !== gameState.userId) {
                            const dx = unit.x - worldX;
                            const dy = unit.y - worldY;
                            if (Math.sqrt(dx * dx + dy * dy) < 60) {
                                targetId = unit.id;
                                targetType = 'unit';
                                targetName = getUnitTypeName(unit);
                            }
                        }
                    });
                    
                    if (!targetId) {
                        gameState.buildings.forEach(building => {
                            if (building.userId !== gameState.userId) {
                                const dx = building.x - worldX;
                                const dy = building.y - worldY;
                                const hitRadius = getBuildingHitboxHalfSize(building);
                                if (Math.sqrt(dx * dx + dy * dy) < hitRadius) {
                                    targetId = building.id;
                                    targetType = 'building';
                                    targetName = getBuildingTypeName(building.type);
                                }
                            }
                        });
                    }
                    
                    // Lock units into command group
                    unitIds.forEach(id => commandGroup.add(id));
                    
                    if (targetId) {
                        let tgtX = worldX, tgtY = worldY;
                        if (targetType === 'unit')     { const tu = gameState.units.get(targetId);    if (tu) { tgtX = tu.x; tgtY = tu.y; } }
                        else if (targetType === 'building') { const tb = gameState.buildings.get(targetId); if (tb) { tgtX = tb.x; tgtY = tb.y; } }
                        socket.emit('attackTarget', {
                            unitIds: unitIds,
                            targetId: targetId,
                            targetType: targetType
                        });
                        selectedUnits.forEach(u => { u.commandAngle = Math.atan2(tgtY - u.y, tgtX - u.x); });
                        attackTarget = { id: targetId, type: targetType, name: targetName };
                    } else {
                        socket.emit('attackMove', {
                            unitIds: unitIds,
                            targetX: worldX,
                            targetY: worldY
                        });
                        selectedUnits.forEach(u => { u.commandAngle = Math.atan2(worldY - u.y, worldX - u.x); });
                        attackTarget = null;
                    }
                    
                    setAttackMode(false);
                } else {
                    // Normal right-click: move
                    unitIds.forEach(id => commandGroup.add(id));
                    socket.emit('moveUnits', {
                        unitIds: unitIds,
                        targetX: worldX,
                        targetY: worldY
                    });
                    selectedUnits.forEach(u => { u.commandAngle = Math.atan2(worldY - u.y, worldX - u.x); });
                    attackTarget = null;
                }
            }
        }
    }
    
    mouse.down = false;
});

canvas.addEventListener('mouseenter', () => {
    isPointerInCanvas = true;
});

canvas.addEventListener('mouseleave', () => {
    isPointerInCanvas = false;
    mouse.down = false;
    mouse.x = canvas.width / 2;
    mouse.y = canvas.height / 2;
});

window.addEventListener('blur', () => {
    isPointerInCanvas = false;
    mouse.down = false;
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Zoom
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    gameState.camera.zoom *= zoomFactor;
    gameState.camera.zoom = Math.max(0.3, Math.min(2, gameState.camera.zoom));
    clampCameraToMapBounds();
    minimapDirty = true;
    emitViewportUpdate(false);
});

// Keyboard controls
const keys = {};

function cancelActiveModes() {
    gameState.buildMode = null;
    gameState.workerMode = null;
    slbmTargetingMode = false;
    mineTargetingMode = false;
    airstrikeTargetingMode = false;
    reconTargetingMode = false;
    setAssaultShipLoadMode(null);
    setAttackMode(false);
    document.getElementById('slbmInstructions').style.display = 'none';
    document.getElementById('airstrikeInstructions').style.display = 'none';
    document.getElementById('mineInstructions').style.display = 'none';
    const reconInstructions = document.getElementById('reconInstructions');
    if (reconInstructions) reconInstructions.style.display = 'none';
}

window.addEventListener('keydown', (e) => {
    keys[e.key] = true;
    
    // Cancel all modes with Escape
    if (e.key === 'Escape') {
        cancelActiveModes();
    }
    
    // Attack mode - 'a'
    if ((e.key === 'a' || e.key === 'A') && gameState.selection.size > 0) {
        const selectedOwnedUnits = getSelectedOwnedUnits();
        const attackUnits = selectedOwnedUnits.filter(canReceiveManualAttackOrders);
        if (attackUnits.length > 0) {
            cancelActiveModes();
            setAttackMode(true);
            return;
        }

        if (selectedOwnedUnits.length > 0 && selectedOwnedUnits.length === getSelectedOwnedAssaultShips().length) {
            const readyShips = getSelectedOwnedAssaultShipsWithCapacity();
            if (readyShips.length > 0) {
                cancelActiveModes();
                setAssaultShipLoadMode('cargo-target');
            }
            return;
        }

        if (selectedOwnedUnits.length > 0 && selectedOwnedUnits.length === getSelectedOwnedAssaultShipLoadableUnits().length) {
            cancelActiveModes();
            setAssaultShipLoadMode('ship-target');
        }
    }
    
    // 기존 자원 채집 기능 제거 - 발전소가 자동으로 에너지 생산
    
    // Worker build hotkey - 'b' (build grid is now always shown in skill panel when workers selected)
    if ((e.key === 'b' || e.key === 'B') && gameState.selection.size > 0) {
        // B key no longer needed to toggle menu, build grid is always visible in skill panel
    }
    
    // Hold position - 'h'
    if ((e.key === 'h' || e.key === 'H') && !e.repeat) {
        const selectedUnits = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(unit => canReceiveManualOrders(unit) && unit.type !== 'missile_launcher');
        if (selectedUnits.length > 0 && socket) {
            cancelActiveModes();
            attackTarget = null;
            selectedUnits.forEach(unit => {
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
            socket.emit('holdPosition', { unitIds: selectedUnits.map(unit => unit.id) });
            updateSelectionInfo();
            return;
        }
    }
});

window.addEventListener('keyup', (e) => {
    keys[e.key] = false;
});

// Camera movement with edge panning + arrow keys
function updateCamera(deltaMs) {
    const edgeSize = 32;
    const speed = (CAMERA_EDGE_PAN_SPEED * (deltaMs / 1000)) / gameState.camera.zoom;
    const prevX = gameState.camera.x;
    const prevY = gameState.camera.y;
    
    // Arrow key panning (always active)
    if (keys['ArrowLeft']) gameState.camera.x -= speed;
    if (keys['ArrowRight']) gameState.camera.x += speed;
    if (keys['ArrowUp']) gameState.camera.y -= speed;
    if (keys['ArrowDown']) gameState.camera.y += speed;
    
    // Edge panning (only when pointer in canvas)
    if (isPointerInCanvas) {
        if (mouse.x < edgeSize) gameState.camera.x -= speed;
        if (mouse.x > canvas.width - edgeSize) gameState.camera.x += speed;
        if (mouse.y < edgeSize + 50) gameState.camera.y -= speed; // +50 for HUD
        if (mouse.y > canvas.height - edgeSize) gameState.camera.y += speed;
    }
    
    // Clamp camera so viewport never escapes map bounds.
    clampCameraToMapBounds();
    
    if (Math.abs(gameState.camera.x - prevX) > 0.5 || Math.abs(gameState.camera.y - prevY) > 0.5) {
        minimapDirty = true;
        emitViewportUpdate(false);
    }
}

function isAirUnitType(unitOrType) {
    const type = typeof unitOrType === 'string' ? unitOrType : unitOrType?.type;
    return type === 'aircraft' || type === 'recon_aircraft';
}

function getSelectedOwnedUnits() {
    return Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(unit => unit && unit.userId === gameState.userId);
}

function getSelectedOwnedCarriers() {
    return getSelectedOwnedUnits().filter(unit => unit.type === 'carrier');
}

function getSelectedOwnedAssaultShips() {
    return getSelectedOwnedUnits().filter(unit => unit.type === 'assaultship');
}

function getAssaultShipLoadedUnitCount(ship) {
    return Array.isArray(ship?.loadedMissileLaunchers) ? ship.loadedMissileLaunchers.length : 0;
}

function getSelectedOwnedMissileLaunchers() {
    return getSelectedOwnedUnits().filter(unit => unit.type === 'missile_launcher');
}

function canUnitBoardAssaultShip(unit) {
    if (!unit || unit.userId !== gameState.userId) return false;
    if (unit.type === 'worker') return true;
    return unit.type === 'missile_launcher' && (!unit.deployState || unit.deployState === 'mobile');
}

function getSelectedOwnedAssaultShipLoadableUnits() {
    return getSelectedOwnedUnits().filter(canUnitBoardAssaultShip);
}

function hasOnlyOwnedMissileLaunchersSelected() {
    const selectedUnits = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(Boolean);
    return selectedUnits.length > 0 && selectedUnits.every(unit => unit.userId === gameState.userId && unit.type === 'missile_launcher');
}

function hasOnlyOwnedAssaultShipLoadableUnitsSelected() {
    const selectedUnits = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(Boolean);
    return selectedUnits.length > 0 && selectedUnits.every(canUnitBoardAssaultShip);
}

function getSelectedOwnedAssaultShipsWithCapacity() {
    return getSelectedOwnedAssaultShips().filter(ship => getAssaultShipLoadedUnitCount(ship) < ASSAULT_SHIP_MAX_LAUNCHERS);
}

function getDeployableMissileLaunchers() {
    return getSelectedOwnedMissileLaunchers().filter(unit => !unit.deployState || unit.deployState === 'mobile');
}

function getUndeployableMissileLaunchers() {
    return getSelectedOwnedMissileLaunchers().filter(unit => unit.deployState === 'deployed');
}

function canReceiveManualOrders(unit) {
    return !!unit
        && unit.userId === gameState.userId
        && unit.type !== 'recon_aircraft'
        && (unit.type !== 'missile_launcher' || !unit.deployState || unit.deployState === 'mobile');
}

function canReceiveManualAttackOrders(unit) {
    return canReceiveManualOrders(unit) && unit.type !== 'worker' && unit.type !== 'missile_launcher' && unit.type !== 'assaultship';
}

function hasOnlyOwnedCarriersSelected() {
    const selectedUnits = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(Boolean);
    return selectedUnits.length > 0 && selectedUnits.every(unit => unit.userId === gameState.userId && unit.type === 'carrier');
}

function hasOnlyOwnedAssaultShipsSelected() {
    const selectedUnits = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(Boolean);
    return selectedUnits.length > 0 && selectedUnits.every(unit => unit.userId === gameState.userId && unit.type === 'assaultship');
}

function canUnloadFromAssaultShip(ship) {
    if (!ship || ship.type !== 'assaultship') return false;
    if (getAssaultShipLoadedUnitCount(ship) <= 0) return false;
    for (let radius = 120; radius <= ASSAULT_SHIP_LAND_RADIUS; radius += 40) {
        for (let i = 0; i < 16; i++) {
            const angle = (i / 16) * Math.PI * 2;
            if (isLandAtWorldPosition(ship.x + Math.cos(angle) * radius, ship.y + Math.sin(angle) * radius)) {
                return true;
            }
        }
    }
    return false;
}

function getUnloadReadyAssaultShips() {
    return getSelectedOwnedAssaultShips().filter(canUnloadFromAssaultShip);
}

function getAssaultShipLoadableUnitSummary(units) {
    const workerCount = units.filter(unit => unit.type === 'worker').length;
    const launcherCount = units.filter(unit => unit.type === 'missile_launcher').length;
    const parts = [];
    if (workerCount > 0) parts.push(`일꾼 ${workerCount}`);
    if (launcherCount > 0) parts.push(`발사차량 ${launcherCount}`);
    return parts.join(' / ') || `유닛 ${units.length}`;
}

function showAssaultShipLoadUnitsSkill(units, options = {}) {
    const { disabled = false, description = '' } = options;
    const slot4 = document.getElementById('skillSlot4');
    slot4.style.display = 'flex';
    document.getElementById('skillBtn4').textContent = '🛶 상륙함 탑승';
    document.getElementById('skillBtn4').className = 'skill-btn' + (disabled ? ' disabled' : '');
    document.getElementById('skillDesc4').textContent = description || `${getAssaultShipLoadableUnitSummary(units)} | 클릭 후 강습상륙함을 지정하면 탑승합니다`;
}

function showAssaultShipPickupSkill(ships) {
    const readyShips = ships.filter(ship => getAssaultShipLoadedUnitCount(ship) < ASSAULT_SHIP_MAX_LAUNCHERS);
    const slot4 = document.getElementById('skillSlot4');
    slot4.style.display = 'flex';
    document.getElementById('skillBtn4').textContent = '📥 유닛 탑승';
    document.getElementById('skillBtn4').className = 'skill-btn' + (readyShips.length > 0 ? '' : ' disabled');
    document.getElementById('skillDesc4').textContent = readyShips.length > 0
        ? `선택 상륙함 ${readyShips.length}척 | 클릭 후 일꾼/이동식 발사차량을 탑승시킵니다`
        : '선택된 강습상륙함의 적재 공간이 모두 가득 찼습니다';
}

function getUnitSelectionPriority(type) {
    return UNIT_SELECTION_PRIORITY[type] || 0;
}

function getSquadDisplayNumber(squadId) {
    // Get all own squad IDs sorted, return 1-based index
    const allSquadIds = [...gameState.squads.keys()].filter(sid => {
        const sq = gameState.squads.get(sid);
        if (!sq || !sq.unitIds || sq.unitIds.length === 0) return false;
        const firstUnit = gameState.units.get(sq.unitIds[0]);
        return firstUnit && firstUnit.userId === gameState.userId;
    }).sort((a, b) => a - b);
    const idx = allSquadIds.indexOf(squadId);
    return idx >= 0 ? idx + 1 : 0;
}

function getHighestPrioritySelectedUnitType(units) {
    let bestType = null;
    let bestPriority = -Infinity;
    units.forEach(unit => {
        const priority = getUnitSelectionPriority(unit.type);
        if (priority > bestPriority) {
            bestPriority = priority;
            bestType = unit.type;
        }
    });
    return bestType;
}

function getDisplayedUnitDamageValue(unit) {
    if (!unit) return 0;
    if (unit.type === 'carrier' || unit.type === 'assaultship') return 0;
    if (unit.type === 'battleship' && unit.battleshipAegisMode) return 7;
    if (unit.type === 'cruiser' && unit.aegisMode) return 25;
    if (unit.type === 'cruiser' && unit.isIsolated) return (unit.damage || 0) * 2;
    if (unit.type === 'battleship' && unit.aimedShot) return (unit.damage || 0) * 2;
    return unit.damage || 0;
}

function getSelectedOwnedHighestPriorityUnitType() {
    return getHighestPrioritySelectedUnitType(getSelectedOwnedUnits());
}

function getBattleshipCombatStanceSpeedMultiplier(unit) {
    const stacks = Math.max(0, unit?.combatStanceStacks || 0);
    return Math.pow(BATTLESHIP_COMBAT_STANCE_ATTACK_SPEED_MULTIPLIER, stacks);
}

function showBattleshipCombatStanceSkill(units) {
    const battleships = units.filter(unit => unit.type === 'battleship' && unit.userId === gameState.userId);
    if (battleships.length <= 0) return;
    const stanceEligibleBattleships = battleships;
    const comboReadyCount = battleships.filter(unit => unit.battleshipModeComboUnlocked).length;
    const slot2 = document.getElementById('skillSlot2');
    slot2.style.display = 'flex';
    const activeCount = stanceEligibleBattleships.filter(unit => unit.combatStanceActive).length;
    const maxStacks = stanceEligibleBattleships.reduce((max, unit) => Math.max(max, unit.combatStanceStacks || 0), 0);
    const maxSpeedMultiplier = stanceEligibleBattleships.reduce((max, unit) => Math.max(max, getBattleshipCombatStanceSpeedMultiplier(unit)), 1);
    const hasEligibleBattleships = stanceEligibleBattleships.length > 0;
    document.getElementById('skillBtn2').textContent = activeCount > 0 ? '⚔️ 전투태세 (활성)' : '⚔️ 전투태세';
    document.getElementById('skillBtn2').className = hasEligibleBattleships
        ? ('skill-btn' + (activeCount > 0 ? ' skill-active' : ''))
        : 'skill-btn disabled';
    document.getElementById('skillDesc2').className = 'skill-desc';

    if (battleships.length === 1) {
        document.getElementById('skillDesc2').textContent = activeCount > 0
            ? `현재 중첩 ${maxStacks} | 공속 x${maxSpeedMultiplier.toFixed(2)} | 공격마다 현재 체력 10% 소모 | 종료 시 현재 체력 10% 소모 후 원래 공속 복귀`
            : '활성 후 공격할 때마다 현재 체력 10% 소모, 공속 10%씩 누적 증가. 종료 시 현재 체력 10% 소모 후 원래 공속으로 복귀';
        if (comboReadyCount > 0) {
            document.getElementById('skillDesc2').textContent += ' | 이지스와 동시 운용 가능';
        }
        return;
    }
    document.getElementById('skillDesc2').textContent = activeCount > 0
        ? `활성 ${activeCount}/${stanceEligibleBattleships.length}척 | 최고 중첩 ${maxStacks} | 최고 공속 x${maxSpeedMultiplier.toFixed(2)}`
        : (stanceEligibleBattleships.length === battleships.length
            ? '선택 전함 공격마다 현재 체력 10% 소모, 공속 10%씩 누적 증가. 종료 시 현재 체력 10% 소모 후 원래 공속 복귀'
            : '이지스 모드가 아닌 선택 전함만 전투태세를 사용함');
    if (comboReadyCount > 0) {
        document.getElementById('skillDesc2').textContent += ` | 동시 운용 해금 ${comboReadyCount}척`;
    }
}

function showBattleshipAegisSkill(units) {
    const battleships = units.filter(unit => unit.type === 'battleship' && unit.userId === gameState.userId);
    if (battleships.length <= 0) return;
    const comboReadyCount = battleships.filter(unit => unit.battleshipModeComboUnlocked).length;
    const slot6 = document.getElementById('skillSlot6');
    slot6.style.display = 'flex';
    const activeCount = battleships.filter(unit => unit.battleshipAegisMode).length;
    document.getElementById('skillBtn6').textContent = activeCount > 0 ? '🛡️ 이지스 모드 (활성)' : '🛡️ 이지스 모드';
    document.getElementById('skillBtn6').className = 'skill-btn' + (activeCount > 0 ? ' skill-active' : '');
    document.getElementById('skillDesc6').className = 'skill-desc';
    if (battleships.length === 1) {
        document.getElementById('skillDesc6').textContent = activeCount > 0
            ? '사거리·시야 x1.5 / 각 포탑 0.48초 연사 / 분산추적 / 발당 7 / 받는 피해 40% 증가'
            : '활성 시 사거리·시야 1.5배, 각 포탑이 독립 추적하며 0.48초마다 발당 7 공격, 대신 받는 피해 40% 증가';
        if (comboReadyCount > 0) {
            document.getElementById('skillDesc6').textContent += ' | 전투태세와 동시 운용 가능';
        }
        return;
    }
    document.getElementById('skillDesc6').textContent = activeCount > 0
        ? `활성 ${activeCount}/${battleships.length}척 | 사거리·시야 x1.5 / 각 포탑 독립 추적 / 발당 7 / 받는 피해 40% 증가`
        : '선택 전함 포탑이 독립 추적하며 0.48초 연사, 발당 7, 사거리·시야 1.5배, 받는 피해 40% 증가';
    if (comboReadyCount > 0) {
        document.getElementById('skillDesc6').textContent += ` | 동시 운용 해금 ${comboReadyCount}척`;
    }
}

function showFrigateEngineOverdriveSkill(units) {
    const frigates = units.filter(unit => unit.type === 'frigate' && unit.userId === gameState.userId);
    if (frigates.length <= 0) return;
    const slot6 = document.getElementById('skillSlot6');
    slot6.style.display = 'flex';
    const activeCount = frigates.filter(unit => unit.engineOverdriveActive).length;
    const highestEvasionPercent = frigates.reduce((max, unit) => {
        const evasionRatio = Math.max(0, Math.min(FRIGATE_ENGINE_OVERDRIVE_MAX_EVASION, unit.evasionChance || 0));
        return Math.max(max, Math.round(evasionRatio * 100));
    }, 0);
    document.getElementById('skillBtn6').textContent = activeCount > 0 ? '🔥 엔진 폭주 (활성)' : '🔥 엔진 폭주';
    document.getElementById('skillBtn6').className = 'skill-btn' + (activeCount > 0 ? ' skill-active' : '');
    document.getElementById('skillDesc6').className = 'skill-desc';
    if (frigates.length === 1) {
        document.getElementById('skillDesc6').textContent = activeCount > 0
            ? `초당 최대 체력 10% 소모 | 속도 +10% | 회피 ${highestEvasionPercent}% (최대 80%)`
            : '활성 중 초당 최대 체력 10% 소모, 속도 +10%, 잃은 체력만큼 회피 증가 (최대 80%)';
        return;
    }
    document.getElementById('skillDesc6').textContent = activeCount > 0
        ? `활성 ${activeCount}/${frigates.length}척 | 속도 +10% | 최고 회피 ${highestEvasionPercent}%`
        : '선택 호위함이 초당 최대 체력 10%를 소모하며 속도 +10%, 잃은 체력만큼 회피 증가 (최대 80%)';
}

function getReadyReconCarriers() {
    return getSelectedOwnedCarriers().filter(carrier => ((carrier.reconAircraft || []).length > 0));
}

function launchSelectedReconAircraft(targetPoint) {
    if (!socket) return 0;
    const readyCarriers = getReadyReconCarriers();
    readyCarriers.forEach(carrier => {
        socket.emit('launchReconAircraft', {
            unitId: carrier.id,
            targetX: targetPoint.x,
            targetY: targetPoint.y
        });
    });
    return readyCarriers.length;
}

function getUnitSelectionBaseSize(unit) {
    return unit.type === 'worker'
        ? 40
        : (unit.type === 'mine'
            ? 40
            : (unit.type === 'missile_launcher'
                ? MISSILE_LAUNCHER_SELECTION_SIZE
            : (unit.type === 'recon_aircraft'
                ? 60
                : (unit.type === 'aircraft'
                    ? 20
                    : (unit.type === 'frigate' ? 35 : (unit.type === 'destroyer' ? 45 : 60))))));
}

function getUnitDisplayPosition(unit) {
    return {
        x: unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x,
        y: unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y
    };
}

function isUnitVisibleToPlayer(unit) {
    if (!unit) return false;
    if (hasTemporaryFullMapReveal()) return true;
    if (unit.type === 'submarine' && unit.userId !== gameState.userId && !unit.isDetected) return false;
    if (unit.type === 'mine' && unit.userId !== gameState.userId && !unit.isDetected) return false;
    const { x, y } = getUnitDisplayPosition(unit);
    if (unit.userId !== gameState.userId && !isPositionVisible(x, y)) return false;
    return true;
}

function isPointInsideUnitHitbox(unit, worldX, worldY) {
    const baseSize = getUnitSelectionBaseSize(unit);
    const { x, y } = getUnitDisplayPosition(unit);
    const dx = worldX - x;
    const dy = worldY - y;

    if (unit.type === 'worker' || unit.type === 'mine') {
        return Math.sqrt(dx * dx + dy * dy) <= baseSize;
    }

    const heightMult = getUnitRenderHeightMultiplier(unit);
    const img = getUnitImage(unit);
    const aspectRatio = getUnitRenderAspectRatio(unit, img);
    const semiMajor = (baseSize * heightMult) / 2;
    const semiMinor = (baseSize * heightMult * aspectRatio) / 2;
    const angle = unit.displayAngle !== undefined ? unit.displayAngle : 0;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    return (localX * localX) / (semiMajor * semiMajor) + (localY * localY) / (semiMinor * semiMinor) <= 1;
}

function findInspectableEnemyUnitAt(worldX, worldY) {
    let clickedUnitId = null;
    let closestDistanceSq = Infinity;

    gameState.units.forEach((unit, unitId) => {
        if (unit.userId === gameState.userId) return;
        if (!isUnitVisibleToPlayer(unit)) return;
        if (!isPointInsideUnitHitbox(unit, worldX, worldY)) return;

        const { x, y } = getUnitDisplayPosition(unit);
        const dx = worldX - x;
        const dy = worldY - y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            clickedUnitId = unitId;
        }
    });

    return clickedUnitId;
}

function findOwnedUnitAt(worldX, worldY, predicate = null) {
    let clickedUnitId = null;
    let closestDistanceSq = Infinity;

    gameState.units.forEach((unit, unitId) => {
        if (unit.userId !== gameState.userId) return;
        if (predicate && !predicate(unit)) return;
        if (!isPointInsideUnitHitbox(unit, worldX, worldY)) return;

        const { x, y } = getUnitDisplayPosition(unit);
        const dx = worldX - x;
        const dy = worldY - y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            clickedUnitId = unitId;
        }
    });

    return clickedUnitId;
}

function tryLoadSelectedUnitsIntoAssaultShip(clickX, clickY) {
    if (!socket) return false;
    const selectedOwnedUnits = getSelectedOwnedUnits();
    const loadableSelection = getSelectedOwnedAssaultShipLoadableUnits();
    if (selectedOwnedUnits.length <= 0 || loadableSelection.length !== selectedOwnedUnits.length) return false;
    const assaultShipId = findOwnedUnitAt(clickX, clickY, unit => unit.type === 'assaultship');
    if (!assaultShipId) return false;
    const ship = gameState.units.get(assaultShipId);
    if (!ship) return false;
    const remainingCapacity = ASSAULT_SHIP_MAX_LAUNCHERS - getAssaultShipLoadedUnitCount(ship);
    if (remainingCapacity <= 0) return false;

    const loadableUnits = loadableSelection.filter(unit => {
        const dx = unit.x - ship.x;
        const dy = unit.y - ship.y;
        return (dx * dx) + (dy * dy) <= ASSAULT_SHIP_LOAD_RADIUS * ASSAULT_SHIP_LOAD_RADIUS;
    }).slice(0, remainingCapacity);
    if (loadableUnits.length <= 0) return false;

    socket.emit('loadUnitsToAssaultShip', {
        shipId: assaultShipId,
        unitIds: loadableUnits.map(unit => unit.id)
    });

    gameState.selection.clear();
    gameState.selection.add(assaultShipId);
    gameState.inspectedUnitId = null;
    commandGroup.clear();
    attackTarget = null;
    updateSelectionInfo();
    return true;
}

function findBestSelectedAssaultShipForUnit(unit) {
    let bestShip = null;
    let bestDistanceSq = Infinity;
    getSelectedOwnedAssaultShipsWithCapacity().forEach(ship => {
        const dx = unit.x - ship.x;
        const dy = unit.y - ship.y;
        const distanceSq = (dx * dx) + (dy * dy);
        if (distanceSq > ASSAULT_SHIP_LOAD_RADIUS * ASSAULT_SHIP_LOAD_RADIUS) return;
        if (distanceSq < bestDistanceSq) {
            bestDistanceSq = distanceSq;
            bestShip = ship;
        }
    });
    return bestShip;
}

function tryLoadClickedUnitIntoSelectedAssaultShip(clickX, clickY) {
    if (!socket) return false;
    const targetUnitId = findOwnedUnitAt(clickX, clickY, canUnitBoardAssaultShip);
    if (!targetUnitId) return false;
    const targetUnit = gameState.units.get(targetUnitId);
    if (!targetUnit) return false;
    const ship = findBestSelectedAssaultShipForUnit(targetUnit);
    if (!ship) return false;
    socket.emit('loadUnitsToAssaultShip', {
        shipId: ship.id,
        unitIds: [targetUnit.id]
    });
    gameState.inspectedUnitId = null;
    attackTarget = null;
    updateSelectionInfo();
    return true;
}

function getInspectedUnit() {
    if (!gameState.inspectedUnitId) return null;
    const unit = gameState.units.get(gameState.inspectedUnitId);
    if (!isUnitVisibleToPlayer(unit)) {
        gameState.inspectedUnitId = null;
        return null;
    }
    return unit;
}

function getPortraitSecretWorkerUnit() {
    const bottomPanel = document.getElementById('bottomPanel');
    if (!bottomPanel || !bottomPanel.classList.contains('active')) return null;

    const inspectedUnit = getInspectedUnit();
    if (inspectedUnit && inspectedUnit.userId === gameState.userId && inspectedUnit.type === 'worker' && gameState.selection.size === 0) {
        return inspectedUnit;
    }

    const selectedUnits = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u !== undefined);
    if (selectedUnits.length !== 1) return null;

    const unit = selectedUnits[0];
    if (!unit || unit.userId !== gameState.userId || unit.type !== 'worker') return null;
    return unit;
}

function getPortraitSecretBattleshipUnit() {
    const bottomPanel = document.getElementById('bottomPanel');
    if (!bottomPanel || !bottomPanel.classList.contains('active')) return null;

    const inspectedUnit = getInspectedUnit();
    if (inspectedUnit && inspectedUnit.userId === gameState.userId && inspectedUnit.type === 'battleship' && gameState.selection.size === 0) {
        return inspectedUnit;
    }

    const selectedUnits = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'battleship');
    if (selectedUnits.length !== 1) return null;
    return selectedUnits[0];
}

function selectUnits() {
    const box = gameState.selectionBox;
    const minX = Math.min(box.startX, box.endX);
    const maxX = Math.max(box.startX, box.endX);
    const minY = Math.min(box.startY, box.endY);
    const maxY = Math.max(box.startY, box.endY);
    
    // Check if this is a click (small box) vs drag selection
    const isClick = Math.abs(box.endX - box.startX) < 10 && Math.abs(box.endY - box.startY) < 10;
    const clickX = (box.startX + box.endX) / 2;
    const clickY = (box.startY + box.endY) / 2;
    
    // If click lands on a building, check if we should preserve current unit selection
    if (isClick) {
        if (tryLoadSelectedUnitsIntoAssaultShip(clickX, clickY)) {
            return;
        }

        let clickedBuilding = null;
        gameState.buildings.forEach((building, buildingId) => {
            if (building.userId === gameState.userId) {
                const buildingHalfSize = getBuildingHitboxHalfSize(building);
                if (clickX >= building.x - buildingHalfSize && clickX <= building.x + buildingHalfSize &&
                    clickY >= building.y - buildingHalfSize && clickY <= building.y + buildingHalfSize) {
                    clickedBuilding = buildingId;
                }
            }
        });
        
        // If we clicked a building and have units with active commands, 
        // just focus the building for production UI without deselecting units
        if (clickedBuilding !== null) {
            // Store previous unit selection for command persistence
            const prevUnitSelection = new Set();
            gameState.selection.forEach(id => {
                if (gameState.units.has(id)) prevUnitSelection.add(id);
            });
            
            gameState.inspectedUnitId = null;
            gameState.selection.clear();
            gameState.selection.add(clickedBuilding);
            
            // Keep units with active commands in commandGroup (they won't be deselected server-side)
            // The commandGroup ensures their orders persist
            
            updateSelectionInfo();
            return;
        }
    }
    
    // Normal selection - clear everything
    gameState.selection.clear();
    gameState.inspectedUnitId = null;
    commandGroup.clear(); // New selection clears command persistence
    attackTarget = null;
    
    // Select units
    gameState.units.forEach((unit, unitId) => {
        if (unit.userId === gameState.userId) {
            if (isClick) {
                if (isPointInsideUnitHitbox(unit, clickX, clickY)) {
                    gameState.selection.add(unitId);
                }
            } else {
                if (unit.x >= minX && unit.x <= maxX &&
                    unit.y >= minY && unit.y <= maxY) {
                    gameState.selection.add(unitId);
                }
            }
        }
    });
    
    // Select buildings (if no units selected)
    if (gameState.selection.size === 0) {
        gameState.buildings.forEach((building, buildingId) => {
            if (building.userId === gameState.userId) {
                const buildingHalfSize = getBuildingHitboxHalfSize(building);
                if (isClick) {
                    if (clickX >= building.x - buildingHalfSize && clickX <= building.x + buildingHalfSize &&
                        clickY >= building.y - buildingHalfSize && clickY <= building.y + buildingHalfSize) {
                        gameState.selection.add(buildingId);
                    }
                } else {
                    if (building.x + buildingHalfSize >= minX && building.x - buildingHalfSize <= maxX &&
                        building.y + buildingHalfSize >= minY && building.y - buildingHalfSize <= maxY) {
                        gameState.selection.add(buildingId);
                    }
                }
            }
        });
    }

    if (gameState.selection.size === 0 && isClick) {
        const enemyUnitId = findInspectableEnemyUnitAt(clickX, clickY);
        if (enemyUnitId !== null) {
            gameState.inspectedUnitId = enemyUnitId;
        } else {
            gameState.buildings.forEach((building, buildingId) => {
                if (building.userId !== gameState.userId && gameState.selection.size === 0) {
                    const buildingHalfSize = getBuildingHitboxHalfSize(building);
                    if (clickX >= building.x - buildingHalfSize && clickX <= building.x + buildingHalfSize &&
                        clickY >= building.y - buildingHalfSize && clickY <= building.y + buildingHalfSize) {
                        gameState.selection.add(buildingId);
                    }
                }
            });
        }
    }
    
    updateSelectionInfo();
}

function renderSingleUnitPanel(unit, options = {}) {
    const { allowSkills = true, showAttackTarget = true } = options;

    let displayDamage = unit.damage || 0;
    if (unit.type === 'carrier') {
        displayDamage = '함재기 / 정찰기';
    } else if (unit.type === 'missile_launcher') {
        displayDamage = unit.deployState === 'deployed' ? '함선/SLBM 현재 체력 50%' : '배치 필요';
    } else if (unit.type === 'assaultship') {
        displayDamage = '수송 전용';
    } else if (unit.type === 'battleship' && unit.battleshipAegisMode) {
        displayDamage = '10 (이지스)';
    } else if (unit.type === 'cruiser' && unit.aegisMode) {
        displayDamage = '25 (이지스)';
    } else if (unit.type === 'battleship' && unit.aimedShot) {
        displayDamage = `${displayDamage * 2} (조준)`;
    } else if (unit.type === 'cruiser' && unit.isIsolated) {
        displayDamage = `${displayDamage * 2} (외로운 늑대)`;
    }
    document.getElementById('statDamage').textContent = displayDamage;

    let displayRange = unit.attackRange || 0;
    if (unit.type === 'missile_launcher' && unit.deployState !== 'deployed') {
        displayRange = '배치 필요';
    } else if (unit.type === 'assaultship') {
        displayRange = '-';
    } else if (unit.type === 'battleship' && unit.battleshipAegisMode) {
        displayRange = `${Math.round(displayRange)} (이지스)`;
    } else if (unit.type === 'battleship' && unit.aimedShot && !unit.battleshipAegisMode) {
        displayRange = `${displayRange * 2} (조준)`;
    } else if (unit.type === 'cruiser' && unit.aegisMode) {
        displayRange = `${Math.round(displayRange * 0.4)} (이지스)`;
    }
    document.getElementById('statRange').textContent = displayRange;
    document.getElementById('statHp').textContent = `${unit.hp || 0} / ${unit.maxHp || 0}`;
    document.getElementById('statKills').textContent = unit.kills || 0;

    if (showAttackTarget && attackTarget && !unit.holdPosition) {
        document.getElementById('targetLabel').textContent = `🎯 ${attackTarget.name}`;
    } else {
        const factionSuffix = unit.userId === gameState.userId ? '' : ' (적군)';
        const holdSuffix = unit.userId === gameState.userId && unit.holdPosition ? ' | 홀드' : '';
        const stateSuffix = unit.type === 'missile_launcher'
            ? ` | ${getMissileLauncherStateLabel(unit)}`
            : (unit.type === 'assaultship' ? ` | 적재 ${getAssaultShipLoadedUnitCount(unit)}/${ASSAULT_SHIP_MAX_LAUNCHERS}` : '');
        document.getElementById('targetLabel').textContent = `${getUnitTypeName(unit)}${factionSuffix}${stateSuffix}${holdSuffix}`;
    }

    if (!allowSkills || unit.userId !== gameState.userId) return;

    if (unit.type === 'submarine') {
        const slot1 = document.getElementById('skillSlot1');
        slot1.style.display = 'flex';
        document.getElementById('skillBtn1').textContent = '🚀 미사일 발사';
        document.getElementById('skillBtn1').className = 'skill-btn';
        document.getElementById('skillDesc1').textContent = `핵미사일 발사 - 반경 800 범위 피해 (잠수함 탑재: ${unit.loadedSlbms || 0}/3 | 전체 보유: ${gameState.missiles || 0})`;
        document.getElementById('skillDesc1').className = 'skill-desc';

        // Slot 2: SLBM 적재
        const slot2 = document.getElementById('skillSlot2');
        slot2.style.display = 'flex';
        const loaded = unit.loadedSlbms || 0;
        const isFull = loaded >= 3;
        document.getElementById('skillBtn2').textContent = '📦 미사일 적재';
        document.getElementById('skillBtn2').className = 'skill-btn' + (isFull ? ' disabled' : '');
        document.getElementById('skillDesc2').textContent = isFull
            ? `탑재 ${loaded}/3 — 가득 참`
            : `사일로 근처에서 미사일 1기 적재 (현재 ${loaded}/3)`;

        // Slot 3: 은신
        const slot3 = document.getElementById('skillSlot3');
        slot3.style.display = 'flex';
        const now = Date.now();
        const stealthOn = !!unit.stealthActive;
        const onCooldown = !stealthOn && unit.stealthCooldownUntil && now < unit.stealthCooldownUntil;
        const cdRemain = onCooldown ? Math.ceil((unit.stealthCooldownUntil - now) / 1000) : 0;
        if (stealthOn) {
            const expiresIn = unit.stealthExpiresAt ? Math.max(0, Math.ceil((unit.stealthExpiresAt - now) / 1000)) : 0;
            document.getElementById('skillBtn3').textContent = `🫥 은신 해제 (${expiresIn}초)`;
            document.getElementById('skillBtn3').className = 'skill-btn skill-active';
            document.getElementById('skillDesc3').textContent = '은신 중 — 적에게 보이지 않음 (공격 시 해제됨)';
        } else if (onCooldown) {
            document.getElementById('skillBtn3').textContent = `🫥 은신 (${cdRemain}초)`;
            document.getElementById('skillBtn3').className = 'skill-btn skill-cooldown';
            document.getElementById('skillDesc3').textContent = `쿨타임 ${cdRemain}초 남음`;
        } else {
            document.getElementById('skillBtn3').textContent = '🫥 은신';
            document.getElementById('skillBtn3').className = 'skill-btn';
            document.getElementById('skillDesc3').textContent = '15초간 적에게 보이지 않음 (쿨타임 30초)';
        }
    }

    if (unit.type === 'battleship') {
        showBattleshipCombatStanceSkill([unit]);
        showBattleshipAegisSkill([unit]);
        const slot5 = document.getElementById('skillSlot5');
        slot5.style.display = 'flex';
        const aimedShotBlockedByAegis = !!unit.battleshipAegisMode;
        const isActive = !aimedShotBlockedByAegis && unit.aimedShot ? true : false;
        const now = Date.now();
        const onCooldown = !aimedShotBlockedByAegis && unit.aimedShotCooldownUntil && now < unit.aimedShotCooldownUntil;
        const cdRemain = onCooldown ? Math.ceil((unit.aimedShotCooldownUntil - now) / 1000) : 0;
        if (aimedShotBlockedByAegis) {
            document.getElementById('skillBtn5').textContent = '🎯 조준 사격';
            document.getElementById('skillBtn5').className = 'skill-btn disabled';
            document.getElementById('skillDesc5').textContent = '이지스 모드 중에는 사용할 수 없음';
        } else if (isActive) {
            document.getElementById('skillBtn5').textContent = '🎯 조준 사격 (활성)';
            document.getElementById('skillBtn5').className = 'skill-btn skill-active';
            document.getElementById('skillDesc5').textContent = '다음 공격 시 사거리·데미지·시야 2배 (활성화됨)';
        } else if (onCooldown) {
            document.getElementById('skillBtn5').textContent = `🎯 조준 사격 (${cdRemain}초)`;
            document.getElementById('skillBtn5').className = 'skill-btn skill-cooldown';
            document.getElementById('skillDesc5').textContent = `쿨타임 ${cdRemain}초 남음`;
        } else {
            document.getElementById('skillBtn5').textContent = '🎯 조준 사격';
            document.getElementById('skillBtn5').className = 'skill-btn';
            document.getElementById('skillDesc5').textContent = '다음 한 번의 공격 사거리·데미지·시야 2배 (쿨타임 16초)';
        }
    }

    if (unit.type === 'frigate') {
        showFrigateEngineOverdriveSkill([unit]);
    }

    if (unit.type === 'cruiser') {
        const slot6 = document.getElementById('skillSlot6');
        slot6.style.display = 'flex';
        const isAegis = unit.aegisMode ? true : false;
        if (isAegis) {
            document.getElementById('skillBtn6').textContent = '🛡️ 이지스 모드 (활성)';
            document.getElementById('skillBtn6').className = 'skill-btn skill-active';
            document.getElementById('skillDesc6').textContent = 'SLBM 요격 가능 / 함선 25, SLBM 50 / 피해감소 30% / 사거리 60% 감소';
        } else {
            document.getElementById('skillBtn6').textContent = '🛡️ 이지스 모드';
            document.getElementById('skillBtn6').className = 'skill-btn';
            document.getElementById('skillDesc6').textContent = 'SLBM 요격 모드 전환 (함선 25, SLBM 50, 피해감소 30%, 사거리 60%↓)';
        }
        if (unit.isIsolated) {
            document.getElementById('skillDesc6').textContent += ' | 🐺 외로운 늑대: 데미지 +100%, 피해감소 50%';
        }
    }

    if (unit.type === 'destroyer') {
        const now7 = Date.now();
        const slot7 = document.getElementById('skillSlot7');
        slot7.style.display = 'flex';
        const searchActive = unit.searchActiveUntil && now7 < unit.searchActiveUntil;
        const searchActiveRemain = searchActive ? Math.ceil((unit.searchActiveUntil - now7) / 1000) : 0;
        const searchCd = unit.searchCooldownUntil && now7 < unit.searchCooldownUntil;
        const searchRemain = searchCd ? Math.ceil((unit.searchCooldownUntil - now7) / 1000) : 0;
        if (searchActive) {
            document.getElementById('skillBtn7').textContent = `🔍 탐색 활성 (${searchActiveRemain}초)`;
            document.getElementById('skillBtn7').className = 'skill-btn skill-active';
            document.getElementById('skillDesc7').textContent = `시야 4800 유지 중 | 쿨타임 ${searchRemain}초`;
        } else if (searchCd) {
            document.getElementById('skillBtn7').textContent = `🔍 탐색 (${searchRemain}초)`;
            document.getElementById('skillBtn7').className = 'skill-btn skill-cooldown';
            document.getElementById('skillDesc7').textContent = `쿨타임 ${searchRemain}초 남음`;
        } else {
            document.getElementById('skillBtn7').textContent = '🔍 탐색';
            document.getElementById('skillBtn7').className = 'skill-btn';
            document.getElementById('skillDesc7').textContent = '기본: 시야 내 잠수함/기뢰 자동 탐지 | 사용: 10초간 시야 4800';
        }
        const slot8 = document.getElementById('skillSlot8');
        slot8.style.display = 'flex';
        document.getElementById('skillBtn8').textContent = '💣 기뢰매설';
        document.getElementById('skillBtn8').className = 'skill-btn';
        document.getElementById('skillDesc8').textContent = '클릭한 위치에 기뢰를 설치합니다';
    }

    if (unit.type === 'missile_launcher') {
        const slot3 = document.getElementById('skillSlot3');
        slot3.style.display = 'flex';
        const btn = document.getElementById('skillBtn3');
        const desc = document.getElementById('skillDesc3');
        if (unit.deployState === 'deployed') {
            btn.textContent = '🚛 배치 해제';
            btn.className = 'skill-btn skill-active';
            desc.textContent = `전함급 사거리 ${MISSILE_LAUNCHER_RANGE} / 40초마다 함선·SLBM 현재 체력 50% 단일 대미지`;
        } else if (unit.deployState === 'undeploying_stage1' || unit.deployState === 'undeploying_stage2') {
            btn.textContent = '🚛 배치 해제 중';
            btn.className = 'skill-btn skill-cooldown disabled';
            desc.textContent = '미사일 발사대 해제중...';
        } else if (unit.deployState === 'deploying_stage1' || unit.deployState === 'deploying_stage2') {
            const stageText = unit.deployState === 'deploying_stage2' ? '전개 중' : '배치 중';
            btn.textContent = `🚛 ${stageText}`;
            btn.className = 'skill-btn skill-cooldown disabled';
            desc.textContent = '미사일 발사대 전개중...';
        } else {
            btn.textContent = '🚛 배치';
            btn.className = 'skill-btn';
            desc.textContent = '현 위치에 고정 배치 후 대함 미사일 모드로 전환합니다';
        }

        if (canUnitBoardAssaultShip(unit)) {
            showAssaultShipLoadUnitsSkill([unit]);
        } else {
            showAssaultShipLoadUnitsSkill([unit], {
                disabled: true,
                description: '배치 완료 또는 전개 중인 발사차량은 탑승할 수 없습니다'
            });
        }
    }

    if (unit.type === 'worker') {
        showAssaultShipLoadUnitsSkill([unit]);
    }

    if (unit.type === 'assaultship') {
        const slot3 = document.getElementById('skillSlot3');
        slot3.style.display = 'flex';
        const loadedCount = getAssaultShipLoadedUnitCount(unit);
        const canUnload = canUnloadFromAssaultShip(unit);
        document.getElementById('skillBtn3').textContent = '🚚 유닛 방출';
        document.getElementById('skillBtn3').className = 'skill-btn' + (canUnload ? '' : ' disabled');
        document.getElementById('skillDesc3').textContent = canUnload
            ? `적재 ${loadedCount}/${ASSAULT_SHIP_MAX_LAUNCHERS} | 육지에 인접해 있어 탑승 유닛을 모두 방출합니다`
            : `적재 ${loadedCount}/${ASSAULT_SHIP_MAX_LAUNCHERS} | 육지와 붙어 있어야 방출 가능`;
        showAssaultShipPickupSkill([unit]);
    }

    if (unit.type === 'carrier') {
        const acCount = (unit.aircraft || []).length;
        const deployedCount = (unit.aircraftDeployed || []).length;
        const acQueue = unit.aircraftQueue || [];
        const totalAc = acCount + deployedCount + acQueue.length;
        const reconCount = (unit.reconAircraft || []).length;
        const reconDeployedCount = (unit.reconAircraftDeployed || []).length;
        const reconQueue = unit.reconAircraftQueue || [];
        const totalRecon = reconCount + reconDeployedCount + reconQueue.length;
        const player = gameState.players.get(gameState.userId);
        const queueFull = acQueue.length >= 10 || totalAc >= 10;
        const reconQueueFull = reconQueue.length >= RECON_AIRCRAFT_MAX_PER_CARRIER || totalRecon >= RECON_AIRCRAFT_MAX_PER_CARRIER;

        const slot3 = document.getElementById('skillSlot3');
        slot3.style.display = 'flex';
        document.getElementById('skillBtn3').textContent = '✈️ 함재기 제작';
        document.getElementById('skillBtn3').className = 'skill-btn' + ((!player || player.resources < 100 || queueFull) ? ' disabled' : '');
        document.getElementById('skillDesc3').textContent = `에너지 100 / 15초 (보유: ${acCount} / 발진: ${deployedCount} / 최대 10) [대기열: ${acQueue.length}]`;

        const slot4 = document.getElementById('skillSlot4');
        slot4.style.display = 'flex';
        const isAdminUser = gameState.username === 'JsonParc';
        const airstrikeReady = unit.airstrikeReady || isAdminUser;
        const now4 = Date.now();
        const airstrikeCd = !isAdminUser && unit.airstrikeCooldownUntil && now4 < unit.airstrikeCooldownUntil;
        const cdRemain4 = airstrikeCd ? Math.ceil((unit.airstrikeCooldownUntil - now4) / 1000) : 0;
        if (airstrikeReady) {
            document.getElementById('skillBtn4').textContent = '✈️ 공중강습 (준비)';
            document.getElementById('skillBtn4').className = 'skill-btn skill-active';
            document.getElementById('skillDesc4').textContent = isAdminUser ? '관리자 모드: 즉시 사용 가능' : `함재기 10기 소모하여 범위 폭격 3회 (준비 완료)`;
        } else if (acCount >= 10 && airstrikeCd) {
            document.getElementById('skillBtn4').textContent = `✈️ 공중강습 (${cdRemain4}초)`;
            document.getElementById('skillBtn4').className = 'skill-btn skill-cooldown';
            document.getElementById('skillDesc4').textContent = `쿨타임 ${cdRemain4}초 남음`;
        } else {
            document.getElementById('skillBtn4').textContent = '✈️ 공중강습';
            document.getElementById('skillBtn4').className = 'skill-btn disabled';
            document.getElementById('skillDesc4').textContent = `함재기 10기 필요 (현재: ${acCount}기)`;
        }

        const slot7 = document.getElementById('skillSlot7');
        slot7.style.display = 'flex';
        const reconProgress = unit.producingReconAircraft
            ? Math.floor(Math.min(1, (Date.now() - unit.producingReconAircraft.startTime) / unit.producingReconAircraft.buildTime) * 100)
            : null;
        document.getElementById('skillBtn7').textContent = '🛩️ 정찰기 제작';
        document.getElementById('skillBtn7').className = 'skill-btn' + ((!player || player.resources < RECON_AIRCRAFT_COST || reconQueueFull) ? ' disabled' : '');
        document.getElementById('skillDesc7').textContent = `에너지 ${RECON_AIRCRAFT_COST} / ${Math.round(RECON_AIRCRAFT_BUILD_TIME_MS / 1000)}초 (보유: ${reconCount} / 출격: ${reconDeployedCount} / 최대 ${RECON_AIRCRAFT_MAX_PER_CARRIER}) [대기열: ${reconQueue.length}]${reconProgress !== null ? ` | 제작 중 ${reconProgress}%` : ''}`;

        const slot8 = document.getElementById('skillSlot8');
        slot8.style.display = 'flex';
        document.getElementById('skillBtn8').textContent = '🛩️ 정찰기 출격';
        document.getElementById('skillBtn8').className = 'skill-btn' + (reconCount <= 0 ? ' disabled' : '');
        document.getElementById('skillDesc8').textContent = `지정 위치로 정찰기 1기 출격 후 정찰하고 항모로 복귀 (보유: ${reconCount} / 비행 중: ${reconDeployedCount} / 동시 운영 최대 ${RECON_AIRCRAFT_MAX_PER_CARRIER})`;

        if (unit.producingAircraft || acQueue.length > 0) {
            const acBar = document.getElementById('aircraftProgressBar');
            acBar.style.display = 'block';
            let queueIconsHtml = acQueue.map((item, idx) => {
                const isFirst = idx === 0;
                return `<span style="display:inline-block;width:24px;height:24px;text-align:center;line-height:24px;background:${isFirst ? QUEUE_HIGHLIGHT_BG : 'rgba(255,255,255,0.1)'};border:1px solid ${isFirst ? QUEUE_HIGHLIGHT_BORDER : '#555'};border-radius:3px;font-size:14px;" title="함재기">✈️</span>`;
            }).join('');

            if (unit.producingAircraft) {
                const elapsed = Date.now() - unit.producingAircraft.startTime;
                const progress = Math.min(1, elapsed / unit.producingAircraft.buildTime);
                document.getElementById('aircraftProgressLabel').innerHTML = `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">${queueIconsHtml}</div>함재기 제작 중... ${Math.floor(progress * 100)}%`;
                document.getElementById('aircraftProgressFill').style.width = `${Math.floor(progress * 100)}%`;
            } else {
                document.getElementById('aircraftProgressLabel').innerHTML = queueIconsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">${queueIconsHtml}</div>` : '';
                document.getElementById('aircraftProgressFill').style.width = '0%';
            }
        }
    }
}

function removeWorkerBuildGrid() {
    const oldBuildGrid = document.getElementById('workerBuildGrid');
    if (oldBuildGrid) oldBuildGrid.remove();
}

function getWorkerBuildItems(categoryKey) {
    return (WORKER_BUILD_CATEGORIES[categoryKey] || WORKER_BUILD_CATEGORIES.general).items;
}

function getOwnedCompletedBuildingCount(type) {
    let count = 0;
    gameState.buildings.forEach(building => {
        if (building.userId === gameState.userId && building.type === type && (building.buildProgress == null || building.buildProgress >= 100)) {
            count++;
        }
    });
    return count;
}

function canBuildCarbase() {
    return CARBASE_PREREQ_BUILDINGS.every(type => getOwnedCompletedBuildingCount(type) >= 2);
}

function canBuildWorkerStructure(type, player) {
    if (!player) return false;
    const buildItem = Object.values(WORKER_BUILD_CATEGORIES)
        .flatMap(category => category.items)
        .find(item => item.type === type);
    if (!buildItem) return false;
    if (player.resources < buildItem.cost) return false;
    if (type === 'carbase' && !canBuildCarbase()) return false;
    return true;
}

function getProductionUnitSummary(unitType, pop) {
    switch (unitType) {
        case 'worker':
            return `인구 ${pop} | 건설, 수리, 채집 담당`;
        case 'destroyer':
            return `인구 ${pop} | 기뢰 매설과 잠수함 탐지 보조`;
        case 'cruiser':
            return `인구 ${pop} | 중형 화력, 이지스 모드 운용 가능`;
        case 'frigate':
            return `인구 ${pop} | 값싼 초반 해상 전투 유닛`;
        case 'battleship':
            return `인구 ${pop} | 장거리 주력 화력함`;
        case 'carrier':
            return `인구 ${pop} | 함재기와 정찰기 운용`;
        case 'submarine':
            return `인구 ${pop} | 잠항 기습과 은밀한 압박`;
        case 'assaultship':
            return `인구 ${pop} | 일꾼·발사차량 적재 및 상륙 지원`;
        case 'missile_launcher':
            return `인구 ${pop} | 배치 후 전함급 사거리에서 함선·SLBM 현재 체력 50% 타격`;
        default:
            return `인구 ${pop}`;
    }
}

function ensureWorkerBuildCategoryBar() {
    const workerBuildMenu = document.getElementById('workerBuildMenu');
    if (!workerBuildMenu) return null;
    if (!workerBuildMenu.dataset.initialized) {
        workerBuildMenu.innerHTML = `
            <button type="button" class="worker-build-tab" data-category="general">일반 건축물</button>
            <button type="button" class="worker-build-tab" data-category="advanced">고급 건축물</button>
        `;
        workerBuildMenu.querySelectorAll('.worker-build-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                const nextCategory = btn.getAttribute('data-category');
                if (!nextCategory || gameState.workerBuildCategory === nextCategory) return;
                gameState.workerBuildCategory = nextCategory;
                updateSelectionInfo();
            });
        });
        workerBuildMenu.dataset.initialized = 'true';
    }
    workerBuildMenu.querySelectorAll('.worker-build-tab').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-category') === gameState.workerBuildCategory);
    });
    return workerBuildMenu;
}

// Show skills for a specific unit type from the selected units in the bottom skill panel
function showSkillsForType(focusType, selectedUnits) {
    // Hide all skill slots first
    for (let _si = 1; _si <= 8; _si++) {
        document.getElementById('skillSlot' + _si).style.display = 'none';
    }
    document.getElementById('productionQueueDisplay').style.display = 'none';
    document.getElementById('slbmProgressBar').style.display = 'none';
    document.getElementById('aircraftProgressBar').style.display = 'none';

    if (!focusType) return;

    if (focusType === 'submarine') {
        const subs = selectedUnits.filter(u => u.type === 'submarine' && u.userId === gameState.userId);
        const slot1 = document.getElementById('skillSlot1');
        slot1.style.display = 'flex';
        document.getElementById('skillBtn1').textContent = '🚀 미사일 발사';
        document.getElementById('skillBtn1').className = 'skill-btn';
        document.getElementById('skillDesc1').textContent = `핵미사일 발사 - 반경 800 범위 피해 (보유: ${gameState.missiles || 0})`;
        document.getElementById('skillDesc1').className = 'skill-desc';

        // Slot 2: SLBM 적재 (multi)
        const slot2 = document.getElementById('skillSlot2');
        slot2.style.display = 'flex';
        const totalLoaded = subs.reduce((sum, u) => sum + (u.loadedSlbms || 0), 0);
        const totalCapacity = subs.length * 3;
        const allFull = totalLoaded >= totalCapacity;
        document.getElementById('skillBtn2').textContent = '📦 미사일 적재';
        document.getElementById('skillBtn2').className = 'skill-btn' + (allFull ? ' disabled' : '');
        document.getElementById('skillDesc2').textContent = allFull
            ? `탑재 ${totalLoaded}/${totalCapacity} — 모두 가득 참`
            : `사일로 근처에서 미사일 적재 (총 ${totalLoaded}/${totalCapacity})`;

        // Slot 3: 은신 (multi)
        const slot3 = document.getElementById('skillSlot3');
        slot3.style.display = 'flex';
        const stealthCount = subs.filter(u => u.stealthActive).length;
        if (stealthCount > 0) {
            document.getElementById('skillBtn3').textContent = `🫥 은신 해제`;
            document.getElementById('skillBtn3').className = 'skill-btn skill-active';
            document.getElementById('skillDesc3').textContent = `${stealthCount}/${subs.length}척 은신 중`;
        } else {
            document.getElementById('skillBtn3').textContent = '🫥 은신';
            document.getElementById('skillBtn3').className = 'skill-btn';
            document.getElementById('skillDesc3').textContent = `선택된 잠수함 ${subs.length}척 은신 (15초, 쿨타임 30초)`;
        }
    } else if (focusType === 'battleship') {
        showBattleshipCombatStanceSkill(selectedUnits);
        showBattleshipAegisSkill(selectedUnits);
        const slot5 = document.getElementById('skillSlot5');
        slot5.style.display = 'flex';
        const selectableBattleships = selectedUnits.filter(u => u.type === 'battleship' && !u.battleshipAegisMode);
        const anyActive = selectableBattleships.some(u => u.aimedShot);
        const now = Date.now();
        const anyCooldown = selectableBattleships.some(u => u.aimedShotCooldownUntil && now < u.aimedShotCooldownUntil);
        if (selectableBattleships.length <= 0) {
            document.getElementById('skillBtn5').textContent = '🎯 조준 사격';
            document.getElementById('skillBtn5').className = 'skill-btn disabled';
            document.getElementById('skillDesc5').textContent = '이지스 모드 중인 전함은 조준 사격을 사용할 수 없음';
        } else if (anyActive) {
            document.getElementById('skillBtn5').textContent = '🎯 조준 사격 (활성)';
            document.getElementById('skillBtn5').className = 'skill-btn skill-active';
            document.getElementById('skillDesc5').textContent = '선택된 전함들의 다음 공격 사거리·데미지·시야 2배 (쿨타임 16초)';
        } else if (anyCooldown) {
            document.getElementById('skillBtn5').textContent = '🎯 조준 사격 (쿨타임)';
            document.getElementById('skillBtn5').className = 'skill-btn skill-cooldown';
            document.getElementById('skillDesc5').textContent = '선택된 전함들의 다음 공격 사거리·데미지·시야 2배 (쿨타임 16초)';
        } else {
            document.getElementById('skillBtn5').textContent = '🎯 조준 사격';
            document.getElementById('skillBtn5').className = 'skill-btn';
            document.getElementById('skillDesc5').textContent = '선택된 전함들의 다음 공격 사거리·데미지·시야 2배 (쿨타임 16초)';
        }
    } else if (focusType === 'carrier') {
        const carriers = selectedUnits.filter(u => u.type === 'carrier' && u.userId === gameState.userId);
        if (carriers.length > 0) {
            const firstCarrier = carriers[0];
            const acCount = (firstCarrier.aircraft || []).length;
            const deployedCount = (firstCarrier.aircraftDeployed || []).length;
            const acQueueLen = (firstCarrier.aircraftQueue || []).length;
            const anyCarrierCanBuildAircraft = carriers.some(carrier => {
                const stored = (carrier.aircraft || []).length;
                const deployed = (carrier.aircraftDeployed || []).length;
                const queue = (carrier.aircraftQueue || []).length;
                return queue < 10 && (stored + deployed + queue) < 10;
            });
            const player = gameState.players.get(gameState.userId);
            const slot3 = document.getElementById('skillSlot3');
            slot3.style.display = 'flex';
            document.getElementById('skillBtn3').textContent = '✈️ 함재기 제작';
            document.getElementById('skillBtn3').className = 'skill-btn' + ((!player || player.resources < 100 || !anyCarrierCanBuildAircraft) ? ' disabled' : '');
            document.getElementById('skillDesc3').textContent = `에너지 100 / 15초 (보유: ${acCount} / 발진: ${deployedCount} / 최대 10) [대기열: ${acQueueLen}]`;
            const slot4 = document.getElementById('skillSlot4');
            slot4.style.display = 'flex';
            const anyAirstrikeReady = carriers.some(c => c.airstrikeReady) || gameState.username === 'JsonParc';
            if (anyAirstrikeReady) {
                document.getElementById('skillBtn4').textContent = '✈️ 공중강습 (준비)';
                document.getElementById('skillBtn4').className = 'skill-btn skill-active';
            } else {
                document.getElementById('skillBtn4').textContent = '✈️ 공중강습';
                document.getElementById('skillBtn4').className = 'skill-btn disabled';
            }
            document.getElementById('skillDesc4').textContent = `함재기 10기 소모하여 범위 폭격 3회`;
            if (carriers.length === selectedUnits.filter(u => u.type === 'carrier').length) {
                const totalReconReady = carriers.reduce((sum, carrier) => sum + ((carrier.reconAircraft || []).length), 0);
                const totalReconDeployed = carriers.reduce((sum, carrier) => sum + ((carrier.reconAircraftDeployed || []).length), 0);
                const totalReconQueue = carriers.reduce((sum, carrier) => sum + ((carrier.reconAircraftQueue || []).length), 0);
                const anyCarrierCanBuildRecon = carriers.some(carrier => {
                    const stored = (carrier.reconAircraft || []).length;
                    const deployed = (carrier.reconAircraftDeployed || []).length;
                    const queue = (carrier.reconAircraftQueue || []).length;
                    return queue < RECON_AIRCRAFT_MAX_PER_CARRIER && (stored + deployed + queue) < RECON_AIRCRAFT_MAX_PER_CARRIER;
                });
                const slot7 = document.getElementById('skillSlot7');
                slot7.style.display = 'flex';
                document.getElementById('skillBtn7').textContent = '🛩️ 정찰기 제작';
                document.getElementById('skillBtn7').className = 'skill-btn' + ((!player || player.resources < RECON_AIRCRAFT_COST || !anyCarrierCanBuildRecon) ? ' disabled' : '');
                document.getElementById('skillDesc7').textContent = `선택 항모 정찰기: 보유 ${totalReconReady} / 출격 ${totalReconDeployed} / 대기열 ${totalReconQueue} / 항모당 최대 ${RECON_AIRCRAFT_MAX_PER_CARRIER}`;
                const slot8 = document.getElementById('skillSlot8');
                slot8.style.display = 'flex';
                document.getElementById('skillBtn8').textContent = '🛩️ 정찰기 출격';
                document.getElementById('skillBtn8').className = 'skill-btn' + (totalReconReady <= 0 ? ' disabled' : '');
                document.getElementById('skillDesc8').textContent = `선택된 각 항모에서 정찰기 1기씩 출격, 항모당 최대 ${RECON_AIRCRAFT_MAX_PER_CARRIER}기 동시 운영`;
            }
        }
    } else if (focusType === 'assaultship') {
        const assaultShips = selectedUnits.filter(u => u.type === 'assaultship');
        const slot3 = document.getElementById('skillSlot3');
        slot3.style.display = 'flex';
        const totalLoaded = assaultShips.reduce((sum, unit) => sum + getAssaultShipLoadedUnitCount(unit), 0);
        const unloadReadyCount = assaultShips.filter(canUnloadFromAssaultShip).length;
        document.getElementById('skillBtn3').textContent = '🚚 유닛 방출';
        document.getElementById('skillBtn3').className = 'skill-btn' + (unloadReadyCount > 0 ? '' : ' disabled');
        document.getElementById('skillDesc3').textContent = `적재 ${totalLoaded} / 선택 ${assaultShips.length}척 | 육지와 맞닿은 상륙함 ${unloadReadyCount}척이 탑승 유닛을 방출합니다`;
        showAssaultShipPickupSkill(selectedUnits);
    } else if (focusType === 'cruiser') {
        const slot6 = document.getElementById('skillSlot6');
        slot6.style.display = 'flex';
        const anyAegis = selectedUnits.some(u => u.type === 'cruiser' && u.aegisMode);
        if (anyAegis) {
            document.getElementById('skillBtn6').textContent = '🛡️ 이지스 모드 (활성)';
            document.getElementById('skillBtn6').className = 'skill-btn skill-active';
        } else {
            document.getElementById('skillBtn6').textContent = '🛡️ 이지스 모드';
            document.getElementById('skillBtn6').className = 'skill-btn';
        }
        document.getElementById('skillDesc6').textContent = 'SLBM 요격 모드 전환 (함선 25, SLBM 50, 피해감소 30%, 사거리 60%↓)';
    } else if (focusType === 'destroyer') {
        const slot7 = document.getElementById('skillSlot7');
        slot7.style.display = 'flex';
        document.getElementById('skillBtn7').textContent = '🔍 탐색';
        document.getElementById('skillBtn7').className = 'skill-btn';
        document.getElementById('skillDesc7').textContent = '기본: 시야 내 잠수함/기뢰 자동 탐지 | 사용: 10초간 시야 4800';
        const slot8 = document.getElementById('skillSlot8');
        slot8.style.display = 'flex';
        document.getElementById('skillBtn8').textContent = '💣 기뢰매설';
        document.getElementById('skillBtn8').className = 'skill-btn';
        document.getElementById('skillDesc8').textContent = '클릭한 위치에 기뢰를 설치합니다';
    } else if (focusType === 'frigate') {
        showFrigateEngineOverdriveSkill(selectedUnits);
    } else if (focusType === 'missile_launcher') {
        const launchers = selectedUnits.filter(u => u.type === 'missile_launcher');
        const slot3 = document.getElementById('skillSlot3');
        slot3.style.display = 'flex';
        const mobileCount = launchers.filter(u => !u.deployState || u.deployState === 'mobile').length;
        const deployingCount = launchers.filter(u => u.deployState === 'deploying_stage1' || u.deployState === 'deploying_stage2').length;
        const undeployingCount = launchers.filter(u => u.deployState === 'undeploying_stage1' || u.deployState === 'undeploying_stage2').length;
        const deployedCount = launchers.filter(u => u.deployState === 'deployed').length;
        if (mobileCount > 0) {
            document.getElementById('skillBtn3').textContent = '🚛 배치';
            document.getElementById('skillBtn3').className = 'skill-btn';
        } else if (deployedCount > 0) {
            document.getElementById('skillBtn3').textContent = '🚛 배치 해제';
            document.getElementById('skillBtn3').className = 'skill-btn skill-active';
        } else if (deployingCount > 0 || undeployingCount > 0) {
            document.getElementById('skillBtn3').textContent = '🚛 배치 중';
            document.getElementById('skillBtn3').className = 'skill-btn skill-cooldown disabled';
        } else {
            document.getElementById('skillBtn3').textContent = '🚛 배치';
            document.getElementById('skillBtn3').className = 'skill-btn disabled';
        }
        document.getElementById('skillDesc3').textContent = `이동식 ${mobileCount} / 전개 중 ${deployingCount} / 해제 중 ${undeployingCount} / 배치 완료 ${deployedCount} | 배치 후 전함급 사거리, 40초마다 함선·SLBM 현재 체력 50%`;
    }
}

function updateSelectionInfo() {
    const selectionInfo = document.getElementById('selectionInfo');
    const workerBuildMenu = ensureWorkerBuildCategoryBar();
    const bottomPanel = document.getElementById('bottomPanel');
    const inspectedUnit = getInspectedUnit();
    
    // Hide all panels first
    if (workerBuildMenu) {
        workerBuildMenu.classList.remove('active');
        workerBuildMenu.style.display = 'none';
    }
    selectionInfo.classList.remove('active');
    const _fp = document.getElementById('formationPanel');
    if (_fp) { _fp.classList.remove('active'); _fp.innerHTML = ''; }
    bottomPanel.classList.remove('active');
    
    // Hide skill/production slots
    for (let _si = 1; _si <= 8; _si++) {
        document.getElementById('skillSlot' + _si).style.display = 'none';
    }
    document.getElementById('productionQueueDisplay').style.display = 'none';
    document.getElementById('slbmProgressBar').style.display = 'none';
    document.getElementById('aircraftProgressBar').style.display = 'none';
    
    const btnContainer = document.getElementById('productionButtons');
    
    if (gameState.selection.size === 0 && !inspectedUnit) {
        // Remove worker build grid if exists when nothing is selected
        removeWorkerBuildGrid();
        return;
    }
    
    // Check if buildings are selected
    const selectedBuildings = Array.from(gameState.selection)
        .map(id => gameState.buildings.get(id))
        .filter(b => b !== undefined);
    
        if (selectedBuildings.length > 0) {
            removeWorkerBuildGrid();
            const building = selectedBuildings[0];
            const buildingTypeNames = {
                'headquarters': '사령부',
                'shipyard': '조선소',
                'naval_academy': '대형조선소',
                'carbase': '차량기지',
                'power_plant': '발전소',
                'missile_silo': '미사일 사일로',
                'defense_tower': '방어 타워'
            };
        
        // Show bottom panel for building stats
        bottomPanel.classList.add('active');
        if (building.type === 'defense_tower') {
            document.getElementById('statDamage').textContent = '26';
            document.getElementById('statRange').textContent = '2500';
        } else {
            document.getElementById('statDamage').textContent = '-';
            document.getElementById('statRange').textContent = '-';
        }
        document.getElementById('statHp').textContent = `${building.hp || 0} / ${building.maxHp || 0}`;
        document.getElementById('statKills').textContent = '-';
        const isEnemyBuilding = building.userId !== gameState.userId;
        const buildingLabel = (isEnemyBuilding ? '[적] ' : '') + (buildingTypeNames[building.type] || building.type);
        document.getElementById('targetLabel').textContent = buildingLabel;
        
        // Show production UI in skill panel for production buildings
        if ((building.type === 'headquarters' || building.type === 'shipyard' || building.type === 'naval_academy' || building.type === 'carbase') && building.userId === gameState.userId) {
            const prodDisplay = document.getElementById('productionQueueDisplay');
            prodDisplay.style.display = 'block';
            
            const allowedUnits = {
                'headquarters': ['worker'],
                'shipyard': ['destroyer', 'cruiser', 'frigate'],
                'naval_academy': ['battleship', 'carrier', 'submarine', 'assaultship'],
                'carbase': ['missile_launcher']
            };
            const allowed = allowedUnits[building.type] || [];
            const unitIcons = { worker: '👷', destroyer: '🚢', cruiser: '⛴️', battleship: '🛳️', carrier: '🛫', assaultship: '🛶', submarine: '🔱', frigate: '⚔️', missile_launcher: '🚛' };
            const unitNames = { worker: '일꾼', destroyer: '구축함', cruiser: '순양함', battleship: '전함', carrier: '항공모함', assaultship: '강습상륙함', submarine: '잠수함', frigate: '호위함', missile_launcher: '발사차량' };
            const unitCosts = { worker: 50, destroyer: 150, cruiser: 300, battleship: BATTLESHIP_COST, carrier: 800, assaultship: ASSAULT_SHIP_COST, submarine: 900, frigate: 120, missile_launcher: MISSILE_LAUNCHER_COST };
            const unitPops = { worker: 1, destroyer: 2, cruiser: 3, battleship: 20, carrier: 6, assaultship: 5, submarine: 4, frigate: 1, missile_launcher: 2 };
            
            // Production buttons
            const btnContainer = document.getElementById('productionButtons');
            const player = gameState.players.get(gameState.userId);
            const queueLen = (building.productionQueue || []).length;
            
            // Only recreate when the production roster actually changes.
            const productionKey = `${building.type}:${allowed.join(',')}`;
            const currentProductionKey = btnContainer.getAttribute('data-production-key');
            if (currentProductionKey !== productionKey) {
                btnContainer.innerHTML = '';
                btnContainer.setAttribute('data-production-key', productionKey);
            }
            
            if (btnContainer.children.length === 0) {
                btnContainer.innerHTML = allowed.map(uType => {
                    const cost = unitCosts[uType];
                    const pop = unitPops[uType];
                    const summary = getProductionUnitSummary(uType, pop);
                    return `
                        <button class="prod-btn prod-btn-row" data-type="${uType}" data-building="${building.id}">
                            <span class="prod-btn-main">
                                <span class="prod-btn-name">${unitNames[uType]}</span>
                                <span class="prod-btn-cost">${cost} 에너지</span>
                            </span>
                            <span class="prod-btn-desc">${summary}</span>
                        </button>
                    `;
                }).join('');
                
            }
            
            btnContainer.querySelectorAll('.prod-btn').forEach(btn => {
                const uType = btn.getAttribute('data-type');
                const cost = unitCosts[uType];
                const pop = unitPops[uType];
                const canAfford = player && player.resources >= cost && player.population + pop <= player.maxPopulation;
                const queueFull = queueLen >= 10;
                const shouldDisable = !canAfford || queueFull || building.buildProgress < 100;
                btn.setAttribute('data-building', building.id);
                btn._buildingId = building.id;
                
                if (shouldDisable) {
                    btn.classList.add('disabled');
                } else {
                    btn.classList.remove('disabled');
                }
            });
            
            // Queue icons
            const queueContainer = document.getElementById('productionQueueIcons');
            const queue = building.productionQueue || [];
            queueContainer.innerHTML = queue.map((item, idx) => {
                const icon = unitIcons[item.unitType] || '?';
                const isFirst = idx === 0;
                return `<span style="display:inline-block;width:24px;height:24px;text-align:center;line-height:24px;background:${isFirst ? QUEUE_HIGHLIGHT_BG : 'rgba(255,255,255,0.1)'};border:1px solid ${isFirst ? QUEUE_HIGHLIGHT_BORDER : '#555'};border-radius:3px;font-size:14px;" title="${unitNames[item.unitType]}">${icon}</span>`;
            }).join('');
            
            // Production progress
            const progContainer = document.getElementById('productionProgressInline');
            if (building.producing) {
                progContainer.style.display = 'block';
                const elapsed = Date.now() - building.producing.startTime;
                const progress = Math.min(1, elapsed / building.producing.buildTime);
                const producingName = unitNames[building.producing.unitType] || building.producing.unitType;
                document.getElementById('productionLabelInline').textContent = `${producingName} 생산 중... ${Math.floor(progress * 100)}%`;
                document.getElementById('productionFillInline').style.width = `${Math.floor(progress * 100)}%`;
            } else {
                progContainer.style.display = 'none';
            }
        }
        
        // Missile production for missile silo (queue-based)
        if (building.type === 'missile_silo' && building.buildProgress >= 100 && building.userId === gameState.userId) {
            const missileQueue = building.missileQueue || [];
            const queueFull = missileQueue.length >= 10;
            const player = gameState.players.get(gameState.userId);
            
            const slot2 = document.getElementById('skillSlot2');
            slot2.style.display = 'flex';
            document.getElementById('skillBtn2').textContent = '🔧 미사일 제작';
            document.getElementById('skillBtn2').className = 'skill-btn skill-purple' + ((!player || player.resources < 1500 || queueFull) ? ' disabled' : '');
            document.getElementById('skillDesc2').textContent = `에너지 1500 / 45초 (보유: ${gameState.missiles || 0}) [대기열: ${missileQueue.length}/10]`;
            document.getElementById('skillDesc2').className = 'skill-desc desc-purple';

            // Show missile queue icons and progress
            const slbmBar = document.getElementById('slbmProgressBar');
            slbmBar.style.display = 'block';
            let queueIconsHtml = missileQueue.map((item, idx) => {
                const isFirst = idx === 0;
                return `<span style="display:inline-block;width:24px;height:24px;text-align:center;line-height:24px;background:${isFirst ? 'rgba(206,147,216,0.3)' : 'rgba(255,255,255,0.1)'};border:1px solid ${isFirst ? '#ce93d8' : '#555'};border-radius:3px;font-size:14px;" title="미사일 생산">🚀</span>`;
            }).join('');
            
            if (building.missileProducing) {
                const elapsed = Date.now() - building.missileProducing.startTime;
                const progress = Math.min(1, elapsed / building.missileProducing.buildTime);
                document.getElementById('slbmProgressLabel').innerHTML = `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">${queueIconsHtml}</div>미사일 생산 중... ${Math.floor(progress * 100)}%`;
                document.getElementById('slbmProgressFill').style.width = `${Math.floor(progress * 100)}%`;
            } else {
                document.getElementById('slbmProgressLabel').innerHTML = queueIconsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">${queueIconsHtml}</div>` : '';
                document.getElementById('slbmProgressFill').style.width = '0%';
            }
        }
        
        // Multi-building info
        if (selectedBuildings.length > 1) {
            let html = `<div><strong>선택된 건물: ${selectedBuildings.length}</strong></div>`;
            selectionInfo.innerHTML = html;
            selectionInfo.classList.add('active');
        }
        return;
    }
    
    const selectedUnits = Array.from(gameState.selection).map(id => gameState.units.get(id)).filter(u => u !== undefined);
    
    if (selectedUnits.length === 0) {
        removeWorkerBuildGrid();
        if (!inspectedUnit) return;
        bottomPanel.classList.add('active');
        renderSingleUnitPanel(inspectedUnit, { allowSkills: false, showAttackTarget: false });
        return;
    }
    
    // Check if workers are selected - show build buttons in skill panel
    const hasWorkers = selectedUnits.some(u => u.type === 'worker' && u.userId === gameState.userId);
    
    // Remove worker build grid if workers are not selected
    if (!hasWorkers) {
        removeWorkerBuildGrid();
    }
    
    if (hasWorkers) {
        if (workerBuildMenu) {
            workerBuildMenu.classList.add('active');
            workerBuildMenu.style.display = 'flex';
        }
        
        const player = gameState.players.get(gameState.userId);
        const buildData = getWorkerBuildItems(gameState.workerBuildCategory);
        
        const skillsPanel = document.getElementById('unitSkills');
        let buildContainer = document.getElementById('workerBuildGrid');
        
        // Only create buttons if they don't exist
        if (!buildContainer) {
            buildContainer = document.createElement('div');
            buildContainer.id = 'workerBuildGrid';
            buildContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
            skillsPanel.appendChild(buildContainer);
        }
        if (buildContainer.getAttribute('data-category') !== gameState.workerBuildCategory) {
            buildContainer.setAttribute('data-category', gameState.workerBuildCategory);
            buildContainer.innerHTML = buildData.map(b => {
                const descText = b.desc ? ` (${b.desc})` : '';
                return `<button class="build-btn" data-type="${b.type}" data-cost="${b.cost}" style="width:calc(50% - 3px);padding:8px 4px;margin-bottom:0;font-size:12px;">${b.name}<br><small>${b.cost} 에너지${descText}</small></button>`;
            }).join('');
            buildContainer.querySelectorAll('.build-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (btn.classList.contains('disabled')) return;
                    const buildingType = btn.getAttribute('data-type');
                    const selectedWorkers = Array.from(gameState.selection)
                        .map(id => gameState.units.get(id))
                        .filter(u => u && u.userId === gameState.userId && u.type === 'worker');
                    if (selectedWorkers.length > 0) {
                        gameState.buildMode = buildingType;
                        canvas.style.cursor = 'pointer';
                    }
                });
            });
        }
        
        // Update button states
        buildContainer.querySelectorAll('.build-btn').forEach(btn => {
            const buildingType = btn.getAttribute('data-type');
            const canBuild = canBuildWorkerStructure(buildingType, player);
            btn.title = '';
            if (canBuild) {
                btn.classList.remove('disabled');
            } else {
                btn.classList.add('disabled');
            }
            if (buildingType === 'carbase' && !canBuildCarbase()) {
                btn.title = '본부, 조선소, 발전소, 방어 타워, 대형조선소, 미사일 사일로를 각각 2개 이상 보유해야 합니다';
            }
        });
    }
    
    // Show bottom panel for unit stats
    bottomPanel.classList.add('active');
    
    if (selectedUnits.length === 1) {
        renderSingleUnitPanel(selectedUnits[0]);
    } else {
        // Multiple units selected - show summary stats
        // Priority order for mixed selections: battleship > submarine > carrier > assaultship > cruiser > destroyer > frigate > missile_launcher/worker.
        const sortedUnits = [...selectedUnits].sort((a, b) => getUnitSelectionPriority(b.type) - getUnitSelectionPriority(a.type));
        const primaryUnit = sortedUnits[0];
        
        const totalDamage = selectedUnits.reduce((sum, u) => sum + getDisplayedUnitDamageValue(u), 0);
        const avgRange = Math.round(selectedUnits.reduce((sum, u) => sum + (u.attackRange || 0), 0) / selectedUnits.length);
        const totalHp = selectedUnits.reduce((sum, u) => sum + (u.hp || 0), 0);
        const totalMaxHp = selectedUnits.reduce((sum, u) => sum + (u.maxHp || 0), 0);
        const totalKills = selectedUnits.reduce((sum, u) => sum + (u.kills || 0), 0);
        const holdCount = selectedUnits.filter(u => u.userId === gameState.userId && u.holdPosition).length;
        const holdSuffix = holdCount === selectedUnits.length ? ' | 홀드' : (holdCount > 0 ? ` | 홀드 ${holdCount}` : '');
        
        document.getElementById('statDamage').textContent = totalDamage;
        document.getElementById('statRange').textContent = avgRange;
        document.getElementById('statHp').textContent = `${totalHp} / ${totalMaxHp}`;
        document.getElementById('statKills').textContent = totalKills;
        document.getElementById('targetLabel').textContent = attackTarget && holdCount === 0
            ? `🎯 ${attackTarget.name}`
            : getUnitTypeName(primaryUnit) + ` 외 ${selectedUnits.length - 1}${holdSuffix}`;
        
        // Determine which unit type's skills to show
        const hasTypes = new Set(selectedUnits.map(u => u.type));
        const highestPriorityType = getHighestPrioritySelectedUnitType(selectedUnits);
        const effectiveSkillType = (skillFocusType && hasTypes.has(skillFocusType)) ? skillFocusType : highestPriorityType;
        showSkillsForType(effectiveSkillType, selectedUnits);

        if (hasOnlyOwnedAssaultShipLoadableUnitsSelected() && effectiveSkillType !== 'assaultship') {
            showAssaultShipLoadUnitsSkill(selectedUnits);
        }
        
        // Build selection info HTML with squad grouping
        const ownUnits = selectedUnits.filter(u => u.userId === gameState.userId);
        // Group units by squad
        const squadGroups = new Map(); // squadId -> units[]
        const ungroupedUnits = []; // units not in any squad
        selectedUnits.forEach(u => {
            if (u.squadId) {
                if (!squadGroups.has(u.squadId)) squadGroups.set(u.squadId, []);
                squadGroups.get(u.squadId).push(u);
            } else {
                ungroupedUnits.push(u);
            }
        });

        let html = `<div><strong>선택된 유닛: ${selectedUnits.length}</strong></div>`;
        if (holdCount > 0) {
            html += `<div>홀드 포지션: ${holdCount}/${selectedUnits.length}</div>`;
        }

        // Show each squad group (collapsed by default, click to expand)
        const sortedSquadIds = [...squadGroups.keys()].sort((a, b) => a - b);
        if (!window._expandedSquads) window._expandedSquads = new Set();
        sortedSquadIds.forEach(sqId => {
            const sqUnits = squadGroups.get(sqId);
            const sqNum = getSquadDisplayNumber(sqId);
            const isExpanded = window._expandedSquads.has(sqId);
            const sqTypes = new Set(sqUnits.map(u => u.type));
            const sqTypeSummary = [...sqTypes].sort((a, b) => getUnitSelectionPriority(b) - getUnitSelectionPriority(a))
                .map(t => {
                    const matchingUnits = sqUnits.filter(u => u.type === t);
                    return `${getUnitSelectionGroupName(t, matchingUnits)} ${matchingUnits.length}`;
                }).join(', ');
            html += `<div class="squad-header" data-squad-toggle="${sqId}" style="color:#00ddff;margin-top:4px;cursor:pointer;user-select:none;" title="${sqTypeSummary}">${isExpanded ? '▼' : '▶'} 부대 ${sqNum} (${sqUnits.length}유닛)</div>`;
            if (isExpanded) {
                // Show unit types in this squad as hoverable items
                [...sqTypes].sort((a, b) => getUnitSelectionPriority(b) - getUnitSelectionPriority(a)).forEach(t => {
                    const cnt = sqUnits.filter(u => u.type === t).length;
                    const isFocused = effectiveSkillType === t;
                    html += `<div class="skill-hover-type" data-skill-type="${t}" style="padding-left:16px;cursor:pointer;${isFocused ? 'color:#00ffcc;font-weight:bold;' : ''}">${getUnitSelectionGroupName(t, sqUnits.filter(u => u.type === t))}: ${cnt}</div>`;
                });
            }
        });

        // Show ungrouped units
        if (ungroupedUnits.length > 0) {
            if (squadGroups.size > 0) {
                html += `<div style="margin-top:4px;color:#aaa;">── 미편성 ──</div>`;
            }
            const ungroupedTypes = new Set(ungroupedUnits.map(u => u.type));
            [...ungroupedTypes].sort((a, b) => getUnitSelectionPriority(b) - getUnitSelectionPriority(a)).forEach(t => {
                const cnt = ungroupedUnits.filter(u => u.type === t).length;
                const isFocused = effectiveSkillType === t;
                html += `<div class="skill-hover-type" data-skill-type="${t}" style="cursor:pointer;${isFocused ? 'color:#00ffcc;font-weight:bold;' : ''}">${getUnitSelectionGroupName(t, ungroupedUnits.filter(u => u.type === t))}: ${cnt}</div>`;
            });
        }

        // Squad buttons
        if (ownUnits.length >= 2) {
            const squadIdsSet = new Set(ownUnits.map(u => u.squadId).filter(Boolean));
            const allInSameSquad = squadIdsSet.size === 1 && ownUnits.every(u => u.squadId);
            const hasAnySquad = squadIdsSet.size > 0;
            const hasUngrouped = ownUnits.some(u => !u.squadId);
            html += `<div style="margin-top:6px;display:flex;gap:6px;">`;
            // Show create button: when not all in same squad (merge / new squad)
            if (!allInSameSquad) {
                html += `<button type="button" class="squad-btn" data-squad="create">부대지정</button>`;
            }
            // Show disband button: when any unit is in a squad
            if (hasAnySquad) {
                html += `<button type="button" class="squad-btn squad-disband" data-squad="disband">부대지정 해제</button>`;
            }
            html += `</div>`;
        }

        selectionInfo.innerHTML = html;
        selectionInfo.classList.add('active');
        updateFormationPanel();
    }
}

// Event delegation for selectionInfo (set up once, survives innerHTML rebuilds)
(function setupSelectionInfoDelegation() {
    const si = document.getElementById('selectionInfo');
    if (!si || si._delegated) return;
    si._delegated = true;

    si.addEventListener('click', (e) => {
        // Squad create/disband buttons
        const squadBtn = e.target.closest('[data-squad]');
        if (squadBtn) {
            e.stopPropagation();
            const action = squadBtn.getAttribute('data-squad');
            const own = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId);
            if (action === 'create' && own.length >= 2 && socket) {
                socket.emit('createSquad', { unitIds: own.map(u => u.id) });
            } else if (action === 'disband') {
                const sids = new Set(own.map(u => u.squadId).filter(Boolean));
                sids.forEach(sid => { if (socket) socket.emit('disbandSquad', { squadId: sid }); });
            }
            return;
        }
        // Squad header expand/collapse
        const hdr = e.target.closest('.squad-header');
        if (hdr) {
            e.stopPropagation();
            const sqId = parseInt(hdr.getAttribute('data-squad-toggle'));
            if (!window._expandedSquads) window._expandedSquads = new Set();
            if (window._expandedSquads.has(sqId)) {
                window._expandedSquads.delete(sqId);
            } else {
                window._expandedSquads.add(sqId);
            }
            updateSelectionInfo();
            return;
        }
    });

    si.addEventListener('mouseenter', (e) => {
        const el = e.target.closest('.skill-hover-type');
        if (!el) return;
        const t = el.getAttribute('data-skill-type');
        if (t && t !== skillFocusType) {
            skillFocusType = t;
            const selectedUnits = Array.from(gameState.selection).map(id => gameState.units.get(id)).filter(Boolean);
            showSkillsForType(t, selectedUnits);
            si.querySelectorAll('.skill-hover-type').forEach(e2 => {
                e2.style.color = '';
                e2.style.fontWeight = '';
            });
            el.style.color = '#00ffcc';
            el.style.fontWeight = 'bold';
        }
    }, true);
})();

function updateFormationPanel() {
    const fp = document.getElementById('formationPanel');
    if (!fp) return;
    const selected = Array.from(gameState.selection).map(id => gameState.units.get(id)).filter(Boolean);
    const ownUnits = selected.filter(u => u.userId === gameState.userId);
    // Collect all squad IDs from selected own units
    const sids = new Set();
    for (const u of ownUnits) {
        if (u.squadId) sids.add(u.squadId);
    }
    if (sids.size === 0) { fp.classList.remove('active'); fp.innerHTML = ''; return; }

    let innerHtml = '';
    const sortedSids = [...sids].sort((a, b) => a - b);
    sortedSids.forEach(sqId => {
        const sqData = gameState.squads.get(sqId);
        const curFT = sqData?.formationType || 'trapezoid';
        const sqNum = getSquadDisplayNumber(sqId);
        const label = sortedSids.length > 1 ? `부대 ${sqNum} 대열` : '부대 대열';
        innerHtml += `
        <span class="formation-label">${label}</span>
        <div style="display:flex;gap:8px;">
        <button type="button" class="formation-type-btn${curFT === 'trapezoid' ? ' active' : ''}" data-formation="trapezoid" data-squad-id="${sqId}" title="사다리꼴 대열">
            <svg width="32" height="26" viewBox="0 0 28 22"><polygon points="6,2 22,2 26,20 2,20" fill="none" stroke="${curFT === 'trapezoid' ? '#00ffcc' : '#8f99a3'}" stroke-width="1.5"/><circle cx="14" cy="5" r="2" fill="${curFT === 'trapezoid' ? '#ff6666' : '#666'}"/><circle cx="8" cy="17" r="2" fill="${curFT === 'trapezoid' ? '#66ff66' : '#666'}"/><circle cx="20" cy="17" r="2" fill="${curFT === 'trapezoid' ? '#66ff66' : '#666'}"/><circle cx="14" cy="17" r="2" fill="${curFT === 'trapezoid' ? '#6666ff' : '#666'}"/></svg>
            <span style="font-size:9px;color:${curFT === 'trapezoid' ? '#00ffcc' : '#8f99a3'};">사다리꼴</span>
        </button>
        <button type="button" class="formation-type-btn${curFT === 'diamond' ? ' active' : ''}" data-formation="diamond" data-squad-id="${sqId}" title="마름모 대열">
            <svg width="32" height="26" viewBox="0 0 28 22"><polygon points="14,1 27,11 14,21 1,11" fill="none" stroke="${curFT === 'diamond' ? '#00ffcc' : '#8f99a3'}" stroke-width="1.5"/><circle cx="14" cy="11" r="2" fill="${curFT === 'diamond' ? '#ff6666' : '#666'}"/><circle cx="14" cy="4" r="2" fill="${curFT === 'diamond' ? '#66ff66' : '#666'}"/><circle cx="7" cy="11" r="2" fill="${curFT === 'diamond' ? '#66ff66' : '#666'}"/><circle cx="21" cy="11" r="2" fill="${curFT === 'diamond' ? '#66ff66' : '#666'}"/></svg>
            <span style="font-size:9px;color:${curFT === 'diamond' ? '#00ffcc' : '#8f99a3'};">마름모</span>
        </button>
        </div>`;
    });
    fp.innerHTML = innerHtml;
    fp.querySelectorAll('.formation-type-btn').forEach(fBtn => {
        fBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const ft = fBtn.getAttribute('data-formation');
            const sid = parseInt(fBtn.getAttribute('data-squad-id'));
            if (ft && !isNaN(sid) && socket) {
                socket.emit('setFormationType', { squadId: sid, formationType: ft });
                const sq = gameState.squads.get(sid);
                if (sq) sq.formationType = ft;
                setTimeout(() => updateFormationPanel(), 50);
            }
        });
    });
    fp.classList.add('active');
}

// Rendering (PixiJS WebGL)
function render() {
    if (!pixiApp || !worldContainer) return;
    if (gameState.map) {
        clampCameraToMapBounds();
    }

    // Camera transform via worldContainer
    const sw = pixiApp.renderer.width;
    const sh = pixiApp.renderer.height;
    worldContainer.position.set(
        sw / 2 - gameState.camera.x * gameState.camera.zoom,
        sh / 2 - gameState.camera.y * gameState.camera.zoom
    );
    worldContainer.scale.set(gameState.camera.zoom);

    if (gameState.map) {
        syncMapLayer();
        renderResources();
        syncBuildingLayer();
        syncUnitLayer();
        syncEffectsLayer(); // contrails + projectiles + explosions
        syncFogLayer();
    }

    // Overlay (selection box, SLBM targeting) – drawn in world space
    overlayGfx.clear();
    drawGlobalRedZoneExplosions();
    if (gameState.selectionBox) {
        const box = gameState.selectionBox;
        overlayGfx.lineStyle(2 / gameState.camera.zoom, 0x4fc3f7, 1);
        overlayGfx.drawRect(
            Math.min(box.startX, box.endX),
            Math.min(box.startY, box.endY),
            Math.abs(box.endX - box.startX),
            Math.abs(box.endY - box.startY)
        );
    }
    if (slbmTargetingMode) {
        overlayGfx.lineStyle(3 / gameState.camera.zoom, 0xff0000, 1);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, 800);
        overlayGfx.moveTo(mouse.worldX - 100, mouse.worldY);
        overlayGfx.lineTo(mouse.worldX + 100, mouse.worldY);
        overlayGfx.moveTo(mouse.worldX, mouse.worldY - 100);
        overlayGfx.lineTo(mouse.worldX, mouse.worldY + 100);
    }
    if (airstrikeTargetingMode) {
        overlayGfx.lineStyle(3 / gameState.camera.zoom, 0xff7800, 1);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, AIRSTRIKE_TARGET_RADIUS);
        overlayGfx.moveTo(mouse.worldX - 80, mouse.worldY);
        overlayGfx.lineTo(mouse.worldX + 80, mouse.worldY);
        overlayGfx.moveTo(mouse.worldX, mouse.worldY - 80);
        overlayGfx.lineTo(mouse.worldX, mouse.worldY + 80);
    }
    if (reconTargetingMode) {
        overlayGfx.lineStyle(3 / gameState.camera.zoom, 0x9ba7b3, 1);
        overlayGfx.beginFill(0x9ba7b3, 0.08);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, RECON_AIRCRAFT_VISION_RADIUS);
        overlayGfx.endFill();
        overlayGfx.moveTo(mouse.worldX - 70, mouse.worldY);
        overlayGfx.lineTo(mouse.worldX + 70, mouse.worldY);
        overlayGfx.moveTo(mouse.worldX, mouse.worldY - 70);
        overlayGfx.lineTo(mouse.worldX, mouse.worldY + 70);
    }
    if (mineTargetingMode) {
        const selectedDestroyer = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .find(u => u && u.userId === gameState.userId && u.type === 'destroyer');
        const canLayMine = canLayMineAtTarget(selectedDestroyer, mouse.worldX, mouse.worldY);
        overlayGfx.lineStyle(2 / gameState.camera.zoom, canLayMine ? 0x00c853 : 0xff5252, 1);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, 80);
        overlayGfx.beginFill(canLayMine ? 0x111111 : 0x880000, 0.5);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, 20);
        overlayGfx.endFill();
    }

    // Trigger PixiJS to present the frame
    pixiApp.renderer.render(pixiApp.stage);
}

function syncFogLayer() {
    if (!fogLayerCanvas) { fogLayer.visible = false; return; }
    const map = gameState.map;
    if (!map) { fogLayer.visible = false; return; }
    if (hasTemporaryFullMapReveal()) { fogLayer.visible = false; return; }

    // Create or update fog texture from offscreen canvas
    if (!fogTexture) {
        fogTexture = PIXI.Texture.from(fogLayerCanvas, { scaleMode: PIXI.SCALE_MODES.NEAREST });
    }
    fogTexture.baseTexture.resource.update();
    fogTexture.update();
    fogLayer.texture = fogTexture;
    fogLayer.width = map.width;
    fogLayer.height = map.height;
    fogLayer.visible = true;
}

function syncMapLayer() {
    const map = gameState.map;
    if (!map) { mapLayer.visible = false; return; }
    ensureMapImageLoaded();
    ensureLandMaskLoaded();

    if (mapImageLoaded && mapImage && !mapImageLoadFailed) {
        if (!mapTexture) {
            mapTexture = PIXI.Texture.from(mapImage);
        }
        mapLayer.texture = mapTexture;
        mapLayer.width = map.width;
        mapLayer.height = map.height;
        mapLayer.visible = true;
    } else {
        mapLayer.visible = false;
    }

    if (landMaskCanvas) {
        if (!landMaskTexture) {
            landMaskTexture = PIXI.Texture.from(landMaskCanvas, { scaleMode: PIXI.SCALE_MODES.NEAREST });
        }
        landMaskLayer.texture = landMaskTexture;
        landMaskLayer.width = map.width;
        landMaskLayer.height = map.height;
        landMaskLayer.alpha = IMAGE_LAND_MASK_ALPHA;
        landMaskLayer.visible = true;
    } else {
        landMaskLayer.visible = false;
    }
}

function renderResources() {
    // 자원 노드 시각화 비활성화 (요청 반영)
    // 자원은 사전에 존재하고 일꾼은 채집 불가
    return;
}

function getViewportBounds(padding = 0) {
    const viewWidth = canvas.width / gameState.camera.zoom;
    const viewHeight = canvas.height / gameState.camera.zoom;
    return {
        left: gameState.camera.x - viewWidth / 2 - padding,
        right: gameState.camera.x + viewWidth / 2 + padding,
        top: gameState.camera.y - viewHeight / 2 - padding,
        bottom: gameState.camera.y + viewHeight / 2 + padding
    };
}

function isInViewport(x, y, padding = 0) {
    const bounds = getViewportBounds(padding);
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function getFogKey(x, y, gridSize) {
    return (y * gridSize) + x;
}

function getFogCircleOffsets(gridRadius) {
    let cached = fogCircleOffsetsCache.get(gridRadius);
    if (cached) {
        return cached;
    }

    const offsets = [];
    const r2 = gridRadius * gridRadius;
    for (let dx = -gridRadius; dx <= gridRadius; dx++) {
        for (let dy = -gridRadius; dy <= gridRadius; dy++) {
            if ((dx * dx) + (dy * dy) <= r2) {
                offsets.push([dx, dy]);
            }
        }
    }

    fogCircleOffsetsCache.set(gridRadius, offsets);
    return offsets;
}

function revealFogArea(gridX, gridY, gridSize, offsets, now) {
    for (let i = 0; i < offsets.length; i++) {
        const dx = offsets[i][0];
        const dy = offsets[i][1];
        const checkX = gridX + dx;
        const checkY = gridY + dy;

        if (checkX < 0 || checkX >= gridSize || checkY < 0 || checkY >= gridSize) {
            continue;
        }

        const key = getFogKey(checkX, checkY, gridSize);
        const existing = gameState.fogOfWar.get(key);
        if (existing) {
            existing.lastSeen = now;
            existing.explored = true;
        } else {
            gameState.fogOfWar.set(key, { lastSeen: now, explored: true });
        }
    }
}

// ---- Fog offscreen canvas helpers ----

/**
 * Lazily creates (or re-creates on grid-size change) the off-screen fog canvas.
 * One pixel = one grid cell; scaled to map world-size in renderFogOfWar.
 */
function ensureFogLayerCanvas(gridSize) {
    if (fogLayerCanvas && fogLayerGridSize === gridSize) return;
    fogLayerCanvas = document.createElement('canvas');
    fogLayerCanvas.width  = gridSize;
    fogLayerCanvas.height = gridSize;
    fogLayerCtx   = fogLayerCanvas.getContext('2d');
    fogLayerGridSize = gridSize;
    fogLayerCtx.fillStyle = FOG_BASE_FILL_STYLE;
    fogLayerCtx.fillRect(0, 0, gridSize, gridSize);
}

/**
 * Redraws the entire fogLayerCanvas to reflect the current fog state.
 * Called once per updateFogOfWar() tick (??.5 Hz), NOT every rAF frame.
 * Algorithm:
 *   1. Fill everything with the default dim fog
 *   2. destination-out erase only the cells inside the current vision snapshot
 */
function refreshFogLayer(gridSize, now) {
    if (!fogLayerCtx) return;
    const fctx = fogLayerCtx;

    fctx.globalCompositeOperation = 'source-over';
    fctx.fillStyle = FOG_BASE_FILL_STYLE;
    fctx.fillRect(0, 0, gridSize, gridSize);

    fctx.globalCompositeOperation = 'destination-out';
    fctx.fillStyle = '#000';
    gameState.fogOfWar.forEach((fogInfo, key) => {
        if (!fogInfo.explored || now - fogInfo.lastSeen >= FOG_VISIBLE_WINDOW_MS) return;
        const x = key % gridSize;
        const y = (key / gridSize) | 0;
        fctx.fillRect(x, y, 1, 1);
    });

    fctx.globalCompositeOperation = 'source-over';
}

// Get player color based on user ID
function getPlayerColor(userId) {
    if (userId === gameState.userId) {
        return '#4fc3f7'; // Cyan for own units
    }
    
    // Generate consistent color for each player ID
    const colors = [
        '#ff5252', // Red
        '#ffeb3b', // Yellow
        '#4caf50', // Green
        '#9c27b0', // Purple
        '#ff9800', // Orange
        '#00bcd4', // Teal
        '#e91e63', // Pink
        '#8bc34a'  // Light Green
    ];
    
    // Use Math.abs to handle negative AI player IDs
    const idx = Math.abs(userId) % colors.length;
    return colors[idx];
}

// Check if a world position is currently visible (not in fog) for the local player
function isPositionVisible(worldX, worldY) {
    const map = gameState.map;
    if (!map) return true;
    if (hasTemporaryFullMapReveal()) return true;
    const gridSize = getMapGridSize(map);
    const cellSize = getMapCellSize(map);
    if (!gridSize || !cellSize) return true;
    
    const gx = Math.floor(worldX / cellSize);
    const gy = Math.floor(worldY / cellSize);
    if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) return false;
    
    const key = getFogKey(gx, gy, gridSize);
    const fogInfo = gameState.fogOfWar.get(key);
    if (!fogInfo || !fogInfo.explored) return false;
    
    const timeSince = Date.now() - fogInfo.lastSeen;
    return timeSince < FOG_VISIBLE_WINDOW_MS;
}

function isLandAtWorldPosition(worldX, worldY) {
    const map = gameState.map;
    if (!map) return false;
    const gridSize = getMapGridSize(map);
    const cellSize = getMapCellSize(map);
    if (!gridSize || !cellSize || !map.landCellSet) return false;
    const gx = Math.floor(worldX / cellSize);
    const gy = Math.floor(worldY / cellSize);
    if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) return false;
    return map.landCellSet.has(getFogKey(gx, gy, gridSize));
}

function getDestroyerOwnedMineCount(destroyerId) {
    let count = 0;
    gameState.units.forEach(unit => {
        if (unit.type !== 'mine' || unit.userId !== gameState.userId) return;
        if (unit.sourceDestroyerId == null || unit.sourceDestroyerId === destroyerId) {
            count++;
        }
    });
    return count;
}

function canLayMineAtTarget(destroyer, targetX, targetY) {
    if (!destroyer) return false;
    const dx = targetX - destroyer.x;
    const dy = targetY - destroyer.y;
    if ((dx * dx) + (dy * dy) > DESTROYER_VISION_RADIUS * DESTROYER_VISION_RADIUS) return false;
    if (isLandAtWorldPosition(targetX, targetY)) return false;
    if (!isPositionVisible(targetX, targetY)) return false;
    if (getDestroyerOwnedMineCount(destroyer.id) >= DESTROYER_MAX_MINES) return false;
    return true;
}

// PixiJS helper: parse hex color string to number
function colorToHex(colorStr) {
    if (typeof colorStr === 'number') return colorStr;
    if (colorStr.startsWith('#')) return parseInt(colorStr.slice(1), 16);
    return 0xffffff;
}

// Building sprite cache for PixiJS
const buildingSpriteMap = new Map(); // buildingId -> { container, sprite, lastImgIdx }

function pickLoadedBuildingFrame(images, loadedFlags, preferredIdx) {
    if (loadedFlags[preferredIdx]) {
        return { img: images[preferredIdx], idx: preferredIdx };
    }
    for (let i = preferredIdx - 1; i >= 0; i--) {
        if (loadedFlags[i]) return { img: images[i], idx: i };
    }
    for (let i = preferredIdx + 1; i < loadedFlags.length; i++) {
        if (loadedFlags[i]) return { img: images[i], idx: i };
    }
    return null;
}

function getBuildingImage(building) {
    if (building.type === 'headquarters') {
        if (hqImageLoaded) return { img: hqImage, idx: 0 };
        return null;
    }
    if (building.type === 'power_plant') {
        const idx = getPowerPlantImageIndex();
        return pickLoadedBuildingFrame(bjsImages, bjsImagesLoaded, idx);
    }
    if (building.type === 'shipyard') {
        const idx = getShipyardImageIndex(building);
        return pickLoadedBuildingFrame(jssImages, jssImagesLoaded, idx);
    }
    if (building.type === 'naval_academy') {
        const idx = getNavalAcademyImageIndex(building);
        return pickLoadedBuildingFrame(djssImages, djssImagesLoaded, idx);
    }
    if (building.type === 'carbase' && carbaseBuildingImageLoaded) {
        return { img: carbaseBuildingImage, idx: 0 };
    }
    if (building.type === 'defense_tower' && defenseTowerBaseLoaded) {
        return {
            img: defenseTowerBaseImage,
            idx: 0,
            fixedMaxDimension: FIXED_BUILDING_IMAGE_MAX_DIMENSION
        };
    }
    if (building.type === 'missile_silo' && missileSiloLoaded) {
        return {
            img: missileSiloImage,
            idx: 0,
            fixedMaxDimension: FIXED_BUILDING_IMAGE_MAX_DIMENSION
        };
    }
    return null;
}

function getBuildingTypeSizeScale(type) {
    if (type === 'power_plant') return POWER_PLANT_SIZE_SCALE;
    if (type === 'shipyard' || type === 'naval_academy' || type === 'carbase') return COASTAL_BUILDING_SIZE_SCALE;
    return 1;
}

function getBuildingDisplaySize(building) {
    const imgData = getBuildingImage(building);
    if (imgData && imgData.fixedMaxDimension) {
        const fixedSize = getFixedImageDisplaySize(imgData.img, imgData.fixedMaxDimension);
        return {
            width: fixedSize.width,
            height: fixedSize.height
        };
    }
    const hasImage = !!(imgData && imgData.img);
    const aspectRatio = hasImage && imgData.img.height
        ? imgData.img.width / imgData.img.height
        : (buildingDisplaySize.width / Math.max(1, buildingDisplaySize.height));
    const baseHeight = (imgData && buildingSizeInitialized) ? buildingDisplaySize.height : 200;
    const baseSize = {
        width: baseHeight * aspectRatio,
        height: baseHeight
    };
    const scale = getBuildingTypeSizeScale(building.type);
    return {
        width: baseSize.width * scale,
        height: baseSize.height * scale
    };
}

function getBuildingHitboxHalfSize(building) {
    const dispSize = getBuildingDisplaySize(building);
    return Math.max(dispSize.width, dispSize.height) / 2;
}

function createBuildingSpriteEntry(building, imgData, dispSize) {
    const container = new PIXI.Container();
    const tex = getOrCreateTexture(imgData.img);
    const sprite = tex ? new PIXI.Sprite(tex) : null;
    let cannonSprite = null;

    if (sprite) {
        sprite.anchor.set(0.5);
        sprite.width = dispSize.width;
        sprite.height = dispSize.height;
        container.addChild(sprite);
    }

    if (building.type === 'defense_tower' && defenseTowerCannonLoaded && defenseTowerCannonImage) {
        const cannonTex = getOrCreateTexture(defenseTowerCannonImage);
        if (cannonTex) {
            const metrics = getDefenseTowerVisualMetrics();
            cannonSprite = new PIXI.Sprite(cannonTex);
            cannonSprite.anchor.set(metrics.cannonAnchorX, metrics.cannonAnchorY);
            cannonSprite.width = metrics.cannonWidth;
            cannonSprite.height = metrics.cannonHeight;
            cannonSprite.position.set(metrics.cannonPivotLocalX, metrics.cannonPivotLocalY);
            container.addChild(cannonSprite);
        }
    }

    container.position.set(building.x, building.y);
    buildingSpriteLayer.addChild(container);
    return {
        container,
        sprite,
        cannonSprite,
        lastImgIdx: imgData.idx,
        buildingType: building.type
    };
}

function syncBuildingLayer() {
    buildingGfx.clear();
    const viewport = getViewportBounds(240);
    const activeBuildingIds = new Set();
    
    gameState.buildings.forEach((building, buildingId) => {
        if (building.x < viewport.left || building.x > viewport.right ||
            building.y < viewport.top || building.y > viewport.bottom) return;
        if (building.userId !== gameState.userId && !isPositionVisible(building.x, building.y)) return;

        activeBuildingIds.add(buildingId);
        const color = colorToHex(getPlayerColor(building.userId));
        const dispSize = getBuildingDisplaySize(building);
        const size = Math.max(dispSize.width, dispSize.height);
        const isSelected = gameState.selection.has(buildingId);

        // Try to render with image
        const imgData = getBuildingImage(building);
        if (imgData) {
            let entry = buildingSpriteMap.get(buildingId);
            if (entry && entry.buildingType !== building.type) {
                if (entry.container.parent) entry.container.parent.removeChild(entry.container);
                entry.container.destroy({ children: true });
                buildingSpriteMap.delete(buildingId);
                entry = null;
            }
            if (!entry) {
                entry = createBuildingSpriteEntry(building, imgData, dispSize);
                buildingSpriteMap.set(buildingId, entry);
            } else {
                entry.container.position.set(building.x, building.y);
                if (entry.sprite) {
                    entry.sprite.width = dispSize.width;
                    entry.sprite.height = dispSize.height;
                }
                if (entry.lastImgIdx !== imgData.idx && entry.sprite) {
                    const tex = getOrCreateTexture(imgData.img);
                    if (tex) {
                        entry.sprite.texture = tex;
                        entry.lastImgIdx = imgData.idx;
                    }
                }
            }

            if (building.type === 'defense_tower') {
                if (!entry.cannonSprite && defenseTowerCannonLoaded && defenseTowerCannonImage) {
                    const cannonTex = getOrCreateTexture(defenseTowerCannonImage);
                    if (cannonTex) {
                        const metrics = getDefenseTowerVisualMetrics();
                        entry.cannonSprite = new PIXI.Sprite(cannonTex);
                        entry.cannonSprite.anchor.set(metrics.cannonAnchorX, metrics.cannonAnchorY);
                        entry.cannonSprite.width = metrics.cannonWidth;
                        entry.cannonSprite.height = metrics.cannonHeight;
                        entry.cannonSprite.position.set(metrics.cannonPivotLocalX, metrics.cannonPivotLocalY);
                        entry.container.addChild(entry.cannonSprite);
                    }
                }

                if (entry.cannonSprite) {
                    const metrics = getDefenseTowerVisualMetrics();
                    entry.cannonSprite.width = metrics.cannonWidth;
                    entry.cannonSprite.height = metrics.cannonHeight;
                    entry.cannonSprite.position.set(metrics.cannonPivotLocalX, metrics.cannonPivotLocalY);
                    const aimTarget = getDefenseTowerAimTarget(building);
                    if (!Number.isFinite(building.turretAngle)) {
                        building.turretAngle = 0;
                    }
                    if (aimTarget) {
                        const desiredAimAngle = Math.atan2(
                            aimTarget.y - (building.y + metrics.cannonPivotLocalY),
                            aimTarget.x - (building.x + metrics.cannonPivotLocalX)
                        );
                        building.turretAngle = desiredAimAngle - metrics.cannonBaseAngle;
                    }
                    entry.cannonSprite.rotation = building.turretAngle;
                }
            }
            entry.container.visible = true;
        } else {
            // Fallback: colored rectangle for buildings without images
            buildingGfx.beginFill(color);
            buildingGfx.drawRect(building.x - size/2, building.y - size/2, size, size);
            buildingGfx.endFill();
            buildingGfx.lineStyle(2, 0xffffff, 1);
            buildingGfx.drawRect(building.x - size/2, building.y - size/2, size, size);
            buildingGfx.lineStyle(0);
        }

        // Build progress bar
        if (building.buildProgress < 100) {
            buildingGfx.beginFill(0xffffff, 0.3);
            buildingGfx.drawRect(building.x - size/2, building.y + size/2 + 5, (size * building.buildProgress) / 100, 5);
            buildingGfx.endFill();
        }

        // Production progress bar
        if (building.producing && building.buildProgress >= 100) {
            const elapsed = Date.now() - building.producing.startTime;
            const prodProgress = Math.min(1, elapsed / building.producing.buildTime);
            buildingGfx.beginFill(0x000000, 0.5);
            buildingGfx.drawRect(building.x - size/2, building.y + size/2 + 12, size, 6);
            buildingGfx.endFill();
            buildingGfx.beginFill(0xffcc00);
            buildingGfx.drawRect(building.x - size/2, building.y + size/2 + 12, size * prodProgress, 6);
            buildingGfx.endFill();
        }

        if (isSelected) {
            const hpBarWidth = size * 0.6;
            const hpBarHeight = 4;
            const hpBarX = building.x - hpBarWidth / 2;
            let hpBarY = building.y + size / 2 + 10;
            if (building.buildProgress < 100) hpBarY += 8;
            if (building.producing && building.buildProgress >= 100) hpBarY += 10;
            buildingGfx.beginFill(0xff0000);
            buildingGfx.drawRect(hpBarX, hpBarY, hpBarWidth, hpBarHeight);
            buildingGfx.endFill();
            buildingGfx.beginFill(0x00ff00);
            buildingGfx.drawRect(hpBarX, hpBarY, (hpBarWidth * building.hp) / building.maxHp, hpBarHeight);
            buildingGfx.endFill();
        }
    });
    
    // Cleanup sprites for destroyed buildings, hide off-viewport ones
    buildingSpriteMap.forEach((entry, id) => {
        if (!gameState.buildings.has(id)) {
            if (entry.container.parent) entry.container.parent.removeChild(entry.container);
            entry.container.destroy({ children: true });
            buildingSpriteMap.delete(id);
        } else if (!activeBuildingIds.has(id)) {
            entry.container.visible = false;
        }
    });
}

function syncUnitLayer() {
    const viewport = getViewportBounds(120);
    const activeIds = new Set();

    gameState.units.forEach((unit, unitId) => {
        // Visibility checks
        if (unit.type === 'submarine' && unit.userId !== gameState.userId && !unit.isDetected) return;
        if (unit.type === 'mine' && unit.userId !== gameState.userId && !unit.isDetected) return;
        const posX = unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x;
        const posY = unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y;
        if (unit.userId !== gameState.userId && !isPositionVisible(posX, posY)) return;
        if (posX < viewport.left || posX > viewport.right || posY < viewport.top || posY > viewport.bottom) return;

        activeIds.add(unitId);
        const isSelected = gameState.selection.has(unitId);
        const size = getUnitSelectionBaseSize(unit);
        const angle = unit.displayAngle !== undefined ? unit.displayAngle : 0;

        // Get or create sprite entry - consolidated recreation check
        let entry = unitSpriteMap.get(unitId);
        let needsRecreate = false;
        
        if (!entry || entry.unitType !== unit.type) {
            needsRecreate = true;
        } else if (!entry.mainSprite && unit.type !== 'worker' && unit.type !== 'battleship' && unit.type !== 'mine') {
            // Fallback shape but image may be loaded now
            if (getUnitImage(unit)) needsRecreate = true;
        } else if (unit.type === 'battleship') {
            if (entry.gfxShape && getBattleshipBodyImage(unit)) {
                needsRecreate = true;
            } else {
                const desiredBodyImg = getBattleshipBodyImage(unit);
                const desiredBodySrc = desiredBodyImg ? desiredBodyImg.src : null;
                const desiredCannonImg = getBattleshipCannonImage(unit);
                const desiredCannonSrc = desiredCannonImg ? desiredCannonImg.src : null;
                if (desiredBodySrc && entry.battleshipBodySrc !== desiredBodySrc) needsRecreate = true;
                else if (desiredCannonSrc && entry.battleshipCannonSrc !== desiredCannonSrc) needsRecreate = true;
                else if (entry.battleshipAegisMode !== !!unit.battleshipAegisMode) needsRecreate = true;
            }
        } else if (unit.type === 'cruiser' && entry.aegisMode !== !!unit.aegisMode) {
            needsRecreate = true;
        }
        
        if (needsRecreate) {
            if (entry) destroyUnitSpriteEntry(entry);
            entry = createUnitSpriteEntry(unit, size);
            if (unit.type === 'battleship') entry.battleshipAegisMode = !!unit.battleshipAegisMode;
            if (unit.type === 'cruiser') entry.aegisMode = !!unit.aegisMode;
            unitSpriteMap.set(unitId, entry);
            attachUnitSpriteEntry(entry);
        }

        syncImageUnitSprite(entry, unit, size);
        attachUnitSpriteEntry(entry);

        // Update position and rotation
        entry.container.position.set(posX, posY);
        entry.container.rotation = angle;
        entry.container.visible = true;

        // Update color for worker
        if (unit.type === 'worker' && entry.gfxShape) {
            const c = WORKER_FILL_COLOR;
            if (entry.lastColor !== c) {
                entry.gfxShape.clear();
                entry.gfxShape.beginFill(c);
                entry.gfxShape.drawCircle(0, 0, size / 2);
                entry.gfxShape.endFill();
                entry.gfxShape.lineStyle(1, WORKER_OUTLINE_COLOR);
                entry.gfxShape.drawCircle(0, 0, size / 2);
                entry.lastColor = c;
            }
        }

        // Battleship turret logic
        if (unit.type === 'battleship' && entry.turretSprites && entry.turretSprites.length > 0) {
            const shipAngle = angle;
            const attackTgt = unit.battleshipAegisMode ? null : getBattleshipAimTarget(unit);
            const turretWorldStates = getBattleshipTurretWorldStates(posX, posY, shipAngle, size, null, unit);
            const turretTargetAngles = turretWorldStates.map((ts, ti) => {
                if (attackTgt) return Math.atan2(attackTgt.y - ts.centerY, attackTgt.x - ts.centerX);
                if (unit.turretAngles && unit.turretAngles[ti] !== undefined) return unit.turretAngles[ti];
                return shipAngle;
            });
            if (!unit.turretAngles || unit.turretAngles.length !== turretTargetAngles.length) {
                unit.turretAngles = turretTargetAngles.slice();
            }
            const rotSpeed = 0.08;
            for (let ti = 0; ti < turretTargetAngles.length; ti++) {
                const target = turretTargetAngles[ti];
                if (attackTgt) { unit.turretAngles[ti] = target; continue; }
                let diff = target - unit.turretAngles[ti];
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                unit.turretAngles[ti] = Math.abs(diff) > rotSpeed
                    ? unit.turretAngles[ti] + Math.sign(diff) * rotSpeed
                    : target;
            }
            entry.turretSprites.forEach((ts, ti) => {
                ts.rotation = unit.turretAngles[ti] - shipAngle;
            });
        }
    });

    // Remove sprites for units that no longer exist
    unitSpriteMap.forEach((entry, id) => {
        if (!gameState.units.has(id)) {
            destroyUnitSpriteEntry(entry);
            unitSpriteMap.delete(id);
        } else if (!activeIds.has(id)) {
            entry.container.visible = false;
            detachUnitSpriteEntry(entry);
        }
    });
}

function createUnitSpriteEntry(unit, size) {
    const container = new PIXI.Container();
    let gfxShape = null;
    let mainSprite = null;
    const turretSprites = [];
    let lastColor = 0;
    let lastImageSrc = null;
    let battleshipBodySrc = null;
    let battleshipCannonSrc = null;

    if (unit.type === 'worker') {
        // Worker - circle via Graphics
        gfxShape = new PIXI.Graphics();
        const c = WORKER_FILL_COLOR;
        gfxShape.beginFill(c);
        gfxShape.drawCircle(0, 0, size / 2);
        gfxShape.endFill();
        gfxShape.lineStyle(1, WORKER_OUTLINE_COLOR);
        gfxShape.drawCircle(0, 0, size / 2);
        lastColor = c;
        container.addChild(gfxShape);
    } else if (unit.type === 'mine') {
        // Mine - black circle with dark outline
        gfxShape = new PIXI.Graphics();
        gfxShape.beginFill(0x111111);
        gfxShape.drawCircle(0, 0, size / 2);
        gfxShape.endFill();
        gfxShape.lineStyle(2, 0x333333);
        gfxShape.drawCircle(0, 0, size / 2);
        container.addChild(gfxShape);
    } else if (unit.type === 'battleship') {
        // Battleship body + turrets
        const bodyImg = getBattleshipBodyImage(unit);
        if (bodyImg) {
            battleshipBodySrc = bodyImg.src;
            const tex = getOrCreateTexture(bodyImg);
            if (tex) {
                const metrics = getBattleshipVisualMetrics(size, unit);
                const bodyGroup = new PIXI.Container();
                bodyGroup.rotation = -Math.PI / 2;

                const body = new PIXI.Sprite(tex);
                body.anchor.set(0.5);
                body.width = metrics.baseWidth;
                body.height = metrics.baseHeight;
                bodyGroup.addChild(body);

                // Turrets
                const cannonImg = getBattleshipCannonImage(unit);
                if (cannonImg) {
                    battleshipCannonSrc = cannonImg.src;
                    const cannonTex = getOrCreateTexture(cannonImg);
                    if (cannonTex) {
                        metrics.turretInner.forEach(pos => {
                            const turretC = new PIXI.Container();
                            turretC.position.set(pos.x, pos.y);
                            const ts = new PIXI.Sprite(cannonTex);
                            ts.anchor.set(0.5);
                            ts.width = metrics.turretWidth;
                            ts.height = metrics.turretHeight;
                            turretC.addChild(ts);
                            bodyGroup.addChild(turretC);
                            turretSprites.push(turretC);
                        });
                    }
                }
                container.addChild(bodyGroup);
            }
        }
        if (container.children.length === 0) {
            // Fallback
            gfxShape = new PIXI.Graphics();
            gfxShape.beginFill(0x4fc3f7);
            gfxShape.moveTo(size, 0); gfxShape.lineTo(size*0.2, -size*0.4);
            gfxShape.lineTo(-size*0.8, -size*0.4); gfxShape.lineTo(-size*0.8, size*0.4);
            gfxShape.lineTo(size*0.2, size*0.4); gfxShape.closePath();
            gfxShape.endFill();
            container.addChild(gfxShape);
        }
    } else {
        // Image-based units: submarine, cruiser, carrier, frigate, aircraft, recon_aircraft
        const img = getUnitImage(unit);
        if (img) {
            const tex = getOrCreateTexture(img);
            if (tex) {
                mainSprite = new PIXI.Sprite(tex);
                lastImageSrc = img.src;
                const aspectRatio = getUnitRenderAspectRatio(unit, img);
                const heightMult = getUnitRenderHeightMultiplier(unit);
                const baseHeight = size * heightMult;
                const baseWidth = baseHeight * aspectRatio;
                mainSprite.anchor.set(0.5);
                mainSprite.width = baseWidth;
                mainSprite.height = baseHeight;
                mainSprite.rotation = -Math.PI / 2;
                container.addChild(mainSprite);
            }
        }
        if (!mainSprite) {
            // Fallback shape
            const c = colorToHex(getPlayerColor(unit.userId));
            gfxShape = new PIXI.Graphics();
            gfxShape.beginFill(c);
            if (isAirUnitType(unit)) {
                gfxShape.moveTo(size, 0); gfxShape.lineTo(-size*0.6, size*0.7);
                gfxShape.lineTo(-size*0.3, 0); gfxShape.lineTo(-size*0.6, -size*0.7);
                gfxShape.closePath();
            } else {
                gfxShape.moveTo(size, 0); gfxShape.lineTo(-size/2, size/2); gfxShape.lineTo(-size/2, -size/2); gfxShape.closePath();
            }
            gfxShape.endFill();
            container.addChild(gfxShape);
        }
    }

    return {
        container,
        gfxShape,
        mainSprite,
        turretSprites,
        unitType: unit.type,
        lastColor,
        lastImageSrc,
        battleshipBodySrc,
        battleshipCannonSrc,
        battleshipAegisMode: unit.type === 'battleship' ? !!unit.battleshipAegisMode : undefined
    };
}

// Draw HP bars, selection circles, labels into effectsGfx (called from syncEffectsLayer)
function drawUnitOverlays(gfx) {
    const viewport = getViewportBounds(120);
    const hasSelection = gameState.selection.size > 0;
    const hasInspected = gameState.inspectedUnitId != null;
    
    gameState.units.forEach((unit, unitId) => {
        // Fast path: skip units that can't have any overlay
        const isSelected = hasSelection && gameState.selection.has(unitId);
        const isInspected = hasInspected && gameState.inspectedUnitId === unitId;
        const isOwnStealth = unit.type === 'submarine' && !unit.isDetected && unit.userId === gameState.userId;
        const hasSquadMark = unit.squadId && unit.userId === gameState.userId;
        if (!isSelected && !isInspected && !isOwnStealth && !hasSquadMark) return;
        
        if (!isUnitVisibleToPlayer(unit)) return;
        const { x: posX, y: posY } = getUnitDisplayPosition(unit);
        if (posX < viewport.left || posX > viewport.right || posY < viewport.top || posY > viewport.bottom) return;

        const size = getUnitSelectionBaseSize(unit);

        if (isSelected || isInspected) {
            const hpBarY = posY + size + 8;
            gfx.beginFill(0xff0000);
            gfx.drawRect(posX - size, hpBarY, size * 2, 4);
            gfx.endFill();
            gfx.beginFill(0x00ff00);
            gfx.drawRect(posX - size, hpBarY, (size * 2 * unit.hp) / unit.maxHp, 4);
            gfx.endFill();
        }

        // Stealth indicator for own submarines
        if (isOwnStealth) {
            gfx.beginFill(0x00ff00, 0.8);
            gfx.drawCircle(posX, posY - size - 14, 4);
            gfx.endFill();
        }

        // Squad indicator — small cyan diamond below unit
        if (hasSquadMark) {
            const sqY = posY + size + 14;
            gfx.beginFill(0x00ddff, 0.85);
            gfx.drawPolygon([posX, sqY - 4, posX + 4, sqY, posX, sqY + 4, posX - 4, sqY]);
            gfx.endFill();
        }

        // Selection ellipse - sized to match rendered image shape
        if (isSelected || isInspected) {
            const outlineColor = isSelected ? 0xffff00 : 0xffaa00;
            if (unit.type === 'worker' || unit.type === 'mine') {
                gfx.lineStyle(2, outlineColor, 1);
                gfx.drawCircle(posX, posY, size + 5);
                gfx.lineStyle(0);
            } else {
                const heightMult = getUnitRenderHeightMultiplier(unit);
                const img = getUnitImage(unit);
                const aspectRatio = getUnitRenderAspectRatio(unit, img);
                const semiMajor = (size * heightMult) / 2 + 5; // along heading (ship length)
                const semiMinor = (size * heightMult * aspectRatio) / 2 + 5; // perpendicular (ship width)
                const uAngle = unit.displayAngle !== undefined ? unit.displayAngle : 0;
                // Draw rotated ellipse as polygon - major axis along ship heading
                gfx.lineStyle(2, outlineColor, 1);
                const ellipseSegs = 32;
                const cosA = Math.cos(uAngle);
                const sinA = Math.sin(uAngle);
                const pts = [];
                for (let ei = 0; ei <= ellipseSegs; ei++) {
                    const theta = (ei / ellipseSegs) * Math.PI * 2;
                    const lx = Math.cos(theta) * semiMajor; // along heading
                    const ly = Math.sin(theta) * semiMinor; // perpendicular
                    pts.push(posX + lx * cosA - ly * sinA, posY + lx * sinA + ly * cosA);
                }
                gfx.drawPolygon(pts);
                gfx.lineStyle(0);
            }
        }
    });
}

// Helper: draw flame trail behind SLBM piece (PixiJS Graphics version)
function drawSlbmFlameGfx(gfx, x, y, angle, width, length) {
    const segments = 6;
    for (let i = segments; i >= 0; i--) {
        const t = i / segments;
        const fx = x - Math.cos(angle) * length * t;
        const fy = y - Math.sin(angle) * length * t;
        const segRadius = (width / 2) * (1 - t * 0.5);
        const segAlpha = (1 - t) * 0.8;
        const r = 255;
        const g = Math.floor(80 + (1 - t) * 175);
        const b = Math.floor((1 - t) * 40);
        const color = (r << 16) | (g << 8) | b;
        gfx.beginFill(color, segAlpha);
        gfx.drawCircle(fx, fy, segRadius);
        gfx.endFill();
    }
}

// Draw a rotated rectangle centered at (cx, cy) with given width, height, rotation angle
function drawRotatedRect(gfx, cx, cy, w, h, angle, color, alpha) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const hw = w / 2;
    const hh = h / 2;
    // Rectangle corners relative to center, rotated
    // The "length" (h) goes along the angle direction, "width" (w) perpendicular
    const dx_along = cos * hh;
    const dy_along = sin * hh;
    const dx_perp = -sin * hw;
    const dy_perp = cos * hw;
    gfx.beginFill(color, alpha !== undefined ? alpha : 1);
    gfx.drawPolygon([
        cx + dx_along + dx_perp, cy + dy_along + dy_perp,  // front-right
        cx + dx_along - dx_perp, cy + dy_along - dy_perp,  // front-left
        cx - dx_along - dx_perp, cy - dy_along - dy_perp,  // rear-left
        cx - dx_along + dx_perp, cy - dy_along + dy_perp   // rear-right
    ]);
    gfx.endFill();
}

// Manage airstrike.png PIXI sprites for flying airstrikes
const airstrikeSpriteMap = new Map(); // strikeId -> PIXI.Sprite
function syncAirstrikeSprites(now, viewport) {
    if (!gameState.activeAirstrikes) gameState.activeAirstrikes = [];
    const activeIds = new Set();
    
    // Remove airstrikes that have completed their flight (progress >= 1)
    gameState.activeAirstrikes = gameState.activeAirstrikes.filter(s => {
        const elapsed = now - s.startTime;
        const progress = Math.min(1, elapsed / s.flightTime);
        return progress < 1;
    });
    
    gameState.activeAirstrikes.forEach(strike => {
        // Skip flights that haven't started yet (delayed 2nd/3rd flights)
        if (now < strike.startTime) return;
        const elapsed = now - strike.startTime;
        const progress = Math.min(1, elapsed / strike.flightTime);
        if (progress >= 1) return;
        
        const destX = strike.exitX != null ? strike.exitX : strike.targetX;
        const destY = strike.exitY != null ? strike.exitY : strike.targetY;
        const currentX = strike.fromX + (destX - strike.fromX) * progress;
        const currentY = strike.fromY + (destY - strike.fromY) * progress;
        const angle = Math.atan2(destY - strike.fromY, destX - strike.fromX);
        
        activeIds.add(strike.id);
        let sprite = airstrikeSpriteMap.get(strike.id);
        if (!sprite) {
            if (airstrikeImageLoaded && airstrikeImage) {
                const tex = getOrCreateTexture(airstrikeImage);
                if (tex) {
                    sprite = new PIXI.Sprite(tex);
                    sprite.anchor.set(0.5);
                    const origW = airstrikeImage.width;
                    const origH = airstrikeImage.height;
                    const aspectRatio = origW / origH;
                    const baseHeight = 60 * 6.6;
                    sprite.height = baseHeight;
                    sprite.width = baseHeight * aspectRatio;
                    airstrikeLayer.addChild(sprite);
                    airstrikeSpriteMap.set(strike.id, sprite);
                }
            }
            if (!sprite) {
                // Fallback: orange circle via Graphics
                sprite = new PIXI.Graphics();
                sprite.beginFill(0xff8800, 0.9);
                sprite.drawCircle(0, 0, 20);
                sprite.endFill();
                airstrikeLayer.addChild(sprite);
                airstrikeSpriteMap.set(strike.id, sprite);
            }
        }
        sprite.position.set(currentX, currentY);
        sprite.rotation = angle + Math.PI / 2; // airstrike image is 180° flipped vs ship images
        sprite.visible = true;
    });
    
    // Remove sprites no longer active
    airstrikeSpriteMap.forEach((sprite, id) => {
        if (!activeIds.has(id)) {
            airstrikeLayer.removeChild(sprite);
            if (sprite.destroy) sprite.destroy();
            airstrikeSpriteMap.delete(id);
        }
    });
}

// Combined effects rendering: battleship exhaust + contrails + projectiles + explosions + unit overlays
function syncEffectsLayer() {
    effectsGfx.clear();
    const now = Date.now();
    const viewport = getViewportBounds(500);
    const loadSettings = getClientLoadSettings();
    syncSlbmFlightSounds(now);

    // Keep smoke underneath selection circles and HP bars.
    syncYamatoExhaust(now, viewport, loadSettings);
    drawYamatoExhaust(effectsGfx, now, viewport);

    // --- Unit overlays (HP bars, selection circles) ---
    drawUnitOverlays(effectsGfx);

    // --- Contrails ---
    slbmContrails.forEach(contrail => {
        contrail.segments = contrail.segments.filter(seg => now - seg.time < 3000);
        for (let i = 0; i < contrail.segments.length - 1; i += loadSettings.contrailStride) {
            const seg = contrail.segments[i];
            const nextSeg = contrail.segments[Math.min(i + loadSettings.contrailStride, contrail.segments.length - 1)];
            if (seg.x < viewport.left - 100 || seg.x > viewport.right + 100 ||
                seg.y < viewport.top - 100 || seg.y > viewport.bottom + 100) continue;
            const age = now - seg.time;
            const fadeProgress = age / 3000;
            const alpha = Math.max(0, 0.3 - fadeProgress * 0.3);
            effectsGfx.lineStyle(loadSettings.detailedProjectiles ? 24 : 16, 0xc8c8c8, alpha);
            effectsGfx.moveTo(seg.x, seg.y);
            effectsGfx.lineTo(nextSeg.x, nextSeg.y);
        }
    });
    slbmContrails = slbmContrails.filter(c => c.segments.length > 0);
    effectsGfx.lineStyle(0);

    // --- Attack projectiles ---
    if (attackProjectiles.length > 0) {
        attackProjectiles = attackProjectiles.filter(projectile => {
            const keep = now - projectile.startTime <= projectile.flightTime + 900;
            if (!keep && projectile.soundInstance) {
                projectile.soundInstance = stopManagedBattleSound(projectile.soundInstance);
            }
            return keep;
        });
    }
    syncBattleshipProjectileSounds(now);

    attackProjectiles.forEach(projectile => {
        const progress = Math.max(0, Math.min(1, (now - projectile.startTime) / projectile.flightTime));
        let finalTargetX = projectile.targetX, finalTargetY = projectile.targetY;
        if (projectile.targetId) {
            const tu = gameState.units.get(projectile.targetId);
            if (tu) {
                finalTargetX = tu.interpDisplayX !== undefined ? tu.interpDisplayX : tu.x;
                finalTargetY = tu.interpDisplayY !== undefined ? tu.interpDisplayY : tu.y;
            }
        }
        const currentX = projectile.fromX + (finalTargetX - projectile.fromX) * progress;
        const currentY = projectile.fromY + (finalTargetY - projectile.fromY) * progress;
        if (currentX < viewport.left || currentX > viewport.right || currentY < viewport.top || currentY > viewport.bottom) return;
        if (!isPositionVisible(currentX, currentY)) return;

        if (progress >= 1) {
            const impactAge = (now - projectile.startTime) - projectile.flightTime;
            const impactProgress = impactAge / 900;
            if (impactProgress < 1) {
                const isBig = projectile.shooterType === 'battleship' || projectile.shooterType === 'defense_tower';
                const isMissileLauncherShot = projectile.shooterType === 'missile_launcher';
                const impactRadius = isMissileLauncherShot
                    ? (22 + impactProgress * 10)
                    : ((isBig ? 30 : 18) * (1 + impactProgress * 0.5));
                const impactAlpha = Math.max(0, isMissileLauncherShot ? (0.45 - impactProgress * 0.45) : (0.6 - impactProgress * 0.6));
                effectsGfx.beginFill(isMissileLauncherShot ? 0xcfd6dd : 0xff8c28, impactAlpha);
                effectsGfx.drawCircle(finalTargetX, finalTargetY, impactRadius);
                effectsGfx.endFill();
                if (isMissileLauncherShot) {
                    effectsGfx.beginFill(0xffc46b, Math.max(0, 0.28 - impactProgress * 0.28));
                    effectsGfx.drawCircle(finalTargetX, finalTargetY, 12 + impactProgress * 8);
                    effectsGfx.endFill();
                }
            }
            return;
        }

        const isTorpedoShot = projectile.projectileKind === 'torpedo' || projectile.shooterType === 'submarine';
        if (isTorpedoShot) {
            const dx = finalTargetX - projectile.fromX;
            const dy = finalTargetY - projectile.fromY;
            const angle = Math.atan2(dy, dx);
            if (!loadSettings.detailedProjectiles) {
                effectsGfx.lineStyle(3, 0xaad6ff, 0.22);
                effectsGfx.moveTo(
                    currentX - Math.cos(angle) * 24,
                    currentY - Math.sin(angle) * 24
                );
                effectsGfx.lineTo(currentX, currentY);
                effectsGfx.lineStyle(0);
                effectsGfx.beginFill(0x4a647c);
                effectsGfx.drawCircle(currentX, currentY, 4);
                effectsGfx.endFill();
                return;
            }
            const torpedoWidth = 8;
            const torpedoLength = 34;
            const halfLength = torpedoLength / 2;

            effectsGfx.lineStyle(3, 0xaad6ff, 0.22);
            effectsGfx.moveTo(
                currentX - Math.cos(angle) * (torpedoLength * 1.2),
                currentY - Math.sin(angle) * (torpedoLength * 1.2)
            );
            effectsGfx.lineTo(currentX, currentY);
            effectsGfx.lineStyle(0);

            drawRotatedRect(effectsGfx, currentX, currentY, torpedoWidth, torpedoLength, angle, 0x3b556b);
            drawRotatedRect(
                effectsGfx,
                currentX + Math.cos(angle) * (halfLength * 0.15),
                currentY + Math.sin(angle) * (halfLength * 0.15),
                torpedoWidth * 0.72,
                torpedoLength * 0.24,
                angle,
                0x88a7be
            );

            const propX = currentX - Math.cos(angle) * halfLength;
            const propY = currentY - Math.sin(angle) * halfLength;
            effectsGfx.beginFill(0xd7f0ff, 0.55);
            effectsGfx.drawCircle(propX, propY, 3 + Math.random() * 1.8);
            effectsGfx.endFill();
            return;
        }

        if (projectile.shooterType === 'missile_launcher') {
            const dx = finalTargetX - projectile.fromX;
            const dy = finalTargetY - projectile.fromY;
            const angle = Math.atan2(dy, dx);
            if (!loadSettings.detailedProjectiles) {
                effectsGfx.lineStyle(4, 0xb5bcc4, 0.18);
                effectsGfx.moveTo(
                    currentX - Math.cos(angle) * 48,
                    currentY - Math.sin(angle) * 48
                );
                effectsGfx.lineTo(currentX, currentY);
                effectsGfx.lineStyle(0);
                effectsGfx.beginFill(0x8f99a3);
                effectsGfx.drawCircle(currentX, currentY, 6);
                effectsGfx.endFill();
                return;
            }
            const missileWidth = 12;
            const missileLength = 75;
            const halfLength = missileLength / 2;
            effectsGfx.lineStyle(6, 0xb5bcc4, 0.18);
            effectsGfx.moveTo(
                currentX - Math.cos(angle) * (missileLength * 0.9),
                currentY - Math.sin(angle) * (missileLength * 0.9)
            );
            effectsGfx.lineTo(currentX, currentY);
            effectsGfx.lineStyle(0);
            drawRotatedRect(effectsGfx, currentX, currentY, missileWidth, missileLength, angle, 0x8f99a3);
            drawRotatedRect(
                effectsGfx,
                currentX + Math.cos(angle) * (halfLength * 0.18),
                currentY + Math.sin(angle) * (halfLength * 0.18),
                missileWidth * 0.55,
                missileLength * 0.22,
                angle,
                0xdfe5ea
            );
            const rearX = currentX - Math.cos(angle) * halfLength;
            const rearY = currentY - Math.sin(angle) * halfLength;
            drawSlbmFlameGfx(effectsGfx, rearX, rearY, angle, missileWidth * 0.8, 22);
            return;
        }

        const isBattleshipShell = projectile.shooterType === 'battleship' || projectile.shooterType === 'defense_tower';
        const shellRadius = isBattleshipShell ? 5 : 3;
        const isAimedShot = projectile.aimedShot;
        const dx = finalTargetX - projectile.fromX;
        const dy = finalTargetY - projectile.fromY;
        const angle = Math.atan2(dy, dx);
        const trailLength = isBattleshipShell ? 120 : 22;
        const trailSegments = loadSettings.projectileTrailSegments;

        for (let i = trailSegments; i >= 0; i--) {
            const t = i / trailSegments;
            const trailX = currentX - Math.cos(angle) * trailLength * t;
            const trailY = currentY - Math.sin(angle) * trailLength * t;
            const segRadius = shellRadius * (1 - t * 0.6);
            const segAlpha = (1 - t) * 0.85;
            let color;
            if (isAimedShot) {
                const cr = Math.floor(50 + (1 - t) * 80);
                const cg = Math.floor(120 + (1 - t) * 135);
                color = (cr << 16) | (cg << 8) | 255;
            } else {
                const cg = Math.floor(60 + (1 - t) * 195);
                const cb = Math.floor((1 - t) * 50);
                color = (255 << 16) | (cg << 8) | cb;
            }
            effectsGfx.beginFill(color, segAlpha);
            effectsGfx.drawCircle(trailX, trailY, segRadius);
            effectsGfx.endFill();
        }

        effectsGfx.beginFill(0x111111);
        effectsGfx.drawCircle(currentX, currentY, shellRadius);
        effectsGfx.endFill();
    });

    // --- SLBM missiles ---
    slbmMissiles.forEach(missile => {
        if (!missile.impacted) {
            const progress = Math.max(0, Math.min(1, (now - missile.startTime) / missile.flightTime));
            if (progress >= 1) { missile.impacted = true; missile.impactTime = now; return; }

            const dx = missile.targetX - missile.fromX;
            const dy = missile.targetY - missile.fromY;
            const angle = Math.atan2(dy, dx);
            const currentX = missile.fromX + dx * progress;
            const currentY = missile.fromY + dy * progress;
            if (!isSlbmVisibleToPlayer(missile, now)) return;
            if (currentX < viewport.left - 200 || currentX > viewport.right + 200 || currentY < viewport.top - 200 || currentY > viewport.bottom + 200) return;

            const missileWidth = 24;
            const missileFullLen = 150;

            // Contrail
            if (!missile.contrailId) {
                missile.contrailId = `contrail-${missile.id}`;
                slbmContrails.push({ id: missile.contrailId, segments: [{ x: currentX, y: currentY, time: now }] });
            }
            const contrail = slbmContrails.find(c => c.id === missile.contrailId);
            const contrailSampleMs = loadSettings.contrailStride > 1 ? 90 : 50;
            if (contrail && (contrail.segments.length === 0 || now - contrail.segments[contrail.segments.length - 1].time > contrailSampleMs)) {
                contrail.segments.push({ x: currentX, y: currentY, time: now });
            }

            if (!loadSettings.detailedProjectiles) {
                const halfLength = missileFullLen / 2;
                drawRotatedRect(effectsGfx, currentX, currentY, missileWidth, missileFullLen * 0.72, angle, 0x111111);
                const rearX = currentX - Math.cos(angle) * halfLength * 0.72;
                const rearY = currentY - Math.sin(angle) * halfLength * 0.72;
                drawSlbmFlameGfx(effectsGfx, rearX, rearY, angle, missileWidth * 0.8, 26);
            } else if (progress < 0.333) {
                const hl = missileFullLen / 2;
                drawRotatedRect(effectsGfx, currentX, currentY, missileWidth, missileFullLen, angle, 0x111111);
                const rearX = currentX - Math.cos(angle) * hl;
                const rearY = currentY - Math.sin(angle) * hl;
                drawSlbmFlameGfx(effectsGfx, rearX, rearY, angle, missileWidth, 50);
            } else if (progress < 0.666) {
                const sp = (progress - 0.333) / 0.333;
                const pieceLen = missileFullLen / 3;
                drawRotatedRect(effectsGfx, currentX, currentY, missileWidth, pieceLen * 2, angle, 0x111111);
                const rearX = currentX - Math.cos(angle) * pieceLen;
                const rearY = currentY - Math.sin(angle) * pieceLen;
                drawSlbmFlameGfx(effectsGfx, rearX, rearY, angle, missileWidth, 40);
                const sep1X = currentX - Math.cos(angle) * pieceLen * 1.5 + Math.sin(angle) * 20 * sp;
                const sep1Y = currentY - Math.sin(angle) * pieceLen * 1.5 - Math.cos(angle) * 20 * sp;
                drawRotatedRect(effectsGfx, sep1X, sep1Y, missileWidth, pieceLen, angle, 0x333333);
            } else {
                const sp = (progress - 0.666) / 0.334;
                const pieceLen = missileFullLen / 3;
                drawRotatedRect(effectsGfx, currentX, currentY, missileWidth, pieceLen, angle, 0x111111);
                const rearX = currentX - Math.cos(angle) * (pieceLen / 2);
                const rearY = currentY - Math.sin(angle) * (pieceLen / 2);
                drawSlbmFlameGfx(effectsGfx, rearX, rearY, angle, missileWidth, 35);
                const sep1X = currentX - Math.cos(angle) * pieceLen * 2.5 + Math.sin(angle) * 35 * Math.min(sp + 0.5, 1);
                const sep1Y = currentY - Math.sin(angle) * pieceLen * 2.5 - Math.cos(angle) * 35 * Math.min(sp + 0.5, 1);
                const alpha1 = Math.max(0, 1 - sp * 0.7);
                drawRotatedRect(effectsGfx, sep1X, sep1Y, missileWidth, pieceLen, angle, 0x444444, alpha1);
                const sep2X = currentX - Math.cos(angle) * pieceLen * 1.5 - Math.sin(angle) * 30 * sp;
                const sep2Y = currentY - Math.sin(angle) * pieceLen * 1.5 + Math.cos(angle) * 30 * sp;
                const alpha2 = Math.max(0, 1 - sp * 0.5);
                drawRotatedRect(effectsGfx, sep2X, sep2Y, missileWidth, pieceLen, angle, 0x444444, alpha2);
            }

            // SLBM HP bar
            if (missile.hp !== undefined && missile.maxHp && missile.hp < missile.maxHp) {
                const barWidth = 40, barHeight = 4;
                const barX = currentX - barWidth / 2, barY = currentY - 50;
                const hpRatio = Math.max(0, missile.hp / missile.maxHp);
                effectsGfx.beginFill(0x000000, 0.6);
                effectsGfx.drawRect(barX, barY, barWidth, barHeight);
                effectsGfx.endFill();
                const hpColor = hpRatio > 0.5 ? 0x4caf50 : (hpRatio > 0.25 ? 0xff9800 : 0xf44336);
                effectsGfx.beginFill(hpColor);
                effectsGfx.drawRect(barX, barY, barWidth * hpRatio, barHeight);
                effectsGfx.endFill();
            }
            return;
        }

        // Impact effect
        const impactElapsed = now - (missile.impactTime || 0);
        if (impactElapsed > 2600) return;
        if (!isSlbmImpactVisibleToPlayer(missile)) return;
        if (missile.targetX < viewport.left || missile.targetX > viewport.right ||
            missile.targetY < viewport.top || missile.targetY > viewport.bottom) return;

        const pulseRadius = 120 + (impactElapsed * 0.42);
        const pulseAlpha = Math.max(0, 0.52 - (impactElapsed / 2600));
        effectsGfx.beginFill(0xff5f14, pulseAlpha);
        effectsGfx.drawCircle(missile.targetX, missile.targetY, pulseRadius);
        effectsGfx.endFill();
    });

    // --- Explosion effects ---
    explosionEffects = explosionEffects.filter(exp => now - exp.startTime < exp.duration);
    explosionEffects.forEach(exp => {
        if (exp.style === 'red-zone') return;
        if (!isPositionVisible(exp.x, exp.y)) return;
        if (loadSettings.detailedExplosions) {
            drawExplosionEffect(effectsGfx, exp, now);
        } else {
            drawSimpleExplosionEffect(effectsGfx, exp, now);
        }
    });

    // --- Active airstrikes (flying airstrike.png sprites) ---
    // Managed via airstrikeLayer PIXI sprites, updated in syncAirstrikeSprites
    syncAirstrikeSprites(now, viewport);
}

function isNavalUnitTypeForEffects(unitType) {
    return unitType === 'destroyer'
        || unitType === 'cruiser'
        || unitType === 'battleship'
        || unitType === 'carrier'
        || unitType === 'assaultship'
        || unitType === 'submarine'
        || unitType === 'frigate';
}

function createGenericUnitDestroyedExplosionEffect(data, startTime) {
    const debrisCount = data.type === 'battleship' ? 20 : (data.type === 'carrier' ? 18 : 12);
    const explosion = {
        x: data.x,
        y: data.y,
        startTime,
        duration: 1500,
        debris: []
    };
    for (let i = 0; i < debrisCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * 120;
        explosion.debris.push({
            dx: Math.cos(angle) * speed,
            dy: Math.sin(angle) * speed,
            size: 2 + Math.random() * 5,
            color: Math.random() > 0.5 ? '#ff6600' : (Math.random() > 0.5 ? '#ffaa00' : '#ff3300'),
            rotation: Math.random() * Math.PI * 2
        });
    }
    return explosion;
}

function createNavalSinkExplosionEffect(data, startTime) {
    const isYamatoSink = data.type === 'battleship' && isYamatoBattleshipOwner(data.userId);
    const isBattleship = data.type === 'battleship';
    const isCarrier = data.type === 'carrier';
    const debrisCount = isYamatoSink ? 40 : (isBattleship ? 28 : (isCarrier ? 24 : 18));
    const splashCount = isYamatoSink ? 50 : (isBattleship ? 34 : (isCarrier ? 28 : 20));
    const foamCount = isYamatoSink ? 16 : (isBattleship ? 12 : 8);
    const explosion = {
        x: data.x,
        y: data.y,
        startTime,
        duration: isYamatoSink ? 2200 : (isBattleship ? 1850 : 1650),
        maxRadius: isYamatoSink ? 86 : (isBattleship ? 68 : 54),
        style: isYamatoSink ? 'yamato-sink' : 'naval-sink',
        debris: [],
        splash: [],
        foam: []
    };

    for (let i = 0; i < debrisCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 45 + Math.random() * (isYamatoSink ? 180 : 130);
        explosion.debris.push({
            dx: Math.cos(angle) * speed,
            dy: Math.sin(angle) * speed,
            size: 2.5 + Math.random() * (isYamatoSink ? 6.5 : 5),
            color: Math.random() > 0.62
                ? '#f6fbff'
                : (Math.random() > 0.45 ? '#c7d0d8' : (Math.random() > 0.5 ? '#ffb24a' : '#ff6a1a')),
            rotation: Math.random() * Math.PI * 2
        });
    }

    for (let i = 0; i < splashCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * (isYamatoSink ? 150 : 110);
        explosion.splash.push({
            dx: Math.cos(angle) * speed,
            dy: Math.sin(angle) * speed,
            radius: 2.5 + Math.random() * (isYamatoSink ? 5.5 : 4),
            alpha: 0.26 + Math.random() * (isYamatoSink ? 0.2 : 0.14),
            color: Math.random() > 0.35 ? 0xffffff : (Math.random() > 0.5 ? 0xdbe3ea : 0xc3ccd4),
            swell: 0.7 + Math.random() * 0.9
        });
    }

    for (let i = 0; i < foamCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const spread = explosion.maxRadius * (0.16 + Math.random() * 0.44);
        explosion.foam.push({
            dx: Math.cos(angle) * spread,
            dy: Math.sin(angle) * spread,
            radius: 6 + Math.random() * (isYamatoSink ? 12 : 8),
            alpha: 0.1 + Math.random() * (isYamatoSink ? 0.12 : 0.08),
            color: Math.random() > 0.45 ? 0xf8fbff : 0xd2dae1
        });
    }

    return explosion;
}

function createUnitDestroyedExplosionEffect(data, startTime = Date.now()) {
    if (isNavalUnitTypeForEffects(data.type)) {
        return createNavalSinkExplosionEffect(data, startTime);
    }
    return createGenericUnitDestroyedExplosionEffect(data, startTime);
}

function drawExplosionEffect(gfx, exp, now) {
    const elapsed = now - exp.startTime;
    if (elapsed < 0) return;
    const progress = elapsed / exp.duration;
    const isRedZoneExplosion = exp.style === 'red-zone';
    const isNavalSink = exp.style === 'naval-sink' || exp.style === 'yamato-sink';
    const isYamatoSink = exp.style === 'yamato-sink';

    // Search pulse: expanding cyan ring
    if (exp.isSearchPulse) {
        const ringRadius = exp.maxRadius * progress;
        const alpha = Math.max(0, 0.6 - progress * 0.6);
        gfx.lineStyle(4, exp.color || 0x00bcd4, alpha);
        gfx.drawCircle(exp.x, exp.y, ringRadius);
        gfx.lineStyle(0);
        return;
    }

    if (isNavalSink) {
        if (progress < 0.36) {
            const splashAlpha = (1 - progress / 0.36) * (isYamatoSink ? 0.9 : 0.72);
            const splashRadius = (exp.maxRadius || 30) * (0.6 + progress * (isYamatoSink ? 1.4 : 1.15));
            gfx.beginFill(0xf8fbff, splashAlpha);
            gfx.drawCircle(exp.x, exp.y, splashRadius);
            gfx.endFill();
            gfx.beginFill(0xd8e0e8, splashAlpha * 0.52);
            gfx.drawCircle(exp.x, exp.y, splashRadius * 0.52);
            gfx.endFill();
        }
        if (progress > 0.03) {
            const ringAlpha = Math.max(0, (isYamatoSink ? 0.62 : 0.46) - progress * (isYamatoSink ? 0.48 : 0.34));
            const ringRadius = (exp.maxRadius || 30) * (0.58 + progress * (isYamatoSink ? 1.6 : 1.25));
            gfx.lineStyle(isYamatoSink ? 10 : 7, 0xffffff, ringAlpha);
            gfx.drawCircle(exp.x, exp.y, ringRadius);
            gfx.lineStyle(isYamatoSink ? 6 : 4, 0xc6cfd8, ringAlpha * 0.8);
            gfx.drawCircle(exp.x, exp.y, ringRadius * 0.74);
            gfx.lineStyle(0);
        }
        if (exp.foam) {
            exp.foam.forEach(foam => {
                const foamProgress = Math.min(1, progress * 1.12);
                const alpha = foam.alpha * Math.max(0, 1 - progress * 0.96);
                const px = exp.x + foam.dx * foamProgress;
                const py = exp.y + foam.dy * foamProgress;
                gfx.beginFill(foam.color, alpha);
                gfx.drawCircle(px, py, foam.radius * (0.7 + foamProgress * 1.2));
                gfx.endFill();
            });
        }
        if (exp.splash) {
            exp.splash.forEach(splash => {
                const sprayProgress = Math.min(1, progress * 1.06);
                const alpha = splash.alpha * Math.max(0, 1 - progress * 0.9);
                const px = exp.x + splash.dx * sprayProgress;
                const py = exp.y + splash.dy * sprayProgress;
                gfx.beginFill(splash.color, alpha);
                gfx.drawCircle(px, py, splash.radius * (0.8 + sprayProgress * splash.swell));
                gfx.endFill();
            });
        }
    } else if (progress < 0.3) {
        const flashAlpha = 1 - (progress / 0.3);
        const flashRadius = (exp.maxRadius || 30) + progress * (isRedZoneExplosion ? 85 : 60);
        gfx.beginFill(isRedZoneExplosion ? 0xbfc3c7 : 0xffc832, flashAlpha * (isRedZoneExplosion ? 0.62 : 0.8));
        gfx.drawCircle(exp.x, exp.y, flashRadius);
        gfx.endFill();
        gfx.beginFill(isRedZoneExplosion ? 0xf2f4f5 : 0xffffff, flashAlpha * (isRedZoneExplosion ? 0.42 : 0.6));
        gfx.drawCircle(exp.x, exp.y, flashRadius * 0.4);
        gfx.endFill();
    }
    if (!isNavalSink && progress > 0.1) {
        const ringAlpha = Math.max(0, 0.4 - progress * 0.4);
        const ringRadius = (isRedZoneExplosion ? 36 : 20) + progress * (isRedZoneExplosion ? 120 : 80);
        gfx.lineStyle(isRedZoneExplosion ? 8 : 6, isRedZoneExplosion ? 0x7b7f84 : 0x646464, ringAlpha);
        gfx.drawCircle(exp.x, exp.y, ringRadius);
        gfx.lineStyle(0);
    }
    if (exp.debris) {
        exp.debris.forEach(d => {
            const alpha = Math.max(0, 1 - progress);
            const px = exp.x + d.dx * progress;
            const py = exp.y + d.dy * progress + (progress * progress * 40);
            let debrisColor;
            if (d.color.startsWith('#')) {
                debrisColor = parseInt(d.color.slice(1), 16);
            } else {
                debrisColor = 0xff6600;
            }
            gfx.beginFill(debrisColor, alpha);
            gfx.drawRect(px - d.size / 2, py - d.size / 2, d.size, d.size * 0.6);
            gfx.endFill();
        });
    }
}

function drawSimpleExplosionEffect(gfx, exp, now) {
    const elapsed = now - exp.startTime;
    if (elapsed < 0) return;
    const progress = elapsed / exp.duration;
    const isRedZoneExplosion = exp.style === 'red-zone';
    const isNavalSink = exp.style === 'naval-sink' || exp.style === 'yamato-sink';
    const isYamatoSink = exp.style === 'yamato-sink';
    const baseRadius = exp.maxRadius || 30;
    const radius = baseRadius * (isNavalSink ? (0.78 + progress * 1.28) : (0.7 + progress * 1.1));
    const alpha = Math.max(
        0,
        (isNavalSink ? (isYamatoSink ? 0.62 : 0.48) : (isRedZoneExplosion ? 0.42 : 0.55))
        - progress * (isNavalSink ? (isYamatoSink ? 0.58 : 0.44) : (isRedZoneExplosion ? 0.42 : 0.55))
    );

    gfx.beginFill(isNavalSink ? 0xf3f8fc : (isRedZoneExplosion ? 0xbfc3c7 : 0xff8c28), alpha);
    gfx.drawCircle(exp.x, exp.y, radius);
    gfx.endFill();

    if (progress > 0.12) {
        gfx.lineStyle(
            isNavalSink ? (isYamatoSink ? 7 : 5) : (isRedZoneExplosion ? 6 : 4),
            isNavalSink ? 0xffffff : (isRedZoneExplosion ? 0x7b7f84 : 0x666666),
            Math.max(0, isNavalSink ? 0.28 - progress * 0.24 : 0.22 - progress * 0.22)
        );
        gfx.drawCircle(exp.x, exp.y, radius * (isNavalSink ? 1.34 : 1.2));
        gfx.lineStyle(0);
    }
}

function drawGlobalRedZoneExplosions() {
    const now = Date.now();
    const viewport = getViewportBounds(500);
    explosionEffects.forEach(exp => {
        if (exp.style !== 'red-zone') return;
        const radius = (exp.maxRadius || 30) + 220;
        if (exp.x < viewport.left - radius || exp.x > viewport.right + radius ||
            exp.y < viewport.top - radius || exp.y > viewport.bottom + radius) {
            return;
        }
        drawExplosionEffect(overlayGfx, exp, now);
    });
}

function renderMinimap() {
    const map = gameState.map;
    if (!map) return;
    ensureMapImageLoaded();
    ensureLandMaskLoaded();
    
    minimapCtx.clearRect(0, 0, minimap.width, minimap.height);
    const now = Date.now();
    const revealAll = hasTemporaryFullMapReveal();
    
    const scaleX = minimap.width / map.width;
    const scaleY = minimap.height / map.height;
    const loadSettings = getClientLoadSettings();

    if (mapImageLoaded && mapImage && !mapImageLoadFailed) {
        minimapCtx.drawImage(mapImage, 0, 0, minimap.width, minimap.height);
        if (landMaskCanvas) {
            minimapCtx.save();
            minimapCtx.globalAlpha = IMAGE_LAND_MASK_ALPHA;
            minimapCtx.drawImage(landMaskCanvas, 0, 0, minimap.width, minimap.height);
            minimapCtx.restore();
        }
    } else {
        minimapCtx.fillStyle = '#1a3a5c';
        minimapCtx.fillRect(0, 0, minimap.width, minimap.height);
        if (landMaskCanvas) {
            minimapCtx.drawImage(landMaskCanvas, 0, 0, minimap.width, minimap.height);
        }
    }

    const gridSize = getMapGridSize(map);
    const fogCellSize = getMapCellSize(map);
    if (gridSize > 0 && fogCellSize > 0 && !revealAll) {
        const minimapVisionRanges = {
            worker: 1000,
            destroyer: 1000,
            cruiser: 1200,
            battleship: 3200,
            carrier: 2000,
            assaultship: 1400,
            submarine: 800,
            frigate: 900,
            aircraft: 1000,
            recon_aircraft: RECON_AIRCRAFT_VISION_RADIUS
        };
        const visibleCircles = [];
        const maxVisionCircles = loadSettings.maxVisionCircles;
        const unitVisionStride = getSampleStride(gameState.units.size, Math.max(1, Math.floor(maxVisionCircles * 0.72)));
        const buildingVisionStride = getSampleStride(gameState.buildings.size, Math.max(1, Math.floor(maxVisionCircles * 0.28)));
        let ownUnitIndex = 0;
        let ownBuildingIndex = 0;

        gameState.units.forEach(unit => {
            if (unit.userId != gameState.userId) return;
            if (visibleCircles.length >= maxVisionCircles) return;
            if (unitVisionStride > 1 && (ownUnitIndex++ % unitVisionStride) !== 0) return;
            if (unitVisionStride === 1) ownUnitIndex++;
            const displayX = unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x;
            const displayY = unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y;
            let worldRadius = minimapVisionRanges[unit.type] || 1000;
            if (unit.type === 'destroyer' && unit.searchActiveUntil && now < unit.searchActiveUntil) {
                worldRadius = DESTROYER_SEARCH_VISION_RADIUS;
            }
            visibleCircles.push({
                x: displayX * scaleX,
                y: displayY * scaleY,
                r: worldRadius * ((scaleX + scaleY) * 0.5)
            });
        });

        gameState.buildings.forEach(building => {
            if (building.userId != gameState.userId) return;
            if (visibleCircles.length >= maxVisionCircles) return;
            if (buildingVisionStride > 1 && (ownBuildingIndex++ % buildingVisionStride) !== 0) return;
            if (buildingVisionStride === 1) ownBuildingIndex++;
            const worldRadius = 2000;
            visibleCircles.push({
                x: building.x * scaleX,
                y: building.y * scaleY,
                r: worldRadius * ((scaleX + scaleY) * 0.5)
            });
        });

        // Fast minimap fog: darken all, then carve out only current-vision circles.
        minimapCtx.fillStyle = 'rgba(0, 0, 0, 0.86)';
        minimapCtx.fillRect(0, 0, minimap.width, minimap.height);
        if (visibleCircles.length > 0) {
            minimapCtx.save();
            minimapCtx.globalCompositeOperation = 'destination-out';
            minimapCtx.fillStyle = 'rgba(0, 0, 0, 1)';
            for (let i = 0; i < visibleCircles.length; i++) {
                const circle = visibleCircles[i];
                minimapCtx.beginPath();
                minimapCtx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
                minimapCtx.fill();
            }
            minimapCtx.restore();

            // Paint visible land in strong green only inside current vision.
            if (landMaskCanvas && loadSettings.drawVisibleLandMask) {
                minimapCtx.save();
                minimapCtx.beginPath();
                for (let i = 0; i < visibleCircles.length; i++) {
                    const circle = visibleCircles[i];
                    minimapCtx.moveTo(circle.x + circle.r, circle.y);
                    minimapCtx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
                }
                minimapCtx.clip();
                minimapCtx.drawImage(landMaskCanvas, 0, 0, minimap.width, minimap.height);
                minimapCtx.globalCompositeOperation = 'source-atop';
                minimapCtx.fillStyle = MINIMAP_VISIBLE_LAND_COLOR;
                minimapCtx.fillRect(0, 0, minimap.width, minimap.height);
                minimapCtx.restore();
            }
        }
    }

    if (Array.isArray(gameState.redZones) && gameState.redZones.length > 0) {
        const minimapCellWidth = map.cellSize * scaleX;
        const minimapCellHeight = map.cellSize * scaleY;
        gameState.redZones.forEach(zone => {
            const zoneColor = zone.detonatedAt
                ? RED_ZONE_MINIMAP_AFTERSHOCK_COLOR
                : RED_ZONE_MINIMAP_PENDING_COLOR;
            minimapCtx.fillStyle = zoneColor;
            const landCells = Array.isArray(zone.landCells) ? zone.landCells : [];
            for (let i = 0; i < landCells.length; i++) {
                const cell = landCells[i];
                if (!Array.isArray(cell) || cell.length < 2) continue;
                minimapCtx.fillRect(
                    cell[0] * map.cellSize * scaleX,
                    cell[1] * map.cellSize * scaleY,
                    minimapCellWidth,
                    minimapCellHeight
                );
            }
        });
    }
    
    // Draw SLBM impact zones (darkened areas)
    slbmMissiles.forEach(missile => {
        if (missile.impacted && isSlbmImpactVisibleToPlayer(missile)) {
            const impactX = missile.targetX * scaleX;
            const impactY = missile.targetY * scaleY;
            minimapCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            minimapCtx.beginPath();
            minimapCtx.arc(impactX, impactY, loadSettings.detailedMinimapMissiles ? 15 : 10, 0, Math.PI * 2);
            minimapCtx.fill();
        }
    });
    
    // Draw units - always show own units, others only in explored area
    gameState.units.forEach(unit => {
        const displayX = unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x;
        const displayY = unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y;
        
        // Hide stealthed enemy units (subs, mines) on minimap
        if (!revealAll && unit.userId !== gameState.userId && (unit.type === 'submarine' || unit.type === 'mine') && !unit.isDetected) return;
        
        if (unit.userId == gameState.userId) {
            minimapCtx.fillStyle = '#00ff00';
            minimapCtx.fillRect(displayX * scaleX - 2, displayY * scaleY - 2, 5, 5);
        } else if (revealAll) {
            minimapCtx.fillStyle = '#ff0000';
            minimapCtx.fillRect(displayX * scaleX - 1, displayY * scaleY - 1, 4, 4);
        } else if (gridSize > 0 && fogCellSize > 0 && isPositionVisible(unit.x, unit.y)) {
            minimapCtx.fillStyle = '#ff0000';
            minimapCtx.fillRect(displayX * scaleX - 1, displayY * scaleY - 1, 4, 4);
        }
    });
    
    // Draw buildings
    const isRedZoneBuildingBlinkOn = Math.floor(now / RED_ZONE_MINIMAP_BUILDING_BLINK_MS) % 2 === 0;
    gameState.buildings.forEach(building => {
        if (building.userId == gameState.userId) {
            minimapCtx.fillStyle = isOwnBuildingInPendingRedZone(building) && !isRedZoneBuildingBlinkOn
                ? RED_ZONE_MINIMAP_BUILDING_WARNING_COLOR
                : '#ffff00';
            minimapCtx.fillRect(building.x * scaleX - 3, building.y * scaleY - 3, 7, 7);
        } else if (revealAll) {
            minimapCtx.fillStyle = '#ff0000';
            minimapCtx.fillRect(building.x * scaleX - 2, building.y * scaleY - 2, 5, 5);
        } else if (gridSize > 0 && fogCellSize > 0 && isPositionVisible(building.x, building.y)) {
            minimapCtx.fillStyle = '#ff0000';
            minimapCtx.fillRect(building.x * scaleX - 2, building.y * scaleY - 2, 5, 5);
        }
    });
    
    // Draw active SLBM missiles (black bar with separation stages, scaled for minimap)
    slbmMissiles.forEach(missile => {
        if (!missile.impacted) {
            if (!isSlbmVisibleToPlayer(missile, now)) return;
            const progress = Math.min(1, (now - missile.startTime) / missile.flightTime);
            if (progress >= 1) return;
            const dx = missile.targetX - missile.fromX;
            const dy = missile.targetY - missile.fromY;
            const angle = Math.atan2(dy, dx);
            const currentX = (missile.fromX + dx * progress) * scaleX;
            const currentY = (missile.fromY + dy * progress) * scaleY;
            if (!loadSettings.detailedMinimapMissiles) {
                minimapCtx.fillStyle = '#111';
                minimapCtx.beginPath();
                minimapCtx.arc(currentX, currentY, 2.5, 0, Math.PI * 2);
                minimapCtx.fill();
                minimapCtx.fillStyle = 'rgba(255, 120, 30, 0.7)';
                minimapCtx.beginPath();
                minimapCtx.arc(
                    currentX - Math.cos(angle) * 4,
                    currentY - Math.sin(angle) * 4,
                    1.2, 0, Math.PI * 2
                );
                minimapCtx.fill();
                return;
            }
            
            // Minimap-scaled missile dimensions
            const mw = 2; // missile width on minimap
            const mLen = 8; // missile full length on minimap
            
            if (progress < 0.333) {
                // Phase 1: Single body
                minimapCtx.save();
                minimapCtx.translate(currentX, currentY);
                minimapCtx.rotate(angle + Math.PI / 2);
                minimapCtx.fillStyle = '#111';
                minimapCtx.fillRect(-mw / 2, -mLen / 2, mw, mLen);
                minimapCtx.restore();
            } else if (progress < 0.666) {
                // Phase 2: Main body + 1 separated piece
                const sp = (progress - 0.333) / 0.333;
                const pieceLen = mLen / 3;
                
                // Main body
                minimapCtx.save();
                minimapCtx.translate(currentX, currentY);
                minimapCtx.rotate(angle + Math.PI / 2);
                minimapCtx.fillStyle = '#111';
                minimapCtx.fillRect(-mw / 2, -pieceLen, mw, pieceLen * 2);
                minimapCtx.restore();
                
                // Separated piece
                const s1x = currentX - Math.cos(angle) * pieceLen * 1.5 * scaleX + Math.sin(angle) * 3 * sp;
                const s1y = currentY - Math.sin(angle) * pieceLen * 1.5 * scaleY - Math.cos(angle) * 3 * sp;
                minimapCtx.save();
                minimapCtx.translate(s1x, s1y);
                minimapCtx.rotate(angle + Math.PI / 2 + sp * 0.3);
                minimapCtx.fillStyle = '#555';
                minimapCtx.fillRect(-mw / 2, -pieceLen / 2, mw, pieceLen);
                minimapCtx.restore();
            } else {
                // Phase 3: Warhead + 2 separated pieces
                const sp = (progress - 0.666) / 0.334;
                const pieceLen = mLen / 3;
                
                // Main warhead
                minimapCtx.save();
                minimapCtx.translate(currentX, currentY);
                minimapCtx.rotate(angle + Math.PI / 2);
                minimapCtx.fillStyle = '#111';
                minimapCtx.fillRect(-mw / 2, -pieceLen / 2, mw, pieceLen);
                minimapCtx.restore();
                
                // 1st separated piece
                const s1x = currentX - Math.cos(angle) * pieceLen * 2.5 + Math.sin(angle) * 5 * Math.min(sp + 0.5, 1);
                const s1y = currentY - Math.sin(angle) * pieceLen * 2.5 - Math.cos(angle) * 5 * Math.min(sp + 0.5, 1);
                minimapCtx.save();
                minimapCtx.translate(s1x, s1y);
                minimapCtx.rotate(angle + Math.PI / 2 + 0.5);
                minimapCtx.globalAlpha = Math.max(0, 1 - sp * 0.7);
                minimapCtx.fillStyle = '#666';
                minimapCtx.fillRect(-mw / 2, -pieceLen / 2, mw, pieceLen);
                minimapCtx.globalAlpha = 1;
                minimapCtx.restore();
                
                // 2nd separated piece
                const s2x = currentX - Math.cos(angle) * pieceLen * 1.5 - Math.sin(angle) * 4 * sp;
                const s2y = currentY - Math.sin(angle) * pieceLen * 1.5 + Math.cos(angle) * 4 * sp;
                minimapCtx.save();
                minimapCtx.translate(s2x, s2y);
                minimapCtx.rotate(angle + Math.PI / 2 - sp * 0.4);
                minimapCtx.globalAlpha = Math.max(0, 1 - sp * 0.5);
                minimapCtx.fillStyle = '#666';
                minimapCtx.fillRect(-mw / 2, -pieceLen / 2, mw, pieceLen);
                minimapCtx.globalAlpha = 1;
                minimapCtx.restore();
            }
            
            // Small flame dot at tail
            minimapCtx.fillStyle = 'rgba(255, 120, 30, 0.8)';
            minimapCtx.beginPath();
            minimapCtx.arc(
                currentX - Math.cos(angle) * (mLen / 2),
                currentY - Math.sin(angle) * (mLen / 2),
                1.5, 0, Math.PI * 2
            );
            minimapCtx.fill();
        }
    });
    
    // Draw camera viewport
    const viewWidth = (canvas.width / gameState.camera.zoom) * scaleX;
    const viewHeight = (canvas.height / gameState.camera.zoom) * scaleY;
    const viewX = gameState.camera.x * scaleX - viewWidth / 2;
    const viewY = gameState.camera.y * scaleY - viewHeight / 2;
    
    minimapCtx.strokeStyle = '#fff';
    minimapCtx.lineWidth = 2;
    minimapCtx.strokeRect(viewX, viewY, viewWidth, viewHeight);
    
    // Draw SLBM targeting indicator
    if (slbmTargetingMode) {
        minimapCtx.strokeStyle = '#ff0000';
        minimapCtx.lineWidth = 2;
        minimapCtx.setLineDash([5, 5]);
        minimapCtx.strokeRect(0, 0, minimap.width, minimap.height);
        minimapCtx.setLineDash([]);
    }
    // Draw airstrike targeting indicator
    if (airstrikeTargetingMode) {
        minimapCtx.strokeStyle = '#ff7800';
        minimapCtx.lineWidth = 2;
        minimapCtx.setLineDash([5, 5]);
        minimapCtx.strokeRect(0, 0, minimap.width, minimap.height);
        minimapCtx.setLineDash([]);
    }
    // Draw recon targeting indicator
    if (reconTargetingMode) {
        minimapCtx.strokeStyle = '#9ba7b3';
        minimapCtx.lineWidth = 2;
        minimapCtx.setLineDash([5, 5]);
        minimapCtx.strokeRect(0, 0, minimap.width, minimap.height);
        minimapCtx.setLineDash([]);
    }
    // Draw mine targeting indicator
    if (mineTargetingMode) {
        minimapCtx.strokeStyle = '#555555';
        minimapCtx.lineWidth = 2;
        minimapCtx.setLineDash([5, 5]);
        minimapCtx.strokeRect(0, 0, minimap.width, minimap.height);
        minimapCtx.setLineDash([]);
    }

    lastMinimapRenderAt = Date.now();
}

// Helper: convert minimap click to world coordinates
function minimapClickToWorld(e) {
    const rect = minimap.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const cssScaleX = minimap.width / rect.width;
    const cssScaleY = minimap.height / rect.height;
    const canvasX = clickX * cssScaleX;
    const canvasY = clickY * cssScaleY;
    const worldScaleX = gameState.map.width / minimap.width;
    const worldScaleY = gameState.map.height / minimap.height;
    return clampWorldPointToMap(canvasX * worldScaleX, canvasY * worldScaleY);
}

// Minimap LEFT-click: always move camera (also handle SLBM targeting)
minimap.addEventListener('click', (e) => {
    if (!gameState.map) return;
    if (registerSecretRapidClick(minimapSecretClicks, SECRET_MINIMAP_CLICK_TARGET)) {
        activateTemporaryFullMapReveal();
    }
    const target = minimapClickToWorld(e);
    
    // Handle SLBM targeting mode
    if (slbmTargetingMode) {
        const selectedSubs = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'submarine');
        
        for (const sub of selectedSubs) {
            if (gameState.missiles > 0) {
                socket.emit('submarineSLBM', {
                    submarineId: sub.id,
                    targetX: target.x,
                    targetY: target.y
                });
            } else break;
        }
        
        slbmTargetingMode = false;
        canvas.style.cursor = 'crosshair';
        document.getElementById('slbmInstructions').style.display = 'none';
        return;
    }
    
    // Handle airstrike targeting mode
    if (airstrikeTargetingMode) {
        const selectedCarriers = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'carrier' && (u.airstrikeReady || gameState.username === 'JsonParc'));
        if (selectedCarriers.length > 0 && socket) {
            socket.emit('launchAirstrike', {
                unitId: selectedCarriers[0].id,
                targetX: target.x,
                targetY: target.y
            });
        }
        airstrikeTargetingMode = false;
        canvas.style.cursor = 'crosshair';
        document.getElementById('airstrikeInstructions').style.display = 'none';
        return;
    }

    // Handle recon targeting mode
    if (reconTargetingMode) {
        launchSelectedReconAircraft(target);
        reconTargetingMode = false;
        canvas.style.cursor = 'crosshair';
        const reconInstructions = document.getElementById('reconInstructions');
        if (reconInstructions) reconInstructions.style.display = 'none';
        return;
    }
    
    // Handle mine targeting mode
    if (mineTargetingMode) {
        const selectedDestroyers = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'destroyer');
        if (selectedDestroyers.length > 0 && socket && canLayMineAtTarget(selectedDestroyers[0], target.x, target.y)) {
            socket.emit('layMine', {
                unitId: selectedDestroyers[0].id,
                targetX: target.x,
                targetY: target.y
            });
        }
        mineTargetingMode = false;
        canvas.style.cursor = 'crosshair';
        document.getElementById('mineInstructions').style.display = 'none';
        return;
    }
    
    // Move camera
    gameState.camera.x = target.x;
    gameState.camera.y = target.y;
    clampCameraToMapBounds();
    minimapDirty = true;
    emitViewportUpdate(true);
});

// Minimap RIGHT-click: move selected units (if any), else move camera
minimap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!gameState.map) return;
    const target = minimapClickToWorld(e);
    
    const selectedUnits = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(canReceiveManualOrders);
    
    if (selectedUnits.length > 0) {
        const unitIds = selectedUnits.map(u => u.id);
        unitIds.forEach(id => commandGroup.add(id));
        socket.emit('moveUnits', {
            unitIds: unitIds,
            targetX: target.x,
            targetY: target.y
        });
        // Store command facing angle (minimap command)
        selectedUnits.forEach(u => { u.commandAngle = Math.atan2(target.y - u.y, target.x - u.x); });
        return;
    }
    
    // No units selected - move camera
    gameState.camera.x = target.x;
    gameState.camera.y = target.y;
    clampCameraToMapBounds();
    minimapDirty = true;
    emitViewportUpdate(true);
});

// Update loop (60fps for smooth interpolation)
let isUpdateRunning = false;
let lastFrameTime = 0;
const FPS_LIMIT = 60;
const FRAME_INTERVAL = 1000 / FPS_LIMIT;

// Interpolate unit positions for smooth movement
function updateUnitInterpolation() {
    const now = Date.now();
    
    gameState.units.forEach(unit => {
        if (unit.interpTargetX !== undefined && unit.interpStartTime !== undefined) {
            const elapsed = now - unit.interpStartTime;
            const t = Math.min(elapsed / interpolationDurationMs, 1);

            // Skip calculation if already at destination
            if (t >= 1 && unit.interpDone) {
                return;
            }

            // Linear interpolation reduces stop-and-go artifacts between server ticks.
            unit.interpDisplayX = unit.interpPrevX + (unit.interpTargetX - unit.interpPrevX) * t;
            unit.interpDisplayY = unit.interpPrevY + (unit.interpTargetY - unit.interpPrevY) * t;

            if (t >= 1) {
                unit.interpDone = true;
            }

            // --- Facing angle ---
            const moveDx = unit.interpTargetX - unit.interpPrevX;
            const moveDy = unit.interpTargetY - unit.interpPrevY;
            // Use squared distance to avoid sqrt
            const moveDistSq = moveDx * moveDx + moveDy * moveDy;
            if (moveDistSq > 0.25) {
                if (unit.squadId && unit.angle !== undefined && unit.angle !== null) {
                    unit.displayAngle = unit.angle;
                } else {
                    unit.displayAngle = Math.atan2(moveDy, moveDx);
                }
                unit.commandAngle = unit.displayAngle;
            } else {
                if (unit.squadId && unit.angle !== undefined && unit.angle !== null) {
                    unit.displayAngle = unit.angle;
                } else {
                    unit.displayAngle = unit.commandAngle !== undefined ? unit.commandAngle : 0;
                }
            }
        } else {
            unit.interpDisplayX = unit.x;
            unit.interpDisplayY = unit.y;
            unit.displayAngle = unit.commandAngle !== undefined ? unit.commandAngle : 0;
        }
    });
}

function update() {
    if (!isUpdateRunning) {
        return;
    }

    try {
        const now = performance.now();
        const elapsed = now - lastFrameTime;
        
        if (elapsed > FRAME_INTERVAL) {
            lastFrameTime = now - (elapsed % FRAME_INTERVAL);
            updateUnitInterpolation();
            updateCamera(elapsed);
            render();
        }
        
        animationFrameId = requestAnimationFrame(update);
    } catch (error) {
        console.error('Error in update loop:', error);
        stopUpdate();
    }
}

function startUpdate() {
    if (!isUpdateRunning) {
        isUpdateRunning = true;
        lastFrameTime = performance.now();
        animationFrameId = requestAnimationFrame(update);
    }
}

function stopUpdate() {
    isUpdateRunning = false;
    if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

// Kill Log - shows elimination messages
function showKillLog(attackerName, defeatedName) {
    const container = document.getElementById('killLogContainer');
    if (!container) return;
    
    const message = document.createElement('div');
    message.className = 'kill-log-message';
    message.innerHTML = `<span class="attacker">${attackerName}</span>이(가) <span class="defeated">${defeatedName}</span>을(를) 처치했습니다!`;
    
    container.appendChild(message);
    
    // Remove the message after animation completes (3 seconds)
    setTimeout(() => {
        if (message.parentNode) {
            message.parentNode.removeChild(message);
        }
    }, 3000);
}

function showKillLogMessage(messageText, variant = '') {
    const container = document.getElementById('killLogContainer');
    if (!container) return;

    const message = document.createElement('div');
    message.className = 'kill-log-message';
    if (variant) {
        message.classList.add(`kill-log-message--${variant}`);
    }
    message.textContent = messageText;

    container.appendChild(message);

    setTimeout(() => {
        if (message.parentNode) {
            message.parentNode.removeChild(message);
        }
    }, 3000);
}

function createRedZoneExplosionEffect(x, y, startTime) {
    const debris = [];
    const debrisCount = 12 + Math.floor(Math.random() * 7);
    for (let i = 0; i < debrisCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 35 + Math.random() * 120;
        debris.push({
            dx: Math.cos(angle) * speed,
            dy: Math.sin(angle) * speed,
            size: 4 + Math.random() * 7,
            color: Math.random() > 0.6 ? '#b5b5b5' : (Math.random() > 0.5 ? '#7a7a7a' : '#5c5c5c'),
            rotation: Math.random() * Math.PI * 2
        });
    }

    return {
        x,
        y,
        startTime,
        duration: 900,
        maxRadius: 58 + Math.random() * 34,
        style: 'red-zone',
        debris
    };
}

// UI Updates
function updateHUD() {
    const player = gameState.players.get(gameState.userId);
    if (!player) return;
    
    document.getElementById('resources').textContent = Math.floor(player.resources);
    document.getElementById('missileCount').textContent = gameState.missiles;
    document.getElementById('population').textContent = player.population;
    document.getElementById('maxPopulation').textContent = player.maxPopulation;
    document.getElementById('combatPower').textContent = player.combatPower;
    document.getElementById('score').textContent = Math.floor(player.score);
    
    // Update action buttons based on selection
    updateActionButtons();
}

function updateActionButtons() {
    // Skill button visibility is managed by updateSelectionInfo()
    // No standalone slbmFireBtn / produceMissileBtn elements exist.
}

// SLBM Fire button handler (skillBtn1 in bottom panel)
document.getElementById('skillBtn1').addEventListener('click', () => {
    const selectedSubs = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'submarine');
    
    if (selectedSubs.length > 0 && gameState.missiles > 0) {
        slbmTargetingMode = true;
        document.getElementById('slbmInstructions').style.display = 'block';
    }
});

// Missile production button handler (skillBtn2 in bottom panel)
document.getElementById('skillBtn2').addEventListener('click', () => {
    const highestPriorityType = getSelectedOwnedHighestPriorityUnitType();

    // Submarine: load SLBM
    if (highestPriorityType === 'submarine' && socket) {
        const selectedSubs = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'submarine');
        if (selectedSubs.length > 0) {
            socket.emit('loadSubmarineSlbm', { unitIds: selectedSubs.map(u => u.id) });
        }
        return;
    }

    if (highestPriorityType === 'battleship' && socket) {
        const selectedBattleships = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => (
                u
                && u.userId === gameState.userId
                && u.type === 'battleship'
                && (!u.battleshipAegisMode || u.battleshipModeComboUnlocked)
            ));
        if (selectedBattleships.length > 0) {
            socket.emit('toggleCombatStance', { unitIds: selectedBattleships.map(unit => unit.id) });
        }
        return;
    }

    const selectedBuildings = Array.from(gameState.selection)
        .map(id => gameState.buildings.get(id))
        .filter(b => b && b.userId === gameState.userId && b.type === 'missile_silo');
    
    if (selectedBuildings.length > 0 && socket) {
        socket.emit('produceMissile', { buildingId: selectedBuildings[0].id });
    }
});

// Carrier: produce aircraft (skillBtn3)
document.getElementById('skillBtn3').addEventListener('click', () => {
    // Submarine: toggle stealth
    const highestPriorityType = getSelectedOwnedHighestPriorityUnitType();
    if (highestPriorityType === 'submarine' && socket) {
        const selectedSubs = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'submarine');
        if (selectedSubs.length > 0) {
            socket.emit('toggleSubmarineStealth', { unitIds: selectedSubs.map(u => u.id) });
        }
        return;
    }

    if (hasOnlyOwnedMissileLaunchersSelected()) {
        const launchers = getDeployableMissileLaunchers();
        if (launchers.length > 0 && socket) {
            socket.emit('deployMissileLauncher', { unitIds: launchers.map(unit => unit.id) });
            return;
        }
        const deployedLaunchers = getUndeployableMissileLaunchers();
        if (deployedLaunchers.length > 0 && socket) {
            socket.emit('undeployMissileLauncher', { unitIds: deployedLaunchers.map(unit => unit.id) });
        }
        return;
    }

    if (hasOnlyOwnedAssaultShipsSelected()) {
        const readyShips = getUnloadReadyAssaultShips();
        if (readyShips.length > 0 && socket) {
            socket.emit('unloadAssaultShipVehicles', { unitIds: readyShips.map(unit => unit.id) });
        }
        return;
    }

    const selectedCarriers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'carrier');
    if (selectedCarriers.length > 0 && socket) {
        selectedCarriers.forEach(carrier => {
            socket.emit('produceAircraft', { unitId: carrier.id });
        });
    }
});

// Shared skill button 4: assault ship boarding / carrier airstrike
document.getElementById('skillBtn4').addEventListener('click', () => {
    if (hasOnlyOwnedAssaultShipsSelected()) {
        const readyShips = getSelectedOwnedAssaultShipsWithCapacity();
        if (readyShips.length > 0) {
            cancelActiveModes();
            setAssaultShipLoadMode('cargo-target');
        }
        return;
    }

    if (hasOnlyOwnedAssaultShipLoadableUnitsSelected()) {
        const loadableUnits = getSelectedOwnedAssaultShipLoadableUnits();
        if (loadableUnits.length > 0) {
            cancelActiveModes();
            setAssaultShipLoadMode('ship-target');
        }
        return;
    }

    const selectedCarriers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'carrier' && (u.airstrikeReady || gameState.username === 'JsonParc'));
    if (selectedCarriers.length > 0 && socket) {
        cancelActiveModes();
        airstrikeTargetingMode = true;
        document.getElementById('airstrikeInstructions').style.display = 'block';
    }
});

// Battleship: aimed shot (skillBtn5)
document.getElementById('skillBtn5').addEventListener('click', () => {
    const selectedBattleships = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'battleship' && !u.battleshipAegisMode);
    if (selectedBattleships.length > 0 && socket) {
        const unitIds = selectedBattleships.map(u => u.id);
        socket.emit('activateAimedShot', { unitIds });
    }
});

// Cruiser: aegis mode toggle (skillBtn6)
document.getElementById('skillBtn6').addEventListener('click', () => {
    const highestPriorityType = getSelectedOwnedHighestPriorityUnitType();
    if (highestPriorityType === 'battleship' && socket) {
        const selectedBattleships = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'battleship');
        if (selectedBattleships.length > 0) {
            socket.emit('toggleBattleshipAegisMode', { unitIds: selectedBattleships.map(unit => unit.id) });
        }
        return;
    }

    if (highestPriorityType === 'frigate' && socket) {
        const selectedFrigates = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'frigate');
        if (selectedFrigates.length > 0) {
            socket.emit('toggleFrigateEngineOverdrive', { unitIds: selectedFrigates.map(unit => unit.id) });
        }
        return;
    }

    const selectedCruisers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'cruiser');
    if (selectedCruisers.length > 0 && socket) {
        const unitIds = selectedCruisers.map(u => u.id);
        socket.emit('toggleAegisMode', { unitIds });
    }
});

// Destroyer: search skill (skillBtn7)
document.getElementById('skillBtn7').addEventListener('click', () => {
    if (hasOnlyOwnedCarriersSelected()) {
        const selectedCarriers = getSelectedOwnedCarriers();
        if (selectedCarriers.length > 0 && socket) {
            selectedCarriers.forEach(carrier => {
                socket.emit('produceReconAircraft', { unitId: carrier.id });
            });
        }
        return;
    }

    const selectedDestroyers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'destroyer');
    if (selectedDestroyers.length > 0 && socket) {
        const unitIds = selectedDestroyers.map(u => u.id);
        socket.emit('activateSearch', { unitIds });
    }
});

// Destroyer: mine laying (skillBtn8)
document.getElementById('skillBtn8').addEventListener('click', () => {
    if (hasOnlyOwnedCarriersSelected()) {
        if (getReadyReconCarriers().length > 0) {
            cancelActiveModes();
            reconTargetingMode = true;
            getReconInstructionsElement().style.display = 'block';
        }
        return;
    }

    const selectedDestroyers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'destroyer');
    if (selectedDestroyers.length > 0 && socket) {
        mineTargetingMode = true;
        document.getElementById('mineInstructions').style.display = 'block';
    }
});

const productionButtons = document.getElementById('productionButtons');
if (productionButtons) {
    productionButtons.addEventListener('pointerdown', (event) => {
        const btn = getClosestProductionButton(event.target);
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        suspendSelectionInfoRefresh(300);
        if (btn.classList.contains('disabled') || !socket) return;
        socket.emit('buildUnit', {
            buildingId: getProductionButtonBuildingId(btn),
            unitType: btn.getAttribute('data-type')
        });
    });

    productionButtons.addEventListener('click', (event) => {
        const btn = getClosestProductionButton(event.target);
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
    });
}

function updateRankings() {
    const roomId = gameState.selectedRoom || localStorage.getItem('selectedRoom') || 'server1';
    const query = new URLSearchParams({ roomId });
    if (gameState.userId != null) {
        query.set('userId', String(gameState.userId));
    }
    fetch(`/api/rankings?${query.toString()}`)
        .then(res => res.json())
        .then(rankings => {
            const list = document.getElementById('rankingsList');
            list.innerHTML = rankings.map((rank, index) => `
                <div class="ranking-item rank-${index + 1}">
                    <span class="rank-number">#${index + 1}</span>
                    <div class="username">${rank.username}${rank.isSelf ? ' (나)' : ''}</div>
                    <div class="stats">
                        점수: ${Math.floor(rank.score)} | 
                        자원: ${Math.floor(rank.resources)} | 
                        인구: ${rank.population} | 
                        전투력: ${rank.combat_power}
                    </div>
                </div>
            `).join('');
        })
        .catch(error => {
            console.error('Ranking update failed:', error);
        });
}

const rankingsPanel = document.getElementById('rankingsPanel');
if (rankingsPanel) {
    rankingsPanel.addEventListener('click', () => {
        if (!socket || !gameState.userId) return;
        if (registerSecretRapidClick(rankingPanelSecretClicks, SECRET_RANKING_CLICK_TARGET)) {
            socket.emit('resetAllAiFactions');
        }
    });
}

const portraitPlaceholder = document.getElementById('portraitPlaceholder');
if (portraitPlaceholder) {
    portraitPlaceholder.addEventListener('click', () => {
        if (!socket || !gameState.userId) return;

        // Battleship easter egg: 22 rapid clicks → unlock combo use for one battleship
        const bsUnit = getPortraitSecretBattleshipUnit();
        if (bsUnit) {
            resetSecretClickStreak(workerPortraitSecretClicks);
            if (registerSecretRapidClick(
                battleshipPortraitSecretClicks,
                SECRET_BATTLESHIP_PORTRAIT_CLICK_TARGET,
                Date.now(),
                SECRET_BATTLESHIP_PORTRAIT_CLICK_RESET_MS
            )) {
                socket.emit('unlockBattleshipModeCombo', { unitId: bsUnit.id });
            }
            return;
        }
        resetSecretClickStreak(battleshipPortraitSecretClicks);

        // Worker easter egg: 29 rapid clicks → trigger red zone
        const workerUnit = getPortraitSecretWorkerUnit();
        if (!workerUnit) {
            resetSecretClickStreak(workerPortraitSecretClicks);
            return;
        }
        if (registerSecretRapidClick(
            workerPortraitSecretClicks,
            SECRET_WORKER_PORTRAIT_CLICK_TARGET,
            Date.now(),
            SECRET_WORKER_PORTRAIT_CLICK_RESET_MS
        )) {
            socket.emit('triggerRedZoneNow');
        }
    });
}

const loginPanel = document.querySelector('#loginScreen .login-container');
if (loginPanel) {
    loginPanel.addEventListener('click', async () => {
        if (socket || !document.getElementById('loginScreen').classList.contains('active')) return;
        if (!registerSecretRapidClick(loginPanelSecretClicks, SECRET_LOGIN_PANEL_CLICK_TARGET)) {
            return;
        }

        const serverSelect = document.getElementById('serverSelect');
        const roomId = serverSelect ? serverSelect.value : 'server1';
        const authError = document.getElementById('authError');

        try {
            const res = await fetch('/api/annihilate-room', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ roomId })
            });
            const data = await res.json();

            if (!res.ok) {
                authError.textContent = data.error || '서버 정리 실패';
                return;
            }

            authError.textContent = `${data.roomLabel || roomId} 정리 완료`;
            fetchRoomInfo();
        } catch (error) {
            console.error('Room annihilation error:', error);
            authError.textContent = '서버 정리 실패';
        }
    });
}

// Build buttons (now rendered dynamically in skill panel for workers)

// Auth
// AI Difficulty description
const ENABLE_AI_TRAINING_UI = true;
const DEFAULT_AI_DIFFICULTY = 'normal';
const AI_DIFFICULTY_SELECTION_ENABLED = true;
const diffDescs = {
    easy: '약화된 규칙 기반 AI. 느린 판단, 적은 건물/유닛',
    normal: '규칙 기반 AI, 기본 난이도',
    hard: '강화학습으로 훈련된 AI. 전략적 판단 + 스킬 활용',
    expert: '최강 강화학습 AI. 자원 보너스 + 빠른 판단 + 완벽한 전략'
};
const diffField = document.getElementById('aiDifficultyField');
const diffSelect = document.getElementById('aiDifficultySelect');
const diffDesc = document.getElementById('difficultyDesc');
function getSelectedAIDifficulty() {
    if (!AI_DIFFICULTY_SELECTION_ENABLED) return DEFAULT_AI_DIFFICULTY;
    return (diffSelect && diffSelect.value) ? diffSelect.value : DEFAULT_AI_DIFFICULTY;
}
if (diffField && !AI_DIFFICULTY_SELECTION_ENABLED) {
    diffField.style.display = 'none';
}
if (diffSelect && diffDesc) {
    diffSelect.value = getSelectedAIDifficulty();
    diffDesc.textContent = diffDescs[getSelectedAIDifficulty()] || '';
    if (AI_DIFFICULTY_SELECTION_ENABLED) {
        diffSelect.addEventListener('change', () => {
            diffDesc.textContent = diffDescs[diffSelect.value] || '';
        });
    }
}

document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('resetBtn').addEventListener('click', resetGame);

// Hidden click zones: add/remove AI
(function() {
    let addClicks = 0, addTimer = null;
    let removeClicks = 0, removeTimer = null;
    const RESET_MS = 8000;

    const addZone = document.getElementById('aiAddZone');
    const removeZone = document.getElementById('aiRemoveZone');
    if (addZone) {
        addZone.addEventListener('click', () => {
            if (!socket) return;
            addClicks++;
            clearTimeout(addTimer);
            addTimer = setTimeout(() => { addClicks = 0; }, RESET_MS);
            if (addClicks >= 10) {
                addClicks = 0;
                clearTimeout(addTimer);
                socket.emit('addAI');
            }
        });
    }
    if (removeZone) {
        removeZone.addEventListener('click', () => {
            if (!socket) return;
            removeClicks++;
            clearTimeout(removeTimer);
            removeTimer = setTimeout(() => { removeClicks = 0; }, RESET_MS);
            if (removeClicks >= 7) {
                removeClicks = 0;
                clearTimeout(removeTimer);
                socket.emit('removeAI');
            }
        });
    }
})();

function addSystemLog(msg) {
    const logEl = document.getElementById('gameLog');
    if (logEl) {
        const row = document.createElement('div');
        row.textContent = '[시스템] ' + msg;
        row.style.color = '#ffcc00';
        logEl.appendChild(row);
        if (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
    }
}

// --- AI Training Panel ---
(function() {
    const panel = document.getElementById('trainingPanel');
    if (!ENABLE_AI_TRAINING_UI) {
        if (panel) panel.style.display = 'none';
        return;
    }
    const closeBtn = document.getElementById('trainingCloseBtn');
    const startBtn = document.getElementById('trainStartBtn');
    const stopBtn = document.getElementById('trainStopBtn');
    const episodeInput = document.getElementById('trainEpisodeInput');
    const continuousChk = document.getElementById('trainContinuous');
    const resetBtn = document.getElementById('trainResetBtn');
    const freezeBtn = document.getElementById('trainFreezeBtn');
    const logDiv = document.getElementById('trainingLog');
    let trainPollTimer = null;
    let selectedDifficulty = 'hard'; // Current tab

    if (closeBtn) closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });

    // Difficulty tab switching
    document.querySelectorAll('.train-diff-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            selectedDifficulty = tab.dataset.diff;
            document.querySelectorAll('.train-diff-tab').forEach(t => {
                t.style.borderColor = '#555'; t.style.color = '#888'; t.style.background = '#1a1f25';
                t.classList.remove('active');
            });
            tab.style.borderColor = selectedDifficulty === 'hard' ? '#4a9eff' : '#ff6b6b';
            tab.style.color = selectedDifficulty === 'hard' ? '#4a9eff' : '#ff6b6b';
            tab.style.background = '#1a2332';
            tab.classList.add('active');
            pollStatus();
        });
    });

    // Preset buttons
    document.querySelectorAll('.train-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const ep = parseInt(btn.dataset.episodes);
            if (episodeInput) episodeInput.value = ep;
        });
    });

    if (startBtn) startBtn.addEventListener('click', async () => {
        const episodes = parseInt(episodeInput.value) || 5000;
        const continuous = continuousChk ? continuousChk.checked : false;
        try {
            const res = await fetch('/api/ai-training/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ episodes, continuous, difficulty: selectedDifficulty })
            });
            const data = await res.json();
            if (data.frozen) { alert('이 난이도는 고정(잠금) 상태입니다. 해제 후 학습하세요.'); return; }
            if (data.started) {
                startBtn.disabled = true;
                stopBtn.disabled = false;
                startPolling();
            }
        } catch(e) { console.error('Training start error:', e); }
    });

    if (stopBtn) stopBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/ai-training/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ difficulty: selectedDifficulty })
            });
            stopBtn.disabled = true;
            startBtn.disabled = false;
        } catch(e) { console.error('Training stop error:', e); }
    });

    if (resetBtn) resetBtn.addEventListener('click', async () => {
        const diffLabel = selectedDifficulty === 'hard' ? '어려움' : '전문가';
        if (!confirm('[' + diffLabel + '] 가중치를 초기화하시겠습니까? 이 난이도의 모든 학습 데이터가 삭제됩니다.')) return;
        try {
            await fetch('/api/ai-training/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ difficulty: selectedDifficulty })
            });
            pollStatus();
        } catch(e) { console.error('Reset error:', e); }
    });

    // Freeze/unfreeze toggle
    if (freezeBtn) freezeBtn.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/ai-training/status?difficulty=' + selectedDifficulty);
            const st = await res.json();
            const newFreeze = !st.frozen;
            await fetch('/api/ai-training/freeze', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ difficulty: selectedDifficulty, freeze: newFreeze })
            });
            pollStatus();
        } catch(e) { console.error('Freeze error:', e); }
    });

    function startPolling() {
        stopPolling();
        pollStatus();
        trainPollTimer = setInterval(pollStatus, 2000);
    }
    function stopPolling() {
        if (trainPollTimer) { clearInterval(trainPollTimer); trainPollTimer = null; }
    }

    async function pollStatus() {
        try {
            const res = await fetch('/api/ai-training/status?difficulty=' + selectedDifficulty);
            const data = await res.json();
            const s = document.getElementById('trainStatus');
            if (s) s.textContent = data.isTraining ? '학습 중...' : '대기중';
            const frozenBadge = document.getElementById('trainFrozenBadge');
            if (frozenBadge) frozenBadge.style.display = data.frozen ? 'inline' : 'none';
            if (freezeBtn) {
                freezeBtn.textContent = data.frozen ? '🔓 해제' : '🔒 고정';
                freezeBtn.style.background = data.frozen ? '#1b4e2d' : '#2d1b4e';
                freezeBtn.style.color = data.frozen ? '#a5ffd4' : '#d4a5ff';
            }
            const ep = document.getElementById('trainEpisode');
            if (ep) ep.textContent = data.currentEpisode || 0;
            const mx = document.getElementById('trainMaxEpisode');
            if (mx) mx.textContent = data.maxEpisodes || 0;
            const te = document.getElementById('trainTotalEpisodes');
            if (te) te.textContent = data.stats ? data.stats.episodes : 0;
            if (data.stats) {
                const st2 = document.getElementById('trainStates');
                if (st2) st2.textContent = data.stats.states || 0;
                const ar = document.getElementById('trainAvgReward');
                if (ar) ar.textContent = data.stats.avgReward || 0;
                const eps = document.getElementById('trainEpsilon');
                if (eps) eps.textContent = data.stats.epsilon || 0;
            }
            if (logDiv && data.log) {
                logDiv.innerHTML = data.log.map(l => '<div>' + l + '</div>').join('');
                logDiv.scrollTop = logDiv.scrollHeight;
            }
            if (!data.isTraining) {
                if (startBtn) startBtn.disabled = false;
                if (stopBtn) stopBtn.disabled = true;
            }
            // Update summary cards for all difficulties
            if (data.allDifficulties) {
                for (const [d, info] of Object.entries(data.allDifficulties)) {
                    const cap = d === 'hard' ? 'Hard' : 'Expert';
                    const stEl = document.getElementById('sum' + cap + 'States');
                    if (stEl) stEl.textContent = info.stats.states || 0;
                    const epEl = document.getElementById('sum' + cap + 'Episodes');
                    if (epEl) epEl.textContent = info.stats.episodes || 0;
                    const frEl = document.getElementById('sum' + cap + 'Frozen');
                    if (frEl) {
                        frEl.textContent = info.frozen ? '🔒 고정됨' : (info.isTraining ? '⚡ 학습중' : '🔓 활성');
                        frEl.style.color = info.frozen ? '#ff4444' : (info.isTraining ? '#4aff4a' : '#888');
                    }
                }
            }
        } catch(e) {}
    }

    // Auto-poll on panel open
    const observer = new MutationObserver(() => {
        if (panel && panel.style.display !== 'none') {
            pollStatus();
            startPolling();
        } else {
            stopPolling();
        }
    });
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['style'] });
})();

// Fetch server room info for login screen
async function fetchRoomInfo() {
    try {
        const res = await fetch('/api/rooms');
        const rooms = await res.json();
        const infoEl = document.getElementById('serverInfo');
        if (infoEl && rooms.length) {
            infoEl.textContent = rooms.map(r => `${r.name}: ${r.playerCount}/${r.maxPlayers}명`).join(' | ');
        }
    } catch(e) {}
}
fetchRoomInfo();
setInterval(fetchRoomInfo, 5000);

function scheduleRoomAnnihilationLogout(messageText) {
    if (roomAnnihilationLogoutTimeoutId) {
        clearTimeout(roomAnnihilationLogoutTimeoutId);
        roomAnnihilationLogoutTimeoutId = null;
    }

    showKillLogMessage(messageText);
    roomAnnihilationLogoutTimeoutId = setTimeout(() => {
        roomAnnihilationLogoutTimeoutId = null;
        logout();
    }, 1500);
}

// Enter key support for login
document.getElementById('username').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
});

let isLoggingIn = false;

async function login() {
    // 중복 실행 방지
    if (isLoggingIn) {
        console.log('Login already in progress');
        return;
    }
    
    const username = document.getElementById('username').value;
    
    if (!username) {
        document.getElementById('authError').textContent = '이름을 입력하세요.';
        return;
    }

    // (AIMANAGEMODE is handled by server response below)
    
    isLoggingIn = true;
    document.getElementById('authError').textContent = '접속 중...';
    console.log('Starting login...');
    
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        
        const data = await res.json();

        // AIMANAGEMODE: server returns special flag, open training panel
        if (ENABLE_AI_TRAINING_UI && data.aiManageMode) {
            isLoggingIn = false;
            document.getElementById('authError').textContent = '';
            const panel = document.getElementById('trainingPanel');
            if (panel) panel.style.display = 'block';
            document.getElementById('username').value = '';
            return;
        }
        
        if (res.ok) {
            gameState.token = data.token;
            gameState.userId = data.userId;
            gameState.username = username;
            gameState.selectedRoom = document.getElementById('serverSelect').value;
            localStorage.setItem('token', data.token);
            localStorage.setItem('selectedRoom', gameState.selectedRoom);
            document.getElementById('authError').textContent = '';
            console.log('Login successful, connecting to game...');
            connectToGame();
        } else {
            document.getElementById('authError').textContent = data.error || '접속 실패';
            isLoggingIn = false;
        }
    } catch (err) {
        console.error('Login error:', err);
        document.getElementById('authError').textContent = '서버 연결 실패';
        isLoggingIn = false;
    }
}

function logout() {
    console.log('Logging out...');
    isLoggingIn = false;
    gameState.userId = null;
    gameState.token = null;
    gameState.username = null;
    if (roomAnnihilationLogoutTimeoutId) {
        clearTimeout(roomAnnihilationLogoutTimeoutId);
        roomAnnihilationLogoutTimeoutId = null;
    }
    resetSecretClickStreak(rankingPanelSecretClicks);
    resetSecretClickStreak(minimapSecretClicks);
    resetSecretClickStreak(loginPanelSecretClicks);
    resetSecretClickStreak(workerPortraitSecretClicks);
    resetSecretClickStreak(battleshipPortraitSecretClicks);
    clearTemporaryFullMapReveal();
    lastSeenRedZoneActivationAt = 0;
    slbmMissiles = [];
    stopAllManagedBattleSounds();
    attackProjectiles = [];
    gameState.activeAirstrikes = [];
    gameState.redZones = [];
    localStorage.removeItem('token');
    stopUpdate();
    stopBackgroundLoops();
    if (rankingInterval) {
        clearInterval(rankingInterval);
        rankingInterval = null;
    }
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
    document.getElementById('loginScreen').classList.add('active');
    document.getElementById('gameScreen').classList.remove('active');
}

async function resetGame() {
    // Confirm before reset
    if (!confirm('게임을 초기화하시겠습니까?\n진행 중인 게임, 점수, 사용자 데이터가 모두 초기화됩니다.')) {
        return;
    }
    
    const token = localStorage.getItem('token');
    if (!token) {
        alert('로그인이 필요합니다.');
        return;
    }
    
    try {
        const res = await fetch('/api/reset', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await res.json();
        
        if (res.ok) {
            alert('내 기지가 초기화되었습니다. 새로운 위치에서 시작합니다.');
            // Reconnect to game
            if (socket) {
                socket.removeAllListeners();
                socket.disconnect();
                socket = null;
            }
            connectToGame();
        } else {
            alert(data.error || '초기화 실패');
        }
    } catch (error) {
        console.error('Reset error:', error);
        alert('서버 연결 실패');
    }
}

function connectToGame() {
    console.log('connectToGame called');
    stopUpdate();
    stopBackgroundLoops();
    
    // Disconnect existing socket if any
    if (socket) {
        console.log('Cleaning up existing socket');
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
    
    // Clear existing ranking interval
    if (rankingInterval) {
        clearInterval(rankingInterval);
        rankingInterval = null;
    }
    
    // 화면 전환은 init 이벤트를 받은 뒤 수행
    
    socket = io({
        auth: {
            token: gameState.token,
            roomId: gameState.selectedRoom || localStorage.getItem('selectedRoom') || 'server1'
        },
        transports: ['websocket'],
        reconnection: false // 자동 재연결 비활성화
    });
    
    socket.on('connect', () => {
        console.log('Connected to server');
        lastViewportEmitAt = 0;
        lastViewportSignature = '';
    });
    
    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        isLoggingIn = false;
        if (socket) {
            socket.removeAllListeners();
            socket.disconnect();
            socket = null;
        }
        document.getElementById('loginScreen').classList.add('active');
        document.getElementById('gameScreen').classList.remove('active');
        document.getElementById('authError').textContent = '로그인 실패: 토큰이 유효하지 않거나 만료되었습니다.';
        localStorage.removeItem('token');
    });
    
    socket.on('disconnect', (reason) => {
        console.log('Disconnected:', reason);
        stopAllManagedBattleSounds();
        stopBackgroundLoops();
        stopUpdate();
        lastViewportEmitAt = 0;
        lastViewportSignature = '';
        if (reason === 'io server disconnect' || reason === 'io client disconnect') {
            // Don't auto-reconnect
        }
    });
    
    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });
    
    socket.on('aiDifficultyChanged', (data) => {
        if (data && data.label) {
            addSystemLog('AI 난이도 변경: ' + data.label);
        }
    });

    socket.on('init', (data) => {
        console.log('Received init data:', data);
        
        // Set AI difficulty (first human player sets it)
        if (diffSelect && data && data.aiDifficulty && diffDescs[data.aiDifficulty]) {
            diffSelect.value = AI_DIFFICULTY_SELECTION_ENABLED ? data.aiDifficulty : DEFAULT_AI_DIFFICULTY;
            if (diffDesc) diffDesc.textContent = diffDescs[diffSelect.value] || '';
        }
        socket.emit('setAIDifficulty', { difficulty: getSelectedAIDifficulty() });
        
        try {
            gameState.userId = data.userId;
            gameState.map = hydrateClientMap(data.map);
            resetMapImageState();
            ensureMapImageLoaded();
            gameState.missiles = data.missiles || 0;
            resetSecretClickStreak(rankingPanelSecretClicks);
            resetSecretClickStreak(minimapSecretClicks);
            resetSecretClickStreak(loginPanelSecretClicks);
            resetSecretClickStreak(workerPortraitSecretClicks);
            resetSecretClickStreak(battleshipPortraitSecretClicks);
            clearTemporaryFullMapReveal();
            lastSeenRedZoneActivationAt = 0;
            
            console.log('Map loaded:', gameState.map ? 'yes' : 'no');
            console.log('Map size:', gameState.map ? `${gameState.map.width}x${gameState.map.height}` : 'no map');
            console.log('Land cells: GET /api/map/land-cells or run downloadLandCells() in browser console');
            
            gameState.players.clear();
            data.players.forEach(p => gameState.players.set(p.userId, p));
            console.log('Players loaded:', gameState.players.size);
            
            gameState.units.clear();
            data.units.forEach(u => gameState.units.set(u.id, u));
            // Rebuild squads from unit data
            gameState.squads.clear();
            for (const [uid, u] of gameState.units) {
                if (u.squadId) {
                    if (!gameState.squads.has(u.squadId)) {
                        gameState.squads.set(u.squadId, { unitIds: [], formationType: u.formationType || 'trapezoid' });
                    }
                    gameState.squads.get(u.squadId).unitIds.push(u.id);
                }
            }
            console.log('Units loaded:', gameState.units.size, 'Squads:', gameState.squads.size);
            
            gameState.buildings.clear();
            data.buildings.forEach(b => {
                const normalizedBuilding = normalizeBuildingPayload(b);
                gameState.buildings.set(normalizedBuilding.id, normalizedBuilding);
            });
            console.log('Buildings loaded:', gameState.buildings.size);
            
            // Clear fog of war for fresh start
            gameState.fogOfWar.clear();
            slbmMissiles = [];
            stopAllManagedBattleSounds();
            attackProjectiles = [];
            gameState.activeAirstrikes = [];
            applyRedZoneSync(data.redZones);
            fogDirty = true;
            minimapDirty = true;
            lastServerUpdateTime = 0;
            serverTickAvgMs = 100;
            interpolationDurationMs = 100;
            
            // Center camera on player's base
            const player = gameState.players.get(gameState.userId);
            if (player) {
                gameState.camera.x = player.baseX;
                gameState.camera.y = player.baseY;
                clampCameraToMapBounds();
                console.log('Camera centered at:', gameState.camera.x, gameState.camera.y);
            } else {
                console.warn('Player data not found!');
            }
            
            console.log('Starting game update loop...');
            updateHUD();
            updateFogOfWar(true); // Initial fog of war update
            renderMinimap();
            lastMinimapRenderAt = Date.now();
            emitViewportUpdate(true);
            startBackgroundLoops();
            startUpdate();
            updateRankings();
            rankingInterval = setInterval(updateRankings, 5000);
            
            // 실제 화면 전환
            console.log('Switching to game screen...');
            document.getElementById('loginScreen').classList.remove('active');
            document.getElementById('gameScreen').classList.add('active');
            isLoggingIn = false;
            
            console.log('Game initialized successfully!');
        } catch (error) {
            console.error('Error in init handler:', error);
            socket.disconnect();
            isLoggingIn = false;
        }
    });
    
    socket.on('gameUpdate', (data) => {
        const nowMs = Date.now();
        if (lastServerUpdateTime > 0) {
            const tick = nowMs - lastServerUpdateTime;
            if (tick >= 40 && tick <= 500) {
                serverTickAvgMs = (serverTickAvgMs * 0.8) + (tick * 0.2);
                interpolationDurationMs = Math.max(90, Math.min(260, Math.round(serverTickAvgMs * 1.15)));
            }
        }
        lastServerUpdateTime = nowMs;

        // Players - use a fast id set built inline
        const serverPlayerIds = new Set();
        for (let i = 0; i < data.players.length; i++) {
            const p = data.players[i];
            serverPlayerIds.add(p.userId);
            gameState.players.set(p.userId, p);
        }
        gameState.players.forEach((player, id) => {
            if (!serverPlayerIds.has(id)) gameState.players.delete(id);
        });
        
        // Units - avoid creating intermediate Set from .map()
        const serverUnitIds = new Set();
        for (let i = 0; i < data.units.length; i++) {
            serverUnitIds.add(data.units[i].id);
        }
        
        // Remove units that no longer exist on server
        gameState.units.forEach((unit, id) => {
            if (!serverUnitIds.has(id)) gameState.units.delete(id);
        });
        
        // Update units with interpolation support
        for (let i = 0; i < data.units.length; i++) {
            const u = data.units[i];
            const existingUnit = gameState.units.get(u.id);
            const mergedUnit = mergeUnitState(existingUnit, u, nowMs);
            gameState.units.set(mergedUnit.id, mergedUnit);
        }
        
        // Buildings - same optimization
        const serverBuildingIds = new Set();
        for (let i = 0; i < data.buildings.length; i++) {
            serverBuildingIds.add(data.buildings[i].id);
        }
        gameState.buildings.forEach((building, id) => {
            if (!serverBuildingIds.has(id)) gameState.buildings.delete(id);
        });
        
        for (let i = 0; i < data.buildings.length; i++) {
            const b = data.buildings[i];
            const existingBuilding = gameState.buildings.get(b.id);
            const mergedBuilding = mergeBuildingVisualState(existingBuilding, b);
            gameState.buildings.set(mergedBuilding.id, mergedBuilding);
        }
        fogDirty = true;
        if (nowMs - lastMinimapInvalidateTime >= 220) {
            minimapDirty = true;
            lastMinimapInvalidateTime = nowMs;
        }
        
        updateHUD();
        if ((gameState.selection.size > 0 || gameState.inspectedUnitId) && nowMs >= selectionInfoSuspendUntil) {
            updateSelectionInfo(); // Refresh production progress bar etc.
        }
    });
    
    socket.on('unitCreated', (unit) => {
        const mergedUnit = mergeUnitState(gameState.units.get(unit.id), unit, Date.now());
        gameState.units.set(mergedUnit.id, mergedUnit);
        fogDirty = true;
        minimapDirty = true;
    });

    socket.on('squadCreated', (data) => {
        if (data && data.squadId && Array.isArray(data.unitIds)) {
            gameState.squads.set(data.squadId, { unitIds: data.unitIds, formationType: data.formationType || 'trapezoid' });
            data.unitIds.forEach(uid => {
                const u = gameState.units.get(uid);
                if (u) u.squadId = data.squadId;
            });
        }
    });

    socket.on('formationTypeChanged', (data) => {
        if (data && data.squadId && data.formationType) {
            const sq = gameState.squads.get(data.squadId);
            if (sq) sq.formationType = data.formationType;
            updateSelectionInfo();
            updateFormationPanel();
        }
    });

    socket.on('squadDisbanded', (data) => {
        if (data && data.squadId) {
            const squad = gameState.squads.get(data.squadId);
            if (squad) {
                squad.unitIds.forEach(uid => {
                    const u = gameState.units.get(uid);
                    if (u) u.squadId = null;
                });
            }
            gameState.squads.delete(data.squadId);
        }
    });
    
    socket.on('buildingCreated', (building) => {
        const existingBuilding = gameState.buildings.get(building.id);
        const mergedBuilding = mergeBuildingVisualState(existingBuilding, building);
        gameState.buildings.set(mergedBuilding.id, mergedBuilding);
        fogDirty = true;
        minimapDirty = true;
    });

    socket.on('playerJoined', () => {
        updateRankings();
    });

    socket.on('playerLeft', () => {
        updateRankings();
    });

    socket.on('systemMessage', (data) => {
        if (data && data.text) {
            showKillLogMessage(data.text, 'system');
        }
    });

    socket.on('battleshipModeComboUnlocked', (data) => {
        if (!data) return;
        showKillLogMessage(
            data.alreadyUnlocked
                ? '⚡ 이 전함은 이미 전투태세 + 이지스 동시 운용이 해금되어 있음'
                : '⚡ 선택 전함 1척에 전투태세 + 이지스 동시 운용이 해금됨',
            'system'
        );
    });

    socket.on('systemKillLog', (data) => {
        if (data && typeof data.message === 'string' && data.message) {
            showKillLogMessage(data.message, data.variant || '');
        }
    });

    socket.on('serverAnnihilation', (data) => {
        if (!data || typeof data.message !== 'string' || !data.message) {
            return;
        }
        scheduleRoomAnnihilationLogout(data.message);
    });

    socket.on('redZoneSync', (data) => {
        applyRedZoneSync(data && data.redZones);
    });

    socket.on('redZoneAlert', (data) => {
        if (!data || typeof data.message !== 'string' || !data.message) {
            return;
        }
        if (data.targetUserId != null && data.targetUserId !== gameState.userId) {
            return;
        }
        showKillLogMessage(data.message, 'red-zone');
    });

    socket.on('redZoneDetonation', (data) => {
        const now = Date.now();
        const burstPoints = Array.isArray(data?.burstPoints) ? data.burstPoints : [];
        burstPoints.forEach(point => {
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            explosionEffects.push(createRedZoneExplosionEffect(point.x, point.y, now + (point.delayMs || 0)));
        });
        const zone = Array.isArray(gameState.redZones)
            ? gameState.redZones.find(entry => entry.id === data?.id)
            : null;
        if (zone) {
            zone.detonatedAt = now;
        }
        fogDirty = true;
        minimapDirty = true;
        playSoundBomb();
    });
    
    socket.on('playerDefeated', (data) => {
        const isRedZoneDefeat = data && data.defeatReason === 'red_zone';
        // Show kill log message on screen
        if (!isRedZoneDefeat && data.defeatedName && data.attackerName) {
            showKillLog(data.attackerName, data.defeatedName);
        }
        if (isRedZoneDefeat && data.userId === gameState.userId) {
            showKillLogMessage('의도적인 설계에 의해 처치되었습니다', 'red-zone');
        }

        updateRankings();
        
        if (data.userId === gameState.userId && data.respawned) {
            // Reset local player data
            const player = gameState.players.get(gameState.userId);
            if (player) {
                player.resources = 1000;
                player.population = 0;
                player.maxPopulation = 10;
                player.combatPower = 0;
                player.score = 0;
                player.researchedSLBM = false;
            }
            gameState.missiles = 0;
            gameState.selection.clear();
            gameState.inspectedUnitId = null;
            updateHUD();
            updateSelectionInfo();
            fogDirty = true;
            minimapDirty = true;
            alert('게임에서 패배했습니다. 새로운 게임을 시작합니다.');
        }
    });
    
    socket.on('slbmFired', (data) => {
        // Add missile to visualization array
        slbmMissiles.push({
            id: data.id,
            fromX: data.fromX,
            fromY: data.fromY,
            targetX: data.targetX,
            targetY: data.targetY,
            startTime: Date.now(),
            flightTime: 5000, // 5 seconds flight time
            impacted: false,
            userId: data.userId,
            flightSoundInstance: null
        });
        minimapDirty = true;
        
        // Decrease missile count if it's our missile
        if (data.userId === gameState.userId) {
            gameState.missiles = Math.max(0, gameState.missiles - 1);
            updateHUD();
        }
        
        console.log('SLBM fired from', data.fromX, data.fromY, 'to', data.targetX, data.targetY);
    });

    socket.on('airstrikeLaunched', (data) => {
        // Create airstrike visual effect - flies from entry to exit (through target)
        if (!gameState.activeAirstrikes) gameState.activeAirstrikes = [];
        gameState.activeAirstrikes.push({
            id: data.id,
            fromX: data.fromX,
            fromY: data.fromY,
            exitX: data.exitX,
            exitY: data.exitY,
            targetX: data.targetX,
            targetY: data.targetY,
            targetProgress: data.targetProgress,
            startTime: Date.now() + (data.startDelay || 0),
            flightTime: data.flightTime,
            userId: data.userId,
            passesCompleted: 0
        });
        fogDirty = true;
        minimapDirty = true;
    });

    socket.on('airstrikeCancelled', (data) => {
        if (!gameState.activeAirstrikes) return;
        gameState.activeAirstrikes = gameState.activeAirstrikes.filter(strike => strike.id !== data.id);
        fogDirty = true;
        minimapDirty = true;
    });

    socket.on('airstrikePass', (data) => {
        // Generate explosion visuals - carpet bombing spread over 800ms as plane passes
        const radius = data.radius || AIRSTRIKE_TARGET_RADIUS;
        const bombCount = data.explosionsPerPass || 30;
        const bombDuration = 800; // spread explosions over 800ms
        const now = Date.now();
        // Get flight direction from the active strike for realistic carpet pattern
        let dirX = 0, dirY = 1;
        if (gameState.activeAirstrikes) {
            const strike = gameState.activeAirstrikes.find(s => s.id === data.id);
            if (strike) {
                const destX = strike.exitX != null ? strike.exitX : strike.targetX;
                const destY = strike.exitY != null ? strike.exitY : strike.targetY;
                const ddx = destX - strike.fromX;
                const ddy = destY - strike.fromY;
                const dlen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
                dirX = ddx / dlen;
                dirY = ddy / dlen;
            }
        }
        for (let i = 0; i < bombCount; i++) {
            const t = i / bombCount; // 0 to 1 over the pass
            const delay = t * bombDuration;
            // Bombs fall along flight path direction with spread
            const alongOffset = (t - 0.5) * radius * 1.5; // spread along flight path
            const perpOffset = (Math.random() - 0.5) * radius * 0.8; // lateral spread
            const ex = data.targetX + dirX * alongOffset - dirY * perpOffset;
            const ey = data.targetY + dirY * alongOffset + dirX * perpOffset;
            explosionEffects.push({
                x: ex,
                y: ey,
                startTime: now + delay,
                duration: 600,
                maxRadius: 30 + Math.random() * 20
            });
        }
        // Update pass count (image continues flying to exit)
        if (gameState.activeAirstrikes) {
            const strike = gameState.activeAirstrikes.find(s => s.id === data.id);
            if (strike) {
                strike.passesCompleted = data.passNum;
            }
        }
        playSoundBomb();
    });

    socket.on('airstrikeNextPass', (data) => {
        // No longer used - single fly-through with 3 bombings
    });

    socket.on('searchActivated', (data) => {
        // Visual pulse effect for destroyer search
        explosionEffects.push({
            x: data.x,
            y: data.y,
            startTime: Date.now(),
            duration: 1000,
            maxRadius: data.radius || 1500,
            color: 0x00bcd4,
            isSearchPulse: true
        });
    });

    socket.on('attackProjectileFired', (data) => {
        const baseId       = data.id || `${Date.now()}-${Math.random()}`;
        const startTime    = data.startTime || Date.now();
        const flightTime   = data.flightTime || 600;
        const isBattleship = data.shooterType === 'battleship';
        const isDefenseTower = data.shooterType === 'defense_tower';

        if (isBattleship) {
            const shooter = data.shooterId ? gameState.units.get(data.shooterId) : null;
            const shipAngle = (shooter && shooter.displayAngle !== undefined)
                ? shooter.displayAngle
                : (shooter && shooter.commandAngle !== undefined)
                    ? shooter.commandAngle
                    : (Number.isFinite(data.targetY) && Number.isFinite(data.targetX))
                        ? Math.atan2(data.targetY - data.fromY, data.targetX - data.fromX)
                        : (shooter ? shooter.angle || 0 : 0);

            const shipX = (shooter && shooter.interpDisplayX !== undefined)
                ? shooter.interpDisplayX
                : ((shooter && shooter.x !== undefined) ? shooter.x : data.fromX);
            const shipY = (shooter && shooter.interpDisplayY !== undefined)
                ? shooter.interpDisplayY
                : ((shooter && shooter.y !== undefined) ? shooter.y : data.fromY);
            if (shooter && data.aimedShot && !shooter.battleshipAegisMode) {
                shooter.aimedShot = false;
                shooter.aimedShotCooldownUntil = startTime + 16000;
                if (gameState.selection.has(shooter.id) || gameState.inspectedUnitId === shooter.id) {
                    updateSelectionInfo();
                }
            }

            const turretCenters = getBattleshipTurretWorldStates(shipX, shipY, shipAngle, 60, null, shooter);

            // Aegis mode: data.shots array with per-turret targets
            if (Array.isArray(data.shots) && data.shots.length > 0) {
                const nextTurretAngles = Array.isArray(shooter?.turretAngles)
                    ? shooter.turretAngles.slice()
                    : turretCenters.map(() => shipAngle);
                data.shots.forEach((shot, seqIdx) => {
                    if (!shot || !Number.isFinite(shot.targetX) || !Number.isFinite(shot.targetY)) return;
                    const ti = Number.isInteger(shot.turretIndex) ? shot.turretIndex : seqIdx;
                    if (ti < 0 || ti >= turretCenters.length) return;
                    const tc = turretCenters[ti];
                    const fireAngle = Math.atan2(shot.targetY - tc.centerY, shot.targetX - tc.centerX);
                    nextTurretAngles[ti] = fireAngle;
                    const muzzleAngles = turretCenters.map(() => shipAngle);
                    muzzleAngles[ti] = fireAngle;
                    const muzzleStates = getBattleshipTurretWorldStates(shipX, shipY, shipAngle, 60, muzzleAngles, shooter);
                    const turret = muzzleStates[ti];
                    if (!turret) return;
                    attackProjectiles.push({
                        id: shot.id || `${baseId}-${ti}`,
                        fromX: turret.muzzleX,
                        fromY: turret.muzzleY,
                        targetX: shot.targetX,
                        targetY: shot.targetY,
                        targetId: shot.targetId,
                        shooterType: 'battleship',
                        aimedShot: false,
                        soundTrigger: seqIdx === 0,
                        soundInstance: null,
                        startTime,
                        flightTime: shot.flightTime || flightTime
                    });
                });
                if (shooter) {
                    shooter.turretAngles = nextTurretAngles;
                    shooter.lastTurretTargetTime = startTime;
                }
            } else {
                // Normal (non-Aegis) battleship firing
                const fireAngles = turretCenters.map(turret => Math.atan2(
                    data.targetY - turret.centerY,
                    data.targetX - turret.centerX
                ));
                const turretIndices = Array.isArray(data.turretIndices) && data.turretIndices.length > 0
                    ? data.turretIndices.filter(index => Number.isInteger(index) && index >= 0 && index < turretCenters.length)
                    : turretCenters.map((_, index) => index);

                if (shooter) {
                    const nextTurretAngles = Array.isArray(shooter.turretAngles)
                        ? shooter.turretAngles.slice()
                        : turretCenters.map(() => shipAngle);
                    turretIndices.forEach(index => {
                        nextTurretAngles[index] = fireAngles[index];
                    });
                    shooter.turretAngles = nextTurretAngles;
                    shooter.lastTurretTargetX = data.targetX;
                    shooter.lastTurretTargetY = data.targetY;
                    shooter.lastTurretTargetTime = startTime;
                }

                const turretMuzzles = getBattleshipTurretWorldStates(shipX, shipY, shipAngle, 60, fireAngles, shooter);
                turretIndices.forEach((turretIndex, sequenceIndex) => {
                    const turret = turretMuzzles[turretIndex];
                    if (!turret) return;
                    attackProjectiles.push({
                        id: `${baseId}-${turretIndex}`,
                        fromX: turret.muzzleX,
                        fromY: turret.muzzleY,
                        targetX: data.targetX,
                        targetY: data.targetY,
                        targetId: data.targetId,
                        shooterType: 'battleship',
                        aimedShot: data.aimedShot || false,
                        soundTrigger: sequenceIndex === 0,
                        soundInstance: null,
                        startTime,
                        flightTime
                    });
                });
            }
        } else {
            if (isDefenseTower && data.shooterId) {
                const tower = gameState.buildings.get(data.shooterId);
                if (tower) {
                    tower.turretAngle = Number.isFinite(data.turretAngle)
                        ? data.turretAngle
                        : Math.atan2(data.targetY - data.fromY, data.targetX - data.fromX);
                    tower.turretTargetX = data.targetX;
                    tower.turretTargetY = data.targetY;
                    tower.lastTurretTargetTime = startTime;
                    if (data.targetId) tower.attackTargetId = data.targetId;
                    if (!tower.attackTargetType) {
                        tower.attackTargetType = gameState.units.has(data.targetId) ? 'unit' : 'slbm';
                    }
                }
            }
            attackProjectiles.push({
                id: baseId,
                fromX:      data.fromX,
                fromY:      data.fromY,
                targetX:    data.targetX,
                targetY:    data.targetY,
                targetId:   data.targetId,
                shooterType: data.shooterType || 'destroyer',
                projectileKind: data.projectileKind || null,
                aimedShot:  data.aimedShot || false,
                soundTrigger: false,
                soundInstance: null,
                startTime,
                flightTime
            });
        }
    });
    
    socket.on('slbmImpact', (data) => {
        // Mark missile as impacted for visualization
        let hasVisibleImpact = false;
        slbmMissiles.forEach(missile => {
            if (!missile.impacted && (
                (data.id && missile.id === data.id) ||
                (Math.abs(missile.targetX - data.x) < 50 && Math.abs(missile.targetY - data.y) < 50)
            )) {
                missile.impacted = true;
                missile.impactTime = Date.now();
                hasVisibleImpact = hasVisibleImpact || isSlbmImpactVisibleToPlayer(missile);
                missile.flightSoundInstance = stopManagedBattleSound(missile.flightSoundInstance);
            }
        });
        
        if (!hasVisibleImpact && Number.isFinite(data.x) && Number.isFinite(data.y)) {
            hasVisibleImpact = isPositionVisible(data.x, data.y);
        }
        if (hasVisibleImpact) {
            playSoundBomb();
        }
        
        // Clean up old missiles after 30 seconds
        setTimeout(() => {
            slbmMissiles = slbmMissiles.filter(missile => {
                const keep = !missile.impacted || Date.now() - missile.impactTime < 30000;
                if (!keep && missile.flightSoundInstance) {
                    missile.flightSoundInstance = stopManagedBattleSound(missile.flightSoundInstance);
                }
                return keep;
            });
            minimapDirty = true;
        }, 30000);
        minimapDirty = true;
        
        console.log('SLBM impact at', data.x, data.y);
    });
    
    socket.on('slbmDestroyed', (data) => {
        // SLBM was intercepted - remove it from visualization
        slbmMissiles.forEach(missile => {
            if (missile.id === data.id) {
                missile.flightSoundInstance = stopManagedBattleSound(missile.flightSoundInstance);
            }
        });
        slbmMissiles = slbmMissiles.filter(missile => missile.id !== data.id);
        minimapDirty = true;
        console.log('SLBM intercepted at', data.x, data.y);
    });
    
    socket.on('slbmDamaged', (data) => {
        // Update SLBM HP for visualization
        const missile = slbmMissiles.find(m => m.id === data.id);
        if (missile) {
            missile.hp = data.hp;
            missile.maxHp = data.maxHp;
        }
    });
    
    socket.on('missileProduced', (data) => {
        if (data.userId === gameState.userId) {
            gameState.missiles = data.count;
            updateHUD();
        }
    });
    
    socket.on('researchCompleted', (data) => {
        if (data.userId === gameState.userId) {
            alert('연구 완료: ' + data.research);
        }
    });
    
    socket.on('slbmProduced', (data) => {
        const building = gameState.buildings.get(data.buildingId);
        if (building) {
            building.slbmCount = data.count;
            minimapDirty = true;
        }
    });

    // Unit destruction effect
    socket.on('unitDestroyed', (data) => {
        if (!isPositionVisible(data.x, data.y)) return;
        explosionEffects.push(createUnitDestroyedExplosionEffect(data, Date.now()));
    });

    // Building destruction explosion effect (grey debris)
    socket.on('buildingDestroyed', (data) => {
        if (!isPositionVisible(data.x, data.y)) return;
        const debrisCount = 25;
        const explosion = {
            x: data.x,
            y: data.y,
            startTime: Date.now(),
            duration: 2000,
            debris: []
        };
        for (let i = 0; i < debrisCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 30 + Math.random() * 150;
            explosion.debris.push({
                dx: Math.cos(angle) * speed,
                dy: Math.sin(angle) * speed,
                size: 3 + Math.random() * 8,
                color: Math.random() > 0.6 ? '#888888' : (Math.random() > 0.5 ? '#666666' : '#aaaaaa'),
                rotation: Math.random() * Math.PI * 2
            });
        }
        // Add some fire/smoke debris too
        for (let i = 0; i < 8; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 20 + Math.random() * 80;
            explosion.debris.push({
                dx: Math.cos(angle) * speed,
                dy: Math.sin(angle) * speed,
                size: 4 + Math.random() * 6,
                color: Math.random() > 0.5 ? '#ff6600' : '#cc4400',
                rotation: Math.random() * Math.PI * 2
            });
        }
        explosionEffects.push(explosion);
    });
}

function startBackgroundLoops() {
    if (!fogIntervalId) {
        fogIntervalId = setInterval(() => {
            updateFogOfWar();
        }, FOG_UPDATE_INTERVAL);
    }

    if (!minimapIntervalId) {
        minimapIntervalId = setInterval(() => {
            if (gameState.map && (minimapDirty || hasBlinkingRedZoneBuildings())) {
                const loadSettings = getClientLoadSettings();
                if ((Date.now() - lastMinimapRenderAt) < loadSettings.minimapMinIntervalMs) {
                    return;
                }
                renderMinimap();
                minimapDirty = false;
                lastMinimapRenderAt = Date.now();
            }
        }, MINIMAP_UPDATE_INTERVAL);
    }

    if (!viewportIntervalId) {
        viewportIntervalId = setInterval(() => {
            emitViewportUpdate(false);
        }, VIEWPORT_UPDATE_HEARTBEAT_MS);
    }
}

function stopBackgroundLoops() {
    if (fogIntervalId) {
        clearInterval(fogIntervalId);
        fogIntervalId = null;
    }
    if (minimapIntervalId) {
        clearInterval(minimapIntervalId);
        minimapIntervalId = null;
    }
    if (viewportIntervalId) {
        clearInterval(viewportIntervalId);
        viewportIntervalId = null;
    }
}

// Update fog of war based on player's units and buildings
function updateFogOfWar(force = false) {
    if (!gameState.map) return;

    const now = Date.now();
    const hasDynamicVisionSource =
        slbmMissiles.some(missile => !missile.impacted || (missile.impactTime && (now - missile.impactTime < 10000))) ||
        ((gameState.activeAirstrikes || []).some(strike => {
            if (now < strike.startTime) return false;
            const progress = Math.min(1, (now - strike.startTime) / strike.flightTime);
            const targetProgress = Number.isFinite(strike.targetProgress) ? strike.targetProgress : 1;
            return progress >= targetProgress && progress < 1;
        }));
    if (!force && !fogDirty && !hasDynamicVisionSource) return;

    const gridSize = getMapGridSize(gameState.map);
    const cellSize = getMapCellSize(gameState.map); // World units per grid cell
    if (!gridSize || !cellSize) return;

    // Ensure the offscreen fog canvas exists (creates it on first call / grid-size change).
    ensureFogLayerCanvas(gridSize);
    
    // Vision ranges (in world units) - increased for better visibility
    const visionRanges = {
        'worker': 1000,
        'destroyer': 1000,
        'cruiser': 1200,
        'battleship': 3200,
        'carrier': 2000,
        'assaultship': 1400,
        'submarine': 800,
        'missile_launcher': 1100,
        'recon_aircraft': RECON_AIRCRAFT_VISION_RADIUS
    };
    
    // Only update for own units (use == for type coercion).
    // Sampling keeps fog updates stable when hundreds of units are selected/active.
    // PERF: Reuse module-level _ownUnitsTemp array to avoid new [] every tick.
    _ownUnitsTemp.length = 0;
    gameState.units.forEach(unit => {
        if (unit.userId == gameState.userId) {
            _ownUnitsTemp.push(unit);
        }
    });
    const maxVisionSources = 180;
    const unitSampleStep = _ownUnitsTemp.length > maxVisionSources
        ? Math.ceil(_ownUnitsTemp.length / maxVisionSources)
        : 1;

    for (let i = 0; i < _ownUnitsTemp.length; i += unitSampleStep) {
        const unit = _ownUnitsTemp[i];
        let radius = visionRanges[unit.type] || 1000;
        if (unit.type === 'battleship' && unit.battleshipAegisMode) {
            radius = Math.round(radius * BATTLESHIP_AEGIS_RANGE_MULTIPLIER);
        }
        if (unit.type === 'destroyer' && unit.searchActiveUntil && now < unit.searchActiveUntil) {
            radius = DESTROYER_SEARCH_VISION_RADIUS;
        }
        const gridX = Math.floor(unit.x / cellSize);
        const gridY = Math.floor(unit.y / cellSize);
        const gridRadius = Math.ceil(radius / cellSize);
        const offsets = getFogCircleOffsets(gridRadius);
        revealFogArea(gridX, gridY, gridSize, offsets, now);
    }
    
    // Update for own buildings (provide vision even if not complete)
    gameState.buildings.forEach(building => {
        if (building.userId == gameState.userId) {
            const radius = 2000; // Building vision range - large for good visibility
            const gridX = Math.floor(building.x / cellSize);
            const gridY = Math.floor(building.y / cellSize);
            const gridRadius = Math.ceil(radius / cellSize);
            const offsets = getFogCircleOffsets(gridRadius);
            revealFogArea(gridX, gridY, gridSize, offsets, now);
        }
    });

    const slbmGridRadius = Math.ceil(SLBM_OWNER_VISION_RADIUS / cellSize);
    const slbmOffsets = getFogCircleOffsets(slbmGridRadius);
    slbmMissiles.forEach(missile => {
        if (missile.userId !== gameState.userId) return;

        let visionX = null;
        let visionY = null;
        if (!missile.impacted) {
            const position = getSlbmWorldPosition(missile, now);
            if (!position) return;
            visionX = position.x;
            visionY = position.y;
        } else if (missile.impactTime && (now - missile.impactTime < 10000)) {
            visionX = missile.targetX;
            visionY = missile.targetY;
        } else {
            return;
        }

        const gridX = Math.floor(visionX / cellSize);
        const gridY = Math.floor(visionY / cellSize);
        revealFogArea(gridX, gridY, gridSize, slbmOffsets, now);
    });

    const airstrikeGridRadius = Math.ceil(AIRSTRIKE_TARGET_RADIUS / cellSize);
    const airstrikeOffsets = getFogCircleOffsets(airstrikeGridRadius);
    (gameState.activeAirstrikes || []).forEach(strike => {
        if (now < strike.startTime) return;
        const progress = Math.min(1, (now - strike.startTime) / strike.flightTime);
        const targetProgress = Number.isFinite(strike.targetProgress) ? strike.targetProgress : 1;
        if (progress < targetProgress || progress >= 1) return;
        const gridX = Math.floor(strike.targetX / cellSize);
        const gridY = Math.floor(strike.targetY / cellSize);
        revealFogArea(gridX, gridY, gridSize, airstrikeOffsets, now);
    });

    gameState.fogOfWar.forEach((fogInfo, key) => {
        if (!fogInfo.explored || now - fogInfo.lastSeen >= FOG_VISIBLE_WINDOW_MS) {
            gameState.fogOfWar.delete(key);
        }
    });

    // Rebuild the offscreen fog canvas to reflect all reveals made in this tick.
    // This runs at ~1.5 Hz (FOG_UPDATE_INTERVAL), not 60 fps.
    refreshFogLayer(gridSize, now);

    fogDirty = false;
    minimapDirty = true;
}

function applyBranding() {
    document.title = APP_NAME;
    const loginTitle = document.querySelector('#loginScreen h1');
    if (loginTitle) {
        loginTitle.textContent = APP_NAME;
    }
}

// Initialize - show login screen by default
applyBranding();
document.getElementById('loginScreen').classList.add('active');
document.getElementById('gameScreen').classList.remove('active');

// Don't auto-login to prevent infinite reconnection issues
// Users must login manually
localStorage.removeItem('token'); // Clear any old tokens
