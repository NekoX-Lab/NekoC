//! Advanced creative templates: standalone builds and deterministic input replay.
use nekoc::engine::{Engine, Program};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command, time::Duration};

fn cli(args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_nekoc"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn build(name: &str, path: &Path, optimize: bool) -> Value {
    let source = format!("samples/templates/{name}.nk.ts");
    assert_eq!(cli(&["check", &source, "--json"])["ok"], true);
    let mut command = Command::new(env!("CARGO_BIN_EXE_nekoc"));
    command
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args(["build", &source, "-o"])
        .arg(path);
    if optimize {
        command.arg("--optimize");
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{name} optimize={optimize}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let path_text = path.to_str().unwrap();
    assert_eq!(cli(&["check", path_text, "--json"])["ok"], true);
    let run = cli(&["run", path_text, "--ticks", "600"]);
    assert_eq!(run["ticks"], 600);
    assert_eq!(run["sequence"], 600);
    assert_eq!(run["budget_yields"], 0);
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn advance(engine: &mut Engine, frames: usize) {
    for _ in 0..frames {
        let frame = engine
            .advance(1.0 / 60.0, 2_000_000, Duration::from_secs(5))
            .unwrap();
        assert!(!frame.budget_yield);
    }
}

fn release(engine: &mut Engine, key: &str) {
    engine.key_event(key, true);
    advance(engine, 4);
    engine.key_event(key, false);
    advance(engine, 12);
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

fn scene(engine: &Engine, project: &Value, name: &str) {
    assert_eq!(
        engine.debug_snapshot()["scene"],
        id(project, "scenes", "scenesDict", name)
    );
}

fn click(engine: &mut Engine, project: &Value, name: &str) {
    engine.pointer_event(
        id(project, "actors", "actorsDict", name),
        "mouse_click",
        0.0,
        -50.0,
    );
    advance(engine, 12);
}

fn menu(engine: &mut Engine, project: &Value) {
    scene(engine, project, "menu");
    engine.key_event("32", true);
    advance(engine, 30);
    scene(engine, project, "menu");
    engine.key_event("32", false);
    advance(engine, 12);
    scene(engine, project, "play");
    assert_eq!(value(engine, project, "rounds"), json!(1.0));
    assert_eq!(value(engine, project, "score"), json!(0.0));
    click(engine, project, "collectible");
    release(engine, "32");
    scene(engine, project, "play");
    assert_eq!(value(engine, project, "score"), json!(2.0));
    release(engine, "32");
    scene(engine, project, "result");
    release(engine, "32"); // A result screen must not collect or start a new round.
    assert_eq!(value(engine, project, "score"), json!(3.0));
    assert_eq!(value(engine, project, "rounds"), json!(1.0));
    release(engine, "82");
    scene(engine, project, "play");
    assert_eq!(value(engine, project, "rounds"), json!(2.0));
    assert_eq!(value(engine, project, "score"), json!(0.0));
    release(engine, "32");
    release(engine, "77"); // Abort a partially completed round.
    scene(engine, project, "menu");
    click(engine, project, "start");
    scene(engine, project, "play");
    assert_eq!(value(engine, project, "rounds"), json!(3.0));
    assert_eq!(value(engine, project, "score"), json!(0.0));
    for _ in 0..3 {
        click(engine, project, "collectible");
    }
    scene(engine, project, "result");
    click(engine, project, "again");
    scene(engine, project, "play");
    assert_eq!(value(engine, project, "rounds"), json!(4.0));
    assert_eq!(value(engine, project, "score"), json!(0.0));
    for _ in 0..3 {
        release(engine, "32");
    }
    release(engine, "77");
    scene(engine, project, "menu");
    engine.start();
    advance(engine, 30);
    scene(engine, project, "menu");
    assert_eq!(value(engine, project, "rounds"), json!(0.0));
    assert_eq!(value(engine, project, "score"), json!(0.0));
}

fn inventory(engine: &mut Engine, project: &Value) {
    assert_eq!(value(engine, project, "inventory"), json!(["苹果"]));
    engine.key_event("50", true);
    advance(engine, 30);
    assert_eq!(value(engine, project, "inventory"), json!(["苹果"]));
    engine.key_event("50", false);
    advance(engine, 12);
    release(engine, "49");
    release(engine, "50");
    release(engine, "49");
    release(engine, "50"); // Sixth item is rejected at capacity five.
    assert_eq!(
        value(engine, project, "inventory"),
        json!(["苹果", "药水", "苹果", "药水", "苹果"])
    );
    assert_eq!(
        value(engine, project, "status"),
        "背包已满，请使用或丢弃物品"
    );
    release(engine, "37"); // Wrap left to the last slot.
    assert_eq!(value(engine, project, "selected"), json!(5.0));
    release(engine, "39"); // Wrap right to the first.
    assert_eq!(value(engine, project, "selected"), json!(1.0));
    release(engine, "39");
    release(engine, "32"); // Use the middle potion, not the first apple.
    assert_eq!(value(engine, project, "status"), "使用 药水");
    assert_eq!(value(engine, project, "used"), json!(1.0));
    assert_eq!(value(engine, project, "selected"), json!(2.0));
    assert_eq!(
        value(engine, project, "inventory"),
        json!(["苹果", "苹果", "药水", "苹果"])
    );
    release(engine, "68"); // Drop the shifted middle apple without increasing used.
    assert_eq!(value(engine, project, "status"), "丢弃 苹果");
    assert_eq!(value(engine, project, "used"), json!(1.0));
    assert_eq!(
        value(engine, project, "inventory"),
        json!(["苹果", "药水", "苹果"])
    );
    release(engine, "39");
    release(engine, "68"); // Drop last slot: selection moves to previous slot.
    assert_eq!(value(engine, project, "selected"), json!(2.0));
    release(engine, "32"); // Use last slot: also clamp selection.
    assert_eq!(value(engine, project, "selected"), json!(1.0));
    release(engine, "32");
    for key in ["37", "39", "32", "68"] {
        release(engine, key);
    }
    assert_eq!(value(engine, project, "selected"), json!(1.0));
    assert_eq!(value(engine, project, "inventory"), json!([]));
    assert_eq!(value(engine, project, "status"), "背包为空，松开 1/2 拾取");
    assert_eq!(value(engine, project, "used"), json!(3.0));
    release(engine, "50");
    release(engine, "49");
    release(engine, "37");
    release(engine, "82"); // Clear a non-first selection, then an already empty bag.
    release(engine, "82");
    assert_eq!(value(engine, project, "inventory"), json!([]));
    assert_eq!(value(engine, project, "selected"), json!(1.0));
    assert_eq!(value(engine, project, "used"), json!(3.0));
    release(engine, "50");
    assert_eq!(value(engine, project, "inventory"), json!(["药水"]));
    engine.start();
    advance(engine, 30);
    assert_eq!(value(engine, project, "inventory"), json!(["苹果"]));
    assert_eq!(value(engine, project, "selected"), json!(1.0));
    assert_eq!(value(engine, project, "used"), json!(0.0));
}

#[test]
fn advanced_templates_build_run_and_respond_to_input() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["menu-scenes-quest", "list-inventory-select"] {
        for optimize in [false, true] {
            let path = dir.path().join(format!("{name}-{optimize}.bcmkn"));
            let project = build(name, &path, optimize);
            for jit in [false, true] {
                let mut engine = Engine::new(Program::compile(&project).unwrap());
                if !jit {
                    engine.disable_jit();
                }
                engine.use_virtual_clock();
                engine.start();
                advance(&mut engine, 600);
                match name {
                    "menu-scenes-quest" => menu(&mut engine, &project),
                    "list-inventory-select" => inventory(&mut engine, &project),
                    _ => unreachable!(),
                }
            }
        }
    }
}
