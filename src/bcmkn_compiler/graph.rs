//! Workspace graph safety. Validate once, then move each block into a tree once.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn check(workspace: &Value) -> Result<()> {
    let blocks = workspace["blocks"]
        .as_object()
        .context("workspaceData.blocks must be an object")?;
    let empty = Map::new();
    let edges = match workspace.get("connections") {
        Some(value) => value
            .as_object()
            .context("workspaceData.connections must be an object")?,
        None => &empty,
    };
    for (id, block) in blocks {
        ensure!(block.is_object(), "workspace block {id} must be an object");
    }
    let mut parents = BTreeSet::new();
    for (id, children) in edges {
        let block = blocks
            .get(id)
            .with_context(|| format!("connections reference missing parent block {id}"))?;
        let children = children
            .as_object()
            .with_context(|| format!("connections for {id} must be an object"))?;
        let mut sockets = BTreeSet::new();
        for (child, edge) in children {
            ensure!(
                blocks.contains_key(child),
                "connection {id} references missing block {child}"
            );
            ensure!(
                parents.insert(child.as_str()),
                "workspace block {child} has multiple parents"
            );
            let socket = match edge["type"].as_str() {
                Some("next") => {
                    ensure!(
                        !crate::validate::block_has_no_next_socket(block),
                        "Kitten N block {} ({id}) has no next socket; cannot connect {child}",
                        block["type"]
                    );
                    "next".to_owned()
                }
                Some("input") => {
                    let name = edge["input_name"]
                        .as_str()
                        .context("input connection is missing input_name")?;
                    let kind = edge["input_type"].as_str().unwrap_or("value");
                    ensure!(
                        matches!(kind, "value" | "statement"),
                        "invalid input_type {kind} at {id}"
                    );
                    format!("input:{name}")
                }
                other => bail!("unsupported connection type {other:?} at {id}"),
            };
            ensure!(
                sockets.insert(socket),
                "duplicate connection socket at workspace block {id}"
            );
        }
    }
    let mut state = BTreeMap::new();
    // Roots first makes the depth budget independent of dictionary order.
    // Visit remaining nodes too, including a detached strongly connected graph.
    for root in blocks
        .keys()
        .filter(|id| !parents.contains(id.as_str()))
        .chain(blocks.keys())
    {
        let mut pending = vec![(root.as_str(), 0usize, 0usize, false)];
        while let Some((id, depth, path, exit)) = pending.pop() {
            if exit {
                state.insert(id, 2);
                continue;
            }
            ensure!(
                depth <= crate::json::MAX_BLOCK_DEPTH,
                "workspace block nesting exceeds {} at {id}",
                crate::json::MAX_BLOCK_DEPTH
            );
            ensure!(
                path <= crate::json::MAX_BLOCK_PATH,
                "workspace block path exceeds {} at {id}",
                crate::json::MAX_BLOCK_PATH
            );
            match state.get(id) {
                Some(1) => bail!("cycle in workspace block graph at {id}"),
                Some(2) => continue,
                _ => {}
            }
            state.insert(id, 1);
            pending.push((id, depth, path, true));
            if let Some(children) = edges.get(id).and_then(Value::as_object) {
                pending.extend(children.iter().map(|(child, edge)| {
                    (
                        child.as_str(),
                        depth + usize::from(edge["type"] != "next"),
                        path + 1,
                        false,
                    )
                }));
            }
        }
    }
    Ok(())
}

pub(super) fn nest(
    id: &str,
    blocks: &Map<String, Value>,
    edges: &Map<String, Value>,
) -> Result<Value> {
    let mut pending = vec![(id, None, false)];
    // Json owners make error cleanup stack-safe, even after a deep subtree moved.
    let mut output = BTreeMap::<&str, crate::json::Json>::new();
    while let Some((id, parent, exit)) = pending.pop() {
        if !exit {
            pending.push((id, parent, true));
            if let Some(children) = edges.get(id).and_then(Value::as_object) {
                pending.extend(
                    children
                        .keys()
                        .rev()
                        .map(|child| (child.as_str(), Some(id), false)),
                );
            }
            continue;
        }
        let mut nested = crate::json::Json::new(crate::json::clone_value(&blocks[id]));
        let object = nested
            .as_object_mut()
            .context("workspace block must be an object")?;
        // Rebuilt fields may hold arbitrary deep input JSON. Dispose of every
        // old value explicitly before insertion, including parent_id metadata.
        for key in ["next", "inputs", "statements", "parent_id"] {
            if let Some(old) = object.remove(key) {
                crate::json::discard(old);
            }
        }
        object.insert("parent_id".into(), json!(parent.unwrap_or("")));
        object.entry("shield").or_insert(json!(false));
        let mut inputs = BTreeMap::new();
        let mut statements = BTreeMap::new();
        if let Some(children) = edges.get(id).and_then(Value::as_object) {
            for (child, edge) in children {
                let value = output
                    .remove(child.as_str())
                    .context("missing expanded workspace child")?;
                if edge["type"] == "next" {
                    object.insert("next".into(), value.into_value());
                } else {
                    let name = edge["input_name"]
                        .as_str()
                        .context("input connection is missing input_name")?;
                    let items = if edge["input_type"] == "statement" {
                        &mut statements
                    } else {
                        &mut inputs
                    };
                    items.insert(name.to_owned(), value);
                }
            }
        }
        for (key, items) in [("inputs", inputs), ("statements", statements)] {
            if !items.is_empty() {
                object.insert(
                    key.into(),
                    Value::Object(
                        items
                            .into_iter()
                            .map(|(k, v)| (k, v.into_value()))
                            .collect(),
                    ),
                );
            }
        }
        output.insert(id, nested);
    }
    Ok(output
        .remove(id)
        .context("missing expanded workspace root")?
        .into_value())
}
