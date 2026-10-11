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

$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Update-Clis' }, $true)
. ([scriptblock]::Create($definition.Extent.Text))
function docker {
  $script:Ran += , ($args -join ' ')
  $global:LASTEXITCODE = 0
  if ($args -contains 'node') {
    "codex`t/kit-home/.local/bin/codex`t0.150.0`t0.159.1`told"
    "claude`t/kit-home/.local/bin/claude`t2.1.200`t2.1.286`told"
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
$Common = @('--hostname', 'pc', '--mount', 'home', '--mount', 'workspace', 'image')
function Test-Updates([bool] $Flag, [bool] $Terminal, [string[]] $Given, [int] $Asked, [string[]] $Expected) {
  $script:UpdateClis = $Flag
  $script:Interactive = $Terminal
  $script:Answers = $Given
  $script:Prompts = @()
  $script:Ran = @()
  Update-Clis
  $updates = @($script:Ran | Where-Object { $_.EndsWith(' update') })
  if ($script:Ran[0] -ne "run --rm --network host --entrypoint node --hostname pc --mount home --mount workspace image $ClisMain") { "Update-Clis read the CLIs with: $($script:Ran[0])" }
  if ($script:Prompts.Count -ne $Asked) { "Update-Clis asked $($script:Prompts.Count) times, not $Asked" }
  if (($updates -join '|') -ne ($Expected -join '|')) { "Update-Clis ran: $($updates -join '|')" }
}
$UpdateClis = $false
$Interactive = $false
$findings += @(Test-Updates $false $true @('', 'n') 2 @('run -i -t --rm --network host --entrypoint /kit-home/.local/bin/codex --hostname pc --mount home --mount workspace image update'))
$findings += @(Test-Updates $true $false @() 0 @(
  'run -i --rm --network host --entrypoint /kit-home/.local/bin/codex --hostname pc --mount home --mount workspace image update',
  'run -i --rm --network host --entrypoint /kit-home/.local/bin/claude --hostname pc --mount home --mount workspace image update',
  'run -i --rm --network host --entrypoint /kit-home/.grok/bin/grok --hostname pc --mount home --mount workspace image update'
))
$findings += @(Test-Updates $false $false @('') 0 @())
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
function Exit-Bootstrap([int] $Status) { throw "kit_bootstrap_exit: $Status" }
$Link = 'Open this link and confirm: '
$Network = @()
$Common = @('--hostname', 'pc', '--mount', 'home', '--mount', 'workspace', 'image')
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
  if (($script:Ran -join '|') -cne 'run --rm --hostname pc --mount home --mount workspace image login --house https://agents.house') { $findings += "Invoke-Login ran: $($script:Ran -join '|')" }
  if (($script:Opened -join '|') -cne 'https://agents.house/kit/ahk_login_one') { $findings += "Invoke-Login opened: $($script:Opened -join '|')" }
}
foreach ($name in @('ConvertTo-NativeArgument', 'Invoke-Native', 'Invoke-Docker', 'Read-Source', 'Connect-Kit')) {
  $found = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  . ([scriptblock]::Create($found.Extent.Text))
}
$Image = 'ghcr.io/agentshouse/kit@sha256:' + ('a' * 64)
$Name = 'house-kit'
$KitHome = 'house-kit-home'
$KitHomeMount = 'home'
$MinimumBuild = 22631
$env:OS = 'Windows_NT'
$env:USERPROFILE = '/tmp'
function Get-CimInstance([string] $ClassName) {
  if ($ClassName -eq 'Win32_OperatingSystem') { return [pscustomobject]@{ ProductType = 1; BuildNumber = '26100'; Caption = 'Windows 11 Pro' } }
  [pscustomobject]@{ Architecture = 9 }
}
function Initialize-DockerDesktop { [pscustomobject]@{ Platform = 'linux/x86_64'; System = 'Docker Desktop'; Kernel = '6.6.87.2-microsoft-standard-WSL2' } }
function Protect-Directory([string] $Path) { $Path }
function Read-Enrolment { $script:Enrolment }
function Test-Container { $script:Installed }
function Test-Path { $true }
function Set-Configuration { $false }
function Update-Clis { }
function Start-Resident { }
function Write-Host { }
function Read-Inspect([string] $Format) {
  if ($Format -ceq '{{.Config.Image}}') { return $Image }
  if ($Format -ceq '{{.State.Running}}') { return 'true' }
  if ($Format.Contains('.Source')) { return 'C:\Users\u\AgentsHouse' }
  if ($Format.Contains('.Name')) { return $KitHome }
  if ($Format.Contains('/kit-home') -and $Format.Contains('.Type')) { return 'volume/true' }
  if ($Format.Contains('.Type')) { return 'bind/true' }
  if ($Format.Contains('agentshouse.house')) { return 'https://agents.house' }
  if ($Format -ceq '{{len .Mounts}}') { return '2' }
  "$Image on-failure"
}
function docker {
  $script:Ran += , ($args -join ' ')
  $global:LASTEXITCODE = 0
  if ($args -contains 'login') {
    $script:Enrolment = @{ environment = 'environment-one'; house = 'https://agents.house' }
    $printed
  }
}
foreach ($case in @(
  @($false, @('--rooms', 'r_k2v.4,r_9qd.x'), 'login --rooms r_k2v.4,r_9qd.x'),
  @($false, @('--no-private', '--house', 'https://agents.house'), 'login --no-private --house https://agents.house'),
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
$findings | ForEach-Object { [Console]::Out.WriteLine($_) }
if ($findings.Count -gt 0) { exit 1 }
