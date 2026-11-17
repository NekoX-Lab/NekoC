# Kitten N 绕角色旋转和碰撞事件目标

`self_rotate_around.sprite` 和 `on_bump_actor.sprite` 的官方菜单都只保存
当前场景 `actorIds` 中的角色 ID。它们的菜单没有 self、鼠标、随机、边缘或
背景目标。不能从 `coordinate_of_sprite`、tell 等其他积木推导这两个菜单。

TS 的全局 `rotateAround`、`self.rotateAround` 和四参数 `onBumpActor`
支持同场景唯一角色名和真实 ID；组装器在所有场景、模板及资源角色分配完成后
解析名字。真实 ID 优先于同名角色，包括跨场景 ID（报错，不重新解释为名字）。
不同场景同名角色按所属场景分别解析；同场景歧义、未知目标和跨场景目标报错。
注册 sprite/screen 会按原有资源规则清空模板角色，解析依据清空后的最终角色表。

`rotateAround("--self", degrees)` 在组装时降为 `self_rotate`：绕当前实例自身
不改变坐标，只增加朝向，角度表达式仍只求值一次。消息、过程和克隆都保留
当前实例身份。`onBumpActor` 的 self 仍解析为明确角色 ID，监听原型接触；
不能从绕转 lowering 推导碰撞事件语义。根脚本按既有模板
注入规则确定实际 owner，只有场景 owner 时不会猜一个角色。过程调用图按
调用者传播角色和场景上下文（含递归、嵌套过程及 tell 回调）；所有调用者必须
解析到同一个 ID；self 绕转降为转向后无需静态 ID，支持多角色共享。
未调用过程不能推断 self 的执行者。

全局过程工作区的官方菜单独立于运行时调用者，使用编辑器当前选择的场景。
过程中的这两个角色目标还必须在所有场景菜单可选，才能在初始场景和后续切换后
都保留有效下拉框。不能满足时 check/build 在动作源位置一致拒绝，导入作品
check 也报告问题。将动作移到所属角色事件回调或普通可内联函数即可保留支持；
不通过更换初始场景掩盖问题。

`check` 和 build 使用相同的最终组装解析，错误代码为
`invalid_actor_menu_target`，TS 调用处带文件、行、列和改法提示。检查已有
`.bcmkn` 时字段必须已经是可选 ID，不会把错误下拉框当成合法引用。

## 官方证据与复现

菜单依据官方编辑器 0.27.4：

- `main.8ccf2442.js` SHA-256：
  `58123fcf43cf793d19372fc822750f9899a4375404de61c541f06e915c2b8165`。
- 两条积木的 `menu_generator_advanced` 均调用同一无参角色菜单生成器。
  该生成器枚举当前场景角色；其可选参数追加背景的分支未启用。
- 在上述 main bundle 中的字符定位及片段哈希（不复制源码）：绕转定义
  offset 1141408 / length 600 / SHA-256
  `32488a3318fa190f5c2b91a3b42ef72fb9b5e0eac51ed2215c1960f8c2e89850`；
  碰撞定义 offset 805813 / length 600 /
  `9287d8a574ac3d8eae88d0d52ea1178eacf1f45f4331a684275edf4b52cf6a63`；
  菜单生成器 offset 1455784 / length 1850 /
  `640440f6e7e06048c572789e22e1ae740725940984a635f40803fdfba8952ec1`。
- 运行时 bundle `crc_libs.8196dbd1.js` SHA-256：
  `462bb78dc75f99002dfe628d15211941469aa01d71e12890327eedcdb142f8a7`。

本仓库只保留原创夹具和工具，不包含官方源码。准备好本地上述 bundle 与
`main-vendors.07f7dd7e.js` 放入被忽略的 `dist/knactortarget/` 后运行：

```bash
node tools/knactortarget-probe.mjs --binary target/debug/nekoc.exe
```

工具生成 self、名称、真实 ID、过程、克隆消息/过程、多场景内联控制及原示例，逐份执行源码 check、作品
check 和 `tools/editor-compat.mjs`。受控动作夹具安排 target、source、decoy
三个角色，直接观测官方运行时角色位置和碰撞参数；验证绕转圆心、一次目标碰撞
及零次 decoy 碰撞，同时对比 self 与自身真实 ID。克隆夹具中原型 `(100,100)`、
克隆 `(200,100)`，消息与过程都要求克隆位置不变、朝向增加 90°、原型不变、
角度函数只调用一次。多场景验证目标场景先/后声明均拒绝静态过程目标，并验证
内联函数和 self 转向过程的编辑器正例。报告和作品均写入忽略目录。
官方观测是正常播放器运行加被动位置采样，不是计时或吞吐量基准。

修订轮 16 份作品（包括切换当前场景后的副本）均 `ok:true`，6 组受控运行
无 page/runtime 错误。四份动作夹具的
作品摘要和观测如下（完整报告在 `dist/knactortarget/editor.json`、
`dist/knactortarget/official.json`）：

| 夹具 | 作品 SHA-256 | 绕转后位置 | hits / hitX / decoyHits |
| --- | --- | --- | --- |
| target-name | `d734a19eef5a30f0b181597d01c01794142c46a495d3ae35eb1346536ee05df4` | `(0,≈0)` | `1 / 100 / 0` |
| target-id | `cfe9a1e041a4a1707f5ba610b596acb3712c86a2d14531ed275943d7778e2234` | `(0,≈0)` | `1 / 100 / 0` |
| target-self-semantic | `96477920d9b401082e8df51f8af13aa0d664ddc5d74f07f92d75ea1af7685ed3` | `(100,100)` | `0 / 0 / 0` |
| target-own-id | `8b0bb300e94d900a9b86622602ea659fde9754db66d635246f6da43cfd95223e` | `(100,100)` | `0 / 0 / 0` |

克隆消息夹具 SHA-256：`4f3a3b3e2fbc3130566b15f81b7ea71763c4a78cd481cb759d41dc27f4b50d83`；
过程夹具：`1a2c01ff52b20d53c7a8a67ac11004affbf8e8674b303e4605a43dab197fbb87`。
两者原型保持 `(100,100)`、rotation=0，克隆保持 `(200,100)`、rotation=π/2
（官方内部单位为弧度），`angleCalls=1`、done=1。

`tests/knactortarget.rs` 验证最终分配、模板、名称/ID 冲突、不同场景、共享/
递归过程、源定位及本地 Engine 解释/JIT 两种模式；
`tests/knactortarget.test.mjs` 检查生成路径使用分享播放器支持的积木。

## 已知运行差异

受控夹具中 source `(100,100)` 绕 target `(100,0)` 正转 90°：官方到达
`(0,0)`，本地 Engine 到达 `(200,0)`。两者选择相同圆心，角度方向不同；
此处保留 Engine 现有旋转行为，目标解析修复不宣称解决角度方向兼容。
修订轮已验证克隆 self 绕转的消息和过程路径；显式原型 ID 仍表示原型。
碰撞事件的克隆接触语义不在 self 绕转认证范围内。
