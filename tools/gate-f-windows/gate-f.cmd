@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem ==========================================================================
rem  hevy2garmin gate F on Windows: no Docker, no WSL, no administrator rights.
rem  docs/OWNER_RUNBOOK.md, block B.
rem
rem    gate-f.cmd setup ^<commit^>   download and verify Node.js and the source, build
rem    gate-f.cmd selftest          start the build without any data, check it, stop it
rem    gate-f.cmd prepare           check the new Neon database, write the private env file
rem    gate-f.cmd start             run the dashboard on http://127.0.0.1:8096 (Ctrl+C stops)
rem    gate-f.cmd stop ^| status
rem
rem  Everything lives in %LOCALAPPDATA%\hevy2garmin-gate-f (or GATE_F_HOME).
rem  Before anything runs, these pins are checked: the official Node.js ZIP and
rem  its node.exe, the source manifest and the launcher. The launcher then checks
rem  every source file against the manifest. Nothing else is trusted.
rem ==========================================================================

rem No variable here may start with NODE_ or OPENSSL_: Node inherits them, and the launcher refuses those.
set "PIN_NODE_VERSION=v22.23.5"
set "PIN_NODE_ZIP_SHA256=4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3"
set "PIN_NODE_EXE_SHA256=247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a"
set "MANIFEST_SHA256=0a181f80aa731863edecf31aa3061ba9aa9628fe0735a6f8a34b9770ad12a64d"
set "LAUNCHER_SHA256=ffa8ca03475dba55762349ad3b9619891d3046adef2498c051c050c51d31275f"
set "REPO=xantic21/hevy2garmin"
set "SYS=%SystemRoot%\System32"

if /i not "%PROCESSOR_ARCHITECTURE%"=="AMD64" (
  echo refusing: only Windows x64 is qualified for gate F
  exit /b 1
)
if defined PROCESSOR_ARCHITEW6432 (
  echo refusing: use the 64-bit Command Prompt
  exit /b 1
)
for %%v in (NODE_OPTIONS NODE_PATH NODE_USE_SYSTEM_CA NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED NODE_COMPILE_CACHE NODE_ICU_DATA NODE_REPL_EXTERNAL_MODULE OPENSSL_CONF OPENSSL_MODULES OPENSSL_ENGINES SSL_CERT_FILE SSL_CERT_DIR) do (
  if defined %%v (
    echo refusing: %%v is set in this window; open a new Command Prompt without it
    exit /b 1
  )
)
for %%t in (curl.exe tar.exe certutil.exe whoami.exe icacls.exe netstat.exe findstr.exe taskkill.exe) do (
  if not exist "%SYS%\%%t" (
    echo refusing: %SYS%\%%t is missing; gate F needs Windows 10 version 1803 or later
    exit /b 1
  )
)
"%SYS%\whoami.exe" /groups | "%SYS%\findstr.exe" /c:"S-1-16-12288" /c:"S-1-16-16384" >nul
if not errorlevel 1 (
  echo refusing: this window runs as administrator; use a normal Command Prompt
  exit /b 1
)

if defined GATE_F_HOME (set "ROOT=%GATE_F_HOME%") else (set "ROOT=%LOCALAPPDATA%\hevy2garmin-gate-f")
echo "%ROOT%" | "%SYS%\findstr.exe" /i /l /c:"onedrive" >nul
if not errorlevel 1 (
  echo refusing: the gate F folder is inside OneDrive; use a local folder
  exit /b 1
)
if not exist "%ROOT%\" mkdir "%ROOT%"
if not exist "%ROOT%\" (
  echo refusing: cannot create "%ROOT%"
  exit /b 1
)
rem The whole folder belongs to this user alone, before anything is downloaded into it.
set "SID="
for /f "tokens=2 delims=," %%s in ('""%SYS%\whoami.exe" /user /fo csv /nh"') do set "SID=%%~s"
if not defined SID (
  echo refusing: cannot determine the current user
  exit /b 1
)
"%SYS%\icacls.exe" "%ROOT%" /inheritance:r /grant:r "*%SID%:(OI)(CI)(F)" /C /Q >nul
if errorlevel 1 (
  echo refusing: cannot make "%ROOT%" private to you; use a folder on an NTFS drive under %%LOCALAPPDATA%%
  exit /b 1
)
pushd "%ROOT%"
if errorlevel 1 exit /b 1

if "%~1"=="" goto usage
if /i "%~1"=="setup" goto setup

call :verify_node
if errorlevel 1 goto fail
call :check "src\tools\gate-f-windows\SOURCE_MANIFEST.sha256" %MANIFEST_SHA256%
if errorlevel 1 goto fail
call :check "src\tools\gate-f-windows\gate-f.mjs" %LAUNCHER_SHA256%
if errorlevel 1 goto fail
"node\node.exe" "src\tools\gate-f-windows\gate-f.mjs" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo gate-f: %~1 ended with exit code %RC%
popd
exit /b %RC%

:setup
set "COMMIT=%~2"
if not defined COMMIT goto badcommit
echo(%COMMIT%| "%SYS%\findstr.exe" /r /x "[0123456789abcdef]*" >nul
if errorlevel 1 goto badcommit
if "%COMMIT:~39,1%"=="" goto badcommit
if not "%COMMIT:~40,1%"=="" goto badcommit
if not exist download\ mkdir download
call :verify_node quiet
if errorlevel 1 call :get_node
if errorlevel 1 goto fail
echo Downloading the source of %COMMIT%...
"%SYS%\curl.exe" -fsSL --retry 3 --proto =https --tlsv1.2 -o download\source.tar.gz "https://codeload.github.com/%REPO%/tar.gz/%COMMIT%"
if errorlevel 1 goto fail
set "SRC=download\hevy2garmin-%COMMIT%"
if exist "%SRC%\" rmdir /s /q "%SRC%"
"%SYS%\tar.exe" -xzf download\source.tar.gz -C download
if errorlevel 1 goto fail
if not exist "%SRC%\tools\gate-f-windows\gate-f.mjs" (
  echo refusing: the download is not commit %COMMIT% with the gate F launcher
  goto fail
)
call :check "%SRC%\tools\gate-f-windows\SOURCE_MANIFEST.sha256" %MANIFEST_SHA256%
if errorlevel 1 goto fail
call :check "%SRC%\tools\gate-f-windows\gate-f.mjs" %LAUNCHER_SHA256%
if errorlevel 1 goto fail
"node\node.exe" "%SRC%\tools\gate-f-windows\gate-f.mjs" build --commit %COMMIT% --from "%SRC%"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo gate-f: setup ended with exit code %RC%
popd
exit /b %RC%

:get_node
echo Downloading Node.js %PIN_NODE_VERSION% (official ZIP from nodejs.org)...
"%SYS%\curl.exe" -fsSL --retry 3 --proto =https --tlsv1.2 -o download\node.zip "https://nodejs.org/dist/%PIN_NODE_VERSION%/node-%PIN_NODE_VERSION%-win-x64.zip"
if errorlevel 1 exit /b 1
call :check download\node.zip %PIN_NODE_ZIP_SHA256%
if errorlevel 1 exit /b 1
if exist "download\node-%PIN_NODE_VERSION%-win-x64\" rmdir /s /q "download\node-%PIN_NODE_VERSION%-win-x64"
"%SYS%\tar.exe" -xf download\node.zip -C download
if errorlevel 1 exit /b 1
if exist node\ rmdir /s /q node
move "download\node-%PIN_NODE_VERSION%-win-x64" node >nul
if errorlevel 1 exit /b 1
call :verify_node
exit /b

:verify_node
if not exist node\node.exe (
  if /i not "%~1"=="quiet" echo refusing: Node.js is not set up here; run gate-f.cmd setup first
  exit /b 1
)
call :check node\node.exe %PIN_NODE_EXE_SHA256%
exit /b

rem :check <file> <expected sha256>
:check
set "GOT=none"
for /f "skip=1 delims=" %%h in ('""%SYS%\certutil.exe" -hashfile "%~1" SHA256"') do (
  set "GOT=%%h"
  goto check_got
)
:check_got
set "GOT=%GOT: =%"
if /i "%GOT%"=="%~2" exit /b 0
echo refusing: %~1 does not have the pinned SHA-256
exit /b 1

:badcommit
echo refusing: setup needs the full 40-character commit id from the runbook
goto fail

:usage
echo usage: gate-f.cmd setup ^<commit^> ^| selftest ^| prepare ^| start ^| stop ^| status
:fail
popd
exit /b 1
