// 移动与碰撞：方向键移动，R 复位。参数集中在这里。
// 坐标碰撞使用轴对齐方框；每轴先尝试移动，撞墙就撤回该轴。
const SPEED = 4;
const PLAYER_HALF = 16;
const LIMIT_X = 400;
const LIMIT_Y = 230;
const WALL_X = 0;
const WALL_Y = 0;
const WALL_HALF_X = 30;
const WALL_HALF_Y = 110;
const START_X = -180;
const START_Y = 0;
// 原创 PNG：玩家 32×32、墙 60×220；默认中心偏移 0。
const BACKDROP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP48esPAAXcAu/gCooqAAAAAElFTkSuQmCC";
const PLAYER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mNQTX5NU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAMMtzEyPwvGEAAAAAElFTkSuQmCC";
const WALL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAADcAQMAAAAWdlCzAAAAA1BMVEX5cxbtqerhAAAAF0lEQVR42mNgGAWjYBSMglEwCkbBUAIAB7wAATLGE98AAAAASUVORK5CYII=";

stage({ name: "移动与碰撞", backdrop: BACKDROP });
let playerX = START_X;
let playerY = START_Y;
let blocked = false;

sprite("wall", { costume: WALL }, (self) => {
  self.onStart(() => {
    self.moveTo(WALL_X, WALL_Y);
    self.think("方向键移动 · R 复位 · 绕过橙色墙");
  });
});

sprite("player", { costume: PLAYER }, (self) => {
  self.onStart(() => {
    playerX = START_X;
    playerY = START_Y;
    forever(() => {
      let dx = 0;
      let dy = 0;
      if (keyPressed("left")) dx -= SPEED;
      if (keyPressed("right")) dx += SPEED;
      if (keyPressed("down")) dy -= SPEED;
      if (keyPressed("up")) dy += SPEED;
      blocked = false;
      playerX += dx;
      if (Math.abs(playerX) + PLAYER_HALF > LIMIT_X ||
          (Math.abs(playerX - WALL_X) < PLAYER_HALF + WALL_HALF_X &&
           Math.abs(playerY - WALL_Y) < PLAYER_HALF + WALL_HALF_Y)) {
        playerX -= dx;
        blocked = true;
      }
      playerY += dy;
      if (Math.abs(playerY) + PLAYER_HALF > LIMIT_Y ||
          (Math.abs(playerX - WALL_X) < PLAYER_HALF + WALL_HALF_X &&
           Math.abs(playerY - WALL_Y) < PLAYER_HALF + WALL_HALF_Y)) {
        playerY -= dy;
        blocked = true;
      }
      if (keyPressed("r")) {
        playerX = START_X;
        playerY = START_Y;
        blocked = false;
      }
      self.moveTo(playerX, playerY);
      wait(0.02);
    });
  });
});
