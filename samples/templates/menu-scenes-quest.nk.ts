// 菜单 → 收集 → 结算：点击方块或松开空格操作；松开 M 返回菜单。
// 可改参数：标题、目标分数；造型可替换为自己的图片 URL。
const TITLE = "星星挑战";
const TARGET_SCORE = 3; // 正整数；每局收集这么多次后进入结算。
// 复用本目录原创、内嵌的 PNG 色块，无需联网下载素材。
const BACKDROP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP48esPAAXcAu/gCooqAAAAAElFTkSuQmCC";
const BUTTON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABACAIAAAAS6ev4AAAAfUlEQVR42u3RAQkAAAgEsS9jMuNbwhiCDC7BLdWjx8UCwAIswAIswAIswIAFWIAFWIAFWIABC7AAC7AAC7AACzBgARZgARZgARZgwAIswAIswAIswIAFWIAFWIAFWIAFGLAAC7AAC7AACzBgARZgARZgARZgwC4AFmAB1kULyvT7WG0dyE0AAAAASUVORK5CYII=";
const STAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PMQ0AAAgDsP34f3HJjwRukiY10EzXaxEQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQuCxmweF4NID8QAAAAABJRU5ErkJggg==";
let score = 0;
let rounds = 0;

screen("menu", { backdrop: BACKDROP }, () => {
  sprite("start", { costume: BUTTON, y: -50 }, (self) => {
    self.onStart(() => {
      self.think(`${TITLE}：点击蓝色按钮或松开空格开始；目标 ${TARGET_SCORE} 颗`);
    });
    self.onClick(() => { switchScreen("play"); });
    onKey("space", "up", () => { switchScreen("play"); });
  });
});

screen("play", { backdrop: BACKDROP }, () => {
  sprite("collectible", { costume: STAR, y: -50 }, (self) => {
    self.onStart(() => {
      score = 0;
      rounds += 1;
      self.think(`点击金色方块或松开空格收集：${score}/${TARGET_SCORE}；松开 M 返回菜单`);
    });
    self.onClick(() => {
      if (score < TARGET_SCORE) score += 1;
      if (score >= TARGET_SCORE) {
        switchScreen("result");
      } else {
        self.think(`星星 ${score}/${TARGET_SCORE}；松开 M 返回菜单`);
      }
    });
    onKey("space", "up", () => {
      if (score < TARGET_SCORE) score += 1;
      if (score >= TARGET_SCORE) {
        switchScreen("result");
      } else {
        self.think(`星星 ${score}/${TARGET_SCORE}；松开 M 返回菜单`);
      }
    });
    onKey("m", "up", () => { switchScreen("menu"); });
  });
});

screen("result", { backdrop: BACKDROP }, () => {
  sprite("again", { costume: BUTTON, y: -50 }, (self) => {
    self.onStart(() => {
      self.think(`第 ${rounds} 局完成！星星 ${score}/${TARGET_SCORE}；点击按钮或松开 R 再玩，松开 M 返回菜单`);
    });
    self.onClick(() => { switchScreen("play"); });
    onKey("r", "up", () => { switchScreen("play"); });
    onKey("m", "up", () => { switchScreen("menu"); });
  });
});
