using Microsoft.Extensions.Hosting;
using RevAgent.Bridge.Bootstrap;
using RevAgent.Bridge.Bootstrap.Logging;

namespace RevAgent.Bridge.Host.Update;

internal sealed class PendingAddinApplier
{
    private readonly BridgeInstallLayout _layout;
    private readonly BridgeUpdateStateStore _stateStore;
    private readonly IRevitProcessProbe _revit;

    internal PendingAddinApplier(
        BridgeInstallLayout layout,
        BridgeUpdateStateStore stateStore,
        IRevitProcessProbe revit)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
        _stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        _revit = revit ?? throw new ArgumentNullException(nameof(revit));
    }

    internal async Task<bool> TryApplyAsync(CancellationToken cancellationToken)
    {
        BridgeUpdateState state = await _stateStore.ReadAsync(cancellationToken)
            .ConfigureAwait(false);
        if (state.PendingAddinVersion is null || state.PendingAddinPath is null ||
            _revit.IsRevitRunning())
        {
            return false;
        }

        string slot = Path.GetFullPath(state.PendingAddinPath);
        string slotsRoot = UpdatePathPolicy.Descendant(_layout.UpdateRoot, "addin-versions");
        string relative = Path.GetRelativePath(slotsRoot, slot);
        if (Path.IsPathFullyQualified(relative) || relative is "" or "." or ".." ||
            relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
            relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal) ||
            !Directory.Exists(slot))
        {
            throw new BridgeUpdateRejectedException(
                "pending_addin_missing",
                "Pending add-in payload is missing or outside its authorized root.");
        }

        BridgeUpdateEngine.DeployAddinSlot(slot, _layout.AddinRoot);
        await _stateStore.MutateAsync(
            current => current with
            {
                PendingAddinVersion = null,
                PendingAddinPath = null,
            },
            cancellationToken).ConfigureAwait(false);
        return true;
    }
}
internal sealed class PendingAddinApplyService : BackgroundService
{
    internal static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(15);

    private readonly PendingAddinApplier _applier;
    private readonly IBridgeLog _log;
    private readonly TimeProvider _timeProvider;

    internal PendingAddinApplyService(
        PendingAddinApplier applier,
        IBridgeLog log,
        TimeProvider? timeProvider = null)
    {
        _applier = applier ?? throw new ArgumentNullException(nameof(applier));
        _log = log ?? throw new ArgumentNullException(nameof(log));
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (await _applier.TryApplyAsync(stoppingToken).ConfigureAwait(false))
                {
                    await TryLogAsync(
                        "information",
                        "addin_update_applied_after_revit_close",
                        "The staged add-in update was applied after Revit closed.",
                        stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                await TryLogAsync(
                    "warning",
                    "addin_update_retry_deferred",
                    "The staged add-in update remains pending for a later retry.",
                    stoppingToken,
                    exception).ConfigureAwait(false);
            }

            try
            {
                await Task.Delay(RetryInterval, _timeProvider, stoppingToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    private async ValueTask TryLogAsync(
        string level,
        string eventId,
        string message,
        CancellationToken cancellationToken,
        Exception? exception = null)
    {
        try
        {
            await _log.WriteAsync(
                level,
                eventId,
                "host.update",
                message,
                exception,
                cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            // Update state remains authoritative when logging is unavailable.
        }
    }
}
