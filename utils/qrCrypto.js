/**
 * 二维码产物加密/解密工具
 *
 * 目的：扫码登录的二维码本质上是"登录凭证"，有效期内在公开仓库的
 * Release / 明文 artifact / Step Summary 中暴露即等于把账号控制权外泄。
 * 因此这里把二维码 PNG/HTML 产物整体打包后用 AES-256-GCM 加密，
 * 密钥由用户预先设置在 Secret `QR_PASS` 的口令派生（scrypt）。
 * 只有持有 `QR_PASS` 的人才能解密查看二维码。
 *
 * 加密格式（单文件，二进制）：
 *   salt(16B) | iv(12B) | authTag(16B) | ciphertext(...)
 * ciphertext 解密后为 JSON 文本：{ "files": { "<文件名>": "<base64内容>", ... } }
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SALT_LEN = 16
const IV_LEN = 12
const KEY_LEN = 32
const AUTH_TAG_LEN = 16
// scrypt 参数：N=16384, r=8, p=1（约 16MB 内存，Node 默认限制内可用的强参数）
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }

function deriveKey(pass, salt) {
  if (!pass) throw new Error('缺少解密口令 QR_PASS')
  return crypto.scryptSync(String(pass), salt, KEY_LEN, SCRYPT_OPTS)
}

/**
 * 把目录下所有文件打包并加密为单个 .enc 文件
 * @param {string} dir    待打包目录（如 ./qr）
 * @param {string} outFile 输出加密文件路径（如 ./qr_bundle.enc）
 * @param {string} pass   口令（QR_PASS）
 * @returns {number} 打包的文件数
 */
function encryptDirToBundle(dir, outFile, pass) {
  const files = {}
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isFile()) {
      files[name] = fs.readFileSync(full).toString('base64')
    }
  }
  const names = Object.keys(files)
  if (names.length === 0) throw new Error(`目录 ${dir} 中没有可打包的文件`)

  const salt = crypto.randomBytes(SALT_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const key = deriveKey(pass, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify({ files }), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  fs.writeFileSync(outFile, Buffer.concat([salt, iv, tag, ciphertext]))
  return names.length
}

/**
 * 解密 .enc 文件并还原到指定目录
 * @param {string} encFile 加密文件路径
 * @param {string} pass    口令（QR_PASS）
 * @param {string} outDir  还原输出目录
 * @returns {string[]} 还原出的文件名列表
 */
function decryptBundleToDir(encFile, pass, outDir) {
  const buf = fs.readFileSync(encFile)
  if (buf.length < SALT_LEN + IV_LEN + AUTH_TAG_LEN) {
    throw new Error('加密文件损坏或格式不正确')
  }
  const salt = buf.subarray(0, SALT_LEN)
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN)
  const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + AUTH_TAG_LEN)
  const ciphertext = buf.subarray(SALT_LEN + IV_LEN + AUTH_TAG_LEN)

  const key = deriveKey(pass, salt)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let plaintext
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('解密失败：口令错误或文件已被篡改')
  }

  const { files } = JSON.parse(plaintext.toString('utf8'))
  fs.mkdirSync(outDir, { recursive: true })
  const written = []
  for (const [name, base64] of Object.entries(files)) {
    // 防止路径穿越：仅取纯文件名
    const safeName = path.basename(name)
    fs.writeFileSync(path.join(outDir, safeName), Buffer.from(base64, 'base64'))
    written.push(safeName)
  }
  return written
}

export { encryptDirToBundle, decryptBundleToDir }
