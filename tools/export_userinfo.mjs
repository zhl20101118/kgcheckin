/**
 * 账号导出工具（Actions 内运行）
 * 读取 Secret USERINFO，用 Secret KG_PASS 派生密钥 AES-GCM 加密，
 * 写出 data/userinfo.enc 供 kgcheckin-console 控制台导入。
 * 日志绝不输出 USERINFO / token 原文。
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

const b64 = (u8) => Buffer.from(u8).toString('base64')

async function main() {
  const raw = process.env.USERINFO || ''
  const pass = process.env.KG_PASS || ''
  if (!pass) {
    console.error('::error::缺少 Secret KG_PASS（由控制台自动写入）')
    process.exit(1)
  }
  let list = []
  try {
    list = raw ? JSON.parse(raw) : []
  } catch {
    console.error('::error::USERINFO 不是合法 JSON')
    process.exit(1)
  }
  if (!Array.isArray(list) || !list.length) {
    console.log('USERINFO 为空，跳过导出（不生成文件）')
    process.exit(0)
  }
  // 仅保留必要字段，绝不写入日志
  const clean = list.map((u) => {
    const o = { userid: u.userid, token: u.token }
    if (u.dfid) o.dfid = u.dfid
    return o
  })
  const keyBytes = crypto.createHash('sha256').update(pass, 'utf8').digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(clean), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // 密文 = ct || tag（Worker 端 AES-GCM 输出同样为 ct||tag）
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync('data/userinfo.enc', JSON.stringify({
    v: 1,
    iv: b64(iv),
    ct: b64(Buffer.concat([ct, tag])),
  }))
  console.log(`✅ 已加密导出 ${clean.length} 个账号 → data/userinfo.enc`)
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('::error::导出失败：' + e.message)
  process.exit(1)
})
