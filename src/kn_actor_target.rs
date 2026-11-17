//! These two menus persist current-scene actor IDs, not the broader sensing or
//! tell menus. Resolve names only after all actor IDs have been allocated.
//! Keep the policy scoped to the exact block types (official KN
//! 0.27.4 main.8ccf2442.js, actor menu generator with no optional arguments).
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Context {
    scene: String,
    actor: Option<String>,
}

struct Menu {
    actors: BTreeMap<String, String>,
    scenes: BTreeMap<String, BTreeSet<String>>,
    current_scene: String,
}

impl Menu {
    fn new(project: &Value) -> Self {
        Self {
            actors: project
                .pointer("/actors/actorsDict")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .map(|(id, a)| (id.clone(), a["name"].as_str().unwrap_or("").to_owned()))
                .collect(),
            scenes: project
                .pointer("/scenes/scenesDict")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .map(|(id, s)| {
                    (
                        id.clone(),
                        s["actorIds"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect(),
                    )
                })
                .collect(),
            current_scene: project
                .pointer("/scenes/currentSceneId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        }
    }

    fn resolve(&self, target: &str, context: &Context, names: bool) -> Result<String, String> {
        let ids = self.scenes.get(&context.scene);
        let eligible =
            |id: &str| self.actors.contains_key(id) && ids.is_some_and(|ids| ids.contains(id));
        // Exact IDs always win, including an out-of-scene ID that happens to
        // equal an eligible actor's name. Never silently select a different actor.
        if self.actors.contains_key(target) {
            return if eligible(target) {
                Ok(target.to_owned())
            } else {
                Err(format!(
                    "actor ID {target:?} is not selectable in scene {:?}",
                    context.scene
                ))
            };
        }
        if names && target == "--self" {
            return context.actor.as_ref().filter(|id| eligible(id)).cloned()
                .ok_or_else(|| "--self requires a definite actor owner/caller, not a scene or an unused procedure".to_owned());
        }
        if names {
            let matches = self
                .actors
                .iter()
                .filter(|(id, name)| eligible(id) && name.as_str() == target)
                .map(|(id, _)| id)
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                return Ok(matches[0].clone());
            }
            if matches.len() > 1 {
                return Err(format!(
                    "ambiguous actor name {target:?} in scene {:?}",
                    context.scene
                ));
            }
        }
        Err(format!(
            "target {target:?} is not a current-scene actor ID{}; this menu has no special targets",
            if names { " or unique actor name" } else { "" }
        ))
    }

    fn owner_contexts(&self, kind: &str, id: &str) -> BTreeSet<Context> {
        if kind == "scenes" {
            return BTreeSet::from([Context {
                scene: id.to_owned(),
                actor: None,
            }]);
        }
        self.scenes
            .iter()
            .filter(|(_, ids)| ids.contains(id))
            .map(|(scene, _)| Context {
                scene: scene.clone(),
                actor: Some(id.to_owned()),
            })
            .collect()
    }

    fn tell_contexts(&self, block: &Value, contexts: &BTreeSet<Context>) -> BTreeSet<Context> {
        let target = block["fields"]["sprite"].as_str().unwrap_or("");
        contexts
            .iter()
            .flat_map(|context| {
                if let Ok(id) = self.resolve(target, context, true) {
                    vec![Context {
                        scene: context.scene.clone(),
                        actor: Some(id),
                    }]
                } else {
                    // Broader/dynamic tell targets are not this menu's policy. Track
                    // every possible actor rather than guess the first actor.
                    self.scenes
                        .get(&context.scene)
                        .into_iter()
                        .flatten()
                        .map(|id| Context {
                            scene: context.scene.clone(),
                            actor: Some(id.clone()),
                        })
                        .collect()
                }
            })
            .collect()
    }
}

fn walk(
    value: &Value,
    contexts: &BTreeSet<Context>,
    menu: &Menu,
    visit: &mut impl FnMut(&Value, &BTreeSet<Context>),
) {
    let mut pending = vec![(value, contexts.clone())];
    while let Some((value, contexts)) = pending.pop() {
        match value {
            Value::Object(object) => {
                visit(value, &contexts);
                let tell = matches!(value["type"].as_str(), Some("tell" | "sync_tell"));
                for (key, child) in object {
                    let child_contexts = if tell && key == "statements" {
                        menu.tell_contexts(value, &contexts)
                    } else {
                        contexts.clone()
                    };
                    pending.push((child, child_contexts));
                }
            }
            Value::Array(items) => pending.extend(items.iter().map(|v| (v, contexts.clone()))),
            _ => {}
        }
    }
}

/// Resolve after allocation when `rewrite` is true; otherwise enforce persisted
/// IDs for imported projects. Procedure contexts propagate to a fixed point, so
/// shared/recursive procedures must have the same selectable target for callers.
type Replacements = BTreeMap<String, BTreeMap<String, String>>;

fn analyze(project: &Value, rewrite: bool) -> (Vec<Value>, Replacements) {
    let menu = Menu::new(project);
    let mut owners = Vec::new();
    for (kind, dict) in [("scenes", "scenesDict"), ("actors", "actorsDict")] {
        if let Some(map) = project
            .pointer(&format!("/{kind}/{dict}"))
            .and_then(Value::as_object)
        {
            for (id, owner) in map {
                owners.push((
                    format!(
                        "/{kind}/{dict}/{}/nekoBlockJsonList",
                        id.replace('~', "~0").replace('/', "~1")
                    ),
                    menu.owner_contexts(kind, id),
                    &owner["nekoBlockJsonList"],
                ));
            }
        }
    }
    let procedures = project
        .pointer("/procedures/proceduresDict")
        .and_then(Value::as_object);
    let mut callers: BTreeMap<String, BTreeSet<Context>> = BTreeMap::new();
    loop {
        let mut next = callers.clone();
        let mut calls = |block: &Value, contexts: &BTreeSet<Context>| {
            if matches!(
                block["type"].as_str(),
                Some("procedures_2_callnoreturn" | "procedures_2_callreturn")
            ) && let Some(id) = crate::runtime::helpers::procedure_def_id(block)
                .or_else(|| block["fields"]["NAME"].as_str())
            {
                next.entry(id.to_owned())
                    .or_default()
                    .extend(contexts.iter().cloned());
            }
        };
        for (_, contexts, blocks) in &owners {
            walk(blocks, contexts, &menu, &mut calls);
        }
        for (id, proc) in procedures.into_iter().flatten() {
            if let Some(contexts) = callers.get(id) {
                walk(&proc["nekoBlockJsonList"], contexts, &menu, &mut calls);
            }
        }
        if next == callers {
            break;
        }
        callers = next;
    }
    for (id, proc) in procedures.into_iter().flatten() {
        let contexts = callers
            .remove(id)
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| {
                BTreeSet::from([Context {
                    scene: menu.current_scene.clone(),
                    actor: None,
                }])
            });
        owners.push((
            format!(
                "/procedures/proceduresDict/{}/nekoBlockJsonList",
                id.replace('~', "~0").replace('/', "~1")
            ),
            contexts,
            &proc["nekoBlockJsonList"],
        ));
    }
    let mut issues = Vec::new();
    let mut all_replacements = BTreeMap::new();
    for (path, contexts, blocks) in owners {
        let mut replacements = BTreeMap::new();
        walk(blocks, &contexts, &menu, &mut |block, contexts| {
            if !matches!(
                block["type"].as_str(),
                Some("self_rotate_around" | "on_bump_actor")
            ) {
                return;
            }
            let target = block["fields"]["sprite"].as_str().unwrap_or("");
            let resolutions = contexts
                .iter()
                .map(|c| menu.resolve(target, c, rewrite))
                .collect::<Result<BTreeSet<_>, _>>();
            let result = resolutions.and_then(|ids| {
                if ids.len() == 1 {
                    Ok(ids.into_iter().next().unwrap())
                } else {
                    Err(
                        "target differs between procedure callers (or owner has no scene)"
                            .to_owned(),
                    )
                }
            });
            match result {
                Ok(id) => { replacements.insert(block["id"].as_str().unwrap_or("").to_owned(), id); }
                Err(reason) => issues.push(json!({
                    "kind": "invalid_actor_menu_target", "owner": path, "block_id": block["id"],
                    "block_type": block["type"], "target": target,
                    "source": block["_nekocTargetSource"],
                    "message": format!("{} sprite: {reason}. Use an explicit, unique actor name or actual ID selectable in every caller's scene; place --self in an actor-owned script.", block["type"].as_str().unwrap_or("")),
                })),
            }
        });
        all_replacements.insert(path, replacements);
    }
    (issues, all_replacements)
}

pub(crate) fn validate(project: &Value) -> Vec<Value> {
    analyze(project, false).0
}

pub(crate) fn resolve(project: &mut Value) -> Vec<Value> {
    let (issues, replacements) = analyze(project, true);
    for (path, replacements) in replacements {
        if let Some(blocks) = project.pointer_mut(&path) {
            let mut pending = vec![blocks];
            while let Some(value) = pending.pop() {
                match value {
                    Value::Object(object) => {
                        if let Some(id) = object
                            .get("id")
                            .and_then(Value::as_str)
                            .and_then(|id| replacements.get(id))
                        {
                            object.get_mut("fields").unwrap()["sprite"] = json!(id);
                        }
                        object.remove("_nekocTargetSource");
                        pending.extend(object.values_mut());
                    }
                    Value::Array(items) => pending.extend(items),
                    _ => {}
                }
            }
        }
    }
    issues
}
