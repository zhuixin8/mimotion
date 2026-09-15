// Local operator utility; never included in the Worker bundle.
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const args=process.argv.slice(2);
const option=name=>args[args.indexOf(name)+1];
if(!args.includes('--credential-file')||!args.includes('--sql-file'))throw new Error('Use --credential-file PRIVATE_PATH --sql-file PRIVATE_SQL_PATH');
const credentialPath=resolve(option('--credential-file')),sqlPath=resolve(option('--sql-file'));
if(credentialPath===sqlPath||existsSync(credentialPath)||existsSync(sqlPath))throw new Error('Refusing to overwrite existing administrator files.');
const key=randomBytes(32).toString('base64url'),digest=createHash('sha256').update('admin-key:'+key).digest('hex');
const version=randomUUID(),t=Math.floor(Date.now()/1000);
const url=option('--origin')||'https://s.dqai.cc';
const origin=args.includes('--origin')?url:'https://s.dqai.cc';
mkdirSync(dirname(credentialPath),{recursive:true});mkdirSync(dirname(sqlPath),{recursive:true});
writeFileSync(credentialPath,`MiMotion 管理后台（请私密保存）\n\n后台地址：${origin}/admin\n管理密钥：${key}\n\n登录方式：在后台输入此管理密钥，无需 GitHub 或 Zepp 密码。\n\n使用：\n1. 生成激活码：选择天数、数量，可设置最晚兑换时间。\n2. 将激活码发给用户；用户登录 Zepp 后兑换开通或续期。\n3. 用户管理：按用户编号查找，追加时长、设置到期时间或停用/恢复。\n4. 管理安全：可生成新管理密钥；旧密钥和后台会话会立即失效。\n\n本文件中的密钥未提交到 GitHub。不要把管理密钥发给普通用户。\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
writeFileSync(sqlPath,`INSERT INTO admin_auth(id,key_hash,version,updated_at) VALUES(1,'${digest}','${version}',${t});\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
console.log('Administrator credential file and initialization SQL created. Secret values are not printed.');
