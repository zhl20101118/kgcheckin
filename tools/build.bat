@echo off
rem 编译 zero-dependency Windows 解密器 decrypt_qr.exe（需要 MinGW-w64 gcc 或 MSVC）
rem
rem 用法：双击本脚本，或在命令行运行  build.bat
rem
rem 优先级：gcc > clang(clang-cl 无 -l) > MSVC cl

where gcc >nul 2>nul
if %errorlevel%==0 (
  gcc -O2 -s -o decrypt_qr.exe decrypt_qr.c -lbcrypt
  goto :done
)

where clang >nul 2>nul
if %errorlevel%==0 (
  clang -O2 -o decrypt_qr.exe decrypt_qr.c -lbcrypt
  goto :done
)

where cl >nul 2>nul
if %errorlevel%==0 (
  cl /O2 /Fe:decrypt_qr.exe decrypt_qr.c bcrypt.lib
  goto :done
)

echo [x] 未找到 gcc / clang / cl 编译器，请先安装 MinGW-w64 或 Visual Studio Build Tools
exit /b 1

:done
if exist decrypt_qr.exe (
  echo [√] 编译完成: %~dp0decrypt_qr.exe
) else (
  echo [x] 编译失败，请检查上方错误信息
  exit /b 1
)
