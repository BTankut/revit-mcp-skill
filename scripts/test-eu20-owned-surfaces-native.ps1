#requires -Version 5.1
<# Real elevated ACL/filesystem fixture, using an ephemeral test signer and
   public fixture payloads. No service, identity, Revit or machine install. #>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'owned_surfaces_native_requires_admin'}
if(@(Get-Service -Name revAgentBridge -ErrorAction SilentlyContinue).Count -or @(Get-Process -Name Revit,revagent-bridge,revagent-bridge-host -ErrorAction SilentlyContinue).Count){throw 'owned_surfaces_native_requires_no_live_bridge_or_revit'}
$repo=Split-Path $PSScriptRoot -Parent;$module=Join-Path $repo 'installer\bridge\lib\RevAgent.BridgeInstall.psm1'
Import-Module $module -Force
Import-Module (Join-Path $repo 'installer\lib\RevAgent.DistributionIntegrity.psm1') -Force
$root=[IO.Path]::GetFullPath($EvidenceRoot);[void](Assert-RevAgentBridgeNoReparsePoint -Path $root -GuardRoot (Split-Path $root -Parent));if(Test-Path -LiteralPath $root){throw 'native_evidence_root_exists'}
$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'));$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
if($PSVersionTable.PSEdition -eq 'Desktop'){[void][IO.Directory]::CreateDirectory($root,$acl)}else{[IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($root),$acl)}
$checks=[Collections.Generic.List[string]]::new();$passed=$false;$stage='fixture'
function Check([bool]$Value,[string]$Name){if(-not $Value){throw "native_owned_surface_failed:$Name"};$checks.Add($Name)}
function Digest([string]$Path,[string]$Excluded=''){
    $rows=@(Get-RevAgentBridgeOwnedEntries -Root $Path|Where-Object{$_.Path -ine $Excluded}|Sort-Object Path|ForEach-Object{@{path=$_.Relative;directory=$_.Directory;sddl=(Get-Acl -LiteralPath $_.Path).Sddl;sha256=$(if($_.Directory){$null}else{(Get-FileHash -LiteralPath $_.Path).Hash})}})
    $s=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($s.ComputeHash([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $rows -Depth 7 -Compress))))).Replace('-','')}finally{$s.Dispose()}
}
function Reject([scriptblock]$Action,[string]$Pattern,[string]$Name){$refused=$false;try{& $Action}catch{$refused=$_.Exception.Message -match $Pattern};Check $refused $Name}
function CheckDistribution([string]$Path,[bool]$Directory){
    $a=Get-Acl -LiteralPath $Path;$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$inherit=if($Directory){3}else{0}
    $actual=@($r|ForEach-Object{'{0}:{1}:{2}:{3}:{4}' -f $_.IdentityReference.Value,[int]$_.FileSystemRights,[int]$_.InheritanceFlags,$_.AccessControlType,$_.IsInherited}|Sort-Object)
    $expected=@("S-1-5-18:2032127:${inherit}:Allow:False","S-1-5-32-544:2032127:${inherit}:Allow:False","S-1-5-32-545:1179817:${inherit}:Allow:False")|Sort-Object
    Check ($a.AreAccessRulesProtected -and $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -in @('S-1-5-18','S-1-5-32-544') -and @((Compare-Object $actual $expected)).Count -eq 0) 'actual owned distribution permissions exact'
}
try{
    # Reuse only the two established ephemeral fixture definitions; never run
    # the non-admin suite or import live signing material from this runner.
    $t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'test-eu20-bridge-install.ps1'),[ref]$t,[ref]$e)
    foreach($name in @('New-TestRsaProvider','New-BridgeReleaseFixture')){$f=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)|Where-Object Name -ceq $name);if($f.Count -ne 1){throw 'native_fixture_definition_missing'};Invoke-Expression $f[0].Extent.Text}
    $package=New-BridgeReleaseFixture -PackageRoot (Join-Path $root 'package')
    $legacyData=Join-Path $root 'legacy-data'
    foreach($relative in @('DPE\revAgent\bootstrap\keep.txt','DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1','DPE\revAgent\updater\config\release-trusted-keys.json','user-config.toml')){$p=Join-Path $legacyData $relative;[void][IO.Directory]::CreateDirectory((Split-Path $p -Parent));[IO.File]::WriteAllText($p,'unrelated legacy/user-state fixture')}
    $legacyBefore=Digest $legacyData
    $layout=Get-RevAgentBridgeLayout -InstallRoot (Join-Path $root 'program\revAgent\Bridge') -StateRoot (Join-Path $root 'data\revAgent\bridge') -AddinProgramFilesRoot (Join-Path $root 'program\revAgent\Addin') -RevitAddinsRoot (Join-Path $root 'shared')
    $addin=Get-RevAgentBridgeAddinLayout -Layout $layout -RevitVersion '2022'
    [void][IO.Directory]::CreateDirectory($layout.RevitAddinsRoot)
    Set-RevAgentBridgeDistributionAcl -Path $layout.RevitAddinsRoot
    [void][IO.Directory]::CreateDirectory($addin.ManifestDirectory)
    & "$env:SystemRoot\System32\icacls.exe" $addin.ManifestDirectory /setowner '*S-1-5-18' /Q|Out-Null;if($LASTEXITCODE -ne 0){throw 'fixture_system_owner_failed'}
    $sibling=Join-Path $addin.ManifestDirectory 'OtherVendor.addin';[IO.File]::WriteAllText($sibling,'unrelated public fixture')
    $vendor=Join-Path $addin.ManifestDirectory 'OtherVendor';[void][IO.Directory]::CreateDirectory($vendor);[IO.File]::WriteAllText((Join-Path $vendor 'plugin.dll'),'unrelated public plugin fixture')
    $sharedBefore=Digest $addin.ManifestDirectory $addin.ManifestPath
    Check ((Get-Acl -LiteralPath $addin.ManifestDirectory).GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq 'S-1-5-18') 'shared parent actually SYSTEM-owned'
    $stage='owned_distribution_and_manifest'
    foreach($path in @($layout.InstallRoot,$layout.StateRoot,$addin.AddinBinRoot)){[void](New-RevAgentBridgeGuardedDirectory -Path $path -GuardRoot $root);Set-RevAgentBridgeDistributionAcl -Path $path;CheckDistribution $path $true}
    [void][IO.Directory]::CreateDirectory($layout.CurrentWorkerDirectory)
    [IO.File]::Copy((Join-Path $package.PackageRoot 'host\revagent-bridge-host.exe'),$layout.HostExecutablePath,$false)
    Copy-RevAgentBridgeDirectoryContents -SourceDirectory (Join-Path $package.PackageRoot 'worker') -DestinationDirectory $layout.CurrentWorkerDirectory
    Copy-RevAgentBridgeDirectoryContents -SourceDirectory (Join-Path $package.PackageRoot 'addin') -DestinationDirectory $addin.AddinBinRoot
    [void][IO.Directory]::CreateDirectory($layout.CredentialDirectory);Set-RevAgentBridgeSystemOnlyAcl -Path $layout.CredentialDirectory
    [void](Write-RevAgentBridgeCredentialArtifact -Path $layout.EnrollmentArtifactPath -Bytes ([byte[]]@(1,2,3)) -GuardRoot $layout.CredentialDirectory)
    [IO.File]::WriteAllText($layout.ConfigurationPath,'public configuration fixture')
    [IO.File]::WriteAllText($layout.JournalPath,'public journal fixture')
    [IO.File]::WriteAllText((Join-Path $layout.StateRoot ('.bridge-config.json.'+[guid]::NewGuid().ToString('N')+'.tmp')),'public interrupted-write fixture')
    $contract=New-RevAgentBridgeAddinManifestContract -AssemblyPath $addin.AssemblyPath
    [IO.File]::WriteAllText($addin.ManifestPath,'foreign canonical-name fixture')
    $foreignManifestHash=(Get-FileHash -LiteralPath $addin.ManifestPath).Hash
    Reject {Write-RevAgentBridgeOwnedManifest -Path $addin.ManifestPath -AssemblyPath $addin.AssemblyPath -GuardRoot $addin.ManifestDirectory} 'bridge_manifest_not_owned' 'foreign canonical-name file refused'
    Check ((Get-FileHash -LiteralPath $addin.ManifestPath).Hash -ceq $foreignManifestHash) 'foreign manifest content preserved'
    [IO.File]::Delete($addin.ManifestPath)
    [void](Write-RevAgentBridgeOwnedManifest -Path $addin.ManifestPath -AssemblyPath $addin.AssemblyPath -GuardRoot $addin.ManifestDirectory)
    Check ((Get-FileHash -LiteralPath $addin.ManifestPath).Hash -ceq $contract.sha256) 'actual owned manifest published'
    CheckDistribution $addin.ManifestPath $false
    Check ((Digest $addin.ManifestDirectory $addin.ManifestPath) -ceq $sharedBefore) 'shared parent and unrelated nested content/ACL preserved'
    $manifestAcl=(Get-Acl -LiteralPath $addin.ManifestPath).Sddl
    [void](Write-RevAgentBridgeOwnedManifest -Path $addin.ManifestPath -AssemblyPath $addin.AssemblyPath -GuardRoot $addin.ManifestDirectory)
    Check ((Get-Acl -LiteralPath $addin.ManifestPath).Sddl -ceq $manifestAcl) 'owned manifest idempotent ACL'
    Check ((Digest $addin.ManifestDirectory $addin.ManifestPath) -ceq $sharedBefore) 'repeat publication preserves shared surface'
    $stage='foreign_refusals'
    $foreign=Join-Path $layout.StateRoot 'operator-notes.txt';[IO.File]::WriteAllText($foreign,'must survive refusal')
    Reject {Get-RevAgentBridgeOwnedCleanupPlan -Layout $layout -RevitVersion 2022 -PackageRoot $package.PackageRoot -TrustedKeysPath $package.TrustedKeysPath} 'bridge_owned_unknown_state_path' 'unknown state blocks complete plan'
    Check (Test-Path -LiteralPath $layout.HostExecutablePath) 'foreign refusal does not delete owned payload'
    Check ([IO.File]::ReadAllText($foreign) -ceq 'must survive refusal') 'foreign state preserved'
    [IO.File]::Delete($foreign)
    $hostBytes=[IO.File]::ReadAllBytes($layout.HostExecutablePath);[IO.File]::WriteAllBytes($layout.HostExecutablePath,[byte[]]@(9,9,9))
    Reject {Get-RevAgentBridgeOwnedCleanupPlan -Layout $layout -RevitVersion 2022 -PackageRoot $package.PackageRoot -TrustedKeysPath $package.TrustedKeysPath} 'bridge_owned_modified_payload_file' 'modified payload blocks removal'
    Check (Test-Path -LiteralPath $addin.ManifestPath) 'modified payload refusal leaves manifest present'
    [IO.File]::WriteAllBytes($layout.HostExecutablePath,$hostBytes)
    $foreignAcl=Join-Path $root 'foreign-acl';[void][IO.Directory]::CreateDirectory($foreignAcl);$security=Get-Acl -LiteralPath $foreignAcl;$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));Set-Acl -LiteralPath $foreignAcl -AclObject $security;$before=(Get-Acl -LiteralPath $foreignAcl).Sddl
    Reject {Set-RevAgentBridgeDistributionAcl -Path $foreignAcl} 'bridge_distribution_unexpected_ace' 'foreign explicit ACL refused'
    Check ((Get-Acl -LiteralPath $foreignAcl).Sddl -ceq $before) 'foreign ACL unchanged'
    $denyAcl=Join-Path $root 'deny-acl';[void][IO.Directory]::CreateDirectory($denyAcl);$security=Get-Acl -LiteralPath $denyAcl;$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Write','Deny'));Set-Acl -LiteralPath $denyAcl -AclObject $security;$before=(Get-Acl -LiteralPath $denyAcl).Sddl
    Reject {Set-RevAgentBridgeDistributionAcl -Path $denyAcl} 'bridge_distribution_unexpected_ace' 'deny ACL refused'
    Check ((Get-Acl -LiteralPath $denyAcl).Sddl -ceq $before) 'deny ACL unchanged'
    $stage='real_uninstaller_dryrun_and_cleanup'
    $uninstall=Join-Path $repo 'installer\bridge\Uninstall-RevAgentBridge.ps1'
    $cleanupArgs=@{Scope='BridgeOwned';PackageRoot=$package.PackageRoot;TrustedKeysPath=$package.TrustedKeysPath;RevitVersion='2022';ProgramDataRoot=$legacyData;InstallRoot=$layout.InstallRoot;StateRoot=$layout.StateRoot;AddinProgramFilesRoot=$layout.AddinProgramFilesRoot;RevitAddinsRoot=$layout.RevitAddinsRoot}
    $beforeOwned=Digest (Join-Path $root 'program');$beforeState=Digest (Join-Path $root 'data')
    $dry=& $uninstall @cleanupArgs -MachineReportPath (Join-Path $root 'owned-dryrun.json') -DryRun
    Check ($dry.status -ceq 'success' -and $dry.dryRun -and $dry.uninstall.scope -ceq 'BridgeOwned') 'explicit owned dry-run successful'
    Check ((Digest (Join-Path $root 'program')) -ceq $beforeOwned -and (Digest (Join-Path $root 'data')) -ceq $beforeState) 'dry-run changes no owned bytes/ACLs'
    # Partial install: one signed file already absent must remain safe.
    [IO.File]::Delete($layout.WorkerExecutablePath)
    $clean=& $uninstall @cleanupArgs -MachineReportPath (Join-Path $root 'owned-cleanup.json')
    Check ($clean.status -ceq 'success' -and $clean.uninstall.ownedCleanup.completed) 'actual explicit owned cleanup successful'
    foreach($path in @($layout.InstallRoot,$layout.StateRoot,$addin.AddinBinRoot,$addin.ManifestPath)){Check (-not(Test-Path -LiteralPath $path)) 'owned target absent'}
    Check (-not(Test-Path -LiteralPath (Join-Path $layout.AddinProgramFilesRoot '2022'))) 'owned version directory absent'
    foreach($path in @($layout.AddinProgramFilesRoot,(Split-Path $layout.InstallRoot -Parent),(Split-Path $layout.StateRoot -Parent))){Check (-not(Test-Path -LiteralPath $path)) 'empty app ancestor absent'}
    Check ((Digest $addin.ManifestDirectory $addin.ManifestPath) -ceq $sharedBefore) 'cleanup preserves SYSTEM-owned shared parent and siblings'
    Check ((Digest $legacyData) -ceq $legacyBefore -and $clean.uninstall.legacyTrees.Count -eq 0 -and $clean.uninstall.scheduledTasks.Count -eq 0 -and $null -eq $clean.uninstall.codexConfig) 'BridgeOwned preserves legacy anchors and unrelated user state'
    $again=& $uninstall @cleanupArgs -MachineReportPath (Join-Path $root 'owned-idempotent.json')
    Check ($again.status -ceq 'success' -and $again.uninstall.ownedCleanup.items.Count -eq 0) 'owned cleanup idempotent'
    Check (-not(Test-Path -LiteralPath $layout.StateRoot)) 'external report does not recreate state root'
    $stage='nonempty_ancestor_preservation'
    # An unrelated component in the app parent is outside the selected
    # version root. It must prevent pruning without becoming a wipe target.
    [void][IO.Directory]::CreateDirectory($layout.AddinProgramFilesRoot)
    $sibling=Join-Path $layout.AddinProgramFilesRoot 'other-component.keep'
    [IO.File]::WriteAllText($sibling,'unrelated app-parent fixture')
    $siblingHash=(Get-FileHash -LiteralPath $sibling).Hash;$siblingAcl=(Get-Acl -LiteralPath $sibling).Sddl
    $parentAcl=(Get-Acl -LiteralPath $layout.AddinProgramFilesRoot).Sddl
    [void][IO.Directory]::CreateDirectory($addin.AddinBinRoot);Set-RevAgentBridgeDistributionAcl -Path $addin.AddinBinRoot
    $withSibling=& $uninstall @cleanupArgs -MachineReportPath (Join-Path $root 'owned-sibling-preserved.json')
    Check ($withSibling.status -ceq 'success' -and -not(Test-Path -LiteralPath $addin.AddinBinRoot)) 'empty selected version removed beside unrelated component'
    Check ((Test-Path -LiteralPath $layout.AddinProgramFilesRoot) -and (Test-Path -LiteralPath (Split-Path $layout.AddinProgramFilesRoot -Parent))) 'nonempty Addin and revAgent ancestors preserved'
    Check ((Get-FileHash -LiteralPath $sibling).Hash -ceq $siblingHash -and (Get-Acl -LiteralPath $sibling).Sddl -ceq $siblingAcl -and (Get-Acl -LiteralPath $layout.AddinProgramFilesRoot).Sddl -ceq $parentAcl) 'unrelated sibling bytes and ACLs preserved'
    Check ((Digest $addin.ManifestDirectory $addin.ManifestPath) -ceq $sharedBefore) 'sibling scenario preserves shared Autodesk directory'
    $passed=$true;$stage='complete'
}finally{
    $result=[ordered]@{passed=$passed;stage=$stage;actualElevated=$true;runtime=$PSVersionTable.PSVersion.ToString();checks=$checks.ToArray();checkCount=$checks.Count;moduleSha256=(Get-FileHash -LiteralPath $module).Hash;fixtureRoot=$root;fixtureRetainedForReview=$true;machineServiceOrModelMutation=$false}
    $result|ConvertTo-Json -Depth 7|Set-Content -LiteralPath (Join-Path $root 'native-owned-surfaces.json') -Encoding UTF8;$result|ConvertTo-Json -Depth 7
}
