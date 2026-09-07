using System.Text.Json;
using RevAgent.Bridge.Bootstrap;

namespace RevAgent.Bridge.Host.Update;

internal sealed record BridgeUpdateState
{
    public int SchemaVersion { get; init; } = 1;
    public string TenantBinding { get; init; } = string.Empty;
    public string DeviceId { get; init; } = string.Empty;
    public string AuthenticatedSessionId { get; init; } = string.Empty;
    public string ActiveVersion { get; init; } = string.Empty;
    public string? PreviousVersion { get; init; }
    public long HighestAcceptedReleaseSequence { get; init; }
    public string? PendingAddinVersion { get; init; }
    public string? PendingAddinPath { get; init; }
    public string? PendingReleaseVersion { get; init; }
    public long? PendingReleaseSequence { get; init; }
    public DateTimeOffset? VersionActivatedAtUtc { get; init; }
    public IReadOnlyList<DateTimeOffset> AbnormalExitTimesUtc { get; init; } = [];
    public IReadOnlyDictionary<string, DateTimeOffset> QuarantinedVersions { get; init; } =
        new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
}

internal sealed class BridgeUpdateStateStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    private readonly BridgeInstallLayout _layout;
    private readonly SemaphoreSlim _gate = new(1, 1);

    internal BridgeUpdateStateStore(BridgeInstallLayout layout)
    {
        _layout = layout ?? throw new ArgumentNullException(nameof(layout));
    }

    internal async Task<BridgeUpdateState> ReadAsync(
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await ReadCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task<BridgeUpdateState> MutateAsync(
        Func<BridgeUpdateState, BridgeUpdateState> mutation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(mutation);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            BridgeUpdateState current = await ReadCoreAsync(cancellationToken)
                .ConfigureAwait(false);
            BridgeUpdateState next = mutation(current) ??
                throw new InvalidOperationException("Update state mutation returned null.");
            Validate(next);
            await WriteCoreAsync(next, cancellationToken).ConfigureAwait(false);
            return next;
        }
        finally
        {
            _gate.Release();
        }
    }

    internal async Task WriteCurrentVersionAsync(
        string version,
        CancellationToken cancellationToken)
    {
        UpdatePathPolicy.ValidateVersion(version);
        Directory.CreateDirectory(_layout.UpdateRoot);
        string temporary = _layout.CurrentVersionPointerPath +
            $".tmp-{Guid.NewGuid():N}";
        await File.WriteAllTextAsync(temporary, version + Environment.NewLine, cancellationToken)
            .ConfigureAwait(false);
        File.Move(temporary, _layout.CurrentVersionPointerPath, overwrite: true);
    }

    private async Task<BridgeUpdateState> ReadCoreAsync(
        CancellationToken cancellationToken)
    {
        if (!File.Exists(_layout.UpdateStatePath))
        {
            return new BridgeUpdateState();
        }

        await using FileStream stream = File.Open(
            _layout.UpdateStatePath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read);
        BridgeUpdateState state = await JsonSerializer.DeserializeAsync<BridgeUpdateState>(
            stream,
            SerializerOptions,
            cancellationToken).ConfigureAwait(false) ??
            throw new BridgeUpdateRejectedException(
                "invalid_update_state",
                "Update state file was empty.");
        Validate(state);
        return state;
    }

    private async Task WriteCoreAsync(
        BridgeUpdateState state,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_layout.UpdateRoot);
        string temporary = _layout.UpdateStatePath + $".tmp-{Guid.NewGuid():N}";
        await using (FileStream stream = new(
            temporary,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.WriteThrough))
        {
            await JsonSerializer.SerializeAsync(
                stream,
                state,
                SerializerOptions,
                cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }

        File.Move(temporary, _layout.UpdateStatePath, overwrite: true);
    }

    private static void Validate(BridgeUpdateState state)
    {
        if (state.SchemaVersion != 1 || state.HighestAcceptedReleaseSequence < 0)
        {
            throw new BridgeUpdateRejectedException(
                "invalid_update_state",
                "Update state schema or release sequence is invalid.");
        }

        if (!string.IsNullOrEmpty(state.ActiveVersion))
        {
            UpdatePathPolicy.ValidateVersion(state.ActiveVersion);
        }

        if (state.PreviousVersion is not null)
        {
            UpdatePathPolicy.ValidateVersion(state.PreviousVersion);
        }

        if (state.PendingAddinVersion is not null)
        {
            UpdatePathPolicy.ValidateVersion(state.PendingAddinVersion);
        }

        if (state.PendingReleaseVersion is not null)
        {
            UpdatePathPolicy.ValidateVersion(state.PendingReleaseVersion);
            if (state.PendingReleaseSequence is null || state.PendingReleaseSequence < 1)
            {
                throw new BridgeUpdateRejectedException(
                    "invalid_update_state",
                    "Pending release state is incomplete.");
            }
        }
        else if (state.PendingReleaseSequence is not null)
        {
            throw new BridgeUpdateRejectedException(
                "invalid_update_state",
                "Pending release sequence has no version binding.");
        }

        foreach (string version in state.QuarantinedVersions.Keys)
        {
            UpdatePathPolicy.ValidateVersion(version);
        }
    }
}
