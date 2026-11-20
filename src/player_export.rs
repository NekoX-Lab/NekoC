//! Browser export preparation. The Node packager bundles the existing web player,
//! WASM and media; the native importer remains the source of project validation.
use anyhow::{Context, Result, bail, ensure};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

pub fn export(input: &Path, output: &Path, wasm_dir: Option<&Path>) -> Result<()> {
    let (mut command, _normalized) = export_command(input, output, wasm_dir)?;
    let status = command.status().context(PackagerLaunchError)?;
    if !status.success() {
        bail!("player export failed ({status}); see packager diagnostic above");
    }
    Ok(())
}

/// Capture packager logs for the CLI JSON envelope without changing text mode.
pub fn export_output(input: &Path, output: &Path, wasm_dir: Option<&Path>) -> Result<Output> {
    let (mut command, _normalized) = export_command(input, output, wasm_dir)?;
    command
        .stdin(Stdio::inherit())
        .output()
        .context(PackagerLaunchError)
}

/// Typed launch context: user paths must never determine error classification.
#[derive(Debug)]
pub struct PackagerLaunchError;

impl std::fmt::Display for PackagerLaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("failed to start player packager; install Node.js 22+ and run npm ci --ignore-scripts in the source checkout")
    }
}

impl std::error::Error for PackagerLaunchError {}

fn export_command(
    input: &Path,
    output: &Path,
    wasm_dir: Option<&Path>,
) -> Result<(Command, tempfile::NamedTempFile)> {
    ensure!(
        !output.exists(),
        "output already exists: {}",
        output.display()
    );
    let source = crate::project::load_project(input)?;
    let (project, report) = crate::player::import(source.value)?;
    ensure!(
        report["fast_runtime_ready"].as_bool() == Some(true),
        "project cannot run in the bundled player: {}",
        report["runtime_error"]
    );
    let script = std::env::var_os("NEKOC_PLAYER_EXPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tools/build-player-export.mjs")
        });
    ensure!(
        script.is_file(),
        "player export tools not found; use a source checkout or set NEKOC_PLAYER_EXPORT to tools/build-player-export.mjs"
    );
    let normalized = tempfile::NamedTempFile::new()?;
    // Materialize canonical K4 edits before the packager rewrites its media.
    // Taking _nekocKitten4.source directly would silently discard those edits.
    let project = if crate::player::is_kitten4_project(&project) {
        crate::kitten4::from_neko(&project)?
    } else {
        project
    };
    std::fs::write(normalized.path(), crate::json::to_vec(&project)?)?;
    let input = input.canonicalize()?;
    let mut command = Command::new("node");
    command
        .arg(script)
        .arg("--input")
        .arg(normalized.path())
        .arg("--asset-base")
        .arg(input.parent().context("input has no parent directory")?)
        .arg("--out")
        .arg(output);
    if let Some(dir) = wasm_dir {
        command.arg("--wasm-dir").arg(dir);
    }
    Ok((command, normalized))
}
