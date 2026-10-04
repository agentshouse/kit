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
$findings | ForEach-Object { [Console]::Out.WriteLine($_) }
if ($findings.Count -gt 0) { exit 1 }
