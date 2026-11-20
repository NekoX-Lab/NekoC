// 菜单与场景切换：松开空格 / 点击按钮开始；游戏里松开 M 返回。
// 修改标题、目标分数和下方两个 screen 的角色即可扩展游戏。
const TITLE = "收集星星";
const TARGET_SCORE = 5;
// 原创 PNG 占位：蓝色按钮 160×64、金色收集物 64×64。
const BACKDROP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP48esPAAXcAu/gCooqAAAAAElFTkSuQmCC";
const BUTTON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABACAIAAAAS6ev4AAAAfUlEQVR42u3RAQkAAAgEsS9jMuNbwhiCDC7BLdWjx8UCwAIswAIswAIswIAFWIAFWIAFWIABC7AAC7AAC7AACzBgARZgARZgARZgwAIswAIswAIswIAFWIAFWIAFWIAFGLAAC7AAC7AACzBgARZgARZgARZgwC4AFmAB1kULyvT7WG0dyE0AAAAASUVORK5CYII=";
const STAR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PMQ0AAAgDsP34f3HJjwRukiY10EzXaxEQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQuCxmweF4NID8QAAAAABJRU5ErkJggg==";
let score = 0;
let visits = 0;

screen("menu", { backdrop: BACKDROP }, () => {
  sprite("start-button", { costume: BUTTON }, (self) => {
    self.onStart(() => {
      self.think(`${TITLE}：点击蓝色按钮或松开空格开始`);
    });
    self.onClick(() => { switchScreen("game"); });
    onKey("space", "up", () => { switchScreen("game"); });
  });
});

screen("game", { backdrop: BACKDROP }, () => {
  sprite("star", { costume: STAR }, (self) => {
    self.onStart(() => {
      score = 0;
      visits += 1;
      self.think(`点击星星或松开空格收集，目标 ${TARGET_SCORE}；松开 M 返回菜单`);
    });
    self.onClick(() => {
      if (score < TARGET_SCORE) score += 1;
      self.think(`星星 ${score}/${TARGET_SCORE}；松开 M 返回菜单`);
    });
    onKey("space", "up", () => {
      if (score < TARGET_SCORE) score += 1;
      self.think(`星星 ${score}/${TARGET_SCORE}；松开 M 返回菜单`);
    });
    onKey("m", "up", () => { switchScreen("menu"); });
  });
});
