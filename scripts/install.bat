@echo off
setlocal EnableDelayedExpansion

REM overSeer Windows 安装/首次运行脚本
REM 用法：双击运行，或在 PowerShell/CMD 中执行 .\scripts\install.bat

echo.
echo  ============================================
echo   overSeer 安装与首次运行向导
echo  ============================================
echo.

REM 1. 检查 Node.js
call :check_command node
if !ERRORLEVEL! NEQ 0 (
  echo [X] 未检测到 Node.js。请先安装 Node.js >= 20：
  echo     https://nodejs.org/
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node --version') do set NODE_MAJOR=%%a
set NODE_MAJOR=!NODE_MAJOR:~1!
if !NODE_MAJOR! LSS 20 (
  echo [X] Node.js 版本过低。当前 !NODE_VERSION!，需要 >= 20
  exit /b 1
)
echo [OK] Node.js !NODE_VERSION!

REM 2. 检查 Git
call :check_command git
if !ERRORLEVEL! NEQ 0 (
  echo [X] 未检测到 git。请安装 git 并加入 PATH：
  echo     https://git-scm.com/
  exit /b 1
)
echo [OK] git

REM 3. 安装依赖
if not exist "node_modules" (
  echo [*] 安装依赖...
  call npm install
  if !ERRORLEVEL! NEQ 0 (
    echo [X] npm install 失败
    exit /b 1
  )
) else (
  echo [OK] node_modules 已存在
)

REM 4. 创建 data/logs
if not exist "data" mkdir data
if not exist "logs" mkdir logs

REM 5. 检查密钥配置
call :check_secrets

REM 6. 运行 doctor
echo.
echo [*] 运行 overSeer doctor 自检...
call npm run dev -- doctor
if !ERRORLEVEL! NEQ 0 (
  echo.
  echo [!] doctor 有未通过项，请按上方建议修复。
  echo     常见问题：
  echo       - 没填 GLM key：复制 config\.secrets.example.yaml -> config\.secrets.yaml 并填 apiKey
  echo       - 本地 fallback 没起：启动 Ollama，并确认 http://localhost:11434/v1 可达
  exit /b 1
)

echo.
echo  ============================================
echo   安装完成。常用命令：
echo  ============================================
echo.
echo   npm run dev -- status         查看状态
echo   npm run dev -- chat "你好"    聊天
echo   npm run dev -- tui            启动 TUI
echo   npm run dev -- daemon start   启动 daemon
echo   npm run dev -- cycle run      跑一轮自主巡检
echo.
pause
goto :eof

:check_command
where %1 > nul 2> nul
exit /b !ERRORLEVEL!

:check_secrets
if exist "config\.secrets.yaml" (
  echo [OK] 已存在 config\.secrets.yaml
) else (
  echo [*] 创建 config\.secrets.yaml 模板...
  copy config\.secrets.example.yaml config\.secrets.yaml > nul
  echo [OK] 已创建模板。请编辑 config\.secrets.yaml 填入 providers.glm.apiKey，
  echo     或设置环境变量：set OVERSEER_GLM_API_KEY=你的key
)
exit /b 0
