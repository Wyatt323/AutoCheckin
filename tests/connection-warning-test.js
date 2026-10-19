const assert = require('node:assert/strict');
const {filterRunLogs} = require('../public/run-log');

const raw = 'Server closed the connection: 0 bytes read on a total of 8 expected bytes';
const record = {id:'packet-warning',account:'alpha',category:'red_packet',ruleId:'packet-one',trigger:'automatic',state:'failed',
  lines:[{id:1,time:'2026-10-19T15:01:20Z',stream:'stderr',text:`[牛逼] 自动化进程错误：${raw}`}]};
const original = structuredClone(record);
const [row] = filterRunLogs([record],{});
assert.equal(row.state,'warning');
assert.equal(row.summary.state,'warning');
assert.equal(row.stream,'warning');
assert.equal(row.text,`[牛逼] ⚠️ Telegram 连接中断，等待恢复\n原始提示：${raw}`);
assert.equal(row.time,record.lines[0].time);
assert.equal(row.runId,record.id);
assert.equal(row.account,'alpha');
assert.equal(row.category,'red_packet');
assert.deepEqual(record,original,'display classification never mutates stored history or runtime events');
assert.equal(filterRunLogs([record],{account:'alpha',category:'red_packet',ruleId:'packet-one',status:'warning'}).length,1);
assert.equal(filterRunLogs([record],{status:'failed'}).length,0);
assert.equal(filterRunLogs([record],{account:'beta'}).length,0);
assert.equal(filterRunLogs([record],{ruleId:'packet-two'}).length,0);
assert.equal(filterRunLogs([record],{date:'2026-10-19',start:'23:01:20',end:'23:01:20'}).length,1);
for (const changed of [
  {...record,category:'checkin'},
  {...record,category:'message'},
  {...record,category:'forward'},
  {...record,lines:[{...record.lines[0],text:'[牛逼] 自动化进程错误：ConnectionError: Cannot send requests while disconnected'}]},
  {...record,lines:[{...record.lines[0],text:'[牛逼] 自动化进程退出（代码 1），15 秒后重试'}]},
  {...record,lines:[{...record.lines[0],text:`[牛逼] 自动化进程错误：Traceback\n${raw}`}]},
  {...record,lines:[record.lines[0],{...record.lines[0],id:2,text:'fatal error'}]},
]) {
  const rows = filterRunLogs([changed],{status:'failed'});
  assert.equal(rows.length,changed.lines.length,'actual failures and unrelated categories keep their classification');
  assert.equal(rows[0].text,changed.lines[0].text);
  assert.equal(rows[0].stream,'stderr');
}
assert.equal(filterRunLogs([{...record,state:'stopped'}],{})[0].state,'stopped','do not relabel other states');
console.log('Connection warning PASS: precise display classification, original details, historical records, filters, isolation and unchanged failures/data');
