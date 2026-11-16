// Included only by the new runtime's allocation-instrumented integration test.
use super::measured;
use nekoc::engine::{Cell as ValueCell, Text};
use std::hint::black_box;

#[test]
fn textlenfast_repeated_leaf_rope_and_dag_lengths_allocate_nothing() {
    let leaf = Text::from("x中😀e\u{301}".repeat(4096));
    let mut left = Text::from("");
    let mut right = Text::from("");
    for _ in 0..4096 {
        left = Text::concat(&left, &leaf);
        right = Text::concat(&leaf, &right);
    }
    let dag = Text::concat(&left, &right);
    let cases = [leaf, left, right, dag].map(ValueCell::Text);
    let (_, allocations) = measured(|| {
        for _ in 0..1000 {
            for value in &cases {
                assert!(black_box(value).text_length() > 0);
            }
        }
    });
    assert_eq!(allocations["allocations"], 0);
    assert_eq!(allocations["allocated_bytes"], 0);
}
