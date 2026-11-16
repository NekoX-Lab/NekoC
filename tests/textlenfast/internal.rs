//! Private representation assertions: included by engine::value::text.
use super::*;

#[test]
fn textlenfast_utf16_cache_survives_all_leaf_splits_and_flat_detachment() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/textlenfast.json")).unwrap();
    for case in corpus.as_array().unwrap() {
        let s = case["text"].as_str().unwrap();
        let expected = case["length"].as_u64().unwrap() as usize;
        for at in s.char_indices().map(|(at, _)| at).chain([s.len()]) {
            let t = Text::concat(&s[..at].into(), &s[at..].into());
            assert_eq!(t.len(), s.len());
            assert_eq!(t.utf16_len(), expected);
            assert_eq!(t.as_ref(), s);
            let joined = Text::concat(&t, &"!".into());
            assert_eq!(joined.utf16_len(), expected + 1);
            if at > 0 && at < s.len() {
                let (left, _) = joined.0.children.as_ref().unwrap();
                assert!(left.0.children.is_none());
                assert_eq!(left.utf16_len(), expected);
                assert_eq!(left.as_ptr(), t.as_ptr());
            }
        }
    }
    // Every corpus pair also exercises genuinely nested and shared nodes with
    // the old materialized UTF-16 count as a separate oracle.
    for a in corpus.as_array().unwrap() {
        for b in corpus.as_array().unwrap() {
            let a = Text::from(a["text"].as_str().unwrap());
            let b = Text::from(b["text"].as_str().unwrap());
            let pair = Text::concat(&a, &b);
            let nested = Text::concat(&pair, &Text::concat(&b, &pair));
            assert_eq!(nested.utf16_len(), nested.as_ref().encode_utf16().count());
        }
    }
}

#[test]
fn textlenfast_repeated_counts_do_not_flatten_any_node_or_detach_prefixes() {
    let unit = Text::from("x中😀e\u{301}");
    for prepend in [false, true] {
        let mut t = Text::from("");
        for n in 1..=10_000 {
            let old = t.clone();
            t = if prepend {
                Text::concat(&unit, &t)
            } else {
                Text::concat(&t, &unit)
            };
            for _ in 0..4 {
                assert_eq!(t.utf16_len(), n * 6);
            }
            if n > 1 {
                assert!(t.0.flat.get().is_none());
                let (left, right) = t.0.children.as_ref().unwrap();
                let retained = if prepend { right } else { left };
                assert!(Rc::ptr_eq(&retained.0, &old.0));
            }
        }
        // Inspect every reachable node, not only the root's cache.
        let dag = Text::concat(&t, &t);
        assert_eq!(dag.utf16_len(), 120_000);
        let mut pending = vec![&dag];
        let mut visited = std::collections::HashSet::new();
        while let Some(t) = pending.pop() {
            if !visited.insert(Rc::as_ptr(&t.0)) {
                continue;
            }
            if let Some((a, b)) = &t.0.children {
                assert!(t.0.flat.get().is_none());
                pending.extend([a, b]);
            }
        }
        assert_eq!(dag.utf16_len(), dag.as_ref().encode_utf16().count());
    }
}

#[test]
fn textlenfast_shared_dag_counts_edges_not_unique_nodes_and_checks_overflow() {
    let mut t = Text::from("😀");
    let mut expected = 2usize;
    for _ in 0..usize::BITS - 4 {
        t = Text::concat(&t, &t);
        expected *= 2;
        assert_eq!(t.utf16_len(), expected);
        assert!(t.0.flat.get().is_none());
    }
    // A valid enormous DAG has no enormous flat buffer. Byte overflow is still
    // checked in release; UTF-16 <= UTF-8 bytes for Rust's scalar-value strings.
    let mut t = Text::from("x");
    for _ in 0..usize::BITS - 1 {
        t = Text::concat(&t, &t);
    }
    let overflow = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Text::concat(&t, &t)));
    assert!(overflow.is_err());
    assert_eq!(t.utf16_len(), 1usize << (usize::BITS - 1));
}
