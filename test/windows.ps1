$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('/kit/bin/connect-windows.ps1', [ref]$tokens, [ref]$errors)
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
$findings += @($ast.FindAll({ param($node)
  ($node -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $node -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) -and
  $node.Value.Contains([char]34) -and ($node.Value.Contains('{{') -or $node.Value.Contains('require('))
}, $true) | ForEach-Object { "double quote in a native argument $($_.Extent.StartLineNumber)" })

foreach ($name in @('Update-Clis', 'Invoke-Docker')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  . ([scriptblock]::Create($definition.Extent.Text))
}
$script:ListStatus = 0
$script:FailingCli = ''
function docker {
  $script:Ran += , ($args -join ' ')
  $global:LASTEXITCODE = 0
  if ($args[-1] -ceq 'update' -and $args -contains $script:FailingCli) { $global:LASTEXITCODE = 1 }
  if ($args -contains 'node') {
    $global:LASTEXITCODE = $script:ListStatus
    "codex`t/kit-home/.local/bin/codex`t0.150.0`t0.160.1`told"
    "claude`t/kit-home/.local/bin/claude`t2.1.200`t2.1.303`told"
    "grok`t/kit-home/.grok/bin/grok`t1.0.50`t1.0.46`tcurrent"
  }
}
function Read-Host([string] $Prompt) {
  $script:Prompts += , $Prompt
  $answer = $script:Answers[$script:Prompts.Count - 1]
  $answer
}
$ClisMain = '/usr/local/lib/node_modules/@agentshouse/kit/dist/clis-main.js'
$Network = @('--network', 'host')
$Common = @('--mount', 'home', '--mount', 'workspace', 'image')
$KitHomeMount = 'home'
$Image = 'image'
function Test-Updates([bool] $Flag, [bool] $Terminal, [string[]] $Given, [int] $Asked, [string[]] $Expected, [string[]] $Failures = @()) {
  $script:UpdateClis = $Flag
  $script:Interactive = $Terminal
  $script:Answers = $Given
  $script:Prompts = @()
  $script:Ran = @()
  $failed = @(Update-Clis)
  $updates = @($script:Ran | Where-Object { $_.EndsWith(' update') })
  $restarts = @($script:Ran | Where-Object { $_ -ceq 'run --rm --network none --mount home --entrypoint touch image /kit-home/restart' })
  $succeeded = @($Expected | Where-Object { -not $script:FailingCli -or -not $_.Contains("--entrypoint $script:FailingCli ") })
  if ($restarts.Count -ne $succeeded.Count) { "Update-Clis asked the Kit to restart $($restarts.Count) times after $($succeeded.Count) updates that succeeded" }
  if (($failed -join '|') -cne ($Failures -join '|')) { "Update-Clis reported the failures: $($failed -join '|')" }
  if ($script:Ran[0] -ne "run --rm --network host --entrypoint node --mount home --mount workspace image $ClisMain") { "Update-Clis read the CLIs with: $($script:Ran[0])" }
  if ($script:Prompts.Count -ne $Asked) { "Update-Clis asked $($script:Prompts.Count) times, not $Asked" }
  if (($updates -join '|') -ne ($Expected -join '|')) { "Update-Clis ran: $($updates -join '|')" }
}
$UpdateClis = $false
$Interactive = $false
$findings += @(Test-Updates $false $true @('', 'n') 2 @('run -i -t --rm --network host --entrypoint /kit-home/.local/bin/codex --mount home --mount workspace image update'))
$findings += @(Test-Updates $true $false @() 0 @(
  'run -i --rm --network host --entrypoint /kit-home/.local/bin/codex --mount home --mount workspace image update',
  'run -i --rm --network host --entrypoint /kit-home/.local/bin/claude --mount home --mount workspace image update',
  'run -i --rm --network host --entrypoint /kit-home/.grok/bin/grok --mount home --mount workspace image update'
))
$findings += @(Test-Updates $false $false @('') 0 @())
$script:FailingCli = '/kit-home/.local/bin/claude'
$findings += @(Test-Updates $true $false @() 0 @(
  'run -i --rm --network host --entrypoint /kit-home/.local/bin/codex --mount home --mount workspace image update',
  'run -i --rm --network host --entrypoint /kit-home/.local/bin/claude --mount home --mount workspace image update',
  'run -i --rm --network host --entrypoint /kit-home/.grok/bin/grok --mount home --mount workspace image update'
) @('claude could not be updated; it stays at 2.1.200'))
$script:FailingCli = ''
$script:ListStatus = 7
$findings += @(Test-Updates $true $false @() 0 @() @('Kit could not read the agent CLIs, so it updated none; docker run ended with status 7'))
$script:ListStatus = 0
$configuration = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Set-Configuration' }, $true)
. ([scriptblock]::Create($configuration.Extent.Text))
$ConfigureMain = 'configure-main.js'
$NoSkills = @()
foreach ($case in @(
  @('installed', 'echo windows > /kit-home/placement; printenv HOUSE_KIT_INSTALL_COMMAND > /kit-home/install-command'),
  @('', 'echo windows > /kit-home/placement')
)) {
  $env:HOUSE_KIT_INSTALL_COMMAND = $case[0]
  $script:Ran = @()
  [void](Set-Configuration)
  if ($script:Ran[0] -cne "run --rm --network none --env HOUSE_KIT_INSTALL_COMMAND --mount home --entrypoint sh image -c $($case[1])") { $findings += "Set-Configuration recorded Kit home with: $($script:Ran[0])" }
}
Remove-Item Env:HOUSE_KIT_INSTALL_COMMAND -ErrorAction Ignore
$workdir = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-HouseWorkdir' }, $true)
. ([scriptblock]::Create($workdir.Extent.Text))
foreach ($case in @(
  @('C:\Users\u\AgentsHouse', '/agents/house'),
  @('C:\Users\u\AgentsHouse\notes\2026', '/agents/house/notes/2026'),
  @('c:\users\u\agentshouse\notes', '/agents/house/notes'),
  @('C:\Users\u\Desktop', '/agents/house'),
  @('C:\Users\u\AgentsHouse2', '/agents/house')
)) {
  $mapped = Get-HouseWorkdir $case[0] 'C:\Users\u\AgentsHouse'
  if ($mapped -cne $case[1]) { $findings += "Get-HouseWorkdir mapped $($case[0]) to $mapped, not $($case[1])" }
}
$authority = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-Authority' }, $true)
. ([scriptblock]::Create($authority.Extent.Text))
function Stop-Bootstrap([string] $Cause) { throw "kit_bootstrap_refused: $Cause" }
function docker { $global:LASTEXITCODE = 1 }
$AuthorityMain = 'authority-main.js'
$enrolment = @{ environment = 'environment-one' }
$Interactive = $true
$script:Answers = @('y')
$script:Prompts = @()
try {
  Test-Authority
  $findings += 'Test-Authority kept a Kit House refuses'
} catch {
  if ($_.Exception.Message -cne 'kit_bootstrap_refused: House refuses the stored Kit credential of Environment environment-one; to reconnect it, run this command again with kit login appended') { $findings += "Test-Authority refused with: $($_.Exception.Message)" }
}
if ($script:Prompts.Count -ne 0) { $findings += "Test-Authority asked: $($script:Prompts[0])" }
$invokeLogin = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Login' }, $true)
. ([scriptblock]::Create($invokeLogin.Extent.Text))
$Link = 'Open this link and confirm: '
$Network = @()
$Common = @('--mount', 'home', '--mount', 'workspace', 'image')
$printed = @('Open this link and confirm: https://agents.house/kit/ahk_login_one', 'Environment environment-one is connected to https://agents.house.')
function docker {
  $script:Ran += , ($args -join ' ')
  $global:LASTEXITCODE = 0
  $printed
}
function Start-Process([string] $FilePath) {
  $script:Opened += , $FilePath
  if ($script:OpenerFails) { throw 'no browser answers' }
}
foreach ($fails in @($false, $true)) {
  $script:OpenerFails = $fails
  $script:Ran = @()
  $script:Opened = @()
  try {
    $shown = @(Invoke-Login @('--house', 'https://agents.house') 6>&1 | ForEach-Object { "$_" })
    if (($shown -join '|') -cne ($printed -join '|')) { $findings += "Invoke-Login showed: $($shown -join '|')" }
  } catch {
    $findings += "Invoke-Login refused with: $($_.Exception.Message)"
  }
  if (($script:Ran -join '|') -cne 'run --rm --mount home --mount workspace image login --house https://agents.house') { $findings += "Invoke-Login ran: $($script:Ran -join '|')" }
  if (($script:Opened -join '|') -cne 'https://agents.house/kit/ahk_login_one') { $findings += "Invoke-Login opened: $($script:Opened -join '|')" }
}
foreach ($name in @('Read-Certificates', 'Write-Certificates')) {
  $found = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  . ([scriptblock]::Create($found.Extent.Text))
}
function Get-ChildItem([string] $LiteralPath) {
  if ($LiteralPath -ceq 'Cert:\LocalMachine\Root') { [pscustomobject]@{ RawData = [byte[]](1..60) } }
  if ($LiteralPath -ceq 'Cert:\CurrentUser\Root') { [pscustomobject]@{ RawData = [byte[]](7, 8, 9) } }
}
$expectedPem = "-----BEGIN CERTIFICATE-----`n$([Convert]::ToBase64String([byte[]](1..60), [Base64FormattingOptions]::InsertLineBreaks).Replace("`r`n", "`n"))`n-----END CERTIFICATE-----`n-----BEGIN CERTIFICATE-----`nBwgJ`n-----END CERTIFICATE-----"
$Certificates = '/kit-home/certificates.pem'
function docker {
  $script:Ran += , ($args -join ' ')
  $script:Piped = @($input) -join '|'
  $global:LASTEXITCODE = 0
}
$script:Ran = @()
Write-Certificates
if (($script:Ran -join '|') -cne 'run -i --rm --network none --mount home --entrypoint sh image -c cat > /kit-home/certificates.pem') { $findings += "Write-Certificates ran: $($script:Ran -join '|')" }
if ($script:Piped -cne $expectedPem) { $findings += "Write-Certificates wrote: $($script:Piped)" }
Remove-Item Function:Get-ChildItem
foreach ($name in @('ConvertTo-NativeArgument', 'Invoke-Native', 'Invoke-Docker', 'Read-Source', 'Start-Resident', 'Get-KitImage', 'Connect-Kit')) {
  $found = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  . ([scriptblock]::Create($found.Extent.Text))
}
$ImageDigest = 'sha256:' + ('a' * 64)
$Image = "agents.house/kit@$ImageDigest"
function Write-Certificates { $script:Ran += , 'certificates' }
$Name = 'house-kit'
$KitHome = 'house-kit-home'
$KitHomeMount = 'home'
$env:OS = 'Windows_NT'
$env:USERPROFILE = '/tmp'
$script:System = [pscustomobject]@{ ProductType = 1; BuildNumber = '26100'; Caption = 'Microsoft Windows 11 Pro' }
$script:Processor = 9
$script:DockerPlatform = 'linux/x86_64'
function Get-CimInstance([string] $ClassName) {
  if ($ClassName -eq 'Win32_OperatingSystem') { return $script:System }
  [pscustomobject]@{ Architecture = $script:Processor }
}
function Initialize-DockerDesktop { [pscustomobject]@{ Platform = $script:DockerPlatform; System = 'Docker Desktop'; Kernel = '6.6.87.2-microsoft-standard-WSL2' } }
function Protect-Directory([string] $Path) { $Path }
$script:SecondEnrolment = @{}
function Read-Enrolment { if ($KitHome -ceq 'house-kit-home') { $script:Enrolment } else { $script:SecondEnrolment } }
function Test-Container { $script:Installed }
function Test-Path { $true }
function Set-Configuration { $false }
$script:CliFailures = @()
function Update-Clis { $script:CliFailures }
$script:Shown = @()
function Write-Host { $script:Shown += , "$args" }
$script:Running = 'true'
function Read-Inspect([string] $Format) {
  if ($Format -ceq '{{.Config.Image}}') { return $Image }
  if ($Format -ceq '{{.State.Running}}') { return $script:Running }
  if ($Format.Contains('RestartPolicy')) { return "$Image on-failure" }
  if ($Format.Contains('.Source')) { return 'C:\Users\u\AgentsHouse' }
  if ($Format.Contains('.Name')) { return $KitHome }
  if ($Format.Contains('/kit-home') -and $Format.Contains('.Type')) { return 'volume/true' }
  if ($Format.Contains('.Type')) { return 'bind/true' }
  if ($Format.Contains('agentshouse.house')) { return 'https://agents.house' }
  if ($Format -ceq '{{len .Mounts}}') { return '2' }
  "$Image on-failure"
}
$script:LoginStatus = 0
$script:ImageAbsent = $false
function docker {
  $script:Ran += , ($args -join ' ')
  $global:LASTEXITCODE = 0
  if ($args[0] -ceq 'image' -and $script:ImageAbsent) { $global:LASTEXITCODE = 1 }
  if ($args[0] -ceq 'rm') { $script:Installed = $false }
  if ($args -contains 'login') {
    $second = ($args -join ' ').Contains('house-kit-home-agents.house')
    $held = $script:Enrolment
    if ($second) { $held = $script:SecondEnrolment }
    if ($args -contains '--code' -and $held.ContainsKey('environment')) {
      $global:LASTEXITCODE = 1
      return
    }
    if ($script:LoginStatus -ne 0) {
      $global:LASTEXITCODE = $script:LoginStatus
      return
    }
    if ($second) { $script:SecondEnrolment = @{ environment = 'environment-two'; house = 'https://agents.house' } } else { $script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' } }
    $printed
  }
}
foreach ($case in @(
  @($false, @('--rooms', 'r_k2v.4,r_9qd.x'), 'login --rooms r_k2v.4,r_9qd.x'),
  @($false, @('--no-private', '--house', 'https://agents.house'), 'login --no-private --house https://agents.house'),
  @($false, @('--code', 'ahk_code_one'), 'login --code ahk_code_one'),
  @($true, @('--workspace', 'C:\Users\u\AgentsHouse', '--no-private'), 'login --no-private'),
  @($true, @('--workspace', 'C:\Users\u\AgentsHouse', '--rooms', 'r_k2v.4'), 'login --rooms r_k2v.4'),
  @($true, @('--workspace', 'C:\Users\u\AgentsHouse', '--code', 'ahk_code_unused', '--no-private'), 'login --no-private'),
  @($true, @('kit', 'login', '--rooms', 'r_k2v.4'), 'login --rooms r_k2v.4'),
  @($true, @('kit', 'login', '--no-private'), 'login --no-private')
)) {
  $script:Installed = $case[0]
  $script:Enrolment = @{}
  if ($case[0]) { $script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' } }
  $BootstrapArguments = $case[1]
  $script:Ran = @()
  try { Connect-Kit } catch { $findings += "Connect-Kit $($case[1] -join ' ') refused with: $($_.Exception.Message)" }
  $logins = @($script:Ran | Where-Object { $_ -match ' login( |$)' })
  if ($logins.Count -ne 1 -or -not $logins[0].EndsWith(" $Image $($case[2])")) { $findings += "the bootstrap $($case[1] -join ' ') ran kit login as: $($logins -join '|')" }
}
$script:Installed = $true
$script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
$BootstrapArguments = @('kit', 'login', '--code', 'ahk_code_unused')
$script:Ran = @()
try {
  Connect-Kit
  $findings += 'a kit login --code forwarded to an enrolled Kit ended without the refusal of kit login'
} catch {
  if ($_.Exception.Message -cne 'kit_bootstrap_refused: kit login ended with status 1') { $findings += "a kit login --code forwarded to an enrolled Kit ended with: $($_.Exception.Message)" }
}
foreach ($rerun in @(
  @('--workspace', 'C:\Users\u\AgentsHouse', '--code', 'ahk_code_unused'),
  @('--workspace', 'C:\Users\u\AgentsHouse')
)) {
  $script:Installed = $true
  $script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
  $BootstrapArguments = $rerun
  $script:Ran = @()
  try { Connect-Kit } catch { $findings += "the enrolled bootstrap $($rerun -join ' ') refused with: $($_.Exception.Message)" }
  $logins = @($script:Ran | Where-Object { $_ -match ' login( |$)' })
  if ($logins.Count -ne 0) { $findings += "the enrolled bootstrap $($rerun -join ' ') ran kit login as: $($logins -join '|')" }
}
$script:Installed = $false
$script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
$BootstrapArguments = @('--no-private')
$script:Ran = @()
try { Connect-Kit } catch { $findings += "an enrolled bootstrap with no container refused --no-private with: $($_.Exception.Message)" }
$logins = @($script:Ran | Where-Object { $_ -match ' login( |$)' })
if ($logins.Count -ne 1 -or -not $logins[0].EndsWith(" $Image login --no-private")) { $findings += "the enrolled bootstrap with no container ran kit login as: $($logins -join '|')" }
$script:LoginStatus = 7
foreach ($case in @(
  @($true, '^start house-kit$'),
  @($false, '^run -d .* resident$')
)) {
  $withContainer = $case[0]
  $script:Installed = $withContainer
  $script:Running = 'false'
  $script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
  $BootstrapArguments = @('--workspace', 'C:\Users\u\AgentsHouse', '--no-private')
  $script:Ran = @()
  try {
    Connect-Kit
    $findings += "the enrolled bootstrap with a container installed $withContainer ended without the status of its failed login"
  } catch {
    if ($_.Exception.Message -cne 'kit_bootstrap_refused: kit login ended with status 7') { $findings += "the enrolled bootstrap with a container installed $withContainer ended with: $($_.Exception.Message)" }
  }
  $started = @(0..($script:Ran.Count - 1) | Where-Object { $script:Ran[$_] -match $case[1] })
  $loggedIn = @(0..($script:Ran.Count - 1) | Where-Object { $script:Ran[$_] -match ' login( |$)' })
  if ($started.Count -ne 1 -or $loggedIn.Count -ne 1 -or $started[0] -gt $loggedIn[0]) {
    $findings += "the enrolled bootstrap with a container installed $withContainer and a failing login ran: $($script:Ran -join '|')"
  }
}
$script:LoginStatus = 0
$script:Running = 'true'

$script:Installed = $false
$script:Enrolment = @{}
$BootstrapArguments = @('--house', 'https://agents.house', '--code', 'ahk_code_one')
$script:Ran = @()
try { Connect-Kit } catch { $findings += "a first bootstrap refused with: $($_.Exception.Message)" }
$residentRun = @($script:Ran | Where-Object { $_ -match '^run .* resident( |$)' })
if ($residentRun.Count -ne 1 -or -not $residentRun[0].StartsWith('run -d --name house-kit --restart on-failure --env NODE_EXTRA_CA_CERTS=/kit-home/certificates.pem --mount home ') -or -not $residentRun[0].EndsWith(" agents.house/kit@$ImageDigest resident")) {
  $findings += "the first bootstrap ran resident as: $($residentRun -join '|')"
}
if (@($script:Ran | Where-Object { $_ -ceq 'certificates' }).Count -ne 1) { $findings += "the first bootstrap wrote the certificate authorities: $($script:Ran -join '|')" }
$script:Installed = $false
$script:Enrolment = @{ environment = 'environment-one'; house = 'https://dev.agents.house' }
$script:SecondEnrolment = @{}
$BootstrapArguments = @('--house', 'https://agents.house', '--code', 'ahk_code_one')
$script:Ran = @()
try { Connect-Kit } catch { $findings += "a second Building's bootstrap refused with: $($_.Exception.Message)" }
$residentRun = @($script:Ran | Where-Object { $_ -match '^run .* resident( |$)' })
if ($residentRun.Count -ne 1 -or -not $residentRun[0].StartsWith('run -d --name house-kit-agents.house --restart on-failure --env NODE_EXTRA_CA_CERTS=/kit-home/certificates.pem --mount type=volume,src=house-kit-home-agents.house,dst=/kit-home --mount type=bind,src=/tmp/AgentsHouse-agents.house,dst=/agents/house ')) {
  $findings += "the second Building's bootstrap ran resident as: $($residentRun -join '|')"
}
if (@($script:Ran | Where-Object { $_ -match '^(rm|volume rm) ' }).Count -ne 0 -or $script:Enrolment['house'] -cne 'https://dev.agents.house' -or $script:SecondEnrolment['environment'] -cne 'environment-two') {
  $findings += "the second Building's bootstrap touched the first Building's Kit: $($script:Ran -join '|')"
}

$env:HOUSE_KIT_RELAY = 'https://kit-relay.example'
$script:Installed = $false
$script:Enrolment = @{}
$BootstrapArguments = @('--code', 'ahk_code_one')
$script:Ran = @()
try { Connect-Kit } catch { $findings += "a relayed bootstrap refused with: $($_.Exception.Message)" }
if (@($script:Ran | Where-Object { $_.EndsWith(" kit-relay.example/agents.house/kit@$ImageDigest resident") }).Count -ne 1) { $findings += "the relayed bootstrap took its image from: $($script:Ran -join '|')" }
$loginRun = @($script:Ran | Where-Object { $_ -match '^run .* login( |$)' })
$residentRun = @($script:Ran | Where-Object { $_ -match '^run .* resident( |$)' })
if ($loginRun.Count -ne 1 -or -not $loginRun[0].Contains('--env HOUSE_KIT_RELAY=https://kit-relay.example')) {
  $findings += "the relayed bootstrap ran login as: $($loginRun -join '|')"
}
if ($residentRun.Count -ne 1 -or $residentRun[0].Contains('HOUSE_KIT_RELAY')) {
  $findings += "the relayed bootstrap ran resident as: $($residentRun -join '|')"
}
Remove-Item Env:HOUSE_KIT_RELAY
$script:Installed = $true
$script:Enrolment = @{}
$BootstrapArguments = @('--workspace', 'C:\Users\u\AgentsHouse')
$script:Ran = @()
try { Connect-Kit } catch { $findings += "a bootstrap whose Kit forgot its credential refused with: $($_.Exception.Message)" }
if (@($script:Ran | Where-Object { $_ -ceq "rm -f $Name" }).Count -ne 1 -or @($script:Ran | Where-Object { $_.StartsWith('volume rm') }).Count -ne 0 -or @($script:Ran | Where-Object { $_ -match ' login( |$)' }).Count -ne 1) {
  $findings += "the bootstrap whose Kit forgot its credential ran: $($script:Ran -join '|')"
}
foreach ($case in @(
  @(@('kit', 'logout', '--help'), 0),
  @(@('kit', 'logout'), 1)
)) {
  $script:Installed = $true
  $script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
  $BootstrapArguments = $case[0]
  $script:Ran = @()
  try { Connect-Kit } catch { $findings += "the bootstrap forwarding $($case[0] -join ' ') ended with: $($_.Exception.Message)" }
  $stops = @($script:Ran | Where-Object { $_ -ceq "stop $Name" })
  if ($stops.Count -ne $case[1]) { $findings += "the bootstrap forwarding $($case[0] -join ' ') stopped the container $($stops.Count) times" }
}
$script:Running = 'false'
$script:Installed = $true
$script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
$BootstrapArguments = @('kit', 'login', '--help')
$script:Ran = @()
try { Connect-Kit } catch { $findings += "the bootstrap forwarding kit login --help ended with: $($_.Exception.Message)" }
if (@($script:Ran | Where-Object { $_ -match ' login( |$)' -or $_ -match '^(start|stop) ' }).Count -ne 1 -or -not $script:Ran[-1].EndsWith(' login --help')) {
  $findings += "the bootstrap forwarding kit login --help into a stopped container ran: $($script:Ran -join '|')"
}
$script:Running = 'true'
$script:CliFailures = @('grok could not be updated; it stays at 1.0.50')
foreach ($case in @(
  @($true, '^restart house-kit$|^start house-kit$|^rm '),
  @($false, '^run -d .* resident$')
)) {
  $script:Installed = $case[0]
  $script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
  $BootstrapArguments = @('--workspace', 'C:\Users\u\AgentsHouse')
  $script:Ran = @()
  try {
    Connect-Kit
    $findings += "the bootstrap with a container installed $($case[0]) whose CLI update failed ended without a refusal"
  } catch {
    if ($_.Exception.Message -cne 'kit_bootstrap_refused: grok could not be updated; it stays at 1.0.50') { $findings += "the bootstrap with a container installed $($case[0]) whose CLI update failed ended with: $($_.Exception.Message)" }
  }
  if (-not $case[0] -and @($script:Ran | Where-Object { $_ -match $case[1] }).Count -ne 1) { $findings += "the bootstrap whose CLI update failed started no Kit: $($script:Ran -join '|')" }
}
$script:CliFailures = @()
foreach ($case in @(
  @{ Name = 'Windows 10'; Type = 1; Build = '19045'; Caption = 'Microsoft Windows 10 Pro'; Processor = 9; Platform = 'linux/x86_64'; Warnings = @('Warning: Microsoft Windows 10 Pro is outdated; update to Windows 11.'); Image = 'amd64' },
  @{ Name = 'a Windows Server edition'; Type = 3; Build = '20348'; Caption = 'Microsoft Windows Server 2022 Datacenter'; Processor = 9; Platform = 'linux/x86_64'; Warnings = @('Warning: Microsoft Windows Server 2022 Datacenter is outdated; update to Windows 11.'); Image = 'amd64' },
  @{ Name = 'Windows on ARM64'; Type = 1; Build = '26100'; Caption = 'Microsoft Windows 11 Pro'; Processor = 12; Platform = 'linux/aarch64'; Warnings = @('Warning: Microsoft Windows 11 Pro on arm64 is outdated; update to Windows 11 on amd64.'); Image = 'arm64' },
  @{ Name = 'Windows 11 on amd64'; Type = 1; Build = '22621'; Caption = 'Microsoft Windows 11 Pro'; Processor = 9; Platform = 'linux/x86_64'; Warnings = @(); Image = 'amd64' }
)) {
  $script:System = [pscustomobject]@{ ProductType = $case.Type; BuildNumber = $case.Build; Caption = $case.Caption }
  $script:Processor = $case.Processor
  $script:DockerPlatform = $case.Platform
  $script:Installed = $false
  $script:Enrolment = @{}
  $script:ImageAbsent = $true
  $BootstrapArguments = @('--code', 'ahk_code_one')
  $script:Ran = @()
  $script:Shown = @()
  try { Connect-Kit } catch { $findings += "the bootstrap on $($case.Name) refused with: $($_.Exception.Message)" }
  $warnings = @($script:Shown | Where-Object { $_.StartsWith('Warning: ') })
  if (($warnings -join '|') -cne ($case.Warnings -join '|')) { $findings += "the bootstrap on $($case.Name) warned: $($warnings -join '|')" }
  $pulls = @($script:Ran | Where-Object { $_.StartsWith('pull ') })
  if (($pulls -join '|') -cne "pull --quiet --platform linux/$($case.Image) $Image") { $findings += "the bootstrap on $($case.Name) pulled: $($pulls -join '|')" }
  if (@($script:Ran | Where-Object { $_ -match '^run -d .* resident$' }).Count -ne 1) { $findings += "the bootstrap on $($case.Name) installed no Kit container: $($script:Ran -join '|')" }
  $script:Installed = $true
  $script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
  $BootstrapArguments = @('kit', 'logout', '--help')
  $script:Shown = @()
  try { Connect-Kit } catch { $findings += "the bootstrap on $($case.Name) forwarding kit logout --help ended with: $($_.Exception.Message)" }
  $warnings = @($script:Shown | Where-Object { $_.StartsWith('Warning: ') })
  if ($warnings.Count -ne 0) { $findings += "the bootstrap on $($case.Name) warned before a forwarded command: $($warnings -join '|')" }
}
$script:ImageAbsent = $false
$script:Processor = 0
$BootstrapArguments = @('--code', 'ahk_code_one')
$script:Ran = @()
try {
  Connect-Kit
  $findings += 'the bootstrap on Windows on x86 ended without a refusal'
} catch {
  if ($_.Exception.Message -cne 'kit_bootstrap_refused: unsupported Windows architecture x86') { $findings += "the bootstrap on Windows on x86 ended with: $($_.Exception.Message)" }
}
if (@($script:Ran | Where-Object { $_ -match '^(volume|pull|run) ' }).Count -ne 0) { $findings += "the bootstrap on Windows on x86 ran: $($script:Ran -join '|')" }
$script:Processor = 9
$script:System = [pscustomobject]@{ ProductType = 1; BuildNumber = '26100'; Caption = 'Microsoft Windows 11 Pro' }
$script:DockerPlatform = 'linux/x86_64'
$installDesktop = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-DockerDesktop' }, $true)
. ([scriptblock]::Create($installDesktop.Extent.Text))
function Invoke-WebRequest([switch] $UseBasicParsing, [string] $Uri, [string] $OutFile) {
  $script:Downloaded += , $Uri
  throw 'offline'
}
foreach ($Architecture in @('amd64', 'arm64')) {
  $script:Downloaded = @()
  try { Install-DockerDesktop } catch { }
  if (($script:Downloaded -join '|') -cne "https://desktop.docker.com/win/main/$Architecture/Docker%20Desktop%20Installer.exe") { $findings += "Install-DockerDesktop on $Architecture downloaded: $($script:Downloaded -join '|')" }
}
Remove-Item Function:Invoke-WebRequest
$whole = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
[void][IO.Directory]::CreateDirectory($whole)
$installer = Join-Path $whole 'connect-windows.ps1'
[IO.File]::WriteAllText($installer, [IO.File]::ReadAllText('/kit/bin/connect-windows.ps1').Replace('__IMAGE_DIGEST__', 'a' * 64))
[IO.File]::WriteAllText((Join-Path $whole 'docker'), "#!/bin/sh`nif [ `"`$1`" = info ]; then echo 'linux/x86_64|Docker Desktop|6.6.87.2-microsoft-standard-WSL2'; exit 0; fi`necho 'docker: no space left on device' >&2`nexit 3`n")
& chmod 755 (Join-Path $whole 'docker')
$prelude = "`$env:OS = 'Windows_NT'; `$env:ProgramFiles = '$whole'; `$env:LOCALAPPDATA = '$whole'; `$env:PATH = '$whole' + ':' + `$env:PATH; function Get-CimInstance([string] `$ClassName) { if (`$ClassName -eq 'Win32_OperatingSystem') { return [pscustomobject]@{ ProductType = 1; BuildNumber = '26100'; Caption = 'Windows 11 Pro' } }; [pscustomobject]@{ Architecture = 9 } };"
foreach ($case in @(
  @('--house https://agents.house --bogus', 'kit_bootstrap_refused: unknown argument --bogus'),
  @('--house https://agents.house', 'kit_bootstrap_refused: docker volume ended with status 3')
)) {
  $output = @(& pwsh -NoProfile -NonInteractive -Command "$prelude & { & ([scriptblock]::Create([IO.File]::ReadAllText('$installer'))) @args } $($case[0])" 2>&1 | ForEach-Object { "$_" })
  $status = $LASTEXITCODE
  if ($status -eq 0 -or -not ($output -join "`n").Contains($case[1])) { $findings += "powershell -Command running the installer with $($case[0]) ended with status $status and: $($output -join '|')" }
}
$findings | ForEach-Object { [Console]::Out.WriteLine($_) }
if ($findings.Count -gt 0) { exit 1 }
