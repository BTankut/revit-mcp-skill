using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Updates;
using RevAgent.Contracts.Signing;

namespace RevAgent.Bridge.Host.Update;

internal sealed class BridgeUpdateEngine
{
    private const long MaximumExpandedComponentBytes = 1024L * 1024 * 1024;

    private readonly BridgeInstallLayout _layout;
    private readonly BridgeUpdateStateStore _stateStore;
    private readonly TrustedPublicKeyRing _trustedKeys;
    private readonly IBridgeUpdateArtifactSource _artifacts;
    private readonly PendingAddinApplier _addinApplier;
    private readonly string _installedVersion;
    private readonly TimeProvider _timeProvider;
    private readonly BridgeUpdateReportStore? _reports;

    internal BridgeUpdateEngine(
        BridgeInstallLayout layout,
        BridgeUpdateStateStore stateStore,
        TrustedPublicKeyRing trustedKeys,
        IBridgeUpdateArtifactSource artifacts,
        IRevitProcessProbe revit,
        string installedVersion,
        TimeProvider? timeProvider = null,
        BridgeUpdateReportStore? reports = null)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
        _stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        _trustedKeys = trustedKeys ?? throw new ArgumentNullException(nameof(trustedKeys));
        _artifacts = artifacts ?? throw new ArgumentNullException(nameof(artifacts));
        ArgumentNullException.ThrowIfNull(revit);
        _addinApplier = new PendingAddinApplier(
            layout,
            stateStore,
            revit,
            reports,
            timeProvider);
        UpdatePathPolicy.ValidateVersion(installedVersion);
        _installedVersion = installedVersion;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _reports = reports;
    }

    internal async Task<BridgeUpdateResult> ApplyAsync(
        SignedBridgeUpdate update,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(update);
        update.Principal.Validate();
        if (update.DeviceRing is < 0 or > 99)
        {
            throw Reject("invalid_device_ring", "Device ring must be in the range 0..99.");
        }

        SignatureVerificationResult signature = DetachedSignatureVerifier.Verify(
            update.Manifest,
            update.SignatureEnvelope,
            _trustedKeys,
            DetachedSignaturePolicy.BridgeManifest);
        if (!signature.Success)
        {
            throw Reject(signature.Reason, signature.Message);
        }

        BridgeUpdateManifest manifest = BridgeUpdateManifestParser.Parse(update.Manifest);
        string manifestDigest = "sha256:" + signature.ContentSha256.ToLowerInvariant();
        BridgeUpdateState state = await EnsureBoundStateAsync(
            update.Principal,
            cancellationToken).ConfigureAwait(false);
        if (state.QuarantinedVersions.ContainsKey(manifest.Version))
        {
            throw Reject(
                "version_quarantined",
                $"Update version '{manifest.Version}' is quarantined on this device.");
        }

        if (manifest.ReleaseSequence < state.HighestAcceptedReleaseSequence)
        {
            throw Reject(
                "release_sequence_rollback",
                "Manifest releaseSequence is lower than the highest accepted sequence.");
        }

        if (manifest.ReleaseSequence == state.HighestAcceptedReleaseSequence)
        {
            if (string.Equals(state.ActiveVersion, manifest.Version, StringComparison.Ordinal))
            {
                if (!string.Equals(
                        state.AcceptedManifestDigest,
                        manifestDigest,
                        StringComparison.Ordinal))
                {
                    throw Reject(
                        "release_content_rebind",
                        "An accepted release cannot be rebound to changed signed content.");
                }
                bool addinApplied = await TryApplyPendingAddinAsync(cancellationToken)
                    .ConfigureAwait(false);
                BridgeUpdateState current = await _stateStore.ReadAsync(cancellationToken)
                    .ConfigureAwait(false);
                return new BridgeUpdateResult(
                    current.PendingAddinVersion is null
                        ? BridgeUpdateDisposition.AlreadyCurrent
                        : BridgeUpdateDisposition.DeferredForRevitClose,
                    manifest.Version,
                    manifest.ReleaseSequence,
                    BridgeApplied: false,
                    AddinApplied: addinApplied,
                    AddinDeferred: current.PendingAddinVersion is not null,
                    "release_sequence_already_applied");
            }

            if (!string.Equals(
                    state.PendingReleaseVersion,
                    manifest.Version,
                    StringComparison.Ordinal) ||
                state.PendingReleaseSequence != manifest.ReleaseSequence)
            {
                throw Reject(
                    "release_sequence_reuse",
                    "An accepted releaseSequence cannot identify a different version.");
            }
            if (!string.Equals(
                    state.PendingManifestDigest,
                    manifestDigest,
                    StringComparison.Ordinal))
            {
                throw Reject(
                    "release_content_rebind",
                    "Interrupted release content does not match its accepted manifest digest.");
            }

            // Resume the exact accepted transaction after an interrupted apply.
        }

        if (manifest.ReleaseSequence > state.HighestAcceptedReleaseSequence &&
            string.Equals(state.ActiveVersion, manifest.Version, StringComparison.Ordinal))
        {
            throw Reject(
                "active_version_resequence",
                "A higher releaseSequence cannot reuse the active version identity.");
        }

        if (!IsSelected(update.Principal.DeviceId, update.DeviceRing, manifest.RolloutPercent))
        {
            await ReportAsync(
                update.Principal.DeviceId,
                state.ActiveVersion,
                manifest.Version,
                manifest.ReleaseSequence,
                manifestDigest,
                BridgeUpdateReportStates.Refused,
                "rollout_not_selected",
                cancellationToken).ConfigureAwait(false);
            return new BridgeUpdateResult(
                BridgeUpdateDisposition.NotSelected,
                manifest.Version,
                manifest.ReleaseSequence,
                BridgeApplied: false,
                AddinApplied: false,
                AddinDeferred: false,
                "rollout_not_selected");
        }

        string releaseStage = UpdatePathPolicy.Descendant(
            _layout.UpdateStagingRoot,
            manifest.Version);
        DeleteOwnedDirectory(releaseStage, _layout.UpdateStagingRoot);
        Directory.CreateDirectory(releaseStage);

        var extracted = new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            foreach (BridgeUpdateComponent component in manifest.Components)
            {
                cancellationToken.ThrowIfCancellationRequested();
                string archivePath = UpdatePathPolicy.Descendant(
                    releaseStage,
                    component.Name + ".zip");
                await DownloadAndVerifyAsync(
                    component,
                    update.Principal,
                    archivePath,
                    cancellationToken).ConfigureAwait(false);
                string extractedPath = UpdatePathPolicy.Descendant(
                    releaseStage,
                    component.Name);
                Directory.CreateDirectory(extractedPath);
                ExtractArchive(archivePath, extractedPath);
                ValidateExtractedComponent(component.Name, extractedPath);
                extracted.Add(component.Name, extractedPath);
            }

            await using IAsyncDisposable mutation =
                await _stateStore.AcquireMutationAsync(
                    "release_commit",
                    cancellationToken).ConfigureAwait(false);
            BridgeUpdateState commitState = await _stateStore.ReadAsync(
                cancellationToken).ConfigureAwait(false);
            if (!string.Equals(
                    commitState.TenantBinding,
                    state.TenantBinding,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    commitState.DeviceId,
                    state.DeviceId,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    commitState.AuthenticatedSessionId,
                    state.AuthenticatedSessionId,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    commitState.ActiveVersion,
                    state.ActiveVersion,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    commitState.PreviousVersion,
                    state.PreviousVersion,
                    StringComparison.Ordinal) ||
                commitState.HighestAcceptedReleaseSequence !=
                    state.HighestAcceptedReleaseSequence ||
                !string.Equals(
                    commitState.AcceptedManifestDigest,
                    state.AcceptedManifestDigest,
                    StringComparison.Ordinal) ||
                !string.Equals(
                    commitState.PendingReleaseVersion,
                    state.PendingReleaseVersion,
                    StringComparison.Ordinal) ||
                commitState.PendingReleaseSequence != state.PendingReleaseSequence ||
                !string.Equals(
                    commitState.PendingManifestDigest,
                    state.PendingManifestDigest,
                    StringComparison.Ordinal) ||
                commitState.QuarantinedVersions.ContainsKey(manifest.Version))
            {
                throw Reject(
                    "update_state_changed",
                    "Update authority changed while signed components were staged.");
            }
            state = commitState;

            string previousVersion = string.IsNullOrEmpty(state.ActiveVersion)
                ? _installedVersion
                : state.ActiveVersion;

            await ReportAsync(
                update.Principal.DeviceId,
                previousVersion,
                manifest.Version,
                manifest.ReleaseSequence,
                manifestDigest,
                BridgeUpdateReportStates.Staged,
                "components_verified_and_staged",
                cancellationToken).ConfigureAwait(false);

            // Persist sequence acceptance before changing the executable pointer.
            await _stateStore.MutateAsync(
                current => current with
                {
                    TenantBinding = update.Principal.TenantBinding,
                    DeviceId = update.Principal.DeviceId,
                    AuthenticatedSessionId = update.Principal.AuthenticatedSessionId,
                    HighestAcceptedReleaseSequence = manifest.ReleaseSequence,
                    PendingReleaseVersion = manifest.Version,
                    PendingReleaseSequence = manifest.ReleaseSequence,
                    PendingManifestDigest = manifestDigest,
                },
                cancellationToken).ConfigureAwait(false);

            bool bridgeApplied = false;
            if (extracted.TryGetValue("bridge", out string? bridgePayload))
            {
                EnsurePreviousBridgeSlot(previousVersion);
                string versionDirectory = UpdatePathPolicy.Descendant(
                    _layout.VersionsRoot,
                    manifest.Version);
                bool pointerAlreadySelected =
                    File.Exists(_layout.CurrentVersionPointerPath) &&
                    string.Equals(
                        File.ReadAllText(_layout.CurrentVersionPointerPath).Trim(),
                        manifest.Version,
                        StringComparison.Ordinal) &&
                    Directory.Exists(versionDirectory);
                if (!pointerAlreadySelected)
                {
                    InstallVersionDirectory(bridgePayload, versionDirectory);
                    await _stateStore.WriteCurrentVersionAsync(
                        manifest.Version,
                        cancellationToken).ConfigureAwait(false);
                }
                bridgeApplied = true;
            }

            string? pendingAddinPath = null;
            string? pendingAddinVersion = null;
            if (extracted.TryGetValue("addin", out string? addinPayload))
            {
                EnsurePreviousAddinSlot(previousVersion);
                string addinSlot = UpdatePathPolicy.Descendant(
                    _layout.UpdateRoot,
                    "addin-versions",
                    manifest.Version);
                InstallVersionDirectory(addinPayload, addinSlot);
                pendingAddinPath = addinSlot;
                pendingAddinVersion = manifest.Version;
            }

            await _stateStore.MutateAsync(
                current => current with
                {
                    ActiveVersion = bridgeApplied
                        ? manifest.Version
                        : previousVersion,
                    PreviousVersion = bridgeApplied
                        ? previousVersion
                        : current.PreviousVersion,
                    VersionActivatedAtUtc = bridgeApplied
                        ? _timeProvider.GetUtcNow()
                        : current.VersionActivatedAtUtc,
                    AbnormalExitTimesUtc = [],
                    PendingAddinVersion = pendingAddinVersion,
                    PendingAddinPath = pendingAddinPath,
                    PendingReleaseVersion = null,
                    PendingReleaseSequence = null,
                    PendingManifestDigest = null,
                    AcceptedManifestDigest = manifestDigest,
                },
                cancellationToken).ConfigureAwait(false);

            await mutation.DisposeAsync().ConfigureAwait(false);
            bool addinApplied = await TryApplyPendingAddinAsync(cancellationToken)
                .ConfigureAwait(false);
            BridgeUpdateState finalState = await _stateStore.ReadAsync(cancellationToken)
                .ConfigureAwait(false);
            bool deferred = finalState.PendingAddinVersion is not null;
            await ReportAsync(
                update.Principal.DeviceId,
                previousVersion,
                manifest.Version,
                manifest.ReleaseSequence,
                manifestDigest,
                deferred
                    ? BridgeUpdateReportStates.Deferred
                    : BridgeUpdateReportStates.Applied,
                deferred ? "deferred_for_revit_close" : "bridge_and_addin_applied",
                cancellationToken).ConfigureAwait(false);
            return new BridgeUpdateResult(
                deferred
                    ? BridgeUpdateDisposition.DeferredForRevitClose
                    : BridgeUpdateDisposition.Applied,
                manifest.Version,
                manifest.ReleaseSequence,
                bridgeApplied,
                addinApplied,
                deferred,
                deferred ? "revit_open" : "applied");
        }
        finally
        {
            DeleteOwnedDirectory(releaseStage, _layout.UpdateStagingRoot);
        }
    }

    private async Task ReportAsync(
        string deviceId,
        string fromVersion,
        string toVersion,
        long releaseSequence,
        string manifestDigest,
        string state,
        string reason,
        CancellationToken cancellationToken)
    {
        if (_reports is null)
        {
            return;
        }

        _ = await _reports.AppendAsync(
            deviceId,
            fromVersion,
            toVersion,
            releaseSequence,
            manifestDigest,
            state,
            reason,
            error: null,
            _timeProvider.GetUtcNow(),
            cancellationToken).ConfigureAwait(false);
    }

    internal async Task<bool> TryApplyPendingAddinAsync(
        CancellationToken cancellationToken)
        => await _addinApplier.TryApplyAsync(cancellationToken).ConfigureAwait(false);

    internal static bool IsSelected(
        string deviceId,
        int deviceRing,
        int rolloutPercent)
    {
        if (deviceRing == 0)
        {
            return true;
        }

        if (rolloutPercent is < 0 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(rolloutPercent));
        }

        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(deviceId));
        int bucket = 0;
        foreach (byte value in digest)
        {
            bucket = ((bucket * 256) + value) % 100;
        }

        return bucket < rolloutPercent;
    }

    private async Task<BridgeUpdateState> EnsureBoundStateAsync(
        BridgeUpdatePrincipal principal,
        CancellationToken cancellationToken)
    {
        return await _stateStore.MutateAsync(
            current =>
            {
                if ((!string.IsNullOrEmpty(current.TenantBinding) &&
                        !string.Equals(current.TenantBinding, principal.TenantBinding, StringComparison.Ordinal)) ||
                    (!string.IsNullOrEmpty(current.DeviceId) &&
                        !string.Equals(current.DeviceId, principal.DeviceId, StringComparison.Ordinal)))
                {
                    throw Reject(
                        "principal_binding_mismatch",
                        "Update state belongs to a different tenant or device.");
                }

                return current with
                {
                    TenantBinding = principal.TenantBinding,
                    DeviceId = principal.DeviceId,
                    AuthenticatedSessionId = principal.AuthenticatedSessionId,
                    ActiveVersion = string.IsNullOrEmpty(current.ActiveVersion)
                        ? _installedVersion
                        : current.ActiveVersion,
                };
            },
            cancellationToken).ConfigureAwait(false);
    }

    private async Task DownloadAndVerifyAsync(
        BridgeUpdateComponent component,
        BridgeUpdatePrincipal principal,
        string destination,
        CancellationToken cancellationToken)
    {
        await using Stream source = await _artifacts.OpenReadAsync(
            component.Url,
            principal,
            cancellationToken).ConfigureAwait(false);
        await using FileStream target = new(
            destination,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            81920,
            FileOptions.WriteThrough);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        long total = 0;
        while (true)
        {
            int read = await source.ReadAsync(buffer, cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            total = checked(total + read);
            if (total > component.SizeBytes)
            {
                throw Reject("component_size_mismatch", "Component exceeded signed sizeBytes.");
            }

            hash.AppendData(buffer, 0, read);
            await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken)
                .ConfigureAwait(false);
        }

        await target.FlushAsync(cancellationToken).ConfigureAwait(false);
        string actualHash = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        if (total != component.SizeBytes)
        {
            throw Reject("component_size_mismatch", "Component size did not match signed sizeBytes.");
        }

        if (!string.Equals(actualHash, component.Sha256, StringComparison.Ordinal))
        {
            throw Reject("component_hash_mismatch", "Component hash did not match signed sha256.");
        }
    }

    private static void ExtractArchive(string archivePath, string destinationRoot)
    {
        using ZipArchive archive = ZipFile.OpenRead(archivePath);
        long expanded = 0;
        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string normalized = entry.FullName.Replace('\\', '/');
            if (string.IsNullOrEmpty(normalized) || normalized.StartsWith('/') ||
                normalized.Split('/').Any(part => part is ".." or ".") ||
                (entry.ExternalAttributes & unchecked((int)0xF0000000)) ==
                    unchecked((int)0xA0000000))
            {
                throw Reject("unsafe_component_archive", "Component archive contains an unsafe path.");
            }

            expanded = checked(expanded + entry.Length);
            if (expanded > MaximumExpandedComponentBytes)
            {
                throw Reject("component_expanded_too_large", "Expanded component exceeds the limit.");
            }

            string destination = UpdatePathPolicy.Descendant(
                destinationRoot,
                normalized.Split('/', StringSplitOptions.RemoveEmptyEntries));
            if (normalized.EndsWith('/'))
            {
                Directory.CreateDirectory(destination);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            using Stream source = entry.Open();
            using FileStream target = new(
                destination,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None);
            source.CopyTo(target);
            target.Flush(flushToDisk: true);
        }
    }

    private static void ValidateExtractedComponent(string name, string root)
    {
        if (name == "bridge" &&
            !File.Exists(Path.Combine(root, BridgeInstallLayout.WorkerExecutableName)))
        {
            throw Reject(
                "bridge_executable_missing",
                "Bridge component does not contain revagent-bridge.exe at its root.");
        }

        if (!Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Any())
        {
            throw Reject("component_empty", "Component archive did not contain files.");
        }
    }

    private static void InstallVersionDirectory(string source, string destination)
    {
        if (Directory.Exists(destination))
        {
            DeleteOwnedDirectory(destination, Path.GetDirectoryName(destination)!);
        }

        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        Directory.Move(source, destination);
    }

    internal static void DeployAddinSlot(string source, string destination)
    {
        string parent = Path.GetDirectoryName(Path.GetFullPath(destination))!;
        Directory.CreateDirectory(parent);
        string incoming = Path.Combine(parent, $".addin-incoming-{Guid.NewGuid():N}");
        string backup = Path.Combine(parent, $".addin-backup-{Guid.NewGuid():N}");
        CopyDirectory(source, incoming);
        bool backedUp = false;
        try
        {
            if (Directory.Exists(destination))
            {
                Directory.Move(destination, backup);
                backedUp = true;
            }

            Directory.Move(incoming, destination);
            if (backedUp)
            {
                Directory.Delete(backup, recursive: true);
            }
        }
        catch
        {
            if (!Directory.Exists(destination) && backedUp && Directory.Exists(backup))
            {
                Directory.Move(backup, destination);
            }

            throw;
        }
        finally
        {
            if (Directory.Exists(incoming))
            {
                Directory.Delete(incoming, recursive: true);
            }
        }
    }

    private void EnsurePreviousBridgeSlot(string previousVersion)
    {
        string slot = UpdatePathPolicy.Descendant(_layout.VersionsRoot, previousVersion);
        if (Directory.Exists(slot))
        {
            return;
        }

        string source = File.Exists(_layout.CurrentVersionPointerPath)
            ? UpdatePathPolicy.Descendant(_layout.VersionsRoot, previousVersion)
            : _layout.CurrentWorkerDirectory;
        if (!Directory.Exists(source))
        {
            throw Reject(
                "previous_bridge_missing",
                "Previous Bridge payload is unavailable for rollback.");
        }

        CopyDirectory(source, slot);
    }

    private void EnsurePreviousAddinSlot(string previousVersion)
    {
        string slot = UpdatePathPolicy.Descendant(
            _layout.UpdateRoot,
            "addin-versions",
            previousVersion);
        if (Directory.Exists(slot) || !Directory.Exists(_layout.AddinRoot))
        {
            return;
        }

        CopyDirectory(_layout.AddinRoot, slot);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (string directory in Directory.EnumerateDirectories(
            source,
            "*",
            SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(
                destination,
                Path.GetRelativePath(source, directory)));
        }

        foreach (string file in Directory.EnumerateFiles(
            source,
            "*",
            SearchOption.AllDirectories))
        {
            string target = Path.Combine(destination, Path.GetRelativePath(source, file));
            File.Copy(file, target, overwrite: false);
        }
    }

    private static void DeleteOwnedDirectory(string path, string guardRoot)
    {
        string full = Path.GetFullPath(path);
        EnsureDescendant(guardRoot, full);
        if (!Directory.Exists(full))
        {
            return;
        }

        FileAttributes attributes = File.GetAttributes(full);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw Reject("reparse_point_blocked", "Update mutation target is a reparse point.");
        }

        Directory.Delete(full, recursive: true);
    }

    private static void EnsureDescendant(string root, string candidate)
    {
        string relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(candidate));
        if (Path.IsPathFullyQualified(relative) || relative is "" or "." or ".." ||
            relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw Reject("path_escape", "Update mutation target escaped its authorized root.");
        }
    }

    private static BridgeUpdateRejectedException Reject(string code, string message) =>
        new(code, message);
}
