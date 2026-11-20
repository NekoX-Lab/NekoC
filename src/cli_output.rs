//! CLI-only output contract; project/compiler/runtime behavior stays in the library.
use anyhow::Result;
use serde_json::{Value, json};
use std::io::{self, Write};

pub const EXIT_HELP: &str = "退出码：0 成功（含帮助/版本）；1 执行失败、检查不通过或结果不匹配；2 命令行参数错误。\n使用 --json 输出机器可读结果；详见 docs/cli.md。";

#[derive(Debug)]
pub struct ReportedFailure;

impl std::fmt::Display for ReportedFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("command failed; report already emitted")
    }
}
impl std::error::Error for ReportedFailure {}

pub fn print_json(value: &impl serde::Serialize) -> Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}

pub fn success(command: &str, result: Value) -> Result<()> {
    print_json(&json!({"ok": true, "command": command, "result": result}))
}

pub fn failure(command: &str, message: &str, hint: &str, result: Value) -> Result<()> {
    print_json(&json!({
        "ok": false, "command": command, "result": result,
        "error": {"kind": "command_failed", "message": message, "hint": hint}
    }))?;
    Err(ReportedFailure.into())
}

pub fn error_report(command: Option<&str>, error: &anyhow::Error) -> Value {
    let message = format!("{error:#}");
    let (kind, hint) = if message.contains("with node") {
        (
            "node_unavailable",
            "安装 Node.js 18 或更新版本，并确认 node --version 可用。",
        )
    } else if message.contains("Cannot find package 'typescript'")
        || message.contains("Cannot find module 'typescript'")
    {
        (
            "frontend_dependency",
            "在 NekoC 安装目录运行 npm ci --ignore-scripts，安装 TypeScript 前端依赖。",
        )
    } else if message.contains("TypeScript frontend") && message.contains("not found") {
        (
            "frontend_unavailable",
            "将 frontend/ 放在 nekoc 可执行文件旁，或把 NEKOC_FRONTEND 设置为前端目录。",
        )
    } else if message.contains("ENOENT") {
        (
            "file_not_found",
            "检查源文件、导入文件和输出目录是否存在；含空格的路径请加引号。",
        )
    } else if message.contains("EACCES") || message.contains("EPERM") {
        (
            "permission_denied",
            "检查文件读写权限，关闭占用文件的程序，或改用可写的输出目录。",
        )
    } else if let Some(io) = error.downcast_ref::<io::Error>() {
        match io.kind() {
            io::ErrorKind::NotFound => (
                "file_not_found",
                "检查输入、模板及辅助文件路径，并确认输出目录已创建；含空格的路径请加引号。",
            ),
            io::ErrorKind::PermissionDenied => (
                "permission_denied",
                "检查文件读写权限，关闭占用文件的程序，或改用可写的输出目录。",
            ),
            _ => ("io_error", "检查文件路径、读写权限及可用磁盘空间后重试。"),
        }
    } else if error.downcast_ref::<serde_json::Error>().is_some()
        || message.contains("invalid JSON")
        || message.contains("JSON object at the root")
    {
        (
            "invalid_json",
            "确认文件是完整的 UTF-8 JSON；作品文件应为 .bcmkn 或 .bcm，而不是网页或压缩包。",
        )
    } else if message.contains("TypeScript frontend") {
        (
            "compile_failed",
            "先运行 nekoc check <源文件> --json，根据诊断中的文件、行和列修正源码。",
        )
    } else if message.contains("does not support local cloud") {
        (
            "unsupported_options",
            "移除 --legacy-runtime 使用默认引擎，或移除所有 --cloud-* 参数。",
        )
    } else if message.contains("project is not packed") {
        (
            "not_packed",
            "unpack 只接受经过 nekoc pack 实际压缩的作品；若没有可压缩列表，请直接使用原作品。",
        )
    } else if message.contains("project is already packed") {
        (
            "already_packed",
            "先运行 nekoc unpack <作品> --out <原始作品>，再对解压作品重新 pack。",
        )
    } else {
        (
            "command_failed",
            "运行 nekoc <子命令> --help 检查用法；作品或源码问题可先运行 nekoc check <文件>。",
        )
    };
    json!({
        "ok": false, "command": command,
        "error": {"kind": kind, "message": message, "hint": hint},
        "diagnostics": [{"severity": "error", "source": "cli", "code": kind, "message": message}]
    })
}

pub fn print_error(report: &Value, json: bool) -> Result<()> {
    if json {
        print_json(report)
    } else {
        let mut stderr = io::stderr().lock();
        writeln!(
            stderr,
            "错误：{}",
            report["error"]["message"].as_str().unwrap_or_default()
        )?;
        writeln!(
            stderr,
            "下一步：{}",
            report["error"]["hint"].as_str().unwrap_or_default()
        )?;
        Ok(())
    }
}
