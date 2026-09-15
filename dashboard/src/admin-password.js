import {utf8,b64,unb64,equal} from './security.js';
import {hash} from './licensing.js';

// Passwords use a salted slow hash. Existing randomly generated keys remain compatible.
export async function hashAdminPassword(password) {
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey('raw',utf8(password),'PBKDF2',false,['deriveBits']);
  const derived=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},key,256);
  return ['pbkdf2-sha256','100000',b64(salt),b64(derived)].join('$');
}

export async function verifyAdminPassword(password,stored) {
  if(typeof stored!=='string')return false;
  if(/^[a-f0-9]{64}$/.test(stored))return equal(await hash('admin-key:'+password),stored);
  const parts=stored.split('$');
  if(parts.length!==4||parts[0]!=='pbkdf2-sha256'||parts[1]!=='100000')return false;
  try {
    const salt=unb64(parts[2]),expected=unb64(parts[3]);
    if(salt.length!==16||expected.length!==32)return false;
    const key=await crypto.subtle.importKey('raw',utf8(password),'PBKDF2',false,['deriveBits']);
    const derived=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},key,256);
    return equal(b64(derived),parts[3]);
  }catch{return false;}
}
