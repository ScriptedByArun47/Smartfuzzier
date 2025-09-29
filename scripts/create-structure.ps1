<#
  create-structure.ps1
  Run: Open PowerShell in the folder you want to initialize and execute:
    .\create-structure.ps1
#>

$root = Get-Location

# folder list (relative)
$folders = @(
  "backend",
  "backend/app",
  "backend/app/api",
  "backend/app/crawler",
  "backend/app/ml",
  "backend/app/db",
  "node-crawler",
  "node-crawler/src",
  "frontend",
  "frontend/public",
  "frontend/src",
  "frontend/src/components",
  "infra",
  "tests",
  "tests/backend",
  "tests/node-crawler",
  "scripts"
)

Write-Host "Creating folders..."
foreach ($f in $folders) {
  $p = Join-Path $root $f
  if (-not (Test-Path $p)) {
    New-Item -ItemType Directory -Path $p -Force | Out-Null
    Write-Host "  Created: $f"
  } else {
    Write-Host "  Exists: $f"
  }
}

# helper to create file with optional content
function New-TextFile($path, $content) {
  if (-not (Test-Path $path)) {
    New-Item -ItemType File -Path $path -Force | Out-Null
    if ($content) { Set-Content -Path $path -Value $content -Force }
    Write-Host "  File: $path"
  } else {
    Write-Host "  File exists: $path"
  }
}

Write-Host "Creating placeholder files..."

# Root files
New-TextFile -path (Join-Path $root ".gitignore") @"
# Python
__pycache__/
.venv/
*.pyc

# Node
node_modules/

# VSCode
.vscode/

# SQLite
*.db
"@

New-TextFile -path (Join-Path $root "README.md") @"
# Hybrid Crawler + ML Pentest Tool

Structure scaffold created by create-structure.ps1.
See backend/, node-crawler/, frontend/ for components.
"@

# Backend placeholders
New-TextFile -path (Join-Path $root "backend/requirements.txt") @"
fastapi
uvicorn[standard]
httpx
beautifulsoup4
sqlalchemy
aiosqlite
"@

New-TextFile -path (Join-Path $root "backend/app/main.py") @"
from fastapi import FastAPI
app = FastAPI(title='Backend API')
@app.get('/health')
async def health():
    return {'status': 'ok'}
"@

New-TextFile -path (Join-Path $root "backend/app/crawler/__init__.py") ""
New-TextFile -path (Join-Path $root "backend/app/db/__init__.py") ""
New-TextFile -path (Join-Path $root "backend/app/schemas.py") @"
# Pydantic schemas go here
"@

# Node crawler placeholders
New-TextFile -path (Join-Path $root "node-crawler/package.json") @"
{
  ""name"": ""node-crawler"",
  ""version"": ""0.1.0"",
  ""private"": true,
  ""main"": ""src/server.js"",
  ""scripts"": {
    ""start"": ""node src/server.js""
  }
}
"@

New-TextFile -path (Join-Path $root "node-crawler/src/server.js") @"
// Express + Playwright crawler stub
const express = require('express');
const app = express();
app.use(express.json());
app.post('/crawl', async (req, res) => {
  // TODO: implement Playwright crawl and return JSON
  res.json({ ok: true, url: req.body.url, endpoints: [] });
});
app.listen(5001, () => console.log('Node crawler listening on 5001'));
"@

# Frontend placeholders
New-TextFile -path (Join-Path $root "frontend/package.json") @"
{
  ""name"": ""frontend"",
  ""version"": ""0.1.0"",
  ""private"": true,
  ""scripts"": {
    ""start"": ""react-scripts start""
  }
}
"@

New-TextFile -path (Join-Path $root "frontend/src/App.jsx") @"
import React from 'react';
export default function App() {
  return <div style={{padding:20}}>Frontend placeholder - connect to backend /scan endpoint.</div>;
}
"@

# Scripts
New-TextFile -path (Join-Path $root "scripts/create-structure.ps1") (Get-Content -Path $PSCommandPath -Raw)

# example infra docker-compose
New-TextFile -path (Join-Path $root "infra/docker-compose.yml") @"
version: '3.8'
services:
  backend:
    build: ./backend
    ports:
      - '8000:8000'
  node-crawler:
    build: ./node-crawler
    ports:
      - '5001:5001'
"@

Write-Host "All done. You can now open the project folder."

