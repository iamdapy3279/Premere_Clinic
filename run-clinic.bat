@echo off
title Premere Clinic - Receptionist AI Console
cls

echo ======================================================================
echo             PREMERE CLINIC - SARVAM VOICE AGENT CONSOLE
echo ======================================================================
echo  Starting clinic server on local workstation...
echo  URL: http://localhost:5173
echo.
echo  Keep this window open while the clinic is operating.
echo  If the server exits unexpectedly, it will automatically restart.
echo ======================================================================
echo.

:run_loop
echo [%date% %time%] Starting Node.js server...
node --env-file-if-exists=.env server/index.js

echo.
echo ======================================================================
echo  [WARNING] Server stopped at %date% %time%
echo  Restarting in 5 seconds... (Press Ctrl+C to stop)
echo ======================================================================
timeout /t 5 >nul
goto run_loop
