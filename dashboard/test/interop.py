"""Check JS encryption against independent Python libraries (test data only)."""
import base64
import json
import subprocess
import sys
from pathlib import Path

from nacl.public import PrivateKey, SealedBox

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
from util.aes_help import decrypt_data

key = PrivateKey.generate()
public = base64.b64encode(bytes(key.public_key)).decode()
source = """
import {encryptSecret} from './src/github.js';
import {aesCBC,b64} from './src/security.js';
const value = JSON.stringify({user: {app_token: 'test-token', app_token_time: '123'}});
console.log(JSON.stringify({github:encryptSecret(value, process.argv[1]), zepp:b64(await aesCBC(value, 'abcdefghijklmnop'))}));
"""
result = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", source, public], cwd=root / "dashboard", text=True))
github_plain = SealedBox(key).decrypt(base64.b64decode(result["github"]))
python_plain = decrypt_data(base64.b64decode(result["zepp"]), b"abcdefghijklmnop")
assert github_plain == python_plain
assert json.loads(python_plain)["user"]["app_token"] == "test-token"
print("PASS: JS sealed-box ciphertext decrypts with PyNaCl; JS token cache decrypts with existing Python AES helper.")
