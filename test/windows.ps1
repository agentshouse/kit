$tokens = $null
$errors = $null
$script = '/kit/bin/connect-windows.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($script, [ref]$tokens, [ref]$errors)
$findings = @($errors | ForEach-Object { "parse $($_.Extent.StartLineNumber): $($_.Message)" })
$findings += @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.ExitStatementAst] -or
  $node -is [System.Management.Automation.Language.PipelineChainAst] -or
  $node -is [System.Management.Automation.Language.TernaryExpressionAst] -or
  ($node -is [System.Management.Automation.Language.BinaryExpressionAst] -and $node.Operator -eq 'QuestionQuestion') -or
  ($node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Operator -eq 'QuestionQuestionEquals') -or
  ($node -is [System.Management.Automation.Language.MemberExpressionAst] -and $node.NullConditional) -or
  ($node -is [System.Management.Automation.Language.IndexExpressionAst] -and $node.NullConditional)
}, $true) | ForEach-Object { "forbidden $($_.Extent.StartLineNumber): $($_.GetType().Name)" })

foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -or $statement -is [System.Management.Automation.Language.AssignmentStatementAst]) {
    . ([scriptblock]::Create($statement.Extent.Text))
  }
}

function Refusal([scriptblock] $Act) {
  try {
    & $Act 6>$null | Out-Null
    'no refusal'
  } catch {
    $_.Exception.Message
  }
}

foreach ($case in @(
  @{ Given = @(); House = 'https://agents.house'; Code = $null },
  @{ Given = @('--house', 'https://dev.agents.house', '--code', 'ahk_code_one'); House = 'https://dev.agents.house'; Code = 'ahk_code_one' },
  @{ Given = @('--code', 'ahk_code_one', '--house', 'https://house.example.org'); House = 'https://house.example.org'; Code = 'ahk_code_one' }
)) {
  $read = Read-Arguments $case.Given
  if ($read['--house'] -cne $case.House -or $read['--code'] -cne $case.Code) { $findings += "Read-Arguments read $($case.Given -join ' ') as $($read['--house']) $($read['--code'])" }
}
foreach ($case in @(
  @(@('--bogus'), 'unknown argument --bogus'),
  @(@('--workspace', 'C:\Users\u\AgentsHouse'), 'unknown argument --workspace'),
  @(@('--rooms', 'r_k2v.4'), 'unknown argument --rooms'),
  @(@('--no-private'), 'unknown argument --no-private'),
  @(@('--no-skills'), 'unknown argument --no-skills'),
  @(@('kit', 'login'), 'unknown argument kit'),
  @(@('--code'), '--code requires one value'),
  @(@('--house', 'https://a.example', '--house', 'https://b.example'), 'supply exactly one House origin'),
  @(@('--code', 'one', '--code', 'two'), 'supply exactly one login code')
)) {
  $refused = Refusal { Read-Arguments $case[0] }
  if ($refused -cne "kit_bootstrap_refused: $($case[1])") { $findings += "Read-Arguments $($case[0] -join ' ') ended with: $refused" }
}

foreach ($case in @(
  @("", "[general]`r`ninstanceIdleTimeout=-1`r`n"),
  @("[wsl2]`nmemory=8GB`n", "[wsl2]`nmemory=8GB`n`n[general]`ninstanceIdleTimeout=-1`n"),
  @("[wsl2]`r`nmemory=8GB", "[wsl2]`r`nmemory=8GB`r`n`r`n[general]`r`ninstanceIdleTimeout=-1`r`n"),
  @("[general]`r`nautoProxy=false`r`n[wsl2]`r`nmemory=8GB`r`n", "[general]`r`ninstanceIdleTimeout=-1`r`nautoProxy=false`r`n[wsl2]`r`nmemory=8GB`r`n"),
  @("# mine`n[General]`ninstanceIdleTimeout = 15000`n[wsl2]`nswap=0`n", "# mine`n[General]`ninstanceIdleTimeout=-1`n[wsl2]`nswap=0`n"),
  @("[wsl2]`ninstanceIdleTimeout=5000`n", "[wsl2]`ninstanceIdleTimeout=5000`n`n[general]`ninstanceIdleTimeout=-1`n"),
  @("[general]`ninstanceIdleTimeout = -1`n[wsl2]`nmemory=8GB`n", "[general]`ninstanceIdleTimeout = -1`n[wsl2]`nmemory=8GB`n")
)) {
  $kept = Get-KeptRunning $case[0]
  if ($kept -cne $case[1]) { $findings += "Get-KeptRunning turned $($case[0] | ConvertTo-Json) into $($kept | ConvertTo-Json)" }
}
$profileFolder = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
[void][IO.Directory]::CreateDirectory($profileFolder)
$env:USERPROFILE = $profileFolder
$wslconfig = Join-Path $profileFolder '.wslconfig'
Set-KeepRunning
if ([IO.File]::ReadAllText($wslconfig) -cne "[general]`r`ninstanceIdleTimeout=-1`r`n") { $findings += "Set-KeepRunning wrote a new .wslconfig as: $([IO.File]::ReadAllText($wslconfig) | ConvertTo-Json)" }
[IO.File]::WriteAllText($wslconfig, "[wsl2]`nmemory=8GB`n")
Set-KeepRunning
Set-KeepRunning
if ([IO.File]::ReadAllText($wslconfig) -cne "[wsl2]`nmemory=8GB`n`n[general]`ninstanceIdleTimeout=-1`n") { $findings += "Set-KeepRunning kept the person's .wslconfig as: $([IO.File]::ReadAllText($wslconfig) | ConvertTo-Json)" }
if ([IO.File]::ReadAllBytes($wslconfig)[0] -eq 0xEF) { $findings += 'Set-KeepRunning wrote a byte order mark' }

foreach ($case in @(
  @('Anton', 'anton'),
  @('John Doe', 'johndoe'),
  @('1st.User', 'stuser'),
  @('_svc-build', '_svc-build'),
  @([string]::new([char]0x0410, 5), 'user'),
  @(('A' * 40), ('a' * 32))
)) {
  $named = Get-LinuxName $case[0]
  if ($named -cne $case[1]) { $findings += "Get-LinuxName named $($case[0]) $named, not $($case[1])" }
}

$fake = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
$bin = Join-Path $fake 'bin'
$ubuntuHome = Join-Path $fake 'ubuntu'
[void][IO.Directory]::CreateDirectory($bin)
$env:FAKE = $fake
$env:UBUNTU = $ubuntuHome
$env:PATH = "${bin}:$env:PATH"
$tools = @{
  'wsl.exe' = @'
#!/bin/sh
printf '%s' "$*" | tr '\n' ' ' >> "$FAKE/wsl.log"
echo >> "$FAKE/wsl.log"
case "$1" in
  --version) [ ! -e "$FAKE/no-wsl" ]; exit ;;
  --list) [ -s "$FAKE/distributions" ] || exit 1; cat "$FAKE/distributions"; exit 0 ;;
  --install) echo Ubuntu >> "$FAKE/distributions"; exit 0 ;;
  --manage) exit 0 ;;
esac
while [ "$1" != --exec ]; do shift; done
shift
case "$1" in
  id) if [ -e "$FAKE/root-default" ]; then echo 0; else echo 1001; fi; exit 0 ;;
  getent) [ -e "$FAKE/user-1000" ]; exit ;;
  useradd) exit 0 ;;
esac
for name in $(printf '%s' "${WSLENV:-}" | tr ':' ' '); do
  name=${name%%/*}
  if value=$(printenv "$name"); then set -- "$name=$value" "$@"; fi
done
cd "$UBUNTU" && exec env -i HOME="$UBUNTU" PATH="$PATH" FAKE="$FAKE" "$@"
'@
  'docker' = @'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/docker.log"
case "$1" in
  info) [ ! -e "$FAKE/docker-down" ]; exit ;;
  container) [ -e "$FAKE/mounts" ] || { echo 'Error: No such container: house-kit' >&2; exit 1; }; cat "$FAKE/mounts" ;;
  cp) [ ! -e "$FAKE/cp-fails" ] || { echo 'Error response from daemon: no space left on device' >&2; exit 1; }; tar -c -C "$FAKE/volume" kit-home ;;
  rm) rm -f "$FAKE/mounts" ;;
esac
'@
  'wslpath' = @'
#!/bin/sh
[ "$1" != -u ] || shift
printf '%s\n' "$1" | sed -e 's|^\([A-Za-z]\):|/mnt/\L\1|' -e 's|\\|/|g'
'@
  'curl' = @'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/curl.log"
cp "$FAKE/bootstrap.sh" "$3"
'@
}
foreach ($tool in $tools.Keys) {
  [IO.File]::WriteAllText((Join-Path $bin $tool), $tools[$tool].Replace("`r`n", "`n"))
  & chmod 755 (Join-Path $bin $tool)
}
[IO.File]::WriteAllText((Join-Path $fake 'bootstrap.sh'), "printf '%s\n' `"`$*`" > `"`$FAKE/bootstrap.args`"`nprintf '%s|%s\n' `"`${HOUSE_KIT_RELAY-unset}`" `"`${HOUSE_KIT_INSTALL_COMMAND-unset}`" > `"`$FAKE/bootstrap.env`"`nexit `"`$(cat `"`$FAKE/bootstrap.status`" 2>/dev/null || echo 0)`"`n")

function Read-Fake([string] $Name) {
  $path = Join-Path $fake $Name
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  @([IO.File]::ReadAllLines($path))
}

function Reset-Fake {
  foreach ($entry in @(Get-ChildItem -LiteralPath $fake -Force | Where-Object { $_.Name -ne 'bin' -and $_.Name -ne 'bootstrap.sh' })) { Remove-Item -LiteralPath $entry.FullName -Recurse -Force }
  [void][IO.Directory]::CreateDirectory($ubuntuHome)
  $volume = Join-Path $fake 'volume/kit-home'
  foreach ($folder in @('kit/releases/0.2.1', 'local-copies/rooms', '.claude', '.agents/skills/house')) { [void][IO.Directory]::CreateDirectory((Join-Path $volume $folder)) }
  $files = @{
    'credential.json' = '{"house":"https://agents.house","environment":"environment-one","credential":"ahk_held"}'
    'kit.json' = '{"skills":false}'
    'placement' = 'windows'
    'install-command' = 'irm agents.house/kit.ps1 | iex'
    'local-copies/rooms/r_notes.json' = '{"key":"rooms/r_notes","repository":"/agents/house/local-copies/rooms/notes"}'
    'kit/current' = '0.2.1'
    '.claude/.credentials.json' = '{}'
  }
  foreach ($name in $files.Keys) { [IO.File]::WriteAllText((Join-Path $volume $name), "$($files[$name])`n") }
  & chmod 600 (Join-Path $volume 'credential.json')
}

function Set-Mounts([string] $Workspace) {
  [IO.File]::WriteAllText((Join-Path $fake 'mounts'), (ConvertTo-Json -Compress @(@{ Type = 'volume'; Name = 'house-kit-home'; Source = '/var/lib/docker/volumes/house-kit-home/_data'; Destination = '/kit-home' }, @{ Type = 'bind'; Source = $Workspace; Destination = '/agents/house' })))
}

function Get-Copied {
  $folder = Join-Path $ubuntuHome '.house-kit-home'
  if (-not (Test-Path -LiteralPath $folder)) { return 'nothing' }
  (@(Get-ChildItem -LiteralPath $folder -Recurse -Force -File | ForEach-Object { $_.FullName.Substring($folder.Length + 1) }) | Sort-Object) -join ','
}

$distribution = 'Ubuntu'
foreach ($case in @(
  @{ Name = 'a Windows path'; Source = 'C:\Users\u\AgentsHouse'; Workspace = '/mnt/c/Users/u/AgentsHouse' },
  @{ Name = "Docker Desktop's host path"; Source = '/run/desktop/mnt/host/c/Users/u/Agents House'; Workspace = '/mnt/c/Users/u/Agents House' }
)) {
  Reset-Fake
  Set-Mounts $case.Source
  $refused = Refusal { Move-ContainerKit $distribution }
  if ($refused -cne 'no refusal') { $findings += "the takeover from $($case.Name) refused with: $refused" }
  $listed = Get-Copied
  if ($listed -cne 'credential.json,install-command,kit.json,local-copies/rooms/r_notes.json,placement,workspace') { $findings += "the takeover from $($case.Name) copied: $listed" }
  $workspace = @([IO.File]::ReadAllLines((Join-Path $ubuntuHome '.house-kit-home/workspace')))
  if (($workspace -join '|') -cne $case.Workspace) { $findings += "the takeover from $($case.Name) named the workspace $($workspace -join '|')" }
  if ([IO.File]::ReadAllText((Join-Path $ubuntuHome '.house-kit-home/credential.json')) -cne "{`"house`":`"https://agents.house`",`"environment`":`"environment-one`",`"credential`":`"ahk_held`"}`n") { $findings += "the takeover from $($case.Name) changed the credential" }
  $ran = (Read-Fake 'docker.log') -join '|'
  if ($ran -cne 'info|container inspect --format {{json .Mounts}} house-kit|stop house-kit|cp house-kit:/kit-home -|rm house-kit') { $findings += "the takeover from $($case.Name) ran docker as: $ran" }
}

Reset-Fake
Set-Mounts 'C:\Users\u\AgentsHouse'
[IO.File]::WriteAllText((Join-Path $fake 'cp-fails'), '')
$refused = Refusal { Move-ContainerKit $distribution }
if ($refused -cne 'kit_bootstrap_refused: the Kit in the container house-kit could not be copied into Ubuntu, where it runs on as before') { $findings += "a failed copy ended with: $refused" }
$ran = (Read-Fake 'docker.log') -join '|'
if ($ran -cne 'info|container inspect --format {{json .Mounts}} house-kit|stop house-kit|cp house-kit:/kit-home -|start house-kit') { $findings += "a failed copy ran docker as: $ran" }
if ((Get-Copied) -cne 'nothing') { $findings += "a failed copy left in Ubuntu: $(Get-Copied)" }

foreach ($case in @(
  @{ Name = 'an Ubuntu whose Kit holds a credential'; Prepare = { [void][IO.Directory]::CreateDirectory((Join-Path $ubuntuHome '.agents/house')); [IO.File]::WriteAllText((Join-Path $ubuntuHome '.agents/house/credential.json'), '{}') }; Docker = '' },
  @{ Name = 'a computer with no Kit container'; Prepare = { Remove-Item -LiteralPath (Join-Path $fake 'mounts') }; Docker = 'info|container inspect --format {{json .Mounts}} house-kit' },
  @{ Name = 'Docker Desktop not answering on a computer that never ran Kit in it'; Prepare = { [IO.File]::WriteAllText((Join-Path $fake 'docker-down'), '') }; Docker = 'info' }
)) {
  Reset-Fake
  Set-Mounts 'C:\Users\u\AgentsHouse'
  & $case.Prepare
  $refused = Refusal { Move-ContainerKit $distribution }
  if ($refused -cne 'no refusal') { $findings += "$($case.Name) refused with: $refused" }
  if ((Get-Copied) -cne 'nothing') { $findings += "$($case.Name) copied: $(Get-Copied)" }
  $ran = (Read-Fake 'docker.log') -join '|'
  if ($ran -cne $case.Docker) { $findings += "$($case.Name) ran docker as: $ran" }
}

Reset-Fake
Set-Mounts 'C:\Users\u\AgentsHouse'
[IO.File]::WriteAllText((Join-Path $fake 'docker-down'), '')
[void][IO.Directory]::CreateDirectory((Join-Path $profileFolder 'AgentsHouse'))
$refused = Refusal { Move-ContainerKit $distribution }
if ($refused -cne 'kit_bootstrap_refused: Kit runs in Docker Desktop on this computer, and Docker Desktop does not answer; start Docker Desktop, then run this command again') { $findings += "Docker Desktop not answering where Kit ran in it ended with: $refused" }
Remove-Item -LiteralPath (Join-Path $profileFolder 'AgentsHouse')

foreach ($case in @(
  @{ Name = 'a direct install'; Relay = $null; Given = @{ '--house' = 'https://agents.house'; '--code' = 'ahk_code_one' }; Url = '-fsSL -o * https://agents.house/kit-installer/connect-linux.sh'; Arguments = '--house https://agents.house --code ahk_code_one'; Environment = "unset|irm agents.house/kit.ps1 | iex; kit login --code 'ahk_code_one'" },
  @{ Name = 'a relayed install with no code'; Relay = 'https://kit-relay.example'; Given = @{ '--house' = 'https://agents.house' }; Url = '-fsSL -o * https://kit-relay.example/agents.house/kit-installer/connect-linux.sh'; Arguments = '--house https://agents.house'; Environment = "https://kit-relay.example|irm agents.house/kit.ps1 | iex; kit login --code 'ahk_code_one'" }
)) {
  Reset-Fake
  $env:HOUSE_KIT_RELAY = $case.Relay
  $env:HOUSE_KIT_INSTALL_COMMAND = "irm agents.house/kit.ps1 | iex; kit login --code 'ahk_code_one'"
  $env:WSLENV = 'USERPROFILE/p'
  $refused = Refusal { Connect-Ubuntu $distribution $case.Given }
  if ($refused -cne 'no refusal') { $findings += "$($case.Name) refused with: $refused" }
  $fetched = (Read-Fake 'curl.log') -join '|'
  if ($fetched -notlike $case.Url) { $findings += "$($case.Name) fetched: $fetched" }
  $handed = (Read-Fake 'bootstrap.args') -join '|'
  if ($handed -cne $case.Arguments) { $findings += "$($case.Name) handed the Linux bootstrap: $handed" }
  $carried = (Read-Fake 'bootstrap.env') -join '|'
  if ($carried -cne $case.Environment) { $findings += "$($case.Name) passed the Linux bootstrap: $carried" }
  if ($env:WSLENV -cne 'USERPROFILE/p:HOUSE_KIT_RELAY/u:HOUSE_KIT_INSTALL_COMMAND/u') { $findings += "$($case.Name) left WSLENV as $env:WSLENV" }
  if (@(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Filter 'tmp.*' -File | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains('bootstrap.args') }).Count -ne 0) { $findings += "$($case.Name) left its download behind" }
}
Remove-Item Env:HOUSE_KIT_RELAY -ErrorAction Ignore
Reset-Fake
[IO.File]::WriteAllText((Join-Path $fake 'bootstrap.status'), '7')
$refused = Refusal { Connect-Ubuntu $distribution @{ '--house' = 'https://agents.house' } }
if ($refused -cne 'kit_bootstrap_refused: the install in Ubuntu ended with status 7') { $findings += "a failing Linux bootstrap ended with: $refused" }

function Test-Host { }
function Register-Start([string] $Ubuntu) { $script:Registered += , $Ubuntu }
function Test-Restart { $script:RestartPending }
function Start-Process([string] $FilePath, [string[]] $ArgumentList, [string] $Verb, [switch] $Wait, [switch] $PassThru) {
  $script:Elevated += , "$Verb $FilePath $($ArgumentList -join ' ')"
  [IO.File]::WriteAllText((Join-Path $fake 'installed'), '')
  [pscustomobject]@{ ExitCode = 0 }
}
foreach ($case in @(
  @{ Name = 'a computer without WSL that needs a restart'; NoWsl = $true; Restart = $true; Distributions = ''; Root = $false; Refusal = 'kit_bootstrap_refused: WSL is installed and Windows needs a restart; restart Windows, then run this command again'; Elevated = 'RunAs wsl.exe --install --no-distribution'; Wsl = @('--version'); Users = '' },
  @{ Name = 'a computer without Ubuntu'; NoWsl = $false; Restart = $false; Distributions = "docker-desktop`n"; Root = $true; Refusal = 'no refusal'; Elevated = ''; Wsl = @('--version', '--list --quiet', '--install --distribution Ubuntu --no-launch', '--distribution Ubuntu --cd ~ --exec id -u', '--distribution Ubuntu --user root --cd ~ --exec getent passwd 1000', '--distribution Ubuntu --user root --cd ~ --exec useradd --create-home --shell /bin/bash --groups sudo anton', '--manage Ubuntu --set-default-user anton', '--distribution Ubuntu --cd ~ --exec test -e .agents/house/credential.json'); Users = 'Ubuntu' },
  @{ Name = 'a computer whose Ubuntu has its own default user'; NoWsl = $false; Restart = $false; Distributions = "Ubuntu-24.04`ndocker-desktop`n"; Root = $false; Refusal = 'no refusal'; Elevated = ''; Wsl = @('--version', '--list --quiet', '--distribution Ubuntu-24.04 --cd ~ --exec id -u', '--distribution Ubuntu-24.04 --cd ~ --exec test -e .agents/house/credential.json'); Users = 'Ubuntu-24.04' }
)) {
  Reset-Fake
  if ($case.NoWsl) { [IO.File]::WriteAllText((Join-Path $fake 'no-wsl'), '') }
  if ($case.Distributions) { [IO.File]::WriteAllText((Join-Path $fake 'distributions'), $case.Distributions) }
  if ($case.Root) { [IO.File]::WriteAllText((Join-Path $fake 'root-default'), '') }
  $script:RestartPending = $case.Restart
  $script:Elevated = @()
  $script:Registered = @()
  $env:USERNAME = 'Anton'
  $BootstrapArguments = @('--house', 'https://agents.house', '--code', 'ahk_code_one')
  $refused = Refusal { Connect-Kit }
  if ($refused -cne $case.Refusal) { $findings += "$($case.Name) ended with: $refused" }
  if (($script:Elevated -join '|') -cne $case.Elevated) { $findings += "$($case.Name) ran elevated: $($script:Elevated -join '|')" }
  $ran = @(Read-Fake 'wsl.log' | Where-Object { -not $_.Contains('bash -c') })
  if (($ran -join '|') -cne ($case.Wsl -join '|').Replace(' --cd ~ ', " --cd $HOME ")) { $findings += "$($case.Name) ran wsl.exe as: $($ran -join '|')" }
  if (($script:Registered -join '|') -cne $case.Users) { $findings += "$($case.Name) registered a start of: $($script:Registered -join '|')" }
  $handed = (Read-Fake 'bootstrap.args') -join '|'
  $expected = ''
  if ($case.Refusal -ceq 'no refusal') { $expected = '--house https://agents.house --code ahk_code_one' }
  if ($handed -cne $expected) { $findings += "$($case.Name) handed the Linux bootstrap: $handed" }
}

$whole = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
[void][IO.Directory]::CreateDirectory($whole)
$entry = Join-Path $whole 'connect-windows.ps1'
[IO.File]::Copy($script, $entry)
foreach ($case in @(
  @('--house https://agents.house --bogus', 'kit_bootstrap_refused: unknown argument --bogus'),
  @('--house https://agents.house --code', 'kit_bootstrap_refused: --code requires one value')
)) {
  $output = @(& pwsh -NoProfile -NonInteractive -Command "& { & ([scriptblock]::Create([IO.File]::ReadAllText('$entry'))) @args } $($case[0])" 2>&1 | ForEach-Object { "$_" })
  $status = $LASTEXITCODE
  if ($status -eq 0 -or -not ($output -join "`n").Contains($case[1])) { $findings += "powershell -Command running the installer with $($case[0]) ended with status $status and: $($output -join '|')" }
}
$findings | ForEach-Object { [Console]::Out.WriteLine($_) }
if ($findings.Count -gt 0) { exit 1 }
