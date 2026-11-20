# KN 摄像头：宿主能力缺失时可恢复降级

## 行为与实现

`open_hide_camera`、`open_close_webcam` 的 `camera_status=turn_on` 现在可编译。
默认宿主没有摄像头后端时，产生可恢复的 `PanelNotice::CameraUnavailable`，通过已有
KN panel 异步边界续行，不抛异常、不停止工程，也不表示已经获得图像。
通知按类型去重，宿主可用 `Engine::take_kn_panel_notices()` 读取；重启清空通知。

两个别名共享摄像头状态与 alpha：

- 初始关闭、alpha=0.6；只关闭已关闭摄像头不重置 alpha。
- 开启失败保留当前 alpha，但记住状态已不是 `turn_off`。
- 失败后关闭将 alpha 重置为 0.6；随后再次关闭不再重置。
- 重启恢复初始状态。非法 `camera_status` 仍明确报错。

实现仅涉及 `src/engine/kn_capture.rs` 与 `src/engine/kn_panel.rs`，沿用现有调度边界。
`tests/kn_r3_camera.rs` 覆盖解释/JIT 配置、独立线程、异步续行、别名共享状态、
失败后的关闭、重复调用通知去重、重启和非法字段。未修改公共调度器。

这是默认的无设备降级能力。浏览器真实视频采集/渲染、授权待决请求及成功状态尚未接入；
Web 播放器也使用此降级路径。宿主通知尚未增加 Web UI 展示。

## 官方证据

2026-11-19 对官方匿名编辑器 `https://kn.codemao.cn/editor`（0.27.4）取证。
可提交结构化记录为 [kn-r3-camera-evidence.json](kn-r3-camera-evidence.json)，
原创探针为 `tools/compat/kn-r3-camera-probe.mjs`。没有使用或移植 HateNeko。

官方 bundle：

- `https://creation.bcmcdn.com/neko/web/release/static/js/main.bfc86683.js`
- SHA-256：`e2b26e0bdc9decfa8d53c0e40eb8e6c9e68d91157e96e82197efd19a14eae4d4`
- 原始字节仅保留在被忽略的 `dist/kn-r3-camera/`。

| 源码位置（UTF-8 零基字节偏移） | 结论 |
| --- | --- |
| 1526591，camera singleton `turnOn` | `NotAllowedError` 设置 `no_permission` 并返回；其他设备启动异常被 catch 后设置 `no_support`，正常完成 Promise |
| 1532777，`turnOff` | 当前状态不是 `turn_off` 才执行关闭与默认 alpha 重置；失败状态也满足条件 |
| 1669205，`open_hide_camera` 注册 | await `turnOn`；没有因权限失败停止工程的分支 |
| 1693927，`open_close_webcam` 注册 | 同样 await `turnOn`，两个面板共享 singleton |

分享播放器发布 bundle `main.0f3db563.js` 中 `turnOn`（2047283 起）也有同类
catch/正常返回路径；主证据使用上述当前编辑器的源码和原生运行实测。

### 浏览器实测

两个独立无登录 Edge context，域函数未替换：

1. **真实浏览器权限拒绝**：CDP `Browser.setPermission(camera, denied)`；通过官方
   “同意授权”按钮处理站点内确认。实际 `getUserMedia` 返回 `NotAllowedError`。
2. **受控无设备错误**：仅在浏览器 `getUserMedia` 边界注入 `NotFoundError`；
   官方设备/域函数实现保留。此项验证官方无设备错误处理，**不是物理拔掉摄像头实测**。

每个 profile 各调用两个开启别名，结果均为 Promise fulfilled→undefined，顺序
`returned → after-register → fulfilled`。分别得到 `no_permission` / `no_support`。
被动包装 raw camera 的 alpha setter 并原样转发：开启失败没有 alpha 写入；随后关闭
恰好写入 0.6。

随后将自编的三个启动脚本交给官方原生编辑器运行：两个脚本分别在开启前后写变量，
第三个独立写变量。两种 profile 的五个变量全部为 1，官方 `is_running()` 仍为 true，
`pageErrors=[]`。因此摄像头状态事件中的 `STOP` **不是工程整体停止**。

## 复现

```bash
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules \
  node tools/compat/kn-r3-camera-probe.mjs --record
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules \
  node tools/editor-compat.mjs dist/kn-r3-camera/camera.bcmkn --channel msedge
bash E:/nekoc-wt/_cargo.sh test --test kn_r3_camera --test kn_panel_capture --test kn_panel_services
```

探针生成的 `camera.bcmkn` 是原创测试作品，保留在 dist。工具测试
`tests/kn-r3-camera-source.test.mjs` 离线校验归档；有本地官方 bundle 时额外核验偏移/hash。

## 未验证与边界

- 未验证真实摄像头成功采集、移动端/桌面客户端权限差异、物理无设备场景。
- 官方原生脚本证实能续行；没有声称 VM 一个 tick 等于浏览器 microtask，精确帧间时序未验证。
- 默认无后端对应已失败的能力请求；不提供等待用户授权、取消或视频流生命周期。
- 三个用户作品还包含 AI、语音、对话框等其他能力；本次移除摄像头编译阻塞，
  不据此声称所有交互和外部服务完全兼容。具体语料运行结果见本任务 `OC-REPORT.md`。
