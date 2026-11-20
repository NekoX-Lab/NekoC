# 导入、装配与 VM 的确定性模糊回归

`tests/fuzz_r3.rs` 使用原创合成数据，不依赖第三方作品，也不依赖随机系统种子。
CI 默认运行 128 组 KN/K4 JSON 结构变异及字节变异、256 组 workspace 图变异、
256 组 VM 表达式变异，以及最小问题样例。增大本地样本数：

```bash
cargo build --test fuzz_r3
NEKOC_FUZZ_CASES=4096 target/debug/deps/fuzz_r3-<hash> --test-threads=1 --nocapture
```

Windows 测试二进制带 `.exe` 后缀。在任务 worktree 中，所有 cargo 命令仍应经
`bash E:/nekoc-wt/_cargo.sh` 执行。模糊测试本地直接运行已构建的测试二进制，
单线程，不启动大批量子进程。变异测试接受可读错误，不接受 panic；VM 使用虚拟时钟、
固定指令预算，没有 CI 墙钟耗时断言。文本增长回归还会预热并确认 native JIT 实际执行。

## 防护边界

- KN 导入及模板装配在修改数据之前校验容器类型，错误带 JSON 路径。
  未识别的扩展字段保持不透明，不改写未知积木类型。
- workspace 图装配前检查循环（包括无根的分离循环）、多父节点、缺失引用、
  重复插槽及连接类型。展开改为迭代式，复用 JSON 模块的 10000 层嵌套及
  20000 边路径上限，避免递归栈溢出和共享图的指数展开。
- VM 初始数组/对象值深度最多 128。项目元数据不受此 Cell 数据深度上限影响。
- KN 文本拼接及 K4 加法/变量增长的结果最多 16 MiB（UTF-8 字节）。
  在展开延迟文本树之前检查长度，超限通过现有 VM 错误通道返回，
  不再等到整数长度溢出或连续内存分配时崩溃。
  列表操作数逐叶受限转换，包含逗号，避免先分配完整强制转换字符串再检查；
  双参数首操作数和 Undefined 截断保留的前缀同样受限。
- 指令统一错误边界覆盖所有等待、广播及 cold-op 提前返回；报告表达式错误
  必须在 `advance()` 中返回带积木位置的错误，不会被等待/yield 吞掉。
- workspace 的 connections 字典按引用读取，不递归复制或析构未知边扩展元数据。
  回归在默认测试线程栈下覆盖 30000 层扩展数组。

这些是 NekoC 的安全策略，**不是官方播放器的行为或资源上限**；官方在极端输入上的
行为未验证。有限的种子回归不等于覆盖引导 fuzz，也不是进程级内存隔离：
未覆盖所有积木、宿主扩展、运行时列表/对象共享图或长期执行时的总体内存增长。
公开低层 `Text::concat`/`Cell::concat` API 保持原契约；本轮为作品执行路径增加可返回错误的防护。

可设置 `NEKOC_FUZZ_ARTIFACT=dist/r3-fuzz/valid.bcmkn`，运行
`valid_workspace_preserves_fields_edges_and_editor_shape` 测试输出合法装配样例，
随后使用 `tools/editor-compat.mjs` 做官方编辑器兼容检查。
