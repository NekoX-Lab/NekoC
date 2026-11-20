// 列表背包：松开 1/2 拾取，空格使用第一格，R 清空。
// 修改容量、物品名和初始列表；同名物品各占一格，先进先出。
const CAPACITY = 4;
const ITEM_ONE = "苹果";
const ITEM_TWO = "药水";
// 原创 PNG 占位：青色背包 96×112。
const BACKDROP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP48esPAAXcAu/gCooqAAAAAElFTkSuQmCC";
const BAG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABwCAIAAABuLOL0AAAAoUlEQVR42u3QMQ0AAAgDsInA/4kG5OGAj69JFTQ1zSEKBAkSJEiQIEGCECRIkCBBggQJQpAgQYIECRIkCEGCBAkSJEiQIEEIEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEiQIAQJEiRIkCBBghAkSJAgQYIECUKQIEGCBAkSJEgQggQJEiRIkCBBCBIkSJAgQYIEIUiQIEGCBAkSJAhBgn4s0dS3heGHQTYAAAAASUVORK5CYII=";
// 命名列表直接对应官方列表积木；索引从 1 开始。
appendList("inventory", ITEM_ONE);
let status = "松开 1/2 拾取，空格使用，R 清空";

stage({ name: "列表背包", backdrop: BACKDROP });
sprite("bag", { costume: BAG, y: -60 }, (self) => {
  self.onStart(() => {
    forever(() => {
      let contents = "";
      for (let i = 1; i <= listLength("inventory"); i++) {
        if (i > 1) contents += "、";
        contents += listItem("inventory", "any", i);
      }
      self.think(`${status} | ${listLength("inventory")}/${CAPACITY}：${contents}`);
      wait(0.1);
    });
  });
  // 数字键使用键码字符串：49 = 主键盘 1，50 = 主键盘 2。
  onKey("49", "up", () => {
    if (listLength("inventory") < CAPACITY) {
      appendList("inventory", ITEM_ONE);
      status = `拾取 ${ITEM_ONE}`;
    } else {
      status = "背包已满，请先按空格使用";
    }
  });
  onKey("50", "up", () => {
    if (listLength("inventory") < CAPACITY) {
      appendList("inventory", ITEM_TWO);
      status = `拾取 ${ITEM_TWO}`;
    } else {
      status = "背包已满，请先按空格使用";
    }
  });
  onKey("space", "up", () => {
    if (listLength("inventory") > 0) {
      status = `使用 ${listItem("inventory", "any", 1)}`;
      deleteListItem("inventory", "any", 1);
    } else {
      status = "背包为空，松开 1/2 拾取";
    }
  });
  onKey("r", "up", () => {
    deleteListItem("inventory", "all", 1);
    status = "已清空，松开 1/2 拾取";
  });
});
