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
    build_source(&source, path, optimize)
}

fn build_source(source: &str, path: &Path, optimize: bool) -> Value {
    assert_eq!(cli(&["check", source, "--json"])["ok"], true);
    let mut command = Command::new(env!("CARGO_BIN_EXE_nekoc"));
    command
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args(["build", source, "-o"])
        .arg(path);
    if optimize {
        command.arg("--optimize");
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{source} optimize={optimize}: {}{}",
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

// Observe the player frame payload, not only hidden variables: a template with
// correct inventory state but stale/missing selection text is still broken.
fn latest_dialog(engine: &mut Engine, project: &Value, actor: &str) -> String {
    let actor_id = id(project, "actors", "actorsDict", actor);
    let mut text = None;
    for _ in 0..90 {
        let frame = engine
            .advance(1.0 / 60.0, 2_000_000, Duration::from_secs(5))
            .unwrap();
        assert!(!frame.budget_yield);
        for sprite in frame.sprites {
            if sprite.id == actor_id
                && let Some(dialog) = sprite.dialog
            {
                // Player dialogs preserve layout with NBSP; compare visible
                // spaces rather than treating that presentation encoding as text loss.
                text = Some(dialog.text.replace('\u{a0}', " "));
            }
        }
    }
    text.unwrap_or_else(|| panic!("missing visible dialog for {actor}"))
}

#[test]
fn template_parameter_boundaries_preserve_state_and_visible_feedback() {
    let dir = tempfile::tempdir().unwrap();
    for (name, original, replacement, capacity, initial) in [
        (
            "menu-scenes-quest",
            "const TARGET_SCORE = 3;",
            "const TARGET_SCORE = 1;",
            0,
            false,
        ),
        (
            "list-inventory-select",
            "const CAPACITY = 5;",
            "const CAPACITY = 1;",
            1,
            true,
        ),
        (
            "list-inventory-select",
            "appendList(\"inventory\", ITEM_ONE);",
            "",
            5,
            false,
        ),
    ] {
        let source = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("samples/templates/{name}.nk.ts")),
        )
        .unwrap();
        assert!(source.contains(original), "parameter anchor disappeared");
        let variant = dir.path().join(format!("{name}-{capacity}.nk.ts"));
        fs::write(&variant, source.replacen(original, replacement, 1)).unwrap();
        for optimize in [false, true] {
            let output = dir
                .path()
                .join(format!("{name}-{capacity}-{optimize}.bcmkn"));
            let project = build_source(variant.to_str().unwrap(), &output, optimize);
            for jit in [false, true] {
                let mut engine = Engine::new(Program::compile(&project).unwrap());
                if !jit {
                    engine.disable_jit();
                }
                engine.use_virtual_clock();
                engine.start();
                if name == "menu-scenes-quest" {
                    advance(&mut engine, 30);
                    for round in 1..=3 {
                        let button = if round == 1 { "start" } else { "again" };
                        click(&mut engine, &project, button);
                        scene(&engine, &project, "play");
                        assert_eq!(value(&engine, &project, "score"), json!(0.0));
                        // Capture the emitted result bubble from the key release itself.
                        engine.key_event("32", true);
                        advance(&mut engine, 4);
                        engine.key_event("32", false);
                        let dialog = latest_dialog(&mut engine, &project, "again");
                        scene(&engine, &project, "result");
                        assert_eq!(value(&engine, &project, "score"), json!(1.0));
                        assert_eq!(value(&engine, &project, "rounds"), json!(round as f64));
                        assert!(
                            dialog.contains(&format!("第 {round} 局完成！星星 1/1")),
                            "unexpected result dialog: {dialog:?}"
                        );
                    }
                    continue;
                }
                advance(&mut engine, 30);
                let mut items = if initial { vec!["苹果"] } else { vec![] };
                let mut selected = 1usize;
                let mut used = 0usize;
                let mut seed = 0x41982u64;
                for step in 0..120 {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    let key = ["49", "50", "37", "39", "32", "68", "82"][(seed >> 32) as usize % 7];
                    release(&mut engine, key);
                    match key {
                        "49" | "50" if items.len() < capacity => {
                            items.push(if key == "49" { "苹果" } else { "药水" });
                        }
                        "37" if !items.is_empty() => {
                            selected = if selected == 1 {
                                items.len()
                            } else {
                                selected - 1
                            };
                        }
                        "39" if !items.is_empty() => {
                            selected = if selected == items.len() {
                                1
                            } else {
                                selected + 1
                            };
                        }
                        "32" | "68" if !items.is_empty() => {
                            items.remove(selected - 1);
                            if key == "32" {
                                used += 1;
                            }
                            selected = selected.min(items.len()).max(1);
                        }
                        "82" => {
                            items.clear();
                            selected = 1;
                        }
                        _ => {}
                    }
                    let dialog = latest_dialog(&mut engine, &project, "bag");
                    assert_eq!(
                        value(&engine, &project, "inventory"),
                        json!(items),
                        "capacity={capacity} optimize={optimize} jit={jit} step={step}"
                    );
                    assert_eq!(value(&engine, &project, "selected"), json!(selected as f64));
                    assert_eq!(value(&engine, &project, "used"), json!(used as f64));
                    let contents = items
                        .iter()
                        .enumerate()
                        .map(|(index, item)| {
                            if index + 1 == selected {
                                format!("[{item}]")
                            } else {
                                item.to_string()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("、");
                    let status = value(&engine, &project, "status");
                    assert_eq!(
                        dialog,
                        format!(
                            "{} | {}/{capacity}：{contents} | 已使用 {used}",
                            status.as_str().unwrap(),
                            items.len()
                        )
                    );
                }
            }
        }
    }
}
