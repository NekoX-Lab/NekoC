use nekoc::engine::{Engine, Program};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;

#[test]
fn continuous_positive_waits_match_official_millisecond_clock() {
    let report: Value =
        serde_json::from_str(include_str!("../docs/kn-r3-wait-precision.json")).unwrap();
    for (name, case) in report["cases"].as_object().unwrap() {
        let bytes =
            std::fs::read(format!("tests/fixtures/kn-r3-sched/precision/{name}.bcmkn")).unwrap();
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), case["sha256"]);
        let project: Value = serde_json::from_slice(&bytes).unwrap();
        for (jit, default_sixty_hz) in [(false, false), (true, false), (false, true), (true, true)]
        {
            if default_sixty_hz && name != "hz60" {
                continue;
            }
            let mut vm = Engine::new(Program::compile(&project).unwrap());
            if !jit {
                vm.disable_jit();
            }
            vm.use_virtual_clock();
            vm.start();
            let expected = case["ready"].as_array().unwrap();
            assert_eq!(expected.len(), 1200);
            for (frame, ready) in expected.iter().enumerate() {
                let dt_ms = if frame == 0 {
                    0.0
                } else if let Some(sequence) = case["frameMs"].as_array() {
                    sequence[(frame - 1) % sequence.len()].as_f64().unwrap()
                } else {
                    case["frameMs"].as_f64().unwrap()
                };
                let dt = if default_sixty_hz && frame != 0 {
                    1.0 / 60.0
                } else {
                    dt_ms / 1000.0
                };
                let update = vm.advance(dt, 100_000, Duration::from_secs(1)).unwrap();
                assert!(!update.budget_yield);
                assert_eq!(
                    vm.variable_value("ready").number(),
                    ready.as_f64().unwrap(),
                    "{name}, frame {}, jit={jit}, default_sixty_hz={default_sixty_hz}",
                    frame + 1
                );
            }
            // A new start resets both the logical clock and per-task epoch.
            vm.start();
            vm.advance(0.0, 100_000, Duration::from_secs(1)).unwrap();
            assert_eq!(vm.variable_value("ready").number(), 1.0);
        }
    }
}

#[test]
fn waits_and_repeat_match_official_frame_boundaries() {
    let report: Value =
        serde_json::from_str(include_str!("../docs/kn-r3-scheduling-official.json")).unwrap();
    assert_eq!(report["ok"], true);
    for name in [
        "wait-zero",
        "wait-negative",
        "wait-positive",
        "wait-until",
        "repeat",
    ] {
        let project: Value = serde_json::from_str(
            &std::fs::read_to_string(format!("tests/fixtures/kn-r3-sched/{name}.bcmkn")).unwrap(),
        )
        .unwrap();
        for jit in [false, true] {
            let mut vm = Engine::new(Program::compile(&project).unwrap());
            if !jit {
                vm.disable_jit();
            }
            vm.use_virtual_clock();
            // Repeated starts retain JIT hot counters and compiled regions.
            for run in 0..600 {
                vm.start();
                for (frame, expected) in report["cases"][name]["frames"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                {
                    let update = vm.advance(0.016, 100_000, Duration::from_secs(1)).unwrap();
                    assert!(!update.budget_yield);
                    assert_eq!(
                        vm.variable_value("trace").text(),
                        expected["variables"]["trace"].as_str().unwrap(),
                        "{name}, run {run}, frame {}, jit={jit}",
                        frame + 1
                    );
                    assert_eq!(
                        vm.variable_value("ready").number(),
                        expected["variables"]["ready"].as_f64().unwrap()
                    );
                }
            }
        }
    }
}

#[test]
fn zero_wait_requires_two_boundaries_even_when_time_does_not_advance() {
    let project: Value =
        serde_json::from_str(include_str!("fixtures/kn-r3-sched/wait-zero.bcmkn")).unwrap();
    for dt in [0.0, 0.001, 0.1] {
        let mut vm = Engine::new(Program::compile(&project).unwrap());
        vm.use_virtual_clock();
        vm.start();
        for expected in ["AB", "AB", "ABab"] {
            vm.advance(dt, 100_000, Duration::from_secs(1)).unwrap();
            assert_eq!(vm.variable_value("trace").text(), expected, "dt={dt}");
        }
    }
}

// Optional local comparison: third-party source is never committed or copied
// outside ignored dist/. CI exercises the original probes above instead.
#[test]
fn corpus_frame_counter_matches_official_when_supplied() {
    let Ok(input) = std::env::var("NEKOC_R3_SCHED_CORPUS") else {
        return;
    };
    let bytes = std::fs::read(input).unwrap();
    let project: Value = serde_json::from_slice(&bytes).unwrap();
    let evidence_path = std::env::var("NEKOC_R3_SCHED_EVIDENCE")
        .unwrap_or_else(|_| "dist/r3-knsched/corpus-official.json".into());
    let evidence: Value =
        serde_json::from_str(&std::fs::read_to_string(evidence_path).unwrap()).unwrap();
    assert_eq!(evidence["ok"], true);
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        evidence["cases"]["336319534"]["sha256"].as_str().unwrap()
    );
    for jit in [false, true] {
        let mut vm = Engine::new(Program::compile(&project).unwrap());
        if !jit {
            vm.disable_jit();
        }
        vm.use_virtual_clock();
        vm.start();
        for (frame, expected) in evidence["cases"]["336319534"]["frames"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            vm.advance(0.016, 100_000, Duration::from_secs(1)).unwrap();
            for id in [
                "3870adb0-6280-4f6b-9e5c-76314aa885bc",
                "99c10f40-c897-498f-9cbf-fe441bd12ce9",
            ] {
                let value = vm.variable_value(id);
                let matches = if let Some(number) = expected["variables"][id].as_f64() {
                    value.number() == number
                } else {
                    value.text() == expected["variables"][id].as_str().unwrap()
                };
                assert!(matches, "frame {}, jit={jit}, {id}", frame + 1);
            }
        }
    }
}
