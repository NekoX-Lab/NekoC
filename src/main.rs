use anyhow::{Context, Result, bail};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use serde_json::json;
use std::path::PathBuf;
use std::process::ExitCode;
use std::str::FromStr;

mod cli_output;

#[derive(Debug, Parser)]
#[command(
    version,
    about = "编译 TypeScript，检查和运行 Kitten N（.bcmkn）及 Kitten 4（.bcm）作品"
)]
struct Cli {
    /// 向标准输出写入 JSON 结果；失败时包含错误原因和下一步提示
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// 导出作品结构概览报告
    Inspect {
        /// 输入作品路径（.bcmkn / .bcm / JSON）
        input: PathBuf,
        /// 输出 JSON 报告路径（父目录须已存在）
        #[arg(long)]
        out: PathBuf,
    },
    /// 读取并重新序列化作品，保留其 JSON 结构
    Roundtrip {
        /// 输入作品路径
        input: PathBuf,
        /// 输出作品路径
        output: PathBuf,
    },
    /// 比较两个作品的 JSON 结构；发现差异时退出码为 1
    Diff {
        /// 左侧作品路径
        left: PathBuf,
        /// 右侧作品路径
        right: PathBuf,
        /// 最多报告的差异数（必须大于 0）
        #[arg(long, default_value_t = 200, value_parser = positive_usize)]
        limit: usize,
    },
    /// 将作品反编译为 TypeScript
    Decompile {
        /// 输入作品路径
        input: PathBuf,
        /// 输出 TypeScript 文件路径
        #[arg(long)]
        out: PathBuf,
    },
    /// 提取作品的工作区报告
    Workspace {
        /// 输入作品路径
        input: PathBuf,
        /// 输出工作区 JSON 路径
        #[arg(long)]
        out: PathBuf,
    },
    /// 将 TypeScript 编译为工作区 JSON，可同时导出 IR 和分析报告
    CompileTs {
        /// 输入 TypeScript / JavaScript 源文件
        input: PathBuf,
        /// 输出工作区 JSON 路径
        #[arg(long)]
        out: PathBuf,
        /// 同时写入中间表示（IR）JSON
        #[arg(long)]
        emit_ir: Option<PathBuf>,
        /// 同时写入静态分析 JSON
        #[arg(long)]
        emit_analysis: Option<PathBuf>,
        /// 启用常量折叠等优化
        #[arg(long)]
        optimize: bool,
    },
    /// 检查类型和目标兼容性，不写入作品；有错误时退出码为 1
    Check {
        /// TS/JS 源文件或 .bcmkn / .bcm / JSON 作品
        input: PathBuf,
        /// 作品体检报告（.bcmkn/.bcm/.json）；可配合 --json
        #[arg(long, conflicts_with_all = ["target", "no_types", "template"])]
        report: bool,
        /// 检查的编译目标
        #[arg(long, default_value = "kitten-n", value_parser = ["kitten-n", "kitten4"])]
        target: String,
        /// 跳过 TypeScript 类型检查，仅检查兼容性
        #[arg(long)]
        no_types: bool,
        /// 源码编译使用的模板（默认使用内置空白 Kitten N 作品）
        #[arg(long)]
        template: Option<PathBuf>,
    },
    /// 将 TS/JS（含 .nk.ts）编译为 .bcmkn；无需提供模板
    Build {
        /// 输入源文件；舞台和角色由 stage()/screen()/sprite() 声明
        input: PathBuf,
        /// 输出路径（默认同目录，game.nk.ts -> game.bcmkn）
        #[arg(short, long)]
        out: Option<PathBuf>,
        /// 模板作品路径（默认使用内置空白 Kitten N 作品）
        #[arg(long)]
        template: Option<PathBuf>,
        /// 启用常量折叠等优化
        #[arg(long)]
        optimize: bool,
        /// 仅检查，不写入作品（等同 nekoc check）
        #[arg(long)]
        check: bool,
    },
    /// 使用指定模板将 TS/JS 编译为 Kitten N 作品
    CompileTsBcmkn {
        /// 输入 TS/JS 源文件
        input: PathBuf,
        /// Kitten N 模板作品路径
        #[arg(long)]
        template: PathBuf,
        /// 输出 .bcmkn 路径
        #[arg(long)]
        out: PathBuf,
        /// 启用常量折叠等优化
        #[arg(long)]
        optimize: bool,
    },
    /// 将 TypeScript 编译为原生 Kitten 4 .bcm 作品
    CompileTsKitten4 {
        /// 输入 TypeScript 源文件
        input: PathBuf,
        /// 可选 Kitten 4 .bcm 模板，复用其资源
        #[arg(long)]
        template: Option<PathBuf>,
        /// 输出 .bcm 路径
        #[arg(long)]
        out: PathBuf,
    },
    /// 编译 Kitten N 作品并验证运行场景
    CompileTsScenario {
        /// 输入 TypeScript 源文件
        input: PathBuf,
        /// Kitten N 模板作品路径
        #[arg(long)]
        template: PathBuf,
        /// 场景 JSON 路径
        #[arg(long)]
        scenario: PathBuf,
        /// 输出 .bcmkn 路径
        #[arg(long)]
        out: PathBuf,
    },
    /// 执行 TypeScript 源码中的单元测试
    Test {
        /// 包含 test() / expect() 的 TypeScript 源文件
        input: PathBuf,
    },
    /// 无界面运行作品并输出运行快照（默认输出 JSON）
    Run {
        /// 输入作品路径
        input: PathBuf,
        /// 按 60 Hz 推进的帧数（默认 1；复现包使用记录帧数；别名 --frames）
        #[arg(long, alias = "frames")]
        ticks: Option<usize>,
        /// 使用旧版 KN JSON 解释器及其快照/追踪格式
        #[arg(long)]
        legacy_runtime: bool,
        /// 默认引擎的随机种子（默认 1）
        #[arg(long, conflicts_with = "legacy_runtime")]
        seed: Option<u64>,
        /// 回放 nekoc-input-v1 输入脚本，或验证 nekoc-repro-v1 复现包
        #[arg(long, conflicts_with = "legacy_runtime")]
        input_script: Option<PathBuf>,
        #[command(flatten)]
        cloud: nekoc::cloud::CloudOptions,
        /// 运行前注入事件，可重复；如 click:10,20、key-down:space、drag:角色,10,20
        #[arg(long = "event")]
        events: Vec<CliRuntimeEvent>,
        /// 将快照写入文件；省略时写入标准输出
        #[arg(long)]
        out: Option<PathBuf>,
        /// 与指定 JSON 快照比较，不匹配时退出码为 1
        #[arg(long)]
        expect: Option<PathBuf>,
    },
    /// 运行作品并验证场景 JSON 中的预期结果
    RunScenario {
        /// 输入作品路径
        input: PathBuf,
        /// 场景 JSON 路径
        scenario: PathBuf,
    },
    /// 报告 Kitten 4 作品中尚不支持的积木（逐行 JSON）
    Coverage {
        /// 一个或多个 Kitten 4 作品路径
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        /// 编译成功后运行的帧数
        #[arg(long, default_value_t = 120)]
        frames: u32,
        /// 固定随机种子（省略时使用时钟）
        #[arg(long)]
        seed: Option<u64>,
    },
    /// 测量各导入阶段耗时（逐行 JSON；建议使用 release 构建）
    BenchImport {
        /// 一个或多个作品路径
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        /// 将所有报告保存为 JSON 数组
        #[arg(long)]
        out: Option<PathBuf>,
        /// 导入后运行的帧数
        #[arg(long, default_value_t = 0)]
        frames: u32,
        /// 记录确定性 VM 快照，跳过昂贵的导入诊断
        #[arg(long)]
        snapshot: bool,
    },
    /// 验证作品结构；发现问题时退出码为 1
    Validate {
        /// 输入作品路径
        input: PathBuf,
        /// 同时将验证报告写入 JSON 文件
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// 将大型文本列表压缩为启动时自动解压的 .bcmkn
    Pack {
        /// 输入 .bcmkn 作品路径
        input: PathBuf,
        /// 输出压缩作品路径
        #[arg(long)]
        out: PathBuf,
        /// 仅压缩 JSON 大小达到该 KiB 阈值的列表
        #[arg(long, default_value_t = 64)]
        min_kb: usize,
        /// 复制可引用的前置列表项数量
        #[arg(long, default_value_t = 8)]
        window: usize,
        /// 最短匹配长度；越大解压越快，但文件可能更大
        #[arg(long, default_value_t = 12)]
        min_match: usize,
    },
    /// 将压缩的 .bcmkn 恢复为原始作品
    Unpack {
        /// 输入压缩作品路径
        input: PathBuf,
        /// 输出解压作品路径
        #[arg(long)]
        out: PathBuf,
    },
    /// 导出无需服务器的独立浏览器播放器目录或 ZIP
    ExportPlayer {
        /// 输入作品路径（.bcmkn / .bcm / JSON）
        input: PathBuf,
        /// 新输出目录或 .zip 文件路径；不覆盖已有路径
        #[arg(long)]
        out: PathBuf,
        /// wasm-bindgen Web 绑定目录（默认 packages/nekoc/dist/web）
        #[arg(long)]
        wasm_dir: Option<PathBuf>,
    },
    /// 分析中间表示（IR）JSON
    AnalyzeIr {
        /// 输入 IR JSON 路径
        input: PathBuf,
        /// 输出分析报告 JSON 路径
        #[arg(long)]
        out: PathBuf,
    },
    /// 监听 TypeScript 文件变化并重新编译；--json 逐行输出编译事件
    Watch {
        /// 监听的 TypeScript 入口文件
        input: PathBuf,
        /// Kitten N 模板作品路径
        #[arg(long)]
        template: PathBuf,
        /// 输出 .bcmkn 路径
        #[arg(long)]
        out: PathBuf,
    },
}

#[derive(Debug, Clone)]
enum CliRuntimeEvent {
    Click {
        x: Option<f64>,
        y: Option<f64>,
    },
    Key {
        key: String,
        state: String,
    },
    Mouse {
        state: Option<String>,
        x: Option<f64>,
        y: Option<f64>,
    },
    Drag {
        actor: String,
        x: f64,
        y: f64,
    },
}

impl FromStr for CliRuntimeEvent {
    type Err = String;

    fn from_str(value: &str) -> std::result::Result<Self, Self::Err> {
        if value == "click" {
            return Ok(Self::Click { x: None, y: None });
        }
        if let Some(coordinates) = value.strip_prefix("click:") {
            let (x, y) = parse_mouse_coordinates(coordinates)?;
            return Ok(Self::Click {
                x: Some(x),
                y: Some(y),
            });
        }
        if let Some(key) = value.strip_prefix("key-down:") {
            return Ok(Self::Key {
                key: key.to_owned(),
                state: "down".to_owned(),
            });
        }
        if let Some(key) = value.strip_prefix("key-up:") {
            return Ok(Self::Key {
                key: key.to_owned(),
                state: "up".to_owned(),
            });
        }
        if let Some((state, coordinates)) = value
            .strip_prefix("mouse-down:")
            .map(|coordinates| (Some("down"), coordinates))
            .or_else(|| {
                value
                    .strip_prefix("mouse-up:")
                    .map(|coordinates| (Some("up"), coordinates))
            })
            .or_else(|| {
                value
                    .strip_prefix("mouse-move:")
                    .map(|coordinates| (None, coordinates))
            })
        {
            let (x, y) = parse_mouse_coordinates(coordinates)?;
            return Ok(Self::Mouse {
                state: state.map(ToOwned::to_owned),
                x: Some(x),
                y: Some(y),
            });
        }
        if let Some(args) = value.strip_prefix("drag:") {
            let parts: Vec<&str> = args.split(',').collect();
            if parts.len() == 3 {
                let x = parts[1]
                    .parse::<f64>()
                    .map_err(|e| format!("invalid drag x: {e}"))?;
                let y = parts[2]
                    .parse::<f64>()
                    .map_err(|e| format!("invalid drag y: {e}"))?;
                return Ok(Self::Drag {
                    actor: parts[0].to_owned(),
                    x,
                    y,
                });
            }
        }
        Err(
            "expected click, click:<x>,<y>, key-down:<key>, key-up:<key>, mouse-down:<x>,<y>, mouse-up:<x>,<y>, mouse-move:<x>,<y>, or drag:<actor>,<x>,<y>"
                .to_owned(),
        )
    }
}

impl From<CliRuntimeEvent> for nekoc::runtime::RuntimeEvent {
    fn from(value: CliRuntimeEvent) -> Self {
        match value {
            CliRuntimeEvent::Click { x, y } => nekoc::runtime::RuntimeEvent::Click { x, y },
            CliRuntimeEvent::Key { key, state } => nekoc::runtime::RuntimeEvent::Key { key, state },
            CliRuntimeEvent::Mouse { state, x, y } => {
                nekoc::runtime::RuntimeEvent::Mouse { state, x, y }
            }
            CliRuntimeEvent::Drag { actor, x, y } => {
                nekoc::runtime::RuntimeEvent::Drag { actor, x, y }
            }
        }
    }
}

/// Prints diagnostics while letting main own process termination.
fn run_check(
    input: &std::path::Path,
    json: bool,
    types: bool,
    template: Option<&std::path::Path>,
    target: &str,
) -> Result<()> {
    let report = nekoc::check::check_file(
        input,
        &nekoc::check::CheckOptions {
            types,
            template,
            target,
        },
    )?;
    if json {
        cli_output::print_json(&report)?;
    } else {
        for diagnostic in &report.diagnostics {
            eprintln!("{diagnostic}");
        }
        if report.ok {
            eprintln!("{}: ok", input.display());
        }
    }
    if !report.ok {
        // Frontend diagnostics already end with their own `help:` line and
        // must match `compile-ts.mjs --check` byte for byte; only add the
        // generic next step when some diagnostic has no guidance of its own.
        if !json && report.diagnostics.iter().any(|d| d.suggestion.is_empty()) {
            eprintln!("下一步：根据诊断中的文件、行和列修正问题，然后重新运行 nekoc check。");
        }
        return Err(cli_output::ReportedFailure.into());
    }
    Ok(())
}

fn parse_mouse_coordinates(value: &str) -> std::result::Result<(f64, f64), String> {
    let (x, y) = value
        .split_once(',')
        .ok_or_else(|| "expected mouse coordinates as <x>,<y>".to_owned())?;
    let x = x
        .parse::<f64>()
        .map_err(|_| format!("invalid mouse x coordinate: {x}"))?;
    let y = y
        .parse::<f64>()
        .map_err(|_| format!("invalid mouse y coordinate: {y}"))?;
    Ok((x, y))
}

fn positive_usize(value: &str) -> std::result::Result<usize, String> {
    value
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "请输入大于 0 的整数".to_owned())
}

fn localized_help(command: clap::Command) -> clap::Command {
    command
        .after_help(cli_output::EXIT_HELP)
        .subcommand_help_heading("子命令")
        .help_template("{about-with-newline}\n用法：{usage}\n\n{all-args}{after-help}\n")
        .mut_subcommands(localized_help)
}

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().collect();
    // Respect `--`: a positional file named --json is not an output switch.
    let json_requested = args
        .iter()
        .skip(1)
        .take_while(|arg| *arg != "--")
        .any(|arg| arg == "--json");
    let matches = match localized_help(Cli::command()).try_get_matches_from(args) {
        Ok(matches) => matches,
        Err(error) => {
            if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                return if error.print().is_ok() {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::FAILURE
                };
            }
            let report = json!({
                "ok": false,
                "error": {"kind": "usage", "message": error.to_string(),
                    "hint": "运行 nekoc --help 或 nekoc <子命令> --help 查看必需参数和示例用法。"}
            });
            let _ = cli_output::print_error(&report, json_requested);
            return ExitCode::from(2);
        }
    };
    // An explicit --cloud-user anonymous is still a cloud override and must
    // not silently accompany a deterministic reproduction package.
    let explicit_cloud = matches.subcommand_matches("run").is_some_and(|args| {
        [
            "cloud_file",
            "cloud_memory",
            "cloud_namespace",
            "cloud_user",
        ]
        .iter()
        .any(|name| args.value_source(name) == Some(clap::parser::ValueSource::CommandLine))
    });
    let command = matches.subcommand_name().unwrap_or("nekoc").to_owned();
    let result = Cli::from_arg_matches(&matches)
        .map_err(anyhow::Error::from)
        .and_then(|cli| execute(cli, explicit_cloud));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let exit_code = if error.is::<clap::Error>() { 2 } else { 1 };
            if !error.is::<cli_output::ReportedFailure>() {
                let report = cli_output::error_report(Some(&command), &error);
                let _ = cli_output::print_error(&report, json_requested);
            }
            ExitCode::from(exit_code)
        }
    }
}

fn execute(cli: Cli, explicit_cloud: bool) -> Result<()> {
    let json = cli.json;

    match cli.command {
        Command::Inspect { input, out } => {
            let project = nekoc::project::load_project(input)?;
            let report = nekoc::inspect::build_report(&project.value, project.byte_len)?;
            std::fs::write(&out, serde_json::to_vec_pretty(&report)?)?;
            if json {
                cli_output::success("inspect", json!({"out": out, "report": report}))?;
            }
        }
        Command::Roundtrip { input, output } => {
            nekoc::project::roundtrip_project(input, &output)?;
            if json {
                cli_output::success("roundtrip", json!({"out": output}))?;
            }
        }
        Command::Diff { left, right, limit } => {
            let left = nekoc::project::load_project(left)?;
            let right = nekoc::project::load_project(right)?;
            let differences = nekoc::diff::diff_values(&left.value, &right.value, limit);
            if json {
                let report = json!({"differences": differences.iter().map(|d| json!({
                    "path": d.path, "kind": match d.kind {
                        nekoc::diff::DifferenceKind::Added => "added",
                        nekoc::diff::DifferenceKind::Removed => "removed",
                        nekoc::diff::DifferenceKind::Changed => "changed",
                    }, "left": d.left, "right": d.right
                })).collect::<Vec<_>>()});
                if differences.is_empty() {
                    return cli_output::success("diff", report);
                }
                return cli_output::failure(
                    "diff",
                    "作品存在结构差异",
                    "检查 differences 中的路径和值，确认是否为预期修改。",
                    report,
                );
            }
            if differences.is_empty() {
                println!("No structural differences");
            } else {
                println!("{}", nekoc::diff::format_differences(&differences));
                bail!("{} structural differences found", differences.len());
            }
        }
        Command::Decompile { input, out } => {
            let project = nekoc::project::load_project(&input)?;
            let ts_code = nekoc::decompile::decompile_to_ts(&project.value)?;
            std::fs::write(&out, &ts_code)?;
            if json {
                cli_output::success("decompile", json!({"out": out}))?;
            } else {
                eprintln!("Decompiled {} -> {}", input.display(), out.display());
            }
        }
        Command::Workspace { input, out } => {
            let project = nekoc::project::load_project(input)?;
            let report = nekoc::workspace::build_report(&project.value)?;
            std::fs::write(&out, serde_json::to_vec_pretty(&report)?)?;
            if json {
                cli_output::success("workspace", json!({"out": out, "report": report}))?;
            }
        }
        Command::CompileTs {
            input,
            out,
            emit_ir,
            emit_analysis,
            optimize,
        } => {
            if optimize {
                let report_path = out.with_extension("workspace.json");
                nekoc::ts_frontend::compile_ts_with_sidecars(
                    &input,
                    &report_path,
                    emit_ir,
                    emit_analysis,
                )?;
                let report = std::fs::read_to_string(&report_path)?;
                let report: serde_json::Value = serde_json::from_str(&report)?;
                let optimized = nekoc::optimizer::optimize_report(&report);
                let bytes = serde_json::to_vec_pretty(&optimized)?;
                std::fs::write(&out, bytes)?;
                if let Some(stats) = optimized.get("optimization").filter(|_| !json) {
                    eprintln!(
                        "Optimized: folded={}, removed={}, simplified={}",
                        stats["constantFolded"], stats["deadRemoved"], stats["simplified"]
                    );
                }
            } else {
                nekoc::ts_frontend::compile_ts_with_sidecars(input, &out, emit_ir, emit_analysis)?;
            }
            if json {
                cli_output::success("compile-ts", json!({"out": out}))?;
            }
        }
        Command::Check {
            input,
            report,
            target,
            no_types,
            template,
        } => {
            if report {
                if !matches!(
                    input.extension().and_then(|extension| extension.to_str()),
                    Some("bcmkn" | "bcm" | "json")
                ) {
                    bail!(
                        "--report requires a .bcmkn, .bcm or .json project; use check without --report for TS/JS sources"
                    );
                }
                let project = nekoc::project::load_project(&input)?;
                let (_, imported) = nekoc::player::import(project.value)?;
                let health = &imported["health_report"];
                if json {
                    println!("{}", serde_json::to_string(health)?);
                } else {
                    print!("{}", health["text"].as_str().unwrap_or_default());
                }
                if health["summary"]["unsupported"].as_u64().unwrap_or(0) > 0 {
                    std::process::exit(1);
                }
            } else {
                run_check(&input, json, !no_types, template.as_deref(), &target)?;
            }
        }
        Command::Build {
            input,
            out,
            template,
            optimize,
            check,
        } => {
            if check {
                run_check(&input, json, true, template.as_deref(), "kitten-n")?;
                return Ok(());
            }
            let out = out.unwrap_or_else(|| {
                input.with_file_name(format!(
                    "{}.bcmkn",
                    nekoc::bcmkn_compiler::project_name(&input)
                ))
            });
            let workspace_file = tempfile::NamedTempFile::new()?;
            nekoc::ts_frontend::compile_ts(&input, workspace_file.path())?;
            let mut report: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(workspace_file.path())?)?;
            if optimize {
                report = nekoc::optimizer::optimize_report(&report);
            }
            let template = match template {
                Some(path) => nekoc::project::load_project(path)?.value,
                None => nekoc::bcmkn_compiler::default_template(),
            };
            let project = nekoc::bcmkn_compiler::assemble_workspace_bcmkn(
                &report,
                &nekoc::bcmkn_compiler::project_name(&input),
                template,
            )?;
            let validation = nekoc::validate::build_report(&project)?;
            if validation["ok"] != true {
                bail!(
                    "compiled project failed validation: {}",
                    validation["issues"]
                );
            }
            std::fs::write(&out, nekoc::json::to_vec(&project)?)?;
            if json {
                cli_output::success("build", json!({"out": out}))?;
            } else {
                eprintln!("Built {} -> {}", input.display(), out.display());
            }
        }
        Command::CompileTsBcmkn {
            input,
            template,
            out,
            optimize,
        } => {
            if optimize {
                let workspace_file = tempfile::NamedTempFile::new()?;
                let workspace_path = workspace_file.path();
                nekoc::ts_frontend::compile_ts(&input, workspace_path)?;
                let report = std::fs::read_to_string(workspace_path)?;
                let report: serde_json::Value = serde_json::from_str(&report)?;
                let optimized = nekoc::optimizer::optimize_report(&report);
                nekoc::bcmkn_compiler::compile_workspace_bcmkn(
                    &optimized, &input, &template, &out,
                )?;
                if let Some(stats) = optimized.get("optimization").filter(|_| !json) {
                    eprintln!(
                        "Optimized: folded={}, removed={}, simplified={}",
                        stats["constantFolded"], stats["deadRemoved"], stats["simplified"]
                    );
                }
            } else {
                nekoc::bcmkn_compiler::compile_ts_bcmkn(input, template, &out)?;
            }
            if json {
                cli_output::success("compile-ts-bcmkn", json!({"out": out}))?;
            }
        }
        Command::CompileTsKitten4 {
            input,
            template,
            out,
        } => {
            nekoc::kitten4_compiler::compile_ts_kitten4(&input, template.as_deref(), &out)?;
            if json {
                cli_output::success("compile-ts-kitten4", json!({"out": out}))?;
            } else {
                eprintln!("Compiled {} -> {}", input.display(), out.display());
            }
        }
        Command::CompileTsScenario {
            input,
            template,
            scenario,
            out,
        } => {
            nekoc::bcmkn_compiler::compile_ts_bcmkn(input, template, &out)?;
            let project = nekoc::project::load_project(&out)?;
            let scenario = nekoc::scenario::load_runtime_scenario(scenario)?;
            let snapshot = nekoc::scenario::run_runtime_scenario(&project.value, &scenario)?;
            let differences = nekoc::scenario::check_runtime_scenario(&snapshot, &scenario);
            if json {
                let report = json!({"out": out, "snapshot": snapshot,
                    "differences": nekoc::scenario::format_scenario_differences(&differences)});
                if differences.is_empty() {
                    return cli_output::success("compile-ts-scenario", report);
                }
                return cli_output::failure(
                    "compile-ts-scenario",
                    "运行场景不匹配",
                    "检查场景预期及 differences，再重新运行。",
                    report,
                );
            }
            nekoc::scenario::ensure_scenario_matches(&differences)?;
            println!("Runtime scenario matches");
        }
        Command::Test { input } => {
            if json {
                let output = nekoc::ts_frontend::test_ts_output(input)?;
                let report = json!({"stdout": String::from_utf8_lossy(&output.stdout),
                    "stderr": String::from_utf8_lossy(&output.stderr)});
                if output.status.success() {
                    return cli_output::success("test", report);
                }
                return cli_output::failure(
                    "test",
                    "TypeScript 单元测试失败",
                    "查看 result.stdout 和 result.stderr，修正失败断言后重试。",
                    report,
                );
            }
            nekoc::ts_frontend::test_ts(input)?;
        }
        Command::Run {
            input,
            ticks,
            legacy_runtime,
            seed,
            input_script,
            cloud,
            events,
            out,
            expect,
        } => {
            if legacy_runtime
                && (cloud.cloud_file.is_some()
                    || cloud.cloud_memory
                    || cloud.cloud_namespace.is_some()
                    || cloud.cloud_user != "anonymous")
            {
                bail!("--legacy-runtime does not support local cloud options");
            }
            let project = nekoc::project::load_project(input)?;
            let events = events
                .into_iter()
                .map(nekoc::runtime::RuntimeEvent::from)
                .collect::<Vec<_>>();
            let report = if legacy_runtime {
                let snapshot = nekoc::runtime::run_project_with_events(
                    &project.value,
                    &events,
                    ticks.unwrap_or(1),
                )?;
                nekoc::runtime::snapshot_to_json(&snapshot)
            } else {
                let script = input_script
                    .as_deref()
                    .map(nekoc::repro::Script::read_file)
                    .transpose()?;
                match script {
                    Some(nekoc::repro::Script::Repro(package)) => {
                        let options = nekoc::repro::ReplayOptions {
                            ticks,
                            seed,
                            has_events: !events.is_empty(),
                            has_cloud: explicit_cloud,
                        };
                        options.validate().map_err(|error| {
                            clap::Error::raw(
                                clap::error::ErrorKind::ArgumentConflict,
                                error.to_string(),
                            )
                        })?;
                        nekoc::repro::replay(&project.value, &package, &options)?
                    }
                    legacy => {
                        let script = match &legacy {
                            Some(nekoc::repro::Script::Legacy(script)) => Some(script),
                            _ => None,
                        };
                        nekoc::cli_run::run_with_input(
                            &project.value,
                            ticks.unwrap_or(1),
                            &events,
                            seed.unwrap_or(1),
                            &cloud,
                            script,
                        )?
                    }
                }
            };
            if let Some(expect) = expect {
                let expected: serde_json::Value = serde_json::from_slice(&std::fs::read(&expect)?)?;
                let differences = nekoc::diff::diff_values(&expected, &report, 200);
                if differences.is_empty() {
                    if !json {
                        println!("Runtime snapshot matches expectation");
                    }
                } else {
                    if json {
                        return cli_output::failure(
                            "run",
                            "运行快照与预期不匹配",
                            "检查 differences；确认源码和输入脚本，或更新预期快照。",
                            json!({"snapshot": report, "differences": nekoc::diff::format_differences(&differences)}),
                        );
                    }
                    println!("{}", nekoc::diff::format_differences(&differences));
                    bail!(
                        "{} runtime expectation differences found",
                        differences.len()
                    );
                }
            }
            if let Some(out) = &out {
                std::fs::write(out, serde_json::to_vec_pretty(&report)?)?;
            }
            if json {
                cli_output::success("run", json!({"out": out, "snapshot": report}))?;
            } else if out.is_none() {
                println!("{}", serde_json::to_string_pretty(&report)?);
            }
        }
        Command::RunScenario { input, scenario } => {
            let project = nekoc::project::load_project(input)?;
            let scenario = nekoc::scenario::load_runtime_scenario(scenario)?;
            let snapshot = nekoc::scenario::run_runtime_scenario(&project.value, &scenario)?;
            let differences = nekoc::scenario::check_runtime_scenario(&snapshot, &scenario);
            if json {
                let report = json!({"snapshot": snapshot,
                    "differences": nekoc::scenario::format_scenario_differences(&differences)});
                if differences.is_empty() {
                    return cli_output::success("run-scenario", report);
                }
                return cli_output::failure(
                    "run-scenario",
                    "运行场景不匹配",
                    "检查场景预期及 differences，再重新运行。",
                    report,
                );
            }
            nekoc::scenario::ensure_scenario_matches(&differences)?;
            println!("Runtime scenario matches");
        }
        Command::Pack {
            input,
            out,
            min_kb,
            window,
            min_match,
        } => {
            let project = nekoc::project::load_project(&input)?.value;
            let options = nekoc::pack::PackOptions {
                min_list_bytes: min_kb
                    .checked_mul(1024)
                    .context("--min-kb 超出可表示的字节数，请减小此参数")?,
                window,
                min_match,
            };
            let (packed, report) = nekoc::pack::pack(&project, &options)?;
            std::fs::write(&out, nekoc::json::to_vec(&packed)?)?;
            if json {
                return cli_output::success("pack", json!({"out": out, "report": report}));
            }
            for list in &report.lists {
                println!(
                    "{}: {} items, {} -> {} bytes ({} tokens)",
                    list.name, list.items, list.original_bytes, list.packed_bytes, list.tokens
                );
            }
            for (name, reason) in &report.skipped {
                println!("skipped {name}: {reason}");
            }
            println!(
                "project: {} -> {} bytes ({:.1}%), {} start scripts wait for the decoder",
                report.original_bytes,
                report.packed_bytes,
                report.packed_bytes as f64 * 100.0 / report.original_bytes.max(1) as f64,
                report.gated_scripts
            );
        }
        Command::Unpack { input, out } => {
            let project = nekoc::project::load_project(&input)?.value;
            std::fs::write(&out, nekoc::json::to_vec(&nekoc::pack::unpack(&project)?)?)?;
            if json {
                cli_output::success("unpack", json!({"out": out}))?;
            }
        }
        Command::ExportPlayer {
            input,
            out,
            wasm_dir,
        } => {
            if json {
                let output =
                    nekoc::player_export::export_output(&input, &out, wasm_dir.as_deref())?;
                let report = json!({
                    "out": out, "stdout": String::from_utf8_lossy(&output.stdout),
                    "stderr": String::from_utf8_lossy(&output.stderr)
                });
                if output.status.success() {
                    return cli_output::success("export-player", report);
                }
                return cli_output::failure(
                    "export-player",
                    "播放器导出失败",
                    "查看 result.stdout 和 result.stderr；确认 Node.js 22+、npm 依赖及 --wasm-dir 中的 Web 绑定已就绪，并使用新的输出路径。",
                    report,
                );
            }
            nekoc::player_export::export(&input, &out, wasm_dir.as_deref())?;
        }
        Command::BenchImport {
            inputs,
            out,
            frames,
            snapshot,
        } => {
            let mut reports = Vec::new();
            let mut failed = false;
            nekoc::import_bench::run_with_report(
                nekoc::import_bench::Args {
                    files: inputs,
                    out,
                    frames,
                    snapshot,
                },
                |report| {
                    failed |= !report["error"].is_null() || !report["export_error"].is_null();
                    if json {
                        reports.push(report.clone());
                    } else {
                        cli_output::print_json(report)?;
                    }
                    Ok(())
                },
            )?;
            if json {
                if failed {
                    return cli_output::failure(
                        "bench-import",
                        "部分作品导入或运行失败",
                        "查看 reports 中的 error / export_error，并先运行 nekoc check <作品>。",
                        json!({"reports": reports}),
                    );
                }
                return cli_output::success("bench-import", json!({"reports": reports}));
            }
            if failed {
                bail!("部分作品导入或运行失败，请检查报告中的 error / export_error");
            }
        }
        Command::Coverage {
            inputs,
            frames,
            seed,
        } => {
            let mut reports = Vec::new();
            for input in inputs {
                let project = nekoc::project::load_project(&input)?;
                let report = nekoc::kitten4::coverage_with_seed(&project.value, frames, seed);
                let entry = json!({"file": input, "report": report});
                if json {
                    reports.push(entry);
                } else {
                    cli_output::print_json(&entry)?;
                }
            }
            if json {
                cli_output::success("coverage", json!({"reports": reports}))?;
            }
        }
        Command::Validate { input, out } => {
            let project = nekoc::project::load_project(input)?;
            let report = nekoc::validate::build_report(&project.value)?;
            if let Some(out) = out {
                let bytes = serde_json::to_vec_pretty(&report)?;
                std::fs::write(out, bytes)?;
            }
            if json {
                cli_output::print_json(&report)?;
                return if report["ok"] == true {
                    Ok(())
                } else {
                    Err(cli_output::ReportedFailure.into())
                };
            }
            if report["ok"].as_bool().unwrap_or(false) {
                println!("No validation issues");
            } else {
                println!("{}", serde_json::to_string_pretty(&report)?);
                bail!("validation issues found");
            }
        }
        Command::AnalyzeIr { input, out } => {
            let bytes = std::fs::read(input)?;
            let ir: serde_json::Value = serde_json::from_slice(&bytes)?;
            let report = nekoc::analysis::build_report(&ir);
            std::fs::write(&out, serde_json::to_vec_pretty(&report)?)?;
            if json {
                cli_output::success("analyze-ir", json!({"out": out, "report": report}))?;
            }
        }
        Command::Watch {
            input,
            template,
            out,
        } => {
            use notify_debouncer_mini::new_debouncer;
            use std::sync::mpsc;
            use std::time::Duration;

            fn do_compile(
                input: &std::path::Path,
                template: &std::path::Path,
                out: &std::path::Path,
                json: bool,
            ) -> Result<()> {
                match nekoc::bcmkn_compiler::compile_ts_bcmkn(input, template, out) {
                    Ok(()) if json => cli_output::print_json(&json!({
                        "ok": true, "command": "watch", "event": "compile", "result": {"out": out}
                    }))?,
                    Ok(()) => eprintln!("[watch] Compiled {}", out.display()),
                    Err(err) => {
                        let mut report = cli_output::error_report(Some("watch"), &err);
                        report["event"] = json!("compile");
                        cli_output::print_error(&report, json)?;
                    }
                }
                Ok(())
            }

            // Fail setup errors instead of silently watching the parent of an absent file.
            std::fs::metadata(&input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            nekoc::project::load_project(&template)?;

            let (tx, rx) = mpsc::channel();
            let mut debouncer = new_debouncer(Duration::from_millis(300), tx)
                .map_err(|e| anyhow::anyhow!("Failed to create file watcher: {e}"))?;

            let watch_path = input
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| std::path::Path::new("."));
            debouncer
                .watcher()
                .watch(watch_path, notify::RecursiveMode::NonRecursive)
                .map_err(|e| anyhow::anyhow!("Failed to watch directory: {e}"))?;
            if !json {
                eprintln!("[watch] Watching {} for changes...", input.display());
            }
            do_compile(&input, &template, &out, json)?;

            for result in rx {
                match result {
                    Ok(events) => {
                        let ts_changed = events.iter().any(|e| {
                            e.path.extension().is_some_and(|ext| ext == "ts")
                                || e.path.extension().is_some_and(|ext| ext == "tsx")
                        });
                        if ts_changed {
                            do_compile(&input, &template, &out, json)?;
                        }
                    }
                    Err(errors) => {
                        bail!("文件监听失败：{errors:?}");
                    }
                }
            }
        }
    }

    Ok(())
}
