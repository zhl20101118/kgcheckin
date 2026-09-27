#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
酷狗签到增强版 · 扫码登录二维码一键解密工具（Python 版）

用法：
  1. 双击运行，按提示粘贴/拖入文件路径（artifact .zip 或 qr_bundle.enc）
  2. 或命令行：python decrypt_qr.py <文件路径>
  3. 输入 QR_PASS 口令（不回显；也可用环境变量 QR_PASS 传入）
  4. 自动解密到同目录 qr_decrypted\，并用系统默认查看器打开二维码

依赖（仅占一个第三方包，可用 PyInstaller 打包为单文件 exe）：
  pip install pycryptodome

PyInstaller 打包示例：
  pyinstaller -F -n 酷狗二维码解密 decrypt_qr.py

加密格式（与 Node 端 utils/qrCrypto.js 一致）：
  salt(16) | iv(12) | authTag(16) | ciphertext
  key = scrypt(UTF8(password), salt, N=16384, r=8, p=1, dklen=32)
  AES-256-GCM，明文为 {"files": {name: base64, ...}}
"""
import base64
import getpass
import hashlib
import json
import os
import sys
import tempfile
import zipfile

from Crypto.Cipher import AES  # pycryptodome

# Windows 控制台默认 GBK，切换到 UTF-8 以免中文提示乱码
if sys.platform == 'win32':
    try:
        os.system('chcp 65001 >nul 2>&1')
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

SALT_LEN, IV_LEN, TAG_LEN = 16, 12, 16
SCRYPT_N, SCRYPT_R, SCRYPT_P = 16384, 8, 1


def pick_input_path() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    raw = input('请把 artifact 压缩包或 qr_bundle.enc 拖进来 / 粘贴路径后回车:\n> ')
    return raw.strip().strip('"')


def unzip_get_enc(zip_path: str, workdir: str) -> str:
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(workdir)
    enc = os.path.join(workdir, 'qr_bundle.enc')
    if not os.path.isfile(enc):
        raise FileNotFoundError('压缩包中未找到 qr_bundle.enc')
    return enc


def decrypt(enc_path: str, password: str) -> dict:
    blob = open(enc_path, 'rb').read()
    if len(blob) < SALT_LEN + IV_LEN + TAG_LEN + 1:
        raise ValueError('加密文件损坏或过短')
    salt = blob[:SALT_LEN]
    iv = blob[SALT_LEN:SALT_LEN + IV_LEN]
    tag = blob[SALT_LEN + IV_LEN:SALT_LEN + IV_LEN + TAG_LEN]
    ct = blob[SALT_LEN + IV_LEN + TAG_LEN:]

    key = hashlib.scrypt(
        password.encode('utf-8'), salt=salt,
        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
        dklen=32, maxmem=64 * 1024 * 1024,
    )
    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    plain = cipher.decrypt_and_verify(ct, tag)  # 口令错误将抛出 ValueError
    return json.loads(plain.decode('utf-8'))


def save_files(bundle: dict, outdir: str) -> list:
    os.makedirs(outdir, exist_ok=True)
    written = []
    for name, b64 in bundle.get('files', {}).items():
        safe = os.path.basename(name)  # 防路径穿越
        data = base64.b64decode(b64)
        with open(os.path.join(outdir, safe), 'wb') as f:
            f.write(data)
        print(f'  [+] {safe} ({len(data)} 字节)')
        written.append(safe)
    return written


def open_results(outdir: str, files: list):
    def reveal(path):
        if sys.platform == 'win32':
            os.startfile(path)  # 系统默认查看器/浏览器
        elif sys.platform == 'darwin':
            os.system(f'open "{path}"')
        else:
            os.system(f'xdg-open "{path}"')

    for f in files:
        if f.lower().endswith('.png'):
            reveal(os.path.join(outdir, f))
    html = os.path.join(outdir, 'login.html')
    if os.path.isfile(html):
        reveal(html)


def main() -> int:
    print('=' * 53)
    print('  酷狗签到增强版 - 扫码登录二维码一键解密工具')
    print('  支持把 Actions 下载的 .zip 或 qr_bundle.enc 拖入')
    print('=' * 53 + '\n')

    path = pick_input_path()
    if not os.path.isfile(path):
        print(f'[x] 文件不存在: {path}')
        return 1

    workdir = tempfile.mkdtemp(prefix='kgqr_')
    try:
        enc = unzip_get_enc(path, workdir) if path.lower().endswith('.zip') else path

        password = os.environ.get('QR_PASS')
        if password:
            print('[i] 使用环境变量 QR_PASS 中的口令')
        bundle = None
        for attempt in range(3):
            if password is None:
                password = getpass.getpass('请输入 QR_PASS 口令: ')
            try:
                bundle = decrypt(enc, password)
                break
            except (ValueError, KeyError):
                print('[x] 解密失败：口令错误或文件被篡改' + ('，请重试' if attempt < 2 else ''))
                password = None if not os.environ.get('QR_PASS') else password
                if os.environ.get('QR_PASS'):
                    break
        if bundle is None:
            return 1

        outdir = os.path.join(os.path.dirname(os.path.abspath(path)), 'qr_decrypted')
        print(f'[√] 解密成功，正在还原文件到: {outdir}')
        files = save_files(bundle, outdir)
        if not files:
            print('[x] 未解出任何文件')
            return 1

        print('\n[√] 完成！二维码即将用系统查看器打开，请尽快扫码（约 2 分钟内有效）。\n')
        open_results(outdir, files)
        return 0
    finally:
        try:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)
        except Exception:
            pass


if __name__ == '__main__':
    # 使用环境变量口令时视为自动模式，结束直接退出；否则窗口停留，便于双击使用的用户查看结果
    keep_open = not os.environ.get('QR_PASS')
    try:
        rc = main()
    except KeyboardInterrupt:
        rc = 130
    if keep_open:
        try:
            input('\n按回车键退出...')
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(rc)
