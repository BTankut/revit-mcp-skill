using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using RevAgent.Bridge.Bootstrap.Enrollment;

namespace RevAgent.Bridge.Tests.Configuration;

public sealed class CredentialDirectoryPolicyTests
{
    [Fact]
    public void CanonicalDirectoryAndFileInheritanceRemainDistinct()
    {
        Assert.Equal(BridgeCredentialAclPrincipal.LocalSystem, BridgeCredentialAclPolicy.OwnerPrincipal);
        Assert.All(BridgeCredentialAclPolicy.DirectoryRules, rule => Assert.True(rule.InheritToChildren));
        Assert.All(BridgeCredentialAclPolicy.FileRules, rule => Assert.False(rule.InheritToChildren));
    }

    [WindowsAdministratorFact]
    [SupportedOSPlatform("windows")]
    public void RealProducerCreatesCanonicalDirectory()
    {
        string? supplied = Environment.GetEnvironmentVariable("REVAGENT_CREDENTIAL_DIRECTORY_FIXTURE_ROOT");
        bool export = !string.IsNullOrWhiteSpace(supplied);
        string root = Path.GetFullPath(export ? supplied! :
            Path.Combine(Path.GetTempPath(), "eu20-credential-policy-" + Guid.NewGuid().ToString("N")));
        GuardRoot(root, export);
        string directory = Path.Combine(root, "csharp-credentials");
        string receipt = Path.Combine(root, "credential-directory-policy.json");
        Assert.False(Path.Exists(directory));
        Assert.False(Path.Exists(receipt));
        // The production resolver, filesystem pins and scoped Windows restore
        // privilege are real. This fixture never creates a machine identity.
        var access = new WindowsBridgeCredentialAccessControl();
        if (!export) access.EnsureProtectedDirectory(root);
        try
        {
            access.EnsureProtectedDirectory(directory);
            access.VerifyProtectedDirectory(directory);
            DirectorySecurity security = new DirectoryInfo(directory).GetAccessControl();
            Assert.Equal("S-1-5-18", Assert.IsType<SecurityIdentifier>(security.GetOwner(typeof(SecurityIdentifier))).Value);
            Assert.True(security.AreAccessRulesProtected);
            FileSystemAccessRule[] rules = security.GetAccessRules(true, true, typeof(SecurityIdentifier))
                .Cast<FileSystemAccessRule>().ToArray();
            Assert.Equal(2, rules.Length);
            foreach (string sid in new[] { "S-1-5-18", "S-1-5-32-544" })
            {
                FileSystemAccessRule rule = Assert.Single(rules, candidate => candidate.IdentityReference.Value == sid);
                Assert.False(rule.IsInherited);
                Assert.Equal(AccessControlType.Allow, rule.AccessControlType);
                Assert.Equal(FileSystemRights.FullControl, rule.FileSystemRights);
                Assert.Equal(InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, rule.InheritanceFlags);
                Assert.Equal(PropagationFlags.None, rule.PropagationFlags);
            }
            string before = security.GetSecurityDescriptorSddlForm(AccessControlSections.All);
            access.EnsureProtectedDirectory(directory);
            Assert.Equal(before, new DirectoryInfo(directory).GetAccessControl()
                .GetSecurityDescriptorSddlForm(AccessControlSections.All));
            Assert.Empty(Directory.EnumerateFileSystemEntries(directory));
            if (export)
            {
                using FileStream stream = new(receipt, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
                JsonSerializer.Serialize(stream, new
                {
                    producer = nameof(WindowsBridgeCredentialAccessControl),
                    directoryPath = directory,
                    directorySddl = before,
                    protectedDirectoryVerified = true,
                    identityCreated = false,
                    fixtureOnly = true,
                });
                stream.Flush(flushToDisk: true);
            }
        }
        finally
        {
            if (!export)
            {
                GuardRoot(root, true);
                if (Directory.Exists(directory)) Directory.Delete(directory, recursive: false);
                if (Directory.Exists(root)) Directory.Delete(root, recursive: false);
            }
        }
    }

    private static void GuardRoot(string root, bool existing)
    {
        Assert.True(Path.IsPathFullyQualified(root));
        Assert.False(root.StartsWith(@"\\", StringComparison.Ordinal));
        foreach (Environment.SpecialFolder folder in new[]
        {
            Environment.SpecialFolder.CommonApplicationData, Environment.SpecialFolder.ProgramFiles,
            Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.Windows,
        })
        {
            string protectedRoot = Path.GetFullPath(Environment.GetFolderPath(folder));
            Assert.False(root.Equals(protectedRoot, StringComparison.OrdinalIgnoreCase) ||
                root.StartsWith(protectedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
        }
        if (existing) Assert.True(Directory.Exists(root));
        else
        {
            Assert.False(Path.Exists(root));
            Assert.StartsWith(Path.GetFullPath(Path.GetTempPath()), root, StringComparison.OrdinalIgnoreCase);
        }
        for (string? cursor = root; cursor is not null; cursor = Path.GetDirectoryName(cursor))
            if (Path.Exists(cursor)) Assert.False((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0);
    }

    private sealed class WindowsAdministratorFactAttribute : FactAttribute
    {
        public WindowsAdministratorFactAttribute()
        {
            if (!OperatingSystem.IsWindows()) Skip = "Requires real Windows credential ACL enforcement.";
            else if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                Skip = "Requires an actual elevated Administrator token; no ACL or privilege mock.";
        }
    }
}
