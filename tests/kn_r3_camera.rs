use nekoc::{
    engine::{Engine, PanelNotice, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

fn chain(blocks: Vec<Value>) -> Value {
    blocks
        .into_iter()
        .rev()
        .reduce(|tail, mut head| {
            head["next"] = tail;
            head
        })
        .unwrap()
}

fn document(blocks: Vec<Value>) -> Value {
    let mut doc = Document::blank().value().clone();
    doc["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([
        {"type":"on_running_group_activated","next":chain(blocks)}
    ]);
    doc
}

fn camera(kind: &str, status: &str) -> Value {
    json!({"type":kind,"fields":{"camera_status":status}})
}

fn alpha(kind: &str, value: f64) -> Value {
    json!({"type":kind,"inputs":{"camera_alpha":{"type":"math_number","fields":{"NUM":value}}}})
}

fn log(value: &str) -> Value {
    json!({"type":"console_log","inputs":{"console_log":{"type":"text","fields":{"TEXT":value}}}})
}

fn tick(vm: &mut Engine) -> Vec<String> {
    vm.advance(1.0 / 60.0, 100_000, Duration::from_secs(2))
        .unwrap()
        .logs
}

fn checkpoint(vm: &mut Engine, expected: &str) {
    // Test eventual continuation, not browser microtask == one VM frame.
    for _ in 0..12 {
        let logs = tick(vm);
        if !logs.is_empty() {
            assert_eq!(logs, [expected]);
            return;
        }
    }
    panic!("camera script did not reach {expected}");
}

#[test]
fn missing_camera_yields_then_continues_both_aliases_and_other_threads() {
    for kind in ["open_hide_camera", "open_close_webcam"] {
        for jit in [false, true] {
            let mut doc = document(vec![log("before"), camera(kind, "turn_on"), log("after")]);
            doc["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"]
                .as_array_mut()
                .unwrap()
                .push(json!({"type":"on_running_group_activated","next":log("independent")}));
            let mut vm = Engine::new(Program::compile(&doc).unwrap());
            if !jit {
                vm.disable_jit();
            }
            vm.start();
            let first = tick(&mut vm);
            assert!(first.contains(&"before".into()));
            assert!(first.contains(&"independent".into()));
            assert!(!first.contains(&"after".into()));
            checkpoint(&mut vm, "after");
            assert_eq!(vm.take_kn_panel_notices(), [PanelNotice::CameraUnavailable]);
            assert!(vm.take_kn_panel_notices().is_empty());
        }
    }
}

#[test]
fn failed_open_preserves_alpha_until_close_and_aliases_share_failure_state() {
    for (open, close) in [
        ("open_hide_camera", "open_close_webcam"),
        ("open_close_webcam", "open_hide_camera"),
    ] {
        let mut vm = Engine::new(
            Program::compile(&document(vec![
                alpha("set_camera_alpha", 37.5),
                log("alpha"),
                camera(open, "turn_on"),
                log("opened"),
                camera(close, "turn_off"),
                log("closed"),
                alpha("set_webcam_alpha", 25.0),
                log("alpha-again"),
                camera(close, "turn_off"),
                log("done"),
            ]))
            .unwrap(),
        );
        vm.start();
        checkpoint(&mut vm, "alpha");
        assert_eq!(vm.kn_camera_alpha(), 0.375);
        // The next command may execute in the checkpoint's same update.
        checkpoint(&mut vm, "opened");
        assert_eq!(vm.kn_camera_alpha(), 0.6);
        checkpoint(&mut vm, "closed");
        assert_eq!(vm.kn_camera_alpha(), 0.25);
        checkpoint(&mut vm, "alpha-again");
        assert_eq!(vm.kn_camera_alpha(), 0.25);
        checkpoint(&mut vm, "done");
    }
}

#[test]
fn repeated_failed_opens_deduplicate_notices_and_restart_clears_failure() {
    let mut vm = Engine::new(
        Program::compile(&document(vec![
            alpha("set_webcam_alpha", 25.0),
            camera("open_hide_camera", "turn_off"),
            log("closed"),
            camera("open_hide_camera", "turn_on"),
            camera("open_close_webcam", "turn_on"),
            log("done"),
        ]))
        .unwrap(),
    );
    vm.start();
    checkpoint(&mut vm, "closed");
    assert_eq!(vm.kn_camera_alpha(), 0.25);
    checkpoint(&mut vm, "done");
    assert_eq!(vm.take_kn_panel_notices(), [PanelNotice::CameraUnavailable]);
    vm.start();
    assert_eq!(vm.kn_camera_alpha(), 0.6);
    assert!(vm.take_kn_panel_notices().is_empty());
    checkpoint(&mut vm, "closed");
    assert_eq!(
        vm.kn_camera_alpha(),
        0.25,
        "restart must clear failed-open state"
    );
}

#[test]
fn malformed_camera_field_is_not_silently_treated_as_close() {
    for kind in ["open_hide_camera", "open_close_webcam"] {
        let error = Program::compile(&document(vec![camera(kind, "hide")]))
            .err()
            .unwrap();
        assert!(format!("{error:#}").contains("camera_status"));
    }
}
