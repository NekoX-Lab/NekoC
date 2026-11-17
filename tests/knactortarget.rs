use nekoc::{
    bcmkn_compiler, check,
    engine::{Engine, Program},
    ts_frontend, validate,
};
use serde_json::{Value, json};
use std::time::Duration;

fn assemble(source: &str, template: nekoc::json::Json) -> anyhow::Result<Value> {
    let dir = tempfile::tempdir()?;
    let input = dir.path().join("knactortarget.ts");
    let report = dir.path().join("workspace.json");
    std::fs::write(&input, source)?;
    ts_frontend::compile_ts(&input, &report)?;
    let report: Value = serde_json::from_slice(&std::fs::read(report)?)?;
    Ok(bcmkn_compiler::assemble_workspace_bcmkn(&report, "knactortarget", template)?.into_value())
}

fn blocks(value: &Value) -> Vec<&Value> {
    let mut found = Vec::new();
    fn visit<'a>(v: &'a Value, found: &mut Vec<&'a Value>) {
        match v {
            Value::Object(m) => {
                if matches!(
                    v["type"].as_str(),
                    Some("self_rotate_around" | "on_bump_actor")
                ) {
                    found.push(v);
                }
                m.values().for_each(|v| visit(v, found));
            }
            Value::Array(a) => a.iter().for_each(|v| visit(v, found)),
            _ => {}
        }
    }
    visit(value, &mut found);
    found
}

fn assert_targets(project: &Value, expected: &[&str]) {
    let actual = blocks(project)
        .into_iter()
        .map(|b| b["fields"]["sprite"].as_str().unwrap())
        .collect::<Vec<_>>();
    let mut expected = expected.to_vec();
    let mut actual = actual;
    actual.sort();
    expected.sort();
    assert_eq!(actual, expected);
    assert_eq!(validate::build_report(project).unwrap()["ok"], true);
    assert!(!project.to_string().contains("_nekocTargetSource"));
}

#[test]
fn global_self_named_id_and_typed_self_api_resolve_after_allocation() {
    for target in ["target", "nekoc-actor-target"] {
        let source = format!(
            r#"sprite("target", {{}}, () => {{}});
sprite("source", {{}}, self => {{
  onStart(() => {{ rotateAround("{target}", 45); self.rotateAround("{target}", 45); }});
  onBumpActor("start", "{target}", "actor", () => {{}});
}});"#
        );
        let p = assemble(&source, bcmkn_compiler::default_template()).unwrap();
        assert_targets(&p, &["nekoc-actor-target"; 3]);
    }
    let p = assemble(
        r#"onStart(() => { rotateAround("--self", 45); });
onBumpActor("start", "--self", "actor", () => {});"#,
        bcmkn_compiler::default_template(),
    )
    .unwrap();
    assert_targets(&p, &["nekoc-default-actor"; 2]);
    let p = assemble(
        r#"sprite("own", {}, self => { onStart(() => { self.rotateAround("--self", 45); }); });"#,
        bcmkn_compiler::default_template(),
    )
    .unwrap();
    assert_targets(&p, &["nekoc-actor-own"]);
    for file in ["samples/motion_actor.ts", "samples/event_bump_received.ts"] {
        let source = std::fs::read_to_string(file).unwrap();
        let p = assemble(&source, bcmkn_compiler::default_template()).unwrap();
        assert_targets(&p, &["nekoc-default-actor"]);
    }
}

#[test]
fn template_names_ids_collisions_and_ambiguity_are_deterministic() {
    let mut t = bcmkn_compiler::default_template();
    let mut a = t["actors"]["actorsDict"]["nekoc-default-actor"].clone();
    a["id"] = json!("nekoc-actor-target");
    a["name"] = json!("target");
    t["actors"]["actorsDict"]["nekoc-actor-target"] = a;
    t["scenes"]["scenesDict"]["nekoc-scene-main"]["actorIds"] =
        json!(["nekoc-default-actor", "nekoc-actor-target"]);
    let source = r#"onStart(() => { rotateAround("target", 90); }); onBumpActor("start", "target", "actor", () => {});"#;
    assert_targets(
        &assemble(source, t.clone()).unwrap(),
        &["nekoc-actor-target"; 2],
    );
    // Resource registration resets template actors: the final allocation, not
    // the removed template's ID/name, is authoritative.
    let p = assemble(
        &format!("sprite(\"target\", {{}}, () => {{}}); {source}"),
        t.clone(),
    )
    .unwrap();
    assert_targets(&p, &["nekoc-actor-target"; 2]);
    t["actors"]["actorsDict"]["nekoc-default-actor"]["name"] = json!("target");
    assert!(
        assemble(source, t.clone())
            .unwrap_err()
            .to_string()
            .contains("ambiguous")
    );
    let source = source.replace("\"target\"", "\"nekoc-actor-target\"");
    assert_targets(
        &assemble(&source, t.clone()).unwrap(),
        &["nekoc-actor-target"; 2],
    );
    // An exact ID wins over an actor with that name.
    t["actors"]["actorsDict"]["nekoc-default-actor"]["name"] = json!("nekoc-actor-target");
    assert_targets(&assemble(&source, t).unwrap(), &["nekoc-actor-target"; 2]);
    // Sanitization collisions must resolve using the allocated suffix.
    let p = assemble(
        r#"sprite("a b", {}, () => {}); sprite("a-b", {}, () => {
onStart(() => { rotateAround("a-b", 1); }); });"#,
        bcmkn_compiler::default_template(),
    )
    .unwrap();
    assert_targets(&p, &["nekoc-actor-a-b-2"]);
}

#[test]
fn scene_scoped_names_and_cross_scene_rejections() {
    let source = r#"screen("one", {}, () => {
  sprite("target", {}, () => {});
  sprite("source", {}, () => { onStart(() => { rotateAround("target", 90); }); });
});
screen("two", {}, () => {
  sprite("target", {}, () => {});
  sprite("source", {}, () => { onBumpActor("start", "target", "actor", () => {}); });
});"#;
    assert_targets(
        &assemble(source, bcmkn_compiler::default_template()).unwrap(),
        &["nekoc-actor-target", "nekoc-actor-target-2"],
    );
    let source = source.replace(
        "rotateAround(\"target\"",
        "rotateAround(\"nekoc-actor-target-2\"",
    );
    assert!(
        assemble(&source, bcmkn_compiler::default_template())
            .unwrap_err()
            .to_string()
            .contains("not selectable")
    );
    let source = r#"screen("one", {}, () => { sprite("target", {}, () => {}); });
screen("two", {}, () => { sprite("source", {}, () => {
onBumpActor("start", "target", "actor", () => {}); }); });"#;
    assert!(
        assemble(source, bcmkn_compiler::default_template())
            .unwrap_err()
            .to_string()
            .contains("current-scene")
    );
}

#[test]
fn nested_recursive_shared_procedures_and_tell_contexts() {
    let source = r#"defineProc("inner", [], () => { rotateAround("--self", 90); });
defineProc("outer", [], () => { callProc("inner"); });
onStart(() => { callProc("outer"); });"#;
    assert_targets(
        &assemble(source, bcmkn_compiler::default_template()).unwrap(),
        &["nekoc-default-actor"],
    );
    let shared = r#"defineProc("p", [], () => { rotateAround("target", 90); });
sprite("target", {}, () => {});
sprite("a", {}, () => { onStart(() => { callProc("p"); }); });
sprite("b", {}, () => { onStart(() => { callProc("p"); }); });"#;
    assert_targets(
        &assemble(shared, bcmkn_compiler::default_template()).unwrap(),
        &["nekoc-actor-target"],
    );
    assert!(
        assemble(
            &shared.replace("rotateAround(\"target\"", "rotateAround(\"--self\""),
            bcmkn_compiler::default_template()
        )
        .unwrap_err()
        .to_string()
        .contains("differs")
    );
    let source = r#"defineProc("p", [], () => { rotateAround("--self", 90); ifThen(false, () => { callProc("p"); }); });
sprite("target", {}, () => {});
onStart(() => { tellAndWait("target", () => { callProc("p"); }); });"#;
    assert_targets(
        &assemble(source, bcmkn_compiler::default_template()).unwrap(),
        &["nekoc-actor-target"],
    );
    let source = r#"defineProc("p", [], () => { rotateAround("target", 90); });
screen("one", {}, () => { sprite("target", {}, () => { onStart(() => { callProc("p"); }); }); });
screen("two", {}, () => { sprite("target", {}, () => { onStart(() => { callProc("p"); }); }); });"#;
    assert!(
        assemble(source, bcmkn_compiler::default_template())
            .unwrap_err()
            .to_string()
            .contains("differs")
    );
    let source = r#"defineProc("unused", [], () => { rotateAround("--self", 90); });"#;
    assert!(
        assemble(source, bcmkn_compiler::default_template())
            .unwrap_err()
            .to_string()
            .contains("unused procedure")
    );
    let source = r#"defineProc("unused", [], () => { rotateAround("Sprite", 90); });"#;
    assert_targets(
        &assemble(source, bcmkn_compiler::default_template()).unwrap(),
        &["nekoc-default-actor"],
    );
}

#[test]
fn unsupported_targets_have_matching_check_build_source_locations_and_project_checks() {
    let dir = tempfile::tempdir().unwrap();
    let mut scene_only = bcmkn_compiler::default_template();
    scene_only["actors"]["actorsDict"] = json!({});
    scene_only["scenes"]["scenesDict"]["nekoc-scene-main"]["actorIds"] = json!([]);
    assert!(
        assemble(
            "onStart(() => { rotateAround(\"--self\", 1); });",
            scene_only.clone()
        )
        .unwrap_err()
        .to_string()
        .contains("definite actor")
    );
    let input = dir.path().join("scene.ts");
    let template = dir.path().join("template.bcmkn");
    std::fs::write(&input, "onStart(() => { rotateAround(\"--self\", 1); });").unwrap();
    std::fs::write(&template, serde_json::to_vec(&scene_only).unwrap()).unwrap();
    let report = check::check_file(
        &input,
        &check::CheckOptions {
            template: Some(&template),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!report.ok);
    assert_eq!(report.diagnostics[0].line, Some(1));
    assert_eq!(report.diagnostics[0].code, "invalid_actor_menu_target");
    for target in [
        "missing",
        "--mouse",
        "--random",
        "--edge",
        "nekoc-scene-main",
    ] {
        let source = format!(
            "onStart(() => {{\n  rotateAround(\"{target}\", 45);\n}});\nonBumpActor(\"start\", \"{target}\", \"actor\", () => {{}});"
        );
        let input = dir.path().join("knactortarget.ts");
        std::fs::write(&input, &source).unwrap();
        let report = check::check_file(&input, &check::CheckOptions::default()).unwrap();
        assert!(!report.ok);
        assert_eq!(report.diagnostics.len(), 2, "{:?}", report.diagnostics);
        let mut lines = report
            .diagnostics
            .iter()
            .map(|d| d.line.unwrap())
            .collect::<Vec<_>>();
        lines.sort();
        assert_eq!(lines, [2, 4]);
        for d in report.diagnostics {
            assert_eq!(d.code, "invalid_actor_menu_target");
            assert!(d.column.unwrap() > 0);
            assert!(d.message.contains("Use an explicit"));
        }
        let err = assemble(&source, bcmkn_compiler::default_template())
            .unwrap_err()
            .to_string();
        assert!(
            err.contains(":2:") && err.contains(":4:") && err.contains("invalid_actor_menu_target"),
            "{err}"
        );
    }
    let mut p = assemble(
        "onStart(() => { rotateAround(\"--self\", 90); });",
        bcmkn_compiler::default_template(),
    )
    .unwrap();
    p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"][0]["next"]["fields"]["sprite"] =
        json!("--self");
    let diagnostics = check::project_diagnostics(&p, Some("import.bcmkn")).unwrap();
    assert!(
        diagnostics
            .iter()
            .any(|d| d.code == "invalid_actor_menu_target")
    );
    // Imported procedure calls bind by mutation def_id, even when the visible
    // NAME is a label. A wrong field must not hide the procedure's actual scene.
    let mut imported = assemble(
        r#"defineProc("p", [], () => { rotateAround("target", 90); });
screen("one", {}, () => { sprite("unrelated", {}, () => {}); });
screen("two", {}, () => { sprite("target", {}, () => {});
sprite("caller", {}, () => { onStart(() => { callProc("p"); }); }); });"#,
        bcmkn_compiler::default_template(),
    )
    .unwrap();
    imported["actors"]["actorsDict"]["nekoc-actor-caller"]["nekoBlockJsonList"][0]["next"]["fields"]
        ["NAME"] = json!("display label");
    assert_eq!(validate::build_report(&imported).unwrap()["ok"], true);
    for target in ["Sprite", "--mouse", "missing", "nekoc-scene-main"] {
        p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"][0]["next"]["fields"]
            ["sprite"] = json!(target);
        assert_eq!(
            check::project_diagnostics(&p, None).unwrap()[0].code,
            "invalid_actor_menu_target"
        );
    }
}

#[test]
fn compiled_named_targets_operate_and_listen_to_the_same_actor_in_both_engine_tiers() {
    let source = r#"sprite("target", { x: 100, y: 0 }, () => {});
sprite("decoy", { x: -200, y: 0 }, () => {});
sprite("source", { x: 100, y: 100 }, self => {
  onStart(() => { self.rotateAround("target", 90); setVar("rotX", xOf("--self")); setVar("rotY", yOf("--self"));
    wait(0.05); self.moveTo(100, 0); wait(0.1); self.moveTo(300, 0); });
  onBumpActor("start", "target", "hit", () => { changeVar("hits", 1); setVar("hitX", bumpActorValue("hit", "x")); });
});"#;
    let p = assemble(source, bcmkn_compiler::default_template()).unwrap();
    for jit in [false, true] {
        let mut engine = Engine::new(Program::compile(&p).unwrap());
        if !jit {
            engine.disable_jit();
        }
        engine.use_virtual_clock();
        for style in [
            "nekoc-style-source",
            "nekoc-style-target",
            "nekoc-style-decoy",
        ] {
            engine.set_costume(
                style,
                nekoc::engine::Costume {
                    width: 40.0,
                    height: 40.0,
                    center_point: [0.0; 2],
                    mask: Some((4, 4, vec![255; 2])),
                    rgb: None,
                },
            );
        }
        engine.start();
        for _ in 0..60 {
            engine
                .advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
                .unwrap();
        }
        assert!((engine.variable_value("kn-var-rotX").number() - 200.0).abs() < 1e-8);
        assert!(engine.variable_value("kn-var-rotY").number().abs() < 1e-8);
        assert_eq!(
            engine.variable_value("kn-var-hits").text(),
            "1",
            "jit={jit}"
        );
        assert_eq!(
            engine.variable_value("kn-var-hitX").text(),
            "100",
            "jit={jit}"
        );
    }
}

#[test]
fn typed_self_api_and_procedure_rejections_retain_source_positions() {
    let dir = tempfile::tempdir().unwrap();
    for source in [
        "sprite(\"source\", {}, self => {\n onStart(() => {\n  self.rotateAround(\"missing\", 90);\n });\n});",
        "defineProc(\"p\", [], () => {\n rotateAround(\"missing\", 90);\n});\nonStart(() => { callProc(\"p\"); });",
    ] {
        let input = dir.path().join("knactortarget.ts");
        std::fs::write(&input, source).unwrap();
        let report = check::check_file(&input, &check::CheckOptions::default()).unwrap();
        assert!(!report.ok);
        let d = report
            .diagnostics
            .iter()
            .find(|d| d.code == "invalid_actor_menu_target")
            .unwrap();
        assert_eq!(
            d.line,
            Some(if source.starts_with("sprite") { 3 } else { 2 })
        );
        assert!(d.column.is_some());
    }
}
