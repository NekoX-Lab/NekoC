//! Synthetic, deterministic mutations; no third-party works or wall-clock assertions.
//! Local campaign: NEKOC_FUZZ_CASES=4096 <test binary> --test-threads=1 --nocapture
use nekoc::{
    bcmkn, bcmkn_compiler,
    engine::{Engine, Program},
    json::{self, Json},
    kitten4,
};
use serde_json::{Value, json};
use std::time::Duration;

fn kn() -> Json {
    let mut p = bcmkn_compiler::default_template();
    p["stageSize"] = json!({"width":1280,"height":720});
    p
}

fn number(n: f64) -> Value {
    json!({"type":"math_number","fields":{"NUM":n}})
}

fn executable(body: Value) -> Json {
    let mut p = kn();
    p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] =
        json!([{"id":"start","type":"on_running_group_activated","next":body}]);
    p
}

fn run(project: &Value) {
    // Rejections are valid fuzz outcomes; successful compiles must be safe to run.
    for interpreted in [true, false] {
        if let Ok(program) = Program::compile(project) {
            let mut vm = Engine::new(program);
            if interpreted {
                vm.disable_jit();
            }
            vm.set_random_seed(3);
            vm.use_virtual_clock();
            vm.start();
            for _ in 0..3 {
                if vm.advance(1.0 / 60.0, 256, Duration::ZERO).is_err() {
                    break;
                }
            }
        }
    }
}

fn exercise(p: Json) {
    run(&p);
    if kitten4::is_kitten4(&p)
        && let Ok(canonical) = kitten4::to_neko(&p)
    {
        run(&canonical);
    }
    let _ = bcmkn::import(p);
}

#[test]
fn malformed_kn_owner_returns_error() {
    // Minimized from a structure-preserving owner mutation. Diagnostic probes
    // previously indexed a boolean as an object after a failed whole-work compile.
    let p = json!({"scenes":{"scenesDict":{}},"actors":{"actorsDict":{"a":true}}});
    let error = bcmkn::import(p).unwrap_err();
    assert!(error.to_string().contains("a"), "{error:#}");
}

#[test]
fn malformed_template_returns_error() {
    let workspace = json!({"workspaceData":{"blocks":{},"connections":{}}});
    let mut p = kn();
    p["actors"]["actorsDict"]["nekoc-default-actor"] = json!(true);
    let error = bcmkn_compiler::assemble_workspace_bcmkn(&workspace, "fuzz", p).unwrap_err();
    assert!(
        error.to_string().contains("nekoc-default-actor"),
        "{error:#}"
    );
}

#[test]
fn deep_initial_values_are_errors_not_recursive_cell_trees() {
    for object in [false, true] {
        let mut value = Json::new(Value::Null);
        for _ in 0..4000 {
            value = Json::new(if object {
                let mut map = serde_json::Map::new();
                map.insert("v".into(), value.into_value());
                Value::Object(map)
            } else {
                Value::Array(vec![value.into_value()])
            });
        }
        let error = nekoc::engine::Cell::from_json(&value).unwrap_err();
        assert!(error.to_string().contains("VM value nesting"), "{error:#}");
        let mut p = kn();
        p["variables"]["variablesDict"]["v"] = json!({"name":"v","isGlobal":true});
        p["variables"]["variablesDict"]["v"]["value"] = value.into_value();
        let error = Program::compile(&p).unwrap_err();
        assert!(
            format!("{error:#}").contains("VM value nesting"),
            "{error:#}"
        );
    }
    let valid = json::from_str(&format!("{}0{}", "[".repeat(128), "]".repeat(128))).unwrap();
    assert!(nekoc::engine::Cell::from_json(&valid).is_ok());
}

#[test]
fn malformed_container_shapes_return_errors() {
    let workspace = json!({"workspaceData":{"blocks":{},"connections":{}}});
    for (section, dict) in [
        ("scenes", "scenesDict"),
        ("actors", "actorsDict"),
        ("procedures", "proceduresDict"),
        ("variables", "variablesDict"),
        ("styles", "stylesDict"),
        ("broadcasts", "broadcastsDict"),
    ] {
        for bad in [json!(true), json!([]), json!(3), json!("bad"), Value::Null] {
            for dictionary in [false, true] {
                let mut p = kn();
                if dictionary {
                    p[section][dict] = bad.clone();
                } else {
                    p[section] = bad.clone();
                }
                assert!(bcmkn::import(p.clone()).is_err(), "{section}/{dict}");
                assert!(bcmkn_compiler::assemble_workspace_bcmkn(&workspace, "fuzz", p).is_err());
            }
        }
    }
}

fn workspace(edges: Value) -> Value {
    json!({"blocks":{"a":{"id":"a","type":"self_show"},
        "b":{"id":"b","type":"self_show"},"c":{"id":"c","type":"self_hide"}},
        "connections":edges})
}

#[test]
fn cyclic_shared_and_invalid_workspace_graphs_are_rejected() {
    for (edges, message) in [
        (json!({"a":{"a":{"type":"next"}}}), "cycle"),
        (
            json!({"a":{"b":{"type":"next"}},"b":{"a":{"type":"next"}}}),
            "cycle",
        ),
        (
            json!({"a":{"c":{"type":"next"}},"b":{"c":{"type":"next"}}}),
            "multiple parents",
        ),
        (json!({"a":{"missing":{"type":"next"}}}), "missing block"),
        (json!({"missing":{}}), "missing parent"),
        (
            json!({"a":{"b":{"type":"next"},"c":{"type":"next"}}}),
            "duplicate connection",
        ),
        (json!({"a":{"b":{"type":"input"}}}), "input_name"),
        (json!({"a":{"b":false}}), "connection type"),
        (json!({"a":true}), "must be an object"),
        (json!(true), "must be an object"),
    ] {
        let w = workspace(edges);
        let error = bcmkn_compiler::workspace_data_to_neko_blocks(&w).unwrap_err();
        assert!(error.to_string().contains(message), "{error:#}");
    }
}

#[test]
fn valid_workspace_preserves_fields_edges_and_editor_shape() {
    let report = json!({"workspaceData":{"blocks":{
        "hat":{"id":"hat","type":"on_running_group_activated","fields":{},"mutation":"","futureExtension":{"keep":[null,17]}},
        "hide":{"id":"hide","type":"self_pen_up","fields":{}},
        "show":{"id":"show","type":"self_pen_down","fields":{}}},
        "connections":{"hat":{"hide":{"type":"next"}},"hide":{"show":{"type":"next"}}}}});
    let p = bcmkn_compiler::assemble_workspace_bcmkn(&report, "r3-fuzz-valid", kn()).unwrap();
    let root = &p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"][0];
    assert_eq!(root["futureExtension"], json!({"keep":[null,17]}));
    assert_eq!(root["mutation"], "");
    assert_eq!(root["next"]["parent_id"], "hat");
    assert_eq!(root["next"]["next"]["parent_id"], "hide");
    assert_eq!(root["next"]["next"]["type"], "self_pen_down");
    assert_eq!(nekoc::validate::build_report(&p).unwrap()["ok"], true);
    assert!(Program::compile(&p).is_ok());
    run(&p);
    if let Some(path) = std::env::var_os("NEKOC_FUZZ_ARTIFACT") {
        std::fs::write(path, json::to_vec(&p).unwrap()).unwrap();
    }
}

#[test]
fn workspace_path_budget_and_iterative_expansion() {
    for count in [2500, json::MAX_BLOCK_PATH + 2] {
        let mut blocks = serde_json::Map::new();
        let mut connections = serde_json::Map::new();
        // Reverse lexical order used to let memoized descendants bypass limits.
        for i in 0..count {
            let id = format!("b{:05}", count - i);
            blocks.insert(id.clone(), json!({"id":id,"type":"self_show"}));
            if i + 1 < count {
                connections.insert(
                    id,
                    json!({format!("b{:05}", count - i - 1):{"type":"next"}}),
                );
            }
        }
        let w = json!({"blocks":blocks,"connections":connections});
        let result = bcmkn_compiler::workspace_data_to_neko_blocks(&w);
        if count > json::MAX_BLOCK_PATH {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("block path exceeds")
            );
        } else {
            let roots = Json::new(Value::Array(result.unwrap()));
            assert_eq!(roots.as_array().unwrap().len(), 1);
            let mut block = &roots[0];
            let mut actual = 0;
            while block.is_object() {
                actual += 1;
                block = &block["next"];
            }
            assert_eq!(actual, count);
        }
    }
}

#[test]
fn deep_connection_extensions_are_borrowed_without_recursive_clone_or_drop() {
    let mut metadata = Json::new(Value::Null);
    for _ in 0..30_000 {
        metadata = Json::new(Value::Array(vec![metadata.into_value()]));
    }
    let mut w = Json::new(json!({"blocks":{
        "a":{"type":"self_pen_up"},"b":{"type":"self_pen_down"}},
        "connections":{"a":{"b":{"type":"next"}}}}));
    w["connections"]["a"]["b"]["extension"] = metadata.into_value();
    // Default harness stack, including normal return and error cleanup. The
    // opaque edge metadata is legal JSON below MAX_DEPTH, not executable data.
    let roots = bcmkn_compiler::workspace_data_to_neko_blocks(&w).unwrap();
    assert_eq!(roots[0]["next"]["type"], "self_pen_down");
    assert!(json::to_vec(&w).unwrap().len() < 61_000);
    w["connections"]["a"]["b"]["type"] = json!(false);
    assert!(bcmkn_compiler::workspace_data_to_neko_blocks(&w).is_err());
}

#[test]
fn rebuilt_workspace_fields_discard_deep_old_values_on_default_thread_stack() {
    // Use an ordinary spawned thread, not expanded() or a custom stack size.
    std::thread::spawn(|| {
        for key in ["parent_id", "next", "inputs", "statements"] {
            let mut old = Json::new(Value::Null);
            for _ in 0..30_000 {
                old = Json::new(Value::Array(vec![old.into_value()]));
            }
            let mut w = Json::new(json!({"blocks":{
                "a":{"type":"self_pen_up"},"b":{"type":"self_pen_down"}},
                "connections":{"a":{"b":{"type":"next"}}}}));
            w["blocks"]["b"][key] = old.into_value();
            let roots = bcmkn_compiler::workspace_data_to_neko_blocks(&w).unwrap();
            assert_eq!(roots.len(), 1);
            assert_eq!(roots[0]["parent_id"], "");
            assert_eq!(roots[0]["next"]["parent_id"], "a", "{key}");
            assert_eq!(roots[0]["next"]["type"], "self_pen_down");
            for removed in ["next", "inputs", "statements"] {
                assert!(roots[0]["next"].get(removed).is_none());
            }
            // Rebuilding only edits a stack-safe clone, never the input field.
            assert!(w["blocks"]["b"][key].is_array());
        }
    })
    .join()
    .unwrap();
}

fn text_literal(text: &str) -> Value {
    json!({"type":"text","fields":{"TEXT":text}})
}

fn missing_property() -> Value {
    json!({"type":"_object_get","inputs":{"obj":{"type":"_object_literal","inputs":{}},
        "key":text_literal("missing")}})
}

fn join(parts: Vec<Value>) -> Value {
    let inputs: serde_json::Map<String, Value> = parts
        .into_iter()
        .enumerate()
        .map(|(i, v)| (format!("ADD{i}"), v))
        .collect();
    json!({"type":"text_join","inputs":inputs})
}

fn assert_resource_error(p: &Value, block: &str) {
    for interpreted in [true, false] {
        let mut vm = Engine::new(Program::compile(p).unwrap());
        if interpreted {
            vm.disable_jit();
        }
        vm.use_virtual_clock();
        vm.start();
        let error = match vm.advance(1.0 / 60.0, 10_000, Duration::ZERO) {
            Err(error) => error,
            Ok(_) => panic!("{block}: expected resource error (interpreter={interpreted})"),
        };
        let message = format!("{error:#}");
        assert!(
            message.contains("text size exceeds VM safety limit"),
            "{message}"
        );
        assert!(message.contains(&format!("at block {block}")), "{message}");
    }
}

#[test]
fn join_budget_covers_list_prefixes_and_undefined_truncation() {
    let get = || json!({"type":"variables_get","fields":{"variable":"a"}});
    // Every leaf is below 16 MiB; the coercion, not the initial JSON, exceeds it.
    for parts in [
        vec![get(), missing_property()],
        vec![get(), text_literal("")],
        vec![get(), missing_property(), text_literal("ignored")],
        vec![text_literal("prefix"), get(), missing_property()],
    ] {
        let mut p = executable(
            json!({"id":"join-limit","type":"variables_set","fields":{"variable":"out"},
            "inputs":{"value":join(parts)}}),
        );
        p["variables"]["variablesDict"]["a"] = json!({"name":"a","isGlobal":true,
            "value":["a".repeat(9*1024*1024), "b".repeat(9*1024*1024)]});
        p["variables"]["variablesDict"]["out"] = json!({"name":"out","isGlobal":true,"value":""});
        assert_resource_error(&p, "join-limit");
    }
    // A single existing Text can also be over the result budget even when the
    // second operand truncates the join. No flattening is necessary to reject it.
    let mut p = executable(
        json!({"id":"text-limit","type":"variables_set","fields":{"variable":"out"},"inputs":{"value":join(vec![get(), missing_property()])}}),
    );
    p["variables"]["variablesDict"]["a"] =
        json!({"name":"a","isGlobal":true,"value":"x".repeat(16*1024*1024+1)});
    assert_resource_error(&p, "text-limit");
    p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"][0]["next"] = json!({"id":"log-limit","type":"console_log","inputs":{"console_log":join(vec![get(), missing_property()])}});
    assert_resource_error(&p, "log-limit");
}

#[test]
fn bounded_join_preserves_list_coercion_and_undefined_short_circuit() {
    use nekoc::engine::Cell;
    let get = || json!({"type":"variables_get","fields":{"variable":"a"}});
    for (parts, expected) in [
        (vec![get(), missing_property()], "x,,true,猫,"),
        (
            vec![get(), missing_property(), text_literal("ignored")],
            "x,,true,猫,",
        ),
        (vec![missing_property(), get()], ""),
    ] {
        let mut p = executable(
            json!({"type":"variables_set","fields":{"variable":"out"},"inputs":{"value":join(parts)}}),
        );
        p["variables"]["variablesDict"]["a"] =
            json!({"name":"a","isGlobal":true,"value":["x",null,[true,"猫"],null]});
        p["variables"]["variablesDict"]["out"] = json!({"name":"out","isGlobal":true,"value":""});
        for interpreted in [true, false] {
            let mut vm = Engine::new(Program::compile(&p).unwrap());
            if interpreted {
                vm.disable_jit();
            }
            vm.use_virtual_clock();
            vm.start();
            vm.advance(1.0 / 60.0, 100, Duration::ZERO).unwrap();
            assert_eq!(
                vm.variable_text("out"),
                expected,
                "interpreter={interpreted}, a={}",
                vm.variable_text("a")
            );
        }
    }
    // Runtime cyclic lists and undefined list elements keep the old coercion.
    // Break the reference cycle after execution so the test does not leak it.
    let mut p = executable(json!({"type":"variables_set","fields":{"variable":"out"},
        "inputs":{"value":join(vec![get(), missing_property()])}}));
    p["variables"]["variablesDict"]["a"] = json!({"isGlobal":true,"value":["x"]});
    for interpreted in [true, false] {
        let mut vm = Engine::new(Program::compile(&p).unwrap());
        if interpreted {
            vm.disable_jit();
        }
        vm.use_virtual_clock();
        vm.start();
        let Cell::List(items) = vm.variable_value("a") else {
            panic!("expected list")
        };
        items
            .borrow_mut()
            .extend([Cell::Undefined, Cell::List(items.clone())]);
        let result = vm.advance(1.0 / 60.0, 100, Duration::ZERO);
        items.borrow_mut().clear();
        result.unwrap();
        assert_eq!(vm.variable_text("out"), "x,,");
    }
}

#[test]
fn resource_errors_propagate_across_wait_broadcast_and_cold_op_yields() {
    let get = || json!({"type":"variables_get","fields":{"variable":"s"}});
    let too_long = || join(vec![get(), get()]);
    for (kind, input) in [
        ("wait_until", "condition"),
        ("wait", "time"),
        ("self_broadcast_and_wait", "message"),
        ("self_ask", "text"),
    ] {
        let mut p = executable(json!({"id":"yield-limit","type":kind,"inputs":{input:too_long()}}));
        p["variables"]["variablesDict"]["s"] =
            json!({"name":"s","isGlobal":true,"value":"x".repeat(8*1024*1024+1)});
        // Make broadcast(wait) take its early-return branch even when a failed
        // reporter supplies the Undefined sentinel's message spelling.
        p["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"]
            .as_array_mut()
            .unwrap()
            .push(
                json!({"type":"self_listen","inputs":{"message":{"type":"broadcast_input","fields":{"message":"undefined"}}},
                "statements":{"DO":{"type":"wait","inputs":{"time":number(1.0)}}}}),
            );
        assert_resource_error(&p, "yield-limit");
    }
}

fn doubling(kind: usize) -> Json {
    let get = || json!({"type":"variables_get","fields":{"variable":"s"}});
    let join = if kind == 1 {
        json!({"type":"math_arithmetic","fields":{"type":"add"},"inputs":{"A":get(),"B":get()}})
    } else {
        json!({"type":"text_join","inputs":{"ADD0":get(),"ADD1":get()}})
    };
    let set = if kind == 2 {
        json!({"id":"double","type":"change_variables","fields":{"variable":"s"},"inputs":{"value":get()}})
    } else {
        json!({"id":"double","type":"variables_set","fields":{"variable":"s"},"inputs":{"value":join}})
    };
    // Run this exact site >500 times before growth begins, crossing the native
    // tier's hot threshold in the JIT-enabled regression as well.
    let reset = json!({"type":"controls_if","inputs":{"IF0":{"type":"logic_compare",
        "fields":{"OP":"LT"},"inputs":{"A":{"type":"variables_get","fields":{"variable":"tick"}},"B":number(600.0)}}},
        "statements":{"DO0":{"type":"variables_set","fields":{"variable":"s"},
            "inputs":{"value":{"type":"text","fields":{"TEXT":"x"}}}}},"next":set});
    let body = json!({"type":"change_variables","fields":{"variable":"tick"},"inputs":{"value":number(1.0)},"next":reset});
    let mut p = executable(
        json!({"type":"warp","statements":{"DO":{"type":"repeat_n_times",
        "inputs":{"times":number(664.0)},"statements":{"DO":body}}}}),
    );
    p["variables"]["variablesDict"]["s"] = json!({"id":"s","name":"s","isGlobal":true,"value":"x"});
    p["variables"]["variablesDict"]["tick"] =
        json!({"id":"tick","name":"tick","isGlobal":true,"value":0});
    if kind != 0 {
        let source = kitten4::from_neko(&kn()).unwrap();
        let canonical = kitten4::to_neko(&source).unwrap();
        p["_nekocKitten4"] = canonical["_nekocKitten4"].clone();
    }
    p
}

#[test]
fn exponential_text_growth_is_a_readable_vm_error() {
    for kind in 0..3 {
        let p = doubling(kind);
        for interpreted in [true, false] {
            let mut vm = Engine::new(Program::compile(&p).unwrap());
            if interpreted {
                vm.disable_jit();
            } else {
                vm.enable_jit_profile();
            }
            vm.use_virtual_clock();
            vm.start();
            let error = vm.advance(1.0 / 60.0, 10_000, Duration::ZERO).unwrap_err();
            assert!(
                format!("{error:#}").contains("text size exceeds VM safety limit"),
                "{kind}: {error:#}"
            );
            if !interpreted {
                assert!(vm.jit_profile()["native_ops"].as_u64().unwrap() > 0);
            }
        }
    }
}

struct Rng(u64);
impl Rng {
    fn pick(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }
}

fn mutate(value: &mut Value, rng: &mut Rng, depth: usize) {
    if depth < 12 && rng.pick(4) != 0 {
        match value {
            Value::Object(m) if !m.is_empty() => {
                let key = m.keys().nth(rng.pick(m.len())).unwrap().clone();
                if rng.pick(5) == 0 {
                    m.remove(&key);
                } else {
                    mutate(m.get_mut(&key).unwrap(), rng, depth + 1);
                }
                return;
            }
            Value::Array(a) if !a.is_empty() => {
                let i = rng.pick(a.len());
                if rng.pick(5) == 0 {
                    a.remove(i);
                } else {
                    mutate(&mut a[i], rng, depth + 1);
                }
                return;
            }
            _ => {}
        }
    }
    let atoms = [
        Value::Null,
        json!(false),
        json!(true),
        json!(0),
        json!(-1),
        json!(1e308),
        json!(""),
        json!("猫😀\0"),
        json!([]),
        json!({}),
        json!([null, false]),
        json!({"type":false,"next":17}),
    ];
    *value = atoms[rng.pick(atoms.len())].clone();
}

#[test]
fn seeded_json_mutations_import_compile_and_run() {
    let body = json!({"id":"repeat","type":"repeat_n_times","inputs":{"times":number(3.0)},
        "statements":{"DO":{"id":"move","type":"self_go_forward","inputs":{"steps":number(1.0)}}}});
    let canonical = executable(body);
    let native = kitten4::from_neko(&canonical).unwrap();
    let seeds = [canonical, native];
    let cases = std::env::var("NEKOC_FUZZ_CASES")
        .ok()
        .map(|s| s.parse::<usize>().unwrap())
        .unwrap_or(128);
    let mut rng = Rng(0x7233_f022_2026_1119);
    for i in 0..cases {
        let mut p = seeds[i % seeds.len()].clone();
        for _ in 0..1 + rng.pick(3) {
            mutate(&mut p, &mut rng, 0);
        }
        let bytes = json::to_vec(&p).unwrap();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            exercise(json::from_slice(&bytes).unwrap());
            // Also mutate syntax and UTF-8 independently of the shape mutator.
            let mut raw = bytes.clone();
            let at = rng.pick(raw.len());
            raw[at] = rng.pick(256) as u8;
            if let Ok(parsed) = json::from_slice(&raw) {
                exercise(parsed);
            }
        }));
        assert!(
            outcome.is_ok(),
            "mutation {i}: {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    eprintln!("r3-fuzz: {cases} seeded KN/K4 structural mutations plus {cases} byte mutations");
}

#[test]
fn seeded_workspace_graph_mutations_compile_without_expansion_bombs() {
    let mut rng = Rng(0x7233_6772_6170_6873);
    for case in 0..256 {
        let mut edges = serde_json::Map::new();
        for id in ["a", "b", "c"] {
            let mut children = serde_json::Map::new();
            for child in ["a", "b", "c", "missing"] {
                match rng.pick(8) {
                    0 => {
                        children.insert(child.into(), json!({"type":"next"}));
                    }
                    1 => {
                        children.insert(child.into(), json!({"type":"input","input_name":"A"}));
                    }
                    2 => {
                        children.insert(
                            child.into(),
                            json!({"type":"input","input_name":"DO","input_type":"statement"}),
                        );
                    }
                    _ => {}
                }
            }
            edges.insert(id.into(), Value::Object(children));
        }
        let mut w = workspace(Value::Object(edges));
        if case % 3 == 0 {
            mutate(&mut w, &mut rng, 0);
        }
        let result = std::panic::catch_unwind(|| {
            let _ = bcmkn_compiler::workspace_data_to_neko_blocks(&w);
            let report = json!({"workspaceData":w});
            if let Ok(p) = bcmkn_compiler::assemble_workspace_bcmkn(&report, "fuzz", kn()) {
                run(&p);
            }
        });
        assert!(result.is_ok(), "workspace mutation {case}: {w}");
    }
    eprintln!("r3-fuzz: 256 seeded workspace graph mutations");
}

fn expression(rng: &mut Rng, depth: usize) -> Value {
    let numbers = [0.0, -0.0, -1.0, 0.5, 1e308, -1e308, 1e-308, 2147483648.0];
    let choice = rng.pick(if depth == 0 { 3 } else { 7 });
    match choice {
        0 => number(numbers[rng.pick(numbers.len())]),
        1 => {
            let strings = [
                "",
                "猫😀",
                "NaN",
                "Infinity",
                "1e99999",
                "-0",
                "0x100000000",
            ];
            json!({"type":"text","fields":{"TEXT":strings[rng.pick(strings.len())]}})
        }
        2 => {
            json!({"type":"logic_boolean","fields":{"BOOL":if rng.pick(2) == 0 {"TRUE"} else {"FALSE"}}})
        }
        3 => {
            let ops = ["add", "minus", "multiply", "divide", "power", "mod"];
            let op = ops[rng.pick(ops.len())];
            json!({"type":"math_arithmetic","fields":{"type":op},"inputs":{"A":expression(rng, depth-1),"B":expression(rng, depth-1)}})
        }
        4 => {
            json!({"type":"text_join","inputs":{"ADD0":expression(rng, depth-1),"ADD1":expression(rng, depth-1)}})
        }
        5 => {
            json!({"type":"logic_compare","fields":{"OP":"EQ"},"inputs":{"A":expression(rng, depth-1),"B":expression(rng, depth-1)}})
        }
        _ => json!({"type":"text_length","inputs":{"text":expression(rng, depth-1)}}),
    }
}

#[test]
fn seeded_vm_expression_mutations_have_bounded_execution() {
    let mut rng = Rng(0x7233_766d_6578_7072);
    for case in 0..256 {
        let expr = expression(&mut rng, 3);
        let p = executable(json!({"type":"console_log","inputs":{"console_log":expr}}));
        assert!(
            Program::compile(&p).is_ok(),
            "valid expression {case}: {expr}"
        );
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run(&p);
        }));
        assert!(result.is_ok(), "VM mutation {case}: {expr}");
    }
    eprintln!("r3-fuzz: 256 seeded VM expression mutations, interpreter and JIT enabled");
}
