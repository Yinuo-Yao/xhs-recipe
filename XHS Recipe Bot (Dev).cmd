@echo off
setlocal
title XHS Recipe Bot - Dev Server
cd /d "E:\xhs-recipe-bot"
if not exist package.json (
  echo Could not find project folder: E:\xhs-recipe-bot
  echo Edit this file and update the path if you moved the project.
  pause
  exit /b 1
)
echo Starting dev server in %CD% ...
echo Press Ctrl+C to stop. Then press any key to close this window.
npm run dev
pause
