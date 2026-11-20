//! KN list-copy graph semantics, independently implemented from official
//! main.bfc86683.js getListDomainFunctions/listCopy (docs/kn-r3-partial.md).
use super::{Cell, List};

pub(super) fn copy_items(source: &List) -> Vec<Cell> {
    // Clone the whole graph in one traversal. Cloning each element separately
    // would split references shared between elements or object properties.
    // Finish the snapshot before mutating the target, including self-copy.
    let Cell::List(snapshot) = Cell::List(source.clone()).deep_clone() else {
        unreachable!()
    };
    // Object properties can point back to this root. Keep its contents alive
    // and shallow-clone the elements, or those back-references become empty.
    snapshot.borrow().clone()
}
