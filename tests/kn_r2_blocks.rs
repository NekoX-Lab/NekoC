//! Original minimal KN fixtures; no third-party works are embedded here.
use nekoc::{
    engine::{Engine, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

const ACTOR: &str = "nekoc-default-actor";

fn num(value: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":value}})
}
fn set(name: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":name},"inputs":{"value":value}})
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
fn start(blocks: Vec<Value>) -> Value {
    json!({"type":"on_running_group_activated","next":chain(blocks)})
}
fn project(roots: Vec<Value>) -> Value {
    let mut p = Document::blank().value().clone();
    p["actors"]["actorsDict"][ACTOR]["position"] = json!({"x":10,"y":20});
    p["actors"]["actorsDict"][ACTOR]["nekoBlockJsonList"] = json!(roots);
    for name in ["after", "other", "calls"] {
        p["variables"]["variablesDict"][name] =
            json!({"id":name,"name":name,"type":"any","value":0,"isGlobal":true});
    }
    p
}
fn engine(p: &Value, jit: bool) -> Engine {
    let mut vm = Engine::new(Program::compile(p).unwrap());
    vm.use_virtual_clock();
    if !jit {
        vm.disable_jit();
    }
    vm.start();
    vm
}
fn tick(vm: &mut Engine, dt: f64) {
    vm.advance(dt, 100_000, Duration::from_secs(2)).unwrap();
}
fn position(vm: &Engine, actor: &str) -> (f64, f64) {
    let snapshot = vm.debug_snapshot();
    let a = &snapshot["actors"][actor];
    (a["x"].as_f64().unwrap(), a["y"].as_f64().unwrap())
}
fn movement(kind: &str, value: Value) -> Value {
    json!({"type":kind,"inputs":{"steps":value}})
}

#[test]
fn kids_four_directions_use_25_pixel_units_and_block_only_their_script() {
    // Pinned official kids constants: 25 px/step, 200 px/s (0.125s/step).
    for jit in [false, true] {
        for (kind, dx, dy) in [
            ("kids_move_right", 50.0, 0.0),
            ("kids_move_left", -50.0, 0.0),
            ("kids_move_up", 0.0, 50.0),
            ("kids_move_down", 0.0, -50.0),
        ] {
            let p = project(vec![
                start(vec![movement(kind, num(2.0)), set("after", num(1.0))]),
                start(vec![set("other", num(1.0))]),
            ]);
            let mut vm = engine(&p, jit);
            tick(&mut vm, 0.0);
            assert_eq!(position(&vm, ACTOR), (10.0, 20.0), "{kind}");
            assert_eq!(vm.variable_value("after").number(), 0.0);
            assert_eq!(vm.variable_value("other").number(), 1.0);
            tick(&mut vm, 0.125);
            assert_eq!(position(&vm, ACTOR), (10.0 + dx / 2.0, 20.0 + dy / 2.0));
            assert_eq!(vm.variable_value("after").number(), 0.0);
            tick(&mut vm, 0.125);
            assert_eq!(position(&vm, ACTOR), (10.0 + dx, 20.0 + dy));
            assert_eq!(vm.variable_value("after").number(), 1.0);
        }
    }
}

#[test]
fn kids_negative_steps_are_immediate_and_invalid_numbers_do_not_poison_positions() {
    for kind in [
        "kids_move_right",
        "kids_move_left",
        "kids_move_up",
        "kids_move_down",
    ] {
        for value in [
            num(0.0),
            json!({"type":"text","fields":{"TEXT":"not a number"}}),
            json!({"type":"math_number","fields":{"NUM":"Infinity"}}),
        ] {
            let mut vm = engine(
                &project(vec![start(vec![
                    movement(kind, value),
                    set("after", num(1.0)),
                ])]),
                false,
            );
            tick(&mut vm, 0.0);
            assert_eq!(position(&vm, ACTOR), (10.0, 20.0));
            assert_eq!(vm.variable_value("after").number(), 1.0);
        }
    }
    let mut vm = engine(
        &project(vec![start(vec![
            movement("kids_move_right", num(-2.0)),
            set("after", num(1.0)),
        ])]),
        false,
    );
    tick(&mut vm, 0.0);
    assert_eq!(position(&vm, ACTOR), (-40.0, 20.0));
    assert_eq!(vm.variable_value("after").number(), 1.0);
}

#[test]
fn kids_numeric_text_is_coerced_after_warning_and_steps_are_evaluated_once() {
    // Official movement warns for text, but does NOT return before steps * 25.
    let steps = json!({"type":"procedures_2_callreturn","fields":{"NAME":"steps"}});
    let mut p = project(vec![start(vec![
        movement("kids_move_right", steps),
        set("after", num(1.0)),
    ])]);
    p["procedures"]["proceduresDict"]["steps"] = json!({"id":"steps","name":"steps","params":[],"return":true,
    "nekoBlockJsonList":[{"type":"procedures_2_defnoreturn","fields":{"NAME":"steps"},"statements":{"STACK":chain(vec![
        json!({"type":"change_variables","fields":{"variable":"calls","method":"increase"},"inputs":{"value":num(1.0)}}),
        json!({"type":"procedures_2_return_value","mutation":"<mutation items=\"1\"></mutation>","inputs":{"VALUE":{"type":"text","fields":{"TEXT":"2"}}}})
    ])}}]});
    let mut vm = engine(&p, false);
    tick(&mut vm, 0.0);
    tick(&mut vm, 0.125);
    tick(&mut vm, 0.125);
    assert_eq!(position(&vm, ACTOR), (60.0, 20.0));
    assert_eq!(vm.variable_value("calls").number(), 1.0);
}

#[test]
fn kids_incremental_motion_preserves_concurrent_changes_until_final_snap() {
    let mut vm = engine(
        &project(vec![
            start(vec![movement("kids_move_right", num(4.0))]),
            start(vec![
                json!({"type":"wait","inputs":{"time":num(0.1)}}),
                json!({"type":"self_move_to","inputs":{"x":num(100.0),"y":num(90.0)}}),
            ]),
        ]),
        false,
    );
    tick(&mut vm, 0.0);
    tick(&mut vm, 0.125);
    assert_eq!(position(&vm, ACTOR), (100.0, 90.0));
    tick(&mut vm, 0.125);
    assert_eq!(position(&vm, ACTOR), (125.0, 90.0));
    tick(&mut vm, 0.25);
    assert_eq!(position(&vm, ACTOR), (110.0, 90.0));
}

#[test]
fn kids_fractional_steps_and_sequential_axes_keep_heading_and_restart_cleanly() {
    let mut p = project(vec![start(vec![
        movement("kids_move_right", num(0.5)),
        movement("kids_move_up", num(1.0)),
        set("after", num(1.0)),
    ])]);
    p["actors"]["actorsDict"][ACTOR]["rotation"] = json!(37.0);
    let mut vm = engine(&p, true);
    tick(&mut vm, 0.0);
    let heading = vm.debug_snapshot()["actors"][ACTOR]["direction"].clone();
    tick(&mut vm, 0.0625);
    assert_eq!(position(&vm, ACTOR), (22.5, 20.0));
    assert_eq!(vm.variable_value("after").number(), 0.0);
    tick(&mut vm, 0.125);
    assert_eq!(position(&vm, ACTOR), (22.5, 45.0));
    assert_eq!(vm.variable_value("after").number(), 1.0);
    assert_eq!(vm.debug_snapshot()["actors"][ACTOR]["direction"], heading);
    vm.start();
    tick(&mut vm, 0.0);
    assert_eq!(position(&vm, ACTOR), (10.0, 20.0));
    assert_eq!(vm.variable_value("after").number(), 0.0);
    tick(&mut vm, 0.0625);
    assert_eq!(position(&vm, ACTOR), (22.5, 20.0));
}

#[test]
fn kids_missing_steps_and_unknown_siblings_remain_diagnostic() {
    for block in [
        json!({"type":"kids_move_right"}),
        json!({"type":"kids_future_move","inputs":{"steps":num(1.0)}}),
    ] {
        assert!(Program::compile(&project(vec![start(vec![block])])).is_err());
    }
}

#[test]
fn headless_ai_uses_explicit_offline_rejection_and_preserves_other_scripts() {
    use nekoc::{cli_run, cloud::CloudOptions, engine::PanelNotice};
    let p = project(vec![
        start(vec![
            json!({"type":"ai_chat_ask","inputs":{"text":{"type":"text","fields":{"TEXT":"hello"}}}}),
            set("after", num(1.0)),
        ]),
        start(vec![set("other", num(1.0))]),
    ]);
    let snapshot = cli_run::run(&p, 12, &[], 1, &CloudOptions::default()).unwrap();
    assert_eq!(snapshot["variables"]["after"], 1.0);
    assert_eq!(snapshot["variables"]["other"], 1.0);
    assert_eq!(snapshot["kn_panel_notices"], json!(["ai_offline"]));
    // The library default still refuses to pretend an unspecified host is offline.
    let mut strict = engine(&p, false);
    assert!(
        strict
            .advance(0.0, 100_000, Duration::from_secs(2))
            .is_err()
    );
    let mut explicit = engine(&p, false);
    explicit.set_kn_offline_anonymous(true);
    for _ in 0..12 {
        tick(&mut explicit, 1.0 / 60.0);
    }
    assert_eq!(explicit.take_kn_panel_notices(), [PanelNotice::AiOffline]);
    assert_eq!(explicit.variable_value("after").number(), 1.0);
}

#[test]
fn every_ai_command_exposes_rejection_without_fabricating_results() {
    use nekoc::engine::PanelNotice;
    for (kind, notice) in [
        ("ai_chat_ask", PanelNotice::AiOffline),
        ("new_conversation", PanelNotice::AiOffline),
        ("set_system_preset", PanelNotice::AiOffline),
        ("ai_text_actor", PanelNotice::AiOffline),
        ("ai_text_photo", PanelNotice::AiOffline),
        ("enable_face_detect_by_actor", PanelNotice::AiLoginRequired),
        ("enable_face_detect_by_photo", PanelNotice::AiLoginRequired),
        (
            "enable_object_detect_by_actor",
            PanelNotice::AiLoginRequired,
        ),
        (
            "enable_object_detect_by_photo",
            PanelNotice::AiLoginRequired,
        ),
        ("evaluate_actor_style", PanelNotice::AiMissingModel),
        ("evaluate_camera", PanelNotice::AiMissingModel),
        ("evaluate_photo", PanelNotice::AiMissingModel),
    ] {
        let command = json!({"type":kind,"fields":{"sprite":"--self","model_id":"?"},"inputs":{"text":{"type":"text","fields":{"TEXT":"test"}}}});
        let mut vm = engine(
            &project(vec![
                start(vec![command, set("after", num(1.0))]),
                start(vec![set("other", num(1.0))]),
            ]),
            false,
        );
        vm.set_kn_offline_anonymous(true);
        for _ in 0..12 {
            tick(&mut vm, 1.0 / 60.0);
        }
        assert_eq!(vm.take_kn_panel_notices(), [notice], "{kind}");
        assert_eq!(vm.variable_value("after").number(), 1.0, "{kind}");
        assert_eq!(vm.variable_value("other").number(), 1.0, "{kind}");
    }
}

#[test]
fn translation_failure_is_empty_not_echo_and_blank_text_needs_no_host() {
    use nekoc::{cli_run, cloud::CloudOptions};
    for text in ["original text", "  "] {
        let translate = |kind| json!({"type":kind,"inputs":{"text":{"type":"text","fields":{"TEXT":text}},"language":{"type":"text","fields":{"TEXT":"en"}}}});
        let p = project(vec![
            start(vec![
                translate("translate"),
                set("calls", translate("translate_result")),
                set("after", num(1.0)),
            ]),
            start(vec![set("other", num(1.0))]),
        ]);
        let snapshot = cli_run::run(&p, 12, &[], 1, &CloudOptions::default()).unwrap();
        assert_eq!(snapshot["variables"]["calls"], "");
        assert_eq!(snapshot["variables"]["after"], 1.0);
        assert_eq!(snapshot["variables"]["other"], 1.0);
        assert_eq!(
            snapshot["kn_panel_notices"],
            if text.trim().is_empty() {
                json!([])
            } else {
                json!(["translation_unavailable"])
            }
        );
    }
}

#[test]
fn camera_unavailable_is_explicit_recoverable_and_deduplicated() {
    use nekoc::{cli_run, cloud::CloudOptions, engine::PanelNotice};
    for jit in [false, true] {
        for kind in ["open_hide_camera", "open_close_webcam"] {
            let camera = |status| json!({"type":kind,"fields":{"camera_status":status}});
            let p = project(vec![
                start(vec![
                    json!({"type":"set_camera_alpha","inputs":{"camera_alpha":num(37.5)}}),
                    camera("turn_on"),
                    camera("turn_on"),
                    camera("turn_off"),
                    set("after", num(1.0)),
                ]),
                start(vec![set("other", num(1.0))]),
            ]);
            let mut vm = engine(&p, jit);
            tick(&mut vm, 0.0);
            assert_eq!(vm.variable_value("after").number(), 0.0);
            assert_eq!(vm.variable_value("other").number(), 1.0);
            for _ in 0..12 {
                tick(&mut vm, 1.0 / 60.0);
            }
            assert_eq!(vm.variable_value("after").number(), 1.0, "{kind}");
            assert_eq!(vm.kn_camera_alpha(), 0.6);
            assert_eq!(vm.take_kn_panel_notices(), [PanelNotice::CameraUnavailable]);
            assert!(vm.take_kn_panel_notices().is_empty());
            // Restart resets notices and the offline capture state.
            vm.start();
            for _ in 0..12 {
                tick(&mut vm, 1.0 / 60.0);
            }
            assert_eq!(vm.take_kn_panel_notices(), [PanelNotice::CameraUnavailable]);
            let snapshot = cli_run::run(&p, 12, &[], 1, &CloudOptions::default()).unwrap();
            assert_eq!(snapshot["variables"]["after"], 1.0);
            assert_eq!(snapshot["variables"]["other"], 1.0);
            assert_eq!(snapshot["kn_panel_notices"], json!(["camera_unavailable"]));
        }
    }
}

#[test]
fn camera_default_host_recovers_and_invalid_switch_is_diagnostic() {
    for kind in ["open_hide_camera", "open_close_webcam"] {
        let p = project(vec![start(vec![
            json!({"type":kind,"fields":{"camera_status":"turn_on"}}),
        ])]);
        let mut vm = engine(&p, false);
        vm.advance(0.0, 100_000, Duration::from_secs(2)).unwrap();
        assert_eq!(vm.take_kn_panel_notices(), [nekoc::engine::PanelNotice::CameraUnavailable]);
        let p = project(vec![start(vec![
            json!({"type":kind,"fields":{"camera_status":"unknown"}}),
        ])]);
        assert!(Program::compile(&p).is_err());
    }
}

#[test]
fn disabled_code_placeholder_skips_sockets_and_keeps_its_continuation() {
    for jit in [false, true] {
        let placeholder = json!({"type":"bcm_translator_text_execution_block","disabled":true,
            "mutation":"<mutation items=\"1\">authored unmatched call</mutation>",
            "inputs":{"ADD0":{"type":"r2_unregistered_expression"}},
            "statements":{"STACK":{"type":"r2_unregistered_statement"}}});
        let p = project(vec![
            start(vec![placeholder, set("after", num(1.0))]),
            start(vec![set("other", num(1.0))]),
        ]);
        let mut vm = engine(&p, jit);
        tick(&mut vm, 0.0);
        assert_eq!(vm.variable_value("after").number(), 1.0);
        assert_eq!(vm.variable_value("other").number(), 1.0);
        assert!(vm.take_kn_panel_notices().is_empty());
    }
}

#[test]
fn enabled_code_placeholder_and_unknown_disabled_blocks_are_not_silenced() {
    for disabled in [None, Some(json!(false)), Some(json!("true"))] {
        let mut block =
            json!({"type":"bcm_translator_text_execution_block","id":"authored-placeholder"});
        if let Some(disabled) = disabled {
            block["disabled"] = disabled;
        }
        let result = Program::compile(&project(vec![start(vec![block])]));
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("enabled placeholders must fail"),
        };
        let message = format!("{error:#}");
        assert!(message.contains("no matching block"), "{message}");
        assert!(message.contains("authored-placeholder"), "{message}");
    }
    let block = json!({"type":"r2_unknown_statement","disabled":true});
    assert!(Program::compile(&project(vec![start(vec![block])])).is_err());
}
