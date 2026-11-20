# KN 声音调度与无设备降级核查

核查日期：2026-11-19。此次改动集中在 `web/audio.js` 的失败完成和恢复路径，新增 `tests/r3-knsound.test.mjs`、`tests/r3_knsound.rs`。没有使用或移植 HateNeko。

## 官方证据

只读获取官方 [main.0f3db563.js](https://creation.bcmcdn.com/neko/web/release/static/js/main.0f3db563.js)，UTF-8 文件长度 12,107,636 字节，SHA256 为 `42841119872219828a193880c7261774643e05e14848be58e6679d78b9add827`。下列偏移是解码后的零起始 UTF-16 字符偏移。原文件仅存于忽略目录 `dist/r3-knsound/official-main.js`，不入库。

| 官方源码位置 | 静态可证实的行为 |
| --- | --- |
| module 89196，`getAudioDomainFunctions`，2154900 | 数字声音选择器按 `Math.round` 转为 1-based 资源顺序，字符串按 ID 或名称解析。 |
| module 89196，`playAudio`，2156895 | 普通播放没有获取线程锁；注册资源级停止回调。 |
| module 89196，`playAudioAndWait`，2157404 | 获取线程锁；匹配资源 ID 的 `PLAY_END`、`PLAY_FAIL`、`PLAY_TIMEOUT` 释放锁。线程停止回调停止资源并释放锁。 |
| module 89196，`stopAudio`，2158048；module 90667，2232873 | `de` 依赖 90667，`si` 导出局部常量 `b="all_audio"`；全停按此 token 区分，其余按资源解析后停止。 |
| module 10366，Web core `addAudio`，12093135；`onplayerror`，12094006 | 每次创建 Howl。加载/播放错误报告 `PLAY_FAIL`；结束、停止均报告 `PLAY_END`，进度分别为 1 和 0。 |
| module 10366，`play`，12094589 | 创建 Howl 后对同 ID 数组逐个 play，支持重叠；有数量保护。NekoC 的每请求一个 voice 不是其所有边缘行为的精确复制。 |
| module 89196，`soundColor`，2158800；module 50865，`convertValue`，2377902 | 音色、速度、音调、音量进入全局 TTS 配置；速度/音调/音量先夹到 `[5,20]` 再减 5；普通导入声音的 play 参数没有这些属性。 |

`set_volume_or_rate_2` / `change_volume_or_rate_2` 的资源音量和速率属于已有 K4 兼容路径。不能把 K4 音量/速率或本地 Web Speech 参数映射宣称为 KN 普通声音的官方音量/音调 API。K4 的资源共享属性、速率同时改变音高的依据见 [audio.md](audio.md)。本次保留这条路径，并复验其现有回归。

## 本次修复

- `Audio` 不存在、构造失败、`play()` 同步抛错或 Promise 拒绝时，报告错误并完成对应等待；失败 voice 暂停，能继续接收其他命令。
- 以每次播放尝试的序号隔离 pause/resume 前后的 Promise。恢复后的声音不会被旧尝试的迟到拒绝提前结束。
- 无进度期限独立于 play Promise 尝试序号：普通键鼠 `unlock()` 重试和运行中重复 `resume()` 都不能续期，也不会覆盖尚未观察的媒体进度。仅新播放、真正暂停后的恢复、从已确认的 `NotAllowedError` 重试时重新起算；权限再次拒绝仍保留等待。此项修复审查 P1 的持续输入永久延期问题。
- 对正在播放的媒体检查 `currentTime`：连续 15 秒没有进度，主动停止并完成等待。通过现有播放器 frame 驱动检查，不增加定时器。暂停时不检查，恢复时重新计时；正常长声音只要有进度就继续播放。
- `NotAllowedError` 保留等待，仍需点击/按键解锁；它是浏览器权限限制，不能当成设备失效。`AbortError` 不立即完成，但无后续进度时也有有限降级。
- 语音对象构造、查询音色和调用 `speechSynthesis.speak` 的同步异常完成等待，包括暂停期间排队、恢复后才遇到错误的语音。
- 本地语音没有媒体时钟，仅对队首检查 60 秒无 `start` / `boundary` / `mark` 进度，超时清理共享语音队列并释放等待。暂停不消耗期限；后续排队项成为队首后才计时。
- 完成通知仍走原有 `audio_done` 和有界重试队列，超时、停止、重复回调不会重复释放同一等待。

**媒体 15 秒、语音 60 秒无进度是 NekoC 的可用性降级策略，不是官方固定等待时长。** 官方 Web 分支的播放失败会释放锁，但没有从上述源码推导出相同的阈值。

## 验证与边界

新增 Node 回归使用模拟时钟，不引入 CI 墙钟性能断言。覆盖无 Audio/构造失败、同步/异步设备失败、永不返回的 play、进度刷新、暂停、自动播放解锁、旧拒绝、完成通知背压和语音设备异常。Rust 回归覆盖 JIT/解释器、普通播放不阻塞、重叠等待独立、停止单资源不释放其他资源、headless 未知媒体有限降级、全局 TTS 配置和重启重置。

在 r2/r3 worktree 中 `node --test` 包装器会自动转发远端，且不会传递本机浏览器 opt-in 环境变量。真实浏览器复验须直接调用本机 Node，而不是误将远端 `SKIP` 当作通过：

```bash
NEKOC_AUDIO_BROWSER=1 \
NEKOC_NODE_MODULES=D:/AppData/Local/Temp/opencode/nekoc-kitenn/node_modules \
"/c/Program Files/nodejs/node.exe" --test tests/audio-browser.test.mjs
```

真实 Edge 检查运行 `tests/audio-browser.test.mjs` 的 opt-in 用例：自有 WAV 非零 PCM、媒体时钟、暂停/恢复、ended、损坏音频恢复、真实自动播放拒绝及点击后重试。编辑器检查使用已有自有夹具 `tests/fixtures/audio.bcmkn`；这不是官方播放器多线程音频实测。

以下仍未验证或不在本次交付中：

1. 物理拔除扬声器、具体硬件驱动行为和跨平台听感；无设备失败用 mock 注入，真实 Edge 检查不等同扬声器听感验证。
2. 官方 KN 多实例注册表清理竞态、超限拒绝、精确线程恢复帧和 native core。已有普通播放线程停止回调的完整对齐也未实现；本次不扩大共享调度结构。
3. 官方在线 TTS 的认证、音色、服务端音调/音量和本地 `speechSynthesis` 的声学等价。后者仍是明确离线降级；不提供 boundary/mark 事件的宿主中，超过 60 秒的长语音可能触发超时。
4. 超过 15 秒没有媒体进度的慢网络可能触发本地降级；检查依赖后续 VM frame，暂停或连接断开时不会自行产生完成通知。
