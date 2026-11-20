use nekoc::{
    json::Json,
    player::{FrameInput, Handshake, InputEvent, Player, Reply, decode_frame, import},
    repro::{self, Config, Input, Package, ReplayOptions, Script, Status},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::{fs, path::Path, process::Command};

const ACTOR: &str = "nekoc-default-actor";

fn num(value: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":value}})
}

fn set(name: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":name},"inputs":{"value":value}})
}

fn change(name: &str) -> Value {
    set(
        name,
        json!({
            "type":"math_arithmetic","fields":{"type":"add"},"inputs":{
                "A":{"type":"variables_get","fields":{"variable":name}},"B":num(1.0)
            }
        }),
    )
}

fn chain(blocks: Vec<Value>) -> Value {
    blocks
        .into_iter()
        .rev()
        .reduce(|next, mut block| {
            block["next"] = next;
            block
        })
        .unwrap()
}

/// Repository-owned minimal program: randomness, wait, fast key edges, pointer,
/// swipe and draggable geometry all leave observable state.
fn project() -> Value {
    let mut project = Document::blank().value().clone();
    for name in [
        "random_before",
        "random_after",
        "wait_done",
        "down",
        "up",
        "click",
        "swipe",
        "mouse_x",
        "mouse_y",
    ] {
        project["variables"]["variablesDict"][name] =
            json!({"id":name,"name":name,"value":0,"isGlobal":true});
    }
    let random = || json!({"type":"random_num","inputs":{"A":num(1.0),"B":num(1_000_000.0)}});
    project["actors"]["actorsDict"][ACTOR]["draggable"] = json!(true);
    project["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([
        {"type":"on_running_group_activated","next":chain(vec![
            set("random_before", random()),
            json!({"type":"wait","inputs":{"time":num(0.05)}}),
            set("random_after", random()),
            set("wait_done", num(1.0)),
        ])},
        {"type":"on_keydown","fields":{"key":"65","type":"down"},"next":change("down")},
        {"type":"on_keydown","fields":{"key":"65","type":"up"},"next":change("up")},
        {"type":"sprite_on_tap","fields":{"sprite":"--self","type":"mouse_click"},"next":chain(vec![
            change("click"),
            set("mouse_x", json!({"type":"get_mouse_info","fields":{"type":"x"}})),
            set("mouse_y", json!({"type":"get_mouse_info","fields":{"type":"y"}})),
        ])},
        {"type":"on_swipe","fields":{"type":"left"},"statements":{"DO":change("swipe")}}
    ]);
    project
}

fn inputs() -> Vec<Value> {
    let mut frames = vec![json!({"pressed":[],"mouse":{"x":0,"y":0},"events":[]}); 12];
    frames[1] = json!({"pressed":[],"mouse":{"x":11,"y":-12},"events":[
        {"kind":"key","key":"65","down":true},
        {"kind":"key","key":"65","down":false},
        {"kind":"pointer","target":ACTOR,"state":"mouse_down","x":11,"y":-12}
    ]});
    frames[2] = json!({"pressed":["65"],"mouse":{"x":25,"y":-30},"events":[
        {"kind":"key","key":"65","down":true},
        {"kind":"drag","target":ACTOR,"x":25,"y":-30}
    ]});
    frames[3] = json!({"pressed":[],"mouse":{"x":25,"y":-30},"events":[
        {"kind":"key","key":"65","down":false},
        {"kind":"pointer","target":ACTOR,"state":"mouse_up","x":25,"y":-30},
        {"kind":"pointer","target":ACTOR,"state":"mouse_click","x":25,"y":-30},
        {"kind":"swipe","direction":"left"}
    ]});
    frames
}

fn handshake(source: &Value) -> Handshake {
    Handshake::parse(
        &json!({
            "nekoc_extension_handshake":1,"project":source,"extensions":[],
            "nekoc_repro":{"seed":"1"}
        })
        .to_string(),
    )
    .unwrap()
}

fn status(player: &mut Player) -> Status {
    let snapshot = player.engine().debug_snapshot();
    let Reply::Text(text) = player.handle(r#"{"repro_status":true}"#).unwrap() else {
        panic!("status must be a JSON reply");
    };
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 1);
    assert_eq!(value["repro_status"].as_object().unwrap().len(), 3);
    assert_eq!(snapshot, player.engine().debug_snapshot());
    let status: Status = serde_json::from_value(value["repro_status"].clone()).unwrap();
    assert_eq!(status, player.repro_status().unwrap());
    status
}

fn record(source: &Value, frames: &[Value]) -> (Package, Value) {
    let mut player = Player::load(handshake(source)).unwrap();
    let ready = player.ready()["repro"].clone();
    let mut last = status(&mut player);
    assert_eq!(last.frame_count, 0);
    assert_eq!(last.budget_yields, 0);
    let mut timeline = Vec::new();
    for (index, input) in frames.iter().enumerate() {
        let mut payload = input.clone();
        payload["dt"] = json!(repro::DT);
        let Reply::Binary(bytes) = player.handle(&payload.to_string()).unwrap() else {
            panic!("input must return a binary frame");
        };
        let (frame, _) = decode_frame(&bytes).unwrap();
        assert_eq!(frame["sequence"], index + 1);
        last = status(&mut player);
        assert_eq!(last.frame_count as usize, index + 1);
        timeline
            .push(json!({"frame":index + 1,"time_ms":index as f64 * 1000.0 / 60.0,"input":input}));
    }
    let package = Package::parse(
        &json!({
            "schema":repro::SCHEMA,"runner":ready["runner"],"work_sha256":ready["work_sha256"],
            "seed":ready["seed"],"dt":ready["dt"],"timeline":timeline,
            "diagnostics":{"state_sha256":last.state_sha256,"frame_count":last.frame_count,
                "budget_yields":last.budget_yields,
                "warnings":["audio","real_time","cloud","external_inputs","asset_geometry"],
                "input_queue":{"coalesced":0,"rejected":0},"interrupted":false}
        })
        .to_string(),
    )
    .unwrap();
    (package, player.engine().debug_snapshot())
}

fn cli(work: &Path, script: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nekoc"));
    command
        .arg("run")
        .arg(work)
        .arg("--input-script")
        .arg(script);
    command
}

fn write(path: &Path, value: &impl serde::Serialize) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

#[test]
fn recorded_player_frames_roundtrip_and_cli_replay_match() {
    let source = project();
    let (package, snapshot) = record(&source, &inputs());
    let decoded = Package::parse(&serde_json::to_string_pretty(&package).unwrap()).unwrap();
    let report = repro::replay(&source, &decoded, &ReplayOptions::default()).unwrap();
    assert_eq!(report["snapshot"], snapshot);
    assert_eq!(report["repro"]["matched"], true);
    assert_eq!(report["repro"]["frame_count"], 12);
    assert_eq!(
        report["repro"]["state_sha256"],
        package.diagnostics.state_sha256
    );
    assert_eq!(snapshot["variables"]["wait_done"], 1.0);
    assert!(snapshot["variables"]["random_before"].as_f64().unwrap() >= 1.0);
    assert!(snapshot["variables"]["random_after"].as_f64().unwrap() >= 1.0);
    assert!(snapshot["variables"]["down"].as_f64().unwrap() >= 1.0);
    assert!(snapshot["variables"]["up"].as_f64().unwrap() >= 1.0);
    assert_eq!(snapshot["variables"]["click"], 1.0);
    assert_eq!(snapshot["variables"]["swipe"], 1.0);
    assert_eq!(snapshot["variables"]["mouse_x"], 25.0);
    assert_eq!(snapshot["variables"]["mouse_y"], -30.0);
    assert_eq!(snapshot["actors"][ACTOR]["x"], 25.0);
    assert_eq!(snapshot["actors"][ACTOR]["y"], -30.0);
    let (_, again) = record(&source, &inputs());
    assert_eq!(snapshot, again);

    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work.json");
    let script = dir.path().join("repro.json");
    write(&work, &source);
    write(&script, &package);
    let output = cli(&work, &script).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let actual: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(actual, report);
}

#[test]
fn zero_frames_and_interrupted_acknowledged_prefix_are_replayable() {
    let source = project();
    for frames in [vec![], inputs()[..3].to_vec()] {
        let (mut package, snapshot) = record(&source, &frames);
        package.diagnostics.interrupted = true;
        package.diagnostics.input_queue.coalesced = 12;
        package.diagnostics.input_queue.rejected = 2;
        package.diagnostics.warnings.push("interrupted".into());
        package.diagnostics.warnings.push("omitted_inputs".into());
        let result = repro::replay(&source, &package, &ReplayOptions::default()).unwrap();
        assert_eq!(result["snapshot"], snapshot);
        assert_eq!(result["repro"]["frame_count"], frames.len());
        assert_eq!(result["repro"]["matched"], true);
        assert_eq!(result["repro"]["interrupted"], true);
        assert_eq!(result["repro"]["input_queue"]["rejected"], 2);
        assert_eq!(result["repro"]["input_queue"]["coalesced"], 12);
        assert_eq!(result["repro"]["complete_recording"], false);
    }
}

#[test]
fn replay_checks_fingerprint_runner_protocol_and_state() {
    let source = project();
    let (original, _) = record(&source, &inputs());
    for (field, replacement, error) in [
        (
            "/work_sha256",
            json!("0".repeat(64)),
            "fingerprint mismatch",
        ),
        ("/runner/name", json!("other"), "runner name mismatch"),
        ("/runner/version", json!("0.0.0"), "runner version mismatch"),
        ("/runner/protocol", json!(0), "protocol mismatch"),
        (
            "/diagnostics/state_sha256",
            json!("0".repeat(64)),
            "state digest mismatch",
        ),
        (
            "/diagnostics/budget_yields",
            json!(1),
            "budget_yields mismatch",
        ),
    ] {
        let mut value = serde_json::to_value(&original).unwrap();
        *value.pointer_mut(field).unwrap() = replacement;
        let package: Package = serde_json::from_value(value).unwrap();
        let actual = repro::replay(&source, &package, &ReplayOptions::default()).unwrap_err();
        assert!(format!("{actual:#}").contains(error), "{actual:#}");
    }
}

#[test]
fn malformed_packages_reject_order_limits_unknown_fields_and_values() {
    let (package, _) = record(&project(), &inputs()[..2]);
    let original = serde_json::to_value(package).unwrap();
    for (field, replacement) in [
        ("/schema", json!("nekoc-repro-v2")),
        ("/seed", json!(1)),
        ("/seed", json!("01")),
        ("/seed", json!("+1")),
        ("/seed", json!("18446744073709551616")),
        ("/work_sha256", json!("A".repeat(64))),
        ("/diagnostics/state_sha256", json!("bad")),
        ("/dt", json!(0.02)),
        ("/diagnostics/frame_count", json!(0)),
        ("/diagnostics/budget_yields", json!(3)),
        ("/diagnostics/warnings", json!(["user supplied detail"])),
        ("/diagnostics/input_queue/rejected", json!(-1)),
        ("/diagnostics/interrupted", json!("true")),
        ("/timeline/0/frame", json!(0)),
        ("/timeline/1/frame", json!(1)),
        ("/timeline/1/frame", json!(3)),
        ("/timeline/1/time_ms", json!(0)),
        ("/timeline/0/time_ms", json!(-1)),
        ("/timeline/0/input/pressed", json!(["256"])),
        ("/timeline/0/input/pressed", json!(["9"])),
        ("/timeline/0/input/pressed", json!(["065"])),
        ("/timeline/0/input/pressed", json!([65])),
        ("/timeline/0/input/pressed", json!(vec!["65"; 257])),
        ("/timeline/0/input/mouse/x", Value::Null),
        ("/timeline/0/input/mouse/y", json!("0")),
        ("/timeline/0/input/events", json!([{"kind":"unknown"}])),
        (
            "/timeline/0/input/events",
            json!([{"kind":"audio_done","id":1}]),
        ),
        (
            "/timeline/0/input/events",
            json!([{"kind":"key","key":"65","down":true,"answer":"secret"}]),
        ),
        (
            "/timeline/0/input/events",
            json!([{"kind":"key","key":"65","down":1}]),
        ),
        (
            "/timeline/0/input/events",
            json!([{"kind":"pointer","target":ACTOR,"state":"down","x":0,"y":0}]),
        ),
        (
            "/timeline/0/input/events",
            json!([{"kind":"drag","target":"x".repeat(4097),"x":0,"y":0}]),
        ),
        (
            "/timeline/0/input/events",
            json!([{"kind":"drag","target":ACTOR,"x":0}]),
        ),
        (
            "/timeline/0/input/events",
            json!([{"kind":"swipe","direction":"diagonal"}]),
        ),
        (
            "/timeline/0/input/events",
            json!(vec![json!({"kind":"swipe","direction":"left"}); 257]),
        ),
    ] {
        let mut bad = original.clone();
        *bad.pointer_mut(field).unwrap() = replacement;
        assert!(
            Package::parse(&bad.to_string()).is_err(),
            "accepted {field}: {bad}"
        );
    }
    for (object, field) in [
        ("", "project"),
        ("/runner", "extra"),
        ("/diagnostics", "raw_variables"),
        ("/diagnostics/input_queue", "extra"),
        ("/timeline/0", "events"),
        ("/timeline/0/input", "costumes"),
        ("/timeline/0/input", "dt"),
        ("/timeline/0/input/mouse", "extra"),
    ] {
        let mut bad = original.clone();
        bad.pointer_mut(object)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(field.into(), json!([]));
        assert!(
            Package::parse(&bad.to_string()).is_err(),
            "accepted {object}/{field}"
        );
    }
    let mut package: Package = serde_json::from_value(original).unwrap();
    package.timeline = vec![package.timeline[0].clone(); repro::MAX_FRAMES + 1];
    package.diagnostics.frame_count = package.timeline.len() as u32;
    assert!(
        package
            .validate()
            .unwrap_err()
            .to_string()
            .contains("36000")
    );
    assert_eq!(repro::parse_seed("18446744073709551615").unwrap(), u64::MAX);
    assert_eq!(repro::parse_seed("0").unwrap(), 0);
    assert!(Script::parse(&" ".repeat(repro::MAX_PACKAGE_BYTES + 1)).is_err());
}

#[test]
fn strict_live_and_typed_inputs_fail_without_advancing_or_mutating() {
    let source = project();
    let mut player = Player::load(handshake(&source)).unwrap();
    let initial = status(&mut player);
    let valid = inputs()[0].clone();
    for (key, value) in [
        ("dt", json!(0.1)),
        ("dt", Value::Null),
        ("coalesce", json!(true)),
        ("budget_ms", json!(1)),
        ("keys", json!(["65"])),
        ("costumes", json!([])),
        ("videos", json!([])),
        ("utc_offset", json!(0)),
        ("kn_microphone", json!({"status":"ready","value":1})),
        ("cloud", json!({"value":1})),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = value;
        assert!(player.handle(&invalid.to_string()).is_err(), "{invalid}");
        assert_eq!(status(&mut player), initial);
    }
    for event in [
        json!({"kind":"audio_done","id":1}),
        json!({"kind":"answer","id":1,"text":"test"}),
        json!({"kind":"extension_event","opcode":"test","value":1}),
        json!({"kind":"device_motion","x":0,"y":0,"z":0}),
        json!({"kind":"pointer","state":"mouse_down","x":0,"y":0}),
        json!({"kind":"swipe","direction":"unknown"}),
    ] {
        let mut invalid = valid.clone();
        invalid["events"] = json!([
            {"kind":"drag","target":ACTOR,"x":123,"y":456},event
        ]);
        assert!(player.handle(&invalid.to_string()).is_err());
        assert_eq!(status(&mut player), initial);
    }
    for text in [
        r#"{"repro_status":false}"#,
        r#"{"repro_status":true,"events":[]}"#,
        r#"{"debug_snapshot":true,"events":[]}"#,
        r#"{"pressed":[],"mouse":{"x":1e999,"y":0},"events":[]}"#,
        "{}",
    ] {
        assert!(player.handle(text).is_err(), "{text}");
        assert_eq!(status(&mut player), initial);
    }
    let typed = Input::from_json(&valid).unwrap().to_frame_input().unwrap();
    let mut invalid = typed.clone();
    invalid.events.push(InputEvent::AudioDone { id: 1 });
    assert!(player.step(&invalid).is_err());
    let mut invalid = typed.clone();
    invalid.mouse = Some((f64::NAN, 0.0));
    assert!(player.step(&invalid).is_err());
    let mut invalid = typed.clone();
    invalid.events.push(InputEvent::Drag {
        target: ACTOR.into(),
        x: f64::INFINITY,
        y: 0.0,
    });
    assert!(player.step(&invalid).is_err());
    let mut invalid = typed.clone();
    invalid.coalesce = true;
    assert!(player.step(&invalid).is_err());
    assert_eq!(status(&mut player), initial);
    // The optional transport dt is not required; typed and wire defaults agree.
    player.frame_json(&valid).unwrap();
    assert_eq!(status(&mut player).frame_count, 1);
    let mut input = typed;
    input.budget = std::time::Duration::ZERO;
    let frame = player.step(&input).unwrap();
    assert_eq!(frame.ticks, 1);
    player.recycle(frame);
    assert_eq!(status(&mut player).frame_count, 2);
}

#[test]
fn repro_handshake_isolates_setup_and_rejects_extensions() {
    let source = project();
    let called = std::cell::Cell::new(false);
    let mut player = Player::load_with(handshake(&source), |_| {
        called.set(true);
        anyhow::bail!("cloud setup must not run")
    })
    .unwrap();
    assert!(!called.get());
    assert_eq!(
        player.ready()["repro"]["runner"],
        serde_json::to_value(repro::Runner::default()).unwrap()
    );
    assert_eq!(player.ready()["repro"]["seed"], "1");
    assert_eq!(player.ready()["repro"]["dt"], repro::DT);
    assert_eq!(status(&mut player).frame_count, 0);

    let mut normal = Player::load_with(Handshake::new(Json::new(source.clone())), |_| {
        called.set(true);
        Ok(())
    })
    .unwrap();
    assert!(called.get());
    assert!(normal.ready().get("repro").is_none());
    assert!(normal.handle(r#"{"repro_status":true}"#).is_err());
    assert_eq!(normal.engine().debug_snapshot()["sequence"], 0);
    let input = FrameInput {
        dt: 0.1,
        ..Default::default()
    };
    normal.step(&input).unwrap();
    assert_eq!(normal.engine().debug_snapshot()["time"], 0.1);

    let mut envelope = json!({"nekoc_extension_handshake":1,"project":source,
        "extensions":[],"nekoc_repro":{"seed":"1"}});
    for config in [
        Value::Null,
        json!({"seed":1}),
        json!({"seed":"1","cloud":true}),
        json!({"seed":"-1"}),
    ] {
        envelope["nekoc_repro"] = config;
        assert!(Handshake::parse(&envelope.to_string()).is_err());
    }
    envelope["nekoc_repro"] = json!({"seed":"1"});
    envelope["extensions"] = json!([{
        "api_version":1,"opcode":"demo.double",
        "parameters":[{"name":"n","value_type":"number"}],
        "returns":"number","blocking":true,"network":false
    }]);
    let error = Player::load(Handshake::parse(&envelope.to_string()).unwrap())
        .err()
        .unwrap();
    assert!(error.to_string().contains("cannot use extensions"));
    let invalid = Handshake::new(Json::new(source)).with_repro(Config { seed: "bad".into() });
    assert!(Player::load(invalid).is_err());
}

#[test]
fn audio_waits_use_browser_mode_and_never_accept_audio_done() {
    let mut source = project();
    source["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([{
        "type":"on_running_group_activated","next":chain(vec![
            json!({"type":"play_audio_and_wait","inputs":{"audio_id":{"type":"text","fields":{"TEXT":"boom"}}}}),
            set("wait_done", num(1.0)),
        ])
    }]);
    let (package, snapshot) = record(&source, &vec![inputs()[0].clone(); 90]);
    assert_eq!(snapshot["variables"]["wait_done"], 0.0);
    assert_eq!(
        repro::replay(&source, &package, &ReplayOptions::default()).unwrap()["snapshot"],
        snapshot
    );
}

#[test]
fn native_and_browser_imports_have_stable_fingerprints_and_replay() {
    for source in [
        project(),
        serde_json::from_str(include_str!("../samples/kitten4-demo.bcm")).unwrap(),
    ] {
        let (first, _) = import(Json::new(source.clone())).unwrap();
        let (second, _) = import(first.clone()).unwrap();
        assert_eq!(
            repro::canonical_sha256(&first).unwrap(),
            repro::canonical_sha256(&second).unwrap()
        );
        let browser_roundtrip =
            nekoc::json::from_slice(&nekoc::json::to_vec(&second).unwrap()).unwrap();
        let (package, snapshot) = record(&browser_roundtrip, &inputs()[..6]);
        let result = repro::replay(&source, &package, &ReplayOptions::default()).unwrap();
        assert_eq!(result["snapshot"], snapshot);
    }
}

#[test]
fn canonical_hash_sorts_nested_keys_and_normalizes_browser_numbers() {
    use sha2::{Digest, Sha256};
    let a: Value = serde_json::from_str(r#"{"z":[1.0,-0.0,{"y":2e0,"x":1e21}],"a":true}"#).unwrap();
    let b: Value = serde_json::from_str(r#"{"a":true,"z":[1,0,{"x":1e21,"y":2}]}"#).unwrap();
    let expected = br#"{"a":true,"z":[1,0,{"x":1e+21,"y":2}]}"#;
    assert_eq!(
        repro::canonical_sha256(&a).unwrap(),
        format!("{:x}", Sha256::digest(expected))
    );
    assert_eq!(
        repro::canonical_sha256(&a).unwrap(),
        repro::canonical_sha256(&b).unwrap()
    );
    let original = json!({"n":9_007_199_254_740_993_u64});
    let browser = json!({"n":9_007_199_254_740_992.0});
    assert_eq!(
        repro::canonical_sha256(&original).unwrap(),
        repro::canonical_sha256(&browser).unwrap()
    );
    let mut deep = Value::Null;
    for _ in 0..4096 {
        let mut object = serde_json::Map::new();
        object.insert("next".into(), deep);
        deep = Value::Object(object);
    }
    let deep = Json::new(deep);
    assert_eq!(repro::canonical_sha256(&deep).unwrap().len(), 64);
}

#[test]
fn cli_rejects_overrides_and_bad_packages_without_legacy_fallback() {
    let source = project();
    let (package, _) = record(&source, &[]);
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work.json");
    let script = dir.path().join("repro.json");
    write(&work, &source);
    write(&script, &package);
    for args in [
        vec!["--ticks", "1"],
        vec!["--frames", "0"],
        vec!["--seed", "1"],
        vec!["--event", "key-down:a"],
        vec!["--cloud-memory", "--cloud-namespace", "test"],
        vec!["--cloud-namespace", "test"],
        vec!["--cloud-user", "anonymous"],
    ] {
        let output = cli(&work, &script).args(&args).output().unwrap();
        assert!(!output.status.success(), "accepted {args:?}");
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("conflicts"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let output = cli(&work, &script).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["repro"]["frame_count"], 0);
    for value in [
        json!({"schema":"nekoc-repro-v1","events":[]}),
        json!({"schema":"nekoc-input-v1","timeline":[]}),
        json!({"schema":"unknown","events":[]}),
    ] {
        write(&script, &value);
        let output = cli(&work, &script).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(Script::parse(&value.to_string()).is_err());
    }
    let mut bad = package;
    bad.work_sha256 = "0".repeat(64);
    write(&script, &bad);
    let output = cli(&work, &script).output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("fingerprint mismatch"));
}

#[test]
fn old_input_scripts_keep_their_engine_path_and_explicit_ticks() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work.json");
    let script = dir.path().join("input.json");
    write(&work, &project());
    let legacy = json!({"schema":"nekoc-input-v1","events":[
        {"frame":1,"time_ms":0,"type":"keydown","key_code":65},
        {"frame":2,"time_ms":17,"type":"keyup","key_code":65}
    ]});
    write(&script, &legacy);
    assert!(matches!(
        Script::parse(&legacy.to_string()).unwrap(),
        Script::Legacy(_)
    ));
    let output = cli(&work, &script)
        .args(["--ticks", "12", "--seed", "7"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["schema"], "nekoc-engine-run-v1");
    assert_eq!(report["ticks"], 12);
    assert_eq!(report["seed"], 7);
    assert!(report.get("repro").is_none());
    write(&script, &json!({"schema":"nekoc-input-v1","events":[]}));
    let output = cli(&work, &script).output().unwrap();
    assert!(output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ticks"], 1);
}

#[test]
fn repro_execution_normalizes_browser_numbers_not_only_the_fingerprint() {
    let mut source = project();
    source["variables"]["variablesDict"]["down"]["value"] = json!(-0.0);
    source["numeric_edges"] = serde_json::from_str::<Value>(
        r#"[-0.0,9007199254740993,18446744073709551615,5e-324,1.7976931348623157e308]"#,
    )
    .unwrap();
    source["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!([{
        "type":"on_running_group_activated","next":set("wait_done", json!({
            "type":"text_join","mutation":"<mutation items=\"2\"></mutation>","inputs":{
                "ADD0":{"type":"text","fields":{"TEXT":"result="}},
                "ADD1":{"type":"math_arithmetic","fields":{"type":"divide"},"inputs":{
                    "A":num(1.0),"B":{"type":"variables_get","fields":{"variable":"down"}}
                }}
            }
        }))
    }]);
    let mut browser = source.clone();
    repro::normalize_browser_numbers(&mut browser).unwrap();
    assert!(
        !browser["numeric_edges"][0]
            .as_f64()
            .unwrap()
            .is_sign_negative()
    );
    assert_eq!(
        browser["numeric_edges"][1].as_f64(),
        Some(9007199254740992.0)
    );
    assert_eq!(
        browser["numeric_edges"][3].as_f64(),
        Some(f64::from_bits(1))
    );
    assert_eq!(browser["numeric_edges"][4].as_f64(), Some(f64::MAX));
    let (package, snapshot) = record(&browser, &inputs()[..1]);
    assert_eq!(snapshot["variables"]["wait_done"], "result=Infinity");
    assert_eq!(
        repro::replay(&source, &package, &ReplayOptions::default()).unwrap()["snapshot"],
        snapshot
    );
    let ordinary = nekoc::cli_run::run(&source, 1, &[], 1, &Default::default()).unwrap();
    assert_eq!(ordinary["variables"]["wait_done"], "result=-Infinity");
}
