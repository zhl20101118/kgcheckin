/*
 * 酷狗签到增强版 · 扫码登录二维码一键解密工具（Windows 单文件版）
 *
 * 功能：
 *   1. 支持把 Actions 下载的 artifact .zip 或其中的 qr_bundle.enc 直接拖到本程序上
 *   2. 输入 QR_PASS 口令（输入时不回显）
 *   3. 解密还原二维码 PNG 与 login.html 到 同目录下的 qr_decrypted 文件夹
 *   4. 自动用系统默认查看器/浏览器打开二维码图片，方便立即扫码
 *
 * 依赖：仅 Windows 系统组件（BCrypt 完成 AES-256-GCM；zip 解压调用系统自带 tar.exe）。
 * 编译（MinGW/gcc）：
 *   gcc -O2 -s -o decrypt_qr.exe decrypt_qr.c -lbcrypt
 *  MSVC:
 *   cl /O2 decrypt_qr.c bcrypt.lib
 *
 * 加密格式（与 tools/../utils/qrCrypto.js 保持一致）：
 *   salt(16) | iv(12) | authTag(16) | ciphertext
 *   key = scrypt(UTF8(password), salt, N=16384, r=8, p=1, dkLen=32)
 *   AES-256-GCM(iv, tag), 明文为 JSON: {"files":{name: base64, ...}}
 */

#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <ctype.h>
#include <conio.h>
#include <direct.h>
#include <windows.h>
#include <bcrypt.h>

#pragma comment(lib, "bcrypt.lib")

#define SCRYPT_N 16384
#define SCRYPT_R 8
#define SCRYPT_P 1
#define KEY_LEN 32
#define SALT_LEN 16
#define IV_LEN 12
#define TAG_LEN 16

/* 自动模式（QR_PASS 环境变量 + 命令行文件参数）：跳过所有 pause，便于脚本/CI 调用 */
static int g_auto = 0;
#define PAUSE() do { if (!g_auto) system("pause"); } while (0)

/* ------------------------------------------------------------------ */
/* SHA-256 （自包含实现，不依赖任何库）                                  */
/* ------------------------------------------------------------------ */

typedef struct {
  uint32_t h[8];
  uint64_t total;
  uint8_t block[64];
  size_t used;
} sha256_ctx;

static uint32_t rotr32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static const uint32_t SHA256_K[64] = {
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};

static void sha256_transform(sha256_ctx *c, const uint8_t *p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++)
    w[i] = ((uint32_t)p[4*i] << 24) | ((uint32_t)p[4*i+1] << 16) | ((uint32_t)p[4*i+2] << 8) | p[4*i+3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = rotr32(w[i-15], 7) ^ rotr32(w[i-15], 18) ^ (w[i-15] >> 3);
    uint32_t s1 = rotr32(w[i-2], 17) ^ rotr32(w[i-2], 19) ^ (w[i-2] >> 10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  uint32_t a = c->h[0], b = c->h[1], cc = c->h[2], d = c->h[3];
  uint32_t e = c->h[4], f = c->h[5], g = c->h[6], h = c->h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = h + S1 + ch + SHA256_K[i] + w[i];
    uint32_t S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    uint32_t maj = (a & b) ^ (a & cc) ^ (b & cc);
    uint32_t t2 = S0 + maj;
    h = g; g = f; f = e; e = d + t1;
    d = cc; cc = b; b = a; a = t1 + t2;
  }
  c->h[0] += a; c->h[1] += b; c->h[2] += cc; c->h[3] += d;
  c->h[4] += e; c->h[5] += f; c->h[6] += g; c->h[7] += h;
}

static void sha256_init(sha256_ctx *c) {
  static const uint32_t H0[8] = {
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
    0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
  };
  memcpy(c->h, H0, sizeof H0);
  c->total = 0;
  c->used = 0;
}

static void sha256_update(sha256_ctx *c, const uint8_t *data, size_t len) {
  c->total += len;
  while (len > 0) {
    size_t space = 64 - c->used;
    size_t take = len < space ? len : space;
    memcpy(c->block + c->used, data, take);
    c->used += take;
    data += take;
    len -= take;
    if (c->used == 64) {
      sha256_transform(c, c->block);
      c->used = 0;
    }
  }
}

static void sha256_final(sha256_ctx *c, uint8_t out[32]) {
  uint64_t bitlen = c->total * 8;
  uint8_t pad = 0x80;
  sha256_update(c, &pad, 1);
  uint8_t zero = 0;
  while (c->used != 56) sha256_update(c, &zero, 1);
  uint8_t lenbuf[8];
  for (int i = 0; i < 8; i++) lenbuf[i] = (uint8_t)(bitlen >> (56 - 8 * i));
  sha256_update(c, lenbuf, 8);
  for (int i = 0; i < 8; i++) {
    out[4*i+0] = (uint8_t)(c->h[i] >> 24);
    out[4*i+1] = (uint8_t)(c->h[i] >> 16);
    out[4*i+2] = (uint8_t)(c->h[i] >> 8);
    out[4*i+3] = (uint8_t)(c->h[i]);
  }
}

/* ------------------------------------------------------------------ */
/* HMAC-SHA256 / PBKDF2                                                */
/* ------------------------------------------------------------------ */

static void hmac_sha256(const uint8_t *key, size_t keylen,
                        const uint8_t *m1, size_t m1len,
                        const uint8_t *m2, size_t m2len,
                        uint8_t out[32]) {
  uint8_t kopad[64], kipad[64], kin[32];
  if (keylen > 64) {
    sha256_ctx t;
    sha256_init(&t);
    sha256_update(&t, key, keylen);
    sha256_final(&t, kin);
    key = kin;
    keylen = 32;
  }
  memset(kipad, 0x36, 64);
  memset(kopad, 0x5c, 64);
  for (size_t i = 0; i < keylen; i++) { kipad[i] ^= key[i]; kopad[i] ^= key[i]; }

  uint8_t inner[32];
  sha256_ctx c;
  sha256_init(&c);
  sha256_update(&c, kipad, 64);
  if (m1) sha256_update(&c, m1, m1len);
  if (m2) sha256_update(&c, m2, m2len);
  sha256_final(&c, inner);

  sha256_init(&c);
  sha256_update(&c, kopad, 64);
  sha256_update(&c, inner, 32);
  sha256_final(&c, out);
}

static void pbkdf2_sha256(const uint8_t *pw, size_t pwlen,
                          const uint8_t *salt, size_t saltlen,
                          uint8_t *out, size_t dklen) {
  uint8_t ctr[4], u[32];
  size_t done = 0;
  uint32_t block = 1;
  while (done < dklen) {
    ctr[0] = (uint8_t)(block >> 24); ctr[1] = (uint8_t)(block >> 16);
    ctr[2] = (uint8_t)(block >> 8);  ctr[3] = (uint8_t)(block);
    hmac_sha256(pw, pwlen, salt, saltlen, ctr, 4, u);
    size_t take = (dklen - done) < 32 ? (dklen - done) : 32;
    memcpy(out + done, u, take);
    done += take;
    block++;
  }
}

/* ------------------------------------------------------------------ */
/* Salsa20/8 + BlockMix + ROMix + scrypt (RFC 7914)                    */
/* ------------------------------------------------------------------ */

static void salsa20_8(uint32_t B[16]) {
  uint32_t x[16];
  memcpy(x, B, sizeof x);
#define R(a, b) (((a) << (b)) | ((a) >> (32 - (b))))
  for (int i = 0; i < 8; i += 2) {
    x[4]  ^= R(x[0]  + x[12], 7);  x[8]  ^= R(x[4]  + x[0],  9);
    x[12] ^= R(x[8]  + x[4],  13); x[0]  ^= R(x[12] + x[8],  18);
    x[9]  ^= R(x[5]  + x[1],  7);  x[13] ^= R(x[9]  + x[5],  9);
    x[1]  ^= R(x[13] + x[9],  13); x[5]  ^= R(x[1]  + x[13], 18);
    x[14] ^= R(x[10] + x[6],  7);  x[2]  ^= R(x[14] + x[10], 9);
    x[6]  ^= R(x[2]  + x[14], 13); x[10] ^= R(x[6]  + x[2],  18);
    x[3]  ^= R(x[15] + x[11], 7);  x[7]  ^= R(x[3]  + x[15], 9);
    x[11] ^= R(x[7]  + x[3],  13); x[15] ^= R(x[11] + x[7],  18);
    x[1]  ^= R(x[0]  + x[3],  7);  x[2]  ^= R(x[1]  + x[0],  9);
    x[3]  ^= R(x[2]  + x[1],  13); x[0]  ^= R(x[3]  + x[2],  18);
    x[6]  ^= R(x[5]  + x[4],  7);  x[7]  ^= R(x[6]  + x[5],  9);
    x[4]  ^= R(x[7]  + x[6],  13); x[5]  ^= R(x[4]  + x[7],  18);
    x[11] ^= R(x[10] + x[9],  7);  x[8]  ^= R(x[11] + x[10], 9);
    x[9]  ^= R(x[8]  + x[11], 13); x[10] ^= R(x[9]  + x[8],  18);
    x[12] ^= R(x[15] + x[14], 7);  x[13] ^= R(x[12] + x[15], 9);
    x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
  }
#undef R
  for (int i = 0; i < 16; i++) B[i] += x[i];
}

static void block_mix(const uint32_t *B, uint32_t *Y, uint32_t r) {
  uint32_t X[16];
  memcpy(X, &B[(2 * r - 1) * 16], 64);
  for (uint32_t i = 0; i < 2 * r; i++) {
    for (int j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
    salsa20_8(X);
    memcpy(&Y[(i / 2 + (i % 2) * r) * 16], X, 64);
  }
}

static uint64_t integerify(const uint32_t *B, uint32_t r) {
  const uint32_t *last = &B[(2 * r - 1) * 16];
  return (uint64_t)last[0] | ((uint64_t)last[1] << 32);
}

static void smix(uint8_t *B, uint32_t r, uint64_t N, uint32_t *V, uint32_t *XY) {
  const size_t block_words = 32 * (size_t)r;
  uint32_t *X = XY;
  uint32_t *Y = XY + block_words;

  /* B 字节按小端读入 X */
  for (size_t i = 0; i < block_words; i++) {
    X[i] = (uint32_t)B[4*i] | ((uint32_t)B[4*i+1] << 8) |
           ((uint32_t)B[4*i+2] << 16) | ((uint32_t)B[4*i+3] << 24);
  }

  for (uint64_t i = 0; i < N; i += 2) {
    memcpy(&V[(size_t)i * block_words], X, block_words * 4);
    block_mix(X, Y, r);
    memcpy(&V[(size_t)(i + 1) * block_words], Y, block_words * 4);
    block_mix(Y, X, r);
  }
  for (uint64_t i = 0; i < N; i += 2) {
    uint64_t j = integerify(X, r) & (N - 1);
    const uint32_t *Vj = &V[(size_t)j * block_words];
    for (size_t k = 0; k < block_words; k++) X[k] ^= Vj[k];
    block_mix(X, Y, r);
    j = integerify(Y, r) & (N - 1);
    Vj = &V[(size_t)j * block_words];
    for (size_t k = 0; k < block_words; k++) Y[k] ^= Vj[k];
    block_mix(Y, X, r);
  }

  for (size_t i = 0; i < block_words; i++) {
    B[4*i+0] = (uint8_t)(X[i]);
    B[4*i+1] = (uint8_t)(X[i] >> 8);
    B[4*i+2] = (uint8_t)(X[i] >> 16);
    B[4*i+3] = (uint8_t)(X[i] >> 24);
  }
}

static void scrypt_kdf(const uint8_t *pw, size_t pwlen,
                       const uint8_t *salt, size_t saltlen,
                       uint64_t N, uint32_t r, uint32_t p,
                       uint8_t *dk, size_t dklen) {
  const size_t Bsz = 128 * (size_t)r * p;
  uint8_t *B = (uint8_t *)malloc(Bsz);
  uint32_t *V = (uint32_t *)malloc(128 * (size_t)r * (size_t)N);
  uint32_t *XY = (uint32_t *)malloc(256 * (size_t)r);
  if (!B || !V || !XY) {
    fprintf(stderr, "内存分配失败\n");
    exit(1);
  }

  pbkdf2_sha256(pw, pwlen, salt, saltlen, B, Bsz);
  for (uint32_t i = 0; i < p; i++)
    smix(B + i * 128 * (size_t)r, r, N, V, XY);
  pbkdf2_sha256(pw, pwlen, B, Bsz, dk, dklen);

  free(B); free(V); free(XY);
}

/* ------------------------------------------------------------------ */
/* AES-256-GCM 解密（Windows BCrypt）                                   */
/* ------------------------------------------------------------------ */

static int aes_gcm_decrypt(const uint8_t *key,
                           const uint8_t *iv, ULONG ivlen,
                           const uint8_t *ct, ULONG ctlen,
                           const uint8_t *tag, ULONG taglen,
                           uint8_t *out, ULONG *outlen) {
  BCRYPT_ALG_HANDLE hAlg = NULL;
  BCRYPT_KEY_HANDLE hKey = NULL;
  NTSTATUS st;
  int ok = 0;

  st = BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_AES_ALGORITHM, NULL, 0);
  if (!BCRYPT_SUCCESS(st)) return 0;
  st = BCryptSetProperty(hAlg, BCRYPT_CHAINING_MODE,
          (PUCHAR)BCRYPT_CHAIN_MODE_GCM, (ULONG)sizeof(BCRYPT_CHAIN_MODE_GCM), 0);
  if (!BCRYPT_SUCCESS(st)) goto cleanup_alg;
  st = BCryptGenerateSymmetricKey(hAlg, &hKey, NULL, 0, (PUCHAR)key, KEY_LEN, 0);
  if (!BCRYPT_SUCCESS(st)) goto cleanup_alg;

  {
    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info;
    BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = (PUCHAR)iv;
    info.cbNonce = ivlen;
    info.pbTag = (PUCHAR)tag;
    info.cbTag = taglen;
    info.pbAuthData = NULL;
    info.cbAuthData = 0;

    st = BCryptDecrypt(hKey, (PUCHAR)ct, ctlen, &info, NULL, 0,
                       out, ctlen, outlen, 0);
    if (BCRYPT_SUCCESS(st)) ok = 1;
  }

  BCryptDestroyKey(hKey);
cleanup_alg:
  BCryptCloseAlgorithmProvider(hAlg, 0);
  return ok;
}

/* ------------------------------------------------------------------ */
/* base64 解码                                                          */
/* ------------------------------------------------------------------ */

static int b64val(int ch) {
  if (ch >= 'A' && ch <= 'Z') return ch - 'A';
  if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
  if (ch >= '0' && ch <= '9') return ch - '0' + 52;
  if (ch == '+') return 62;
  if (ch == '/') return 63;
  return -1;
}

static uint8_t *b64decode(const char *in, size_t inlen, size_t *outlen) {
  uint8_t *out = (uint8_t *)malloc(inlen / 4 * 3 + 4);
  if (!out) return NULL;
  size_t n = 0;
  for (size_t i = 0; i < inlen;) {
    int v[4] = {0, 0, 0, 0};
    int pad = 0;
    for (int k = 0; k < 4 && i < inlen; k++) {
      if (in[i] == '=') { pad++; i++; v[k] = 0; }
      else { v[k] = b64val((unsigned char)in[i]); i++; }
    }
    uint32_t triple = ((uint32_t)v[0] << 18) | ((uint32_t)v[1] << 12) | ((uint32_t)v[2] << 6) | (uint32_t)v[3];
    out[n++] = (uint8_t)(triple >> 16);
    if (pad < 2) out[n++] = (uint8_t)(triple >> 8);
    if (pad < 1) out[n++] = (uint8_t)(triple);
  }
  *outlen = n;
  return out;
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

static uint8_t *read_file(const char *path, long *size) {
  FILE *fp = fopen(path, "rb");
  if (!fp) return NULL;
  fseek(fp, 0, SEEK_END);
  long sz = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  uint8_t *buf = (uint8_t *)malloc((size_t)sz + 1);
  if (!buf) { fclose(fp); return NULL; }
  fread(buf, 1, (size_t)sz, fp);
  fclose(fp);
  *size = sz;
  return buf;
}

/* 把本地代码页（GBK 等）的字符串转成 UTF-8，与 Node 端 scryptSync 的字节一致 */
static void to_utf8(const char *in, char *out, size_t cap) {
  int wlen = MultiByteToWideChar(CP_ACP, 0, in, -1, NULL, 0);
  if (wlen <= 0) { strncpy(out, in, cap); out[cap - 1] = 0; return; }
  wchar_t *w = (wchar_t *)malloc((size_t)wlen * sizeof(wchar_t));
  if (!w) { strncpy(out, in, cap); out[cap - 1] = 0; return; }
  MultiByteToWideChar(CP_ACP, 0, in, -1, w, wlen);
  WideCharToMultiByte(CP_UTF8, 0, w, -1, out, (int)cap, NULL, NULL);
  free(w);
}

/* 输入口令，不回显（显示 *）。读到的原始字节按 console 本地代码页处理。 */
static void read_password(char *buf, size_t cap) {
  size_t n = 0;
  while (n + 1 < cap) {
    int ch = _getch();
    if (ch == '\r' || ch == '\n') break;
    if (ch == '\b') {
      if (n > 0) { n--; printf("\b \b"); }
      continue;
    }
    /* GBK 中文与功能键都按原始字节累加；口令按字节精确匹配，无需区分 */
    buf[n++] = (char)ch;
    putchar('*');
  }
  buf[n] = '\0';
  putchar('\n');
}

/* 从 {"files":{"name":"base64", ...}} 中逐个取出 name/base64 并落盘 */
static int extract_bundle_files(const char *json, const char *outdir) {
  const char *files = strstr(json, "\"files\"");
  if (!files) { printf("[x] 解密结果格式异常（缺少 files 字段）。\n"); return 0; }
  const char *p = files;
  int count = 0;
  while ((p = strchr(p, '"')) != NULL) {
    const char *k1 = p + 1;
    const char *k2 = strchr(k1, '"');
    if (!k2) break;
    size_t keylen = (size_t)(k2 - k1);
    const char *colon = k2 + 1;
    while (*colon && (*colon == ':' || isspace((unsigned char)*colon))) colon++;
    if (*colon != '"') { p = k2 + 1; continue; }
    const char *v1 = colon + 1;
    const char *v2 = strchr(v1, '"');
    if (!v2) break;
    size_t vallen = (size_t)(v2 - v1);

    /* 过滤路径分隔符，仅取纯文件名 */
    char name[256];
    size_t cap = keylen < sizeof(name) - 1 ? keylen : sizeof(name) - 1;
    memcpy(name, k1, cap);
    name[cap] = 0;
    const char *base = strrchr(name, '/');
    const char *use = base ? base + 1 : name;

    size_t outlen = 0;
    uint8_t *data = b64decode(v1, vallen, &outlen);
    if (!data) { p = v2 + 1; continue; }

    char path[MAX_PATH];
    _snprintf(path, sizeof(path), "%s\\%s", outdir, use);
    FILE *fp = fopen(path, "wb");
    if (fp) {
      fwrite(data, 1, outlen, fp);
      fclose(fp);
      printf("  [+] %s (%lu 字节)\n", use, (unsigned long)outlen);
      count++;
    } else {
      printf("  [!] 无法写入 %s\n", path);
    }
    free(data);
    p = v2 + 1;
  }
  return count;
}

/* zip 解压：调用系统自带 tar.exe（Windows 10 1803+ / 11） */
static int extract_zip(const char *zip, const char *destdir) {
  char cmd[1024];
  _snprintf(cmd, sizeof(cmd), "tar -xf \"%s\" -C \"%s\" 1>nul 2>nul", zip, destdir);
  int rc = system(cmd);
  return rc == 0;
}

static int ends_with_ci(const char *s, const char *suffix) {
  size_t ls = strlen(s), ls2 = strlen(suffix);
  if (ls < ls2) return 0;
  return _stricmp(s + ls - ls2, suffix) == 0;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

static void open_result_files(const char *outdir) {
  WIN32_FIND_DATAA fd;
  char pattern[MAX_PATH];
  _snprintf(pattern, sizeof(pattern), "%s\\*.png", outdir);
  HANDLE h = FindFirstFileA(pattern, &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      char path[MAX_PATH];
      _snprintf(path, sizeof(path), "%s\\%s", outdir, fd.cFileName);
      printf("[i] 打开二维码图片: %s\n", fd.cFileName);
      ShellExecuteA(NULL, "open", path, NULL, NULL, SW_SHOW);
    } while (FindNextFileA(h, &fd));
    FindClose(h);
  }
  char html[MAX_PATH];
  _snprintf(html, sizeof(html), "%s\\login.html", outdir);
  if (GetFileAttributesA(html) != INVALID_FILE_ATTRIBUTES) {
    printf("[i] 打开汇页面 login.html\n");
    ShellExecuteA(NULL, "open", html, NULL, NULL, SW_SHOW);
  }
}

int main(int argc, char **argv) {
  /* 输出用 UTF-8 显示中文提示；输入保持系统本地代码页，口令随后手动转 UTF-8 */
  SetConsoleOutputCP(65001);

  if (argc > 1 && getenv("QR_PASS")) g_auto = 1;

  printf("=====================================================\n");
  printf("  酷狗签到增强版 - 扫码登录二维码一键解密工具\n");
  printf("  可直接把 Actions 下载的 .zip 或 qr_bundle.enc 拖到本程序上\n");
  printf("=====================================================\n\n");

  char input[MAX_PATH] = {0};
  if (argc > 1) {
    strncpy(input, argv[1], sizeof(input) - 1);
  } else {
    printf("请把文件拖进来，或粘贴文件路径后回车:\n> ");
    if (!fgets(input, sizeof(input), stdin)) return 1;
    /* 去除换行和首尾引号/空白 */
    size_t n = strlen(input);
    while (n && (input[n-1] == '\n' || input[n-1] == '\r' || input[n-1] == ' ' || input[n-1] == '"'))
      input[--n] = 0;
    char *s = input;
    while (*s == ' ' || *s == '"') s++;
    if (s != input) memmove(input, s, strlen(s) + 1);
  }

  if (GetFileAttributesA(input) == INVALID_FILE_ATTRIBUTES) {
    printf("[x] 文件不存在: %s\n", input);
    PAUSE();
    return 1;
  }

  /* 寻找 qr_bundle.enc：直接传入，或从 zip 解压 */
  char encPath[MAX_PATH] = {0};
  char zipTmp[MAX_PATH] = {0};
  if (ends_with_ci(input, ".zip")) {
    GetTempPathA(MAX_PATH, zipTmp);
    /* 注意：目录末尾不能带反斜杠，否则命令行里 "...\dir\" 的 \" 会被当作转义引号 */
    _snprintf(zipTmp + strlen(zipTmp), sizeof(zipTmp) - strlen(zipTmp), "kgqr%lu", (unsigned long)GetTickCount());
    if (_mkdir(zipTmp) != 0 && errno != EEXIST) {
      printf("[x] 无法创建临时目录。\n");
      PAUSE();
      return 1;
    }
    if (!extract_zip(input, zipTmp)) {
      printf("[x] zip 解压失败：系统 tar.exe 不可用。请手动解压 zip 后再把 qr_bundle.enc 拖给我。\n");
      PAUSE();
      return 1;
    }
    _snprintf(encPath, sizeof(encPath), "%s\\qr_bundle.enc", zipTmp);
    if (GetFileAttributesA(encPath) == INVALID_FILE_ATTRIBUTES) {
      printf("[x] 解压后未找到 qr_bundle.enc，请确认拖入的是 artifact 压缩包。\n");
      PAUSE();
      return 1;
    }
  } else {
    strncpy(encPath, input, sizeof(encPath) - 1);
  }

  long encSize = 0;
  uint8_t *enc = read_file(encPath, &encSize);
  if (!enc || encSize < SALT_LEN + IV_LEN + TAG_LEN + 1) {
    printf("[x] 加密文件读取失败或文件损坏。\n");
    PAUSE();
    return 1;
  }

  const uint8_t *salt = enc;
  const uint8_t *iv = enc + SALT_LEN;
  const uint8_t *tag = enc + SALT_LEN + IV_LEN;
  const uint8_t *ct = enc + SALT_LEN + IV_LEN + TAG_LEN;
  ULONG ctlen = (ULONG)(encSize - SALT_LEN - IV_LEN - TAG_LEN);

  uint8_t *plain = (uint8_t *)malloc((size_t)ctlen + 1);
  if (!plain) { printf("[x] 内存分配失败。\n"); PAUSE(); return 1; }

  /* 输出目录：始终在被拖入文件的旁边（即使是 zip 也不在临时目录里输出） */
  char outdir[MAX_PATH];
  strncpy(outdir, input, sizeof(outdir) - 1);
  char *sep = strrchr(outdir, '\\');
  if (sep) *sep = 0; else strcpy(outdir, ".");
  strncat(outdir, "\\qr_decrypted", sizeof(outdir) - strlen(outdir) - 1);
  _mkdir(outdir);

  char pass[512], passRaw[512];
  int ok = 0;
  const char *envPass = getenv("QR_PASS");
  const int hasEnvPass = envPass && *envPass;
  for (int attempt = 0; attempt < 3; attempt++) {
    if (hasEnvPass) {
      /* 支持 QR_PASS 环境变量传入（便于脚本/自动化） */
      strncpy(passRaw, envPass, sizeof(passRaw) - 1);
      passRaw[sizeof(passRaw) - 1] = 0;
      printf("[i] 使用环境变量 QR_PASS 中的口令\n");
    } else {
      printf("请输入 QR_PASS 口令: ");
      read_password(passRaw, sizeof(passRaw));
    }
    /* 统一转为 UTF-8 字节参与 scrypt，与 Node 端行为一致（兼容中文口令） */
    to_utf8(passRaw, pass, sizeof(pass));

    uint8_t key[KEY_LEN];
    scrypt_kdf((const uint8_t *)pass, strlen(pass), salt, SALT_LEN,
               SCRYPT_N, SCRYPT_R, SCRYPT_P, key, KEY_LEN);

    ULONG outlen = 0;
    ok = aes_gcm_decrypt(key, iv, IV_LEN, ct, ctlen, tag, TAG_LEN, plain, &outlen);
    if (ok) { plain[outlen] = 0; break; }
    printf("[x] 解密失败：口令错误或文件被篡改%s\n", attempt < 2 ? "，请重试" : "");
    if (hasEnvPass) break; /* 环境变量口令错误时无需重试 */
  }
  if (!ok) { PAUSE(); return 1; }

  printf("[√] 解密成功，正在还原文件到: %s\n", outdir);
  int count = extract_bundle_files((const char *)plain, outdir);
  if (count == 0) {
    printf("[x] 未解出任何文件。\n");
    PAUSE();
    return 1;
  }

  printf("\n[√] 完成！二维码即将用系统查看器打开，请尽快扫码（二维码约 2 分钟内有效）。\n\n");
  if (!g_auto) open_result_files(outdir);

  /* 清理 zip 解压的临时目录 */
  if (zipTmp[0]) {
    char cmd[MAX_PATH * 2];
    _snprintf(cmd, sizeof(cmd), "rmdir /s /q \"%s\" 1>nul 2>nul", zipTmp);
    system(cmd);
  }

  free(plain);
  free(enc);
  PAUSE();
  return 0;
}
