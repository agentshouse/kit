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
function Test-Updates([bool] $Flag, [bool] $Terminal, [string[]] $Given, [int] $Asked, [string[]] $Expected, [bool] $Changed) {
  $script:UpdateClis = $Flag
  $script:Interactive = $Terminal
  $script:Answers = $Given
  $script:Prompts = @()
  $script:Ran = @()
  $updated = Update-Clis
  $updates = @($script:Ran | Where-Object { $_.EndsWith(' update') })
  if ($script:Ran[0] -ne "run --rm --network host --entrypoint node --hostname pc --mount home --mount workspace image $ClisMain") { "Update-Clis read the CLIs with: $($script:Ran[0])" }
  if ($script:Prompts.Count -ne $Asked) { "Update-Clis asked $($script:Prompts.Count) times, not $Asked" }
  if (($updates -join '|') -ne ($Expected -join '|')) { "Update-Clis ran: $($updates -join '|')" }
  if ($updated -ne $Changed) { "Update-Clis answered $updated" }
}
$UpdateClis = $false
$Interactive = $false
$findings += @(Test-Updates $false $true @('', 'n') 2 @('run -i -t --rm --network host --entrypoint /kit-home/.local/bin/codex --hostname pc --mount home --mount workspace image update') $true)
$findings += @(Test-Updates $true $false @() 0 @(
  'run -i --rm --network host --entrypoint /kit-home/.local/bin/codex --hostname pc --mount home --mount workspace image update',
  'run -i --rm --network host --entrypoint /kit-home/.local/bin/claude --hostname pc --mount home --mount workspace image update',
  'run -i --rm --network host --entrypoint /kit-home/.grok/bin/grok --hostname pc --mount home --mount workspace image update'
) $true)
$findings += @(Test-Updates $false $false @('') 0 @() $false)
$findings | ForEach-Object { [Console]::Out.WriteLine($_) }
if ($findings.Count -gt 0) { exit 1 }
