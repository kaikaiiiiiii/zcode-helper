@echo off
setlocal
cd /d "%~dp0"

rem ZCode Helper 启动器：双击运行；`run.bat debug` 为调试模式（保留菜单/DevTools）
set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
  echo [ZCode Helper] 首次运行：安装依赖（含 Electron 下载，约 1-2 分钟，请勿关闭本窗口）...
  where npm >nul 2>&1 || (
    echo [ZCode Helper] 未找到 npm，请先安装 Node.js 后重试。
    pause
    exit /b 1
  )
  call npm install --no-audit --no-fund
  rem npm 安装不会拉取 Electron 二进制（本机实测：首次启动时才补下载），这里强制触发一次
  if not exist "%ELECTRON_EXE%" node -e "require('electron')" >nul 2>&1
)

if not exist "%ELECTRON_EXE%" (
  echo [ZCode Helper] 依赖安装失败：请手动执行 npm install 后重试。
  pause
  exit /b 1
)

if /i "%~1"=="debug" (
  start "ZCode Helper" "%ELECTRON_EXE%" . --debug
) else (
  start "ZCode Helper" "%ELECTRON_EXE%" .
)
exit /b 0
