# OpenMimir installer for Windows: irm https://openmimir.com/install.ps1 | iex
#
# Installs mimir.exe and its web UI into %USERPROFILE%\.openmimir\bin and adds that
# folder to your PATH. No admin rights needed. Run it again to update.
# Set $env:MIMIR_VERSION = "v0.3.0" first to pin a version.
#
# Works in Windows PowerShell 5.1 and PowerShell 7. It never calls `exit`, so piping
# it into `iex` can't close your window.

function Install-OpenMimir {
  $ErrorActionPreference = "Stop"
  $repo = "openmimir/openmimir"
  $installDir = if ($env:MIMIR_INSTALL_DIR) { $env:MIMIR_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".openmimir\bin" }

  # PowerShell 5.1 defaults to old TLS versions that GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $arch = $null
  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    $arch = $env:PROCESSOR_ARCHITECTURE
  }
  switch -Regex ($arch) {
    "^(X64|AMD64)$" { $target = "windows-x64" }
    "^(Arm64|ARM64)$" { $target = "windows-arm64" }
    default { Write-Host "OpenMimir needs 64-bit Windows (found $arch)." -ForegroundColor Red; return }
  }

  if ($env:MIMIR_DOWNLOAD_BASE) {
    $base = $env:MIMIR_DOWNLOAD_BASE
  } elseif ($env:MIMIR_VERSION) {
    $base = "https://github.com/$repo/releases/download/$($env:MIMIR_VERSION)"
  } else {
    $base = "https://github.com/$repo/releases/latest/download"
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("openmimir-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $oldProgress = $ProgressPreference
  # The progress bar makes downloads many times slower in Windows PowerShell 5.1.
  $ProgressPreference = "SilentlyContinue"
  try {
    Write-Host "Installing OpenMimir " -NoNewline
    Write-Host "($target)" -ForegroundColor DarkGray

    $checksums = Join-Path $tmp "checksums.txt"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/checksums.txt" -OutFile $checksums
    $sums = Get-Content $checksums
    # Older releases have no ARM64 build; x64 runs under emulation on Windows on Arm.
    if ($target -eq "windows-arm64" -and -not ($sums -match "mimir-windows-arm64\.zip")) {
      Write-Host "No ARM64 build in this release, using x64." -ForegroundColor DarkGray
      $target = "windows-x64"
    }
    $archive = "mimir-$target.zip"
    $line = $sums | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1
    if (-not $line) { Write-Host "This release has no $archive." -ForegroundColor Red; return }
    $expected = ($line -split "\s+")[0].ToLower()

    $zip = Join-Path $tmp $archive
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$archive" -OutFile $zip
    $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($actual -ne $expected) { Write-Host "Checksum mismatch for $archive, not installing." -ForegroundColor Red; return }

    $unpacked = Join-Path $tmp "unpacked"
    Expand-Archive -Path $zip -DestinationPath $unpacked -Force

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $exe = Join-Path $installDir "mimir.exe"
    # Leftovers from an earlier update of a running Mimir.
    Get-ChildItem -Path $installDir -Filter "mimir.exe.old-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $old = $null
    if (Test-Path $exe) {
      # A running exe can't be overwritten, but it can be renamed out of the way.
      $old = Join-Path $installDir ("mimir.exe.old-" + [DateTime]::Now.ToString("yyyyMMddHHmmss"))
      Rename-Item -Path $exe -NewName (Split-Path $old -Leaf) -Force
    }
    $web = Join-Path $installDir "web"
    if (Test-Path $web) { Remove-Item -Path $web -Recurse -Force }
    Move-Item -Path (Join-Path $unpacked "mimir.exe") -Destination $exe
    Move-Item -Path (Join-Path $unpacked "web") -Destination $web
    Unblock-File -Path $exe -ErrorAction SilentlyContinue
    # Gone right away unless that Mimir is still running; then the next update removes it.
    if ($old) { Remove-Item -Path $old -Force -ErrorAction SilentlyContinue }

    if (-not (Test-Path $exe)) {
      Write-Host "mimir.exe disappeared right after installing. Your antivirus may have removed it;" -ForegroundColor Red
      Write-Host "please report it at https://github.com/$repo/issues" -ForegroundColor Red
      return
    }
    $version = "unknown"
    try { $version = (& $exe version 2>$null | Select-Object -First 1) } catch {}

    # Add to the user's PATH, keeping %VARIABLES% in it unexpanded.
    $key = Get-Item -Path "HKCU:\Environment"
    $userPath = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $entries = @($userPath -split ";" | Where-Object { $_ -ne "" })
    $onPath = $entries | Where-Object { $_.TrimEnd("\") -ieq $installDir.TrimEnd("\") }
    if (-not $onPath) {
      $newPath = (@($entries) + $installDir) -join ";"
      Set-ItemProperty -Path "HKCU:\Environment" -Name "Path" -Value $newPath -Type ExpandString
      # Tell Explorer, so new terminals see it without signing out.
      if (-not ("OpenMimir.Env" -as [type])) {
        Add-Type -Namespace OpenMimir -Name Env -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
      }
      $result = [UIntPtr]::Zero
      [void][OpenMimir.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
      Write-Host "Added $installDir to your PATH" -ForegroundColor DarkGray
    }
    if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $installDir.TrimEnd("\") })) {
      $env:Path = "$env:Path;$installDir"
    }

    Write-Host ""
    Write-Host "OpenMimir $version installed to $installDir" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next:"
    Write-Host "  mimir init     " -NoNewline
    Write-Host "# API keys and project folders" -ForegroundColor DarkGray
    Write-Host "  mimir          " -NoNewline
    Write-Host "# start, then open http://localhost:4747" -ForegroundColor DarkGray
    if (Get-Process -Name "mimir" -ErrorAction SilentlyContinue) {
      Write-Host ""
      Write-Host "Mimir is running; restart it to use this version." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    $ProgressPreference = $oldProgress
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-OpenMimir
