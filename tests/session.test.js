'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {currentActivity,savedTabsToClose}=require('../src/session');

test('fresh session hides historical activity without mutating the journal snapshot',()=>{
  const old={invocationId:'old',startedAt:'2026-10-14T23:00:00Z',timestamp:'2026-10-15T02:00:00Z',status:'succeeded'};
  const recent={invocationId:'new',startedAt:'2026-10-15T02:00:00Z',timestamp:'2026-10-15T02:01:00Z',status:'running'};
  const snapshot={activities:[recent,old],events:[{invocationId:'old'},{invocationId:'new'}],summary:{running:1,succeeded:1,failed:0}};
  const result=currentActivity(snapshot,'2026-10-15T01:00:00Z');
  assert.deepEqual(result.activities,[recent]);assert.deepEqual(result.events,[{invocationId:'new'}]);
  assert.deepEqual(result.summary,{running:1,succeeded:0,failed:0});
  assert.equal(snapshot.activities.length,2);assert.equal(snapshot.events.length,2);
});

test('new work still appears, while a reset boundary empties the display',()=>{
  const snapshot={activities:[{timestamp:'2026-10-15T02:00:00Z',status:'failed'}],events:[]};
  assert.equal(currentActivity(snapshot,'2026-10-15T01:00:00Z').summary.failed,1);
  assert.equal(currentActivity(snapshot,'2026-10-15T03:00:00Z').activities.length,0);
  assert.equal(currentActivity(snapshot,'not-a-date').activities.length,0);
});

test('fresh home keeps dirty editors and the research dashboard; only clean tabs close',()=>{
  const clean={isDirty:false,input:{uri:'project.py'}},dirty={isDirty:true,input:{uri:'draft.py'}},home={isDirty:false,input:{viewType:'researchHub'}};
  const realHome={isDirty:false,input:{viewType:'mainThreadWebview-researchHub'}};
  const terminal={isDirty:false,input:{}},unknownView={isDirty:false,input:{viewType:'another-webview'}};
  const untitled={isDirty:false,input:{uri:{scheme:'untitled',path:'Untitled-1'}}};
  const diff={isDirty:false,input:{original:{scheme:'file'},modified:{scheme:'file'}}};
  assert.deepEqual(savedTabsToClose([{tabs:[dirty,clean,home,realHome,terminal,unknownView,untitled,diff]}]),[clean,diff]);
  assert.deepEqual(savedTabsToClose(undefined),[]);
});
