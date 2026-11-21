//! `nekoc check`: type and compatibility checks without writing a project.
//!
//! For TS/JS sources this runs the frontend's check mode (type check against
//! `ts/nekoc.d.ts` plus the selected target's canonical compile), then assembles the project
//! in memory and runs the structural checks the official runtime depends on.
//! For `.bcmkn` / `.bcm` / `.json` inputs only the project checks run.
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct Diagnostic {
    /// `error` or `warning`.
    pub severity: String,
    /// `syntax`, `types`, `compat` (unsupported by the target) or `project`.
    pub source: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<u64>,
    /// Original source line, without a line ending; null when unavailable.
    pub snippet: Option<String>,
    /// Actionable guidance, separate from the diagnostic message.
    pub suggestion: String,
}

impl Diagnostic {
    pub(crate) fn from_actor_target(issue: &Value) -> Self {
        let diagnostic = Self {
            severity: "error".into(),
            source: "compat".into(),
            code: "invalid_actor_menu_target".into(),
            message: issue["message"].as_str().unwrap_or("").to_owned(),
            file: issue["source"]["file"].as_str().map(str::to_owned),
            line: issue["source"]["line"].as_u64(),
            column: issue["source"]["column"].as_u64(),
            snippet: None,
            suggestion: "Use the name or ID of a sprite declared in the same scene; see docs/api.md for supported actor targets.".into(),
        };
        #[cfg(not(target_arch = "wasm32"))]
        let diagnostic = diagnostic.with_source_snippet();
        diagnostic
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn from_frontend(value: &Value) -> Self {
        let text = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
        Self {
            severity: text("severity"),
            source: text("source"),
            code: text("code"),
            message: text("message"),
            file: value["file"].as_str().map(str::to_owned),
            line: value["line"].as_u64(),
            column: value["column"].as_u64(),
            snippet: value["snippet"].as_str().map(str::to_owned),
            suggestion: text("suggestion"),
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn with_source_snippet(mut self) -> Self {
        if let (Some(file), Some(line)) = (&self.file, self.line) {
            self.snippet = std::fs::read_to_string(file).ok().and_then(|text| {
                text.replace("\r\n", "\n")
                    .split(['\n', '\r', '\u{2028}', '\u{2029}'])
                    .nth(line.saturating_sub(1) as usize)
                    .map(str::to_owned)
            });
        }
        self
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(file) = &self.file {
            write!(f, "{file}")?;
            if let (Some(line), Some(column)) = (self.line, self.column) {
                write!(f, ":{line}:{column}")?;
            }
            write!(f, ": ")?;
        }
        write!(
            f,
            "{} {}: {} [{}]",
            self.severity, self.code, self.message, self.source
        )?;
        if let (Some(snippet), Some(line), Some(column)) = (&self.snippet, self.line, self.column) {
            // TypeScript columns count UTF-16 code units, including astral
            // characters. Preserve tabs just as the frontend formatter does.
            let padding: String = snippet
                .encode_utf16()
                .take(column.saturating_sub(1) as usize)
                .map(|unit| if unit == 9 { '\t' } else { ' ' })
                .collect();
            let gutter = " ".repeat(line.to_string().len());
            write!(f, "\n  {line} | {snippet}\n  {gutter} | {padding}^")?;
        }
        if !self.suggestion.is_empty() {
            write!(f, "\n  help: {}", self.suggestion)?;
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct CheckReport {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
}

pub struct CheckOptions<'a> {
    /// Type check TS sources against nekoc.d.ts.
    pub types: bool,
    /// Template project for TS sources; the bundled empty work when `None`.
    pub template: Option<&'a Path>,
    /// Frontend lowering/preflight target: `kitten-n` (default) or `kitten4`.
    pub target: &'a str,
}

impl Default for CheckOptions<'_> {
    fn default() -> Self {
        Self {
            types: true,
            template: None,
            target: "kitten-n",
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn is_project_file(input: &Path) -> bool {
    matches!(
        input.extension().and_then(|ext| ext.to_str()),
        Some("bcmkn" | "bcm" | "json")
    )
}

/// Checks a TS/JS source (through the Node frontend) or a project file.
#[cfg(not(target_arch = "wasm32"))]
pub fn check_file(input: &Path, options: &CheckOptions) -> Result<CheckReport> {
    let mut diagnostics = Vec::new();
    let project = if is_project_file(input) {
        Some(crate::project::load_project(input)?.value)
    } else {
        let frontend =
            crate::ts_frontend::check_ts_for_target(input, options.types, options.target)?;
        diagnostics.extend(frontend.diagnostics.iter().map(Diagnostic::from_frontend));
        match frontend.report {
            Some(report) => {
                let template = match options.template {
                    Some(path) => {
                        let template = crate::project::load_project(path)?.value;
                        if options.target == "kitten4" && crate::kitten4::is_kitten4(&template) {
                            crate::kitten4::to_neko(&template)?
                        } else {
                            template
                        }
                    }
                    None => crate::bcmkn_compiler::default_template(),
                };
                match crate::bcmkn_compiler::assemble_workspace_bcmkn(
                    &report,
                    &crate::bcmkn_compiler::project_name(input),
                    template,
                ) {
                    Ok(project) => Some(project),
                    Err(error) => {
                        if let Some(errors) =
                            error.downcast_ref::<crate::bcmkn_compiler::ActorTargetErrors>()
                        {
                            diagnostics.extend(errors.diagnostics());
                            None
                        } else {
                            return Err(error);
                        }
                    }
                }
            }
            None => None,
        }
    };
    if let Some(project) = project {
        diagnostics.extend(project_diagnostics(
            &project,
            Some(&input.display().to_string()),
        )?);
    }
    Ok(CheckReport {
        ok: !diagnostics.iter().any(|d| d.severity == "error"),
        diagnostics,
    })
}

/// Structural problems the official editor or runtime would reject, as
/// `project` diagnostics. Shared by `nekoc check` and the wasm package.
pub fn project_diagnostics(project: &Value, file: Option<&str>) -> Result<Vec<Diagnostic>> {
    let mut out = Vec::new();
    let report = crate::validate::build_report(project)?;
    for issue in report["issues"].as_array().into_iter().flatten() {
        let kind = issue["kind"].as_str().unwrap_or("project_issue");
        let mut details = issue.clone();
        if let Some(map) = details.as_object_mut() {
            map.remove("kind");
        }
        out.push(Diagnostic {
            severity: "error".into(),
            source: "project".into(),
            code: kind.into(),
            message: issue["message"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| details.to_string()),
            file: file.map(str::to_owned),
            line: None,
            column: None,
            snippet: None,
            suggestion: "Fix the reported project structure and rerun nekoc check; regenerate the work from corrected source when available.".into(),
        });
    }
    Ok(out)
}
