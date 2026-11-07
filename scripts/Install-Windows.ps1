param([string]$Profile = "web")
$ErrorActionPreference = "Stop"
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  $version = & node -p "process.versions.node"
  if ($LASTEXITCODE -ne 0) { throw "请先安装 Node.js 24.9 或以上版本" }
  $parts = $version.Split('.')
  if ([int]$parts[0] -lt 24 -or ([int]$parts[0] -eq 24 -and [int]$parts[1] -lt 9)) { throw "需要 Node.js >= 24.9，当前 $version" }
  & npm install --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "构建失败" }
  & npm run setup
  if ($LASTEXITCODE -ne 0) { throw "配置生成失败" }
  $pluginDir = (Get-Location).Path
  & dsh plugin --profile $Profile add $pluginDir
  if ($LASTEXITCODE -ne 0) { throw "DSH 插件注册失败，请确认 dsh 命令和版本" }
  Write-Host "Shiguang 已安装。完成本机账号配置后，重启 DSH。"
} finally { Pop-Location }
