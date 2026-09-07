namespace RevAgent.Bridge.Bootstrap;

internal sealed record BridgeInstallLayout(string InstallRoot, string StateRoot)
{
    internal const string ServiceName = "revAgentBridge";
    internal const string ServiceDisplayName = "revAgent Bridge";
    /// <summary>
    /// The SCM logon account, in the exact spelling the SCM reports back so
    /// the exact-registration check stays stable.
    /// </summary>
    /// <remarks>
    /// A per-service virtual account cannot open the interactive user's Revit
    /// process. Add-in attestation calls
    /// <c>OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)</c> on the process that
    /// owns the loopback listener, and a process's default DACL grants that only
    /// to its own owner, SYSTEM, and Administrators. Under the virtual account
    /// every probe failed with <c>revit_process_identity_unavailable</c>, so no
    /// Revit was ever discovered and no session was ever registered. The bridge
    /// is a machine-wide supervisor of local Revit sessions, so it runs as
    /// LocalSystem; the frozen protocol does not constrain this choice.
    /// </remarks>
    internal const string ServiceAccount = "LocalSystem";
    internal const string EventSourceName = "revAgent Bridge";
    internal const string HostExecutableName = "revagent-bridge-host.exe";
    internal const string WorkerExecutableName = "revagent-bridge.exe";

    internal static BridgeInstallLayout Canonical { get; } = new(
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "revAgent",
            "Bridge"),
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "revAgent",
            "bridge"));

    internal string HostExecutablePath =>
        Path.Combine(InstallRoot, HostExecutableName);

    internal string UpdateTrustedKeysPath =>
        Path.Combine(InstallRoot, "update-trusted-keys.json");

    internal string VersionsRoot =>
        Path.Combine(InstallRoot, "versions");

    internal string CurrentWorkerDirectory =>
        Path.Combine(VersionsRoot, "current");

    internal string WorkerExecutablePath =>
        Path.Combine(CurrentWorkerDirectory, WorkerExecutableName);

    internal string ConfigurationPath =>
        Path.Combine(StateRoot, "bridge-config.json");

    internal string HostLogDirectory =>
        Path.Combine(StateRoot, "logs", "host");

    internal string WorkerLogDirectory =>
        Path.Combine(StateRoot, "logs", "worker");

    internal string JournalPath =>
        Path.Combine(StateRoot, "journal.db");

    internal string CredentialDirectory =>
        Path.Combine(StateRoot, "credentials");

    internal string MachineIdentityPath =>
        Path.Combine(CredentialDirectory, "machine-identity.dpapi");

    internal string MachineFingerprintPath =>
        Path.Combine(CredentialDirectory, "machine-fingerprint.json");

    internal string DeviceCredentialPath =>
        Path.Combine(CredentialDirectory, "device-credential.dpapi");

    internal string AuthDiagnosticPath =>
        Path.Combine(CredentialDirectory, "auth-diagnostic.json");

    internal string EnrollmentLockPath =>
        Path.Combine(CredentialDirectory, "enrollment.lock");

    internal string BundleExtractionRoot =>
        Path.Combine(StateRoot, "bundle-extract");

    internal string UpdateRoot =>
        Path.Combine(StateRoot, "updates");

    internal string UpdateStagingRoot =>
        Path.Combine(UpdateRoot, "staging");

    internal string UpdateStatePath =>
        Path.Combine(UpdateRoot, "state.json");

    internal string UpdateReportPendingRoot =>
        Path.Combine(UpdateRoot, "reports", "pending");

    internal string CurrentVersionPointerPath =>
        Path.Combine(UpdateRoot, "current.version");

    internal string AddinRoot =>
        Path.Combine(
            Directory.GetParent(Path.GetFullPath(InstallRoot))?.FullName
                ?? Path.GetFullPath(InstallRoot),
            "Addin");
}
