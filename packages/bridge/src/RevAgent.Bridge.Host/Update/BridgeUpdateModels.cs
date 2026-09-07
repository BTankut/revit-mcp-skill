using Newtonsoft.Json.Linq;

namespace RevAgent.Bridge.Host.Update;

internal sealed record BridgeUpdatePrincipal(
    string TenantBinding,
    string DeviceId,
    string AuthenticatedSessionId)
{
    internal void Validate()
    {
        ValidatePart(TenantBinding, nameof(TenantBinding));
        ValidatePart(DeviceId, nameof(DeviceId));
        ValidatePart(AuthenticatedSessionId, nameof(AuthenticatedSessionId));
    }

    private static void ValidatePart(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 256 ||
            value.Any(char.IsControl))
        {
            throw new BridgeUpdateRejectedException(
                "invalid_principal_binding",
                $"Update principal field '{name}' is invalid.");
        }
    }
}

internal sealed record SignedBridgeUpdate(
    JObject Manifest,
    JObject SignatureEnvelope,
    BridgeUpdatePrincipal Principal,
    int DeviceRing);

internal sealed record BridgeUpdateComponent(
    string Name,
    string Version,
    string Sha256,
    long SizeBytes,
    Uri Url);

internal sealed record BridgeUpdateManifest(
    int SchemaVersion,
    string Channel,
    string Version,
    long ReleaseSequence,
    IReadOnlyList<BridgeUpdateComponent> Components,
    int RolloutPercent,
    string MinimumSupportedVersion,
    string Notes);

internal enum BridgeUpdateDisposition
{
    Applied,
    DeferredForRevitClose,
    AlreadyCurrent,
    NotSelected,
}

internal sealed record BridgeUpdateResult(
    BridgeUpdateDisposition Disposition,
    string Version,
    long ReleaseSequence,
    bool BridgeApplied,
    bool AddinApplied,
    bool AddinDeferred,
    string Reason);

internal sealed record CrashRollbackResult(
    bool RolledBack,
    string ActiveVersion,
    string? QuarantinedVersion,
    int CrashCount,
    string Reason);

internal sealed class BridgeUpdateRejectedException : Exception
{
    internal BridgeUpdateRejectedException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    internal string Code { get; }
}

internal interface IBridgeUpdateArtifactSource
{
    ValueTask<Stream> OpenReadAsync(
        Uri artifactUri,
        BridgeUpdatePrincipal principal,
        CancellationToken cancellationToken);
}

internal interface IRevitProcessProbe
{
    bool IsRevitRunning();
}

internal sealed class SystemRevitProcessProbe : IRevitProcessProbe
{
    public bool IsRevitRunning()
    {
        System.Diagnostics.Process[] processes =
            System.Diagnostics.Process.GetProcessesByName("Revit");
        try
        {
            return processes.Length != 0;
        }
        finally
        {
            foreach (System.Diagnostics.Process process in processes)
            {
                process.Dispose();
            }
        }
    }
}
