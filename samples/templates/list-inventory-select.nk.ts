// 可选格列表背包：松开 1/2 拾取，左右选格，空格使用，D 丢弃，R 清空。
// 可改参数：容量、两种物品名、初始 appendList；同名物品各占一格。
const CAPACITY = 5; // 正整数，且不小于初始物品数。
const ITEM_ONE = "苹果";
const ITEM_TWO = "药水";
// 复用本目录原创、内嵌的 PNG 色块，无需联网下载素材。
const BACKDROP = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP48esPAAXcAu/gCooqAAAAAElFTkSuQmCC";
const BAG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABwCAIAAABuLOL0AAAAoUlEQVR42u3QMQ0AAAgDsInA/4kG5OGAj69JFTQ1zSEKBAkSJEiQIEGCECRIkCBBggQJQpAgQYIECRIkCEGCBAkSJEiQIEEIEiRIkCBBggQhSJAgQYIECRKEIEGCBAkSJEiQIAQJEiRIkCBBghAkSJAgQYIECUKQIEGCBAkSJEgQggQJEiRIkCBBCBIkSJAgQYIEIUiQIEGCBAkSJAhBgn4s0dS3heGHQTYAAAAASUVORK5CYII=";
// 官方命名列表 API 的下标从 1 开始；空包时 selected 保持为 1。
appendList("inventory", ITEM_ONE);
let selected = 1;
let used = 0;
let status = "松开 1/2 拾取，左右选格，空格使用，D 丢弃，R 清空";

stage({ name: "选格背包", backdrop: BACKDROP });
sprite("bag", { costume: BAG, y: -80 }, (self) => {
  self.onStart(() => {
    forever(() => {
      let contents = "";
      for (let i = 1; i <= listLength("inventory"); i++) {
        if (i > 1) contents += "、";
        if (i === selected) contents += "[";
        contents += listItem("inventory", "any", i);
        if (i === selected) contents += "]";
      }
      self.think(`${status} | ${listLength("inventory")}/${CAPACITY}：${contents} | 已使用 ${used}`);
      wait(0.1);
    });
  });
  // 主键盘数字键使用键码字符串：49 = 1，50 = 2。
  onKey("49", "up", () => {
    if (listLength("inventory") < CAPACITY) {
      appendList("inventory", ITEM_ONE);
      status = `拾取 ${ITEM_ONE}`;
    } else {
      status = "背包已满，请使用或丢弃物品";
    }
  });
  onKey("50", "up", () => {
    if (listLength("inventory") < CAPACITY) {
      appendList("inventory", ITEM_TWO);
      status = `拾取 ${ITEM_TWO}`;
    } else {
      status = "背包已满，请使用或丢弃物品";
    }
  });
  onKey("left", "up", () => {
    if (listLength("inventory") > 0) {
      selected -= 1;
      if (selected < 1) selected = listLength("inventory");
    }
  });
  onKey("right", "up", () => {
    if (listLength("inventory") > 0) {
      selected += 1;
      if (selected > listLength("inventory")) selected = 1;
    }
  });
  onKey("space", "up", () => {
    if (listLength("inventory") > 0) {
      status = `使用 ${listItem("inventory", "any", selected)}`;
      deleteListItem("inventory", "any", selected);
      used += 1;
      if (selected > listLength("inventory")) selected = listLength("inventory");
      if (selected < 1) selected = 1;
    } else {
      status = "背包为空，松开 1/2 拾取";
    }
  });
  onKey("d", "up", () => {
    if (listLength("inventory") > 0) {
      status = `丢弃 ${listItem("inventory", "any", selected)}`;
      deleteListItem("inventory", "any", selected);
      if (selected > listLength("inventory")) selected = listLength("inventory");
      if (selected < 1) selected = 1;
    } else {
      status = "背包为空，松开 1/2 拾取";
    }
  });
  onKey("r", "up", () => {
    deleteListItem("inventory", "all", 1);
    selected = 1;
    status = "已清空，松开 1/2 拾取";
  });
});
