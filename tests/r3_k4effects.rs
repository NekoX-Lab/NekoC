use nekoc::{
    engine::{Costume, Engine, Program},
    kitten4,
};
use serde_json::Value;
use std::time::Duration;

#[test]
fn neutral_twist_activation_reaches_frames_and_clear_disables_it() {
    let evidence: Value =
        serde_json::from_str(include_str!("../docs/r3-k4effects-official.json")).unwrap();
    for kind in [
        "self_set_effect",
        "self_set_effect_2",
        "self_change_effect",
        "self_change_effect_2",
        "self_change_effect_3",
    ] {
        for target in ["actor", "scene"] {
            if target == "scene" && !["self_set_effect_2", "self_change_effect_3"].contains(&kind) {
                continue;
            }
            let source = std::fs::read_to_string(format!(
                "tests/fixtures/kitten4/partial-effects-11-{kind}-{target}-chain.bcm"
            ))
            .unwrap();
            let project = kitten4::to_neko(&nekoc::json::from_str(&source).unwrap()).unwrap();
            for jit in [false, true] {
                let mut engine = Engine::new(Program::compile(&project).unwrap());
                for (id, width, height) in [("background", 960.0, 720.0), ("costume-a", 96.0, 64.0)]
                {
                    engine.set_costume(
                        id,
                        Costume {
                            width,
                            height,
                            center_point: [0.0; 2],
                            mask: None,
                            rgb: None,
                        },
                    );
                }
                engine.use_virtual_clock();
                if !jit {
                    engine.disable_jit();
                }
                engine.start();
                let offset = if kind == "self_change_effect_3" {
                    14
                } else {
                    0
                };
                let mut state = None;
                for frame in 1..=52 + offset {
                    let delta = engine
                        .advance(1.0 / 60.0, 2_000_000, Duration::ZERO)
                        .unwrap();
                    assert!(!delta.budget_yield);
                    let id = if target == "scene" {
                        "10000000-0000-4000-8000-000000000001"
                    } else {
                        "20000000-0000-4000-8000-000000000001"
                    };
                    if let Some(sprite) = delta.sprites.iter().find(|s| s.id == id) {
                        state = Some(serde_json::to_value(sprite).unwrap());
                    }
                    let wire = state.as_ref().unwrap();
                    // The new changer has seven extra decrease operations, each
                    // with a wait. Compare shared phases to the native probe.
                    if offset != 0 && (17..=30).contains(&frame) {
                        continue;
                    }
                    let observed_frame = if frame > 30 { frame - offset } else { frame };
                    let observed = &evidence["observations"][observed_frame - 1];
                    assert_eq!(
                        wire["k4_twist_enabled"].as_bool().unwrap_or(false),
                        observed["enabled"],
                        "{kind}/{target}/{frame}/jit={jit}"
                    );
                    if (27..=32).contains(&observed_frame) {
                        assert_eq!(wire["effects"][5], 0.0);
                        assert_eq!(wire["k4_twist_enabled"], true);
                    }
                    if observed["enabled"] == false {
                        assert!(
                            wire.get("k4_twist_enabled").is_none(),
                            "disabled field must stay absent"
                        );
                    }
                }
                engine.start();
                let reset = engine
                    .advance(1.0 / 60.0, 2_000_000, Duration::ZERO)
                    .unwrap();
                assert!(reset.sprites.iter().all(|s| !s.k4_twist_enabled));
            }
        }
    }
}

#[test]
fn kn_frames_keep_their_existing_wire_shape() {
    let document = nekoc::studio::document::Document::blank();
    let mut engine = Engine::new(Program::compile(document.value()).unwrap());
    engine.start();
    let frame = engine
        .advance(1.0 / 60.0, 2_000_000, Duration::ZERO)
        .unwrap();
    for sprite in frame.sprites {
        assert!(!sprite.k4_twist_enabled);
        assert!(
            serde_json::to_value(sprite)
                .unwrap()
                .get("k4_twist_enabled")
                .is_none()
        );
    }
}
