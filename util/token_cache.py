"""Merge the encrypted web bootstrap with newer tokens refreshed by Actions."""
import base64
import json
from pathlib import Path

from util.aes_help import decrypt_data


def restore_tokens(key, bootstrap="", path="encrypted_tokens.data"):
    result = {}
    candidates = []
    cache = Path(path)
    if cache.is_file():
        candidates.append(cache.read_bytes())
    if bootstrap:
        try:
            candidates.append(base64.b64decode(bootstrap, validate=True))
        except (ValueError, TypeError):
            print("网页登录凭据格式无效，将尝试密码登录。")
    for encrypted in candidates:
        try:
            data = json.loads(decrypt_data(encrypted, key).decode("utf-8"))
            if not isinstance(data, dict):
                continue
            for account, info in data.items():
                if not isinstance(info, dict):
                    continue
                previous = result.get(account, {})
                if int(info.get("app_token_time", 0)) >= int(previous.get("app_token_time", 0)):
                    result[account] = info
        except (ValueError, TypeError, UnicodeError):
            print("一份加密登录缓存不可用，尝试其他缓存或密码登录。")
    return result
