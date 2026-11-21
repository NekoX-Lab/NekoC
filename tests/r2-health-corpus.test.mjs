import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Third-party works remain outside the repository. Enable only with a read-only
// corpus directory, after building the local CLI through the cargo semaphore.
const corpus=process.env.NEKOC_HEALTH_CORPUS;
const bin=path.resolve('target/debug',process.platform==='win32'?'nekoc.exe':'nekoc');
for(const [id,type,category] of [
  [297168191,'open_hide_camera','unsupported'],
  [303456318,'bcm_translator_text_execution_block','approximate'],
])test(`r2-health: read-only corpus ${id} retains located ${type} diagnostics`,{skip:!corpus,timeout:180000},()=>{
  const input=path.join(corpus,`${id}.json`),before=fs.readFileSync(input);
  const result=spawnSync(bin,['check',input,'--report','--json'],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:150000});
  assert.ifError(result.error);
  assert.equal(result.status,1,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.schema_version,1);
  assert.equal(report.format,'kitten-n');
  assert.equal(report.summary.preserve,1);
  const issues=report.items.filter(item=>item.block_type===type&&item.category===category);
  assert.ok(issues.length>0,'expected concrete risk, not only a project-level error');
  for(const issue of issues){
    assert.ok(issue.scene,'scene location');
    assert.ok(issue.owner,'owner location');
    assert.ok(issue.block,'block ID');
    assert.ok(issue.impact);
    assert.ok(report.text.includes(issue.block));
  }
  assert.ok(report.summary.unverified>0,'unknown semantics must remain explicit');
  assert.deepEqual(fs.readFileSync(input),before,'read-only corpus must be unchanged');
  console.log(JSON.stringify({work:id,summary:report.summary,located:issues.length,first:issues[0]}));
});
