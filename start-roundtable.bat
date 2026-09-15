@echo off
chcp 65001 >nul
title 圆桌工作台启动器
echo ========================================
echo   圆桌工作台 一键启动
echo ========================================
echo.

rem ---- 1/2 服务 ----
netstat -ano | findstr ":3020 " | findstr LISTENING >nul
if %errorlevel%==0 goto svc_skip
echo [1/2] 正在启动服务 ...
start "roundtable-server" /min cmd /c "cd /d F:\web_agent_tablellm\products\roundtable && node app\server.mjs > data\server.log 2>&1"
set /a n=0
:wait_svc
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":3020 " | findstr LISTENING >nul
if %errorlevel%==0 goto svc_ok
set /a n+=1
if %n% lss 30 goto wait_svc
echo [1/2] 服务启动超时，请把 products\roundtable\data\server.log 发我排查。
goto browser
:svc_ok
echo [1/2] 服务已启动。
goto browser
:svc_skip
echo [1/2] 服务已在运行，跳过。

:browser
rem ---- 2/2 专用自动化浏览器 ----
netstat -ano | findstr ":9223 " | findstr LISTENING >nul
if %errorlevel%==0 goto chrome_skip
echo [2/2] 正在启动专用自动化浏览器 ...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir="F:\web_agent_tablellm\browser-profiles\roundtable" --no-first-run --no-default-browser-check http://127.0.0.1:3020
echo [2/2] 自动化浏览器已启动。
goto done
:chrome_skip
echo [2/2] 自动化浏览器已在运行，跳过。

:done
echo.
echo ========================================
echo   全部就绪： http://127.0.0.1:3020
echo.
echo   这个窗口是圆桌工作台专用的自动化浏览
echo   器，各家模型网站在这里各登录一次就会
echo   一直记住，以后双击启动器即可。
echo ========================================
echo.
pause
