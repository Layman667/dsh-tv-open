@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1 || goto :missing
where npm >nul 2>&1 || goto :missing
node -e "const [m,n]=process.versions.node.split('.').map(Number);process.exit(m>24||m===24&&n>=9?0:1)" || goto :missing
if not exist "node_modules\.bin\dsh.cmd" call npm ci || goto :failed
if not exist "desktop\node_modules\.bin\dsh-pet-standalone.cmd" call npm --prefix desktop ci || goto :failed
call npm run init || goto :failed
call npm start
if errorlevel 1 goto :failed
exit /b 0
:missing
echo Install Node.js 24.9 or later and reopen this window.
:failed
pause
exit /b 1
