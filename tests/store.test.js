import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../app/store.js';

const a={site:'https://jira.example.test',project:'DEMO',user:'a'};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jira-store-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,store:new Store(root)};}
test('workspace data survives reopen and stays within the account/site partition',async t=>{
 const {root,store}=await fixture(t);
 assert.deepEqual((await store.load(a)).drafts,[]);
 await store.update(a,state=>{state.drafts.push({id:'one',hours:1});state.bindings['2024-02']={key:'DEMO-1'};});
 const reopened=await new Store(root).load(a);assert.equal(reopened.drafts[0].id,'one');assert.equal(reopened.bindings['2024-02'].key,'DEMO-1');
 assert.equal((await store.load({...a,user:'b'})).drafts.length,0);
 assert.equal((await store.load({...a,site:'https://another.example.test'})).drafts.length,0);
});
test('one writer retains updates issued together including across Store instances',async t=>{
 const {root,store}=await fixture(t);const other=new Store(root);
 await Promise.all(Array.from({length:12},(_,i)=>(i%2?store:other).update(a,state=>{state.history.push({id:String(i)});} )));
 const state=await store.load(a);assert.equal(state.history.length,12);assert.equal(new Set(state.history.map(r=>r.id)).size,12);
});
test('damaged data remains available while user can begin a fresh workspace',async t=>{
 const {root,store}=await fixture(t);await store.update(a,state=>{state.drafts.push({id:'one'});});
 const file=(await readdir(join(root,'workspaces'))).find(name=>name.endsWith('.json'));
 const path=join(root,'workspaces',file);await writeFile(path,'{broken');
 const loaded=await store.load(a);assert.equal(loaded.recovery.code,'DATA_DAMAGED');assert.deepEqual(loaded.drafts,[]);assert.equal(await readFile(path,'utf8'),'{broken');
 await store.update(a,state=>{state.drafts.push({id:'fresh'});});
 assert.equal((await store.load(a)).drafts[0].id,'fresh');assert.equal(await readFile(path.replace(/\.json$/,'.damaged.json'),'utf8'),'{broken');
});
test('global settings persist references separately from account work',async t=>{
 const {root,store}=await fixture(t);await store.saveConfig({jira:{url:a.site,user:'a',secretRef:'ref'},agent:null});
 const config=await new Store(root).loadConfig();assert.equal(config.jira.secretRef,'ref');assert.equal((await store.load(a)).history.length,0);
});
test('valid JSON with wrong workspace shape is reported as damaged instead of crashing',async t=>{
 const {root,store}=await fixture(t);await store.update(a,state=>{state.drafts.push({id:'old'});});
 const file=join(root,'workspaces',(await readdir(join(root,'workspaces')))[0]);
 await writeFile(file,'null');
 const state=await store.load(a);assert.deepEqual(state.drafts,[]);assert.equal(state.recovery.code,'DATA_DAMAGED');
 await store.update(a,next=>{next.drafts.push({id:'new'});});assert.equal((await store.load(a)).drafts[0].id,'new');
});
