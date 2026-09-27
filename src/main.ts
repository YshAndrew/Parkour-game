import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { LevelRegistry } from './levels/registry';
import { Save } from './core/save-data';
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

function getScene() {
  return game.scene.getScene('game') as unknown as GameScene;
}

function startLevel(index: number) {
  currentLevelIndex = index;
  const scene = getScene();
  UI.hideOverlay();
  UI.hidePause();
  game.scene.resume('game');
  scene.events.once('ready', () => {
    UI.showHUD(LevelRegistry.get(index).name);
    scene.startLevel();
  });
  scene.scene.restart({ levelIndex: index });
}

function showMenu() {
  UI.hideHUD();
  UI.showTitle();
  game.scene.pause('game');
}

// 场景 → UI（GameScene 实例跨 restart 复用同一个 events emitter，只需绑定一次）
game.events.once('scene-ready', () => {
  if (wired) return;
  wired = true;
  const scene = getScene();

  scene.events.on(
    'tick',
    (d: { ms: number; deaths: number; coins: number; totalCoins: number }) => UI.updateHUD(d),
  );
  scene.events.on('died', () => UI.flashDeath());
  scene.events.on(
    'win',
    (d: { levelId: string; levelIndex: number; ms: number; deaths: number; coins: number; totalCoins: number }) => {
      UI.showWin({ ...d, isLast: d.levelIndex + 1 >= LevelRegistry.count() });
    },
  );
  scene.events.on('paused', () => UI.showPause(() => scene.resumeGame()));
  scene.events.on('resumed', () => UI.hidePause());

  showMenu();
});

// UI → 场景
UI.on('play-next', (next?: number) =>
  startLevel(next ?? Math.min(Save.data.unlocked, LevelRegistry.count() - 1)),
);
UI.on('play-level', (index: number) => startLevel(index));
UI.on('restart', () => startLevel(currentLevelIndex));
UI.on('go-menu', () => showMenu());

UI.init();
