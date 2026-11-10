import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Secrets} from '../app/secrets.js';

async function fixture(t,safe){const root=await mkdtemp(join(tmpdir(),'jira-secrets-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,secrets:new Secrets(root,safe)};}
test('credential bytes are protected through OS adapter and retrieved only by opaque reference',async t=>{
 const calls=[];
 const safe={isEncryptionAvailable:()=>true,encryptString:s=>{calls.push(s);return Buffer.from('encrypted:'+Buffer.from(s).toString('base64'));},decryptString:b=>Buffer.from(b.toString().slice(10),'base64').toString()};
 const {root,secrets}=await fixture(t,safe);const ref=await secrets.put('synthetic-secret');
 assert.ok(ref);assert.equal(await secrets.get(ref),'synthetic-secret');assert.deepEqual(calls,['synthetic-secret']);
 const bytes=await readFile(join(root,ref+'.bin'));assert.equal(bytes.includes(Buffer.from('synthetic-secret')),false);
 await assert.rejects(secrets.get('../outside'),error=>error.code==='INVALID_CREDENTIAL_REFERENCE');
});
test('no credential is saved when system protection is unavailable',async t=>{
 const {root,secrets}=await fixture(t,{isEncryptionAvailable:()=>false});
 await assert.rejects(secrets.put('synthetic-secret'),error=>error.code==='SECURE_STORAGE_UNAVAILABLE');
 assert.deepEqual(await readdir(root),[]);
});
test('async safeStorage result can be decrypted without exposing a result object',async t=>{
 const safe={isEncryptionAvailable:()=>true,encryptStringAsync:async s=>Buffer.from('protected-'+s),decryptStringAsync:async b=>({result:b.toString().slice(10)})};
 const {secrets}=await fixture(t,safe);const ref=await secrets.put('only-test-value');assert.equal(await secrets.get(ref),'only-test-value');
});
