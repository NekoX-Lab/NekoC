//! Runnable starter templates: real CLI builds plus deterministic input replay.
use nekoc::engine::{Engine, Program};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command, time::Duration};

fn cli(args: &[&str], path: &Path) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_nekoc"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args(args)
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?} {}: {}{}",
        path.display(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn build(name: &str, output: &Path, optimize: bool) -> Value {
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("samples/templates/{name}.nk.ts"));
    assert_eq!(cli(&["check", "--json"], &source)["ok"], true);
    let mut command = Command::new(env!("CARGO_BIN_EXE_nekoc"));
    command
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .arg("build")
        .arg(source)
        .arg("-o")
        .arg(output);
    if optimize {
        command.arg("--optimize");
    }
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{name}, optimize={optimize}: {}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(cli(&["check", "--json"], output)["ok"], true);
    let run = cli(&["run", "--ticks", "600"], output);
    assert_eq!(run["ticks"], 600);
    assert_eq!(run["sequence"], 600);
    assert_eq!(run["budget_yields"], 0);
    serde_json::from_slice(&fs::read(output).unwrap()).unwrap()
}

fn advance(engine: &mut Engine, frames: usize) {
    for _ in 0..frames {
        let frame = engine
            .advance(1.0 / 60.0, 2_000_000, Duration::from_secs(5))
            .unwrap();
        assert!(!frame.budget_yield, "template exhausted the frame budget");
    }
}

fn hold(engine: &mut Engine, key: &str, frames: usize) {
    engine.key_event(key, true);
    advance(engine, frames);
    engine.key_event(key, false);
    advance(engine, 4);
}

fn id<'a>(project: &'a Value, section: &str, dict: &str, name: &str) -> &'a str {
    project[section][dict]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, entry)| entry["name"] == name)
        .unwrap_or_else(|| panic!("missing {section} entry {name}"))
        .0
}

fn value(engine: &Engine, project: &Value, name: &str) -> Value {
    serde_json::to_value(engine.variable_value(id(project, "variables", "variablesDict", name)))
        .unwrap()
}

fn position(engine: &Engine, project: &Value) -> (f64, f64) {
    let snapshot = engine.debug_snapshot();
    let player = &snapshot["actors"][id(project, "actors", "actorsDict", "player")];
    (player["x"].as_f64().unwrap(), player["y"].as_f64().unwrap())
}

fn movement(engine: &mut Engine, project: &Value) {
    assert_eq!(position(engine, project), (-180.0, 0.0));
    hold(engine, "39", 120); // Right: stopped on the near side of the wall.
    assert_eq!(position(engine, project), (-48.0, 0.0));
    hold(engine, "38", 180); // Up: slide along the wall, stop at stage bounds.
    assert_eq!(position(engine, project), (-48.0, 212.0));
    hold(engine, "39", 360); // Cross above the wall to the right boundary.
    assert_eq!(position(engine, project), (384.0, 212.0));
    hold(engine, "40", 360);
    assert_eq!(position(engine, project), (384.0, -212.0));
    hold(engine, "37", 600);
    assert_eq!(position(engine, project), (-384.0, -212.0));
    hold(engine, "82", 6); // R resets both axes.
    assert_eq!(position(engine, project), (-180.0, 0.0));
}

fn scene(engine: &Engine, project: &Value, name: &str) {
    assert_eq!(
        engine.debug_snapshot()["scene"],
        id(project, "scenes", "scenesDict", name)
    );
}

fn menu(engine: &mut Engine, project: &Value) {
    scene(engine, project, "menu");
    engine.key_event("32", true);
    advance(engine, 30);
    scene(engine, project, "menu"); // Holding space must not start repeatedly.
    engine.key_event("32", false);
    advance(engine, 10);
    scene(engine, project, "game");
    assert_eq!(value(engine, project, "visits"), json!(1.0));
    assert_eq!(value(engine, project, "score"), json!(0.0));
    for _ in 0..7 {
        hold(engine, "32", 3);
    }
    assert_eq!(value(engine, project, "score"), json!(5.0));
    hold(engine, "77", 3);
    scene(engine, project, "menu");
    engine.pointer_event(
        id(project, "actors", "actorsDict", "start-button"),
        "mouse_click",
        0.0,
        0.0,
    );
    advance(engine, 10);
    scene(engine, project, "game");
    assert_eq!(value(engine, project, "score"), json!(0.0));
    assert_eq!(value(engine, project, "visits"), json!(2.0));
    engine.pointer_event(
        id(project, "actors", "actorsDict", "star"),
        "mouse_click",
        0.0,
        0.0,
    );
    advance(engine, 4);
    assert_eq!(value(engine, project, "score"), json!(1.0));
    hold(engine, "77", 3);
    scene(engine, project, "menu");
}

fn inventory(engine: &mut Engine, project: &Value) {
    assert_eq!(value(engine, project, "inventory"), json!(["苹果"]));
    engine.key_event("49", true);
    advance(engine, 30);
    assert_eq!(value(engine, project, "inventory"), json!(["苹果"]));
    engine.key_event("49", false);
    advance(engine, 4);
    hold(engine, "50", 3);
    hold(engine, "50", 3);
    hold(engine, "49", 3); // Full: fifth item must be rejected.
    assert_eq!(
        value(engine, project, "inventory"),
        json!(["苹果", "苹果", "药水", "药水"])
    );
    assert_eq!(value(engine, project, "status"), "背包已满，请先按空格使用");
    hold(engine, "32", 3);
    assert_eq!(value(engine, project, "status"), "使用 苹果");
    assert_eq!(
        value(engine, project, "inventory"),
        json!(["苹果", "药水", "药水"])
    );
    hold(engine, "49", 3); // Released space permits reuse of the freed slot.
    assert_eq!(
        value(engine, project, "inventory"),
        json!(["苹果", "药水", "药水", "苹果"])
    );
    for _ in 0..5 {
        hold(engine, "32", 3);
    }
    assert_eq!(value(engine, project, "inventory"), json!([]));
    assert_eq!(value(engine, project, "status"), "背包为空，松开 1/2 拾取");
    hold(engine, "50", 3);
    hold(engine, "82", 3);
    hold(engine, "82", 3); // Clearing an empty bag is also safe.
    assert_eq!(value(engine, project, "inventory"), json!([]));
    hold(engine, "50", 3);
    assert_eq!(value(engine, project, "inventory"), json!(["药水"]));
}

#[test]
fn templates_compile_run_600_frames_and_respond_to_input() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["movement-collision", "menu-scenes", "list-inventory"] {
        for optimize in [false, true] {
            let output = dir.path().join(format!("{name}-{optimize}.bcmkn"));
            let project = build(name, &output, optimize);
            for jit in [false, true] {
                let mut engine = Engine::new(Program::compile(&project).unwrap());
                if !jit {
                    engine.disable_jit();
                }
                engine.use_virtual_clock();
                engine.start();
                advance(&mut engine, 600);
                match name {
                    "movement-collision" => movement(&mut engine, &project),
                    "menu-scenes" => menu(&mut engine, &project),
                    "list-inventory" => inventory(&mut engine, &project),
                    _ => unreachable!(),
                }
            }
        }
    }
}
