#requires -Version 5.1
<# Actual elevated Windows regression. No service, identity, token or machine
   installation. Creates only a fresh caller-selected evidence directory and
   disposable ACL fixtures beneath it; never changes an ancestor ACL. #>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'native_acl_test_actual_administrator_required'}
$repo=Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $repo 'installer\bridge\lib\RevAgent.BridgeInstall.psm1') -Force
$root=[IO.Path]::GetFullPath($EvidenceRoot)
[void](Assert-RevAgentBridgeNoReparsePoint -Path $root -GuardRoot (Split-Path $root -Parent))
if(Test-Path -LiteralPath $root){throw 'native_acl_test_requires_fresh_root'}
$security=[Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$security.SetAccessRuleProtection($true,$false)
foreach($sid in @('S-1-5-18','S-1-5-32-544')){$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
if($PSVersionTable.PSEdition -eq 'Desktop'){[void][IO.Directory]::CreateDirectory($root,$security)}else{[IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($root),$security)}
$checks=[Collections.Generic.List[string]]::new();$stage='start';$passed=$false
function Check([bool]$Value,[string]$Name){if(-not $Value){throw "native_acl_test_failed:$Name"};$checks.Add($Name)}
function ExactAcl([string]$Path,[switch]$Directory){
    $a=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $Path;$rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    $inheritance=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
    Check ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-18') 'SYSTEM owner'
    Check ($a.AreAccessRulesProtected -and $rules.Count -eq 2) 'protected two ACEs'
    foreach($sid in @('S-1-5-18','S-1-5-32-544')){$r=@($rules|Where-Object{$_.IdentityReference.Value -ceq $sid});Check ($r.Count -eq 1 -and -not $r[0].IsInherited -and $r[0].AccessControlType -eq 'Allow' -and $r[0].FileSystemRights -eq 'FullControl' -and $r[0].InheritanceFlags -eq $inheritance -and $r[0].PropagationFlags -eq 'None') "exact $sid allow"}
}
try{
    $stage='fresh_inherited_directory';$credentials=Join-Path $root 'credentials';[void][IO.Directory]::CreateDirectory($credentials)
    $initial=Get-Acl -LiteralPath $credentials
    Check (@($initial.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])).Count -eq 0) 'fresh directory inherited-only'
    Set-RevAgentBridgeSystemOnlyAcl -Path $credentials;ExactAcl $credentials -Directory
    $directorySddl=(Get-Acl -LiteralPath $credentials).Sddl
    $stage='directory_idempotency';Set-RevAgentBridgeSystemOnlyAcl -Path $credentials
    Check ((Get-Acl -LiteralPath $credentials).Sddl -ceq $directorySddl) 'directory idempotent'
    $stage='genuine_csharp_directory_producer'
    $previousFixture=$env:REVAGENT_CREDENTIAL_DIRECTORY_FIXTURE_ROOT
    try{
        $env:REVAGENT_CREDENTIAL_DIRECTORY_FIXTURE_ROOT=$root
        & dotnet test (Join-Path $repo 'packages\bridge\tests\RevAgent.Bridge.Tests\RevAgent.Bridge.Tests.csproj') -c Release --no-build --no-restore --filter 'FullyQualifiedName~CredentialDirectoryPolicyTests.RealProducerCreatesCanonicalDirectory' --logger 'trx;LogFileName=credential-directory.trx' --results-directory $root *> (Join-Path $root 'csharp-directory-producer.log')
        $producerExit=$LASTEXITCODE
    }finally{$env:REVAGENT_CREDENTIAL_DIRECTORY_FIXTURE_ROOT=$previousFixture}
    Check ($producerExit -eq 0) 'real C# directory producer test passed'
    $producer=Get-Content -LiteralPath (Join-Path $root 'credential-directory-policy.json') -Raw|ConvertFrom-Json
    Check ($producer.producer -ceq 'WindowsBridgeCredentialAccessControl' -and $producer.protectedDirectoryVerified -and -not $producer.identityCreated) 'actual production ACL path without identity or mock'
    Check ($producer.directoryPath -ceq (Join-Path $root 'csharp-credentials')) 'producer directory remains in exact fixture root'
    [IO.Directory]::Delete($credentials,$false)
    $credentials=$producer.directoryPath;ExactAcl $credentials -Directory
    $directorySddl=(Get-Acl -LiteralPath $credentials).Sddl
    Check ($directorySddl -ceq $producer.directorySddl) 'genuine C# directory descriptor readback'
    $stage='file_in_credential_parent';$file=Join-Path $credentials 'public-fixture.txt'
    [IO.File]::WriteAllText($file,'public ACL regression fixture')
    $fileBefore=Get-Acl -LiteralPath $file
    @{sddl=$fileBefore.Sddl;explicitRules=@($fileBefore.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=[string]$_.FileSystemRights}})}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $root 'file-baseline.json') -Encoding UTF8
    $foreignDefault=@($fileBefore.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')})
    if($foreignDefault.Count){$refused=$false;try{Set-RevAgentBridgeSystemOnlyAcl -Path $file}catch{$refused=$_.Exception.Message -ceq 'bridge_credential_acl_unexpected_ace'};Check $refused 'default logon ACE remains refused';Check ((Get-Acl -LiteralPath $file).Sddl -ceq $fileBefore.Sddl) 'default DACL refusal unchanged'}
    [IO.File]::Delete($file)
    $creation=@(Write-RevAgentBridgeCredentialArtifact -Path $file -Bytes ([Text.Encoding]::UTF8.GetBytes('public ACL regression fixture')) -GuardRoot $credentials -Verbose 4>&1)
    Check (@($creation|Where-Object{$_ -is [Management.Automation.VerboseRecord] -and $_.Message -ceq 'bridge_credential_private_empty_file_verified'}).Count -eq 1) 'actual producer verified empty private file before writing bytes'
    ExactAcl $file
    Check ([IO.File]::ReadAllText($file) -ceq 'public ACL regression fixture') 'file remains accessible'
    Check ((Get-Acl -LiteralPath $credentials).Sddl -ceq $directorySddl) 'artifact writer leaves genuine directory policy unchanged'
    $fileSddl=(Get-Acl -LiteralPath $file).Sddl;Set-RevAgentBridgeSystemOnlyAcl -Path $file
    Check ((Get-Acl -LiteralPath $file).Sddl -ceq $fileSddl) 'file idempotent'
    $existsRefused=$false;try{Write-RevAgentBridgeCredentialArtifact -Path $file -Bytes ([byte[]]@(1,2,3)) -GuardRoot $credentials}catch{$existsRefused=$_.Exception.Message -ceq 'bridge_credential_artifact_already_exists'}
    Check $existsRefused 'existing artifact create-only refusal';Check ([IO.File]::ReadAllText($file) -ceq 'public ACL regression fixture') 'existing artifact bytes preserved'
    $failedPath=Join-Path $credentials 'failed-public.txt';$writeFailed=$false
    try{Write-RevAgentBridgeCredentialArtifact -Path $failedPath -Bytes ([byte[]]@(1,2,3)) -GuardRoot $credentials -IcaclsInvoker {throw 'test_owner_finalization_failure'}}catch{$writeFailed=$_.Exception.Message -ceq 'test_owner_finalization_failure'}
    Check $writeFailed 'ownership finalization failure propagates';Check (-not(Test-Path -LiteralPath $failedPath)) 'failed writer never publishes';Check (@(Get-ChildItem -LiteralPath $credentials -Filter '.enrollment.*.tmp' -Force).Count -eq 0) 'failed writer removes only its private temporary file'
    $stage='create_only_race';$racePath=Join-Path $credentials 'race-public.txt'
    $competingWriter={
        param([string[]]$Arguments)
        $out=& "$env:SystemRoot\System32\icacls.exe" @Arguments 2>&1
        if($LASTEXITCODE -ne 0){throw 'test_race_native_failure'}
        if(-not(Test-Path -LiteralPath $racePath)){[void](Write-RevAgentBridgeCredentialArtifact -Path $racePath -Bytes ([Text.Encoding]::UTF8.GetBytes('competing public artifact')) -GuardRoot $credentials)}
        return $out
    }.GetNewClosure()
    $raceRefused=$false
    try{Write-RevAgentBridgeCredentialArtifact -Path $racePath -Bytes ([byte[]]@(4,5,6)) -GuardRoot $credentials -IcaclsInvoker $competingWriter}catch{$raceRefused=$_.Exception.InnerException -is [IO.IOException] -or $_.Exception -is [IO.IOException]}
    Check $raceRefused 'concurrent artifact publication refuses overwrite';Check ([IO.File]::ReadAllText($racePath) -ceq 'competing public artifact') 'concurrent artifact bytes preserved';ExactAcl $racePath
    Check (@(Get-ChildItem -LiteralPath $credentials -Filter '.enrollment.*.tmp' -Force).Count -eq 0) 'race loser removes its private temporary file';[IO.File]::Delete($racePath)
    $stage='foreign_ace_refusal'
    foreach($deny in @($false,$true)){
        $foreign=Join-Path $root ('foreign-'+$deny);[void][IO.Directory]::CreateDirectory($foreign);$a=Get-Acl -LiteralPath $foreign
        # Materialize a protected native baseline before injection. A newly
        # inherited DACL can acquire DaclAutoInherited during its first restore.
        # Retain this fixture's Administrators owner so its Deny Read ACL can
        # still be inspected; the genuine SYSTEM-owned parent is tested above.
        $a.SetAccessRuleProtection($true,$false)
        foreach($sid in @('S-1-5-18','S-1-5-32-544')){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
        $directory=[IO.DirectoryInfo]::new($foreign)
        if($PSVersionTable.PSEdition -eq 'Desktop'){$directory.SetAccessControl($a)}else{[IO.FileSystemAclExtensions]::SetAccessControl($directory,$a)}
        $a=Get-Acl -LiteralPath $foreign
        Check ($a.AreAccessRulesProtected -and $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-32-544' -and @($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])).Count -eq 2) "native canonical fixture baseline $deny"
        $originalSddl=$a.Sddl
        $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read',$(if($deny){'Deny'}else{'Allow'})))
        Set-Acl -LiteralPath $foreign -AclObject $a;$before=(Get-Acl -LiteralPath $foreign).Sddl;$refused=$false
        @{path=$foreign;originalSddl=$originalSddl;testSddl=$before}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root ('foreign-acl-'+$deny+'.json')) -Encoding UTF8
        try{
            try{Set-RevAgentBridgeSystemOnlyAcl -Path $foreign}catch{$refused=$_.Exception.Message -ceq 'bridge_credential_acl_unexpected_ace'}
            Check $refused "foreign or deny refusal $deny";Check ((Get-Acl -LiteralPath $foreign).Sddl -ceq $before) "refusal preserves DACL $deny"
            $refused=$false;try{Write-RevAgentBridgeCredentialArtifact -Path (Join-Path $foreign 'refused.json') -Bytes ([byte[]]@(1,2,3)) -GuardRoot $foreign}catch{$refused=$true}
            Check $refused "artifact rejects foreign or deny parent $deny"
            Check ((Get-Acl -LiteralPath $foreign).Sddl -ceq $before) "artifact refusal preserves DACL $deny"
        }finally{
            # Everyone Deny Read also blocks this test's directory enumeration.
            # Restore only the exact fixture baseline, never unexpected drift.
            if((Get-Acl -LiteralPath $foreign).Sddl -cne $before){throw 'native_foreign_fixture_acl_drift_preserved'}
            $restore=[Security.AccessControl.DirectorySecurity]::new();$restore.SetSecurityDescriptorSddlForm($originalSddl)
            $directory=[IO.DirectoryInfo]::new($foreign)
            if($PSVersionTable.PSEdition -eq 'Desktop'){$directory.SetAccessControl($restore)}else{[IO.FileSystemAclExtensions]::SetAccessControl($directory,$restore)}
            Check ((Get-Acl -LiteralPath $foreign).Sddl -ceq $originalSddl) "exact fixture ACL restored before inspection $deny"
        }
        Check (@(Get-ChildItem -LiteralPath $foreign -Force).Count -eq 0) "refused parent creates no file $deny"
        [IO.Directory]::Delete($foreign,$false)
    }
    $stage='wrong_directory_policy_refusal'
    $wrong=Join-Path $root 'nonpropagating-directory';[void][IO.Directory]::CreateDirectory($wrong)
    Set-RevAgentBridgeSystemOnlyAcl -Path $wrong
    $a=Get-Acl -LiteralPath $wrong
    foreach($rule in @($a.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){[void]$a.RemoveAccessRuleSpecific($rule)}
    foreach($sid in @('S-1-5-18','S-1-5-32-544')){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','None','None','Allow'))}
    Set-Acl -LiteralPath $wrong -AclObject $a;$wrongBefore=(Get-Acl -LiteralPath $wrong).Sddl
    $refused=$false;try{Write-RevAgentBridgeCredentialArtifact -Path (Join-Path $wrong 'refused.json') -Bytes ([byte[]]@(1,2,3)) -GuardRoot $wrong}catch{$refused=$_.Exception.Message -ceq 'bridge_credential_acl_verification_failed'}
    Check $refused 'nonpropagating directory is not accepted as an alternate policy'
    Check ((Get-Acl -LiteralPath $wrong).Sddl -ceq $wrongBefore -and @(Get-ChildItem -LiteralPath $wrong -Force).Count -eq 0) 'wrong directory policy refused without mutation'
    [IO.Directory]::Delete($wrong,$false)
    $stage='credential_parent_reparse_refusal';$link=Join-Path $root 'credential-link'
    [void](New-Item -ItemType Junction -Path $link -Target $credentials)
    $refused=$false;try{Write-RevAgentBridgeCredentialArtifact -Path (Join-Path $link 'refused.json') -Bytes ([byte[]]@(1,2,3)) -GuardRoot $root}catch{$refused=$true}
    Check $refused 'credential parent junction refused';Check (-not(Test-Path -LiteralPath (Join-Path $credentials 'refused.json'))) 'junction target untouched'
    [IO.Directory]::Delete($link,$false)
    $stage='native_error_propagation';$vanishing=Join-Path $root 'vanishing';[void][IO.Directory]::CreateDirectory($vanishing)
    # Remove only this empty owned fixture after its real preflight ACL read.
    # The producer must report the actual icacls nonzero exit, even in PS5.
    # The runner is nested beneath the operator wrapper. A script-local
    # function is invisible to the imported module in that invocation shape.
    # Temporarily install a captured, exact-path global reader, restoring the
    # original function even if native execution fails.
    $priorGlobalReader=& (Get-Module RevAgent.BridgeInstall) { Get-Item Function:Get-Acl -ErrorAction SilentlyContinue }
    $priorGlobalReaderBody=if($priorGlobalReader){$priorGlobalReader.ScriptBlock}else{$null}
    $reader={param([string]$LiteralPath,$ErrorAction)
        if($LiteralPath -cne $vanishing){
            if($null -ne $priorGlobalReaderBody){return & $priorGlobalReaderBody @PSBoundParameters}
            return Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
        }
        $a=Microsoft.PowerShell.Security\Get-Acl -LiteralPath $LiteralPath -ErrorAction Stop
        [IO.Directory]::Delete($vanishing,$false)
        return $a
    }.GetNewClosure()
    Set-Item Function:global:Get-Acl -Value $reader
    $nativeFailed=$false
    $nativeError=[ordered]@{caught=$false;code='none';exceptionType=$null;fixtureAbsent=$false}
    try{Set-RevAgentBridgeSystemOnlyAcl -Path $vanishing}catch{
        $nativeError.caught=$true;$nativeError.exceptionType=$_.Exception.GetType().FullName
        $nativeFailed=$_.Exception.Message -match '^bridge_credential_icacls_failed: exit=[1-9][0-9]* operation=/grant:r$'
        $nativeError.code=if($nativeFailed){$_.Exception.Message}else{'unexpected_exception'}
    }finally{
        if($null -ne $priorGlobalReaderBody){Set-Item Function:global:Get-Acl -Value $priorGlobalReaderBody}else{& (Get-Module RevAgent.BridgeInstall) { Remove-Item Function:Get-Acl }}
        $nativeError.fixtureAbsent=-not(Test-Path -LiteralPath $vanishing)
        $nativeError|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'native-error.json') -Encoding UTF8
    }
    Check $nativeError.fixtureAbsent 'owned empty fixture removed before native mutation'
    Check $nativeFailed 'real native error propagated'
    Check ((Get-Acl -LiteralPath $credentials).Sddl -ceq $directorySddl) 'genuine parent remains unchanged after all file operations'
    $stage='cleanup';[IO.File]::Delete($file);[IO.Directory]::Delete($credentials,$false)
    $passed=$true
}
finally{
    $outcome=[ordered]@{passed=$passed;stage=$stage;actualElevated=$true;powerShellEdition=$PSVersionTable.PSEdition;powerShellVersion=$PSVersionTable.PSVersion.ToString();checks=$checks.ToArray();checkCount=$checks.Count;moduleSha256=(Get-FileHash -LiteralPath (Join-Path $repo 'installer\bridge\lib\RevAgent.BridgeInstall.psm1')).Hash;fixtureCleanupComplete=$passed;failedFixturesPreserved=(-not $passed)}
    $outcome|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $root 'native-acl-result.json') -Encoding UTF8
    $outcome|ConvertTo-Json -Depth 6
}
