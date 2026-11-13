$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Container = 'house-kit'
$Copied = '.house-kit-home'
$Shortcut = 'Kit.lnk'
$Installer = 'connect-linux.sh'
$Passed = @('HOUSE_KIT_RELAY/u', 'HOUSE_KIT_INSTALL_COMMAND/u')
$BootstrapArguments = @($args | ForEach-Object { [string]$_ })
$CopyScript = @'
set -eu
rm -rf "$0.new"
mkdir -m 700 "$0.new"
tar -x -C "$0.new" --strip-components=1 --anchored --exclude=kit-home/kit --exclude=kit-home/certificates.pem --exclude='kit-home/.*'
'@
$KeepScript = @'
set -eu
printf '%s\n' "$(wslpath -u "$1")" > "$0.new/workspace"
rm -rf "$0"
mv "$0.new" "$0"
'@
$HandoverScript = @'
set -eu
bootstrap=$(mktemp)
trap 'rm -f "$bootstrap"' EXIT
curl -fsSL -o "$bootstrap" "$0"
bash "$bootstrap" "$@"
'@

function Stop-Bootstrap([string] $Cause) {
  throw "kit_bootstrap_refused: $Cause"
}

function ConvertTo-NativeArgument([string] $Value) {
  if ((Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue) -in @('Windows', 'Standard')) { return $Value }
  if ($Value -eq '') { return '""' }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  if ($Value -match '\s') { $escaped = $escaped -replace '(\\+)$', '$1$1' }
  $escaped
}

function Join-CommandLine([string[]] $Words) {
  @($Words | ForEach-Object {
    if ($_ -ne '' -and $_ -notmatch '[\s"]') { return $_ }
    '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
  }) -join ' '
}

function Invoke-Native([string] $Command, [string[]] $NativeArguments) {
  $ErrorActionPreference = 'Continue'
  $output = @(& $Command @($NativeArguments | ForEach-Object { ConvertTo-NativeArgument $_ }) 2>&1 | ForEach-Object { "$_" -replace "`0", '' })
  [pscustomobject]@{ Status = $LASTEXITCODE; Output = $output }
}

function Get-LastLine([object] $Result) {
  @($Result.Output | Where-Object { $_.Trim() })[-1]
}

function Invoke-Ubuntu([string] $Ubuntu, [string[]] $Command, [string] $User) {
  $selected = @('--distribution', $Ubuntu)
  if ($User) { $selected += @('--user', $User) }
  Invoke-Native wsl.exe ($selected + @('--cd', '~', '--exec') + $Command)
}

function Read-Arguments([string[]] $Given) {
  $read = @{ '--house' = 'https://agents.house' }
  $chosen = @{}
  for ($index = 0; $index -lt $Given.Count; $index++) {
    $argument = $Given[$index]
    if ($argument -cne '--house' -and $argument -cne '--code') { Stop-Bootstrap "unknown argument $argument" }
    if ($index + 1 -ge $Given.Count) { Stop-Bootstrap "$argument requires one value" }
    if ($chosen.ContainsKey($argument) -and $argument -ceq '--house') { Stop-Bootstrap 'supply exactly one House origin' }
    if ($chosen.ContainsKey($argument)) { Stop-Bootstrap 'supply exactly one login code' }
    $index++
    $chosen[$argument] = $true
    $read[$argument] = $Given[$index]
  }
  $read
}

function Test-Host {
  if ($env:OS -ne 'Windows_NT') { Stop-Bootstrap 'this bootstrap is for Windows; run connect-linux.sh on Linux and macOS' }
  $processor = [int]@(Get-CimInstance -ClassName Win32_Processor)[0].Architecture
  $architecture = @{ 9 = 'amd64'; 12 = 'arm64' }[$processor]
  if (-not $architecture) {
    $described = @{ 0 = 'x86'; 5 = 'ARM' }[$processor]
    if (-not $described) { $described = "architecture $processor" }
    Stop-Bootstrap "unsupported Windows architecture $described"
  }
  if (-not [Environment]::Is64BitProcess) { Stop-Bootstrap 'this is a 32-bit PowerShell; run this bootstrap from the 64-bit Windows PowerShell' }
  $system = Get-CimInstance -ClassName Win32_OperatingSystem
  if ([int]$system.ProductType -ne 1 -or [int]$system.BuildNumber -lt 22000 -or $architecture -ne 'amd64') {
    $found = $system.Caption
    $contract = 'Windows 11'
    if ($architecture -ne 'amd64') {
      $found += " on $architecture"
      $contract += ' on amd64'
    }
    Write-Host "Warning: $found is outdated; update to $contract."
  }
}

function Test-Restart {
  Test-Path -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
}

function Install-Wsl {
  if ((Invoke-Native wsl.exe @('--status')).Status -eq 0) { return }
  $platform = @(Get-CimInstance -ClassName Win32_OptionalFeature -Filter "Name='VirtualMachinePlatform'")[0]
  Write-Host 'Installing WSL; Windows asks you to approve administrator rights.'
  try {
    $process = Start-Process -FilePath wsl.exe -ArgumentList @('--install', '--no-distribution') -Verb RunAs -Wait -PassThru
  } catch {
    Stop-Bootstrap "WSL could not be installed; Windows did not grant administrator rights: $($_.Exception.Message); run this command again and approve the prompt"
  }
  if ($process.ExitCode -ne 0) { Stop-Bootstrap "WSL could not be installed (exit $($process.ExitCode)); run this command again" }
  if ($platform.InstallState -ne 1) { Stop-Bootstrap 'WSL is installed and Windows needs a restart; restart Windows, then run this command again' }
}

function Find-Ubuntu {
  $listed = Invoke-Native wsl.exe @('--list', '--quiet')
  if ($listed.Status -ne 0) { return $null }
  $names = @($listed.Output | ForEach-Object { $_.Trim() } | Where-Object { $_ -like 'Ubuntu*' })
  if ($names -contains 'Ubuntu') { return 'Ubuntu' }
  $names[0]
}

function Install-Ubuntu {
  Write-Host 'Installing Ubuntu in WSL.'
  $installed = Invoke-Native wsl.exe @('--install', '--distribution', 'Ubuntu', '--no-launch')
  if ($installed.Status -ne 0) {
    if (Test-Restart) { Stop-Bootstrap 'WSL is installed and Windows needs a restart; restart Windows, then run this command again' }
    Stop-Bootstrap "Ubuntu could not be installed: $(Get-LastLine $installed)"
  }
  'Ubuntu'
}

function Get-LinuxName([string] $WindowsName) {
  $name = ($WindowsName.ToLowerInvariant() -replace '[^a-z0-9_-]', '') -replace '^[^a-z_]+', ''
  if ($name.Length -gt 32) { $name = $name.Substring(0, 32) }
  if (-not $name) { return 'user' }
  $name
}

function Initialize-User([string] $Ubuntu) {
  if ((Get-LastLine (Invoke-Ubuntu $Ubuntu @('id', '-u'))) -ne '0') { return }
  if ((Invoke-Ubuntu $Ubuntu @('getent', 'passwd', '1000') 'root').Status -eq 0) { return }
  $name = Get-LinuxName $env:USERNAME
  $created = Invoke-Ubuntu $Ubuntu @('/usr/sbin/useradd', '--create-home', '--shell', '/bin/bash', '--groups', 'sudo', $name) 'root'
  if ($created.Status -ne 0) { Stop-Bootstrap "the Ubuntu user $name could not be created: $(Get-LastLine $created)" }
  $chosen = Invoke-Native wsl.exe @('--manage', $Ubuntu, '--set-default-user', $name)
  if ($chosen.Status -ne 0) { Stop-Bootstrap "$name could not be made Ubuntu's default user: $(Get-LastLine $chosen)" }
}

function Get-KeptRunning([string] $Text) {
  $ending = "`r`n"
  if ($Text -match '[^\r]\n|^\n') { $ending = "`n" }
  $lines = [Collections.Generic.List[string]]::new()
  if ($Text -ne '') { $lines.AddRange([string[]]($Text -split '\r?\n')) }
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  $general = -1
  $section = ''
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match '^\s*\[([^\]]*)\]\s*$') {
      $section = $Matches[1].Trim()
      if ($section -eq 'general' -and $general -lt 0) { $general = $index }
    } elseif ($section -eq 'general' -and $lines[$index] -match '^\s*instanceIdleTimeout\s*=') {
      if ($lines[$index] -match '^\s*instanceIdleTimeout\s*=\s*-1\s*$') { return $Text }
      $lines[$index] = 'instanceIdleTimeout=-1'
      return ($lines -join $ending) + $ending
    }
  }
  if ($general -ge 0) {
    $lines.Insert($general + 1, 'instanceIdleTimeout=-1')
  } else {
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -ne '') { $lines.Add('') }
    $lines.Add('[general]')
    $lines.Add('instanceIdleTimeout=-1')
  }
  ($lines -join $ending) + $ending
}

function Set-KeepRunning {
  $path = Join-Path $env:USERPROFILE '.wslconfig'
  $text = ''
  if (Test-Path -LiteralPath $path -PathType Leaf) { $text = [IO.File]::ReadAllText($path) }
  $kept = Get-KeptRunning $text
  if ($kept -ceq $text) { return }
  [IO.File]::WriteAllText($path, $kept, (New-Object Text.UTF8Encoding($false)))
  Write-Host 'Restarting WSL so that it keeps running.'
  $stopped = Invoke-Native wsl.exe @('--shutdown')
  if ($stopped.Status -ne 0) { Stop-Bootstrap "WSL could not be restarted: $(Get-LastLine $stopped)" }
}

function Register-Start([string] $Ubuntu) {
  $link = Join-Path ([Environment]::GetFolderPath('Startup')) $Shortcut
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
  $shortcut.TargetPath = Join-Path $env:ProgramFiles 'WSL\wslg.exe'
  $shortcut.Arguments = Join-CommandLine @('--distribution', $Ubuntu, '--shell-type', 'none', '--', '/bin/true')
  $shortcut.Save()
}

function Find-Docker {
  $found = @(Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)
  if ($found.Count -gt 0) { return $found[0].Source }
  foreach ($location in @((Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'))) {
    if (Test-Path -LiteralPath $location -PathType Leaf) { return $location }
  }
  $null
}

function Get-WindowsPath([string] $Source) {
  if ($Source -match '^/run/desktop/mnt/host/([a-z])(/.*)?$') { return "$($Matches[1].ToUpper()):$($Matches[2] -replace '/', '\')" }
  $Source
}

function Copy-ContainerHome([string] $Docker, [string] $Ubuntu) {
  $reading = New-Object Diagnostics.ProcessStartInfo
  $reading.FileName = $Docker
  $reading.Arguments = Join-CommandLine @('cp', "${Container}:/kit-home", '-')
  $reading.UseShellExecute = $false
  $reading.RedirectStandardOutput = $true
  $writing = New-Object Diagnostics.ProcessStartInfo
  $writing.FileName = (Get-Command wsl.exe -CommandType Application)[0].Source
  $writing.Arguments = Join-CommandLine @('--distribution', $Ubuntu, '--cd', '~', '--exec', 'bash', '-c', $CopyScript, $Copied)
  $writing.UseShellExecute = $false
  $writing.RedirectStandardInput = $true
  $read = [Diagnostics.Process]::Start($reading)
  $written = [Diagnostics.Process]::Start($writing)
  $copied = $true
  try {
    $read.StandardOutput.BaseStream.CopyTo($written.StandardInput.BaseStream)
  } catch [IO.IOException] {
    $copied = $false
  } finally {
    $written.StandardInput.Close()
  }
  if (-not $copied -and -not $read.HasExited) { $read.Kill() }
  $read.WaitForExit()
  $written.WaitForExit()
  $copied -and $read.ExitCode -eq 0 -and $written.ExitCode -eq 0
}

function Invoke-Docker([string] $Docker, [string[]] $DockerArguments) {
  $result = Invoke-Native $Docker $DockerArguments
  if ($result.Status -ne 0) { Stop-Bootstrap "docker $($DockerArguments[0]) ended with status $($result.Status): $(Get-LastLine $result)" }
}

function Move-ContainerKit([string] $Ubuntu) {
  if ((Invoke-Ubuntu $Ubuntu @('test', '-e', '.agents/house/credential.json')).Status -eq 0) { return }
  $docker = Find-Docker
  if (-not $docker) { return }
  if ((Invoke-Native $docker @('info')).Status -ne 0) {
    if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE 'AgentsHouse') -PathType Container) {
      Stop-Bootstrap 'Kit runs in Docker Desktop on this computer, and Docker Desktop does not answer; start Docker Desktop, then run this command again'
    }
    return
  }
  $inspected = Invoke-Native $docker @('container', 'inspect', '--format', '{{json .Mounts}}', $Container)
  if ($inspected.Status -ne 0) { return }
  $mounts = ($inspected.Output -join "`n") | ConvertFrom-Json
  $workspace = @($mounts | Where-Object { $_.Destination -ceq '/agents/house' } | ForEach-Object { Get-WindowsPath $_.Source })
  if ($workspace.Count -ne 1) { Stop-Bootstrap "the container $Container mounts no workspace" }
  Write-Host 'Moving the Kit that runs in Docker Desktop into Ubuntu.'
  Invoke-Docker $docker @('stop', $Container)
  if (-not (Copy-ContainerHome $docker $Ubuntu) -or (Invoke-Ubuntu $Ubuntu @('bash', '-c', $KeepScript, $Copied, $workspace[0])).Status -ne 0) {
    Invoke-Docker $docker @('start', $Container)
    Stop-Bootstrap "the Kit in the container $Container could not be copied into Ubuntu, where it runs on as before"
  }
  Invoke-Docker $docker @('rm', $Container)
}

function Connect-Ubuntu([string] $Ubuntu, [hashtable] $Given) {
  $served = $Given['--house']
  if ($env:HOUSE_KIT_RELAY) { $served = "$($env:HOUSE_KIT_RELAY)/$(([uri]$Given['--house']).Authority)" }
  $handed = @('--house', $Given['--house'])
  if ($Given.ContainsKey('--code')) { $handed += @('--code', $Given['--code']) }
  $env:WSLENV = (@($env:WSLENV -split ':' | Where-Object { $_ -and $Passed -notcontains $_ }) + $Passed) -join ':'
  $words = @('--distribution', $Ubuntu, '--cd', '~', '--exec', 'bash', '-c', $HandoverScript, "$served/kit-installer/$Installer") + $handed
  & wsl.exe @($words | ForEach-Object { ConvertTo-NativeArgument $_ })
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "the install in Ubuntu ended with status $LASTEXITCODE" }
}

function Connect-Kit {
  $given = Read-Arguments $BootstrapArguments
  Test-Host
  Install-Wsl
  $ubuntu = Find-Ubuntu
  if (-not $ubuntu) { $ubuntu = Install-Ubuntu }
  Initialize-User $ubuntu
  Move-ContainerKit $ubuntu
  Register-Start $ubuntu
  Set-KeepRunning
  Connect-Ubuntu $ubuntu $given
}

$consoleEncoding = [Console]::OutputEncoding
$wslEnvironment = $env:WSLENV
$wslUtf8 = $env:WSL_UTF8
try {
  try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  } catch {
    Stop-Bootstrap 'this PowerShell has no console; run this bootstrap from a Windows PowerShell console window'
  }
  $env:WSL_UTF8 = '1'
  Connect-Kit
  $global:LASTEXITCODE = 0
} finally {
  $env:WSLENV = $wslEnvironment
  $env:WSL_UTF8 = $wslUtf8
  try { [Console]::OutputEncoding = $consoleEncoding } catch { }
}
