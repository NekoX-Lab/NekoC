// Self-authored probes; never copy published projects into tracked fixtures.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const cases = JSON.parse(await fs.readFile(new URL('../../tests/fixtures/r3-knpen-cases.json', import.meta.url), 'utf8'));
export function command([name, value, y]) {
  const commands = {
    move: ['self_move_to', { x: value, y }], size: ['self_set_pen_size', { size: value }],
    alpha: ['self_set_pen_color_property', { scope: 'alpha', val: value }],
    color: ['self_set_pen_color', { color: value }], down: ['self_pen_down', {}],
    up: ['self_pen_up', {}], clear: ['clear_drawing', {}],
  };
  if (!commands[name]) throw Error(`Unknown pen probe action: ${name}`);
  return commands[name];
}
export async function penProject(actions) {
  const p = JSON.parse(await fs.readFile(new URL('../../samples/kitten-n-0.27.4.bcmkn', import.meta.url), 'utf8'));
  let serial = 0;
  const block = (type, fields = {}, inputs = {}) => ({ id: `r3-knpen-${++serial}`, type, fields, inputs });
  const blocks = [block('on_running_group_activated'), ...actions.map(action => {
    const [type, args] = command(action), fields = {}, inputs = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'number') inputs[key] = block('math_number', { NUM: String(value) });
      else fields[key] = value;
    }
    return block(type, fields, inputs);
  })];
  for (let i = 1; i < blocks.length; i++) blocks[i - 1].next = blocks[i];
  p.projectName = 'NekoC r3-knpen';
  p.actors.actorsDict['nekoc-default-actor'].visible = false;
  p.actors.actorsDict['nekoc-default-actor'].nekoBlockJsonList = [blocks[0]];
  return p;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fs.mkdir('dist/r3-knpen/fixtures', { recursive: true });
  for (const c of cases) await fs.writeFile(`dist/r3-knpen/fixtures/${c.name}.bcmkn`, JSON.stringify(await penProject(c.actions), null, 2) + '\n');
}
