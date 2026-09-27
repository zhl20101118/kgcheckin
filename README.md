# 酷狗签到增强版

GitHub Actions 实现 `酷狗概念VIP` 自动签到，每天领取总计 `两天酷狗概念VIP`

> 在原 [develop202/kgcheckin](https://github.com/develop202/kgcheckin) 基础上做防盗号安全加固，并增强领取流程（dfid 自动获取、单日VIP领取+升级超级VIP、账号管理等）。

登录后即可使用，目前提供二维码登录(推荐)和手机号登录(一个手机号绑定多个账号无法登录，见 [多账号登录问题](https://github.com/MakcRe/KuGouMusicApi/issues/51))

> [!warning]
> **本项目已做防盗号安全加固**。登录二维码、登录态 token 均不再出现在任何公开可见的 Release / 明文 artifact / Actions 日志中。详见下方「安全说明」。**建议将 fork 后的仓库设为 Private（私有）**，可从根本上避免日志/artifact 被他人查看。

## 免责声明

> [!important]
>
> 1. 本项目仅供学习使用，请尊重版权，请勿利用此项目从事商业行为及非法用途!
> 2. 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 24小时内清除使用本项目的过程中所产生的版权数据。
> 3. 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。
> 4. **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。
> 5. 音乐平台不易，请尊重版权，支持正版。
> 6. 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。
> 7. 如果官方音乐平台觉得本项目不妥，可联系本项目更改或移除。

## 安全说明

“被盗号”通常不是代码主动外发，而是**凭证被放在了公开可见的地方**。本版针对性做了如下加固：

1. **二维码登录产物加密**（最大风险点）
   - 旧版本把扫码登录二维码以“公开 Release 直链”展示，而 fork 仓库通常是公开的 → 任何人在二维码有效期内扫一下即可登录你的账号。
   - 现在二维码 PNG/HTML 会用你设置的 Secret `QR_PASS` 派生密钥做 **AES-256-GCM 加密**，打成 `qr_bundle.enc` 后才以 artifact 上传。没有口令，即使下载了 artifact 也看不到二维码。
   - 明文二维码产物在加密后立即从 runner 删除，不落任何公开产物。

2. **彻底移除“在日志输出 USERINFO(token)”的功能**
   - 旧版本 `print_userinfo` 会把含全部 token 的 `USERINFO` 明文打到 Actions 日志；公开仓库的日志任何人可看，等于直接送号。**已移除**，任何情况下都不会回显 token。
   - 日志中的手机号、token、二维码 key、昵称、userid 等均做脱敏/打码。

3. **PAT 改为可选 + 最小权限指引**
   - PAT 仅用于把登录态写回 Secret `USERINFO`、以及刷新 token 后回写，**不配置也能用**（登录成功后跳过时会有提示）。
   - 如需配置，请务必使用 **Fine-grained token**，仅授权当前 fork 仓库，仅给 `Secrets` 读写权限，并设置较短有效期（见下文步骤 2）。

4. **Workflow 权限收紧**
   - 各 workflow 仅保留最小权限（登录/签到/账号管理为 `contents: read`；仅“仓库保活”需要 `contents: write`）。
   - 签到增加随机错峰延迟，避免大量 fork 在同一时刻集中请求接口。

> [!tip]
> **强烈建议**：进入 fork 仓库 `Settings → General → Danger Zone → Change repository visibility`，改为 **Private**。私有仓库的 Actions 日志 / artifact / Release 均不对外公开，是从根本上最省心的防护。

## 使用说明

> [!warning]
> 注意事项
>
> 若登录后听歌领取失败，请到APP 活动中心->天天签到领VIP(这个活动新用户好像没有) 查看当日是否已经领取VIP。

1. Fork 本仓库（**建议随后设为 Private**）

1. （可选，但推荐）创建最小权限令牌 PAT —— 用于自动把登录信息写回 Secret `USERINFO` / 刷新 token
   - **创建令牌**：复制下方官网链接，在浏览器中打开

     ```shell
     https://github.com/settings/personal-access-tokens/new
     ```

   - **登录 GitHub 官网**：若登陆后未跳转至 token 生成页，请再次粘贴链接进行访问
   - **在设置页面配置权限**
      **Token name 备注**：随意填写
      **Expiration (有效期)**：建议自定义较短有效期，勿长期不维护
      **Repository access (仓库范围)**：只选择当前 fork 的仓库
      **Repository permissions (仓库权限)**：`Metadata` 保持只读，`Secrets` 设置为读写
      ![精细化个人访问令牌权限](imgs/精细化个人访问令牌权限.png)
   - 滑动到底部，点击绿色的 Generate token 保存按钮
   - 复制生成的字符串，回到本仓库添加到 `Secret`，变量名 `PAT`，value 为复制的令牌

   > 不配置 `PAT` 也可以正常使用：登录成功/刷新 token 后无法自动回写 `USERINFO`，届时按提示改为设私有仓库或手动维护即可。

1. 设置二维码加密口令
   - 在仓库 Secret 添加 `QR_PASS`，值为一段你自己记得住的口令（用于加密/解密扫码登录二维码）。**务必设置**，否则二维码登录会被中止以保护账号。

1. 登录（两种独立的登录方式，任选其一）

   **3.1 二维码登录（推荐）**

   运行 Actions `二维码登录`，点击 Run。运行结束后：
   - 到该次运行的 **Artifacts** 下载 `qr-bundle`（zip 压缩包，内含加密的 `qr_bundle.enc`）；
   - 使用一键解密工具打开（**无需安装任何环境**）：
     - **Windows（推荐）**：直接使用仓库里编译好的 `tools/decrypt_qr.exe`。把下载的 **zip 压缩包**（或解压出的 `qr_bundle.enc`）**拖到 exe 上**，输入 `QR_PASS` 口令（不回显），解密后自动用系统照片查看器/浏览器打开二维码扫码。
     - 如需自行编译：安装 MinGW-w64 后运行 `tools/build.bat`。
     - **macOS/Linux 或其他平台**：`pip install pycryptodome` 后运行 `python tools/decrypt_qr.py <文件路径>`，或用 PyInstaller 打包为单文件：`pyinstaller -F tools/decrypt_qr.py`。
   - 解密产物在输入文件同目录的 `qr_decrypted\`，扫码并确认登录即可（二维码约 2 分钟有效，请尽快操作）。

   > 提示：也可用环境变量传口令（适合脚本/自动化）：`QR_PASS=你的口令 工具路径 文件路径`

   **3.2 手机号登录**

   添加手机号到 Secret `PHONE`，运行 Actions `手机号登录`，操作步骤选择「发送验证码」获取验证码，把验证码添加到 Secret `CODE`；再次运行 Actions `手机号登录`，操作步骤选择「登录」即可。

1. 启用 Actions `签到`，每天凌晨北京时间 01:10 自动签到（可在 `签到.yml` 中设置 cron），签到前会随机延迟数分钟以错峰。启用 Actions `仓库保活` 以保证签到可以长期执行。

   每次签到依次完成：听歌领取 → 8 次广告领取 → **领取一天畅听 VIP（tvip）**（`/youth/day/vip`，`receive_day` 取当天）→ **升级超级 VIP（svip）**（`/youth/day/vip/upgrade`，升级后约 24 小时有效）。决策以 `/user/vip/detail` 的 `busi_vip` 为准：svip 仍在有效期内则跳过领取与升级，tvip 有效但 svip 未激活则直接升级，均已过期才执行领取+升级。单日 VIP 与升级接口均为概念版测试接口，请遵循"勿频繁调用、勿领多日"的原则。

1. 账号管理（新增）

   运行 Actions `账号管理`，选择操作类型：
   - `vip`：查询每个账号的 VIP 到期时间、剩余天数（临期自动提醒）并推送通知；
   - `refresh`：刷新所有账号的登录 token，配置 `PAT` 后自动回写到 Secret `USERINFO`。

1. （可选）配置运行结果通知

   在仓库 Settings → Secrets and variables → Actions 中添加对应渠道的 Secret，签到完成后将自动推送结果通知。支持以下渠道（全部可选，配置多个将同时发送）：

   | 通知渠道 | Secret 变量名 | 说明 |
   |---------|-------------|------|
   | 企业微信机器人 | `WECOM_BOT_KEY` | 企业微信群机器人 webhook 完整地址或 key |
   | 钉钉机器人 | `DINGTALK_BOT_KEY` | 钉钉机器人 access_token |
   | 钉钉加签 | `DINGTALK_SECRET` | 钉钉机器人加签密钥（可选） |
   | 飞书机器人 | `FEISHU_BOT_KEY` | 飞书自定义机器人 webhook 完整地址或 key |
   | 飞书加签 | `FEISHU_SECRET` | 飞书机器人加签密钥（机器人开启"签名校验"时必填，否则消息会被静默拒绝） |
   | 云湖机器人 | `YUNHU_BOT_KEY` | 云湖机器人 webhook 的 key |
   | Server酱 | `SERVERCHAN_SENDKEY` | Server酱 SendKey |
   | PushPlus | `PUSHPLUS_TOKEN` | PushPlus token |
   | PushPlus群组 | `PUSHPLUS_TOPIC` | PushPlus 群组编码（可选） |
   | Telegram | `TG_BOT_TOKEN` | Telegram Bot Token |
   | Telegram | `TG_CHAT_ID` | Telegram 接收消息的 Chat ID |
   | Bark (iOS) | `BARK_KEY` | Bark key 或完整 URL |
   | Bark分组 | `BARK_GROUP` | Bark 消息分组（可选） |
   | Discord | `DISCORD_WEBHOOK` | Discord Webhook 完整 URL |
   | 邮箱 SMTP | `MAIL_HOST` | SMTP 服务器地址（如 `smtp.qq.com`） |
   | 邮箱 SMTP | `MAIL_PORT` | SMTP 端口（默认 465） |
   | 邮箱 SMTP | `MAIL_USER` | 发件邮箱账号 |
   | 邮箱 SMTP | `MAIL_PASS` | 发件邮箱授权码（非登录密码） |
   | 邮箱 SMTP | `MAIL_TO` | 收件邮箱地址 |

   通知包含：签到结果总览、临期提醒置顶、各账号明细（听歌/广告领取、单日 VIP 领取与超级 VIP 升级状态、到期时间与剩余天数）、异常账号单独汇总等。

API源代码来自 [MakcRe/KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) ~~图省事直接搬来~~

## 令牌（Token）机制说明

项目中包含三类机密：

1. **GitHub Personal Access Token (PAT，可选)**：用于自动将酷狗登录信息写入仓库 Secret `USERINFO`，以及刷新酷狗登录 Token 后回写。建议使用最小权限的 fine-grained token（仅本仓库、Secrets 读写）。

2. **酷狗登录 Token**：存储在 `USERINFO` Secret 中，用于酷狗 API 身份认证。通过登录获取，可定期刷新（每周日签到时自动刷新，或用「账号管理 → refresh」手动刷新）。每个账号同时保存设备指纹 `dfid`（登录时通过 `/register/dev` 自动获取；老数据缺失时运行签到/账号管理会自动补齐并回写），风控较严的接口（如领取/升级 VIP）需要它才能正常调用。

3. **二维码加密口令 QR_PASS**：仅用于加密/解密扫码登录二维码，防止二维码在公开产物中泄露而被盗号。

## Secret 位置

1. 步骤一
   ![步骤一](./imgs/步骤一.jpg)
1. 步骤二
   ![步骤二](./imgs/步骤二.jpg)
1. 步骤三
   ![步骤三](./imgs/步骤三.jpg)
1. 步骤四
   ![步骤四](./imgs/步骤四.jpg)

## 致谢

- 感谢 [@MakcRe](https://github.com/MakcRe) 提供 API 源代码
- 感谢 [@itfw](https://github.com/itfw) 提供二维码显示问题的解决方案
- 感谢 [@klaas8](https://github.com/klaas8) 提供自动写入secret的方法
