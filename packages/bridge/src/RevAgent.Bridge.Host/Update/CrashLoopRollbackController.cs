using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Updates;

namespace RevAgent.Bridge.Host.Update;

internal sealed class CrashLoopRollbackController
{
    internal static readonly TimeSpan CrashWindow = TimeSpan.FromMinutes(5);
    internal const int CrashThreshold = 3;

    private readonly BridgeInstallLayout _layout;
    private readonly BridgeUpdateStateStore _stateStore;
    private readonly IRevitProcessProbe _revit;
    private readonly TimeProvider _timeProvider;
    private readonly BridgeUpdateReportStore? _reports;

    internal CrashLoopRollbackController(
        BridgeInstallLayout layout,
        BridgeUpdateStateStore stateStore,
        IRevitProcessProbe revit,
        TimeProvider? timeProvider = null,
        BridgeUpdateReportStore? reports = null)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
        _stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        _revit = revit ?? throw new ArgumentNullException(nameof(revit));
        _timeProvider = timeProvider ?? TimeProvider.System;
        _reports = reports;
    }

    internal async Task<CrashRollbackResult> RecordUnexpectedExitAsync(
        CancellationToken cancellationToken)
    {
        DateTimeOffset now = _timeProvider.GetUtcNow();
        BridgeUpdateState state = await _stateStore.ReadAsync(cancellationToken)
            .ConfigureAwait(false);
        if (state.PreviousVersion is null || state.VersionActivatedAtUtc is null ||
            now - state.VersionActivatedAtUtc > CrashWindow)
        {
            return new CrashRollbackResult(
                false,
                state.ActiveVersion,
                null,
                0,
                "no_recent_version_flip");
        }

        DateTimeOffset cutoff = now - CrashWindow;
        DateTimeOffset[] crashes =
            [.. state.AbnormalExitTimesUtc.Where(value => value >= cutoff), now];
        if (crashes.Length < CrashThreshold)
        {
            await _stateStore.MutateAsync(
                current => current with { AbnormalExitTimesUtc = crashes },
                cancellationToken).ConfigureAwait(false);
            return new CrashRollbackResult(
                false,
                state.ActiveVersion,
                null,
                crashes.Length,
                "crash_threshold_not_reached");
        }

        string badVersion = state.ActiveVersion;
        string restoredVersion = state.PreviousVersion;
        string restoredBridge = UpdatePathPolicy.Descendant(
            _layout.VersionsRoot,
            restoredVersion);
        if (!Directory.Exists(restoredBridge) ||
            !File.Exists(Path.Combine(
                restoredBridge,
                BridgeInstallLayout.WorkerExecutableName)))
        {
            throw new BridgeUpdateRejectedException(
                "rollback_payload_missing",
                "Previous Bridge version is unavailable for crash-loop rollback.");
        }

        await _stateStore.WriteCurrentVersionAsync(restoredVersion, cancellationToken)
            .ConfigureAwait(false);

        string restoredAddin = UpdatePathPolicy.Descendant(
            _layout.UpdateRoot,
            "addin-versions",
            restoredVersion);
        bool hasRestoredAddin = Directory.Exists(restoredAddin);
        string? pendingAddinVersion = hasRestoredAddin ? restoredVersion : null;
        string? pendingAddinPath = hasRestoredAddin ? restoredAddin : null;

        var quarantine = new Dictionary<string, DateTimeOffset>(
            state.QuarantinedVersions,
            StringComparer.Ordinal)
        {
            [badVersion] = now,
        };
        await _stateStore.MutateAsync(
            current => current with
            {
                ActiveVersion = restoredVersion,
                PreviousVersion = null,
                VersionActivatedAtUtc = null,
                AbnormalExitTimesUtc = [],
                QuarantinedVersions = quarantine,
                PendingAddinVersion = pendingAddinVersion,
                PendingAddinPath = pendingAddinPath,
            },
            cancellationToken).ConfigureAwait(false);

        if (_reports is not null)
        {
            string digest = state.AcceptedManifestDigest ??
                "sha256:" + new string('0', 64);
            _ = await _reports.AppendAsync(
                state.DeviceId,
                badVersion,
                restoredVersion,
                state.HighestAcceptedReleaseSequence,
                digest,
                BridgeUpdateReportStates.Rollback,
                "crash_loop_rollback",
                error: null,
                now,
                cancellationToken).ConfigureAwait(false);
            _ = await _reports.AppendAsync(
                state.DeviceId,
                badVersion,
                restoredVersion,
                state.HighestAcceptedReleaseSequence,
                digest,
                BridgeUpdateReportStates.Quarantined,
                "bad_version_quarantined",
                error: null,
                now,
                cancellationToken).ConfigureAwait(false);
        }

        bool addinDeferred = hasRestoredAddin;
        if (hasRestoredAddin && !_revit.IsRevitRunning())
        {
            try
            {
                BridgeUpdateEngine.DeployAddinSlot(restoredAddin, _layout.AddinRoot);
                await _stateStore.MutateAsync(
                    current => current with
                    {
                        PendingAddinVersion = null,
                        PendingAddinPath = null,
                    },
                    cancellationToken).ConfigureAwait(false);
                addinDeferred = false;
            }
            catch (IOException)
            {
                // The previous add-in remains durably pending. A close-race or
                // filesystem lock must not prevent the worker rollback.
            }
            catch (UnauthorizedAccessException)
            {
                // The previous add-in remains durably pending for a later retry.
            }
        }

        return new CrashRollbackResult(
            true,
            restoredVersion,
            badVersion,
            crashes.Length,
            addinDeferred
                ? "crash_threshold_reached_addin_deferred"
                : "crash_threshold_reached");
    }
}
