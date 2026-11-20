import test from 'node:test';
import assert from 'node:assert/strict';
import { StageOverlay } from '../web/overlay.js';

// Minimal DOM for protocol tests. Real CSS/layout and trusted pointer input are
// checked separately against the official player in the opt-in browser test.
class Element {
  children = []; dataset = {}; handlers = new Map();
  style = { setProperty(name, value) { this[name] = value; } };
  className = ''; hidden = false; textContent = '';
  classList = {
    add: name => { this.className += ` ${name}`; },
    contains: name => this.className.split(' ').includes(name),
  };
  constructor(tag) { this.tag = tag; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this[name] = value; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  querySelector(tag) { return this.children.find(child => child.tag === tag) || this.children.map(child => child.querySelector(tag)).find(Boolean); }
  addEventListener(type, fn) { this.handlers.set(type, [...(this.handlers.get(type) || []), fn]); }
  emit(type, detail = {}) {
    const event = { type, button: 0, detail: 0, stopPropagation() { this.stopped = true; }, ...detail };
    for (let target = this; target; target = event.stopped ? null : target.parent) {
      target[`on${type}`]?.(event);
      for (const fn of target.handlers.get(type) || []) fn(event);
    }
  }
}

function fixture(t, { width = 620, height = 900, kitten4 = true, visible = false } = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    head: new Element('head'), createElement: tag => new Element(tag), getElementById: () => null,
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  const box = new Element('div'), answers = [];
  let accepting = true;
  const renderer = { width, height, kitten4, sprites: [{ id: 'actor', visible }], spriteImage: () => null };
  const overlay = new StageOverlay(box, renderer, event => { if (!accepting) return false; answers.push(event); });
  // This unit harness has no layout, connection state or focus navigation.
  overlay.focusControl = () => {};
  const ask = { id: 1, sprite: 'actor', question: 'NekoC question', choices: ['first', '', 'last'] };
  return { overlay, box, answers, ask, accept(value) { accepting = value; },
    buttons() { return overlay.ask.children.find(child => child.className === 'choices').children; } };
}

for (const [width, height, columns] of [[1280, 720, 2], [620, 900, 1], [720, 720, 1]]) {
  test(`r3-k4ui ${width}x${height}: row count and pop distance follow orientation`, t => {
    const f = fixture(t, { width, height });
    f.overlay.apply({ ask: f.ask });
    const initial = Math.ceil(f.ask.choices.length / columns) * (height * .0888) + 10;
    assert.equal(f.overlay.ask.style['--choice-columns'], String(columns));
    assert.equal(f.overlay.askDistance, initial, 'Start does not advance the pop animation');
    let distance = initial;
    for (let frame = 2; frame <= 40; frame++) {
      distance -= Math.ceil(distance / 4);
      f.overlay.apply({ ask: f.ask });
      assert.equal(f.overlay.askDistance, distance);
    }
    assert.equal(distance <= 0, true);
  });
}

test('r3-k4ui choice text keeps empty/whitespace and truncates UTF-16 display only', t => {
  const f = fixture(t), long = '12345678901234567890!';
  f.ask.choices = ['', '  spaced  ', '123456789012345678😀Z', long];
  f.overlay.showAsk(f.ask);
  const buttons = f.buttons();
  assert.deepEqual(buttons.map(button => button.textContent), ['', '  spaced  ', '123456789012345678\ud83d…', '1234567890123456789…']);
  buttons[3].emit('mouseup');
  buttons[3].emit('click', { detail: 1 });
  buttons[3].emit('touchend');
  assert.deepEqual(f.answers, [{ kind: 'answer', id: 1, text: long, choice: 4 }]);
  assert.equal(f.overlay.ask, null);
});

test('r3-k4ui header hides for visible actors and empty questions only', t => {
  const f = fixture(t, { visible: true });
  f.overlay.showAsk(f.ask);
  assert.equal(f.overlay.ask.querySelector('p').hidden, true);
  f.overlay.renderer.sprites[0].visible = false;
  f.overlay.showAsk({ ...f.ask, question: '' });
  assert.equal(f.overlay.ask.querySelector('p').hidden, true);
  f.overlay.showAsk(f.ask);
  assert.equal(f.overlay.ask.querySelector('p').hidden, false);
});

test('r3-k4ui release answers once, rejects stale controls, and retries backpressure', t => {
  const f = fixture(t);
  f.overlay.showAsk(f.ask);
  const stale = f.buttons()[0];
  f.overlay.showAsk({ ...f.ask, id: 2 });
  stale.emit('mouseup');
  assert.deepEqual(f.answers, []);
  const button = f.buttons()[1], leaks = [];
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'click']) {
    f.box.addEventListener(type, () => leaks.push(type));
  }
  f.accept(false);
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'keyup', 'pointerup', 'mouseup', 'click']) button.emit(type, { detail: 1 });
  assert.ok(f.overlay.ask, 'rejected input remains available');
  assert.deepEqual(f.answers, []);
  assert.deepEqual(leaks, []);
  f.accept(true);
  button.emit('mouseup', { button: 2 });
  assert.deepEqual(f.answers, [], 'right button is not a selection');
  button.emit('touchend');
  button.emit('mouseup');
  assert.deepEqual(f.answers, [{ kind: 'answer', id: 2, text: '', choice: 2 }]);
  f.overlay.reset();
  stale.emit('click');
  assert.equal(f.answers.length, 1);
});

test('r3-k4ui KN choices retain labels and click activation', t => {
  const f = fixture(t, { kitten4: false });
  f.ask.choices = ['', '12345678901234567890!'];
  f.overlay.showAsk(f.ask);
  assert.deepEqual(f.buttons().map(button => button.textContent), ['选项 1', f.ask.choices[1]]);
  assert.equal(f.overlay.ask.classList.contains('k4-choice'), false);
  f.buttons()[0].emit('mouseup');
  assert.deepEqual(f.answers, []);
  f.buttons()[1].emit('click', { detail: 1 });
  assert.deepEqual(f.answers, [{ kind: 'answer', id: 1, text: f.ask.choices[1], choice: 2 }]);
});

test('r3-k4ui choice keyboard activation stays available and accepted frames do not recreate it', t => {
  const f = fixture(t);
  f.overlay.apply({ ask: f.ask });
  const button = f.buttons()[0];
  button.emit('click');
  button.emit('click');
  f.overlay.apply({ ask: f.ask });
  assert.equal(f.overlay.ask, null);
  assert.deepEqual(f.answers, [{ kind: 'answer', id: 1, text: 'first', choice: 1 }]);
  f.overlay.apply({});
  f.overlay.apply({ ask: { ...f.ask, id: 2 } });
  assert.ok(f.overlay.ask);
  f.buttons()[2].emit('click');
  assert.deepEqual(f.answers.at(-1), { kind: 'answer', id: 2, text: 'last', choice: 3 });
});

test('r3-k4ui typed asks also reject duplicate accepted callbacks without changing retry behavior', t => {
  const f = fixture(t);
  f.overlay.showAsk({ id: 3, question: 'type here' });
  f.overlay.ask.querySelector('input').value = '<literal answer>';
  const button = f.overlay.ask.querySelector('button');
  f.accept(false);
  button.emit('click');
  assert.ok(f.overlay.ask);
  f.accept(true);
  button.emit('click'); button.emit('click');
  assert.deepEqual(f.answers, [{ kind: 'answer', id: 3, text: '<literal answer>' }]);
});

test('r3-k4ui official probes remain editable original fixtures with inline media only', async () => {
  const { choiceFixtures } = await import('../tools/compat/r3-k4ui-probe.mjs');
  const fixtures = await choiceFixtures();
  assert.deepEqual(fixtures.map(entry => entry.name), ['landscape', 'portrait', 'visible', 'no-question']);
  for (const { project, choices, question } of fixtures) {
    assert.equal(project.compile_result, undefined);
    assert.deepEqual(project.variables, {});
    const actor = Object.values(project.theatre.actors)[0];
    const blocks = Object.values(actor.block_data_json.blocks);
    assert.equal(blocks.filter(block => block.type === 'ask_and_choose').length, 1);
    assert.deepEqual(blocks.filter(block => block.type === 'text').map(block => block.fields.TEXT), [question, ...choices]);
    for (const style of Object.values(project.theatre.styles)) assert.ok(style.url.startsWith('data:image/svg+xml;base64,'));
  }
});

test('r3-k4ui real browser choices match official geometry, text, hover and release', {
  skip: !process.env.NEKOC_R3_K4UI_INTEGRATION, timeout: 600000,
}, async () => {
  const { recordChoices } = await import('../tools/compat/r3-k4ui-probe.mjs');
  const evidence = await recordChoices();
  for (const entry of evidence.cases) {
    assert.deepEqual(entry.errors, [], entry.name);
    assert.ok(entry.assets.some(asset => asset.sha256 === '0f7933d51266add6cbad0682b9531036dc1c8daf8c522cde4243744376ce4160'));
    assert.ok(entry.externalRequests.every(request => request.action === 'blocked'));
    assert.deepEqual(entry.frames.map(frame => frame.frame), [1, 40]);
    for (const frame of entry.frames) {
      const { official, local } = frame;
      assert.deepEqual(local.labels, official.labels, `${entry.name}/${frame.frame} text`);
      assert.equal(local.header, official.header, `${entry.name} header`);
      assert.equal(local.buttons.length, official.buttons.length);
      for (let i = 0; i < local.buttons.length; i++) {
        for (const dimension of ['x', 'y', 'width', 'height']) {
          assert.ok(Math.abs(local.buttons[i][dimension] - official.buttons[i][dimension]) < .1,
            `${entry.name}/${frame.frame} button ${i} ${dimension}: ${local.buttons[i][dimension]} vs ${official.buttons[i][dimension]}`);
        }
      }
      // Measured CSS/PIXI edge/text residual, not a claim of pixel parity.
      // Portrait has three full-width outlines instead of two half-width rows.
      const pixelCeiling = entry.name === 'portrait' ? 1.6 : 1;
      assert.ok(frame.pixels.changedPercent < pixelCeiling, `${entry.name}/${frame.frame}: ${frame.pixels.changedPercent}%`);
    }
    assert.deepEqual(entry.interaction.local.answers, [{ kind: 'answer', id: 1, text: entry.choices.at(-1), choice: entry.choices.length }]);
    assert.equal(entry.interaction.official.index, entry.choices.length - 1);
    assert.equal(entry.interaction.local.background, 'rgb(41, 126, 255)');
    assert.equal(entry.interaction.local.color, 'rgb(255, 255, 255)');
    assert.equal(entry.interaction.official.fill, 'white');
    assert.deepEqual(entry.interaction.local.leaks, []);
  }
});
