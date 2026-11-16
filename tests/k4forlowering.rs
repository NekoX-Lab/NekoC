use assert_cmd::Command;
use nekoc::{
    engine::{Engine, Program},
    kitten4, kitten4_compiler, project,
};
use serde_json::Value;
use std::{fs, path::Path, process::Command as Process, time::Duration};
use tempfile::tempdir;

const SOURCE: &str = r#"
let total=0; let count=0; let trace=""; let limit=5; let step=0.25; let outside=0;
onStart(() => {
  pointTowards(90);
  for(let i=0;i<10;i++) { total+=i; count++; trace+=i+","; moveSteps(i); }
  for(let i=4;i>=0;i-=2) { total+=i; count++; trace+=i+","; moveSteps(i); }
  for(let i=3;i<3;i++) { total+=999; }
  for(let i=0.25;i<1;i+=step) { total+=i; count++; trace+=i+","; moveSteps(i); }
  for(let i=0;i<limit;i++) { total+=i; count++; trace+=i+","; moveSteps(i); limit--; }
  for(let i=0;i<5;i++) { total+=i; count++; trace+=i+","; moveSteps(i); i++; }
  for(let i=0;i<6;i++) { if(i===1) continue; if(i===4) break; total+=i; count++; trace+=i+","; moveSteps(i); }
  for(let i=0;i<2;i++) { for(let i=0;i<3;i++) { if(i===1) continue; total+=i; count++; trace+=i+","; moveSteps(i); } total+=i+10; trace+=(i+10)+","; count++; moveSteps(i+10); }
  for(outside=1;outside<5;outside+=2) { total+=outside; trace+=outside+","; count++; moveSteps(outside); }
  for(let i=0,j=4;i<j;i++,j--) { total+=i+j; trace+=(i+j)+","; count++; moveSteps(i+j); continue; }
  outer: for(let a=0;a<3;a++) { for(let b=0;b<3;b++) { total+=a; trace+=a+","; count++; moveSteps(a); continue outer; } total+=999; }
  end: for(let a=0;a<3;a++) { for(let b=0;b<3;b++) { total+=7; trace+="7,"; count++; moveSteps(7); break end; } total+=999; }
  setVar("done",1);
});
"#;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn assert_schema(native: &Value) {
    let schema: Value =
        serde_json::from_str(include_str!("../docs/kitten4-block-schema.json")).unwrap();
    for owner in native["theatre"]["actors"]
        .as_object()
        .unwrap()
        .values()
        .chain(native["theatre"]["scenes"].as_object().unwrap().values())
    {
        let graph = &owner["block_data_json"];
        let blocks = graph["blocks"].as_object().unwrap();
        for (id, block) in blocks {
            let kind = block["type"].as_str().unwrap();
            assert!(!kind.starts_with("traverse_number"));
            let inputs = schema["blocks"][kind]["inputs"]
                .as_array()
                .unwrap_or_else(|| panic!("no official schema for {kind}"));
            for (child, edge) in graph["connections"][id].as_object().unwrap() {
                assert_eq!(blocks[child]["parent_id"], id.as_str());
                if edge["type"] == "input" {
                    // Official text_join starts with zero sockets; its mutation
                    // creates ADD0..ADD(items-1), so the frozen default is empty.
                    if kind == "text_join" {
                        let mutation = block["mutation"].as_str().unwrap();
                        let items: usize = mutation
                            .split("items=\"")
                            .nth(1)
                            .unwrap()
                            .split('"')
                            .next()
                            .unwrap()
                            .parse()
                            .unwrap();
                        let index: usize = edge["input_name"]
                            .as_str()
                            .unwrap()
                            .strip_prefix("ADD")
                            .unwrap()
                            .parse()
                            .unwrap();
                        assert!(index < items);
                        assert_eq!(edge["input_type"], "value");
                        continue;
                    }
                    assert!(
                        inputs
                            .iter()
                            .any(|i| i["name"] == edge["input_name"]
                                && i["kind"] == edge["input_type"]),
                        "{kind}: {edge}"
                    );
                }
            }
        }
    }
}

#[test]
fn native_for_graph_schema_roundtrip_and_both_engines_match_node_side_effect_order() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("loops.ts");
    let output = dir.path().join("loops.bcm");
    fs::write(&input, SOURCE).unwrap();
    // Node executes the identical TS source with minimal DSL stubs: this is the
    // semantic oracle, not the inverse adapter being compared with itself.
    let expected = Process::new("node").current_dir(root()).args(["--input-type=module", "-e",
        r#"import fs from 'node:fs'; import ts from 'typescript'; import vm from 'node:vm';
        let x=0; const js=ts.transpileModule(fs.readFileSync(process.argv[1],'utf8')+'\nJSON.stringify({total,count,trace,limit,outside});',{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
        const result=vm.runInNewContext(js,{onStart:f=>f(),pointTowards:()=>{},moveSteps:n=>x+=n,setVar:()=>{}});
        console.log(JSON.stringify({...JSON.parse(result),x}));"#]).arg(&input).output().unwrap();
    assert!(
        expected.status.success(),
        "{}",
        String::from_utf8_lossy(&expected.stderr)
    );
    let expected: Value = serde_json::from_slice(&expected.stdout).unwrap();
    // Optional local artifact for the official KN editor and share-registry
    // gates. CI remains deterministic and does not require a browser/network.
    if let Some(artifacts) = std::env::var_os("NEKOC_SEMANTIC_ARTIFACT_DIR") {
        let artifacts = std::path::PathBuf::from(artifacts);
        fs::create_dir_all(&artifacts).unwrap();
        let report_path = dir.path().join("workspace.json");
        nekoc::ts_frontend::compile_ts_for_target(
            &input,
            &report_path,
            None::<&Path>,
            None::<&Path>,
            "kitten4",
        )
        .unwrap();
        let report: Value = serde_json::from_slice(&fs::read(report_path).unwrap()).unwrap();
        let canonical = nekoc::bcmkn_compiler::assemble_workspace_bcmkn(
            &report,
            "k4forlowering",
            nekoc::bcmkn_compiler::default_template(),
        )
        .unwrap();
        fs::write(
            artifacts.join("loops.bcmkn"),
            nekoc::json::to_vec(&canonical).unwrap(),
        )
        .unwrap();
    }
    kitten4_compiler::compile_ts_kitten4(&input, None, &output).unwrap();
    let native = project::load_project(&output).unwrap().value;
    assert_schema(&native);
    let canonical = kitten4::to_neko(&native).unwrap();
    let roundtrip = kitten4::from_neko(&canonical).unwrap();
    assert_schema(&roundtrip);
    for project in [&canonical, &kitten4::to_neko(&roundtrip).unwrap()] {
        for jit in [false, true] {
            let mut engine = Engine::new(Program::compile(project).unwrap());
            if !jit {
                engine.disable_jit();
            }
            engine.use_virtual_clock();
            engine.start();
            for _ in 0..600 {
                engine
                    .advance(1.0 / 60.0, 1_000_000, Duration::from_secs(1))
                    .unwrap();
            }
            let snapshot = engine.debug_snapshot();
            assert_eq!(engine.active_tasks(), 0, "jit={jit}");
            for name in ["total", "count", "trace", "limit", "outside"] {
                let id = native["variables"]
                    .as_object()
                    .unwrap()
                    .iter()
                    .find_map(|(id, v)| (v["name"] == name).then_some(id))
                    .unwrap();
                if let Some(number) = expected[name].as_f64() {
                    assert_eq!(
                        snapshot["variables"][id].as_f64(),
                        Some(number),
                        "{name}, jit={jit}"
                    );
                } else {
                    assert_eq!(
                        snapshot["variables"][id], expected[name],
                        "{name}, jit={jit}"
                    );
                }
            }
            let actor = snapshot["actors"]
                .as_object()
                .unwrap()
                .values()
                .next()
                .unwrap();
            assert!((actor["x"].as_f64().unwrap() - expected["x"].as_f64().unwrap()).abs() < 1e-8);
            assert!(actor["y"].as_f64().unwrap().abs() < 1e-8);
        }
    }
}

#[test]
fn cli_target_check_and_native_export_agree_and_fail_without_overwriting() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("loops.ts");
    let output = dir.path().join("loops.bcm");
    fs::write(&input, "onStart(()=>{for(let i=0;i<10;i++)moveSteps(i);});").unwrap();
    Command::cargo_bin("nekoc")
        .unwrap()
        .args(["check", "--target", "kitten4", "--json"])
        .arg(&input)
        .assert()
        .success();
    Command::cargo_bin("nekoc")
        .unwrap()
        .arg("compile-ts-kitten4")
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .assert()
        .success();
    Command::cargo_bin("nekoc")
        .unwrap()
        .args(["check", "--target", "kitten4", "--json", "--template"])
        .arg(&output)
        .arg(&input)
        .assert()
        .success();
    fs::write(
        &input,
        "onStart(()=>{\nforRange(\"i\",0,3,1,()=>{ moveSteps(1); });\n});",
    )
    .unwrap();
    let check = Command::cargo_bin("nekoc")
        .unwrap()
        .args(["check", "--target", "kitten4", "--json"])
        .arg(&input)
        .output()
        .unwrap();
    assert!(!check.status.success());
    let checked: Value = serde_json::from_slice(&check.stdout).unwrap();
    assert_eq!(checked["diagnostics"][0]["line"], 2);
    assert!(
        checked["diagnostics"][0]["message"]
            .as_str()
            .unwrap()
            .contains("Replace forRange")
    );
    let before = fs::read(&output).unwrap();
    assert!(kitten4_compiler::compile_ts_kitten4(&input, None, &output).is_err());
    assert_eq!(fs::read(&output).unwrap(), before);
}

#[test]
fn var_declarations_and_class_helpers_have_exact_cli_locations_and_preserve_output() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("main.ts");
    let dependency = dir.path().join("model.ts");
    let output = dir.path().join("keep.bcm");
    let model = "// model\n  class A{n:number=2;add(x:number){this.n+=x;}}\nexport function run(){const a=new A();for(let i=0;i<3;i++)a.add(i);}";
    fs::write(&dependency, model).unwrap();
    for (source, file, line, column, hint) in [
        (
            "var i=99;\nfor(var i=0;i<3;i++)moveSteps(i);setVar(\"result\",i);",
            &input,
            2,
            5,
            "assignment-form",
        ),
        (
            "onStart(()=>{var i=99;\n for(var i=0;i<3;i++)moveSteps(i);setVar(\"result\",i);});",
            &input,
            2,
            6,
            "assignment-form",
        ),
        (
            "onStart(()=>{var i=99;\n for(var i=0;i<3;i++)moveSteps(i);for(var i=0;i<3;i++)moveSteps(i);setVar(\"result\",i);});",
            &input,
            2,
            6,
            "assignment-form",
        ),
        (
            "class A{n:number=2;add(x:number){this.n+=x;}}const a=new A();onStart(()=>{for(let i=0;i<3;i++)a.add(i);setVar(\"result\",a.n);});",
            &input,
            1,
            1,
            "custom procedures",
        ),
        (
            "// heading\n\n  class A{\n n:number=2;\n add(x:number){this.n+=x;}\n}\nconst a=new A();\nonStart(()=>{for(let i=0;i<3;i++)a.add(i);\nsetVar(\"result\",a.n);});",
            &input,
            3,
            3,
            "custom procedures",
        ),
        (
            "import {run} from \"./model\";onStart(()=>{run();});",
            &dependency,
            2,
            3,
            "custom procedures",
        ),
    ] {
        fs::write(&input, source).unwrap();
        fs::write(&output, b"keep existing output").unwrap();
        let check = Command::cargo_bin("nekoc")
            .unwrap()
            .args(["check", "--target", "kitten4", "--json"])
            .arg(&input)
            .output()
            .unwrap();
        assert!(!check.status.success());
        let checked: Value = serde_json::from_slice(&check.stdout).unwrap();
        let diagnostic = &checked["diagnostics"][0];
        assert_eq!(
            diagnostic["file"].as_str().unwrap().replace('\\', "/"),
            file.to_string_lossy().replace('\\', "/")
        );
        assert_eq!(diagnostic["line"], line);
        assert_eq!(diagnostic["column"], column);
        assert!(diagnostic["message"].as_str().unwrap().contains(hint));
        let real_source = fs::read_to_string(file).unwrap();
        assert!(column as usize <= real_source.lines().nth(line as usize - 1).unwrap().len());
        let export = Command::cargo_bin("nekoc")
            .unwrap()
            .arg("compile-ts-kitten4")
            .arg(&input)
            .arg("--out")
            .arg(&output)
            .output()
            .unwrap();
        assert!(!export.status.success());
        let stderr = String::from_utf8_lossy(&export.stderr).replace('\\', "/");
        assert!(
            stderr.contains(&format!(
                "{}:{line}:{column}",
                file.to_string_lossy().replace('\\', "/")
            )),
            "{stderr}"
        );
        assert!(stderr.contains(hint), "{stderr}");
        assert_eq!(fs::read(&output).unwrap(), b"keep existing output");
    }
}

#[test]
fn external_assignment_var_rewrite_matches_node_in_native_interpreter_and_jit() {
    let dir = tempdir().unwrap();
    let input = dir.path().join("rewrite.ts");
    let output = dir.path().join("rewrite.bcm");
    for source in [
        "var i=99;for(i=0;i<3;i++)moveSteps(i);setVar(\"result\",i);",
        "onStart(()=>{var i=99;for(i=0;i<3;i++)moveSteps(i);setVar(\"result\",i);});",
        "onStart(()=>{var i=99;for(i=0;i<3;i++)moveSteps(i);for(i=0;i<3;i++)moveSteps(i);setVar(\"result\",i);});",
    ] {
        fs::write(&input, source).unwrap();
        let oracle = Process::new("node")
            .current_dir(root())
            .args([
                "--input-type=module",
                "-e",
                r#"import fs from 'node:fs';import vm from 'node:vm';
            const result={x:0};vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),
            {onStart:f=>f(),moveSteps:n=>result.x+=n,setVar:(k,v)=>result[k]=v});
            console.log(JSON.stringify(result));"#,
            ])
            .arg(&input)
            .output()
            .unwrap();
        assert!(oracle.status.success());
        let expected: Value = serde_json::from_slice(&oracle.stdout).unwrap();
        assert_eq!(expected["result"], 3);
        kitten4_compiler::compile_ts_kitten4(&input, None, &output).unwrap();
        let native = project::load_project(&output).unwrap().value;
        assert_schema(&native);
        let canonical = kitten4::to_neko(&native).unwrap();
        for jit in [false, true] {
            let mut engine = Engine::new(Program::compile(&canonical).unwrap());
            if !jit {
                engine.disable_jit();
            }
            engine.use_virtual_clock();
            engine.start();
            for _ in 0..600 {
                engine
                    .advance(1.0 / 60.0, 1_000_000, Duration::from_secs(1))
                    .unwrap();
            }
            assert_eq!(engine.active_tasks(), 0);
            let snapshot = engine.debug_snapshot();
            let id = native["variables"]
                .as_object()
                .unwrap()
                .iter()
                .find_map(|(id, v)| (v["name"] == "result").then_some(id))
                .unwrap();
            assert_eq!(
                snapshot["variables"][id].as_f64(),
                expected["result"].as_f64(),
                "jit={jit}"
            );
            let actor = snapshot["actors"]
                .as_object()
                .unwrap()
                .values()
                .next()
                .unwrap();
            let x = actor["x"].as_f64().unwrap();
            let y = actor["y"].as_f64().unwrap();
            assert!(
                (x.hypot(y) - expected["x"].as_f64().unwrap()).abs() < 1e-8,
                "jit={jit}"
            );
        }
    }
}
