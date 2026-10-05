$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Image = 'ghcr.io/agentshouse/kit@sha256:__IMAGE_DIGEST__'
$Name = 'house-kit'
$KitHome = 'house-kit-home'
$KitHomeMount = "type=volume,src=$KitHome,dst=/kit-home"
$Link = 'Open this link and confirm: '
$AuthorityMain = '/usr/local/lib/node_modules/@agentshouse/kit/dist/authority-main.js'
$ConfigureMain = '/usr/local/lib/node_modules/@agentshouse/kit/dist/configure-main.js'
$ClisMain = '/usr/local/lib/node_modules/@agentshouse/kit/dist/clis-main.js'
$EnrolmentReader = "try{const e=JSON.parse(require('fs').readFileSync('/kit-home/credential.json','utf8'));console.log('house',e.house);console.log('environment',e.environment)}catch(e){if(e.code!=='ENOENT')throw e}"
$BootstrapArguments = @($args | ForEach-Object { [string]$_ })
$MinimumBuild = 22631
$MinimumWsl = [version]'2.1.5'
$DesktopInstaller = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'
$DesktopWaitSeconds = 300

function Stop-Bootstrap([string] $Cause) {
  throw "kit_bootstrap_refused: $Cause"
}

function Exit-Bootstrap([int] $Status) {
  throw "kit_bootstrap_exit: $Status"
}

function Invoke-Native([string] $Command, [string[]] $NativeArguments) {
  $ErrorActionPreference = 'Continue'
  $output = @(& $Command @NativeArguments 2>&1 | ForEach-Object { "$_" })
  [pscustomobject]@{ Status = $LASTEXITCODE; Output = $output }
}

function ConvertTo-NativeArgument([string] $Value) {
  if ((Get-Variable -Name PSNativeCommandArgumentPassing -ValueOnly -ErrorAction SilentlyContinue) -in @('Windows', 'Standard')) { return $Value }
  if ($Value -eq '') { return '""' }
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  if ($PSVersionTable.PSEdition -eq 'Desktop' -and $Value -match '\s') { $escaped = $escaped -replace '(\\+)$', '$1$1' }
  $escaped
}

function Invoke-Docker {
  & docker @args
  if ($LASTEXITCODE -ne 0) { Exit-Bootstrap $LASTEXITCODE }
}

function Read-Docker {
  $read = [pscustomobject]@{ Answers = $false; Platform = ''; System = ''; Kernel = ''; Cause = 'the docker command is not installed' }
  if (-not (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) { return $read }
  $result = Invoke-Native docker @('info', '--format', '{{.OSType}}/{{.Architecture}}|{{.OperatingSystem}}|{{.KernelVersion}}')
  $line = @($result.Output | Where-Object { $_ -match '^[a-z]+/[a-z0-9_]+\|' })
  if ($result.Status -ne 0 -or $line.Count -eq 0) {
    $read.Cause = @($result.Output | Where-Object { $_ })[-1]
    return $read
  }
  $fields = $line[0].Split('|')
  $read.Answers = $true
  $read.Platform = $fields[0]
  $read.System = $fields[1]
  $read.Kernel = $fields[2]
  $read
}

function Invoke-Elevated([string] $FilePath, [string[]] $ElevatedArguments, [string] $Failure, [int[]] $Accepted = @(0)) {
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $ElevatedArguments -Verb RunAs -Wait -PassThru
  } catch {
    Stop-Bootstrap "$Failure; Windows did not grant administrator rights: $($_.Exception.Message); rerun this bootstrap and approve the prompt"
  }
  if ($Accepted -notcontains $process.ExitCode) {
    Stop-Bootstrap "$Failure (exit $($process.ExitCode)); rerun this bootstrap"
  }
}

function Get-WslVersion {
  if (-not (Get-Command wsl.exe -CommandType Application -ErrorAction SilentlyContinue)) { return $null }
  $result = Invoke-Native wsl.exe @('--version')
  if ($result.Status -ne 0) { return $null }
  if ((($result.Output -join "`n") -replace "`0", '') -match '(\d+)\.(\d+)\.(\d+)') {
    return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
  }
  $null
}

function Initialize-Wsl {
  $version = Get-WslVersion
  if ($null -eq $version) {
    Write-Host 'Installing WSL through wsl --install --no-distribution; Windows asks you to approve administrator rights.'
    Invoke-Elevated 'wsl.exe' @('--install', '--no-distribution') 'WSL could not be installed' @(0, 3010)
    Stop-Bootstrap 'WSL is installed and needs a Windows restart; restart Windows, then rerun this bootstrap'
  }
  if ($version -lt $MinimumWsl) {
    Write-Host "Updating WSL $version through wsl --update; Windows asks you to approve administrator rights."
    Invoke-Elevated 'wsl.exe' @('--update') 'WSL could not be updated'
  }
}

function Find-DockerDesktop {
  foreach ($location in @((Join-Path $env:ProgramFiles 'Docker\Docker'), (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop'))) {
    if (Test-Path -LiteralPath (Join-Path $location 'Docker Desktop.exe') -PathType Leaf) { return $location }
  }
  $null
}

function Add-DockerPath([string] $Location) {
  if (-not (Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) {
    $env:PATH = "$env:PATH;$(Join-Path $Location 'resources\bin')"
  }
}

function Install-DockerDesktop {
  $download = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
  [void][IO.Directory]::CreateDirectory($download)
  try {
    $installer = Join-Path $download 'Docker Desktop Installer.exe'
    Write-Host 'Downloading Docker Desktop for Windows from docker.com.'
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $DesktopInstaller -OutFile $installer
    } catch {
      Stop-Bootstrap "Docker Desktop could not be downloaded: $($_.Exception.Message)"
    }
    Write-Host 'Installing Docker Desktop for this Windows account.'
    try {
      $process = Start-Process -FilePath $installer -ArgumentList @('install', '--user', '--quiet') -Wait -PassThru
    } catch {
      Stop-Bootstrap "the Docker Desktop installer could not be started: $($_.Exception.Message)"
    }
    if ($process.ExitCode -ne 0) { Stop-Bootstrap "the Docker Desktop installer did not finish (exit $($process.ExitCode))" }
  } finally {
    Remove-Item -LiteralPath $download -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Initialize-DockerDesktop {
  $location = Find-DockerDesktop
  if ($location) { Add-DockerPath $location }
  $docker = Read-Docker
  if ($docker.Answers) { return $docker }
  if ($Forwarding) {
    if (-not $location) { Stop-Bootstrap 'House Kit is not installed; run this bootstrap without arguments first' }
    Stop-Bootstrap "Docker Desktop does not answer: $($docker.Cause); start Docker Desktop, then rerun this command"
  }
  Initialize-Wsl
  if (-not $location) {
    Install-DockerDesktop
    $location = Find-DockerDesktop
    if (-not $location) { Stop-Bootstrap 'Docker Desktop is not where its installer puts it; rerun this bootstrap' }
    Add-DockerPath $location
  }
  Write-Host 'Starting Docker Desktop; accept its terms or finish its setup if its window asks.'
  try {
    Start-Process -FilePath (Join-Path $location 'Docker Desktop.exe')
  } catch {
    Stop-Bootstrap "Docker Desktop could not be started: $($_.Exception.Message)"
  }
  $waited = 0
  while (-not ($docker = Read-Docker).Answers) {
    if ($waited -ge $DesktopWaitSeconds) {
      Stop-Bootstrap "Docker Desktop is not ready: $($docker.Cause); finish what its window asks, then rerun this bootstrap"
    }
    Start-Sleep -Seconds 2
    $waited += 2
  }
  $docker
}

function Protect-Directory([string] $Path) {
  if ($Path.Contains(',')) { Stop-Bootstrap "$Path contains a comma, which this bootstrap cannot pass to a Docker mount from Windows PowerShell" }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Stop-Bootstrap "$Path is a symbolic link" }
  $created = -not $item
  if ($created) {
    try { [void][IO.Directory]::CreateDirectory($Path) } catch { Stop-Bootstrap "$Path could not be created" }
    $item = Get-Item -LiteralPath $Path -Force
  }
  if (-not $item.PSIsContainer) { Stop-Bootstrap "$Path is not a directory" }
  $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (-not $created -and $owner -ne $User.Value) { Stop-Bootstrap "$Path is not owned by this User" }
  try {
    $security = New-Object Security.AccessControl.DirectorySecurity
    if ($owner -ne $User.Value) { $security.SetOwner($User) }
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($User, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    $item.SetAccessControl($security)
  } catch {
    Stop-Bootstrap "$Path could not be owner-protected"
  }
  $item.FullName.TrimEnd('\')
}

function Read-Enrolment {
  $ErrorActionPreference = 'Continue'
  $output = @(& docker run --rm --network none --mount $KitHomeMount --entrypoint node $Image -e $EnrolmentReader 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "the Kit home could not be read: $(@($output | Where-Object { $_ })[-1])" }
  $enrolment = @{}
  foreach ($line in @($output | Where-Object { $_ -match '^(house|environment) \S+$' })) {
    $field, $value = $line -split ' ', 2
    $enrolment[$field] = $value
  }
  $enrolment
}

function Read-Inspect([string] $Format) {
  $value = & docker inspect --format $Format $Name
  if ($LASTEXITCODE -ne 0) { Exit-Bootstrap $LASTEXITCODE }
  "$value"
}

function Read-Source([string] $Destination) {
  $source = Read-Inspect ('{{range .Mounts}}{{if eq .Destination `' + $Destination + '`}}{{.Source}}{{end}}{{end}}')
  if ($source -match '^/run/desktop/mnt/host/([a-z])(/.*)?$') { $source = "$($Matches[1].ToUpper()):$($Matches[2] -replace '/', '\')" }
  $source
}

function Test-Container {
  (Invoke-Native docker @('container', 'inspect', $Name)).Status -eq 0
}

function Invoke-Login([string[]] $LoginArguments) {
  if ($LoginArguments -contains '--manual') {
    Invoke-Docker run -i --rm @Network @Common login @LoginArguments
    return
  }
  & docker run @Published --rm @Network @Common login @LoginArguments | ForEach-Object {
    if ($_.StartsWith($Link)) {
      Write-Host "Opening House Login in the host browser: $($_.Substring($Link.Length))"
      try { Start-Process -FilePath $_.Substring($Link.Length) } catch { Stop-Bootstrap 'host browser did not open; rerun with --manual' }
    } else {
      Write-Host $_
    }
  }
  if ($LASTEXITCODE -ne 0) { Exit-Bootstrap $LASTEXITCODE }
}

function Test-Authority {
  & docker run --rm @Network --entrypoint node @Common $AuthorityMain
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "House refuses the stored Kit credential of Environment $($enrolment['environment']); to reconnect it, run this command again with kit login appended" }
}

function Set-Configuration {
  $ErrorActionPreference = 'Continue'
  $output = @(& docker run --rm --network none --mount $KitHomeMount --entrypoint node $Image $ConfigureMain @NoSkills 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "the Kit configuration could not be written: $(@($output | Where-Object { $_ })[-1])" }
  $output -contains 'changed'
}

function Update-Clis {
  $ErrorActionPreference = 'Continue'
  $listed = @(& docker run --rm @Network --entrypoint node @Common $ClisMain)
  if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('House Kit could not read the agent CLIs, so it updates none.')
    return $false
  }
  $updated = $false
  foreach ($line in $listed) {
    $name, $path, $release, $minimum, $state = "$line".Split("`t")
    if (-not $UpdateClis) {
      if ($state -cne 'old' -or -not $Interactive) { continue }
      $answer = Read-Host "$name $release is older than $minimum, the oldest this House Kit runs. Update it? [Y/n]"
      if ($answer -and $answer -notmatch '^[Yy]') { continue }
    }
    Write-Host "Updating $name $release."
    $terminal = @()
    if ($Interactive) { $terminal = @('-t') }
    & docker run -i @terminal --rm @Network --entrypoint $path @Common update | Out-Host
    if ($LASTEXITCODE -eq 0) {
      $updated = $true
    } else {
      [Console]::Error.WriteLine("$name could not be updated; it stays at $release.")
    }
  }
  $updated
}

function Start-Resident {
  $resident = @()
  if (-not $House.StartsWith('https://')) { $resident = @('--network', 'host') }
  Invoke-Docker run -d --name $Name --restart unless-stopped @resident --mount $KitHomeMount --mount $WorkspaceMount --label "agentshouse.house=$House" $Image resident | Out-Null
}

function Connect-Kit {
  $House = 'https://agents.house'
  $Workspace = $null
  $Manual = $false
  $WorkspaceSelected = $false
  $HouseSelected = $false
  $Forwarding = $false
  $Forwarded = 'kit'
  $Forward = @()
  $NoSkills = @()
  $UpdateClis = $false
  $Interactive = -not [Console]::IsInputRedirected
  $Arguments = $BootstrapArguments
  for ($index = 0; $index -lt $Arguments.Count; $index++) {
    $argument = $Arguments[$index]
    if ($argument -ceq 'kit' -or $argument -ceq 'house') {
      $Forwarding = $true
      $Forwarded = $argument
      $Forward = @($Arguments | Select-Object -Skip ($index + 1) | ForEach-Object { ConvertTo-NativeArgument $_ })
      break
    } elseif ($argument -ceq '--workspace' -or $argument -ceq '--house') {
      if ($index + 1 -ge $Arguments.Count) { Stop-Bootstrap "$argument requires one value" }
      $index++
      if ($argument -ceq '--workspace') {
        if ($WorkspaceSelected) { Stop-Bootstrap 'supply exactly one workspace root' }
        $Workspace = $Arguments[$index]
        $WorkspaceSelected = $true
      } else {
        if ($HouseSelected) { Stop-Bootstrap 'supply exactly one House origin' }
        $House = $Arguments[$index]
        $HouseSelected = $true
      }
    } elseif ($argument -ceq '--manual') {
      $Manual = $true
    } elseif ($argument -ceq '--no-skills') {
      $NoSkills = @('--no-skills')
    } elseif ($argument -ceq '--update-clis') {
      $UpdateClis = $true
    } else {
      Stop-Bootstrap "unknown argument $argument"
    }
  }

  if ($Image -notmatch '^ghcr\.io/agentshouse/kit@sha256:[0-9a-f]{64}$') { Stop-Bootstrap 'this bootstrap has not been published with an immutable image digest' }
  if ($env:OS -ne 'Windows_NT') { Stop-Bootstrap 'this bootstrap is for Windows 11; run connect-linux.sh on Linux and macOS' }
  if (-not [Environment]::Is64BitProcess) { Stop-Bootstrap 'this is a 32-bit PowerShell; run this bootstrap from the 64-bit Windows PowerShell' }
  $system = Get-CimInstance -ClassName Win32_OperatingSystem
  if ([int]$system.ProductType -ne 1) { Stop-Bootstrap "$($system.Caption) is a Windows Server edition; this bootstrap supports Windows 11 on amd64" }
  if ([int]$system.BuildNumber -lt 22000) { Stop-Bootstrap "$($system.Caption) is not Windows 11; this bootstrap supports Windows 11 on amd64" }
  if ([int]$system.BuildNumber -lt $MinimumBuild) { Stop-Bootstrap "Docker Desktop needs Windows 11 23H2 (build $MinimumBuild) or later, not build $($system.BuildNumber); update Windows, then rerun this bootstrap" }
  $processor = [int]@(Get-CimInstance -ClassName Win32_Processor)[0].Architecture
  if ($processor -ne 9) {
    $described = @{ 0 = 'x86'; 5 = 'ARM'; 12 = 'ARM64' }[$processor]
    if (-not $described) { $described = "architecture $processor" }
    Stop-Bootstrap "Windows on $described is not supported; this bootstrap supports Windows 11 on amd64"
  }
  if ($WorkspaceSelected -and $Workspace -notmatch '^[A-Za-z]:\\') { Stop-Bootstrap 'workspace root must be an absolute path' }

  $docker = Initialize-DockerDesktop
  if (-not $docker.Platform.StartsWith('linux/')) { Stop-Bootstrap "Docker runs $($docker.Platform.Split('/')[0]) containers; switch Docker Desktop to Linux containers, then rerun this bootstrap" }
  if ($docker.System -ne 'Docker Desktop') { Stop-Bootstrap "Docker answers from $($docker.System), not Docker Desktop; stop that engine or switch Docker to Docker Desktop, then rerun this bootstrap" }
  if ($docker.Kernel -notlike '*WSL2*') { Stop-Bootstrap "Docker Desktop does not use its WSL 2 engine; turn on Use the WSL 2 based engine in its settings, then rerun this bootstrap" }
  if ($docker.Platform -ne 'linux/x86_64' -and $docker.Platform -ne 'linux/amd64') { Stop-Bootstrap "host linux/amd64 does not match Docker Desktop $($docker.Platform)" }
  if ($Forwarding) {
    if (-not (Test-Container)) { Stop-Bootstrap 'House Kit is not installed; run this bootstrap without arguments first' }
    if ((Read-Inspect '{{.Config.Image}}') -cne $Image) { Stop-Bootstrap 'an installed Kit uses a different image; rerun this bootstrap without arguments to update it' }
    $Workspace = Read-Source '/agents/house'
    if ($Workspace -notmatch '^[A-Za-z]:\\' -or -not (Test-Path -LiteralPath $Workspace -PathType Container)) {
      Stop-Bootstrap "the installed Kit's workspace root $Workspace is not a directory on this computer; rerun this bootstrap without arguments"
    }
  } else {
    Invoke-Docker volume create $KitHome | Out-Null
    if ((Invoke-Native docker @('image', 'inspect', '--format', '{{.Id}}', $Image)).Status -ne 0) { Invoke-Docker pull --quiet --platform linux/amd64 $Image | Out-Null }
  }
  if (-not $Workspace) { $Workspace = Join-Path $env:USERPROFILE 'AgentsHouse' }

  $User = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $Workspace = Protect-Directory $Workspace
  $WorkspaceMount = "type=bind,src=$Workspace,dst=/agents/house"
  $enrolment = Read-Enrolment
  if ($enrolment.ContainsKey('environment')) {
    if (-not $enrolment.ContainsKey('house')) { Stop-Bootstrap 'the stored credential names no House origin' }
    if ($HouseSelected -and $House -cne $enrolment['house']) { Stop-Bootstrap 'this Environment is bound to another House origin' }
    $House = $enrolment['house']
  }
  if ($House -notmatch '^(https://|http://127\.0\.0\.1:|http://localhost:)') { Stop-Bootstrap 'House origin must use HTTPS or local loopback HTTP' }
  $Network = @('--network', 'host')
  $Published = @()
  if ($House.StartsWith('https://')) {
    $Network = @()
    $port = Get-Random -Minimum 49152 -Maximum 65536
    $Published = @('--publish', "127.0.0.1:${port}:$port", '--env', "HOUSE_KIT_LOGIN_PORT=$port")
  }
  $Common = @('--hostname', [Net.Dns]::GetHostName(), '--mount', $KitHomeMount, '--mount', $WorkspaceMount, $Image)

  if (Test-Container) {
    $installed = Read-Inspect '{{.Config.Image}}'
    if ((Read-Inspect '{{.HostConfig.RestartPolicy.Name}}') -cne 'unless-stopped') { Stop-Bootstrap 'the installed Kit has a different lifecycle' }
    if ((Read-Inspect '{{len .Mounts}}') -cne '2') { Stop-Bootstrap 'the installed Kit has unexpected mounts' }
    if ((Read-Inspect '{{range .Mounts}}{{if eq .Destination `/kit-home`}}{{.Name}}{{end}}{{end}}') -cne $KitHome) { Stop-Bootstrap 'the installed Kit uses another Kit home' }
    if ((Read-Inspect '{{range .Mounts}}{{if eq .Destination `/kit-home`}}{{.Type}}/{{.RW}}{{end}}{{end}}') -cne 'volume/true') { Stop-Bootstrap 'the installed Kit home is not a writable volume' }
    if ((Read-Source '/agents/house') -ine $Workspace) { Stop-Bootstrap 'the installed Kit uses another workspace root' }
    if ((Read-Inspect '{{range .Mounts}}{{if eq .Destination `/agents/house`}}{{.Type}}/{{.RW}}{{end}}{{end}}') -cne 'bind/true') { Stop-Bootstrap 'the installed workspace is not a writable bind mount' }
    if ((Read-Inspect '{{index .Config.Labels `agentshouse.house`}}') -cne $House) { Stop-Bootstrap 'the installed Kit uses another House origin' }
    if (-not $enrolment.ContainsKey('environment')) { Stop-Bootstrap 'the installed Kit has no enrolled authority' }
    if ($Forwarding) {
      if ($Forwarded -ceq 'kit' -and $Forward.Count -gt 0 -and $Forward[0] -ceq 'login') {
        Invoke-Login @($Forward | Select-Object -Skip 1)
        return
      }
      $placed = @()
      $entry = @()
      if ($Forwarded -ceq 'house') {
        $here = (Get-Location).ProviderPath.TrimEnd('\')
        if ($here -ine $Workspace -and -not $here.StartsWith("$Workspace\", [StringComparison]::OrdinalIgnoreCase)) {
          Stop-Bootstrap "the current directory is outside the workspace $Workspace"
        }
        $placed = @('--workdir', "/agents/house$($here.Substring($Workspace.Length).Replace('\', '/'))")
        $entry = @('--entrypoint', 'house')
      }
      $terminal = @()
      if (-not [Console]::IsInputRedirected) { $terminal = @('-t') }
      if ((Read-Inspect '{{.State.Running}}') -ceq 'true') {
        & docker exec -i @terminal @placed $Name $Forwarded @Forward
      } else {
        & docker run -i @terminal @placed @entry --rm @Network @Common @Forward
      }
      Exit-Bootstrap $LASTEXITCODE
    }
    Test-Authority
    $configured = Set-Configuration
    $updated = Update-Clis
    if ($installed -cne $Image) {
      Invoke-Docker rm -f $Name | Out-Null
      Start-Resident
      Write-Host "House Kit updated for Environment $($enrolment['environment'])."
      return
    }
    if ((Read-Inspect '{{.State.Running}}') -cne 'true') {
      Invoke-Docker start $Name | Out-Null
      Write-Host "House Kit restarted for Environment $($enrolment['environment'])."
    } elseif ($configured -or $updated) {
      Invoke-Docker restart $Name | Out-Null
      Write-Host "House Kit restarted for Environment $($enrolment['environment'])."
    } else {
      Write-Host "House Kit is already running for Environment $($enrolment['environment'])."
    }
    return
  }

  if ($enrolment.ContainsKey('environment')) {
    Test-Authority
  } else {
    $login = @()
    if ($HouseSelected) { $login += @('--house', $House) }
    if ($Manual) { $login += '--manual' }
    Invoke-Login $login
    $enrolment = Read-Enrolment
    if (-not $enrolment.ContainsKey('environment')) { Stop-Bootstrap 'kit login connected no Environment' }
  }
  [void](Set-Configuration)
  [void](Update-Clis)
  Start-Resident
  Write-Host "House Kit connected for Environment $($enrolment['environment'])."
}

$consoleEncoding = [Console]::OutputEncoding
try {
  try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  } catch {
    Stop-Bootstrap 'this PowerShell has no console; run this bootstrap from a Windows PowerShell console window'
  }
  Connect-Kit
  $global:LASTEXITCODE = 0
} catch {
  $message = "$($_.Exception.Message)"
  if ($message -match '^kit_bootstrap_exit: (\d+)$') {
    $global:LASTEXITCODE = [int]$Matches[1]
  } elseif ($message.StartsWith('kit_bootstrap_refused: ')) {
    [Console]::Error.WriteLine($message)
    $global:LASTEXITCODE = 1
  } else {
    $global:LASTEXITCODE = 1
    throw
  }
} finally {
  try { [Console]::OutputEncoding = $consoleEncoding } catch { }
}
