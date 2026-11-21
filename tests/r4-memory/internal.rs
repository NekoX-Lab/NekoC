//! Deterministic retained-resource checks, not allocator RSS or wall-clock limits.
use super::*;
#[path = "workload.rs"]
mod workload;

#[test]
#[ignore = "manual fixture export for the official editor compatibility check"]
fn export_original_work_for_editor_check() {
    // The remote sync preserves target/, unlike its temporary dist/ directory.
    std::fs::create_dir_all("target/r4-memory").unwrap();
    std::fs::write(
        "target/r4-memory/original.bcmkn",
        serde_json::to_vec_pretty(&workload::work()).unwrap(),
    )
    .unwrap();
}

#[test]
fn deleted_clone_releases_payload_only_at_the_disposal_boundary() {
    for k4 in [false, true] {
        let mut p = Program::compile(&workload::work()).unwrap();
        if k4 {
            p.semantics = RuntimeSemantics::Kitten4;
        }
        let mut e = Engine::new(p);
        e.disable_jit();
        e.start();
        for _ in 0..200 {
            e.clone_counts.clear();
            e.clone_sprite(1, None).unwrap();
            let slot = *e.clone_index.slots(1).last().unwrap();
            let nested = Rc::new(RefCell::new(vec![Cell::Text("owned".into())]));
            let weak = Rc::downgrade(&nested);
            let sprite = &mut e.sprites[slot];
            sprite.variables.insert(0, Cell::List(nested));
            sprite.fill_path = Some(vec![[1.0, 2.0]; 8192]);
            sprite.text = Some(SpriteText {
                text: "x".repeat(65536),
                size: 24.0,
                color: "#123456".into(),
            });
            sprite.dialog = Some(Dialog {
                text: "y".repeat(65536),
                think: false,
            });
            e.request_entity_disposal(slot);
            if k4 {
                assert!(e.sprites[slot].alive);
                assert!(weak.upgrade().is_some());
                assert_eq!(e.sprites[slot].fill_path.as_ref().unwrap().len(), 8192);
                assert!(e.sprites[slot].text.is_some());
                assert!(e.sprites[slot].dialog.is_some());
                e.dispose_requested_entities();
            }
            let sprite = &e.sprites[slot];
            assert!(!sprite.alive);
            assert!(sprite.fill_path.is_none(), "deleted contour retained");
            assert!(sprite.text.is_none(), "deleted text retained");
            assert!(sprite.dialog.is_none(), "deleted bubble retained");
            assert!(sprite.variables.is_empty());
            assert!(weak.upgrade().is_none());
            assert_eq!(e.free_slots, [slot]);
            // Drain notifications/tasks exactly as a viewer does each frame.
            e.removed.clear();
            e.tasks.clear();
        }
        assert_eq!(e.sprites.len(), e.program.sprites.len() + 1);
    }
}

#[test]
fn original_clone_pen_and_list_work_stays_bounded_for_ten_thousand_frames() {
    for jit in [false, true] {
        let mut e = Engine::new(Program::compile(&workload::work()).unwrap());
        if !jit {
            e.disable_jit();
        }
        e.use_virtual_clock();
        e.start();
        let mut lines = 0;
        let mut removed = 0;
        let mut witnesses = Vec::new();
        let mut max_slots = 0;
        let mut warm_capacity = None;
        for frame in 0..10_000 {
            if jit && frame == 9990 {
                // Verify native execution without profiling millions of ops.
                e.enable_jit_profile();
            }
            let f = e.advance(1.0 / 60.0, 1_000_000, Duration::ZERO).unwrap();
            lines += f.lines.len() / 9;
            removed += f.removed.len();
            assert!(f.lines.len() <= 9 * 65536);
            assert!(f.pen_fills.is_empty());
            assert!(e.lines.is_empty());
            assert!(e.text_stamps.is_empty() && e.image_stamps.is_empty());
            assert!(e.removed.is_empty());
            assert!(e.tasks.len() <= 1 + workload::BATCH * 4);
            assert!(e.clone_index.slots(1).len() <= workload::BATCH * 4);
            assert!(e.lists[0].borrow().is_empty());
            let capacity = (
                e.sprites.capacity(),
                e.dirty.capacity(),
                e.tasks.capacity(),
                e.free_slots.capacity(),
                e.order.capacity(),
                e.ready.capacity(),
                e.lists[0].borrow().capacity(),
            );
            if frame == 1000 {
                warm_capacity = Some(capacity);
            }
            if let Some(warm) = warm_capacity {
                assert_eq!(capacity, warm, "backing storage grew after warmup");
            }
            for sprite in &e.sprites {
                if !sprite.alive {
                    assert!(sprite.fill_path.is_none());
                    assert!(sprite.text.is_none() && sprite.dialog.is_none());
                    assert!(sprite.variables.is_empty());
                }
            }
            // Weak ownership witnesses prove nested lists die after clone
            // deletion, not merely disappear from snapshots. No GC/timing guess.
            if frame % 100 == 0 {
                witnesses.retain(|w: &std::rc::Weak<RefCell<Vec<Cell>>>| {
                    assert!(w.upgrade().is_none(), "old clone list leaked");
                    false
                });
                for sprite in e.sprites.iter().filter(|s| s.alive && s.clone_index > 0) {
                    for (_, value) in sprite.variables.iter() {
                        if let Cell::List(list) = value {
                            assert_eq!(list.borrow().len(), workload::POINTS);
                            witnesses.push(Rc::downgrade(list));
                            if let Some(Cell::List(nested)) = list.borrow().first() {
                                witnesses.push(Rc::downgrade(nested));
                            }
                        }
                    }
                }
            }
            max_slots = max_slots.max(e.sprites.len());
            assert!(max_slots <= e.program.sprites.len() + workload::BATCH * 4);
            e.recycle_lines(f.lines);
        }
        assert!(removed > 100_000, "work must really churn clones");
        assert!(lines > 10_000_000, "work must really draw");
        assert!(max_slots > e.program.sprites.len());
        if jit {
            assert!(e.jit_profile()["native_ops"].as_u64().unwrap() > 0);
        }
        e.start();
        assert_eq!(e.sprites.len(), e.program.sprites.len());
        for witness in witnesses {
            assert!(witness.upgrade().is_none());
        }
        eprintln!(
            "r4-memory jit={jit}: frames=10000 removed={removed} lines={lines} max_slots={max_slots}"
        );
    }
}
