// Canonical KN opcodes accepted by src/kitten4.rs::translate for new works.
// This is an early, source-located preflight, not a native-format validator.
const kitten4Blocks = new Set(`
  on_running_group_activated on_keydown self_listen when broadcast_input
  variables_get variables_set change_variables pure_list_get list_get
  list_append list_insert_value replace_list_item delete_list_item list_item
  list_length list_index_of list_is_exist list_copy
  math_number math_arithmetic math_function math_round math_trig math_modulo
  random_num divisible_by math_number_property convert_type
  text logic_boolean logic_compare logic_operation logic_negate
  text_join text_split text_length text_contain text_select
  repeat_n_times repeat_forever repeat_forever_until controls_if warp break
  wait wait_until self_broadcast self_broadcast_and_wait
  self_go_forward self_move_to self_rotate self_point_towards self_bounce_off_edge
  self_set_position_x self_set_position_y self_add_position_x self_add_position_y
  self_change_coordinate_x self_change_coordinate_y coordinate_of_sprite
  self_get_position_x self_get_position_y self_get_rotation get_orientation
  appearance_of_sprite self_appear set_scale self_dialog self_dialog_wait
  self_pen_down self_pen_up self_set_pen_size self_change_pen_size
  self_set_pen_color self_set_pen_color_property self_change_pen_color_property
  clear_drawing timer set_timer_state show_hide_timer
`.trim().split(/\s+/));

export function compileTarget(target = "kitten-n") {
  if (!["kitten-n", "kitten4"].includes(target)) throw new Error(`Unknown compile target ${JSON.stringify(target)}; use kitten-n or kitten4`);
  return { name: target, numberTraversal: target !== "kitten4" };
}

export function checkTargetBlock(c, block, node) {
  if (c.target.name !== "kitten4") return;
  let hint;
  if (!kitten4Blocks.has(block.type)) {
    hint = block.type.startsWith("traverse_number")
      ? "Replace forRange with an ordinary for (let i = start; i < end; i += step) loop."
      : block.type.startsWith("procedures_2_")
        ? "New custom procedures are not supported by the native exporter; use a non-recursive inline function or inline the body."
        : "Use basic variables, arithmetic and control blocks instead, or select target kitten-n.";
  } else if (block.type === "math_trig" && !["sin", "cos", "tan"].includes(block.fields?.type)) {
    hint = "Only forward sin/cos/tan are mapped; select target kitten-n for inverse trigonometry.";
  } else if (block.type === "appearance_of_sprite" && block.fields?.appearance !== "direction") {
    hint = "Only the direction reporter is mapped; select target kitten-n for other appearance reporters.";
  }
  if (hint) c.unsupported(node, `Cannot compile ${block.type} to native Kitten 4. ${hint}`);
}
