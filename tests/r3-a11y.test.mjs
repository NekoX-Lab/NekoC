import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {messages,normalizeLanguage,translate} from '../web/i18n.js';
import {PlayerFeedback} from '../web/player-feedback.js';

test('r3-a11y: UI messages have both locales and matching interpolation fields',()=>{
  const fields=text=>[...text.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
  for(const [key,pair]of Object.entries(messages)){
    assert.equal(pair.length,2,key);
    for(const text of pair)assert.ok(typeof text==='string'&&text.length,key);
    assert.deepEqual(fields(pair[0]),fields(pair[1]),key);
  }
  assert.equal(normalizeLanguage('en-US'),'en');assert.equal(normalizeLanguage('zh'),'zh-CN');assert.equal(normalizeLanguage('invalid'),null);
  assert.equal(translate('fileFailed','en',{name:'<b>.bcm',error:'bad'}),'Cannot read project “<b>.bcm”: bad');
  assert.equal(translate('ready','unknown'),'就绪');
});

test('r3-a11y: declared HTML translations exist and deployment includes the catalog',async()=>{
  for(const file of ['index.html','play.html']){
    const html=await readFile(new URL(`../web/${file}`,import.meta.url),'utf8');
    for(const [,key]of html.matchAll(/data-i18n(?:-aria-label|-title|-placeholder)?="([^"]+)"/g))assert.ok(messages[key],`${file}: ${key}`);
  }
  for(const file of ['app.js','play.js','player-feedback.js']){
    const source=await readFile(new URL(`../web/${file}`,import.meta.url),'utf8');
    for(const [,key]of source.matchAll(/\bt\('([^']+)'/g))assert.ok(messages[key],`${file}: ${key}`);
  }
  for(const file of ['tools/build-pages.mjs','tools/build-extension.mjs']){
    const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
    for(const module of ['i18n.js','repro.js','input.js','player-feedback.js'])assert.ok(source.includes(`'${module}'`),`${file}: ${module}`);
  }
});

test('r3-a11y: merged mobile player keeps unique IDs and off-stage accessible errors',async()=>{
  const html=await readFile(new URL('../web/play.html',import.meta.url),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,'conflict resolution must not duplicate IDs');
  for(const id of ['stop','runtime-mode','record','virtual-toggle','virtual-controls','language','coverage-dialog'])assert.ok(ids.includes(id),id);
  const viewport=html.slice(html.indexOf('<section id="viewport"'),html.indexOf('</section>'));
  assert.ok(!viewport.includes('id="notice"'),'runtime errors must remain outside the stage');
  assert.match(html,/<span id="notice-text" tabindex="0"[^>]*data-i18n-aria-label="noticeDetails"/);
  assert.match(html,/id="coverage"[^>]*aria-controls="coverage-dialog"/);
  for(const code of [38,37,40,39,32,13,90,88])assert.match(html,new RegExp(`data-key="${code}"[^>]*data-i18n-aria-label="[^"]+"[^>]*aria-pressed="false"`));
});

test('r3-a11y: report Tab wraps both ways, but other keys keep native behavior',()=>{
  const elements=new Map(),root={activeElement:null,querySelector(selector){
    if(!elements.has(selector))elements.set(selector,{focus(){root.activeElement=this;}});
    return elements.get(selector);
  }};
  new PlayerFeedback(root);
  const keydown=root.querySelector('#coverage-dialog').onkeydown;
  let prevented=0;
  const event={key:'Tab',shiftKey:false,preventDefault(){prevented++;}};
  root.activeElement=root.querySelector('#report-close');keydown(event);
  assert.equal(root.activeElement,root.querySelector('#report-content'));assert.equal(prevented,1);
  keydown({...event,shiftKey:true});
  assert.equal(root.activeElement,root.querySelector('#report-close'));assert.equal(prevented,2);
  keydown({...event,key:'Escape'});assert.equal(prevented,2);
  root.activeElement=root.querySelector('#report-download');keydown(event);assert.equal(prevented,2);
});
