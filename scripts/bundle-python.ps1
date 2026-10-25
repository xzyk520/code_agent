param(
  [string]$Version = "3.11.9",
  [string]$RuntimeDir = "runtime\win32-x64"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root $RuntimeDir
$tmp = Join-Path $env:TEMP ("bee-python-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  $zip = Join-Path $tmp "python.zip"
  Write-Host "Downloading Python $Version embeddable runtime..."
  & curl.exe -L --retry 3 --max-time 900 -o $zip "https://www.python.org/ftp/python/$Version/python-$Version-embed-amd64.zip"
  if ($LASTEXITCODE -ne 0) { throw "Python runtime download failed" }
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  New-Item -ItemType Directory -Force $target | Out-Null
  Expand-Archive -Path $zip -DestinationPath $target -Force

  $pth = Get-ChildItem -Path $target -Filter "python*._pth" | Select-Object -First 1
  if ($pth) {
    $lines = Get-Content $pth.FullName
    if (-not ($lines -contains "Lib\site-packages")) {
      $lines = @((Split-Path $pth.Name -Leaf).Replace("._pth", ".zip"), ".", "Lib\site-packages", "..\..", "import site")
    }
    Set-Content -Path $pth.FullName -Value $lines -Encoding ASCII
  }

  $python = Join-Path $target "python.exe"
  $getPip = Join-Path $tmp "get-pip.py"
  Write-Host "Installing pip..."
  & curl.exe -L --retry 3 --max-time 300 -o $getPip "https://bootstrap.pypa.io/get-pip.py"
  if ($LASTEXITCODE -ne 0) { throw "get-pip download failed" }
  & $python $getPip --no-warn-script-location
  if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed" }

  Write-Host "Installing beecode runtime dependencies..."
  & $python -m pip install --no-warn-script-location "httpx>=0.27" "pydantic>=2.7"
  if ($LASTEXITCODE -ne 0) { throw "dependency installation failed" }

  & $python -c "import httpx, pydantic, sys; print('bundled runtime ok:', sys.version)"
  if ($LASTEXITCODE -ne 0) { throw "runtime verification failed" }
  Write-Host "Bundled runtime ready: $target"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}