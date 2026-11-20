# 手机 / 平板 Web 播放器

独立播放器 `/play` 支持触摸画面、虚拟按键、横竖屏和全屏。Web Studio
中的舞台仍共用 `StageInput` 的触摸映射；虚拟按键面板只在独立播放器提供。

## 使用

- 触摸舞台对应鼠标按下、移动、松开 / 点击；坐标按显示尺寸映射回作品的
  舞台中心原点（x 向右、y 向上）。可拖拽角色保留已有的 KN / K4 拖动规则。
- 点「显示虚拟按键」可打开方向键及空格、回车、Z、X；默认隐藏，不自动
  遮住舞台。支持方向 + 操作键同时按，也可同时触摸舞台。
- 按键最小触控尺寸 44 CSS px，可用 Tab 聚焦后以空格 / 回车操作。
  虚拟与实体键盘分别持有同一个键，最后一个来源松开才释放。
- 松手（含移出按钮）、取消、失去捕获、失焦、隐藏面板、暂停、重玩、切到
  后台、旋转和全屏切换会清理相应按住状态，避免卡键。旋转后需重新按住。
- 按钮焦点移到舞台时只清理该按钮的键盘激活；捕获中的触摸仍保持到松手或取消。
  窗口失焦、隐藏面板等生命周期清理仍会释放全部来源。
- 手机上舞台按作品宽高比适配；短横屏打开按键后让出右侧控制区，隐藏品牌
  面板。竖屏全屏打开按键时也隐藏品牌面板，给舞台保留空间；操作与退出入口
  始终保留，不强制锁定屏幕方向。
- 宽横屏打开虚拟键后同样使用舞台／控制两列布局，不以 1200px 为上界，避免
  竖屏作品被右列内容撑出浏览器视口。
- 浏览器不支持或拒绝 Fullscreen API 时，降级为窗口内全屏，仍保留浏览器
  自己的地址栏等界面；再次点退出或按 Esc 恢复普通布局。

`?app` 导出执行包和 Android 原生壳仍保持原有的纯舞台 / 原生 UI，不额外
显示 Web 虚拟按键面板。没有添加新外部资源或新的模块路由。

## 验证与一致性边界

基础鼠标 / 键码映射的已有官方源码证据和原创作品实测见
[input.md](input.md)、[input-kn.md](input-kn.md)。其中 KN 模块 26921
的移动分支把 touchstart / touchend 接到鼠标语义回调，模块 61248 按舞台
坐标转换；K4 `a1xw` 输入路径及原包 hash 也已记录。

本次新增的虚拟按键布局、多来源合并、取消 / 失焦清理及窗口内全屏是 NekoC
的可用性策略，**没有与官方手机播放器逐项比对，官方一致性未验证**。
尤其 KN 官方移动端松开后可将鼠标坐标清成 NaN；本播放器仍沿用已有的最后
位置策略，不把本次功能称为精确官方移动输入仿真。没有移植 HateNeko 代码。

### 回归

```bash
# 无浏览器：多来源键状态、队列背压、取消/隐藏/捕获等
node --test tests/r3-mobile.test.mjs tests/stage-input.test.mjs tests/playerinputqueue.test.mjs

# 真播放器：先使用任务约定的 cargo wrapper 构建 web
bash E:/nekoc-wt/_cargo.sh build --bin web
NEKOC_R3_MOBILE_E2E=1 node --test tests/r3-mobile-browser.test.mjs
```

浏览器测试按需设置 `NEKOC_NODE_MODULES`（含 Playwright）、
`NEKOC_WEB_BIN` 和 `NEKOC_BROWSER_CHANNEL`；Windows 缺省 Edge，Linux 缺省
Playwright Chromium。默认工具测试跳过需要浏览器的 E2E。

如果构建环境只能生成远端 Linux 二进制，但本机已有本任务先前构建的 Windows
`web.exe`（须包含当前 `play.html`），可设
`NEKOC_R3_MOBILE_SOURCE_ASSETS=1`：仍使用真实本机 Rust 后端、HTML 导航和
WebSocket，只把 JS/CSS 请求返回为当前 `web/` 的生产源码，
不替换 `play.js` 初始化逻辑。本次未修改 Rust 后端或模块路由；该模式要求
现有二进制已包含本任务的 `play.html` 控件结构（早期已在本机构建过）。
需要保存截图时设置 `NEKOC_R3_MOBILE_SCREENSHOTS=dist/r3-mobile/screenshots`。

E2E 启动真实 Rust HTTP / WebSocket 后端，加载仓库原创 `input.bcm`，使用
生产 `play.js`、渲染器和输入队列，不替换初始化代码。检查手机
390×844 / 844×390 / 320×568、平板 768×1024 / 1024×768，触摸中心坐标、
多指、移出松手、取消、隐藏 / 暂停 / 重玩 / 后台 / 旋转 / 捕获释放、原生
及降级全屏，以及内存中调整为 620×900 的竖屏作品。CDP 提供真实浏览器触摸
事件；生命周期部分用 DOM 事件确定性触发，不等于 OS 真机验证。
iOS Safari、Android 真机和屏幕阅读器实机
**未验证**。不使用墙钟耗时断言。
