$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ImageDigest = 'sha256:__IMAGE_DIGEST__'
$Release = '__KIT_RELEASE__'
$Name = 'house-kit'
$KitHome = 'house-kit-home'
$KitHomeMount = "type=volume,src=$KitHome,dst=/kit-home"
$Certificates = '/kit-home/certificates.pem'
$Link = 'Open this link and confirm: '
$Contained = '/kit-home/kit'
$Node = "$Contained/releases/$Release/bin/node"
$AuthorityMain = "$Contained/releases/$Release/lib/node_modules/@agentshouse/kit/dist/authority-main.js"
$ConfigureMain = "$Contained/releases/$Release/lib/node_modules/@agentshouse/kit/dist/configure-main.js"
$HoldEnrolment = 'cd /kit-home && mkdir held-enrolment && for record in credential.json disconnected.json; do [ ! -f $record ] || mv $record held-enrolment/ || exit 1; done'
$SettleEnrolment = 'cd /kit-home && if [ ! -e credential.json ]; then for record in credential.json disconnected.json; do [ ! -f held-enrolment/$record ] || mv held-enrolment/$record .; done; fi; rm -rf held-enrolment'
$KitHomeReader = @'
for field in house environment; do
  value=$(sed -n "s/.*\"$field\":\"\([^\"]*\)\".*/\1/p" /kit-home/credential.json 2>/dev/null)
  [ -z "$value" ] || printf '%s %s\n' "$field" "$value"
done
[ ! -f /kit-home/kit/current ] || printf 'release %s\n' "$(cat /kit-home/kit/current)"
exit 0

'@
$BootstrapArguments = @($args | ForEach-Object { [string]$_ })
$MinimumWsl = [version]'2.1.5'
# Docker Desktop's first start waits on its own terms and setup windows; five minutes bounds that before asking for a rerun.
$DesktopWaitSeconds = 300

function Stop-Bootstrap([string] $Cause) {
  throw "kit_bootstrap_refused: $Cause"
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
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "docker $($args[0]) ended with status $LASTEXITCODE" }
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
      Invoke-WebRequest -UseBasicParsing -Uri "https://desktop.docker.com/win/main/$Architecture/Docker%20Desktop%20Installer.exe" -OutFile $installer
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
    if (-not $location) { Stop-Bootstrap 'Kit is not installed; run this bootstrap without arguments first' }
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
    # Checking every two seconds finds Docker Desktop ready at most two seconds after it answers.
    Start-Sleep -Seconds 2
    $waited += 2
  }
  $docker
}

function Protect-Directory([string] $Path) {
  $User = [Security.Principal.WindowsIdentity]::GetCurrent().User
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
  $output = @($KitHomeReader | & docker run -i --rm --network none --mount $KitHomeMount --entrypoint sh $Image -s 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "the Kit home could not be read: $(@($output | Where-Object { $_ })[-1])" }
  $enrolment = @{}
  foreach ($line in @($output | Where-Object { $_ -match '^(house|environment|release) \S+$' })) {
    $field, $value = $line -split ' ', 2
    $enrolment[$field] = $value
  }
  $enrolment
}

function Read-Inspect([string] $Format) {
  $value = & docker inspect --format $Format $Name
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "docker inspect ended with status $LASTEXITCODE" }
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
  & docker run --rm @Network @Common login @LoginArguments | ForEach-Object {
    Write-Host $_
    if ($_.StartsWith($Link)) {
      try { Start-Process -FilePath $_.Substring($Link.Length) } catch { }
    }
  }
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "kit login ended with status $LASTEXITCODE" }
}

function Test-Authority {
  & docker run --rm @Network --entrypoint $Node @Common $AuthorityMain
  if ($LASTEXITCODE -eq 0) { return }
  if (-not $Code) { Stop-Bootstrap "House refuses the stored Kit credential of Environment $($enrolment['environment']); to reconnect it, run this command again with kit login appended" }
  $enrolment.Remove('environment')
}

function Invoke-KitHome([string] $Script) {
  Invoke-Docker run --rm --network none --mount $KitHomeMount --entrypoint sh $Image -c $Script | Out-Null
}

function Get-KitImage([string] $Origin) {
  $registry = ([uri]$Origin).Authority
  if ($env:HOUSE_KIT_RELAY) { $registry = ([uri]$env:HOUSE_KIT_RELAY).Authority + '/' + $registry }
  "$registry/kit@$ImageDigest"
}

function Read-Certificates {
  foreach ($store in @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root')) {
    foreach ($certificate in @(Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue)) {
      '-----BEGIN CERTIFICATE-----'
      [Convert]::ToBase64String($certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks).Replace("`r`n", "`n")
      '-----END CERTIFICATE-----'
    }
  }
}

function Write-Certificates {
  $ErrorActionPreference = 'Continue'
  (@(Read-Certificates) -join "`n") | & docker run -i --rm --network none --mount $KitHomeMount --entrypoint sh $Image -c "cat > $Certificates"
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "the computer's certificate authorities could not be written to Kit home: docker run ended with status $LASTEXITCODE" }
}

function Set-Configuration {
  $record = 'echo windows > /kit-home/placement'
  if ($env:HOUSE_KIT_INSTALL_COMMAND) { $record += '; printenv HOUSE_KIT_INSTALL_COMMAND > /kit-home/install-command' }
  Invoke-Docker run --rm --network none --env HOUSE_KIT_INSTALL_COMMAND --mount $KitHomeMount --entrypoint sh $Image -c $record | Out-Null
  $ErrorActionPreference = 'Continue'
  $output = @(& docker run --rm --network none --mount $KitHomeMount --entrypoint $Node $Image $ConfigureMain @NoSkills 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "the Kit configuration could not be written: $(@($output | Where-Object { $_ })[-1])" }
  $output -contains 'changed'
}

function Install-Release {
  $served = $House
  if ($env:HOUSE_KIT_RELAY) { $served = "$($env:HOUSE_KIT_RELAY)/$(([uri]$House).Authority)" }
  try {
    $installer = Invoke-RestMethod -UseBasicParsing -Uri "$served/kit-installer/connect-linux.sh"
  } catch {
    Stop-Bootstrap "the Kit installer could not be downloaded from ${House}: $($_.Exception.Message)"
  }
  $ErrorActionPreference = 'Continue'
  $installer | & docker run -i --rm @Network @Relay --env "NODE_EXTRA_CA_CERTS=$Certificates" --mount $KitHomeMount --entrypoint bash $Image -s - --house $House --place $Contained | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { Stop-Bootstrap "Kit $Release could not be placed in Kit home: docker run ended with status $LASTEXITCODE" }
}

function Get-HouseWorkdir([string] $Here, [string] $Root) {
  if ($Here -ieq $Root -or $Here.StartsWith("$Root\", [StringComparison]::OrdinalIgnoreCase)) {
    return "/agents/house$($Here.Substring($Root.Length).Replace('\', '/'))"
  }
  '/agents/house'
}

function Start-Resident {
  $resident = @()
  if (-not $House.StartsWith('https://')) { $resident = @('--network', 'host') }
  Invoke-Docker run -d --name $Name --restart on-failure @resident --env "NODE_EXTRA_CA_CERTS=$Certificates" --mount $KitHomeMount --mount $WorkspaceMount --label "agentshouse.house=$House" $Image resident | Out-Null
}

function Connect-Kit {
  $House = 'https://agents.house'
  $Workspace = $null
  $WorkspaceSelected = $false
  $HouseSelected = $false
  $Forwarding = $false
  $Forwarded = 'kit'
  $Forward = @()
  $NoSkills = @()
  $Login = @()
  $Code = $null
  $Rooms = @()
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
        $Login += @('--house', $House)
      }
    } elseif ($argument -ceq '--rooms') {
      if ($index + 1 -ge $Arguments.Count) { Stop-Bootstrap "$argument requires one value" }
      $index++
      $Rooms += @('--rooms', $Arguments[$index])
      $Login += @('--rooms', $Arguments[$index])
    } elseif ($argument -ceq '--no-private') {
      $Rooms += @('--no-private')
      $Login += @('--no-private')
    } elseif ($argument -ceq '--code') {
      if ($index + 1 -ge $Arguments.Count) { Stop-Bootstrap "$argument requires one value" }
      $index++
      $Code = $Arguments[$index]
      $Login += @('--code', $Code)
    } elseif ($argument -ceq '--no-skills') {
      $NoSkills = @('--no-skills')
    } else {
      Stop-Bootstrap "unknown argument $argument"
    }
  }

  if ($ImageDigest -notmatch '^sha256:[0-9a-f]{64}$' -or $Release -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$') { Stop-Bootstrap 'this bootstrap has not been published with an immutable release' }
  if ($env:OS -ne 'Windows_NT') { Stop-Bootstrap 'this bootstrap is for Windows; run connect-linux.sh on Linux and macOS' }
  $processor = [int]@(Get-CimInstance -ClassName Win32_Processor)[0].Architecture
  $Architecture = @{ 9 = 'amd64'; 12 = 'arm64' }[$processor]
  if (-not $Architecture) {
    $described = @{ 0 = 'x86'; 5 = 'ARM' }[$processor]
    if (-not $described) { $described = "architecture $processor" }
    Stop-Bootstrap "unsupported Windows architecture $described"
  }
  if (-not [Environment]::Is64BitProcess) { Stop-Bootstrap 'this is a 32-bit PowerShell; run this bootstrap from the 64-bit Windows PowerShell' }
  $system = Get-CimInstance -ClassName Win32_OperatingSystem
  if (-not $Forwarding -and ([int]$system.ProductType -ne 1 -or [int]$system.BuildNumber -lt 22000 -or $Architecture -ne 'amd64')) {
    $found = $system.Caption
    $contract = 'Windows 11'
    if ($Architecture -ne 'amd64') {
      $found += " on $Architecture"
      $contract += ' on amd64'
    }
    Write-Host "Warning: $found is outdated; update to $contract."
  }
  if ($WorkspaceSelected -and $Workspace -notmatch '^[A-Za-z]:\\') { Stop-Bootstrap 'workspace root must be an absolute path' }

  $docker = Initialize-DockerDesktop
  if (-not $docker.Platform.StartsWith('linux/')) { Stop-Bootstrap "Docker runs $($docker.Platform.Split('/')[0]) containers; switch Docker Desktop to Linux containers, then rerun this bootstrap" }
  if ($docker.System -ne 'Docker Desktop') { Stop-Bootstrap "Docker answers from $($docker.System), not Docker Desktop; stop that engine or switch Docker to Docker Desktop, then rerun this bootstrap" }
  if ($docker.Kernel -notlike '*WSL2*') { Stop-Bootstrap "Docker Desktop does not use its WSL 2 engine; turn on Use the WSL 2 based engine in its settings, then rerun this bootstrap" }
  $Platform = @{ 'linux/x86_64' = 'linux/amd64'; 'linux/amd64' = 'linux/amd64'; 'linux/aarch64' = 'linux/arm64'; 'linux/arm64' = 'linux/arm64' }[$docker.Platform]
  if (-not $Platform) { Stop-Bootstrap "unsupported Docker Desktop platform $($docker.Platform)" }
  $Image = Get-KitImage $House
  if ($HouseSelected -and (Invoke-Native docker @('volume', 'inspect', $KitHome)).Status -eq 0) {
    if ((Invoke-Native docker @('image', 'inspect', '--format', '{{.Id}}', $Image)).Status -ne 0) { Invoke-Docker pull --quiet --platform $Platform $Image | Out-Null }
    $held = Read-Enrolment
    if ($held.ContainsKey('house') -and $held['house'] -cne $House) {
      $key = ([uri]$House).Authority.Replace(':', '-')
      $Name = "house-kit-$key"
      $KitHome = "house-kit-home-$key"
      $KitHomeMount = "type=volume,src=$KitHome,dst=/kit-home"
      if (-not $WorkspaceSelected) { $Workspace = Join-Path $env:USERPROFILE "AgentsHouse-$key" }
    }
  }
  if ($Forwarding) {
    if (-not (Test-Container)) { Stop-Bootstrap 'Kit is not installed; run this bootstrap without arguments first' }
    if ((Read-Inspect '{{.Config.Image}}') -cne $Image) { Stop-Bootstrap 'an installed Kit uses a different image; rerun this bootstrap without arguments to update it' }
    $Workspace = Read-Source '/agents/house'
    if ($Workspace -notmatch '^[A-Za-z]:\\' -or -not (Test-Path -LiteralPath $Workspace -PathType Container)) {
      Stop-Bootstrap "the installed Kit's workspace root $Workspace is not a directory on this computer; rerun this bootstrap without arguments"
    }
  } else {
    Invoke-Docker volume create $KitHome | Out-Null
    if ((Invoke-Native docker @('image', 'inspect', '--format', '{{.Id}}', $Image)).Status -ne 0) { Invoke-Docker pull --quiet --platform $Platform $Image | Out-Null }
  }
  if (-not $Workspace) { $Workspace = Join-Path $env:USERPROFILE 'AgentsHouse' }

  $Workspace = Protect-Directory $Workspace
  $WorkspaceMount = "type=bind,src=$Workspace,dst=/agents/house"
  Invoke-KitHome $SettleEnrolment
  $enrolment = Read-Enrolment
  if ($enrolment.ContainsKey('environment')) {
    if (-not $enrolment.ContainsKey('house')) { Stop-Bootstrap 'the stored credential names no House origin' }
    $House = $enrolment['house']
    $Image = Get-KitImage $House
  }
  if ($House -notmatch '^(https://|http://127\.0\.0\.1:|http://localhost:)') { Stop-Bootstrap 'House origin must use HTTPS or local loopback HTTP' }
  $Network = @('--network', 'host')
  if ($House.StartsWith('https://')) { $Network = @() }
  $Relay = @()
  if ($env:HOUSE_KIT_RELAY) { $Relay = @('--env', "HOUSE_KIT_RELAY=$($env:HOUSE_KIT_RELAY)") }
  $Common = $Relay + @('--env', "NODE_EXTRA_CA_CERTS=$Certificates", '--mount', $KitHomeMount, '--mount', $WorkspaceMount, $Image)
  $placed = $false
  if (-not $Forwarding) {
    Write-Certificates
    if ($enrolment['release'] -cne $Release) {
      Install-Release
      $placed = $true
    }
  }

  if (Test-Container) {
    $installed = Read-Inspect '{{.Config.Image}} {{.HostConfig.RestartPolicy.Name}}'
    if ((Read-Inspect '{{len .Mounts}}') -cne '2') { Stop-Bootstrap 'the installed Kit has unexpected mounts' }
    if ((Read-Inspect '{{range .Mounts}}{{if eq .Destination `/kit-home`}}{{.Name}}{{end}}{{end}}') -cne $KitHome) { Stop-Bootstrap 'the Kit process uses another Kit home' }
    if ((Read-Inspect '{{range .Mounts}}{{if eq .Destination `/kit-home`}}{{.Type}}/{{.RW}}{{end}}{{end}}') -cne 'volume/true') { Stop-Bootstrap 'the installed Kit home is not a writable volume' }
    if ((Read-Source '/agents/house') -ine $Workspace) { Stop-Bootstrap 'the installed Kit uses another workspace root' }
    if ((Read-Inspect '{{range .Mounts}}{{if eq .Destination `/agents/house`}}{{.Type}}/{{.RW}}{{end}}{{end}}') -cne 'bind/true') { Stop-Bootstrap 'the installed workspace is not a writable bind mount' }
    if ((Read-Inspect '{{index .Config.Labels `agentshouse.house`}}') -cne $House) { Stop-Bootstrap 'the installed Kit uses another House origin' }
    if ($Forwarding) {
      $help = $Forward -ccontains '--help'
      if (-not $help -and $Forwarded -ceq 'kit' -and $Forward.Count -gt 0 -and $Forward[0] -ceq 'login') {
        Invoke-Login @($Forward | Select-Object -Skip 1)
        if ((Read-Inspect '{{.State.Running}}') -cne 'true') { Invoke-Docker start $Name | Out-Null }
        return
      }
      if (-not $help -and -not $enrolment.ContainsKey('environment')) { Stop-Bootstrap 'the installed Kit has no enrolled authority' }
      $placed = @()
      $entry = @()
      if ($Forwarded -ceq 'house') {
        $placed = @('--workdir', (Get-HouseWorkdir (Get-Location).ProviderPath.TrimEnd('\') $Workspace))
        $entry = @('--entrypoint', 'house')
      }
      $terminal = @()
      if (-not [Console]::IsInputRedirected) { $terminal = @('-t') }
      if ((Read-Inspect '{{.State.Running}}') -ceq 'true') {
        & docker exec -i @terminal @placed @Relay $Name $Forwarded @Forward
      } else {
        & docker run -i @terminal @placed @entry --rm @Network @Common @Forward
      }
      $status = $LASTEXITCODE
      if ($status -ne 0) { Stop-Bootstrap "$Forwarded ended with status $status" }
      if ($Forwarded -ceq 'kit' -and ($Forward -join ' ') -ceq 'logout') { Invoke-Docker stop $Name | Out-Null }
      return
    }
    if ($enrolment.ContainsKey('environment')) { Test-Authority }
    if (-not $enrolment.ContainsKey('environment')) { Invoke-Docker rm -f $Name | Out-Null }
  }

  if (Test-Container) {
    $configured = Set-Configuration
    if ($placed -or $installed -cne "$Image on-failure") {
      Invoke-Docker rm -f $Name | Out-Null
      Start-Resident
      Write-Host 'Kit updated.'
    } elseif ((Read-Inspect '{{.State.Running}}') -cne 'true') {
      Invoke-Docker start $Name | Out-Null
      Write-Host "Kit restarted for Environment $($enrolment['environment'])."
    } elseif ($configured) {
      Invoke-Docker restart $Name | Out-Null
      Write-Host "Kit restarted for Environment $($enrolment['environment'])."
    } else {
      Write-Host 'Kit is already installed.'
    }
    if ($Rooms.Count -gt 0) { Invoke-Login $Rooms }
    return
  }

  if ($enrolment.ContainsKey('environment')) { Test-Authority }
  $alreadyConnected = $enrolment.ContainsKey('environment')
  [void](Set-Configuration)
  if (-not $alreadyConnected) {
    if ($Code -and -not $HouseSelected) { $Login += @('--house', $House) }
    try {
      if ($Code) { Invoke-KitHome $HoldEnrolment }
      Invoke-Login $Login
    } finally {
      if ($Code) { Invoke-KitHome $SettleEnrolment }
    }
    $enrolment = Read-Enrolment
    if (-not $enrolment.ContainsKey('environment')) { Stop-Bootstrap 'kit login connected no Environment' }
  }
  Start-Resident
  Write-Host "Kit connected for Environment $($enrolment['environment'])."
  if ($alreadyConnected -and $Rooms.Count -gt 0) { Invoke-Login $Rooms }
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
} finally {
  try { [Console]::OutputEncoding = $consoleEncoding } catch { }
}
