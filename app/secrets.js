import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

function unavailable() {
  return Object.assign(new Error('系统安全存储不可用，凭据尚未保存'),{code:'SECURE_STORAGE_UNAVAILABLE'});
}

/** Credentials are protected by the signed-in OS user; ordinary settings only retain opaque references. */
export class Secrets {
  constructor(root,safeStorage) {
    this.root=resolve(root);
    this.safeStorage=safeStorage;
  }

  async requireProtection() {
    const safe=this.safeStorage;
    if (!safe || !await safe.isEncryptionAvailable() || safe.getSelectedStorageBackend?.() === 'basic_text') throw unavailable();
  }

  async put(value) {
    if (typeof value !== 'string' || !value) throw Object.assign(new Error('请填写凭据'),{code:'INVALID_CREDENTIAL'});
    await this.requireProtection();
    const safe=this.safeStorage;
    const encrypted = safe.encryptStringAsync ? await safe.encryptStringAsync(value) : safe.encryptString(value);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw unavailable();
    const reference=randomUUID();
    await mkdir(this.root,{recursive:true});
    await writeFile(join(this.root,reference+'.bin'),encrypted,{mode:0o600,flag:'wx'});
    return reference;
  }

  async get(reference) {
    if (typeof reference !== 'string' || !/^[0-9a-f-]{36}$/.test(reference)) {
      throw Object.assign(new Error('凭据引用无效'),{code:'INVALID_CREDENTIAL_REFERENCE'});
    }
    await this.requireProtection();
    const bytes=await readFile(join(this.root,reference+'.bin'));
    const safe=this.safeStorage;
    const decrypted = safe.decryptStringAsync ? (await safe.decryptStringAsync(bytes)).result : safe.decryptString(bytes);
    if (typeof decrypted !== 'string') throw unavailable();
    return decrypted;
  }
}
