#!/usr/bin/env node
/**
 * 本地解密查看扫码登录二维码
 *
 * 用法：
 *   node decryptQr.js [qr_bundle.enc] [输出目录]
 *
 * 口令来源（二选一）：
 *   1) 环境变量 QR_PASS：  QR_PASS=你的口令 node decryptQr.js
 *   2) 交互输入（不回显）：直接运行后按提示输入
 *
 * 解密后打开输出目录里的 login.html 即可看到二维码，用酷狗音乐 APP 扫码登录。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { decryptBundleToDir } from './utils/qrCrypto.js'

const encFile = process.argv[2] || 'qr_bundle.enc'
const outDir = process.argv[3] || './qr_decrypted'

// 隐藏输入的口令提示
function promptPass() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const orig = rl._writeToOutput
    rl._writeToOutput = function (s) {
      if (s.includes('\n') || s.includes('\r')) rl.output.write(s)
      else rl.output.write('*')
    }
    rl.question('请输入 QR_PASS: ', (ans) => {
      rl._writeToOutput = orig
      rl.close()
      process.stdout.write('\n')
      resolve(ans)
    })
  })
}

async function main() {
  if (!fs.existsSync(encFile)) {
    console.error(`未找到加密文件：${encFile}`)
    console.error(`用法：node decryptQr.js [qr_bundle.enc] [输出目录]`)
    process.exit(1)
  }
  const pass = process.env.QR_PASS || (await promptPass())
  try {
    const files = decryptBundleToDir(encFile, pass, outDir)
    console.log(`✅ 解密成功，已还原 ${files.length} 个文件到 ${path.resolve(outDir)}`)
    if (files.includes('login.html')) {
      console.log(`\n请用浏览器打开以下文件并扫码登录（二维码约 2 分钟内有效）：`)
      console.log(`  ${path.resolve(path.join(outDir, 'login.html'))}`)
    } else {
      console.log('包含文件：' + files.join(', '))
    }
  } catch (e) {
    console.error(`❌ ${e.message}`)
    process.exit(1)
  }
}

main()
