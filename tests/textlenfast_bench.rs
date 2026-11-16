//! Local-only allocation-instrumented engine benchmark, not a CI timing gate.
use nekoc::engine::{Engine, Program};
use serde_json::{Value, json};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    time::{Duration, Instant},
};

struct CountingAllocator;
thread_local! {
    static COUNTS: Cell<Option<(u64, u64)>> = const { Cell::new(None) };
}
fn count(bytes: usize) {
    let _ = COUNTS.try_with(|c| {
        if let Some((allocations, total)) = c.get() {
            c.set(Some((allocations + 1, total + bytes as u64)));
        }
    });
}
// SAFETY: every allocation/deallocation is forwarded unchanged to System;
// thread-local counters do not allocate and do not inspect allocation contents.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        count(size);
        unsafe { System.realloc(ptr, layout, size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[path = "textlenfast/allocations.rs"]
mod allocation_tests;

fn measured<T>(f: impl FnOnce() -> T) -> (T, Value) {
    COUNTS.with(|c| c.set(Some((0, 0))));
    let start = Instant::now();
    let out = f();
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    let (allocations, bytes) = COUNTS.with(|c| c.replace(None).unwrap());
    (
        out,
        json!({"ms":ms,"allocations":allocations,"allocated_bytes":bytes}),
    )
}
fn num(n: usize) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}
fn get(id: &str) -> Value {
    json!({"type":"variables_get","fields":{"variable":id}})
}
fn set(id: &str, value: Value) -> Value {
    json!({"type":"variables_set","fields":{"variable":id},"inputs":{"value":value}})
}
fn chain(ops: Vec<Value>) -> Value {
    ops.into_iter()
        .rev()
        .reduce(|next, mut op| {
            op["next"] = next;
            op
        })
        .unwrap()
}
fn project(case: &str) -> Value {
    let mut p = nekoc::studio::document::Document::blank().value().clone();
    let length = json!({"type":"text_length","inputs":{"text":get("s")}});
    let join = |piece| json!({"type":"text_join","inputs":{"ADD0":get("s"),"ADD1":{"type":"text","fields":{"TEXT":piece}}}});
    let add =
        |a, b| json!({"type":"math_arithmetic","fields":{"type":"add"},"inputs":{"A":a,"B":b}});
    let body = match case {
        "fixed" => set("out", add(get("out"), length.clone())),
        "growing" => chain(vec![
            set("s", join("x😀e\u{301}")),
            set("out", add(get("out"), length)),
        ]),
        "concat" => set("s", join("abcdefgh")),
        "short-concat" => set(
            "s",
            json!({"type":"text_join","inputs":{"ADD0":{"type":"text","fields":{"TEXT":"ab"}},"ADD1":{"type":"text","fields":{"TEXT":"cd"}}}}),
        ),
        "numeric" => set("out", add(get("out"), num(1))),
        // Exact existing KN string control: 2000 joins of abcdefgh per batch.
        _ => panic!("unknown benchmark case {case}"),
    };
    let reset = if case == "fixed" {
        None
    } else {
        Some(set("s", json!({"type":"text","fields":{"TEXT":""}})))
    };
    let repeat = json!({"type":"warp","statements":{"DO":{"type":"repeat_n_times","inputs":{"times":num(2000)},"statements":{"DO":body}}}});
    let batch = match reset {
        Some(reset) => chain(vec![reset, repeat]),
        None => repeat,
    };
    p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([{
        "type":"on_running_group_activated","next":{"type":"repeat_forever","statements":{"DO":batch}}
    }]);
    for (id, initial) in [
        (
            "s",
            json!(if case == "fixed" {
                "x😀e\u{301}".repeat(16_384)
            } else {
                String::new()
            }),
        ),
        ("out", json!(0)),
    ] {
        p["variables"]["variablesDict"][id] =
            json!({"id":id,"name":id,"value":initial,"isGlobal":true});
    }
    p
}

#[test]
#[ignore = "local release AB/BA benchmark; no timing assertions"]
fn textlenfast_local_benchmark() {
    let case = std::env::var("TEXTLENFAST_CASE").unwrap_or_else(|_| "fixed".into());
    let p = project(&case);
    let (mut vm, compile) = measured(|| Engine::new(Program::compile(&p).unwrap()));
    if std::env::var_os("TEXTLENFAST_INTERPRETER").is_some() {
        vm.disable_jit();
    }
    vm.use_virtual_clock();
    vm.start();
    let mut frames = Vec::new();
    for _ in 0..16 {
        let (frame, stats) = measured(|| {
            vm.advance(1.0 / 60.0, 200_000_000, Duration::from_secs(60))
                .unwrap()
        });
        assert!(!frame.budget_yield);
        frames.push(stats);
        vm.recycle_lines(frame.lines);
    }
    // Snapshots are deliberately outside the measured windows.
    println!(
        "TEXTLENFAST {}",
        json!({"case":case,"compile":compile,"frames":frames,"state":vm.debug_snapshot()})
    );
}
