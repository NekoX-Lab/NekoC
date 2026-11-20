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
    let (kind, hint) = if error.is::<clap::Error>() {
        (
            "usage",
            "运行 nekoc run --help 查看用法；复现包使用记录中的帧数、种子、事件和云配置，请移除 --ticks/--frames、--seed、--event 及所有 --cloud-* 参数。",
        )
    } else if error.is::<nekoc::player_export::PackagerLaunchError>() {
        (
            "node_unavailable",
            "安装 Node.js 22 或更新版本，确认 node --version 可用，并在源码目录运行 npm ci --ignore-scripts。",
        )
    } else if error
        .downcast_ref::<nekoc::ts_frontend::NodeLaunchError>()
        .is_some()
    {
        (
            "node_unavailable",
            "安装 Node.js 18 或更新版本，并确认 node --version 可用。",
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
    } else if let Some(frontend) = error.downcast_ref::<nekoc::ts_frontend::FrontendError>() {
        frontend_hint(frontend)
    } else if error.downcast_ref::<serde_json::Error>().is_some()
        || message.contains("invalid JSON")
        || message.contains("JSON object at the root")
    {
        (
            "invalid_json",
            "确认文件是完整的 UTF-8 JSON；作品文件应为 .bcmkn 或 .bcm，而不是网页或压缩包。",
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
    } else if command == Some("export-player") {
        (
            "command_failed",
            "使用尚不存在的 --out 目录或 ZIP 路径；确认作品可运行、Node.js 22+ 和 npm 依赖已安装，--wasm-dir 指向已构建的 Web 绑定目录。",
        )
    } else if command == Some("run") {
        (
            "command_failed",
            "检查作品及 --input-script；复现包必须匹配作品指纹、NekoC 版本、协议和状态摘要，必要时用同版本重新录制；旧输入脚本使用 nekoc-input-v1。",
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

fn frontend_hint(error: &nekoc::ts_frontend::FrontendError) -> (&'static str, &'static str) {
    use nekoc::ts_frontend::FrontendError;
    let stderr = match error {
        FrontendError::NotFound { .. } => {
            return (
                "frontend_unavailable",
                "将 frontend/ 放在 nekoc 可执行文件旁，或把 NEKOC_FRONTEND 设置为前端目录。",
            );
        }
        FrontendError::Failed { stderr, .. } => stderr,
    };
    // Only actual frontend stderr error headers, never formatted path contexts.
    if stderr.lines().any(|line| {
        line.starts_with("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typescript'")
            || line.starts_with("Error: Cannot find module 'typescript'")
    }) {
        (
            "frontend_dependency",
            "在 NekoC 安装目录运行 npm ci --ignore-scripts，安装 TypeScript 前端依赖。",
        )
    } else if stderr
        .lines()
        .any(|line| line.starts_with("Error: ENOENT:"))
    {
        (
            "file_not_found",
            "检查源文件、导入文件和输出目录是否存在；含空格的路径请加引号。",
        )
    } else if stderr
        .lines()
        .any(|line| line.starts_with("Error: EACCES:") || line.starts_with("Error: EPERM:"))
    {
        (
            "permission_denied",
            "检查文件读写权限，关闭占用文件的程序，或改用可写的输出目录。",
        )
    } else {
        (
            "compile_failed",
            "先运行 nekoc check <源文件> --json，根据诊断中的文件、行和列修正源码。",
        )
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context;
    use nekoc::ts_frontend::FrontendError;

    #[test]
    fn io_source_wins_over_path_text() {
        for (source, expected) in [
            (io::ErrorKind::NotFound, "file_not_found"),
            (io::ErrorKind::PermissionDenied, "permission_denied"),
            (io::ErrorKind::Other, "io_error"),
        ] {
            let error = anyhow::Error::new(io::Error::from(source)).context(
                "failed to read with node ENOENT EACCES EPERM Cannot find package 'typescript' invalid JSON",
            );
            assert_eq!(
                error_report(Some("validate"), &error)["error"]["kind"],
                expected
            );
        }
    }

    #[test]
    fn frontend_headers_are_classified_only_in_typed_stderr() {
        for (stderr, expected) in [
            (
                "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typescript' imported from /frontend",
                "frontend_dependency",
            ),
            (
                "Error: Cannot find module 'typescript'\nRequire stack:",
                "frontend_dependency",
            ),
            (
                "Error: ENOENT: no such file or directory, open 'EACCES.ts'",
                "file_not_found",
            ),
            (
                "Error: EACCES: permission denied, open 'ENOENT.ts'",
                "permission_denied",
            ),
            (
                "Error: EPERM: operation not permitted, open 'with node.ts'",
                "permission_denied",
            ),
            (
                "with node ENOENT EACCES EPERM.ts:1:1: error NEKOC: unsupported",
                "compile_failed",
            ),
        ] {
            // Check mode has a JSON parse source when Node could not start the script.
            let error = serde_json::from_str::<Value>("")
                .context(FrontendError::Failed {
                    action: " check",
                    stderr: stderr.to_owned(),
                })
                .unwrap_err();
            assert_eq!(
                error_report(Some("check"), &error)["error"]["kind"],
                expected
            );
        }
        let error = anyhow::anyhow!("failed to read with node Error: EACCES: and ENOENT");
        assert_eq!(
            error_report(Some("validate"), &error)["error"]["kind"],
            "command_failed"
        );
    }

    #[test]
    fn player_packager_launch_and_replay_conflict_use_typed_sources() {
        let error = anyhow::Error::new(io::Error::from(io::ErrorKind::NotFound))
            .context(nekoc::player_export::PackagerLaunchError)
            .context("with node ENOENT EACCES EPERM");
        let report = error_report(Some("export-player"), &error);
        assert_eq!(report["error"]["kind"], "node_unavailable");
        assert!(
            report["error"]["hint"]
                .as_str()
                .unwrap()
                .contains("Node.js 22")
        );
        let error = anyhow::Error::new(clap::Error::raw(
            clap::error::ErrorKind::ArgumentConflict,
            "repro package conflicts with --seed",
        ));
        assert_eq!(error_report(Some("run"), &error)["error"]["kind"], "usage");
    }
}
