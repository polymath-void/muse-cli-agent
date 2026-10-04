import os
import json
import time
import requests
import base64
import hashlib
import urllib.parse
from pathlib import Path

DEFAULT_AUTH_BASE_URL = os.environ.get('MUSE_AUTH_BASE_URL', 'https://auth.meta.com')
DEFAULT_API_BASE_URL = os.environ.get('MUSE_API_BASE_URL', 'https://api.meta.ai/v1')

def resolve_auth_path() -> str:
    xdg = os.environ.get('XDG_CONFIG_HOME')
    if not xdg:
        xdg = str(Path.home() / '.config')
    return str(Path(xdg) / 'muse' / 'auth.json')

def load_auth_file(auth_path: str = None) -> dict:
    p = auth_path or resolve_auth_path()
    try:
        with open(p, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if not isinstance(data, dict) or 'providers' not in data:
                return {'schema_version': 1, 'providers': {}}
            return data
    except Exception:
        return {'schema_version': 1, 'providers': {}}

def save_auth_file(auth: dict, auth_path: str = None) -> str:
    p = auth_path or resolve_auth_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    auth['schema_version'] = 1
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(auth, f, indent=2)
    return p

def poll_device_token(token_endpoint, client_id, device_code, interval_sec=5, expires_in_sec=600):
    deadline = time.time() + expires_in_sec
    while time.time() < deadline:
        time.sleep(interval_sec)
        res = requests.post(token_endpoint, data={
            'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
            'device_code': device_code,
            'client_id': client_id
        })
        if res.status_code == 200:
            return res.json()
        try:
            data = res.json()
        except:
            raise Exception(f'Login failed: {res.status_code}')
        if data.get('error') == 'authorization_pending':
            continue
        if data.get('error') == 'slow_down':
            interval_sec += 5
            continue
        raise Exception(f'Login failed: {data.get("error")}')
    raise Exception('Login expired')
