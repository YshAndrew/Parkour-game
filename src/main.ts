import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { LevelRegistry } from './levels/registry';
import { Save } from './core/save-data';
import { generateMap } from './core/generator';
import type { LevelData } from './core/map-format';
import { UI } from './ui/ui';

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0d0f18',
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 960,
    height: 540,
  },
  scene: [BootScene, GameScene],
};

const game = new Phaser.Game(config);

// ---------- 全局 UI 与场景桥接 ----------

let currentLevelIndex = 0;
let wired = false;

// ---------- 无限模式状态 ----------
let infinityMode = false;
const infinity = {
  round: 0,
  deaths: 0,
  coins: 0,
  level: null as LevelData | null,
  label: '',
};

function getScene() {
  return game.scene.getScene('game') as unknown as GameScene;
}

/** 用动态关卡数据（无限模式）或普通索引启动一关 */
function launchLevel(data: { levelIndex?: number; level?: LevelData }, label: string) {
  const scene = getScene();
  UI.hideOverlay();
  UI.hidePause();
  game.scene.resume('game');
  scene.events.once('game:ready', () => {
    UI.showHUD(label);
    scene.startLevel();
  });
  scene.scene.restart(data);
}

function startLevel(index: number) {
  infinityMode = false;
  currentLevelIndex = index;
  launchLevel({ levelIndex: index }, LevelRegistry.get(index).name);
}

/** 无限模式：生成一张随机关卡并开始（难度随轮数递增） */
function loadInfinityLevel() {
  const round = infinity.round;
  const diff = Math.min(1.0, 0.3 + round * 0.05);
  let res = generateMap({ difficulty: diff, width: 80 });
  if (!res) res = generateMap({ difficulty: Math.max(0.2, diff - 0.1), width: 80 }); // 极小概率兜底
  if (!res) {
    infinityMode = false;
    UI.showTitle();
    return;
  }
  const themes = ['forest', 'cave', 'sky'] as const;
  const theme = themes[Math.floor(Math.random() * themes.length)];
  infinity.level = {
    meta: {
      id: res.id,
      name: `无限模式 · 第 ${round + 1} 关`,
      hint: res.hint,
      theme,
    },
    grid: res.rows,
  };
  infinity.label = `无限模式 · 第 ${round + 1} 关（难度 ${diff.toFixed(2)}）`;
  launchLevel({ level: infinity.level }, infinity.label);
}

function startInfinity() {
  infinityMode = true;
  infinity.round = 0;
  infinity.deaths = 0;
  infinity.coins = 0;
  loadInfinityLevel();
}

function showMenu() {
  UI.hideHUD();
  UI.showTitle();
  game.scene.pause('game');
}

// 场景 → UI（GameScene 实例跨 restart 复用同一个 events emitter，只需绑定一次）
game.events.once('game:scene-ready', () => {
  if (wired) return;
  wired = true;
  const scene = getScene();

  scene.events.on(
    'game:tick',
    (d: { ms: number; deaths: number; coins: number; totalCoins: number }) => UI.updateHUD(d),
  );
  scene.events.on('game:died', () => UI.flashDeath());
  scene.events.on(
    'game:win',
    (d: {
      levelId: string;
      levelIndex: number;
      ms: number;
      deaths: number;
      coins: number;
      totalCoins: number;
      isInfinity?: boolean;
    }) => {
      if (d.isInfinity) {
        infinity.deaths += d.deaths;
        infinity.coins += d.coins;
        UI.showWin({
          ...d,
          isLast: false,
          isInfinity: true,
          round: infinity.round + 1,
          runDeaths: infinity.deaths,
          runCoins: infinity.coins,
        });
      } else {
        UI.showWin({ ...d, isLast: d.levelIndex + 1 >= LevelRegistry.count() });
      }
    },
  );
  scene.events.on('game:paused', () => UI.showPause(() => scene.resumeGame()));
  scene.events.on('game:resumed', () => UI.hidePause());

  UI.bindCanvas();

  // 深链：?level=2 直接打开第 2 关（方便调试新地图）
  const wanted = Number(new URLSearchParams(location.search).get('level'));
  if (Number.isInteger(wanted) && wanted >= 1 && wanted <= LevelRegistry.count()) {
    startLevel(wanted - 1);
  } else {
    showMenu();
  }
});

// 开发期调试入口（生产构建里不存在）
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__parkour = { game, UI, LevelRegistry, startLevel };
}

// UI → 场景
UI.on('play-next', (next?: number) =>
  startLevel(next ?? Math.min(Save.data.unlocked, LevelRegistry.count() - 1)),
);
UI.on('play-level', (index: number) => startLevel(index));
UI.on('play-infinity', () => startInfinity());
UI.on('infinity-next', () => {
  infinity.round++;
  loadInfinityLevel();
});
UI.on('restart', () => {
  if (infinityMode && infinity.level) {
    launchLevel({ level: infinity.level }, infinity.label);
  } else {
    startLevel(currentLevelIndex);
  }
});
UI.on('go-menu', () => {
  infinityMode = false;
  showMenu();
});

UI.init();
