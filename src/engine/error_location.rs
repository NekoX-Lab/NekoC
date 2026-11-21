//! Trusted provenance travels as typed metadata, never parsed from user text.
use super::{Cell, Compiler, Engine, Op};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Debug)]
pub(super) struct Diagnostic {
    message: String,
    location: Option<DiagnosticLocation>,
}

#[derive(Clone, Debug)]
struct DiagnosticLocation {
    block: String,
    owner: String,
    source: Option<String>,
}

impl From<String> for Diagnostic {
    fn from(message: String) -> Self {
        Self {
            message,
            location: None,
        }
    }
}

impl From<&str> for Diagnostic {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

impl From<anyhow::Error> for Diagnostic {
    fn from(error: anyhow::Error) -> Self {
        // Only our actual type can certify provenance across a procedure call.
        error
            .downcast_ref::<Self>()
            .cloned()
            .unwrap_or_else(|| format!("{error:#}").into())
    }
}

impl std::ops::Deref for Diagnostic {
    type Target = str;
    fn deref(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(location) = &self.location {
            write!(f, " [actor {}", location.owner)?;
            if let Some(source) = &location.source {
                write!(f, ", {source}")?;
            }
            write!(f, "] at block {}", location.block)?;
        }
        Ok(())
    }
}

impl std::error::Error for Diagnostic {}

impl Diagnostic {
    fn locate(
        &mut self,
        block: &str,
        locations: &BTreeMap<String, Location>,
        actor: Option<(&str, &str)>,
    ) {
        if self.location.is_some() {
            return;
        }
        let location = locations.get(block);
        self.location = Some(DiagnosticLocation {
            block: block.to_owned(),
            owner: actor
                .map(|(name, id)| format!("{name} ({id})"))
                .or_else(|| location.map(|l| l.owner.clone()))
                .unwrap_or_else(|| "?".to_owned()),
            source: location.and_then(|l| l.source.clone()),
        });
    }
}

#[derive(Debug)]
pub(super) struct Location {
    owner: String,
    source: Option<String>,
}

/// Only index executable block trees, not arbitrary ids in resource metadata.
/// Older maps lacked a filename and used zero-based columns: they are deliberately
/// treated as block-only locations rather than guessed to refer to the entry file.
pub(super) fn collect(project: &Value) -> BTreeMap<String, Location> {
    let mut locations = BTreeMap::new();
    for path in [
        "/scenes/scenesDict",
        "/actors/actorsDict",
        "/procedures/proceduresDict",
    ] {
        for (owner_id, owner) in project
            .pointer(path)
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            let name = owner["name"].as_str().unwrap_or(owner_id);
            let mut pending: Vec<_> = owner["nekoBlockJsonList"]
                .as_array()
                .into_iter()
                .flatten()
                .collect();
            while let Some(block) = pending.pop() {
                if let Some(id) = block["id"].as_str() {
                    let source = &project["sourceMap"][id];
                    let source = source["file"]
                        .as_str()
                        .filter(|file| !file.is_empty())
                        .and_then(|file| {
                            let line = source["line"].as_u64().filter(|n| *n > 0)?;
                            let column = source["column"].as_u64().filter(|n| *n > 0)?;
                            Some(format!("{file}:{line}:{column}"))
                        });
                    locations.insert(
                        id.to_owned(),
                        Location {
                            owner: format!(
                                "{} ({})",
                                name,
                                owner["id"].as_str().unwrap_or(owner_id)
                            ),
                            source,
                        },
                    );
                }
                if let Some(next) = block.get("next").filter(|v| v.is_object()) {
                    pending.push(next);
                }
                for key in ["inputs", "statements"] {
                    pending.extend(block[key].as_object().into_iter().flat_map(|m| m.values()));
                }
            }
        }
    }
    locations
}

impl Engine {
    #[inline]
    pub(super) fn eval_value_one<const PREPARED: bool>(&mut self, i: usize, actor: usize) -> Cell {
        let value = self.eval_value_inner::<PREPARED>(i, actor);
        self.locate_value_error(i, actor);
        value
    }

    pub(super) fn locate_value_error(&mut self, i: usize, actor: usize) {
        self.locate_reporter_error(false, i, actor);
    }

    pub(super) fn locate_expression_error(&mut self, pc: usize, actor: usize) {
        self.locate_reporter_error(true, pc, actor);
    }

    fn locate_reporter_error(&mut self, numeric: bool, i: usize, actor: usize) {
        if self.value_error.is_none() {
            return;
        }
        let sources = if numeric {
            &self.program.expression_sources
        } else {
            &self.program.value_sources
        };
        // Replacement errors start without metadata; inner failures keep theirs.
        if let Some(block) = sources.get(&i) {
            let error = self.value_error.as_mut().unwrap();
            let sprite = &self.sprites[actor];
            error.locate(
                block,
                &self.program.error_locations,
                Some((&sprite.name, &sprite.id)),
            );
        }
    }

    pub(super) fn located_error(
        &self,
        error: impl Into<Diagnostic>,
        pc: usize,
        actor: usize,
    ) -> anyhow::Error {
        let sprite = &self.sprites[actor];
        let mut error = error.into();
        error.locate(
            self.program
                .sources
                .get(pc)
                .map(String::as_str)
                .unwrap_or("?"),
            &self.program.error_locations,
            Some((&sprite.name, &sprite.id)),
        );
        error.into()
    }

    #[inline]
    pub(super) fn exec(
        &mut self,
        index: usize,
        pc: usize,
        op: Op,
        actor: usize,
    ) -> anyhow::Result<bool> {
        // Preserve the shared boundary for early yields, broadcasts and cold ops.
        let result = self.exec_inner(index, pc, op, actor);
        if let Some(error) = self.value_error.take() {
            return Err(self.located_error(error, pc, actor));
        }
        result.map_err(|error| self.located_error(error, pc, actor))
    }
}

impl Compiler {
    pub(super) fn locate_value_result(
        &mut self,
        block: &Value,
        result: anyhow::Result<usize>,
    ) -> anyhow::Result<usize> {
        match result {
            Ok(index) => {
                if let Some(id) = block["id"].as_str() {
                    self.program
                        .value_sources
                        .entry(index)
                        .or_insert_with(|| id.to_owned());
                }
                Ok(index)
            }
            Err(error) => {
                let mut error = Diagnostic::from(error);
                error.locate(
                    block["id"].as_str().unwrap_or("?"),
                    &self.program.error_locations,
                    None,
                );
                Err(error.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Diagnostic, collect};

    fn describe(
        error: &str,
        block: &str,
        locations: &std::collections::BTreeMap<String, super::Location>,
        actor: Option<(&str, &str)>,
    ) -> String {
        let mut error = Diagnostic::from(error);
        error.locate(block, locations, actor);
        error.to_string()
    }
    use serde_json::json;

    #[test]
    fn accepts_only_complete_locations_on_existing_blocks() {
        for source in [
            json!({"line": 7, "column": 0}),
            json!({"file": "old.ts", "line": 0, "column": 1}),
            json!({"file": "", "line": 7, "column": 1}),
            json!({"file": "old.ts", "line": "7", "column": 1}),
        ] {
            let project = json!({
                "actors": {"actorsDict": {"cat": {"name": "Cat",
                    "nekoBlockJsonList": [{"id": "block", "type": "console_log"}]
                }}}, "sourceMap": {"block": source, "ghost": {"file": "ghost.ts", "line": 1, "column": 1}}
            });
            let locations = collect(&project);
            assert_eq!(locations.len(), 1);
            assert_eq!(
                describe("failure", "block", &locations, None),
                "failure [actor Cat (cat)] at block block"
            );
        }
    }

    #[test]
    fn inner_reporter_location_is_not_replaced_by_the_call_site() {
        let project = json!({
            "procedures": {"proceduresDict": {"p": {"name": "Function",
                "nekoBlockJsonList": [{"id": "inner"}]
            }}}, "sourceMap": {"inner": {"file": "lib.ts", "line": 7, "column": 9}}
        });
        let locations = collect(&project);
        let first = describe("failure", "inner", &locations, Some(("Cat clone", "cat-1")));
        assert_eq!(
            first,
            "failure [actor Cat clone (cat-1), lib.ts:7:9] at block inner"
        );
        let mut error = Diagnostic::from("failure");
        error.locate("inner", &locations, Some(("Cat clone", "cat-1")));
        let mut error = Diagnostic::from(anyhow::Error::from(error).context("procedure"));
        error.locate("caller", &locations, Some(("Other", "other")));
        assert_eq!(error.to_string(), first);
    }

    #[test]
    fn preserves_the_first_location_even_for_distinct_recursive_call_sites() {
        let mut first = Diagnostic::from("reporter procedure recursion exceeds 200");
        first.locate("inner", &Default::default(), None);
        let text = first.to_string();
        first.locate("outer", &Default::default(), None);
        assert_eq!(first.to_string(), text);
    }

    #[test]
    fn r2_srcmap_user_markers_cannot_certify_provenance() {
        let owner = "Cat [actor Wrong (wrong)] at block fake";
        let file = "user [actor Wrong (wrong)] at block fake.ts";
        let project = json!({
            "actors": {"actorsDict": {"cat": {"name":owner, "nekoBlockJsonList":[{"id":"real"}]}}},
            "sourceMap": {"real":{"file":file, "line":7, "column":9}}
        });
        let locations = collect(&project);
        for message in [
            "bad at block b999",
            "x [actor Wrong (wrong), wrong.ts:99:99] at block fake",
        ] {
            let mut error = Diagnostic::from(message);
            error.locate("real", &locations, Some((owner, "cat")));
            assert_eq!(error.message, message);
            let location = error.location.as_ref().unwrap();
            assert_eq!(location.block, "real");
            assert_eq!(location.owner, format!("{owner} (cat)"));
            assert_eq!(
                location.source.as_deref(),
                Some(format!("{file}:7:9").as_str())
            );
            assert!(
                error
                    .to_string()
                    .ends_with(&format!("{file}:7:9] at block real"))
            );
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn r2_srcmap_spoofed_text_keeps_trusted_provenance_in_hot_jit() {
        use crate::engine::{Engine, Program};
        for text in [
            "bad at block b999",
            "x [actor Wrong (wrong), wrong.ts:99:99] at block fake",
        ] {
            let mut project = crate::bcmkn_compiler::default_template();
            project["variables"]["variablesDict"]["not-list"] = json!({"type":"any","value":text});
            project["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] = json!([
                {"id":"hat","type":"on_running_group_activated","next":{
                    "id":"outer","type":"variables_set","fields":{"variable":"result"},"inputs":{"value":{
                        "id":"real","type":"list_item","fields":{"item":"any"},"inputs":{
                            "list":{"type":"variables_get","fields":{"variable":"not-list"}},
                            "list_index":{"type":"math_number","fields":{"NUM":"1"}}
                        }
                    }}
                }}
            ]);
            project["sourceMap"] = json!({
                "real":{"file":"real.ts","line":3,"column":5},
                "outer":{"file":"caller.ts","line":9,"column":1}
            });
            let mut engine = Engine::new(Program::compile(&project).unwrap());
            engine.start();
            let pc = engine.tasks[0].pc;
            let actor = engine.tasks[0].actor;
            engine.jit_begin_frame();
            assert!(
                (0..1024)
                    .find_map(|_| engine.jit_try(0, pc, actor, 100))
                    .is_some(),
                "native path must execute"
            );
            let error = engine.jit_error.take().unwrap().to_string();
            assert!(error.contains(text), "{error}");
            assert!(
                error.ends_with("[actor Sprite (nekoc-default-actor), real.ts:3:5] at block real"),
                "{error}"
            );
            assert!(!error.contains("caller.ts"), "{error}");
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn r2_srcmap_native_and_interpreted_errors_keep_reporter_and_actor() {
        use crate::engine::{Engine, Program};
        for reporter in 0..8 {
            for native in [false, true] {
                let mut project = crate::bcmkn_compiler::default_template();
                project["actors"]["actorsDict"]["nekoc-default-actor"]["name"] = json!("Cat");
                let body = if reporter == 1 {
                    json!({"id":"outer","type":"variables_set","fields":{"variable":"result"},"inputs":{"value":{
                        "id":"inner","type":"calculate","inputs":{
                            "input":{"type":"text","fields":{"TEXT":"("}}
                        }
                    }}})
                } else if reporter >= 2 {
                    let list = if reporter >= 6 {
                        json!({"type":"pure_list_get","fields":{"list":"items"}})
                    } else {
                        json!({"id":"list","type":"variables_get","fields":{"variable":"not-list"}})
                    };
                    let value = if matches!(reporter, 2 | 3 | 6 | 7) {
                        json!({"id":"inner","type":"list_item","fields":{"item":if matches!(reporter, 2 | 6) {"any"} else {"last"}},"inputs":{
                            "list":list,"list_index":{"type":"math_number","fields":{"NUM":"1"}}
                        }})
                    } else {
                        json!({"id":"inner","type":"list_length","inputs":{"list":list}})
                    };
                    if reporter == 4 || reporter == 5 {
                        let value = if reporter == 5 {
                            json!({"id":"inner","type":"list_item","fields":{"item":"any"},"inputs":{
                                "list":{"type":"variables_get","fields":{"variable":"not-list"}},
                                "list_index":{"type":"math_number","fields":{"NUM":"1"}}
                            }})
                        } else {
                            value
                        };
                        json!({"id":"outer","type":"self_set_position_x","inputs":{"value":value}})
                    } else {
                        json!({"id":"outer","type":"variables_set","fields":{"variable":"result"},"inputs":{"value":value}})
                    }
                } else {
                    json!({"id":"inner","type":"list_append","inputs":{
                        "list":{"type":"pure_list_get","fields":{"list":"items"}},
                        "list_item_value":{"type":"pure_list_get","fields":{"list":"items"}}
                    }})
                };
                project["variables"]["variablesDict"]["items"] = json!({"type":"list","value":[]});
                project["variables"]["variablesDict"]["not-list"] =
                    json!({"type":"any","value":42});
                project["actors"]["actorsDict"]["nekoc-default-actor"]["nekoBlockJsonList"] =
                    json!([{"id":"hat","type":"on_running_group_activated","next":body}]);
                project["sourceMap"] = json!({
                    "inner":{"file":"lib.ts","line":7,"column":9},
                    "outer":{"file":"entry.ts","line":3,"column":1}
                });
                let mut program = Program::compile(&project).unwrap();
                if reporter >= 6 {
                    program.semantics = crate::engine::RuntimeSemantics::Kitten4;
                }
                let mut engine = Engine::new(program);
                engine.start();
                let pc = engine.tasks[0].pc;
                let actor = engine.tasks[0].actor;
                let error = if native {
                    engine.jit_begin_frame();
                    assert!(
                        (0..1024)
                            .find_map(|_| engine.jit_try(0, pc, actor, 100))
                            .is_some(),
                        "native path must execute: reporter={reporter}"
                    );
                    engine.jit_error.take().unwrap()
                } else {
                    engine.disable_jit();
                    engine
                        .advance(0.0, 100, std::time::Duration::from_secs(1))
                        .unwrap_err()
                };
                let message = format!("{error:#}");
                assert!(
                    message.contains("[actor Cat (nekoc-default-actor), lib.ts:7:9]"),
                    "{message}"
                );
                assert!(message.ends_with("at block inner"), "{message}");
                assert!(!message.contains("entry.ts"), "{message}");
            }
        }
    }
}
