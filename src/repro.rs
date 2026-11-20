//! Deterministic Player recordings. Only normalized keyboard/mouse input crosses
//! this boundary; packages never supply a project or external capabilities.
use crate::json::Json;
use crate::player::{FrameInput, Handshake, InputEvent, PROTOCOL_VERSION, Player};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const SCHEMA: &str = "nekoc-repro-v1";
pub const DT: f64 = 1.0 / 60.0;
pub const MAX_FRAMES: usize = 36_000;
pub const INSTRUCTION_BUDGET: usize = 2_000_000;
pub const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
pub const WARNING_CODES: &[&str] = &[
    "audio",
    "real_time",
    "cloud",
    "external_inputs",
    "asset_geometry",
    "omitted_inputs",
    "interrupted",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub seed: String,
}

impl Config {
    pub fn seed_value(&self) -> Result<u64> {
        parse_seed(&self.seed)
    }
}

pub fn parse_seed(seed: &str) -> Result<u64> {
    ensure!(
        !seed.is_empty()
            && seed.len() <= 20
            && seed.bytes().all(|c| c.is_ascii_digit())
            && (seed == "0" || !seed.starts_with('0')),
        "repro seed must be a canonical decimal u64 string"
    );
    seed.parse().context("repro seed exceeds u64")
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Runner {
    pub name: String,
    pub version: String,
    pub protocol: u32,
}

impl Default for Runner {
    fn default() -> Self {
        Self {
            name: "nekoc".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: PROTOCOL_VERSION,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub runner: Runner,
    pub work_sha256: String,
    pub seed: String,
    pub dt: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub state_sha256: String,
    pub frame_count: u32,
    pub budget_yields: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Mouse {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Key {
        key: String,
        down: bool,
    },
    Pointer {
        target: String,
        state: String,
        x: f64,
        y: f64,
    },
    Drag {
        target: String,
        x: f64,
        y: f64,
    },
    Swipe {
        direction: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub pressed: Vec<String>,
    pub mouse: Mouse,
    pub events: Vec<Event>,
}

fn validate_key(key: &str) -> Result<()> {
    let code = key.parse::<u8>().ok();
    ensure!(
        code.is_some_and(|code| {
            matches!(code, 13 | 32 | 37..=40 | 48..=57 | 65..=90) && code.to_string() == key
        }),
        "invalid repro keyCode {key:?}"
    );
    Ok(())
}

fn validate_coordinates(x: f64, y: f64) -> Result<()> {
    ensure!(
        x.is_finite() && y.is_finite(),
        "repro coordinates must be finite"
    );
    Ok(())
}

fn validate_target(target: &str) -> Result<()> {
    ensure!(
        target.encode_utf16().count() <= 4096,
        "repro target exceeds 4096 characters"
    );
    Ok(())
}

impl Input {
    pub fn from_json(value: &Value) -> Result<Self> {
        let input = Self::deserialize(value)
            .context("invalid repro frame input (only pressed, mouse and events are allowed)")?;
        input.validate()?;
        Ok(input)
    }

    /// The live wire optionally includes the fixed delta; package inputs do not.
    pub fn from_request(value: &Value) -> Result<Self> {
        fn default_dt() -> f64 {
            DT
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Request {
            #[serde(default = "default_dt")]
            dt: f64,
            pressed: Vec<String>,
            mouse: Mouse,
            events: Vec<Event>,
        }
        let request = Request::deserialize(value).context("invalid repro frame request")?;
        ensure!(request.dt == DT, "repro frame dt must equal 1/60");
        let input = Self {
            pressed: request.pressed,
            mouse: request.mouse,
            events: request.events,
        };
        input.validate()?;
        Ok(input)
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(self.pressed.len() <= 256, "repro pressed exceeds 256 keys");
        ensure!(self.events.len() <= 256, "repro frame exceeds 256 events");
        for key in &self.pressed {
            validate_key(key)?;
        }
        validate_coordinates(self.mouse.x, self.mouse.y)?;
        for event in &self.events {
            match event {
                Event::Key { key, .. } => validate_key(key)?,
                Event::Pointer {
                    target,
                    state,
                    x,
                    y,
                } => {
                    validate_target(target)?;
                    validate_coordinates(*x, *y)?;
                    ensure!(
                        matches!(
                            state.as_str(),
                            "" | "mouse_down" | "mouse_up" | "mouse_click"
                        ),
                        "invalid repro pointer state {state:?}"
                    );
                }
                Event::Drag { target, x, y } => {
                    validate_target(target)?;
                    validate_coordinates(*x, *y)?;
                }
                Event::Swipe { direction } => ensure!(
                    matches!(direction.as_str(), "up" | "down" | "left" | "right"),
                    "invalid repro swipe direction {direction:?}"
                ),
            }
        }
        Ok(())
    }

    pub fn to_frame_input(&self) -> Result<FrameInput> {
        self.validate()?;
        Ok(FrameInput {
            dt: DT,
            pressed: Some(self.pressed.clone()),
            mouse: Some((self.mouse.x, self.mouse.y)),
            events: self
                .events
                .iter()
                .map(|event| match event {
                    Event::Key { key, down } => InputEvent::Key {
                        key: key.clone(),
                        down: *down,
                    },
                    Event::Pointer {
                        target,
                        state,
                        x,
                        y,
                    } => InputEvent::Pointer {
                        target: target.clone(),
                        state: state.clone(),
                        x: *x,
                        y: *y,
                    },
                    Event::Drag { target, x, y } => InputEvent::Drag {
                        target: target.clone(),
                        x: *x,
                        y: *y,
                    },
                    Event::Swipe { direction } => InputEvent::Swipe {
                        direction: direction.clone(),
                    },
                })
                .collect(),
            ..Default::default()
        })
    }

    /// Typed SDK callers must obey the same whitelist as wire clients.
    pub fn from_frame_input(input: &FrameInput) -> Result<Self> {
        ensure!(
            input.dt == DT && !input.coalesce,
            "repro requires dt=1/60 and coalesce=false"
        );
        ensure!(
            input.microphone.is_none()
                && input.keys.is_empty()
                && input.costumes.is_empty()
                && input.videos.is_empty()
                && input.utc_offset.is_none(),
            "repro only permits normalized keyboard/mouse input"
        );
        let pressed = input.pressed.clone().context("repro requires pressed")?;
        let (x, y) = input.mouse.context("repro requires mouse")?;
        let events = input
            .events
            .iter()
            .map(|event| {
                Ok(match event {
                    InputEvent::Key { key, down } => Event::Key {
                        key: key.clone(),
                        down: *down,
                    },
                    InputEvent::Pointer {
                        target,
                        state,
                        x,
                        y,
                    } => Event::Pointer {
                        target: target.clone(),
                        state: state.clone(),
                        x: *x,
                        y: *y,
                    },
                    InputEvent::Drag { target, x, y } => Event::Drag {
                        target: target.clone(),
                        x: *x,
                        y: *y,
                    },
                    InputEvent::Swipe { direction } => Event::Swipe {
                        direction: direction.clone(),
                    },
                    _ => bail!("repro only permits key, pointer, drag and swipe events"),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let input = Self {
            pressed,
            mouse: Mouse { x, y },
            events,
        };
        input.validate()?;
        Ok(input)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TimelineFrame {
    pub frame: u32,
    pub time_ms: f64,
    pub input: Input,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InputQueue {
    pub coalesced: u64,
    pub rejected: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Diagnostics {
    pub state_sha256: String,
    pub frame_count: u32,
    pub budget_yields: u32,
    pub warnings: Vec<String>,
    pub input_queue: InputQueue,
    pub interrupted: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Package {
    pub schema: String,
    pub runner: Runner,
    pub work_sha256: String,
    pub seed: String,
    pub dt: f64,
    pub timeline: Vec<TimelineFrame>,
    pub diagnostics: Diagnostics,
}

fn validate_hash(hash: &str, label: &str) -> Result<()> {
    ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
        "repro {label} must be 64 lowercase hexadecimal characters"
    );
    Ok(())
}

impl Package {
    pub fn parse(text: &str) -> Result<Self> {
        ensure!(
            text.len() <= MAX_PACKAGE_BYTES,
            "repro package exceeds 64 MiB"
        );
        let package: Self = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .context("invalid nekoc-repro-v1 package")?;
        package.validate()?;
        Ok(package)
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(self.schema == SCHEMA, "expected {SCHEMA}");
        let runner = Runner::default();
        ensure!(
            self.runner.name == runner.name,
            "repro runner name mismatch"
        );
        ensure!(
            self.runner.version == runner.version,
            "repro runner version mismatch: expected {}, got {}",
            runner.version,
            self.runner.version
        );
        ensure!(
            self.runner.protocol == runner.protocol,
            "repro protocol mismatch: expected {}, got {}",
            runner.protocol,
            self.runner.protocol
        );
        validate_hash(&self.work_sha256, "work_sha256")?;
        validate_hash(&self.diagnostics.state_sha256, "state_sha256")?;
        parse_seed(&self.seed)?;
        ensure!(self.dt == DT, "repro dt must equal 1/60");
        ensure!(
            self.timeline.len() <= MAX_FRAMES,
            "repro exceeds 36000 frames"
        );
        ensure!(
            self.diagnostics.frame_count as usize == self.timeline.len(),
            "repro frame_count must equal timeline length"
        );
        ensure!(
            self.diagnostics.budget_yields <= self.diagnostics.frame_count,
            "repro budget_yields exceeds frame_count"
        );
        ensure!(
            self.diagnostics.warnings.len() <= 32,
            "too many repro warning codes"
        );
        for warning in &self.diagnostics.warnings {
            ensure!(
                WARNING_CODES.contains(&warning.as_str()),
                "unknown repro warning code {warning:?}"
            );
        }
        for (index, entry) in self.timeline.iter().enumerate() {
            ensure!(
                entry.frame as usize == index + 1,
                "repro timeline frames must be contiguous starting at 1 (entry {})",
                index + 1
            );
            let time_ms = index as f64 * 1000.0 / 60.0;
            ensure!(
                entry.time_ms.is_finite() && (entry.time_ms - time_ms).abs() <= 1e-6,
                "repro time_ms must equal (frame-1)*1000/60 at frame {}",
                entry.frame
            );
            entry
                .input
                .validate()
                .with_context(|| format!("invalid repro input at frame {}", entry.frame))?;
        }
        Ok(())
    }
}

/// Dispatch by schema exactly once. Malformed repro packages cannot fall back
/// to the historical input interpreter. Legacy validation stays in cli_run.
#[derive(Debug)]
pub enum Script {
    Repro(Package),
    Legacy(crate::input::InputScript),
}

impl Script {
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_file(path: &std::path::Path) -> Result<Self> {
        use std::io::Read;
        let file = std::fs::File::open(path)
            .with_context(|| format!("reading input script {}", path.display()))?;
        let mut text = String::new();
        file.take(MAX_PACKAGE_BYTES as u64 + 1)
            .read_to_string(&mut text)?;
        Self::parse(&text)
    }

    pub fn parse(text: &str) -> Result<Self> {
        ensure!(
            text.len() <= MAX_PACKAGE_BYTES,
            "input script exceeds 64 MiB"
        );
        let text = text.trim_start_matches('\u{feff}');
        let value: Value = serde_json::from_str(text).context("invalid input script JSON")?;
        match value["schema"].as_str() {
            Some(SCHEMA) => Package::parse(text).map(Self::Repro),
            Some("nekoc-input-v1") => Ok(Self::Legacy(serde_json::from_str(text)?)),
            _ => bail!("input script schema must be nekoc-input-v1 or {SCHEMA}"),
        }
    }
}

/// Iterative canonical JSON hashing handles deeply nested projects without
/// recursive clones. Numbers follow browser JSON's IEEE-754/ECMAScript spelling
/// (including -0 => 0), so JSON.parse/stringify round trips keep the fingerprint.
pub fn canonical_sha256(value: &Value) -> Result<String> {
    enum Part<'a> {
        Value(&'a Value),
        Key(&'a str),
        Byte(u8),
    }
    let mut hash = Sha256::new();
    let mut pending = vec![Part::Value(value)];
    while let Some(part) = pending.pop() {
        match part {
            Part::Byte(byte) => hash.update([byte]),
            Part::Key(key) => hash.update(serde_json::to_vec(key)?),
            Part::Value(Value::Object(object)) => {
                hash.update(b"{");
                pending.push(Part::Byte(b'}'));
                let mut entries: Vec<_> = object.iter().collect();
                entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
                for (index, (key, value)) in entries.into_iter().enumerate().rev() {
                    pending.push(Part::Value(value));
                    pending.push(Part::Byte(b':'));
                    pending.push(Part::Key(key));
                    if index != 0 {
                        pending.push(Part::Byte(b','));
                    }
                }
            }
            Part::Value(Value::Array(array)) => {
                hash.update(b"[");
                pending.push(Part::Byte(b']'));
                for (index, value) in array.iter().enumerate().rev() {
                    pending.push(Part::Value(value));
                    if index != 0 {
                        pending.push(Part::Byte(b','));
                    }
                }
            }
            Part::Value(Value::Number(number)) => {
                let number = number
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .context("canonical JSON number must be finite")?;
                hash.update(crate::js_number::text(number).as_bytes());
            }
            Part::Value(scalar) => hash.update(serde_json::to_vec(scalar)?),
        }
    }
    Ok(format!("{hash:x}", hash = hash.finalize()))
}

/// Match JSON.parse/stringify's numeric transport semantics in the actual
/// executable input, not only its fingerprint. Keep the ordinary runner's
/// signed-zero and integer behavior unchanged outside repro sessions.
pub fn normalize_browser_numbers(value: &mut Value) -> Result<()> {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Number(number) => {
                let number = number
                    .as_f64()
                    .context("repro JSON number cannot be represented as f64")?;
                // Reparse the browser's serialized spelling: integral metadata
                // (e.g. K4 version 25) must stay an integer, not become 25.0.
                *value = if number.is_finite() {
                    serde_json::from_str(&crate::js_number::text(number))?
                } else {
                    Value::Null
                };
            }
            Value::Array(array) => pending.extend(array.iter_mut()),
            Value::Object(object) => pending.extend(object.values_mut()),
            _ => {}
        }
    }
    Ok(())
}

#[derive(Default)]
pub struct ReplayOptions {
    pub ticks: Option<usize>,
    pub seed: Option<u64>,
    pub has_events: bool,
    pub has_cloud: bool,
}

impl ReplayOptions {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.ticks.is_none(),
            "repro package conflicts with explicit --ticks/--frames"
        );
        ensure!(self.seed.is_none(), "repro package conflicts with --seed");
        ensure!(!self.has_events, "repro package conflicts with --event");
        ensure!(
            !self.has_cloud,
            "repro package conflicts with cloud options"
        );
        Ok(())
    }
}

/// Run exactly the acknowledged timeline, including idle and zero-frame runs,
/// through the same loading, input validation and stepping path as the Web host.
pub fn replay(source: &Value, package: &Package, options: &ReplayOptions) -> Result<Value> {
    options.validate()?;
    package.validate()?;
    let mut player = Player::load(
        Handshake::new(Json::new(crate::json::clone_value(source))).with_repro(Config {
            seed: package.seed.clone(),
        }),
    )?;
    ensure!(
        player.ready()["repro"]["work_sha256"] == package.work_sha256,
        "repro work fingerprint mismatch"
    );
    for entry in &package.timeline {
        let frame = player
            .step(&entry.input.to_frame_input()?)
            .with_context(|| format!("repro frame {} failed", entry.frame))?;
        player.recycle(frame);
    }
    let status = player.repro_status()?;
    ensure!(
        status.state_sha256 == package.diagnostics.state_sha256,
        "repro state digest mismatch: expected {}, got {}",
        package.diagnostics.state_sha256,
        status.state_sha256
    );
    ensure!(
        status.budget_yields == package.diagnostics.budget_yields,
        "repro budget_yields mismatch: expected {}, got {}",
        package.diagnostics.budget_yields,
        status.budget_yields
    );
    Ok(json!({
        "schema": "nekoc-repro-run-v1",
        "snapshot": player.engine().debug_snapshot(),
        "repro": {
            "matched": true, "runner": Runner::default(),
            "work_sha256": package.work_sha256, "seed": package.seed, "dt": DT,
            "state_sha256": status.state_sha256, "frame_count": status.frame_count,
            "budget_yields": status.budget_yields,
            "warnings": package.diagnostics.warnings,
            "input_queue": package.diagnostics.input_queue,
            "interrupted": package.diagnostics.interrupted,
            "complete_recording": !package.diagnostics.interrupted && package.diagnostics.input_queue.rejected == 0,
        }
    }))
}
