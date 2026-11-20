use nekoc::{
    engine::{Engine, Frame, Program},
    studio::document::Document,
};
use serde_json::{Value, json};
use std::time::Duration;

fn step(vm: &mut Engine, dt: f64) -> Frame {
    vm.advance(dt, 100_000, Duration::from_secs(2)).unwrap()
}
fn text(value: &str) -> Value {
    json!({"type":"text","fields":{"TEXT":value}})
}
fn audio(kind: &str, target: &str) -> Value {
    json!({"type":kind,"inputs":{"audio_id":text(target)}})
}
fn log(value: &str) -> Value {
    json!({"type":"console_log","inputs":{"console_log":text(value)}})
}
fn chain(nodes: Vec<Value>) -> Value {
    nodes.into_iter().rev().fold(Value::Null, |next, mut node| {
        if !next.is_null() {
            node["next"] = next;
        }
        node
    })
}
fn start(nodes: Vec<Value>) -> Value {
    json!({"type":"on_running_group_activated","next":chain(nodes)})
}
fn project(roots: Vec<Value>) -> Value {
    let mut p = Document::blank().value().clone();
    p["audios"] = json!({"audiosDict":{
        "a":{"id":"a","name":"tone A","duration":1},
        "b":{"id":"b","name":"tone B","duration":1}
    },"sortList":["a","b"]});
    p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!(roots);
    p
}
fn engine(p: &Value, browser: bool, interpreter: bool) -> Engine {
    let mut vm = Engine::new(Program::compile(p).unwrap());
    if browser {
        vm.use_browser_audio();
    }
    if interpreter {
        vm.disable_jit();
    }
    vm.start();
    vm
}

#[test]
fn resource_stop_releases_overlap_but_keeps_other_resources_waiting() {
    for browser in [false, true] {
        for interpreter in [false, true] {
            let p = project(vec![
                start(vec![audio("play_audio_and_wait", "a"), log("a1")]),
                start(vec![audio("play_audio_and_wait", "a"), log("a2")]),
                start(vec![audio("play_audio_and_wait", "b"), log("b")]),
                start(vec![audio("stop_audio", "tone A")]),
            ]);
            let mut vm = engine(&p, browser, interpreter);
            let first = step(&mut vm, 0.0);
            assert!(first.logs.is_empty());
            assert_eq!(first.audio_commands.len(), 4);
            assert_eq!(step(&mut vm, 0.0).logs, ["a1", "a2"]);
            if browser {
                for command in &first.audio_commands[..2] {
                    vm.audio_finished(command.wait.unwrap());
                }
                assert!(step(&mut vm, 10.0).logs.is_empty());
                vm.audio_finished(first.audio_commands[2].wait.unwrap());
                assert_eq!(step(&mut vm, 0.0).logs, ["b"]);
            } else {
                // advance() caps each simulation delta at 250 ms.
                for _ in 0..3 {
                    assert!(step(&mut vm, 0.25).logs.is_empty());
                }
                assert_eq!(step(&mut vm, 0.25).logs, ["b"]);
            }
        }
    }
}

#[test]
fn ordinary_play_does_not_block_and_waits_remain_independent() {
    let p = project(vec![
        start(vec![audio("play_audio", "a"), log("ordinary")]),
        start(vec![audio("play_audio_and_wait", "a"), log("first")]),
        start(vec![audio("play_audio_and_wait", "a"), log("second")]),
    ]);
    for interpreter in [false, true] {
        let mut vm = engine(&p, true, interpreter);
        let frame = step(&mut vm, 0.0);
        assert_eq!(frame.logs, ["ordinary"]);
        assert!(frame.audio_commands[0].wait.is_none());
        let first = frame.audio_commands[1].wait.unwrap();
        let second = frame.audio_commands[2].wait.unwrap();
        assert_ne!(first, second);
        vm.audio_finished(second);
        assert_eq!(step(&mut vm, 0.0).logs, ["second"]);
        vm.audio_finished(second);
        assert!(step(&mut vm, 0.0).logs.is_empty());
        vm.audio_finished(first);
        assert_eq!(step(&mut vm, 0.0).logs, ["first"]);
    }
}

#[test]
fn headless_unknown_duration_and_offline_speech_cannot_deadlock() {
    let mut p = project(vec![start(vec![
        audio("play_audio_and_wait", "a"),
        json!({"type":"play_word_audio_wait","inputs":{"text":text("hello")}}),
        log("continued"),
    ])]);
    p["audios"]["audiosDict"]["a"]
        .as_object_mut()
        .unwrap()
        .remove("duration");
    for interpreter in [false, true] {
        let mut vm = engine(&p, false, interpreter);
        assert!(step(&mut vm, 0.0).logs[0].contains("时长未知"));
        let next = step(&mut vm, 0.0);
        assert_eq!(next.logs, ["continued"]);
        assert!(next.speech_commands[0].wait.is_none());
    }
}

#[test]
fn sound_color_is_shared_tts_configuration_and_restart_resets_it() {
    let p = project(vec![
        json!({"type":"on_keydown","fields":{"key":"66","type":"down"},"next":
            {"type":"sound_color","fields":{"sound_color_per":"3"},
            "mutation":"<mutation sound_color_speed=\"7\" sound_color_pitch=\"12\" sound_color_volume=\"5\"/>"}}),
        json!({"type":"on_keydown","fields":{"key":"65","type":"down"},"next":
            {"type":"play_word_audio_wait","inputs":{"text":text("configured")}}}),
    ]);
    for interpreter in [false, true] {
        let mut vm = engine(&p, true, interpreter);
        // Configuration belongs to the runtime, not to the configuring thread.
        vm.key("66");
        let configured = step(&mut vm, 0.0);
        assert!(configured.audio_commands.is_empty());
        vm.key("65");
        let speech = step(&mut vm, 0.0).speech_commands.remove(0);
        assert_eq!(speech.config, [3.0, 7.0, 12.0, 5.0]);
        let old_wait = speech.wait.unwrap();
        vm.start();
        step(&mut vm, 0.0);
        vm.key("65");
        let new = step(&mut vm, 0.0).speech_commands.remove(0);
        assert_ne!(old_wait, new.wait.unwrap());
        assert_eq!(new.config, [0.0, 10.0, 10.0, 10.0]);
        vm.audio_finished(old_wait);
        vm.audio_finished(new.wait.unwrap());
    }
}

#[test]
fn compatibility_volume_and_rate_use_percentage_points_without_restarting_waits() {
    let property = |key: &str, change: bool, value: Value| {
        json!({"type":if change {"change_volume_or_rate_2"} else {"set_volume_or_rate_2"},
            "fields":{"audio_key":key,"increase":"decrease"},
            "inputs":{"audio":text("a"),"audio_value":value}})
    };
    let number = |n: f64| json!({"type":"math_number","fields":{"NUM":n}});
    let p = project(vec![start(vec![
        property("volume", false, number(25.0)),
        property("volume", true, number(10.0)),
        property("rate", false, number(200.0)),
        property("rate", false, text("300")), // official number check, no coercion
        audio("play_audio_and_wait", "a"),
        log("done"),
    ])]);
    for interpreter in [false, true] {
        let mut vm = engine(&p, false, interpreter);
        let frame = step(&mut vm, 0.0);
        assert_eq!(frame.audio_commands.len(), 4);
        let volume = frame.audio_commands[0].property.as_ref().unwrap();
        assert!(!volume.rate && !volume.change);
        assert_eq!(volume.value, 0.25);
        let decrease = frame.audio_commands[1].property.as_ref().unwrap();
        assert!(!decrease.rate && decrease.change);
        assert_eq!(decrease.value, -0.1);
        let rate = frame.audio_commands[2].property.as_ref().unwrap();
        assert!(rate.rate && !rate.change);
        assert_eq!(rate.value, 2.0);
        assert!(step(&mut vm, 0.25).logs.is_empty());
        assert_eq!(step(&mut vm, 0.25).logs, ["done"]);
    }
}
